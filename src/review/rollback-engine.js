/**
 * Rollback Engine — Monitors active strategy version performance
 * and triggers automatic rollbacks when thresholds are breached.
 *
 * Called after every trade close + during nightly review.
 *
 * 4 triggers:
 * 1. WIN_RATE_DROP — Win rate dropped >15pp from parent version
 * 2. AVOIDABLE_LOSSES — 3+ losses that previous version would have skipped
 * 3. AVG_PNL_DROP — Avg P&L below 70% of parent version's avg
 * 4. DRAWDOWN — Total P&L under current version below -$2000
 *
 * Plus: V1 floor guarantee — any version worse than v1 after 5 trades → back to v1.
 */

import {
  getVersionByNumber, getTradesForVersion, getPhantomComparisonsForVersion,
  saveRollbackEvent, getRecentRollbacks,
} from '../store/db.js';
import {
  getActiveVersionNumber, getActiveConfig, getVersionLabel,
  rollbackTo, getV1BaselineConfig,
} from './strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Rollback');

// Minimum trades before any rollback check activates
const MIN_TRADES_FOR_ROLLBACK = 5;

/**
 * Check all rollback triggers. Returns null (no rollback) or trigger info.
 */
export function checkRollbackTriggers() {
  const currentVersion = getActiveVersionNumber();
  if (currentVersion === 1) return null; // Never rollback v1

  const config = getActiveConfig();
  const versionLabel = getVersionLabel();

  // Get trades under current version
  const trades = getTradesForVersion(versionLabel);
  const closedTrades = trades.filter(t => t.closed_at);

  if (closedTrades.length < MIN_TRADES_FOR_ROLLBACK) return null;

  // Get current version row for parent info
  const currentRow = getVersionByNumber(currentVersion);
  if (!currentRow) return null;

  const parentVersion = currentRow.parent_version || 1;
  const parentRow = getVersionByNumber(parentVersion);

  // Get phantom comparisons for this version
  const comparisons = getPhantomComparisonsForVersion(currentVersion);

  // Check each trigger
  const triggers = [
    checkWinRateDrop(closedTrades, parentRow, parentVersion),
    checkAvoidableLosses(closedTrades, comparisons),
    checkAvgPnlDrop(closedTrades, parentRow, parentVersion),
    checkDrawdown(closedTrades),
  ];

  for (const trigger of triggers) {
    if (trigger) {
      // Execute rollback
      const rollbackTarget = parentVersion;
      const success = rollbackTo(rollbackTarget);

      if (success) {
        saveRollbackEvent({
          triggerType: trigger.type,
          fromVersion: currentVersion,
          toVersion: rollbackTarget,
          triggerDetails: trigger.details,
          discordSent: false,
        });

        log.warn(
          `ROLLBACK: ${trigger.type} | v${currentVersion} → v${rollbackTarget} | ` +
          `${trigger.details.reason}`
        );

        return {
          trigger: trigger.type,
          fromVersion: currentVersion,
          toVersion: rollbackTarget,
          details: trigger.details,
        };
      }
    }
  }

  // V1 Floor guarantee check
  const floorRollback = checkV1Floor(closedTrades, currentVersion);
  if (floorRollback) return floorRollback;

  return null;
}

/**
 * Get recent rollback history.
 */
export function getRollbackHistory(limit = 10) {
  return getRecentRollbacks(limit);
}

// ---- Trigger checks ----

/**
 * Trigger 1: Win rate dropped >15 percentage points from parent version.
 */
function checkWinRateDrop(currentTrades, parentRow, parentVersion) {
  if (!parentRow) return null;

  const parentLabel = `v${parentVersion}`;
  const parentTrades = getTradesForVersion(parentLabel).filter(t => t.closed_at);
  if (parentTrades.length < MIN_TRADES_FOR_ROLLBACK) return null;

  const currentWinRate = calcWinRate(currentTrades);
  const parentWinRate = calcWinRate(parentTrades);

  if (parentWinRate - currentWinRate > 15) {
    return {
      type: 'WIN_RATE_DROP',
      details: {
        reason: `Win rate dropped ${parentWinRate.toFixed(1)}% → ${currentWinRate.toFixed(1)}% (${(parentWinRate - currentWinRate).toFixed(1)}pp)`,
        currentWinRate,
        parentWinRate,
        currentTrades: currentTrades.length,
        parentTrades: parentTrades.length,
      },
    };
  }

  return null;
}

/**
 * Trigger 2: 3+ consecutive losses where previous version wouldn't have entered.
 */
function checkAvoidableLosses(currentTrades, comparisons) {
  // Find consecutive losses at the end of the trade list
  const losses = [];
  for (let i = currentTrades.length - 1; i >= 0; i--) {
    if ((currentTrades[i].pnl_dollars || 0) <= 0) {
      losses.push(currentTrades[i]);
    } else {
      break; // Stop at first win
    }
  }

  if (losses.length < 3) return null;

  // Check how many of the consecutive losses the parent version would have avoided
  const compMap = new Map(comparisons.map(c => [c.trade_id, c]));
  let avoidable = 0;
  for (const loss of losses) {
    const comp = compMap.get(loss.id);
    if (comp && !comp.previous_would_enter) {
      avoidable++;
    }
  }

  if (losses.length >= 3 && avoidable >= 2) {
    return {
      type: 'AVOIDABLE_LOSSES',
      details: {
        reason: `${losses.length} consecutive losses, ${avoidable} would have been avoided by previous version`,
        consecutiveLosses: losses.length,
        avoidableLosses: avoidable,
      },
    };
  }

  return null;
}

/**
 * Trigger 3: Average P&L per trade below 70% of parent version's avg.
 */
function checkAvgPnlDrop(currentTrades, parentRow, parentVersion) {
  if (!parentRow) return null;

  const parentLabel = `v${parentVersion}`;
  const parentTrades = getTradesForVersion(parentLabel).filter(t => t.closed_at);
  if (parentTrades.length < MIN_TRADES_FOR_ROLLBACK) return null;

  const currentAvgPnl = calcAvgPnl(currentTrades);
  const parentAvgPnl = calcAvgPnl(parentTrades);

  // Only trigger if parent had positive avg P&L (don't compare two negatives)
  if (parentAvgPnl <= 0) return null;

  if (currentAvgPnl < parentAvgPnl * 0.70) {
    return {
      type: 'AVG_PNL_DROP',
      details: {
        reason: `Avg P&L dropped to ${currentAvgPnl.toFixed(1)}% from ${parentAvgPnl.toFixed(1)}% (below 70% threshold)`,
        currentAvgPnl,
        parentAvgPnl,
        threshold: parentAvgPnl * 0.70,
      },
    };
  }

  return null;
}

/**
 * Trigger 4: Cumulative P&L under current version dropped below -$2000.
 */
function checkDrawdown(currentTrades) {
  const totalPnl = currentTrades.reduce((sum, t) => sum + (t.pnl_dollars || 0), 0);

  if (totalPnl <= -2000) {
    return {
      type: 'DRAWDOWN',
      details: {
        reason: `Total P&L under current version: $${totalPnl.toFixed(0)} (below -$2,000 threshold)`,
        totalPnl,
        tradeCount: currentTrades.length,
      },
    };
  }

  return null;
}

/**
 * V1 Floor guarantee: if any version underperforms v1 after 5+ trades
 * in BOTH win rate AND avg P&L, roll all the way back to v1.
 */
function checkV1Floor(currentTrades, currentVersion) {
  if (currentVersion === 1) return null;

  const v1Trades = getTradesForVersion('v1').filter(t => t.closed_at);
  if (v1Trades.length < MIN_TRADES_FOR_ROLLBACK) return null;

  const currentWinRate = calcWinRate(currentTrades);
  const v1WinRate = calcWinRate(v1Trades);
  const currentAvgPnl = calcAvgPnl(currentTrades);
  const v1AvgPnl = calcAvgPnl(v1Trades);

  // Both metrics must be worse
  if (currentWinRate < v1WinRate && currentAvgPnl < v1AvgPnl) {
    const success = rollbackTo(1);
    if (success) {
      saveRollbackEvent({
        triggerType: 'V1_FLOOR',
        fromVersion: currentVersion,
        toVersion: 1,
        triggerDetails: {
          reason: `Version underperforms v1 baseline: ${currentWinRate.toFixed(1)}% vs ${v1WinRate.toFixed(1)}% win rate, ${currentAvgPnl.toFixed(1)}% vs ${v1AvgPnl.toFixed(1)}% avg P&L`,
          currentWinRate,
          v1WinRate,
          currentAvgPnl,
          v1AvgPnl,
        },
        discordSent: false,
      });

      log.warn(`V1 FLOOR ROLLBACK: v${currentVersion} → v1`);

      return {
        trigger: 'V1_FLOOR',
        fromVersion: currentVersion,
        toVersion: 1,
        details: {
          reason: `Performance floor breached — rolling back to v1 baseline`,
          currentWinRate,
          v1WinRate,
          currentAvgPnl,
          v1AvgPnl,
        },
      };
    }
  }

  return null;
}

// ---- Utility functions ----

function calcWinRate(trades) {
  if (trades.length === 0) return 0;
  const wins = trades.filter(t => (t.pnl_dollars || 0) > 0).length;
  return (wins / trades.length) * 100;
}

function calcAvgPnl(trades) {
  if (trades.length === 0) return 0;
  const totalPct = trades.reduce((sum, t) => sum + (t.pnl_pct || 0), 0);
  return totalPct / trades.length;
}
