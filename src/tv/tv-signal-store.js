/**
 * TV Signal State Store — Multi-Indicator, Multi-Timeframe
 * Tracks Echo, Bravo, Tango across SPX/SPY/QQQ on 1m and 3m timeframes.
 * Echo = early warning (fastest), Bravo = primary confirmation, Tango = highest conviction.
 * GEX is the primary decision maker; these are confirmation/timing signals.
 */

import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';

const log = createLogger('TV-Store');

// ---- Configuration ----

const TICKERS = ['spx', 'spy', 'qqq'];
const INDICATORS = ['echo', 'bravo', 'tango'];
const TIMEFRAMES = ['1', '3'];

// Echo is SPX-only, 3m-only (2 alerts: up + down). Bravo + Tango run on all 3 tickers × 2 TFs (12 alerts).
const ECHO_TICKERS = ['spx'];
const ECHO_TIMEFRAMES = ['3']; // Echo only has 3m alerts

// Staleness: 1m signals go stale faster than 3m
const STALE_MS = {
  '1': 3 * 60 * 1000,  // 3 minutes for 1m
  '3': 9 * 60 * 1000,  // 9 minutes for 3m
};

// Weighted scoring: higher timeframe + higher conviction indicator = more weight
const SIGNAL_WEIGHTS = {
  echo_3: 0.75,
  bravo_1: 0.75,
  bravo_3: 1.0,
  tango_1: 1.0,
  tango_3: 1.5,
};

// ---- Signal Classification ----

const BULLISH_SIGNALS = {
  echo:  ['BLUE_1', 'BLUE_2', 'WHITE'],
  bravo: ['BLUE_1', 'BLUE_2', 'WHITE'],
  tango: ['BLUE_1', 'BLUE_2'],
};

const BEARISH_SIGNALS = {
  echo:  ['PINK_1', 'PINK_2'],
  bravo: ['PINK_1', 'PINK_2'],
  tango: ['PINK_1', 'PINK_2'],
};

// ---- In-Memory State ----
// Flat map keyed by "ticker_indicator_timeframe" e.g. "spx_bravo_3"

function makeEmpty() {
  return { state: 'NONE', updatedAt: null, isStale: false, confirmed: false };
}

const signalState = {};

// Initialize all valid slots
function initSlots() {
  for (const tkr of TICKERS) {
    for (const ind of INDICATORS) {
      // Echo only runs on SPX
      if (ind === 'echo' && !ECHO_TICKERS.includes(tkr)) continue;
      const tfs = (ind === 'echo') ? ECHO_TIMEFRAMES : TIMEFRAMES;
      for (const tf of tfs) {
        const key = `${tkr}_${ind}_${tf}`;
        signalState[key] = makeEmpty();
      }
    }
  }
}
initSlots();

let lastUpdateTime = 0;

// TV Regime — remembers last significant Diamond direction.
let tvRegime = { direction: null, setAt: null, ticker: null, signal: null };

// ---- Core API ----

/**
 * Build a flat key from components.
 */
function makeKey(ticker, indicator, timeframe) {
  return `${ticker.toLowerCase()}_${indicator.toLowerCase()}_${timeframe}`;
}

/**
 * Update a signal from a webhook payload.
 * @param {string} indicator - echo, bravo, or tango
 * @param {string} sig - signal state e.g. BLUE_1, PINK_2, WHITE_1, NONE
 * @param {string} ticker - spx, spy, qqq
 * @param {string} timeframe - '1' or '3'
 * @param {boolean} confirmed - true if bar-close, false if bar-open
 */
export function updateSignal(indicator, sig, ticker = 'spx', timeframe = '3', confirmed = true) {
  const ind = indicator.toLowerCase();
  const tkr = ticker.toLowerCase();
  const tf = String(timeframe);
  const state = sig.toUpperCase();
  const now = Date.now();
  const key = makeKey(tkr, ind, tf);

  if (!signalState[key]) {
    log.warn(`Unknown signal slot: ${key} (ticker=${tkr}, ind=${ind}, tf=${tf})`);
    return;
  }

  const oldState = signalState[key].state;
  const wasConfirmed = signalState[key].confirmed;

  // If same state arrives as confirmed, just upgrade
  if (state === oldState && confirmed && !wasConfirmed) {
    signalState[key].confirmed = true;
    signalState[key].updatedAt = now;
    signalState[key].isStale = false;
    lastUpdateTime = now;
    log.info(`${tkr.toUpperCase()} ${ind.toUpperCase()} ${tf}m: ${state} CONFIRMED (was early)`);
    return;
  }

  signalState[key] = { state, updatedAt: now, isStale: false, confirmed };
  lastUpdateTime = now;

  // Update TV regime on Bravo Diamond signals (primary indicator)
  if (ind === 'bravo' && tf === '3') {
    const classification = classifySignal('bravo', state, false);
    if (classification === 'BEARISH') {
      const oldRegime = tvRegime.direction;
      tvRegime = { direction: 'BEARISH', setAt: now, ticker: tkr, signal: state };
      if (oldRegime !== 'BEARISH') {
        log.info(`TV regime → BEARISH (${tkr.toUpperCase()} Bravo 3m ${state})`);
      }
    } else if (classification === 'BULLISH' && state !== 'WHITE') {
      const oldRegime = tvRegime.direction;
      tvRegime = { direction: 'BULLISH', setAt: now, ticker: tkr, signal: state };
      if (oldRegime !== 'BULLISH') {
        log.info(`TV regime → BULLISH (${tkr.toUpperCase()} Bravo 3m ${state})`);
      }
    }
  }

  log.info(`${tkr.toUpperCase()} ${ind.toUpperCase()} ${tf}m: ${oldState} → ${state}${confirmed ? '' : ' (early)'}`);
}

// ---- Staleness ----

/**
 * Check staleness of all signals. Returns count of stale SPX signals.
 */
export function checkStaleness() {
  const now = Date.now();
  let spxStaleCount = 0;

  for (const [key, sig] of Object.entries(signalState)) {
    if (!sig.updatedAt) continue;
    const tf = key.split('_')[2]; // e.g. "spx_bravo_3" → "3"
    const threshold = STALE_MS[tf] || STALE_MS['3'];

    if ((now - sig.updatedAt) > threshold) {
      if (!sig.isStale) {
        sig.isStale = true;
        log.warn(`${key} is STALE (no update in ${threshold / 60000}+ min)`);
      }
      if (key.startsWith('spx_')) spxStaleCount++;
    }
  }

  return spxStaleCount;
}

// ---- Classification ----

function classifySignal(indicator, state, isStale = false) {
  if (isStale) return 'NEUTRAL';
  const bullish = BULLISH_SIGNALS[indicator];
  const bearish = BEARISH_SIGNALS[indicator];
  if (bullish && bullish.includes(state)) return 'BULLISH';
  if (bearish && bearish.includes(state)) return 'BEARISH';
  return 'NEUTRAL';
}

// ---- Per-Ticker Summary ----

/**
 * Get weighted TV score for a ticker.
 * Returns { bullishScore, bearishScore, maxPossible, signals[] }
 */
export function getTickerSummary(ticker = 'spx') {
  const tkr = ticker.toLowerCase();
  let bullishScore = 0;
  let bearishScore = 0;
  let maxPossible = 0;
  const signals = [];

  for (const ind of INDICATORS) {
    if (ind === 'echo' && !ECHO_TICKERS.includes(tkr)) continue;
    for (const tf of TIMEFRAMES) {
      const key = makeKey(tkr, ind, tf);
      const sig = signalState[key];
      if (!sig) continue;

      const weight = SIGNAL_WEIGHTS[`${ind}_${tf}`] || 1.0;
      maxPossible += weight;

      const classification = classifySignal(ind, sig.state, sig.isStale);
      if (classification === 'BULLISH') bullishScore += weight;
      if (classification === 'BEARISH') bearishScore += weight;

      signals.push({
        key,
        indicator: ind,
        timeframe: tf,
        state: sig.state,
        classification,
        weight,
        isStale: sig.isStale,
        confirmed: sig.confirmed,
      });
    }
  }

  return { bullishScore, bearishScore, maxPossible, signals };
}

// ---- Backward-Compatible Confirmations ----

/**
 * Get confirmation counts for a ticker (backward compatible).
 * Now counts across all indicators and timeframes.
 */
export function getConfirmations(ticker = 'spx') {
  const summary = getTickerSummary(ticker);
  let bullish = 0;
  let bearish = 0;

  for (const sig of summary.signals) {
    if (sig.classification === 'BULLISH') bullish++;
    if (sig.classification === 'BEARISH') bearish++;
  }

  // Backward compat: bravo_confirms and tango_confirms check 3m signals
  const tkr = ticker.toLowerCase();
  const bravo3 = signalState[makeKey(tkr, 'bravo', '3')];
  const tango3 = signalState[makeKey(tkr, 'tango', '3')];

  return {
    bullish,
    bearish,
    total: summary.signals.length,
    bravo_confirms: bravo3 ? classifySignal('bravo', bravo3.state, bravo3.isStale) !== 'NEUTRAL' : false,
    tango_confirms: tango3 ? classifySignal('tango', tango3.state, tango3.isStale) !== 'NEUTRAL' : false,
    weighted: { bullish: summary.bullishScore, bearish: summary.bearishScore, max: summary.maxPossible },
  };
}

// ---- TV Alignment ----

/**
 * How many 3m SPX indicators agree on direction?
 * Returns { direction, count, total } — used for confidence labeling.
 */
export function getTvAlignment() {
  const tkr = 'spx';
  let bullish3m = 0;
  let bearish3m = 0;
  let total3m = 0;

  for (const ind of INDICATORS) {
    if (ind === 'echo' && !ECHO_TICKERS.includes(tkr)) continue;
    const key = makeKey(tkr, ind, '3');
    const sig = signalState[key];
    if (!sig) continue;
    total3m++;

    const cls = classifySignal(ind, sig.state, sig.isStale);
    if (cls === 'BULLISH') bullish3m++;
    if (cls === 'BEARISH') bearish3m++;
  }

  if (bullish3m >= bearish3m && bullish3m > 0) {
    return { direction: 'BULLISH', count: bullish3m, total: total3m };
  }
  if (bearish3m > 0) {
    return { direction: 'BEARISH', count: bearish3m, total: total3m };
  }
  return { direction: null, count: 0, total: total3m };
}

/**
 * Timeframe confirmation: does 1m agree with 3m for a given ticker+indicator?
 */
export function getTimeframeConfirmation(ticker = 'spx') {
  const tkr = ticker.toLowerCase();
  const results = [];

  for (const ind of INDICATORS) {
    if (ind === 'echo' && !ECHO_TICKERS.includes(tkr)) continue;
    const sig1 = signalState[makeKey(tkr, ind, '1')];
    const sig3 = signalState[makeKey(tkr, ind, '3')];
    if (!sig1 || !sig3) continue;

    const cls1 = classifySignal(ind, sig1.state, sig1.isStale);
    const cls3 = classifySignal(ind, sig3.state, sig3.isStale);
    const agrees = cls1 === cls3 && cls1 !== 'NEUTRAL';

    results.push({ indicator: ind, tf1: cls1, tf3: cls3, agrees });
  }

  return results;
}

/**
 * Calculate TV confidence level (label only, NOT an entry gate).
 * MASTER: 3/3 SPX 3m indicators agree
 * INTERMEDIATE: 2/3 agree
 * BEGINNER: 1/3 agree
 * NONE: 0/3 or conflicting
 */
export function calculateTvConfidence() {
  const alignment = getTvAlignment();
  if (alignment.count >= 3) return 'MASTER';
  if (alignment.count >= 2) return 'INTERMEDIATE';
  if (alignment.count >= 1) return 'BEGINNER';
  return 'NONE';
}

// ---- Cross-Market ----

function getCrossMarketTV() {
  let bullishTickers = 0;
  let bearishTickers = 0;

  for (const tkr of TICKERS) {
    const summary = getTickerSummary(tkr);
    if (summary.bullishScore > summary.bearishScore && summary.bullishScore > 0) bullishTickers++;
    else if (summary.bearishScore > 0) bearishTickers++;
  }

  return { bullish_tickers: bullishTickers, bearish_tickers: bearishTickers, total: TICKERS.length };
}

// ---- Snapshot (Agent Input) ----

/**
 * Full snapshot for the agent. Maintains backward-compat fields
 * while adding new multi-indicator, multi-timeframe data.
 */
export function getSignalSnapshot() {
  const spxConf = getConfirmations('spx');
  const spxStaleCount = checkStaleness();
  const crossMarket = getCrossMarketTV();
  const alignment = getTvAlignment();
  const confidence = calculateTvConfidence();
  const spxSummary = getTickerSummary('spx');

  // Build per-ticker blocks
  function tickerBlock(tkr) {
    const conf = getConfirmations(tkr);
    const summary = getTickerSummary(tkr);
    const block = {
      confirmations: conf,
      weighted_score: { bullish: summary.bullishScore, bearish: summary.bearishScore, max: summary.maxPossible },
      signals: {},
    };

    // Add individual signal states
    for (const sig of summary.signals) {
      block.signals[`${sig.indicator}_${sig.timeframe}m`] = {
        state: sig.state,
        classification: sig.classification,
        isStale: sig.isStale,
        confirmed: sig.confirmed,
        weight: sig.weight,
      };
    }

    // Backward-compat: flat bravo/tango fields (3m values)
    const bravo3 = signalState[makeKey(tkr, 'bravo', '3')];
    const tango3 = signalState[makeKey(tkr, 'tango', '3')];
    block.bravo = bravo3 ? bravo3.state : 'NONE';
    block.tango = tango3 ? tango3.state : 'NONE';

    return block;
  }

  const snapshot = {
    // Per-ticker with full signal detail
    spx: tickerBlock('spx'),
    spy: tickerBlock('spy'),
    qqq: tickerBlock('qqq'),

    // Cross-market aggregate
    cross_market: crossMarket,

    // TV alignment & confidence
    alignment: { direction: alignment.direction, count: alignment.count, total: alignment.total },
    confidence,

    // Backward-compat fields (SPX 3m)
    bravo: signalState[makeKey('spx', 'bravo', '3')]?.state || 'NONE',
    tango: signalState[makeKey('spx', 'tango', '3')]?.state || 'NONE',
    confirmations: { bullish: spxConf.bullish, bearish: spxConf.bearish, total: spxConf.total },
    bravo_confirms: spxConf.bravo_confirms,
    tango_confirms: spxConf.tango_confirms,
    stale_count: spxStaleCount,
    all_stale: spxStaleCount >= INDICATORS.length * TIMEFRAMES.length, // all SPX slots stale
  };

  return snapshot;
}

// ---- Detailed State (for Dashboard + Discord) ----

/**
 * Array of all signal objects — used by TvGrid and Discord alerts.
 */
export function getDetailedState() {
  const details = [];

  for (const [key, sig] of Object.entries(signalState)) {
    const [tkr, ind, tf] = key.split('_');
    details.push({
      key,
      indicator: `${tkr}_${ind}`,
      ticker: tkr,
      indicatorName: ind,
      timeframe: tf,
      state: sig.state,
      classification: classifySignal(ind, sig.state, sig.isStale),
      isStale: sig.isStale,
      confirmed: sig.confirmed,
      updatedAt: sig.updatedAt,
      weight: SIGNAL_WEIGHTS[`${ind}_${tf}`] || 1.0,
    });
  }

  return details;
}

// ---- Regime ----

export function getLastUpdateTime() {
  return lastUpdateTime;
}

/**
 * TV regime based on Bravo 3m Diamond signals.
 * Expires after 30 minutes.
 */
export function getTvRegime() {
  if (!tvRegime.direction) return { direction: null };

  const age = Date.now() - tvRegime.setAt;
  if (age > 30 * 60 * 1000) {
    return { direction: null, expired: true };
  }

  return { ...tvRegime, ageMs: age };
}

// ---- DB Persistence ----

/**
 * Load signal state from SQLite on startup.
 * Handles old format (bravo), medium format (spx_bravo), and new format (spx_bravo_3).
 */
export function loadFromDb(rows) {
  for (const row of rows) {
    const rawKey = row.indicator.toLowerCase();

    let key;
    const parts = rawKey.split('_');

    if (parts.length === 3 && signalState[rawKey]) {
      // New format: spx_bravo_3
      key = rawKey;
    } else if (parts.length === 2 && TICKERS.includes(parts[0])) {
      // Medium format: spx_bravo → default to 3m
      key = `${rawKey}_3`;
    } else if (INDICATORS.includes(parts[0])) {
      // Old format: bravo → spx_bravo_3
      key = `spx_${rawKey}_3`;
    } else {
      continue;
    }

    if (signalState[key]) {
      signalState[key] = {
        state: row.state,
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
        isStale: !!row.is_stale,
        confirmed: true, // DB rows are always confirmed
      };
    }
  }
  log.info('Loaded signal state from database');
}

/**
 * Get raw state for DB persistence.
 * Uses full key format: spx_bravo_3, spy_tango_1, etc.
 */
export function getStateForDb() {
  const entries = [];
  for (const [key, data] of Object.entries(signalState)) {
    entries.push({
      indicator: key,
      state: data.state || 'NONE',
      level: null,
      kind: null,
      updatedAt: data.updatedAt ? formatET(nowET()) : null,
      isStale: data.isStale ? 1 : 0,
    });
  }
  return entries;
}
