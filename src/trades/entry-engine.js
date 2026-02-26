/**
 * Algorithmic Entry Engine
 * Pure pattern + validation entry decisions. No agent call needed.
 *
 * Lane A: GEX-only patterns → live trades
 * Lane B: GEX patterns + TV confirmation → phantom trades
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot } from '../tv/tv-signal-store.js';
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
  const { patterns, scored, multiAnalysis, nodeTouches } = state;
  const cfg = getActiveConfig() || {};

  if (!patterns || patterns.length === 0) return null;
  if (cfg.lane_a_enabled === false) return null;

  for (const trigger of patterns) {
    const validation = validateGexOnlyEntry(trigger, state, cfg);
    if (!validation.valid) {
      log.debug(`Lane A skip ${trigger.pattern}: ${validation.reason}`);
      continue;
    }

    const confidence = getGexOnlyConfidence(trigger, state);
    if (confidence === 'LOW') {
      log.debug(`Lane A skip ${trigger.pattern}: confidence too low`);
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

  // Gate 1: Alignment check
  if (alignment < minAlignment) {
    if (!(alignment >= 1 && scored.score >= overrideScore)) {
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
        if (distFromMidPct < 0.05) {
          return { valid: false, reason: `At midpoint between ${nearestBelow.strike} and ${nearestAbove.strike} — R:R ~1:1` };
        }
      }
    }
  }

  // Gate 3: Minimum GEX score
  const minScore = cfg.gex_only_min_score ?? 50;
  if (scored.score < minScore) {
    return { valid: false, reason: `GEX score ${scored.score} < min ${minScore}` };
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

// ---- Lane B: GEX + TV Entry ----

/**
 * Check for a Lane B (GEX + TV) phantom entry.
 * Same pattern detection as Lane A, but ALSO requires TV confirmation.
 */
export function checkLaneBEntry(state) {
  const { patterns, scored, multiAnalysis } = state;
  const cfg = getActiveConfig() || {};

  if (!patterns || patterns.length === 0) return null;
  if (cfg.lane_b_enabled === false) return null;

  const tvSnap = getSignalSnapshot();

  for (const trigger of patterns) {
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
