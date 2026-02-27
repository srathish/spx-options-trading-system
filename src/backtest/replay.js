/**
 * GexClaw Replay Engine
 * Replays stored raw GEX snapshots through the full pipeline
 * using the CURRENT active strategy config.
 *
 * Usage: node src/backtest/replay.js <YYYY-MM-DD>
 *
 * No DB writes — all trades simulated in memory.
 * Runs as a standalone process (separate from live PM2 system).
 */

import { DateTime } from 'luxon';
import { getRawSnapshotsByDate, getRawSnapshotDates, reconstructParsedData } from '../store/db.js';
import { identifyWalls } from '../gex/gex-parser.js';
import { scoreSpxGex } from '../gex/gex-scorer.js';
import { detectAllPatterns } from '../gex/gex-patterns.js';
import { checkGexOnlyEntry } from '../trades/entry-engine.js';
import { checkEntryGates, recordEntryForGates, recordExitForGates, resetDailyGates } from '../trades/entry-gates.js';
import { buildEntryContext } from '../trades/entry-context.js';
import {
  resetDailyState, saveGexRead, saveNodeSnapshot, recordScore,
  updateRegime, getNodeTrends, updateLatestSpot, getGexHistory,
  detectWallTrends,
} from '../store/state.js';
import { updateNodeTouches, resetNodeTouches, getNodeTouches } from '../gex/node-tracker.js';
import { initStrategyStore, getActiveConfig, getVersionLabel } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Replay');

// ---- Core Replay Function ----

function replayDate(dateStr) {
  // 1. LOAD
  const allRows = getRawSnapshotsByDate(dateStr);
  if (allRows.length === 0) {
    log.error(`No snapshots found for ${dateStr}`);
    return null;
  }

  // Group by cycle_index
  const cycles = new Map();
  for (const row of allRows) {
    if (!cycles.has(row.cycle_index)) cycles.set(row.cycle_index, {});
    cycles.get(row.cycle_index)[row.ticker] = row;
  }

  const spxwCount = allRows.filter(r => r.ticker === 'SPXW').length;
  log.info(`Loaded ${allRows.length} snapshots across ${cycles.size} cycles for ${dateStr} (${spxwCount} SPXW)`);

  // 2. INITIALIZE
  initStrategyStore();
  const cfg = getActiveConfig();
  log.info(`Replaying with strategy ${getVersionLabel()} (${Object.keys(cfg).length} params)`);

  resetDailyState();
  resetNodeTouches();
  resetDailyGates();

  // 3. REPLAY STATE
  const state = {
    position: null,
    trades: [],
    blockedEntries: [],
    cycleCount: 0,
  };

  // 4. CYCLE LOOP
  const sortedCycleIndices = [...cycles.keys()].sort((a, b) => a - b);

  for (const cycleIdx of sortedCycleIndices) {
    const cycleData = cycles.get(cycleIdx);
    state.cycleCount++;
    replayCycle(cycleData, state, cfg);
  }

  // 5. Force-close any open position at EOD
  if (state.position) {
    const lastSpxwRow = allRows.filter(r => r.ticker === 'SPXW').pop();
    if (lastSpxwRow) {
      closeReplayPosition(state, lastSpxwRow.spot_price, 'EOD_CLOSE', lastSpxwRow.timestamp);
    }
  }

  // 6. Build report
  return buildReplayReport(state, dateStr);
}

// ---- Single Cycle Replay ----

function replayCycle(cycleData, state, cfg) {
  const spxwRow = cycleData.SPXW;
  if (!spxwRow) return;

  // Reconstruct SPXW parsed data
  const spxwParsed = reconstructParsedData(spxwRow);
  const spxwWalls = identifyWalls(spxwParsed);
  spxwParsed.walls = spxwWalls;

  // Populate state buffers (same calls as live loop)
  saveGexRead(spxwParsed, 'SPXW');
  saveNodeSnapshot(spxwWalls, 'SPXW');

  // Also populate SPY/QQQ state for any cross-references
  for (const ticker of ['SPY', 'QQQ']) {
    const row = cycleData[ticker];
    if (!row) continue;
    const parsed = reconstructParsedData(row);
    const walls = identifyWalls(parsed);
    parsed.walls = walls;
    saveGexRead(parsed, ticker);
    saveNodeSnapshot(walls, ticker);
  }

  // Detect wall trends from history
  const history = getGexHistory('SPXW');
  const wallTrends = history.length >= 2 ? detectWallTrends(spxwWalls, history) : [];

  // Retrieve stored multi-analysis (don't re-run cross-ticker)
  const storedMultiAnalysis = spxwRow.multi_analysis
    ? JSON.parse(spxwRow.multi_analysis)
    : { bonus: 0, alignment: { count: 0, direction: 'MIXED' }, driver: null,
        rug_setups: [], stacked_walls: [], king_nodes: {}, node_slides: [],
        wall_classifications: [], multi_signal: {}, reshuffles: [], hedge_nodes: [] };

  // Score SPXW with current strategy config
  const bonus = storedMultiAnalysis.bonus || 0;
  const scored = scoreSpxGex(spxwParsed, wallTrends, bonus, 'SPXW');

  // Track state
  updateNodeTouches(spxwParsed.spotPrice, spxwWalls);
  recordScore('SPXW', scored.score, scored.direction);
  updateRegime('SPXW', scored.direction);
  updateLatestSpot(spxwParsed.spotPrice);

  // Parse replay time for time-based gates
  const replayTime = DateTime.fromFormat(
    spxwRow.timestamp, 'yyyy-MM-dd HH:mm:ss',
    { zone: 'America/New_York' }
  );

  // ---- EXIT CHECK (if in position) ----
  if (state.position) {
    const exitResult = checkReplayExits(
      state.position, spxwParsed.spotPrice, scored,
      storedMultiAnalysis, spxwRow, cfg, replayTime
    );
    if (exitResult.exit) {
      closeReplayPosition(state, spxwParsed.spotPrice, exitResult.reason, spxwRow.timestamp);
    }
  }

  // ---- ENTRY CHECK (if flat) ----
  if (!state.position) {
    const nodeTouches = getNodeTouches();
    const nodeTrends = getNodeTrends('SPXW');

    const detectedPatterns = detectAllPatterns(
      scored, spxwParsed, storedMultiAnalysis,
      nodeTouches, nodeTrends, null
    );

    if (detectedPatterns.length > 0) {
      const entryState = { patterns: detectedPatterns, scored, multiAnalysis: storedMultiAnalysis, nodeTouches };
      const laneAResult = checkGexOnlyEntry(entryState);

      if (laneAResult?.shouldEnter) {
        const replayMs = replayTime.toMillis();
        const guardrail = checkEntryGates(
          laneAResult.action, scored, storedMultiAnalysis,
          { lane: 'A', timeOverride: replayTime, nowMs: replayMs }
        );

        if (guardrail.allowed) {
          const entryContext = buildEntryContext(laneAResult.trigger, scored, storedMultiAnalysis);
          openReplayPosition(state, {
            direction: laneAResult.trigger.direction,
            spotPrice: spxwParsed.spotPrice,
            trigger: laneAResult.trigger,
            scored,
            entryContext,
            timestamp: spxwRow.timestamp,
          });
          recordEntryForGates(replayMs);
        } else {
          state.blockedEntries.push({
            timestamp: spxwRow.timestamp,
            pattern: laneAResult.trigger.pattern,
            direction: laneAResult.trigger.direction,
            reason: guardrail.reason,
            score: scored.score,
          });
        }
      }
    }
  }
}

// ---- Position Management ----

function openReplayPosition(state, params) {
  const { direction, spotPrice, trigger, scored, entryContext, timestamp } = params;

  state.position = {
    direction,
    entrySpx: spotPrice,
    targetSpx: trigger.target_strike,
    stopSpx: trigger.stop_strike,
    pattern: trigger.pattern,
    confidence: trigger.confidence,
    entryScore: scored.score,
    entryContext,
    openedAt: timestamp,
    entryTimestampMs: DateTime.fromFormat(timestamp, 'yyyy-MM-dd HH:mm:ss', { zone: 'America/New_York' }).toMillis(),
    bestSpxChange: 0,
  };

  log.info(`ENTRY ${timestamp} | ${direction} @ $${spotPrice.toFixed(2)} via ${trigger.pattern} (${trigger.confidence}) | target=${trigger.target_strike} stop=${trigger.stop_strike}`);
}

function closeReplayPosition(state, exitSpx, exitReason, timestamp) {
  const pos = state.position;
  if (!pos) return;

  const isBullish = pos.direction === 'BULLISH';
  const spxChange = isBullish ? exitSpx - pos.entrySpx : pos.entrySpx - exitSpx;
  const pnlPct = (spxChange / pos.entrySpx) * 100;

  // Parse timestamp for nowMs override
  const exitMs = DateTime.fromFormat(timestamp, 'yyyy-MM-dd HH:mm:ss', { zone: 'America/New_York' }).toMillis();

  state.trades.push({
    direction: pos.direction,
    pattern: pos.pattern,
    confidence: pos.confidence,
    entrySpx: pos.entrySpx,
    exitSpx,
    entryScore: pos.entryScore,
    spxChange: Math.round(spxChange * 100) / 100,
    pnlPct: Math.round(pnlPct * 1000) / 1000,
    exitReason,
    isWin: spxChange > 0,
    openedAt: pos.openedAt,
    closedAt: timestamp,
  });

  const pnlStr = `${spxChange > 0 ? '+' : ''}${(Math.round(spxChange * 100) / 100)} pts`;
  log.info(`EXIT  ${timestamp} | ${pos.direction} ${exitReason} | ${pnlStr} | ${spxChange > 0 ? 'WIN' : 'LOSS'}`);

  state.position = null;
  recordExitForGates(pos.direction, spxChange <= 0, exitMs);
}

// ---- Exit Trigger Checks (Pure, No DB Writes) ----

function checkReplayExits(position, currentSpot, scored, multiAnalysis, spxwRow, cfg, replayTime) {
  const isBullish = position.direction === 'BULLISH';

  // Compute hold time from actual timestamps
  const currentMs = replayTime.toMillis();
  const holdMs = currentMs - position.entryTimestampMs;
  const holdSeconds = holdMs / 1000;
  const holdMinutes = holdSeconds / 60;
  const holdTooShort = holdMinutes < (cfg.momentum_min_hold_minutes ?? 3);

  // SPX change in our direction
  const spxProgress = isBullish
    ? currentSpot - position.entrySpx
    : position.entrySpx - currentSpot;

  // Track best progress for trailing stop
  if (spxProgress > position.bestSpxChange) {
    position.bestSpxChange = spxProgress;
  }

  // 1. TARGET_HIT
  if (position.targetSpx) {
    const targetHit = isBullish
      ? currentSpot >= position.targetSpx
      : currentSpot <= position.targetSpx;
    if (targetHit) return { exit: true, reason: 'TARGET_HIT' };
  }

  // 2. NODE_SUPPORT_BREAK (trend-aware)
  if (position.entryContext) {
    const nodeTrends = getNodeTrends('SPXW');
    let buffer = cfg.node_break_buffer_pts ?? 2;

    if (isBullish && position.entryContext.support_node?.strike) {
      const trend = nodeTrends.get(position.entryContext.support_node.strike);
      if (trend?.trend === 'GONE') return { exit: true, reason: 'NODE_SUPPORT_BREAK' };
      if (trend?.trend === 'WEAKENING') buffer = 0;
      else if (trend?.trend === 'GROWING') buffer += 1;
      if (currentSpot < position.entryContext.support_node.strike - buffer) {
        return { exit: true, reason: 'NODE_SUPPORT_BREAK' };
      }
    }
    if (!isBullish && position.entryContext.ceiling_node?.strike) {
      const trend = nodeTrends.get(position.entryContext.ceiling_node.strike);
      if (trend?.trend === 'GONE') return { exit: true, reason: 'NODE_SUPPORT_BREAK' };
      if (trend?.trend === 'WEAKENING') buffer = 0;
      else if (trend?.trend === 'GROWING') buffer += 1;
      if (currentSpot > position.entryContext.ceiling_node.strike + buffer) {
        return { exit: true, reason: 'NODE_SUPPORT_BREAK' };
      }
    }
  }

  // 3. STOP_HIT
  if (position.stopSpx) {
    const stopHit = isBullish
      ? currentSpot <= position.stopSpx
      : currentSpot >= position.stopSpx;
    if (stopHit) return { exit: true, reason: 'STOP_HIT' };
  }

  // 4. PROFIT_TARGET
  const movePct = Math.abs(spxProgress / position.entrySpx) * 100;
  if (spxProgress > 0 && movePct >= (cfg.profit_target_pct || 0.15)) {
    return { exit: true, reason: 'PROFIT_TARGET' };
  }

  // 5. STOP_LOSS
  if (spxProgress < 0 && Math.abs(movePct) >= (cfg.stop_loss_pct || 0.20)) {
    return { exit: true, reason: 'STOP_LOSS' };
  }

  // 6. MOMENTUM_TIMEOUT (4 phases)
  const phase0Seconds = cfg.momentum_phase0_seconds ?? 60;
  const phase0MinPts = cfg.momentum_phase0_min_pts ?? 1;
  const phase1Seconds = (cfg.momentum_phase1_minutes ?? 5) * 60;

  // Phase 0: exempt from min hold
  if (holdSeconds >= phase0Seconds && holdSeconds < phase1Seconds) {
    if (spxProgress < phase0MinPts) {
      return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
    }
  }

  if (!holdTooShort) {
    // Phase 1: 5 min, need +2pts
    if (holdMinutes >= (cfg.momentum_phase1_minutes ?? 5) && spxProgress < (cfg.momentum_phase1_min_pts ?? 2)) {
      return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
    }

    // Phase 2: 10 min, need 40% to target
    if (holdMinutes >= (cfg.momentum_phase2_minutes ?? 10) && position.targetSpx) {
      const totalTarget = Math.abs(position.targetSpx - position.entrySpx);
      if (totalTarget > 0 && spxProgress < totalTarget * (cfg.momentum_phase2_target_pct ?? 0.40)) {
        return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
      }
    }

    // Phase 3: 15 min, must be net positive
    if (holdMinutes >= (cfg.momentum_phase3_minutes ?? 15) && spxProgress <= 0) {
      return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
    }
  }

  // 7. TV_COUNTER_FLIP (from stored TV snapshot)
  if (!holdTooShort && spxwRow.tv_snapshot) {
    try {
      const tvSnap = JSON.parse(spxwRow.tv_snapshot);
      const signals = tvSnap.spx?.signals || {};

      if (cfg.tv_counter_flip_enabled !== false) {
        const bravo3 = signals['bravo_3m'];
        const tango3 = signals['tango_3m'];
        const bravoAgainst = bravo3 && !bravo3.isStale && (
          (isBullish && bravo3.classification === 'BEARISH') ||
          (!isBullish && bravo3.classification === 'BULLISH')
        );
        const tangoAgainst = tango3 && !tango3.isStale && (
          (isBullish && tango3.classification === 'BEARISH') ||
          (!isBullish && tango3.classification === 'BULLISH')
        );
        if ((bravoAgainst ? 1 : 0) + (tangoAgainst ? 1 : 0) >= (cfg.tv_counter_flip_min_indicators ?? 2)) {
          return { exit: true, reason: 'TV_COUNTER_FLIP' };
        }
      }

      // TV_FLIP: 2+ opposing 3m indicators
      let opposingCount = 0;
      for (const [key, sig] of Object.entries(signals)) {
        if (!key.endsWith('3m')) continue;
        const opposing = isBullish ? sig.classification === 'BEARISH' : sig.classification === 'BULLISH';
        if (opposing && !sig.isStale) opposingCount++;
      }
      if (opposingCount >= (cfg.tv_against_exit_count || 2)) {
        return { exit: true, reason: 'TV_FLIP' };
      }
    } catch (_) {}
  }

  // 8. OPPOSING_WALL
  if (!holdTooShort) {
    const opposingWallValue = cfg.opposing_wall_exit_value || 5_000_000;
    const walls = isBullish ? scored.wallsAbove : scored.wallsBelow;
    const hasOpposing = walls?.some(w => Math.abs(w.gexValue || w.absGexValue || 0) >= opposingWallValue && w.type === 'positive');
    if (hasOpposing) {
      return { exit: true, reason: 'OPPOSING_WALL' };
    }
  }

  // 9. TRAILING_STOP
  if (!holdTooShort) {
    const trailActivate = cfg.trailing_stop_activate_pts || 8;
    const trailDistance = cfg.trailing_stop_distance_pts || 5;
    if (position.bestSpxChange >= trailActivate) {
      const drawdown = position.bestSpxChange - spxProgress;
      if (drawdown >= trailDistance) {
        return { exit: true, reason: 'TRAILING_STOP' };
      }
    }
  }

  // 10. THETA_DEATH (time-based)
  const noEntryAfter = cfg.no_entry_after || '15:30';
  const [thetaH, thetaM] = noEntryAfter.split(':').map(Number);
  if (replayTime.hour > thetaH || (replayTime.hour === thetaH && replayTime.minute >= thetaM)) {
    return { exit: true, reason: 'THETA_DEATH' };
  }

  // 11. GEX_FLIP
  if (!holdTooShort && scored.score >= (cfg.gex_exit_threshold || 40)) {
    const gexBullish = scored.direction === 'BULLISH';
    if (gexBullish !== isBullish) {
      return { exit: true, reason: 'GEX_FLIP' };
    }
  }

  return { exit: false };
}

// ---- Report Builder ----

function buildReplayReport(state, dateStr) {
  const { trades, blockedEntries } = state;

  const wins = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const totalPnl = trades.reduce((sum, t) => sum + t.spxChange, 0);

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // Pattern performance
  const patternPerf = {};
  for (const t of trades) {
    if (!patternPerf[t.pattern]) patternPerf[t.pattern] = { wins: 0, losses: 0, totalPnl: 0 };
    if (t.isWin) patternPerf[t.pattern].wins++;
    else patternPerf[t.pattern].losses++;
    patternPerf[t.pattern].totalPnl += t.spxChange;
  }

  // Blocked entry reasons
  const blockReasons = {};
  for (const b of blockedEntries) {
    blockReasons[b.reason] = (blockReasons[b.reason] || 0) + 1;
  }

  return {
    date: dateStr,
    strategy: getVersionLabel(),
    cycles: state.cycleCount,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 'N/A',
    totalPnlPts: Math.round(totalPnl * 100) / 100,
    avgWinPts: wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.spxChange, 0) / wins.length * 100) / 100 : 0,
    avgLossPts: losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.spxChange, 0) / losses.length * 100) / 100 : 0,
    exitReasons,
    patternPerformance: patternPerf,
    blockedEntries: blockedEntries.length,
    blockReasons,
    trades,
  };
}

// ---- CLI Entry Point ----

const args = process.argv.slice(2);
const dateArg = args[0];

if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Usage: node src/backtest/replay.js <YYYY-MM-DD>');
  console.error('Example: node src/backtest/replay.js 2026-02-27');

  const dates = getRawSnapshotDates(10);
  if (dates.length > 0) {
    console.error('\nAvailable dates:');
    dates.forEach(d => console.error(`  ${d.date} (${d.snapshots} snapshots, ${d.tickers} tickers)`));
  } else {
    console.error('\nNo snapshot data yet. Snapshots accumulate during live operation.');
  }
  process.exit(1);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`  GexClaw Replay Engine`);
console.log(`${'='.repeat(50)}\n`);

const report = replayDate(dateArg);

if (!report) {
  process.exit(1);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`  Results: ${report.date} | Strategy: ${report.strategy}`);
console.log(`${'='.repeat(50)}\n`);

console.log(`Cycles: ${report.cycles}`);
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
    console.log(`  ${reason}: ${count}`);
  }
}

if (Object.keys(report.patternPerformance).length > 0) {
  console.log(`\nPattern Performance:`);
  for (const [pattern, perf] of Object.entries(report.patternPerformance)) {
    const total = perf.wins + perf.losses;
    const wr = total > 0 ? ((perf.wins / total) * 100).toFixed(0) : 'N/A';
    const pnlStr = `${perf.totalPnl > 0 ? '+' : ''}${perf.totalPnl.toFixed(2)}`;
    console.log(`  ${pattern}: ${perf.wins}W/${perf.losses}L (${wr}%) | ${pnlStr} pts`);
  }
}

if (report.blockedEntries > 0) {
  console.log(`\nBlocked Entries: ${report.blockedEntries}`);
  for (const [reason, count] of Object.entries(report.blockReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
}

if (report.trades.length > 0) {
  console.log(`\nTrade Log:`);
  for (const t of report.trades) {
    const pnlStr = `${t.spxChange > 0 ? '+' : ''}${t.spxChange}`;
    const tag = t.isWin ? 'WIN ' : 'LOSS';
    console.log(`  ${t.openedAt} | ${t.direction.padEnd(7)} ${t.pattern.padEnd(20)} | $${t.entrySpx.toFixed(2)} -> $${t.exitSpx.toFixed(2)} | ${pnlStr.padStart(8)} pts | ${t.exitReason.padEnd(18)} | ${tag}`);
  }
}

console.log('');
process.exit(0);
