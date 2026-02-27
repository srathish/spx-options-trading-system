/**
 * Trade Manager
 * State machine: FLAT → PENDING → IN_CALLS/IN_PUTS → FLAT
 * Manages position lifecycle, P&L tracking, and exit triggers.
 */

import {
  openTrade, closeTrade, updateTradePnlDb, confirmTrade,
  getOpenTrade, getTradeById,
} from '../store/db.js';
import { nowET } from '../utils/market-hours.js';
import { getActiveConfig, getVersionLabel } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TradeManager');

const AUTO_CONFIRM_MS = 60_000;              // Auto-confirm PENDING after 60s
const POSITION_UPDATE_MS = 5 * 60_000;      // Discord update every 5 min
const MIN_HOLD_BEFORE_SOFT_EXIT_MS = 3 * 60_000; // 3 min before GEX_FLIP/AGENT_EXIT can trigger

// In-memory position state
let currentPosition = null;
let lastUpdateSentAt = 0;

/**
 * Initialize trade manager — load open position from DB.
 */
export function initTradeManager() {
  const open = getOpenTrade();
  if (open) {
    let entryCtx = null;
    try { entryCtx = open.entry_context ? JSON.parse(open.entry_context) : null; } catch { /* ignore */ }

    currentPosition = {
      id: open.id,
      contract: open.contract,
      direction: open.direction,
      strike: open.strike,
      entryPrice: open.entry_price,
      entrySpx: open.entry_spx,
      targetPrice: open.target_price,
      stopPrice: open.stop_price,
      targetSpx: open.target_spx,
      stopSpx: open.stop_spx,
      greeks: JSON.parse(open.greeks_at_entry || '{}'),
      state: open.state,
      openedAt: open.opened_at,
      currentPnlPct: open.current_pnl_pct || 0,
      bestSpxChange: 0,
      entryContext: entryCtx,
    };
    log.info(`Resumed position: ${currentPosition.contract} (${currentPosition.state})`);
  } else {
    log.info('No open position — starting FLAT');
  }
}

/**
 * Get current position state string.
 */
export function getPositionState() {
  if (!currentPosition) return 'FLAT';
  return currentPosition.state;
}

/**
 * Get full current position details (for agent context).
 */
export function getCurrentPosition() {
  return currentPosition;
}

/**
 * Enter a new position.
 */
export function enterPosition({
  contract, direction, strike, entryPrice, entrySpx,
  targetPrice, stopPrice, targetSpx, stopSpx,
  greeks, gexState, tvState, agentReasoning,
  strategyLane, entryTrigger, entryContext,
}) {
  if (currentPosition) {
    log.warn('Already in a position — cannot enter another');
    return null;
  }

  const id = openTrade({
    contract, direction, strike, entryPrice, entrySpx,
    targetPrice, stopPrice, targetSpx, stopSpx,
    greeks, gexState, tvState, agentReasoning,
    isPhantom: false,
    state: 'PENDING',
    strategyVersion: getVersionLabel(),
    strategyLane: strategyLane || null,
    entryTrigger: entryTrigger || null,
    entryContext: entryContext || null,
  });

  currentPosition = {
    id, contract, direction, strike, entryPrice, entrySpx,
    targetPrice, stopPrice, targetSpx, stopSpx,
    greeks, state: 'PENDING',
    openedAt: new Date().toISOString(),
    currentPnlPct: 0,
    bestSpxChange: 0,
    entryContext: entryContext || null,
  };

  lastUpdateSentAt = Date.now();
  log.info(`Opened: ${contract} ${direction} @ $${entryPrice} | target=$${targetPrice} stop=$${stopPrice}`);

  return currentPosition;
}

/**
 * Per-cycle management of open position.
 * Handles auto-confirm, P&L updates, exit trigger checks.
 *
 * @returns {{ exitTriggered, exitReason, pnl, shouldSendUpdate }}
 */
export function manageCycle(currentSpot, scored, agentAction, context = {}) {
  if (!currentPosition) return { exitTriggered: false, shouldSendUpdate: false };

  const now = Date.now();
  const result = { exitTriggered: false, exitReason: null, pnl: null, shouldSendUpdate: false };

  // 1. Auto-confirm PENDING → IN_CALLS/IN_PUTS after 60s
  if (currentPosition.state === 'PENDING') {
    const openedTime = new Date(currentPosition.openedAt).getTime();
    if (now - openedTime >= AUTO_CONFIRM_MS) {
      const newState = currentPosition.direction === 'BULLISH' ? 'IN_CALLS' : 'IN_PUTS';
      confirmTrade(currentPosition.id, newState);
      currentPosition.state = newState;
      log.info(`Auto-confirmed: ${currentPosition.contract} → ${newState}`);
    }
  }

  // 2. Update P&L estimate — SPX spot movement
  if (currentPosition.entrySpx && currentSpot) {
    const isBullish = currentPosition.direction === 'BULLISH';
    const spxChange = isBullish ? currentSpot - currentPosition.entrySpx : currentPosition.entrySpx - currentSpot;
    const pnlPct = (spxChange / currentPosition.entrySpx) * 100;

    currentPosition.currentPnlPct = Math.round(pnlPct * 10) / 10;
    updateTradePnlDb(currentPosition.id, currentPosition.currentPnlPct);
    result.pnl = {
      spxChange: Math.round(spxChange * 100) / 100,
      pnlPct: currentPosition.currentPnlPct,
      currentSpx: currentSpot,
    };
  }

  // 3. Check exit triggers (priority order)
  const cfg = getActiveConfig() || {};
  const isBullish = currentPosition.direction === 'BULLISH';

  // 3a. Target hit — SPX reached target wall
  if (currentPosition.targetSpx) {
    const targetHit = isBullish
      ? currentSpot >= currentPosition.targetSpx
      : currentSpot <= currentPosition.targetSpx;

    if (targetHit) {
      result.exitTriggered = true;
      result.exitReason = 'TARGET_HIT';
      return result;
    }
  }

  // 3a2. NODE_SUPPORT_BREAK — price broke past the structural node that defined the trade thesis
  if (currentPosition.entryContext) {
    const ctx = currentPosition.entryContext;
    const buffer = cfg.node_break_buffer_pts ?? 2;

    if (isBullish && ctx.support_node?.strike) {
      if (currentSpot < ctx.support_node.strike - buffer) {
        result.exitTriggered = true;
        result.exitReason = 'NODE_SUPPORT_BREAK';
        return result;
      }
    }
    if (!isBullish && ctx.ceiling_node?.strike) {
      if (currentSpot > ctx.ceiling_node.strike + buffer) {
        result.exitTriggered = true;
        result.exitReason = 'NODE_SUPPORT_BREAK';
        return result;
      }
    }
  }

  // 3b. Stop hit — SPX broke through stop level
  if (currentPosition.stopSpx) {
    const stopHit = isBullish
      ? currentSpot <= currentPosition.stopSpx
      : currentSpot >= currentPosition.stopSpx;

    if (stopHit) {
      result.exitTriggered = true;
      result.exitReason = 'STOP_HIT';
      return result;
    }
  }

  // 3c. Profit target — lock in gains (immediate, no hold gate)
  if (currentPosition.entrySpx && currentSpot) {
    const spxChange = isBullish ? currentSpot - currentPosition.entrySpx : currentPosition.entrySpx - currentSpot;
    const movePct = (spxChange / currentPosition.entrySpx) * 100;

    const profitTargetPct = cfg.profit_target_pct || 0.15;
    if (movePct >= profitTargetPct) {
      result.exitTriggered = true;
      result.exitReason = 'PROFIT_TARGET';
      return result;
    }

    // 3d. Stop loss — cut losses (immediate, no hold gate)
    const stopLossPct = cfg.stop_loss_pct || 0.20;
    if (movePct <= -stopLossPct) {
      result.exitTriggered = true;
      result.exitReason = 'STOP_LOSS';
      return result;
    }
  }

  // Calculate hold time for minimum-hold gates
  const holdTimeMs = now - new Date(currentPosition.openedAt).getTime();
  const holdTooShort = holdTimeMs < MIN_HOLD_BEFORE_SOFT_EXIT_MS;

  // 3d2. TV_COUNTER_FLIP — both Bravo AND Tango 3m flipped against position
  if (cfg.tv_counter_flip_enabled !== false && !holdTooShort && context.tvSnapshot) {
    const signals = context.tvSnapshot.spx?.signals || {};
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

    const minIndicators = cfg.tv_counter_flip_min_indicators ?? 2;
    const counterCount = (bravoAgainst ? 1 : 0) + (tangoAgainst ? 1 : 0);

    if (counterCount >= minIndicators) {
      result.exitTriggered = true;
      result.exitReason = 'TV_COUNTER_FLIP';
      return result;
    }
  }

  // 3e. Opposing wall — large positive wall materialized against our position
  const opposingWallValue = cfg.opposing_wall_exit_value || 5_000_000;
  if (!holdTooShort && scored) {
    const opposingWalls = isBullish ? scored.wallsBelow : scored.wallsAbove;
    const bigOpposing = opposingWalls?.find(w => Math.abs(w.gexValue) >= opposingWallValue && w.type === 'POSITIVE');
    if (bigOpposing) {
      result.exitTriggered = true;
      result.exitReason = 'OPPOSING_WALL';
      return result;
    }
  }

  // 3e2. MOMENTUM_TIMEOUT — 3 progressive phases of stall detection
  if (!holdTooShort && currentPosition.entrySpx && currentSpot) {
    const holdMinutes = holdTimeMs / 60_000;
    const spxProgress = isBullish
      ? currentSpot - currentPosition.entrySpx
      : currentPosition.entrySpx - currentSpot;

    const phase1Min = cfg.momentum_phase1_minutes ?? 5;
    const phase1Pts = cfg.momentum_phase1_min_pts ?? 2;
    const phase2Min = cfg.momentum_phase2_minutes ?? 10;
    const phase2Pct = cfg.momentum_phase2_target_pct ?? 0.40;
    const phase3Min = cfg.momentum_phase3_minutes ?? 15;

    // Phase 1: After 5 min, must have moved +2 pts
    if (holdMinutes >= phase1Min && spxProgress < phase1Pts) {
      result.exitTriggered = true;
      result.exitReason = 'MOMENTUM_TIMEOUT';
      return result;
    }

    // Phase 2: After 10 min, must be 40% of the way to target
    if (holdMinutes >= phase2Min && currentPosition.targetSpx) {
      const totalTarget = Math.abs(currentPosition.targetSpx - currentPosition.entrySpx);
      if (totalTarget > 0 && spxProgress < totalTarget * phase2Pct) {
        result.exitTriggered = true;
        result.exitReason = 'MOMENTUM_TIMEOUT';
        return result;
      }
    }

    // Phase 3: After 15 min, must be net positive
    if (holdMinutes >= phase3Min && spxProgress <= 0) {
      result.exitTriggered = true;
      result.exitReason = 'MOMENTUM_TIMEOUT';
      return result;
    }
  }

  // 3f. TV flip — multiple 3m indicators turned against position
  const tvAgainstCount = cfg.tv_against_exit_count || 2;
  if (!holdTooShort && context.tvSnapshot) {
    const signals = context.tvSnapshot.spx?.signals || {};
    let opposingCount = 0;
    for (const [key, sig] of Object.entries(signals)) {
      if (!key.endsWith('3m')) continue;
      const opposing = isBullish ? sig.classification === 'BEARISH' : sig.classification === 'BULLISH';
      if (opposing && !sig.isStale) opposingCount++;
    }
    if (opposingCount >= tvAgainstCount) {
      result.exitTriggered = true;
      result.exitReason = 'TV_FLIP';
      return result;
    }
  }

  // 3g. Map reshuffle — flag for agent review, don't auto-exit
  // The agent gets reshuffle context and decides: 'minor shift, hold' vs 'thesis broken, exit'
  if (!holdTooShort && context.multiAnalysis?.reshuffles?.some(r => r.detected)) {
    result.reshuffleDetected = true;
    log.info('Map reshuffle detected — flagged for agent review (no auto-exit)');
  }

  // 3h. Trailing stop — activated after threshold, trails behind best price
  const trailActivate = cfg.trailing_stop_activate_pts || 8;
  const trailDistance = cfg.trailing_stop_distance_pts || 5;
  if (!holdTooShort && currentPosition.entrySpx && currentSpot) {
    const spxChangeForTrail = isBullish ? currentSpot - currentPosition.entrySpx : currentPosition.entrySpx - currentSpot;

    if (!currentPosition.bestSpxChange || spxChangeForTrail > currentPosition.bestSpxChange) {
      currentPosition.bestSpxChange = spxChangeForTrail;
    }

    if (currentPosition.bestSpxChange >= trailActivate) {
      const drawdown = currentPosition.bestSpxChange - spxChangeForTrail;
      if (drawdown >= trailDistance) {
        result.exitTriggered = true;
        result.exitReason = 'TRAILING_STOP';
        return result;
      }
    }
  }

  // 3i. Agent EXIT signal — advisory only, requires structural confirmation
  // Agent has 33% win rate on discretionary exits — only act when confirmed by:
  //   - Price broke support/ceiling node (within 3pts)
  //   - Momentum stalled (< +1pt progress after 5+ min)
  //   - GEX score dropped below exit threshold
  if (agentAction) {
    const action = agentAction.toUpperCase();
    if (
      (currentPosition.state === 'IN_CALLS' && (action === 'EXIT_CALLS' || action === 'EXIT')) ||
      (currentPosition.state === 'IN_PUTS' && (action === 'EXIT_PUTS' || action === 'EXIT'))
    ) {
      if (holdTooShort) {
        log.debug(`Agent recommends exit but holding — ${Math.round((MIN_HOLD_BEFORE_SOFT_EXIT_MS - holdTimeMs) / 1000)}s until min hold`);
      } else {
        // Check for structural confirmation before acting on agent exit
        let confirmed = false;
        let confirmReason = '';

        // Confirmation 1: Price near/past support or ceiling node
        if (currentPosition.entryContext) {
          const ctx = currentPosition.entryContext;
          const nearBuffer = 3; // within 3pts of node
          if (isBullish && ctx.support_node?.strike && currentSpot < ctx.support_node.strike + nearBuffer) {
            confirmed = true;
            confirmReason = `price near support ${ctx.support_node.strike}`;
          }
          if (!isBullish && ctx.ceiling_node?.strike && currentSpot > ctx.ceiling_node.strike - nearBuffer) {
            confirmed = true;
            confirmReason = `price near ceiling ${ctx.ceiling_node.strike}`;
          }
        }

        // Confirmation 2: Momentum stalled (< +1pt after 5+ min hold)
        if (!confirmed && holdTimeMs >= 5 * 60_000) {
          const spxProgress = isBullish
            ? currentSpot - currentPosition.entrySpx
            : currentPosition.entrySpx - currentSpot;
          if (spxProgress < 1) {
            confirmed = true;
            confirmReason = `momentum stalled (${spxProgress.toFixed(1)}pts after ${Math.round(holdTimeMs / 60_000)}min)`;
          }
        }

        // Confirmation 3: GEX score dropped below exit threshold
        if (!confirmed && scored && scored.score < (cfg.gex_exit_threshold || 40)) {
          confirmed = true;
          confirmReason = `GEX score ${scored.score} < exit threshold`;
        }

        if (confirmed) {
          result.exitTriggered = true;
          result.exitReason = 'AGENT_EXIT';
          log.info(`Agent exit CONFIRMED: ${confirmReason}`);
          return result;
        } else {
          log.info(`Agent recommends exit but NO structural confirmation — holding position`);
        }
      }
    }
  }

  // 3j. Theta death — configurable time cutoff (always immediate)
  const [thetaH, thetaM] = (cfg.no_entry_after || '15:30').split(':').map(Number);
  const etNow = nowET();
  if (etNow.hour > thetaH ||
      (etNow.hour === thetaH && etNow.minute >= thetaM)) {
    result.exitTriggered = true;
    result.exitReason = 'THETA_DEATH';
    return result;
  }

  // 3k. GEX flip — direction flipped against position — requires minimum hold time
  const gexFlipThreshold = cfg.gex_exit_threshold || 60;
  if (scored && scored.score >= gexFlipThreshold) {
    const gexBullish = scored.direction === 'BULLISH';
    const positionBullish = currentPosition.direction === 'BULLISH';
    if (gexBullish !== positionBullish) {
      if (holdTooShort) {
        log.debug(`GEX flipped but holding — ${Math.round((MIN_HOLD_BEFORE_SOFT_EXIT_MS - holdTimeMs) / 1000)}s until min hold (noise filter)`);
      } else {
        result.exitTriggered = true;
        result.exitReason = 'GEX_FLIP';
        return result;
      }
    }
  }

  // 4. Check if position update should be sent to Discord (every 5 min)
  if (now - lastUpdateSentAt >= POSITION_UPDATE_MS) {
    result.shouldSendUpdate = true;
    lastUpdateSentAt = now;
  }

  return result;
}

/**
 * Exit the current position.
 * P&L is based on SPX spot movement (no option pricing needed).
 */
export function exitPosition(exitReason, exitSpx) {
  if (!currentPosition) {
    log.warn('No position to exit');
    return null;
  }

  const isBullish = currentPosition.direction === 'BULLISH';
  const spxChange = isBullish ? exitSpx - currentPosition.entrySpx : currentPosition.entrySpx - exitSpx;
  const pnlPct = currentPosition.entrySpx ? (spxChange / currentPosition.entrySpx) * 100 : 0;

  closeTrade(currentPosition.id, {
    exitPrice: 0,
    exitSpx,
    pnlDollars: Math.round(spxChange * 100) / 100,
    pnlPct: Math.round(pnlPct * 10) / 10,
    exitReason,
  });

  const result = {
    id: currentPosition.id,
    contract: currentPosition.contract,
    direction: currentPosition.direction,
    entrySpx: currentPosition.entrySpx,
    exitSpx,
    spxChange: Math.round(spxChange * 100) / 100,
    pnlPct: Math.round(pnlPct * 10) / 10,
    exitReason,
    isWin: spxChange > 0,
    strategyLane: currentPosition.strategyLane || null,
    entryTrigger: currentPosition.entryTrigger || null,
  };

  log.info(
    `Closed: ${currentPosition.contract} [Lane ${currentPosition.strategyLane || '?'}] | ${exitReason} | ` +
    `SPX ${currentPosition.entrySpx} → ${exitSpx} (${spxChange > 0 ? '+' : ''}${result.spxChange} pts) | ${result.isWin ? 'WIN' : 'LOSS'}`
  );

  currentPosition = null;
  lastUpdateSentAt = 0;

  return result;
}

/**
 * Check if a new ENTER signal should be treated as a phantom trade.
 */
export function shouldBePhantom() {
  return currentPosition !== null;
}
