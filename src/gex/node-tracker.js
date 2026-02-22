/**
 * Node Touch Tracker
 * Tracks how many times price has tested (touched) significant GEX nodes
 * within the current trading day.
 */

import { NODE_TOUCH } from './constants.js';

// { [strike]: { touches, lastTouch, broke, direction } }
let touchCounts = {};
let lastSpot = null;

/**
 * Update node touch counts based on current spot price and walls.
 * Called every cycle from the main loop.
 */
export function updateNodeTouches(spotPrice, walls) {
  const now = Date.now();

  for (const wall of walls) {
    const distPct = Math.abs(spotPrice - wall.strike) / spotPrice * 100;
    const key = wall.strike;

    // Initialize tracking for this strike if needed
    if (!touchCounts[key]) {
      touchCounts[key] = {
        touches: 0,
        lastTouch: 0,
        broke: false,
        direction: wall.relativeToSpot,
      };
    }

    const entry = touchCounts[key];

    // Check if price is touching this wall (within proximity threshold)
    if (distPct <= NODE_TOUCH.PROXIMITY_PCT) {
      // Only count as new touch if at least 60 seconds since last touch
      if (now - entry.lastTouch > 60_000) {
        entry.touches++;
        entry.lastTouch = now;
      }
    }

    // Check if price has broken through the wall
    if (!entry.broke) {
      const breakDist = NODE_TOUCH.BREAK_CONFIRMATION_PCT / 100 * spotPrice;
      if (wall.relativeToSpot === 'above' && spotPrice > wall.strike + breakDist) {
        entry.broke = true;
      } else if (wall.relativeToSpot === 'below' && spotPrice < wall.strike - breakDist) {
        entry.broke = true;
      }
    }
  }

  lastSpot = spotPrice;
}

/**
 * Get all node touch counts (for agent input).
 * Returns object keyed by strike.
 */
export function getNodeTouches() {
  // Only return strikes with at least 1 touch
  const result = {};
  for (const [strike, data] of Object.entries(touchCounts)) {
    if (data.touches > 0) {
      result[strike] = {
        touches: data.touches,
        broke: data.broke,
        direction: data.direction,
      };
    }
  }
  return result;
}

/**
 * Get touch count for a specific strike.
 */
export function getTouchCount(strike) {
  return touchCounts[strike]?.touches || 0;
}

/**
 * Reset all node touch tracking (called at start of each trading day).
 */
export function resetNodeTouches() {
  touchCounts = {};
  lastSpot = null;
}
