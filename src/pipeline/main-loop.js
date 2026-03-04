/**
 * Main Polling Loop — The orchestrator.
 * Replaces Chrome extension's background.js service worker.
 *
 * Handles:
 * - Variable-rate polling based on schedule phase
 * - GEX fetch → parse → score → alert pipeline
 * - Direction flip detection
 * - Wall change alerts
 * - Proximity alerts
 * - Opening summary & EOD recap
 * - Health heartbeats
 * - Win/loss tracking
 */

import { formatDollar } from '../gex/gex-parser.js';
import { scoreSpxGex } from '../gex/gex-scorer.js';
import { fetchTrinityData, getTrinityState } from '../gex/trinity.js';
import { analyzeMultiTicker, getLastMultiAnalysis } from '../gex/multi-ticker-analyzer.js';
import { CONFIDENCE, FULL_ANALYSIS_COOLDOWN_MS, HEALTH_HEARTBEAT_INTERVAL_MS } from '../gex/constants.js';
import { saveSnapshot, savePrediction, saveHealth, saveMultiAnalysis, saveAlert, saveRawSnapshot, getCheckedPredictionsToday, getUncheckedPredictions, markPredictionChecked, cleanupOldData, getTradeById, getTradesByDate, getPhantomTradesByDate, getDecisionsByDate, getTvSignalLogByDate, getGexSnapshotsByDate, getAlertsByDate, getTodaysPredictions } from '../store/db.js';
import { resetDailyState, updateLatestSpot, recordScore, detectChopMode, updateRegime, saveKingNode, getNodeSignChanges, getKingNodeFlip, saveStackSnapshot } from '../store/state.js';
import { shouldSendAlert } from '../alerts/throttle.js';
import { sendSpxAnalysis, sendLiveAlert, sendOpeningSummary, sendEodRecap, sendEodSummary, sendHealthHeartbeat, sendCombinedSignalAlert, sendTradeCard, sendPositionUpdate, sendTradeClosed, sendStrategyChange, sendStrategyRollback, sendNoChange, sendMapReshuffleAlert, sendReviewReport } from '../alerts/discord.js';
import { runDecisionCycle } from '../agent/decision-engine.js';
import { initTradeManager, getPositionState, getCurrentPosition, enterPosition, manageCycle as managePosition, exitPosition, shouldBePhantom, expireCrossDayTrade } from '../trades/trade-manager.js';
import { initPhantomTracker, recordPhantom, updatePhantoms, expireCrossDayPhantoms } from '../trades/phantom-tracker.js';
import { checkGexOnlyEntry, checkLaneBEntry, checkTrendPullbackEntry } from '../trades/entry-engine.js';
import { checkEntryGates, recordEntryForGates, recordExitForGates, resetDailyGates } from '../trades/entry-gates.js';
import { buildEntryContext } from '../trades/entry-context.js';
import { detectAllPatterns } from '../gex/gex-patterns.js';
import { getNodeTouches } from '../gex/node-tracker.js';
import { getSignalSnapshot } from '../tv/tv-signal-store.js';
import { getSchedulePhase, isOpeningSummaryTime, isEodRecapTime, nowET, formatET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';
import { updateLoopStatus } from './loop-status.js';
import { dashboardEmitter } from '../dashboard/dashboard-server.js';
import { initStrategyStore, getVersionLabel, getActiveVersionNumber, getActiveConfig } from '../review/strategy-store.js';
import { runPhantomComparison } from '../review/phantom-engine.js';
import { checkRollbackTriggers } from '../review/rollback-engine.js';
import { runNightlyReview } from '../review/nightly-review.js';
import { runWeeklyReview } from '../review/weekly-review.js';
import { generateMorningBriefing } from '../review/morning-briefing.js';
import { updateNodeTouches, resetNodeTouches } from '../gex/node-tracker.js';
import { updateTrendBuffer, detectTrendDay, getTrendState, resetTrendDetector } from '../store/trend-detector.js';

const log = createLogger('MainLoop');

// State tracking
let lastDirection = null;
let lastFullAnalysisTime = 0;
let lastFullAnalysisScore = 0;
let lastHealthHeartbeatTime = 0;
let openingSummarySentDate = null;
let eodRecapSentDate = null;
let cycleCount = 0;
let lastSpot = null;
let lastScore = null;
let loopTimer = null;
let reviewTimer = null;
let eodSummaryTimer = null;
let dailyCycleIndex = 0;
let eodSummarySentDate = null;
let nightlyReviewDate = null;
let running = false;

// Lane B phantom cooldown
let lastLaneBPhantomTime = 0;
const LANE_B_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between Lane B phantoms

/**
 * Start the main polling loop.
 */
export function startMainLoop() {
  if (running) {
    log.warn('Main loop already running');
    return;
  }

  running = true;
  log.info('GexClaw main loop starting...');

  updateLoopStatus({ running: true, startedAt: Date.now() });

  // Initialize strategy store (Phase 5) — must come before trade manager
  initStrategyStore();
  log.info(`Strategy ${getVersionLabel()} active`);

  // Initialize trade subsystems
  initTradeManager();
  initPhantomTracker();

  // Run cleanup on startup
  cleanupOldData(7);

  // Schedule nightly review (4:10 PM ET, right after market close)
  scheduleNightlyReview();

  // Schedule daily node tracker reset (9:25 AM ET, before warm-up)
  scheduleDailyReset();

  // Schedule EOD summary (4:05 PM ET)
  scheduleEodSummary();

  // Kick off the first cycle immediately
  scheduleCycle();
}

/**
 * Stop the main polling loop.
 */
export function stopMainLoop() {
  running = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (reviewTimer) {
    clearTimeout(reviewTimer);
    reviewTimer = null;
  }
  if (dailyResetTimer) {
    clearTimeout(dailyResetTimer);
    dailyResetTimer = null;
  }
  if (eodSummaryTimer) {
    clearTimeout(eodSummaryTimer);
    eodSummaryTimer = null;
  }
  updateLoopStatus({ running: false });
  log.info('Main loop stopped');
}

/**
 * Schedule the next cycle based on current phase.
 */
function scheduleCycle() {
  if (!running) return;

  const phase = getSchedulePhase();

  updateLoopStatus({ phase: phase.phase, description: phase.description, pollIntervalMs: phase.pollIntervalMs });

  if (phase.pollIntervalMs === 0) {
    // Not active — check again in 30 seconds to see if phase changed
    log.debug(`${phase.description} — sleeping 30s`);
    loopTimer = setTimeout(scheduleCycle, 30000);

    // Check for EOD recap during the recap window
    if (phase.phase === 'EOD_RECAP') {
      handleEodRecap();
    }
    return;
  }

  // Run a cycle, then schedule the next
  runCycle(phase).finally(() => {
    if (running) {
      loopTimer = setTimeout(scheduleCycle, phase.pollIntervalMs);
    }
  });
}

/**
 * Run a single polling cycle.
 */
async function runCycle(phase) {
  cycleCount++;

  try {
    // ---- FETCH + PARSE + SCORE (Multi-Ticker Trinity Mode) ----
    const trinity = await fetchTrinityData();
    const spxwData = trinity.spxw;

    if (!spxwData) {
      log.error('SPXW fetch failed in Trinity — skipping cycle');
      return;
    }

    const parsed = spxwData.parsed;
    const walls = spxwData.walls;
    const wallTrends = spxwData.wallTrends || [];

    // Get trinity state (built by fetchTrinityData)
    const trinityState = getTrinityState();

    // Run multi-ticker analysis (driver, alignment, stacked, rug, slides)
    const multiAnalysis = analyzeMultiTicker(trinityState?.spxw, trinityState?.spy, trinityState?.qqq);

    // Save stacked walls snapshot for persistence tracking
    saveStackSnapshot(multiAnalysis.stacked_walls || [], 'SPXW');

    // Re-score SPXW with multi-ticker bonus if applicable
    const baseScored = spxwData.scored;
    const scored = multiAnalysis.bonus > 0
      ? scoreSpxGex(parsed, wallTrends, multiAnalysis.bonus, 'SPXW')
      : baseScored;

    const driverInfo = multiAnalysis.driver ? ` | Driver: ${multiAnalysis.driver.ticker}` : '';
    const alignInfo = ` | Align: ${multiAnalysis.alignment.count}/3 ${multiAnalysis.alignment.direction}`;
    log.info(`Score: ${scored.score} ${scored.direction} | Spot: $${parsed.spotPrice.toFixed(2)} | Call Wall: ${scored.wallsAbove[0] ? `${scored.wallsAbove[0].strike} (${formatDollar(scored.wallsAbove[0].gexValue)})` : 'none'} | Put Wall: ${scored.wallsBelow[0] ? `${scored.wallsBelow[0].strike} (${formatDollar(scored.wallsBelow[0].gexValue)})` : 'none'}${driverInfo}${alignInfo}`);

    // Update node touch tracker (must be before decision engine)
    updateNodeTouches(parsed.spotPrice, walls);

    // Send reshuffle alerts if detected
    if (multiAnalysis.reshuffles?.some(r => r.detected)) {
      for (const r of multiAnalysis.reshuffles.filter(r => r.detected)) {
        try { await sendMapReshuffleAlert(r); } catch (_) {}
        try {
          const alertData = { type: 'MAP_RESHUFFLE', message: `${r.ticker}: ${r.new_count} new walls, ${r.disappeared_count} disappeared`, details: { ticker: r.ticker, newWalls: r.new_count, disappearedWalls: r.disappeared_count } };
          dashboardEmitter.emit('alert', alertData);
          saveAlert('MAP_RESHUFFLE', alertData);
        } catch (_) {}
      }
    }

    // Save SPXW to DB (history is saved per-ticker inside fetchTrinityData)
    saveSnapshot(scored);
    try { saveMultiAnalysis(multiAnalysis, trinityState); } catch (_) {}

    // Save king node for type flip detection
    const spxwKingNode = multiAnalysis.king_nodes?.SPXW;
    if (spxwKingNode) saveKingNode(spxwKingNode, 'SPXW');

    // Save raw GEX snapshots for replay engine
    dailyCycleIndex++;
    try {
      const tvSnapshotForCapture = getSignalSnapshot();
      saveRawSnapshot({
        ticker: 'SPXW', spotPrice: parsed.spotPrice, parsedData: parsed,
        walls, multiAnalysis, tvSnapshot: tvSnapshotForCapture,
        scoredDirection: scored.direction, scoredScore: scored.score,
        cycleIndex: dailyCycleIndex,
      });
      for (const [ticker, data] of [['SPY', trinity.spy], ['QQQ', trinity.qqq]]) {
        if (data) {
          saveRawSnapshot({
            ticker, spotPrice: data.parsed.spotPrice, parsedData: data.parsed,
            walls: data.walls, multiAnalysis: null, tvSnapshot: null,
            scoredDirection: data.scored.direction, scoredScore: data.scored.score,
            cycleIndex: dailyCycleIndex,
          });
        }
      }
    } catch (snapErr) {
      log.warn(`Raw snapshot save failed: ${snapErr.message}`);
    }

    // Track state
    lastSpot = parsed.spotPrice;
    lastScore = scored.score;
    updateLoopStatus({ cycleCount, lastSpot, lastScore, lastDirection: scored.direction });

    // Record score for chop detection + regime tracking
    recordScore('SPXW', scored.score, scored.direction, scored.spotPrice);
    updateRegime('SPXW', scored.direction);

    // Trend day detection
    const cfg = getActiveConfig() || {};
    updateTrendBuffer(scored, cfg);
    const trendState = detectTrendDay();
    if (trendState.isTrend) {
      log.info(`TREND: ${trendState.direction} (${trendState.strength}) | floor=${trendState.supportFloor?.strike || '?'} ceiling=${trendState.resistanceCeiling?.strike || '?'}`);
      try { dashboardEmitter.emit('trend_update', trendState); } catch (_) {}
    }

    // Dashboard: emit GEX update (include full analysis data for trade idea)
    try {
      dashboardEmitter.emit('gex_update', {
        spotPrice: parsed.spotPrice,
        score: scored.score,
        direction: scored.direction,
        confidence: scored.confidence,
        environment: scored.environment,
        wallsAbove: scored.wallsAbove?.slice(0, 4),
        wallsBelow: scored.wallsBelow?.slice(0, 4),
        breakdown: scored.breakdown,
        targetWall: scored.targetWall ? { strike: scored.targetWall.strike, gexValue: scored.targetWall.gexValue } : null,
        floorWall: scored.floorWall ? { strike: scored.floorWall.strike, gexValue: scored.floorWall.gexValue } : null,
        gexAtSpot: scored.gexAtSpot,
        recommendation: scored.recommendation,
        distanceToTarget: scored.distanceToTarget,
        envDetail: scored.envDetail,
      });
    } catch (_) {}

    // Dashboard: emit Trinity update with multi-ticker analysis
    try { dashboardEmitter.emit('trinity_update', { ...trinityState, analysis: multiAnalysis }); } catch (_) {}

    // ---- CHECK OLD PREDICTIONS ----
    await checkPredictions(parsed.spotPrice);

    // ---- OPENING SUMMARY (9:15 AM) ----
    const todayStr = formatET(nowET()).slice(0, 10);
    if (isOpeningSummaryTime() && openingSummarySentDate !== todayStr) {
      openingSummarySentDate = todayStr;
      await sendOpeningSummary(scored);
      log.info('Opening summary sent');
    }

    // Only send alerts if alerts are active for this phase
    if (!phase.alertsActive) {
      log.debug(`Alerts inactive during ${phase.phase} — data collected only`);

      // Still detect direction for when alerts activate
      lastDirection = scored.direction;
      return;
    }

    // ---- NOISE FILTERING ----
    const largestWallAbs = walls.length > 0 ? walls[0].absGexValue : 0;
    const noiseThreshold = largestWallAbs * 0.10;

    // ---- FULL ANALYSIS ALERT ----
    const now = Date.now();
    const cooldownPassed = (now - lastFullAnalysisTime) > FULL_ANALYSIS_COOLDOWN_MS;
    const scoreChanged = Math.abs(scored.score - lastFullAnalysisScore) >= 20;

    if (scored.score >= CONFIDENCE.MEDIUM && (cooldownPassed || scoreChanged)) {
      await sendSpxAnalysis(scored);
      lastFullAnalysisTime = now;
      lastFullAnalysisScore = scored.score;

      savePrediction(
        scored.direction, scored.score, parsed.spotPrice,
        scored.targetWall?.strike || null,
        scored.floorWall?.strike || null,
      );

      try {
        const targetStr = scored.targetWall ? ` | Target: ${scored.targetWall.strike}` : '';
        const floorStr = scored.floorWall ? ` | ${scored.direction === 'BEARISH' ? 'Ceiling' : 'Floor'}: ${scored.floorWall.strike}` : '';
        const recStr = scored.recommendation ? ` — ${scored.recommendation}` : '';
        const alertData = {
          type: 'FULL_ANALYSIS',
          message: `${scored.direction} ${scored.score}/100 — ${scored.confidence}${targetStr}${floorStr}${recStr}`,
          details: {
            score: scored.score, direction: scored.direction, confidence: scored.confidence,
            spotPrice: parsed.spotPrice, environment: scored.environment,
            targetWall: scored.targetWall ? { strike: scored.targetWall.strike, gexValue: scored.targetWall.gexValue } : null,
            floorWall: scored.floorWall ? { strike: scored.floorWall.strike, gexValue: scored.floorWall.gexValue } : null,
            recommendation: scored.recommendation,
            distanceToTarget: scored.distanceToTarget,
          },
        };
        dashboardEmitter.emit('alert', alertData);
        saveAlert('FULL_ANALYSIS', alertData);
      } catch (_) {}
      log.info('Full analysis auto-sent to Discord');
    }

    // ---- DIRECTION CHANGE ALERT ----
    if (lastDirection !== null && scored.direction !== lastDirection) {
      if (shouldSendAlert('DIRECTION_FLIP', 0, { from: lastDirection, to: scored.direction })) {
        const flipDetails =
          `SPX flipped **${lastDirection} \u2192 ${scored.direction}**\n` +
          `Score: **${scored.score}/100** | Spot: $${parsed.spotPrice.toFixed(2)}\n` +
          `Environment: ${scored.environment}\n` +
          `${scored.recommendation}`;

        await sendLiveAlert('DIRECTION_CHANGE', flipDetails);
        try { dashboardEmitter.emit('alert', { type: 'DIRECTION_CHANGE', message: `${lastDirection} → ${scored.direction} | Score: ${scored.score}/100`, details: { from: lastDirection, to: scored.direction, score: scored.score, spotPrice: parsed.spotPrice } }); } catch (_) {}
        log.info(`Direction flip: ${lastDirection} \u2192 ${scored.direction}`);

        // On directional flip, also send full analysis + log prediction
        if (scored.direction !== 'CHOP' && scored.score >= 30) {
          await sendSpxAnalysis(scored);
          savePrediction(
            scored.direction, scored.score, parsed.spotPrice,
            scored.targetWall?.strike || null,
            scored.floorWall?.strike || null,
          );
          lastFullAnalysisTime = now;
          lastFullAnalysisScore = scored.score;
        }
      }
    }
    lastDirection = scored.direction;

    // ---- SPOT PRICE MOVEMENT ALERT ----
    if (lastSpot > 0) {
      const spotMovePct = Math.abs(parsed.spotPrice - lastSpot) / lastSpot * 100;

      if (spotMovePct > 0.3) {
        const moveDir = parsed.spotPrice > lastSpot ? 'UP' : 'DOWN';
        const moveStrike = Math.round(parsed.spotPrice / 5) * 5;
        if (shouldSendAlert('BIG_MOVE', moveStrike)) {
          await sendLiveAlert('ENVIRONMENT_CHANGE',
            `SPX moved **${moveDir} ${spotMovePct.toFixed(2)}%** in last cycle\n` +
            `$${lastSpot.toFixed(2)} \u2192 $${parsed.spotPrice.toFixed(2)}\n` +
            `Environment: ${scored.environment}`
          );
          try { dashboardEmitter.emit('alert', { type: 'ENVIRONMENT_CHANGE', message: `SPX moved ${moveDir} ${spotMovePct.toFixed(2)}%`, details: { direction: moveDir, pct: spotMovePct, from: lastSpot, to: parsed.spotPrice } }); } catch (_) {}
        }
      }
    }

    // ---- WALL PROXIMITY ALERT ----
    if (scored.targetWall) {
      const strikeDist = Math.abs(parsed.spotPrice - scored.targetWall.strike);
      const strikeStep = parsed.strikes.length > 1 ? Math.abs(parsed.strikes[1] - parsed.strikes[0]) : 5;
      if (strikeDist <= strikeStep) {
        if (shouldSendAlert('PROXIMITY', scored.targetWall.strike)) {
          await sendLiveAlert('PRICE_NEAR_TARGET',
            `SPX at **$${parsed.spotPrice.toFixed(2)}** \u2014 within 1 strike of target wall at **${scored.targetWall.strike}** (${formatDollar(scored.targetWall.gexValue)})\n` +
            `Setup: ${scored.direction} | Score: ${scored.score}/100`
          );
          try { dashboardEmitter.emit('alert', { type: 'PRICE_NEAR_TARGET', message: `Near target wall $${scored.targetWall.strike}`, details: { spotPrice: parsed.spotPrice, targetStrike: scored.targetWall.strike, direction: scored.direction, score: scored.score } }); } catch (_) {}
        }
      }
    }

    // ---- WALL CHANGE ALERTS ----
    for (const alert of wallTrends) {
      if (alert.wall.absGexValue < noiseThreshold) continue;

      if (!shouldSendAlert(alert.type, alert.wall.strike)) continue;

      if (alert.type === 'WALL_GROWTH') {
        await sendLiveAlert('WALL_GROWTH',
          `Wall at **${alert.wall.strike}** grew **${(alert.growthPct * 100).toFixed(0)}%**\n` +
          `${formatDollar(alert.prevValue)} \u2192 ${formatDollar(alert.wall.absGexValue)}\n` +
          `Type: ${alert.wall.type} | ${alert.wall.relativeToSpot} spot`
        );
        try { dashboardEmitter.emit('alert', { type: 'WALL_GROWTH', message: `Wall $${alert.wall.strike} grew ${(alert.growthPct * 100).toFixed(0)}%`, details: { strike: alert.wall.strike, growthPct: alert.growthPct, wallType: alert.wall.type } }); } catch (_) {}
      } else if (alert.type === 'WALL_SHRINK') {
        await sendLiveAlert('WALL_SHRINK',
          `Wall at **${alert.wall.strike}** shrank **${(Math.abs(alert.growthPct) * 100).toFixed(0)}%**\n` +
          `${formatDollar(alert.prevValue)} \u2192 ${formatDollar(alert.wall.absGexValue)}\n` +
          `Potential breakout signal`
        );
        try { dashboardEmitter.emit('alert', { type: 'WALL_SHRINK', message: `Wall $${alert.wall.strike} shrank ${(Math.abs(alert.growthPct) * 100).toFixed(0)}%`, details: { strike: alert.wall.strike, growthPct: alert.growthPct } }); } catch (_) {}
      }
    }

    // ---- PHASE 2: PATTERN DETECTION + DECISION ENGINE ----
    let agentAction = null;
    let detectedPatterns = [];
    let agentEntryTrigger = null;

    // Always detect patterns (fast, algorithmic — <1ms)
    try {
      const nodeSignChanges = getNodeSignChanges('SPXW');
      const kingNodeFlip = getKingNodeFlip('SPXW');
      detectedPatterns = detectAllPatterns(scored, parsed, multiAnalysis, getNodeTouches(), trinityState?.spxw?.nodeTrends, getCurrentPosition()?.direction || null, nodeSignChanges, kingNodeFlip);
      if (detectedPatterns.length > 0) {
        log.info(`Patterns: ${detectedPatterns.map(p => `${p.pattern}(${p.direction})`).join(', ')}`);
        try { dashboardEmitter.emit('patterns_detected', detectedPatterns); } catch (_) {}
      }
    } catch (patternErr) {
      log.error('Pattern detection error:', patternErr.message);
    }

    // Agent call: ONLY when in a position (exit advisory) — entries are algorithmic
    const posStateForAgent = getPositionState();
    if (posStateForAgent !== 'FLAT') {
      try {
        const decisionResult = await runDecisionCycle(scored, parsed, wallTrends, multiAnalysis, trinityState);

        if (decisionResult && decisionResult.changed && !decisionResult.skipped) {
          const decision = decisionResult.decision;
          decision.spotPrice = parsed.spotPrice;
          await sendCombinedSignalAlert(decision);
          try {
            const alertData = { type: 'SIGNAL', message: `${decision.action.replace(/_/g, ' ')} — ${decision.confidence} confidence`, details: { action: decision.action, confidence: decision.confidence, reason: decision.reason, spotPrice: parsed.spotPrice, score: scored.score, direction: scored.direction } };
            dashboardEmitter.emit('alert', alertData);
            saveAlert('SIGNAL', alertData);
          } catch (_) {}
          agentAction = decision.action;
          agentEntryTrigger = decision.entry_trigger || null;
          log.info(`Decision: ${decision.action} (${decision.confidence}) — alert sent`);
        } else if (decisionResult) {
          agentAction = decisionResult.decision?.action || null;
        }
        try { dashboardEmitter.emit('decision_update', { action: agentAction, decision: decisionResult?.decision, marketMode: detectChopMode('SPXW') }); } catch (_) {}
      } catch (decisionErr) {
        log.error('Decision engine error:', decisionErr.message);
      }
    } else {
      // FLAT — emit dashboard update without agent call
      try { dashboardEmitter.emit('decision_update', { action: 'WAIT', marketMode: detectChopMode('SPXW') }); } catch (_) {}
    }

    // ---- PHASE 3: TRADE EXECUTION ----
    // Spot price sanity check: reject absurd jumps within a single cycle
    // (e.g., stale pre-market data returning $6881 when actual spot is $6725)
    let spotSane = true;
    if (lastSpot && Math.abs(parsed.spotPrice - lastSpot) > 50) {
      const gapPts = Math.abs(parsed.spotPrice - lastSpot).toFixed(1);
      log.warn(`STALE SPOT DETECTED: $${parsed.spotPrice} vs last $${lastSpot} (gap: ${gapPts} pts) — skipping trade execution`);
      spotSane = false;
      // Don't update lastSpot — keep the valid one until API returns sane data
    }

    // Update Heatseeker spot cache for price feed (only if sane)
    if (spotSane) updateLatestSpot(parsed.spotPrice);

    try {
      if (!spotSane) {
        log.warn('Skipping trade execution due to stale spot price');
      } else {
      const posState = getPositionState();

      // A. If position OPEN → manage cycle (exit triggers, P&L updates)
      if (posState !== 'FLAT') {
        const tvSnapshotForExit = getSignalSnapshot();
        const mgmt = managePosition(parsed.spotPrice, scored, agentAction, { tvSnapshot: tvSnapshotForExit, multiAnalysis, trendState: getTrendState() });

        if (mgmt.exitTriggered) {
          const result = exitPosition(mgmt.exitReason, parsed.spotPrice);
          if (result) {
            // Track exit for entry gates (loss streaks, re-entry cooldown)
            recordExitForGates(result.direction, result.spxChange <= 0, undefined, result.entryTrigger);

            await sendTradeClosed(result);
            try { dashboardEmitter.emit('trade_closed', result); } catch (_) {}
            try {
              const pnlStr = `${result.spxChange > 0 ? '+' : ''}${result.spxChange} pts`;
              const alertData = { type: 'TRADE_CLOSED', message: `${result.contract} — ${result.exitReason} ${pnlStr}`, details: { contract: result.contract, exitReason: result.exitReason, spxChange: result.spxChange, pnlPct: result.pnlPct, direction: result.direction, entrySpx: result.entrySpx, exitSpx: result.exitSpx } };
              dashboardEmitter.emit('alert', alertData);
              saveAlert('TRADE_CLOSED', alertData);
            } catch (_) {}

            // Phase 5: Phantom comparison + rollback check after trade close
            try {
              const tradeRow = getTradeById(result.id);
              if (tradeRow) {
                runPhantomComparison(tradeRow);
                const rollback = checkRollbackTriggers();
                if (rollback) {
                  log.warn(`Rollback triggered: ${rollback.trigger} v${rollback.fromVersion} → v${rollback.toVersion}`);
                  try { dashboardEmitter.emit('strategy_rollback', rollback); } catch (_) {}
                  try { await sendStrategyRollback(rollback); } catch (_) {}
                }
              }
            } catch (p5err) {
              log.error('Phase 5 post-trade hook error:', p5err.message);
            }
          }
        } else if (mgmt.shouldSendUpdate && mgmt.pnl) {
          const pos = getCurrentPosition();
          if (pos) {
            const posUpdate = {
              contract: pos.contract,
              direction: pos.direction,
              pnlPct: mgmt.pnl.pnlPct,
              currentSpx: parsed.spotPrice,
              entrySpx: pos.entrySpx,
            };
            await sendPositionUpdate(posUpdate);
            try { dashboardEmitter.emit('position_update', posUpdate); } catch (_) {}
          }
        }
      }

      // B. If FLAT → algorithmic Lane A entry (GEX-only, no agent call needed)
      if (getPositionState() === 'FLAT' && detectedPatterns.length > 0) {
        const nodeTouches = getNodeTouches();
        const currentTrendState = getTrendState();
        const entryState = { patterns: detectedPatterns, scored, multiAnalysis, nodeTouches, trendState: currentTrendState };
        const laneAResult = checkGexOnlyEntry(entryState);

        if (laneAResult?.shouldEnter) {
          const guardrail = checkEntryGates(laneAResult.action, scored, multiAnalysis, { lane: 'A', pattern: laneAResult.trigger.pattern, trendState: currentTrendState });
          if (guardrail.allowed) {
            const entryContext = buildEntryContext(laneAResult.trigger, scored, multiAnalysis);
            await handleTradeEntry(laneAResult.action, parsed, scored, wallTrends, {
              strategyLane: 'A',
              entryTrigger: laneAResult.trigger.pattern,
              entryContext,
              entryConfidence: laneAResult.confidence,
            });
            recordEntryForGates(undefined, laneAResult.trigger.pattern);
          } else {
            log.warn(`Lane A entry BLOCKED: ${laneAResult.action} — ${guardrail.reason}`);
            // Create phantom trade for gate-blocked entries so we can track what would have happened
            try {
              const direction = laneAResult.trigger.direction;
              const spotPrice = parsed.spotPrice;
              const atm = Math.round(spotPrice / 5) * 5;
              const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
              const optType = direction === 'BULLISH' ? 'C' : 'P';
              const contract = `SPX${expDate}${optType}${atm}`;
              const entryContext = buildEntryContext(laneAResult.trigger, scored, multiAnalysis);
              recordPhantom({
                contract,
                direction,
                strike: atm,
                entryPrice: 0,
                entrySpx: spotPrice,
                targetPrice: 0,
                stopPrice: 0,
                targetSpx: laneAResult.trigger.target_strike,
                stopSpx: laneAResult.trigger.stop_strike,
                greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
                gexState: { score: scored.score, direction: scored.direction },
                tvState: getSignalSnapshot(),
                agentReasoning: `Lane A blocked: ${laneAResult.trigger.pattern} — gate: ${guardrail.reason}`,
                strategyLane: 'A',
                entryTrigger: laneAResult.trigger.pattern,
                entryContext,
              });
              log.info(`Lane A phantom (blocked): ${contract} ${direction} via ${laneAResult.trigger.pattern} — ${guardrail.reason}`);
            } catch (_) {}
            try {
              saveAlert('ENTRY_BLOCKED', { type: 'ENTRY_BLOCKED', message: `Lane A ${laneAResult.action} blocked — ${guardrail.reason}`, details: { action: laneAResult.action, reason: guardrail.reason, score: scored.score, direction: scored.direction, spotPrice: parsed.spotPrice, trigger: laneAResult.trigger.pattern } });
            } catch (_) {}
            try {
              dashboardEmitter.emit('entry_blocked', { action: laneAResult.action, reason: guardrail.reason, spotPrice: parsed.spotPrice });
            } catch (_) {}
          }
        }
      }

      // B2. Trend pullback entry (only when Lane A didn't fire and we're FLAT)
      if (getPositionState() === 'FLAT') {
        const currentTrend = getTrendState();
        if (currentTrend.isTrend) {
          const pullbackResult = checkTrendPullbackEntry({ scored, multiAnalysis, nodeTouches: getNodeTouches() }, currentTrend);
          if (pullbackResult?.shouldEnter) {
            const guardrail = checkEntryGates(pullbackResult.action, scored, multiAnalysis,
              { lane: 'A', pattern: 'TREND_PULLBACK', trendState: currentTrend });
            if (guardrail.allowed) {
              const entryContext = buildEntryContext(pullbackResult.trigger, scored, multiAnalysis);
              await handleTradeEntry(pullbackResult.action, parsed, scored, wallTrends, {
                strategyLane: 'A',
                entryTrigger: 'TREND_PULLBACK',
                entryContext,
                entryConfidence: pullbackResult.confidence,
              });
              recordEntryForGates(undefined, 'TREND_PULLBACK');
            } else {
              log.warn(`Trend pullback entry BLOCKED: ${pullbackResult.action} — ${guardrail.reason}`);
              // Phantom for blocked trend pullback
              try {
                const direction = pullbackResult.trigger.direction;
                const spotPrice = parsed.spotPrice;
                const atm = Math.round(spotPrice / 5) * 5;
                const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const optType = direction === 'BULLISH' ? 'C' : 'P';
                const contract = `SPX${expDate}${optType}${atm}`;
                const entryContext = buildEntryContext(pullbackResult.trigger, scored, multiAnalysis);
                recordPhantom({
                  contract, direction, strike: atm, entryPrice: 0, entrySpx: spotPrice,
                  targetPrice: 0, stopPrice: 0,
                  targetSpx: pullbackResult.trigger.target_strike,
                  stopSpx: pullbackResult.trigger.stop_strike,
                  greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
                  gexState: { score: scored.score, direction: scored.direction },
                  tvState: getSignalSnapshot(),
                  agentReasoning: `Trend pullback blocked: ${guardrail.reason}`,
                  strategyLane: 'A', entryTrigger: 'TREND_PULLBACK', entryContext,
                });
              } catch (_) {}
            }
          }
        }
      }

      // C. If NOT FLAT + Lane A pattern fires → phantom trade (Lane A skipped signal)
      if (getPositionState() !== 'FLAT' && detectedPatterns.length > 0 && shouldBePhantom()) {
        const nodeTouches = getNodeTouches();
        const entryState = { patterns: detectedPatterns, scored, multiAnalysis, nodeTouches, trendState: getTrendState() };
        const laneAResult = checkGexOnlyEntry(entryState);

        if (laneAResult?.shouldEnter) {
          const direction = laneAResult.trigger.direction;
          const spotPrice = parsed.spotPrice;
          const atm = Math.round(spotPrice / 5) * 5;
          const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const optType = direction === 'BULLISH' ? 'C' : 'P';
          const contract = `SPX${expDate}${optType}${atm}`;
          const entryContext = buildEntryContext(laneAResult.trigger, scored, multiAnalysis);

          recordPhantom({
            contract,
            direction,
            strike: atm,
            entryPrice: 0,
            entrySpx: spotPrice,
            targetPrice: 0,
            stopPrice: 0,
            targetSpx: laneAResult.trigger.target_strike,
            stopSpx: laneAResult.trigger.stop_strike,
            greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
            gexState: { score: scored.score, direction: scored.direction },
            tvState: getSignalSnapshot(),
            agentReasoning: `Lane A phantom: ${laneAResult.trigger.pattern} — ${laneAResult.trigger.reasoning}`,
            strategyLane: 'A',
            entryTrigger: laneAResult.trigger.pattern,
            entryContext,
          });
        }
      }

      // D. Lane B: GEX+TV phantom trades (independent of Lane A)
      const laneBReady = (Date.now() - lastLaneBPhantomTime) >= LANE_B_COOLDOWN_MS;
      if (detectedPatterns.length > 0 && laneBReady) {
        try {
          const nodeTouches = getNodeTouches();
          const entryState = { patterns: detectedPatterns, scored, multiAnalysis, nodeTouches, trendState: getTrendState() };
          const laneBResult = checkLaneBEntry(entryState);

          if (laneBResult?.shouldEnter) {
            const guardrail = checkEntryGates(laneBResult.action, scored, multiAnalysis, { pattern: laneBResult.trigger.pattern });
            if (guardrail.allowed) {
              const direction = laneBResult.trigger.direction;
              const spotPrice = parsed.spotPrice;
              const atm = Math.round(spotPrice / 5) * 5;
              const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
              const optType = direction === 'BULLISH' ? 'C' : 'P';
              const contract = `SPX${expDate}${optType}${atm}`;
              const entryContext = buildEntryContext(laneBResult.trigger, scored, multiAnalysis);

              recordPhantom({
                contract,
                direction,
                strike: atm,
                entryPrice: 0,
                entrySpx: spotPrice,
                targetPrice: 0,
                stopPrice: 0,
                targetSpx: laneBResult.trigger.target_strike,
                stopSpx: laneBResult.trigger.stop_strike,
                greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
                gexState: { score: scored.score, direction: scored.direction },
                tvState: getSignalSnapshot(),
                agentReasoning: `Lane B: ${laneBResult.trigger.pattern} + TV confirm (${laneBResult.tvConfirmCount} indicators)`,
                strategyLane: 'B',
                entryTrigger: laneBResult.trigger.pattern,
                entryContext,
              });

              lastLaneBPhantomTime = Date.now();
              log.info(`Lane B phantom: ${contract} ${direction} via ${laneBResult.trigger.pattern} + TV (${laneBResult.tvConfirmCount} confirms)`);
            }
          }
        } catch (laneBErr) {
          log.error('Lane B phantom error:', laneBErr.message);
        }
      }

      // E. Update phantom trades (pass full context for 13 exit triggers)
      const tvSnapshotForPhantoms = getSignalSnapshot();
      const closedPhantoms = updatePhantoms(parsed.spotPrice, scored, { tvSnapshot: tvSnapshotForPhantoms, multiAnalysis });
      if (closedPhantoms.length > 0) {
        log.info(`${closedPhantoms.length} phantom(s) closed this cycle`);
      }
      } // end spotSane gate
    } catch (tradeErr) {
      log.error('Trade execution error:', tradeErr.message);
    }

    // ---- HEALTH HEARTBEAT ----
    if ((now - lastHealthHeartbeatTime) > HEALTH_HEARTBEAT_INTERVAL_MS) {
      lastHealthHeartbeatTime = now;
      saveHealth('main-loop', 'OK', `Cycle ${cycleCount} | ${phase.phase}`);
      await sendHealthHeartbeat({
        phase: phase.phase,
        cycleCount,
        lastScore: scored.score,
        lastDirection: scored.direction,
        lastSpot: parsed.spotPrice,
      });
    }

  } catch (err) {
    log.error(`Cycle ${cycleCount} failed:`, err.message);
    saveHealth('main-loop', 'ERROR', err.message);

    if (err.message.includes('AUTH_EXPIRED')) {
      log.error('JWT token expired! Update HEATSEEKER_JWT in .env and restart.');
    }
  }
}

/**
 * Check old predictions (30+ min) against current price.
 */
async function checkPredictions(currentPrice) {
  try {
    const unchecked = getUncheckedPredictions();
    for (const pred of unchecked) {
      const priceDiff = currentPrice - pred.spot_price;
      const pctMove = (priceDiff / pred.spot_price) * 100;

      let win = false;
      if (pred.direction === 'BULLISH' && priceDiff > 0) win = true;
      if (pred.direction === 'BEARISH' && priceDiff < 0) win = true;

      markPredictionChecked(pred.id, currentPrice, pctMove, win);
    }
  } catch (err) {
    log.error('Failed to check predictions:', err.message);
  }
}

/**
 * Handle EOD recap at 4:01 PM.
 */
async function handleEodRecap() {
  const todayStr = formatET(nowET()).slice(0, 10);
  if (eodRecapSentDate === todayStr) return;

  eodRecapSentDate = todayStr;

  try {
    const predictions = getCheckedPredictionsToday();
    await sendEodRecap(predictions);
    log.info('EOD recap sent');
  } catch (err) {
    log.error('Failed to send EOD recap:', err.message);
  }
}

/**
 * Schedule EOD summary at 4:05 PM ET (weekdays only).
 * Sends comprehensive 4-embed summary to Discord.
 */
function scheduleEodSummary() {
  const et = nowET();
  let target = et.set({ hour: 16, minute: 5, second: 0, millisecond: 0 });

  // If already past 4:05 PM today, schedule for tomorrow
  if (et.hour > 16 || (et.hour === 16 && et.minute >= 5)) {
    target = target.plus({ days: 1 });
  }

  // Skip weekends (Sat=6, Sun=7 in Luxon ISO weekday)
  while (target.weekday === 6 || target.weekday === 7) {
    target = target.plus({ days: 1 });
  }

  const msUntilSummary = target.toMillis() - et.toMillis();
  const hoursUntil = (msUntilSummary / 3_600_000).toFixed(1);

  log.info(`EOD summary scheduled in ${hoursUntil}h (4:05 PM ET)`);

  eodSummaryTimer = setTimeout(async () => {
    if (!running) return;

    const todayStr = formatET(nowET()).slice(0, 10);
    if (eodSummarySentDate === todayStr) {
      log.info('EOD summary already sent today — skipping');
      scheduleEodSummary();
      return;
    }

    eodSummarySentDate = todayStr;

    try {
      const trades = getTradesByDate(todayStr);
      const phantoms = getPhantomTradesByDate(todayStr);
      const decisions = getDecisionsByDate(todayStr);
      const tvSignalLog = getTvSignalLogByDate(todayStr);
      const gexSnapshots = getGexSnapshotsByDate(todayStr);
      const alerts = getAlertsByDate(todayStr);
      const predictions = getTodaysPredictions();
      const strategyLabel = getVersionLabel();

      await sendEodSummary({
        trades,
        phantoms,
        decisions,
        tvSignalLog,
        gexSnapshots,
        alerts,
        predictions,
        strategy: strategyLabel,
        cycleCount,
      });

      log.info('EOD summary sent successfully');
    } catch (err) {
      log.error('Failed to send EOD summary:', err.message);
    }

    // Reschedule for next trading day
    scheduleEodSummary();
  }, msUntilSummary);
}

// validateEntryGuardrails() removed — replaced by checkEntryGates() in entry-gates.js

/**
 * Handle a new trade entry (ENTER_CALLS or ENTER_PUTS).
 * Uses GEX walls for strike/target/stop — no delayed Polygon chain needed.
 */
async function handleTradeEntry(agentAction, parsed, scored, wallTrends, laneOpts = {}) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';

  try {
    const spotPrice = parsed.spotPrice;
    const atm = Math.round(spotPrice / 5) * 5;

    // Strike: ATM for calls, ATM for puts
    const strike = atm;

    // Target & stop from GEX walls — must be on correct side of spot
    let targetSpx = direction === 'BULLISH'
      ? (scored.wallsAbove?.[0]?.strike || spotPrice + 20)
      : (scored.wallsBelow?.[0]?.strike || spotPrice - 20);
    let stopSpx = direction === 'BULLISH'
      ? (scored.wallsBelow?.[0]?.strike || spotPrice - 10)
      : (scored.wallsAbove?.[0]?.strike || spotPrice + 10);

    // Widen stop for trend days + breakouts
    const entryCfg = getActiveConfig() || {};
    const currentTrendState = getTrendState();
    const entryTrendAligned = currentTrendState?.isTrend && currentTrendState.direction === direction
      && (currentTrendState.strength === 'CONFIRMED' || currentTrendState.strength === 'STRONG');
    if (entryTrendAligned) {
      const stopDist = Math.abs(stopSpx - spotPrice);
      const trendMult = entryCfg.trend_stop_multiplier ?? 1.5;
      const newStopDist = stopDist * trendMult;
      stopSpx = direction === 'BULLISH' ? spotPrice - newStopDist : spotPrice + newStopDist;
      log.info(`Trend stop widened: ${stopDist.toFixed(1)} → ${newStopDist.toFixed(1)} pts (${trendMult}x)`);
    }
    if (scored.score >= (entryCfg.breakout_score_threshold ?? 90)) {
      const stopDist = Math.abs(stopSpx - spotPrice);
      const breakoutMult = entryCfg.breakout_stop_multiplier ?? 1.3;
      const newStopDist = stopDist * breakoutMult;
      stopSpx = direction === 'BULLISH' ? spotPrice - newStopDist : spotPrice + newStopDist;
      log.info(`Breakout stop widened: ${stopDist.toFixed(1)} → ${newStopDist.toFixed(1)} pts (${breakoutMult}x, score=${scored.score})`);
    }

    // Synthetic contract name (0DTE SPX format)
    const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const optType = direction === 'BULLISH' ? 'C' : 'P';
    const contract = `SPX${expDate}${optType}${strike}`;

    const tvSnapshot = getSignalSnapshot();
    const triggerStr = laneOpts.entryTrigger ? ` | trigger=${laneOpts.entryTrigger}` : '';
    log.info(`Trade entry: ${contract} | lane=${laneOpts.strategyLane || '-'} | spot=$${spotPrice} ATM=$${atm} | target=$${targetSpx} stop=$${stopSpx}${triggerStr}`);

    // Enter position (entryPrice=0 since we don't have live quotes)
    const pos = enterPosition({
      contract,
      direction,
      strike,
      entryPrice: 0,
      entrySpx: spotPrice,
      targetPrice: 0,
      stopPrice: 0,
      targetSpx,
      stopSpx,
      greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
      gexState: {
        score: scored.score,
        direction: scored.direction,
        environment: scored.environment,
      },
      tvState: tvSnapshot,
      agentReasoning: scored.recommendation || null,
      strategyLane: laneOpts.strategyLane || null,
      entryTrigger: laneOpts.entryTrigger || null,
      entryContext: laneOpts.entryContext || null,
      entryConfidence: laneOpts.entryConfidence || null,
    });

    if (pos) {
      const tradeData = {
        ...pos,
        targetPnlPct: 0,
        stopPnlPct: 0,
        rewardRiskRatio: 0,
        greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
        agentReasoning: scored.recommendation || null,
      };
      await sendTradeCard(tradeData);
      try { dashboardEmitter.emit('trade_opened', tradeData); } catch (_) {}
      try {
        const alertData = { type: 'TRADE_OPENED', message: `${tradeData.contract} — ${tradeData.direction}`, details: { contract: tradeData.contract, direction: tradeData.direction, strike: tradeData.strike, entryPrice: tradeData.entryPrice, spotPrice: tradeData.spotPrice } };
        dashboardEmitter.emit('alert', alertData);
        saveAlert('TRADE_OPENED', alertData);
      } catch (_) {}
    }
  } catch (err) {
    log.error(`Trade entry failed: ${err.message}`);
  }
}

// ---- Daily Reset Scheduling (Node Tracker + Entry Gates) ----

let dailyResetTimer = null;

/**
 * Expire cross-day 0DTE positions (trades + phantoms) at daily reset.
 * 0DTE options expire at close — any surviving from previous day are invalid.
 */
function expireCrossDayPositions() {
  const expiredTrades = expireCrossDayTrade();
  const expiredPhantoms = expireCrossDayPhantoms();
  if (expiredTrades > 0 || expiredPhantoms > 0) {
    log.info(`Cross-day cleanup: ${expiredTrades} trade(s), ${expiredPhantoms} phantom(s) expired`);
  }
}

/**
 * Schedule daily reset of node touch tracker at 9:25 AM ET (before warm-up).
 */
function scheduleDailyReset() {
  const et = nowET();
  let target = et.set({ hour: 9, minute: 25, second: 0, millisecond: 0 });

  // If already past 9:25 AM today, schedule for tomorrow
  if (et.hour > 9 || (et.hour === 9 && et.minute >= 25)) {
    target = target.plus({ days: 1 });
  }

  const msUntilReset = target.toMillis() - et.toMillis();
  const hoursUntil = (msUntilReset / 3_600_000).toFixed(1);

  log.info(`Daily node reset scheduled in ${hoursUntil}h (9:25 AM ET)`);

  dailyResetTimer = setTimeout(() => {
    if (!running) return;

    resetNodeTouches();
    resetDailyState();
    resetDailyGates();
    resetTrendDetector();
    dailyCycleIndex = 0;
    lastSpot = null; // Clear stale spot from previous session

    // Expire cross-day 0DTE phantoms and trades (options expired at previous close)
    expireCrossDayPositions();

    log.info('Daily reset: node tracker, smoothing, entry gates, trend detector, cycle index, stale spot cleared');

    // Reschedule for next day
    scheduleDailyReset();
  }, msUntilReset);
}

// ---- Phase 5: Nightly/Weekly Review Scheduling ----

/**
 * Schedule the next nightly review at 4:10 PM ET.
 * On Sundays, runs weekly review instead.
 */
function scheduleNightlyReview() {
  const et = nowET();
  let target = et.set({ hour: 16, minute: 10, second: 0, millisecond: 0 });

  // If already past 4:10 PM today, schedule for tomorrow
  if (et.hour > 16 || (et.hour === 16 && et.minute >= 10)) {
    target = target.plus({ days: 1 });
  }

  // Skip weekends (Sat=6, Sun=7 in Luxon ISO weekday)
  while (target.weekday === 6 || target.weekday === 7) {
    target = target.plus({ days: 1 });
  }

  const msUntilReview = target.toMillis() - et.toMillis();
  const hoursUntil = (msUntilReview / 3_600_000).toFixed(1);

  log.info(`Nightly review scheduled in ${hoursUntil}h (${formatET(target).split(' ')[0]} 16:10 ET)`);

  reviewTimer = setTimeout(async () => {
    if (!running) return;

    const todayStr = formatET(nowET()).slice(0, 10);
    if (nightlyReviewDate === todayStr) {
      log.info('Nightly review already ran today — skipping');
      scheduleNightlyReview();
      return;
    }

    nightlyReviewDate = todayStr;

    try {
      // Sunday = day 7 in Luxon (ISO weekday)
      const isSunday = nowET().weekday === 7;
      let reviewResult;

      if (isSunday) {
        log.info('Sunday — running weekly review');
        reviewResult = await runWeeklyReview();
      } else {
        reviewResult = await runNightlyReview();
      }

      // Generate morning briefing
      const briefing = generateMorningBriefing(reviewResult);
      log.info(`Morning briefing generated: ${briefing.changes.length} change(s)`);

      // Send Discord review report + emit dashboard events
      try {
        if (!reviewResult.skipped) {
          await sendReviewReport(reviewResult);
        }
        if (reviewResult.newVersion) {
          dashboardEmitter.emit('strategy_update', {
            version: reviewResult.newVersion,
            changes: reviewResult.changes,
            analysis: reviewResult.analysis?.analysis_summary,
          });
        }
      } catch (discordErr) {
        log.error('Review report failed, falling back:', discordErr.message);
        try {
          if (reviewResult.newVersion) await sendStrategyChange(reviewResult);
          else if (!reviewResult.skipped) await sendNoChange(reviewResult);
        } catch (_) {}
      }

    } catch (err) {
      log.error('Nightly review failed:', err.message);
    }

    // Reschedule for next night
    scheduleNightlyReview();
  }, msUntilReview);
}

// Re-export getLoopStatus from loop-status.js for backwards compatibility
export { getLoopStatus } from './loop-status.js';
