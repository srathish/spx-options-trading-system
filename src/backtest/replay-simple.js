/**
 * Lane C — Simple King Node Strategy
 *
 * 5 rules:
 * 1. One entry per direction per day. Find king node. Enter once. Hold to target or stop.
 * 2. 12pt stop, not 5.
 * 3. Velocity confirms: king node must be growing (not shrinking).
 * 4. Morning ML decides mode: < 0.3 sit out, > 0.5 trade aggressively.
 * 5. No old pattern engine. King node is the only signal.
 *
 * Usage:
 *   node src/backtest/replay-simple.js data/gex-replay-2026-03-20.json
 *   node src/backtest/replay-simple.js --batch data/gex-replay-2026-*.json
 */

import { readFileSync } from 'fs';
import { parseGexResponse } from '../gex/gex-parser.js';

function frameToRaw(frame) {
  return {
    CurrentSpot: frame.spotPrice,
    Strikes: frame.strikes,
    GammaValues: frame.gammaValues,
  };
}

function findKingNode(parsed) {
  const spot = parsed.spotPrice;
  if (!spot) return null;

  let kingStrike = null, kingValue = 0, kingAbsValue = 0;
  let totalAbsGamma = 0;

  for (const strike of parsed.strikes) {
    const gex = parsed.aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    totalAbsGamma += absGex;
    if (absGex > kingAbsValue && Math.abs(strike - spot) < 200) {
      kingStrike = strike; kingValue = gex; kingAbsValue = absGex;
    }
  }
  if (!kingStrike) return null;

  return { strike: kingStrike, value: kingValue, absValue: kingAbsValue, dist: kingStrike - spot, totalAbsGamma };
}

// ---- Core replay ----
function replaySimple(jsonPath, verbose = false) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity';

  // State
  let openPrice = 0, hod = -Infinity, lod = Infinity;
  let position = null;
  const trades = [];
  const enteredDirs = new Set(); // rule 1: one entry per direction
  let prevKingValue = 0; // for velocity check

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const spxwData = isTrinity ? frame.tickers?.SPXW : frame;
    if (!spxwData?.spotPrice || !spxwData?.gammaValues) continue;

    const parsed = parseGexResponse(frameToRaw(spxwData));
    const spot = parsed.spotPrice;
    if (!spot) continue;

    if (openPrice === 0) openPrice = spot;
    if (spot > hod) hod = spot;
    if (spot < lod) lod = spot;

    const king = findKingNode(parsed);
    if (!king) continue;

    const minuteOfDay = (() => {
      if (frame.timestamp) {
        const d = new Date(frame.timestamp);
        const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        return et.getHours() * 60 + et.getMinutes();
      }
      // Fallback: frame index → time (9:30 + 1min/frame)
      return 570 + i;
    })();

    // ---- Manage open position ----
    if (position) {
      const isBull = position.direction === 'BULLISH';
      const progress = isBull ? spot - position.entrySpx : position.entrySpx - spot;
      if (progress > position.mfe) position.mfe = progress;
      if (progress < position.mae) position.mae = progress;

      let exitReason = null;

      // Target hit: within 5pts of king node
      if (position.targetStrike) {
        const hit = isBull ? spot >= position.targetStrike - 5 : spot <= position.targetStrike + 5;
        if (hit) exitReason = 'TARGET_HIT';
      }

      // Trailing stop: once +15, move stop to breakeven
      if (!exitReason && position.mfe >= 15 && progress <= 0) exitReason = 'TRAIL_BE';

      // Initial stop: -12 pts (only if never reached +15)
      if (!exitReason && position.mfe < 15 && progress <= -12) exitReason = 'STOP_HIT';

      // EOD: 3:45 PM
      if (!exitReason && minuteOfDay >= 945) exitReason = 'EOD_CLOSE';

      if (exitReason) {
        const pnl = exitReason === 'STOP_HIT' ? -12 : exitReason === 'TRAIL_BE' ? 0 : Math.round(progress * 100) / 100;
        trades.push({
          direction: position.direction,
          entrySpx: position.entrySpx,
          exitSpx: spot,
          targetStrike: position.targetStrike,
          pnl,
          exitReason,
          openedAt: position.openedAt,
          closedAt: `frame-${i}`,
          mfe: Math.round(position.mfe * 100) / 100,
          mae: Math.round(position.mae * 100) / 100,
        });
        if (verbose) {
          const tag = pnl > 0 ? 'WIN' : 'LOSS';
          console.log(`  EXIT  ${minuteOfDay} | ${position.direction} ${exitReason} | ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} pts | ${tag}`);
        }
        position = null;
      }
    }

    // ---- Entry logic: simple king node ----
    // Rule: only enter between 9:50 and 3:00
    if (!position && minuteOfDay >= 590 && minuteOfDay <= 900) {

      const dist = king.strike - spot;
      const absDist = Math.abs(dist);
      const direction = dist > 0 ? 'BULLISH' : 'BEARISH';

      // Rule 1: one entry per direction per day
      if (enteredDirs.has(direction)) {
        prevKingValue = king.absValue;
        continue;
      }

      // Rule: king node must be at least 15pts away (not already at target)
      if (absDist < 15) {
        prevKingValue = king.absValue;
        continue;
      }

      // Rule: king node must be significant (>= 5M absolute gamma)
      if (king.absValue < 5_000_000) {
        prevKingValue = king.absValue;
        continue;
      }

      // Rule 3: velocity — king must be growing or stable, not shrinking
      // Compare to previous frame's king value at same strike
      const growing = prevKingValue === 0 || king.absValue >= prevKingValue * 0.9; // not shrinking >10%

      // Rule: need 20+ frames of data (10:00 AM minimum)
      if (i < 20) {
        prevKingValue = king.absValue;
        continue;
      }

      if (growing) {
        position = {
          direction,
          entrySpx: spot,
          targetStrike: king.strike,
          openedAt: `frame-${i}`,
          mfe: 0,
          mae: 0,
        };
        enteredDirs.add(direction);
        if (verbose) {
          console.log(`  ENTER ${minuteOfDay} | ${direction} @ $${Math.round(spot)} → ${king.strike} (${absDist.toFixed(0)}pts, ${(king.value/1e6).toFixed(1)}M)`);
        }
      }
    }

    prevKingValue = king.absValue;
  }

  // Force close at EOD
  if (position) {
    const lastSpxw = isTrinity ? frames[frames.length - 1]?.tickers?.SPXW : frames[frames.length - 1];
    const lastSpot = lastSpxw?.spotPrice || position.entrySpx;
    const isBull = position.direction === 'BULLISH';
    const pnl = Math.round((isBull ? lastSpot - position.entrySpx : position.entrySpx - lastSpot) * 100) / 100;
    trades.push({
      direction: position.direction, entrySpx: position.entrySpx, exitSpx: lastSpot,
      targetStrike: position.targetStrike, pnl, exitReason: 'EOD_FORCE',
      openedAt: position.openedAt, closedAt: 'EOD',
      mfe: Math.round(position.mfe * 100) / 100, mae: Math.round(position.mae * 100) / 100,
    });
    position = null;
  }

  // Results
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const dayMove = hod !== -Infinity ? ((() => {
    const lastSpxw = isTrinity ? frames[frames.length - 1]?.tickers?.SPXW : frames[frames.length - 1];
    return (lastSpxw?.spotPrice || openPrice) - openPrice;
  })()) : 0;

  console.log(`${dateStr} | SPX ${dayMove >= 0 ? '+' : ''}${dayMove.toFixed(0)} | ${trades.length} trades (${wins}W/${losses}L) | NET: ${netPnl > 0 ? '+' : ''}${netPnl.toFixed(2)} pts`);
  for (const t of trades) {
    console.log(`  ${t.openedAt} → ${t.closedAt} | ${t.direction} → ${t.targetStrike} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)} | ${t.exitReason} | MFE=${t.mfe} MAE=${t.mae}`);
  }

  return { date: dateStr, trades, netPnl, wins, losses };
}

// ---- CLI ----
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const isBatch = args.includes('--batch');
const files = args.filter(a => !a.startsWith('--') && a.endsWith('.json'));

if (files.length === 0) {
  console.log('Usage: node src/backtest/replay-simple.js [--verbose] [--batch] <file.json ...>');
  process.exit(1);
}

const allResults = [];
for (const file of files) {
  try {
    allResults.push(replaySimple(file, verbose));
  } catch (err) {
    console.error(`ERROR on ${file}: ${err.message}`);
  }
}

if (isBatch && allResults.length > 1) {
  const totalTrades = allResults.reduce((s, r) => s + r.trades.length, 0);
  const totalWins = allResults.reduce((s, r) => s + r.wins, 0);
  const totalLosses = allResults.reduce((s, r) => s + r.losses, 0);
  const totalPnl = allResults.reduce((s, r) => s + r.netPnl, 0);
  const tradeDays = allResults.filter(r => r.trades.length > 0).length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`LANE C SIMPLE: ${allResults.length} days`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Trades: ${totalTrades} (${totalWins}W/${totalLosses}L) | NET: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
  console.log(`Trade days: ${tradeDays} | Flat days: ${allResults.length - tradeDays}`);
  if (totalWins > 0 && totalLosses > 0) {
    const allTrades = allResults.flatMap(r => r.trades);
    const avgWin = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / totalWins;
    const avgLoss = allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / totalLosses;
    console.log(`Avg Win: +${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)} | R:R ${(avgWin / Math.abs(avgLoss)).toFixed(2)}`);
  }

  // Exit breakdown
  const allTrades = allResults.flatMap(r => r.trades);
  const exits = {};
  for (const t of allTrades) {
    if (!exits[t.exitReason]) exits[t.exitReason] = { count: 0, pnl: 0 };
    exits[t.exitReason].count++;
    exits[t.exitReason].pnl += t.pnl;
  }
  console.log('\nExits:');
  for (const [reason, data] of Object.entries(exits).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason.padEnd(12)} ${data.count} trades | ${data.pnl > 0 ? '+' : ''}${data.pnl.toFixed(2)} pts`);
  }
}
