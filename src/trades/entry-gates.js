/**
 * Entry Quality Gates
 * Centralized pre-entry validation. Every entry (Lane A or Lane B) must pass ALL gates.
 * Replaces validateEntryGuardrails() from main-loop.js.
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
import { getSpotMomentum, isDirectionStable, hadRecentDirectionFlip, getRegime } from '../store/state.js';
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
let lastExitWasLoss = { BULLISH: false, BEARISH: false };

// Pattern-level tracking
let patternTradeCount = {};         // { 'TRIPLE_FLOOR': 5, ... }
let patternConsecutiveLosses = {};   // { 'TRIPLE_FLOOR': 3, ... }
let patternCooldownUntil = {};       // { 'TRIPLE_FLOOR': 1709312345000, ... }
let patternWins = {};                // { 'TRIPLE_FLOOR': 2, ... }
let patternTotal = {};               // { 'TRIPLE_FLOOR': 10, ... }

// ---- Main gate check ----

/**
 * Check all entry quality gates. Returns { allowed, reason }.
 * @param {string} action - 'ENTER_CALLS' or 'ENTER_PUTS'
 * @param {object} scored - Scored GEX state
 * @param {object} multiAnalysis - Multi-ticker analysis
 * @param {object} [opts] - Options
 * @param {string} [opts.lane] - 'A' or 'B' — Lane A skips TV regime gate
 * @param {string} [opts.pattern] - Pattern name for pattern-level gates
 */
export function checkEntryGates(action, scored, multiAnalysis, opts = {}) {
  const direction = action === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH';
  const cfg = getActiveConfig() || {};
  const etNow = opts.timeOverride || nowET();
  const now = opts.nowMs || Date.now();
  const timeET = `${String(etNow.hour).padStart(2, '0')}:${String(etNow.minute).padStart(2, '0')}`;

  // Gate 1: 60s minimum spacing between ANY entries (reduced during trend days after wins)
  const trendState = opts.trendState;
  const isTrendConfirmed = trendState?.isTrend && trendState.direction === direction
    && (trendState.strength === 'CONFIRMED' || trendState.strength === 'STRONG');
  const isTrendAligned = isTrendConfirmed;
  const trendWinReentry = isTrendAligned && !lastExitWasLoss[direction];
  const minSpacing = trendWinReentry
    ? (cfg.trend_reentry_spacing_ms ?? 30_000)
    : (cfg.entry_min_spacing_ms ?? 60_000);
  if (lastEntryTime > 0 && (now - lastEntryTime) < minSpacing) {
    const remaining = Math.round((minSpacing - (now - lastEntryTime)) / 1000);
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
  if (now < cooldownUntil) {
    const remaining = Math.round((cooldownUntil - now) / 60_000);
    return { allowed: false, reason: `Loss cooldown: ${consecutiveLosses[direction]} consecutive ${direction} losses, ${remaining}m remaining` };
  }

  // Gate 4: TV Regime gate (Pink Diamond = no calls, Blue Diamond = no puts)
  // Lane A is GEX-only — skip TV regime check
  const tvRegime = opts.lane === 'A' ? { direction: null } : getTvRegime();
  if (tvRegime.direction) {
    if (direction === 'BULLISH' && tvRegime.direction === 'BEARISH') {
      const ageMin = tvRegime.setAt ? Math.round((now - tvRegime.setAt) / 60000) : '?';
      return { allowed: false, reason: `TV regime BEARISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${ageMin}m ago) — need Blue Diamond for calls` };
    }
    if (direction === 'BEARISH' && tvRegime.direction === 'BULLISH') {
      const ageMin = tvRegime.setAt ? Math.round((now - tvRegime.setAt) / 60000) : '?';
      return { allowed: false, reason: `TV regime BULLISH (${tvRegime.ticker?.toUpperCase()} ${tvRegime.signal} ${ageMin}m ago) — need Pink Diamond for puts` };
    }
  }

  // Gate 5: Re-entry cooldown (same direction, after exit — reduced during trend days after wins)
  if (lastExitTime > 0 && lastExitDirection === direction) {
    const reentryMs = trendWinReentry
      ? (cfg.trend_reentry_spacing_ms ?? 30_000)
      : (cfg.entry_min_spacing_ms ?? 60_000);
    const elapsed = now - lastExitTime;
    if (elapsed < reentryMs) {
      const remaining = Math.round((reentryMs - elapsed) / 1000);
      return { allowed: false, reason: `Re-entry cooldown: exited ${direction} ${Math.round(elapsed / 1000)}s ago, wait ${remaining}s` };
    }
  }

  // Gate 6: removed (no daily trade limit)

  // Gate 7: Direction stability — must be stable for 3 cycles (skip during trend day in trend direction)
  if (!isTrendAligned && !isDirectionStable('SPXW', 3)) {
    return { allowed: false, reason: 'Unstable direction: not stable for 3 consecutive cycles' };
  }

  // Gate 8: Recent direction flip — wait 4 cycles (skip during trend day in trend direction)
  if (!isTrendAligned && hadRecentDirectionFlip('SPXW', 4)) {
    return { allowed: false, reason: 'Direction flipped in last 4 cycles — wait for stabilization' };
  }

  // Gate 9: No entries after 3:30 PM ET (0DTE theta decay)
  const noEntryAfter = cfg.no_entry_after || '15:30';
  if (timeET >= noEntryAfter) {
    return { allowed: false, reason: `Time gate: no entries after ${noEntryAfter} ET` };
  }

  // Gate 10: removed (opening caution — pattern confidence handles this)

  // Gate 11: removed (chop score gate — replaced by confidence-based chop check in entry-engine)

  // Gate 12: Regime conflict — don't enter against a persistent opposing regime
  // Skip when regime is CHOP — chop is not a directional regime, handled by Gate 0.5 in entry-engine
  const regime = getRegime('SPXW');
  if (regime.persistent && regime.direction !== direction && regime.direction !== 'CHOP') {
    return { allowed: false, reason: `Persistent ${regime.direction} regime (${regime.cycles} cycles, ${regime.minutes}m) — blocks ${direction} entry` };
  }

  // Gate 13: Pattern-specific loss cooldown
  const pattern = opts.pattern;
  if (pattern) {
    const patternCooldown = patternCooldownUntil[pattern] || 0;
    if (now < patternCooldown) {
      const remaining = Math.round((patternCooldown - now) / 60_000);
      return { allowed: false, reason: `Pattern cooldown: ${pattern} has ${patternConsecutiveLosses[pattern]} consecutive losses, ${remaining}m remaining` };
    }

    // Gate 14: Max trades per pattern per day
    const maxPerPattern = cfg.max_trades_per_pattern ?? 8;
    if ((patternTradeCount[pattern] || 0) >= maxPerPattern) {
      return { allowed: false, reason: `Pattern limit: ${pattern} hit ${maxPerPattern} trades today` };
    }

    // Gate 15: Per-pattern win rate filter (only after enough samples)
    const minTrades = cfg.pattern_win_rate_min_trades ?? 10;
    const totalForPattern = patternTotal[pattern] || 0;
    if (totalForPattern >= minTrades) {
      const winRate = (patternWins[pattern] || 0) / totalForPattern;
      const minWinRate = cfg.pattern_win_rate_min ?? 0.30;
      if (winRate < minWinRate) {
        return { allowed: false, reason: `Pattern disabled: ${pattern} win rate ${(winRate * 100).toFixed(0)}% < ${(minWinRate * 100).toFixed(0)}% (${totalForPattern} trades)` };
      }
    }
  }

  return { allowed: true };
}

// ---- State Tracking ----

/**
 * Record that an entry was made. Call after successful trade/phantom entry.
 * @param {number} [nowMs] - Optional timestamp override (for replay engine)
 * @param {string} [pattern] - Pattern name for per-pattern tracking
 */
export function recordEntryForGates(nowMs, pattern) {
  lastEntryTime = nowMs || Date.now();
  todayTradeCount++;
  if (pattern) {
    patternTradeCount[pattern] = (patternTradeCount[pattern] || 0) + 1;
  }
}

/**
 * Record that a position was exited. Tracks loss streaks for cooldown.
 * @param {string} direction - 'BULLISH' or 'BEARISH'
 * @param {boolean} isLoss - Whether the trade was a loss
 * @param {number} [nowMs] - Optional timestamp override (for replay engine)
 * @param {string} [pattern] - Pattern name for per-pattern tracking
 */
export function recordExitForGates(direction, isLoss, nowMs, pattern) {
  const now = nowMs || Date.now();
  lastExitTime = now;
  lastExitDirection = direction;
  lastExitWasLoss[direction] = isLoss;

  if (isLoss) {
    consecutiveLosses[direction] = (consecutiveLosses[direction] || 0) + 1;
    const cfg = getActiveConfig() || {};
    const lossLimit = cfg.consecutive_loss_limit ?? 2;
    if (consecutiveLosses[direction] >= lossLimit) {
      const cooldown = cfg.consecutive_loss_cooldown_ms ?? 15 * 60_000;
      consecutiveLossCooldownUntil[direction] = now + cooldown;
      log.warn(`${direction} loss streak: ${consecutiveLosses[direction]} consecutive → ${cooldown / 60_000}m cooldown`);
    }

    // Pattern-level loss tracking
    if (pattern) {
      patternConsecutiveLosses[pattern] = (patternConsecutiveLosses[pattern] || 0) + 1;
      const patternLossLimit = cfg.pattern_loss_limit ?? 3;
      if (patternConsecutiveLosses[pattern] >= patternLossLimit) {
        const patternCooldown = cfg.pattern_loss_cooldown_ms ?? 30 * 60_000;
        patternCooldownUntil[pattern] = now + patternCooldown;
        log.warn(`${pattern} loss streak: ${patternConsecutiveLosses[pattern]} consecutive → ${patternCooldown / 60_000}m cooldown`);
      }
    }
  } else {
    // Win resets the loss streak for that direction
    consecutiveLosses[direction] = 0;
    consecutiveLossCooldownUntil[direction] = 0;

    // Win resets pattern loss streak
    if (pattern) {
      patternConsecutiveLosses[pattern] = 0;
      patternCooldownUntil[pattern] = 0;
    }
  }

  // Track pattern win rate (regardless of win/loss)
  if (pattern) {
    patternTotal[pattern] = (patternTotal[pattern] || 0) + 1;
    if (!isLoss) {
      patternWins[pattern] = (patternWins[pattern] || 0) + 1;
    }
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
  lastExitWasLoss = { BULLISH: false, BEARISH: false };
  patternTradeCount = {};
  patternConsecutiveLosses = {};
  patternCooldownUntil = {};
  patternWins = {};
  patternTotal = {};
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
    patternTradeCount: { ...patternTradeCount },
    patternConsecutiveLosses: { ...patternConsecutiveLosses },
    patternCooldownUntil: { ...patternCooldownUntil },
    patternWinRates: Object.fromEntries(
      Object.entries(patternTotal).map(([p, total]) => [p, {
        wins: patternWins[p] || 0,
        total,
        rate: total > 0 ? ((patternWins[p] || 0) / total * 100).toFixed(0) + '%' : 'n/a',
      }])
    ),
  };
}
