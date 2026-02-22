/**
 * Loop Status — Neutral module for sharing main-loop state.
 * Breaks circular import between main-loop.js and dashboard-server.js.
 */

let status = {
  running: false,
  phase: 'UNKNOWN',
  description: 'Not started',
  cycleCount: 0,
  lastSpot: null,
  lastScore: null,
  lastDirection: null,
  pollIntervalMs: 0,
  startedAt: null,
};

export function updateLoopStatus(data) {
  Object.assign(status, data);
}

export function getLoopStatus() {
  return { ...status };
}

export function getLoopPhase() {
  return status.phase;
}
