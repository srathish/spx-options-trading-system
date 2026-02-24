/**
 * REST API client for the dashboard backend.
 * All requests go through Next.js rewrites → localhost:3002.
 */

const BASE = '';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function fetchStatus() {
  return fetchJson('/api/status');
}

export function fetchPosition() {
  return fetchJson('/api/position');
}

export function fetchTodaysTrades() {
  return fetchJson('/api/trades/today');
}

export function fetchPhantoms() {
  return fetchJson('/api/phantoms');
}

export function fetchPerformance() {
  return fetchJson('/api/performance');
}

export function fetchSystemHealth() {
  return fetchJson('/api/system/health');
}

export function fetchCosts() {
  return fetchJson('/api/system/costs');
}

export function fetchDecisions() {
  return fetchJson('/api/decisions');
}

export function fetchTrinity() {
  return fetchJson('/api/trinity');
}

export function fetchStrategyBriefing() {
  return fetchJson('/api/strategy/briefing');
}

export function fetchStrategyVersions() {
  return fetchJson('/api/strategy/versions');
}

export function fetchStrategyRollbacks() {
  return fetchJson('/api/strategy/rollbacks');
}

export function fetchActiveStrategy() {
  return fetchJson('/api/strategy/active');
}

// ---- Trade Ideas ----

export function fetchTradeIdeas(date) {
  const query = date ? `?date=${date}` : '';
  return fetchJson(`/api/trade-ideas${query}`);
}

// ---- Alerts ----

export function fetchAlerts(limit = 50) {
  return fetchJson(`/api/alerts?limit=${limit}`);
}

// ---- Chat ----

export async function sendChatMessage(message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Chat error: ${res.status}`);
  return res.json();
}

export function fetchChatHistory() {
  return fetchJson('/api/chat/history');
}
