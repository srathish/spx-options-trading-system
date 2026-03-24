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
  // Get a fresh JWT (auto-refreshed via Clerk, or static fallback)
  const token = await getFreshToken();

  // New API: token goes in URL query param, not header
  const url = DATA_API(symbol, token);
  const headers = {
    'Origin': 'https://app.skylit.ai',
    'Referer': 'https://app.skylit.ai/',
  };

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

  const contentType = resp.headers.get('content-type') || '';

  // Handle SSE (Server-Sent Events) stream — new API format
  if (contentType.includes('text/event-stream')) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let collected = '';
    const start = Date.now();
    let snapshotData = null;
    let velocityData = null;

    // Read until we get both snapshot + velocity, or timeout after 10s
    while (Date.now() - start < 10000) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });

      // Parse complete SSE events (separated by double newlines)
      const events = collected.split('\n\n');
      // Keep the last potentially incomplete event in the buffer
      collected = events.pop() || '';

      for (const event of events) {
        const lines = event.trim().split('\n');
        const eventType = lines.find(l => l.startsWith('event:'))?.replace('event:', '').trim();
        const dataLine = lines.find(l => l.startsWith('data:'))?.replace('data:', '').trim();
        if (!dataLine) continue;

        try {
          const parsed = JSON.parse(dataLine);

          // snapshot_update: classic GEX format inside .data
          if (eventType === 'snapshot_update' && parsed.data?.CurrentSpot) {
            snapshotData = parsed.data;
          }

          // velocity_update: rate-of-change data for each strike
          if (eventType === 'velocity_update' && parsed.data?.topRisers) {
            velocityData = parsed.data;
          }
        } catch (e) {
          // Incomplete JSON, skip
        }
      }

      // Got snapshot — that's the minimum we need. Velocity is bonus.
      if (snapshotData) break;
    }
    reader.cancel();

    if (!snapshotData) {
      log.warn(`SSE stream for ${symbol}: no snapshot_update received in 10s`);
      throw new Error(`No GEX data in SSE stream for ${symbol}`);
    }

    // Attach velocity data to the snapshot for downstream use
    if (velocityData) {
      snapshotData._velocity = {
        topRisers: (velocityData.topRisers || []).slice(0, 10).map(r => ({
          strike: r.strike, value: r.currentValue,
          delta1m: r.delta1Min, delta5m: r.delta5Min, delta15m: r.delta15Min, delta1h: r.delta1Hour,
          pct1m: r.percent1Min, pct5m: r.percent5Min, pct15m: r.percent15Min, pct1h: r.percent1Hour,
          velocity: r.velocity, trend: r.trend,
        })),
        topFallers: (velocityData.topFallers || []).slice(0, 10).map(r => ({
          strike: r.strike, value: r.currentValue,
          delta1m: r.delta1Min, delta5m: r.delta5Min, delta15m: r.delta15Min, delta1h: r.delta1Hour,
          pct1m: r.percent1Min, pct5m: r.percent5Min, pct15m: r.percent15Min, pct1h: r.percent1Hour,
          velocity: r.velocity, trend: r.trend,
        })),
        timestamp: velocityData.timestamp,
      };
      log.debug(`Got velocity: ${velocityData.topRisers?.length || 0} risers, ${velocityData.topFallers?.length || 0} fallers`);
    }

    log.debug(`Got data (SSE snapshot): Spot=$${snapshotData.CurrentSpot} | ${snapshotData.GammaValues?.length || 0} strikes | ${snapshotData.Expirations?.length || 0} exp`);
    return snapshotData;
  }

  // Handle regular JSON response (legacy)
  const data = await resp.json();

  if (!data.CurrentSpot || !data.GammaValues) {
    throw new Error('Invalid API response — missing CurrentSpot or GammaValues');
  }

  log.debug(`Got data: Spot=$${data.CurrentSpot} | ${data.Expirations?.length || 0} expirations | ${data.GammaValues?.length || 0} strikes`);

  return data;
}
