/**
 * Options Chain Fetcher
 * Fetches and normalizes 0DTE SPX options chain from Polygon.io.
 * Only called when a signal fires, not every 30s cycle.
 */

import { getChainSnapshot } from './polygon-client.js';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Chain');

const STRIKE_RANGE = 30; // +/- 30 strikes from ATM ($5 increments = +/- $150)

/**
 * Get today's expiration date in YYYY-MM-DD format (ET).
 */
export function getTodayExpiration() {
  return nowET().toFormat('yyyy-MM-dd');
}

/**
 * Normalize a Polygon snapshot result into our standard format.
 */
function normalizeContract(raw) {
  const details = raw.details || {};
  const greeks = raw.greeks || {};
  const quote = raw.last_quote || {};
  const day = raw.day || {};

  const bid = quote.bid || 0;
  const ask = quote.ask || 0;
  const midpoint = bid && ask ? (bid + ask) / 2 : raw.fair_market_value || 0;

  return {
    ticker: details.ticker || raw.ticker,
    strike: details.strike_price,
    type: details.contract_type, // 'call' or 'put'
    expiration: details.expiration_date,
    greeks: {
      delta: greeks.delta || 0,
      gamma: greeks.gamma || 0,
      theta: greeks.theta || 0,
      vega: greeks.vega || 0,
      iv: raw.implied_volatility || 0,
    },
    lastQuote: {
      bid,
      ask,
      midpoint,
      spread: ask - bid,
      spreadPct: bid > 0 ? ((ask - bid) / bid) * 100 : 999,
    },
    openInterest: raw.open_interest || 0,
    volume: day.volume || 0,
    fmv: raw.fair_market_value || midpoint,
  };
}

/**
 * Fetch the 0DTE chain filtered around the current spot price.
 * Returns { calls, puts, expiration, atm, spotPrice }.
 */
export async function fetch0DteChain(spotPrice) {
  const expiration = getTodayExpiration();
  log.info(`Fetching 0DTE chain: exp=${expiration}, spot=$${spotPrice}`);

  const raw = await getChainSnapshot(expiration);

  if (!raw || raw.length === 0) {
    log.warn('No chain data returned from Polygon');
    return null;
  }

  log.info(`Raw chain: ${raw.length} contracts`);

  // Determine ATM strike (nearest $5 increment)
  const atm = Math.round(spotPrice / 5) * 5;
  const minStrike = atm - STRIKE_RANGE * 5;
  const maxStrike = atm + STRIKE_RANGE * 5;

  // Filter and normalize
  const calls = [];
  const puts = [];

  for (const contract of raw) {
    const details = contract.details || {};
    const strike = details.strike_price;

    if (!strike || strike < minStrike || strike > maxStrike) continue;

    const normalized = normalizeContract(contract);
    if (!normalized.strike) continue;

    if (details.contract_type === 'call') {
      calls.push(normalized);
    } else if (details.contract_type === 'put') {
      puts.push(normalized);
    }
  }

  // Sort by strike
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);

  log.info(`Chain filtered: ${calls.length} calls, ${puts.length} puts, ATM=$${atm}`);

  return { calls, puts, expiration, atm, spotPrice };
}
