/**
 * Lane E — Adaptive-Stop Simple System (Phantom Only)
 *
 * Strategy:
 * 1. Morning ML scorer: is today a 50+ pt day?
 * 2. First 30 min: direction (>3pt move) + range → adaptive stop
 * 3. Enter ONE trade at 10:00 AM in f30 direction
 * 4. Target +20, stop = max(12, 0.6 × f30_range), no trail
 * 5. Hold to target, stop, or EOD. No re-entry.
 *
 * All trades are PHANTOM — no live orders.
 */

import Database from 'better-sqlite3';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';
import { getDailyTrendScore } from './llm-king-live.js';

const log = createLogger('Lane-E');

// ---- State ----
let state = {
  qualified: null,         // true/false/null — did today qualify?
  mlScore: null,           // morning ML score
  direction: null,         // 'BULLISH' or 'BEARISH'
  f30Move: null,           // first 30-min move in pts
  f30Range: null,          // first 30-min range in pts
  f30High: -Infinity,
  f30Low: Infinity,
  adaptiveStop: null,      // max(12, 0.6 * f30Range)
  target: 20,
  openPrice: null,
  entryPrice: null,
  entryTime: null,
  position: null,          // { direction, entrySpx, target, stop, mfe, mae }
  exitReason: null,
  exitPrice: null,
  exitTime: null,
  pnl: null,
  tradeLogged: false,
  firstSpotTime: null,
  frameCount: 0,
};

// ---- DB Setup ----
let db;
try {
  db = new Database('./data/spx-bot.db');
  db.exec(`CREATE TABLE IF NOT EXISTS lane_e_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
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
    target REAL,
    stop REAL,
    pnl REAL,
    mfe REAL,
    mae REAL,
    underlying_progress REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
} catch (e) {
  log.warn(`DB init: ${e.message}`);
}

/**
 * Called every cycle from main-loop.
 * @param {object} parsed - SPXW parsed data with spotPrice
 * @returns {object} Lane E state for dashboard
 */
export function runLaneECycle(parsed) {
  const spot = parsed?.spotPrice;
  if (!spot || spot <= 0) return getState();

  const et = nowET();
  const minuteOfDay = et.hour * 60 + et.minute;

  // Before market or after close — skip
  if (minuteOfDay < 570 || minuteOfDay > 960) return getState();

  state.frameCount++;

  // ---- Phase 1: Track open price (9:30) ----
  if (state.openPrice === null) {
    state.openPrice = spot;
    state.firstSpotTime = et.toFormat('HH:mm:ss');
    log.info(`Open: $${spot.toFixed(0)}`);
  }

  // ---- Phase 2: Track first 30 min (9:30-10:00) ----
  if (minuteOfDay < 600) {
    if (spot > state.f30High) state.f30High = spot;
    if (spot < state.f30Low) state.f30Low = spot;
    return getState();
  }

  // ---- Phase 3: Qualification at 10:00 ----
  if (state.qualified === null && minuteOfDay >= 600) {
    // Compute first-30-min metrics
    state.f30Move = spot - state.openPrice;
    state.f30Range = state.f30High - state.f30Low;

    // Direction: first 30 min moved >3pts
    if (state.f30Move > 3) {
      state.direction = 'BULLISH';
    } else if (state.f30Move < -3) {
      state.direction = 'BEARISH';
    } else {
      state.direction = null;
    }

    // Adaptive stop
    state.adaptiveStop = Math.max(12, 0.6 * state.f30Range);

    // ML score gate
    const trendScore = getDailyTrendScore();
    state.mlScore = trendScore?.score ?? null;

    // Qualification: ML says big day likely AND we have a direction
    // Using ML score > 0.4 as proxy for 50+ pt day prediction
    const mlQualifies = state.mlScore !== null ? state.mlScore >= 0.4 : true; // fallback: always trade if no ML
    state.qualified = mlQualifies && state.direction !== null;

    log.info(`Qualification: ${state.qualified ? 'TRADE' : 'SKIP'} | ML=${state.mlScore?.toFixed(2) ?? '?'} | dir=${state.direction} | f30=${state.f30Move?.toFixed(1)} | range=${state.f30Range?.toFixed(0)} | stop=${state.adaptiveStop?.toFixed(1)}`);

    // ---- Phase 4: Entry at 10:00 if qualified ----
    if (state.qualified && state.direction) {
      state.entryPrice = spot;
      state.entryTime = et.toFormat('HH:mm:ss');
      state.position = {
        direction: state.direction,
        entrySpx: spot,
        target: state.target,
        stop: state.adaptiveStop,
        mfe: 0,
        mae: 0,
      };
      log.info(`[PHANTOM] ENTRY ${state.direction} @ $${spot.toFixed(0)} | target=+${state.target} | stop=-${state.adaptiveStop.toFixed(1)} | range=${state.f30Range.toFixed(0)}`);
    }

    return getState();
  }

  // ---- Phase 5: Position management ----
  if (state.position && !state.exitReason) {
    const pos = state.position;
    const isBull = pos.direction === 'BULLISH';
    const progress = isBull ? spot - pos.entrySpx : pos.entrySpx - spot;

    if (progress > pos.mfe) pos.mfe = progress;
    if (progress < pos.mae) pos.mae = progress;

    // Target hit
    if (progress >= pos.target) {
      exitTrade(spot, 'TARGET_HIT', progress, et);
    }
    // Stop hit
    else if (progress <= -pos.stop) {
      exitTrade(spot, 'STOP_HIT', progress, et);
    }
    // EOD exit (3:45 PM)
    else if (minuteOfDay >= 945) {
      exitTrade(spot, 'EOD_EXIT', progress, et);
    }
  }

  return getState();
}

function exitTrade(spot, reason, progress, et) {
  state.exitReason = reason;
  state.exitPrice = spot;
  state.exitTime = et.toFormat('HH:mm:ss');

  // Estimate option PnL
  const premium = 15.0;
  const spread = 1.50;
  const entryCost = premium + spread;
  const intrinsic = Math.max(0, progress);
  const timeValRemain = 2.0; // approximate remaining time value
  const exitValue = intrinsic + timeValRemain;
  state.pnl = Math.round((exitValue - entryCost - 1.0) * 100) / 100;

  const tag = state.pnl > 0 ? 'WIN' : 'LOSS';
  log.info(`[PHANTOM] EXIT ${state.position.direction} ${reason} | progress=${progress.toFixed(1)} | MFE=${state.position.mfe.toFixed(1)} | PnL=$${state.pnl.toFixed(2)} | ${tag}`);

  // Log to DB
  logTrade();
}

function logTrade() {
  if (state.tradeLogged || !db) return;
  state.tradeLogged = true;

  const today = nowET().toFormat('yyyy-MM-dd');
  try {
    db.prepare(`INSERT INTO lane_e_trades (
      date, ml_score, qualified, direction, f30_move, f30_range,
      adaptive_stop, entry_price, entry_time, exit_price, exit_time,
      exit_reason, target, stop, pnl, mfe, mae, underlying_progress
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      today,
      state.mlScore,
      state.qualified ? 1 : 0,
      state.direction,
      state.f30Move,
      state.f30Range,
      state.adaptiveStop,
      state.entryPrice,
      state.entryTime,
      state.exitPrice,
      state.exitTime,
      state.exitReason,
      state.target,
      state.adaptiveStop,
      state.pnl,
      state.position?.mfe ?? 0,
      state.position?.mae ?? 0,
      state.exitPrice && state.entryPrice
        ? (state.direction === 'BULLISH' ? state.exitPrice - state.entryPrice : state.entryPrice - state.exitPrice)
        : 0,
    );
    log.info(`Trade logged to lane_e_trades`);
  } catch (e) {
    log.warn(`Failed to log trade: ${e.message}`);
  }
}

/**
 * Also log skipped days for tracking.
 */
function logSkippedDay() {
  if (state.tradeLogged || !db) return;
  state.tradeLogged = true;

  const today = nowET().toFormat('yyyy-MM-dd');
  try {
    db.prepare(`INSERT INTO lane_e_trades (
      date, ml_score, qualified, direction, f30_move, f30_range,
      adaptive_stop, exit_reason
    ) VALUES (?, ?, 0, ?, ?, ?, ?, 'SKIPPED')`).run(
      today, state.mlScore, state.direction, state.f30Move, state.f30Range, state.adaptiveStop,
    );
  } catch (e) { /* ok */ }
}

/**
 * Get current state for dashboard.
 */
export function getState() {
  return {
    qualified: state.qualified,
    mlScore: state.mlScore,
    direction: state.direction,
    f30Move: state.f30Move ? Math.round(state.f30Move * 10) / 10 : null,
    f30Range: state.f30Range ? Math.round(state.f30Range) : null,
    adaptiveStop: state.adaptiveStop ? Math.round(state.adaptiveStop * 10) / 10 : null,
    target: state.target,
    entryPrice: state.entryPrice ? Math.round(state.entryPrice) : null,
    exitReason: state.exitReason,
    pnl: state.pnl,
    mfe: state.position?.mfe ? Math.round(state.position.mfe * 10) / 10 : null,
    mae: state.position?.mae ? Math.round(state.position.mae * 10) / 10 : null,
    tradeActive: state.position !== null && state.exitReason === null,
    progress: state.position && state.exitReason === null && state.entryPrice
      ? Math.round((state.direction === 'BULLISH'
          ? (state.exitPrice || 0) - state.entryPrice
          : state.entryPrice - (state.exitPrice || 0)) * 10) / 10
      : null,
  };
}

/**
 * Reset daily state.
 */
export function resetLaneE() {
  // Log skipped day if we qualified but didn't trade (shouldn't happen) or didn't qualify
  if (state.qualified === false && !state.tradeLogged) {
    logSkippedDay();
  }

  state = {
    qualified: null, mlScore: null, direction: null,
    f30Move: null, f30Range: null, f30High: -Infinity, f30Low: Infinity,
    adaptiveStop: null, target: 20,
    openPrice: null, entryPrice: null, entryTime: null,
    position: null, exitReason: null, exitPrice: null, exitTime: null,
    pnl: null, tradeLogged: false, firstSpotTime: null, frameCount: 0,
  };
  log.info('Daily reset');
}

/**
 * Get cumulative stats for dashboard.
 */
export function getLaneEStats() {
  if (!db) return null;
  try {
    const trades = db.prepare(`SELECT * FROM lane_e_trades WHERE qualified = 1 AND exit_reason != 'SKIPPED' ORDER BY date DESC`).all();
    const wins = trades.filter(t => t.pnl > 0).length;
    const total = trades.length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const recent = trades.slice(0, 10);

    return {
      totalTrades: total,
      wins,
      winRate: total > 0 ? Math.round(wins / total * 100) : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      recentTrades: recent.map(t => ({
        date: t.date,
        direction: t.direction,
        exitReason: t.exit_reason,
        pnl: t.pnl,
        mfe: t.mfe,
        f30Range: t.f30_range,
        adaptiveStop: t.adaptive_stop,
      })),
    };
  } catch (e) {
    return null;
  }
}
