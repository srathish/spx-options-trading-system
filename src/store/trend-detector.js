/**
 * Trend Day Detector
 * Detects persistent directional trend days by tracking support floor / resistance ceiling
 * migration over a 120-cycle (~60 min) window.
 *
 * Signals:
 * - BULLISH trend: Put wall (support floor) rising + directional bias + spot moving up
 * - BEARISH trend: Call wall (resistance ceiling) falling + bearish bias + spot moving down
 *
 * Strength: EMERGING (3/5 conditions) → CONFIRMED (4/5) → STRONG (5/5 + extreme)
 *
 * v2 Changes:
 * - Lower minLookback 60 → 30 (detect trends in 15 min not 30)
 * - Added price-based bias (spot above/below its rolling mean) alongside GEX bias
 * - Deactivation requires BOTH GEX bias drop AND price reversal (not just one)
 * - dayTrendDirection activates at CONFIRMED × 10 (was STRONG × 20)
 * - confirmedCyclesCount decays by 1 on non-meeting cycles instead of resetting to 0
 * - Added spot velocity shortcut: 20+ pts in lookback = auto-EMERGING
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
const CONFIRMED_GRACE_CYCLES = 40; // ~20 min at 30s polling (was 30 = 15 min)
let confirmedSinceCycle = 0;  // cycle count when CONFIRMED was first reached
let cycleCounter = 0;         // monotonically increasing cycle count

// Sticky day-level trend memory: persists even when real-time trend oscillates
// v2: Uses per-direction accumulators that allow flipping when evidence builds
const DAY_TREND_MIN_CYCLES = 25; // must accumulate 25 CONFIRMED+ cycles (~12.5 min)
const DAY_TREND_MIN_SPOT_MOVE = 30; // must show 30+ pts spot move (real trend, not range day noise)
const DAY_TREND_MIN_CYCLE_COUNT = 120; // don't set before cycle 120 (~60 min = ~10:30 AM)
let dayTrendDirection = null;     // 'BULLISH' or 'BEARISH' — can flip with evidence
let dayTrendAccum = { BULLISH: 0, BEARISH: 0 }; // per-direction accumulators

// Lighter-weight sticky direction for exit logic — activates faster
const DAY_EXIT_TREND_MIN_CYCLES = 8;  // 8 CONFIRMED+ cycles = ~4 min
let dayExitTrendDirection = null;       // activates at CONFIRMED (not STRONG), can flip
let dayExitAccum = { BULLISH: 0, BEARISH: 0 };

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
  const minLookback = cfg.trend_min_lookback_cycles ?? 30; // v2: was 60

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
        // Hold at CONFIRMED during grace period
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

    // v2: Track CONFIRMED+ per direction with accumulators that allow flipping
    const meetsThreshold = effectiveStrength === 'CONFIRMED' || effectiveStrength === 'STRONG';
    const opposite = detected.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';

    // Compute spot move from full buffer for gating
    const latestSpot = lookback[lookback.length - 1]?.spotPrice ?? 0;
    const bufferSpotMove = fullBuffer.length > 0
      ? Math.abs(latestSpot - fullBuffer[0].spotPrice) : 0;

    // --- Day trend direction (entry filtering) ---
    if (meetsThreshold) {
      dayTrendAccum[detected.direction]++;
      dayTrendAccum[opposite] = Math.max(0, dayTrendAccum[opposite] - 2);
    } else {
      dayTrendAccum.BULLISH = Math.max(0, dayTrendAccum.BULLISH - 1);
      dayTrendAccum.BEARISH = Math.max(0, dayTrendAccum.BEARISH - 1);
    }

    // Set or flip dayTrendDirection when enough evidence + spot move + minimum cycles elapsed
    const hasDayEvidence = dayTrendAccum[detected.direction] >= DAY_TREND_MIN_CYCLES
      && bufferSpotMove >= DAY_TREND_MIN_SPOT_MOVE
      && cycleCounter >= DAY_TREND_MIN_CYCLE_COUNT;

    if (hasDayEvidence && meetsThreshold) {
      if (dayTrendDirection !== detected.direction) {
        const action = dayTrendDirection ? 'FLIPPED' : 'SET';
        dayTrendDirection = detected.direction;
        log.info(`Day trend ${action}: ${dayTrendDirection} (accum=${dayTrendAccum[detected.direction]}, spotMove=${Math.round(bufferSpotMove)}pts)`);
      }
    }

    // --- Day exit trend direction (structural hold — activates faster) ---
    if (meetsThreshold) {
      dayExitAccum[detected.direction]++;
      dayExitAccum[opposite] = Math.max(0, dayExitAccum[opposite] - 2);
    } else {
      dayExitAccum.BULLISH = Math.max(0, dayExitAccum.BULLISH - 1);
      dayExitAccum.BEARISH = Math.max(0, dayExitAccum.BEARISH - 1);
    }

    if (dayExitAccum[detected.direction] >= DAY_EXIT_TREND_MIN_CYCLES && meetsThreshold) {
      if (dayExitTrendDirection !== detected.direction) {
        const action = dayExitTrendDirection ? 'FLIPPED' : 'SET';
        dayExitTrendDirection = detected.direction;
        log.info(`Day exit trend ${action}: ${dayExitTrendDirection} (accum=${dayExitAccum[detected.direction]})`);
      }
    }

    if (!wasAlreadyTrend) {
      log.info(`TREND DAY detected: ${detected.direction} (${effectiveStrength}) | floor=${detected.supportFloor?.strike || '?'} ceiling=${detected.resistanceCeiling?.strike || '?'} | ${JSON.stringify(detected.metrics)}`);
    } else if (effectiveStrength !== prevStrength) {
      log.info(`Trend strength changed: ${prevStrength} → ${effectiveStrength}`);
    }
  } else if (currentTrendState.isTrend) {
    // Conditions failed detection (< 3/5) — check if within grace period
    const inGracePeriod = confirmedSinceCycle > 0 && (cycleCounter - confirmedSinceCycle) < CONFIRMED_GRACE_CYCLES;

    if (inGracePeriod) {
      // Within grace period: hold at CONFIRMED, don't downgrade or deactivate
      if (currentTrendState.strength !== 'CONFIRMED' && currentTrendState.strength !== 'STRONG') {
        currentTrendState.strength = 'CONFIRMED';
      }
      // v2: Decay accumulators slowly during grace period
      dayTrendAccum.BULLISH = Math.max(0, dayTrendAccum.BULLISH - 1);
      dayTrendAccum.BEARISH = Math.max(0, dayTrendAccum.BEARISH - 1);
      dayExitAccum.BULLISH = Math.max(0, dayExitAccum.BULLISH - 1);
      dayExitAccum.BEARISH = Math.max(0, dayExitAccum.BEARISH - 1);
    } else {
      // Outside grace period: check deactivation
      const lookbackForDeactivation = trendBuffer.slice(-minLookback);
      const deactivate = checkTrendDeactivation(lookbackForDeactivation, currentTrendState, cfg);
      if (deactivate) {
        log.warn(`Trend day DEACTIVATED: ${currentTrendState.direction} — conditions no longer met`);
        currentTrendState = {
          isTrend: false, direction: null, strength: 'NONE',
          supportFloor: null, resistanceCeiling: null,
          detectedAt: null, metrics: {},
        };
        confirmedSinceCycle = 0;
        // v2: Don't reset accumulators — let day-level stickiness persist
      } else {
        // Conditions weakened but not enough to deactivate — hold as EMERGING
        currentTrendState.strength = 'EMERGING';
        dayTrendAccum.BULLISH = Math.max(0, dayTrendAccum.BULLISH - 1);
        dayTrendAccum.BEARISH = Math.max(0, dayTrendAccum.BEARISH - 1);
        dayExitAccum.BULLISH = Math.max(0, dayExitAccum.BULLISH - 1);
        dayExitAccum.BEARISH = Math.max(0, dayExitAccum.BEARISH - 1);
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
  dayTrendAccum = { BULLISH: 0, BEARISH: 0 };
  dayExitTrendDirection = null;
  dayExitAccum = { BULLISH: 0, BEARISH: 0 };
  log.info('Trend detector reset');
}

// ---- Internal Helpers ----

/**
 * Detect a directional trend.
 * v2: 5 conditions (added price-based bias). 3/5 = EMERGING, 4/5 = CONFIRMED, 5/5+extreme = STRONG.
 *
 * Conditions:
 * 1. Strong floor/ceiling exists (wall value ≥ 2× threshold)
 * 2. Wall value grew over buffer window
 * 3. GEX directional bias (scored direction favors trend direction)
 * 4. Spot movement (≥ 10 pts in trend direction)
 * 5. Price-based bias (spot above/below its rolling mean ≥ 60% of lookback)
 */
function detectDirectionalTrend(lookback, fullBuffer, direction, cfg) {
  const minFloorRise = cfg.trend_min_floor_rise_pts ?? 15;
  const minBias = cfg.trend_min_directional_bias_pct ?? 0.55; // v2: was 0.60
  const minSpotMove = cfg.trend_min_spot_move_pts ?? 10;

  const oldest = lookback[0];
  const newest = lookback[lookback.length - 1];
  const result = { qualifies: false, direction, strength: 'NONE', strengthScore: 0, supportFloor: null, resistanceCeiling: null, metrics: {} };

  // Compute price-based bias: what % of cycles is spot above/below its rolling mean?
  // This is more stable than GEX direction which oscillates on minor pullbacks.
  const spotPrices = lookback.map(e => e.spotPrice);
  const spotMean = spotPrices.reduce((a, b) => a + b, 0) / spotPrices.length;
  const priceBiasRatio = direction === 'BULLISH'
    ? spotPrices.filter(p => p > spotMean).length / spotPrices.length
    : spotPrices.filter(p => p < spotMean).length / spotPrices.length;
  const priceBiasOk = priceBiasRatio >= 0.55;

  if (direction === 'BULLISH') {
    const minFloorValue = cfg.trend_min_floor_value ?? 5_000_000;

    // 1. Strong floor exists — recent median floor value >= 2× threshold
    const recentValues = lookback.slice(-20).filter(e => e.supportFloorValue > 0).map(e => e.supportFloorValue);
    const recentMedianValue = median(recentValues);
    const floorStrong = recentMedianValue >= minFloorValue * 2;

    // 2. Floor value grew — compare full buffer old vs recent
    const oldValues = fullBuffer.slice(0, 20).filter(e => e.supportFloorValue > 0).map(e => e.supportFloorValue);
    const oldMedianValue = median(oldValues);
    const valueGrew = oldMedianValue === 0 || recentMedianValue >= oldMedianValue * 1.2;

    const growthRate = oldMedianValue > 0 ? recentMedianValue / oldMedianValue : 0;

    // 3. GEX Directional bias — use lookback window (recent momentum)
    const bullishCount = lookback.filter(e => e.direction === 'BULLISH').length;
    const gexBias = bullishCount / lookback.length;
    const gexBiasOk = gexBias >= minBias;

    // 4. Spot movement — use full buffer to capture larger moves
    const fullOldest = fullBuffer[0];
    const spotMove = newest.spotPrice - fullOldest.spotPrice;
    const spotOk = spotMove >= minSpotMove;

    // 5. Price-based bias (computed above)

    // Also check floor strike migration (bonus for STRONG)
    const smoothedFloors = getSmoothedWallStrikes(fullBuffer, 'supportFloorStrike');
    const floorRise = smoothedFloors.length >= 2
      ? smoothedFloors[smoothedFloors.length - 1] - smoothedFloors[0]
      : 0;

    const conditionsMet = [floorStrong, valueGrew, gexBiasOk, spotOk, priceBiasOk].filter(Boolean).length;
    result.metrics = {
      floorStrong, floorValue: Math.round(recentMedianValue / 1e6) + 'M',
      valueGrew, growthRate: growthRate > 0 ? growthRate.toFixed(1) + 'x' : 'N/A',
      gexBias: Math.round(gexBias * 100) + '%', priceBias: Math.round(priceBiasRatio * 100) + '%',
      spotMove: Math.round(spotMove), floorRise: Math.round(floorRise), conditionsMet,
    };

    // Latest support floor / resistance ceiling
    const latestFloor = lookback.filter(e => e.supportFloorStrike).pop();
    const latestCeiling = lookback.filter(e => e.resistanceCeilingStrike).pop();
    result.supportFloor = latestFloor ? { strike: latestFloor.supportFloorStrike, value: latestFloor.supportFloorValue } : null;
    result.resistanceCeiling = latestCeiling ? { strike: latestCeiling.resistanceCeilingStrike, value: latestCeiling.resistanceCeilingValue } : null;

    if (conditionsMet >= 3) {
      result.qualifies = true;
      if (conditionsMet >= 5 && floorRise >= minFloorRise && gexBias >= 0.65 && spotMove >= 20) {
        result.strength = 'STRONG';
        result.strengthScore = 3;
      } else if (conditionsMet >= 4) {
        result.strength = 'CONFIRMED';
        result.strengthScore = 2;
      } else {
        result.strength = 'EMERGING';
        result.strengthScore = 1;
      }
    }
  } else {
    // BEARISH: mirror — strong ceiling, value grew, bearish bias, spot falling, price bias
    const minFloorValue = cfg.trend_min_floor_value ?? 5_000_000;

    // 1. Strong ceiling exists
    const recentValues = lookback.slice(-20).filter(e => e.resistanceCeilingValue > 0).map(e => e.resistanceCeilingValue);
    const recentMedianValue = median(recentValues);
    const ceilingStrong = recentMedianValue >= minFloorValue * 2;

    // 2. Ceiling value grew
    const oldValues = fullBuffer.slice(0, 20).filter(e => e.resistanceCeilingValue > 0).map(e => e.resistanceCeilingValue);
    const oldMedianValue = median(oldValues);
    const valueGrew = oldMedianValue === 0 || recentMedianValue >= oldMedianValue * 1.2;

    const growthRate = oldMedianValue > 0 ? recentMedianValue / oldMedianValue : 0;

    // 3. GEX Directional bias
    const bearishCount = lookback.filter(e => e.direction === 'BEARISH').length;
    const gexBias = bearishCount / lookback.length;
    const gexBiasOk = gexBias >= minBias;

    // 4. Spot movement
    const fullOldest = fullBuffer[0];
    const spotMove = fullOldest.spotPrice - newest.spotPrice;
    const spotOk = spotMove >= minSpotMove;

    // 5. Price-based bias (computed above)

    // Also check ceiling strike migration (bonus for STRONG)
    const smoothedCeilings = getSmoothedWallStrikes(fullBuffer, 'resistanceCeilingStrike');
    const ceilingDrop = smoothedCeilings.length >= 2
      ? smoothedCeilings[0] - smoothedCeilings[smoothedCeilings.length - 1]
      : 0;

    const conditionsMet = [ceilingStrong, valueGrew, gexBiasOk, spotOk, priceBiasOk].filter(Boolean).length;
    result.metrics = {
      ceilingStrong, ceilingValue: Math.round(recentMedianValue / 1e6) + 'M',
      valueGrew, growthRate: growthRate > 0 ? growthRate.toFixed(1) + 'x' : 'N/A',
      gexBias: Math.round(gexBias * 100) + '%', priceBias: Math.round(priceBiasRatio * 100) + '%',
      spotMove: Math.round(spotMove), ceilingDrop: Math.round(ceilingDrop), conditionsMet,
    };

    const latestFloor = lookback.filter(e => e.supportFloorStrike).pop();
    const latestCeiling = lookback.filter(e => e.resistanceCeilingStrike).pop();
    result.supportFloor = latestFloor ? { strike: latestFloor.supportFloorStrike, value: latestFloor.supportFloorValue } : null;
    result.resistanceCeiling = latestCeiling ? { strike: latestCeiling.resistanceCeilingStrike, value: latestCeiling.resistanceCeilingValue } : null;

    if (conditionsMet >= 3) {
      result.qualifies = true;
      if (conditionsMet >= 5 && ceilingDrop >= minFloorRise && gexBias >= 0.65 && spotMove >= 20) {
        result.strength = 'STRONG';
        result.strengthScore = 3;
      } else if (conditionsMet >= 4) {
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
 * v2: Requires BOTH GEX bias failure AND price reversal. Either alone is not enough.
 */
function checkTrendDeactivation(lookback, trendState, cfg) {
  const recent = lookback.slice(-20); // last ~10 min
  const floorDropThreshold = cfg.trend_deactivate_floor_drop_pts ?? 10;
  const biasThreshold = cfg.trend_deactivate_bias_threshold ?? 0.35; // v2: was 0.40

  // v2: Check price reversal — has spot moved significantly against the trend?
  const spotNow = recent[recent.length - 1]?.spotPrice;
  const spotOldest = recent[0]?.spotPrice;
  const priceReversed = trendState.direction === 'BULLISH'
    ? (spotOldest - spotNow > 5) // dropped 5+ pts in recent window
    : (spotNow - spotOldest > 5); // rallied 5+ pts in recent window

  if (trendState.direction === 'BULLISH') {
    const recentBullish = recent.filter(e => e.direction === 'BULLISH').length / recent.length;
    const gexBiasFailed = recentBullish < biasThreshold;

    // Check if floor dropped from peak
    const recentFloors = recent.map(e => e.supportFloorStrike).filter(s => s !== null);
    const peakSmoothed = getSmoothedWallStrikes(trendBuffer.slice(-40), 'supportFloorStrike');
    let floorBroken = false;
    if (recentFloors.length > 0 && peakSmoothed.length > 0) {
      const peakFloor = Math.max(...peakSmoothed);
      const currentFloor = median(recentFloors);
      floorBroken = (peakFloor - currentFloor >= floorDropThreshold);
    }

    // v2: Require BOTH bias failure AND (price reversed OR floor broken) to deactivate
    return gexBiasFailed && (priceReversed || floorBroken);
  } else {
    const recentBearish = recent.filter(e => e.direction === 'BEARISH').length / recent.length;
    const gexBiasFailed = recentBearish < biasThreshold;

    const recentCeilings = recent.map(e => e.resistanceCeilingStrike).filter(s => s !== null);
    const lowestSmoothed = getSmoothedWallStrikes(trendBuffer.slice(-40), 'resistanceCeilingStrike');
    let ceilingBroken = false;
    if (recentCeilings.length > 0 && lowestSmoothed.length > 0) {
      const lowestCeiling = Math.min(...lowestSmoothed);
      const currentCeiling = median(recentCeilings);
      ceilingBroken = (currentCeiling - lowestCeiling >= floorDropThreshold);
    }

    // v2: Require BOTH bias failure AND (price reversed OR ceiling broken)
    return gexBiasFailed && (priceReversed || ceilingBroken);
  }
}

/**
 * Smooth wall strikes using 10-cycle window with median.
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
