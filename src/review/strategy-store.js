/**
 * Strategy Store — Version CRUD + in-memory config cache.
 * Foundation module for the self-improvement loop.
 *
 * Every tunable parameter is versioned. Versions form a tree (not a line):
 * if v3 is rolled back to v2, the next change creates v4 branching from v2.
 */

import {
  saveStrategyVersion, activateVersion, getActiveVersion, getVersionByNumber,
  getAllVersions, getV1Floor, getNextVersionNumber,
} from '../store/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Strategy');

// ---- V1 Baseline Config ----

const V1_BASELINE = {
  // GEX thresholds
  gex_min_score: 60,
  gex_strong_score: 80,
  gex_chop_zone_low: 40,
  gex_chop_zone_high: 60,
  wall_min_value: 2_000_000,
  wall_dominant_value: 5_000_000,
  noise_filter_pct: 0.10,

  // Multi-ticker
  alignment_min_for_entry: 2,
  driver_bonus_confidence: true,
  king_node_first_tap_bias: 'REJECT',
  king_node_second_tap_bias: 'BREAK',
  node_slide_weight: 1.5,

  // TV weights (Bravo + Tango only — GEX is primary decision maker)
  tv_weight_bravo: 1.0,
  tv_weight_tango: 1.5,

  // GEX-primary entry thresholds
  gex_strong_threshold: 80,   // GEX score where TV confirmation is optional

  // Entry/exit rules
  min_rr_ratio: 1.0,
  max_trades_per_day: 5,
  no_entry_after: '15:30',
  theta_warning_time: '15:00',
  stop_buffer_pct: 0.05,
  gex_exit_threshold: 40,
  gex_wait_zone_low: 40,
  gex_wait_zone_high: 60,

  // Exit tuning
  profit_target_pct: 0.20,           // +0.20% SPX move → lock profits (was 0.15)
  stop_loss_pct: 0.15,               // -0.15% adverse → cut losses (was 0.20)
  tv_against_exit_count: 2,          // 2+ opposing 3m TV signals → exit
  trailing_stop_activate_pts: 8,     // Activate trailing after +8 SPX pts
  trailing_stop_distance_pts: 5,     // Trail 5 pts behind best
  opposing_wall_exit_value: 5_000_000, // Exit if opposing wall > $5M appears

  // Chop detection
  chop_lookback_cycles: 60,          // 60 cycles = 30 min of history
  chop_flip_threshold: 4,            // 4+ direction flips = chop (was 6)
  chop_stddev_threshold: 15,         // score stddev > 15 = chop (was 20)
  chop_flip_rate_threshold: 0.30,    // flip rate > 30% of cycles = chop
  chop_entry_spacing_ms: 120_000,    // 2min spacing in chop (vs 60s default)
  chop_min_entry_score: 80,          // during CHOP, require score >= 80

  // Strike selection weights
  rr_weight: 0.40,
  delta_weight: 0.25,
  liquidity_weight: 0.20,
  theta_weight: 0.15,
  delta_sweet_spot_low: 0.35,
  delta_sweet_spot_high: 0.55,

  // Self-improvement settings
  learning_period_days: 0,
  min_trades_for_adjustment: 5,
  max_adjustments_per_review: 3,

  // GEX Pattern thresholds
  pattern_min_wall_pct: 0.15,
  pattern_rug_max_gap_strikes: 2,
  pattern_king_node_max_touches: 1,
  pattern_pika_max_dist_pct: 0.20,
  pattern_air_pocket_min_quality: 'MEDIUM',
  pattern_range_fade_max_touches: 1,
  pattern_triple_min_walls: 3,

  // Dual-lane config
  lane_a_enabled: true,
  lane_b_enabled: true,
  lane_b_min_tv_weight: 0.5,
  lane_b_min_tv_indicators: 1,

  // Algorithmic entry engine
  gex_only_min_score: 50,
  alignment_override_gex_score: 85,
  power_hour_min_gex_score: 80,

  // Entry quality gates
  entry_min_spacing_ms: 60_000,
  entry_blackout_start: '09:30',
  entry_blackout_end: '09:33',
  consecutive_loss_limit: 2,
  consecutive_loss_cooldown_ms: 15 * 60_000,

  // NODE_SUPPORT_BREAK exit
  node_break_buffer_pts: 2,

  // MOMENTUM_TIMEOUT exit (4 phases — phase 0 exempt from min hold)
  momentum_phase0_seconds: 90,       // was 60 — give entries more time
  momentum_phase0_min_pts: 0.5,      // was 1 — less aggressive early exit
  momentum_min_hold_minutes: 3,
  momentum_phase1_minutes: 5,
  momentum_phase1_min_pts: 2,
  momentum_phase2_minutes: 10,
  momentum_phase2_target_pct: 0.40,
  momentum_phase3_minutes: 15,

  // TV_COUNTER_FLIP exit
  tv_counter_flip_enabled: true,
  tv_counter_flip_min_indicators: 2,

  // Pattern trigger weights (for ranking when multiple patterns fire)
  trigger_weight_rug_pull: 1.2,
  trigger_weight_reverse_rug: 1.1,
  trigger_weight_king_node_bounce: 1.0,
  trigger_weight_pika_pillow: 1.0,
  trigger_weight_triple_ceiling: 0.9,
  trigger_weight_triple_floor: 0.9,
  trigger_weight_air_pocket: 1.1,
  trigger_weight_range_edge_fade: 0.8,

  // Pattern-specific minimum wall values
  rug_pull_min_value: 3_000_000,
  pika_pillow_min_value: 5_000_000,
  king_node_min_value: 3_000_000,

  // Pattern-level risk management
  max_trades_per_pattern: 8,         // max trades per pattern per day
  pattern_loss_limit: 3,             // consecutive losses on same pattern → cooldown
  pattern_loss_cooldown_ms: 30 * 60_000, // 30min cooldown after pattern loss limit
  pattern_win_rate_min: 0.30,        // auto-disable patterns below 30% win rate
  pattern_win_rate_min_trades: 10,   // need 10+ trades before win rate gate activates

  // Entry quality
  min_entry_rr_ratio: 1.5,           // require target >= 1.5x stop distance
  structural_min_score: 40,          // structural patterns still need GEX score >= 40
  midpoint_danger_zone_pct: 0.08,    // widen midpoint buffer from 0.05% to 0.08%

  // Adaptive momentum
  momentum_phase1_high_conf_minutes: 7, // HIGH/VERY_HIGH entries get 7min Phase 1 (vs 5)

  // Trend day detection
  trend_min_floor_value: 5_000_000,           // $5M min for wall to count as support floor
  trend_min_lookback_cycles: 60,              // 30 min minimum data before detection
  trend_min_floor_rise_pts: 15,               // support floor must migrate ≥15 SPX pts
  trend_min_directional_bias_pct: 0.60,       // ≥60% of cycles must read same direction
  trend_min_spot_move_pts: 10,                // spot must move ≥10 pts in trend direction
  trend_deactivate_floor_drop_pts: 10,        // deactivate if floor drops 10+ pts from peak
  trend_deactivate_bias_threshold: 0.40,      // deactivate if bias drops below 40%

  // Trend day exit adjustments
  trend_profit_target_multiplier: 2.5,        // 2.5x wider profit target during trend
  trend_stop_loss_multiplier: 2.0,            // 2x wider stop loss during trend
  trend_stop_multiplier: 1.5,                 // 1.5x wider structural stop at entry
  trend_trail_activate_pts: 5,                // activate trailing sooner (5 vs 8 pts)
  trend_trail_distance_pts: 8,                // trail wider (8 vs 5 pts)
  trend_momentum_time_multiplier: 2.5,        // 2.5x longer momentum timeouts during trend
  trend_momentum_phase1_min_pts: 1,            // reduced phase 1 min progress during trend (normally 2)
  trend_gex_flip_required_cycles: 3,          // require 3 consecutive opposing GEX cycles
  trend_floor_break_buffer_pts: 3,            // structural exit: spot must break floor by 3+ pts
  breakout_score_threshold: 90,               // score ≥90 = breakout entry
  breakout_stop_multiplier: 1.3,              // 1.3x wider stop for breakout entries

  // Trend pullback entry
  trend_pullback_enabled: true,
  trend_pullback_min_score: 40,               // lower than normal — trend provides context
  trend_pullback_max_dist_pts: 8,             // within 8 pts of support floor
  trend_pullback_stop_buffer_pts: 5,          // stop 5 pts below support floor

  // Trend day re-entry
  trend_reentry_spacing_ms: 30_000,           // 30s cooldown (vs 60s) after win in trend

  // Wall intelligence (Gap detection)
  pin_gex_at_spot_threshold: 20_000_000,      // $20M GEX@spot + pos walls on both sides = extreme pin
  wall_flip_min_magnitude: 5_000_000,         // $5M min for wall sign flip to count as pattern

  // Cross-ticker + magnet bounce
  negative_king_node_max_dist_pts: 5,          // Must be within 5pts for magnet bounce (vs 10pts for positive)

  // Magnet walk (continuation through stacked targets)
  magnet_walk_enabled: true,
  magnet_walk_max_steps: 2,                    // max target extensions per trade
  magnet_walk_max_dist_pts: 25,                // next magnet must be within 25pts
  magnet_walk_stop_ratchet_pts: 3,             // move stop to previous_target - 3pts on walk
};

// ---- In-memory cache ----

let activeConfig = null;
let activeVersionNum = null;
let initialized = false;

// ---- Public API ----

/**
 * Initialize: load active version from DB, or seed v1 if empty.
 */
export function initStrategyStore() {
  if (initialized) return;

  const active = getActiveVersion();
  if (active) {
    activeConfig = JSON.parse(active.config);
    activeVersionNum = active.version;
    log.info(`Strategy v${active.version} loaded (source: ${active.source})`);
  } else {
    // Seed v1 baseline
    saveStrategyVersion({
      version: 1,
      parentVersion: null,
      config: V1_BASELINE,
      changeSummary: [],
      source: 'INIT',
      reviewAnalysis: null,
      isActive: true,
      isV1Floor: true,
    });
    activateVersion(1);
    activeConfig = { ...V1_BASELINE };
    activeVersionNum = 1;
    log.info('Strategy v1 baseline seeded and activated');
  }

  initialized = true;
}

/**
 * Get the active config object (synchronous, zero overhead).
 * Called every 30s cycle.
 */
export function getActiveConfig() {
  return activeConfig;
}

/**
 * Override the in-memory active config WITHOUT creating a DB version.
 * Used by the replay engine in forked child processes for backtest config testing.
 * The override dies with the process — no impact on live trading.
 */
export function setActiveConfigOverride(overrideConfig) {
  activeConfig = { ...activeConfig, ...overrideConfig };
}

/**
 * Get the active version number.
 */
export function getActiveVersionNumber() {
  return activeVersionNum;
}

/**
 * Get a display label like 'v4'.
 */
export function getVersionLabel() {
  return `v${activeVersionNum}`;
}

/**
 * Create a new version with changes.
 * Deactivates old version, activates new, updates cache.
 */
export function createVersion(config, changeSummary, source, reviewAnalysis = null, tokenUsage = {}) {
  const newVersionNum = getNextVersionNumber();
  const parentVersion = activeVersionNum;

  saveStrategyVersion({
    version: newVersionNum,
    parentVersion,
    config,
    changeSummary,
    source,
    reviewAnalysis,
    isActive: true,
    isV1Floor: false,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    responseTimeMs: tokenUsage.responseTimeMs,
  });

  activateVersion(newVersionNum);

  // Update cache
  activeConfig = { ...config };
  activeVersionNum = newVersionNum;

  log.info(`Strategy v${newVersionNum} created (parent: v${parentVersion}, source: ${source}, ${changeSummary.length} changes)`);
  return newVersionNum;
}

/**
 * Rollback to a specific version.
 */
export function rollbackTo(version) {
  const row = getVersionByNumber(version);
  if (!row) {
    log.error(`Cannot rollback: version ${version} not found`);
    return false;
  }

  activateVersion(version);
  activeConfig = JSON.parse(row.config);
  activeVersionNum = version;

  log.warn(`Rolled back to strategy v${version}`);
  return true;
}

/**
 * Get all versions descending.
 */
export function getVersionHistory() {
  return getAllVersions();
}

/**
 * Get the v1 baseline config.
 */
export function getV1BaselineConfig() {
  const row = getV1Floor();
  return row ? JSON.parse(row.config) : V1_BASELINE;
}

/**
 * Get failed adjustments — parameters from rolled-back versions.
 * The nightly review uses this to avoid repeating failed changes.
 */
export function getFailedAdjustments() {
  const versions = getAllVersions();
  const failed = [];

  for (const v of versions) {
    // Check if this version was rolled back (a later version exists with parent != this)
    const wasRolledBack = versions.some(other =>
      other.version > v.version &&
      other.source === 'ROLLBACK'
    );

    // If a version was created but later another version branched from its parent,
    // it means this version was effectively "skipped"
    if (wasRolledBack || isVersionRolledBack(v, versions)) {
      const changes = JSON.parse(v.change_summary || '[]');
      for (const change of changes) {
        failed.push({
          version: v.version,
          parameter: change.param || change.parameter,
          oldValue: change.old || change.old_value,
          newValue: change.new || change.new_value,
          reason: change.reason,
        });
      }
    }
  }

  return failed;
}

/**
 * Check if we're in the learning period (first N days, v1 only).
 */
export function isLearningPeriod() {
  if (activeVersionNum !== 1) return false;

  const v1 = getV1Floor();
  if (!v1) return false;

  const createdAt = new Date(v1.created_at);
  const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  const learningDays = activeConfig?.learning_period_days ?? 7;

  return daysSinceCreation < learningDays;
}

// ---- Internal helpers ----

function isVersionRolledBack(version, allVersions) {
  // A version is "rolled back" if a newer version exists whose parent is this version's parent
  // (meaning this version was bypassed)
  if (!version.parent_version) return false;

  return allVersions.some(other =>
    other.version > version.version &&
    other.parent_version === version.parent_version &&
    other.version !== version.version
  );
}
