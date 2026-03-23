/**
 * GexClaw JSON Replay Engine
 * Replays raw GEX JSON snapshots through the full pipeline.
 * Supports both legacy SPXW-only and trinity (SPXW+SPY+QQQ) JSON formats.
 *
 * Usage: node src/backtest/replay-json.js <path-to-json> [--quiet]
 */

import { readFileSync } from 'fs';
import { DateTime } from 'luxon';
import { parseGexResponse, identifyWalls } from '../gex/gex-parser.js';
import { scoreSpxGex } from '../gex/gex-scorer.js';
import { detectAllPatterns } from '../gex/gex-patterns.js';
import { analyzeMultiTicker } from '../gex/multi-ticker-analyzer.js';
import { checkGexOnlyEntry, checkTrendPullbackEntry } from '../trades/entry-engine.js';
import { checkEntryGates, recordEntryForGates, recordExitForGates, resetDailyGates } from '../trades/entry-gates.js';
import { buildEntryContext } from '../trades/entry-context.js';
import {
  resetDailyState, saveGexRead, saveNodeSnapshot, saveStrikeMemory, getGexConviction,
  isThesisNodeAlive, recordScore, updateRegime, getNodeTrends, updateLatestSpot,
  updateHodLod, getHodLod, setReplayTime, getGexHistory, detectWallTrends,
  saveKingNode, getNodeSignChanges, getKingNodeFlip, saveStackSnapshot, getStackPersistence,
} from '../store/state.js';
import { updateNodeTouches, resetNodeTouches, getNodeTouches } from '../gex/node-tracker.js';
import { initStrategyStore, getActiveConfig, getVersionLabel, setActiveConfigOverride } from '../review/strategy-store.js';
import { updateTrendBuffer, detectTrendDay, getTrendState, resetTrendDetector } from '../store/trend-detector.js';
import {
  scoreTrendDay, checkConfirmationGate, checkSecondCandleConfirmation, updateLaneCDirection,
  checkLaneCEntry, checkLaneCTrendPullback,
  checkLaneCExits, trackLaneCRegime, openLaneCPosition, closeLaneCPosition,
  isLaneCActive, hasLaneCPosition, resetLaneC, getLaneCState, setPriorDayNetGex,
  setPriorDayCloseNearLow, recordDayResult, getDayTracker, isLaneCConfirmed,
} from '../trades/lane-c.js';
import { getNetGexRoC } from '../store/state.js';
import { TechnicalAgent } from '../technicals/technical-agent.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ReplayJSON');

// Global technical agent instance (persists across frames within a day, resets daily)
const techAgent = new TechnicalAgent();

// ---- Frame → Raw format for parseGexResponse ----

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

// ---- Convert UTC timestamp → ET DateTime ----

function frameTimestampToET(utcTimestamp) {
  return DateTime.fromISO(utcTimestamp, { zone: 'UTC' }).setZone('America/New_York');
}

function frameTimestampToETString(utcTimestamp) {
  return frameTimestampToET(utcTimestamp).toFormat('yyyy-MM-dd HH:mm:ss');
}

// ---- Build ticker state for multi-ticker analyzer (mirrors trinity.js buildTickerState) ----

function buildTickerState(ticker, parsed, walls, scored, wallTrends) {
  const spotPrice = parsed.spotPrice;
  const spotIdx = parsed.strikes.findIndex(s => s >= spotPrice);
  const startIdx = Math.max(0, spotIdx - 20);
  const endIdx = Math.min(parsed.strikes.length, spotIdx + 20);

  const strikes = [];
  let maxAbsGex = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const strike = parsed.strikes[i];
    const gexValue = parsed.aggregatedGex.get(strike) || 0;
    maxAbsGex = Math.max(maxAbsGex, Math.abs(gexValue));
    strikes.push({ strike, gexValue });
  }

  let largestWall = null;
  let largestAbsGex = 0;
  for (const strike of parsed.strikes) {
    const gex = parsed.aggregatedGex.get(strike) || 0;
    if (Math.abs(gex) > largestAbsGex) {
      largestAbsGex = Math.abs(gex);
      largestWall = {
        strike,
        gexValue: gex,
        absGexValue: Math.abs(gex),
        type: gex > 0 ? 'positive' : 'negative',
        relativeToSpot: strike > spotPrice ? 'above' : strike < spotPrice ? 'below' : 'at',
        distanceFromSpot: Math.abs(strike - spotPrice),
        distancePct: (Math.abs(strike - spotPrice) / spotPrice * 100),
      };
    }
  }

  const nodeTrends = getNodeTrends(ticker);

  return {
    ticker,
    spotPrice,
    scored: {
      score: scored.score,
      direction: scored.direction,
      confidence: scored.confidence,
      environment: scored.environment,
      envDetail: scored.envDetail,
      gexAtSpot: scored.gexAtSpot,
      smoothedGexAtSpot: scored.smoothedGexAtSpot,
      breakdown: scored.breakdown,
      targetWall: scored.targetWall,
      floorWall: scored.floorWall,
      distanceToTarget: scored.distanceToTarget,
      wallsAbove: scored.wallsAbove,
      wallsBelow: scored.wallsBelow,
    },
    strikes,
    maxAbsGex,
    topWalls: walls.slice(0, 10),
    largestWall,
    wallTrends: wallTrends || [],
    nodeTrends: nodeTrends || new Map(),
    aggregatedGex: parsed.aggregatedGex,
    allExpGex: parsed.allExpGex,
    vexMap: parsed.vexMap,
  };
}

// ---- Detect frame format ----

function isTrinityFrame(frame) {
  return frame.tickers && typeof frame.tickers === 'object';
}

// ---- Core Replay Function ----

export function replayJsonFile(jsonPath, configOverride = null) {
  const rawJson = readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(rawJson);
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity' || (frames.length > 0 && isTrinityFrame(frames[0]));

  log.info(`Loaded ${frames.length} frames for ${dateStr} (${isTrinity ? 'trinity' : 'SPXW-only'} mode)`);

  // Initialize
  initStrategyStore();
  if (configOverride && typeof configOverride === 'object') {
    setActiveConfigOverride(configOverride);
  }
  const cfg = getActiveConfig();

  resetDailyState();
  resetNodeTouches();
  resetDailyGates();
  resetTrendDetector();
  resetLaneC();
  techAgent.resetDaily();

  const state = {
    position: null,
    laneCPosition: null,
    trades: [],
    blockedEntries: [],
    cycleCount: 0,
    firstSpot: null,
    laneCScored: false,
    _lcOpenSpot: null,  // 9:30 open price for confirmation gate
    _lcFirstCandleSpot: null, // 9:40 spot for second candle check
    _spotHistory: [],  // rolling window of recent spot prices for momentum checks
  };

  // Process each frame
  for (const frame of frames) {
    if (isTrinity) {
      // Trinity mode: frame.tickers.SPXW / SPY / QQQ
      if (!frame.tickers?.SPXW?.spotPrice || !frame.tickers?.SPXW?.gammaValues) continue;
    } else {
      // Legacy mode: frame.spotPrice / gammaValues
      if (!frame.spotPrice || !frame.gammaValues) continue;
    }
    state.cycleCount++;
    replayJsonCycle(frame, state, cfg, isTrinity);
  }

  // Force-close Lane A at EOD
  if (state.position && frames.length > 0) {
    const lastFrame = frames[frames.length - 1];
    const lastSpot = isTrinity
      ? lastFrame.tickers?.SPXW?.spotPrice
      : lastFrame.spotPrice;
    if (lastSpot) {
      closeReplayPosition(state, lastSpot, 'EOD_CLOSE', frameTimestampToETString(lastFrame.timestamp));
    }
  }

  // Force-close Lane C at EOD
  if (state.laneCPosition && frames.length > 0) {
    const lastFrame = frames[frames.length - 1];
    const lastSpot = isTrinity
      ? lastFrame.tickers?.SPXW?.spotPrice
      : lastFrame.spotPrice;
    if (lastSpot) {
      closeLaneCPosition(state, lastSpot, 'LC_EOD_CLOSE', frameTimestampToETString(lastFrame.timestamp));
    }
  }

  // Save this day's ending net GEX for tomorrow's delta comparison
  const endingNetGex = getNetGexRoC('SPXW').current;
  if (endingNetGex) setPriorDayNetGex(endingNetGex);

  // Record Lane C day result for day-type tracker
  const lcState = getLaneCState();
  const lcDateStr = frames.length > 0 ? frameTimestampToETString(frames[0].timestamp).split(' ')[0] : 'unknown';
  recordDayResult(lcDateStr, lcState.active || lcState.score > 0, lcState.score, lcState.signals, lcState.confirmed, state.trades);

  // Detect if today closed near lows (for tomorrow's prior_day_near_lows signal)
  if (frames.length > 10) {
    const lastN = frames.slice(-20); // last ~10 minutes
    const spots = lastN.map(f => isTrinity ? f.tickers?.SPXW?.spotPrice : f.spotPrice).filter(Boolean);
    const allSpots = frames.map(f => isTrinity ? f.tickers?.SPXW?.spotPrice : f.spotPrice).filter(Boolean);
    if (spots.length > 0 && allSpots.length > 0) {
      const dayLow = Math.min(...allSpots);
      const dayHigh = Math.max(...allSpots);
      const dayRange = dayHigh - dayLow;
      const closeSpot = spots[spots.length - 1];
      const closePosition = dayRange > 0 ? (closeSpot - dayLow) / dayRange : 0.5;
      setPriorDayCloseNearLow(closePosition < 0.25); // bottom 25% of range = near lows
    }
  }

  setReplayTime(null);
  return buildReplayReport(state, dateStr);
}

// ---- Single Cycle Replay ----

function replayJsonCycle(frame, state, cfg, isTrinity) {
  const snapshotTime = frameTimestampToET(frame.timestamp);
  const etTimestamp = snapshotTime.toFormat('yyyy-MM-dd HH:mm:ss');
  setReplayTime(snapshotTime);

  // ---- Parse SPXW (always required) ----
  const spxwFrameData = isTrinity ? frame.tickers.SPXW : frame;
  const spxwRaw = frameToRaw(spxwFrameData);
  const spxwParsed = parseGexResponse(spxwRaw);
  const spxwWalls = identifyWalls(spxwParsed);
  spxwParsed.walls = spxwWalls;

  saveGexRead(spxwParsed, 'SPXW');
  saveNodeSnapshot(spxwWalls, 'SPXW');
  saveStrikeMemory(spxwWalls, spxwParsed.spotPrice, 'SPXW');

  const spxwHistory = getGexHistory('SPXW');
  const spxwWallTrends = spxwHistory.length >= 2 ? detectWallTrends(spxwWalls, spxwHistory) : [];
  const spxwScored = scoreSpxGex(spxwParsed, spxwWallTrends, 0, 'SPXW');

  // ---- Parse SPY + QQQ if trinity mode ----
  let spyState = null;
  let qqqState = null;

  if (isTrinity) {
    // SPY
    const spyData = frame.tickers.SPY;
    if (spyData && !spyData.error && spyData.spotPrice && spyData.gammaValues) {
      const spyRaw = frameToRaw(spyData);
      const spyParsed = parseGexResponse(spyRaw);
      const spyWalls = identifyWalls(spyParsed);
      spyParsed.walls = spyWalls;

      saveGexRead(spyParsed, 'SPY');
      saveNodeSnapshot(spyWalls, 'SPY');

      const spyHistory = getGexHistory('SPY');
      const spyWallTrends = spyHistory.length >= 2 ? detectWallTrends(spyWalls, spyHistory) : [];
      const spyScored = scoreSpxGex(spyParsed, spyWallTrends, 0, 'SPY');

      recordScore('SPY', spyScored.score, spyScored.direction, spyParsed.spotPrice);
      updateRegime('SPY', spyScored.direction);

      spyState = buildTickerState('SPY', spyParsed, spyWalls, spyScored, spyWallTrends);
    }

    // QQQ
    const qqqData = frame.tickers.QQQ;
    if (qqqData && !qqqData.error && qqqData.spotPrice && qqqData.gammaValues) {
      const qqqRaw = frameToRaw(qqqData);
      const qqqParsed = parseGexResponse(qqqRaw);
      const qqqWalls = identifyWalls(qqqParsed);
      qqqParsed.walls = qqqWalls;

      saveGexRead(qqqParsed, 'QQQ');
      saveNodeSnapshot(qqqWalls, 'QQQ');

      const qqqHistory = getGexHistory('QQQ');
      const qqqWallTrends = qqqHistory.length >= 2 ? detectWallTrends(qqqWalls, qqqHistory) : [];
      const qqqScored = scoreSpxGex(qqqParsed, qqqWallTrends, 0, 'QQQ');

      recordScore('QQQ', qqqScored.score, qqqScored.direction, qqqParsed.spotPrice);
      updateRegime('QQQ', qqqScored.direction);

      qqqState = buildTickerState('QQQ', qqqParsed, qqqWalls, qqqScored, qqqWallTrends);
    }
  }

  // ---- Feed Technical Agent with price ticks ----
  techAgent.addTick('SPXW', spxwParsed.spotPrice, frame.timestamp);
  if (isTrinity && frame.tickers.SPY?.spotPrice) {
    techAgent.addTick('SPY', frame.tickers.SPY.spotPrice, frame.timestamp);
  }
  if (isTrinity && frame.tickers.QQQ?.spotPrice) {
    techAgent.addTick('QQQ', frame.tickers.QQQ.spotPrice, frame.timestamp);
  }

  // ---- Multi-ticker analysis ----
  let multiAnalysis;
  let scored = spxwScored;

  if (spyState || qqqState) {
    // Build SPXW state for analyzeMultiTicker
    const spxwState = buildTickerState('SPXW', spxwParsed, spxwWalls, spxwScored, spxwWallTrends);
    multiAnalysis = analyzeMultiTicker(spxwState, spyState, qqqState);

    // Re-score SPXW with multi-ticker bonus
    if (multiAnalysis.bonus > 0) {
      scored = scoreSpxGex(spxwParsed, spxwWallTrends, multiAnalysis.bonus, 'SPXW');
    }
  } else {
    // SPXW-only fallback
    multiAnalysis = {
      bonus: 0,
      alignment: { count: 1, direction: scored.direction, total: 1 },
      driver: null,
      rug_setups: [],
      stacked_walls: [],
      king_nodes: {},
      node_slides: [],
      wall_classifications: [],
      multi_signal: {},
      reshuffles: [],
      hedge_nodes: [],
    };
  }

  // Save king node for type flip detection
  const spxwKingNode = multiAnalysis.king_nodes?.SPXW;
  if (spxwKingNode) saveKingNode(spxwKingNode, 'SPXW');

  // Save stacked walls snapshot for persistence tracking
  saveStackSnapshot(multiAnalysis.stacked_walls || [], 'SPXW');

  // Track state
  updateNodeTouches(spxwParsed.spotPrice, spxwWalls);
  recordScore('SPXW', scored.score, scored.direction, scored.spotPrice);
  updateRegime('SPXW', scored.direction);
  updateLatestSpot(spxwParsed.spotPrice);
  updateHodLod(spxwParsed.spotPrice);

  // ---- Lane C: Pre-session scoring (after first N frames) ----
  if (!state.firstSpot && spxwParsed.spotPrice) {
    state.firstSpot = spxwParsed.spotPrice;
  }

  // Track spot prices for Lane C early velocity calculation
  if (!state._earlySpots) state._earlySpots = [];
  const scoringFrames = cfg.lane_c_scoring_frames ?? 5;
  if (state._earlySpots.length < scoringFrames) {
    state._earlySpots.push(spxwParsed.spotPrice);
  }

  if (cfg.lane_c_enabled !== false && !state.laneCScored && state.cycleCount === scoringFrames) {
    // Compute net GEX for each ticker
    let spxwNetGex = 0;
    for (const [, value] of spxwParsed.aggregatedGex) spxwNetGex += value;

    let spyNetGex = null;
    if (spyState) {
      spyNetGex = 0;
      for (const [, value] of spyState.aggregatedGex) spyNetGex += value;
    }

    let qqqNetGex = null;
    if (qqqState) {
      qqqNetGex = 0;
      for (const [, value] of qqqState.aggregatedGex) qqqNetGex += value;
    }

    // Compute early range and velocity from first N frames
    const spots = state._earlySpots;
    const earlyHigh = Math.max(...spots);
    const earlyLow = Math.min(...spots);
    const overnightRange = earlyHigh - earlyLow;
    const earlyVelocity = spots[spots.length - 1] - spots[0]; // positive = rallying, negative = selling

    scoreTrendDay({
      spxwNetGex,
      priorDayNetGex: getLaneCState().priorDayNetGex,
      spyNetGex,
      qqqNetGex,
      overnightRange,
      earlyVelocity,
      spotPrice: spxwParsed.spotPrice,
      spxwDirection: scored.direction,
    });
    state.laneCScored = true;
  }

  // Trend day detection
  updateTrendBuffer(scored, cfg);
  detectTrendDay();

  // Track spot price history for momentum/chop detection (rolling window)
  const spotHistoryWindow = cfg.spot_history_window ?? 10; // frames (~10 min)
  state._spotHistory.push(spxwParsed.spotPrice);
  if (state._spotHistory.length > spotHistoryWindow) state._spotHistory.shift();

  const replayTime = snapshotTime;

  // ---- EXIT CHECK: Lane A (if in position) ----
  if (state.position) {
    // Evaluate trend mode before exit checks — may upgrade trade
    evaluateTrendMode(state.position, scored, replayTime, cfg);

    const exitResult = checkReplayExits(
      state.position, spxwParsed.spotPrice, scored,
      multiAnalysis, null, cfg, replayTime, getTrendState()
    );
    if (exitResult.exit) {
      const exitPrice = exitResult.exitPrice || spxwParsed.spotPrice;
      const reason = state.position._trendMode ? `TM_${exitResult.reason}` : exitResult.reason;
      closeReplayPosition(state, exitPrice, reason, etTimestamp);
    }
  }

  // ---- EXIT CHECK: Lane C (independent from Lane A) ----
  if (state.laneCPosition) {
    trackLaneCRegime(state.laneCPosition, getNetGexRoC('SPXW').current);
    const lcExit = checkLaneCExits(state.laneCPosition, spxwParsed.spotPrice, scored, replayTime, cfg);
    if (lcExit.exit) {
      const exitPrice = lcExit.exitPrice || spxwParsed.spotPrice;
      closeLaneCPosition(state, exitPrice, lcExit.reason, etTimestamp);
    }
  }

  // ---- Lane C confirmation gate (9:30-9:45 window) ----
  // Track the 9:30 open spot for confirmation gate
  if (!state._lcOpenSpot && replayTime.hour === 9 && replayTime.minute >= 30) {
    state._lcOpenSpot = spxwParsed.spotPrice;
  }

  // Check confirmation gate at ~9:40 (10 min after open)
  const lcState = getLaneCState();
  if (lcState.active && !isLaneCConfirmed() && state._lcOpenSpot &&
      replayTime.hour === 9 && replayTime.minute >= 40) {
    if (lcState._requireSecondCandle && state._lcFirstCandleSpot &&
        ((replayTime.hour === 9 && replayTime.minute >= 59) || replayTime.hour >= 10)) {
      // Extended confirmation at 10:00 for large-impulse days (30 min of data for structural checks)
      const nodeTrendsForCheck = getNodeTrends('SPXW');
      checkSecondCandleConfirmation(state._lcOpenSpot, state._lcFirstCandleSpot, spxwParsed.spotPrice, scored, nodeTrendsForCheck);
    } else if (!lcState._requireSecondCandle) {
      // Normal first candle confirmation at 9:40 — pass scored + nodeTrends for structural exhaustion check
      const nodeTrends = getNodeTrends('SPXW');
      const result = checkConfirmationGate(state._lcOpenSpot, spxwParsed.spotPrice, scored.direction, scored, nodeTrends);
      if (!result.confirmed && getLaneCState()._requireSecondCandle) {
        // First candle was in caution zone — save 9:40 spot for second candle check
        state._lcFirstCandleSpot = spxwParsed.spotPrice;
      }
    }
  }

  // After confirmation, allow direction refinement on large moves
  if (isLaneCActive() && state.firstSpot && replayTime.hour >= 10) {
    updateLaneCDirection(spxwParsed.spotPrice, state.firstSpot, scored);
  }

  // ---- ENTRY CHECK (if flat) ----
  if (!state.position && replayTime.hour >= 9 && (replayTime.hour > 9 || replayTime.minute >= 30)) {
    const nodeTouches = getNodeTouches();
    const nodeTrends = getNodeTrends('SPXW');
    const nodeSignChanges = getNodeSignChanges('SPXW');
    const kingNodeFlip = getKingNodeFlip('SPXW');

    const detectedPatterns = detectAllPatterns(
      scored, spxwParsed, multiAnalysis,
      nodeTouches, nodeTrends, null,
      nodeSignChanges, kingNodeFlip
    );

    if (detectedPatterns.length > 0) {
      const entryState = { patterns: detectedPatterns, scored, multiAnalysis, nodeTouches, trendState: getTrendState() };
      const laneAResult = checkGexOnlyEntry(entryState);

      if (laneAResult?.shouldEnter) {
        const replayMs = replayTime.toMillis();
        const conviction = getGexConviction(spxwParsed.spotPrice, 'SPXW');
        const guardrail = checkEntryGates(
          laneAResult.action, scored, multiAnalysis,
          { lane: 'A', timeOverride: replayTime, nowMs: replayMs, pattern: laneAResult.trigger.pattern, trigger: laneAResult.trigger, trendState: getTrendState(), conviction }
        );

        // Daily loss limit: stop trading if cumulative day PnL below threshold
        const dayPnlSoFar = state.trades.reduce((sum, t) => sum + t.spxChange, 0);
        const dailyLossLimit = cfg.daily_loss_limit_pts ?? -999;
        if (dayPnlSoFar < dailyLossLimit) {
          guardrail.allowed = false;
          guardrail.reason = `Daily loss limit: ${dayPnlSoFar.toFixed(1)} < ${dailyLossLimit}`;
        }

        // Note: chop filters (daily loss limit, price momentum, adaptive chop) all tested
        // and shown to hurt overall performance. MAGNET_PULL is a leading indicator —
        // requiring price confirmation blocks V-recovery entries. Consecutive loss
        // cooldowns + pattern cooldowns are the optimal chop protection.

        // Max trades per day limit
        const maxDailyTrades = cfg.max_trades_per_day ?? 999;
        if (state.trades.length >= maxDailyTrades) {
          guardrail.allowed = false;
          guardrail.reason = `Max daily trades: ${state.trades.length} >= ${maxDailyTrades}`;
        }

        // No entry before time gate
        if (cfg.no_entry_before && replayTime) {
          const [nebH, nebM] = cfg.no_entry_before.split(':').map(Number);
          if (replayTime.hour < nebH || (replayTime.hour === nebH && replayTime.minute < nebM)) {
            guardrail.allowed = false;
            guardrail.reason = `No entry before ${cfg.no_entry_before}`;
          }
        }

        // Pattern-specific min score gate
        const patMinScoreKey = `${laneAResult.trigger.pattern.toLowerCase()}_min_score`;
        const patMinScore = cfg[patMinScoreKey] ?? 0;
        if (patMinScore > 0 && scored.score < patMinScore) {
          guardrail.allowed = false;
          guardrail.reason = `${laneAResult.trigger.pattern} min score: ${scored.score} < ${patMinScore}`;
        }

        if (guardrail.allowed) {
          // Technical confluence check (Layer 4): require technicals to agree with GEX signal
          const confluence = cfg.confluence_gate_enabled === true
            ? techAgent.getConfluence(laneAResult.trigger.direction, spxwParsed.spotPrice)
            : null;
          const confluenceBlocked = confluence?.recommendation === 'BLOCK';

          if (confluenceBlocked) {
            state.blockedEntries.push({
              timestamp: etTimestamp,
              pattern: laneAResult.trigger.pattern,
              direction: laneAResult.trigger.direction,
              reason: `Confluence BLOCK: ${confluence.conflicts.join('; ')}`,
              score: scored.score,
            });
          } else {
            const entryContext = buildEntryContext(laneAResult.trigger, scored, multiAnalysis);
            // Attach confluence data for analysis
            if (confluence) entryContext._confluence = confluence;
            openReplayPosition(state, {
              direction: laneAResult.trigger.direction,
              spotPrice: spxwParsed.spotPrice,
              trigger: laneAResult.trigger,
              scored,
              entryContext,
              timestamp: etTimestamp,
              multiAnalysis,
              replayTime,
              conviction,
            });
            recordEntryForGates(replayMs, laneAResult.trigger.pattern);
          }
        } else {
          state.blockedEntries.push({
            timestamp: etTimestamp,
            pattern: laneAResult.trigger.pattern,
            direction: laneAResult.trigger.direction,
            reason: guardrail.reason,
            score: scored.score,
          });
        }
      }
    }

    // Trend pullback entry
    if (!state.position) {
      const currentTrend = getTrendState();
      if (currentTrend.isTrend) {
        const pullbackResult = checkTrendPullbackEntry(
          { scored, multiAnalysis, nodeTouches: getNodeTouches() },
          currentTrend
        );
        if (pullbackResult?.shouldEnter) {
          const replayMs = replayTime.toMillis();
          const pullbackConviction = getGexConviction(spxwParsed.spotPrice, 'SPXW');
          const guardrail = checkEntryGates(
            pullbackResult.action, scored, multiAnalysis,
            { lane: 'A', timeOverride: replayTime, nowMs: replayMs, pattern: 'TREND_PULLBACK', trigger: pullbackResult.trigger, trendState: currentTrend, conviction: pullbackConviction }
          );
          if (guardrail.allowed) {
            const entryContext = buildEntryContext(pullbackResult.trigger, scored, multiAnalysis);
            openReplayPosition(state, {
              direction: pullbackResult.trigger.direction,
              spotPrice: spxwParsed.spotPrice,
              trigger: pullbackResult.trigger,
              scored,
              entryContext,
              timestamp: etTimestamp,
              multiAnalysis,
              replayTime,
            });
            recordEntryForGates(replayMs, 'TREND_PULLBACK');
          } else {
            state.blockedEntries.push({
              timestamp: etTimestamp,
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

  // ---- LANE C ENTRY CHECK (parallel to Lane A, no gates) ----
  if (isLaneCActive() && !hasLaneCPosition() && replayTime.hour >= 9 && (replayTime.hour > 9 || replayTime.minute >= 30)) {
    const nodeTouches = getNodeTouches();
    const nodeTrends = getNodeTrends('SPXW');
    const nodeSignChanges = getNodeSignChanges('SPXW');
    const kingNodeFlip = getKingNodeFlip('SPXW');

    const detectedPatterns = detectAllPatterns(
      scored, spxwParsed, multiAnalysis,
      nodeTouches, nodeTrends, null,
      nodeSignChanges, kingNodeFlip
    );

    // Try pattern-based Lane C entry
    let lcEntry = checkLaneCEntry(scored, detectedPatterns, getTrendState(), replayTime);

    // Try TREND_PULLBACK-based Lane C entry if no pattern entry
    if (!lcEntry) {
      const currentTrend = getTrendState();
      if (currentTrend.isTrend) {
        const pullbackResult = checkTrendPullbackEntry(
          { scored, multiAnalysis, nodeTouches: getNodeTouches() },
          currentTrend
        );
        lcEntry = checkLaneCTrendPullback(pullbackResult);
      }
    }

    if (lcEntry?.shouldEnter) {
      openLaneCPosition(state, {
        direction: lcEntry.trigger.direction,
        spotPrice: spxwParsed.spotPrice,
        trigger: lcEntry.trigger,
        scored,
        timestamp: etTimestamp,
        entryTimestampMs: replayTime.toMillis(),
      });
    }
  }
}

// ---- Position Management ----

function openReplayPosition(state, params) {
  const { direction, spotPrice, trigger, scored, entryContext, timestamp, multiAnalysis, replayTime, conviction } = params;
  const cfg = getActiveConfig() || {};

  let stopSpx = trigger.stop_strike;

  const currentTrend = getTrendState();
  const entryTrendAligned = currentTrend?.isTrend && currentTrend.direction === direction
    && (currentTrend.strength === 'CONFIRMED' || currentTrend.strength === 'STRONG');
  if (entryTrendAligned && stopSpx) {
    const stopDist = Math.abs(stopSpx - spotPrice);
    const trendMult = cfg.trend_stop_multiplier ?? 1.5;
    stopSpx = direction === 'BULLISH' ? spotPrice - stopDist * trendMult : spotPrice + stopDist * trendMult;
  }

  if (scored.score >= (cfg.breakout_score_threshold ?? 90) && stopSpx) {
    const stopDist = Math.abs(stopSpx - spotPrice);
    const breakoutMult = cfg.breakout_stop_multiplier ?? 1.3;
    stopSpx = direction === 'BULLISH' ? spotPrice - stopDist * breakoutMult : spotPrice + stopDist * breakoutMult;
  }

  // Clamp stop to max distance after all multipliers
  // Pattern-specific stop caps: MAGNET_PULL benefits from tighter stops (MAE analysis shows
  // winners move immediately, so 3pt captures most wins while cutting stop losses)
  // EXCEPTION: conviction trades with far targets get wider stops — the pattern already
  // computed the right stop distance accounting for conviction, don't clamp it back down
  const patternStopKey = `${trigger.pattern.toLowerCase()}_max_stop_pts`;
  let maxStopDist = cfg[patternStopKey] ?? cfg.position_max_stop_pts ?? cfg.max_stop_distance_pts ?? 6;
  // On confirmed trend days with conviction AND a distant target, widen stops.
  // A 5-pt stop in a 20-pt chop zone before a 50-pt move wastes entries.
  // Only on trend days — chop days keep the tight stop.
  if (entryTrendAligned && conviction && conviction.conviction >= (cfg.conviction_min_override ?? 70) && conviction.direction === direction) {
    const targetDistForStop = trigger.target_strike ? Math.abs(trigger.target_strike - spotPrice) : 0;
    if (targetDistForStop >= 30) {
      const trendStopMax = cfg.conviction_trend_max_stop_pts ?? 8;
      maxStopDist = Math.max(maxStopDist, trendStopMax);
    }
  }
  if (maxStopDist > 0 && stopSpx) {
    const finalDist = Math.abs(stopSpx - spotPrice);
    if (finalDist > maxStopDist) {
      stopSpx = direction === 'BULLISH' ? spotPrice - maxStopDist : spotPrice + maxStopDist;
    }
  }

  // ML feature snapshot: capture everything available at entry time
  const hodLod = getHodLod(spotPrice);
  const alignment = multiAnalysis?.alignment || { count: 1, direction: 'CHOP' };
  const multiSignal = multiAnalysis?.multi_signal || {};
  const dayPnl = state.trades.reduce((sum, t) => sum + t.spxChange, 0);
  const tradesToday = state.trades.length;
  const recentLosses = state.trades.slice(-3).filter(t => !t.isWin).length;
  const targetDist = trigger.target_strike ? Math.abs(trigger.target_strike - spotPrice) : 0;
  const stopDist = stopSpx ? Math.abs(stopSpx - spotPrice) : 0;
  const rr = stopDist > 0 ? targetDist / stopDist : 0;
  const hour = replayTime?.hour ?? 0;
  const minute = replayTime?.minute ?? 0;
  const minuteOfDay = hour * 60 + minute;

  const mlFeatures = {
    // Time features
    hour, minute, minuteOfDay,
    // GEX score features
    score: scored.score,
    rawScore: scored.rawScore ?? scored.score,
    gexAtSpot: scored.gexAtSpot ?? 0,
    smoothedGexAtSpot: scored.smoothedGexAtSpot ?? 0,
    gammaRatio: scored.gammaRatio ?? 1,
    wallAsymmetry: scored.wallAsymmetry ?? 1,
    directionalBalance: scored.directionalBalance ?? 0,
    isChop: scored.isChop ? 1 : 0,
    inNegGamma: scored.environment === 'NEGATIVE GAMMA' ? 1 : 0,
    charmPressure: scored.charmPressure ?? 0,
    // Pattern/direction
    pattern: trigger.pattern,
    direction: direction === 'BULLISH' ? 1 : 0,
    confidence: trigger.confidence === 'HIGH' ? 2 : trigger.confidence === 'MEDIUM' ? 1 : 0,
    // Wall distances
    targetDist, stopDist, rr,
    callWallDist: scored.wallsAbove?.[0] ? Math.abs(scored.wallsAbove[0].strike - spotPrice) : 999,
    putWallDist: scored.wallsBelow?.[0] ? Math.abs(scored.wallsBelow[0].strike - spotPrice) : 999,
    // Multi-ticker
    alignmentCount: alignment.count ?? 1,
    alignmentMatchesDir: alignment.direction === (direction === 'BULLISH' ? 'BULLISH' : 'BEARISH') ? 1 : 0,
    multiBonus: multiAnalysis?.bonus ?? 0,
    multiConfidence: multiSignal.confidence === 'VERY_HIGH' ? 3 : multiSignal.confidence === 'HIGH' ? 2 : multiSignal.confidence === 'MEDIUM' ? 1 : 0,
    // HOD/LOD
    distFromHod: hodLod.hod ? spotPrice - hodLod.hod : 0,
    distFromLod: hodLod.lod ? spotPrice - hodLod.lod : 0,
    rangeUsed: (hodLod.hod && hodLod.lod && hodLod.hod > hodLod.lod) ? (spotPrice - hodLod.lod) / (hodLod.hod - hodLod.lod) : 0.5,
    // Momentum
    momentumPts: scored.momentum?.points ?? 0,
    momentumStrength: scored.momentum?.strength === 'STRONG' ? 2 : scored.momentum?.strength === 'MODERATE' ? 1 : 0,
    momentumAligned: scored.momentum?.direction === (direction === 'BULLISH' ? 'UP' : 'DOWN') ? 1 : (scored.momentum?.direction === 'NONE' ? 0 : -1),
    // Session context
    dayPnl, tradesToday, recentLosses,
    // Technical agent features (Layer 2+3)
    ...(() => {
      const spxSig = techAgent.getSignals('SPXW');
      const qqqLead = techAgent.getQqqLeadSignal();
      const conf = entryContext?._confluence;
      return {
        ta_vwapDist: spxSig.vwap ? Math.round((spotPrice - spxSig.vwap) * 100) / 100 : 0,
        ta_aboveVwap: spxSig.vwap ? (spotPrice > spxSig.vwap ? 1 : 0) : 0,
        ta_emaStackDir: spxSig.emaStack?.direction === 'BULLISH' ? 1 : spxSig.emaStack?.direction === 'BEARISH' ? -1 : 0,
        ta_emaStackStrength: spxSig.emaStack?.strength ?? 0,
        ta_emaAligned: spxSig.emaStack?.direction === (direction === 'BULLISH' ? 'BULLISH' : 'BEARISH') ? 1 : (spxSig.emaStack?.direction === 'CHOP' ? 0 : -1),
        ta_rsi: Math.round(spxSig.rsi ?? 50),
        ta_roc5: spxSig.roc?.roc5min ?? 0,
        ta_roc10: spxSig.roc?.roc10min ?? 0,
        ta_roc20: spxSig.roc?.roc20min ?? 0,
        ta_qqqLeadActive: qqqLead.active ? 1 : 0,
        ta_qqqLeadDir: qqqLead.direction === 'BULLISH' ? 1 : qqqLead.direction === 'BEARISH' ? -1 : 0,
        ta_qqqLeadAligned: qqqLead.direction === (direction === 'BULLISH' ? 'BULLISH' : 'BEARISH') ? 1 : (qqqLead.direction === 'NONE' ? 0 : -1),
        ta_qqqDivergence: qqqLead.divergence ? 1 : 0,
        ta_confluenceScore: conf?.score ?? 0,
        ta_confluenceConflicts: conf?.conflictCount ?? 0,
        ta_confluenceRec: conf?.recommendation ?? 'NONE',
      };
    })(),
  };

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
    worstSpxChange: 0,
    _gexFlipCount: 0,
    _trendMode: false,
    _mlFeatures: mlFeatures,
    _entryConviction: conviction?.conviction ?? 0,
    // Thesis target is the TRADE's target strike (where the magnet is), not conviction's dominant.
    // "I'm holding because the 6500 node is building" — 6500 is the target, not some random growing strike.
    _entryConvictionTarget: trigger.target_strike ?? conviction?.dominantStrike ?? null,
    _entryConvictionValue: conviction?.dominantValue ?? 0,
  };

  log.info(`ENTRY ${timestamp} | ${direction} @ $${spotPrice.toFixed(2)} via ${trigger.pattern} (${trigger.confidence}) | target=${trigger.target_strike} stop=${stopSpx?.toFixed(2) || '?'}`);
}

function closeReplayPosition(state, exitSpx, exitReason, timestamp) {
  const pos = state.position;
  if (!pos) return;

  const isBullish = pos.direction === 'BULLISH';
  const spxChange = isBullish ? exitSpx - pos.entrySpx : pos.entrySpx - exitSpx;

  const exitMs = DateTime.fromFormat(timestamp, 'yyyy-MM-dd HH:mm:ss', { zone: 'America/New_York' }).toMillis();

  state.trades.push({
    direction: pos.direction,
    pattern: pos.pattern,
    confidence: pos.confidence,
    entrySpx: pos.entrySpx,
    exitSpx,
    entryScore: pos.entryScore,
    spxChange: Math.round(spxChange * 100) / 100,
    pnlPct: Math.round((spxChange / pos.entrySpx) * 100 * 1000) / 1000,
    exitReason,
    isWin: spxChange > 0,
    openedAt: pos.openedAt,
    closedAt: timestamp,
    trendMode: pos._trendMode || false,
    mae: Math.round(pos.worstSpxChange * 100) / 100,
    mfe: Math.round(pos.bestSpxChange * 100) / 100,
    mlFeatures: pos._mlFeatures || null,
  });

  const pnlStr = `${spxChange > 0 ? '+' : ''}${(Math.round(spxChange * 100) / 100)} pts`;
  log.info(`EXIT  ${timestamp} | ${pos.direction} ${exitReason} | ${pnlStr} | ${spxChange > 0 ? 'WIN' : 'LOSS'}`);

  state.position = null;
  recordExitForGates(pos.direction, spxChange <= 0, exitMs, pos.pattern, spxChange);
}

// ---- Trend Mode Evaluation ----

/**
 * Evaluate whether a winning Lane A trade should switch to trend mode.
 * Trend mode disables scalping exits and widens the trail, allowing
 * the trade to ride large directional moves instead of taking 2-5 pts.
 *
 * Checked every cycle after 10 min hold time. Once activated, stays on.
 */
function evaluateTrendMode(position, scored, replayTime, cfg) {
  if (position._trendMode) return; // already in trend mode

  const isBullish = position.direction === 'BULLISH';
  const spxProgress = isBullish
    ? scored.spotPrice - position.entrySpx
    : position.entrySpx - scored.spotPrice;

  const holdMs = replayTime.toMillis() - position.entryTimestampMs;
  const holdMinutes = holdMs / 60_000;

  // Criterion 1 (required): Trade is in profit
  const minProfit = cfg.trend_mode_min_profit_pts ?? 2;
  const inProfit = spxProgress >= minProfit;
  if (!inProfit) return;

  // Criterion 2 (required): Sustained hold — not a spike
  // At least 2 minutes: the move isn't just a one-candle blip
  const minHoldMinutes = cfg.trend_mode_min_hold_minutes ?? 2;
  if (holdMinutes < minHoldMinutes) return;

  // Criterion 3 (bonus): Price still trending — HWM is near current (not retracing)
  // If drawdown from HWM exceeds 30%, the move may be fading
  const drawdownFromHWM = position.bestSpxChange - spxProgress;
  const hwmDrawdownPct = position.bestSpxChange > 0 ? drawdownFromHWM / position.bestSpxChange : 0;
  const notRetracing = hwmDrawdownPct < (cfg.trend_mode_max_drawdown_pct ?? 0.30);

  if (notRetracing) {
    position._trendMode = true;
    // Adaptive trail: cap trail so we never risk more than maxLossAllowance from HWM.
    // e.g. HWM=2pts, maxLoss=5 → trail=7, worst case = 2-7 = -5pts (not -10pts with fixed 12)
    let fixedTrail = cfg.trend_mode_trail_distance_pts ?? 12;
    let maxLossAllowance = cfg.trend_mode_trail_max_loss_pts ?? 5;
    const minTrail = cfg.trend_mode_trail_min_pts ?? 4;

    // Conviction-based trail widening: when the GEX landscape is screaming a direction
    // and the target is far away, give the trade more room to breathe through pullbacks.
    // A human trader watching -45M grow to -95M at 6500 wouldn't panic on a 3pt pullback.
    const entryConviction = position._entryConviction || 0;
    const targetDist = position.targetSpx ? Math.abs(position.targetSpx - position.entrySpx) : 0;
    const convictionMinForWide = cfg.conviction_trail_min ?? 50;
    if (entryConviction >= convictionMinForWide && targetDist >= 20) {
      // Scale trail based on target distance: 20pt target → 1.5x, 50pt+ → 2x
      const trailMultiplier = Math.min(2.0, 1.0 + targetDist / 100);
      fixedTrail = Math.round(fixedTrail * trailMultiplier);
      maxLossAllowance = Math.round(maxLossAllowance * trailMultiplier);
      log.info(`Conviction trail: ${entryConviction} conviction, ${targetDist.toFixed(0)}pt target → ${trailMultiplier.toFixed(1)}x trail (${fixedTrail}pt max, ${maxLossAllowance}pt loss allow)`);
    }

    const hwm = position.bestSpxChange > 0 ? position.bestSpxChange : spxProgress;
    const adaptiveTrail = Math.min(fixedTrail, hwm + maxLossAllowance);
    position._trendModeTrailDist = Math.max(adaptiveTrail, minTrail);

    // Ratchet stop: when TM activates, tighten stop to limit max loss
    const tmStopRatchet = cfg.tm_stop_ratchet_pts;
    if (tmStopRatchet != null && position.stopSpx) {
      const isBull = position.direction === 'BULLISH';
      const ratchetStop = isBull
        ? position.entrySpx - tmStopRatchet
        : position.entrySpx + tmStopRatchet;
      position.stopSpx = isBull
        ? Math.max(position.stopSpx, ratchetStop)
        : Math.min(position.stopSpx, ratchetStop);
    }

    log.info(`TREND MODE activated | ${position.direction} @ $${scored.spotPrice.toFixed(0)} | +${spxProgress.toFixed(1)} pts | hold ${holdMinutes.toFixed(0)}m | trail=${position._trendModeTrailDist.toFixed(1)}pts (HWM=${hwm.toFixed(1)})`);
  }
}

// ---- Exit Trigger Checks ----

function checkReplayExits(position, currentSpot, scored, multiAnalysis, spxwRow, cfg, replayTime, trendState) {
  const isBullish = position.direction === 'BULLISH';
  const isTrendAligned = trendState?.isTrend && trendState.direction === position.direction
    && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');

  const currentMs = replayTime.toMillis();
  const holdMs = currentMs - position.entryTimestampMs;
  const holdSeconds = holdMs / 1000;
  const holdMinutes = holdSeconds / 60;
  const holdTooShort = holdMinutes < (cfg.momentum_min_hold_minutes ?? 3);

  const spxProgress = isBullish
    ? currentSpot - position.entrySpx
    : position.entrySpx - currentSpot;

  if (spxProgress > position.bestSpxChange) {
    position.bestSpxChange = spxProgress;
  }
  if (spxProgress < position.worstSpxChange) {
    position.worstSpxChange = spxProgress;
  }

  // 1. TARGET_HIT
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
        } else {
          return { exit: true, reason: 'TARGET_HIT' };
        }
      } else {
        return { exit: true, reason: 'TARGET_HIT' };
      }
    }
  }

  // STOP_HIT — hard price stop.
  // CONVICTION HOLD: If this is a conviction trade and the thesis node is still building,
  // REMOVE the price stop entirely. The thesis is "the node is building all day and price
  // will reach it." A 5-pt bounce doesn't invalidate that — only the node weakening does.
  // This is how a human trades it: "I see 6500 growing from -18M to -95M. I'm holding
  // my puts through the chop at 6550 because the magnet keeps getting stronger."
  const entryConv = position._entryConviction || 0;
  const thesisTarget = position._entryConvictionTarget;
  const convictionHoldMin = cfg.conviction_hold_min ?? 60;
  let thesisHoldActive = false;

  if (entryConv >= convictionHoldMin && thesisTarget) {
    // Check the SPECIFIC thesis strike, not overall conviction.
    // "Is the 6500 node I entered on still massive/growing?"
    const thesisNode = isThesisNodeAlive(thesisTarget, position._entryConvictionValue, 'SPXW');
    const thesisIntact = thesisNode.alive;
    const convictionMaxLoss = cfg.conviction_hold_max_loss_pts ?? 10;
    const withinLossLimit = spxProgress > -convictionMaxLoss;

    if (thesisIntact && withinLossLimit) {
      thesisHoldActive = true;
      if (!position._thesisHoldLogged) {
        log.info(`THESIS HOLD active: ${thesisTarget} node ${(thesisNode.currentValue / 1e6).toFixed(0)}M (${thesisNode.trend}, ${(thesisNode.growthFromEntry * 100).toFixed(0)}% from entry) — price stop DISABLED, max loss ${convictionMaxLoss}pts`);
        position._thesisHoldLogged = true;
      }
    } else if (!thesisIntact && position._thesisHoldLogged) {
      log.info(`THESIS BROKEN: ${thesisTarget} node ${thesisNode.alive ? 'alive but' : 'weakened to'} ${(thesisNode.currentValue / 1e6).toFixed(0)}M — re-enabling price stop`);
      position._thesisHoldLogged = false;
    }
  }

  if (position.stopSpx && !thesisHoldActive) {
    const stopHit = isBullish
      ? currentSpot <= position.stopSpx
      : currentSpot >= position.stopSpx;
    if (stopHit) return { exit: true, reason: 'STOP_HIT', exitPrice: position.stopSpx };
  }

  // THESIS_TIMEOUT — early exit for non-TM losing trades
  // Data shows 72/106 non-TM stops never went positive (MFE=0).
  // Exiting at 3min/-1.5pt saves ~182 pts while killing only 7 wins.
  if (cfg.thesis_timeout_enabled === true && !position._trendMode && !isTrendAligned) {
    const thesisSeconds = cfg.thesis_timeout_seconds ?? 180;
    const thesisMaxLoss = cfg.thesis_timeout_max_loss_pts ?? 1.5;
    if (holdSeconds >= thesisSeconds && spxProgress <= -thesisMaxLoss) {
      return { exit: true, reason: 'THESIS_TIMEOUT' };
    }
  }

  // Trend mode: skip scalping exits, use only trend-appropriate exits
  const inTrendMode = position._trendMode === true;

  // 2. NODE_SUPPORT_BREAK — skip in trend mode (nodes shift during trends)
  if (position.entryContext && !inTrendMode && !cfg.node_break_disabled) {
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

  // 2b. TREND_FLOOR_BREAK
  if (!cfg.trend_floor_break_disabled && isTrendAligned && trendState.supportFloor?.strike) {
    const floorBuffer = cfg.trend_floor_break_buffer_pts ?? 3;
    if (isBullish && currentSpot < trendState.supportFloor.strike - floorBuffer) {
      return { exit: true, reason: 'TREND_FLOOR_BREAK' };
    }
    if (!isBullish && trendState.resistanceCeiling?.strike &&
        currentSpot > trendState.resistanceCeiling.strike + floorBuffer) {
      return { exit: true, reason: 'TREND_FLOOR_BREAK' };
    }
  }

  // 3. STOP_HIT — exit at stop level (simulates stop-limit order)
  // Thesis hold: same logic as pre-TM stop check — suppress if thesis node still building
  if (position.stopSpx && !thesisHoldActive) {
    const stopHit = isBullish
      ? currentSpot <= position.stopSpx
      : currentSpot >= position.stopSpx;
    if (stopHit) return { exit: true, reason: 'STOP_HIT', exitPrice: position.stopSpx };
  }

  // 4. PROFIT_TARGET
  const movePct = Math.abs(spxProgress / position.entrySpx) * 100;
  let profitTargetPct = cfg.profit_target_pct || 0.15;
  if (isTrendAligned) profitTargetPct *= (cfg.trend_profit_target_multiplier ?? 2.5);
  if (spxProgress > 0 && movePct >= profitTargetPct) {
    return { exit: true, reason: 'PROFIT_TARGET' };
  }

  // 5. STOP_LOSS
  let stopLossPct = cfg.stop_loss_pct || 0.20;
  if (isTrendAligned) stopLossPct *= (cfg.trend_stop_loss_multiplier ?? 2.0);
  if (spxProgress < 0 && Math.abs(movePct) >= stopLossPct) {
    return { exit: true, reason: 'STOP_LOSS' };
  }

  // 6. MOMENTUM_TIMEOUT — skip in trend mode (trade already proved momentum)
  if (!inTrendMode) {
    const phase0Seconds = cfg.momentum_phase0_seconds ?? 90;
    const phase0MinPts = cfg.momentum_phase0_min_pts ?? 0.5;
    const isHighConfEntry = position.confidence === 'HIGH' || position.confidence === 'VERY_HIGH';
    const phase1Minutes = isHighConfEntry
      ? (cfg.momentum_phase1_high_conf_minutes ?? 7)
      : (cfg.momentum_phase1_minutes ?? 5);
    const phase1Seconds = phase1Minutes * 60;
    const breakoutThreshold = cfg.breakout_score_threshold ?? 90;
    const isBreakoutEntry = isTrendAligned && position.entryContext?.gex_score_at_entry >= breakoutThreshold;
    const isMagnetPull = position.entryContext?.pattern === 'MAGNET_PULL';
    const isReverseRug = position.entryContext?.pattern === 'REVERSE_RUG';
    const isRugPull = position.entryContext?.pattern === 'RUG_PULL';
    const skipPhase0 = isMagnetPull || isReverseRug || (isRugPull && cfg.rug_pull_skip_phase0);

    if (!isTrendAligned && !isBreakoutEntry && !skipPhase0 && holdSeconds >= phase0Seconds && holdSeconds < phase1Seconds) {
      if (spxProgress < phase0MinPts) {
        return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
      }
    }

    const skipAllMomentum = isMagnetPull || (isRugPull && cfg.rug_pull_skip_momentum);
    if (!isTrendAligned && !skipAllMomentum && !holdTooShort) {
      const phase1Pts = cfg.momentum_phase1_min_pts ?? 2;
      if (holdMinutes >= phase1Minutes && spxProgress < phase1Pts) {
        return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
      }

      const phase2Min = cfg.momentum_phase2_minutes ?? 10;
      if (holdMinutes >= phase2Min && position.targetSpx) {
        const totalTarget = Math.abs(position.targetSpx - position.entrySpx);
        if (totalTarget > 0 && spxProgress < totalTarget * (cfg.momentum_phase2_target_pct ?? 0.40)) {
          return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
        }
      }

      const phase3Min = cfg.momentum_phase3_minutes ?? 15;
      if (holdMinutes >= phase3Min && spxProgress <= 0) {
        return { exit: true, reason: 'MOMENTUM_TIMEOUT' };
      }
    }
  }

  // 7. TV exits — skipped (no TV data in JSON replay)

  // 8. OPPOSING_WALL — skip in trend mode (walls shift during trends, this exit cuts winners)
  // Also skip for MAGNET_PULL — the magnet pull force should override temporary opposing walls;
  // the magnet target is already factored into the setup, so walls in the path are expected.
  const isOppWallMagnet = position.entryContext?.pattern === 'MAGNET_PULL' && (cfg.opposing_wall_skip_magnet_pull !== false);
  if (!inTrendMode && !isTrendAligned && !holdTooShort && !isOppWallMagnet && !cfg.opposing_wall_exit_disabled) {
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

  // 8b. STACK_DISPERSED
  if (!cfg.stack_dispersed_disabled && !holdTooShort && position.entryContext?.initial_stack?.count > 0) {
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

  // 9. TRAILING_STOP — trend mode uses wider trail (12+ pts)
  if (!holdTooShort) {
    let trailActivate, trailDistance;
    if (inTrendMode) {
      trailActivate = cfg.trend_mode_trail_activate_pts ?? 5;
      trailDistance = position._trendModeTrailDist || (cfg.trend_mode_trail_distance_pts ?? 12);
    } else if (isTrendAligned) {
      trailActivate = cfg.trend_trail_activate_pts ?? 5;
      trailDistance = cfg.trend_trail_distance_pts ?? 8;
    } else {
      trailActivate = cfg.trailing_stop_activate_pts || 8;
      trailDistance = cfg.trailing_stop_distance_pts || 5;
    }
    if (position._stackShrinkTightened) {
      trailActivate = Math.max(3, Math.round(trailActivate * 0.6));
      trailDistance = Math.max(3, Math.round(trailDistance * 0.7));
    }
    if (position.bestSpxChange >= trailActivate) {
      const drawdown = position.bestSpxChange - spxProgress;
      if (drawdown >= trailDistance) {
        // Trailing stop ALWAYS fires — it protects profits. Thesis hold only disables
        // the hard STOP_HIT (which is the one that kills entries on small bounces).
        const trailStopProgress = position.bestSpxChange - trailDistance;
        const trailExitPrice = isBullish
          ? position.entrySpx + trailStopProgress
          : position.entrySpx - trailStopProgress;
        return { exit: true, reason: 'TRAILING_STOP', exitPrice: trailExitPrice };
      }
    }
  }

  // 10. THETA_DEATH
  if (!cfg.theta_death_disabled) {
    const noEntryAfter = cfg.no_entry_after || '15:30';
    const [thetaH, thetaM] = noEntryAfter.split(':').map(Number);
    if (replayTime.hour > thetaH || (replayTime.hour === thetaH && replayTime.minute >= thetaM)) {
      return { exit: true, reason: 'THETA_DEATH' };
    }
  }

  // 11. GEX_FLIP — trend mode requires many more flips to confirm reversal
  if (!holdTooShort && cfg.gex_flip_exit_enabled !== false && scored.score >= (cfg.gex_exit_threshold || 40)) {
    const gexBullish = scored.direction === 'BULLISH';
    if (gexBullish !== isBullish) {
      if (inTrendMode) {
        // Trend mode: require sustained flip (10+ cycles = ~5 min of opposing direction)
        position._gexFlipCount = (position._gexFlipCount || 0) + 1;
        const requiredFlips = cfg.trend_mode_gex_flip_required_cycles ?? 10;
        if (position._gexFlipCount >= requiredFlips) {
          return { exit: true, reason: 'GEX_FLIP' };
        }
      } else if (isTrendAligned) {
        position._gexFlipCount = (position._gexFlipCount || 0) + 1;
        const requiredFlips = cfg.trend_gex_flip_required_cycles ?? 3;
        if (position._gexFlipCount >= requiredFlips) {
          return { exit: true, reason: 'GEX_FLIP' };
        }
      } else {
        // Non-trend: configurable confirmation delay (default 1 = immediate, backward compat)
        // Increasing to 2-3 filters brief GEX noise and prevents premature exits.
        // Per-pattern override: MAGNET_PULL has strong underlying gamma force, allow more cycles.
        const entryPattern = position.entryContext?.pattern;
        const patternOverride = entryPattern ? (cfg[`${entryPattern.toLowerCase()}_gex_flip_required_cycles`] ?? null) : null;
        const requiredFlips = patternOverride ?? cfg.gex_flip_required_cycles ?? 1;
        position._gexFlipCount = (position._gexFlipCount || 0) + 1;
        if (position._gexFlipCount >= requiredFlips) {
          return { exit: true, reason: 'GEX_FLIP' };
        }
      }
    } else {
      if (position._gexFlipCount) position._gexFlipCount = 0;
    }
  }

  return { exit: false };
}

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

  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  const patternPerf = {};
  for (const t of trades) {
    if (!patternPerf[t.pattern]) patternPerf[t.pattern] = { wins: 0, losses: 0, totalPnl: 0 };
    if (t.isWin) patternPerf[t.pattern].wins++;
    else patternPerf[t.pattern].losses++;
    patternPerf[t.pattern].totalPnl += t.spxChange;
  }

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

import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const batchMode = args.includes('--batch');
const quiet = args.includes('--quiet');
const auditMode = args.includes('--audit');
const featuresMode = args.includes('--features');

// Batch mode: process multiple files in sequence, preserving Lane C cross-day state
if (batchMode) {
  const files = args.filter(a => a.endsWith('.json')).sort();
  if (files.length === 0) {
    console.error('Usage: node src/backtest/replay-json.js --batch data/gex-replay-*.json [--quiet] [--audit]');
    process.exit(1);
  }

  const allReports = [];
  for (const file of files) {
    const report = replayJsonFile(file);
    if (report) {
      allReports.push(report);
      if (!quiet) {
        console.log(`SUMMARY: ${report.date} | ${report.totalTrades} trades | ${report.wins}W/${report.losses}L | NET: ${report.totalPnlPts > 0 ? '+' : ''}${report.totalPnlPts} pts`);
      }
    }
  }

  // Print batch summary
  const totalTrades = allReports.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins = allReports.reduce((s, r) => s + r.wins, 0);
  const totalLosses = allReports.reduce((s, r) => s + r.losses, 0);
  const totalPnl = allReports.reduce((s, r) => s + r.totalPnlPts, 0);
  console.log(`\nDays: ${allReports.length} | Trades: ${totalTrades} | Wins: ${totalWins} | Losses: ${totalLosses} | NET: ${totalPnl > 0 ? '+' : ''}${Math.round(totalPnl * 100) / 100} pts`);

  // Audit mode: print Lane C day tracker
  if (auditMode) {
    const tracker = getDayTracker();
    console.log('\n=== LANE C DAY TRACKER ===');
    console.log('Date         | Score | Act | Conf | LC Trades | LC PnL  | Signals');
    for (const day of tracker) {
      const sigStr = Object.keys(day.signals).join(', ') || '-';
      console.log(`${day.date} | ${String(day.score).padStart(5)} | ${day.activated ? 'YES' : ' no'} | ${day.confirmed ? 'YES' : ' no'} | ${String(day.trades).padStart(9)} | ${(day.pnl > 0 ? '+' : '') + day.pnl.toFixed(1).padStart(6)} | ${sigStr}`);
    }
    const act = tracker.filter(d => d.activated).length;
    const conf = tracker.filter(d => d.confirmed).length;
    console.log(`\nActivation: ${act}/${tracker.length} | Confirmed: ${conf}/${tracker.length}`);
  }

  // Write all trades to results file for analyze-results.js
  const allTrades = allReports.flatMap(r => r.trades);
  for (const r of allReports) {
    // Re-print full trade log for analyze-results.js parsing
    if (!quiet) {
      for (const t of r.trades) {
        const pnlStr = `${t.spxChange > 0 ? '+' : ''}${t.spxChange}`;
        const tag = t.isWin ? 'WIN ' : 'LOSS';
        console.log(`  ${t.openedAt} | ${t.direction.padEnd(7)} ${t.pattern.padEnd(20)} | $${t.entrySpx.toFixed(2)} -> $${t.exitSpx.toFixed(2)} | ${pnlStr.padStart(8)} pts | ${t.exitReason.padEnd(18)} | ${tag} | score=${t.entryScore}`);
      }
    }
  }

  // Features mode: export ML training dataset as JSON
  if (featuresMode) {
    const trainingData = allTrades
      .filter(t => t.mlFeatures)
      .map(t => ({
        ...t.mlFeatures,
        // Target variables
        isWin: t.isWin ? 1 : 0,
        spxChange: t.spxChange,
        exitReason: t.exitReason,
        mae: t.mae ?? 0,
        mfe: t.mfe ?? 0,
        // Metadata (not for training, for analysis)
        _openedAt: t.openedAt,
        _closedAt: t.closedAt,
        _entrySpx: t.entrySpx,
      }));
    const outPath = 'data/ml-training-data.json';
    writeFileSync(outPath, JSON.stringify(trainingData, null, 2));
    console.error(`\nML training data: ${trainingData.length} trades written to ${outPath}`);
  }

  process.exit(0);
}

const jsonPath = args[0];

if (!jsonPath) {
  console.error('Usage: node src/backtest/replay-json.js <path-to-json> [--quiet]');
  console.error('       node src/backtest/replay-json.js --batch data/gex-replay-*.json [--quiet] [--audit]');
  process.exit(1);
}

const report = replayJsonFile(jsonPath);

if (!report) {
  process.exit(1);
}

if (!quiet) {
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
      console.log(`  ${t.openedAt} | ${t.direction.padEnd(7)} ${t.pattern.padEnd(20)} | $${t.entrySpx.toFixed(2)} -> $${t.exitSpx.toFixed(2)} | ${pnlStr.padStart(8)} pts | ${t.exitReason.padEnd(18)} | ${tag} | score=${t.entryScore}`);
    }
  }
}

// Machine-readable summary line (always printed)
console.log(`\nSUMMARY: ${report.date} | ${report.totalTrades} trades | ${report.wins}W/${report.losses}L | NET: ${report.totalPnlPts > 0 ? '+' : ''}${report.totalPnlPts} pts`);
