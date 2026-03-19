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
import { getSpotMomentum, pushGexAtSpot, getSmoothedGexAtSpot, smoothGexScore, recordDirection, saveNetGex, getNetGexRoC, getEffectiveTime } from '../store/state.js';
import { getActiveConfig } from '../review/strategy-store.js';
import { nowET } from '../utils/market-hours.js';

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

  // --- Feature 1: Zero Gamma Level (Gamma Flip) ---
  const sortedStrikes = [...aggregatedGex.keys()].sort((a, b) => a - b);
  let zeroGammaLevel = null;
  for (let i = 1; i < sortedStrikes.length; i++) {
    const prev = aggregatedGex.get(sortedStrikes[i - 1]);
    const curr = aggregatedGex.get(sortedStrikes[i]);
    if (prev !== undefined && curr !== undefined && prev < 0 && curr >= 0) {
      const range = curr - prev;
      const ratio = range !== 0 ? Math.abs(prev) / range : 0.5;
      zeroGammaLevel = Math.round(sortedStrikes[i - 1] + (sortedStrikes[i] - sortedStrikes[i - 1]) * ratio);
      if (zeroGammaLevel > spotPrice - 50 && zeroGammaLevel < spotPrice + 50) break;
    }
  }

  // --- Feature 3: Gamma Ratio (call/put balance) ---
  let totalPositiveGex = 0, totalNegativeGex = 0;
  for (const [, value] of aggregatedGex) {
    if (value > 0) totalPositiveGex += value;
    else totalNegativeGex += Math.abs(value);
  }
  const gammaRatio = totalNegativeGex > 0 ? totalPositiveGex / totalNegativeGex : 1.0;

  // --- Feature 4: Wall Distance Asymmetry ---
  const callWallDist = wallsAbove[0] ? Math.abs(wallsAbove[0].strike - spotPrice) : 999;
  const putWallDist = wallsBelow[0] ? Math.abs(wallsBelow[0].strike - spotPrice) : 999;
  const wallAsymmetry = putWallDist > 0 ? callWallDist / putWallDist : 1.0;

  // --- Feature 5: Net GEX Rate of Change ---
  let totalNetGex = 0;
  for (const [, value] of aggregatedGex) totalNetGex += value;
  saveNetGex(totalNetGex, ticker);
  const netGexRoC = getNetGexRoC(ticker);

  // --- Feature 7: Transition Zones (PTrans/NTrans) ---
  // Find first SIGNIFICANT GEX sign change above/below spot (ignore noise)
  const transMinMagnitude = largestWallAbs * 0.05; // must be ≥5% of largest wall
  let pTrans = null, nTrans = null;
  const spotIdx = sortedStrikes.findIndex(s => s >= spotPrice);
  for (let i = Math.max(0, spotIdx); i < sortedStrikes.length - 1; i++) {
    const curr = aggregatedGex.get(sortedStrikes[i]) || 0;
    const next = aggregatedGex.get(sortedStrikes[i + 1]) || 0;
    if ((curr < 0 && next >= 0) || (curr >= 0 && next < 0)) {
      if (Math.abs(curr) >= transMinMagnitude || Math.abs(next) >= transMinMagnitude) {
        pTrans = sortedStrikes[i + 1];
        break;
      }
    }
  }
  for (let i = Math.min(sortedStrikes.length - 1, spotIdx) - 1; i > 0; i--) {
    const curr = aggregatedGex.get(sortedStrikes[i]) || 0;
    const prev = aggregatedGex.get(sortedStrikes[i - 1]) || 0;
    if ((curr < 0 && prev >= 0) || (curr >= 0 && prev < 0)) {
      if (Math.abs(curr) >= transMinMagnitude || Math.abs(prev) >= transMinMagnitude) {
        nTrans = sortedStrikes[i - 1];
        break;
      }
    }
  }
  const transitionZones = { pTrans, nTrans };
  const inTransitionChop = pTrans && nTrans
    && Math.abs(spotPrice - pTrans) < 10
    && Math.abs(spotPrice - nTrans) < 10;

  // --- Feature 9: Charm Pressure Direction ---
  const charmPressure = estimateCharmPressure(aggregatedGex, spotPrice, sortedStrikes);

  // --- Feature 10: Call Wall / Put Wall identification ---
  const callWall = wallsAbove.find(w => w.type === 'positive') || null;
  const putWall = wallsBelow.find(w => w.type === 'negative') || null;

  // --- Feature 2: Time-of-Day Wall Reliability ---
  const etNow = getEffectiveTime() || nowET();
  const hourDecimal = etNow.hour + etNow.minute / 60;
  const wallReliability = hourDecimal >= 14 ? Math.max(0.4, 1.0 - (hourDecimal - 14) * 0.3) : 1.0;

  // Check momentum BEFORE scoring — used to gate negative GEX at spot
  const momentum = getSpotMomentum(ticker);

  // Score both directions — use smoothed gexAtSpot for sign determination
  // Pass new metrics to scoring functions
  // Directional GEX balance: sum of |GEX| above vs below spot
  let gexSumAbove = 0, gexSumBelow = 0;
  for (const [strike, value] of aggregatedGex) {
    if (strike > spotPrice) gexSumAbove += Math.abs(value);
    else if (strike < spotPrice) gexSumBelow += Math.abs(value);
  }
  const directionalBalance = gexSumBelow > 0 ? gexSumAbove / gexSumBelow : 1.0;

  const scoringCtx = { gammaRatio, wallAsymmetry, charmPressure, wallReliability, directionalBalance };
  const bullish = scoreBullish(smoothedGexAtSpot, wallsAbove, wallsBelow, spotPrice, parsedData, largestWallAbs, momentum, gexAtSpot, wallTrends, scoringCtx);
  const bearish = scoreBearish(smoothedGexAtSpot, wallsAbove, wallsBelow, spotPrice, parsedData, wallTrends, largestWallAbs, momentum, gexAtSpot, scoringCtx);

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

  // Momentum conflict override — if score direction fights price trend, penalize hard
  // Fires on MODERATE+ (was STRONG-only, which waited until 30-40pts into a move)
  // On STRONG momentum: hard override flips direction instead of just penalizing
  if (momentum.strength === 'MODERATE' || momentum.strength === 'STRONG') {
    if (bullish.score > bearish.score && momentum.direction === 'DOWN') {
      if (momentum.strength === 'STRONG') {
        // Hard override: price is crashing, walls are wrong — force bearish
        const override = bullish.score - bearish.score + 10; // flip + 10pt margin
        bullish.score = Math.max(0, bullish.score - override);
        bullish.breakdown.push(`-${override}: MOMENTUM OVERRIDE — price falling ${momentum.points}pts (STRONG), forcing direction flip`);
      } else {
        // Moderate conflict: scale penalty by move size, no floor
        const conflictPenalty = Math.min(40, Math.round(Math.abs(momentum.points) * 3));
        bullish.score = Math.max(0, bullish.score - conflictPenalty);
        bullish.breakdown.push(`-${conflictPenalty}: MOMENTUM CONFLICT — walls say BULLISH but price falling ${momentum.points}pts`);
      }
    } else if (bearish.score > bullish.score && momentum.direction === 'UP') {
      if (momentum.strength === 'STRONG') {
        const override = bearish.score - bullish.score + 10;
        bearish.score = Math.max(0, bearish.score - override);
        bearish.breakdown.push(`-${override}: MOMENTUM OVERRIDE — price rising +${momentum.points}pts (STRONG), forcing direction flip`);
      } else {
        const conflictPenalty = Math.min(40, Math.round(momentum.points * 3));
        bearish.score = Math.max(0, bearish.score - conflictPenalty);
        bearish.breakdown.push(`-${conflictPenalty}: MOMENTUM CONFLICT — walls say BEARISH but price rising +${momentum.points}pts`);
      }
    }
  }

  // Check for chop — flag only, don't override direction
  const chop = checkChop(gexAtSpot, wallsAbove, wallsBelow, aggregatedGex, strikes, getActiveConfig());

  // Determine best direction (always directional — CHOP is a separate flag)
  // Hysteresis is handled downstream by EMA smoothing + direction stability checks
  let result;
  if (bullish.score >= bearish.score) {
    result = bullish;
  } else {
    result = bearish;
  }

  // Low scores → NEUTRAL (not enough evidence for a directional call)
  if (result.score < NEUTRAL_THRESHOLD) {
    result.breakdown.push(`Score ${result.score} < ${NEUTRAL_THRESHOLD} threshold → NEUTRAL`);
    result.direction = 'NEUTRAL';
  }

  // Apply Trinity cross-market confirmation bonus (only for directional setups)
  if (trinityBonus > 0 && result.direction !== 'NEUTRAL') {
    result.score = Math.min(100, result.score + trinityBonus);
    result.breakdown.push(`+${trinityBonus}: Trinity confirmation (cross-market alignment)`);
  }

  // EMA score smoothing — prevents whipsaw on small spot moves
  // Resets on direction flip to avoid smoothing across BULLISH↔BEARISH boundary
  const rawScore = result.score;
  result.score = smoothGexScore(ticker, result.score, result.direction);
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

  // Overall environment label — use zero gamma level (structural) with smoothed fallback
  const inNegativeGamma = zeroGammaLevel ? spotPrice < zeroGammaLevel : smoothedGexAtSpot < 0;
  const environment = inNegativeGamma ? 'NEGATIVE GAMMA' : 'POSITIVE GAMMA';
  const envDetail = inNegativeGamma
    ? 'Volatile — dealers short gamma, moves amplified'
    : 'Pinned — dealers long gamma, moves dampened';

  return {
    spotPrice,
    gexAtSpot,
    smoothedGexAtSpot,
    rawScore,
    score: result.score,
    direction: result.direction,
    isChop: chop.isChop,
    chopReasons: chop.isChop ? chop.reasons : [],
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
    // New GEX analysis features
    zeroGammaLevel,
    gammaRatio: parseFloat(gammaRatio.toFixed(2)),
    wallAsymmetry: parseFloat(wallAsymmetry.toFixed(2)),
    netGexRoC,
    transitionZones,
    inTransitionChop,
    charmPressure,
    callWall,
    putWall,
    directionalBalance: parseFloat(directionalBalance.toFixed(2)),
  };
}

function scoreBullish(gexAtSpot, wallsAbove, wallsBelow, spotPrice, data, largestWallAbs, momentum, rawGexAtSpot, wallTrends, ctx = {}) {
  let score = 0;
  const breakdown = [];
  const minSignificant = largestWallAbs * 0.10;
  const { gammaRatio = 1.0, wallAsymmetry = 1.0, charmPressure = {}, wallReliability = 1.0, directionalBalance = 1.0 } = ctx;

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

  // --- Feature 2: Wall reliability decay (afternoon) ---
  if (wallReliability < 1.0) {
    const negGexAwarded = gexAtSpot < 0 && (momentum.direction !== 'DOWN' || momentum.strength === 'WEAK');
    const wallPortion = score - (negGexAwarded ? SCORE.NEGATIVE_GEX_AT_SPOT : 0);
    if (wallPortion > 0) {
      const reduction = Math.round(wallPortion * (1 - wallReliability));
      score -= reduction;
      breakdown.push(`-${reduction}: Afternoon wall decay (${(wallReliability * 100).toFixed(0)}% reliability)`);
    }
  }

  // --- Feature 3: Gamma ratio bias ---
  if (gammaRatio > 1.5) {
    score += 5;
    breakdown.push(`+5: Call-heavy gamma ratio (${gammaRatio.toFixed(2)}) — bullish support`);
  }

  // --- Feature 4: Wall asymmetry bonus ---
  if (wallAsymmetry > 1.5) {
    score += 5;
    breakdown.push(`+5: More room upward (asymmetry ${wallAsymmetry.toFixed(2)})`);
  }

  // --- Feature 9: Charm pressure bonus ---
  if (charmPressure.active && charmPressure.strength > 0.3 && charmPressure.direction === 'BULLISH') {
    score += 5;
    breakdown.push(`+5: Bullish charm pressure (${(charmPressure.strength * 100).toFixed(0)}% strength)`);
  }

  // Directional GEX balance: more GEX above spot = bullish support
  if (directionalBalance >= 3.0) {
    score += 10;
    breakdown.push(`+10: Strong GEX above spot (${directionalBalance.toFixed(1)}x balance)`);
  } else if (directionalBalance >= 2.0) {
    score += 5;
    breakdown.push(`+5: GEX above spot (${directionalBalance.toFixed(1)}x balance)`);
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

function scoreBearish(gexAtSpot, wallsAbove, wallsBelow, spotPrice, data, wallTrends, largestWallAbs, momentum, rawGexAtSpot, ctx = {}) {
  let score = 0;
  const breakdown = [];
  const minSignificant = largestWallAbs * 0.10;
  const { gammaRatio = 1.0, wallAsymmetry = 1.0, charmPressure = {}, wallReliability = 1.0, directionalBalance = 1.0 } = ctx;

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

  // --- Feature 2: Wall reliability decay (afternoon) ---
  if (wallReliability < 1.0) {
    const negGexAwarded = gexAtSpot < 0 && (momentum.direction !== 'UP' || momentum.strength === 'WEAK');
    const wallPortion = score - (negGexAwarded ? SCORE.NEGATIVE_GEX_AT_SPOT : 0);
    if (wallPortion > 0) {
      const reduction = Math.round(wallPortion * (1 - wallReliability));
      score -= reduction;
      breakdown.push(`-${reduction}: Afternoon wall decay (${(wallReliability * 100).toFixed(0)}% reliability)`);
    }
  }

  // --- Feature 3: Gamma ratio bias ---
  if (gammaRatio < 0.67) {
    score += 5;
    breakdown.push(`+5: Put-heavy gamma ratio (${gammaRatio.toFixed(2)}) — bearish support`);
  }

  // --- Feature 4: Wall asymmetry bonus ---
  if (wallAsymmetry < 0.67) {
    score += 5;
    breakdown.push(`+5: More room downward (asymmetry ${wallAsymmetry.toFixed(2)})`);
  }

  // --- Feature 9: Charm pressure bonus ---
  if (charmPressure.active && charmPressure.strength > 0.3 && charmPressure.direction === 'BEARISH') {
    score += 5;
    breakdown.push(`+5: Bearish charm pressure (${(charmPressure.strength * 100).toFixed(0)}% strength)`);
  }

  // Directional GEX balance: more GEX below spot = bearish support
  if (directionalBalance <= 0.33) {
    score += 10;
    breakdown.push(`+10: Strong GEX below spot (${directionalBalance.toFixed(2)} balance)`);
  } else if (directionalBalance <= 0.50) {
    score += 5;
    breakdown.push(`+5: GEX below spot (${directionalBalance.toFixed(2)} balance)`);
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

function checkChop(gexAtSpot, wallsAbove, wallsBelow, aggregatedGex, strikes, cfg) {
  const reasons = [];

  // Find nearest positive walls on each side (pin zone = positive gamma trapping price)
  const posAbove = wallsAbove.filter(w => w.type === 'positive');
  const posBelow = wallsBelow.filter(w => w.type === 'positive');

  // Condition 1: Pinned between POSITIVE walls of similar size
  // Positive walls on both sides = dealers long gamma both directions = price dampened
  // On trend days, one side typically has negative walls (magnets), so this doesn't fire
  if (posAbove.length > 0 && posBelow.length > 0) {
    const topAbs = posAbove[0].absGexValue;
    const botAbs = posBelow[0].absGexValue;
    const ratio = Math.min(topAbs, botAbs) / Math.max(topAbs, botAbs);
    if (ratio > 0.50) {
      reasons.push(`Pinned between positive walls (${(ratio * 100).toFixed(0)}% ratio): ${posBelow[0].strike} vs ${posAbove[0].strike}`);
    }
  }

  // Condition 2: Highly positive GEX environment (pinned)
  const allValues = [...aggregatedGex.values()];
  const positiveCount = allValues.filter(v => v > 0).length;
  if (positiveCount / allValues.length > 0.85) {
    reasons.push(`${(positiveCount / allValues.length * 100).toFixed(0)}% of strikes have positive GEX — highly pinned`);
  }

  // Condition 3: Tight range — positive walls within 30 SPX pts on both sides
  if (posAbove.length > 0 && posBelow.length > 0) {
    const range = posAbove[0].strike - posBelow[0].strike;
    if (range > 0 && range <= 30) {
      reasons.push(`Tight positive wall range: ${posBelow[0].strike} to ${posAbove[0].strike} (${range} pts)`);
    }
  }

  // Condition 4: No significant walls anywhere
  if (wallsAbove.length === 0 && wallsBelow.length === 0) {
    reasons.push('No significant walls identified anywhere');
  }

  // Condition 5: Extreme pin zone — very high positive GEX at spot + positive walls on both sides
  // Late-day pin: dealers massively long gamma at spot, all moves immediately dampened
  const pinThreshold = cfg?.pin_gex_at_spot_threshold ?? 20_000_000;
  if (gexAtSpot > pinThreshold && posAbove.length > 0 && posBelow.length > 0) {
    reasons.push(`Extreme pin: GEX@spot ${(gexAtSpot / 1e6).toFixed(0)}M > ${(pinThreshold / 1e6).toFixed(0)}M with pos walls on both sides`);
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

/**
 * Feature 9: Estimate charm (time decay) pressure direction.
 * After 1:30 PM ET, OTM options decay accelerates → net hedging flow.
 * More OTM put decay = bullish (MMs unwind short hedges).
 * More OTM call decay = bearish (MMs unwind long hedges).
 */
function estimateCharmPressure(aggregatedGex, spotPrice, sortedStrikes) {
  const now = getEffectiveTime() || nowET();
  const hour = now.hour + now.minute / 60;
  if (hour < 13.5) return { direction: null, strength: 0, active: false };

  let putGammaBelow = 0, callGammaAbove = 0;
  for (const strike of sortedStrikes) {
    const gex = aggregatedGex.get(strike) || 0;
    if (strike < spotPrice && gex < 0) putGammaBelow += Math.abs(gex);
    if (strike > spotPrice && gex > 0) callGammaAbove += gex;
  }

  const charmBias = putGammaBelow - callGammaAbove;
  const strength = Math.min(1.0, Math.abs(charmBias) / 50_000_000);
  const timeFactor = Math.min(1.0, (hour - 13.5) / 2.5);

  return {
    direction: charmBias > 0 ? 'BULLISH' : charmBias < 0 ? 'BEARISH' : null,
    strength: parseFloat((strength * timeFactor).toFixed(3)),
    active: true,
    putGammaBelow,
    callGammaAbove,
  };
}
