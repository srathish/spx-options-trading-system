/**
 * State management — replaces Chrome storage with SQLite-backed state.
 * Tracks GEX read history, wall trends, and alert deduplication.
 */

import { getRecentSnapshots, getRecentAlerts, saveAlert } from './db.js';
import { ALERT_DEDUP_MINUTES, MOMENTUM } from '../gex/constants.js';

// In-memory GEX history for wall trend detection (keeps last 3 reads per ticker)
const gexHistory = { SPXW: [], SPY: [], QQQ: [] };
const MAX_HISTORY = 3;

// Spot price ring buffer for momentum detection (keeps last N reads per ticker)
const spotBuffer = { SPXW: [], SPY: [], QQQ: [] };

// Longer drift buffer — catches slow grinding moves over 15+ minutes
const driftBuffer = { SPXW: [], SPY: [], QQQ: [] };

// GEX-at-spot smoothing buffer — rolling median prevents oscillation at gamma boundaries
const gexAtSpotBuffer = { SPXW: [], SPY: [], QQQ: [] };
const GEX_AT_SPOT_WINDOW = 3;

// EMA score smoothing — prevents score whipsaw on small spot moves
const smoothedScores = { SPXW: null, SPY: null, QQQ: null };
const SMOOTHING_ALPHA = 0.3; // 0.3 = responsive (30% toward new value each cycle)

// Cached latest spot price (updated each main loop cycle)
let latestSpot = { price: null, updatedAt: 0 };

// Direction history for stability detection
const directionHistory = { SPXW: [], SPY: [], QQQ: [] };
const DIRECTION_HISTORY_SIZE = 10;

// Score history for chop detection
const scoreHistory = { SPXW: [], SPY: [], QQQ: [] };
const SCORE_HISTORY_SIZE = 60; // 60 cycles = ~30 min

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
 * Returns the smoothed score (integer).
 */
export function smoothGexScore(ticker, rawScore) {
  if (!smoothedScores[ticker] && smoothedScores[ticker] !== 0) {
    smoothedScores[ticker] = rawScore;
    return rawScore;
  }
  const smoothed = Math.round(SMOOTHING_ALPHA * rawScore + (1 - SMOOTHING_ALPHA) * smoothedScores[ticker]);
  smoothedScores[ticker] = smoothed;
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
export function recordScore(ticker, score, direction) {
  if (!scoreHistory[ticker]) scoreHistory[ticker] = [];
  scoreHistory[ticker].push({ score, direction, timestamp: Date.now() });
  while (scoreHistory[ticker].length > SCORE_HISTORY_SIZE) {
    scoreHistory[ticker].shift();
  }
}

/**
 * Detect if the market is in chop mode based on score history.
 * Chop = frequent direction flips OR high score standard deviation.
 */
export function detectChopMode(ticker = 'SPXW', lookback = 60) {
  const history = scoreHistory[ticker] || [];
  if (history.length < 10) return { isChop: false, reason: 'insufficient data' };

  const recent = history.slice(-lookback);

  // Count direction flips
  let flips = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].direction !== recent[i - 1].direction) flips++;
  }

  // Calculate score standard deviation
  const scores = recent.map(h => h.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);

  const isChop = flips >= 6 || stddev > 20;

  return {
    isChop,
    flips,
    stddev: Math.round(stddev * 10) / 10,
    readings: recent.length,
    reason: isChop
      ? (flips >= 6 ? `${flips} direction flips` : `score stddev ${stddev.toFixed(1)}`)
      : 'trending',
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
 * Reset daily state (call at 9:25 AM ET before warm-up).
 */
export function resetDailyState() {
  smoothedScores.SPXW = null;
  smoothedScores.SPY = null;
  smoothedScores.QQQ = null;
  directionHistory.SPXW = [];
  directionHistory.SPY = [];
  directionHistory.QQQ = [];
  scoreHistory.SPXW = [];
  scoreHistory.SPY = [];
  scoreHistory.QQQ = [];
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
