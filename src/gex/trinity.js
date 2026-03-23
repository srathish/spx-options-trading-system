/**
 * Trinity Mode — Cross-Market GEX Analysis
 * Fetches SPXW + SPY + QQQ with staggered requests, runs full scoring on each,
 * and prepares per-ticker state for the multi-ticker analyzer.
 */

import { fetchGexData } from './gex-ingester.js';
import { parseGexResponse, identifyWalls, getGexAtSpot } from './gex-parser.js';
import { scoreSpxGex } from './gex-scorer.js';
import { WALL_MIN_INDEX, WALL_MIN_QQQ, MULTI_TICKER } from './constants.js';
import { saveGexRead, getGexHistory, detectWallTrends, saveNodeSnapshot, saveStrikeMemory, getNodeTrends } from '../store/state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Trinity');

// In-memory trinity state
let trinityState = null;

// Wall thresholds per ticker
const WALL_THRESHOLDS = {
  SPXW: WALL_MIN_INDEX,
  SPY: WALL_MIN_INDEX,
  QQQ: WALL_MIN_QQQ,
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch, parse, score all three tickers with staggered requests.
 * Returns { spxw, spy, qqq } where each is a full ticker state or null.
 */
export async function fetchTrinityData() {
  const tickers = ['SPXW', 'SPY', 'QQQ'];
  const results = {};

  for (const ticker of tickers) {
    try {
      const raw = await fetchGexData(ticker);
      const parsed = parseGexResponse(raw);
      const walls = identifyWalls(parsed);
      parsed.walls = walls;

      // Save to per-ticker history and compute wall trends
      saveGexRead(parsed, ticker);
      saveNodeSnapshot(walls, ticker);
      saveStrikeMemory(walls, parsed.spotPrice, ticker);
      const history = getGexHistory(ticker);
      const wallTrends = history.length >= 2 ? detectWallTrends(walls, history) : [];
      const nodeTrends = getNodeTrends(ticker);

      // Full scoring (same scorer as SPXW) — pass ticker for per-ticker gexAtSpot smoothing
      const scored = scoreSpxGex(parsed, wallTrends, 0, ticker);

      results[ticker] = { raw, parsed, walls, scored, wallTrends, nodeTrends };
    } catch (err) {
      log.warn(`${ticker} fetch failed: ${err.message}`);
      results[ticker] = null;
    }

    // Stagger requests
    if (ticker !== tickers[tickers.length - 1]) {
      await sleep(MULTI_TICKER.STAGGER_MS);
    }
  }

  const trinity = {
    spxw: results.SPXW || null,
    spy: results.SPY || null,
    qqq: results.QQQ || null,
  };

  // Build dashboard-friendly state
  trinityState = {
    spxw: trinity.spxw ? buildTickerState('SPXW', trinity.spxw) : null,
    spy: trinity.spy ? buildTickerState('SPY', trinity.spy) : null,
    qqq: trinity.qqq ? buildTickerState('QQQ', trinity.qqq) : null,
    timestamp: Date.now(),
  };

  const dirs = [trinity.spxw, trinity.spy, trinity.qqq]
    .map((t, i) => t ? `${tickers[i]}=${t.scored.direction}` : `${tickers[i]}=N/A`);
  log.debug(`Trinity: ${dirs.join(' | ')}`);

  return trinity;
}

/**
 * Build a full ticker state object for dashboard + multi-ticker analyzer.
 */
function buildTickerState(ticker, data) {
  const { parsed, walls, scored, wallTrends, nodeTrends } = data;
  const spotPrice = parsed.spotPrice;

  // Get strikes around spot (±20 strikes) with their GEX values
  const spotIdx = parsed.strikes.findIndex(s => s >= spotPrice);
  const startIdx = Math.max(0, spotIdx - 20);
  const endIdx = Math.min(parsed.strikes.length, spotIdx + 20);

  const strikes = [];
  let maxAbsGex = 0;

  for (let i = startIdx; i < endIdx; i++) {
    const strike = parsed.strikes[i];
    const gexValue = parsed.aggregatedGex.get(strike) || 0;
    maxAbsGex = Math.max(maxAbsGex, Math.abs(gexValue));
    strikes.push({ strike, gexValue });
  }

  // Find king node — largest absolute GEX strike (unfiltered, not from walls)
  let largestWall = null;
  let largestAbsGex = 0;
  for (const strike of parsed.strikes) {
    const gex = parsed.aggregatedGex.get(strike) || 0;
    if (Math.abs(gex) > largestAbsGex) {
      largestAbsGex = Math.abs(gex);
      largestWall = {
        strike,
        gexValue: gex,
        absGexValue: Math.abs(gex),
        type: gex > 0 ? 'positive' : 'negative',
        relativeToSpot: strike > spotPrice ? 'above' : strike < spotPrice ? 'below' : 'at',
        distanceFromSpot: Math.abs(strike - spotPrice),
        distancePct: (Math.abs(strike - spotPrice) / spotPrice * 100),
      };
    }
  }

  return {
    ticker,
    spotPrice,
    scored: {
      score: scored.score,
      direction: scored.direction,
      confidence: scored.confidence,
      environment: scored.environment,
      envDetail: scored.envDetail,
      gexAtSpot: scored.gexAtSpot,
      smoothedGexAtSpot: scored.smoothedGexAtSpot,
      breakdown: scored.breakdown,
      targetWall: scored.targetWall,
      floorWall: scored.floorWall,
      distanceToTarget: scored.distanceToTarget,
      wallsAbove: scored.wallsAbove,
      wallsBelow: scored.wallsBelow,
    },
    strikes,
    maxAbsGex,
    topWalls: walls.slice(0, 10),
    largestWall,
    wallTrends: wallTrends || [],
    nodeTrends: nodeTrends || new Map(),
    // Advanced analysis data (Gaps 9, 10)
    aggregatedGex: parsed.aggregatedGex,  // 0DTE Map — for hedge node + wall classification
    allExpGex: parsed.allExpGex,          // All expirations Map — for hedge node detection
    vexMap: parsed.vexMap,                // Vanna Exposure Map — for VEX confluence
  };
}

/**
 * Get the cached trinity state (for dashboard).
 */
export function getTrinityState() {
  return trinityState;
}
