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
import { saveSnapshot, savePrediction, saveHealth, saveMultiAnalysis, getCheckedPredictionsToday, getUncheckedPredictions, markPredictionChecked, cleanupOldData, getTradeById } from '../store/db.js';
import { getGexHistory } from '../store/state.js';
import { shouldSendAlert } from '../alerts/throttle.js';
import { sendSpxAnalysis, sendLiveAlert, sendOpeningSummary, sendEodRecap, sendHealthHeartbeat, sendCombinedSignalAlert, sendTradeCard, sendPositionUpdate, sendTradeClosed, sendStrategyChange, sendStrategyRollback, sendNoChange, sendMapReshuffleAlert } from '../alerts/discord.js';
import { runDecisionCycle } from '../agent/decision-engine.js';
import { initTradeManager, getPositionState, getCurrentPosition, enterPosition, manageCycle as managePosition, exitPosition, shouldBePhantom } from '../trades/trade-manager.js';
import { initPhantomTracker, recordPhantom, updatePhantoms } from '../trades/phantom-tracker.js';
import { updateHeatseekerSpot } from '../polygon/price-feed.js';
import { isPolygonAvailable } from '../polygon/polygon-client.js';
import { fetch0DteChain } from '../polygon/options-chain.js';
import { selectStrike } from '../trades/strike-selector.js';
import { getSignalSnapshot } from '../tv/tv-signal-store.js';
import { getSchedulePhase, isOpeningSummaryTime, isEodRecapTime, nowET, formatET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';
import { updateLoopStatus } from './loop-status.js';
import { dashboardEmitter } from '../dashboard/dashboard-server.js';
import { initStrategyStore, getVersionLabel, getActiveVersionNumber } from '../review/strategy-store.js';
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
let nightlyReviewDate = null;
let running = false;

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
      ? scoreSpxGex(parsed, wallTrends, multiAnalysis.bonus)
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
      }
    }

    // Save SPXW to DB (history is saved per-ticker inside fetchTrinityData)
    saveSnapshot(scored);
    try { saveMultiAnalysis(multiAnalysis, trinityState); } catch (_) {}

    // Track state
    lastSpot = parsed.spotPrice;
    lastScore = scored.score;
    updateLoopStatus({ cycleCount, lastSpot, lastScore, lastDirection: scored.direction });

    // Dashboard: emit GEX update
    try { dashboardEmitter.emit('gex_update', { spotPrice: parsed.spotPrice, score: scored.score, direction: scored.direction, confidence: scored.confidence, environment: scored.environment, wallsAbove: scored.wallsAbove?.slice(0, 4), wallsBelow: scored.wallsBelow?.slice(0, 4), breakdown: scored.breakdown }); } catch (_) {}

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
    if (history.length >= 1) {
      const prevSpot = history[history.length - 1].spotPrice;
      const spotMovePct = Math.abs(parsed.spotPrice - prevSpot) / prevSpot * 100;

      if (spotMovePct > 0.3) {
        const moveDir = parsed.spotPrice > prevSpot ? 'UP' : 'DOWN';
        const moveStrike = Math.round(parsed.spotPrice / 5) * 5;
        if (shouldSendAlert('BIG_MOVE', moveStrike)) {
          await sendLiveAlert('ENVIRONMENT_CHANGE',
            `SPX moved **${moveDir} ${spotMovePct.toFixed(2)}%** in last cycle\n` +
            `$${prevSpot.toFixed(2)} \u2192 $${parsed.spotPrice.toFixed(2)}\n` +
            `Environment: ${scored.environment}`
          );
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
      } else if (alert.type === 'WALL_SHRINK') {
        await sendLiveAlert('WALL_SHRINK',
          `Wall at **${alert.wall.strike}** shrank **${(Math.abs(alert.growthPct) * 100).toFixed(0)}%**\n` +
          `${formatDollar(alert.prevValue)} \u2192 ${formatDollar(alert.wall.absGexValue)}\n` +
          `Potential breakout signal`
        );
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
        agentAction = decision.action;
        log.info(`Decision: ${decision.action} (${decision.confidence}) — alert sent`);
      } else if (decisionResult && decisionResult.skipped) {
        agentAction = decisionResult.decision?.action || null;
        log.debug('Decision: agent skipped (no change)');
      } else if (decisionResult) {
        agentAction = decisionResult.decision?.action || null;
        log.debug(`Decision: ${decisionResult.decision?.action} (no change)`);
      }
      // Dashboard: emit decision update
      try { dashboardEmitter.emit('decision_update', { action: agentAction, decision: decisionResult?.decision }); } catch (_) {}
    } catch (decisionErr) {
      log.error('Decision engine error:', decisionErr.message);
    }

    // ---- PHASE 3: TRADE EXECUTION ----
    // Update Heatseeker spot cache for price feed
    updateHeatseekerSpot(parsed.spotPrice);

    try {
      const posState = getPositionState();

      // A. If position OPEN → manage cycle (exit triggers, P&L updates)
      if (posState !== 'FLAT') {
        const mgmt = managePosition(parsed.spotPrice, scored, agentAction);

        if (mgmt.exitTriggered) {
          // Estimate exit price via current P&L
          const exitPrice = mgmt.pnl?.estimatedPrice || getCurrentPosition()?.entryPrice || 0;
          const result = exitPosition(mgmt.exitReason, exitPrice, parsed.spotPrice);
          if (result) {
            await sendTradeClosed(result);
            try { dashboardEmitter.emit('trade_closed', result); } catch (_) {}

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
              pnlDollars: mgmt.pnl.pnlDollars,
              currentSpx: parsed.spotPrice,
              entrySpx: pos.entrySpx,
              estimatedPrice: mgmt.pnl.estimatedPrice,
              entryPrice: pos.entryPrice,
            };
            await sendPositionUpdate(posUpdate);
            try { dashboardEmitter.emit('position_update', posUpdate); } catch (_) {}
          }
        }
      }

      // B. If FLAT + agent ENTER + Polygon available → open trade
      if (getPositionState() === 'FLAT' && agentAction && isPolygonAvailable()) {
        const isEnter = agentAction === 'ENTER_CALLS' || agentAction === 'ENTER_PUTS';
        if (isEnter) {
          await handleTradeEntry(agentAction, parsed, scored, wallTrends);
        }
      }

      // C. If NOT FLAT + agent ENTER again → phantom trade
      if (getPositionState() !== 'FLAT' && agentAction) {
        const isEnter = agentAction === 'ENTER_CALLS' || agentAction === 'ENTER_PUTS';
        if (isEnter && shouldBePhantom() && isPolygonAvailable()) {
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
 * Handle a new trade entry (ENTER_CALLS or ENTER_PUTS).
 */
async function handleTradeEntry(agentAction, parsed, scored, wallTrends) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';

  try {
    // Fetch options chain
    const chain = await fetch0DteChain(parsed.spotPrice);
    if (!chain) {
      log.warn('No chain data — skipping trade entry');
      return;
    }

    // Select strike
    const targetSpx = scored.targetWall?.strike || (direction === 'BULLISH' ? parsed.spotPrice + 20 : parsed.spotPrice - 20);
    const stopSpx = scored.floorWall?.strike || (direction === 'BULLISH' ? parsed.spotPrice - 10 : parsed.spotPrice + 10);

    const selection = selectStrike({
      direction,
      spotPrice: parsed.spotPrice,
      atm: chain.atm,
      calls: chain.calls,
      puts: chain.puts,
      targetSpx,
      stopSpx,
    });

    if (!selection.selected) {
      log.warn(`No valid strike selected for ${direction} — skipping`);
      return;
    }

    const { contract, entryPrice, targets } = selection.selected;
    const tvSnapshot = getSignalSnapshot();

    // Enter position
    const pos = enterPosition({
      contract: contract.ticker,
      direction,
      strike: contract.strike,
      entryPrice,
      entrySpx: parsed.spotPrice,
      targetPrice: targets.targetOptionPrice,
      stopPrice: targets.stopOptionPrice,
      targetSpx,
      stopSpx,
      greeks: contract.greeks,
      gexState: {
        score: scored.score,
        direction: scored.direction,
        environment: scored.environment,
      },
      tvState: tvSnapshot,
      agentReasoning: scored.recommendation || null,
    });

    if (pos) {
      const tradeData = {
        ...pos,
        targetPnlPct: targets.targetPnlPct,
        stopPnlPct: targets.stopPnlPct,
        rewardRiskRatio: targets.rewardRiskRatio,
        greeks: contract.greeks,
        agentReasoning: scored.recommendation || null,
      };
      await sendTradeCard(tradeData);
      try { dashboardEmitter.emit('trade_opened', tradeData); } catch (_) {}
    }
  } catch (err) {
    log.error(`Trade entry failed: ${err.message}`);
  }
}

/**
 * Handle a phantom trade entry (new ENTER while already in a position).
 */
async function handlePhantomEntry(agentAction, parsed, scored, wallTrends) {
  const direction = agentAction === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';

  try {
    const chain = await fetch0DteChain(parsed.spotPrice);
    if (!chain) return;

    const targetSpx = scored.targetWall?.strike || (direction === 'BULLISH' ? parsed.spotPrice + 20 : parsed.spotPrice - 20);
    const stopSpx = scored.floorWall?.strike || (direction === 'BULLISH' ? parsed.spotPrice - 10 : parsed.spotPrice + 10);

    const selection = selectStrike({
      direction,
      spotPrice: parsed.spotPrice,
      atm: chain.atm,
      calls: chain.calls,
      puts: chain.puts,
      targetSpx,
      stopSpx,
    });

    if (!selection.selected) return;

    const { contract, entryPrice, targets } = selection.selected;

    recordPhantom({
      contract: contract.ticker,
      direction,
      strike: contract.strike,
      entryPrice,
      entrySpx: parsed.spotPrice,
      targetPrice: targets.targetOptionPrice,
      stopPrice: targets.stopOptionPrice,
      targetSpx,
      stopSpx,
      greeks: contract.greeks,
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
    log.info('Node touch tracker reset for new trading day');

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

      // Send Discord alerts + emit dashboard events
      try {
        if (reviewResult.newVersion) {
          await sendStrategyChange(reviewResult);
          dashboardEmitter.emit('strategy_update', {
            version: reviewResult.newVersion,
            changes: reviewResult.changes,
            analysis: reviewResult.analysis?.analysis_summary,
          });
        } else if (!reviewResult.skipped) {
          await sendNoChange(reviewResult);
        }
      } catch (_) {}

    } catch (err) {
      log.error('Nightly review failed:', err.message);
    }

    // Reschedule for next night
    scheduleNightlyReview();
  }, msUntilReview);
}

// Re-export getLoopStatus from loop-status.js for backwards compatibility
export { getLoopStatus } from './loop-status.js';
