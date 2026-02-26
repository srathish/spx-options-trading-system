/**
 * Entry Quality Gates
 * Centralized pre-entry validation. Every entry (Lane A or Lane B) must pass ALL gates.
 * Replaces validateEntryGuardrails() from main-loop.js.
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
import { getSpotMomentum, isDirectionStable, hadRecentDirectionFlip, detectChopMode } from '../store/state.js';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EntryGates');

// ---- In-memory gate state ----

let lastEntryTime = 0;
let todayTradeCount = 0;
let lastExitTime = 0;
let lastExitDirection = null;
let consecutiveLosses = { BULLISH: 0, BEARISH: 0 };
let consecutiveLossCooldownUntil = { BULLISH: 0, BEARISH: 0 };

// ---- Main gate check ----

/**
 * Check all entry quality gates. Returns { allowed, reason }.
 * @param {string} action - 'ENTER_CALLS' or 'ENTER_PUTS'
 * @param {object} scored - Scored GEX state
 * @param {object} multiAnalysis - Multi-ticker analysis
 */
export function checkEntryGates(action, scored, multiAnalysis) {
  const direction = action === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';
  const cfg = getActiveConfig() || {};
  const etNow = nowET();
  const timeET = `${String(etNow.hour).padStart(2, '0')}:${String(etNow.minute).padStart(2, '0')}`;

  // Gate 1: 60s minimum spacing between ANY entries
  const minSpacing = cfg.entry_min_spacing_ms ?? 60_000;
  if (lastEntryTime > 0 && (Date.now() - lastEntryTime) < minSpacing) {
    const remaining = Math.round((minSpacing - (Date.now() - lastEntryTime)) / 1000);
    return { allowed: false, reason: `Entry spacing: ${remaining}s until next entry allowed` };
  }

  // Gate 2: 9:30-9:33 blackout (no entries in first 3 min of open)
  const blackoutStart = cfg.entry_blackout_start || '09:30';
  const blackoutEnd = cfg.entry_blackout_end || '09:33';
  if (timeET >= blackoutStart && timeET < blackoutEnd) {
    return { allowed: false, reason: `Blackout: no entries ${blackoutStart}-${blackoutEnd}` };
  }

  // Gate 3: Consecutive same-direction loss cooldown
  const cooldownUntil = consecutiveLossCooldownUntil[direction] || 0;
  if (Date.now() < cooldownUntil) {
    const remaining = Math.round((cooldownUntil - Date.now()) / 60_000);
    return { allowed: false, reason: `Loss cooldown: ${consecutiveLosses[direction]} consecutive ${direction} losses, ${remaining}m remaining` };
  }

  // Gate 4: TV Regime gate (Pink Diamond = no calls, Blue Diamond = no puts)
  const tvRegime = getTvRegime();
  if (tvRegime.direction) {
    if (direction === 'BULLISH' && tvRegime.direction === 'BEARISH') {
      const ageMin = tvRegime.setAt ? Math.round((Date.now() - tvRegime.setAt) / 60000) : '?';
      return { allowed: false, reason: `TV regime BEARISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${ageMin}m ago) — need Blue Diamond for calls` };
    }
    if (direction === 'BEARISH' && tvRegime.direction === 'BULLISH') {
      const ageMin = tvRegime.setAt ? Math.round((Date.now() - tvRegime.setAt) / 60000) : '?';
      return { allowed: false, reason: `TV regime BULLISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${ageMin}m ago) — need Pink Diamond for puts` };
    }
  }

  // Gate 5: Re-entry cooldown (same direction, after exit)
  if (lastExitTime > 0 && lastExitDirection === direction) {
    const reentryMs = cfg.entry_min_spacing_ms ?? 60_000; // Use same spacing
    const elapsed = Date.now() - lastExitTime;
    if (elapsed < reentryMs) {
      const remaining = Math.round((reentryMs - elapsed) / 1000);
      return { allowed: false, reason: `Re-entry cooldown: exited ${direction} ${Math.round(elapsed / 1000)}s ago, wait ${remaining}s` };
    }
  }

  // Gate 6: Max trades per day
  const maxTrades = cfg.max_trades_per_day ?? 8;
  if (todayTradeCount >= maxTrades) {
    return { allowed: false, reason: `Max trades reached: ${todayTradeCount}/${maxTrades}` };
  }

  // Gate 7: Direction stability — must be stable for 3 cycles
  if (!isDirectionStable('SPXW', 3)) {
    return { allowed: false, reason: 'Unstable direction: not stable for 3 consecutive cycles' };
  }

  // Gate 8: Recent direction flip — wait 4 cycles
  if (hadRecentDirectionFlip('SPXW', 4)) {
    return { allowed: false, reason: 'Direction flipped in last 4 cycles — wait for stabilization' };
  }

  // Gate 9: No entries after 3:00 PM ET (0DTE theta decay)
  const noEntryAfter = cfg.no_entry_after || '15:00';
  if (timeET >= noEntryAfter) {
    return { allowed: false, reason: `Time gate: no entries after ${noEntryAfter} ET` };
  }

  // Gate 10: Opening caution 9:33-9:40 (higher thresholds)
  if (timeET >= '09:33' && timeET < '09:40') {
    if (scored.score < 85) {
      return { allowed: false, reason: `Opening caution: score ${scored.score} < 85 before 09:40` };
    }
    const alignment = multiAnalysis?.alignment?.count || 0;
    if (alignment < 3) {
      return { allowed: false, reason: `Opening caution: alignment ${alignment}/3 < 3/3 before 09:40` };
    }
  }

  // Gate 11: Chop mode — higher score required
  const chopResult = detectChopMode('SPXW', cfg.chop_lookback_cycles || 60);
  if (chopResult.isChop && scored.score < (cfg.gex_strong_score || 80)) {
    return { allowed: false, reason: `Chop mode (${chopResult.reason}) — need score >= ${cfg.gex_strong_score || 80}, got ${scored.score}` };
  }

  return { allowed: true };
}

// ---- State Tracking ----

/**
 * Record that an entry was made. Call after successful trade/phantom entry.
 */
export function recordEntryForGates() {
  lastEntryTime = Date.now();
  todayTradeCount++;
}

/**
 * Record that a position was exited. Tracks loss streaks for cooldown.
 * @param {string} direction - 'BULLISH' or 'BEARISH'
 * @param {boolean} isLoss - Whether the trade was a loss
 */
export function recordExitForGates(direction, isLoss) {
  lastExitTime = Date.now();
  lastExitDirection = direction;

  if (isLoss) {
    consecutiveLosses[direction] = (consecutiveLosses[direction] || 0) + 1;
    const cfg = getActiveConfig() || {};
    const lossLimit = cfg.consecutive_loss_limit ?? 2;
    if (consecutiveLosses[direction] >= lossLimit) {
      const cooldown = cfg.consecutive_loss_cooldown_ms ?? 15 * 60_000;
      consecutiveLossCooldownUntil[direction] = Date.now() + cooldown;
      log.warn(`${direction} loss streak: ${consecutiveLosses[direction]} consecutive → ${cooldown / 60_000}m cooldown`);
    }
  } else {
    // Win resets the loss streak for that direction
    consecutiveLosses[direction] = 0;
    consecutiveLossCooldownUntil[direction] = 0;
  }
}

/**
 * Reset all daily gate state. Call at 9:25 AM daily reset.
 */
export function resetDailyGates() {
  lastEntryTime = 0;
  todayTradeCount = 0;
  lastExitTime = 0;
  lastExitDirection = null;
  consecutiveLosses = { BULLISH: 0, BEARISH: 0 };
  consecutiveLossCooldownUntil = { BULLISH: 0, BEARISH: 0 };
  log.info('Daily entry gates reset');
}

/**
 * Get current gate state for diagnostics.
 */
export function getGateState() {
  return {
    lastEntryTime,
    todayTradeCount,
    lastExitTime,
    lastExitDirection,
    consecutiveLosses: { ...consecutiveLosses },
    consecutiveLossCooldownUntil: { ...consecutiveLossCooldownUntil },
  };
}
