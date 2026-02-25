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
import { saveSnapshot, savePrediction, saveHealth, saveMultiAnalysis, saveAlert, getCheckedPredictionsToday, getUncheckedPredictions, markPredictionChecked, cleanupOldData, getTradeById, getTradesByDate, getPhantomTradesByDate, getDecisionsByDate, getTvSignalLogByDate, getGexSnapshotsByDate, getAlertsByDate, getTodaysPredictions } from '../store/db.js';
import { getGexHistory, getSpotMomentum, isDirectionStable, hadRecentDirectionFlip, resetDailyState, updateLatestSpot, recordScore, detectChopMode } from '../store/state.js';
import { shouldSendAlert } from '../alerts/throttle.js';
import { sendSpxAnalysis, sendLiveAlert, sendOpeningSummary, sendEodRecap, sendEodSummary, sendHealthHeartbeat, sendCombinedSignalAlert, sendTradeCard, sendPositionUpdate, sendTradeClosed, sendStrategyChange, sendStrategyRollback, sendNoChange, sendMapReshuffleAlert, sendReviewReport } from '../alerts/discord.js';
import { runDecisionCycle } from '../agent/decision-engine.js';
import { initTradeManager, getPositionState, getCurrentPosition, enterPosition, manageCycle as managePosition, exitPosition, shouldBePhantom } from '../trades/trade-manager.js';
import { initPhantomTracker, recordPhantom, updatePhantoms } from '../trades/phantom-tracker.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
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
let eodSummarySentDate = null;
let nightlyReviewDate = null;
let running = false;

// Re-entry cooldown tracking
let lastExitTime = 0;
let lastExitDirection = null;
const REENTRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes after exit before re-entering same direction

// Entry quality gate tracking
let lastEntryTime = 0;
let todayTradeCount = 0;
const ENTRY_GATES = {
  MAX_TRADES_PER_DAY: 8,
  MIN_TIME_BETWEEN_ENTRIES_MS: 5 * 60 * 1000,   // 5 min between ANY entries
  MIN_STABLE_DIRECTION_CYCLES: 3,                 // Direction must agree 3 consecutive cycles
  NO_ENTRY_AFTER_FLIP_CYCLES: 4,                  // Wait 4 cycles after direction flip
  NO_ENTRY_AFTER_ET: '15:00',                     // No new entries after 3:00 PM ET for 0DTE
  OPENING_CAUTION_UNTIL_ET: '09:40',              // Higher thresholds during first 10 min
  OPENING_MIN_SCORE: 85,                           // Score ≥85 required during open
  OPENING_MIN_ALIGNMENT: 3,                        // 3/3 alignment required during open
};

/**
 * Start the main polling loop.
 */
export function startMainLoop() {
  if (running) {
    log.warn('Main loop already running');
    return;
  }

  running = true;
  log.info('OpenClaw main loop starting...');

  updateLoopStatus({ running: true, startedAt: Date.now() });

  // Initialize strategy store (Phase 5) — must come before trade manager
  initStrategyStore();
  log.info(`Strategy ${getVersionLabel()} active`);

  // Initialize trade subsystems
  initTradeManager();
  initPhantomTracker();

  // Run cleanup on startup
  cleanupOldData(7);

  // Schedule nightly review (2 AM ET, independent of main loop)
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

    // Track state
    lastSpot = parsed.spotPrice;
    lastScore = scored.score;
    updateLoopStatus({ cycleCount, lastSpot, lastScore, lastDirection: scored.direction });

    // Record score for chop detection
    recordScore('SPXW', scored.score, scored.direction);

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

    // ---- PHASE 2: DECISION ENGINE (GEX + TV → Agent) ----
    let agentAction = null;
    try {
      const decisionResult = await runDecisionCycle(scored, parsed, wallTrends, multiAnalysis, trinityState);

      if (decisionResult && decisionResult.changed && !decisionResult.skipped) {
        // Action or confidence changed — send combined signal alert
        const decision = decisionResult.decision;
        decision.spotPrice = parsed.spotPrice; // inject for Discord formatting
        await sendCombinedSignalAlert(decision);
        try {
          const alertData = { type: 'SIGNAL', message: `${decision.action.replace(/_/g, ' ')} — ${decision.confidence} confidence`, details: { action: decision.action, confidence: decision.confidence, reason: decision.reason, spotPrice: parsed.spotPrice, score: scored.score, direction: scored.direction } };
          dashboardEmitter.emit('alert', alertData);
          saveAlert('SIGNAL', alertData);
        } catch (_) {}
        agentAction = decision.action;

        // Save prediction for ENTER signals so trade ideas appear in dashboard Ideas tab
        if (decision.action?.startsWith('ENTER')) {
          savePrediction(
            scored.direction, scored.score, parsed.spotPrice,
            scored.targetWall?.strike || decision.target_wall?.strike || null,
            scored.floorWall?.strike || decision.stop_level?.strike || null,
          );
        }

        log.info(`Decision: ${decision.action} (${decision.confidence}) — alert sent`);
      } else if (decisionResult && decisionResult.skipped) {
        agentAction = decisionResult.decision?.action || null;
        log.debug('Decision: agent skipped (no change)');
      } else if (decisionResult) {
        agentAction = decisionResult.decision?.action || null;
        log.debug(`Decision: ${decisionResult.decision?.action} (no change)`);
      }
      // Dashboard: emit decision update (include market mode for CHOP badge)
      try { dashboardEmitter.emit('decision_update', { action: agentAction, decision: decisionResult?.decision, marketMode: detectChopMode('SPXW') }); } catch (_) {}
    } catch (decisionErr) {
      log.error('Decision engine error:', decisionErr.message);
    }

    // ---- PHASE 3: TRADE EXECUTION ----
    // Update Heatseeker spot cache for price feed
    updateLatestSpot(parsed.spotPrice);

    try {
      const posState = getPositionState();

      // A. If position OPEN → manage cycle (exit triggers, P&L updates)
      if (posState !== 'FLAT') {
        const tvSnapshotForExit = getSignalSnapshot();
        const mgmt = managePosition(parsed.spotPrice, scored, agentAction, { tvSnapshot: tvSnapshotForExit, multiAnalysis });

        if (mgmt.exitTriggered) {
          const result = exitPosition(mgmt.exitReason, parsed.spotPrice);
          if (result) {
            // Track exit for re-entry cooldown
            lastExitTime = Date.now();
            lastExitDirection = result.direction;

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

      // B. If FLAT + agent ENTER → open trade (with guardrails)
      if (getPositionState() === 'FLAT' && agentAction) {
        const isEnter = agentAction === 'ENTER_CALLS' || agentAction === 'ENTER_PUTS';
        if (isEnter) {
          const guardrail = validateEntryGuardrails(agentAction, scored, multiAnalysis);
          if (guardrail.allowed) {
            await handleTradeEntry(agentAction, parsed, scored, wallTrends);
          } else {
            log.warn(`Entry BLOCKED: ${agentAction} — ${guardrail.reason}`);
            // Save blocked entry to DB for end-of-day review
            try {
              saveAlert('ENTRY_BLOCKED', { type: 'ENTRY_BLOCKED', message: `${agentAction} blocked — ${guardrail.reason}`, details: { action: agentAction, reason: guardrail.reason, score: scored.score, direction: scored.direction, spotPrice: parsed.spotPrice } });
            } catch (_) {}
            // Tell dashboard the entry was blocked so TradeCard shows the reason
            try {
              dashboardEmitter.emit('entry_blocked', { action: agentAction, reason: guardrail.reason, spotPrice: parsed.spotPrice });
            } catch (_) {}
          }
        }
      }

      // C. If NOT FLAT + agent ENTER again → phantom trade
      if (getPositionState() !== 'FLAT' && agentAction) {
        const isEnter = agentAction === 'ENTER_CALLS' || agentAction === 'ENTER_PUTS';
        if (isEnter && shouldBePhantom()) {
          await handlePhantomEntry(agentAction, parsed, scored, wallTrends);
        }
      }

      // D. Update phantom trades
      const closedPhantoms = updatePhantoms(parsed.spotPrice);
      if (closedPhantoms.length > 0) {
        log.info(`${closedPhantoms.length} phantom(s) closed this cycle`);
      }
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

/**
 * Validate entry against hard guardrails.
 * These rules override the agent — even if the agent says ENTER, we block if:
 * 1. TV regime conflicts (Pink Diamond fired → no calls until Blue Diamond)
 * 2. Insufficient alignment (< 2/3 tickers) with no TV confirmation
 * 3. Re-entry cooldown hasn't elapsed after recent exit in same direction
 */
function validateEntryGuardrails(agentAction, scored, multiAnalysis) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';
  const tvSnapshot = getSignalSnapshot();
  const tvRegime = getTvRegime();
  const alignment = multiAnalysis?.alignment?.count || 0;

  // Count TV confirmations for the entry direction (now includes Echo + Bravo + Tango × 2 timeframes)
  const spxConf = tvSnapshot.spx?.confirmations || {};
  const tvBullish = spxConf.bullish || 0;
  const tvBearish = spxConf.bearish || 0;
  const tvConfirms = direction === 'BULLISH' ? tvBullish : tvBearish;
  const tvWeighted = tvSnapshot.spx?.weighted_score || {};
  const tvWeightedScore = direction === 'BULLISH' ? (tvWeighted.bullish || 0) : (tvWeighted.bearish || 0);

  // Rule 1: TV Regime gate
  // Once Pink Diamond fires → BEARISH regime → no calls until Blue Diamond fires
  // Once Blue Diamond fires → BULLISH regime → no puts until Pink Diamond fires
  if (tvRegime.direction) {
    if (direction === 'BULLISH' && tvRegime.direction === 'BEARISH') {
      return { allowed: false, reason: `TV regime is BEARISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${Math.round((Date.now() - tvRegime.setAt) / 60000)}m ago) — need Blue Diamond before entering calls` };
    }
    if (direction === 'BEARISH' && tvRegime.direction === 'BULLISH') {
      return { allowed: false, reason: `TV regime is BULLISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${Math.round((Date.now() - tvRegime.setAt) / 60000)}m ago) — need Pink Diamond before entering puts` };
    }
  }

  // Rule 2: Alignment + TV gate
  // With 0 TV confirmation, need alignment >= config threshold (default 2/3)
  // EXCEPTION: Strong SPX momentum + high GEX score overrides alignment requirement
  const alignmentMin = (getActiveConfig() || {}).alignment_min_for_entry || 2;
  if (tvConfirms === 0 && alignment < alignmentMin) {
    const momentum = getSpotMomentum('SPXW');
    const momentumAligned = (direction === 'BULLISH' && momentum.direction === 'UP') ||
                            (direction === 'BEARISH' && momentum.direction === 'DOWN');

    if (momentum.strength === 'STRONG' && momentumAligned && scored.score >= 80) {
      log.info(`Momentum override: ${momentum.strength} ${momentum.direction} ($${momentum.absPoints}) with score ${scored.score} — allowing entry despite ${alignment}/3 alignment, 0 TV`);
    } else {
      return { allowed: false, reason: `Only ${alignment}/3 aligned, 0 TV confirms (weighted: ${tvWeightedScore.toFixed(1)}) — need ${alignmentMin}/3 alignment or TV confirmation (momentum: ${momentum.strength} ${momentum.direction})` };
    }
  }

  // Rule 3: Re-entry cooldown
  // After exiting a position, wait before re-entering the same direction
  if (lastExitTime > 0 && lastExitDirection === direction) {
    const elapsed = Date.now() - lastExitTime;
    if (elapsed < REENTRY_COOLDOWN_MS) {
      const remaining = Math.round((REENTRY_COOLDOWN_MS - elapsed) / 1000);
      return { allowed: false, reason: `Re-entry cooldown: exited ${direction} ${Math.round(elapsed / 1000)}s ago, wait ${remaining}s more` };
    }
  }

  // Rule 4: Max trades per day
  if (todayTradeCount >= ENTRY_GATES.MAX_TRADES_PER_DAY) {
    return { allowed: false, reason: `Max trades reached: ${todayTradeCount}/${ENTRY_GATES.MAX_TRADES_PER_DAY} today` };
  }

  // Rule 5: Min time between ANY entries (not just same direction)
  if (lastEntryTime > 0) {
    const elapsed = Date.now() - lastEntryTime;
    if (elapsed < ENTRY_GATES.MIN_TIME_BETWEEN_ENTRIES_MS) {
      const remaining = Math.round((ENTRY_GATES.MIN_TIME_BETWEEN_ENTRIES_MS - elapsed) / 1000);
      return { allowed: false, reason: `Entry cooldown: last entry ${Math.round(elapsed / 1000)}s ago, wait ${remaining}s more` };
    }
  }

  // Rule 6: Direction stability — score must be stable for 3 consecutive cycles
  if (!isDirectionStable('SPXW', ENTRY_GATES.MIN_STABLE_DIRECTION_CYCLES)) {
    return { allowed: false, reason: `Unstable direction: score hasn't been stable for ${ENTRY_GATES.MIN_STABLE_DIRECTION_CYCLES} consecutive cycles` };
  }

  // Rule 7: Recent direction flip — wait 4 cycles after a flip
  if (hadRecentDirectionFlip('SPXW', ENTRY_GATES.NO_ENTRY_AFTER_FLIP_CYCLES)) {
    return { allowed: false, reason: `Direction flipped in last ${ENTRY_GATES.NO_ENTRY_AFTER_FLIP_CYCLES} cycles — wait for stabilization` };
  }

  // Rule 8: Time of day gate — no new entries after 3:00 PM ET on 0DTE
  const etNow = nowET();
  const timeET = `${String(etNow.hour).padStart(2, '0')}:${String(etNow.minute).padStart(2, '0')}`;
  if (timeET >= ENTRY_GATES.NO_ENTRY_AFTER_ET) {
    return { allowed: false, reason: `Time gate: no new entries after ${ENTRY_GATES.NO_ENTRY_AFTER_ET} ET on 0DTE` };
  }

  // Rule 9: Opening caution (9:30-9:40) — higher thresholds
  if (timeET < ENTRY_GATES.OPENING_CAUTION_UNTIL_ET && timeET >= '09:30') {
    if (scored.score < ENTRY_GATES.OPENING_MIN_SCORE) {
      return { allowed: false, reason: `Opening caution: score ${scored.score} < ${ENTRY_GATES.OPENING_MIN_SCORE} required before ${ENTRY_GATES.OPENING_CAUTION_UNTIL_ET}` };
    }
    if (alignment < ENTRY_GATES.OPENING_MIN_ALIGNMENT) {
      return { allowed: false, reason: `Opening caution: alignment ${alignment}/3 < ${ENTRY_GATES.OPENING_MIN_ALIGNMENT}/3 required before ${ENTRY_GATES.OPENING_CAUTION_UNTIL_ET}` };
    }
  }

  // Rule 10: Chop mode — require higher score during chop
  const chopCfg = getActiveConfig() || {};
  const chopResult = detectChopMode('SPXW', chopCfg.chop_lookback_cycles || 60);
  if (chopResult.isChop && scored.score < (chopCfg.gex_strong_score || 80)) {
    return { allowed: false, reason: `Chop mode (${chopResult.reason}) — need score >= ${chopCfg.gex_strong_score || 80} during chop, got ${scored.score}` };
  }

  return { allowed: true };
}

/**
 * Handle a new trade entry (ENTER_CALLS or ENTER_PUTS).
 * Uses GEX walls for strike/target/stop — no delayed Polygon chain needed.
 */
async function handleTradeEntry(agentAction, parsed, scored, wallTrends) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';

  try {
    const spotPrice = parsed.spotPrice;
    const atm = Math.round(spotPrice / 5) * 5;

    // Strike: ATM for calls, ATM for puts
    const strike = atm;

    // Target & stop from GEX walls
    const targetSpx = scored.targetWall?.strike || (direction === 'BULLISH' ? spotPrice + 20 : spotPrice - 20);
    const stopSpx = scored.floorWall?.strike || (direction === 'BULLISH' ? spotPrice - 10 : spotPrice + 10);

    // Synthetic contract name (0DTE SPX format)
    const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const optType = direction === 'BULLISH' ? 'C' : 'P';
    const contract = `SPX${expDate}${optType}${strike}`;

    const tvSnapshot = getSignalSnapshot();

    log.info(`Trade entry: ${contract} | spot=$${spotPrice} ATM=$${atm} | target=$${targetSpx} stop=$${stopSpx}`);

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
    });

    if (pos) {
      // Track entry for quality gates
      lastEntryTime = Date.now();
      todayTradeCount++;

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

/**
 * Handle a phantom trade entry (new ENTER while already in a position).
 * Uses GEX walls for strike/target/stop — no delayed Polygon chain needed.
 */
async function handlePhantomEntry(agentAction, parsed, scored, wallTrends) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';

  try {
    const spotPrice = parsed.spotPrice;
    const atm = Math.round(spotPrice / 5) * 5;
    const strike = atm;

    const targetSpx = scored.targetWall?.strike || (direction === 'BULLISH' ? spotPrice + 20 : spotPrice - 20);
    const stopSpx = scored.floorWall?.strike || (direction === 'BULLISH' ? spotPrice - 10 : spotPrice + 10);

    const expDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const optType = direction === 'BULLISH' ? 'C' : 'P';
    const contract = `SPX${expDate}${optType}${strike}`;

    recordPhantom({
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
      gexState: { score: scored.score, direction: scored.direction },
      tvState: getSignalSnapshot(),
      agentReasoning: null,
    });
  } catch (err) {
    log.error(`Phantom entry failed: ${err.message}`);
  }
}

// ---- Daily Reset Scheduling (Node Tracker) ----

let dailyResetTimer = null;

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
    todayTradeCount = 0;
    lastEntryTime = 0;
    lastExitTime = 0;
    lastExitDirection = null;
    log.info('Daily reset: node tracker, smoothing, trade counters');

    // Reschedule for next day
    scheduleDailyReset();
  }, msUntilReset);
}

// ---- Phase 5: Nightly/Weekly Review Scheduling ----

/**
 * Schedule the next nightly review at 2 AM ET.
 * On Sundays, runs weekly review instead.
 */
function scheduleNightlyReview() {
  const et = nowET();
  let target = et.set({ hour: 2, minute: 0, second: 0, millisecond: 0 });

  // If already past 2 AM today, schedule for tomorrow
  if (et.hour >= 2) {
    target = target.plus({ days: 1 });
  }

  const msUntilReview = target.toMillis() - et.toMillis();
  const hoursUntil = (msUntilReview / 3_600_000).toFixed(1);

  log.info(`Nightly review scheduled in ${hoursUntil}h (${formatET(target).split(' ')[0]} 02:00 ET)`);

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
