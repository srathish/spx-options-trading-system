/**
 * Lane C: Trend Day Overlay
 *
 * Philosophy: On trend days, your job is to NOT get out, not to get in perfectly.
 *
 * v8 — Weighted pre-session scoring (0–9) with confirmation gate:
 *   +2  GEX negative at open (core requirement)
 *   +2  Trinity: SPX + QQQ + SPY all negative GEX
 *   +2  GEX delta > 2σ negative vs 10-day rolling avg
 *   +1  Overnight range > 40 pts AND directional
 *   +1  Prior day closed near lows (last-30-min trend)
 *   +1  VIX proxy: very deep negative GEX (>60M) at open
 *
 * Threshold: score ≥ 5 to activate
 * Confirmation gate: first 10-min candle > 8 pts AND aligns with GEX bias
 *
 * Entry: after confirmation, first trend-direction signal
 * Stop: structural (nearest GEX wall behind entry, 10-15 pt range)
 * Exit: trailing stop only, time stop (3:45), or GEX regime reversal
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('LaneC');

// ---- Lane C State ----

let laneCState = {
  active: false,
  score: 0,
  signals: {},
  direction: null,         // inferred trend direction from early frames
  position: null,          // Lane C's own position (separate from Lane A)
  priorDayNetGex: null,    // stored from previous day for delta comparison
  entriesUsed: 0,          // track entries per day for max limit
  stopsHit: 0,             // track consecutive stops to detect wrong-side days
  confirmed: false,        // confirmation gate passed
  priorDayCloseNearLow: false, // set by replay from prior day analysis
  gexDeltaHistory: [],     // rolling 10-day GEX values for std dev calculation
};

// ---- Day-Type Tracker ----
const dayTracker = [];

export function getDayTracker() {
  return [...dayTracker];
}

function recordDayResult(date, activated, score, signals, confirmed, trades) {
  const lcTrades = trades.filter(t => t.laneC);
  const lcPnl = lcTrades.reduce((sum, t) => sum + t.spxChange, 0);
  const lcWins = lcTrades.filter(t => t.isWin).length;
  const lcStops = lcTrades.filter(t => t.exitReason === 'LC_STOP_HIT').length;

  dayTracker.push({
    date,
    activated,
    score,
    signals,
    confirmed,
    trades: lcTrades.length,
    wins: lcWins,
    stops: lcStops,
    pnl: Math.round(lcPnl * 100) / 100,
  });
}

export { recordDayResult };

// ---- Pre-Session Trend Day Scoring (v8 weighted) ----

/**
 * Score the first N frames of the day to determine if Lane C should activate.
 *
 * @param {object} opts
 * @param {number} opts.spxwNetGex - SPXW total net GEX from first frame
 * @param {number|null} opts.priorDayNetGex - Prior day's net GEX (if available)
 * @param {number|null} opts.spyNetGex - SPY net GEX from first frame
 * @param {number|null} opts.qqqNetGex - QQQ net GEX from first frame
 * @param {number} opts.overnightRange - Overnight/early range in pts
 * @param {number} opts.earlyVelocity - Price change across first N frames (signed)
 * @param {number} opts.spotPrice - Current spot price
 * @param {string} opts.spxwDirection - GEX scored direction from first frame
 * @returns {object} { active, score, signals, direction }
 */
export function scoreTrendDay(opts) {
  const cfg = getActiveConfig() || {};
  const minScore = cfg.lane_c_min_score ?? 5;

  let score = 0;
  const signals = {};

  // Signal 1 (weight 2): GEX negative at open — core requirement
  const gexNegThreshold = cfg.lane_c_gex_neg_threshold ?? 0;
  if (opts.spxwNetGex < gexNegThreshold) {
    score += 2;
    signals.gex_negative = true;
  }

  // Signal 2 (weight 2): Trinity — all three tickers negative GEX
  const trinityNeg = opts.spxwNetGex < 0 &&
    (opts.qqqNetGex !== null && opts.qqqNetGex < 0) &&
    (opts.spyNetGex !== null && opts.spyNetGex < 0);
  if (trinityNeg) {
    score += 2;
    signals.trinity_negative = true;
  } else if (opts.qqqNetGex !== null && opts.qqqNetGex < 0 && opts.spxwNetGex < 0) {
    // Partial: SPX + QQQ negative (SPY often positive)
    score += 1;
    signals.spx_qqq_negative = true;
  }

  // Signal 3 (weight 2): GEX delta — large negative shift vs rolling average
  const gexDeltaThreshold = cfg.lane_c_gex_delta_threshold ?? -20_000_000;
  if (opts.priorDayNetGex !== null) {
    const delta = opts.spxwNetGex - opts.priorDayNetGex;

    // Check vs rolling history for std dev calculation
    const history = laneCState.gexDeltaHistory;
    if (history.length >= 5) {
      const mean = history.reduce((s, v) => s + v, 0) / history.length;
      const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;
      const stdDev = Math.sqrt(variance);
      const zScore = stdDev > 0 ? (opts.spxwNetGex - mean) / stdDev : 0;

      if (zScore < -2) {
        score += 2;
        signals.gex_delta_2sigma = true;
      } else if (delta < gexDeltaThreshold) {
        score += 2;
        signals.gex_delta_negative = true;
      }
    } else if (delta < gexDeltaThreshold) {
      score += 2;
      signals.gex_delta_negative = true;
    }
  } else {
    // No prior day — deep negative absolute as fallback
    const deepNegThreshold = cfg.lane_c_gex_deep_neg_threshold ?? -30_000_000;
    if (opts.spxwNetGex < deepNegThreshold) {
      score += 1;
      signals.gex_deep_negative = true;
    }
  }

  // Signal 4 (weight 1): Overnight range > 40 pts AND directional (not gap-fill)
  const overnightThreshold = cfg.lane_c_overnight_range_pts ?? 40;
  if (opts.overnightRange >= overnightThreshold) {
    // Check if directional: velocity should be > 60% of range (not choppy back-and-forth)
    const velocity = opts.earlyVelocity || 0;
    const isDirectional = Math.abs(velocity) > opts.overnightRange * 0.6;
    if (isDirectional) {
      score += 1;
      signals.overnight_range_directional = true;
    }
  }

  // Signal 5 (weight 1): Prior day closed near lows
  if (laneCState.priorDayCloseNearLow) {
    score += 1;
    signals.prior_day_near_lows = true;
  }

  // Signal 6 (weight 1): VIX proxy — very deep negative GEX = high vol regime
  if (opts.spxwNetGex < -60_000_000) {
    score += 1;
    signals.vix_proxy_deep_neg = true;
  }

  // Mandatory gate: negative GEX OR 2σ delta shift must be present
  // Either the regime IS negative gamma now, or a structural shift is arriving
  // (catches crash-during-session days like Mar 3 where absolute GEX was still positive at open)
  const hasNegGex = signals.gex_negative || signals.gex_deep_negative || signals.vix_proxy_deep_neg;
  const hasDeltaShift = signals.gex_delta_2sigma;
  const active = score >= minScore && (hasNegGex || hasDeltaShift);

  // Infer initial trend direction from GEX + early price action
  let direction = null;
  if (active) {
    direction = opts.spxwDirection || null;
  }

  laneCState = {
    ...laneCState,
    active,
    score,
    signals,
    direction,
    position: null,
    entriesUsed: 0,
    stopsHit: 0,
    confirmed: false,
  };

  if (active) {
    log.info(`LANE C ACTIVATED: score ${score}/${minScore} (max 9) | negGEX=${hasNegGex} | signals: ${JSON.stringify(signals)} | direction: ${direction} | awaiting confirmation`);
  } else {
    const reason = !(hasNegGex || hasDeltaShift) ? 'no negative GEX or 2σ delta' : `score ${score} < ${minScore}`;
    log.info(`Lane C inactive: ${reason} | score ${score}/${minScore} | signals: ${JSON.stringify(signals)}`);
  }

  return { active, score, signals, direction };
}

// ---- Structural Exhaustion Detection ----

/**
 * Check whether a large first-candle impulse is exhausted or has fuel remaining.
 * Instead of arbitrary size thresholds, checks GEX structure:
 *   1. Has price already reached the GEX target wall? (magnet satisfied)
 *   2. Is there absorption at the impulse destination? (wall growing as price pushes into it)
 *   3. Did price cross through the zero gamma level? (regime flip happened, recovery likely)
 *   4. Is the second candle retracing the impulse? (exhaustion confirmed by price action)
 *
 * @param {object} opts
 * @param {number} opts.openSpot - 9:30 spot
 * @param {number} opts.currentSpot - current spot
 * @param {object} opts.scored - GEX scorer output
 * @param {Map|null} opts.nodeTrends - wall trend data from getNodeTrends()
 * @returns {object} { exhausted, reason, detail }
 */
function checkImpulseExhaustion({ openSpot, currentSpot, scored, nodeTrends }) {
  const move = currentSpot - openSpot;
  const absMove = Math.abs(move);
  const impulseDir = move > 0 ? 'BULLISH' : 'BEARISH';

  // Only check exhaustion on large impulses (>30 pts in first candle)
  if (absMove < 30) return { exhausted: false };

  const reasons = [];

  // Check 1: GEX target wall reached — the magnet that was pulling price has been satisfied
  if (scored.targetWall?.strike) {
    const target = scored.targetWall.strike;
    const targetReached = impulseDir === 'BEARISH'
      ? currentSpot <= target          // bearish impulse reached negative wall below
      : currentSpot >= target;         // bullish impulse reached negative wall above

    if (targetReached) {
      reasons.push(`GEX_TARGET_REACHED (target ${target}, spot ${currentSpot.toFixed(0)})`);
    }
  }

  // Check 2: Absorption — positive wall near spot is GROWING (dealers absorbing the move)
  if (nodeTrends) {
    for (const [strike, trend] of nodeTrends) {
      if (trend.trend !== 'GROWING') continue;
      const dist = Math.abs(strike - currentSpot);
      if (dist > 15) continue; // only walls near current price
      // Positive wall growing near spot = absorption barrier
      if (trend.currentValue > 0 && trend.changePct30 >= 0.20) {
        reasons.push(`ABSORPTION (positive wall at ${strike} growing ${(trend.changePct30 * 100).toFixed(0)}%)`);
        break;
      }
    }
  }

  // Check 3: Zero gamma crossover — only when crossing INTO negative gamma
  // Bearish impulse crossing below ZGL = dealers lost their hedge, regime worsened overnight → recovery likely
  // Bullish impulse crossing above ZGL = recovery back to positive gamma → NOT exhaustion, trend is starting
  if (scored.zeroGammaLevel && impulseDir === 'BEARISH') {
    const zgl = scored.zeroGammaLevel;
    const crossedBelow = openSpot > zgl && currentSpot < zgl;

    if (crossedBelow) {
      reasons.push(`CROSSED_ZERO_GAMMA (ZGL ${zgl.toFixed(0)}, regime flip in impulse)`);
    }
  }

  // Exhaustion = structural signals + impulse size
  // Any structural signal on >50pt move: exhausted (structural confirmation of extreme move)
  // Two+ structural signals on any move >30pt: exhausted
  // One signal on 30-50pt move: caution (require 2nd candle)
  // No structural signals but >50pt: caution fallback (not enough data to confirm structure)
  const isLargeImpulse = absMove >= 50;

  if (reasons.length >= 2 || (reasons.length >= 1 && isLargeImpulse)) {
    return {
      exhausted: true,
      requireSecondCandle: false,
      reason: reasons.join(' + '),
      detail: `${absMove.toFixed(0)}pt impulse with ${reasons.length} exhaustion signal(s)`,
    };
  }

  if (reasons.length === 1) {
    return {
      exhausted: false,
      requireSecondCandle: true,
      reason: reasons.join(' + '),
      detail: `${absMove.toFixed(0)}pt impulse with caution signal — requiring 2nd candle`,
    };
  }

  // Fallback: extreme impulse (>50 pts) with no structural data available
  // At 9:40, node trends only have ~2 cycles — absorption can't fire.
  // Require second candle as safety check for large moves with insufficient structural data.
  if (isLargeImpulse) {
    return {
      exhausted: false,
      requireSecondCandle: true,
      reason: 'LARGE_IMPULSE_NO_STRUCTURAL_DATA',
      detail: `${absMove.toFixed(0)}pt impulse — insufficient structural data at 9:40, requiring 2nd candle`,
    };
  }

  return { exhausted: false };
}

// ---- Confirmation Gate ----

/**
 * Confirmation gate: first 10-minute candle must move > 8 pts in one direction
 * AND that direction must align with GEX bias.
 * Called once at ~9:40 with the 9:30-9:40 price data.
 *
 * For large impulses (>30 pts), runs structural exhaustion check instead of
 * arbitrary size thresholds. Checks whether the GEX target was reached, whether
 * walls are absorbing the move, and whether price crossed the zero gamma level.
 *
 * @param {number} openSpot - Spot price at 9:30
 * @param {number} currentSpot - Spot price at 9:40
 * @param {string} gexDirection - GEX scored direction
 * @param {object} [scored] - GEX scorer output (for exhaustion check)
 * @param {Map|null} [nodeTrends] - wall trend data (for absorption check)
 * @returns {object} { confirmed, direction }
 */
export function checkConfirmationGate(openSpot, currentSpot, gexDirection, scored, nodeTrends) {
  if (!laneCState.active || laneCState.confirmed) return { confirmed: laneCState.confirmed, direction: laneCState.direction };

  const cfg = getActiveConfig() || {};
  const confirmThresholdPts = cfg.lane_c_confirm_threshold_pts ?? 8;

  const move = currentSpot - openSpot;
  const absMove = Math.abs(move);
  const priceDirection = move > 0 ? 'BULLISH' : 'BEARISH';

  // Structural exhaustion check for large impulses
  if (absMove >= 30 && scored) {
    const exhaust = checkImpulseExhaustion({ openSpot, currentSpot, scored, nodeTrends });

    if (exhaust.exhausted) {
      log.info(`Lane C DEACTIVATED: ${exhaust.detail} — ${exhaust.reason}`);
      laneCState.active = false;
      laneCState.confirmed = false;
      return { confirmed: false, direction: null };
    }

    if (exhaust.requireSecondCandle) {
      laneCState.confirmed = false;
      laneCState.direction = priceDirection;
      laneCState._requireSecondCandle = true;
      log.info(`Lane C CAUTION: ${exhaust.detail} — ${exhaust.reason} — requiring 2nd candle`);
      return { confirmed: false, direction: priceDirection };
    }
  }

  if (absMove < confirmThresholdPts) {
    log.info(`Lane C confirmation WAITING: ${move > 0 ? '+' : ''}${move.toFixed(1)} pts (need ${confirmThresholdPts}+)`);
    return { confirmed: false, direction: laneCState.direction };
  }

  // Direction must align with GEX bias OR be very strong (> 2x threshold)
  const aligned = priceDirection === gexDirection || priceDirection === laneCState.direction;
  const veryStrong = absMove >= confirmThresholdPts * 2;

  if (aligned || veryStrong) {
    laneCState.confirmed = true;
    laneCState.direction = priceDirection; // override with confirmed direction
    log.info(`LANE C CONFIRMED: ${priceDirection} | ${move > 0 ? '+' : ''}${move.toFixed(1)} pts in first candle | ${aligned ? 'GEX aligned' : 'STRONG momentum override'}`);
    return { confirmed: true, direction: priceDirection };
  }

  // Price moved but against GEX bias — deactivate Lane C
  log.info(`Lane C DEACTIVATED: price ${priceDirection} (${move > 0 ? '+' : ''}${move.toFixed(1)} pts) conflicts with GEX ${gexDirection} — likely gap-fill day`);
  laneCState.active = false;
  laneCState.confirmed = false;
  return { confirmed: false, direction: null };
}

/**
 * Extended confirmation: called at 10:00 for large impulses (>50 pts first candle).
 *
 * At 9:50 (2nd candle), the waterfall/spike often continues briefly before reversing.
 * Mar 6 and Mar 9 both continued selling for 10 more minutes before bouncing.
 * By 10:00 (30 min after open), the reversal is usually visible.
 *
 * Check: from the first candle extreme (9:40 spot), has price retraced >30%?
 * If yes → exhaustion confirmed, deactivate.
 * If price is still trending → confirm entry.
 *
 * Also checks structural signals (absorption, target reached) which now have
 * 6+ frames of node data to work with.
 *
 * @param {number} openSpot - Spot at 9:30
 * @param {number} firstCandleSpot - Spot at 9:40 (end of first candle)
 * @param {number} currentSpot - Current spot at 10:00
 * @param {object} [scored] - GEX scorer output for structural checks
 * @param {Map|null} [nodeTrends] - Node trend data for absorption detection
 * @returns {object} { confirmed, direction }
 */
export function checkSecondCandleConfirmation(openSpot, firstCandleSpot, currentSpot, scored, nodeTrends) {
  if (!laneCState.active || laneCState.confirmed || !laneCState._requireSecondCandle) {
    return { confirmed: laneCState.confirmed, direction: laneCState.direction };
  }

  const firstCandleDir = laneCState.direction; // set by first candle
  const totalMove = currentSpot - openSpot;
  const retrace = currentSpot - firstCandleSpot;
  const firstCandleSize = Math.abs(firstCandleSpot - openSpot);

  // Is the retrace going against the impulse direction?
  const retraceDirection = retrace > 0 ? 'BULLISH' : 'BEARISH';
  const isRetracing = retraceDirection !== firstCandleDir;
  const reversalRatio = isRetracing ? Math.abs(retrace) / firstCandleSize : 0;

  // Also run structural exhaustion check now that we have more node data
  let structuralExhaustion = false;
  if (scored) {
    const exhaust = checkImpulseExhaustion({ openSpot, currentSpot: firstCandleSpot, scored, nodeTrends });
    if (exhaust.exhausted || exhaust.requireSecondCandle) {
      log.info(`Lane C structural signal at 10:00: ${exhaust.reason}`);
      structuralExhaustion = true;
    }
  }

  // Deactivate if:
  // 1. Price retraced >30% of the first candle (price action confirms exhaustion)
  // 2. OR structural exhaustion detected AND any retrace at all
  if (reversalRatio >= 0.30 || (structuralExhaustion && isRetracing)) {
    laneCState.active = false;
    laneCState.confirmed = false;
    laneCState._requireSecondCandle = false;
    const reason = reversalRatio >= 0.30
      ? `price retraced ${(reversalRatio * 100).toFixed(0)}% of impulse`
      : `structural exhaustion + ${(reversalRatio * 100).toFixed(0)}% retrace`;
    log.info(`Lane C DEACTIVATED at 10:00: ${reason} (${retrace > 0 ? '+' : ''}${retrace.toFixed(1)} pts since 9:40) — impulse exhaustion confirmed`);
    return { confirmed: false, direction: null };
  }

  // Price still trending in impulse direction — confirm
  laneCState.confirmed = true;
  laneCState._requireSecondCandle = false;
  log.info(`LANE C CONFIRMED (10:00 check): ${firstCandleDir} | retrace ratio: ${(reversalRatio * 100).toFixed(0)}% | total move: ${totalMove > 0 ? '+' : ''}${totalMove.toFixed(1)} pts`);
  return { confirmed: true, direction: firstCandleDir };
}

// ---- Direction Update ----

/**
 * Update Lane C direction based on ongoing price action.
 * Only called AFTER confirmation gate has passed.
 */
export function updateLaneCDirection(spotPrice, firstSpot, scored) {
  if (!laneCState.active || !laneCState.confirmed) return;

  const move = spotPrice - firstSpot;
  const absMoveThreshold = 10; // need 10+ pts move to override confirmed direction

  if (Math.abs(move) >= absMoveThreshold) {
    const priceDirection = move > 0 ? 'BULLISH' : 'BEARISH';
    if (laneCState.direction !== priceDirection) {
      log.info(`Lane C direction updated: ${laneCState.direction} → ${priceDirection} (price moved ${move > 0 ? '+' : ''}${move.toFixed(1)} pts)`);
      laneCState.direction = priceDirection;
    }
  }
}

// ---- Lane C Entry Check ----

/**
 * Check if Lane C should enter a position.
 * Requires confirmation gate to have passed.
 */
export function checkLaneCEntry(scored, detectedPatterns, trendState, replayTime) {
  if (!laneCState.active || !laneCState.confirmed || laneCState.position) return null;

  const cfg = getActiveConfig() || {};
  const direction = laneCState.direction;
  if (!direction) return null;

  // Max entries per day
  const maxEntries = cfg.lane_c_max_entries ?? 2;
  if (laneCState.entriesUsed >= maxEntries) return null;

  // After 2 consecutive stops, Lane C direction was wrong — stop trying
  if (laneCState.stopsHit >= 2) return null;

  // Time window — Lane C enters 9:45-15:00
  const lcEntryStart = cfg.lane_c_entry_start_minute ?? 45;
  const hour = replayTime.hour;
  const minute = replayTime.minute;
  const timeOk = (hour === 9 && minute >= lcEntryStart) || (hour >= 10 && hour < 15);
  if (!timeOk) return null;

  // Find a matching pattern in the trend direction
  const trendPatterns = detectedPatterns.filter(p => p.direction === direction);

  let bestTrigger = null;
  const preferred = ['TREND_PULLBACK', 'REVERSE_RUG', 'RUG_PULL', 'MAGNET_PULL', 'KING_NODE_BOUNCE'];
  for (const pref of preferred) {
    const match = trendPatterns.find(p => p.pattern === pref);
    if (match) {
      bestTrigger = match;
      break;
    }
  }

  if (!bestTrigger && trendPatterns.length > 0) {
    bestTrigger = trendPatterns[0];
  }

  if (!bestTrigger) return null;

  // Structural stop: use the pattern's stop strike, clamped to 10-15 pts
  const stopStrike = computeStructuralStop(direction, scored, bestTrigger, cfg);

  return {
    shouldEnter: true,
    action: direction === 'BULLISH' ? 'ENTER_CALLS' : 'ENTER_PUTS',
    trigger: {
      pattern: `LC_${bestTrigger.pattern}`,
      direction,
      confidence: bestTrigger.confidence || 'HIGH',
      target_strike: null, // no fixed target — trail only
      stop_strike: stopStrike,
      reasoning: `Lane C trend entry: ${bestTrigger.pattern} ${direction} (score ${laneCState.score}/9, confirmed)`,
      walls: bestTrigger.walls || {},
      laneC: true,
    },
  };
}

/**
 * Check if Lane C should enter via TREND_PULLBACK.
 */
export function checkLaneCTrendPullback(pullbackResult) {
  if (!laneCState.active || !laneCState.confirmed || laneCState.position) return null;
  if (!pullbackResult?.shouldEnter) return null;

  const cfg = getActiveConfig() || {};
  const maxEntries = cfg.lane_c_max_entries ?? 2;
  if (laneCState.entriesUsed >= maxEntries) return null;
  if (laneCState.stopsHit >= 2) return null;

  const direction = laneCState.direction;
  if (!direction || pullbackResult.trigger.direction !== direction) return null;

  const trigger = { ...pullbackResult.trigger };
  trigger.pattern = `LC_${trigger.pattern}`;
  trigger.laneC = true;

  // Structural stop
  const minStop = cfg.lane_c_stop_min_pts ?? 10;
  const maxStop = cfg.lane_c_stop_max_pts ?? 15;
  const spotPrice = trigger.walls?.floor || trigger.stop_strike;
  if (spotPrice) {
    const rawDist = Math.abs(trigger.stop_strike - spotPrice);
    const clampedDist = Math.max(minStop, Math.min(maxStop, rawDist));
    trigger.stop_strike = direction === 'BULLISH'
      ? spotPrice - clampedDist
      : spotPrice + clampedDist;
  }

  return {
    shouldEnter: true,
    action: pullbackResult.action,
    trigger,
  };
}

/**
 * Compute structural stop: nearest GEX wall behind entry, clamped to 10-15 pts.
 */
function computeStructuralStop(direction, scored, pattern, cfg) {
  const spotPrice = scored.spotPrice;
  const minStop = cfg.lane_c_stop_min_pts ?? 10;
  const maxStop = cfg.lane_c_stop_max_pts ?? 15;

  // Look for nearest significant wall behind entry
  let structuralLevel = null;
  if (direction === 'BULLISH') {
    // Find strongest wall below spot
    const wallsBelow = scored.wallsBelow || [];
    const significant = wallsBelow.filter(w => w.type === 'positive' && Math.abs(w.strike - spotPrice) >= 3);
    if (significant.length > 0) {
      structuralLevel = significant[0].strike; // nearest significant positive wall below
    }
  } else {
    const wallsAbove = scored.wallsAbove || [];
    const significant = wallsAbove.filter(w => w.type === 'positive' && Math.abs(w.strike - spotPrice) >= 3);
    if (significant.length > 0) {
      structuralLevel = significant[0].strike;
    }
  }

  // If we found a structural level, use it (with buffer) clamped to min/max
  if (structuralLevel) {
    const rawDist = Math.abs(structuralLevel - spotPrice) + 2; // 2pt buffer past the wall
    const clampedDist = Math.max(minStop, Math.min(maxStop, rawDist));
    return direction === 'BULLISH'
      ? spotPrice - clampedDist
      : spotPrice + clampedDist;
  }

  // Fallback: use pattern stop if available, clamped
  if (pattern.stop_strike) {
    const patternDist = Math.abs(pattern.stop_strike - spotPrice);
    const clampedDist = Math.max(minStop, Math.min(maxStop, patternDist));
    return direction === 'BULLISH'
      ? spotPrice - clampedDist
      : spotPrice + clampedDist;
  }

  // Last resort: use max stop distance
  return direction === 'BULLISH'
    ? spotPrice - maxStop
    : spotPrice + maxStop;
}

// ---- Helpers ----

function getMinutesSinceEntry(position, replayTime) {
  if (!position.openedAt || !replayTime) return Infinity;
  // openedAt is a string like "2026-03-09 09:56:00", replayTime is a Luxon DateTime
  const parts = position.openedAt.split(/[- :]/);
  const entryHour = parseInt(parts[3], 10);
  const entryMinute = parseInt(parts[4], 10);
  return (replayTime.hour - entryHour) * 60 + (replayTime.minute - entryMinute);
}

// ---- Lane C Exit Check ----

/**
 * Lane C exit logic — only four exit reasons:
 * 1. STOP_HIT (structural, 10-15 pts)
 * 2. TRAILING_STOP (wide: 12-15 pts behind high watermark)
 * 3. TIME_STOP (close at 3:45 PM)
 * 4. REGIME_REVERSAL (GEX flips + price confirms)
 */
export function checkLaneCExits(position, currentSpot, scored, replayTime, cfg) {
  if (!position || !position.laneC) return { exit: false };

  const isBullish = position.direction === 'BULLISH';
  const spxProgress = isBullish
    ? currentSpot - position.entrySpx
    : position.entrySpx - currentSpot;

  // Track high watermark
  if (spxProgress > position.bestSpxChange) {
    position.bestSpxChange = spxProgress;
  }

  // 1. STOP_HIT — structural stop
  if (position.stopSpx) {
    const stopHit = isBullish
      ? currentSpot <= position.stopSpx
      : currentSpot >= position.stopSpx;
    if (stopHit) return { exit: true, reason: 'LC_STOP_HIT', exitPrice: position.stopSpx };
  }

  // 2. TRAILING_STOP — wide trail
  const trailActivate = cfg.lane_c_trail_activate_pts ?? 8;
  const trailDistance = cfg.lane_c_trail_distance_pts ?? 15;

  if (position.bestSpxChange >= trailActivate) {
    const drawdown = position.bestSpxChange - spxProgress;
    if (drawdown >= trailDistance) {
      return { exit: true, reason: 'LC_TRAILING_STOP' };
    }
  }

  // 3. TIME_STOP — close at 3:45 PM ET
  const timeStopHour = cfg.lane_c_time_stop_hour ?? 15;
  const timeStopMinute = cfg.lane_c_time_stop_minute ?? 45;
  if (replayTime.hour > timeStopHour || (replayTime.hour === timeStopHour && replayTime.minute >= timeStopMinute)) {
    return { exit: true, reason: 'LC_TIME_STOP' };
  }

  // 4. REGIME_REVERSAL — GEX flips AND price confirms
  // Suppress regime reversal exits in the first 30 minutes of a confirmed trend day.
  // Early trend days are choppy — regime flips in the first 30 min are noise, not signal.
  const regimeReversalDrawdown = cfg.lane_c_regime_reversal_drawdown_pts ?? 10;
  const earlyExitSuppressMinutes = cfg.lane_c_early_exit_suppress_minutes ?? 30;

  if (position._gexRegimeFlipped && (position.bestSpxChange - spxProgress) >= regimeReversalDrawdown) {
    // Check if we're in the early-chop suppression window
    const minutesSinceEntry = getMinutesSinceEntry(position, replayTime);
    if (minutesSinceEntry < earlyExitSuppressMinutes) {
      log.info(`Lane C suppressed early regime reversal (${minutesSinceEntry.toFixed(0)}m < ${earlyExitSuppressMinutes}m window) — trend day chop, not real reversal`);
      // Reset the regime flip flag so it needs to re-trigger
      position._gexRegimeFlipped = false;
      position._gexPositiveCount = 0;
    } else {
      return { exit: true, reason: 'LC_REGIME_REVERSAL' };
    }
  }

  return { exit: false };
}

/**
 * Track GEX regime flips for Lane C positions.
 * Requires N consecutive positive readings to confirm flip.
 */
export function trackLaneCRegime(position, netGex) {
  if (!position || !position.laneC) return;

  const requiredFlips = 5;

  if (netGex > 0) {
    position._gexPositiveCount = (position._gexPositiveCount || 0) + 1;
    if (position._gexPositiveCount >= requiredFlips && !position._gexRegimeFlipped) {
      position._gexRegimeFlipped = true;
      log.info(`Lane C regime flip confirmed: ${position._gexPositiveCount} consecutive positive readings (${(netGex / 1e6).toFixed(0)}M)`);
    }
  } else {
    position._gexPositiveCount = 0;
    position._gexRegimeFlipped = false;
  }
}

// ---- Lane C Position Management ----

export function openLaneCPosition(state, params) {
  const { direction, spotPrice, trigger, scored, timestamp } = params;
  const cfg = getActiveConfig() || {};

  const stopSpx = trigger.stop_strike || computeStructuralStop(direction, scored, trigger, cfg);
  const stopDist = Math.abs(spotPrice - stopSpx);

  const position = {
    direction,
    entrySpx: spotPrice,
    targetSpx: null,
    stopSpx,
    pattern: trigger.pattern,
    confidence: trigger.confidence,
    entryScore: scored.score,
    entryContext: { pattern: trigger.pattern, laneC: true },
    openedAt: timestamp,
    entryTimestampMs: params.entryTimestampMs || Date.now(),
    bestSpxChange: 0,
    _gexFlipCount: 0,
    _gexRegimeFlipped: false,
    laneC: true,
  };

  laneCState.position = position;
  laneCState.entriesUsed++;
  state.laneCPosition = position;

  log.info(`LANE C ENTRY ${timestamp} | ${direction} @ $${spotPrice.toFixed(2)} via ${trigger.pattern} | stop=${stopSpx.toFixed(2)} (${stopDist.toFixed(0)}pt wide) | score ${laneCState.score}/9 | entry #${laneCState.entriesUsed}`);

  return position;
}

export function closeLaneCPosition(state, exitSpx, exitReason, timestamp) {
  const pos = laneCState.position;
  if (!pos) return null;

  const isBullish = pos.direction === 'BULLISH';
  const spxChange = isBullish ? exitSpx - pos.entrySpx : pos.entrySpx - exitSpx;

  const trade = {
    direction: pos.direction,
    pattern: pos.pattern,
    confidence: pos.confidence,
    entrySpx: pos.entrySpx,
    exitSpx,
    entryScore: pos.entryScore,
    spxChange: Math.round(spxChange * 100) / 100,
    pnlPct: Math.round((spxChange / pos.entrySpx) * 100 * 1000) / 1000,
    exitReason,
    isWin: spxChange > 0,
    openedAt: pos.openedAt,
    closedAt: timestamp,
    laneC: true,
  };

  state.trades.push(trade);

  const pnlStr = `${spxChange > 0 ? '+' : ''}${(Math.round(spxChange * 100) / 100)} pts`;
  const hwm = pos.bestSpxChange.toFixed(1);
  log.info(`LANE C EXIT ${timestamp} | ${pos.direction} ${exitReason} | ${pnlStr} | HWM: ${hwm} pts | ${spxChange > 0 ? 'WIN' : 'LOSS'}`);

  // Track consecutive stops — 2 stops = wrong direction, stop trying
  if (exitReason === 'LC_STOP_HIT') {
    laneCState.stopsHit++;
  } else {
    laneCState.stopsHit = 0;
  }

  laneCState.position = null;
  state.laneCPosition = null;

  return trade;
}

// ---- Accessors ----

export function getLaneCState() {
  return { ...laneCState };
}

export function isLaneCActive() {
  return laneCState.active && laneCState.confirmed;
}

export function isLaneCScored() {
  return laneCState.score > 0 || laneCState.signals?.gex_negative !== undefined;
}

export function hasLaneCPosition() {
  return laneCState.position !== null;
}

export function isLaneCConfirmed() {
  return laneCState.confirmed;
}

export function resetLaneC() {
  const priorNetGex = laneCState.priorDayNetGex;
  const priorCloseNearLow = laneCState.priorDayCloseNearLow;
  const gexHistory = laneCState.gexDeltaHistory;
  laneCState = {
    active: false,
    score: 0,
    signals: {},
    direction: null,
    position: null,
    priorDayNetGex: priorNetGex,
    entriesUsed: 0,
    stopsHit: 0,
    confirmed: false,
    priorDayCloseNearLow: priorCloseNearLow,
    gexDeltaHistory: gexHistory,
    _requireSecondCandle: false,
  };
}

export function setPriorDayNetGex(netGex) {
  laneCState.priorDayNetGex = netGex;
  // Add to rolling history for std dev calculation (keep last 10)
  laneCState.gexDeltaHistory.push(netGex);
  if (laneCState.gexDeltaHistory.length > 10) {
    laneCState.gexDeltaHistory.shift();
  }
}

export function setPriorDayCloseNearLow(nearLow) {
  laneCState.priorDayCloseNearLow = nearLow;
}
