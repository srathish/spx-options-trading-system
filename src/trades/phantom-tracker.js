/**
 * Phantom Tracker
 * Tracks phantom trades (Lane A skipped signals + Lane B GEX+TV phantoms).
 * Full exit trigger parity with trade-manager.js (13 of 14 triggers — no AGENT_EXIT).
 * P&L is based on SPX spot movement (same as trade-manager.js).
 */

import { openTrade, closeTrade, getOpenPhantoms } from '../store/db.js';
import { nowET, formatET } from '../utils/market-hours.js';
import { getActiveConfig } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Phantom');

const MIN_HOLD_BEFORE_SOFT_EXIT_MS = 3 * 60_000; // 3 min hold gate (same as trade-manager)

// In-memory phantom positions
let phantoms = [];

/**
 * Initialize phantom tracker — load open phantoms from DB.
 */
export function initPhantomTracker() {
  const rows = getOpenPhantoms();
  const today = formatET(nowET()).slice(0, 10).replace(/-/g, '');
  let expiredCount = 0;

  phantoms = [];
  for (const row of rows) {
    // Expire cross-day 0DTE phantoms — these options expired at previous close
    const contractDate = extractContractDate(row.contract);
    if (contractDate && contractDate !== today) {
      closeTrade(row.id, {
        exitPrice: 0, exitSpx: row.entry_spx,
        pnlDollars: 0, pnlPct: 0, exitReason: 'EXPIRED_0DTE',
      });
      expiredCount++;
      continue;
    }

    let entryCtx = null;
    try { entryCtx = row.entry_context ? JSON.parse(row.entry_context) : null; } catch { /* ignore */ }

    phantoms.push({
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
      strategyLane: row.strategy_lane || null,
      entryTrigger: row.entry_trigger || null,
      entryContext: entryCtx,
      bestSpxChange: 0,
    });
  }

  if (expiredCount > 0) {
    log.info(`Expired ${expiredCount} cross-day 0DTE phantom(s)`);
  }
  if (phantoms.length > 0) {
    log.info(`Loaded ${phantoms.length} open phantom(s) from DB`);
  }
}

/**
 * Record a phantom trade.
 */
export function recordPhantom({
  contract, direction, strike, entryPrice, entrySpx,
  targetPrice, stopPrice, targetSpx, stopSpx,
  greeks, gexState, tvState, agentReasoning,
  strategyLane, entryTrigger, entryContext,
}) {
  const state = direction === 'BULLISH' ? 'IN_CALLS' : 'IN_PUTS';

  const id = openTrade({
    contract, direction, strike, entryPrice, entrySpx,
    targetPrice, stopPrice, targetSpx, stopSpx,
    greeks, gexState, tvState, agentReasoning,
    isPhantom: true,
    state,
    strategyLane: strategyLane || null,
    entryTrigger: entryTrigger || null,
    entryContext: entryContext || null,
  });

  const phantom = {
    id, contract, direction, strike, entryPrice, entrySpx,
    targetSpx, stopSpx, greeks,
    openedAt: new Date().toISOString(), state,
    strategyLane: strategyLane || null,
    entryTrigger: entryTrigger || null,
    entryContext: entryContext || null,
    bestSpxChange: 0,
  };

  phantoms.push(phantom);
  log.info(`Phantom recorded: ${contract} ${direction} @ SPX ${entrySpx} [Lane ${strategyLane || '?'}]`);

  return phantom;
}

/**
 * Update all open phantoms each cycle.
 * Full exit trigger parity with trade-manager (13 triggers, no AGENT_EXIT).
 *
 * @param {number} currentSpot - Current SPX price
 * @param {object} scored - Scored GEX state (for GEX_FLIP, OPPOSING_WALL)
 * @param {object} context - { tvSnapshot, multiAnalysis }
 * @returns {Array} Closed phantom summaries
 */
export function updatePhantoms(currentSpot, scored = null, context = {}) {
  const closed = [];
  const cfg = getActiveConfig() || {};
  const etNow = nowET();
  const remaining = [];

  for (const phantom of phantoms) {
    const exitReason = checkPhantomExit(phantom, currentSpot, scored, context, cfg, etNow);

    if (exitReason) {
      const isBullish = phantom.direction === 'BULLISH';
      const spxChange = isBullish ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;
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
        strategyLane: phantom.strategyLane,
        entryTrigger: phantom.entryTrigger,
      });

      log.info(
        `Phantom closed: ${phantom.contract} [Lane ${phantom.strategyLane || '?'}] | ${exitReason} | ` +
        `SPX ${phantom.entrySpx} → ${currentSpot} (${spxChange > 0 ? '+' : ''}${pnlDollars} pts) | ${spxChange > 0 ? 'WIN' : 'LOSS'}`
      );
    } else {
      // Update bestSpxChange for trailing stop tracking
      if (phantom.entrySpx && currentSpot) {
        const isBullish = phantom.direction === 'BULLISH';
        const spxChange = isBullish ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;
        if (spxChange > (phantom.bestSpxChange || 0)) {
          phantom.bestSpxChange = spxChange;
        }
      }
      remaining.push(phantom);
    }
  }

  phantoms = remaining;
  return closed;
}

/**
 * Check all 13 exit triggers for a phantom (same priority as trade-manager, minus AGENT_EXIT).
 */
function checkPhantomExit(phantom, currentSpot, scored, context, cfg, etNow) {
  const isBullish = phantom.direction === 'BULLISH';
  const now = Date.now();
  const holdTimeMs = now - new Date(phantom.openedAt).getTime();
  const holdTooShort = holdTimeMs < MIN_HOLD_BEFORE_SOFT_EXIT_MS;

  // 1. TARGET_HIT
  if (phantom.targetSpx) {
    const hit = isBullish ? currentSpot >= phantom.targetSpx : currentSpot <= phantom.targetSpx;
    if (hit) return 'TARGET_HIT';
  }

  // 2. NODE_SUPPORT_BREAK
  if (phantom.entryContext) {
    const ctx = phantom.entryContext;
    const buffer = cfg.node_break_buffer_pts ?? 2;

    if (isBullish && ctx.support_node?.strike) {
      if (currentSpot < ctx.support_node.strike - buffer) return 'NODE_SUPPORT_BREAK';
    }
    if (!isBullish && ctx.ceiling_node?.strike) {
      if (currentSpot > ctx.ceiling_node.strike + buffer) return 'NODE_SUPPORT_BREAK';
    }
  }

  // 3. STOP_HIT
  if (phantom.stopSpx) {
    const hit = isBullish ? currentSpot <= phantom.stopSpx : currentSpot >= phantom.stopSpx;
    if (hit) return 'STOP_HIT';
  }

  // 4. PROFIT_TARGET
  if (phantom.entrySpx && currentSpot) {
    const spxChange = isBullish ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;
    const movePct = (spxChange / phantom.entrySpx) * 100;
    if (movePct >= (cfg.profit_target_pct || 0.15)) return 'PROFIT_TARGET';
    // 5. STOP_LOSS
    if (movePct <= -(cfg.stop_loss_pct || 0.20)) return 'STOP_LOSS';
  }

  // 6. TV_COUNTER_FLIP
  if (cfg.tv_counter_flip_enabled !== false && !holdTooShort && context.tvSnapshot) {
    const signals = context.tvSnapshot.spx?.signals || {};
    const bravo3 = signals['bravo_3m'];
    const tango3 = signals['tango_3m'];

    const bravoAgainst = bravo3 && !bravo3.isStale && (
      (isBullish && bravo3.classification === 'BEARISH') || (!isBullish && bravo3.classification === 'BULLISH')
    );
    const tangoAgainst = tango3 && !tango3.isStale && (
      (isBullish && tango3.classification === 'BEARISH') || (!isBullish && tango3.classification === 'BULLISH')
    );

    if ((bravoAgainst ? 1 : 0) + (tangoAgainst ? 1 : 0) >= (cfg.tv_counter_flip_min_indicators ?? 2)) {
      return 'TV_COUNTER_FLIP';
    }
  }

  // 7. OPPOSING_WALL
  if (!holdTooShort && scored) {
    const opposingWalls = isBullish ? scored.wallsBelow : scored.wallsAbove;
    const opposingValue = cfg.opposing_wall_exit_value || 5_000_000;
    if (opposingWalls?.find(w => Math.abs(w.gexValue) >= opposingValue && w.type === 'POSITIVE')) {
      return 'OPPOSING_WALL';
    }
  }

  // 8. MOMENTUM_TIMEOUT
  if (!holdTooShort && phantom.entrySpx && currentSpot) {
    const holdMinutes = holdTimeMs / 60_000;
    const spxProgress = isBullish ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;

    const p1Min = cfg.momentum_phase1_minutes ?? 5;
    const p1Pts = cfg.momentum_phase1_min_pts ?? 2;
    if (holdMinutes >= p1Min && spxProgress < p1Pts) return 'MOMENTUM_TIMEOUT';

    const p2Min = cfg.momentum_phase2_minutes ?? 10;
    const p2Pct = cfg.momentum_phase2_target_pct ?? 0.40;
    if (holdMinutes >= p2Min && phantom.targetSpx) {
      const totalTarget = Math.abs(phantom.targetSpx - phantom.entrySpx);
      if (totalTarget > 0 && spxProgress < totalTarget * p2Pct) return 'MOMENTUM_TIMEOUT';
    }

    const p3Min = cfg.momentum_phase3_minutes ?? 15;
    if (holdMinutes >= p3Min && spxProgress <= 0) return 'MOMENTUM_TIMEOUT';
  }

  // 9. TV_FLIP (multiple 3m indicators against)
  if (!holdTooShort && context.tvSnapshot) {
    const signals = context.tvSnapshot.spx?.signals || {};
    let opposingCount = 0;
    for (const [key, sig] of Object.entries(signals)) {
      if (!key.endsWith('3m')) continue;
      const opposing = isBullish ? sig.classification === 'BEARISH' : sig.classification === 'BULLISH';
      if (opposing && !sig.isStale) opposingCount++;
    }
    if (opposingCount >= (cfg.tv_against_exit_count || 2)) return 'TV_FLIP';
  }

  // 10. MAP_RESHUFFLE
  if (!holdTooShort && context.multiAnalysis?.reshuffles?.some(r => r.detected)) {
    return 'MAP_RESHUFFLE';
  }

  // 11. TRAILING_STOP
  const trailActivate = cfg.trailing_stop_activate_pts || 8;
  const trailDistance = cfg.trailing_stop_distance_pts || 5;
  if (!holdTooShort && phantom.entrySpx && currentSpot) {
    const spxChange = isBullish ? currentSpot - phantom.entrySpx : phantom.entrySpx - currentSpot;
    if (spxChange > (phantom.bestSpxChange || 0)) phantom.bestSpxChange = spxChange;
    if ((phantom.bestSpxChange || 0) >= trailActivate) {
      const drawdown = phantom.bestSpxChange - spxChange;
      if (drawdown >= trailDistance) return 'TRAILING_STOP';
    }
  }

  // 12. THETA_DEATH
  const [thetaH, thetaM] = (cfg.no_entry_after || '15:30').split(':').map(Number);
  if (etNow.hour > thetaH || (etNow.hour === thetaH && etNow.minute >= thetaM)) {
    return 'THETA_DEATH';
  }

  // 13. GEX_FLIP
  const gexFlipThreshold = cfg.gex_exit_threshold || 60;
  if (!holdTooShort && scored && scored.score >= gexFlipThreshold) {
    const gexBullish = scored.direction === 'BULLISH';
    if (gexBullish !== isBullish) return 'GEX_FLIP';
  }

  return null; // No exit
}

/**
 * Expire any cross-day 0DTE phantoms (called at daily reset).
 */
export function expireCrossDayPhantoms() {
  const today = formatET(nowET()).slice(0, 10).replace(/-/g, '');
  const expired = [];
  const remaining = [];

  for (const phantom of phantoms) {
    const contractDate = extractContractDate(phantom.contract);
    if (contractDate && contractDate !== today) {
      closeTrade(phantom.id, {
        exitPrice: 0, exitSpx: phantom.entrySpx,
        pnlDollars: 0, pnlPct: 0, exitReason: 'EXPIRED_0DTE',
      });
      expired.push(phantom.contract);
    } else {
      remaining.push(phantom);
    }
  }

  if (expired.length > 0) {
    log.info(`Daily reset: expired ${expired.length} cross-day phantom(s): ${expired.join(', ')}`);
  }
  phantoms = remaining;
  return expired.length;
}

/**
 * Extract the date portion from a contract symbol (e.g., SPX20260303C6725 → 20260303).
 */
function extractContractDate(contract) {
  if (!contract) return null;
  const match = contract.match(/(\d{8})/);
  return match ? match[1] : null;
}

/**
 * Get count of active phantoms.
 */
export function getPhantomCount() {
  return phantoms.length;
}
