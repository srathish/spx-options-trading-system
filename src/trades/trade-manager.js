/**
 * Trade Manager
 * State machine: FLAT → PENDING → IN_CALLS/IN_PUTS → FLAT
 * Manages position lifecycle, P&L tracking, and exit triggers.
 */

import { estimateCurrentPnl } from './target-calculator.js';
import {
  openTrade, closeTrade, updateTradePnlDb, confirmTrade,
  getOpenTrade, getTradeById,
} from '../store/db.js';
import { nowET } from '../utils/market-hours.js';
import { getActiveConfig, getVersionLabel } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TradeManager');

const AUTO_CONFIRM_MS = 60_000;       // Auto-confirm PENDING after 60s
const POSITION_UPDATE_MS = 5 * 60_000; // Discord update every 5 min

// In-memory position state
let currentPosition = null;
let lastUpdateSentAt = 0;

/**
 * Initialize trade manager — load open position from DB.
 */
export function initTradeManager() {
  const open = getOpenTrade();
  if (open) {
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
  });

  currentPosition = {
    id, contract, direction, strike, entryPrice, entrySpx,
    targetPrice, stopPrice, targetSpx, stopSpx,
    greeks, state: 'PENDING',
    openedAt: new Date().toISOString(),
    currentPnlPct: 0,
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
export function manageCycle(currentSpot, scored, agentAction) {
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

  // 2. Update P&L estimate
  if (currentPosition.greeks?.delta) {
    const pnl = estimateCurrentPnl({
      entryPrice: currentPosition.entryPrice,
      entrySpx: currentPosition.entrySpx,
      greeks: currentPosition.greeks,
      openedAt: currentPosition.openedAt,
    }, currentSpot);

    currentPosition.currentPnlPct = pnl.pnlPct;
    updateTradePnlDb(currentPosition.id, pnl.pnlPct);
    result.pnl = pnl;
  }

  // 3. Check exit triggers (priority order)

  // 3a. Target hit — SPX reached target wall
  if (currentPosition.targetSpx) {
    const isBullish = currentPosition.direction === 'BULLISH';
    const targetHit = isBullish
      ? currentSpot >= currentPosition.targetSpx
      : currentSpot <= currentPosition.targetSpx;

    if (targetHit) {
      result.exitTriggered = true;
      result.exitReason = 'TARGET_HIT';
      return result;
    }
  }

  // 3b. Stop hit — SPX broke through stop level
  if (currentPosition.stopSpx) {
    const isBullish = currentPosition.direction === 'BULLISH';
    const stopHit = isBullish
      ? currentSpot <= currentPosition.stopSpx
      : currentSpot >= currentPosition.stopSpx;

    if (stopHit) {
      result.exitTriggered = true;
      result.exitReason = 'STOP_HIT';
      return result;
    }
  }

  // 3c. Agent EXIT signal
  if (agentAction) {
    const action = agentAction.toUpperCase();
    if (
      (currentPosition.state === 'IN_CALLS' && (action === 'EXIT_CALLS' || action === 'EXIT')) ||
      (currentPosition.state === 'IN_PUTS' && (action === 'EXIT_PUTS' || action === 'EXIT'))
    ) {
      result.exitTriggered = true;
      result.exitReason = 'AGENT_EXIT';
      return result;
    }
  }

  // 3d. Theta death — configurable time cutoff
  const cfg = getActiveConfig() || {};
  const [thetaH, thetaM] = (cfg.no_entry_after || '15:30').split(':').map(Number);
  const etNow = nowET();
  if (etNow.hour > thetaH ||
      (etNow.hour === thetaH && etNow.minute >= thetaM)) {
    result.exitTriggered = true;
    result.exitReason = 'THETA_DEATH';
    return result;
  }

  // 3e. GEX flip — direction flipped against position
  const gexFlipThreshold = cfg.gex_exit_threshold || 60;
  if (scored && scored.score >= gexFlipThreshold) {
    const gexBullish = scored.direction === 'BULLISH';
    const positionBullish = currentPosition.direction === 'BULLISH';
    if (gexBullish !== positionBullish) {
      result.exitTriggered = true;
      result.exitReason = 'GEX_FLIP';
      return result;
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
 */
export function exitPosition(exitReason, exitPrice, exitSpx) {
  if (!currentPosition) {
    log.warn('No position to exit');
    return null;
  }

  const pnlDollars = exitPrice - currentPosition.entryPrice;
  const pnlPct = (pnlDollars / currentPosition.entryPrice) * 100;

  closeTrade(currentPosition.id, {
    exitPrice,
    exitSpx,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    pnlPct: Math.round(pnlPct * 10) / 10,
    exitReason,
  });

  const result = {
    id: currentPosition.id,
    contract: currentPosition.contract,
    direction: currentPosition.direction,
    entryPrice: currentPosition.entryPrice,
    exitPrice,
    entrySpx: currentPosition.entrySpx,
    exitSpx,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    pnlPct: Math.round(pnlPct * 10) / 10,
    exitReason,
    isWin: pnlDollars > 0,
  };

  log.info(
    `Closed: ${currentPosition.contract} | ${exitReason} | ` +
    `P&L: $${result.pnlDollars} (${result.pnlPct}%) | ${result.isWin ? 'WIN' : 'LOSS'}`
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
