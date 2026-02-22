/**
 * Price Feed
 * Provides current SPX price from Heatseeker (primary) or Polygon (backup).
 * Heatseeker gives real-time spot; Polygon free tier is 15-min delayed.
 */

import { getSpxPrevDay, isPolygonAvailable } from './polygon-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PriceFeed');

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Cached spot from Heatseeker (updated each main loop cycle)
let heatseekerSpot = { price: null, updatedAt: 0 };

// Cached Polygon prev-day close
let polygonCache = { close: null, fetchedAt: 0 };
const POLYGON_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Called by main loop each cycle with the latest Heatseeker spot price.
 */
export function updateHeatseekerSpot(spotPrice) {
  if (spotPrice && spotPrice > 0) {
    heatseekerSpot = { price: spotPrice, updatedAt: Date.now() };
  }
}

/**
 * Get the best available SPX price.
 * Primary: Heatseeker real-time spot (fresh if <2 min).
 * Backup: Polygon prev-day close (15-min delayed, cached 10 min).
 */
export async function getSpxPrice() {
  const now = Date.now();

  // Primary: Heatseeker
  if (heatseekerSpot.price) {
    const staleMs = now - heatseekerSpot.updatedAt;
    if (staleMs < STALE_THRESHOLD_MS) {
      return {
        price: heatseekerSpot.price,
        source: 'heatseeker',
        staleMs,
      };
    }
    // Still return it but flag as stale
    log.warn(`Heatseeker spot is stale (${Math.round(staleMs / 1000)}s old)`);
    return {
      price: heatseekerSpot.price,
      source: 'heatseeker-stale',
      staleMs,
    };
  }

  // Backup: Polygon prev-day close
  if (isPolygonAvailable()) {
    if (polygonCache.close && (now - polygonCache.fetchedAt) < POLYGON_CACHE_TTL_MS) {
      return {
        price: polygonCache.close,
        source: 'polygon-prev-close',
        staleMs: now - polygonCache.fetchedAt,
      };
    }

    try {
      const prev = await getSpxPrevDay();
      if (prev?.close) {
        polygonCache = { close: prev.close, fetchedAt: now };
        return {
          price: prev.close,
          source: 'polygon-prev-close',
          staleMs: 0,
        };
      }
    } catch (err) {
      log.error(`Polygon price fetch failed: ${err.message}`);
    }
  }

  return { price: null, source: 'unavailable', staleMs: Infinity };
}
