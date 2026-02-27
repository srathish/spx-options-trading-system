/**
 * Nightly Review Agent — 2 AM ET daily self-improvement cycle.
 * Calls Claude Sonnet with 10-dimension analysis + enriched data,
 * generates strategy adjustments, creates new version if warranted.
 */

import { config } from '../utils/config.js';
import { callSonnet } from '../agent/sonnet-client.js';
import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';
import {
  getTradesByDateRange, getTradesForVersion,
  getRecentPhantomComparisons, getRecentClosedTrades,
  getDecisionsByDate, getGexSnapshotsByDate, getTvSignalLogByDate,
  getAllVersions, getTradesByLane, getPatternPerformance,
} from '../store/db.js';
import {
  getActiveConfig, getActiveVersionNumber, getVersionLabel,
  createVersion, isLearningPeriod, getFailedAdjustments,
} from './strategy-store.js';

const log = createLogger('Review');

// ---- Review System Prompt ----

const REVIEW_SYSTEM_PROMPT = `You are GexClaw's self-improvement engine — an autonomous 0DTE SPX options trading system. You analyze daily trading performance data and recommend specific, data-backed strategy adjustments.

## Your Role
You receive a comprehensive data package each night containing:
- 10-dimension trade analysis (GEX scores, alignment, TV signals, time-of-day, direction, exits, strikes, phantoms)
- Enrichment data (blocked entries, GEX score distribution, TV signal transitions, previous review findings, lane comparison)
- Current strategy config with 38+ tunable parameters

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
10. Look at blocked entries — if many good setups were blocked, entry criteria may be too strict.
11. Analyze exit effectiveness — if most profits come from one exit type, others may need tuning.
12. Build on previous review findings when available — create a narrative over time.

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
- pattern_min_wall_pct: Minimum wall size for pattern detection (% of largest wall)
- pattern_king_node_max_touches: Max touches for fresh king node bounce
- pattern_pika_max_dist_pct: Max distance to floor for pika pillow pattern
- pattern_air_pocket_min_quality: Minimum air pocket quality (HIGH, MEDIUM, LOW)
- pattern_range_fade_max_touches: Max gatekeeper touches for range edge fade
- lane_b_min_tv_weight: Minimum TV weighted score for Lane B entry
- lane_b_min_tv_indicators: Minimum TV indicators confirming direction for Lane B

### Algorithmic Entry Engine
- gex_only_min_score: Minimum GEX score for algorithmic pattern entry (Lane A)
- alignment_override_gex_score: GEX score that overrides alignment requirement
- power_hour_min_gex_score: Minimum GEX score for entries during power hour

### Entry Quality Gates
- entry_min_spacing_ms: Minimum milliseconds between ANY entries
- entry_blackout_start, entry_blackout_end: No-entry blackout period (e.g., 09:30-09:33)
- consecutive_loss_limit: Same-direction losses before cooldown triggers
- consecutive_loss_cooldown_ms: Cooldown duration after loss streak

### NODE_SUPPORT_BREAK Exit
- node_break_buffer_pts: SPX points buffer before triggering node support break exit

### MOMENTUM_TIMEOUT Exit (3 phases)
- momentum_phase1_minutes, momentum_phase1_min_pts: Phase 1 stall detection (min progress after N minutes)
- momentum_phase2_minutes, momentum_phase2_target_pct: Phase 2 (min % of target distance after N minutes)
- momentum_phase3_minutes: Phase 3 (must be net positive after N minutes)

### TV_COUNTER_FLIP Exit
- tv_counter_flip_enabled: Whether Bravo+Tango counter-flip exit is active
- tv_counter_flip_min_indicators: Min indicators flipping against position to trigger exit

### Pattern-Specific
- rug_pull_min_value, pika_pillow_min_value, king_node_min_value: Minimum GEX wall values for pattern detection

## Output Format
Respond with ONLY valid JSON in this exact format:
{
  "should_adjust": true,
  "analysis_summary": "Brief 2-3 sentence overview of findings",
  "adjustments": [
    {
      "parameter": "gex_min_score",
      "old_value": 60,
      "new_value": 65,
      "reason": "Trades with GEX score 60-65 had 33% win rate vs 78% for 65+. Raising minimum filters weak setups.",
      "expected_impact": "Fewer trades but higher win rate"
    }
  ],
  "market_notes": "Any notable patterns about market conditions",
  "morning_briefing_text": "2-3 sentence summary for the dashboard",
  "pattern_analysis": {
    "winning_setups": "Description of what winning trades had in common",
    "losing_setups": "Description of what losing trades had in common",
    "blocked_entry_review": "Were blocked entries justified? Any good setups filtered out?",
    "exit_effectiveness": "Which exit triggers worked well, which need tuning?",
    "tv_signal_value": "How much value did TV signals add to entry/exit decisions?",
    "time_patterns": "Any time-of-day patterns worth noting?",
    "lane_comparison": "Compare Lane A (GEX-only live) vs Lane B (GEX+TV phantom). Which produced better results? Should TV requirement be added or relaxed?",
    "trigger_analysis": "Which GEX patterns (entry triggers) performed best? Any patterns to avoid?"
  },
  "narrative": {
    "today_story": "Natural language summary of the trading day — what happened, key moments, overall character of the day",
    "comparison_to_previous": "How does today compare to the last review? Are we improving?",
    "cumulative_learnings": "What is the system learning over time? What patterns are emerging across multiple days?"
  }
}

If no adjustments are warranted, set should_adjust: false and adjustments: [], but still provide pattern_analysis and narrative.`;

// ---- Public API ----

/**
 * Run the full nightly review process.
 * Returns: { skipped, reason?, changes?, newVersion?, analysis? }
 */
export async function runNightlyReview() {
  log.info('=== Starting Nightly Review (Sonnet) ===');

  const activeConfig = getActiveConfig();
  const currentVersion = getActiveVersionNumber();

  // Guard: learning period
  if (isLearningPeriod()) {
    log.info('Learning period active — skipping review (collecting baseline data)');
    return { skipped: true, reason: 'learning_period' };
  }

  // Build analysis data
  const input = buildReviewInput();

  // Guard: not enough trades
  const totalTrades = input.analysis.overall_metrics.total_trades;
  const minTrades = activeConfig.min_trades_for_adjustment || 5;
  if (totalTrades < minTrades) {
    log.info(`Only ${totalTrades} trades (need ${minTrades}) — skipping review`);
    return { skipped: true, reason: 'insufficient_trades', tradeCount: totalTrades };
  }

  // Guard: no Anthropic API key
  if (!config.anthropicApiKey) {
    log.warn('Anthropic API key not configured — skipping review');
    return { skipped: true, reason: 'no_api_key' };
  }

  // Call Claude Sonnet
  log.info(`Sending review data to Sonnet (${totalTrades} trades, v${currentVersion})...`);

  try {
    const { parsed: result, tokenUsage } = await callSonnet(REVIEW_SYSTEM_PROMPT, input);

    log.info(
      `Review completed in ${tokenUsage.responseTimeMs}ms | ` +
      `${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | ` +
      `should_adjust: ${result.should_adjust}`
    );

    // Attach input data for Discord report
    result._inputData = input;

    // Propose changes (DO NOT auto-apply — user reviews in Discord and decides)
    if (result.should_adjust && result.adjustments?.length > 0) {
      const maxChanges = activeConfig.max_adjustments_per_review || 3;
      const adjustments = result.adjustments.slice(0, maxChanges);

      // Validate and clamp changes (for the proposal)
      const validated = validateChanges(adjustments, activeConfig);

      log.info(`Review proposes ${validated.length} change(s) — awaiting user approval via Discord`);

      return {
        skipped: false,
        changes: validated,
        proposed: true, // Flag: changes are proposed, not applied
        analysis: result,
        tokenUsage,
      };
    }

    log.info(`Review: no changes — ${result.analysis_summary || 'performance satisfactory'}`);
    return {
      skipped: false,
      changes: [],
      analysis: result,
      tokenUsage,
    };

  } catch (err) {
    log.error(`Review agent error:`, err.message);
    return { skipped: true, reason: `api_error: ${err.message}` };
  }
}

/**
 * Build the structured input for the review agent.
 * Includes 10-dimension analysis + enrichment data from DB.
 */
export function buildReviewInput() {
  const activeConfig = getActiveConfig();
  const currentVersion = getActiveVersionNumber();
  const versionLabel = getVersionLabel();
  const lookbackDays = activeConfig.learning_period_days || 7;

  const start = formatET(nowET().minus({ days: lookbackDays }));
  const end = formatET(nowET());

  // Get all closed non-phantom trades in the lookback window
  const allTrades = getTradesByDateRange(start, end + ' 23:59:59');
  const closedTrades = allTrades.filter(t => t.closed_at);

  // Get trades specifically under current version
  const versionTrades = getTradesForVersion(versionLabel).filter(t => t.closed_at);

  // Get phantom comparisons
  const comparisons = getRecentPhantomComparisons(50);

  // Get failed adjustments
  const failedAdj = getFailedAdjustments();

  // ---- Enrichment data ----

  // Blocked entries from today's decisions
  const todayStr = formatET(nowET()).slice(0, 10);
  const recentDecisions = getDecisionsByDate(todayStr);
  const blockedEntries = recentDecisions
    .filter(d => {
      try { const p = JSON.parse(d.decision_json || '{}'); return p.entryBlocked; } catch { return false; }
    })
    .map(d => {
      try { return JSON.parse(d.decision_json || '{}'); } catch { return {}; }
    });

  // GEX score distribution today
  const gexSnapshots = getGexSnapshotsByDate(todayStr);
  const gexScores = gexSnapshots.map(s => {
    try { return JSON.parse(s.snapshot_json || '{}').score || 0; } catch { return 0; }
  }).filter(s => s > 0);

  // TV signal transitions today
  const tvSignalLog = getTvSignalLogByDate(todayStr);

  // Previous review findings (narrative continuity)
  const allVersions = getAllVersions();
  const previousReview = allVersions.length > 1 ? allVersions[allVersions.length - 1] : null;

  return {
    current_version: currentVersion,
    version_label: versionLabel,
    current_config: activeConfig,
    days_analyzed: lookbackDays,
    failed_adjustments: failedAdj,
    analysis: {
      overall_metrics: buildOverallMetrics(closedTrades),
      gex_score_performance: analyzeByGexRange(closedTrades),
      multi_ticker_alignment: analyzeByAlignment(closedTrades),
      tv_indicator_effectiveness: analyzeByTvIndicator(closedTrades),
      confirmation_mode_performance: analyzeByConfirmations(closedTrades),
      time_of_day_performance: analyzeByTimeOfDay(closedTrades),
      direction_performance: analyzeByDirection(closedTrades),
      exit_reason_distribution: analyzeByExitReason(closedTrades),
      strike_performance: analyzeStrikeEffectiveness(closedTrades),
      phantom_comparison_summary: summarizeComparisons(comparisons),
      version_performance: buildVersionMetrics(versionTrades),
    },
    enrichment: {
      blocked_entries_summary: {
        total_blocked: blockedEntries.length,
        top_block_reasons: summarizeBlockReasons(blockedEntries),
      },
      gex_score_distribution: {
        count: gexScores.length,
        avg: gexScores.length > 0 ? +(gexScores.reduce((a, b) => a + b, 0) / gexScores.length).toFixed(1) : 0,
        min: gexScores.length > 0 ? Math.min(...gexScores) : 0,
        max: gexScores.length > 0 ? Math.max(...gexScores) : 0,
      },
      tv_signal_transitions: tvSignalLog.length,
      previous_review: previousReview ? {
        version: previousReview.version,
        changes: safeParseJson(previousReview.changes_json),
        analysis: safeParseJson(previousReview.analysis_json)?.analysis_summary,
      } : null,
      lane_comparison: buildLaneComparison(todayStr),
      trigger_effectiveness: buildTriggerEffectiveness(todayStr),
      pattern_performance_7d: getPatternPerformance(7),
    },
  };
}

// ---- 10-Dimension Analysis Functions ----

function buildOverallMetrics(trades) {
  const wins = trades.filter(t => (t.pnl_dollars || 0) > 0);
  const losses = trades.filter(t => (t.pnl_dollars || 0) <= 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
  const avgPnlPct = trades.length > 0
    ? trades.reduce((s, t) => s + (t.pnl_pct || 0), 0) / trades.length
    : 0;

  return {
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0',
    total_pnl_dollars: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 10) / 10,
    best_trade_pnl_pct: trades.length > 0 ? Math.max(...trades.map(t => t.pnl_pct || 0)) : 0,
    worst_trade_pnl_pct: trades.length > 0 ? Math.min(...trades.map(t => t.pnl_pct || 0)) : 0,
  };
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
      losses: group.length - wins,
      win_rate: group.length > 0 ? ((wins / group.length) * 100).toFixed(1) : '0',
      avg_pnl_pct: group.length > 0
        ? (group.reduce((s, t) => s + (t.pnl_pct || 0), 0) / group.length).toFixed(1)
        : '0',
    };
  }

  return result;
}

function analyzeByAlignment(trades) {
  const buckets = { '0': [], '1': [], '2': [], '3': [] };

  for (const t of trades) {
    const gex = safeParseJson(t.gex_state_at_entry);
    const alignment = gex.alignment_count ?? gex.alignmentCount ?? 0;
    const key = String(Math.min(alignment, 3));
    buckets[key].push(t);
  }

  const result = {};
  for (const [count, group] of Object.entries(buckets)) {
    const wins = group.filter(t => (t.pnl_dollars || 0) > 0).length;
    result[`${count}/3`] = {
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
    let withSignal = { wins: 0, losses: 0 };
    let withoutSignal = { wins: 0, losses: 0 };

    for (const t of trades) {
      const tv = safeParseJson(t.tv_state_at_entry);
      const state = tv[ind];
      const hasSignal = state && state !== 'NEUTRAL' && state !== 'FLAT' && state !== 'UNKNOWN' && state !== 'NONE';
      const isWin = (t.pnl_dollars || 0) > 0;

      if (hasSignal) {
        isWin ? withSignal.wins++ : withSignal.losses++;
      } else {
        isWin ? withoutSignal.wins++ : withoutSignal.losses++;
      }
    }

    const withTotal = withSignal.wins + withSignal.losses;
    const withoutTotal = withoutSignal.wins + withoutSignal.losses;

    result[ind] = {
      with_signal: {
        trades: withTotal,
        win_rate: withTotal > 0 ? ((withSignal.wins / withTotal) * 100).toFixed(1) : '0',
      },
      without_signal: {
        trades: withoutTotal,
        win_rate: withoutTotal > 0 ? ((withoutSignal.wins / withoutTotal) * 100).toFixed(1) : '0',
      },
    };
  }

  return result;
}

function analyzeByConfirmations(trades) {
  const buckets = { '0/2': [], '1/2': [], '2/2': [] };

  for (const t of trades) {
    const tv = safeParseJson(t.tv_state_at_entry);
    const bullish = tv.confirmations?.bullish || 0;
    const bearish = tv.confirmations?.bearish || 0;
    const confirmations = Math.min(Math.max(bullish, bearish), 2);
    if (confirmations >= 2) buckets['2/2'].push(t);
    else if (confirmations >= 1) buckets['1/2'].push(t);
    else buckets['0/2'].push(t);
  }

  const result = {};
  for (const [mode, group] of Object.entries(buckets)) {
    const wins = group.filter(t => (t.pnl_dollars || 0) > 0).length;
    result[mode] = {
      trades: group.length,
      wins,
      win_rate: group.length > 0 ? ((wins / group.length) * 100).toFixed(1) : '0',
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
      wins,
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
    BULLISH: {
      trades: bullish.length,
      wins: bWins,
      win_rate: bullish.length > 0 ? ((bWins / bullish.length) * 100).toFixed(1) : '0',
    },
    BEARISH: {
      trades: bearish.length,
      wins: sWins,
      win_rate: bearish.length > 0 ? ((sWins / bearish.length) * 100).toFixed(1) : '0',
    },
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

function analyzeStrikeEffectiveness(trades) {
  let totalRrPlanned = 0;
  let totalRrActual = 0;
  let count = 0;

  for (const t of trades) {
    if (t.target_price && t.stop_price && t.entry_price) {
      const plannedRr = Math.abs(t.target_price - t.entry_price) / Math.abs(t.entry_price - t.stop_price);
      const actualPnl = t.pnl_pct || 0;
      totalRrPlanned += plannedRr;
      totalRrActual += actualPnl > 0 ? plannedRr : 0;
      count++;
    }
  }

  return {
    trades_with_targets: count,
    avg_planned_rr: count > 0 ? (totalRrPlanned / count).toFixed(2) : '0',
    target_hit_rate: trades.length > 0
      ? ((trades.filter(t => t.exit_reason === 'TARGET_HIT').length / trades.length) * 100).toFixed(1)
      : '0',
    stop_hit_rate: trades.length > 0
      ? ((trades.filter(t => t.exit_reason === 'STOP_HIT').length / trades.length) * 100).toFixed(1)
      : '0',
  };
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

function buildVersionMetrics(versionTrades) {
  if (versionTrades.length === 0) return { trades: 0 };
  const wins = versionTrades.filter(t => (t.pnl_dollars || 0) > 0).length;
  return {
    trades: versionTrades.length,
    wins,
    losses: versionTrades.length - wins,
    win_rate: ((wins / versionTrades.length) * 100).toFixed(1),
    total_pnl: versionTrades.reduce((s, t) => s + (t.pnl_dollars || 0), 0).toFixed(0),
  };
}

// ---- Enrichment helpers ----

function summarizeBlockReasons(blocked) {
  const reasons = {};
  for (const b of blocked) {
    const r = b.blockReason || b.reason || 'unknown';
    reasons[r] = (reasons[r] || 0) + 1;
  }
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function buildLaneComparison(dateStr) {
  const laneATrades = getTradesByLane('A', dateStr);
  const laneBTrades = getTradesByLane('B', dateStr);

  function countTriggers(trades) {
    const triggers = {};
    for (const t of trades) {
      const trigger = t.entry_trigger || 'unknown';
      triggers[trigger] = (triggers[trigger] || 0) + 1;
    }
    return triggers;
  }

  function laneMetrics(trades) {
    const closed = trades.filter(t => t.closed_at);
    return {
      count: trades.length,
      closed: closed.length,
      wins: closed.filter(t => (t.pnl_dollars || 0) > 0).length,
      losses: closed.filter(t => (t.pnl_dollars || 0) <= 0).length,
      total_pnl: Math.round(closed.reduce((s, t) => s + (t.pnl_dollars || 0), 0) * 100) / 100,
      triggers: countTriggers(trades),
    };
  }

  return {
    lane_a: laneMetrics(laneATrades),
    lane_b: laneMetrics(laneBTrades),
  };
}

/**
 * Build trigger effectiveness: win rate by entry_trigger pattern.
 * Combines both lanes for overall trigger performance.
 */
function buildTriggerEffectiveness(dateStr) {
  const laneATrades = getTradesByLane('A', dateStr);
  const laneBTrades = getTradesByLane('B', dateStr);
  const allTrades = [...laneATrades, ...laneBTrades];

  const triggers = {};
  for (const t of allTrades) {
    const trigger = t.entry_trigger || 'unknown';
    if (!triggers[trigger]) {
      triggers[trigger] = { total: 0, closed: 0, wins: 0, losses: 0, total_pnl: 0 };
    }
    triggers[trigger].total++;
    if (t.closed_at) {
      triggers[trigger].closed++;
      const pnl = t.pnl_dollars || 0;
      triggers[trigger].total_pnl = Math.round((triggers[trigger].total_pnl + pnl) * 100) / 100;
      if (pnl > 0) triggers[trigger].wins++;
      else triggers[trigger].losses++;
    }
  }

  // Convert to array with win rate
  return Object.entries(triggers).map(([trigger, stats]) => ({
    trigger,
    ...stats,
    win_rate: stats.closed > 0 ? Math.round((stats.wins / stats.closed) * 1000) / 10 : null,
    avg_pnl: stats.closed > 0 ? Math.round((stats.total_pnl / stats.closed) * 100) / 100 : null,
  })).sort((a, b) => (b.closed || 0) - (a.closed || 0));
}

// ---- Validation ----

/**
 * Validate changes: enforce 20% max change per numeric param,
 * check param exists, filter out failed adjustments.
 */
function validateChanges(changes, currentConfig) {
  const failedAdj = getFailedAdjustments();
  const failedParams = new Set(failedAdj.map(f => f.parameter));

  return changes.filter(change => {
    const param = change.parameter;
    const oldVal = currentConfig[param];

    // Param must exist in config
    if (oldVal === undefined) {
      log.warn(`Review suggested unknown param: ${param} — skipping`);
      return false;
    }

    // Don't repeat failed adjustments
    if (failedParams.has(param)) {
      log.warn(`Review suggested previously-failed param: ${param} — skipping`);
      return false;
    }

    // 20% max change for numeric params
    if (typeof oldVal === 'number' && typeof change.new_value === 'number') {
      const maxDelta = Math.max(Math.abs(oldVal) * 0.20, 1); // At least ±1 for small values
      if (Math.abs(change.new_value - oldVal) > maxDelta) {
        const clamped = oldVal + Math.sign(change.new_value - oldVal) * maxDelta;
        log.warn(`Clamping ${param}: ${oldVal} → ${change.new_value} clamped to ${clamped.toFixed(2)}`);
        change.new_value = Math.round(clamped * 100) / 100;
      }
    }

    // Ensure old_value matches actual
    change.old_value = oldVal;

    return true;
  });
}

// ---- Utilities ----

function safeParseJson(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}
