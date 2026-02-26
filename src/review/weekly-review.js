/**
 * Weekly Review Agent — Runs Sunday 2 AM ET.
 * Deeper analysis than nightly: 14-day lookback, cross-version analysis,
 * day-of-week patterns. Uses Claude Sonnet for analysis.
 */

import { config } from '../utils/config.js';
import { callSonnet } from '../agent/sonnet-client.js';
import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';
import {
  getTradesByDateRange, getRecentPhantomComparisons, getAllVersions,
  getDecisionsByDate, getGexSnapshotsByDate, getTvSignalLogByDate,
} from '../store/db.js';
import {
  getActiveConfig, getActiveVersionNumber, getVersionLabel,
  createVersion, getFailedAdjustments,
} from './strategy-store.js';

const log = createLogger('WeeklyReview');

const WEEKLY_LOOKBACK_DAYS = 14;

// ---- Weekly Review System Prompt ----

const WEEKLY_SYSTEM_PROMPT = `You are GexClaw's weekly deep-analysis engine — an autonomous 0DTE SPX options trading system. You analyze 14 days of trading data with special focus on weekly patterns, cross-version performance, and day-of-week trends.

## Rules
1. NEVER recommend more than 3 adjustments at once. Small changes, measured results.
2. EVERY adjustment must cite specific data from the analysis provided.
3. NEVER repeat a failed adjustment from the failed_adjustments list.
4. If performance is already good (>65% win rate AND positive avg P&L), suggest 0 changes.
5. If performance is poor, prioritize the dimension with the clearest signal.
6. Consider sample size — don't adjust based on fewer than 5 trades in a category.
7. Think about second-order effects — raising gex_min_score means fewer trades.
8. Changes should be conservative: no more than ~20% shift on any numeric parameter.
9. Only adjust parameters listed in the current_config.
10. Pay special attention to weekly patterns:
    - Day-of-week effects (Monday vs Friday performance)
    - Early-week vs late-week trends
    - If a version was rolled back this week, understand WHY and avoid similar changes
    - Cross-version performance: was version N better than N-1 overall?
11. Look at blocked entries — if many good setups were blocked, entry criteria may be too strict.
12. Analyze exit effectiveness — which exits preserved profits, which let winners turn to losers?
13. Build narrative across weeks — what's the system learning over time?

## Adjustable Parameters (and what they control)
- gex_min_score: Minimum GEX score to consider entry (higher = fewer but better trades)
- gex_strong_score: Score considered "strong" signal (TV confirmation optional above this)
- gex_strong_threshold: GEX score where TV confirmation is optional
- tv_weight_bravo, tv_weight_tango: TV indicator weight multipliers (only 2 TV indicators: Bravo + Tango)
- alignment_min_for_entry: Minimum tickers aligned for entry (out of 3)
- no_entry_after: Time cutoff for new entries (HH:MM format)
- stop_buffer_pct: Stop placement buffer percentage
- profit_target_pct: SPX move % to lock profits
- stop_loss_pct: Adverse SPX move % to cut losses
- trailing_stop_activate_pts: SPX points profit to activate trailing stop
- trailing_stop_distance_pts: Trailing stop distance in SPX points
- tv_against_exit_count: Opposing TV signals needed to trigger exit
- opposing_wall_exit_value: GEX wall value threshold for opposing wall exit
- rr_weight, delta_weight, liquidity_weight, theta_weight: Strike selection weights (must sum to 1.0)
- delta_sweet_spot_low, delta_sweet_spot_high: Target delta range for strike selection
- min_rr_ratio: Minimum risk:reward ratio for entry
- chop_lookback_cycles, chop_flip_threshold, chop_stddev_threshold: Chop detection tuning

## Output Format
Respond with ONLY valid JSON in this format:
{
  "should_adjust": true,
  "analysis_summary": "Weekly deep analysis: 2-3 sentence overview",
  "adjustments": [
    {
      "parameter": "gex_min_score",
      "old_value": 60,
      "new_value": 65,
      "reason": "Over 14 days, trades with GEX 60-65 had 30% win rate vs 75% for 65+.",
      "expected_impact": "Fewer trades but higher win rate"
    }
  ],
  "weekly_patterns": "Notable day-of-week or cross-version patterns observed",
  "market_notes": "Any notable patterns about market conditions this week",
  "morning_briefing_text": "2-3 sentence summary for the dashboard",
  "pattern_analysis": {
    "winning_setups": "What winning trades over 2 weeks had in common",
    "losing_setups": "What losing trades over 2 weeks had in common",
    "blocked_entry_review": "Were blocked entries justified? Patterns in what was filtered out?",
    "exit_effectiveness": "Which exit triggers worked well over 2 weeks, which need tuning?",
    "tv_signal_value": "How much value did TV signals add over 2 weeks?",
    "time_patterns": "Day-of-week and time-of-day patterns worth noting",
    "version_evolution": "How did version changes affect performance? What worked, what didn't?"
  },
  "narrative": {
    "week_story": "Natural language summary of the past 2 weeks — what happened, trends, turning points",
    "evolution": "How is the system evolving? What's improving vs stuck?",
    "cumulative_learnings": "Key learnings from 2 weeks of data. What patterns are solidifying?"
  }
}

If no adjustments are warranted, set should_adjust: false and adjustments: [], but still provide pattern_analysis and narrative.`;

// ---- Public API ----

/**
 * Run the full weekly review process.
 * Returns: { skipped, reason?, changes?, newVersion?, analysis? }
 */
export async function runWeeklyReview() {
  log.info('=== Starting Weekly Review (Sonnet, 14-day deep analysis) ===');

  const activeConfig = getActiveConfig();
  const currentVersion = getActiveVersionNumber();

  // Build weekly analysis data
  const input = buildWeeklyInput();

  // Guard: not enough trades over 14 days
  const totalTrades = input.analysis.overall_metrics.total_trades;
  if (totalTrades < 5) {
    log.info(`Only ${totalTrades} trades over 14 days — skipping weekly review`);
    return { skipped: true, reason: 'insufficient_trades', tradeCount: totalTrades };
  }

  // Guard: no API key
  if (!config.anthropicApiKey) {
    log.warn('Anthropic API key not configured — skipping weekly review');
    return { skipped: true, reason: 'no_api_key' };
  }

  log.info(`Sending weekly data to Sonnet (${totalTrades} trades over 14d, v${currentVersion})...`);

  try {
    const { parsed: result, tokenUsage } = await callSonnet(WEEKLY_SYSTEM_PROMPT, input);

    log.info(
      `Weekly review completed in ${tokenUsage.responseTimeMs}ms | ` +
      `${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | ` +
      `should_adjust: ${result.should_adjust}`
    );

    // Attach input data for Discord report
    result._inputData = input;

    // Propose changes (DO NOT auto-apply — user reviews in Discord and decides)
    if (result.should_adjust && result.adjustments?.length > 0) {
      const maxChanges = activeConfig.max_adjustments_per_review || 3;
      const adjustments = result.adjustments.slice(0, maxChanges);

      const validated = validateChanges(adjustments, activeConfig);

      log.info(`Weekly review proposes ${validated.length} change(s) — awaiting user approval via Discord`);

      return {
        skipped: false,
        changes: validated,
        proposed: true,
        analysis: result,
        tokenUsage,
      };
    }

    log.info(`Weekly review: no changes — ${result.analysis_summary || 'performance satisfactory'}`);
    return {
      skipped: false,
      changes: [],
      analysis: result,
      tokenUsage,
    };

  } catch (err) {
    log.error(`Weekly review error:`, err.message);
    return { skipped: true, reason: `api_error: ${err.message}` };
  }
}

// ---- Weekly-Specific Analysis Builder ----

function buildWeeklyInput() {
  const activeConfig = getActiveConfig();
  const currentVersion = getActiveVersionNumber();
  const versionLabel = getVersionLabel();

  const start = formatET(nowET().minus({ days: WEEKLY_LOOKBACK_DAYS }));
  const end = formatET(nowET());

  const allTrades = getTradesByDateRange(start, end + ' 23:59:59');
  const closedTrades = allTrades.filter(t => t.closed_at);
  const comparisons = getRecentPhantomComparisons(100);
  const failedAdj = getFailedAdjustments();
  const allVersions = getAllVersions();

  // ---- Enrichment data ----
  const todayStr = formatET(nowET()).slice(0, 10);

  // Aggregate blocked entries across lookback period (sample last few days)
  let totalBlocked = 0;
  const blockReasons = {};
  for (let i = 0; i < Math.min(WEEKLY_LOOKBACK_DAYS, 5); i++) {
    const dayStr = formatET(nowET().minus({ days: i })).slice(0, 10);
    const decisions = getDecisionsByDate(dayStr);
    for (const d of decisions) {
      try {
        const p = JSON.parse(d.decision_json || '{}');
        if (p.entryBlocked) {
          totalBlocked++;
          const r = p.blockReason || p.reason || 'unknown';
          blockReasons[r] = (blockReasons[r] || 0) + 1;
        }
      } catch { /* skip */ }
    }
  }

  // GEX score distribution (today only for freshness)
  const gexSnapshots = getGexSnapshotsByDate(todayStr);
  const gexScores = gexSnapshots.map(s => {
    try { return JSON.parse(s.snapshot_json || '{}').score || 0; } catch { return 0; }
  }).filter(s => s > 0);

  return {
    review_type: 'WEEKLY',
    current_version: currentVersion,
    version_label: versionLabel,
    current_config: activeConfig,
    days_analyzed: WEEKLY_LOOKBACK_DAYS,
    failed_adjustments: failedAdj,
    analysis: {
      overall_metrics: buildMetrics(closedTrades),
      day_of_week_performance: analyzeByDayOfWeek(closedTrades),
      cross_version_performance: analyzeCrossVersion(closedTrades, allVersions),
      gex_score_performance: analyzeByGexRange(closedTrades),
      tv_indicator_effectiveness: analyzeByTvIndicator(closedTrades),
      time_of_day_performance: analyzeByTimeOfDay(closedTrades),
      direction_performance: analyzeByDirection(closedTrades),
      exit_reason_distribution: analyzeByExitReason(closedTrades),
      phantom_comparison_summary: summarizeComparisons(comparisons),
      version_history_summary: summarizeVersionHistory(allVersions),
    },
    enrichment: {
      blocked_entries_summary: {
        total_blocked: totalBlocked,
        top_block_reasons: Object.entries(blockReasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => ({ reason, count })),
      },
      gex_score_distribution: {
        count: gexScores.length,
        avg: gexScores.length > 0 ? +(gexScores.reduce((a, b) => a + b, 0) / gexScores.length).toFixed(1) : 0,
        min: gexScores.length > 0 ? Math.min(...gexScores) : 0,
        max: gexScores.length > 0 ? Math.max(...gexScores) : 0,
      },
    },
  };
}

// ---- Analysis Functions ----

function buildMetrics(trades) {
  const wins = trades.filter(t => (t.pnl_dollars || 0) > 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
  const avgPnlPct = trades.length > 0
    ? trades.reduce((s, t) => s + (t.pnl_pct || 0), 0) / trades.length
    : 0;

  return {
    total_trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    win_rate: trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0',
    total_pnl_dollars: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 10) / 10,
  };
}

function analyzeByDayOfWeek(trades) {
  const days = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const t of trades) {
    if (!t.opened_at) continue;
    const date = new Date(t.opened_at);
    const dayName = dayNames[date.getDay()];
    if (days[dayName]) days[dayName].push(t);
  }

  const result = {};
  for (const [day, group] of Object.entries(days)) {
    const wins = group.filter(t => (t.pnl_dollars || 0) > 0).length;
    const avgPnl = group.length > 0
      ? group.reduce((s, t) => s + (t.pnl_pct || 0), 0) / group.length
      : 0;
    result[day] = {
      trades: group.length,
      wins,
      win_rate: group.length > 0 ? ((wins / group.length) * 100).toFixed(1) : '0',
      avg_pnl_pct: avgPnl.toFixed(1),
    };
  }

  return result;
}

function analyzeCrossVersion(trades, allVersions) {
  const result = {};

  for (const v of allVersions) {
    const vTrades = trades.filter(t => t.strategy_version === `v${v.version}`);
    if (vTrades.length === 0) continue;

    const wins = vTrades.filter(t => (t.pnl_dollars || 0) > 0).length;
    result[`v${v.version}`] = {
      trades: vTrades.length,
      wins,
      losses: vTrades.length - wins,
      win_rate: ((wins / vTrades.length) * 100).toFixed(1),
      total_pnl: vTrades.reduce((s, t) => s + (t.pnl_dollars || 0), 0).toFixed(0),
      source: v.source,
      is_active: v.is_active,
    };
  }

  return result;
}

function analyzeByGexRange(trades) {
  const ranges = { '60-70': [], '70-80': [], '80-90': [], '90+': [] };

  for (const t of trades) {
    const gex = safeParseJson(t.gex_state_at_entry);
    const score = gex.score || 0;
    if (score >= 90) ranges['90+'].push(t);
    else if (score >= 80) ranges['80-90'].push(t);
    else if (score >= 70) ranges['70-80'].push(t);
    else ranges['60-70'].push(t);
  }

  const result = {};
  for (const [range, group] of Object.entries(ranges)) {
    const wins = group.filter(t => (t.pnl_dollars || 0) > 0).length;
    result[range] = {
      trades: group.length,
      wins,
      win_rate: group.length > 0 ? ((wins / group.length) * 100).toFixed(1) : '0',
    };
  }

  return result;
}

function analyzeByTvIndicator(trades) {
  const indicators = ['bravo', 'tango'];
  const result = {};

  for (const ind of indicators) {
    let withWins = 0, withLosses = 0, withoutWins = 0, withoutLosses = 0;

    for (const t of trades) {
      const tv = safeParseJson(t.tv_state_at_entry);
      const state = tv[ind];
      const hasSignal = state && state !== 'NEUTRAL' && state !== 'FLAT' && state !== 'UNKNOWN' && state !== 'NONE';
      const isWin = (t.pnl_dollars || 0) > 0;

      if (hasSignal) { isWin ? withWins++ : withLosses++; }
      else { isWin ? withoutWins++ : withoutLosses++; }
    }

    const withTotal = withWins + withLosses;
    result[ind] = {
      with_signal_trades: withTotal,
      with_signal_win_rate: withTotal > 0 ? ((withWins / withTotal) * 100).toFixed(1) : '0',
    };
  }

  return result;
}

function analyzeByTimeOfDay(trades) {
  const hours = {};
  for (const t of trades) {
    const hour = parseInt(t.opened_at?.split(' ')[1]?.split(':')[0] || '0');
    const label = `${hour}:00-${hour + 1}:00`;
    if (!hours[label]) hours[label] = [];
    hours[label].push(t);
  }

  const result = {};
  for (const [label, group] of Object.entries(hours)) {
    const wins = group.filter(t => (t.pnl_dollars || 0) > 0).length;
    result[label] = {
      trades: group.length,
      win_rate: group.length > 0 ? ((wins / group.length) * 100).toFixed(1) : '0',
    };
  }
  return result;
}

function analyzeByDirection(trades) {
  const bullish = trades.filter(t => t.direction === 'BULLISH');
  const bearish = trades.filter(t => t.direction === 'BEARISH');
  const bWins = bullish.filter(t => (t.pnl_dollars || 0) > 0).length;
  const sWins = bearish.filter(t => (t.pnl_dollars || 0) > 0).length;

  return {
    BULLISH: { trades: bullish.length, wins: bWins, win_rate: bullish.length > 0 ? ((bWins / bullish.length) * 100).toFixed(1) : '0' },
    BEARISH: { trades: bearish.length, wins: sWins, win_rate: bearish.length > 0 ? ((sWins / bearish.length) * 100).toFixed(1) : '0' },
  };
}

function analyzeByExitReason(trades) {
  const reasons = {};
  for (const t of trades) {
    const reason = t.exit_reason || 'UNKNOWN';
    if (!reasons[reason]) reasons[reason] = { count: 0, wins: 0, losses: 0 };
    reasons[reason].count++;
    if ((t.pnl_dollars || 0) > 0) reasons[reason].wins++;
    else reasons[reason].losses++;
  }
  return reasons;
}

function summarizeComparisons(comparisons) {
  const summary = { total: comparisons.length, current_better: 0, previous_better: 0, same: 0 };
  for (const c of comparisons) {
    if (c.assessment === 'CURRENT_BETTER') summary.current_better++;
    else if (c.assessment === 'PREVIOUS_BETTER') summary.previous_better++;
    else summary.same++;
  }
  return summary;
}

function summarizeVersionHistory(allVersions) {
  return allVersions.slice(0, 10).map(v => ({
    version: v.version,
    source: v.source,
    is_active: v.is_active,
    created_at: v.created_at,
    changes: JSON.parse(v.change_summary || '[]').length,
  }));
}

// ---- Validation (same as nightly) ----

function validateChanges(changes, currentConfig) {
  const failedAdj = getFailedAdjustments();
  const failedParams = new Set(failedAdj.map(f => f.parameter));

  return changes.filter(change => {
    const param = change.parameter;
    const oldVal = currentConfig[param];

    if (oldVal === undefined) {
      log.warn(`Weekly review suggested unknown param: ${param} — skipping`);
      return false;
    }

    if (failedParams.has(param)) {
      log.warn(`Weekly review suggested previously-failed param: ${param} — skipping`);
      return false;
    }

    if (typeof oldVal === 'number' && typeof change.new_value === 'number') {
      const maxDelta = Math.max(Math.abs(oldVal) * 0.20, 1);
      if (Math.abs(change.new_value - oldVal) > maxDelta) {
        const clamped = oldVal + Math.sign(change.new_value - oldVal) * maxDelta;
        log.warn(`Clamping ${param}: ${oldVal} → ${change.new_value} clamped to ${clamped.toFixed(2)}`);
        change.new_value = Math.round(clamped * 100) / 100;
      }
    }

    change.old_value = oldVal;
    return true;
  });
}

function safeParseJson(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}
