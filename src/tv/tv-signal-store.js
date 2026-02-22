/**
 * TV Signal State Store
 * Maintains current state of all TradingView Startup indicators.
 * In-memory with SQLite backing for persistence across restarts.
 */

import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';

const log = createLogger('TV-Store');

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---- Signal Classification ----

const BULLISH_SIGNALS = {
  echo: ['BLUE'],
  bravo: ['BLUE_1', 'BLUE_2', 'WHITE'],
  tango: ['BLUE_1', 'BLUE_2'],
  helix: ['GREEN_STEEP', 'GREEN'],
  mountain: ['UP'],
  arch: ['GREEN'],
  lattice: ['BLUE_ABOVE'],
};

const BEARISH_SIGNALS = {
  echo: ['PINK'],
  bravo: ['PINK_1', 'PINK_2'],
  tango: ['PINK_1', 'PINK_2'],
  helix: ['PURPLE_STEEP', 'PURPLE'],
  mountain: ['DOWN'],
  arch: ['PURPLE'],
  lattice: ['PINK_BELOW'],
};

// ---- In-Memory State ----

const signalState = {
  echo:     { state: 'NONE', updatedAt: null, isStale: false },
  bravo:    { state: 'NONE', updatedAt: null, isStale: false },
  tango:    { state: 'NONE', updatedAt: null, isStale: false },
  helix:    { state: 'FLAT', updatedAt: null, isStale: false },
  mountain: { state: 'ABSENT', updatedAt: null, isStale: false },
  arch:     { state: 'PURPLE', updatedAt: null, isStale: false },
  lattice:  { state: 'PINK_BELOW', updatedAt: null, isStale: false },
  support:  { level: null, kind: null, updatedAt: null, isStale: false },
  resistance: { level: null, kind: null, updatedAt: null, isStale: false },
};

// Track when the last update came in (for pre-agent filter)
let lastUpdateTime = 0;

/**
 * Update a signal from a webhook payload.
 */
export function updateSignal(indicator, sig, level = null) {
  const ind = indicator.toLowerCase();
  const state = sig.toUpperCase();
  const now = Date.now();

  // Handle voila (S/R levels) specially
  if (ind === 'voila') {
    // Parse signal: "support_5820" → type=support, level=5820
    // Or: "gold", "green" → support; "purple", "silver" → resistance
    const lower = state.toLowerCase();
    let srType = null;
    let parsedLevel = level;

    if (lower.startsWith('support')) {
      srType = 'support';
      if (!parsedLevel) {
        const match = lower.match(/support[_\s]?(\d+)/);
        if (match) parsedLevel = parseFloat(match[1]);
      }
    } else if (lower.startsWith('resistance')) {
      srType = 'resistance';
      if (!parsedLevel) {
        const match = lower.match(/resistance[_\s]?(\d+)/);
        if (match) parsedLevel = parseFloat(match[1]);
      }
    } else if (lower === 'gold' || lower === 'green') {
      srType = 'support';
    } else {
      srType = 'resistance';
    }

    const oldLevel = signalState[srType].level;
    signalState[srType] = { level: parsedLevel, kind: lower, updatedAt: now, isStale: false };
    log.info(`${srType.charAt(0).toUpperCase() + srType.slice(1)} updated: ${lower} at $${parsedLevel} (was $${oldLevel})`);
    lastUpdateTime = now;
    return;
  }

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
    if (ind === 'support' || ind === 'resistance') continue;

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
 * Count confirmations across all indicators.
 */
export function getConfirmations() {
  const indicators = ['echo', 'bravo', 'tango', 'helix', 'mountain', 'arch', 'lattice'];
  let bullish = 0;
  let bearish = 0;

  for (const ind of indicators) {
    const classification = classifySignal(ind, signalState[ind].state);
    if (classification === 'BULLISH') bullish++;
    if (classification === 'BEARISH') bearish++;
  }

  const total = indicators.length;

  let mode;
  const maxConfirm = Math.max(bullish, bearish);
  if (maxConfirm >= 4) mode = 'MASTER';
  else if (maxConfirm >= 3) mode = 'INTERMEDIATE';
  else mode = 'BEGINNER';

  return { bullish, bearish, total, mode };
}

/**
 * Get a full snapshot of TV signal state for the agent.
 */
export function getSignalSnapshot() {
  const confirmations = getConfirmations();
  const staleCount = checkStaleness();

  const snapshot = {
    echo: signalState.echo.state,
    bravo: signalState.bravo.state,
    tango: signalState.tango.state,
    helix: signalState.helix.state,
    mountain: signalState.mountain.state,
    arch: signalState.arch.state,
    lattice: signalState.lattice.state,
    support: signalState.support.level
      ? { level: signalState.support.level, kind: signalState.support.kind }
      : null,
    resistance: signalState.resistance.level
      ? { level: signalState.resistance.level, kind: signalState.resistance.kind }
      : null,
    confirmations: {
      bullish: confirmations.bullish,
      bearish: confirmations.bearish,
      total: confirmations.total,
    },
    confirmation_mode: confirmations.mode,
    stale_count: staleCount,
    all_stale: staleCount >= 7,
  };

  return snapshot;
}

/**
 * Get detailed state (for Discord alert formatting).
 */
export function getDetailedState() {
  const indicators = ['echo', 'bravo', 'tango', 'helix', 'mountain', 'arch', 'lattice'];
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
      if (ind === 'support' || ind === 'resistance') {
        signalState[ind] = {
          level: row.level,
          kind: row.kind,
          updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
          isStale: !!row.is_stale,
        };
      } else {
        signalState[ind] = {
          state: row.state,
          updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
          isStale: !!row.is_stale,
        };
      }
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
    level: data.level || null,
    kind: data.kind || null,
    updatedAt: data.updatedAt ? formatET(nowET()) : null,
    isStale: data.isStale ? 1 : 0,
  }));
}
