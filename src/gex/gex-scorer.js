/**
 * GEX Scoring Engine for SPX
 *
 * Scores the SPX environment 0-100 for bullish/bearish/chop.
 *
 * BULLISH SETUP (calls):
 *   +30 = negative GEX at spot price (volatile environment)
 *   +25 = large negative wall ABOVE spot (magnet pulling price up)
 *         OR unobstructed upside (neg gamma + no significant pos walls above)
 *   +25 = positive GEX floor BELOW spot (protection/support)
 *   +20 = open air between spot and target / no resistance above
 *   -20 = if positive GEX wall above is larger than negative wall (cap)
 *
 * BEARISH SETUP (puts):
 *   +30 = negative GEX at spot price
 *   +25 = large negative wall BELOW spot (magnet pulling price down)
 *         OR unobstructed downside (neg gamma + no significant pos walls below)
 *   +25 = negative GEX ceiling ABOVE spot (resistance confirmed)
 *   +20 = wall growing between reads / open air below
 *   -20 = if large positive GEX floor exists below target
 *
 * CHOP/PIN:
 *   Spot between two walls of similar size
 *   All surrounding GEX is positive
 *   No significant walls
 */

import { SCORE, CONFIDENCE, MIDPOINT, AIR_POCKET, NEUTRAL_THRESHOLD, MOMENTUM } from './constants.js';
import { getGexAtSpot, formatDollar } from './gex-parser.js';
import { getSpotMomentum, pushGexAtSpot, getSmoothedGexAtSpot, smoothGexScore, recordDirection } from '../store/state.js';

/**
 * Score the SPX GEX environment.
 * Returns: { score, direction, confidence, breakdown, walls, environment }
 */
export function scoreSpxGex(parsedData, wallTrends = null, trinityBonus = 0, ticker = 'SPXW') {
  const { spotPrice, aggregatedGex, strikes, walls } = parsedData;

  const gexAtSpot = getGexAtSpot(aggregatedGex, strikes, spotPrice);

  // Smooth gexAtSpot with rolling median to prevent oscillation at gamma boundaries
  pushGexAtSpot(ticker, gexAtSpot);
  const smoothedGexAtSpot = getSmoothedGexAtSpot(ticker);

  // Find the largest wall — used to filter out insignificant walls
  const largestWallAbs = walls.length > 0 ? walls[0].absGexValue : 0;

  // Separate walls by position
  const wallsAbove = walls.filter(w => w.relativeToSpot === 'above');
  const wallsBelow = walls.filter(w => w.relativeToSpot === 'below');

  // Check momentum BEFORE scoring — used to gate negative GEX at spot
  const momentum = getSpotMomentum(ticker);

  // Score both directions — use smoothed gexAtSpot for sign determination
  const bullish = scoreBullish(smoothedGexAtSpot, wallsAbove, wallsBelow, spotPrice, parsedData, largestWallAbs, momentum, gexAtSpot, wallTrends);
  const bearish = scoreBearish(smoothedGexAtSpot, wallsAbove, wallsBelow, spotPrice, parsedData, wallTrends, largestWallAbs, momentum, gexAtSpot);

  // Apply momentum — direction-conflict penalty with CHOP override
  if (momentum.strength !== 'WEAK') {
    const bonus = momentum.strength === 'STRONG' ? MOMENTUM.STRONG_BONUS : MOMENTUM.MODERATE_BONUS;
    const penalty = MOMENTUM.CONTRARY_PENALTY;

    if (momentum.direction === 'DOWN') {
      bearish.score = Math.min(100, Math.max(0, bearish.score + bonus));
      bearish.breakdown.push(`+${bonus}: ${momentum.strength} bearish momentum (${momentum.points}pts over ${momentum.readings} reads)`);
      bullish.score = Math.max(0, bullish.score + penalty);
      bullish.breakdown.push(`${penalty}: Fighting bearish momentum (${momentum.points}pts)`);
    } else if (momentum.direction === 'UP') {
      bullish.score = Math.min(100, Math.max(0, bullish.score + bonus));
      bullish.breakdown.push(`+${bonus}: ${momentum.strength} bullish momentum (+${momentum.points}pts over ${momentum.readings} reads)`);
      bearish.score = Math.max(0, bearish.score + penalty);
      bearish.breakdown.push(`${penalty}: Fighting bullish momentum (+${momentum.points}pts)`);
    }
  }

  // Momentum conflict override — if score direction fights strong price trend, degrade to CHOP
  // This catches the scenario where walls say BULLISH but price is falling through them
  if (momentum.strength === 'STRONG') {
    if (bullish.score > bearish.score && momentum.direction === 'DOWN') {
      const conflictPenalty = Math.min(30, Math.round(Math.abs(momentum.points) * 2));
      bullish.score = Math.max(25, bullish.score - conflictPenalty);
      bullish.breakdown.push(`-${conflictPenalty}: MOMENTUM CONFLICT — walls say BULLISH but price falling ${momentum.points}pts`);
    } else if (bearish.score > bullish.score && momentum.direction === 'UP') {
      const conflictPenalty = Math.min(30, Math.round(momentum.points * 2));
      bearish.score = Math.max(25, bearish.score - conflictPenalty);
      bearish.breakdown.push(`-${conflictPenalty}: MOMENTUM CONFLICT — walls say BEARISH but price rising +${momentum.points}pts`);
    }
  }

  // Check for chop
  const chop = checkChop(gexAtSpot, wallsAbove, wallsBelow, aggregatedGex, strikes);

  // Determine best direction
  let result;
  if (chop.isChop) {
    result = {
      score: Math.max(bullish.score, bearish.score),
      direction: 'CHOP',
      breakdown: chop.reasons,
      targetWall: null,
      floorWall: null,
      distanceToTarget: 'N/A',
    };
  } else if (bullish.score >= bearish.score) {
    result = bullish;
  } else {
    result = bearish;
  }

  // Low scores → NEUTRAL (not enough evidence for a directional call)
  if (result.direction !== 'CHOP' && result.score < NEUTRAL_THRESHOLD) {
    result.breakdown.push(`Score ${result.score} < ${NEUTRAL_THRESHOLD} threshold → NEUTRAL`);
    result.direction = 'NEUTRAL';
  }

  // Apply Trinity cross-market confirmation bonus (only for directional setups)
  if (trinityBonus > 0 && result.direction !== 'CHOP' && result.direction !== 'NEUTRAL') {
    result.score = Math.min(100, result.score + trinityBonus);
    result.breakdown.push(`+${trinityBonus}: Trinity confirmation (cross-market alignment)`);
  }

  // EMA score smoothing — prevents whipsaw on small spot moves
  const rawScore = result.score;
  result.score = smoothGexScore(ticker, result.score);
  if (result.score !== rawScore) {
    result.breakdown.push(`EMA smoothed: ${rawScore} → ${result.score} (α=${0.3})`);
  }

  // Track direction for stability detection
  recordDirection(ticker, result.direction);

  // Confidence tier (based on smoothed score)
  let confidence;
  if (result.score >= CONFIDENCE.HIGH) confidence = 'HIGH';
  else if (result.score >= CONFIDENCE.MEDIUM) confidence = 'MEDIUM';
  else confidence = 'LOW';

  // Overall environment label — use smoothed value to prevent oscillation
  const environment = smoothedGexAtSpot < 0 ? 'NEGATIVE GAMMA' : 'POSITIVE GAMMA';
  const envDetail = smoothedGexAtSpot < 0
    ? 'Volatile — dealers short gamma, moves amplified'
    : 'Pinned — dealers long gamma, moves dampened';

  return {
    spotPrice,
    gexAtSpot,
    smoothedGexAtSpot,
    rawScore,
    score: result.score,
    direction: result.direction,
    confidence,
    breakdown: result.breakdown,
    targetWall: result.targetWall,
    floorWall: result.floorWall,
    distanceToTarget: result.distanceToTarget,
    wallsAbove: wallsAbove.slice(0, 5),
    wallsBelow: wallsBelow.slice(0, 5),
    environment,
    envDetail,
    momentum: {
      direction: momentum.direction,
      points: momentum.points,
      strength: momentum.strength,
      readings: momentum.readings,
    },
    recommendation: getRecommendation(result.direction, confidence, environment),
  };
}

function scoreBullish(gexAtSpot, wallsAbove, wallsBelow, spotPrice, data, largestWallAbs, momentum, rawGexAtSpot, wallTrends) {
  let score = 0;
  const breakdown = [];
  const minSignificant = largestWallAbs * 0.10;

  // +30: Negative GEX at spot — volatile, dealers amplify moves
  // Uses smoothed gexAtSpot (passed as gexAtSpot) to prevent oscillation
  // Only award if momentum is NOT bearish (neg gamma helps the trend, not both sides)
  if (gexAtSpot < 0) {
    if (momentum.direction !== 'DOWN' || momentum.strength === 'WEAK') {
      score += SCORE.NEGATIVE_GEX_AT_SPOT;
      breakdown.push(`+30: Negative GEX at spot (${formatDollar(rawGexAtSpot)}, smoothed: ${formatDollar(gexAtSpot)})`);
    } else {
      breakdown.push(`+0: Negative GEX at spot but momentum is bearish (${momentum.points}pts) — amplifies downside, not upside`);
    }
  }

  // +25: Target / Expansion signal
  const negWallsAbove = wallsAbove.filter(w => w.type === 'negative');
  const significantNegAbove = negWallsAbove.filter(w => w.absGexValue >= minSignificant);
  const targetWall = significantNegAbove[0] || null;

  const posWallsAbove = wallsAbove.filter(w => w.type === 'positive');
  const significantPosAbove = posWallsAbove.filter(w => w.absGexValue >= minSignificant);

  let hasUnobstructedUpside = false;

  if (targetWall) {
    score += SCORE.LARGE_WALL_TARGET;
    breakdown.push(`+25: Neg wall above at ${targetWall.strike} (${formatDollar(targetWall.gexValue)}) — upside magnet`);
  } else if (gexAtSpot < 0 && significantPosAbove.length === 0) {
    score += SCORE.UNOBSTRUCTED_EXPANSION;
    hasUnobstructedUpside = true;
    breakdown.push(`+25: Unobstructed upside — neg gamma, no significant pos walls above`);
  } else if (negWallsAbove.length > 0) {
    breakdown.push(`+0: Neg wall above at ${negWallsAbove[0].strike} (${formatDollar(negWallsAbove[0].gexValue)}) too small vs dominant walls`);
  }

  // +25: Positive GEX floor BELOW spot (protection/support)
  const posWallsBelow = wallsBelow.filter(w => w.type === 'positive' && w.absGexValue >= minSignificant);
  const floorWall = posWallsBelow[0] || null;
  if (floorWall) {
    score += SCORE.FLOOR_OR_CEILING;
    breakdown.push(`+25: Pos floor below at ${floorWall.strike} (${formatDollar(floorWall.gexValue)}) — downside protection`);
  }

  // +20: Open air to target / no resistance above
  let gotTrendBonus = false;
  if (targetWall) {
    const hasOpenAir = checkOpenAir(spotPrice, targetWall.strike, 'above', data.aggregatedGex, data.strikes, targetWall.absGexValue);
    if (hasOpenAir) {
      score += SCORE.OPEN_AIR;
      gotTrendBonus = true;
      breakdown.push('+20: Open air to target (no blocking walls)');
    }
  } else if (hasUnobstructedUpside) {
    const strikesAbove = data.strikes.filter(s => s > spotPrice).slice(0, 20);
    let blocked = false;
    for (const s of strikesAbove) {
      const gexVal = data.aggregatedGex.get(s) || 0;
      if (gexVal > 0 && gexVal >= minSignificant) {
        blocked = true;
        breakdown.push(`+0: Pos wall at ${s} (${formatDollar(gexVal)}) blocks open air above`);
        break;
      }
    }
    if (!blocked) {
      score += SCORE.OPEN_AIR;
      gotTrendBonus = true;
      breakdown.push('+20: Open air above — no significant positive GEX resistance');
    }
  }

  // +20: Target wall growing between reads (wall trend confirmation)
  if (wallTrends && targetWall) {
    const growing = wallTrends.find(t => t.type === 'WALL_GROWTH' && t.wall.strike === targetWall.strike);
    if (growing && !gotTrendBonus) {
      score += SCORE.OPEN_AIR;
      gotTrendBonus = true;
      breakdown.push(`+20: Target wall growing (${(growing.growthPct * 100).toFixed(0)}% increase)`);
    }
  }

  // -20 (or -5): Positive wall above larger than negative wall (caps upside)
  // Reduced to -5 when walls are within 4 strikes — that's a rug setup, not noise
  if (significantPosAbove.length > 0 && targetWall && significantPosAbove[0].absGexValue > targetWall.absGexValue) {
    const strikeGap = Math.abs(significantPosAbove[0].strike - targetWall.strike) / 5; // SPX $5 steps
    if (strikeGap <= 4) {
      score -= 5;
      breakdown.push(`-5: Pos wall above (${significantPosAbove[0].strike}) near neg target (${strikeGap} strikes) — possible rug setup, reduced penalty`);
    } else {
      score += SCORE.CONFLICTING_WALL_PENALTY;
      breakdown.push(`-20: Pos wall above (${significantPosAbove[0].strike}) larger than neg target — caps upside`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    direction: 'BULLISH',
    breakdown,
    targetWall,
    floorWall,
    distanceToTarget: targetWall
      ? `${((targetWall.strike - spotPrice) / spotPrice * 100).toFixed(1)}%`
      : hasUnobstructedUpside ? 'OPEN (expansion)' : 'N/A',
  };
}

function scoreBearish(gexAtSpot, wallsAbove, wallsBelow, spotPrice, data, wallTrends, largestWallAbs, momentum, rawGexAtSpot) {
  let score = 0;
  const breakdown = [];
  const minSignificant = largestWallAbs * 0.10;

  // +30: Negative GEX at spot — volatile, dealers amplify moves
  // Uses smoothed gexAtSpot (passed as gexAtSpot) to prevent oscillation
  // Only award if momentum is NOT bullish
  if (gexAtSpot < 0) {
    if (momentum.direction !== 'UP' || momentum.strength === 'WEAK') {
      score += SCORE.NEGATIVE_GEX_AT_SPOT;
      breakdown.push(`+30: Negative GEX at spot (${formatDollar(rawGexAtSpot)}, smoothed: ${formatDollar(gexAtSpot)})`);
    } else {
      breakdown.push(`+0: Negative GEX at spot but momentum is bullish (+${momentum.points}pts) — amplifies upside, not downside`);
    }
  }

  // +25: Target / Expansion signal
  const negWallsBelow = wallsBelow.filter(w => w.type === 'negative' && w.absGexValue >= minSignificant);
  const targetWall = negWallsBelow[0] || null;

  const posWallsBelow = wallsBelow.filter(w => w.type === 'positive');
  const significantPosBelow = posWallsBelow.filter(w => w.absGexValue >= minSignificant);

  let hasUnobstructedDownside = false;

  if (targetWall) {
    score += SCORE.LARGE_WALL_TARGET;
    breakdown.push(`+25: Neg wall below at ${targetWall.strike} (${formatDollar(targetWall.gexValue)}) — downside magnet`);
  } else if (gexAtSpot < 0 && significantPosBelow.length === 0) {
    score += SCORE.UNOBSTRUCTED_EXPANSION;
    hasUnobstructedDownside = true;
    breakdown.push(`+25: Unobstructed downside — neg gamma, no significant pos floors below`);
  }

  // +25: Negative GEX ceiling ABOVE spot (confirms bearish pressure)
  const negWallsAbove = wallsAbove.filter(w => w.type === 'negative' && w.absGexValue >= minSignificant);
  const ceilingWall = negWallsAbove[0] || null;
  if (ceilingWall) {
    score += SCORE.FLOOR_OR_CEILING;
    breakdown.push(`+25: Neg ceiling above at ${ceilingWall.strike} (${formatDollar(ceilingWall.gexValue)}) — upside resistance`);
  }

  // +20: Wall growing OR open air below
  let gotTrendBonus = false;
  if (wallTrends && ceilingWall) {
    const growing = wallTrends.find(t => t.type === 'WALL_GROWTH' && t.wall.strike === ceilingWall.strike);
    if (growing) {
      score += SCORE.OPEN_AIR;
      gotTrendBonus = true;
      breakdown.push(`+20: Ceiling wall growing (${(growing.growthPct * 100).toFixed(0)}% increase)`);
    }
  }

  if (!gotTrendBonus && hasUnobstructedDownside) {
    const strikesBelow = data.strikes.filter(s => s < spotPrice).reverse().slice(0, 20);
    let blocked = false;
    for (const s of strikesBelow) {
      const gexVal = data.aggregatedGex.get(s) || 0;
      if (gexVal > 0 && gexVal >= minSignificant) {
        blocked = true;
        breakdown.push(`+0: Pos wall at ${s} (${formatDollar(gexVal)}) blocks open air below`);
        break;
      }
    }
    if (!blocked) {
      score += SCORE.OPEN_AIR;
      breakdown.push('+20: Open air below — no significant positive GEX support');
    }
  }

  // -20 (or -5): Large positive GEX floor below target blocks downside
  // Reduced to -5 when walls are within 4 strikes — that's a rug setup, not noise
  if (significantPosBelow.length > 0 && targetWall && significantPosBelow[0].absGexValue > targetWall.absGexValue * 0.5) {
    const strikeGap = Math.abs(significantPosBelow[0].strike - targetWall.strike) / 5;
    if (strikeGap <= 4) {
      score -= 5;
      breakdown.push(`-5: Pos floor below (${significantPosBelow[0].strike}) near neg target (${strikeGap} strikes) — possible rug setup, reduced penalty`);
    } else {
      score += SCORE.CONFLICTING_WALL_PENALTY;
      breakdown.push(`-20: Pos floor below (${significantPosBelow[0].strike}) could block downside`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    direction: 'BEARISH',
    breakdown,
    targetWall,
    floorWall: ceilingWall,
    distanceToTarget: targetWall
      ? `${((spotPrice - targetWall.strike) / spotPrice * 100).toFixed(1)}%`
      : hasUnobstructedDownside ? 'OPEN (expansion)' : 'N/A',
  };
}

function checkChop(gexAtSpot, wallsAbove, wallsBelow, aggregatedGex, strikes) {
  const reasons = [];

  if (wallsAbove.length > 0 && wallsBelow.length > 0) {
    const topAbs = wallsAbove[0].absGexValue;
    const botAbs = wallsBelow[0].absGexValue;
    const ratio = Math.min(topAbs, botAbs) / Math.max(topAbs, botAbs);
    if (ratio > 0.70) {
      reasons.push(`Pinned between walls of similar size (${(ratio * 100).toFixed(0)}% ratio): ${wallsBelow[0].strike} vs ${wallsAbove[0].strike}`);
    }
  }

  const allValues = [...aggregatedGex.values()];
  const positiveCount = allValues.filter(v => v > 0).length;
  if (positiveCount / allValues.length > 0.85) {
    reasons.push(`${(positiveCount / allValues.length * 100).toFixed(0)}% of strikes have positive GEX — highly pinned`);
  }

  if (wallsAbove.length === 0 && wallsBelow.length === 0) {
    reasons.push('No significant walls identified anywhere');
  }

  return {
    isChop: reasons.length >= 2,
    reasons,
  };
}

/**
 * Detect if spot price is in the midpoint danger zone between two significant walls.
 * Returns null if no walls on both sides.
 */
export function detectMidpointDanger(spotPrice, wallsAbove, wallsBelow) {
  const nearestAbove = wallsAbove.length > 0 ? wallsAbove[wallsAbove.length - 1] : null; // closest to spot (sorted by abs size desc, so last = smallest but might be closest)
  const nearestBelow = wallsBelow.length > 0 ? wallsBelow[wallsBelow.length - 1] : null;

  // Find the closest wall above and below spot by distance
  const closestAbove = wallsAbove.reduce((best, w) =>
    !best || w.distanceFromSpot < best.distanceFromSpot ? w : best, null);
  const closestBelow = wallsBelow.reduce((best, w) =>
    !best || w.distanceFromSpot < best.distanceFromSpot ? w : best, null);

  if (!closestAbove || !closestBelow) return null;

  const midpoint = (closestAbove.strike + closestBelow.strike) / 2;
  const distancePct = Math.abs(spotPrice - midpoint) / spotPrice * 100;

  return {
    midpoint,
    distance_pct: parseFloat(distancePct.toFixed(3)),
    in_danger_zone: distancePct <= MIDPOINT.DANGER_ZONE_PCT,
    nearest_above: { strike: closestAbove.strike, type: closestAbove.type, value: closestAbove.gexValue },
    nearest_below: { strike: closestBelow.strike, type: closestBelow.type, value: closestBelow.gexValue },
  };
}

/**
 * Characterize the air pocket quality between spot and a target strike.
 * Enhanced version of checkOpenAir with quality assessment.
 */
export function characterizeAirPocket(spotPrice, targetStrike, direction, aggregatedGex, strikes, targetWallSize) {
  const noiseThreshold = targetWallSize * AIR_POCKET.NOISE_PCT;

  const between = strikes.filter(s =>
    direction === 'above'
      ? s > spotPrice && s < targetStrike
      : s < spotPrice && s > targetStrike
  );

  const totalStrikes = between.length;
  let emptyStrikes = 0;
  let largestObstacle = 0;
  let largestObstacleStrike = null;

  for (const s of between) {
    const absVal = Math.abs(aggregatedGex.get(s) || 0);
    if (absVal <= noiseThreshold) {
      emptyStrikes++;
    }
    if (absVal > largestObstacle) {
      largestObstacle = absVal;
      largestObstacleStrike = s;
    }
  }

  let quality;
  if (totalStrikes === 0) {
    quality = 'HIGH'; // no strikes between = direct path
  } else if (emptyStrikes >= AIR_POCKET.QUALITY_HIGH_STRIKES && largestObstacle <= noiseThreshold) {
    quality = 'HIGH';
  } else if (emptyStrikes >= AIR_POCKET.MIN_STRIKES && largestObstacle < targetWallSize * 0.30) {
    quality = 'MEDIUM';
  } else if (emptyStrikes >= 1) {
    quality = 'LOW';
  } else {
    quality = 'BLOCKED';
  }

  return {
    quality,
    empty_strikes: emptyStrikes,
    total_strikes: totalStrikes,
    largest_obstacle: largestObstacle,
    largest_obstacle_strike: largestObstacleStrike,
  };
}

function checkOpenAir(spotPrice, targetStrike, direction, aggregatedGex, strikes, targetSize) {
  const threshold = targetSize * 0.30;
  const between = strikes.filter(s =>
    direction === 'above'
      ? s > spotPrice && s < targetStrike
      : s < spotPrice && s > targetStrike
  );

  for (const s of between) {
    if (Math.abs(aggregatedGex.get(s) || 0) > threshold) {
      return false;
    }
  }
  return true;
}

function getRecommendation(direction, confidence, environment) {
  if (direction === 'CHOP') return 'WAIT — choppy environment, no clear setup';
  if (direction === 'NEUTRAL') return 'WAIT — insufficient directional evidence';
  if (confidence === 'LOW') return 'WAIT — low confidence, avoid forcing trades';

  if (direction === 'BULLISH') {
    if (confidence === 'HIGH') return 'CALLS — high confidence bullish setup';
    return 'CALLS with caution — medium confidence';
  }
  if (direction === 'BEARISH') {
    if (confidence === 'HIGH') return 'PUTS — high confidence bearish setup';
    return 'PUTS with caution — medium confidence';
  }
  return 'WAIT';
}
