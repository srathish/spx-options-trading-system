/**
 * Multi-Ticker Analyzer — Cross-market GEX pattern detection.
 *
 * Takes fully-scored SPXW/SPY/QQQ state and detects:
 * - King nodes (largest wall per ticker + proximity to spot)
 * - Driver (which ticker is catalyzing the move)
 * - Alignment (how many tickers agree on direction)
 * - Stacked walls (3+ consecutive same-sign strikes = strong barrier)
 * - Rug setups (negative wall near positive wall)
 * - Node slides (wall appearing or growing 100%+ between reads)
 * - Multi-signal synthesis (overall cross-market verdict)
 */

import { MULTI_TICKER, STRIKE_STEPS, GATEKEEPER, ROLLING_WALL, RESHUFFLE, HEDGE_NODE } from './constants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MultiTicker');

// Cached last analysis for dashboard
let lastAnalysis = null;

/**
 * Run full multi-ticker analysis.
 * @param {object|null} spxState - buildTickerState() output from trinity.js
 * @param {object|null} spyState
 * @param {object|null} qqqState
 * @returns {object} Full analysis result
 */
export function analyzeMultiTicker(spxState, spyState, qqqState) {
  const states = { SPXW: spxState, SPY: spyState, QQQ: qqqState };

  // 1. King nodes per ticker
  const kingNodes = {};
  for (const [ticker, state] of Object.entries(states)) {
    kingNodes[ticker] = state ? findKingNode(state) : null;
  }

  // 2. Stacked walls per ticker
  const stackedWalls = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      stackedWalls.push(...detectStackedWalls(state, ticker));
    }
  }

  // 3. Rug setups per ticker
  const rugSetups = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      rugSetups.push(...detectRugSetups(state, ticker));
    }
  }

  // 4. Node slides per ticker
  const nodeSlides = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      nodeSlides.push(...detectNodeSlides(state, ticker));
    }
  }

  // 5. Alignment
  const alignment = computeAlignment(spxState, spyState, qqqState);

  // 6. Driver detection (depends on king nodes, node slides, and scores)
  const driver = detectDriver(states, kingNodes, nodeSlides);

  // 7. Multi-signal synthesis
  const multiSignal = computeMultiSignal(driver, alignment, stackedWalls, rugSetups, nodeSlides);

  // 8. Wall classifications per ticker (Gap 1)
  const wallClassifications = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      wallClassifications.push(...classifyWalls(state, ticker));
    }
  }

  // 9. Rolling walls per ticker (Gap 4)
  const rollingWalls = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      rollingWalls.push(...detectRollingWalls(state, ticker));
    }
  }

  // 10. Map reshuffle detection per ticker (Gap 5)
  const reshuffles = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      const reshuffle = detectReshuffle(state, ticker);
      if (reshuffle) reshuffles.push(reshuffle);
    }
  }

  // 11. Hedge node detection per ticker (Gap 9)
  const hedgeNodes = [];
  for (const [ticker, state] of Object.entries(states)) {
    if (state) {
      hedgeNodes.push(...detectHedgeNodes(state, ticker));
    }
  }

  // 12. Enhanced bonus for SPX scoring
  const spxDirection = spxState?.scored?.direction || 'CHOP';
  const bonus = computeEnhancedBonus(alignment, driver, spxDirection);

  lastAnalysis = {
    driver,
    alignment,
    king_nodes: kingNodes,
    stacked_walls: stackedWalls,
    rug_setups: rugSetups,
    node_slides: nodeSlides,
    multi_signal: multiSignal,
    bonus,
    wall_classifications: wallClassifications,
    rolling_walls: rollingWalls,
    reshuffles,
    hedge_nodes: hedgeNodes,
  };

  log.debug(`Analysis: Driver=${driver?.ticker || 'NONE'} | Alignment=${alignment.count}/3 ${alignment.direction} | Bonus=+${bonus}`);

  return lastAnalysis;
}

/**
 * Get cached last analysis for dashboard.
 */
export function getLastMultiAnalysis() {
  return lastAnalysis;
}

// ---- Internal analysis functions ----

/**
 * Find the king node (single largest absolute wall) for a ticker.
 * Returns { wall, distancePct } or null.
 */
function findKingNode(state) {
  const { largestWall, spotPrice } = state;
  if (!largestWall) return null;

  const distancePct = Math.abs(largestWall.strike - spotPrice) / spotPrice * 100;
  const isNear = distancePct <= MULTI_TICKER.KING_NODE_PROXIMITY_PCT;

  return {
    strike: largestWall.strike,
    gexValue: largestWall.gexValue,
    absGexValue: largestWall.absGexValue,
    type: largestWall.type,
    relativeToSpot: largestWall.relativeToSpot,
    distancePct,
    isNear,
  };
}

/**
 * Detect the driver — which ticker is catalyzing the move.
 * Priority: node slide > king node proximity > score strength.
 */
function detectDriver(states, kingNodes, nodeSlides) {
  // Priority 1: Ticker with a node slide (dealer manipulation)
  if (nodeSlides.length > 0) {
    // Pick the slide with the largest absolute new value
    const biggest = nodeSlides.sort((a, b) => Math.abs(b.new_value) - Math.abs(a.new_value))[0];
    const state = states[biggest.ticker];
    return {
      ticker: biggest.ticker,
      reason: `Node slide at ${biggest.strike} (${biggest.description})`,
      score: state?.scored?.score || 0,
      direction: state?.scored?.direction || 'NEUTRAL',
    };
  }

  // Priority 2: Ticker closest to its king node (by % distance)
  const nearKings = Object.entries(kingNodes)
    .filter(([_, kn]) => kn && kn.isNear)
    .sort((a, b) => a[1].distancePct - b[1].distancePct);

  if (nearKings.length > 0) {
    const [ticker, kn] = nearKings[0];
    const state = states[ticker];
    const wallType = kn.type === 'positive' ? 'support/resistance' : 'magnet';
    return {
      ticker,
      reason: `At king node ${kn.strike} (${wallType}, ${kn.distancePct.toFixed(2)}% away)`,
      score: state?.scored?.score || 0,
      direction: state?.scored?.direction || 'NEUTRAL',
    };
  }

  // Priority 3: Ticker with highest score
  const scored = Object.entries(states)
    .filter(([_, s]) => s && s.scored)
    .sort((a, b) => b[1].scored.score - a[1].scored.score);

  if (scored.length > 0) {
    const [ticker, state] = scored[0];
    return {
      ticker,
      reason: `Strongest setup (score ${state.scored.score}/100)`,
      score: state.scored.score,
      direction: state.scored.direction,
    };
  }

  return null;
}

/**
 * Compute directional alignment across all tickers.
 */
function computeAlignment(spxState, spyState, qqqState) {
  const directions = [
    spxState?.scored?.direction,
    spyState?.scored?.direction,
    qqqState?.scored?.direction,
  ].filter(d => d && d !== 'CHOP');

  const bullish = directions.filter(d => d === 'BULLISH').length;
  const bearish = directions.filter(d => d === 'BEARISH').length;
  const total = directions.length;

  let direction = 'MIXED';
  let count = 0;

  if (bullish > bearish && bullish >= 2) {
    direction = 'BULLISH';
    count = bullish;
  } else if (bearish > bullish && bearish >= 2) {
    direction = 'BEARISH';
    count = bearish;
  } else if (bullish === 1 && bearish === 0) {
    direction = 'BULLISH';
    count = 1;
  } else if (bearish === 1 && bullish === 0) {
    direction = 'BEARISH';
    count = 1;
  }

  const details = [
    spxState ? `SPX ${spxState.scored.score} ${spxState.scored.direction}` : 'SPX N/A',
    spyState ? `SPY ${spyState.scored.score} ${spyState.scored.direction}` : 'SPY N/A',
    qqqState ? `QQQ ${qqqState.scored.score} ${qqqState.scored.direction}` : 'QQQ N/A',
  ].join(', ');

  return { direction, count, total, details };
}

/**
 * Detect stacked walls — 3+ consecutive same-sign strikes forming a barrier.
 */
function detectStackedWalls(state, ticker) {
  const { strikes, largestWall } = state;
  if (!strikes || strikes.length === 0 || !largestWall) return [];

  const minValue = largestWall.absGexValue * MULTI_TICKER.STACKED_MIN_VALUE;
  const results = [];

  let runSign = null;
  let runStart = null;
  let runCount = 0;
  let runTotal = 0;

  for (const { strike, gexValue } of strikes) {
    const sign = gexValue >= 0 ? 'positive' : 'negative';
    const isSignificant = Math.abs(gexValue) >= minValue;

    if (isSignificant && sign === runSign) {
      runCount++;
      runTotal += gexValue;
    } else if (isSignificant) {
      // New run started — flush previous
      if (runCount >= MULTI_TICKER.STACKED_MIN_STRIKES) {
        results.push(buildStackedResult(ticker, runSign, runStart, strike, runCount, runTotal, state.spotPrice));
      }
      runSign = sign;
      runStart = strike;
      runCount = 1;
      runTotal = gexValue;
    } else {
      // Not significant — break the run
      if (runCount >= MULTI_TICKER.STACKED_MIN_STRIKES) {
        results.push(buildStackedResult(ticker, runSign, runStart, strike, runCount, runTotal, state.spotPrice));
      }
      runSign = null;
      runStart = null;
      runCount = 0;
      runTotal = 0;
    }
  }

  // Flush final run
  if (runCount >= MULTI_TICKER.STACKED_MIN_STRIKES) {
    const lastStrike = strikes[strikes.length - 1].strike;
    results.push(buildStackedResult(ticker, runSign, runStart, lastStrike, runCount, runTotal, state.spotPrice));
  }

  return results;
}

function buildStackedResult(ticker, sign, startStrike, endStrike, count, totalGex, spotPrice) {
  const isAbove = startStrike > spotPrice;
  const type = sign === 'positive'
    ? (isAbove ? 'ceiling' : 'floor')
    : (isAbove ? 'magnet_above' : 'magnet_below');

  return {
    ticker,
    type,
    sign,
    startStrike,
    endStrike,
    count,
    totalGex,
    description: `${ticker}: ${count} stacked ${sign} nodes ${startStrike}-${endStrike} (${type})`,
  };
}

/**
 * Detect rug setups — negative wall near a positive wall.
 * "Rug": negative BELOW positive = support being pulled
 * "Reverse rug": positive BELOW negative = floor being established
 */
function detectRugSetups(state, ticker) {
  const { topWalls, spotPrice } = state;
  if (!topWalls || topWalls.length < 2) return [];

  const results = [];
  const strikeStep = STRIKE_STEPS[ticker] || 5;
  const maxGap = MULTI_TICKER.RUG_MAX_STRIKE_GAP * strikeStep;

  const posWalls = topWalls.filter(w => w.type === 'positive');
  const negWalls = topWalls.filter(w => w.type === 'negative');

  for (const pos of posWalls) {
    for (const neg of negWalls) {
      const gap = Math.abs(pos.strike - neg.strike);
      if (gap > maxGap) continue;

      if (neg.strike < pos.strike) {
        // Negative below positive = "rug" (support being pulled away)
        results.push({
          ticker,
          type: 'rug',
          description: `${ticker}: Neg at ${neg.strike} below pos at ${pos.strike} — rug setup (support being pulled)`,
          direction: 'BEARISH',
          posStrike: pos.strike,
          negStrike: neg.strike,
        });
      } else {
        // Positive below negative = "reverse rug" (floor being placed)
        results.push({
          ticker,
          type: 'reverse_rug',
          description: `${ticker}: Pos at ${pos.strike} below neg at ${neg.strike} — reverse rug (floor established)`,
          direction: 'BULLISH',
          posStrike: pos.strike,
          negStrike: neg.strike,
        });
      }
    }
  }

  return results;
}

/**
 * Detect node slides — walls that appeared or grew 100%+ between reads.
 */
function detectNodeSlides(state, ticker) {
  const { wallTrends } = state;
  if (!wallTrends || wallTrends.length === 0) return [];

  const results = [];

  for (const trend of wallTrends) {
    if (trend.type === 'NEW_WALL') {
      results.push({
        ticker,
        type: 'new_wall',
        strike: trend.wall.strike,
        old_value: 0,
        new_value: trend.wall.gexValue,
        description: `New ${trend.wall.type} wall appeared at ${trend.wall.strike}`,
        implication: trend.wall.type === 'positive'
          ? (trend.wall.relativeToSpot === 'above' ? 'BEARISH' : 'BULLISH')
          : (trend.wall.relativeToSpot === 'above' ? 'BULLISH' : 'BEARISH'),
      });
    } else if (trend.type === 'WALL_GROWTH' && trend.growthPct >= MULTI_TICKER.NODE_SLIDE_GROWTH_PCT) {
      results.push({
        ticker,
        type: 'node_slide',
        strike: trend.wall.strike,
        old_value: trend.prevValue,
        new_value: trend.wall.absGexValue,
        description: `Wall at ${trend.wall.strike} grew ${(trend.growthPct * 100).toFixed(0)}%`,
        implication: trend.wall.type === 'positive'
          ? (trend.wall.relativeToSpot === 'above' ? 'BEARISH' : 'BULLISH')
          : (trend.wall.relativeToSpot === 'above' ? 'BULLISH' : 'BEARISH'),
      });
    }
  }

  return results;
}

/**
 * Synthesize all signals into an overall multi-ticker verdict.
 */
function computeMultiSignal(driver, alignment, stackedWalls, rugSetups, nodeSlides) {
  // Count directional evidence
  let bullishEvidence = 0;
  let bearishEvidence = 0;

  // Alignment
  if (alignment.direction === 'BULLISH') bullishEvidence += alignment.count;
  if (alignment.direction === 'BEARISH') bearishEvidence += alignment.count;

  // Driver
  if (driver?.direction === 'BULLISH') bullishEvidence += 2;
  if (driver?.direction === 'BEARISH') bearishEvidence += 2;

  // Stacked walls
  for (const sw of stackedWalls) {
    if (sw.type === 'floor' || sw.type === 'magnet_above') bullishEvidence++;
    if (sw.type === 'ceiling' || sw.type === 'magnet_below') bearishEvidence++;
  }

  // Rug setups
  for (const rug of rugSetups) {
    if (rug.direction === 'BULLISH') bullishEvidence++;
    if (rug.direction === 'BEARISH') bearishEvidence++;
  }

  // Node slides
  for (const slide of nodeSlides) {
    if (slide.implication === 'BULLISH') bullishEvidence++;
    if (slide.implication === 'BEARISH') bearishEvidence++;
  }

  // Determine direction
  let direction = 'MIXED';
  if (bullishEvidence > bearishEvidence && bullishEvidence >= 3) direction = 'BULLISH';
  else if (bearishEvidence > bullishEvidence && bearishEvidence >= 3) direction = 'BEARISH';

  // Confidence level
  const total = bullishEvidence + bearishEvidence;
  const dominance = total > 0 ? Math.max(bullishEvidence, bearishEvidence) / total : 0;

  let confidence = 'LOW';
  if (alignment.count >= 3 && dominance >= 0.75) confidence = 'VERY_HIGH';
  else if (alignment.count >= 2 && dominance >= 0.65) confidence = 'HIGH';
  else if (alignment.count >= 2 || dominance >= 0.60) confidence = 'MEDIUM';

  // Build reason
  const parts = [];
  parts.push(`${alignment.count}/3 aligned ${alignment.direction}`);
  if (driver) parts.push(`Driver: ${driver.ticker} (${driver.reason})`);
  if (stackedWalls.length > 0) parts.push(`${stackedWalls.length} stacked zone(s)`);
  if (nodeSlides.length > 0) parts.push(`${nodeSlides.length} node slide(s)`);
  if (rugSetups.length > 0) parts.push(`${rugSetups.length} rug setup(s)`);

  return { direction, confidence, reason: parts.join(' | ') };
}

// ---- Gap 1: Gatekeeper Classification ----

/**
 * Classify each wall as GATEKEEPER, MAGNET, ANCHOR, or NOISE.
 */
function classifyWalls(state, ticker) {
  const { topWalls, largestWall, spotPrice } = state;
  if (!topWalls || topWalls.length === 0 || !largestWall) return [];

  const results = [];

  for (const wall of topWalls) {
    const sizePct = wall.absGexValue / largestWall.absGexValue;
    const distPct = Math.abs(wall.strike - spotPrice) / spotPrice * 100;
    const nearSpot = distPct <= GATEKEEPER.PROXIMITY_PCT;

    let classification;
    if (sizePct < GATEKEEPER.MIN_SIZE_PCT) {
      classification = 'NOISE';
    } else if (wall.type === 'negative') {
      classification = 'MAGNET'; // negative walls pull price toward them
    } else if (nearSpot) {
      classification = 'GATEKEEPER'; // large positive wall near spot = barrier
    } else {
      classification = 'ANCHOR'; // large positive wall far from spot = structural
    }

    results.push({
      ticker,
      strike: wall.strike,
      type: wall.type,
      classification,
      size_pct: parseFloat(sizePct.toFixed(3)),
      near_spot: nearSpot,
      distance_pct: parseFloat(distPct.toFixed(3)),
    });
  }

  return results;
}

// ---- Gap 4: Rolling Ceilings/Floors ----

/**
 * Detect rolling walls — walls that shifted strike but maintained similar size.
 */
function detectRollingWalls(state, ticker) {
  const { wallTrends, topWalls, spotPrice } = state;
  if (!wallTrends || wallTrends.length === 0 || !topWalls) return [];

  const results = [];

  // Find walls that disappeared (WALL_SHRINK by >70% or missing from current)
  const disappeared = wallTrends.filter(t =>
    t.type === 'WALL_SHRINK' && Math.abs(t.growthPct) >= 0.70
  );

  // Find new walls that appeared
  const appeared = wallTrends.filter(t => t.type === 'NEW_WALL');

  // Match disappeared walls with appeared walls of similar size
  for (const gone of disappeared) {
    const goneSize = gone.prevValue;
    if (goneSize < (state.largestWall?.absGexValue || 1) * ROLLING_WALL.MIN_SIZE_PCT) continue;

    for (const newWall of appeared) {
      const newSize = newWall.wall.absGexValue;
      const sizeRatio = Math.min(goneSize, newSize) / Math.max(goneSize, newSize);

      // Similar size (within 50%) and same sign
      if (sizeRatio < 0.50) continue;
      if (gone.wall.type !== newWall.wall.type) continue;

      const shift = newWall.wall.strike - gone.wall.strike;
      const strikeStep = STRIKE_STEPS[ticker] || 5;
      const shiftStrikes = Math.abs(shift) / strikeStep;

      if (shiftStrikes < ROLLING_WALL.MIN_SHIFT_STRIKES) continue;

      const shiftDirection = shift > 0 ? 'up' : 'down';
      const wallRole = gone.wall.relativeToSpot === 'above' ? 'ceiling' : 'floor';

      results.push({
        ticker,
        from_strike: gone.wall.strike,
        to_strike: newWall.wall.strike,
        shift: shiftStrikes,
        direction: shiftDirection,
        type: wallRole,
        size: newSize,
        description: `${ticker}: ${wallRole} rolled ${shiftDirection} ${gone.wall.strike} -> ${newWall.wall.strike}`,
      });
    }
  }

  return results;
}

// ---- Gap 5: Map Reshuffle Detection ----

/**
 * Detect dramatic changes in the GEX map (many walls appearing/disappearing at once).
 */
function detectReshuffle(state, ticker) {
  const { wallTrends } = state;
  if (!wallTrends || wallTrends.length === 0) return null;

  const newWalls = wallTrends.filter(t => t.type === 'NEW_WALL').length;
  // Count walls that shrank by 70%+ as "disappeared"
  const disappeared = wallTrends.filter(t =>
    t.type === 'WALL_SHRINK' && Math.abs(t.growthPct) >= 0.70
  ).length;
  const combined = newWalls + disappeared;

  const detected = (
    newWalls >= RESHUFFLE.MIN_NEW_WALLS ||
    disappeared >= RESHUFFLE.MIN_DISAPPEARED ||
    combined >= RESHUFFLE.COMBINED_MIN
  );

  if (!detected) return null;

  return {
    ticker,
    detected: true,
    new_count: newWalls,
    disappeared_count: disappeared,
    description: `${ticker}: Map reshuffle — ${newWalls} new walls, ${disappeared} disappeared`,
  };
}

// ---- Gap 9: Hedge Node Detection ----

/**
 * Detect hedge nodes — walls where allExp GEX >> 0DTE GEX.
 * These represent institutional multi-day hedges that persist across expirations.
 */
function detectHedgeNodes(state, ticker) {
  const { topWalls, aggregatedGex, allExpGex, largestWall } = state;
  if (!topWalls || !aggregatedGex || !allExpGex || !largestWall) return [];

  const minSize = largestWall.absGexValue * HEDGE_NODE.MIN_SIZE_PCT;
  const results = [];

  for (const wall of topWalls) {
    if (wall.absGexValue < minSize) continue;

    const gex0dte = Math.abs(aggregatedGex.get(wall.strike) || 0);
    const gexAllExp = Math.abs(allExpGex.get(wall.strike) || 0);

    if (gex0dte === 0) continue;

    const ratio = gexAllExp / gex0dte;
    if (ratio >= HEDGE_NODE.ALL_EXP_RATIO) {
      results.push({
        ticker,
        strike: wall.strike,
        gex_0dte: gex0dte,
        gex_all_exp: gexAllExp,
        ratio: parseFloat(ratio.toFixed(2)),
        type: wall.type,
      });
    }
  }

  return results;
}

/**
 * Compute enhanced score bonus based on alignment + driver.
 */
function computeEnhancedBonus(alignment, driver, spxDirection) {
  if (spxDirection === 'CHOP') return 0;

  // Alignment bonus (0/5/10/15)
  let bonus = MULTI_TICKER.ALIGNMENT_BONUS[alignment.count] || 0;

  // Only apply alignment bonus if alignment direction matches SPX
  if (alignment.direction !== spxDirection && alignment.direction !== 'MIXED') {
    bonus = 0;
  }

  // Driver bonus (+5 if driver agrees with SPX)
  if (driver && driver.direction === spxDirection) {
    bonus += MULTI_TICKER.DRIVER_BONUS;
  }

  return Math.min(20, bonus);
}
