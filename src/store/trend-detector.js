/**
 * Trend Day Detector
 * Detects persistent directional trend days by tracking support floor / resistance ceiling
 * migration over a 120-cycle (~60 min) window.
 *
 * Signals:
 * - BULLISH trend: Put wall (support floor) rising + directional bias + spot moving up
 * - BEARISH trend: Call wall (resistance ceiling) falling + bearish bias + spot moving down
 *
 * Strength: EMERGING (3/4 conditions) → CONFIRMED (4/4) → STRONG (extreme conditions)
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TrendDetect');

// ---- State ----

const TREND_BUFFER_SIZE = 120; // ~60 min at 30s polling
const trendBuffer = [];

let currentTrendState = {
  isTrend: false,
  direction: null,       // 'BULLISH' or 'BEARISH'
  strength: 'NONE',      // 'NONE', 'EMERGING', 'CONFIRMED', 'STRONG'
  supportFloor: null,    // { strike, value }
  resistanceCeiling: null,
  detectedAt: null,
  metrics: {},
};

// Hysteresis: once CONFIRMED, hold for at least this many cycles before allowing downgrade
const CONFIRMED_GRACE_CYCLES = 30; // ~15 min at 30s polling
let confirmedSinceCycle = 0;  // cycle count when CONFIRMED was first reached
let cycleCounter = 0;         // monotonically increasing cycle count

// Sticky day-level trend memory: persists even when real-time trend oscillates
// Requires sustained CONFIRMED+ before setting (prevents false triggers on range days)
const DAY_TREND_MIN_CONFIRMED_CYCLES = 20; // must hold CONFIRMED+ for ~10 min
let dayTrendDirection = null;     // 'BULLISH' or 'BEARISH' — sticky for the day (entry filtering)
let dayTrendConfirmedAt = 0;      // cycle when first confirmed
let confirmedCyclesCount = 0;     // consecutive cycles at CONFIRMED+

// Lighter-weight sticky direction for exit logic — activates faster
// Used in isTrendAligned to suppress momentum timeouts even when real-time trend oscillates
const DAY_EXIT_TREND_MIN_CYCLES = 10;  // 10 CONFIRMED+ cycles = ~5 min
let dayExitTrendDirection = null;       // activates at CONFIRMED (not STRONG)
let exitTrendCyclesCount = 0;           // consecutive CONFIRMED+ cycles for exit trend

// ---- Public API ----

/**
 * Record one cycle of data into the trend buffer.
 * Call every cycle from main-loop.js and replay.js.
 *
 * @param {object} scored - Scored GEX state (spotPrice, wallsAbove, wallsBelow, score, direction)
 * @param {object} [cfgOverride] - Optional config override
 */
export function updateTrendBuffer(scored, cfgOverride) {
  cycleCounter++;
  const cfg = cfgOverride || getActiveConfig() || {};
  const minFloorValue = cfg.trend_min_floor_value ?? 5_000_000;

  // Find support floor: highest positive wall below spot with value >= threshold
  const positiveBelow = (scored.wallsBelow || [])
    .filter(w => w.type === 'positive' && (w.absGexValue || Math.abs(w.gexValue || 0)) >= minFloorValue)
    .sort((a, b) => b.strike - a.strike); // highest strike first

  const supportFloor = positiveBelow[0] || null;

  // Find resistance ceiling: lowest positive wall above spot with value >= threshold
  const positiveAbove = (scored.wallsAbove || [])
    .filter(w => w.type === 'positive' && (w.absGexValue || Math.abs(w.gexValue || 0)) >= minFloorValue)
    .sort((a, b) => a.strike - b.strike); // lowest (nearest) first

  const resistanceCeiling = positiveAbove[0] || null;

  trendBuffer.push({
    timestamp: Date.now(),
    spotPrice: scored.spotPrice,
    supportFloorStrike: supportFloor?.strike ?? null,
    supportFloorValue: supportFloor ? (supportFloor.absGexValue || Math.abs(supportFloor.gexValue || 0)) : 0,
    resistanceCeilingStrike: resistanceCeiling?.strike ?? null,
    resistanceCeilingValue: resistanceCeiling ? (resistanceCeiling.absGexValue || Math.abs(resistanceCeiling.gexValue || 0)) : 0,
    score: scored.score,
    direction: scored.direction,
  });

  while (trendBuffer.length > TREND_BUFFER_SIZE) {
    trendBuffer.shift();
  }
}

/**
 * Run trend detection on the current buffer.
 * Call every cycle after updateTrendBuffer.
 * @returns {object} Current trend state
 */
export function detectTrendDay() {
  const cfg = getActiveConfig() || {};
  const minLookback = cfg.trend_min_lookback_cycles ?? 60;

  if (trendBuffer.length < minLookback) {
    return currentTrendState;
  }

  const lookback = trendBuffer.slice(-minLookback);
  // Pass full buffer for structural checks (floor migration), lookback for momentum checks (bias, spot)
  const fullBuffer = [...trendBuffer];
  const bullish = detectDirectionalTrend(lookback, fullBuffer, 'BULLISH', cfg);
  const bearish = detectDirectionalTrend(lookback, fullBuffer, 'BEARISH', cfg);

  let detected = null;
  if (bullish.qualifies && bearish.qualifies) {
    detected = bullish.strengthScore >= bearish.strengthScore ? bullish : bearish;
  } else if (bullish.qualifies) {
    detected = bullish;
  } else if (bearish.qualifies) {
    detected = bearish;
  }

  if (detected) {
    const wasAlreadyTrend = currentTrendState.isTrend;
    const prevStrength = currentTrendState.strength;
    let effectiveStrength = detected.strength;

    // Track when CONFIRMED was first reached
    if (!wasAlreadyTrend || currentTrendState.direction !== detected.direction) {
      // New trend or direction change — reset grace period
      if (effectiveStrength === 'CONFIRMED' || effectiveStrength === 'STRONG') {
        confirmedSinceCycle = cycleCounter;
      }
    } else {
      // Same direction — apply hysteresis
      if ((prevStrength === 'CONFIRMED' || prevStrength === 'STRONG') && detected.strength === 'EMERGING') {
        // Within grace period → hold at CONFIRMED
        effectiveStrength = 'CONFIRMED';
      }
      if (detected.strength === 'CONFIRMED' || detected.strength === 'STRONG') {
        if (confirmedSinceCycle === 0) confirmedSinceCycle = cycleCounter;
      }
    }

    currentTrendState = {
      isTrend: true,
      direction: detected.direction,
      strength: effectiveStrength,
      supportFloor: detected.supportFloor,
      resistanceCeiling: detected.resistanceCeiling,
      detectedAt: wasAlreadyTrend ? currentTrendState.detectedAt : Date.now(),
      metrics: detected.metrics,
    };

    // Track sustained CONFIRMED+ for sticky day trend (entry filtering — conservative)
    // Use STRONG threshold for first activation (harder to falsely trigger on range days)
    const meetsEntryThreshold = !dayTrendDirection
      ? effectiveStrength === 'STRONG'
      : (effectiveStrength === 'CONFIRMED' || effectiveStrength === 'STRONG');

    if (meetsEntryThreshold) {
      if (!dayTrendDirection || dayTrendDirection === detected.direction) {
        confirmedCyclesCount++;
        if (!dayTrendDirection && confirmedCyclesCount >= DAY_TREND_MIN_CONFIRMED_CYCLES) {
          dayTrendDirection = detected.direction;
          dayTrendConfirmedAt = cycleCounter;
          log.info(`Day trend direction set: ${dayTrendDirection} (${confirmedCyclesCount} STRONG cycles — sticky for entry filtering)`);
        }
      } else {
        confirmedCyclesCount = 1;
      }
    } else {
      confirmedCyclesCount = 0;
    }

    // Track CONFIRMED+ for exit trend direction (less conservative — activates faster)
    const meetsExitThreshold = effectiveStrength === 'CONFIRMED' || effectiveStrength === 'STRONG';
    if (meetsExitThreshold) {
      if (!dayExitTrendDirection || dayExitTrendDirection === detected.direction) {
        exitTrendCyclesCount++;
        if (!dayExitTrendDirection && exitTrendCyclesCount >= DAY_EXIT_TREND_MIN_CYCLES) {
          dayExitTrendDirection = detected.direction;
          log.info(`Day exit trend set: ${dayExitTrendDirection} (${exitTrendCyclesCount} CONFIRMED+ cycles — sticky for structural hold)`);
        }
      } else {
        exitTrendCyclesCount = 1;
      }
    } else {
      exitTrendCyclesCount = 0;
    }

    if (!wasAlreadyTrend) {
      log.info(`TREND DAY detected: ${detected.direction} (${effectiveStrength}) | floor=${detected.supportFloor?.strike || '?'} ceiling=${detected.resistanceCeiling?.strike || '?'} | ${JSON.stringify(detected.metrics)}`);
    } else if (effectiveStrength !== prevStrength) {
      log.info(`Trend strength changed: ${prevStrength} → ${effectiveStrength}`);
    }
  } else if (currentTrendState.isTrend) {
    // Conditions failed detection (< 3/4) — check if within grace period
    const inGracePeriod = confirmedSinceCycle > 0 && (cycleCounter - confirmedSinceCycle) < CONFIRMED_GRACE_CYCLES;

    if (inGracePeriod) {
      // Within grace period: hold at CONFIRMED, don't downgrade or deactivate
      if (currentTrendState.strength !== 'CONFIRMED' && currentTrendState.strength !== 'STRONG') {
        currentTrendState.strength = 'CONFIRMED';
      }
    } else {
      // Outside grace period: check deactivation
      const deactivate = checkTrendDeactivation(lookback, currentTrendState, cfg);
      if (deactivate) {
        log.warn(`Trend day DEACTIVATED: ${currentTrendState.direction} — conditions no longer met`);
        currentTrendState = {
          isTrend: false, direction: null, strength: 'NONE',
          supportFloor: null, resistanceCeiling: null,
          detectedAt: null, metrics: {},
        };
        confirmedSinceCycle = 0;
      } else {
        // Conditions weakened but not enough to deactivate — hold as EMERGING
        currentTrendState.strength = 'EMERGING';
      }
    }
  }

  return currentTrendState;
}

/**
 * Get current trend state (read-only copy).
 */
export function getTrendState() {
  return { ...currentTrendState, dayTrendDirection, dayExitTrendDirection };
}

/**
 * Reset all trend state. Call at daily reset (9:25 AM).
 */
export function resetTrendDetector() {
  trendBuffer.length = 0;
  currentTrendState = {
    isTrend: false, direction: null, strength: 'NONE',
    supportFloor: null, resistanceCeiling: null,
    detectedAt: null, metrics: {},
  };
  confirmedSinceCycle = 0;
  cycleCounter = 0;
  dayTrendDirection = null;
  dayTrendConfirmedAt = 0;
  confirmedCyclesCount = 0;
  dayExitTrendDirection = null;
  exitTrendCyclesCount = 0;
  log.info('Trend detector reset');
}

// ---- Internal Helpers ----

/**
 * Detect a directional trend.
 * @param {Array} lookback - Recent window for bias/spot checks (60 cycles = 30 min)
 * @param {Array} fullBuffer - Full buffer for structural checks (120 cycles = 60 min)
 */
function detectDirectionalTrend(lookback, fullBuffer, direction, cfg) {
  const minFloorRise = cfg.trend_min_floor_rise_pts ?? 15;
  const minBias = cfg.trend_min_directional_bias_pct ?? 0.60;
  const minSpotMove = cfg.trend_min_spot_move_pts ?? 10;

  const oldest = lookback[0];
  const newest = lookback[lookback.length - 1];
  const result = { qualifies: false, direction, strength: 'NONE', strengthScore: 0, supportFloor: null, resistanceCeiling: null, metrics: {} };

  if (direction === 'BULLISH') {
    const minFloorValue = cfg.trend_min_floor_value ?? 5_000_000;

    // 1. Strong floor exists — recent median floor value >= 2× threshold
    // (captures that market has built significant support, even if floor strike hasn't migrated)
    const recentValues = lookback.slice(-20).filter(e => e.supportFloorValue > 0).map(e => e.supportFloorValue);
    const recentMedianValue = median(recentValues);
    const floorStrong = recentMedianValue >= minFloorValue * 2;

    // 2. Floor value grew — compare full buffer old vs recent
    // (captures $3M → $9M growth = market building support over time)
    const oldValues = fullBuffer.slice(0, 20).filter(e => e.supportFloorValue > 0).map(e => e.supportFloorValue);
    const oldMedianValue = median(oldValues);
    const valueGrew = oldMedianValue === 0 || recentMedianValue >= oldMedianValue * 1.2;

    // Floor growth rate — how much the floor value multiplied (e.g., 2.7x = strong trend)
    const growthRate = oldMedianValue > 0 ? recentMedianValue / oldMedianValue : 0;

    // 3. Directional bias — use lookback window (recent momentum)
    const bullishCount = lookback.filter(e => e.direction === 'BULLISH').length;
    const bias = bullishCount / lookback.length;
    const biasOk = bias >= minBias;

    // 4. Spot movement — use full buffer to capture larger moves
    const fullOldest = fullBuffer[0];
    const spotMove = newest.spotPrice - fullOldest.spotPrice;
    const spotOk = spotMove >= minSpotMove;

    // Also check floor strike migration (bonus for STRONG)
    const smoothedFloors = getSmoothedWallStrikes(fullBuffer, 'supportFloorStrike');
    const floorRise = smoothedFloors.length >= 2
      ? smoothedFloors[smoothedFloors.length - 1] - smoothedFloors[0]
      : 0;

    const conditionsMet = [floorStrong, valueGrew, biasOk, spotOk].filter(Boolean).length;
    result.metrics = {
      floorStrong, floorValue: Math.round(recentMedianValue / 1e6) + 'M',
      valueGrew, growthRate: growthRate > 0 ? growthRate.toFixed(1) + 'x' : 'N/A',
      bias: Math.round(bias * 100) + '%',
      spotMove: Math.round(spotMove), floorRise: Math.round(floorRise), conditionsMet,
    };

    // Latest support floor / resistance ceiling
    const latestFloor = lookback.filter(e => e.supportFloorStrike).pop();
    const latestCeiling = lookback.filter(e => e.resistanceCeilingStrike).pop();
    result.supportFloor = latestFloor ? { strike: latestFloor.supportFloorStrike, value: latestFloor.supportFloorValue } : null;
    result.resistanceCeiling = latestCeiling ? { strike: latestCeiling.resistanceCeilingStrike, value: latestCeiling.resistanceCeilingValue } : null;

    if (conditionsMet >= 3) {
      result.qualifies = true;
      if (conditionsMet === 4 && floorRise >= minFloorRise && bias >= 0.70 && spotMove >= 20) {
        result.strength = 'STRONG';
        result.strengthScore = 3;
      } else if (conditionsMet === 4) {
        result.strength = 'CONFIRMED';
        result.strengthScore = 2;
      } else {
        result.strength = 'EMERGING';
        result.strengthScore = 1;
      }
    }
  } else {
    // BEARISH: mirror — strong ceiling, value grew, bearish bias, spot falling
    const minFloorValue = cfg.trend_min_floor_value ?? 5_000_000;

    // 1. Strong ceiling exists
    const recentValues = lookback.slice(-20).filter(e => e.resistanceCeilingValue > 0).map(e => e.resistanceCeilingValue);
    const recentMedianValue = median(recentValues);
    const ceilingStrong = recentMedianValue >= minFloorValue * 2;

    // 2. Ceiling value grew
    const oldValues = fullBuffer.slice(0, 20).filter(e => e.resistanceCeilingValue > 0).map(e => e.resistanceCeilingValue);
    const oldMedianValue = median(oldValues);
    const valueGrew = oldMedianValue === 0 || recentMedianValue >= oldMedianValue * 1.2;

    // Ceiling growth rate — how much the ceiling value multiplied
    const growthRate = oldMedianValue > 0 ? recentMedianValue / oldMedianValue : 0;

    const bearishCount = lookback.filter(e => e.direction === 'BEARISH').length;
    const bias = bearishCount / lookback.length;
    const biasOk = bias >= minBias;

    const fullOldest = fullBuffer[0];
    const spotMove = fullOldest.spotPrice - newest.spotPrice;
    const spotOk = spotMove >= minSpotMove;

    // Also check ceiling strike migration (bonus for STRONG)
    const smoothedCeilings = getSmoothedWallStrikes(fullBuffer, 'resistanceCeilingStrike');
    const ceilingDrop = smoothedCeilings.length >= 2
      ? smoothedCeilings[0] - smoothedCeilings[smoothedCeilings.length - 1]
      : 0;

    const conditionsMet = [ceilingStrong, valueGrew, biasOk, spotOk].filter(Boolean).length;
    result.metrics = {
      ceilingStrong, ceilingValue: Math.round(recentMedianValue / 1e6) + 'M',
      valueGrew, growthRate: growthRate > 0 ? growthRate.toFixed(1) + 'x' : 'N/A',
      bias: Math.round(bias * 100) + '%',
      spotMove: Math.round(spotMove), ceilingDrop: Math.round(ceilingDrop), conditionsMet,
    };

    const latestFloor = lookback.filter(e => e.supportFloorStrike).pop();
    const latestCeiling = lookback.filter(e => e.resistanceCeilingStrike).pop();
    result.supportFloor = latestFloor ? { strike: latestFloor.supportFloorStrike, value: latestFloor.supportFloorValue } : null;
    result.resistanceCeiling = latestCeiling ? { strike: latestCeiling.resistanceCeilingStrike, value: latestCeiling.resistanceCeilingValue } : null;

    if (conditionsMet >= 3) {
      result.qualifies = true;
      if (conditionsMet === 4 && ceilingDrop >= minFloorRise && bias >= 0.70 && spotMove >= 20) {
        result.strength = 'STRONG';
        result.strengthScore = 3;
      } else if (conditionsMet === 4) {
        result.strength = 'CONFIRMED';
        result.strengthScore = 2;
      } else {
        result.strength = 'EMERGING';
        result.strengthScore = 1;
      }
    }
  }

  return result;
}

/**
 * Check if a currently active trend should be deactivated.
 */
function checkTrendDeactivation(lookback, trendState, cfg) {
  const recent = lookback.slice(-20); // last ~10 min
  const floorDropThreshold = cfg.trend_deactivate_floor_drop_pts ?? 10;
  const biasThreshold = cfg.trend_deactivate_bias_threshold ?? 0.40;

  if (trendState.direction === 'BULLISH') {
    // Check if bias dropped
    const recentBullish = recent.filter(e => e.direction === 'BULLISH').length / recent.length;
    if (recentBullish < biasThreshold) return true;

    // Check if floor dropped from peak using MEDIAN of recent floors
    // (raw values oscillate wildly when spot hovers near a wall level)
    const recentFloors = recent.map(e => e.supportFloorStrike).filter(s => s !== null);
    const peakSmoothed = getSmoothedWallStrikes(trendBuffer.slice(-40), 'supportFloorStrike');
    if (recentFloors.length > 0 && peakSmoothed.length > 0) {
      const peakFloor = Math.max(...peakSmoothed);
      const currentFloor = median(recentFloors);
      if (peakFloor - currentFloor >= floorDropThreshold) return true;
    }
  } else {
    const recentBearish = recent.filter(e => e.direction === 'BEARISH').length / recent.length;
    if (recentBearish < biasThreshold) return true;

    // Check if ceiling rose from lowest using MEDIAN of recent ceilings
    const recentCeilings = recent.map(e => e.resistanceCeilingStrike).filter(s => s !== null);
    const lowestSmoothed = getSmoothedWallStrikes(trendBuffer.slice(-40), 'resistanceCeilingStrike');
    if (recentCeilings.length > 0 && lowestSmoothed.length > 0) {
      const lowestCeiling = Math.min(...lowestSmoothed);
      const currentCeiling = median(recentCeilings);
      if (currentCeiling - lowestCeiling >= floorDropThreshold) return true;
    }
  }

  return false;
}

/**
 * Smooth wall strikes using 10-cycle window with median.
 * Handles oscillation when spot is right at a wall level.
 * Median is more robust than 25th percentile for capturing floor migration
 * when the floor oscillates between old and new levels.
 */
function getSmoothedWallStrikes(lookback, field) {
  const windowSize = 10;
  const smoothed = [];

  for (let i = 0; i < lookback.length; i += windowSize) {
    const window = lookback.slice(i, i + windowSize);
    const strikes = window
      .map(e => e[field])
      .filter(s => s !== null && s !== undefined)
      .sort((a, b) => a - b);

    if (strikes.length >= 3) {
      const mid = Math.floor(strikes.length / 2);
      const medianVal = strikes.length % 2 ? strikes[mid] : (strikes[mid - 1] + strikes[mid]) / 2;
      smoothed.push(medianVal);
    }
  }

  return smoothed;
}

/**
 * Compute median of a numeric array.
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
