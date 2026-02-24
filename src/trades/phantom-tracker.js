/**
 * Phantom Tracker
 * Tracks skipped signals — when a new ENTER fires while already in a position.
 * Records what would have happened for performance analysis.
 * P&L is based on SPX spot movement (same as trade-manager.js).
 */

import { openTrade, closeTrade, getOpenPhantoms } from '../store/db.js';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Phantom');

const THETA_DEATH_HOUR = 15;
const THETA_DEATH_MINUTE = 30;

// In-memory phantom positions
let phantoms = [];

/**
 * Initialize phantom tracker — load open phantoms from DB.
 */
export function initPhantomTracker() {
  const rows = getOpenPhantoms();
  phantoms = rows.map(row => ({
    id: row.id,
    contract: row.contract,
    direction: row.direction,
    strike: row.strike,
    entryPrice: row.entry_price,
    entrySpx: row.entry_spx,
    targetSpx: row.target_spx,
    stopSpx: row.stop_spx,
    greeks: JSON.parse(row.greeks_at_entry || '{}'),
    openedAt: row.opened_at,
    state: row.state,
  }));

  if (phantoms.length > 0) {
    log.info(`Loaded ${phantoms.length} open phantom(s) from DB`);
  }
}

/**
 * Record a phantom trade (skipped signal).
 */
export function recordPhantom({
  contract, direction, strike, entryPrice, entrySpx,
  targetPrice, stopPrice, targetSpx, stopSpx,
  greeks, gexState, tvState, agentReasoning,
}) {
  const state = direction === 'BULLISH' ? 'IN_CALLS' : 'IN_PUTS';

  const id = openTrade({
    contract, direction, strike, entryPrice, entrySpx,
    targetPrice, stopPrice, targetSpx, stopSpx,
    greeks, gexState, tvState, agentReasoning,
    isPhantom: true,
    state,
  });

  const phantom = {
    id, contract, direction, strike, entryPrice, entrySpx,
    targetSpx, stopSpx, greeks,
    openedAt: new Date().toISOString(), state,
  };

  phantoms.push(phantom);
  log.info(`Phantom recorded: ${contract} ${direction} @ $${entryPrice}`);

  return phantom;
}

/**
 * Update all open phantoms each cycle.
 * Returns array of closed phantom summaries.
 */
export function updatePhantoms(currentSpot) {
  const closed = [];
  const etNow = nowET();
  const isThetaDeath = etNow.hour > THETA_DEATH_HOUR ||
    (etNow.hour === THETA_DEATH_HOUR && etNow.minute >= THETA_DEATH_MINUTE);

  const remaining = [];

  for (const phantom of phantoms) {
    const isBullish = phantom.direction === 'BULLISH';

    // Check target hit
    let exitReason = null;
    if (phantom.targetSpx) {
      const targetHit = isBullish
        ? currentSpot >= phantom.targetSpx
        : currentSpot <= phantom.targetSpx;
      if (targetHit) exitReason = 'TARGET_HIT';
    }

    // Check stop hit
    if (!exitReason && phantom.stopSpx) {
      const stopHit = isBullish
        ? currentSpot <= phantom.stopSpx
        : currentSpot >= phantom.stopSpx;
      if (stopHit) exitReason = 'STOP_HIT';
    }

    // Check theta death
    if (!exitReason && isThetaDeath) {
      exitReason = 'THETA_DEATH';
    }

    if (exitReason) {
      // SPX-based P&L — same as trade-manager.js
      const isBull = phantom.direction === 'BULLISH';
      const spxChange = isBull ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;
      const pnlPct = phantom.entrySpx ? Math.round((spxChange / phantom.entrySpx) * 1000) / 10 : 0;
      const pnlDollars = Math.round(spxChange * 100) / 100;

      closeTrade(phantom.id, {
        exitPrice: 0,
        exitSpx: currentSpot,
        pnlDollars,
        pnlPct,
        exitReason,
      });

      closed.push({
        contract: phantom.contract,
        direction: phantom.direction,
        entrySpx: phantom.entrySpx,
        exitSpx: currentSpot,
        spxChange: pnlDollars,
        pnlPct,
        exitReason,
        isWin: spxChange > 0,
      });

      log.info(
        `Phantom closed: ${phantom.contract} | ${exitReason} | ` +
        `SPX ${phantom.entrySpx} → ${currentSpot} (${spxChange > 0 ? '+' : ''}${pnlDollars} pts) | ${spxChange > 0 ? 'WIN' : 'LOSS'}`
      );
    } else {
      remaining.push(phantom);
    }
  }

  phantoms = remaining;
  return closed;
}

/**
 * Get count of active phantoms.
 */
export function getPhantomCount() {
  return phantoms.length;
}
