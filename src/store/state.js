/**
 * State management — replaces Chrome storage with SQLite-backed state.
 * Tracks GEX read history, wall trends, and alert deduplication.
 */

import { getRecentSnapshots, getRecentAlerts, saveAlert } from './db.js';
import { ALERT_DEDUP_MINUTES } from '../gex/constants.js';

// In-memory GEX history for wall trend detection (keeps last 3 reads per ticker)
const gexHistory = { SPXW: [], SPY: [], QQQ: [] };
const MAX_HISTORY = 3;

/**
 * Save a GEX read for trend detection (keeps last 3 in memory per ticker).
 */
export function saveGexRead(parsedData, ticker = 'SPXW') {
  if (!gexHistory[ticker]) gexHistory[ticker] = [];

  gexHistory[ticker].push({
    timestamp: Date.now(),
    spotPrice: parsedData.spotPrice,
    walls: (parsedData.walls || []).slice(0, 10),
  });

  while (gexHistory[ticker].length > MAX_HISTORY) {
    gexHistory[ticker].shift();
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
