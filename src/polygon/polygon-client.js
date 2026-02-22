/**
 * Polygon.io REST Client
 * Thin wrapper around Polygon REST API for SPX options data.
 * Free tier: 5 req/min, 15-min delayed quotes.
 */

import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Polygon');

const BASE_URL = 'https://api.polygon.io';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5; // free tier: 5 calls/min

// Rate limiter state
const requestTimestamps = [];

// ---- Rate Limiting ----

function waitForRateLimit() {
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 100;
    log.warn(`Rate limit approaching, waiting ${waitMs}ms`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return Promise.resolve();
}

function recordRequest() {
  requestTimestamps.push(Date.now());
}

// ---- Core Fetch ----

async function polygonFetch(path, params = {}) {
  await waitForRateLimit();

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apiKey', config.polygonApiKey);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      recordRequest();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'User-Agent': 'OpenClaw/3.0' },
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
        log.warn(`Rate limited (429), waiting ${retryAfter}s before retry`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (res.status === 403 || res.status === 401) {
        // Auth errors are not transient — don't retry
        const body = await res.text().catch(() => '');
        throw new Error(`Polygon ${res.status}: ${body.slice(0, 100)}`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Polygon ${res.status}: ${body.slice(0, 200)}`);
      }

      return await res.json();
    } catch (err) {
      const isAuthError = err.message.includes('Polygon 403') || err.message.includes('Polygon 401');
      if (isAuthError) throw err; // Don't retry auth errors

      if (err.name === 'AbortError') {
        log.warn(`Request timeout (attempt ${attempt}/${MAX_RETRIES}): ${path}`);
      } else if (attempt < MAX_RETRIES) {
        log.warn(`Request failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      } else {
        throw err;
      }
      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// ---- Ticker Builder ----

/**
 * Build OCC-format options ticker.
 * Example: buildOptionsTicker('SPXW', '2026-02-20', 'C', 6900) → 'O:SPXW260220C06900000'
 */
export function buildOptionsTicker(underlying, expirationDate, type, strike) {
  const [year, month, day] = expirationDate.split('-');
  const yy = year.slice(2);
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `O:${underlying}${yy}${month}${day}${type.toUpperCase()}${strikeStr}`;
}

// ---- API Methods ----

/**
 * List options contracts for a given expiration date.
 */
export async function listContracts(expirationDate, opts = {}) {
  const params = {
    underlying_ticker: 'SPX',
    expiration_date: expirationDate,
    contract_type: opts.type, // 'call' or 'put' or undefined for both
    limit: opts.limit || 250,
    order: 'asc',
    sort: 'strike_price',
  };

  const data = await polygonFetch('/v3/reference/options/contracts', params);
  return data?.results || [];
}

/**
 * Get snapshot for a single options contract (includes greeks + quote).
 */
export async function getContractSnapshot(contractTicker) {
  // contractTicker format: O:SPXW260220C06900000
  const underlying = 'SPX';
  const data = await polygonFetch(`/v3/snapshot/options/${underlying}/${contractTicker}`);
  return data?.results || null;
}

/**
 * Get full chain snapshot for an expiration date.
 * Returns all contracts with greeks and quotes.
 */
export async function getChainSnapshot(expirationDate) {
  const params = {
    'expiration_date': expirationDate,
    limit: 250,
  };

  const data = await polygonFetch('/v3/snapshot/options/SPX', params);
  const results = data?.results || [];

  // Handle pagination if needed
  let allResults = [...results];
  let nextUrl = data?.next_url;

  while (nextUrl && allResults.length < 1000) {
    await waitForRateLimit();
    recordRequest();
    const res = await fetch(`${nextUrl}&apiKey=${config.polygonApiKey}`, {
      headers: { 'User-Agent': 'OpenClaw/3.0' },
    });
    if (!res.ok) break;
    const page = await res.json();
    allResults = allResults.concat(page?.results || []);
    nextUrl = page?.next_url;
  }

  return allResults;
}

/**
 * Get SPX previous day aggregate (backup price source).
 * Tries I:SPX (index ticker) first, then SPY as fallback.
 */
export async function getSpxPrevDay() {
  // Try index ticker first
  for (const ticker of ['I:SPX', 'SPY']) {
    try {
      const data = await polygonFetch(`/v2/aggs/ticker/${ticker}/prev`);
      const result = data?.results?.[0];
      if (result) {
        const price = ticker === 'SPY' ? result.c * 10 : result.c; // SPY ≈ SPX/10
        return {
          close: price,
          open: ticker === 'SPY' ? result.o * 10 : result.o,
          high: ticker === 'SPY' ? result.h * 10 : result.h,
          low: ticker === 'SPY' ? result.l * 10 : result.l,
          volume: result.v,
          vwap: result.vw,
          source: ticker,
        };
      }
    } catch (err) {
      log.debug(`${ticker} prev day fetch failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Check if Polygon API is available (key is set).
 */
export function isPolygonAvailable() {
  return !!config.polygonApiKey;
}

/**
 * Quick connectivity test — fetch SPX prev day.
 */
export async function testConnection() {
  try {
    const prev = await getSpxPrevDay();
    if (prev?.close) {
      log.info(`Polygon connected — SPX prev close: $${prev.close}`);
      return true;
    }
    log.warn('Polygon returned no data');
    return false;
  } catch (err) {
    log.error(`Polygon connection failed: ${err.message}`);
    return false;
  }
}
