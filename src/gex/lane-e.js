/**
 * Lane E — Three Parallel Phantom Tracks
 *
 * Shared entry logic:
 * 1. Morning ML scorer: is today a 50+ pt day?
 * 2. First 30 min: direction (>3pt move) + range → adaptive stop
 * 3. Enter ONE trade at 10:00 AM in f30 direction
 * 4. Stop = max(12, 0.6 × f30_range), no re-entry
 *
 * Three exit variants (all phantom):
 * E-U (uncapped): hold to stop or EOD. No target, no trail.
 * E-T (profit lock): same as E-U but once MFE >= 15, lock minimum exit at +5.
 * E-C (capped): target +20, hold to target/stop/EOD.
 *
 * All trades are PHANTOM — no live orders.
 */

import Database from 'better-sqlite3';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';
import { getDailyTrendScore } from './llm-king-live.js';

const log = createLogger('Lane-E');

// ---- Shared State ----
let shared = {
  qualified: null,
  mlScore: null,
  direction: null,
  f30Move: null,
  f30Range: null,
  f30High: -Infinity,
  f30Low: Infinity,
  adaptiveStop: null,
  openPrice: null,
  entryPrice: null,
  entryTime: null,
  frameCount: 0,
};

// Per-variant position state
function newPosition(variant) {
  return {
    variant,
    direction: null,
    entrySpx: 0,
    stop: 0,
    mfe: 0,
    mae: 0,
    exitReason: null,
    exitPrice: null,
    exitTime: null,
    pnl: null,
    profitLockActive: false,
    profitLockTime: null,
    logged: false,
  };
}

let positions = {
  'E-U': newPosition('E-U'),
  'E-T': newPosition('E-T'),
  'E-C': newPosition('E-C'),
};

// ---- DB ----
let db;
try {
  db = new Database('./data/spx-bot.db');
  db.exec(`CREATE TABLE IF NOT EXISTS lane_e_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    variant TEXT,
    ml_score REAL,
    qualified INTEGER,
    direction TEXT,
    f30_move REAL,
    f30_range REAL,
    adaptive_stop REAL,
    entry_price REAL,
    entry_time TEXT,
    exit_price REAL,
    exit_time TEXT,
    exit_reason TEXT,
    pnl REAL,
    mfe REAL,
    mae REAL,
    profit_lock_activated INTEGER DEFAULT 0,
    profit_lock_time TEXT,
    underlying_progress REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
} catch (e) {
  log.warn(`DB init: ${e.message}`);
}

function logTrade(pos) {
  if (pos.logged || !db) return;
  pos.logged = true;
  const today = nowET().toFormat('yyyy-MM-dd');
  try {
    db.prepare(`INSERT INTO lane_e_v2 (
      date, variant, ml_score, qualified, direction, f30_move, f30_range,
      adaptive_stop, entry_price, entry_time, exit_price, exit_time,
      exit_reason, pnl, mfe, mae, profit_lock_activated, profit_lock_time,
      underlying_progress
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      today, pos.variant, shared.mlScore, shared.qualified ? 1 : 0,
      shared.direction, shared.f30Move, shared.f30Range, shared.adaptiveStop,
      shared.entryPrice, shared.entryTime, pos.exitPrice, pos.exitTime,
      pos.exitReason, pos.pnl, pos.mfe, pos.mae,
      pos.profitLockActive ? 1 : 0, pos.profitLockTime,
      pos.exitPrice && shared.entryPrice
        ? (shared.direction === 'BULLISH' ? pos.exitPrice - shared.entryPrice : shared.entryPrice - pos.exitPrice)
        : 0,
    );
  } catch (e) {
    log.warn(`Log ${pos.variant}: ${e.message}`);
  }
}

/**
 * Called every cycle from main-loop.
 */
export function runLaneECycle(parsed) {
  const spot = parsed?.spotPrice;
  if (!spot || spot <= 0) return getState();

  const et = nowET();
  const minuteOfDay = et.hour * 60 + et.minute;
  if (minuteOfDay < 570 || minuteOfDay > 960) return getState();

  shared.frameCount++;

  // ---- Phase 1: Track open ----
  if (shared.openPrice === null) {
    shared.openPrice = spot;
    log.info(`Open: $${spot.toFixed(0)}`);
  }

  // ---- Phase 2: Track first 30 min ----
  if (minuteOfDay < 600) {
    if (spot > shared.f30High) shared.f30High = spot;
    if (spot < shared.f30Low) shared.f30Low = spot;
    return getState();
  }

  // ---- Phase 3: Qualify + Enter at 10:00 ----
  if (shared.qualified === null && minuteOfDay >= 600) {
    shared.f30Move = spot - shared.openPrice;
    shared.f30Range = shared.f30High - shared.f30Low;

    if (shared.f30Move > 3) shared.direction = 'BULLISH';
    else if (shared.f30Move < -3) shared.direction = 'BEARISH';
    else shared.direction = null;

    shared.adaptiveStop = Math.max(12, 0.6 * shared.f30Range);

    const trendScore = getDailyTrendScore();
    shared.mlScore = trendScore?.score ?? null;
    const mlQualifies = shared.mlScore !== null ? shared.mlScore >= 0.4 : true;
    shared.qualified = mlQualifies && shared.direction !== null;

    log.info(`Qualify: ${shared.qualified ? 'TRADE' : 'SKIP'} | ML=${shared.mlScore?.toFixed(2) ?? '?'} | dir=${shared.direction} | f30=${shared.f30Move?.toFixed(1)} | range=${shared.f30Range?.toFixed(0)} | stop=${shared.adaptiveStop?.toFixed(1)}`);

    if (shared.qualified) {
      shared.entryPrice = spot;
      shared.entryTime = et.toFormat('HH:mm:ss');

      // Enter all three variants
      for (const key of ['E-U', 'E-T', 'E-C']) {
        const pos = positions[key];
        pos.direction = shared.direction;
        pos.entrySpx = spot;
        pos.stop = shared.adaptiveStop;
        pos.mfe = 0;
        pos.mae = 0;
      }
      log.info(`[PHANTOM] ENTRY ${shared.direction} @ $${spot.toFixed(0)} | stop=${shared.adaptiveStop.toFixed(1)} | range=${shared.f30Range.toFixed(0)}`);
    }
    return getState();
  }

  // ---- Phase 4: Manage positions ----
  if (!shared.qualified || !shared.entryPrice) return getState();

  for (const [key, pos] of Object.entries(positions)) {
    if (pos.exitReason) continue; // already exited

    const isBull = shared.direction === 'BULLISH';
    const progress = isBull ? spot - pos.entrySpx : pos.entrySpx - spot;
    if (progress > pos.mfe) pos.mfe = progress;
    if (progress < pos.mae) pos.mae = progress;

    let exitReason = null;

    // ---- E-U: uncapped, stop + EOD ----
    if (key === 'E-U') {
      if (progress <= -pos.stop) exitReason = 'STOP_HIT';
      else if (minuteOfDay >= 945) exitReason = 'EOD_EXIT';
    }

    // ---- E-T: uncapped + profit lock ----
    else if (key === 'E-T') {
      // Activate profit lock at MFE >= 15
      if (!pos.profitLockActive && pos.mfe >= 15) {
        pos.profitLockActive = true;
        pos.profitLockTime = et.toFormat('HH:mm:ss');
        log.debug(`[E-T] Profit lock activated at MFE=${pos.mfe.toFixed(1)}`);
      }

      if (progress <= -pos.stop) {
        exitReason = 'STOP_HIT';
      } else if (pos.profitLockActive && progress <= 5) {
        // Lock: once MFE hit 15, don't let it fall below +5
        exitReason = 'PROFIT_LOCK_EXIT';
      } else if (minuteOfDay >= 945) {
        exitReason = 'EOD_EXIT';
      }
    }

    // ---- E-C: capped at +20 ----
    else if (key === 'E-C') {
      if (progress >= 20) exitReason = 'TARGET_HIT';
      else if (progress <= -pos.stop) exitReason = 'STOP_HIT';
      else if (minuteOfDay >= 945) exitReason = 'EOD_EXIT';
    }

    if (exitReason) {
      pos.exitReason = exitReason;
      pos.exitPrice = spot;
      pos.exitTime = et.toFormat('HH:mm:ss');

      // Option PnL estimate
      const premium = 15.0;
      const intrinsic = Math.max(0, progress);
      const timeRemain = Math.max(0.5, (960 - minuteOfDay) / 60);
      const timeVal = 15.0 * Math.sqrt(timeRemain / 5.5) * 0.35;
      pos.pnl = Math.round((intrinsic + timeVal - premium - 2.5) * 100) / 100;

      const tag = pos.pnl > 0 ? 'WIN' : 'LOSS';
      const lockNote = key === 'E-T' && pos.profitLockActive ? ' [lock active]' : '';
      log.info(`[${key}] EXIT ${exitReason} | prog=${progress.toFixed(1)} | MFE=${pos.mfe.toFixed(1)} | PnL=$${pos.pnl.toFixed(2)} | ${tag}${lockNote}`);

      logTrade(pos);
    }
  }

  return getState();
}

export function getState() {
  return {
    qualified: shared.qualified,
    mlScore: shared.mlScore,
    direction: shared.direction,
    f30Move: shared.f30Move ? Math.round(shared.f30Move * 10) / 10 : null,
    f30Range: shared.f30Range ? Math.round(shared.f30Range) : null,
    adaptiveStop: shared.adaptiveStop ? Math.round(shared.adaptiveStop * 10) / 10 : null,
    entryPrice: shared.entryPrice ? Math.round(shared.entryPrice) : null,
    variants: {
      'E-U': variantState(positions['E-U']),
      'E-T': variantState(positions['E-T']),
      'E-C': variantState(positions['E-C']),
    },
  };
}

function variantState(pos) {
  return {
    exitReason: pos.exitReason,
    pnl: pos.pnl,
    mfe: pos.mfe ? Math.round(pos.mfe * 10) / 10 : null,
    mae: pos.mae ? Math.round(pos.mae * 10) / 10 : null,
    profitLockActive: pos.profitLockActive,
    active: pos.entrySpx > 0 && !pos.exitReason,
  };
}

export function resetLaneE() {
  // Log skipped days
  if (shared.qualified === false) {
    const today = nowET().toFormat('yyyy-MM-dd');
    try {
      if (db) {
        for (const v of ['E-U', 'E-T', 'E-C']) {
          db.prepare(`INSERT INTO lane_e_v2 (date, variant, ml_score, qualified, direction, f30_move, f30_range, adaptive_stop, exit_reason)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'SKIPPED')`).run(
            today, v, shared.mlScore, shared.direction, shared.f30Move, shared.f30Range, shared.adaptiveStop);
        }
      }
    } catch (e) { /* ok */ }
  }

  shared = {
    qualified: null, mlScore: null, direction: null,
    f30Move: null, f30Range: null, f30High: -Infinity, f30Low: Infinity,
    adaptiveStop: null, openPrice: null, entryPrice: null, entryTime: null,
    frameCount: 0,
  };
  positions = {
    'E-U': newPosition('E-U'),
    'E-T': newPosition('E-T'),
    'E-C': newPosition('E-C'),
  };
  log.info('Daily reset (3 variants)');
}

export function getLaneEStats() {
  if (!db) return null;
  try {
    const stats = {};
    for (const v of ['E-U', 'E-T', 'E-C']) {
      const trades = db.prepare(`SELECT * FROM lane_e_v2 WHERE variant = ? AND qualified = 1 AND exit_reason != 'SKIPPED' ORDER BY date DESC`).all(v);
      const wins = trades.filter(t => t.pnl > 0).length;
      const total = trades.length;
      const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
      const gaveBack = trades.filter(t => t.mfe >= 15 && t.pnl <= 0).length;
      const monsterWins = trades.filter(t => t.pnl >= 30).length;

      stats[v] = {
        trades: total,
        wins,
        winRate: total > 0 ? Math.round(wins / total * 100) : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
        gaveBack,
        monsterWins,
        recent: trades.slice(0, 10).map(t => ({
          date: t.date, exitReason: t.exit_reason, pnl: t.pnl,
          mfe: t.mfe, profitLock: t.profit_lock_activated,
        })),
      };
    }
    return stats;
  } catch (e) { return null; }
}
