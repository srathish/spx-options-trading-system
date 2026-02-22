/**
 * Alert throttling and deduplication.
 * Wraps the state.js dedup logic with a clean API for the main loop.
 */

import { isDuplicateAlert, recordAlert } from '../store/state.js';

/**
 * Check if an alert should be sent (not a duplicate).
 * If allowed, records the alert for future dedup.
 * Returns true if the alert should be sent.
 */
export function shouldSendAlert(alertType, strike = 0, data = {}) {
  // Direction flips always fire (no dedup)
  if (alertType === 'DIRECTION_FLIP') {
    recordAlert(alertType, { strike, ...data });
    return true;
  }

  if (isDuplicateAlert(alertType, strike)) {
    return false;
  }

  recordAlert(alertType, { strike, ...data });
  return true;
}
