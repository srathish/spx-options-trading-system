/**
 * Algorithmic Entry Engine
 * Pure pattern + validation entry decisions. No agent call needed.
 *
 * Lane A: GEX-only patterns → live trades
 * Lane B: GEX patterns + TV confirmation → phantom trades
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EntryEngine');

// ---- Lane A: GEX-Only Entry ----

/**
 * Check for a Lane A (GEX-only) entry.
 * Iterates detected patterns in confidence order and returns the first one passing validation.
 *
 * @param {object} state - { patterns, scored, multiAnalysis, nodeTouches }
 * @returns {object|null} { shouldEnter, trigger, confidence, action, reason } or null
 */
export function checkGexOnlyEntry(state) {
  const { patterns, scored, multiAnalysis, nodeTouches, trendState } = state;
  const cfg = getActiveConfig() || {};

  if (!patterns || patterns.length === 0) return null;
  if (cfg.lane_a_enabled === false) return null;

  for (const trigger of patterns) {
    // Suppress counter-trend patterns: dayTrendDirection AND real-time CONFIRMED/STRONG must agree
    const realtimeConfirmed = trendState?.isTrend
      && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');
    if (trendState?.dayTrendDirection && trigger.direction !== trendState.dayTrendDirection
        && realtimeConfirmed && trendState.direction === trendState.dayTrendDirection) {
      log.info(`Trend filter: suppressing ${trigger.pattern} (${trigger.direction}) — day trend ${trendState.dayTrendDirection} (${trendState.strength})`);
      continue;
    }

    const validation = validateGexOnlyEntry(trigger, state, cfg);
    if (!validation.valid) {
      log.debug(`Lane A skip ${trigger.pattern}: ${validation.reason}`);
      continue;
    }

    // Gate: Minimum R:R at entry — GEX wall target distance must be >= 1.5x stop distance
    const minRR = cfg.min_entry_rr_ratio ?? 1.5;
    if (scored.spotPrice && trigger.target_strike && trigger.stop_strike) {
      const targetDist = Math.abs(trigger.target_strike - scored.spotPrice);
      const stopDist = Math.abs(trigger.stop_strike - scored.spotPrice);
      if (stopDist > 0 && targetDist / stopDist < minRR) {
        log.debug(`Lane A skip ${trigger.pattern}: R:R ${(targetDist / stopDist).toFixed(2)} < min ${minRR} (target=${trigger.target_strike} stop=${trigger.stop_strike})`);
        continue;
      }
    }

    let confidence = getGexOnlyConfidence(trigger, state);

    // TV regime advisory: downgrade confidence if TV strongly opposes (Lane A only)
    try {
      const tvRegime = getTvRegime();
      if (tvRegime.direction) {
        const opposing = (trigger.direction === 'BULLISH' && tvRegime.direction === 'BEARISH') ||
                         (trigger.direction === 'BEARISH' && tvRegime.direction === 'BULLISH');
        if (opposing && confidence !== 'LOW') {
          const downgraded = downgradeConfidence(confidence);
          log.info(`TV regime opposing (${tvRegime.direction}) — downgrading ${trigger.pattern} confidence ${confidence} → ${downgraded}`);
          confidence = downgraded;
        }
      }
    } catch (_) {}

    if (confidence === 'LOW') {
      log.debug(`Lane A skip ${trigger.pattern}: confidence too low (after TV downgrade)`);
      continue;
    }

    const action = trigger.direction === 'BULLISH' ? 'ENTER_CALLS' : 'ENTER_PUTS';

    log.info(`Lane A entry: ${trigger.pattern} ${trigger.direction} (${confidence}) — ${trigger.reasoning}`);
    return {
      shouldEnter: true,
      trigger,
      confidence,
      action,
      reason: `Lane A: ${trigger.pattern} (${confidence}) — ${trigger.reasoning}`,
    };
  }

  return null;
}

// ---- Entry Validation ----
// Simple: pattern confidence is the entry decision.
// We only block for obvious structural reasons, not composite score gates.

/**
 * Validate a pattern trigger.
 * Pattern confidence already encodes wall quality, regime, growth, etc.
 * We just check: wall boundaries, chop, and no-entry-after timing.
 */
export function validateGexOnlyEntry(trigger, state, config) {
  const { scored } = state;
  const cfg = config || getActiveConfig() || {};

  // 1. Call/Put Wall boundaries — don't chase past the wall
  if (scored.callWall && trigger.direction === 'BULLISH') {
    if (scored.spotPrice >= scored.callWall.strike) {
      return { valid: false, reason: `Past call wall ${scored.callWall.strike} — 83% holds as resistance` };
    }
  }
  if (scored.putWall && trigger.direction === 'BEARISH') {
    if (scored.spotPrice <= scored.putWall.strike) {
      return { valid: false, reason: `Past put wall ${scored.putWall.strike} — 89% holds as support` };
    }
  }

  // 2. Chop — configurable minimum confidence (pattern must be clear to trade in chop)
  const chopMinConf = cfg.chop_min_confidence ?? 'HIGH'; // HIGH, MEDIUM, or NONE
  if (scored.isChop && chopMinConf !== 'NONE') {
    const trendAligned = state.trendState?.isTrend && state.trendState.direction === trigger.direction;
    if (!trendAligned) {
      const confIdx = CONFIDENCE_ORDER.indexOf(trigger.confidence);
      const minIdx = CONFIDENCE_ORDER.indexOf(chopMinConf);
      if (confIdx < minIdx) {
        return { valid: false, reason: `CHOP — need ${chopMinConf} confidence, got ${trigger.confidence}` };
      }
    }
  }

  // 2b. GEX score minimum (optional — set to 0 to disable)
  const gexMinScore = cfg.gex_min_entry_score ?? 0;
  if (gexMinScore > 0 && scored.score < gexMinScore) {
    return { valid: false, reason: `GEX score ${scored.score} < min ${gexMinScore}` };
  }

  // Time gate handled by checkEntryGates (Gate 9) which uses replayTime correctly
  return { valid: true };
}

// ---- Confidence Scoring ----

const CONFIDENCE_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];

function upgradeConfidence(level) {
  const idx = CONFIDENCE_ORDER.indexOf(level);
  return idx < CONFIDENCE_ORDER.length - 1 ? CONFIDENCE_ORDER[idx + 1] : level;
}

export function downgradeConfidence(level) {
  const idx = CONFIDENCE_ORDER.indexOf(level);
  return idx > 0 ? CONFIDENCE_ORDER[idx - 1] : level;
}

/**
 * Calculate entry confidence with alignment boost, fresh node boost, cross-ticker boost.
 */
export function getGexOnlyConfidence(trigger, state) {
  const { multiAnalysis, nodeTouches } = state;
  let confidence = trigger.confidence || 'MEDIUM';

  const alignment = multiAnalysis?.alignment?.count || 0;
  const alignmentDirection = multiAnalysis?.alignment?.direction;

  // Boost: 3/3 alignment → upgrade one level
  if (alignment >= 3) {
    confidence = upgradeConfidence(confidence);
  }

  // Boost: fresh king node (0 touches)
  if (trigger.pattern === 'KING_NODE_BOUNCE' && nodeTouches) {
    const kingStrike = trigger.walls?.king;
    if (kingStrike) {
      const touches = nodeTouches[kingStrike]?.touches || 0;
      if (touches === 0) {
        confidence = upgradeConfidence(confidence);
      }
    }
  }

  // Boost: alignment direction matches trigger direction
  if (alignment >= 2 && alignmentDirection === trigger.direction && confidence === 'MEDIUM') {
    confidence = 'HIGH';
  }

  // Super boost: 3/3 alignment + same direction = A+++ trade
  if (alignment >= 3 && alignmentDirection === trigger.direction) {
    confidence = 'VERY_HIGH';
  }

  // Feature 6: Regime-specific confidence adjustment
  const { scored } = state;
  if (scored) {
    const isNegGamma = scored.environment === 'NEGATIVE GAMMA';
    const fadePatterns = ['KING_NODE_BOUNCE', 'RANGE_EDGE_FADE', 'TRIPLE_CEILING', 'TRIPLE_FLOOR', 'PIKA_PILLOW', 'REVERSE_RUG'];
    const momentumPatterns = ['RUG_PULL', 'AIR_POCKET'];

    if (isNegGamma && momentumPatterns.includes(trigger.pattern)) {
      confidence = upgradeConfidence(confidence);
    }
    if (!isNegGamma && fadePatterns.includes(trigger.pattern)) {
      confidence = upgradeConfidence(confidence);
    }
    if (isNegGamma && fadePatterns.includes(trigger.pattern) && confidence !== 'LOW') {
      confidence = downgradeConfidence(confidence);
    }
    if (!isNegGamma && momentumPatterns.includes(trigger.pattern) && confidence !== 'LOW') {
      confidence = downgradeConfidence(confidence);
    }

    // Feature 10: Call/Put wall fade boost
    if (['RANGE_EDGE_FADE', 'TRIPLE_CEILING'].includes(trigger.pattern) && scored.callWall) {
      const nearCallWall = Math.abs(scored.spotPrice - scored.callWall.strike) < 10;
      if (nearCallWall) confidence = upgradeConfidence(confidence);
    }
    if (['RANGE_EDGE_FADE', 'TRIPLE_FLOOR'].includes(trigger.pattern) && scored.putWall) {
      const nearPutWall = Math.abs(scored.spotPrice - scored.putWall.strike) < 10;
      if (nearPutWall) confidence = upgradeConfidence(confidence);
    }
  }

  return confidence;
}

// ---- Trend Pullback Entry ----

/**
 * Check for a trend pullback entry.
 * Fires when price pulls back near the support floor (bullish) or resistance ceiling (bearish)
 * during an active trend day.
 *
 * @param {object} state - { scored, multiAnalysis, nodeTouches }
 * @param {object} trendState - From getTrendState()
 * @returns {object|null} { shouldEnter, trigger, confidence, action, reason } or null
 */
export function checkTrendPullbackEntry(state, trendState) {
  if (!trendState?.isTrend) return null;
  // Only enter pullbacks when trend is CONFIRMED or STRONG (not EMERGING)
  if (trendState.strength !== 'CONFIRMED' && trendState.strength !== 'STRONG') return null;

  const { scored, multiAnalysis, nodeTouches } = state;
  const cfg = getActiveConfig() || {};

  if (cfg.trend_pullback_enabled === false) return null;

  // Chop gate for trend pullbacks (configurable)
  if ((cfg.trend_pullback_chop_block ?? true) && scored.isChop) return null;

  // Min GEX score for trend pullbacks (0 = disabled)
  const tpMinScore = cfg.trend_pullback_min_score ?? 0;
  if (tpMinScore > 0 && scored.score < tpMinScore) return null;

  const direction = trendState.direction;
  const maxDist = cfg.trend_pullback_max_dist_pts ?? 8;
  const stopBuffer = cfg.trend_pullback_stop_buffer_pts ?? 5;

  // Must be reading in trend direction
  if (scored.direction !== direction) return null;

  // Momentum must not oppose — if price is still falling, the pullback isn't done yet
  if (scored.momentum) {
    const opposes = (direction === 'BULLISH' && scored.momentum.direction === 'DOWN' && scored.momentum.strength !== 'WEAK')
      || (direction === 'BEARISH' && scored.momentum.direction === 'UP' && scored.momentum.strength !== 'WEAK');
    if (opposes) return null;
  }

  if (direction === 'BULLISH') {
    const floor = trendState.supportFloor;
    if (!floor?.strike) return null;

    // Price must be within maxDist pts of support floor
    const dist = scored.spotPrice - floor.strike;
    if (dist < 0 || dist > maxDist) return null;

    // Target = resistance ceiling, stop = floor - buffer
    const target = trendState.resistanceCeiling?.strike || (scored.spotPrice + 15);
    const stop = floor.strike - stopBuffer;

    // R:R check
    const targetDist = target - scored.spotPrice;
    const stopDist = scored.spotPrice - stop;
    const minRR = cfg.min_entry_rr_ratio ?? 1.5;
    if (stopDist > 0 && targetDist / stopDist < minRR) return null;

    let confidence = strengthToConfidence(trendState.strength);

    // TV regime advisory downgrade
    try {
      const tvRegime = getTvRegime();
      if (tvRegime.direction === 'BEARISH' && confidence !== 'LOW') {
        confidence = downgradeConfidence(confidence);
      }
    } catch (_) {}

    if (confidence === 'LOW') return null;

    const trigger = {
      pattern: 'TREND_PULLBACK',
      direction: 'BULLISH',
      confidence,
      target_strike: target,
      stop_strike: stop,
      reasoning: `Pullback to trend floor ${floor.strike} (dist ${dist.toFixed(1)}pts), target ${target}`,
      walls: { floor: floor.strike, ceiling: target },
    };

    log.info(`Trend pullback entry: BULLISH near floor ${floor.strike} (dist ${dist.toFixed(1)}pts, ${trendState.strength})`);
    return {
      shouldEnter: true,
      trigger,
      confidence,
      action: 'ENTER_CALLS',
      reason: `Trend pullback: BULLISH near floor ${floor.strike} (${trendState.strength})`,
    };
  } else {
    // BEARISH pullback — price near resistance ceiling
    const ceiling = trendState.resistanceCeiling;
    if (!ceiling?.strike) return null;

    const dist = ceiling.strike - scored.spotPrice;
    if (dist < 0 || dist > maxDist) return null;

    const target = trendState.supportFloor?.strike || (scored.spotPrice - 15);
    const stop = ceiling.strike + stopBuffer;

    const targetDist = scored.spotPrice - target;
    const stopDist = stop - scored.spotPrice;
    const minRR = cfg.min_entry_rr_ratio ?? 1.5;
    if (stopDist > 0 && targetDist / stopDist < minRR) return null;

    let confidence = strengthToConfidence(trendState.strength);

    try {
      const tvRegime = getTvRegime();
      if (tvRegime.direction === 'BULLISH' && confidence !== 'LOW') {
        confidence = downgradeConfidence(confidence);
      }
    } catch (_) {}

    if (confidence === 'LOW') return null;

    const trigger = {
      pattern: 'TREND_PULLBACK',
      direction: 'BEARISH',
      confidence,
      target_strike: target,
      stop_strike: stop,
      reasoning: `Pullback to trend ceiling ${ceiling.strike} (dist ${dist.toFixed(1)}pts), target ${target}`,
      walls: { floor: target, ceiling: ceiling.strike },
    };

    log.info(`Trend pullback entry: BEARISH near ceiling ${ceiling.strike} (dist ${dist.toFixed(1)}pts, ${trendState.strength})`);
    return {
      shouldEnter: true,
      trigger,
      confidence,
      action: 'ENTER_PUTS',
      reason: `Trend pullback: BEARISH near ceiling ${ceiling.strike} (${trendState.strength})`,
    };
  }
}

/**
 * Map trend strength to confidence level.
 */
function strengthToConfidence(strength) {
  switch (strength) {
    case 'STRONG': return 'VERY_HIGH';
    case 'CONFIRMED': return 'HIGH';
    case 'EMERGING': return 'MEDIUM';
    default: return 'LOW';
  }
}

// ---- Lane B: GEX + TV Entry ----

/**
 * Check for a Lane B (GEX + TV) phantom entry.
 * Same pattern detection as Lane A, but ALSO requires TV confirmation.
 */
export function checkLaneBEntry(state) {
  const { patterns, scored, multiAnalysis, trendState } = state;
  const cfg = getActiveConfig() || {};

  if (!patterns || patterns.length === 0) return null;
  if (cfg.lane_b_enabled === false) return null;

  const tvSnap = getSignalSnapshot();

  for (const trigger of patterns) {
    // Suppress counter-trend patterns: dayTrendDirection AND real-time CONFIRMED/STRONG must agree
    const realtimeConfirmedB = trendState?.isTrend
      && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');
    if (trendState?.dayTrendDirection && trigger.direction !== trendState.dayTrendDirection
        && realtimeConfirmedB && trendState.direction === trendState.dayTrendDirection) {
      log.info(`Trend filter (Lane B): suppressing ${trigger.pattern} (${trigger.direction}) — day trend ${trendState.dayTrendDirection} (${trendState.strength})`);
      continue;
    }

    // Same structural validation as Lane A
    const validation = validateGexOnlyEntry(trigger, state, cfg);
    if (!validation.valid) continue;

    // ADDITIONAL: TV must confirm the direction
    const direction = trigger.direction;
    const tvWeight = direction === 'BULLISH'
      ? (tvSnap.spx?.weighted_score?.bullish || 0)
      : (tvSnap.spx?.weighted_score?.bearish || 0);

    const minTvWeight = cfg.lane_b_min_tv_weight ?? 0.5;
    if (tvWeight < minTvWeight) continue;

    // Check minimum TV indicator count
    const minIndicators = cfg.lane_b_min_tv_indicators ?? 1;
    const signals = tvSnap.spx?.signals || {};
    const expected = direction === 'BULLISH' ? 'BULLISH' : 'BEARISH';

    let tvConfirmCount = 0;
    const bravo3m = signals['bravo_3m'];
    const tango3m = signals['tango_3m'];
    const echo3m = signals['echo_3m'];

    if (bravo3m && !bravo3m.isStale && bravo3m.classification === expected) tvConfirmCount++;
    if (tango3m && !tango3m.isStale && tango3m.classification === expected) tvConfirmCount++;
    if (echo3m && !echo3m.isStale && echo3m.classification === expected) tvConfirmCount++;

    if (tvConfirmCount < minIndicators) continue;

    const confidence = getGexOnlyConfidence(trigger, state);
    const action = direction === 'BULLISH' ? 'ENTER_CALLS' : 'ENTER_PUTS';

    log.info(`Lane B entry: ${trigger.pattern} ${direction} + TV confirm (${tvConfirmCount} indicators, weight ${tvWeight.toFixed(1)})`);
    return {
      shouldEnter: true,
      trigger,
      confidence,
      action,
      tvConfirmCount,
      tvWeight,
      reason: `Lane B: ${trigger.pattern} (${confidence}) + TV confirm (${tvConfirmCount} indicators)`,
    };
  }

  return null;
}
