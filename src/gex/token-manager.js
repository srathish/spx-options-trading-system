/**
 * Token Manager — Automatic JWT refresh via Clerk's token endpoint.
 *
 * Clerk auth flow:
 *   1. __client cookie (long-lived, rotating) is stored in .env / DB
 *   2. POST to clerk.skylit.ai/v1/client/sessions/{session}/tokens
 *   3. Clerk returns a fresh short-lived JWT (~60s)
 *   4. We use that JWT as Authorization: Bearer for Heatseeker API
 *   5. If Clerk rotates the __client cookie, we capture and store the new one
 *
 * Result: Log in once, never touch it again.
 */

import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TokenMgr');

// Cached token state
let cachedJwt = null;
let cachedJwtExpiry = 0;

// Current __client cookie (may rotate)
let currentClientCookie = null;

const TOKEN_BUFFER_MS = 5000; // refresh 5s before expiry
const CLERK_BASE = 'https://clerk.skylit.ai';
const CLERK_API_VERSION = '2025-11-10';
const CLERK_JS_VERSION = '5.124.0';

/**
 * Initialize the token manager with stored credentials.
 */
export function initTokenManager() {
  currentClientCookie = config.clerkClientCookie || '';

  if (!config.clerkSessionId || !currentClientCookie) {
    log.warn('Clerk credentials not configured — set CLERK_SESSION_ID and CLERK_CLIENT_COOKIE in .env');
    log.warn('Falling back to static HEATSEEKER_JWT (will expire quickly)');
    return false;
  }

  log.info(`Token manager initialized | Session: ${config.clerkSessionId.slice(0, 20)}...`);
  return true;
}

/**
 * Get a fresh JWT token for Heatseeker API calls.
 * Automatically refreshes via Clerk when needed.
 */
export async function getFreshToken() {
  // If we have a valid cached JWT, use it
  if (cachedJwt && Date.now() < cachedJwtExpiry) {
    return cachedJwt;
  }

  // Try Clerk token refresh
  if (config.clerkSessionId && currentClientCookie) {
    try {
      const token = await refreshViaClerk();
      if (token) return token;
    } catch (err) {
      log.error('Clerk token refresh failed:', err.message);
    }
  }

  // Fallback to static JWT from .env
  if (config.heatseekerJwt) {
    log.debug('Using static JWT from .env (may be expired)');
    return config.heatseekerJwt;
  }

  throw new Error('No auth available — configure Clerk credentials or HEATSEEKER_JWT in .env');
}

/**
 * Refresh the JWT via Clerk's token endpoint.
 */
async function refreshViaClerk() {
  const sessionId = config.clerkSessionId;
  const url = `${CLERK_BASE}/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;

  log.debug('Refreshing JWT via Clerk...');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `__client=${currentClientCookie}; __client_uat=${config.clerkClientUat || ''}`,
      'Origin': 'https://app.skylit.ai',
      'Referer': 'https://app.skylit.ai/',
    },
    body: '', // Clerk's token endpoint accepts empty body
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Clerk returned ${resp.status}: ${text.slice(0, 200)}`);
  }

  // Check for cookie rotation in Set-Cookie header
  const setCookie = resp.headers.get('set-cookie') || '';
  if (setCookie.includes('__client=')) {
    const match = setCookie.match(/__client=([^;]+)/);
    if (match && match[1] !== currentClientCookie) {
      log.info('Clerk rotated __client cookie — updating stored value');
      currentClientCookie = match[1];
      // Note: In production, we'd persist this to DB. For now, it stays in memory
      // and the .env value is used on next restart.
    }
  }

  const data = await resp.json();

  // Clerk returns { jwt: "eyJ..." } or { object: "token", jwt: "eyJ..." }
  const jwt = data.jwt;
  if (!jwt) {
    throw new Error('No JWT in Clerk response: ' + JSON.stringify(data).slice(0, 200));
  }

  // Parse JWT expiry (without verification — we trust Clerk)
  const payload = parseJwtPayload(jwt);
  const expiresAt = payload.exp ? payload.exp * 1000 : Date.now() + 55000; // default ~55s

  cachedJwt = jwt;
  cachedJwtExpiry = expiresAt - TOKEN_BUFFER_MS;

  const ttlSec = Math.round((expiresAt - Date.now()) / 1000);
  log.debug(`Got fresh JWT (expires in ${ttlSec}s)`);

  return jwt;
}

/**
 * Parse JWT payload without verification (just base64 decode).
 */
function parseJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return {};
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

/**
 * Get the current auth status (for health checks / CLI).
 */
export function getAuthStatus() {
  const hasClerk = !!(config.clerkSessionId && currentClientCookie);
  const hasStaticJwt = !!config.heatseekerJwt;
  const hasCachedJwt = !!(cachedJwt && Date.now() < cachedJwtExpiry);
  const ttl = hasCachedJwt ? Math.round((cachedJwtExpiry - Date.now()) / 1000) : 0;

  return {
    method: hasClerk ? 'clerk-auto-refresh' : hasStaticJwt ? 'static-jwt' : 'none',
    clerkConfigured: hasClerk,
    cachedJwtValid: hasCachedJwt,
    cachedJwtTtlSeconds: ttl,
  };
}
