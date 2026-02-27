/**
 * GEX Data Parser
 * Parses raw Heatseeker API response into structured GEX data.
 *
 * API Response format:
 *   CurrentSpot: number (spot price)
 *   Expirations: string[] (expiry dates)
 *   GammaValues: number[][] (2D: rows=strikes, cols=expirations)
 *   GammaMaxValue / GammaMinValue: number (range for heatmap)
 *   Strikes: number[] (optional — strike prices per row)
 *   VannaValues: number[][] (optional)
 */

import { WALL_MIN_INDEX, VEX } from './constants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GEX-Parser');

/**
 * Parse raw API response into structured GEX data.
 */
export function parseGexResponse(raw) {
  const spotPrice = raw.CurrentSpot;
  const expirations = raw.Expirations || [];
  const gammaValues = raw.GammaValues || [];
  const numRows = gammaValues.length;
  const numCols = expirations.length;

  // Get strikes — from response or compute them
  let strikes;
  if (raw.Strikes && Array.isArray(raw.Strikes)) {
    strikes = raw.Strikes;
  } else {
    // Compute strikes: assume $5 intervals for SPXW, centered on spot
    const step = 5;
    const halfRange = Math.floor(numRows / 2);
    const startStrike = Math.round((spotPrice - halfRange * step) / step) * step;
    strikes = [];
    for (let i = 0; i < numRows; i++) {
      strikes.push(startStrike + i * step);
    }
    log.info(`No Strikes array — computed ${numRows} strikes from ${strikes[0]} to ${strikes[strikes.length - 1]}`);
  }

  // PRIMARY: 0DTE GEX (first expiration only — what Heatseeker shows, drives intraday)
  const aggregatedGex = new Map();
  for (let row = 0; row < numRows; row++) {
    const rowData = gammaValues[row];
    const val = (rowData && rowData[0]) || 0; // column 0 = today's expiration
    aggregatedGex.set(strikes[row], val);
  }

  // Near-term GEX (first 2 expirations — today + tomorrow)
  const nearTermGex = new Map();
  const nearTermCols = Math.min(2, numCols);
  for (let row = 0; row < numRows; row++) {
    let total = 0;
    const rowData = gammaValues[row];
    if (rowData) {
      for (let col = 0; col < nearTermCols; col++) {
        total += rowData[col] || 0;
      }
    }
    nearTermGex.set(strikes[row], total);
  }

  // Full aggregate (all expirations — kept for reference)
  const allExpGex = new Map();
  for (let row = 0; row < numRows; row++) {
    let total = 0;
    const rowData = gammaValues[row];
    if (rowData) {
      for (let col = 0; col < numCols; col++) {
        total += rowData[col] || 0;
      }
    }
    allExpGex.set(strikes[row], total);
  }

  // VEX (Vanna Exposure) — same 2D format as GammaValues
  const vannaValues = raw.VannaValues || [];
  const vexMap = new Map();
  for (let row = 0; row < numRows; row++) {
    const rowData = vannaValues[row];
    const val = (rowData && rowData[0]) || 0; // 0DTE only
    vexMap.set(strikes[row], val);
  }

  log.debug(`Using 0DTE expiration: ${expirations[0] || 'unknown'} | ${numRows} strikes | ${numCols} expirations | VEX: ${vannaValues.length > 0 ? 'yes' : 'no'}`);

  return {
    spotPrice,
    expirations,
    strikes,
    gammaValues,
    aggregatedGex,   // 0DTE only (primary — used for scoring + walls)
    nearTermGex,     // today + tomorrow
    allExpGex,       // all expirations summed (reference only)
    vexMap,          // Vanna Exposure 0DTE (Gap 10)
    gammaMaxValue: raw.GammaMaxValue || 0,
    gammaMinValue: raw.GammaMinValue || 0,
    walls: [], // filled by identifyWalls()
  };
}

/**
 * Identify significant GEX walls (concentrations) in the data.
 * Uses top-N by absolute value + percentile ranking (no neighbor comparison).
 */
export function identifyWalls(parsedData) {
  const { aggregatedGex, strikes, spotPrice } = parsedData;
  const minWallSize = WALL_MIN_INDEX;

  // Step 1: Compute percentile ranks for ALL strikes
  const allAbs = strikes.map(s => Math.abs(aggregatedGex.get(s) || 0)).sort((a, b) => a - b);
  const p90Threshold = allAbs[Math.floor(allAbs.length * 0.90)] || 0;

  // Step 2: Top 10 by absolute value within ±100pts of spot
  const nearSpot = strikes
    .filter(s => Math.abs(s - spotPrice) <= 100)
    .map(s => ({ strike: s, absGex: Math.abs(aggregatedGex.get(s) || 0) }))
    .sort((a, b) => b.absGex - a.absGex)
    .slice(0, 10);

  const topNStrikes = new Set(nearSpot.map(n => n.strike));

  // Step 3: Add any strike in top 10% by absolute value (within ±150pts)
  for (const strike of strikes) {
    if (Math.abs(strike - spotPrice) > 150) continue;
    const absGex = Math.abs(aggregatedGex.get(strike) || 0);
    if (absGex >= p90Threshold && absGex >= minWallSize) {
      topNStrikes.add(strike);
    }
  }

  // Step 4: Build wall objects (filter by min threshold)
  const walls = [];
  for (const strike of topNStrikes) {
    const gex = aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    if (absGex < minWallSize) continue;

    // Compute percentile rank
    let rank = allAbs.findIndex(v => v >= absGex);
    if (rank < 0) rank = allAbs.length;
    const percentileRank = Math.round((rank / allAbs.length) * 100);

    walls.push({
      strike,
      gexValue: gex,
      absGexValue: absGex,
      type: gex > 0 ? 'positive' : 'negative',
      relativeToSpot: strike > spotPrice ? 'above' : strike < spotPrice ? 'below' : 'at',
      distanceFromSpot: Math.abs(strike - spotPrice),
      distancePct: (Math.abs(strike - spotPrice) / spotPrice * 100),
      percentileRank,
    });
  }

  // Sort by absolute GEX value descending
  walls.sort((a, b) => b.absGexValue - a.absGexValue);

  return walls;
}

/**
 * Get GEX value at the spot price (interpolate between nearest strikes).
 */
export function getGexAtSpot(aggregatedGex, strikes, spotPrice) {
  let lowerIdx = 0;
  for (let i = 0; i < strikes.length - 1; i++) {
    if (strikes[i] <= spotPrice && strikes[i + 1] >= spotPrice) {
      lowerIdx = i;
      break;
    }
  }

  const lower = strikes[lowerIdx];
  const upper = strikes[Math.min(lowerIdx + 1, strikes.length - 1)];
  const gexLower = aggregatedGex.get(lower) || 0;
  const gexUpper = aggregatedGex.get(upper) || 0;

  if (lower === upper) return gexLower;

  const weight = (spotPrice - lower) / (upper - lower);
  return gexLower + (gexUpper - gexLower) * weight;
}

/**
 * Detect VEX (Vanna Exposure) confluence with GEX walls.
 * Returns array of confluence assessments for each wall.
 */
export function detectVexConfluence(parsedData) {
  const { walls, vexMap, spotPrice } = parsedData;
  if (!vexMap || vexMap.size === 0 || walls.length === 0) return [];

  const results = [];

  for (const wall of walls) {
    const vexValue = vexMap.get(wall.strike) || 0;
    const absVex = Math.abs(vexValue);
    const absGex = wall.absGexValue;

    if (absGex === 0) continue;

    const ratio = absVex / absGex;

    let type = 'NEUTRAL';
    if (ratio >= VEX.MIN_RATIO) {
      // Same sign = reinforcing (both push same direction at that strike)
      // Opposite sign = opposing (vanna fights gamma)
      const sameSign = (vexValue > 0 && wall.gexValue > 0) || (vexValue < 0 && wall.gexValue < 0);
      type = sameSign ? 'REINFORCING' : 'OPPOSING';
    }

    results.push({
      strike: wall.strike,
      gexValue: wall.gexValue,
      vexValue,
      ratio: parseFloat(ratio.toFixed(3)),
      type,
    });
  }

  return results;
}

/**
 * Format a dollar value for display.
 */
export function formatDollar(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
