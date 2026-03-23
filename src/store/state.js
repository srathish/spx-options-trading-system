/**
 * State management — replaces Chrome storage with SQLite-backed state.
 * Tracks GEX read history, wall trends, and alert deduplication.
 */

import { getRecentSnapshots, getRecentAlerts, saveAlert } from './db.js';
import { ALERT_DEDUP_MINUTES, MOMENTUM } from '../gex/constants.js';

// In-memory GEX history for wall trend detection (keeps last 3 reads per ticker)
const gexHistory = { SPXW: [], SPY: [], QQQ: [] };
const MAX_HISTORY = 10;

// Spot price ring buffer for momentum detection (keeps last N reads per ticker)
const spotBuffer = { SPXW: [], SPY: [], QQQ: [] };

// Longer drift buffer — catches slow grinding moves over 15+ minutes
const driftBuffer = { SPXW: [], SPY: [], QQQ: [] };

// GEX-at-spot smoothing buffer — rolling median prevents oscillation at gamma boundaries
const gexAtSpotBuffer = { SPXW: [], SPY: [], QQQ: [] };
const GEX_AT_SPOT_WINDOW = 3;

// EMA score smoothing — prevents score whipsaw on small spot moves
const smoothedScores = { SPXW: null, SPY: null, QQQ: null };
const smoothedDirection = { SPXW: null, SPY: null, QQQ: null }; // track direction to reset EMA on flip
const SMOOTHING_ALPHA = 0.3; // 0.3 = responsive (30% toward new value each cycle)

// Cached latest spot price (updated each main loop cycle)
let latestSpot = { price: null, updatedAt: 0 };

// Direction history for stability detection
const directionHistory = { SPXW: [], SPY: [], QQQ: [] };
const DIRECTION_HISTORY_SIZE = 10;

// Score history for chop detection
const scoreHistory = { SPXW: [], SPY: [], QQQ: [] };
const SCORE_HISTORY_SIZE = 60; // 60 cycles = ~30 min

// Node strength trending — rolling buffer of top 10 walls per cycle (~100s at 5s polling)
const nodeHistory = { SPXW: [], SPY: [], QQQ: [] };
const NODE_HISTORY_SIZE = 120;

// King node history — tracks king node strike + type per cycle
const kingNodeHistory = { SPXW: [], SPY: [], QQQ: [] };
const KING_HISTORY_SIZE = 60;

// Strike-level gamma memory — tracks every significant strike's gamma value over time
// Key: ticker → Map<strike, Array<{value, rawValue, timestamp}>>
// This lets us see "the 6500 strike went from -18M → -27M → -45M → -95M" over the full day
const strikeMemory = { SPXW: new Map(), SPY: new Map(), QQQ: new Map() };
const STRIKE_MEMORY_MAX_READINGS = 400; // Full trading day at 1-min polling
const STRIKE_MEMORY_MIN_VALUE = 2_000_000; // Only track strikes with >$2M gamma

// GEX regime persistence — tracks consecutive same-direction cycles
const regimeState = {
  SPXW: { direction: null, startedAt: 0, cycles: 0 },
  SPY: { direction: null, startedAt: 0, cycles: 0 },
  QQQ: { direction: null, startedAt: 0, cycles: 0 },
};

// Stack persistence tracking — rolling snapshots of stacked_walls per cycle
const stackSnapshots = { SPXW: [], SPY: [], QQQ: [] };
const STACK_SNAPSHOT_SIZE = 30;  // ~2.5 min at 5s polling

// Net GEX rate of change — tracks total net GEX per cycle for regime transition detection
const netGexBuffer = { SPXW: [], SPY: [], QQQ: [] };
const NET_GEX_BUFFER_SIZE = 30; // ~2.5 min at 5s polling

// HOD/LOD tracking — for negative gamma at extremes pattern
let dailyHOD = { price: 0, timestamp: 0 };
let dailyLOD = { price: Infinity, timestamp: 0 };

// Round-trip day detection — price returning to open range after big move = chop signal
let dailyOpenRange = { open: 0, rangeHigh: 0, rangeLow: 0, maxExcursion: 0, roundTripDetected: false };
const OPEN_RANGE_READINGS = 20; // ~100s at 5s polling (first ~2 min of data)
let openRangeReadings = 0;

// Replay time override — when set, scoring/patterns use this instead of nowET()
let replayTimeOverride = null;

/**
 * Save a GEX read for trend detection (keeps last 3 in memory per ticker).
 * Also tracks spot price in ring buffer for momentum detection.
 */
export function saveGexRead(parsedData, ticker = 'SPXW') {
  if (!gexHistory[ticker]) gexHistory[ticker] = [];
  if (!spotBuffer[ticker]) spotBuffer[ticker] = [];

  gexHistory[ticker].push({
    timestamp: Date.now(),
    spotPrice: parsedData.spotPrice,
    walls: (parsedData.walls || []).slice(0, 10),
  });

  while (gexHistory[ticker].length > MAX_HISTORY) {
    gexHistory[ticker].shift();
  }

  // Track spot price for momentum (short window ~5 min)
  spotBuffer[ticker].push({
    timestamp: Date.now(),
    spot: parsedData.spotPrice,
  });
  while (spotBuffer[ticker].length > MOMENTUM.LOOKBACK) {
    spotBuffer[ticker].shift();
  }

  // Track spot price for drift detection (long window ~15 min)
  if (!driftBuffer[ticker]) driftBuffer[ticker] = [];
  driftBuffer[ticker].push({
    timestamp: Date.now(),
    spot: parsedData.spotPrice,
  });
  while (driftBuffer[ticker].length > MOMENTUM.DRIFT_LOOKBACK) {
    driftBuffer[ticker].shift();
  }
}

/**
 * Save a node snapshot for trend detection (keeps last 20 cycles per ticker).
 * Stores top 10 walls by absolute value with their strike and value.
 * Called each cycle after identifyWalls().
 */
export function saveNodeSnapshot(walls, ticker = 'SPXW') {
  if (!nodeHistory[ticker]) nodeHistory[ticker] = [];
  if (!walls || walls.length === 0) return;

  const top10 = [...walls]
    .sort((a, b) => (b.absGexValue || Math.abs(b.gexValue || 0)) - (a.absGexValue || Math.abs(a.gexValue || 0)))
    .slice(0, 10)
    .map(w => ({
      strike: w.strike,
      value: w.absGexValue || Math.abs(w.gexValue || 0),
      rawValue: w.gexValue || 0,
    }));

  nodeHistory[ticker].push({ timestamp: Date.now(), walls: top10 });
  while (nodeHistory[ticker].length > NODE_HISTORY_SIZE) {
    nodeHistory[ticker].shift();
  }
}

/**
 * Save per-strike gamma values into strike memory.
 * Called with the full wall list each cycle — remembers every significant strike's gamma over time.
 * This is the "trader watching each strike change" memory.
 */
export function saveStrikeMemory(walls, spot, ticker = 'SPXW') {
  if (!walls || walls.length === 0) return;
  const mem = strikeMemory[ticker];
  if (!mem) return;

  const now = Date.now();

  // Record gamma for every wall with significant value within 150pts of spot
  for (const w of walls) {
    if (!w.strike || Math.abs(w.strike - spot) > 150) continue;
    const absVal = w.absGexValue || Math.abs(w.gexValue || 0);
    if (absVal < STRIKE_MEMORY_MIN_VALUE) continue;

    if (!mem.has(w.strike)) {
      mem.set(w.strike, []);
    }
    const history = mem.get(w.strike);
    history.push({ value: absVal, rawValue: w.gexValue || 0, timestamp: now });

    // Trim to max size
    while (history.length > STRIKE_MEMORY_MAX_READINGS) {
      history.shift();
    }
  }
}

/**
 * Get GEX conviction for a direction by analyzing strike memory.
 * Looks at: how many strikes below/above spot are growing, how consistently, how fast.
 *
 * Returns {
 *   conviction: 0-100 (0 = no signal, 100 = massive sustained growth in one direction),
 *   direction: 'BEARISH' | 'BULLISH' | null,
 *   dominantStrike: number (the strike with strongest sustained growth),
 *   dominantValue: number (current gamma at that strike),
 *   growthRate: number (% growth of dominant strike over its history),
 *   growingStrikes: number (count of strikes growing in this direction),
 *   sustainedCycles: number (how many consecutive cycles the dominant strike has been growing),
 * }
 */
export function getGexConviction(spot, ticker = 'SPXW') {
  const mem = strikeMemory[ticker];
  if (!mem || mem.size === 0) return { conviction: 0, direction: null };

  const candidates = []; // { strike, direction, growthPct, sustainedCycles, currentValue, rawValue }

  for (const [strike, history] of mem.entries()) {
    if (history.length < 5) continue; // need at least 5 readings

    const current = history[history.length - 1];
    const isBelow = strike < spot;
    const isNegative = current.rawValue < 0;

    // For bearish conviction: negative walls BELOW spot growing = magnet pulling price down
    // For bullish conviction: negative walls ABOVE spot growing = magnet pulling price up
    // (positive walls are resistance, not magnets)
    const isBearishMagnet = isBelow && isNegative;
    const isBullishMagnet = !isBelow && isNegative;
    if (!isBearishMagnet && !isBullishMagnet) continue;

    // Compute sustained growth: how many of the last N readings show value increasing?
    const lookback = Math.min(history.length, 60); // up to 60 cycles (~60 min at 1 min polling)
    const recent = history.slice(-lookback);

    let growingCycles = 0;
    let consecutiveGrowing = 0;
    let maxConsecutive = 0;

    for (let i = 1; i < recent.length; i++) {
      if (recent[i].value > recent[i - 1].value * 1.001) { // grew at least 0.1%
        growingCycles++;
        consecutiveGrowing++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveGrowing);
      } else {
        consecutiveGrowing = 0;
      }
    }

    // Growth from earliest reading to now
    const earliest = recent[0];
    const growthPct = earliest.value > 0 ? (current.value - earliest.value) / earliest.value : 0;

    // Growth from 10 cycles ago (shorter term acceleration)
    const ago10 = history.length >= 11 ? history[history.length - 11] : null;
    const recentGrowthPct = ago10 && ago10.value > 0
      ? (current.value - ago10.value) / ago10.value
      : 0;

    const consistency = lookback > 1 ? growingCycles / (lookback - 1) : 0;

    candidates.push({
      strike,
      direction: isBearishMagnet ? 'BEARISH' : 'BULLISH',
      growthPct,
      recentGrowthPct,
      consistency,
      sustainedCycles: maxConsecutive,
      currentValue: current.value,
      rawValue: current.rawValue,
      distFromSpot: Math.abs(strike - spot),
    });
  }

  if (candidates.length === 0) return { conviction: 0, direction: null };

  // Score each candidate: combination of growth %, consistency, and absolute value
  for (const c of candidates) {
    c.score =
      Math.min(c.growthPct, 5) * 20 +         // growth capped at 5x = 100 pts
      c.consistency * 30 +                      // 30% consistency = 30 pts max
      Math.min(c.sustainedCycles / 20, 1) * 20 + // sustained growth up to 20 pts
      Math.min(c.currentValue / 100e6, 1) * 30;  // value up to $100M = 30 pts max
  }

  // Pick strongest candidate
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Count how many strikes are growing in the same direction
  const growingInDirection = candidates.filter(
    c => c.direction === best.direction && c.growthPct > 0.1 && c.consistency > 0.3
  ).length;

  // Final conviction: 0-100
  const conviction = Math.min(100, Math.round(best.score + growingInDirection * 5));

  return {
    conviction,
    direction: best.direction,
    dominantStrike: best.strike,
    dominantValue: best.currentValue,
    dominantRawValue: best.rawValue,
    growthRate: best.growthPct,
    recentGrowthRate: best.recentGrowthPct,
    consistency: best.consistency,
    growingStrikes: growingInDirection,
    sustainedCycles: best.sustainedCycles,
    distFromSpot: best.distFromSpot,
  };
}

/**
 * Check if a specific thesis strike node is still alive (growing or massive stable).
 * Used by thesis hold: "is the 6500 node I entered on still building?"
 * Returns { alive: boolean, currentValue, growthFromEntry, trend }
 */
export function isThesisNodeAlive(strike, entryValue, ticker = 'SPXW') {
  const mem = strikeMemory[ticker];
  if (!mem || !mem.has(strike)) return { alive: false, currentValue: 0 };

  const history = mem.get(strike);
  if (history.length === 0) return { alive: false, currentValue: 0 };

  const current = history[history.length - 1];
  const growthFromEntry = entryValue > 0 ? (current.value - entryValue) / entryValue : 0;

  // Node is alive if:
  // 1. It hasn't shrunk more than 30% from entry value (some decay is ok)
  // 2. OR it's still massive (>$20M absolute)
  const notShrunk = current.value >= entryValue * 0.70;
  const stillMassive = current.value >= 20_000_000;
  const alive = notShrunk || stillMassive;

  // Trend: compare to 5 readings ago
  let trend = 'UNKNOWN';
  if (history.length >= 6) {
    const prev = history[history.length - 6];
    const pctChange = prev.value > 0 ? (current.value - prev.value) / prev.value : 0;
    if (pctChange >= 0.05) trend = 'GROWING';
    else if (pctChange <= -0.15) trend = 'WEAKENING';
    else trend = 'STABLE';
  }

  return { alive, currentValue: current.value, growthFromEntry, trend };
}

/**
 * Get node trends for a ticker by comparing current walls to 5, 10, 30, and 60 cycles ago.
 * Returns Map<strike, { trend, longTrend, currentValue, prevValue5, prevValue10, prevValue30, prevValue60, changePct10, changePct30, changePct60 }>
 * Trends: GROWING (≥20% increase), WEAKENING (≥20% decrease), STABLE, NEW, GONE
 * longTrend: based on 30/60 cycle comparison — more stable, less noise
 */
export function getNodeTrends(ticker = 'SPXW') {
  const history = nodeHistory[ticker] || [];
  const trends = new Map();

  if (history.length < 2) return trends;

  const current = history[history.length - 1];
  const ago5 = history.length >= 6 ? history[history.length - 6] : null;
  const ago10 = history.length >= 11 ? history[history.length - 11] : null;
  const ago30 = history.length >= 31 ? history[history.length - 31] : null;  // ~15 min at 30s polling
  const ago60 = history.length >= 61 ? history[history.length - 61] : null;  // ~30 min at 30s polling

  // Build lookup maps for past snapshots
  const map5 = new Map();
  const map10 = new Map();
  const map30 = new Map();
  const map60 = new Map();
  if (ago5) ago5.walls.forEach(w => map5.set(w.strike, w.value));
  if (ago10) ago10.walls.forEach(w => map10.set(w.strike, w.value));
  if (ago30) ago30.walls.forEach(w => map30.set(w.strike, w.value));
  if (ago60) ago60.walls.forEach(w => map60.set(w.strike, w.value));

  // Classify each current wall
  for (const wall of current.walls) {
    const prev5 = map5.get(wall.strike);
    const prev10 = map10.get(wall.strike);
    const prev30 = map30.get(wall.strike);
    const prev60 = map60.get(wall.strike);

    let trend;
    let changePct10 = 0;
    let changePct30 = 0;
    let changePct60 = 0;

    if (ago10 && prev10 === undefined) {
      // Didn't exist 10 cycles ago
      trend = 'NEW';
    } else if (ago10 && prev10 !== undefined) {
      changePct10 = prev10 > 0 ? ((wall.value - prev10) / prev10) : 0;

      if (changePct10 >= 0.20) trend = 'GROWING';
      else if (changePct10 <= -0.20) trend = 'WEAKENING';
      else trend = 'STABLE';
    } else if (ago5 && prev5 !== undefined) {
      // Not enough history for 10-cycle, use 5-cycle with tighter thresholds
      const changePct5 = prev5 > 0 ? ((wall.value - prev5) / prev5) : 0;
      changePct10 = changePct5; // store what we have

      if (changePct5 >= 0.10) trend = 'GROWING';
      else if (changePct5 <= -0.10) trend = 'WEAKENING';
      else trend = 'STABLE';
    } else {
      trend = 'NEW'; // Not enough history
    }

    // Compute long-term change percentages
    if (prev30 && prev30 > 0) changePct30 = (wall.value - prev30) / prev30;
    if (prev60 && prev60 > 0) changePct60 = (wall.value - prev60) / prev60;

    // longTrend: based on best available long lookback (prefer 60, fallback 30)
    let longTrend = null;
    const longPct = prev60 !== undefined ? changePct60 : (prev30 !== undefined ? changePct30 : null);
    if (longPct !== null) {
      if (longPct >= 0.20) longTrend = 'GROWING';
      else if (longPct <= -0.20) longTrend = 'WEAKENING';
      else longTrend = 'STABLE';
    }

    // Absolute change over 30 cycles (~15 min) — $5M+ absolute growth is significant
    // regardless of percentage (a $2M wall growing to $7M = +$5M absolute)
    const absChange30 = prev30 !== undefined ? wall.value - prev30 : 0;

    trends.set(wall.strike, {
      trend,
      longTrend,
      currentValue: wall.value,
      prevValue5: prev5 ?? null,
      prevValue10: prev10 ?? null,
      prevValue30: prev30 ?? null,
      prevValue60: prev60 ?? null,
      changePct10: parseFloat(changePct10.toFixed(3)),
      changePct30: parseFloat(changePct30.toFixed(3)),
      changePct60: parseFloat(changePct60.toFixed(3)),
      absChange30,
    });
  }

  // Find GONE walls — existed 10 cycles ago but not in current snapshot
  if (ago10) {
    const currentStrikes = new Set(current.walls.map(w => w.strike));
    for (const wall of ago10.walls) {
      if (!currentStrikes.has(wall.strike)) {
        trends.set(wall.strike, {
          trend: 'GONE',
          longTrend: 'GONE',
          currentValue: 0,
          prevValue5: map5.get(wall.strike) ?? null,
          prevValue10: wall.value,
          prevValue30: map30.get(wall.strike) ?? null,
          prevValue60: map60.get(wall.strike) ?? null,
          changePct10: -1,
          changePct30: -1,
          changePct60: -1,
        });
      }
    }
  }

  return trends;
}

/**
 * Get GEX read history for a specific ticker.
 */
export function getGexHistory(ticker = 'SPXW') {
  return gexHistory[ticker] || [];
}

/**
 * Compare current walls to previous reads for trend detection.
 * Returns alert objects for significant changes.
 */
export function detectWallTrends(currentWalls, history) {
  if (history.length < 2) return [];

  const previousWalls = history[history.length - 2].walls || [];
  const alerts = [];

  for (const current of currentWalls) {
    const previous = previousWalls.find(w => w.strike === current.strike);
    if (!previous) {
      alerts.push({ type: 'NEW_WALL', wall: current });
      continue;
    }

    const prevAbs = previous.absGexValue || Math.abs(previous.gexValue || 0);
    const currAbs = current.absGexValue || Math.abs(current.gexValue || 0);

    if (prevAbs === 0) continue;

    const growthPct = (currAbs - prevAbs) / prevAbs;
    if (growthPct >= 0.20) {
      alerts.push({ type: 'WALL_GROWTH', wall: current, growthPct, prevValue: prevAbs });
    }
    if (growthPct <= -0.30) {
      alerts.push({ type: 'WALL_SHRINK', wall: current, growthPct, prevValue: prevAbs });
    }
  }

  return alerts;
}

/**
 * Get spot price momentum for a ticker.
 * Returns { direction, points, strength, oldest, newest }
 * - direction: 'UP', 'DOWN', or 'FLAT'
 * - points: absolute price change in $ over lookback window
 * - strength: 'STRONG', 'MODERATE', or 'WEAK'
 */
export function getSpotMomentum(ticker = 'SPXW') {
  const buffer = spotBuffer[ticker] || [];
  if (buffer.length < 3) {
    return { direction: 'FLAT', points: 0, strength: 'WEAK', readings: buffer.length, drift: null };
  }

  const oldest = buffer[0];
  const newest = buffer[buffer.length - 1];
  const change = newest.spot - oldest.spot;
  const absChange = Math.abs(change);

  let direction = 'FLAT';
  if (change > 2) direction = 'UP';
  else if (change < -2) direction = 'DOWN';

  let strength = 'WEAK';
  if (absChange >= MOMENTUM.STRONG_MOVE_PTS) strength = 'STRONG';
  else if (absChange >= MOMENTUM.MODERATE_MOVE_PTS) strength = 'MODERATE';

  // Drift detection — catches slow grinds over 15+ minutes
  const drift = detectDrift(ticker);

  // If short-window momentum is WEAK but drift is MODERATE+, upgrade
  if (strength === 'WEAK' && drift && drift.strength !== 'WEAK') {
    strength = drift.strength;
    direction = drift.direction;
  }

  return {
    direction,
    points: parseFloat(change.toFixed(2)),
    absPoints: parseFloat(absChange.toFixed(2)),
    strength,
    readings: buffer.length,
    oldestSpot: oldest.spot,
    newestSpot: newest.spot,
    drift,
  };
}

/**
 * Analyze price behavior near a GEX node — dwell time, oscillation, rejection/acceptance.
 * Uses spotBuffer to classify whether price rejected or accepted a king node.
 * - Rejection: 3+ cycles within ±5pts, oscillation < 8pts, momentum reversed
 * - Acceptance: broke through by >5pts, momentum continues original direction
 * - Inconclusive: not enough data or mixed signals → no change to existing behavior
 */
export function getNodeDwellAnalysis(strike, ticker = 'SPXW') {
  const buffer = spotBuffer[ticker] || [];
  const zonePts = 5;
  const minDwellCycles = 3;
  const maxOscillation = 8;

  if (buffer.length < 5) {
    return { dwellCycles: 0, rejected: false, accepted: false, inconclusive: true };
  }

  // Find readings within ±zonePts of strike
  const inZone = [];
  for (const reading of buffer) {
    if (Math.abs(reading.spot - strike) <= zonePts) inZone.push(reading);
  }
  const dwellCycles = inZone.length;
  const dwellMs = inZone.length >= 2 ? inZone[inZone.length - 1].timestamp - inZone[0].timestamp : 0;

  // Oscillation range within zone
  let oscillationPts = 0;
  if (inZone.length >= 2) {
    const spots = inZone.map(r => r.spot);
    oscillationPts = Math.max(...spots) - Math.min(...spots);
  }

  // Arrival direction: what was momentum doing before reaching the node?
  const firstZoneIdx = inZone.length > 0 ? buffer.indexOf(inZone[0]) : -1;
  let arrivalDirection = null;
  if (firstZoneIdx >= 3) {
    const pre = buffer.slice(Math.max(0, firstZoneIdx - 5), firstZoneIdx);
    if (pre.length >= 2) {
      const preChange = pre[pre.length - 1].spot - pre[0].spot;
      arrivalDirection = preChange > 1 ? 'UP' : (preChange < -1 ? 'DOWN' : 'FLAT');
    }
  }

  // Current momentum (last 3 readings)
  const recent = buffer.slice(-3);
  const recentChange = recent.length >= 2 ? recent[recent.length - 1].spot - recent[0].spot : 0;
  const currentDirection = recentChange > 1 ? 'UP' : (recentChange < -1 ? 'DOWN' : 'FLAT');

  const latestSpot = buffer[buffer.length - 1].spot;
  const broke = Math.abs(latestSpot - strike) > zonePts;

  // Classify
  let rejected = false, accepted = false;

  if (dwellCycles >= minDwellCycles && oscillationPts <= maxOscillation) {
    const arrivedFromBelow = arrivalDirection === 'UP' && strike >= buffer[firstZoneIdx].spot;
    const arrivedFromAbove = arrivalDirection === 'DOWN' && strike <= buffer[firstZoneIdx].spot;
    const nowMovingAway = (arrivedFromBelow && currentDirection === 'DOWN')
                       || (arrivedFromAbove && currentDirection === 'UP');
    if (nowMovingAway) rejected = true;
  }

  if (broke && !rejected) {
    const continuedMomentum = (arrivalDirection === 'UP' && currentDirection === 'UP')
                           || (arrivalDirection === 'DOWN' && currentDirection === 'DOWN');
    if (continuedMomentum || dwellCycles < minDwellCycles) accepted = true;
  }

  return { dwellCycles, dwellMs, oscillationPts, rejected, accepted, inconclusive: !rejected && !accepted };
}

/**
 * Detect cumulative drift over a longer window (~15 min).
 * A slow grind of $6+ in one direction is significant even if no single
 * 5-minute window hit $8.
 */
function detectDrift(ticker) {
  const buf = driftBuffer[ticker] || [];
  if (buf.length < 10) return null; // need at least ~5 min of data

  const oldest = buf[0];
  const newest = buf[buf.length - 1];
  const totalChange = newest.spot - oldest.spot;
  const absTotalChange = Math.abs(totalChange);

  // Check consistency: count how many reads moved in the same direction as the total
  let consistentMoves = 0;
  for (let i = 1; i < buf.length; i++) {
    const delta = buf[i].spot - buf[i - 1].spot;
    if ((totalChange > 0 && delta > 0) || (totalChange < 0 && delta < 0)) {
      consistentMoves++;
    }
  }
  const consistencyRatio = consistentMoves / (buf.length - 1);

  // Need at least 45% of moves in the same direction (filters out whipsaw)
  if (consistencyRatio < 0.45) return null;

  let direction = 'FLAT';
  if (totalChange > 2) direction = 'UP';
  else if (totalChange < -2) direction = 'DOWN';

  let strength = 'WEAK';
  if (absTotalChange >= MOMENTUM.DRIFT_STRONG_PTS) strength = 'STRONG';
  else if (absTotalChange >= MOMENTUM.DRIFT_MODERATE_PTS) strength = 'MODERATE';

  return {
    direction,
    points: parseFloat(totalChange.toFixed(2)),
    strength,
    readings: buf.length,
    consistencyRatio: parseFloat(consistencyRatio.toFixed(2)),
  };
}

/**
 * Push a raw gexAtSpot value into the per-ticker smoothing buffer.
 */
export function pushGexAtSpot(ticker, value) {
  if (!gexAtSpotBuffer[ticker]) gexAtSpotBuffer[ticker] = [];
  gexAtSpotBuffer[ticker].push(value);
  while (gexAtSpotBuffer[ticker].length > GEX_AT_SPOT_WINDOW) {
    gexAtSpotBuffer[ticker].shift();
  }
}

/**
 * Get the smoothed (median) gexAtSpot for a ticker.
 * Median of 3 requires 2/3 agreement on sign — filters single-cycle flips.
 */
export function getSmoothedGexAtSpot(ticker) {
  const buf = gexAtSpotBuffer[ticker] || [];
  if (buf.length === 0) return 0;
  if (buf.length === 1) return buf[0];
  const sorted = [...buf].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Smooth a GEX score using EMA to prevent whipsaw.
 * Resets EMA state when direction flips — prevents smoothing across a boundary
 * (e.g. BULLISH 70 → BEARISH 65 would wrongly smooth to BULLISH 55 without reset).
 * Returns the smoothed score (integer).
 */
export function smoothGexScore(ticker, rawScore, direction) {
  // Reset EMA on direction flip or first call
  if (!smoothedScores[ticker] && smoothedScores[ticker] !== 0 ||
      (direction && smoothedDirection[ticker] && direction !== smoothedDirection[ticker])) {
    smoothedScores[ticker] = rawScore;
    smoothedDirection[ticker] = direction || null;
    return rawScore;
  }
  const smoothed = Math.round(SMOOTHING_ALPHA * rawScore + (1 - SMOOTHING_ALPHA) * smoothedScores[ticker]);
  smoothedScores[ticker] = smoothed;
  smoothedDirection[ticker] = direction || smoothedDirection[ticker];
  return smoothed;
}

/**
 * Record a GEX direction for stability tracking.
 */
export function recordDirection(ticker, direction) {
  if (!directionHistory[ticker]) directionHistory[ticker] = [];
  directionHistory[ticker].push({ direction, timestamp: Date.now() });
  while (directionHistory[ticker].length > DIRECTION_HISTORY_SIZE) {
    directionHistory[ticker].shift();
  }
}

/**
 * Get the last recorded GEX direction for a ticker.
 */
export function getLastDirection(ticker = 'SPXW') {
  const history = directionHistory[ticker] || [];
  return history.length > 0 ? history[history.length - 1].direction : null;
}

/**
 * Check if the GEX direction has been stable for N consecutive cycles.
 */
export function isDirectionStable(ticker, minCycles = 3) {
  const history = directionHistory[ticker] || [];
  if (history.length < minCycles) return false;
  const recent = history.slice(-minCycles);
  return recent.every(d => d.direction === recent[0].direction);
}

/**
 * Check if a direction flip occurred within the last N cycles.
 */
export function hadRecentDirectionFlip(ticker, lookback = 4) {
  const history = directionHistory[ticker] || [];
  if (history.length < 2) return false;
  const start = Math.max(0, history.length - lookback);
  for (let i = start + 1; i < history.length; i++) {
    if (history[i].direction !== history[i - 1].direction) return true;
  }
  return false;
}

/**
 * Record a GEX score for chop detection.
 */
export function recordScore(ticker, score, direction, spotPrice = null) {
  if (!scoreHistory[ticker]) scoreHistory[ticker] = [];
  scoreHistory[ticker].push({ score, direction, spotPrice, timestamp: Date.now() });
  while (scoreHistory[ticker].length > SCORE_HISTORY_SIZE) {
    scoreHistory[ticker].shift();
  }
}

/**
 * Detect if the market is in chop mode based on score history.
 * Chop = frequent direction flips OR high score standard deviation.
 */
export function detectChopMode(ticker = 'SPXW', lookback = 60, cfg = {}) {
  const history = scoreHistory[ticker] || [];
  if (history.length < 10) return { isChop: false, reason: 'insufficient data' };

  const recent = history.slice(-lookback);

  // Count direction flips
  let flips = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].direction !== recent[i - 1].direction) flips++;
  }

  // Flip rate: proportion of cycles that are flips
  const flipRate = recent.length > 1 ? flips / (recent.length - 1) : 0;

  // Calculate score standard deviation
  const scores = recent.map(h => h.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);

  const flipThreshold = cfg.chop_flip_threshold ?? 4;
  const stddevThreshold = cfg.chop_stddev_threshold ?? 15;
  const flipRateThreshold = cfg.chop_flip_rate_threshold ?? 0.30;

  // Compound condition: flips + stddev together, OR high flip rate alone
  let isChop = (flips >= flipThreshold && stddev > stddevThreshold) || flipRate > flipRateThreshold;

  let reason = 'trending';
  if (isChop) {
    if (flipRate > flipRateThreshold) {
      reason = `flip rate ${(flipRate * 100).toFixed(0)}% > ${(flipRateThreshold * 100).toFixed(0)}%`;
    } else {
      reason = `${flips} flips + stddev ${stddev.toFixed(1)}`;
    }
  }

  return {
    isChop,
    flips,
    flipRate: Math.round(flipRate * 100) / 100,
    stddev: Math.round(stddev * 10) / 10,
    readings: recent.length,
    reason,
  };
}

/**
 * Cache the latest SPX spot price (called by main loop each cycle).
 */
export function updateLatestSpot(spotPrice) {
  if (spotPrice && spotPrice > 0) {
    latestSpot = { price: spotPrice, updatedAt: Date.now() };
  }
}

/**
 * Get the cached latest spot price.
 */
export function getLatestSpot() {
  return latestSpot;
}

/**
 * Update GEX regime for a ticker. Call each cycle with the scored direction.
 * Tracks consecutive same-direction cycles for regime persistence detection.
 */
export function updateRegime(ticker, direction) {
  if (!regimeState[ticker]) regimeState[ticker] = { direction: null, startedAt: 0, cycles: 0 };
  if (direction === regimeState[ticker].direction) {
    regimeState[ticker].cycles++;
  } else {
    regimeState[ticker] = { direction, startedAt: Date.now(), cycles: 1 };
  }
}

/**
 * Get regime state for a ticker.
 * Returns { direction, persistent, cycles, minutes }.
 * persistent = true if same direction for 36+ cycles (~3 min at 5s polling).
 */
export function getRegime(ticker = 'SPXW') {
  const r = regimeState[ticker];
  if (!r || !r.direction) return { direction: null, persistent: false, cycles: 0, minutes: 0 };
  const minutes = (Date.now() - r.startedAt) / 60_000;
  return {
    direction: r.direction,
    persistent: r.cycles >= 36,
    cycles: r.cycles,
    minutes: Math.round(minutes),
  };
}

/**
 * Detect node sign changes — walls that flipped from positive to negative (or vice versa)
 * or new walls that emerged as massively negative.
 * Uses rawValue from nodeHistory to compare signed values across time windows.
 * Returns array of { strike, from, to, magnitude, rawValue, prevRawValue? }
 */
export function getNodeSignChanges(ticker = 'SPXW') {
  const history = nodeHistory[ticker] || [];
  if (history.length < 6) return [];

  const current = history[history.length - 1];
  const ago10 = history.length >= 11 ? history[history.length - 11] : null;
  const ago30 = history.length >= 31 ? history[history.length - 31] : null;

  const changes = [];
  const pastRef = ago30 || ago10;
  if (!pastRef) return changes;

  const pastMap = new Map();
  pastRef.walls.forEach(w => pastMap.set(w.strike, w.rawValue));

  for (const wall of current.walls) {
    const pastRaw = pastMap.get(wall.strike);
    const currentRaw = wall.rawValue;
    const currentSign = currentRaw >= 0 ? 'positive' : 'negative';

    if (pastRaw === undefined) {
      // New wall — only flag if large negative (negative emergence)
      if (currentRaw < -5_000_000) {
        changes.push({ strike: wall.strike, from: 'absent', to: currentSign, magnitude: Math.abs(currentRaw), rawValue: currentRaw });
      }
    } else {
      const pastSign = pastRaw >= 0 ? 'positive' : 'negative';
      if (pastSign !== currentSign) {
        changes.push({ strike: wall.strike, from: pastSign, to: currentSign, magnitude: Math.abs(currentRaw), rawValue: currentRaw, prevRawValue: pastRaw });
      }
    }
  }

  return changes;
}

/**
 * Save the king node for a ticker each cycle.
 * Tracks strike, type, and value for king node type flip detection.
 */
export function saveKingNode(kingNode, ticker = 'SPXW') {
  if (!kingNode) return;
  if (!kingNodeHistory[ticker]) kingNodeHistory[ticker] = [];
  kingNodeHistory[ticker].push({
    strike: kingNode.strike,
    type: kingNode.type,
    value: kingNode.absGexValue || Math.abs(kingNode.gexValue || 0),
    timestamp: Date.now(),
  });
  while (kingNodeHistory[ticker].length > KING_HISTORY_SIZE) {
    kingNodeHistory[ticker].shift();
  }
}

/**
 * Detect if the king node at the same strike flipped type (positive↔negative).
 * Returns { strike, fromType, toType, currentValue, cyclesAgo } or null.
 */
export function getKingNodeFlip(ticker = 'SPXW') {
  const history = kingNodeHistory[ticker] || [];
  if (history.length < 10) return null;

  const current = history[history.length - 1];
  // Look back 10-30 cycles to find if same strike had different type
  for (let i = Math.max(0, history.length - 31); i < history.length - 5; i++) {
    const past = history[i];
    if (past.strike === current.strike && past.type !== current.type) {
      return {
        strike: current.strike,
        fromType: past.type,
        toType: current.type,
        currentValue: current.value,
        cyclesAgo: history.length - 1 - i,
      };
    }
  }
  return null;
}

/**
 * Reset daily state (call at 9:25 AM ET before warm-up).
 */
/**
 * Save a snapshot of current stacked_walls for persistence tracking.
 * Called each cycle from main-loop after analyzeMultiTicker().
 */
export function saveStackSnapshot(stackedWalls, ticker = 'SPXW') {
  if (!stackSnapshots[ticker]) stackSnapshots[ticker] = [];
  const relevantStacks = (stackedWalls || []).filter(sw => sw.ticker === ticker);
  stackSnapshots[ticker].push({
    timestamp: Date.now(),
    stacks: relevantStacks.map(sw => ({
      type: sw.type,
      sign: sw.sign,
      startStrike: sw.startStrike,
      endStrike: sw.endStrike,
      count: sw.count,
    })),
  });
  while (stackSnapshots[ticker].length > STACK_SNAPSHOT_SIZE) {
    stackSnapshots[ticker].shift();
  }
}

/**
 * Get stack persistence metrics for a given direction.
 * Determines if overhead/underfoot magnet stacks are persistent, growing, shrinking, or gone.
 * @param {string} ticker
 * @param {string} direction - 'BULLISH' or 'BEARISH'
 */
export function getStackPersistence(ticker = 'SPXW', direction = 'BULLISH') {
  const history = stackSnapshots[ticker] || [];
  if (history.length < 2) {
    return { presentCycles: 0, totalCycles: history.length, isPresent: false, trend: 'UNKNOWN', disappeared: false, currentNodeCount: 0 };
  }

  const relevantTypes = direction === 'BULLISH'
    ? ['magnet_above', 'ceiling']
    : ['magnet_below', 'floor'];

  let presentCycles = 0;
  let currentNodeCount = 0;
  let firstNodeCount = 0;

  for (let i = 0; i < history.length; i++) {
    const snap = history[i];
    const relevantNodes = snap.stacks.filter(s => relevantTypes.includes(s.type));
    const nodeCount = relevantNodes.reduce((sum, s) => sum + s.count, 0);
    if (relevantNodes.length > 0) presentCycles++;
    if (i === 0) firstNodeCount = nodeCount;
    if (i === history.length - 1) currentNodeCount = nodeCount;
  }

  const isPresent = presentCycles > 0 && currentNodeCount > 0;
  const lastSnap = history[history.length - 1];
  const hasRelevantNow = lastSnap.stacks.some(s => relevantTypes.includes(s.type));
  const disappeared = !hasRelevantNow && presentCycles > history.length * 0.5;

  let trend = 'STABLE';
  if (disappeared) {
    trend = 'GONE';
  } else if (firstNodeCount > 0 && currentNodeCount > 0) {
    const changePct = (currentNodeCount - firstNodeCount) / firstNodeCount;
    if (changePct >= 0.30) trend = 'GROWING';
    else if (changePct <= -0.30) trend = 'SHRINKING';
  } else if (firstNodeCount === 0 && currentNodeCount > 0) {
    trend = 'GROWING';
  }

  return { presentCycles, totalCycles: history.length, isPresent, trend, disappeared, currentNodeCount };
}

/**
 * Save total net GEX for rate-of-change tracking.
 * Called each cycle from scoreSpxGex() after computing totalNetGex.
 */
export function saveNetGex(totalNetGex, ticker = 'SPXW') {
  if (!netGexBuffer[ticker]) netGexBuffer[ticker] = [];
  netGexBuffer[ticker].push({ value: totalNetGex, timestamp: Date.now() });
  if (netGexBuffer[ticker].length > NET_GEX_BUFFER_SIZE) netGexBuffer[ticker].shift();
}

/**
 * Get net GEX rate of change — delta and slope over the buffer window.
 * RISING = net GEX increasing (stabilizing), FALLING = decreasing (destabilizing).
 */
export function getNetGexRoC(ticker = 'SPXW') {
  const buf = netGexBuffer[ticker] || [];
  if (buf.length < 5) return { delta: 0, slope: 0, trend: 'UNKNOWN', current: 0 };
  const recent = buf[buf.length - 1].value;
  const past5 = buf[buf.length - 5].value;
  const past = buf[0].value;
  const delta5 = recent - past5;
  const deltaFull = recent - past;
  const slope = deltaFull / buf.length;
  const trend = slope > 500_000 ? 'RISING' : slope < -500_000 ? 'FALLING' : 'FLAT';
  return { delta: delta5, slope: Math.round(slope), trend, current: recent };
}

/**
 * Set replay time override. When set, getEffectiveTime() returns this instead of nowET().
 * Call with null to clear.
 */
export function setReplayTime(dateTime) {
  replayTimeOverride = dateTime;
}

/**
 * Get effective time — replay override or live nowET().
 * Use this in scoring/patterns instead of nowET() directly.
 */
export function getEffectiveTime() {
  if (replayTimeOverride) return replayTimeOverride;
  // Dynamic import avoided — caller should import nowET separately if needed
  return null; // null = use nowET() at call site
}

/**
 * Update HOD/LOD tracking. Call each cycle with current spot price.
 * Also tracks opening range and round-trip detection.
 */
export function updateHodLod(spotPrice, timestamp = Date.now()) {
  if (!spotPrice || spotPrice <= 0) return;
  if (spotPrice > dailyHOD.price) {
    dailyHOD = { price: spotPrice, timestamp };
  }
  if (spotPrice < dailyLOD.price) {
    dailyLOD = { price: spotPrice, timestamp };
  }

  // Track opening range (first ~2 min of readings)
  openRangeReadings++;
  if (openRangeReadings <= OPEN_RANGE_READINGS) {
    if (openRangeReadings === 1) {
      dailyOpenRange.open = spotPrice;
      dailyOpenRange.rangeHigh = spotPrice;
      dailyOpenRange.rangeLow = spotPrice;
    }
    if (spotPrice > dailyOpenRange.rangeHigh) dailyOpenRange.rangeHigh = spotPrice;
    if (spotPrice < dailyOpenRange.rangeLow) dailyOpenRange.rangeLow = spotPrice;
  }

  // Round-trip detection: after establishing opening range, check if price
  // moved >15pts away and then returned within 3pts of open
  if (openRangeReadings > OPEN_RANGE_READINGS && !dailyOpenRange.roundTripDetected) {
    const excursion = Math.max(
      Math.abs(dailyHOD.price - dailyOpenRange.open),
      Math.abs(dailyLOD.price - dailyOpenRange.open)
    );
    dailyOpenRange.maxExcursion = Math.max(dailyOpenRange.maxExcursion, excursion);

    // Price moved >15pts from open AND returned within 3pts of open = round trip
    if (dailyOpenRange.maxExcursion >= 15 && Math.abs(spotPrice - dailyOpenRange.open) <= 3) {
      dailyOpenRange.roundTripDetected = true;
    }
  }
}

/**
 * Get current HOD/LOD and whether spot is at a new extreme.
 */
export function getHodLod(spotPrice) {
  const isNewHOD = spotPrice && spotPrice >= dailyHOD.price;
  const isNewLOD = spotPrice && spotPrice <= dailyLOD.price;
  const nearHOD = spotPrice && Math.abs(spotPrice - dailyHOD.price) <= 3;
  const nearLOD = spotPrice && Math.abs(spotPrice - dailyLOD.price) <= 3;
  return {
    hod: dailyHOD.price,
    lod: dailyLOD.price === Infinity ? 0 : dailyLOD.price,
    isNewHOD,
    isNewLOD,
    nearHOD,
    nearLOD,
  };
}

/**
 * Get round-trip day status — true when price returned to open after big excursion.
 * Round-trip days are chop days — confidence should be reduced.
 */
export function getRoundTripStatus() {
  return {
    roundTrip: dailyOpenRange.roundTripDetected,
    openPrice: dailyOpenRange.open,
    maxExcursion: dailyOpenRange.maxExcursion,
    rangeHigh: dailyOpenRange.rangeHigh,
    rangeLow: dailyOpenRange.rangeLow,
  };
}

/**
 * Find walls that have doubled (100%+ growth) over 30 cycles (~15 min).
 * Returns array of { strike, currentValue, growth30Pct, longTrend }.
 */
export function getDoublingWalls(ticker = 'SPXW') {
  const trends = getNodeTrends(ticker);
  const doubling = [];
  for (const [strike, t] of trends) {
    if (t.changePct30 >= 1.0 && t.currentValue >= 3_000_000) {
      doubling.push({ strike, currentValue: t.currentValue, growth30Pct: t.changePct30, longTrend: t.longTrend });
    }
  }
  return doubling;
}

/**
 * Find walls with rapid absolute growth ($5M+ over 30 cycles) within range of spot.
 * Absolute growth catches walls going $2M→$7M (significant!) that percentage thresholds miss
 * because they start small. Also catches $20M→$25M walls that don't hit 20% but gained $5M.
 * @param {number} spotPrice - Current spot price
 * @param {number} [maxDistPts=15] - Maximum distance from spot in points
 * @param {number} [minAbsGrowth=5_000_000] - Minimum absolute growth
 */
export function getRapidGrowthWalls(ticker = 'SPXW', spotPrice = 0, maxDistPts = 15, minAbsGrowth = 5_000_000) {
  const trends = getNodeTrends(ticker);
  const rapid = [];
  for (const [strike, t] of trends) {
    if (spotPrice > 0 && Math.abs(strike - spotPrice) > maxDistPts) continue;
    if ((t.absChange30 || 0) >= minAbsGrowth) {
      rapid.push({
        strike,
        currentValue: t.currentValue,
        absChange30: t.absChange30,
        changePct30: t.changePct30,
        trend: t.trend,
      });
    }
  }
  return rapid.sort((a, b) => b.absChange30 - a.absChange30);
}

export function resetDailyState() {
  smoothedScores.SPXW = null;
  smoothedScores.SPY = null;
  smoothedScores.QQQ = null;
  smoothedDirection.SPXW = null;
  smoothedDirection.SPY = null;
  smoothedDirection.QQQ = null;
  directionHistory.SPXW = [];
  directionHistory.SPY = [];
  directionHistory.QQQ = [];
  scoreHistory.SPXW = [];
  scoreHistory.SPY = [];
  scoreHistory.QQQ = [];
  nodeHistory.SPXW = [];
  nodeHistory.SPY = [];
  nodeHistory.QQQ = [];
  regimeState.SPXW = { direction: null, startedAt: 0, cycles: 0 };
  regimeState.SPY = { direction: null, startedAt: 0, cycles: 0 };
  regimeState.QQQ = { direction: null, startedAt: 0, cycles: 0 };
  kingNodeHistory.SPXW = [];
  kingNodeHistory.SPY = [];
  kingNodeHistory.QQQ = [];
  stackSnapshots.SPXW = [];
  stackSnapshots.SPY = [];
  stackSnapshots.QQQ = [];
  netGexBuffer.SPXW = [];
  netGexBuffer.SPY = [];
  netGexBuffer.QQQ = [];
  dailyHOD = { price: 0, timestamp: 0 };
  dailyLOD = { price: Infinity, timestamp: 0 };
  dailyOpenRange = { open: 0, rangeHigh: 0, rangeLow: 0, maxExcursion: 0, roundTripDetected: false };
  openRangeReadings = 0;
  strikeMemory.SPXW = new Map();
  strikeMemory.SPY = new Map();
  strikeMemory.QQQ = new Map();
}

/**
 * Check if an alert was already sent recently (within configured cooldown).
 * If not duplicate, records the alert in the database.
 */
export function isDuplicateAlert(alertType, strike = 0) {
  const recentAlerts = getRecentAlerts(alertType, ALERT_DEDUP_MINUTES);

  for (const alert of recentAlerts) {
    try {
      const content = JSON.parse(alert.content);
      if (content.strike === strike) return true;
    } catch {
      // If content doesn't have strike, check by type only
      if (strike === 0) return true;
    }
  }

  return false;
}

/**
 * Record that an alert was sent (for dedup tracking).
 */
export function recordAlert(alertType, data, discordSent = true) {
  saveAlert(alertType, data, discordSent);
}
