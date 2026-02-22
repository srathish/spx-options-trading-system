/**
 * Phantom Comparison Engine — Pure code, no AI calls.
 * After each trade closes, re-evaluates entry/exit conditions
 * under the previous version's config to determine if the old
 * strategy would have done better or worse.
 */

import { savePhantomComparison, getVersionByNumber, getRecentPhantomComparisons } from '../store/db.js';
import { getActiveVersionNumber, getActiveConfig } from './strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Phantom');

// Bullish states per indicator (must match tv-signal-store.js classifications)
const BULLISH_STATES = {
  bravo: ['BLUE_1', 'BLUE_2', 'WHITE'],
  tango: ['BLUE_1', 'BLUE_2'],
};

const BEARISH_STATES = {
  bravo: ['PINK_1', 'PINK_2'],
  tango: ['PINK_1', 'PINK_2'],
};

/**
 * Run phantom comparison for a closed trade.
 * Compares current version's rules vs parent version's rules.
 */
export function runPhantomComparison(closedTradeRow) {
  const currentVersion = getActiveVersionNumber();
  const currentConfig = getActiveConfig();

  if (currentVersion <= 1) return null; // v1 has no parent to compare against

  // Get parent version's config
  const currentRow = getVersionByNumber(currentVersion);
  if (!currentRow || !currentRow.parent_version) return null;

  const parentRow = getVersionByNumber(currentRow.parent_version);
  if (!parentRow) return null;

  const parentConfig = JSON.parse(parentRow.config);

  // Parse trade data
  const gexState = safeParseJson(closedTradeRow.gex_state_at_entry);
  const tvState = safeParseJson(closedTradeRow.tv_state_at_entry);

  // Evaluate under both configs
  const currentWouldEnter = evaluateEntry(gexState, tvState, closedTradeRow.direction, currentConfig);
  const parentWouldEnter = evaluateEntry(gexState, tvState, closedTradeRow.direction, parentConfig);

  // Evaluate exit conditions
  const currentExitNotes = evaluateExitContext(closedTradeRow, currentConfig);
  const parentExitNotes = evaluateExitContext(closedTradeRow, parentConfig);

  // Determine assessment
  const isWin = (closedTradeRow.pnl_dollars || 0) > 0;
  const assessment = assessComparison(currentWouldEnter, parentWouldEnter, isWin);

  // Save to database
  savePhantomComparison({
    tradeId: closedTradeRow.id,
    currentVersion,
    previousVersion: currentRow.parent_version,
    currentWouldEnter,
    previousWouldEnter: parentWouldEnter,
    currentWouldExit: currentExitNotes,
    previousWouldExit: parentExitNotes,
    tradePnlDollars: closedTradeRow.pnl_dollars,
    tradePnlPct: closedTradeRow.pnl_pct,
    assessment,
    details: {
      gexScore: gexState.score,
      direction: closedTradeRow.direction,
      exitReason: closedTradeRow.exit_reason,
      currentConfig: {
        gex_min_score: currentConfig.gex_min_score,
        gex_strong_threshold: currentConfig.gex_strong_threshold,
      },
      parentConfig: {
        gex_min_score: parentConfig.gex_min_score,
        gex_strong_threshold: parentConfig.gex_strong_threshold,
      },
    },
  });

  log.debug(
    `Phantom: trade #${closedTradeRow.id} | ${isWin ? 'WIN' : 'LOSS'} | ` +
    `current=${currentWouldEnter ? 'ENTER' : 'SKIP'} parent=${parentWouldEnter ? 'ENTER' : 'SKIP'} → ${assessment}`
  );

  return assessment;
}

/**
 * Get recent phantom comparisons.
 */
export function getRecentComparisons(limit = 20) {
  return getRecentPhantomComparisons(limit);
}

// ---- Internal evaluation logic ----

/**
 * Would this config have entered this trade?
 * GEX-primary: strong GEX can enter without TV, moderate GEX needs >= 1 TV.
 */
function evaluateEntry(gexState, tvState, direction, config) {
  // 1. GEX score check
  const gexScore = gexState.score || 0;
  if (gexScore < config.gex_min_score) return false;

  // 2. TV confirmations check (GEX-primary paradigm)
  const tvConfirmations = countWeightedConfirmations(tvState, direction, config);
  const strongThreshold = config.gex_strong_threshold || config.gex_strong_score || 80;

  // Strong GEX (>= threshold) can enter without TV
  if (gexScore >= strongThreshold) return true;

  // Moderate GEX needs at least 1 TV confirmation
  if (tvConfirmations < 1) return false;

  return true;
}

/**
 * Count weighted TV confirmations under a given config.
 */
function countWeightedConfirmations(tvState, direction, config) {
  if (!tvState) return 0;

  const isBullish = direction === 'BULLISH';
  const indicators = ['bravo', 'tango'];
  let count = 0;

  for (const ind of indicators) {
    const state = tvState[ind];
    if (!state) continue;

    const stateStr = typeof state === 'string' ? state : state.state || state.classification || '';
    const states = isBullish ? BULLISH_STATES[ind] : BEARISH_STATES[ind];

    if (states && states.includes(stateStr.toUpperCase())) {
      const weightKey = `tv_weight_${ind}`;
      const weight = config[weightKey] || 1.0;
      count += weight;
    }
  }

  return count;
}

/**
 * Evaluate exit context — would the config's exit rules differ?
 */
function evaluateExitContext(trade, config) {
  const notes = [];

  // Check if GEX flip threshold would have triggered earlier/later
  if (trade.exit_reason === 'GEX_FLIP') {
    notes.push(`GEX flip threshold: ${config.gex_exit_threshold}`);
  }

  // Check if no_entry_after would have prevented entry entirely
  if (trade.opened_at) {
    const entryHour = parseInt(trade.opened_at.split(' ')[1]?.split(':')[0] || '0');
    const entryMin = parseInt(trade.opened_at.split(' ')[1]?.split(':')[1] || '0');
    const [cutoffH, cutoffM] = config.no_entry_after.split(':').map(Number);
    if (entryHour > cutoffH || (entryHour === cutoffH && entryMin >= cutoffM)) {
      notes.push('Entry blocked by no_entry_after');
    }
  }

  return notes.length > 0 ? notes.join('; ') : null;
}

/**
 * Determine assessment based on entry decisions and outcome.
 */
function assessComparison(currentWouldEnter, parentWouldEnter, isWin) {
  if (currentWouldEnter === parentWouldEnter) return 'SAME';

  if (isWin) {
    // Trade was profitable
    if (currentWouldEnter && !parentWouldEnter) return 'CURRENT_BETTER';
    if (!currentWouldEnter && parentWouldEnter) return 'PREVIOUS_BETTER';
  } else {
    // Trade was a loss
    if (!currentWouldEnter && parentWouldEnter) return 'CURRENT_BETTER';
    if (currentWouldEnter && !parentWouldEnter) return 'PREVIOUS_BETTER';
  }

  return 'SAME';
}

function safeParseJson(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}
