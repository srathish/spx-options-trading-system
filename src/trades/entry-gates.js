/**
 * Entry Quality Gates
 * Centralized pre-entry validation. Every entry (Lane A or Lane B) must pass ALL gates.
 * Replaces validateEntryGuardrails() from main-loop.js.
 */

import { getActiveConfig } from '../review/strategy-store.js';
import { getSignalSnapshot, getTvRegime } from '../tv/tv-signal-store.js';
import { getSpotMomentum, isDirectionStable, hadRecentDirectionFlip, getRegime, getNetGexRoC, getRoundTripStatus, getNodeTrends } from '../store/state.js';
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

// Chop cooldown — track recent small-P&L trades
let recentTrades = [];                   // [{ timestamp, pnlPts }]
let chopCooldownUntil = 0;

// Daily P&L circuit breaker
let todayNetPnl = 0;                    // Accumulated net PnL for the day (in SPX pts)

// Pattern-level tracking
let patternTradeCount = {};         // { 'TRIPLE_FLOOR': 5, ... }
let patternConsecutiveLosses = {};   // { 'TRIPLE_FLOOR': 3, ... }
let patternCooldownUntil = {};       // { 'TRIPLE_FLOOR': 1709312345000, ... }
let patternWins = {};                // { 'TRIPLE_FLOOR': 2, ... }
let patternTotal = {};               // { 'TRIPLE_FLOOR': 10, ... }

// Day-trend lock: once CONFIRMED trend fires, lock the direction for the day.
// Prevents flip-flopping between BULLISH and BEARISH within the same day.
let dayTrendLocked = null;           // null | 'BULLISH' | 'BEARISH'

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

  // GEX conviction override — when strike memory shows sustained directional growth,
  // allow re-entry even through cooldowns. A human watching the chart would re-enter
  // when the wall keeps growing after a stop-out.
  const conviction = opts.conviction || null;
  const convictionMinOverride = cfg.conviction_min_override ?? 70;
  const hasConviction = conviction
    && conviction.conviction >= convictionMinOverride
    && conviction.direction === direction;
  if (hasConviction) {
    log.info(`GEX conviction ${conviction.conviction}: ${conviction.direction} | ${conviction.dominantStrike} @ ${(conviction.dominantValue / 1e6).toFixed(0)}M | growth ${(conviction.growthRate * 100).toFixed(0)}% | ${conviction.growingStrikes} strikes growing`);
  }

  // Gate 0a: Daily P&L circuit breaker.
  // When today's cumulative P&L hits the max daily loss threshold, halt all new entries.
  // Prevents spiraling losses on adverse market days (e.g. 0W/9L days in 60-day backtest).
  if (cfg.max_daily_loss_pts && todayNetPnl <= -Math.abs(cfg.max_daily_loss_pts)) {
    return { allowed: false, reason: `Daily loss limit: ${todayNetPnl.toFixed(2)} pts (limit: -${cfg.max_daily_loss_pts})` };
  }

  // Gate 0b: SPY momentum gate — "the brain."
  // If SPY 5-min momentum is STRONG in the opposite direction to our entry, the broad
  // market is actively fighting the GEX signal. Block to avoid trading into crashes.
  // Only fires on STRONG (≥$15 move in 5 min) to avoid filtering choppy chop.
  // Key scenario: 2026-02-03 SPX crashed 89 pts while system took 9 BULLISH entries.
  if (cfg.spy_momentum_gate_enabled) {
    const minStrength = cfg.spy_momentum_gate_min_strength ?? 'STRONG';
    const strengthOrder = { STRONG: 3, MODERATE: 2, WEAK: 1, CHOP: 0 };
    const minLevel = strengthOrder[minStrength] ?? 3;
    const spyMom = getSpotMomentum('SPY');
    const qqqMom = cfg.qqq_momentum_gate_enabled ? getSpotMomentum('QQQ') : null;
    const spyHeadwind = (strengthOrder[spyMom?.strength] ?? 0) >= minLevel
      && spyMom?.direction && spyMom.direction !== 'CHOP' && spyMom.direction !== direction;
    const qqqHeadwind = qqqMom && (strengthOrder[qqqMom?.strength] ?? 0) >= minLevel
      && qqqMom.direction !== 'CHOP' && qqqMom.direction !== direction;
    if (spyHeadwind) {
      return { allowed: false, reason: `SPY momentum headwind: SPY ${spyMom.strength} ${spyMom.direction} vs ${direction} (${spyMom.points?.toFixed(1) ?? '?'} pts)` };
    }
    if (qqqHeadwind) {
      return { allowed: false, reason: `QQQ momentum headwind: QQQ ${qqqMom.strength} ${qqqMom.direction} vs ${direction} (${qqqMom.points?.toFixed(1) ?? '?'} pts)` };
    }
  }

  // Gate 0: Trend-only mode — only enter when a solid intraday trend is confirmed.
  // Direction is anchored to raw price move from the day's open, not the trend detector's
  // first-fire direction. This prevents locking the wrong direction on gap-and-reverse days.
  const trendState = opts.trendState;
  if (cfg.trend_only_mode) {
    const trendStrength = trendState?.strength;
    const trendActive = trendState?.isTrend && (trendStrength === 'CONFIRMED' || trendStrength === 'STRONG');

    if (!trendActive) {
      return { allowed: false, reason: `Trend-only: waiting for CONFIRMED trend (current: ${trendStrength || 'none'})` };
    }

    // Determine day direction from raw price move from open (not trend detector's first-fire).
    // This correctly handles gap-and-reverse days where the first candle's direction reverses.
    if (!dayTrendLocked) {
      const { openPrice } = getRoundTripStatus();
      const minDayMove = cfg.trend_only_min_move_pts ?? 30;
      if (openPrice && openPrice > 0) {
        const moveFromOpen = scored.spotPrice - openPrice;
        if (moveFromOpen >= minDayMove) {
          dayTrendLocked = 'BULLISH';
        } else if (moveFromOpen <= -minDayMove) {
          dayTrendLocked = 'BEARISH';
        } else {
          return { allowed: false, reason: `Trend-only: move from open only ${moveFromOpen.toFixed(0)}pts (need ±${minDayMove})` };
        }
        log.info(`Trend-only: day direction LOCKED ${dayTrendLocked} (move: ${moveFromOpen.toFixed(0)}pts from open ${openPrice.toFixed(0)})`);
      } else {
        return { allowed: false, reason: 'Trend-only: open price not yet established' };
      }
    }

    // Only trade the locked direction — no reversals mid-day
    if (direction !== dayTrendLocked) {
      return { allowed: false, reason: `Trend-only: ${direction} blocked — day locked ${dayTrendLocked}` };
    }
  }

  // Gate 1: 60s minimum spacing between ANY entries (reduced during trend days after wins)
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
  // OVERRIDE: If GEX conviction is high, the wall is still growing — the thesis didn't fail,
  // just timing. A human trader would re-enter when they see the magnet getting stronger.
  const cooldownUntil = consecutiveLossCooldownUntil[direction] || 0;
  if (now < cooldownUntil && !hasConviction) {
    const remaining = Math.round((cooldownUntil - now) / 60_000);
    return { allowed: false, reason: `Loss cooldown: ${consecutiveLosses[direction]} consecutive ${direction} losses, ${remaining}m remaining` };
  }

  // Gate 3b: Same-direction loss cap — after N losses in one direction, require higher confidence
  // OVERRIDE: High conviction means the GEX landscape is screaming this direction
  const dirLossCap = cfg.direction_loss_cap ?? 3;
  if (dirLossCap > 0 && consecutiveLosses[direction] >= dirLossCap && !hasConviction) {
    const trigger = opts.trigger;
    const conf = trigger?.confidence || 'MEDIUM';
    const requiredConf = cfg.direction_loss_cap_min_confidence ?? 'VERY_HIGH';
    const confOrder = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
    if (confOrder.indexOf(conf) < confOrder.indexOf(requiredConf)) {
      return { allowed: false, reason: `Direction cap: ${consecutiveLosses[direction]} ${direction} losses — need ${requiredConf} confidence, got ${conf}` };
    }
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

  // Gate 10: Noon dead zone — 12:00-12:59 ET is 22% WR, -68 pts across 60 days
  // OVERRIDE: Only with very high conviction (80+) — noon chop is the most dangerous time
  const noonBlackoutStart = cfg.noon_blackout_start || '12:00';
  const noonBlackoutEnd = cfg.noon_blackout_end || '13:00';
  const noonConvictionMin = cfg.conviction_noon_override ?? 90;
  const hasNoonConviction = conviction && conviction.conviction >= noonConvictionMin && conviction.direction === direction;
  if (cfg.noon_blackout_enabled !== false && timeET >= noonBlackoutStart && timeET < noonBlackoutEnd && !hasNoonConviction) {
    return { allowed: false, reason: `Noon dead zone: no entries ${noonBlackoutStart}-${noonBlackoutEnd}` };
  }

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

  // Gate 16: Max stop distance — reject entries with stops too far away
  const maxStopDist = cfg.max_stop_distance_pts ?? 6;
  const trigger = opts.trigger;
  if (maxStopDist > 0 && trigger?.stop_strike && scored?.spotPrice) {
    const stopDist = Math.abs(trigger.stop_strike - scored.spotPrice);
    if (stopDist > maxStopDist) {
      return { allowed: false, reason: `Stop too wide: ${stopDist.toFixed(1)} pts > ${maxStopDist} max` };
    }
  }

  // Gate 17: GEX regime directional gate
  // Data: deep negative GEX (<-30M) = 68% up days → block low-confidence BEARISH entries
  //       positive GEX (>10M) = 60% down days → block low-confidence BULLISH entries
  // OVERRIDE: With conviction, the sustained growth in strike memory confirms the direction
  // is correct despite the net GEX regime — the walls are actively pulling
  if (cfg.regime_gate_enabled !== false && !hasConviction) {
    const netGexM = getNetGexRoC('SPXW').current / 1e6;
    const deepNegThreshold = cfg.regime_deep_negative_threshold ?? -30;
    const posThreshold = cfg.regime_positive_threshold ?? 10;
    const triggerConf = trigger?.confidence || 'MEDIUM';
    const confOrder = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
    const minRegimeConf = cfg.regime_gate_min_confidence ?? 'HIGH';

    if (direction === 'BEARISH' && netGexM < deepNegThreshold && confOrder.indexOf(triggerConf) < confOrder.indexOf(minRegimeConf)) {
      return { allowed: false, reason: `GEX regime gate: BEARISH in deep negative GEX (${netGexM.toFixed(0)}M < ${deepNegThreshold}M) — need ${minRegimeConf}+, got ${triggerConf}` };
    }
    if (direction === 'BULLISH' && netGexM > posThreshold && confOrder.indexOf(triggerConf) < confOrder.indexOf(minRegimeConf)) {
      return { allowed: false, reason: `GEX regime gate: BULLISH in positive GEX (${netGexM.toFixed(0)}M > ${posThreshold}M) — need ${minRegimeConf}+, got ${triggerConf}` };
    }
  }

  // Gate 18: MAGNET_PULL magnet still growing at entry time
  // Pattern detects GROWING magnet but by entry (1-2 frames later) it may have weakened.
  // Block if target node has become WEAKENING or GONE since detection.
  if (cfg.magnet_entry_freshness_check !== false && trigger?.pattern === 'MAGNET_PULL' && trigger?.target_strike) {
    const nodeTrends = getNodeTrends('SPXW');
    const nodeTrend = nodeTrends?.get(trigger.target_strike);
    if (nodeTrend && (nodeTrend.trend === 'GONE' || nodeTrend.trend === 'WEAKENING')) {
      return { allowed: false, reason: `Magnet stale: ${trigger.target_strike} is now ${nodeTrend.trend} since detection` };
    }
  }

  // Gate 19: Multi-ticker alignment gate — require SPY+QQQ consensus to support entry direction.
  // If 2+ tickers (majority) show opposing direction, the MAGNET_PULL has a strong headwind.
  // Default: enabled for MAGNET_PULL. Disable with multi_alignment_gate_enabled: false.
  if (cfg.multi_alignment_gate_enabled !== false) {
    const gatePatterns = cfg.multi_alignment_gate_patterns ?? ['MAGNET_PULL'];
    if (pattern && gatePatterns.includes(pattern)) {
      const alignment = multiAnalysis?.alignment;
      const minCount = cfg.multi_alignment_min_count ?? 2;
      if (alignment && alignment.count >= minCount && alignment.direction !== 'MIXED' && alignment.direction !== direction) {
        return { allowed: false, reason: `Multi-ticker headwind: ${alignment.count}/3 tickers say ${alignment.direction} vs entry ${direction}` };
      }
    }
  }

  // Gate 20: REVERSE_RUG time window restrictions.
  // Early morning (pre-09:50): 0% win rate (0W/8L), opening volatility breaks setups.
  // Late afternoon (post-15:00): 20% win rate (1W/4L), theta decay + poor reward/risk.
  if (pattern === 'REVERSE_RUG') {
    if (cfg.reverse_rug_morning_blackout_end && timeET < cfg.reverse_rug_morning_blackout_end) {
      return { allowed: false, reason: `REVERSE_RUG morning blackout: no entries before ${cfg.reverse_rug_morning_blackout_end}` };
    }
    if (cfg.reverse_rug_no_entry_after && timeET >= cfg.reverse_rug_no_entry_after) {
      return { allowed: false, reason: `REVERSE_RUG afternoon cutoff: no entries after ${cfg.reverse_rug_no_entry_after}` };
    }
  }

  // Gate 21a: MAGNET_PULL 9AM HIGH confidence block (score >= threshold at 9AM).
  // The "high confidence paradox": HIGH score (>=80) MAGNET_PULL at 9AM has 34% WR
  // while LOW score (<60) has 80% WR. Opening volatility breaks the strongest setups.
  if (pattern === 'MAGNET_PULL' && cfg.magnet_pull_9am_max_score) {
    const entryScore = scored?.score ?? 0;
    if (etNow.hour === 9 && entryScore > cfg.magnet_pull_9am_max_score) {
      return { allowed: false, reason: `MAGNET_PULL 9AM high-score block: score ${entryScore.toFixed(0)} > ${cfg.magnet_pull_9am_max_score} at 9AM (low WR paradox)` };
    }
  }

  // Gate 21: MAGNET_PULL morning blackout (pre-09:40).
  // 09:33-09:39: 6W/15L (29% WR), NET: +5.60 vs 09:40-09:46: 8W/5L (62% WR), NET: +49.97
  // First 7 minutes: opening auction volatility causes most setups to stop out immediately.
  if (pattern === 'MAGNET_PULL') {
    if (cfg.magnet_pull_morning_blackout_end && timeET < cfg.magnet_pull_morning_blackout_end) {
      return { allowed: false, reason: `MAGNET_PULL morning blackout: no entries before ${cfg.magnet_pull_morning_blackout_end}` };
    }
  }

  // Gate 22: RUG_PULL score 70-79 block.
  // Score 70-79: 7W/16L (30% WR), NET: -17.16 — worst performing score bucket for RUG_PULL.
  // Scores below 70 and above 79 all outperform this specific range.
  if (pattern === 'RUG_PULL') {
    const entryScore = scored?.score ?? 0;
    const minScore = cfg.rug_pull_score_min ?? 0;
    const maxBlockedScore = cfg.rug_pull_score_max_blocked ?? 0;
    if (maxBlockedScore > 0 && entryScore >= minScore && entryScore <= maxBlockedScore) {
      return { allowed: false, reason: `RUG_PULL score ${entryScore.toFixed(0)} in blocked range (${minScore}-${maxBlockedScore})` };
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
 * @param {number} [pnlPts] - P&L in SPX points (for chop cooldown tracking)
 */
export function recordExitForGates(direction, isLoss, nowMs, pattern, pnlPts) {
  const now = nowMs || Date.now();
  lastExitTime = now;
  lastExitDirection = direction;
  lastExitWasLoss[direction] = isLoss;

  // Track daily net P&L for circuit breaker (Gate 0a)
  if (pnlPts !== undefined) {
    todayNetPnl += pnlPts;
  }

  // Track recent trades for chop cooldown
  if (pnlPts !== undefined) {
    recentTrades.push({ timestamp: now, pnlPts });
    // Keep only trades from last 30 min
    const windowMs = 30 * 60_000;
    while (recentTrades.length > 0 && recentTrades[0].timestamp < now - windowMs) {
      recentTrades.shift();
    }
    // Check chop cooldown: 3+ trades in window, all with |P&L| < 3 pts
    const smallThreshold = 3;
    const minCount = 3;
    if (recentTrades.length >= minCount) {
      const allSmall = recentTrades.slice(-minCount).every(t => Math.abs(t.pnlPts) < smallThreshold);
      if (allSmall) {
        chopCooldownUntil = now + 20 * 60_000; // 20 min cooldown
        log.warn(`Chop cooldown activated: ${minCount} consecutive small trades (<${smallThreshold} pts) → 20m pause`);
      }
    }
  }

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
  recentTrades = [];
  chopCooldownUntil = 0;
  todayNetPnl = 0;
  patternTradeCount = {};
  patternConsecutiveLosses = {};
  patternCooldownUntil = {};
  patternWins = {};
  patternTotal = {};
  dayTrendLocked = null;
  log.info('Daily entry gates reset');
}

/**
 * Get current gate state for diagnostics.
 */
export function getGateState() {
  return {
    lastEntryTime,
    todayTradeCount,
    todayNetPnl,
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
