/**
 * Morning Briefing Generator — Creates daily briefing after nightly/weekly review.
 * Summarizes yesterday's performance, overnight strategy changes, and active config.
 */

import {
  saveMorningBriefing, getMorningBriefing, getLatestBriefing,
  getRecentClosedTrades, getRecentRollbacks,
} from '../store/db.js';
import {
  getActiveVersionNumber, getActiveConfig, getVersionLabel,
} from './strategy-store.js';
import { nowET, formatET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Briefing');

/**
 * Generate and save a morning briefing after a review completes.
 * @param {Object} reviewResult — Output from runNightlyReview() or runWeeklyReview()
 * @returns {Object} The saved briefing object
 */
export function generateMorningBriefing(reviewResult) {
  const today = formatET(nowET()).split(' ')[0]; // YYYY-MM-DD
  const version = getActiveVersionNumber();
  const versionLabel = getVersionLabel();

  // Build yesterday's performance summary
  const recentTrades = getRecentClosedTrades(50);
  const yesterday = formatET(nowET().minus({ days: 1 })).split(' ')[0];
  const yesterdayTrades = recentTrades.filter(t =>
    t.closed_at && t.closed_at.startsWith(yesterday)
  );

  const wins = yesterdayTrades.filter(t => (t.pnl_dollars || 0) > 0);
  const losses = yesterdayTrades.filter(t => (t.pnl_dollars || 0) <= 0);
  const totalPnl = yesterdayTrades.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
  const bestTrade = yesterdayTrades.length > 0
    ? Math.max(...yesterdayTrades.map(t => t.pnl_pct || 0))
    : 0;
  const worstTrade = yesterdayTrades.length > 0
    ? Math.min(...yesterdayTrades.map(t => t.pnl_pct || 0))
    : 0;

  const performanceSummary = {
    date: yesterday,
    trades: yesterdayTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: yesterdayTrades.length > 0
      ? ((wins.length / yesterdayTrades.length) * 100).toFixed(1)
      : '0',
    totalPnlDollars: Math.round(totalPnl * 100) / 100,
    bestTradePct: bestTrade.toFixed(1),
    worstTradePct: worstTrade.toFixed(1),
  };

  // Build changes list
  const changes = [];
  if (reviewResult && !reviewResult.skipped && reviewResult.changes?.length > 0) {
    for (const c of reviewResult.changes) {
      changes.push({
        param: c.parameter,
        old: c.old_value,
        new: c.new_value,
        reason: c.reason,
      });
    }
  }

  // Check for recent rollbacks
  const recentRollbacks = getRecentRollbacks(5);
  const todayRollbacks = recentRollbacks.filter(r =>
    r.timestamp && r.timestamp.startsWith(today)
  );

  // Build briefing text
  let briefingText = '';

  if (reviewResult?.skipped) {
    briefingText = `Review skipped: ${reviewResult.reason}. ` +
      `Strategy ${versionLabel} remains active.`;
  } else if (changes.length > 0) {
    const changeLines = changes.map(c =>
      `${c.param}: ${c.old} → ${c.new} (${c.reason})`
    ).join('\n');
    briefingText = `Strategy updated to v${version} with ${changes.length} change(s):\n${changeLines}`;
  } else {
    briefingText = reviewResult?.analysis?.morning_briefing_text ||
      `No changes overnight. Strategy ${versionLabel} performing within expectations.`;
  }

  if (todayRollbacks.length > 0) {
    const rb = todayRollbacks[0];
    briefingText += `\n⚠ Rollback triggered: v${rb.from_version} → v${rb.to_version} (${rb.trigger_type})`;
  }

  // Build the full briefing object
  const briefing = {
    version,
    date: today,
    performance: performanceSummary,
    changes,
    noChangeReason: changes.length === 0 ? (reviewResult?.reason || 'performance_satisfactory') : null,
    analysisSummary: reviewResult?.analysis?.analysis_summary || null,
    reviewSkipped: reviewResult?.skipped || false,
    briefingText,
  };

  // Save to database
  saveMorningBriefing({
    date: today,
    version,
    briefing: briefingText,
    changes: JSON.stringify(changes),
    performanceSummary: JSON.stringify(performanceSummary),
  });

  log.info(`Morning briefing saved for ${today} (v${version}, ${changes.length} changes)`);

  return briefing;
}

/**
 * Get today's briefing.
 */
export function getTodaysBriefing() {
  const today = formatET(nowET()).split(' ')[0];
  const row = getMorningBriefing(today);
  if (!row) return null;

  return {
    ...row,
    changes: safeParseJson(row.changes),
    performance_summary: safeParseJson(row.performance_summary),
  };
}

/**
 * Get the most recent briefing.
 */
export function getLatestBriefingData() {
  const row = getLatestBriefing();
  if (!row) return null;

  return {
    ...row,
    changes: safeParseJson(row.changes),
    performance_summary: safeParseJson(row.performance_summary),
  };
}

function safeParseJson(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}
