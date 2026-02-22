/**
 * TV Signal State Store
 * Maintains current state of TradingView indicators: Bravo + Tango only.
 * GEX is the primary decision maker; these are confirmation/timing signals.
 */

import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';

const log = createLogger('TV-Store');

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---- Signal Classification ----

const BULLISH_SIGNALS = {
  bravo: ['BLUE_1', 'BLUE_2', 'WHITE'],
  tango: ['BLUE_1', 'BLUE_2'],
};

const BEARISH_SIGNALS = {
  bravo: ['PINK_1', 'PINK_2'],
  tango: ['PINK_1', 'PINK_2'],
};

// ---- In-Memory State ----

const signalState = {
  bravo: { state: 'NONE', updatedAt: null, isStale: false },
  tango: { state: 'NONE', updatedAt: null, isStale: false },
};

// Track when the last update came in (for pre-agent filter)
let lastUpdateTime = 0;

/**
 * Update a signal from a webhook payload.
 */
export function updateSignal(indicator, sig) {
  const ind = indicator.toLowerCase();
  const state = sig.toUpperCase();
  const now = Date.now();

  if (!signalState[ind]) {
    log.warn(`Unknown indicator: ${ind}`);
    return;
  }

  const oldState = signalState[ind].state;
  signalState[ind] = { state, updatedAt: now, isStale: false };
  lastUpdateTime = now;

  log.info(`${ind.toUpperCase()}: ${oldState} → ${state}`);
}

/**
 * Check staleness of all signals.
 * Marks signals stale if not updated in 5 minutes during market hours.
 */
export function checkStaleness() {
  const now = Date.now();
  let staleCount = 0;

  for (const [ind, sig] of Object.entries(signalState)) {
    if (sig.updatedAt && (now - sig.updatedAt) > STALE_THRESHOLD_MS) {
      if (!sig.isStale) {
        sig.isStale = true;
        log.warn(`${ind.toUpperCase()} is STALE (no update in 5+ min)`);
      }
      staleCount++;
    }
  }

  return staleCount;
}

/**
 * Classify a signal as BULLISH, BEARISH, or NEUTRAL.
 */
function classifySignal(indicator, state) {
  if (signalState[indicator]?.isStale) return 'NEUTRAL';

  const bullish = BULLISH_SIGNALS[indicator];
  const bearish = BEARISH_SIGNALS[indicator];

  if (bullish && bullish.includes(state)) return 'BULLISH';
  if (bearish && bearish.includes(state)) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Count confirmations across Bravo + Tango.
 */
export function getConfirmations() {
  const indicators = ['bravo', 'tango'];
  let bullish = 0;
  let bearish = 0;

  for (const ind of indicators) {
    const classification = classifySignal(ind, signalState[ind].state);
    if (classification === 'BULLISH') bullish++;
    if (classification === 'BEARISH') bearish++;
  }

  const total = indicators.length; // 2

  return {
    bullish,
    bearish,
    total,
    bravo_confirms: classifySignal('bravo', signalState.bravo.state) !== 'NEUTRAL',
    tango_confirms: classifySignal('tango', signalState.tango.state) !== 'NEUTRAL',
  };
}

/**
 * Get a full snapshot of TV signal state for the agent.
 */
export function getSignalSnapshot() {
  const confirmations = getConfirmations();
  const staleCount = checkStaleness();

  return {
    bravo: signalState.bravo.state,
    tango: signalState.tango.state,
    confirmations: {
      bullish: confirmations.bullish,
      bearish: confirmations.bearish,
      total: confirmations.total,
    },
    bravo_confirms: confirmations.bravo_confirms,
    tango_confirms: confirmations.tango_confirms,
    stale_count: staleCount,
    all_stale: staleCount >= 2,
  };
}

/**
 * Get detailed state (for Discord alert formatting).
 */
export function getDetailedState() {
  const indicators = ['bravo', 'tango'];
  return indicators.map(ind => ({
    indicator: ind,
    state: signalState[ind].state,
    classification: classifySignal(ind, signalState[ind].state),
    isStale: signalState[ind].isStale,
    updatedAt: signalState[ind].updatedAt,
  }));
}

/**
 * Get the timestamp of the last signal update (for pre-agent filter).
 */
export function getLastUpdateTime() {
  return lastUpdateTime;
}

/**
 * Load signal state from SQLite on startup.
 */
export function loadFromDb(rows) {
  for (const row of rows) {
    const ind = row.indicator.toLowerCase();
    if (signalState[ind] !== undefined) {
      signalState[ind] = {
        state: row.state,
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
        isStale: !!row.is_stale,
      };
    }
  }
  log.info('Loaded signal state from database');
}

/**
 * Get raw state for DB persistence.
 */
export function getStateForDb() {
  return Object.entries(signalState).map(([indicator, data]) => ({
    indicator,
    state: data.state || 'NONE',
    level: null,
    kind: null,
    updatedAt: data.updatedAt ? formatET(nowET()) : null,
    isStale: data.isStale ? 1 : 0,
  }));
}
