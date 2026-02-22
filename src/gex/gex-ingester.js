/**
 * GEX Ingester — Fetches data from Heatseeker API.
 * Uses TokenManager for automatic JWT refresh via Clerk.
 */

import { DATA_API } from './constants.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { getFreshToken, getAuthStatus } from './token-manager.js';

const log = createLogger('GEX-Ingester');

/**
 * Fetch raw GEX data from the Heatseeker API.
 */
export async function fetchGexData(symbol = 'SPXW') {
  const url = DATA_API(symbol);
  const headers = {};

  // Get a fresh JWT (auto-refreshed via Clerk, or static fallback)
  const token = await getFreshToken();
  headers['Authorization'] = `Bearer ${token}`;

  // Also add cookies if configured (belt + suspenders)
  if (config.heatseekerCookies) {
    headers['Cookie'] = config.heatseekerCookies;
  }

  const auth = getAuthStatus();
  log.debug(`Fetching ${symbol} | Auth: ${auth.method} | JWT TTL: ${auth.cachedJwtTtlSeconds}s`);

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      `AUTH_EXPIRED: Heatseeker returned ${resp.status}. ` +
      (auth.method === 'clerk-auto-refresh'
        ? 'Clerk session may have expired — log into app.skylit.ai and update CLERK_CLIENT_COOKIE in .env'
        : 'Refresh your JWT token in .env')
    );
  }

  if (!resp.ok) {
    throw new Error(`Heatseeker API error: HTTP ${resp.status}`);
  }

  const data = await resp.json();

  if (!data.CurrentSpot || !data.GammaValues) {
    throw new Error('Invalid API response — missing CurrentSpot or GammaValues');
  }

  log.debug(`Got data: Spot=$${data.CurrentSpot} | ${data.Expirations?.length || 0} expirations | ${data.GammaValues?.length || 0} strikes`);

  return data;
}
