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

    // Read until we get a gex_update or snapshot event, or timeout after 8s
    while (Date.now() - start < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });

      // Look for a complete SSE event with GEX data
      // Events are separated by double newlines: "event: X\ndata: {...}\n\n"
      const events = collected.split('\n\n');
      for (const event of events) {
        const lines = event.trim().split('\n');
        const eventType = lines.find(l => l.startsWith('event:'))?.replace('event:', '').trim();
        const dataLine = lines.find(l => l.startsWith('data:'))?.replace('data:', '').trim();

        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine);

          // snapshot_update contains classic format inside .data
          if (eventType === 'snapshot_update' && parsed.data?.CurrentSpot) {
            reader.cancel();
            const d = parsed.data;
            log.debug(`Got data (SSE snapshot): Spot=$${d.CurrentSpot} | ${d.GammaValues?.length || 0} strikes | ${d.Expirations?.length || 0} exp`);
            return d;
          }

          // Fallback: direct classic format
          if (parsed.CurrentSpot && parsed.GammaValues) {
            reader.cancel();
            log.debug(`Got data (SSE ${eventType}): Spot=$${parsed.CurrentSpot} | ${parsed.GammaValues?.length || 0} strikes`);
            return parsed;
          }
        } catch (e) {
          // Not valid JSON yet, keep reading
        }
      }
    }
    reader.cancel();

    // If we got here, dump what we collected for debugging
    log.warn(`SSE stream for ${symbol}: got ${collected.length} bytes but no GEX data found`);
    log.debug(`SSE events received: ${collected.substring(0, 500)}`);
    throw new Error(`No GEX data in SSE stream for ${symbol}`);
  }

  // Handle regular JSON response (legacy)
  const data = await resp.json();

  if (!data.CurrentSpot || !data.GammaValues) {
    throw new Error('Invalid API response — missing CurrentSpot or GammaValues');
  }

  log.debug(`Got data: Spot=$${data.CurrentSpot} | ${data.Expirations?.length || 0} expirations | ${data.GammaValues?.length || 0} strikes`);

  return data;
}
