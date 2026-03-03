/**
 * GEX Pattern Detection Engine
 *
 * Detects 7 directional GEX patterns from scored data, multi-ticker analysis,
 * and node touch tracking. Returns unified pattern objects for the agent and
 * dual-lane execution.
 *
 * Patterns:
 * 1. Rug Pull (BEARISH) — neg wall pulling through pos support
 * 2. Reverse Rug (BULLISH) — pos floor established below neg magnet
 * 3. King Node Bounce — fresh king node rejection (direction varies)
 * 4. Pika Pillow (BULLISH) — pos floor cushion in neg gamma
 * 5. Triple Ceiling/Floor — 3+ stacked same-sign walls
 * 6. Air Pocket — unobstructed path to negative magnet
 * 7. Range Edge Fade — gatekeeper rejection at range boundary
 */

import { characterizeAirPocket } from './gex-scorer.js';
import { getActiveConfig } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Patterns');

/**
 * Detect all patterns from current market state.
 * @param {object} scored - Output from scoreSpxGex()
 * @param {object} parsedData - Raw parsed GEX data (aggregatedGex, strikes, walls)
 * @param {object} multiAnalysis - Output from analyzeMultiTicker()
 * @param {object} nodeTouches - Output from getNodeTouches()
 * @returns {Array} Detected patterns sorted by confidence (HIGH first)
 */
export { allTickersShowSameSetup, detectNodePolarityFlips };

export function detectAllPatterns(scored, parsedData, multiAnalysis, nodeTouches, nodeTrends, currentDirection, nodeSignChanges, kingNodeFlip) {
  if (!scored || !parsedData || !multiAnalysis) return [];

  const cfg = getActiveConfig() || {};
  const ctx = { scored, parsedData, multiAnalysis, nodeTouches: nodeTouches || {}, cfg, nodeTrends: nodeTrends || new Map(), nodeSignChanges: nodeSignChanges || [], kingNodeFlip: kingNodeFlip || null };

  const patterns = [
    ...detectRugPull(ctx),
    ...detectReverseRug(ctx),
    ...detectKingNodeBounce(ctx),
    ...detectPikaPillow(ctx),
    ...detectTripleCeilingFloor(ctx),
    ...detectAirPocket(ctx),
    ...detectRangeEdgeFade(ctx),
    ...detectWallFlip(ctx),
  ];

  // Validate: target and stop must be on correct side of spot
  const spotPrice = scored.spotPrice;
  const valid = patterns.filter(p => {
    if (p.direction === 'BULLISH') {
      if (p.target_strike <= spotPrice) {
        log.warn(`Filtered ${p.pattern}: BULLISH target ${p.target_strike} <= spot ${spotPrice}`);
        return false;
      }
      if (p.stop_strike >= spotPrice) {
        log.warn(`Filtered ${p.pattern}: BULLISH stop ${p.stop_strike} >= spot ${spotPrice}`);
        return false;
      }
    }
    if (p.direction === 'BEARISH') {
      if (p.target_strike >= spotPrice) {
        log.warn(`Filtered ${p.pattern}: BEARISH target ${p.target_strike} >= spot ${spotPrice}`);
        return false;
      }
      if (p.stop_strike <= spotPrice) {
        log.warn(`Filtered ${p.pattern}: BEARISH stop ${p.stop_strike} <= spot ${spotPrice}`);
        return false;
      }
    }
    return true;
  });

  // Sort by confidence: HIGH > MEDIUM > LOW
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  valid.sort((a, b) => (order[a.confidence] || 2) - (order[b.confidence] || 2));

  // Deduplicate: if two patterns share the same direction + target strike, keep highest confidence
  const seen = new Set();
  const deduped = [];
  for (const p of valid) {
    const key = `${p.direction}:${p.target_strike}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  // Fix 1: Resolve directional conflicts (e.g. RUG_PULL bearish + REVERSE_RUG bullish)
  const bullishPatterns = deduped.filter(p => p.direction === 'BULLISH');
  const bearishPatterns = deduped.filter(p => p.direction === 'BEARISH');
  if (bullishPatterns.length > 0 && bearishPatterns.length > 0) {
    const favored = scored.direction; // GEX structural direction as tiebreaker
    for (const p of deduped) {
      if (p.direction !== favored && favored !== 'CHOP' && favored !== 'NEUTRAL') {
        p.confidence = adjustConfidence(p.confidence, 'downgrade');
        p.conflicting = true;
        p.reasoning += ` [CONFLICTING: GEX favors ${favored}]`;
      }
    }
    // Re-sort after adjustment
    deduped.sort((a, b) => (order[a.confidence] || 2) - (order[b.confidence] || 2));
  }

  // Fix 5: Multi-expiration wall strength — upgrade confidence if key wall has non-0DTE confirmation
  for (const p of deduped) {
    const keyStrike = getPatternKeyStrike(p);
    if (keyStrike && hasMultiExpConfirmation(keyStrike, parsedData.aggregatedGex, parsedData.allExpGex)) {
      p.confidence = adjustConfidence(p.confidence, 'upgrade');
      p.reasoning += ' [MULTI-EXP confirmed]';
    }
  }

  // Fix 6: Flag patterns opposing current position direction
  if (currentDirection) {
    for (const p of deduped) {
      if (p.direction !== currentDirection) {
        p.opposing_position = true;
      }
    }
  }

  if (deduped.length > 0) {
    log.debug(`Detected ${deduped.length} pattern(s): ${deduped.map(p => `${p.pattern}(${p.direction}${p.conflicting ? ' CONFLICT' : ''})`).join(', ')}`);
  }

  return deduped;
}

// ---- Trend-based confidence adjustment ----

function adjustConfidence(confidence, direction) {
  const tiers = ['LOW', 'MEDIUM', 'HIGH'];
  const idx = tiers.indexOf(confidence);
  if (idx === -1) return confidence;
  if (direction === 'upgrade' && idx < 2) return tiers[idx + 1];
  if (direction === 'downgrade' && idx > 0) return tiers[idx - 1];
  return confidence;
}

// ---- Cross-Ticker Confirmation ----

/**
 * Check if SPY/QQQ king nodes and rug setups confirm a direction.
 * Uses structural alignment (king node position relative to each ticker's spot)
 * rather than just scored.direction alignment.
 */
function getCrossTickerConfirmation(multiAnalysis, direction) {
  const kingNodes = multiAnalysis?.king_nodes || {};
  const rugs = multiAnalysis?.rug_setups || [];
  let confirmCount = 0;
  const confirmedTickers = new Set();
  const details = [];

  // Check SPY/QQQ king nodes — structural position relative to their own spot
  for (const ticker of ['SPY', 'QQQ']) {
    const kn = kingNodes[ticker];
    if (!kn || !kn.isNear) continue;

    const isSupport = kn.relativeToSpot === 'below' || kn.relativeToSpot === 'at';
    const isResistance = kn.relativeToSpot === 'above';

    if (direction === 'BULLISH' && isSupport) {
      confirmCount++;
      confirmedTickers.add(ticker);
      details.push(`${ticker} KN@${kn.strike} support`);
    } else if (direction === 'BEARISH' && isResistance) {
      confirmCount++;
      confirmedTickers.add(ticker);
      details.push(`${ticker} KN@${kn.strike} resistance`);
    }
  }

  // Check SPY/QQQ rug setups as additional confirmation (don't double-count)
  for (const rug of rugs) {
    if (rug.ticker === 'SPXW') continue;
    if (confirmedTickers.has(rug.ticker)) continue;

    if (rug.direction === direction) {
      confirmCount++;
      confirmedTickers.add(rug.ticker);
      details.push(`${rug.ticker} ${rug.type}`);
    }
  }

  return {
    confirmed: confirmCount >= 1,
    strong: confirmCount >= 2,
    count: confirmCount,
    details,
  };
}

// ---- Multi-Expiration Confirmation (Fix 5) ----

function hasMultiExpConfirmation(strike, aggregatedGex, allExpGex) {
  if (!allExpGex) return false;
  const odteValue = Math.abs(aggregatedGex.get(strike) || 0);
  const allValue = Math.abs(allExpGex.get(strike) || 0);
  if (odteValue < 1_000_000) return false; // Too small to matter
  return allValue / odteValue >= 1.5; // 50%+ extra from other expirations
}

function getPatternKeyStrike(pattern) {
  switch (pattern.pattern) {
    case 'RUG_PULL': return pattern.walls?.pos;
    case 'REVERSE_RUG': return pattern.walls?.pos;
    case 'KING_NODE_BOUNCE': return pattern.walls?.king;
    case 'PIKA_PILLOW': return pattern.walls?.floor;
    case 'AIR_POCKET': return pattern.walls?.target;
    case 'RANGE_EDGE_FADE': return pattern.walls?.gatekeeper;
    default: return null;
  }
}

// ---- Pattern 1: Rug Pull (BEARISH) ----

function detectRugPull(ctx) {
  const { scored, multiAnalysis, nodeTouches, cfg, nodeTrends } = ctx;
  const rugSetups = multiAnalysis.rug_setups || [];
  const results = [];

  for (const rug of rugSetups) {
    if (rug.type !== 'rug') continue;
    if (rug.ticker !== 'SPXW') continue; // Only trade SPX patterns

    const distPct = Math.abs(rug.posStrike - scored.spotPrice) / scored.spotPrice * 100;
    if (distPct > 1.5) continue; // Too far from spot

    // Confidence scoring
    let confidence = 'MEDIUM';
    const touches = nodeTouches[rug.posStrike]?.touches || 0;

    // Higher confidence if negative gamma amplifies the move
    if (scored.gexAtSpot < 0) confidence = 'HIGH';
    // Lower confidence if positive wall has been tested multiple times (weakened)
    if (touches >= 2) confidence = 'HIGH'; // Wall weakened = rug more likely
    // Lower if spot is far from the setup
    if (distPct > 0.75) confidence = 'LOW';

    // Trend adjustment: WEAKENING support = rug more likely, GROWING = less likely
    const posTrend = nodeTrends.get(rug.posStrike);
    if (posTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'upgrade');
    else if (posTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'downgrade');

    // Cross-ticker boost: SPY/QQQ confirming bearish
    const crossTicker = getCrossTickerConfirmation(multiAnalysis, 'BEARISH');
    if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

    // Target must be BELOW spot for bearish — use negStrike only if below, else nearest wall below
    const targetStrike = rug.negStrike < scored.spotPrice
      ? rug.negStrike
      : (scored.wallsBelow?.[0]?.strike || Math.round(scored.spotPrice / 5) * 5 - 15);

    results.push({
      pattern: 'RUG_PULL',
      direction: 'BEARISH',
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetStrike,
      stop_strike: rug.posStrike + (cfg.stop_buffer_pct || 0.05) / 100 * scored.spotPrice,
      reasoning: `Neg wall at ${rug.negStrike} below pos wall at ${rug.posStrike} — rug setup (${touches} touches on support)`,
      source_ticker: rug.ticker,
      walls: { pos: rug.posStrike, neg: rug.negStrike },
    });
  }

  return results;
}

// ---- Pattern 2: Reverse Rug (BULLISH) ----

function detectReverseRug(ctx) {
  const { scored, multiAnalysis, nodeTouches, cfg, nodeTrends } = ctx;
  const rugSetups = multiAnalysis.rug_setups || [];
  const results = [];

  for (const rug of rugSetups) {
    if (rug.type !== 'reverse_rug') continue;
    if (rug.ticker !== 'SPXW') continue;

    const distPct = Math.abs(rug.posStrike - scored.spotPrice) / scored.spotPrice * 100;
    if (distPct > 1.5) continue;

    let confidence = 'MEDIUM';
    const touches = nodeTouches[rug.posStrike]?.touches || 0;

    if (scored.gexAtSpot < 0) confidence = 'HIGH';
    if (touches >= 2) confidence = 'HIGH';
    if (distPct > 0.75) confidence = 'LOW';

    // Trend adjustment: GROWING floor = stronger setup, WEAKENING = floor dissolving
    const posTrend = nodeTrends.get(rug.posStrike);
    if (posTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
    else if (posTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');

    // Rapid growth boost: floor doubled in 30 cycles = very strong structural support
    if (posTrend?.changePct30 >= 1.0) confidence = adjustConfidence(confidence, 'upgrade');

    // Cross-ticker boost: SPY/QQQ confirming bullish
    const crossTicker = getCrossTickerConfirmation(multiAnalysis, 'BULLISH');
    if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

    // Target must be ABOVE spot for bullish — use negStrike only if above, else nearest wall above
    const targetStrike = rug.negStrike > scored.spotPrice
      ? rug.negStrike
      : (scored.wallsAbove?.[0]?.strike || Math.round(scored.spotPrice / 5) * 5 + 15);

    results.push({
      pattern: 'REVERSE_RUG',
      direction: 'BULLISH',
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetStrike,
      stop_strike: rug.posStrike - (cfg.stop_buffer_pct || 0.05) / 100 * scored.spotPrice,
      reasoning: `Pos floor at ${rug.posStrike} below neg magnet at ${rug.negStrike} — reverse rug (floor established, ${touches} touches)`,
      source_ticker: rug.ticker,
      walls: { pos: rug.posStrike, neg: rug.negStrike },
    });
  }

  return results;
}

// ---- Pattern 3: King Node Bounce ----

function detectKingNodeBounce(ctx) {
  const { scored, multiAnalysis, nodeTouches, cfg, nodeTrends, kingNodeFlip } = ctx;
  const kingNodes = multiAnalysis.king_nodes || {};
  const results = [];
  const maxTouches = cfg.pattern_king_node_max_touches ?? 1;

  const kn = kingNodes.SPXW;
  if (!kn) return results;

  const knDistPts = Math.abs(kn.strike - scored.spotPrice);

  if (kn.type === 'negative') {
    // --- NEGATIVE MAGNET BOUNCE ---
    // When price arrives at a negative magnet, the pull is satisfied → reversal zone
    const maxMagnetDist = cfg.negative_king_node_max_dist_pts ?? 5;
    if (knDistPts > maxMagnetDist) return results;

    const touches = nodeTouches[kn.strike]?.touches || 0;
    if (touches > maxTouches) return results;

    // Start at MEDIUM — magnets are less reliable bounce zones than positive walls
    let confidence = 'MEDIUM';
    if (kn.absGexValue < (scored.wallsAbove[0]?.absGexValue || 1) * 0.30) {
      confidence = 'LOW';
    }

    const knTrend = nodeTrends.get(kn.strike);
    if (knTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
    else if (knTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');
    if (knTrend?.changePct30 >= 1.0) confidence = adjustConfidence(confidence, 'upgrade');

    // Negative magnet below → price was pulled down, now reverses UP (BULLISH)
    // Negative magnet above → price was pulled up, now reverses DOWN (BEARISH)
    const direction = kn.relativeToSpot === 'above' ? 'BEARISH' : 'BULLISH';

    // Cross-ticker boost: SPY/QQQ king nodes confirming same direction
    const crossTicker = getCrossTickerConfirmation(multiAnalysis, direction);
    if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

    const targetWall = direction === 'BEARISH'
      ? scored.wallsBelow?.[0]
      : scored.wallsAbove?.[0];

    results.push({
      pattern: 'KING_NODE_BOUNCE',
      direction,
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetWall?.strike || (direction === 'BEARISH' ? scored.spotPrice - 15 : scored.spotPrice + 15),
      stop_strike: direction === 'BEARISH' ? kn.strike + 5 : kn.strike - 5,
      reasoning: `Magnet arrival at ${kn.strike} (negative ${(kn.absGexValue / 1e6).toFixed(0)}M, ${knDistPts.toFixed(0)}pts, ${touches} touches${crossTicker.count > 0 ? ', ' + crossTicker.details.join('+') : ''}) — expect ${direction.toLowerCase()} reversal`,
      source_ticker: 'SPXW',
      walls: { king: kn.strike, king_value: kn.gexValue },
    });
    return results;
  }

  // --- POSITIVE KING NODE BOUNCE (existing logic) ---
  if (knDistPts > 10) return results;

  const touches = nodeTouches[kn.strike]?.touches || 0;
  if (touches > maxTouches) return results;

  let confidence = touches === 0 ? 'HIGH' : 'MEDIUM';
  if (kn.absGexValue < (scored.wallsAbove[0]?.absGexValue || 1) * 0.30) {
    confidence = 'LOW';
  }

  const knTrend = nodeTrends.get(kn.strike);
  if (knTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
  else if (knTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');
  if (knTrend?.changePct30 >= 1.0) confidence = adjustConfidence(confidence, 'upgrade');

  if (kingNodeFlip?.strike === kn.strike && kingNodeFlip.fromType === 'negative' && kingNodeFlip.toType === 'positive') {
    confidence = adjustConfidence(confidence, 'upgrade');
  }

  const direction = kn.relativeToSpot === 'above' ? 'BEARISH' : 'BULLISH';

  // Cross-ticker boost: SPY/QQQ king nodes confirming same direction
  const crossTicker = getCrossTickerConfirmation(multiAnalysis, direction);
  if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

  const targetWall = direction === 'BEARISH'
    ? scored.wallsBelow?.[0]
    : scored.wallsAbove?.[0];

  results.push({
    pattern: 'KING_NODE_BOUNCE',
    direction,
    confidence,
    entry_strike: Math.round(scored.spotPrice / 5) * 5,
    target_strike: targetWall?.strike || (direction === 'BEARISH' ? scored.spotPrice - 15 : scored.spotPrice + 15),
    stop_strike: direction === 'BEARISH' ? kn.strike + 5 : kn.strike - 5,
    reasoning: `King node at ${kn.strike} (${kn.type}, ${kn.distancePct.toFixed(2)}% away, ${touches} touches${crossTicker.count > 0 ? ', ' + crossTicker.details.join('+') : ''}) — expect ${direction.toLowerCase()} bounce`,
    source_ticker: 'SPXW',
    walls: { king: kn.strike, king_value: kn.gexValue },
  });

  return results;
}

// ---- Pattern 4: Pika Pillow (BULLISH) ----

function detectPikaPillow(ctx) {
  const { scored, multiAnalysis, cfg, nodeTrends } = ctx;
  const results = [];

  // Requires: positive floor below spot
  if (!scored.floorWall) return results;
  if (scored.floorWall.type !== 'positive') return results;

  const maxDistPct = cfg.pattern_pika_max_dist_pct ?? 0.20;
  const distPct = Math.abs(scored.spotPrice - scored.floorWall.strike) / scored.spotPrice * 100;
  const distPts = Math.abs(scored.spotPrice - scored.floorWall.strike);
  // Allow if within percentage OR within 15pts absolute (whichever is more permissive)
  if (distPct > maxDistPct && distPts > 15) return results;

  // Target: nearest negative wall above (magnet pulling up)
  const negAbove = scored.wallsAbove?.find(w => w.type === 'negative');
  if (!negAbove) return results; // No upside magnet

  let confidence = 'MEDIUM';
  if (distPts <= 5 && scored.score >= 70) confidence = 'HIGH';
  if (distPts > 10) confidence = 'LOW';
  // Positive gamma at spot = less amplification → downgrade one tier
  if (scored.gexAtSpot >= 0 && confidence === 'HIGH') confidence = 'MEDIUM';
  else if (scored.gexAtSpot >= 0 && confidence === 'MEDIUM') confidence = 'LOW';

  // Trend adjustment: GROWING pillow = strengthening, WEAKENING = dissolving
  const floorTrend = nodeTrends.get(scored.floorWall.strike);
  if (floorTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
  else if (floorTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');

  // Rapid growth boost: pillow doubled in 30 cycles = very strong cushion
  if (floorTrend?.changePct30 >= 1.0) confidence = adjustConfidence(confidence, 'upgrade');

  // Cross-ticker boost: SPY/QQQ confirming bullish support
  const crossTicker = getCrossTickerConfirmation(multiAnalysis, 'BULLISH');
  if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

  const env = scored.gexAtSpot < 0 ? 'neg gamma' : 'pos gamma (reduced)';

  results.push({
    pattern: 'PIKA_PILLOW',
    direction: 'BULLISH',
    confidence,
    entry_strike: Math.round(scored.spotPrice / 5) * 5,
    target_strike: negAbove.strike,
    stop_strike: scored.floorWall.strike - (cfg.stop_buffer_pct || 0.05) / 100 * scored.spotPrice,
    reasoning: `Pos floor at ${scored.floorWall.strike} (${distPts.toFixed(0)}pts below) in ${env} — pika pillow, target ${negAbove.strike}`,
    source_ticker: 'SPXW',
    walls: { floor: scored.floorWall.strike, target: negAbove.strike },
  });

  return results;
}

// ---- Pattern 5: Triple Ceiling / Triple Floor ----

function detectTripleCeilingFloor(ctx) {
  const { scored, multiAnalysis, cfg } = ctx;
  const stackedWalls = multiAnalysis.stacked_walls || [];
  const results = [];
  const minWalls = cfg.pattern_triple_min_walls ?? 3;

  for (const stack of stackedWalls) {
    if (stack.ticker !== 'SPXW') continue;
    if (stack.count < minWalls) continue;

    // Only care about stacked walls near spot
    const midStrike = (stack.startStrike + stack.endStrike) / 2;
    const distPct = Math.abs(midStrike - scored.spotPrice) / scored.spotPrice * 100;
    if (distPct > 1.0) continue; // Too far

    let direction, confidence, targetWall, stopStrike;

    if (stack.type === 'ceiling' || stack.type === 'magnet_above') {
      // Stacked above → BEARISH (trapped below)
      if (stack.sign === 'positive') {
        direction = 'BEARISH';
        targetWall = scored.wallsBelow?.[0];
        stopStrike = stack.endStrike + 5;
      } else {
        // Negative stacked above → magnet pulling up = BULLISH
        direction = 'BULLISH';
        targetWall = { strike: stack.startStrike }; // Target is the stacked zone
        stopStrike = scored.wallsBelow?.[0]?.strike || scored.spotPrice - 15;
      }
    } else if (stack.type === 'floor' || stack.type === 'magnet_below') {
      if (stack.sign === 'positive') {
        direction = 'BULLISH';
        targetWall = scored.wallsAbove?.[0];
        stopStrike = stack.startStrike - 5;
      } else {
        direction = 'BEARISH';
        targetWall = { strike: stack.endStrike };
        stopStrike = scored.wallsAbove?.[0]?.strike || scored.spotPrice + 15;
      }
    } else {
      continue;
    }

    confidence = stack.count >= 4 ? 'HIGH' : 'MEDIUM';
    if (distPct > 0.5) confidence = confidence === 'HIGH' ? 'MEDIUM' : 'LOW';

    // Cross-ticker boost: SPY/QQQ confirming same direction
    const crossTicker = getCrossTickerConfirmation(multiAnalysis, direction);
    if (crossTicker.count >= 1) confidence = adjustConfidence(confidence, 'upgrade');

    results.push({
      pattern: stack.type === 'ceiling' || stack.type === 'magnet_above' ? 'TRIPLE_CEILING' : 'TRIPLE_FLOOR',
      direction,
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetWall?.strike || (direction === 'BEARISH' ? scored.spotPrice - 15 : scored.spotPrice + 15),
      stop_strike: stopStrike,
      reasoning: `${stack.count} stacked ${stack.sign} walls ${stack.startStrike}-${stack.endStrike} (${stack.type}) — ${direction.toLowerCase()} pressure`,
      source_ticker: stack.ticker,
      walls: { start: stack.startStrike, end: stack.endStrike, count: stack.count },
    });
  }

  return results;
}

// ---- Pattern 6: Air Pocket ----

function detectAirPocket(ctx) {
  const { scored, parsedData, cfg, nodeTrends } = ctx;
  const results = [];

  if (!scored.targetWall) return results;

  // Positive gamma or positive target wall → downgrade confidence, don't hard skip
  let positiveGammaDowngrade = scored.gexAtSpot >= 0;
  let positiveTargetDowngrade = scored.targetWall.type !== 'negative';

  const direction = scored.direction === 'BULLISH' ? 'above' : 'below';
  const airPocket = characterizeAirPocket(
    scored.spotPrice,
    scored.targetWall.strike,
    direction,
    parsedData.aggregatedGex,
    parsedData.strikes,
    scored.targetWall.absGexValue,
  );

  const minQuality = cfg.pattern_air_pocket_min_quality || 'MEDIUM';
  const qualityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, BLOCKED: 3 };
  if ((qualityOrder[airPocket.quality] || 3) > (qualityOrder[minQuality] || 0)) return results;

  let confidence = airPocket.quality === 'HIGH' ? 'HIGH' : 'MEDIUM';
  if (scored.score < 60) confidence = 'LOW';
  // Downgrade confidence for positive gamma or positive target (resistance, not magnet)
  if (positiveGammaDowngrade || positiveTargetDowngrade) {
    if (confidence === 'HIGH') confidence = 'MEDIUM';
    else if (confidence === 'MEDIUM') confidence = 'LOW';
  }

  // Trend adjustment: GROWING magnet = stronger pull, WEAKENING = fading
  const targetTrend = nodeTrends.get(scored.targetWall.strike);
  if (targetTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
  else if (targetTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');

  const tradeDirection = scored.direction;
  if (tradeDirection !== 'BULLISH' && tradeDirection !== 'BEARISH') return results;

  const stopWall = scored.floorWall;

  results.push({
    pattern: 'AIR_POCKET',
    direction: tradeDirection,
    confidence,
    entry_strike: Math.round(scored.spotPrice / 5) * 5,
    target_strike: scored.targetWall.strike,
    stop_strike: stopWall?.strike || (tradeDirection === 'BULLISH' ? scored.spotPrice - 10 : scored.spotPrice + 10),
    reasoning: `${airPocket.quality} air pocket to ${scored.targetWall.strike} (${airPocket.empty_strikes}/${airPocket.total_strikes} empty) — fast ${tradeDirection.toLowerCase()} move expected`,
    source_ticker: 'SPXW',
    walls: { target: scored.targetWall.strike, quality: airPocket.quality, empty: airPocket.empty_strikes },
  });

  return results;
}

// ---- Pattern 7: Range Edge Fade ----

function detectRangeEdgeFade(ctx) {
  const { scored, multiAnalysis, nodeTouches, cfg, nodeTrends } = ctx;
  const classifications = multiAnalysis.wall_classifications || [];
  const results = [];
  const maxTouches = cfg.pattern_range_fade_max_touches ?? 1;

  // Find GATEKEEPER walls near spot on SPXW
  const gatekeepers = classifications.filter(
    w => w.ticker === 'SPXW' && w.classification === 'GATEKEEPER' && w.near_spot,
  );

  for (const gk of gatekeepers) {
    // Only fade positive gatekeepers (barriers that reject price)
    if (gk.type !== 'positive') continue;

    const touches = nodeTouches[gk.strike]?.touches || 0;
    if (touches > maxTouches) continue; // Too many touches, might break

    const distPct = gk.distance_pct;
    if (distPct > 0.20) continue; // Not close enough for fade

    // Fade direction: gatekeeper above → BEARISH, below → BULLISH
    const direction = scored.spotPrice < gk.strike ? 'BEARISH' : 'BULLISH';

    // Target: opposite side of range
    const targetWall = direction === 'BEARISH'
      ? scored.wallsBelow?.[0]
      : scored.wallsAbove?.[0];

    let confidence = touches === 0 ? 'MEDIUM' : 'LOW';
    if (gk.size_pct > 0.50 && touches === 0) confidence = 'HIGH'; // Very large fresh gatekeeper

    // Trend adjustment: GROWING gatekeeper = stronger rejection, WEAKENING = failing
    const gkTrend = nodeTrends.get(gk.strike);
    if (gkTrend?.trend === 'GROWING') confidence = adjustConfidence(confidence, 'upgrade');
    else if (gkTrend?.trend === 'WEAKENING') confidence = adjustConfidence(confidence, 'downgrade');

    results.push({
      pattern: 'RANGE_EDGE_FADE',
      direction,
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetWall?.strike || (direction === 'BEARISH' ? scored.spotPrice - 10 : scored.spotPrice + 10),
      stop_strike: direction === 'BEARISH' ? gk.strike + 5 : gk.strike - 5,
      reasoning: `Gatekeeper at ${gk.strike} (${(gk.size_pct * 100).toFixed(0)}% of largest, ${touches} touches, ${distPct.toFixed(2)}% away) — fade ${direction.toLowerCase()}`,
      source_ticker: 'SPXW',
      walls: { gatekeeper: gk.strike, size_pct: gk.size_pct },
    });
  }

  return results;
}

// ---- Pattern 8: Wall Flip (sign change at a wall) ----

function detectWallFlip(ctx) {
  const { scored, cfg, nodeSignChanges } = ctx;
  const results = [];
  if (!nodeSignChanges || nodeSignChanges.length === 0) return results;

  const minMagnitude = cfg.wall_flip_min_magnitude ?? 5_000_000;

  for (const change of nodeSignChanges) {
    if (change.magnitude < minMagnitude) continue;
    if (change.from === 'absent') continue; // That's emergence, not a flip

    const distPts = Math.abs(change.strike - scored.spotPrice);
    if (distPts > 20) continue; // Too far from spot to matter

    let direction = null;
    let confidence;
    let reasoning;

    if (change.from === 'negative' && change.to === 'positive') {
      // Former magnet/resistance became support → BULLISH (only if below spot)
      if (change.strike <= scored.spotPrice) {
        direction = 'BULLISH';
        confidence = distPts <= 10 ? 'HIGH' : 'MEDIUM';
        reasoning = `Wall at ${change.strike} flipped neg→pos (now ${(change.magnitude / 1e6).toFixed(0)}M support) — former resistance became support`;
      }
    } else if (change.from === 'positive' && change.to === 'negative') {
      if (change.strike <= scored.spotPrice) {
        // Former support became downside magnet → BEARISH
        direction = 'BEARISH';
        confidence = distPts <= 10 ? 'HIGH' : 'MEDIUM';
        reasoning = `Wall at ${change.strike} flipped pos→neg (now ${(change.magnitude / 1e6).toFixed(0)}M magnet) — former support dissolved`;
      } else {
        // Wall above spot flipped pos→neg → magnet pulling up = BULLISH
        direction = 'BULLISH';
        confidence = 'MEDIUM';
        reasoning = `Wall at ${change.strike} flipped pos→neg above spot (now magnet pulling up)`;
      }
    }

    if (!direction) continue;

    const targetWall = direction === 'BULLISH' ? scored.wallsAbove?.[0] : scored.wallsBelow?.[0];
    const stopStrike = direction === 'BULLISH'
      ? change.strike - 5
      : change.strike + 5;

    results.push({
      pattern: 'WALL_FLIP',
      direction,
      confidence,
      entry_strike: Math.round(scored.spotPrice / 5) * 5,
      target_strike: targetWall?.strike || (direction === 'BULLISH' ? scored.spotPrice + 15 : scored.spotPrice - 15),
      stop_strike: stopStrike,
      reasoning,
      source_ticker: 'SPXW',
      walls: { flipped_strike: change.strike, from: change.from, to: change.to, magnitude: change.magnitude },
    });
  }

  return results;
}

// ---- Cross-Ticker Helpers ----

/**
 * Check if all tickers show the same directional setup.
 * Uses multi-ticker alignment to confirm cross-ticker agreement.
 * @param {object} multiAnalysis - Output from analyzeMultiTicker()
 * @param {string} direction - 'BULLISH' or 'BEARISH'
 * @returns {{ confirmed: boolean, count: number, tickers: string[] }}
 */
function allTickersShowSameSetup(multiAnalysis, direction) {
  if (!multiAnalysis) return { confirmed: false, count: 0, tickers: [] };

  const alignment = multiAnalysis.alignment || {};
  const tickers = [];

  if (alignment.details) {
    for (const [ticker, dir] of Object.entries(alignment.details)) {
      if (dir === direction) tickers.push(ticker);
    }
  }

  // Also check rug setups for bearish confirmation across tickers
  if (direction === 'BEARISH' && multiAnalysis.rug_setups) {
    for (const rug of multiAnalysis.rug_setups) {
      if (rug.ticker && !tickers.includes(rug.ticker)) {
        tickers.push(rug.ticker);
      }
    }
  }

  return {
    confirmed: (alignment.count || 0) >= 3 && alignment.direction === direction,
    count: alignment.count || 0,
    tickers,
  };
}

/**
 * Detect node polarity flips — walls whose classification conflicts with their GEX sign.
 * Indicates structural shift (e.g., a wall classified as SUPPORT but with negative GEX).
 * @param {object} scored - Current scored GEX state
 * @param {object} multiAnalysis - Multi-ticker analysis (includes wall_classifications)
 * @returns {Array} Flipped nodes with { strike, from, to, ticker, classification }
 */
function detectNodePolarityFlips(scored, multiAnalysis) {
  const flips = [];
  if (!multiAnalysis?.wall_classifications) return flips;

  for (const wall of multiAnalysis.wall_classifications) {
    const isPositiveClass = ['SUPPORT', 'GATEKEEPER', 'BARRIER'].includes(wall.classification);
    const isNegativeGex = wall.gexValue < 0;

    if (isPositiveClass && isNegativeGex) {
      flips.push({ strike: wall.strike, from: 'POSITIVE', to: 'NEGATIVE', ticker: wall.ticker, classification: wall.classification });
    }

    const isNegativeClass = ['MAGNET', 'VACUUM'].includes(wall.classification);
    const isPositiveGex = wall.gexValue > 0;

    if (isNegativeClass && isPositiveGex) {
      flips.push({ strike: wall.strike, from: 'NEGATIVE', to: 'POSITIVE', ticker: wall.ticker, classification: wall.classification });
    }
  }

  if (flips.length > 0) {
    log.debug(`Node polarity flips: ${flips.map(f => `${f.ticker}:${f.strike} ${f.from}→${f.to}`).join(', ')}`);
  }

  return flips;
}
