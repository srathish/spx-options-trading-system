#!/usr/bin/env node
/**
 * Optimal GEX Trade Analyzer
 *
 * For each day:
 * 1. Track every strike's gamma value every frame (full day memory)
 * 2. Find every 15+ pt move
 * 3. Look backwards: what GEX node was growing BEFORE the move started?
 * 4. Output CSV with signal characteristics
 *
 * Usage: node scripts/analyze-optimal-trades.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { DateTime } from 'luxon';

// ---- Configuration ----
const MOVE_THRESHOLD = 15;         // Minimum pts for a "significant move"
const LOOKBACK_FRAMES = 30;        // 30 frames = 30 min lookback for node growth
const NEAR_SPOT_RANGE = 30;        // Only look at nodes within 30 pts of spot
const TOP_N_NODES = 5;             // Track top N growing nodes
const CHECKPOINT_INTERVAL = 10;    // Print spot every 10 minutes

const FILES = [
  { file: 'data/gex-replay-2026-02-06.json', label: '+140 rally' },
  { file: 'data/gex-replay-2026-03-20.json', label: '-116 selloff' },
  { file: 'data/gex-replay-2026-02-23.json', label: '-73 selloff' },
  { file: 'data/gex-replay-2026-01-14.json', label: '-38 moderate' },
  { file: 'data/gex-replay-2026-02-11.json', label: '+3 chop' },
  { file: 'data/gex-replay-2026-03-12.json', label: '-104 selloff' },
  { file: 'data/gex-replay-2026-02-05.json', label: '-86 selloff' },
];

// ---- Helpers ----

function getSpot(frame) {
  if (frame.tickers?.SPXW) return frame.tickers.SPXW.spotPrice;
  return frame.spotPrice;
}

function getStrikes(frame) {
  if (frame.tickers?.SPXW) return frame.tickers.SPXW.strikes;
  return frame.strikes;
}

function getGammaValues(frame) {
  if (frame.tickers?.SPXW) return frame.tickers.SPXW.gammaValues;
  return frame.gammaValues;
}

function totalGamma(gammaArr) {
  if (Array.isArray(gammaArr[0])) {
    // Multi-expiration: sum across expirations, but weight 0DTE heavily
    // Index 0 is 0DTE - use only 0DTE for cleaner signal
    return gammaArr[0]; // Just the 0DTE gamma value
  }
  return gammaArr; // Already flat
}

function frameToET(timestamp) {
  return DateTime.fromISO(timestamp, { zone: 'UTC' }).setZone('America/New_York');
}

function formatTime(timestamp) {
  return frameToET(timestamp).toFormat('HH:mm');
}

// ---- Build per-strike gamma history for full day ----

function buildGammaHistory(frames) {
  // gammaHistory[strike] = [{ frameIdx, value, spot, time }]
  const history = {};
  const spotHistory = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const spot = getSpot(frame);
    const strikes = getStrikes(frame);
    const gammaVals = getGammaValues(frame);
    const time = frame.timestamp;

    spotHistory.push({ frameIdx: i, spot, time });

    for (let j = 0; j < strikes.length; j++) {
      const strike = strikes[j];
      // Sum gamma across expirations, with 0DTE as primary
      let gVal;
      if (Array.isArray(gammaVals[j])) {
        // 0DTE gamma is index 0, total across all expirations
        gVal = gammaVals[j].reduce((a, b) => a + b, 0);
      } else {
        gVal = gammaVals[j];
      }

      if (!history[strike]) history[strike] = [];
      history[strike].push({ frameIdx: i, value: gVal, spot, time });
    }
  }

  return { gammaHistory: history, spotHistory };
}

// ---- Find all significant moves (15+ pts) ----

function findSignificantMoves(spotHistory, threshold = MOVE_THRESHOLD) {
  const moves = [];
  const n = spotHistory.length;

  // Use a sliding window approach:
  // For every frame, look forward to find moves >= threshold
  // Then find the actual local extremes (high/low) to get the full move

  // First, find local extremes (swing highs and lows)
  const extremes = findSwingPoints(spotHistory);

  // Then find moves between consecutive extremes that are >= threshold
  for (let i = 0; i < extremes.length - 1; i++) {
    const start = extremes[i];
    const end = extremes[i + 1];
    const movePts = end.spot - start.spot;

    if (Math.abs(movePts) >= threshold) {
      moves.push({
        startFrame: start.frameIdx,
        endFrame: end.frameIdx,
        startPrice: start.spot,
        endPrice: end.spot,
        pts: movePts,
        direction: movePts > 0 ? 'UP' : 'DOWN',
        startTime: start.time,
        endTime: end.time,
        durationMin: end.frameIdx - start.frameIdx, // 1 frame = 1 min
      });
    }
  }

  // Also look for compound moves: chain of same-direction swings
  // Sometimes a big move has small pullbacks within it
  const compoundMoves = findCompoundMoves(extremes, threshold);

  return [...moves, ...compoundMoves].sort((a, b) => a.startFrame - b.startFrame);
}

function findSwingPoints(spotHistory) {
  // Use a 5-frame smoothing to reduce noise
  const smoothed = [];
  for (let i = 0; i < spotHistory.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(spotHistory.length - 1, i + 2); j++) {
      sum += spotHistory[j].spot;
      count++;
    }
    smoothed.push({ ...spotHistory[i], smoothSpot: sum / count });
  }

  const extremes = [smoothed[0]]; // Always start with first point

  for (let i = 5; i < smoothed.length - 5; i++) {
    const prev5 = smoothed.slice(i - 5, i).map(s => s.smoothSpot);
    const next5 = smoothed.slice(i + 1, i + 6).map(s => s.smoothSpot);
    const curr = smoothed[i].smoothSpot;

    const isHigh = prev5.every(p => p <= curr + 0.5) && next5.every(n => n <= curr + 0.5);
    const isLow = prev5.every(p => p >= curr - 0.5) && next5.every(n => n >= curr - 0.5);

    if (isHigh || isLow) {
      // Don't add if too close to last extreme
      const last = extremes[extremes.length - 1];
      if (i - last.frameIdx >= 5) {
        extremes.push(smoothed[i]);
      }
    }
  }

  extremes.push(smoothed[smoothed.length - 1]); // Always end with last

  // Remove extremes that are too close together or don't represent meaningful turns
  return cleanExtremes(extremes, 3); // min 3pt swing
}

function cleanExtremes(extremes, minSwing) {
  if (extremes.length <= 2) return extremes;

  const cleaned = [extremes[0]];

  for (let i = 1; i < extremes.length; i++) {
    const last = cleaned[cleaned.length - 1];
    const curr = extremes[i];
    const swing = Math.abs(curr.spot - last.spot);

    if (swing >= minSwing || i === extremes.length - 1) {
      cleaned.push(curr);
    }
  }

  // Second pass: merge same-direction consecutive moves (keep the extreme)
  const merged = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    const prev = merged[merged.length - 1];
    const prevPrev = merged.length >= 2 ? merged[merged.length - 2] : null;

    if (prevPrev) {
      const dir1 = prev.spot - prevPrev.spot > 0 ? 'UP' : 'DOWN';
      const dir2 = cleaned[i].spot - prev.spot > 0 ? 'UP' : 'DOWN';

      // If same direction, keep the more extreme one
      if (dir1 === dir2) {
        if (dir1 === 'UP' && cleaned[i].spot > prev.spot) {
          merged[merged.length - 1] = cleaned[i];
        } else if (dir1 === 'DOWN' && cleaned[i].spot < prev.spot) {
          merged[merged.length - 1] = cleaned[i];
        } else {
          merged.push(cleaned[i]);
        }
        continue;
      }
    }
    merged.push(cleaned[i]);
  }

  return merged;
}

function findCompoundMoves(extremes, threshold) {
  const moves = [];

  // Look for moves that span multiple swing points but maintain direction
  for (let i = 0; i < extremes.length; i++) {
    for (let j = i + 2; j < Math.min(extremes.length, i + 10); j++) {
      const movePts = extremes[j].spot - extremes[i].spot;
      if (Math.abs(movePts) >= threshold * 1.5) { // Higher threshold for compound
        // Check that the move is mostly in one direction
        let maxDrawback = 0;
        for (let k = i + 1; k < j; k++) {
          const interim = extremes[k].spot - extremes[i].spot;
          if (movePts > 0) { // Up move
            maxDrawback = Math.max(maxDrawback, extremes[i].spot - extremes[k].spot);
          } else { // Down move
            maxDrawback = Math.max(maxDrawback, extremes[k].spot - extremes[i].spot);
          }
        }

        if (maxDrawback < Math.abs(movePts) * 0.3) { // Less than 30% drawback
          moves.push({
            startFrame: extremes[i].frameIdx,
            endFrame: extremes[j].frameIdx,
            startPrice: extremes[i].spot,
            endPrice: extremes[j].spot,
            pts: movePts,
            direction: movePts > 0 ? 'UP' : 'DOWN',
            startTime: extremes[i].time,
            endTime: extremes[j].time,
            durationMin: extremes[j].frameIdx - extremes[i].frameIdx,
            compound: true,
          });
        }
      }
    }
  }

  return moves;
}

// ---- Deduplicate overlapping moves ----

function deduplicateMoves(moves) {
  if (moves.length === 0) return [];

  // Sort by absolute pts (largest first)
  const sorted = [...moves].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const used = new Set();
  const result = [];

  for (const move of sorted) {
    // Check if this move's frames significantly overlap with an already-selected move
    let overlaps = false;
    for (const selected of result) {
      const overlapStart = Math.max(move.startFrame, selected.startFrame);
      const overlapEnd = Math.min(move.endFrame, selected.endFrame);
      if (overlapEnd > overlapStart) {
        const overlapLen = overlapEnd - overlapStart;
        const moveLen = move.endFrame - move.startFrame;
        if (overlapLen / moveLen > 0.5) {
          overlaps = true;
          break;
        }
      }
    }

    if (!overlaps) {
      result.push(move);
    }
  }

  return result.sort((a, b) => a.startFrame - b.startFrame);
}

// ---- Find GEX signal that predicted a move ----

function findPredictiveSignal(move, gammaHistory, spotHistory) {
  const signals = [];

  // Look at frames BEFORE the move started
  // Window: from 30 frames before to the start of the move
  const lookbackStart = Math.max(0, move.startFrame - LOOKBACK_FRAMES);
  const lookbackEnd = move.startFrame;

  const spotAtStart = move.startPrice;

  // For each strike, calculate growth rate in the lookback period
  for (const [strikeStr, history] of Object.entries(gammaHistory)) {
    const strike = parseInt(strikeStr);
    const distFromSpot = strike - spotAtStart;

    // Only look at nodes within reasonable range of spot
    if (Math.abs(distFromSpot) > 50) continue;

    // Get gamma values at lookback start and at move start
    const entriesInWindow = history.filter(h => h.frameIdx >= lookbackStart && h.frameIdx <= lookbackEnd);
    if (entriesInWindow.length < 2) continue;

    const firstEntry = entriesInWindow[0];
    const lastEntry = entriesInWindow[entriesInWindow.length - 1];

    const valueAtStart = lastEntry.value;
    const valueAtLookback = firstEntry.value;
    const growth = valueAtStart - valueAtLookback;
    const growthRate = growth / (lastEntry.frameIdx - firstEntry.frameIdx + 1); // per frame (per minute)
    const absValue = Math.abs(valueAtStart);

    // Also check: was this node still growing at the start? (last 5 frames)
    const recentEntries = entriesInWindow.filter(h => h.frameIdx >= lookbackEnd - 5);
    let recentGrowth = 0;
    if (recentEntries.length >= 2) {
      recentGrowth = recentEntries[recentEntries.length - 1].value - recentEntries[0].value;
    }

    // Find when growth started (first frame where consistent growth began)
    let growthStartFrame = lookbackStart;
    for (let k = entriesInWindow.length - 1; k > 0; k--) {
      if (Math.sign(entriesInWindow[k].value - entriesInWindow[k-1].value) !== Math.sign(growth)) {
        growthStartFrame = entriesInWindow[k].frameIdx;
        break;
      }
    }

    const entryDelay = move.startFrame - growthStartFrame;

    signals.push({
      strike,
      distFromSpot: distFromSpot,
      valueAtStart: valueAtStart,
      valueAtLookback: valueAtLookback,
      growth: growth,
      growthRate: growthRate,
      growthPct: valueAtLookback !== 0 ? (growth / Math.abs(valueAtLookback)) * 100 : 0,
      absValue: absValue,
      isPositive: valueAtStart > 0,
      recentGrowth: recentGrowth,
      entryDelay: entryDelay,
      growthStartFrame: growthStartFrame,
    });
  }

  // Rank signals by relevance to the move
  // For DOWN moves: look for negative nodes growing (more negative) below spot, or positive nodes shrinking above spot
  // For UP moves: look for positive nodes growing above spot, or negative nodes growing below spot

  const isUp = move.direction === 'UP';

  signals.sort((a, b) => {
    // Primary: absolute growth rate
    return Math.abs(b.growthRate) - Math.abs(a.growthRate);
  });

  // Also find the "directional" signal: the one most aligned with the move direction
  const directionalSignals = signals.filter(s => {
    if (isUp) {
      // For UP: positive node growing above spot (magnet pull), or negative node shrinking below (support released)
      return (s.distFromSpot > 0 && s.growth > 0 && s.isPositive) ||
             (s.distFromSpot < 0 && s.growth < 0 && !s.isPositive) ||
             (s.distFromSpot > 0 && s.growthRate > 0);
    } else {
      // For DOWN: negative node growing below spot (magnet pull), or positive node shrinking above (resistance weakening)
      return (s.distFromSpot < 0 && Math.abs(s.growth) > 0 && !s.isPositive) ||
             (s.distFromSpot > 0 && s.growth < 0) ||
             (s.distFromSpot < 0 && s.growthRate < 0);
    }
  });

  return {
    topByGrowthRate: signals.slice(0, 5),
    directional: directionalSignals.slice(0, 5),
    all: signals,
  };
}

// ---- Find TOP growing nodes at checkpoint ----

function getTopGrowingNodes(frameIdx, gammaHistory, spotHistory, lookback = LOOKBACK_FRAMES) {
  const spot = spotHistory[frameIdx].spot;
  const lookbackIdx = Math.max(0, frameIdx - lookback);

  const nodes = [];

  for (const [strikeStr, history] of Object.entries(gammaHistory)) {
    const strike = parseInt(strikeStr);
    if (Math.abs(strike - spot) > NEAR_SPOT_RANGE) continue;

    const current = history.find(h => h.frameIdx === frameIdx);
    const past = history.find(h => h.frameIdx === lookbackIdx);

    if (!current || !past) continue;

    const growth = current.value - past.value;
    const growthRate = growth / (frameIdx - lookbackIdx);

    nodes.push({
      strike,
      value: current.value,
      growth,
      growthRate,
      distFromSpot: strike - spot,
      isPositive: current.value > 0,
    });
  }

  // Sort by absolute growth rate
  nodes.sort((a, b) => Math.abs(b.growthRate) - Math.abs(a.growthRate));

  return nodes.slice(0, TOP_N_NODES);
}

// ---- Analyze the GEX structure at any frame ----

function getGexStructure(frameIdx, gammaHistory, spotHistory) {
  const spot = spotHistory[frameIdx].spot;
  const nodes = [];

  for (const [strikeStr, history] of Object.entries(gammaHistory)) {
    const strike = parseInt(strikeStr);
    if (Math.abs(strike - spot) > 40) continue;

    const current = history.find(h => h.frameIdx === frameIdx);
    if (!current) continue;

    nodes.push({
      strike,
      value: current.value,
      distFromSpot: strike - spot,
      isPositive: current.value > 0,
      absValue: Math.abs(current.value),
    });
  }

  // Sort by absolute value (largest walls first)
  nodes.sort((a, b) => b.absValue - a.absValue);

  // Find the largest positive node above and below spot
  const posAbove = nodes.find(n => n.isPositive && n.distFromSpot > 0);
  const posBelow = nodes.find(n => n.isPositive && n.distFromSpot < 0);
  const negAbove = nodes.find(n => !n.isPositive && n.distFromSpot > 0);
  const negBelow = nodes.find(n => !n.isPositive && n.distFromSpot < 0);

  // Net gamma balance
  const aboveGamma = nodes.filter(n => n.distFromSpot > 0).reduce((s, n) => s + n.value, 0);
  const belowGamma = nodes.filter(n => n.distFromSpot < 0).reduce((s, n) => s + n.value, 0);

  return {
    spot,
    topWalls: nodes.slice(0, 5),
    posAbove, posBelow, negAbove, negBelow,
    aboveGamma, belowGamma,
    netBalance: aboveGamma + belowGamma,
    directionalBias: aboveGamma > belowGamma ? 'BEARISH_CEILING' : 'BULLISH_FLOOR',
  };
}

// ---- Main analysis for a single day ----

function analyzeDay(filePath, label) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`ANALYZING: ${filePath} (${label})`);
  console.log('='.repeat(80));

  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const frames = data.frames;

  // Build full gamma history
  const { gammaHistory, spotHistory } = buildGammaHistory(frames);

  const date = data.metadata?.date || filePath.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const openPrice = spotHistory[0].spot;
  const closePrice = spotHistory[spotHistory.length - 1].spot;

  console.log(`\nDate: ${date} | Open: ${openPrice.toFixed(1)} | Close: ${closePrice.toFixed(1)} | Change: ${(closePrice - openPrice).toFixed(1)}`);

  // ---- Part 1: Spot price every 10 minutes ----
  console.log('\n--- SPOT PRICE EVERY 10 MINUTES ---');
  console.log('Time(ET)   Spot     Chg    Top Growing Nodes (strike:value:growth30m)');

  for (let i = 0; i < frames.length; i += CHECKPOINT_INTERVAL) {
    const spot = spotHistory[i].spot;
    const change = spot - openPrice;
    const time = formatTime(frames[i].timestamp);
    const topNodes = getTopGrowingNodes(i, gammaHistory, spotHistory);

    const nodeStr = topNodes.slice(0, 3).map(n =>
      `${n.strike}:${(n.value/1e6).toFixed(1)}M:${n.growth > 0 ? '+' : ''}${(n.growth/1e6).toFixed(1)}M`
    ).join('  ');

    console.log(`${time}  ${spot.toFixed(1)}  ${change >= 0 ? '+' : ''}${change.toFixed(1)}   ${nodeStr}`);
  }

  // ---- Part 2: Find all significant moves ----
  console.log('\n--- SIGNIFICANT MOVES (15+ pts) ---');

  const rawMoves = findSignificantMoves(spotHistory, MOVE_THRESHOLD);
  const moves = deduplicateMoves(rawMoves);

  console.log(`Found ${moves.length} significant moves:\n`);

  const csvRows = [];

  for (const move of moves) {
    const startTime = formatTime(move.startTime);
    const endTime = formatTime(move.endTime);

    console.log(`  ${move.direction} ${Math.abs(move.pts).toFixed(1)}pts: ${move.startPrice.toFixed(1)} → ${move.endPrice.toFixed(1)} (${startTime} → ${endTime}, ${move.durationMin}min)${move.compound ? ' [compound]' : ''}`);

    // ---- Part 3: Find predictive GEX signal ----
    const signals = findPredictiveSignal(move, gammaHistory, spotHistory);

    if (signals.directional.length > 0) {
      const best = signals.directional[0];
      console.log(`    SIGNAL: Strike ${best.strike} (${best.distFromSpot > 0 ? '+' : ''}${best.distFromSpot.toFixed(0)}pts from spot)`);
      console.log(`      Value: ${(best.valueAtStart / 1e6).toFixed(2)}M | Growth: ${(best.growth / 1e6).toFixed(2)}M in ${LOOKBACK_FRAMES}min | Rate: ${(best.growthRate / 1e6).toFixed(3)}M/min`);
      console.log(`      Sign: ${best.isPositive ? 'POSITIVE' : 'NEGATIVE'} | Entry delay: ${best.entryDelay} frames`);

      csvRows.push({
        date,
        move_start_frame: move.startFrame,
        move_end_frame: move.endFrame,
        move_start_price: move.startPrice.toFixed(2),
        move_end_price: move.endPrice.toFixed(2),
        move_pts: move.pts.toFixed(2),
        move_direction: move.direction,
        signal_node_strike: best.strike,
        signal_node_value_at_start: best.valueAtStart.toFixed(0),
        signal_node_growth_30m: best.growth.toFixed(0),
        signal_node_growth_rate: best.growthRate.toFixed(0),
        signal_node_dist_from_spot: best.distFromSpot.toFixed(1),
        signal_node_is_positive: best.isPositive ? 1 : 0,
        entry_delay_frames: best.entryDelay,
        optimal_entry_price: move.startPrice.toFixed(2),
        optimal_exit_price: move.endPrice.toFixed(2),
        duration_min: move.durationMin,
        move_start_time: startTime,
        move_end_time: endTime,
      });
    } else if (signals.topByGrowthRate.length > 0) {
      const best = signals.topByGrowthRate[0];
      console.log(`    SIGNAL (non-directional): Strike ${best.strike} (${best.distFromSpot > 0 ? '+' : ''}${best.distFromSpot.toFixed(0)}pts from spot)`);
      console.log(`      Value: ${(best.valueAtStart / 1e6).toFixed(2)}M | Growth: ${(best.growth / 1e6).toFixed(2)}M in ${LOOKBACK_FRAMES}min | Rate: ${(best.growthRate / 1e6).toFixed(3)}M/min`);
      console.log(`      Sign: ${best.isPositive ? 'POSITIVE' : 'NEGATIVE'} | Entry delay: ${best.entryDelay} frames`);

      csvRows.push({
        date,
        move_start_frame: move.startFrame,
        move_end_frame: move.endFrame,
        move_start_price: move.startPrice.toFixed(2),
        move_end_price: move.endPrice.toFixed(2),
        move_pts: move.pts.toFixed(2),
        move_direction: move.direction,
        signal_node_strike: best.strike,
        signal_node_value_at_start: best.valueAtStart.toFixed(0),
        signal_node_growth_30m: best.growth.toFixed(0),
        signal_node_growth_rate: best.growthRate.toFixed(0),
        signal_node_dist_from_spot: best.distFromSpot.toFixed(1),
        signal_node_is_positive: best.isPositive ? 1 : 0,
        entry_delay_frames: best.entryDelay,
        optimal_entry_price: move.startPrice.toFixed(2),
        optimal_exit_price: move.endPrice.toFixed(2),
        duration_min: move.durationMin,
        move_start_time: startTime,
        move_end_time: endTime,
      });
    } else {
      console.log(`    NO SIGNAL FOUND`);
    }

    // Show GEX structure at move start
    const structure = getGexStructure(move.startFrame, gammaHistory, spotHistory);
    console.log(`    GEX STRUCTURE at start: Net balance: ${(structure.netBalance / 1e6).toFixed(1)}M | Bias: ${structure.directionalBias}`);
    if (structure.posAbove) console.log(`      Pos above: ${structure.posAbove.strike} (${(structure.posAbove.value / 1e6).toFixed(1)}M, +${structure.posAbove.distFromSpot.toFixed(0)}pts)`);
    if (structure.posBelow) console.log(`      Pos below: ${structure.posBelow.strike} (${(structure.posBelow.value / 1e6).toFixed(1)}M, ${structure.posBelow.distFromSpot.toFixed(0)}pts)`);
    if (structure.negAbove) console.log(`      Neg above: ${structure.negAbove.strike} (${(structure.negAbove.value / 1e6).toFixed(1)}M, +${structure.negAbove.distFromSpot.toFixed(0)}pts)`);
    if (structure.negBelow) console.log(`      Neg below: ${structure.negBelow.strike} (${(structure.negBelow.value / 1e6).toFixed(1)}M, ${structure.negBelow.distFromSpot.toFixed(0)}pts)`);
    console.log();
  }

  // ---- Part 4: IDEAL trades ----
  console.log('\n--- IDEAL TRADES ---');

  // Calculate maximum possible capture
  let totalCapture = 0;
  for (const move of moves) {
    console.log(`  ${move.direction} trade: Entry ${move.startPrice.toFixed(1)} at ${formatTime(move.startTime)} → Exit ${move.endPrice.toFixed(1)} at ${formatTime(move.endTime)} = ${Math.abs(move.pts).toFixed(1)} pts`);
    totalCapture += Math.abs(move.pts);
  }
  console.log(`\n  TOTAL IDEAL CAPTURE: ${totalCapture.toFixed(1)} pts across ${moves.length} trades`);
  console.log(`  DAY RANGE: ${Math.abs(closePrice - openPrice).toFixed(1)} pts`);
  console.log(`  EFFICIENCY: ${(totalCapture / Math.max(1, Math.abs(closePrice - openPrice)) * 100).toFixed(0)}%`);

  return csvRows;
}

// ---- Extended analysis: what the signal looked like at each point ----

function extendedNodeAnalysis(filePath, label) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const frames = data.frames;
  const { gammaHistory, spotHistory } = buildGammaHistory(frames);
  const date = data.metadata?.date || filePath.match(/\d{4}-\d{2}-\d{2}/)?.[0];

  console.log(`\n${'='.repeat(80)}`);
  console.log(`EXTENDED NODE ANALYSIS: ${date} (${label})`);
  console.log('='.repeat(80));

  // For this day, track the top 3 fastest-growing nodes at every 10-min checkpoint
  // and show what happened to spot in the NEXT 30 minutes

  console.log('\nTime   Spot    | Node1 (strike:val:growth) | Node2 | Node3 | Spot +30m | Chg');

  const rows = [];

  for (let i = 30; i < frames.length - 30; i += 10) {
    const spot = spotHistory[i].spot;
    const spotFuture = spotHistory[Math.min(i + 30, frames.length - 1)].spot;
    const futureChg = spotFuture - spot;
    const time = formatTime(frames[i].timestamp);

    const topNodes = getTopGrowingNodes(i, gammaHistory, spotHistory);

    const nodeStrs = topNodes.slice(0, 3).map(n => {
      const sign = n.isPositive ? '+' : '-';
      const dir = n.distFromSpot > 0 ? 'A' : 'B'; // Above/Below
      return `${n.strike}${dir}:${sign}${(Math.abs(n.value)/1e6).toFixed(1)}M:${n.growth > 0 ? '+' : ''}${(n.growth/1e6).toFixed(1)}M`;
    });

    while (nodeStrs.length < 3) nodeStrs.push('---');

    console.log(`${time}  ${spot.toFixed(1)} | ${nodeStrs[0].padEnd(22)} | ${nodeStrs[1].padEnd(22)} | ${nodeStrs[2].padEnd(22)} | ${spotFuture.toFixed(1)} | ${futureChg >= 0 ? '+' : ''}${futureChg.toFixed(1)}`);

    // For each top node, record the signal and the outcome
    for (const node of topNodes.slice(0, 3)) {
      rows.push({
        date,
        time,
        frameIdx: i,
        spot: spot.toFixed(2),
        strike: node.strike,
        distFromSpot: node.distFromSpot.toFixed(1),
        nodeValue: node.value.toFixed(0),
        nodeGrowth30m: node.growth.toFixed(0),
        nodeGrowthRate: node.growthRate.toFixed(0),
        isPositive: node.isPositive ? 1 : 0,
        spotIn30m: spotFuture.toFixed(2),
        spotChange30m: futureChg.toFixed(2),
        direction30m: futureChg > 5 ? 'UP' : futureChg < -5 ? 'DOWN' : 'FLAT',
      });
    }
  }

  return rows;
}

// ---- Main execution ----

console.log('GEX OPTIMAL TRADE ANALYZER');
console.log('Analyzing 7 days of GEX replay data\n');

let allCsvRows = [];
let allNodeRows = [];

for (const { file, label } of FILES) {
  const csvRows = analyzeDay(file, label);
  allCsvRows.push(...csvRows);

  const nodeRows = extendedNodeAnalysis(file, label);
  allNodeRows.push(...nodeRows);
}

// ---- Write CSV outputs ----

// Main CSV: moves and their signals
const csvHeader = 'date,move_start_frame,move_end_frame,move_start_price,move_end_price,move_pts,move_direction,signal_node_strike,signal_node_value_at_start,signal_node_growth_30m,signal_node_growth_rate,signal_node_dist_from_spot,signal_node_is_positive,entry_delay_frames,optimal_entry_price,optimal_exit_price,duration_min,move_start_time,move_end_time';
const csvLines = allCsvRows.map(r =>
  `${r.date},${r.move_start_frame},${r.move_end_frame},${r.move_start_price},${r.move_end_price},${r.move_pts},${r.move_direction},${r.signal_node_strike},${r.signal_node_value_at_start},${r.signal_node_growth_30m},${r.signal_node_growth_rate},${r.signal_node_dist_from_spot},${r.signal_node_is_positive},${r.entry_delay_frames},${r.optimal_entry_price},${r.optimal_exit_price},${r.duration_min},${r.move_start_time},${r.move_end_time}`
);
writeFileSync('data/optimal-trades.csv', [csvHeader, ...csvLines].join('\n'));
console.log(`\nWrote ${allCsvRows.length} trade signals to data/optimal-trades.csv`);

// Node signal CSV: every 10-min checkpoint with top nodes and future outcome
const nodeHeader = 'date,time,frameIdx,spot,strike,distFromSpot,nodeValue,nodeGrowth30m,nodeGrowthRate,isPositive,spotIn30m,spotChange30m,direction30m';
const nodeLines = allNodeRows.map(r =>
  `${r.date},${r.time},${r.frameIdx},${r.spot},${r.strike},${r.distFromSpot},${r.nodeValue},${r.nodeGrowth30m},${r.nodeGrowthRate},${r.isPositive},${r.spotIn30m},${r.spotChange30m},${r.direction30m}`
);
writeFileSync('data/node-signals.csv', [nodeHeader, ...nodeLines].join('\n'));
console.log(`Wrote ${allNodeRows.length} node signal observations to data/node-signals.csv`);

// ---- Summary across all days ----
console.log('\n' + '='.repeat(80));
console.log('CROSS-DAY SUMMARY');
console.log('='.repeat(80));

console.log(`\nTotal significant moves found: ${allCsvRows.length}`);
console.log(`UP moves: ${allCsvRows.filter(r => r.move_direction === 'UP').length}`);
console.log(`DOWN moves: ${allCsvRows.filter(r => r.move_direction === 'DOWN').length}`);

const avgGrowthRate = allCsvRows.reduce((s, r) => s + Math.abs(parseFloat(r.signal_node_growth_rate)), 0) / allCsvRows.length;
const avgEntryDelay = allCsvRows.reduce((s, r) => s + r.entry_delay_frames, 0) / allCsvRows.length;
const avgDist = allCsvRows.reduce((s, r) => s + Math.abs(parseFloat(r.signal_node_dist_from_spot)), 0) / allCsvRows.length;
const pctPositive = allCsvRows.filter(r => r.signal_node_is_positive === 1).length / allCsvRows.length * 100;

console.log(`\nAvg signal node growth rate: ${avgGrowthRate.toFixed(0)} per frame`);
console.log(`Avg entry delay (signal → move): ${avgEntryDelay.toFixed(1)} frames`);
console.log(`Avg node distance from spot: ${avgDist.toFixed(1)} pts`);
console.log(`Positive node signals: ${pctPositive.toFixed(1)}%`);
console.log(`Avg move size: ${(allCsvRows.reduce((s, r) => s + Math.abs(parseFloat(r.move_pts)), 0) / allCsvRows.length).toFixed(1)} pts`);
console.log(`Avg move duration: ${(allCsvRows.reduce((s, r) => s + r.duration_min, 0) / allCsvRows.length).toFixed(1)} min`);
