/**
 * Nightly Review Agent — 2 AM ET daily self-improvement cycle.
 * Calls Kimi K2.5 with 10-dimension analysis of recent trades,
 * generates strategy adjustments, creates new version if warranted.
 */

import OpenAI from 'openai';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';
import {
  getTradesByDateRange, getTradesForVersion,
  getRecentPhantomComparisons, getRecentClosedTrades,
} from '../store/db.js';
import {
  getActiveConfig, getActiveVersionNumber, getVersionLabel,
  createVersion, isLearningPeriod, getFailedAdjustments,
} from './strategy-store.js';

const log = createLogger('Review');

// ---- Review System Prompt ----

const REVIEW_SYSTEM_PROMPT = `You are OpenClaw's self-improvement engine. You analyze trading performance data and recommend specific, data-backed strategy adjustments.

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

## Adjustable Parameters (and what they control)
- gex_min_score: Minimum GEX score to consider entry (higher = fewer but better trades)
- gex_strong_score: Score considered "strong" signal
- min_confirmations: Minimum TV indicator confirmations for entry (out of 7)
- require_diamond: Whether at least one diamond signal (echo/bravo/tango) is required
- helix_flat_override: Whether flat helix blocks ALL entries
- tv_weight_echo, tv_weight_bravo, tv_weight_tango, tv_weight_helix, tv_weight_mountain, tv_weight_arch, tv_weight_lattice: TV indicator weight multipliers
- alignment_min_for_entry: Minimum tickers aligned for entry (out of 3)
- no_entry_after: Time cutoff for new entries (HH:MM format)
- stop_buffer_pct: Stop placement buffer percentage
- rr_weight, delta_weight, liquidity_weight, theta_weight: Strike selection weights (must sum to 1.0)
- delta_sweet_spot_low, delta_sweet_spot_high: Target delta range for strike selection
- min_rr_ratio: Minimum risk:reward ratio for entry

## Output Format
Respond with ONLY valid JSON in this format:
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
  "morning_briefing_text": "2-3 sentence summary for the dashboard"
}

If no adjustments are warranted:
{
  "should_adjust": false,
  "analysis_summary": "Current strategy performing well. 68% win rate over 15 trades.",
  "adjustments": [],
  "market_notes": "...",
  "morning_briefing_text": "No changes overnight. Strategy continues performing well."
}`;

// ---- Kimi client (reuses same config as decision agent) ----

let client = null;

function getClient() {
  if (!client && config.kimiApiKey) {
    client = new OpenAI({
      baseURL: 'https://api.moonshot.ai/v1',
      apiKey: config.kimiApiKey,
    });
  }
  return client;
}

// ---- Public API ----

/**
 * Run the full nightly review process.
 * Returns: { skipped, reason?, changes?, newVersion?, analysis? }
 */
export async function runNightlyReview() {
  log.info('=== Starting Nightly Review ===');

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

  // Guard: no Kimi API key
  const kimiClient = getClient();
  if (!kimiClient) {
    log.warn('Kimi API key not configured — skipping review');
    return { skipped: true, reason: 'no_api_key' };
  }

  // Call Kimi K2.5
  log.info(`Sending review data to Kimi (${totalTrades} trades, v${currentVersion})...`);
  const startTime = Date.now();

  try {
    const response = await kimiClient.chat.completions.create({
      model: config.agentModel || 'kimi-k2.5',
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });

    const responseTimeMs = Date.now() - startTime;
    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      log.error('Review agent returned empty response');
      return { skipped: true, reason: 'empty_response' };
    }

    let result;
    try {
      result = JSON.parse(content);
    } catch {
      log.error('Review agent returned invalid JSON:', content.slice(0, 300));
      return { skipped: true, reason: 'invalid_json' };
    }

    const tokenUsage = {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      responseTimeMs,
    };

    log.info(
      `Review completed in ${responseTimeMs}ms | ` +
      `${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | ` +
      `should_adjust: ${result.should_adjust}`
    );

    // Apply changes if any
    if (result.should_adjust && result.adjustments?.length > 0) {
      const maxChanges = activeConfig.max_adjustments_per_review || 3;
      const adjustments = result.adjustments.slice(0, maxChanges);

      // Validate and clamp changes
      const validated = validateChanges(adjustments, activeConfig);
      if (validated.length === 0) {
        log.info('All proposed changes failed validation — no changes applied');
        return {
          skipped: false,
          changes: [],
          reason: 'validation_failed',
          analysis: result,
          tokenUsage,
        };
      }

      // Build new config
      const newConfig = { ...activeConfig };
      for (const change of validated) {
        newConfig[change.parameter] = change.new_value;
      }

      // Create new version
      const newVersionNum = createVersion(
        newConfig,
        validated.map(c => ({
          param: c.parameter,
          old: c.old_value,
          new: c.new_value,
          reason: c.reason,
        })),
        'NIGHTLY_REVIEW',
        result,
        tokenUsage,
      );

      log.info(`Review created v${newVersionNum} with ${validated.length} change(s)`);

      return {
        skipped: false,
        changes: validated,
        newVersion: newVersionNum,
        previousVersion: currentVersion,
        analysis: result,
        tokenUsage,
      };
    }

    log.info(`Review: no changes — ${result.analysis_summary || 'performance satisfactory'}`);
    return {
      skipped: false,
      changes: [],
      reason: result.analysis_summary || 'no_changes_needed',
      analysis: result,
      tokenUsage,
    };

  } catch (err) {
    const responseTimeMs = Date.now() - startTime;
    log.error(`Review agent error (${responseTimeMs}ms):`, err.message);
    return { skipped: true, reason: `api_error: ${err.message}` };
  }
}

/**
 * Build the structured input for the review agent.
 * Includes 10-dimension analysis from DB queries.
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
  const indicators = ['echo', 'bravo', 'tango', 'helix', 'mountain', 'arch', 'lattice'];
  const result = {};

  for (const ind of indicators) {
    let withSignal = { wins: 0, losses: 0 };
    let withoutSignal = { wins: 0, losses: 0 };

    for (const t of trades) {
      const tv = safeParseJson(t.tv_state_at_entry);
      const state = tv[ind];
      const hasSignal = state && state !== 'NEUTRAL' && state !== 'FLAT' && state !== 'UNKNOWN';
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
  const buckets = { '1-2 (BEGINNER)': [], '3-4 (INTERMEDIATE)': [], '5+ (MASTER)': [] };

  for (const t of trades) {
    const tv = safeParseJson(t.tv_state_at_entry);
    const confirmations = tv.confirmations?.bullish || tv.confirmations?.total || 0;
    if (confirmations >= 5) buckets['5+ (MASTER)'].push(t);
    else if (confirmations >= 3) buckets['3-4 (INTERMEDIATE)'].push(t);
    else buckets['1-2 (BEGINNER)'].push(t);
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
