/**
 * King Node Thesis Replay
 *
 * Simple, standalone strategy: find the king node (biggest gamma wall on SPXW),
 * enter toward it if it's far from spot and growing, hold until price reaches it
 * or the thesis breaks. No entry gates, no conviction scoring, no trend detection.
 *
 * Usage:
 *   node src/backtest/replay-king-node.js data/gex-replay-2026-03-20.json
 *   node src/backtest/replay-king-node.js --batch data/gex-replay-*.json
 *   node src/backtest/replay-king-node.js data/gex-replay-2026-03-20.json --verbose
 */

import { readFileSync } from 'fs';
import { DateTime } from 'luxon';
import { parseGexResponse } from '../gex/gex-parser.js';

// ---- Config (all tunable params in one place) ----

const CONFIG = {
  // Entry — only trade "Mar 20" type days where one big node builds all day
  min_distance_pts: 30,         // king node must be >30 pts from spot (real magnet, not nearby noise)
  min_king_value: 30_000_000,   // king node must be >$30M — fully established, not just forming
  min_growth_lookback_min: 20,  // must have been growing for 20+ min (not a spike)
  entry_start_time: '09:50',    // don't enter in first 20 min — let nodes establish
  entry_end_time: '15:00',      // no new entries after 3:00 PM (need time for price to reach target)
  king_stability_min: 15,       // king must stay at same strike for 15+ min (anti-chop)
  max_king_flips: 2,            // if king node has flipped sides >2 times today, don't trade (chop day)

  // Exit
  target_proximity_pts: 5,      // exit when price within 5 pts of king node
  thesis_broken_drop_pct: 0.40, // (legacy) exit if king value drops >40% from peak
  nodes_below_min_value: 15_000_000, // nodes below spot must total >$15M to hold
  nodes_building_lookback: 10,       // compare node total to N minutes ago
  max_loss_pts: 15,             // hard stop: 15 pts from entry
  eod_exit_time: '15:45',       // force close at 3:45 PM

  // Re-entry
  reentry_cooldown_min: 5,      // wait 5 min after stop-out before re-entering
  max_trades_per_day: 5,        // cap total trades per day
};

// ---- Frame helpers ----

function frameToRaw(frame) {
  return {
    CurrentSpot: frame.spotPrice,
    Strikes: frame.strikes,
    GammaValues: frame.gammaValues,
    VannaValues: frame.vannaValues || [],
    Expirations: frame.expirations || [],
    GammaMaxValue: frame.gammaMaxValue || 0,
    GammaMinValue: frame.gammaMinValue || 0,
  };
}

function frameTimestampToET(utcTimestamp) {
  return DateTime.fromISO(utcTimestamp, { zone: 'UTC' }).setZone('America/New_York');
}

function isTrinityFrame(frame) {
  return frame.tickers && typeof frame.tickers === 'object';
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function fmtVal(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '+';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ---- Find king node: strike with biggest absolute 0DTE gamma ----

function findKingNode(parsed) {
  const { aggregatedGex, strikes, spotPrice } = parsed;
  let kingStrike = null;
  let kingValue = 0;
  let kingAbsValue = 0;

  for (const strike of strikes) {
    const gex = aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    if (absGex > kingAbsValue) {
      kingAbsValue = absGex;
      kingValue = gex;
      kingStrike = strike;
    }
  }

  if (kingStrike === null) return null;

  return {
    strike: kingStrike,
    value: kingValue,
    absValue: kingAbsValue,
    distanceFromSpot: kingStrike - spotPrice,  // positive = above, negative = below
    absDistance: Math.abs(kingStrike - spotPrice),
  };
}

// ---- Measure nodes building on one side of spot ----
// "As long as I see nodes building below spot, I hold my puts"

function measureNodesBuildingSide(parsed, direction) {
  const { aggregatedGex, strikes, spotPrice } = parsed;
  let totalNegGamma = 0;  // sum of absolute negative gamma on our side
  let nodeCount = 0;
  let biggestNode = { strike: 0, value: 0 };

  for (const strike of strikes) {
    const gex = aggregatedGex.get(strike) || 0;
    if (gex >= 0) continue; // only care about negative gamma (magnets)

    const absGex = Math.abs(gex);
    if (absGex < 2_000_000) continue; // ignore tiny nodes

    const isOnOurSide = direction === 'BEARISH' ? strike < spotPrice : strike > spotPrice;
    if (!isOnOurSide) continue;

    const dist = Math.abs(strike - spotPrice);
    if (dist > 150) continue; // within 150 pts

    totalNegGamma += absGex;
    nodeCount++;
    if (absGex > biggestNode.value) {
      biggestNode = { strike, value: absGex };
    }
  }

  return { totalNegGamma, nodeCount, biggestNode };
}

// ---- Core replay ----

function replayKingNode(jsonPath, verbose = false) {
  const rawJson = readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(rawJson);
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity' || (frames.length > 0 && isTrinityFrame(frames[0]));

  if (verbose) console.log(`\n[KingNode] Loaded ${frames.length} frames for ${dateStr} (${isTrinity ? 'trinity' : 'SPXW-only'})`);

  // State
  const state = {
    position: null,
    trades: [],
    kingNodeHistory: [],    // rolling window: { timestamp, strike, value, absValue }
    peakKingValue: 0,       // highest absValue of the CURRENT king node since entry
    peakKingStrike: null,   // strike of the king node we're tracking
    lastExitMs: 0,          // timestamp of last exit (for cooldown)
    kingFlipCount: 0,       // how many times king node crossed from below→above or above→below spot
    lastKingSide: null,     // 'above' or 'below' — for flip detection
  };

  const entryStartMin = timeToMinutes(CONFIG.entry_start_time);
  const entryEndMin = timeToMinutes(CONFIG.entry_end_time);
  const eodMin = timeToMinutes(CONFIG.eod_exit_time);

  for (const frame of frames) {
    // Extract SPXW data
    let spxwData;
    if (isTrinity) {
      spxwData = frame.tickers?.SPXW;
      if (!spxwData?.spotPrice || !spxwData?.gammaValues) continue;
    } else {
      spxwData = frame;
      if (!spxwData.spotPrice || !spxwData.gammaValues) continue;
    }

    const et = frameTimestampToET(frame.timestamp);
    const etStr = et.toFormat('yyyy-MM-dd HH:mm:ss');
    const minuteOfDay = et.hour * 60 + et.minute;
    const currentMs = et.toMillis();

    // Parse GEX
    const raw = frameToRaw(spxwData);
    const parsed = parseGexResponse(raw);
    const spot = parsed.spotPrice;

    // Find king node this frame
    const king = findKingNode(parsed);
    if (!king) continue;

    // Track king node side flips (chop detection)
    const currentSide = king.strike > spot ? 'above' : king.strike < spot - 5 ? 'below' : 'at';
    if (state.lastKingSide && currentSide !== 'at' && currentSide !== state.lastKingSide) {
      state.kingFlipCount++;
    }
    if (currentSide !== 'at') state.lastKingSide = currentSide;

    // Save to history (rolling window for growth check)
    state.kingNodeHistory.push({
      timestamp: currentMs,
      strike: king.strike,
      value: king.value,
      absValue: king.absValue,
    });
    // Keep last 30 min of history
    const historyWindowMs = 30 * 60 * 1000;
    while (state.kingNodeHistory.length > 0 &&
           currentMs - state.kingNodeHistory[0].timestamp > historyWindowMs) {
      state.kingNodeHistory.shift();
    }

    if (verbose && minuteOfDay % 15 === 0) {
      console.log(`  ${etStr} | spot=$${spot.toFixed(0)} | king=${king.strike} ${fmtVal(king.value)} | dist=${king.distanceFromSpot > 0 ? '+' : ''}${king.distanceFromSpot.toFixed(0)}pts`);
    }

    // ---- EXIT CHECK (if in position) ----
    if (state.position) {
      const pos = state.position;
      const isBullish = pos.direction === 'BULLISH';
      const progress = isBullish ? spot - pos.entrySpx : pos.entrySpx - spot;

      // Track best/worst
      if (progress > pos.bestProgress) pos.bestProgress = progress;
      if (progress < pos.worstProgress) pos.worstProgress = progress;

      // Update peak king value for the king node we're tracking
      // The king node we care about is the one at our TARGET strike (or close)
      // If king node shifted to a strike closer to spot, update target
      if (king.absValue > state.peakKingValue && king.strike === pos.targetStrike) {
        state.peakKingValue = king.absValue;
      }

      // Also track if the king node is the same strike we entered on
      const trackingStrike = pos.targetStrike;
      const trackingValue = parsed.aggregatedGex.get(trackingStrike) || 0;
      const trackingAbsValue = Math.abs(trackingValue);
      if (trackingAbsValue > state.peakKingValue) {
        state.peakKingValue = trackingAbsValue;
      }

      let exitReason = null;
      let exitPrice = spot;

      // 1. TARGET: price within target_proximity_pts of king node
      if (isBullish && spot >= pos.targetStrike - CONFIG.target_proximity_pts) {
        exitReason = 'TARGET_HIT';
      } else if (!isBullish && spot <= pos.targetStrike + CONFIG.target_proximity_pts) {
        exitReason = 'TARGET_HIT';
      }

      // 2. THESIS CHECK: are nodes still building on our side?
      // "As long as I see nodes building below spot, I hold my puts"
      // Only exit if nodes have STOPPED building — total negative gamma on our side
      // dropped below threshold AND is shrinking vs 10 minutes ago
      if (!exitReason) {
        const sideNodes = measureNodesBuildingSide(parsed, pos.direction);
        // Track node total history for this trade
        if (!pos._nodeHistory) pos._nodeHistory = [];
        pos._nodeHistory.push({ total: sideNodes.totalNegGamma, ts: minuteOfDay });
        // Trim to last 30 readings
        while (pos._nodeHistory.length > 30) pos._nodeHistory.shift();

        const lookbackIdx = Math.max(0, pos._nodeHistory.length - CONFIG.nodes_building_lookback - 1);
        const pastTotal = pos._nodeHistory[lookbackIdx]?.total || sideNodes.totalNegGamma;
        const isShrinking = sideNodes.totalNegGamma < pastTotal * 0.70; // dropped >30%
        const isBelowMin = sideNodes.totalNegGamma < CONFIG.nodes_below_min_value;

        if (isShrinking && isBelowMin) {
          exitReason = 'THESIS_BROKEN';
          if (verbose) {
            console.log(`  THESIS BROKEN: nodes on ${pos.direction} side dropped to ${fmtVal(sideNodes.totalNegGamma)} (was ${fmtVal(pastTotal)}, min ${fmtVal(CONFIG.nodes_below_min_value)})`);
          }
        }
      }

      // 3. MAX LOSS: hard stop at 15 pts
      if (!exitReason && progress <= -CONFIG.max_loss_pts) {
        exitReason = 'MAX_LOSS';
        exitPrice = isBullish ? pos.entrySpx - CONFIG.max_loss_pts : pos.entrySpx + CONFIG.max_loss_pts;
      }

      // 4. EOD: force close at 15:45
      if (!exitReason && minuteOfDay >= eodMin) {
        exitReason = 'EOD_CLOSE';
      }

      // 5. KING NODE SHIFT: if the king node moves to a different strike that's
      //    CLOSER to spot (and still in our direction), update target. But if it
      //    moved to the OTHER side of spot, that's a thesis break.
      if (!exitReason) {
        const kingOnOurSide = isBullish ? king.strike > spot : king.strike < spot;
        const kingOnOpposite = isBullish ? king.strike < spot - 5 : king.strike > spot + 5;

        if (king.strike !== pos.targetStrike && king.absValue >= trackingAbsValue) {
          if (kingOnOurSide) {
            // King node shifted but still in our direction — update target
            if (verbose) {
              console.log(`  KING SHIFT: target ${pos.targetStrike} -> ${king.strike} (${fmtVal(king.value)})`);
            }
            pos.targetStrike = king.strike;
            state.peakKingValue = king.absValue;
          } else if (kingOnOpposite) {
            // King node flipped to opposite side — but check if nodes still building on our side
            // "King moved but I still see massive nodes below spot, holding"
            const sideCheck = measureNodesBuildingSide(parsed, pos.direction);
            if (sideCheck.totalNegGamma < CONFIG.nodes_below_min_value) {
              exitReason = 'KING_FLIP';
              if (verbose) {
                console.log(`  KING FLIP: ${pos.direction} trade, king moved to ${king.strike}, nodes on our side only ${fmtVal(sideCheck.totalNegGamma)}`);
              }
            } else if (verbose) {
              console.log(`  KING FLIP ignored: king moved to ${king.strike} but ${fmtVal(sideCheck.totalNegGamma)} still building on ${pos.direction} side`);
            }
          }
        }
      }

      if (exitReason) {
        const spxChange = isBullish ? exitPrice - pos.entrySpx : pos.entrySpx - exitPrice;
        const roundedChange = Math.round(spxChange * 100) / 100;

        state.trades.push({
          direction: pos.direction,
          entrySpx: pos.entrySpx,
          exitSpx: exitPrice,
          targetStrike: pos.targetStrike,
          entryKingValue: pos.entryKingValue,
          spxChange: roundedChange,
          isWin: roundedChange > 0,
          exitReason,
          openedAt: pos.openedAt,
          closedAt: etStr,
          mfe: Math.round(pos.bestProgress * 100) / 100,
          mae: Math.round(pos.worstProgress * 100) / 100,
        });

        const pnlStr = `${roundedChange > 0 ? '+' : ''}${roundedChange.toFixed(2)} pts`;
        const tag = roundedChange > 0 ? 'WIN' : 'LOSS';
        if (verbose) {
          console.log(`  EXIT  ${etStr} | ${pos.direction} ${exitReason} | ${pnlStr} | ${tag} | target=${pos.targetStrike} | MFE=${pos.bestProgress.toFixed(1)} MAE=${pos.worstProgress.toFixed(1)}`);
        }

        state.position = null;
        state.lastExitMs = currentMs;
        state.peakKingValue = 0;
      }
    }

    // ---- ENTRY CHECK (if flat) ----
    if (!state.position) {
      // Time gates
      if (minuteOfDay < entryStartMin || minuteOfDay > entryEndMin) continue;

      // Max trades per day
      if (state.trades.length >= CONFIG.max_trades_per_day) continue;

      // Re-entry cooldown
      if (state.lastExitMs > 0 && (currentMs - state.lastExitMs) < CONFIG.reentry_cooldown_min * 60 * 1000) continue;

      // CHOP FILTER: if king node has flipped sides too many times today, it's chop — sit out
      if (state.kingFlipCount > CONFIG.max_king_flips) continue;

      // King node must be far enough from spot
      if (king.absDistance < CONFIG.min_distance_pts) continue;

      // King node must be big enough
      if (king.absValue < CONFIG.min_king_value) continue;

      // King node must be GROWING over the lookback window
      const lookbackMs = CONFIG.min_growth_lookback_min * 60 * 1000;
      const pastEntries = state.kingNodeHistory.filter(h =>
        currentMs - h.timestamp >= lookbackMs - 30_000 &&
        currentMs - h.timestamp <= lookbackMs + 30_000
      );

      if (pastEntries.length === 0) continue;

      const pastEntry = pastEntries.find(h => h.strike === king.strike);
      if (!pastEntry) {
        const recentKingFrames = state.kingNodeHistory.filter(h => h.strike === king.strike);
        if (recentKingFrames.length < 3) continue;
      } else {
        if (king.absValue <= pastEntry.absValue) continue;
      }

      // STABILITY CHECK: king node must have been at the SAME strike for N+ minutes
      // If it keeps flipping between strikes, that's chop — don't trade
      const stabilityMs = CONFIG.king_stability_min * 60 * 1000;
      const recentHistory = state.kingNodeHistory.filter(h => currentMs - h.timestamp <= stabilityMs);
      const atSameStrike = recentHistory.filter(h => h.strike === king.strike).length;
      const stabilityPct = recentHistory.length > 0 ? atSameStrike / recentHistory.length : 0;
      if (stabilityPct < 0.50) continue; // king must be at this strike >50% of recent time

      // NODES CHECK: make sure there are significant nodes building on the target side
      // Not just the king node — total picture should show accumulation
      const direction = king.distanceFromSpot > 0 ? 'BULLISH' : 'BEARISH';
      const sideNodes = measureNodesBuildingSide(parsed, direction);
      if (sideNodes.totalNegGamma < CONFIG.min_king_value) continue; // not enough nodes on that side

      // ENTER
      state.position = {
        direction,
        entrySpx: spot,
        targetStrike: king.strike,
        entryKingValue: king.absValue,
        openedAt: etStr,
        entryTimestampMs: currentMs,
        bestProgress: 0,
        worstProgress: 0,
      };
      state.peakKingValue = king.absValue;

      if (verbose) {
        console.log(`  ENTRY ${etStr} | ${direction} @ $${spot.toFixed(2)} | king=${king.strike} ${fmtVal(king.value)} | dist=${king.absDistance.toFixed(0)}pts`);
      }
    }
  }

  // Force-close any open position at end of data
  if (state.position) {
    const lastFrame = frames[frames.length - 1];
    const lastSpxw = isTrinity ? lastFrame.tickers?.SPXW : lastFrame;
    const lastSpot = lastSpxw?.spotPrice;
    if (lastSpot) {
      const pos = state.position;
      const isBullish = pos.direction === 'BULLISH';
      const spxChange = isBullish ? lastSpot - pos.entrySpx : pos.entrySpx - lastSpot;
      const roundedChange = Math.round(spxChange * 100) / 100;
      const etStr = frameTimestampToET(lastFrame.timestamp).toFormat('yyyy-MM-dd HH:mm:ss');

      state.trades.push({
        direction: pos.direction,
        entrySpx: pos.entrySpx,
        exitSpx: lastSpot,
        targetStrike: pos.targetStrike,
        entryKingValue: pos.entryKingValue,
        spxChange: roundedChange,
        isWin: roundedChange > 0,
        exitReason: 'EOD_FORCE',
        openedAt: pos.openedAt,
        closedAt: etStr,
        mfe: Math.round(pos.bestProgress * 100) / 100,
        mae: Math.round(pos.worstProgress * 100) / 100,
      });

      state.position = null;
    }
  }

  return buildReport(state, dateStr);
}

// ---- Report ----

function buildReport(state, dateStr) {
  const { trades } = state;
  const wins = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const totalPnl = trades.reduce((s, t) => s + t.spxChange, 0);

  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  return {
    date: dateStr,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 'N/A',
    totalPnlPts: Math.round(totalPnl * 100) / 100,
    avgWinPts: wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.spxChange, 0) / wins.length * 100) / 100 : 0,
    avgLossPts: losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.spxChange, 0) / losses.length * 100) / 100 : 0,
    exitReasons,
    trades,
  };
}

function printReport(report) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  King Node Thesis | ${report.date}`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`Trades: ${report.totalTrades} (${report.wins}W / ${report.losses}L)`);
  console.log(`Win Rate: ${report.winRate}%`);
  console.log(`Total P&L: ${report.totalPnlPts > 0 ? '+' : ''}${report.totalPnlPts} SPX pts`);
  if (report.wins > 0) console.log(`Avg Win: +${report.avgWinPts} pts`);
  if (report.losses > 0) console.log(`Avg Loss: ${report.avgLossPts} pts`);
  if (report.wins > 0 && report.losses > 0) {
    const rr = Math.abs(report.avgWinPts / report.avgLossPts);
    console.log(`Reward/Risk: ${rr.toFixed(2)}`);
  }

  if (Object.keys(report.exitReasons).length > 0) {
    console.log(`\nExit Reasons:`);
    for (const [reason, count] of Object.entries(report.exitReasons).sort((a, b) => b[1] - a[1])) {
      const reasonTrades = report.trades.filter(t => t.exitReason === reason);
      const reasonPnl = reasonTrades.reduce((s, t) => s + t.spxChange, 0);
      console.log(`  ${reason.padEnd(18)}: ${String(count).padStart(3)} trades | ${(reasonPnl > 0 ? '+' : '')}${reasonPnl.toFixed(2)} pts`);
    }
  }

  if (report.trades.length > 0) {
    console.log(`\nTrade Log:`);
    for (const t of report.trades) {
      const pnlStr = `${t.spxChange > 0 ? '+' : ''}${t.spxChange.toFixed(2)}`;
      const tag = t.isWin ? 'WIN ' : 'LOSS';
      const valStr = fmtVal(t.entryKingValue);
      console.log(`  ${t.openedAt} -> ${t.closedAt.split(' ')[1]} | ${t.direction.padEnd(7)} @ $${t.entrySpx.toFixed(2)} | target=${t.targetStrike} (${valStr}) | exit=$${t.exitSpx.toFixed(2)} | ${pnlStr.padStart(8)} pts | ${t.exitReason.padEnd(15)} | ${tag} | MFE=${t.mfe} MAE=${t.mae}`);
    }
  }

  console.log(`\nSUMMARY: ${report.date} | ${report.totalTrades} trades | ${report.wins}W/${report.losses}L | NET: ${report.totalPnlPts > 0 ? '+' : ''}${report.totalPnlPts} pts`);
}

// ---- CLI ----

const args = process.argv.slice(2);
const batchMode = args.includes('--batch');
const verbose = args.includes('--verbose');

if (batchMode) {
  const files = args.filter(a => a.endsWith('.json')).sort();
  if (files.length === 0) {
    console.error('Usage: node src/backtest/replay-king-node.js --batch data/gex-replay-*.json [--verbose]');
    process.exit(1);
  }

  const allReports = [];
  for (const file of files) {
    try {
      const report = replayKingNode(file, verbose);
      allReports.push(report);
      console.log(`SUMMARY: ${report.date} | ${report.totalTrades} trades | ${report.wins}W/${report.losses}L | NET: ${report.totalPnlPts > 0 ? '+' : ''}${report.totalPnlPts} pts`);
    } catch (err) {
      console.error(`Error processing ${file}: ${err.message}`);
    }
  }

  // Batch totals
  const totalTrades = allReports.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins = allReports.reduce((s, r) => s + r.wins, 0);
  const totalLosses = allReports.reduce((s, r) => s + r.losses, 0);
  const totalPnl = allReports.reduce((s, r) => s + r.totalPnlPts, 0);
  const winDays = allReports.filter(r => r.totalPnlPts > 0).length;
  const lossDays = allReports.filter(r => r.totalPnlPts < 0).length;
  const flatDays = allReports.filter(r => r.totalPnlPts === 0).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  BATCH SUMMARY: ${allReports.length} days`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Trades: ${totalTrades} | Wins: ${totalWins} | Losses: ${totalLosses} | WR: ${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 'N/A'}%`);
  console.log(`NET P&L: ${totalPnl > 0 ? '+' : ''}${(Math.round(totalPnl * 100) / 100)} pts | Avg/trade: ${totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : 0} pts`);
  console.log(`Win days: ${winDays} | Loss days: ${lossDays} | Flat days: ${flatDays}`);

  if (totalWins > 0 && totalLosses > 0) {
    const allTrades = allReports.flatMap(r => r.trades);
    const avgWin = allTrades.filter(t => t.isWin).reduce((s, t) => s + t.spxChange, 0) / totalWins;
    const avgLoss = allTrades.filter(t => !t.isWin).reduce((s, t) => s + t.spxChange, 0) / totalLosses;
    console.log(`Avg Win: +${avgWin.toFixed(2)} pts | Avg Loss: ${avgLoss.toFixed(2)} pts | R:R ${Math.abs(avgWin / avgLoss).toFixed(2)}`);
  }

  // Exit reason breakdown across all days
  const allExitReasons = {};
  const allTrades = allReports.flatMap(r => r.trades);
  for (const t of allTrades) {
    if (!allExitReasons[t.exitReason]) allExitReasons[t.exitReason] = { count: 0, pnl: 0 };
    allExitReasons[t.exitReason].count++;
    allExitReasons[t.exitReason].pnl += t.spxChange;
  }
  console.log(`\nExit Reasons (all days):`);
  for (const [reason, data] of Object.entries(allExitReasons).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(18)}: ${String(data.count).padStart(3)} trades | ${(data.pnl > 0 ? '+' : '')}${data.pnl.toFixed(2)} pts`);
  }

  process.exit(0);
}

// Single file mode
const jsonPath = args.filter(a => !a.startsWith('--'))[0];
if (!jsonPath) {
  console.error('Usage: node src/backtest/replay-king-node.js <path-to-json> [--verbose]');
  console.error('       node src/backtest/replay-king-node.js --batch data/gex-replay-*.json [--verbose]');
  process.exit(1);
}

const report = replayKingNode(jsonPath, verbose);
printReport(report);
