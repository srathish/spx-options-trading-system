/**
 * Velocity-Based King Node Migration Strategy
 *
 * Watches which gamma nodes are GROWING fastest (not just biggest).
 * When a new node starts building away from spot, enter in that direction.
 * When price reaches the node (or it stops growing), exit.
 * Look for the next building node and enter again.
 *
 * Usage:
 *   node src/backtest/replay-velocity.js data/gex-replay-2026-03-20.json
 *   node src/backtest/replay-velocity.js --batch data/gex-replay-2026-*.json
 */

import { readFileSync } from 'fs';
import { parseGexResponse } from '../gex/gex-parser.js';

function frameToRaw(frame) {
  return { CurrentSpot: frame.spotPrice, Strikes: frame.strikes, GammaValues: frame.gammaValues };
}

function replayVelocity(jsonPath, verbose = false) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity';

  // Track gamma at each strike over the ENTIRE day — full memory
  const strikeHistory = new Map(); // strike → [{ frame, value }]
  let openPrice = 0, hod = -Infinity, lod = Infinity;
  let position = null;
  const trades = [];

  // Track the dominant growing node
  let prevTopGrower = null;
  let dirStops = { BULLISH: 0, BEARISH: 0 }; // stop after 2 stops in same direction
  let totalTradesToday = 0; // cap at 2 trades per day

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

    const minuteOfDay = (() => {
      if (frame.timestamp) {
        const d = new Date(frame.timestamp);
        const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        return et.getHours() * 60 + et.getMinutes();
      }
      return 570 + i;
    })();

    // ---- Update strike history (every frame, full day) ----
    for (const strike of parsed.strikes) {
      const gex = parsed.aggregatedGex.get(strike) || 0;
      if (Math.abs(strike - spot) > 150) continue;
      if (!strikeHistory.has(strike)) strikeHistory.set(strike, []);
      strikeHistory.get(strike).push({ frame: i, value: Math.abs(gex) });
    }

    // ---- Find fastest growing node (positive OR negative) ----
    // A positive node growing above spot pulls price UP (dealers hedge toward it)
    // A negative node growing below spot pulls price DOWN (magnet attraction)
    // Either way — follow the growth, that's where the money is going
    let topGrower = null;
    let topGrowthRate = 0;

    for (const [strike, hist] of strikeHistory) {
      if (hist.length < 10) continue;
      const current = hist[hist.length - 1].value;
      const past = hist[hist.length - 10].value; // 10 frames ago
      if (past < 2_000_000) continue; // ignore tiny strikes
      if (current < 5_000_000) continue; // must be significant now

      const growth = past > 0 ? (current - past) / past : 0;
      const dist = strike - spot;
      const absDist = Math.abs(dist);

      // Must be 15-80pts from spot (not at spot, not too far)
      if (absDist < 15 || absDist > 80) continue;

      // Direction: price moves TOWARD the growing node regardless of sign
      // Positive node above = bullish (pin pulls price up)
      // Negative node above = bullish (magnet pulls price up)
      // Positive node below = bearish (pin pulls price down)
      // Negative node below = bearish (magnet pulls price down)
      const direction = dist > 0 ? 'BULLISH' : 'BEARISH';

      // Prefer faster growth AND bigger absolute value
      const score = growth * (current / 10_000_000); // weight by size
      if (score > topGrowthRate) {
        topGrowthRate = score;
        topGrower = { strike, value: current, growth, dist, direction, absDist, rawGrowth: growth };
      }
    }

    // ---- Manage open position ----
    if (position) {
      const isBull = position.direction === 'BULLISH';
      const progress = isBull ? spot - position.entrySpx : position.entrySpx - spot;
      if (progress > position.mfe) position.mfe = progress;
      if (progress < position.mae) position.mae = progress;

      let exitReason = null;

      // Target: price reached the growing node
      // BUT — if there's a NEW node building further in same direction, shift target instead of exiting
      if (position.targetStrike) {
        const hit = isBull ? spot >= position.targetStrike - 5 : spot <= position.targetStrike + 5;
        if (hit) {
          // Check: is there a bigger node building further in our direction?
          let nextNode = null;
          for (const [strike, hist] of strikeHistory) {
            if (hist.length < 10) continue;
            const current = hist[hist.length - 1].value;
            const ago = hist[Math.max(0, hist.length - 10)].value;
            const growth = ago > 0 ? (current - ago) / ago : 0;
            if (current < 8_000_000 || growth < 0.2) continue;

            const nodeDist = strike - spot;
            // Must be further in our direction
            if (isBull && nodeDist > 15 && nodeDist < 80 && strike > position.targetStrike) {
              if (!nextNode || current > nextNode.value) {
                nextNode = { strike, value: current, growth };
              }
            }
            if (!isBull && nodeDist < -15 && nodeDist > -80 && strike < position.targetStrike) {
              if (!nextNode || current > nextNode.value) {
                nextNode = { strike, value: current, growth };
              }
            }
          }

          if (nextNode) {
            // Shift target — don't exit, keep holding
            if (verbose) {
              const time = `${Math.floor(minuteOfDay/60)}:${String(minuteOfDay%60).padStart(2,'0')}`;
              console.log(`  SHIFT ${time} | target ${position.targetStrike} → ${nextNode.strike} | ${(nextNode.value/1e6).toFixed(1)}M growing ${(nextNode.growth*100).toFixed(0)}% | progress=${progress.toFixed(1)}`);
            }
            position.targetStrike = nextNode.strike;
          } else {
            exitReason = 'TARGET_HIT';
          }
        }
      }

      // Check if our target node is still growing
      // Check if target node is alive using full-day trend
      const targetHist = strikeHistory.get(position.targetStrike);
      let targetAlive = true;
      if (targetHist && targetHist.length >= 10) {
        const now = targetHist[targetHist.length - 1].value;
        const peak = Math.max(...targetHist.slice(-60).map(h => h.value)); // peak in last 60 frames
        const atEntry = targetHist.find(h => h.frame >= position.entryFrame)?.value || now;

        // Node is dead if BOTH conditions:
        // 1. Shrunk 40%+ from its peak
        // 2. Shrunk below its value when we entered
        const shrunkFromPeak = now < peak * 0.60;
        const shrunkFromEntry = now < atEntry * 0.80;
        targetAlive = !(shrunkFromPeak && shrunkFromEntry);
      }

      // Node alive → HOLD. Only exit on target hit or hard stop.
      // Node dead → take profit or cut.
      if (!targetAlive) {
        if (!exitReason && progress >= 5) exitReason = 'NODE_DIED_PROFIT';
        if (!exitReason && progress >= 0) exitReason = 'NODE_DIED_FLAT';
        if (!exitReason) exitReason = 'NODE_DIED_CUT';
      }

      // Stop: -12 pts always
      if (!exitReason && progress <= -12) exitReason = 'STOP_HIT';

      // EOD
      if (!exitReason && minuteOfDay >= 945) exitReason = 'EOD_CLOSE';

      if (exitReason) {
        const pnl = exitReason === 'STOP_HIT' ? -12
          : exitReason === 'TRAIL_BE' ? Math.round(progress * 100) / 100
          : Math.round(progress * 100) / 100;
        trades.push({
          direction: position.direction, entrySpx: position.entrySpx, exitSpx: spot,
          targetStrike: position.targetStrike, pnl, exitReason,
          mfe: Math.round(position.mfe * 100) / 100,
          mae: Math.round(position.mae * 100) / 100,
          entryFrame: position.entryFrame, exitFrame: i,
        });
        if (exitReason === 'STOP_HIT') dirStops[position.direction]++;
        totalTradesToday++;
        if (verbose) {
          const tag = pnl > 0 ? 'WIN' : pnl === 0 ? 'BE' : 'LOSS';
          const time = `${Math.floor(minuteOfDay/60)}:${String(minuteOfDay%60).padStart(2,'0')}`;
          console.log(`  EXIT  ${time} | ${position.direction} ${exitReason} | ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} pts | MFE=${position.mfe.toFixed(1)} | ${tag}`);
        }
        position = null;
      }
    }

    // ---- Entry: detect a strong growing node ----
    // Only trade after 10:00 (need 30 min of data for velocity + direction confirmation)
    if (!position && i >= 30 && minuteOfDay >= 600 && minuteOfDay <= 930 && totalTradesToday < 2) {

      // Need a STRONG grower: growth score >= 0.5 (growth rate × size weighting)
      // AND raw growth >= 30% AND value >= 8M
      if (topGrower && topGrowthRate >= 0.5 && topGrower.rawGrowth >= 0.3 && topGrower.value >= 8_000_000) {

        // Cooldown: at least 15 frames (15 min) between trades
        const lastTrade = trades[trades.length - 1];
        const cooldown = lastTrade && (i - lastTrade.exitFrame) < 15;
        const sameNode = lastTrade && lastTrade.targetStrike === topGrower.strike;

        // 2 stops in same direction = stop trading that direction today
        const dirBlocked = dirStops[topGrower.direction] >= 2;
        if (!sameNode && !cooldown && !dirBlocked) {
          position = {
            direction: topGrower.direction,
            entrySpx: spot,
            targetStrike: topGrower.strike,
            entryFrame: i,
            mfe: 0, mae: 0,
          };
          if (verbose) {
            const time = `${Math.floor(minuteOfDay/60)}:${String(minuteOfDay%60).padStart(2,'0')}`;
            console.log(`  ENTER ${time} | ${topGrower.direction} @ $${Math.round(spot)} → ${topGrower.strike} | growth=${(topGrower.rawGrowth*100).toFixed(0)}% score=${topGrowthRate.toFixed(1)} | ${(topGrower.value/1e6).toFixed(1)}M | ${topGrower.absDist.toFixed(0)}pts`);
          }
        }
      }
    }

    prevTopGrower = topGrower;
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
      mfe: Math.round(position.mfe * 100) / 100, mae: Math.round(position.mae * 100) / 100,
      entryFrame: position.entryFrame, exitFrame: frames.length - 1,
    });
    position = null;
  }

  // Results
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const be = trades.filter(t => t.pnl === 0).length;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const dayMove = (() => {
    const lastSpxw = isTrinity ? frames[frames.length - 1]?.tickers?.SPXW : frames[frames.length - 1];
    return ((lastSpxw?.spotPrice || openPrice) - openPrice);
  })();

  console.log(`${dateStr} | SPX ${dayMove >= 0 ? '+' : ''}${dayMove.toFixed(0)} | ${trades.length} trades (${wins}W/${losses}L/${be}BE) | NET: ${netPnl > 0 ? '+' : ''}${netPnl.toFixed(2)} pts`);
  if (verbose || trades.length <= 10) {
    for (const t of trades) {
      console.log(`  ${t.direction.padEnd(7)} $${Math.round(t.entrySpx)} → ${t.targetStrike} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)} | ${t.exitReason} | MFE=${t.mfe} MAE=${t.mae}`);
    }
  }

  return { date: dateStr, trades, netPnl, wins, losses, dayMove };
}

// ---- CLI ----
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const isBatch = args.includes('--batch');
const files = args.filter(a => !a.startsWith('--') && a.endsWith('.json'));

if (files.length === 0) {
  console.log('Usage: node src/backtest/replay-velocity.js [--verbose] [--batch] <file.json ...>');
  process.exit(1);
}

const allResults = [];
for (const file of files) {
  try {
    allResults.push(replayVelocity(file, verbose));
  } catch (err) {
    console.error(`ERROR ${file}: ${err.message}`);
  }
}

if (isBatch && allResults.length > 1) {
  const allTrades = allResults.flatMap(r => r.trades);
  const totalWins = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl < 0).length;
  const totalBE = allTrades.filter(t => t.pnl === 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`VELOCITY STRATEGY: ${allResults.length} days`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Trades: ${allTrades.length} (${totalWins}W/${totalLosses}L/${totalBE}BE) | NET: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
  console.log(`Avg trades/day: ${(allTrades.length / allResults.length).toFixed(1)}`);
  if (totalWins > 0 && totalLosses > 0) {
    const avgWin = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / totalWins;
    const avgLoss = allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / totalLosses;
    console.log(`Avg Win: +${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)} | R:R ${(avgWin / Math.abs(avgLoss)).toFixed(2)}`);
  }

  const exits = {};
  for (const t of allTrades) {
    if (!exits[t.exitReason]) exits[t.exitReason] = { count: 0, pnl: 0 };
    exits[t.exitReason].count++;
    exits[t.exitReason].pnl += t.pnl;
  }
  console.log('\nExits:');
  for (const [reason, d] of Object.entries(exits).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason.padEnd(14)} ${d.count} trades | ${d.pnl > 0 ? '+' : ''}${d.pnl.toFixed(2)} pts`);
  }

  // Best/worst days
  const sorted = [...allResults].sort((a, b) => b.netPnl - a.netPnl);
  console.log('\nTop 5 days:');
  for (const r of sorted.slice(0, 5)) {
    console.log(`  ${r.date}: ${r.netPnl > 0 ? '+' : ''}${r.netPnl.toFixed(2)} (${r.trades.length} trades, SPX ${r.dayMove >= 0 ? '+' : ''}${r.dayMove.toFixed(0)})`);
  }
  console.log('Worst 5 days:');
  for (const r of sorted.slice(-5).reverse()) {
    console.log(`  ${r.date}: ${r.netPnl > 0 ? '+' : ''}${r.netPnl.toFixed(2)} (${r.trades.length} trades, SPX ${r.dayMove >= 0 ? '+' : ''}${r.dayMove.toFixed(0)})`);
  }
}
