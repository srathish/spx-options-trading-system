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
  profit_target_pct: 0.15,           // +0.15% SPX move → lock profits
  stop_loss_pct: 0.20,               // -0.20% adverse → cut losses
  tv_against_exit_count: 2,          // 2+ opposing 3m TV signals → exit
  trailing_stop_activate_pts: 8,     // Activate trailing after +8 SPX pts
  trailing_stop_distance_pts: 5,     // Trail 5 pts behind best
  opposing_wall_exit_value: 5_000_000, // Exit if opposing wall > $5M appears

  // Chop detection
  chop_lookback_cycles: 60,          // 60 cycles = 30 min of history
  chop_flip_threshold: 6,            // 6+ direction flips = chop
  chop_stddev_threshold: 20,         // score stddev > 20 = chop

  // Strike selection weights
  rr_weight: 0.40,
  delta_weight: 0.25,
  liquidity_weight: 0.20,
  theta_weight: 0.15,
  delta_sweet_spot_low: 0.35,
  delta_sweet_spot_high: 0.55,

  // Self-improvement settings
  learning_period_days: 7,
  min_trades_for_adjustment: 5,
  max_adjustments_per_review: 3,
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
  const learningDays = activeConfig?.learning_period_days || 7;

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
