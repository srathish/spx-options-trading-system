/**
 * Algorithmic Entry Engine
 * Pure pattern + validation entry decisions. No agent call needed.
 *
 * Lane A: GEX-only patterns → live trades
 * Lane B: GEX patterns + TV confirmation → phantom trades
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
import { nowET } from '../utils/market-hours.js';
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
    // Suppress counter-trend patterns: only use sticky dayTrendDirection (set after sustained CONFIRMED)
    if (trendState?.dayTrendDirection && trigger.direction !== trendState.dayTrendDirection) {
      log.info(`Trend filter: suppressing ${trigger.pattern} (${trigger.direction}) — day trend ${trendState.dayTrendDirection}`);
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

// ---- Entry Validation (4 gates) ----

/**
 * Validate a pattern trigger against 4 structural gates.
 * Gate 1: Alignment ≥ 2/3 (or GEX override ≥ alignment_override_gex_score)
 * Gate 2: Not at midpoint danger zone (skip for AIR_POCKET, KING_NODE_BOUNCE)
 * Gate 3: GEX score ≥ gex_only_min_score
 * Gate 4: Power hour needs GEX ≥ power_hour_min_gex_score
 */
export function validateGexOnlyEntry(trigger, state, config) {
  const { scored, multiAnalysis } = state;
  const cfg = config || getActiveConfig() || {};

  const alignment = multiAnalysis?.alignment?.count || 0;
  const minAlignment = cfg.alignment_min_for_entry ?? 2;
  const overrideScore = cfg.alignment_override_gex_score ?? 85;

  // Gate 0.5: Chop environment — require HIGH confidence + higher score for non-breakout patterns
  // Skip for trend-aligned entries (consolidation within a trend is not chop)
  if (scored.isChop) {
    const trendState = state.trendState;
    const isTrendAligned = trendState?.isTrend && trendState.direction === trigger.direction
      && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');

    if (!isTrendAligned) {
      const CHOP_EXEMPT_PATTERNS = ['AIR_POCKET', 'KING_NODE_BOUNCE'];
      if (!CHOP_EXEMPT_PATTERNS.includes(trigger.pattern)) {
        if (trigger.confidence !== 'HIGH' && trigger.confidence !== 'VERY_HIGH') {
          return { valid: false, reason: `CHOP environment — ${trigger.pattern} needs HIGH confidence, got ${trigger.confidence}` };
        }
        const chopMinScore = cfg.chop_min_entry_score ?? 80;
        if (scored.score < chopMinScore) {
          return { valid: false, reason: `CHOP environment — GEX ${scored.score} < ${chopMinScore} required` };
        }
      }
    }
  }

  // Gate 1: Alignment check (bypass for structural single-ticker patterns)
  const STRUCTURAL_PATTERNS_ALIGN = ['RUG_PULL', 'REVERSE_RUG', 'KING_NODE_BOUNCE', 'PIKA_PILLOW'];
  if (alignment < minAlignment) {
    if (STRUCTURAL_PATTERNS_ALIGN.includes(trigger.pattern) && trigger.confidence !== 'LOW') {
      log.info(`Gate 1 bypass: ${trigger.pattern} (${trigger.confidence}) — structural setup, alignment ${alignment}/3 waived`);
    } else if (alignment >= 1 && scored.score >= overrideScore) {
      // Original override: 1/3 alignment + high score
    } else {
      return { valid: false, reason: `Alignment ${alignment}/3 < ${minAlignment} (GEX ${scored.score} < override ${overrideScore})` };
    }
  }

  // Gate 2: Not at midpoint (skip for breakout patterns)
  const breakoutPatterns = ['AIR_POCKET', 'KING_NODE_BOUNCE'];
  if (!breakoutPatterns.includes(trigger.pattern)) {
    if (scored.wallsAbove?.length > 0 && scored.wallsBelow?.length > 0) {
      const nearestAbove = scored.wallsAbove[0];
      const nearestBelow = scored.wallsBelow[0];
      if (nearestAbove.type === 'positive' && nearestBelow.type === 'positive') {
        const midpoint = (nearestAbove.strike + nearestBelow.strike) / 2;
        const distFromMidPct = Math.abs(scored.spotPrice - midpoint) / scored.spotPrice * 100;
        const midpointBuffer = cfg.midpoint_danger_zone_pct ?? 0.15;
        if (distFromMidPct < midpointBuffer) {
          return { valid: false, reason: `At midpoint between ${nearestBelow.strike} and ${nearestAbove.strike} — dist ${distFromMidPct.toFixed(2)}% < ${midpointBuffer}%` };
        }
      }
    }
  }

  // Gate 3: Minimum GEX score (conditional bypass for structural patterns)
  const STRUCTURAL_PATTERNS = ['RUG_PULL', 'REVERSE_RUG', 'KING_NODE_BOUNCE', 'PIKA_PILLOW'];
  const minScore = cfg.gex_only_min_score ?? 50;
  const structuralMinScore = cfg.structural_min_score ?? 60;
  if (scored.score < minScore) {
    if (STRUCTURAL_PATTERNS.includes(trigger.pattern) && trigger.confidence !== 'LOW') {
      // Structural patterns still need a minimum score floor
      if (scored.score < structuralMinScore) {
        return { valid: false, reason: `Structural ${trigger.pattern}: GEX ${scored.score} < structural min ${structuralMinScore}` };
      }
      log.info(`Gate 3 bypass: ${trigger.pattern} (${trigger.confidence}) overrides GEX score ${scored.score} < ${minScore} (above structural min ${structuralMinScore})`);
    } else {
      return { valid: false, reason: `GEX score ${scored.score} < min ${minScore}` };
    }
  }

  // Gate 4: Power hour check (after 3:30 PM ET)
  const etNow = nowET();
  const mins = etNow.hour * 60 + etNow.minute;
  if (mins >= 930) { // 15:30
    const powerMin = cfg.power_hour_min_gex_score ?? 80;
    if (scored.score < powerMin) {
      return { valid: false, reason: `Power hour: GEX ${scored.score} < ${powerMin} required` };
    }
  }

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

  const direction = trendState.direction;
  const minScore = cfg.trend_pullback_min_score ?? 40;
  const maxDist = cfg.trend_pullback_max_dist_pts ?? 8;
  const stopBuffer = cfg.trend_pullback_stop_buffer_pts ?? 5;

  // Must be reading in trend direction
  if (scored.direction !== direction) return null;

  // Minimum GEX score
  if (scored.score < minScore) return null;

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
    // Suppress counter-trend patterns: only use sticky dayTrendDirection
    if (trendState?.dayTrendDirection && trigger.direction !== trendState.dayTrendDirection) {
      log.info(`Trend filter (Lane B): suppressing ${trigger.pattern} (${trigger.direction}) — day trend ${trendState.dayTrendDirection}`);
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
