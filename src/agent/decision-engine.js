/**
 * Decision Engine — Pre-agent filter + agent orchestration.
 * Sits between data (GEX + TV + Multi-Ticker) and the agent.
 */

import { callAgent, isAgentAvailable } from './agent.js';
import { getSignalSnapshot, getLastUpdateTime, getDetailedState, getTvAlignment, calculateTvConfidence } from '../tv/tv-signal-store.js';
import { getPositionState, getCurrentPosition } from '../trades/trade-manager.js';
import { saveDecision } from '../store/db.js';
import { createLogger } from '../utils/logger.js';
import { detectMidpointDanger, characterizeAirPocket } from '../gex/gex-scorer.js';
import { detectVexConfluence } from '../gex/gex-parser.js';
import { getNodeTouches } from '../gex/node-tracker.js';
import { detectAllPatterns } from '../gex/gex-patterns.js';
import { isPowerHour, isOpexWeek, isOpexDay } from '../utils/market-hours.js';
import { detectChopMode } from '../store/state.js';

const log = createLogger('Decision');

// State tracking
let previousState = null;
let lastAgentCallTime = 0;
let currentAction = 'WAIT';
let currentConfidence = 'LOW';
let lastDecision = null;

/**
 * Check if the agent should be called (pre-filter).
 * Skip if GEX, TV, and multi-ticker state are all unchanged.
 */
function shouldCallAgent(scored, tvSnapshot, multiAnalysis) {
  if (!previousState) return true; // first run always calls

  const gexChanged = (
    Math.abs(scored.score - previousState.gexScore) >= 5 ||
    scored.direction !== previousState.gexDirection ||
    Math.abs(scored.spotPrice - previousState.spotPrice) >= 5
  );

  const tvChanged = getLastUpdateTime() > lastAgentCallTime;

  // Multi-ticker changes: driver changed, alignment changed, or node slides detected
  const multiChanged = multiAnalysis && (
    multiAnalysis.driver?.ticker !== previousState.driverTicker ||
    multiAnalysis.alignment?.direction !== previousState.alignmentDirection ||
    (multiAnalysis.node_slides?.length || 0) > 0
  );

  // Power hour transition or reshuffle detected
  const powerHourChanged = isPowerHour() !== (previousState.wasPowerHour || false);
  const reshuffleDetected = multiAnalysis?.reshuffles?.some(r => r.detected) || false;

  if (!gexChanged && !tvChanged && !multiChanged && !powerHourChanged && !reshuffleDetected) {
    log.debug('Pre-filter: no change — skipping agent call');
    return false;
  }

  if (gexChanged) log.debug('Pre-filter: GEX changed — calling agent');
  if (tvChanged) log.debug('Pre-filter: TV signal updated — calling agent');
  if (multiChanged) log.debug('Pre-filter: Multi-ticker changed — calling agent');
  if (powerHourChanged) log.debug('Pre-filter: Power hour transition — calling agent');
  if (reshuffleDetected) log.debug('Pre-filter: Map reshuffle detected — calling agent');

  return true;
}

/**
 * Build the structured input for the agent (now includes multi-ticker data).
 */
function buildAgentInput(scored, parsedData, tvSnapshot, wallTrends, multiAnalysis, trinityState) {
  // Build walls_above / walls_below for agent
  const wallsAbove = scored.wallsAbove.slice(0, 4).map(w => ({
    strike: w.strike,
    value: w.gexValue,
  }));

  const wallsBelow = scored.wallsBelow.slice(0, 4).map(w => ({
    strike: w.strike,
    value: w.gexValue,
  }));

  // Wall trends for agent
  const trends = (wallTrends || []).slice(0, 5).map(t => ({
    strike: t.wall.strike,
    direction: t.type === 'WALL_GROWTH' ? 'GROWTH' : t.type === 'NEW_WALL' ? 'NEW' : 'SHRINK',
    pct: t.growthPct || 0,
  }));

  // Build multi-ticker price and GEX sections
  const spyState = trinityState?.spy;
  const qqqState = trinityState?.qqq;

  const input = {
    price: {
      spx: scored.spotPrice,
      spy: spyState?.spotPrice || null,
      qqq: qqqState?.spotPrice || null,
    },
    gex: {
      spx: {
        score: scored.score,
        direction: scored.direction,
        confidence: scored.confidence,
        environment: scored.environment.replace(' ', '_'),
        gex_at_spot: scored.gexAtSpot,
        call_wall: scored.targetWall && scored.direction === 'BULLISH'
          ? { strike: scored.targetWall.strike, value: scored.targetWall.gexValue }
          : wallsAbove[0] || null,
        put_wall: scored.targetWall && scored.direction === 'BEARISH'
          ? { strike: scored.targetWall.strike, value: scored.targetWall.gexValue }
          : wallsBelow[0] || null,
        walls_above: wallsAbove,
        walls_below: wallsBelow,
        wall_trends: trends,
        top_nodes: (() => {
          const nt = trinityState?.spxw?.nodeTrends || new Map();
          return [...parsedData.aggregatedGex.entries()]
            .filter(([strike]) => Math.abs(strike - scored.spotPrice) <= 100)
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, 10)
            .map(([strike, value]) => ({
              strike,
              value,
              type: value > 0 ? 'positive' : 'negative',
              dist_from_spot: strike - scored.spotPrice,
              trend: nt.get(strike)?.trend || 'UNKNOWN',
            }));
        })(),
        gone_nodes: (() => {
          const nt = trinityState?.spxw?.nodeTrends || new Map();
          return [...nt.entries()]
            .filter(([, info]) => info.trend === 'GONE')
            .map(([strike, info]) => ({ strike, last_value: info.prevValue10 }))
            .slice(0, 5);
        })(),
      },
      spy: spyState?.scored ? {
        score: spyState.scored.score,
        direction: spyState.scored.direction,
        confidence: spyState.scored.confidence,
        environment: spyState.scored.environment?.replace(' ', '_'),
        gex_at_spot: spyState.scored.gexAtSpot,
        call_wall: spyState.scored.wallsAbove?.[0] ? { strike: spyState.scored.wallsAbove[0].strike, value: spyState.scored.wallsAbove[0].gexValue } : null,
        put_wall: spyState.scored.wallsBelow?.[0] ? { strike: spyState.scored.wallsBelow[0].strike, value: spyState.scored.wallsBelow[0].gexValue } : null,
      } : null,
      qqq: qqqState?.scored ? {
        score: qqqState.scored.score,
        direction: qqqState.scored.direction,
        confidence: qqqState.scored.confidence,
        environment: qqqState.scored.environment?.replace(' ', '_'),
        gex_at_spot: qqqState.scored.gexAtSpot,
        call_wall: qqqState.scored.wallsAbove?.[0] ? { strike: qqqState.scored.wallsAbove[0].strike, value: qqqState.scored.wallsAbove[0].gexValue } : null,
        put_wall: qqqState.scored.wallsBelow?.[0] ? { strike: qqqState.scored.wallsBelow[0].strike, value: qqqState.scored.wallsBelow[0].gexValue } : null,
      } : null,
    },
    multi_ticker: multiAnalysis ? {
      driver: multiAnalysis.driver,
      alignment: multiAnalysis.alignment,
      stacked_walls: multiAnalysis.stacked_walls?.slice(0, 5),
      rug_setups: multiAnalysis.rug_setups?.slice(0, 5),
      node_slides: multiAnalysis.node_slides?.slice(0, 5),
      multi_signal: multiAnalysis.multi_signal,
      wall_classifications: multiAnalysis.wall_classifications?.slice(0, 10),
      rolling_walls: multiAnalysis.rolling_walls?.slice(0, 5),
      reshuffles: multiAnalysis.reshuffles,
      hedge_nodes: multiAnalysis.hedge_nodes?.slice(0, 5),
    } : null,
    tv: tvSnapshot,
    position: getPositionState(),
    prev_action: currentAction,
    node_touches: getNodeTouches(),
    market_context: {
      is_power_hour: isPowerHour(),
      is_opex_week: isOpexWeek(),
      is_opex_day: isOpexDay(),
      market_mode: detectChopMode('SPXW'),
    },
  };

  // Advanced GEX analysis (Gaps 2, 6, 10)
  const midpointResult = detectMidpointDanger(scored.spotPrice, scored.wallsAbove || [], scored.wallsBelow || []);
  if (midpointResult) {
    input.gex.spx.midpoint = midpointResult;
  }

  if (scored.targetWall) {
    const direction = scored.direction === 'BULLISH' ? 'above' : 'below';
    const airPocketResult = characterizeAirPocket(
      scored.spotPrice, scored.targetWall.strike, direction,
      parsedData.aggregatedGex, parsedData.strikes, scored.targetWall.absGexValue
    );
    input.gex.spx.air_pocket = airPocketResult;
  }

  const vexConfluenceResult = detectVexConfluence(parsedData);
  if (vexConfluenceResult.length > 0) {
    input.gex.spx.vex_confluence = vexConfluenceResult.slice(0, 5);
  }

  // Detect GEX patterns for Lane A (pattern-based entries)
  const nodeTouches = getNodeTouches();
  const spxwNodeTrends = trinityState?.spxw?.nodeTrends || new Map();
  input.patterns_detected = detectAllPatterns(scored, parsedData, multiAnalysis, nodeTouches, spxwNodeTrends);
  input.lane = 'A';

  // Add position context when in a trade
  const pos = getCurrentPosition();
  if (pos) {
    input.position_context = {
      contract: pos.contract,
      direction: pos.direction,
      entry_spx: pos.entrySpx,
      current_pnl_pct: pos.currentPnlPct,
      target_spx: pos.targetSpx,
      stop_spx: pos.stopSpx,
    };
  }

  return input;
}

/**
 * Run the full decision cycle.
 * Called every 30s from the main loop after GEX scoring.
 *
 * Returns: { changed, decision, skipped } or null if agent unavailable
 */
export async function runDecisionCycle(scored, parsedData, wallTrends = [], multiAnalysis = null, trinityState = null) {
  if (!isAgentAvailable()) {
    return null;
  }

  // 1. Read TV signal state
  const tvSnapshot = getSignalSnapshot();

  // 2. If TV signals are stale, log it but let GEX drive the decision.
  //    Stale TV = no confirmation, not a hard block.
  if (tvSnapshot.all_stale) {
    log.debug('TV signals stale — GEX will drive (no TV confirmation)');
  }

  // 3. Pre-filter: should we call the agent?
  if (!shouldCallAgent(scored, tvSnapshot, multiAnalysis)) {
    // Log skipped decision
    saveDecision({
      gexScore: scored.score,
      gexDirection: scored.direction,
      gexConfidence: scored.confidence,
      tvState: tvSnapshot,
      tv_confirmations: tvSnapshot.confirmations.bullish + tvSnapshot.confirmations.bearish,
      bravo_confirms: tvSnapshot.bravo_confirms,
      tango_confirms: tvSnapshot.tango_confirms,
      action: currentAction,
      confidence: currentConfidence,
      reason: 'No change — agent skipped',
      skipped: true,
    });

    // Still detect patterns even when agent is skipped (Lane B needs them)
    const skippedNodeTrends = trinityState?.spxw?.nodeTrends || new Map();
    const skippedPatterns = detectAllPatterns(scored, parsedData, multiAnalysis, getNodeTouches(), skippedNodeTrends);
    return { changed: false, decision: lastDecision, skipped: true, patterns: skippedPatterns };
  }

  // 4. Build agent input (now includes multi-ticker data + patterns)
  const input = buildAgentInput(scored, parsedData, tvSnapshot, wallTrends, multiAnalysis, trinityState);

  // 5. Call the agent
  log.info('Calling Kimi agent...');
  const agentResult = await callAgent(input);

  // 6. Update state
  lastAgentCallTime = Date.now();
  previousState = {
    gexScore: scored.score,
    gexDirection: scored.direction,
    spotPrice: scored.spotPrice,
    driverTicker: multiAnalysis?.driver?.ticker || null,
    alignmentDirection: multiAnalysis?.alignment?.direction || null,
    wasPowerHour: isPowerHour(),
  };

  // 7. Check if action changed
  const actionChanged = agentResult.action !== currentAction;
  const confidenceChanged = agentResult.confidence !== currentConfidence;
  const changed = actionChanged || confidenceChanged;

  const previousAction = currentAction;
  currentAction = agentResult.action;
  currentConfidence = agentResult.confidence;

  // 8. Build full decision record
  const decision = {
    ...agentResult,
    gexScore: scored.score,
    gexDirection: scored.direction,
    gexConfidence: scored.confidence,
    tvState: tvSnapshot,
    tv_confirmations: tvSnapshot.confirmations.bullish + tvSnapshot.confirmations.bearish,
    bravo_confirms: tvSnapshot.bravo_confirms,
    tango_confirms: tvSnapshot.tango_confirms,
    tv_alignment: getTvAlignment(),
    tv_confidence: calculateTvConfidence(),
    inputTokens: agentResult.input_tokens,
    outputTokens: agentResult.output_tokens,
    responseTimeMs: agentResult.response_time_ms,
    skipped: false,
    previousAction,
    tvDetailedState: getDetailedState(),
    multiTicker: multiAnalysis ? {
      driver: multiAnalysis.driver,
      alignment: multiAnalysis.alignment,
      multiSignal: multiAnalysis.multi_signal,
    } : null,
    spotPrice: scored.spotPrice,
    spyScore: trinityState?.spy?.scored?.score || null,
    spyDirection: trinityState?.spy?.scored?.direction || null,
    spySpot: trinityState?.spy?.spotPrice || null,
    qqqScore: trinityState?.qqq?.scored?.score || null,
    qqqDirection: trinityState?.qqq?.scored?.direction || null,
    qqqSpot: trinityState?.qqq?.spotPrice || null,
  };

  lastDecision = decision;

  // 9. Save to database
  saveDecision(decision);

  if (changed) {
    log.info(`Decision changed: ${previousAction} → ${agentResult.action} (${agentResult.confidence})`);
  }

  return { changed, decision, skipped: false, patterns: input.patterns_detected };
}

/**
 * Get the current decision state (for CLI / health).
 */
export function getCurrentDecision() {
  return {
    action: currentAction,
    confidence: currentConfidence,
    lastDecision,
  };
}
