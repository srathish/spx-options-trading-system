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
import { checkGexOnlyEntry, checkTrendPullbackEntry } from '../trades/entry-engine.js';
import { checkEntryGates, recordEntryForGates, recordExitForGates, resetDailyGates } from '../trades/entry-gates.js';
import { buildEntryContext } from '../trades/entry-context.js';
import {
  resetDailyState, saveGexRead, saveNodeSnapshot, recordScore,
  updateRegime, getNodeTrends, updateLatestSpot, updateHodLod, setReplayTime, getGexHistory,
  detectWallTrends, saveKingNode, getNodeSignChanges, getKingNodeFlip,
  saveStackSnapshot, getStackPersistence,
} from '../store/state.js';
import { updateNodeTouches, resetNodeTouches, getNodeTouches } from '../gex/node-tracker.js';
import { initStrategyStore, getActiveConfig, getVersionLabel, setActiveConfigOverride } from '../review/strategy-store.js';
import { updateTrendBuffer, detectTrendDay, getTrendState, resetTrendDetector } from '../store/trend-detector.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Replay');

// ---- Core Replay Function ----

export function replayDate(dateStr, configOverride = null) {
  // 1. LOAD
  const allRows = getRawSnapshotsByDate(dateStr);
  if (allRows.length === 0) {
    log.error(`No snapshots found for ${dateStr}`);
    return null;
  }

  // Group by timestamp (cycle_index can repeat across sessions/restarts)
  const cycles = new Map();
  for (const row of allRows) {
    const key = `${row.cycle_index}_${row.timestamp}`;
    if (!cycles.has(key)) cycles.set(key, {});
    cycles.get(key)[row.ticker] = row;
  }

  const spxwCount = allRows.filter(r => r.ticker === 'SPXW').length;
  log.info(`Loaded ${allRows.length} snapshots across ${cycles.size} cycles for ${dateStr} (${spxwCount} SPXW)`);

  // 2. INITIALIZE
  initStrategyStore();

  // Apply config override if provided (forked child process — dies with process)
  if (configOverride && typeof configOverride === 'object') {
    setActiveConfigOverride(configOverride);
    log.info(`Config override applied: ${Object.keys(configOverride).length} params overridden`);
  }

  const cfg = getActiveConfig();
  log.info(`Replaying with strategy ${getVersionLabel()} (${Object.keys(cfg).length} params)`);

  resetDailyState();
  resetNodeTouches();
  resetDailyGates();
  resetTrendDetector();

  // 3. REPLAY STATE
  const state = {
    position: null,
    trades: [],
    blockedEntries: [],
    cycleCount: 0,
  };

  // 4. CYCLE LOOP — sort by SPXW timestamp to ensure chronological order
  const sortedKeys = [...cycles.keys()].sort((a, b) => {
    const tsA = cycles.get(a).SPXW?.timestamp || '';
    const tsB = cycles.get(b).SPXW?.timestamp || '';
    return tsA.localeCompare(tsB);
  });

  for (const key of sortedKeys) {
    const cycleData = cycles.get(key);
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

  // 6. Clear replay time override
  setReplayTime(null);

  // 7. Build report
  return buildReplayReport(state, dateStr);
}

// ---- Single Cycle Replay ----

function replayCycle(cycleData, state, cfg) {
  const spxwRow = cycleData.SPXW;
  if (!spxwRow) return;

  // Set replay time override for scoring/patterns to use correct snapshot time
  const snapshotTime = DateTime.fromFormat(
    spxwRow.timestamp, 'yyyy-MM-dd HH:mm:ss',
    { zone: 'America/New_York' }
  );
  setReplayTime(snapshotTime);

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

  // Save king node for type flip detection
  const spxwKingNode = storedMultiAnalysis.king_nodes?.SPXW;
  if (spxwKingNode) saveKingNode(spxwKingNode, 'SPXW');

  // Save stacked walls snapshot for persistence tracking
  saveStackSnapshot(storedMultiAnalysis.stacked_walls || [], 'SPXW');

  // Track state
  updateNodeTouches(spxwParsed.spotPrice, spxwWalls);
  recordScore('SPXW', scored.score, scored.direction, scored.spotPrice);
  updateRegime('SPXW', scored.direction);
  updateLatestSpot(spxwParsed.spotPrice);
  updateHodLod(spxwParsed.spotPrice);

  // Trend day detection
  updateTrendBuffer(scored, cfg);
  detectTrendDay();

  // Use the already-parsed snapshot time for time-based gates
  const replayTime = snapshotTime;

  // ---- EXIT CHECK (if in position) ----
  if (state.position) {
    const exitResult = checkReplayExits(
      state.position, spxwParsed.spotPrice, scored,
      storedMultiAnalysis, spxwRow, cfg, replayTime, getTrendState()
    );
    if (exitResult.exit) {
      closeReplayPosition(state, spxwParsed.spotPrice, exitResult.reason, spxwRow.timestamp);
    }
  }

  // ---- ENTRY CHECK (if flat) ----
  // Skip entries before market open — pre-market GEX data builds state but shouldn't trigger trades
  if (!state.position && replayTime.hour >= 9 && (replayTime.hour > 9 || replayTime.minute >= 30)) {
    const nodeTouches = getNodeTouches();
    const nodeTrends = getNodeTrends('SPXW');

    const nodeSignChanges = getNodeSignChanges('SPXW');
    const kingNodeFlip = getKingNodeFlip('SPXW');
    const detectedPatterns = detectAllPatterns(
      scored, spxwParsed, storedMultiAnalysis,
      nodeTouches, nodeTrends, null,
      nodeSignChanges, kingNodeFlip
    );

    if (detectedPatterns.length > 0) {
      const entryState = { patterns: detectedPatterns, scored, multiAnalysis: storedMultiAnalysis, nodeTouches, trendState: getTrendState() };
      const laneAResult = checkGexOnlyEntry(entryState);

      if (laneAResult?.shouldEnter) {
        const replayMs = replayTime.toMillis();
        const guardrail = checkEntryGates(
          laneAResult.action, scored, storedMultiAnalysis,
          { lane: 'A', timeOverride: replayTime, nowMs: replayMs, pattern: laneAResult.trigger.pattern, trigger: laneAResult.trigger, trendState: getTrendState() }
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
          recordEntryForGates(replayMs, laneAResult.trigger.pattern);
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

    // Trend pullback entry (only when Lane A didn't fire and still FLAT)
    if (!state.position) {
      const currentTrend = getTrendState();
      if (currentTrend.isTrend) {
        const pullbackResult = checkTrendPullbackEntry(
          { scored, multiAnalysis: storedMultiAnalysis, nodeTouches },
          currentTrend
        );
        if (pullbackResult?.shouldEnter) {
          const replayMs = replayTime.toMillis();
          const guardrail = checkEntryGates(
            pullbackResult.action, scored, storedMultiAnalysis,
            { lane: 'A', timeOverride: replayTime, nowMs: replayMs, pattern: 'TREND_PULLBACK', trigger: pullbackResult.trigger, trendState: currentTrend }
          );
          if (guardrail.allowed) {
            const entryContext = buildEntryContext(pullbackResult.trigger, scored, storedMultiAnalysis);
            openReplayPosition(state, {
              direction: pullbackResult.trigger.direction,
              spotPrice: spxwParsed.spotPrice,
              trigger: pullbackResult.trigger,
              scored,
              entryContext,
              timestamp: spxwRow.timestamp,
            });
            recordEntryForGates(replayMs, 'TREND_PULLBACK');
          } else {
            state.blockedEntries.push({
              timestamp: spxwRow.timestamp,
              pattern: 'TREND_PULLBACK',
              direction: pullbackResult.trigger.direction,
              reason: guardrail.reason,
              score: scored.score,
            });
          }
        }
      }
    }
  }
}

// ---- Position Management ----

function openReplayPosition(state, params) {
  const { direction, spotPrice, trigger, scored, entryContext, timestamp } = params;
  const cfg = getActiveConfig() || {};

  let stopSpx = trigger.stop_strike;

  // Widen stop for trend days
  const currentTrend = getTrendState();
  const entryTrendAligned = currentTrend?.isTrend && currentTrend.direction === direction
    && (currentTrend.strength === 'CONFIRMED' || currentTrend.strength === 'STRONG');
  if (entryTrendAligned && stopSpx) {
    const stopDist = Math.abs(stopSpx - spotPrice);
    const trendMult = cfg.trend_stop_multiplier ?? 1.5;
    stopSpx = direction === 'BULLISH' ? spotPrice - stopDist * trendMult : spotPrice + stopDist * trendMult;
  }

  // Widen stop for breakout entries
  if (scored.score >= (cfg.breakout_score_threshold ?? 90) && stopSpx) {
    const stopDist = Math.abs(stopSpx - spotPrice);
    const breakoutMult = cfg.breakout_stop_multiplier ?? 1.3;
    stopSpx = direction === 'BULLISH' ? spotPrice - stopDist * breakoutMult : spotPrice + stopDist * breakoutMult;
  }

  state.position = {
    direction,
    entrySpx: spotPrice,
    targetSpx: trigger.target_strike,
    stopSpx,
    pattern: trigger.pattern,
    confidence: trigger.confidence,
    entryScore: scored.score,
    entryContext,
    openedAt: timestamp,
    entryTimestampMs: DateTime.fromFormat(timestamp, 'yyyy-MM-dd HH:mm:ss', { zone: 'America/New_York' }).toMillis(),
    bestSpxChange: 0,
    _gexFlipCount: 0,
  };

  log.info(`ENTRY ${timestamp} | ${direction} @ $${spotPrice.toFixed(2)} via ${trigger.pattern} (${trigger.confidence}) | target=${trigger.target_strike} stop=${stopSpx?.toFixed(2) || '?'}`);
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
  recordExitForGates(pos.direction, spxChange <= 0, exitMs, pos.pattern, spxChange);
}

// ---- Exit Trigger Checks (Pure, No DB Writes) ----

function checkReplayExits(position, currentSpot, scored, multiAnalysis, spxwRow, cfg, replayTime, trendState) {
  const isBullish = position.direction === 'BULLISH';
  // v2: Only use real-time CONFIRMED/STRONG for isTrendAligned
  const isTrendAligned = trendState?.isTrend && trendState.direction === position.direction
    && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');

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

  // 1. TARGET_HIT (with magnet walk extension)
  if (position.targetSpx) {
    const targetHit = isBullish
      ? currentSpot >= position.targetSpx
      : currentSpot <= position.targetSpx;
    if (targetHit) {
      const walkEnabled = cfg.magnet_walk_enabled ?? true;
      const maxWalks = cfg.magnet_walk_max_steps ?? 2;
      const walkCount = position._walkCount || 0;
      const walkPatterns = ['KING_NODE_BOUNCE', 'REVERSE_RUG', 'AIR_POCKET', 'MAGNET_PULL'];
      const pattern = position.entryContext?.pattern;

      if (walkEnabled && walkCount < maxWalks && walkPatterns.includes(pattern) && multiAnalysis) {
        const nextMagnet = findNextMagnetReplay(multiAnalysis.stacked_walls || [], position.targetSpx, isBullish, cfg.magnet_walk_max_dist_pts ?? 25);
        if (nextMagnet) {
          const prevTarget = position.targetSpx;
          position.targetSpx = nextMagnet.strike;
          position._walkCount = walkCount + 1;
          const ratchetPts = cfg.magnet_walk_stop_ratchet_pts ?? 3;
          const newStop = isBullish ? prevTarget - ratchetPts : prevTarget + ratchetPts;
          position.stopSpx = isBullish
            ? Math.max(position.stopSpx, newStop)
            : Math.min(position.stopSpx, newStop);
          // Don't exit — continue with extended target
        } else {
          return { exit: true, reason: 'TARGET_HIT' };
        }
      } else {
        return { exit: true, reason: 'TARGET_HIT' };
      }
    }
  }

  // 2. NODE_SUPPORT_BREAK (trend-aware)
  // v2: Wider buffer during confirmed trends — minor dips are normal on trend days
  if (position.entryContext) {
    const nodeTrends = getNodeTrends('SPXW');
    const realtimeTrendAligned = trendState?.isTrend && trendState.direction === position.direction
      && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');
    let buffer = realtimeTrendAligned ? (cfg.node_break_trend_buffer_pts ?? 5) : (cfg.node_break_buffer_pts ?? 2);

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

  // 2b. TREND_FLOOR_BREAK — structural exit during trend days
  if (isTrendAligned && trendState.supportFloor?.strike) {
    const floorBuffer = cfg.trend_floor_break_buffer_pts ?? 3;
    if (isBullish && currentSpot < trendState.supportFloor.strike - floorBuffer) {
      return { exit: true, reason: 'TREND_FLOOR_BREAK' };
    }
    if (!isBullish && trendState.resistanceCeiling?.strike &&
        currentSpot > trendState.resistanceCeiling.strike + floorBuffer) {
      return { exit: true, reason: 'TREND_FLOOR_BREAK' };
    }
  }

  // 3. STOP_HIT
  if (position.stopSpx) {
    const stopHit = isBullish
      ? currentSpot <= position.stopSpx
      : currentSpot >= position.stopSpx;
    if (stopHit) return { exit: true, reason: 'STOP_HIT' };
  }

  // 4. PROFIT_TARGET (trend-aware)
  const movePct = Math.abs(spxProgress / position.entrySpx) * 100;
  let profitTargetPct = cfg.profit_target_pct || 0.15;
  if (isTrendAligned) profitTargetPct *= (cfg.trend_profit_target_multiplier ?? 2.5);
  if (spxProgress > 0 && movePct >= profitTargetPct) {
    return { exit: true, reason: 'PROFIT_TARGET' };
  }

  // 5. STOP_LOSS (trend-aware)
  let stopLossPct = cfg.stop_loss_pct || 0.20;
  if (isTrendAligned) stopLossPct *= (cfg.trend_stop_loss_multiplier ?? 2.0);
  if (spxProgress < 0 && Math.abs(movePct) >= stopLossPct) {
    return { exit: true, reason: 'STOP_LOSS' };
  }

  // 6. MOMENTUM_TIMEOUT (4 phases — phases 1-3 skipped during trend days)
  const phase0Seconds = cfg.momentum_phase0_seconds ?? 90;
  const phase0MinPts = cfg.momentum_phase0_min_pts ?? 0.5;
  const isHighConfEntry = position.confidence === 'HIGH' || position.confidence === 'VERY_HIGH';
  const phase1Minutes = isHighConfEntry
    ? (cfg.momentum_phase1_high_conf_minutes ?? 7)
    : (cfg.momentum_phase1_minutes ?? 5);
  const phase1Seconds = phase1Minutes * 60;

  // Phase 0: exempt from min hold — skip entirely during confirmed trend days and MAGNET_PULL
  const breakoutThreshold = cfg.breakout_score_threshold ?? 90;
  const isBreakoutEntry = isTrendAligned && position.entryContext?.gex_score_at_entry >= breakoutThreshold;
  const isMagnetPull = position.entryContext?.pattern === 'MAGNET_PULL';

  // MAGNET_PULL: skip Phase 0 entirely — magnets need time to attract price
  if (!isTrendAligned && !isBreakoutEntry && !isMagnetPull && holdSeconds >= phase0Seconds && holdSeconds < phase1Seconds) {
    if (spxProgress < phase0MinPts) {
      return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
    }
  }

  // Skip momentum phases 1-3 entirely during confirmed trend days and MAGNET_PULL trades
  // MAGNET_PULL relies on structural exits (TARGET_HIT, TRAILING_STOP, OPPOSING_WALL) instead
  if (!isTrendAligned && !isMagnetPull && !holdTooShort) {
    // Phase 1: adaptive timeout
    const phase1Pts = cfg.momentum_phase1_min_pts ?? 2;
    if (holdMinutes >= phase1Minutes && spxProgress < phase1Pts) {
      return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
    }

    // Phase 2: need 40% to target
    const phase2Min = cfg.momentum_phase2_minutes ?? 10;
    if (holdMinutes >= phase2Min && position.targetSpx) {
      const totalTarget = Math.abs(position.targetSpx - position.entrySpx);
      if (totalTarget > 0 && spxProgress < totalTarget * (cfg.momentum_phase2_target_pct ?? 0.40)) {
        return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
      }
    }

    // Phase 3: must be net positive
    const phase3Min = cfg.momentum_phase3_minutes ?? 15;
    if (holdMinutes >= phase3Min && spxProgress <= 0) {
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

  // 8. OPPOSING_WALL — skip during confirmed trend days (walls shift naturally)
  // v3: proximity check — only exit if wall is within 15 pts of spot (distant walls aren't immediate threats)
  if (!isTrendAligned && !holdTooShort) {
    const opposingWallValue = cfg.opposing_wall_exit_value || 5_000_000;
    const opposingWallMaxDist = cfg.opposing_wall_max_dist_pts ?? 15;
    const walls = isBullish ? scored.wallsAbove : scored.wallsBelow;
    const hasOpposing = walls?.some(w =>
      Math.abs(w.gexValue || w.absGexValue || 0) >= opposingWallValue
      && w.type === 'positive'
      && Math.abs(w.strike - currentSpot) <= opposingWallMaxDist
    );
    if (hasOpposing) {
      return { exit: true, reason: 'OPPOSING_WALL' };
    }
  }

  // 8b. STACK_DISPERSED — overhead magnet stack that justified the trade has disappeared
  if (!holdTooShort && position.entryContext?.initial_stack?.count > 0) {
    const stackPatterns = ['KING_NODE_BOUNCE', 'REVERSE_RUG'];
    if (stackPatterns.includes(position.entryContext.pattern)) {
      const stackPersistence = getStackPersistence('SPXW', position.direction);
      if (stackPersistence.disappeared) return { exit: true, reason: 'STACK_DISPERSED' };
      if (stackPersistence.trend === 'SHRINKING' && position.entryContext.initial_stack.totalNodes > 0) {
        const shrinkRatio = stackPersistence.currentNodeCount / position.entryContext.initial_stack.totalNodes;
        if (shrinkRatio < 0.5) position._stackShrinkTightened = true;
      }
    }
  }

  // 9. TRAILING_STOP (trend-aware)
  if (!holdTooShort) {
    let trailActivate = isTrendAligned
      ? (cfg.trend_trail_activate_pts ?? 5)
      : (cfg.trailing_stop_activate_pts || 8);
    let trailDistance = isTrendAligned
      ? (cfg.trend_trail_distance_pts ?? 8)
      : (cfg.trailing_stop_distance_pts || 5);
    // Tighten if stack is shrinking (>50% lost)
    if (position._stackShrinkTightened) {
      trailActivate = Math.max(3, Math.round(trailActivate * 0.6));
      trailDistance = Math.max(3, Math.round(trailDistance * 0.7));
    }
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

  // 11. GEX_FLIP (trend-aware: require consecutive opposing cycles)
  if (!holdTooShort && scored.score >= (cfg.gex_exit_threshold || 40)) {
    const gexBullish = scored.direction === 'BULLISH';
    if (gexBullish !== isBullish) {
      if (isTrendAligned) {
        position._gexFlipCount = (position._gexFlipCount || 0) + 1;
        const requiredFlips = cfg.trend_gex_flip_required_cycles ?? 3;
        if (position._gexFlipCount >= requiredFlips) {
          return { exit: true, reason: 'GEX_FLIP' };
        }
      } else {
        return { exit: true, reason: 'GEX_FLIP' };
      }
    } else {
      if (position._gexFlipCount) position._gexFlipCount = 0;
    }
  }

  return { exit: false };
}

/**
 * Find the next magnet target in stacked walls beyond the current target (replay version).
 */
function findNextMagnetReplay(stackedWalls, currentTarget, isBullish, maxDist) {
  const relevantTypes = isBullish ? ['magnet_above'] : ['magnet_below'];
  let best = null, bestDist = Infinity;
  for (const stack of stackedWalls) {
    if (stack.ticker !== 'SPXW' || !relevantTypes.includes(stack.type)) continue;
    const magnetStrike = isBullish ? stack.startStrike : stack.endStrike;
    const beyond = isBullish ? magnetStrike > currentTarget : magnetStrike < currentTarget;
    if (!beyond) continue;
    const dist = Math.abs(magnetStrike - currentTarget);
    if (dist <= maxDist && dist < bestDist) { best = { strike: magnetStrike, type: stack.type }; bestDist = dist; }
  }
  return best;
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

// ---- Child Process Handler (for dashboard backtest API) ----

if (process.send) {
  process.on('message', (msg) => {
    try {
      const { date, configOverride } = msg;
      const result = replayDate(date, configOverride);
      process.send({ type: 'result', data: result }, () => {
        process.disconnect();
      });
    } catch (err) {
      process.send({ type: 'error', message: err.message }, () => {
        process.disconnect();
      });
    }
  });
}

// ---- CLI Entry Point (only when run directly, not as child process) ----

if (!process.send) {
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
}
