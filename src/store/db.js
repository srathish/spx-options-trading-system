/**
 * SQLite database setup and helpers using better-sqlite3.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { nowET, formatET } from '../utils/market-hours.js';

const log = createLogger('DB');

// ---- GEX Map Serialization (for replay engine) ----

export function serializeMap(map) {
  if (!map || !(map instanceof Map)) return '{}';
  return JSON.stringify(Object.fromEntries(map));
}

export function deserializeMap(jsonStr) {
  if (!jsonStr) return new Map();
  return new Map(Object.entries(JSON.parse(jsonStr)).map(([k, v]) => [Number(k), v]));
}

// Ensure data directory exists
mkdirSync(config.dataDir, { recursive: true });

const dbPath = `${config.dataDir}/spx-bot.db`;
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS gex_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    spot_price REAL NOT NULL,
    score INTEGER NOT NULL,
    direction TEXT NOT NULL,
    confidence TEXT NOT NULL,
    environment TEXT NOT NULL,
    gex_at_spot REAL,
    dominant_call_wall TEXT,
    dominant_put_wall TEXT,
    walls_above TEXT,
    walls_below TEXT,
    raw_data TEXT,
    breakdown TEXT
  );

  CREATE TABLE IF NOT EXISTS wall_trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    strike INTEGER NOT NULL,
    direction TEXT NOT NULL,
    old_value REAL NOT NULL,
    new_value REAL NOT NULL,
    pct_change REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    discord_sent INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    service TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    direction TEXT NOT NULL,
    score INTEGER NOT NULL,
    spot_price REAL NOT NULL,
    target_strike REAL,
    floor_strike REAL,
    checked INTEGER DEFAULT 0,
    result_price REAL,
    result_pct_move REAL,
    result_win INTEGER
  );

  -- Phase 2: TV signal current state (one row per indicator, upserted)
  CREATE TABLE IF NOT EXISTS tv_signals (
    indicator TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    level REAL,
    kind TEXT,
    updated_at TEXT NOT NULL,
    is_stale INTEGER DEFAULT 0
  );

  -- Phase 2: TV signal change history
  CREATE TABLE IF NOT EXISTS tv_signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    indicator TEXT NOT NULL,
    old_state TEXT,
    new_state TEXT NOT NULL,
    payload TEXT
  );

  -- Phase 2: Agent decisions
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    gex_score INTEGER,
    gex_direction TEXT,
    gex_confidence TEXT,
    tv_state TEXT,
    confirmations INTEGER,
    confirmation_mode TEXT,
    agent_action TEXT,
    agent_confidence TEXT,
    agent_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    response_time_ms INTEGER,
    skipped INTEGER DEFAULT 0
  );

  -- Phase 3: Trade tracking
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    contract TEXT NOT NULL,
    direction TEXT NOT NULL,
    strike REAL NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    entry_spx REAL NOT NULL,
    exit_spx REAL,
    pnl_dollars REAL,
    pnl_pct REAL,
    exit_reason TEXT,
    target_price REAL,
    stop_price REAL,
    target_spx REAL,
    stop_spx REAL,
    greeks_at_entry TEXT,
    gex_state_at_entry TEXT,
    tv_state_at_entry TEXT,
    agent_reasoning TEXT,
    is_phantom INTEGER DEFAULT 0,
    state TEXT DEFAULT 'PENDING',
    last_update_at TEXT,
    current_pnl_pct REAL,
    strategy_version TEXT DEFAULT 'v3.0'
  );

  -- Multi-ticker cross-market analysis
  CREATE TABLE IF NOT EXISTS multi_ticker_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    driver_ticker TEXT,
    driver_reason TEXT,
    alignment_direction TEXT,
    alignment_count INTEGER,
    stacked_walls TEXT,
    rug_setups TEXT,
    node_slides TEXT,
    multi_signal_direction TEXT,
    multi_signal_confidence TEXT,
    multi_signal_reason TEXT,
    spx_score INTEGER,
    spy_score INTEGER,
    qqq_score INTEGER
  );

  -- Phase 5: Strategy version snapshots
  CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    parent_version INTEGER,
    config TEXT NOT NULL,
    change_summary TEXT,
    source TEXT NOT NULL,
    review_analysis TEXT,
    is_active INTEGER DEFAULT 0,
    is_v1_floor INTEGER DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    response_time_ms INTEGER
  );

  -- Phase 5: Phantom trade comparisons (current vs previous version)
  CREATE TABLE IF NOT EXISTS phantom_comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    current_version INTEGER NOT NULL,
    previous_version INTEGER,
    current_would_enter INTEGER NOT NULL,
    previous_would_enter INTEGER NOT NULL,
    current_would_exit TEXT,
    previous_would_exit TEXT,
    trade_pnl_dollars REAL,
    trade_pnl_pct REAL,
    assessment TEXT,
    details TEXT,
    FOREIGN KEY (trade_id) REFERENCES trades(id)
  );

  -- Phase 5: Rollback event log
  CREATE TABLE IF NOT EXISTS rollback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    from_version INTEGER NOT NULL,
    to_version INTEGER NOT NULL,
    trigger_details TEXT,
    discord_sent INTEGER DEFAULT 0
  );

  -- Phase 5: Morning briefings
  CREATE TABLE IF NOT EXISTS morning_briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    briefing TEXT NOT NULL,
    changes TEXT,
    performance_summary TEXT,
    created_at TEXT NOT NULL
  );

  -- Replay engine: raw GEX snapshots (full strike-level Maps per cycle)
  CREATE TABLE IF NOT EXISTS gex_raw_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    ticker TEXT NOT NULL,
    spot_price REAL NOT NULL,
    aggregated_gex TEXT NOT NULL,
    all_exp_gex TEXT NOT NULL,
    near_term_gex TEXT NOT NULL,
    vex_map TEXT NOT NULL,
    strikes TEXT NOT NULL,
    expirations TEXT NOT NULL,
    walls TEXT NOT NULL,
    multi_analysis TEXT,
    tv_snapshot TEXT,
    scored_direction TEXT,
    scored_score INTEGER,
    cycle_index INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gex_raw_ts ON gex_raw_snapshots(timestamp, ticker);

  -- Backtest presets: saved named parameter configs for replay engine
  CREATE TABLE IF NOT EXISTS backtest_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    config TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations — add columns that may not exist in older databases
try { db.exec('ALTER TABLE trades ADD COLUMN strategy_lane TEXT DEFAULT NULL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN entry_trigger TEXT DEFAULT NULL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN entry_context TEXT DEFAULT NULL'); } catch (_) {}

log.info(`Database initialized at ${dbPath}`);

// ---- Prepared statements ----

const insertSnapshot = db.prepare(`
  INSERT INTO gex_snapshots (timestamp, spot_price, score, direction, confidence, environment,
    gex_at_spot, dominant_call_wall, dominant_put_wall, walls_above, walls_below, raw_data, breakdown)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertWallTrend = db.prepare(`
  INSERT INTO wall_trends (timestamp, strike, direction, old_value, new_value, pct_change)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (timestamp, type, content, discord_sent) VALUES (?, ?, ?, ?)
`);

const insertHealth = db.prepare(`
  INSERT INTO health (timestamp, service, status, details) VALUES (?, ?, ?, ?)
`);

const insertPrediction = db.prepare(`
  INSERT INTO predictions (timestamp, direction, score, spot_price, target_strike, floor_strike)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Phase 2 prepared statements
const upsertTvSignal = db.prepare(`
  INSERT INTO tv_signals (indicator, state, level, kind, updated_at, is_stale)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(indicator) DO UPDATE SET
    state = excluded.state,
    level = excluded.level,
    kind = excluded.kind,
    updated_at = excluded.updated_at,
    is_stale = excluded.is_stale
`);

const insertTvSignalLog = db.prepare(`
  INSERT INTO tv_signal_log (timestamp, indicator, old_state, new_state, payload)
  VALUES (?, ?, ?, ?, ?)
`);

const insertDecision = db.prepare(`
  INSERT INTO decisions (timestamp, gex_score, gex_direction, gex_confidence, tv_state,
    confirmations, confirmation_mode, agent_action, agent_confidence, agent_reason,
    input_tokens, output_tokens, response_time_ms, skipped)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Multi-ticker analysis prepared statements
const insertMultiAnalysis = db.prepare(`
  INSERT INTO multi_ticker_analysis (timestamp, driver_ticker, driver_reason, alignment_direction,
    alignment_count, stacked_walls, rug_setups, node_slides, multi_signal_direction,
    multi_signal_confidence, multi_signal_reason, spx_score, spy_score, qqq_score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Phase 5 prepared statements
const insertStrategyVersion = db.prepare(`
  INSERT INTO strategy_versions (version, created_at, parent_version, config, change_summary, source, review_analysis, is_active, is_v1_floor, input_tokens, output_tokens, response_time_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateDeactivateAllVersions = db.prepare(`
  UPDATE strategy_versions SET is_active = 0 WHERE is_active = 1
`);

const updateActivateVersion = db.prepare(`
  UPDATE strategy_versions SET is_active = 1 WHERE version = ?
`);

const selectActiveVersion = db.prepare(`
  SELECT * FROM strategy_versions WHERE is_active = 1 LIMIT 1
`);

const selectVersionByNumber = db.prepare(`
  SELECT * FROM strategy_versions WHERE version = ?
`);

const selectAllVersions = db.prepare(`
  SELECT * FROM strategy_versions ORDER BY version DESC
`);

const selectV1Floor = db.prepare(`
  SELECT * FROM strategy_versions WHERE is_v1_floor = 1 LIMIT 1
`);

const selectNextVersionNumber = db.prepare(`
  SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM strategy_versions
`);

const insertPhantomComparison = db.prepare(`
  INSERT INTO phantom_comparisons (trade_id, timestamp, current_version, previous_version, current_would_enter, previous_would_enter, current_would_exit, previous_would_exit, trade_pnl_dollars, trade_pnl_pct, assessment, details)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectPhantomComparisonsForVersion = db.prepare(`
  SELECT * FROM phantom_comparisons WHERE current_version = ? ORDER BY id DESC
`);

const selectRecentPhantomComparisons = db.prepare(`
  SELECT * FROM phantom_comparisons ORDER BY id DESC LIMIT ?
`);

const insertRollbackEvent = db.prepare(`
  INSERT INTO rollback_events (timestamp, trigger_type, from_version, to_version, trigger_details, discord_sent)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectRecentRollbacks = db.prepare(`
  SELECT * FROM rollback_events ORDER BY id DESC LIMIT ?
`);

const insertMorningBriefing = db.prepare(`
  INSERT INTO morning_briefings (date, version, briefing, changes, performance_summary, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET
    version = excluded.version,
    briefing = excluded.briefing,
    changes = excluded.changes,
    performance_summary = excluded.performance_summary,
    created_at = excluded.created_at
`);

const selectMorningBriefingByDate = db.prepare(`
  SELECT * FROM morning_briefings WHERE date = ?
`);

const selectLatestBriefing = db.prepare(`
  SELECT * FROM morning_briefings ORDER BY date DESC LIMIT 1
`);

// Replay engine prepared statements
const insertRawSnapshot = db.prepare(`
  INSERT INTO gex_raw_snapshots (timestamp, ticker, spot_price, aggregated_gex, all_exp_gex,
    near_term_gex, vex_map, strikes, expirations, walls,
    multi_analysis, tv_snapshot, scored_direction, scored_score, cycle_index)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectRawSnapshotsByDate = db.prepare(`
  SELECT * FROM gex_raw_snapshots
  WHERE timestamp LIKE ? || '%'
  ORDER BY cycle_index ASC, ticker ASC
`);

const selectRawSnapshotsByDateTicker = db.prepare(`
  SELECT * FROM gex_raw_snapshots
  WHERE timestamp LIKE ? || '%' AND ticker = ?
  ORDER BY cycle_index ASC
`);

const selectRawSnapshotDates = db.prepare(`
  SELECT DISTINCT substr(timestamp, 1, 10) as date,
         COUNT(*) as snapshots,
         COUNT(DISTINCT ticker) as tickers
  FROM gex_raw_snapshots
  GROUP BY date
  ORDER BY date DESC
  LIMIT ?
`);

// Backtest preset prepared statements
const upsertBacktestPreset = db.prepare(`
  INSERT INTO backtest_presets (name, config, description, created_at, updated_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(name) DO UPDATE SET
    config = excluded.config,
    description = excluded.description,
    updated_at = datetime('now')
`);

const selectAllBacktestPresets = db.prepare(`
  SELECT * FROM backtest_presets ORDER BY updated_at DESC
`);

const selectBacktestPreset = db.prepare(`
  SELECT * FROM backtest_presets WHERE name = ?
`);

const deleteBacktestPresetStmt = db.prepare(`
  DELETE FROM backtest_presets WHERE name = ?
`);

const selectTradesByDateRange = db.prepare(`
  SELECT * FROM trades WHERE closed_at IS NOT NULL AND is_phantom = 0 AND opened_at >= ? AND opened_at <= ? ORDER BY opened_at ASC
`);

const selectTradesForVersion = db.prepare(`
  SELECT * FROM trades WHERE strategy_version = ? AND closed_at IS NOT NULL AND is_phantom = 0 ORDER BY opened_at ASC
`);

const selectRecentClosedTrades = db.prepare(`
  SELECT * FROM trades WHERE closed_at IS NOT NULL AND is_phantom = 0 ORDER BY closed_at DESC LIMIT ?
`);

// Phase 3 prepared statements
const insertTrade = db.prepare(`
  INSERT INTO trades (opened_at, contract, direction, strike, entry_price, entry_spx,
    target_price, stop_price, target_spx, stop_spx, greeks_at_entry, gex_state_at_entry,
    tv_state_at_entry, agent_reasoning, is_phantom, state, last_update_at, strategy_version,
    strategy_lane, entry_trigger, entry_context)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateTradeClose = db.prepare(`
  UPDATE trades SET closed_at = ?, exit_price = ?, exit_spx = ?,
    pnl_dollars = ?, pnl_pct = ?, exit_reason = ?, state = 'CLOSED', last_update_at = ?
  WHERE id = ?
`);

const updateTradePnl = db.prepare(`
  UPDATE trades SET current_pnl_pct = ?, last_update_at = ? WHERE id = ?
`);

const updateTradeState = db.prepare(`
  UPDATE trades SET state = ?, last_update_at = ? WHERE id = ?
`);

const updateTradeTargetStmt = db.prepare(`
  UPDATE trades SET target_spx = ?, last_update_at = ? WHERE id = ?
`);

const selectOpenTrade = db.prepare(`
  SELECT * FROM trades WHERE state IN ('PENDING', 'IN_CALLS', 'IN_PUTS') AND is_phantom = 0 LIMIT 1
`);

const selectOpenPhantoms = db.prepare(`
  SELECT * FROM trades WHERE state IN ('PENDING', 'IN_CALLS', 'IN_PUTS') AND is_phantom = 1
`);

const selectTodaysTrades = db.prepare(`
  SELECT * FROM trades WHERE is_phantom = 0 AND opened_at LIKE ? || '%' ORDER BY id DESC
`);

const selectTradeById = db.prepare(`
  SELECT * FROM trades WHERE id = ?
`);

// ---- Public API ----

export function saveSnapshot(scored) {
  const ts = formatET(nowET());

  // Find dominant call wall (positive above) and put wall (positive below)
  const callWall = scored.wallsAbove.find(w => w.type === 'positive') || null;
  const putWall = scored.wallsBelow.find(w => w.type === 'positive') || null;

  insertSnapshot.run(
    ts,
    scored.spotPrice,
    scored.score,
    scored.direction,
    scored.confidence,
    scored.environment,
    scored.gexAtSpot,
    callWall ? JSON.stringify({ strike: callWall.strike, value: callWall.gexValue }) : null,
    putWall ? JSON.stringify({ strike: putWall.strike, value: putWall.gexValue }) : null,
    JSON.stringify(scored.wallsAbove),
    JSON.stringify(scored.wallsBelow),
    null, // skip raw_data to save space
    JSON.stringify(scored.breakdown),
  );
}

// ---- Replay engine: raw snapshot CRUD ----

export function saveRawSnapshot({ ticker, spotPrice, parsedData, walls, multiAnalysis, tvSnapshot, scoredDirection, scoredScore, cycleIndex }) {
  const ts = formatET(nowET());
  insertRawSnapshot.run(
    ts, ticker, spotPrice,
    serializeMap(parsedData.aggregatedGex),
    serializeMap(parsedData.allExpGex),
    serializeMap(parsedData.nearTermGex),
    serializeMap(parsedData.vexMap),
    JSON.stringify(parsedData.strikes),
    JSON.stringify(parsedData.expirations),
    JSON.stringify(walls),
    multiAnalysis ? JSON.stringify(multiAnalysis) : null,
    tvSnapshot ? JSON.stringify(tvSnapshot) : null,
    scoredDirection, scoredScore, cycleIndex,
  );
}

export function getRawSnapshotsByDate(dateStr) {
  return selectRawSnapshotsByDate.all(dateStr);
}

export function getRawSnapshotsByDateTicker(dateStr, ticker) {
  return selectRawSnapshotsByDateTicker.all(dateStr, ticker);
}

export function getRawSnapshotDates(limit = 30) {
  return selectRawSnapshotDates.all(limit);
}

export function reconstructParsedData(row) {
  return {
    spotPrice: row.spot_price,
    strikes: JSON.parse(row.strikes),
    expirations: JSON.parse(row.expirations),
    aggregatedGex: deserializeMap(row.aggregated_gex),
    allExpGex: deserializeMap(row.all_exp_gex),
    nearTermGex: deserializeMap(row.near_term_gex),
    vexMap: deserializeMap(row.vex_map),
    walls: [], // Re-generated by identifyWalls()
  };
}

export function saveWallTrend(strike, direction, oldValue, newValue, pctChange) {
  const ts = formatET(nowET());
  insertWallTrend.run(ts, strike, direction, oldValue, newValue, pctChange);
}

export function saveAlert(type, content, discordSent = true) {
  const ts = formatET(nowET());
  insertAlert.run(ts, type, JSON.stringify(content), discordSent ? 1 : 0);
}

export function saveHealth(service, status, details = null) {
  const ts = formatET(nowET());
  insertHealth.run(ts, service, status, details);
}

export function savePrediction(direction, score, spotPrice, targetStrike, floorStrike) {
  const ts = formatET(nowET());
  insertPrediction.run(ts, direction, score, spotPrice, targetStrike, floorStrike);
}

export function getLatestSnapshot() {
  return db.prepare('SELECT * FROM gex_snapshots ORDER BY id DESC LIMIT 1').get();
}

export function getRecentSnapshots(limit = 3) {
  return db.prepare('SELECT * FROM gex_snapshots ORDER BY id DESC LIMIT ?').all(limit);
}

export function getUncheckedPredictions() {
  return db.prepare(
    "SELECT * FROM predictions WHERE checked = 0 AND timestamp < datetime('now', '-30 minutes')"
  ).all();
}

export function markPredictionChecked(id, resultPrice, pctMove, win) {
  db.prepare(
    'UPDATE predictions SET checked = 1, result_price = ?, result_pct_move = ?, result_win = ? WHERE id = ?'
  ).run(resultPrice, pctMove, win ? 1 : 0, id);
}

export function getTodaysPredictions() {
  const today = formatET(nowET()).slice(0, 10);
  return db.prepare("SELECT * FROM predictions WHERE timestamp LIKE ? || '%'").all(today);
}

export function getPredictionsByDate(dateStr) {
  return db.prepare("SELECT * FROM predictions WHERE timestamp LIKE ? || '%'").all(dateStr);
}

export function getCheckedPredictionsToday() {
  const today = formatET(nowET()).slice(0, 10);
  return db.prepare(
    "SELECT * FROM predictions WHERE checked = 1 AND timestamp LIKE ? || '%'"
  ).all(today);
}

export function getRecentAlerts(type, minutes = 15) {
  const cutoff = formatET(nowET().minus({ minutes }));
  return db.prepare(
    'SELECT * FROM alerts WHERE type = ? AND timestamp > ? ORDER BY id DESC'
  ).all(type, cutoff);
}

/**
 * Get all recent alerts (any type) for the dashboard feed.
 */
export function getAlertsFeed(limit = 50) {
  return db.prepare(
    'SELECT * FROM alerts ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

export function getHealth() {
  return db.prepare('SELECT * FROM health ORDER BY id DESC LIMIT 10').get();
}

export function getLatestGex() {
  const snap = getLatestSnapshot();
  if (!snap) return { message: 'No GEX data yet' };
  return {
    timestamp: snap.timestamp,
    spot: snap.spot_price,
    score: snap.score,
    direction: snap.direction,
    confidence: snap.confidence,
    environment: snap.environment,
  };
}

// ---- Phase 2: TV Signal helpers ----

export function saveTvSignal(indicator, state, level = null, kind = null, isStale = false) {
  const ts = formatET(nowET());
  upsertTvSignal.run(indicator, state, level, kind, ts, isStale ? 1 : 0);
}

export function saveTvSignalLog(indicator, oldState, newState, payload = null) {
  const ts = formatET(nowET());
  insertTvSignalLog.run(ts, indicator, oldState, newState, payload);
}

export function loadTvSignals() {
  return db.prepare('SELECT * FROM tv_signals').all();
}

export function saveDecision(decision) {
  const ts = formatET(nowET());
  insertDecision.run(
    ts,
    decision.gexScore || null,
    decision.gexDirection || null,
    decision.gexConfidence || null,
    decision.tvState ? JSON.stringify(decision.tvState) : null,
    decision.confirmations || null,
    decision.confirmationMode || null,
    decision.action || 'WAIT',
    decision.confidence || 'LOW',
    decision.reason || null,
    decision.inputTokens || null,
    decision.outputTokens || null,
    decision.responseTimeMs || null,
    decision.skipped ? 1 : 0,
  );
}

export function getLatestDecision() {
  return db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 1').get();
}

export function getTodaysDecisions() {
  const today = formatET(nowET()).slice(0, 10);
  return db.prepare("SELECT * FROM decisions WHERE timestamp LIKE ? || '%'").all(today);
}

// ---- Phase 3: Trade helpers ----

export function openTrade(trade) {
  const ts = formatET(nowET());
  const result = insertTrade.run(
    ts,
    trade.contract,
    trade.direction,
    trade.strike,
    trade.entryPrice,
    trade.entrySpx,
    trade.targetPrice,
    trade.stopPrice,
    trade.targetSpx,
    trade.stopSpx,
    JSON.stringify(trade.greeks),
    JSON.stringify(trade.gexState),
    JSON.stringify(trade.tvState),
    trade.agentReasoning || null,
    trade.isPhantom ? 1 : 0,
    trade.state || 'PENDING',
    ts,
    trade.strategyVersion || 'v1',
    trade.strategyLane || null,
    trade.entryTrigger || null,
    trade.entryContext ? JSON.stringify(trade.entryContext) : null,
  );
  return result.lastInsertRowid;
}

export function closeTrade(id, { exitPrice, exitSpx, pnlDollars, pnlPct, exitReason }) {
  const ts = formatET(nowET());
  updateTradeClose.run(ts, exitPrice, exitSpx, pnlDollars, pnlPct, exitReason, ts, id);
}

export function updateTradePnlDb(id, currentPnlPct) {
  const ts = formatET(nowET());
  updateTradePnl.run(currentPnlPct, ts, id);
}

export function confirmTrade(id, state) {
  const ts = formatET(nowET());
  updateTradeState.run(state, ts, id);
}

export function updateTradeTargetDb(id, newTargetSpx) {
  const ts = formatET(nowET());
  updateTradeTargetStmt.run(newTargetSpx, ts, id);
}

export function getOpenTrade() {
  return selectOpenTrade.get() || null;
}

export function getOpenPhantoms() {
  return selectOpenPhantoms.all();
}

export function getTodaysTrades() {
  const today = formatET(nowET()).slice(0, 10);
  return selectTodaysTrades.all(today);
}

export function getTradeById(id) {
  return selectTradeById.get(id) || null;
}

export function saveMultiAnalysis(analysis, trinityState) {
  const now = formatET(nowET());
  insertMultiAnalysis.run(
    now,
    analysis.driver?.ticker || null,
    analysis.driver?.reason || null,
    analysis.alignment?.direction || null,
    analysis.alignment?.count || 0,
    JSON.stringify(analysis.stacked_walls || []),
    JSON.stringify(analysis.rug_setups || []),
    JSON.stringify(analysis.node_slides || []),
    analysis.multi_signal?.direction || null,
    analysis.multi_signal?.confidence || null,
    analysis.multi_signal?.reason || null,
    trinityState?.spxw?.scored?.score || null,
    trinityState?.spy?.scored?.score || null,
    trinityState?.qqq?.scored?.score || null,
  );
}

export function getLatestMultiAnalysis() {
  return db.prepare('SELECT * FROM multi_ticker_analysis ORDER BY id DESC LIMIT 1').get() || null;
}

// ---- Phase 5: Strategy version helpers ----

export function saveStrategyVersion(versionData) {
  const ts = formatET(nowET());
  insertStrategyVersion.run(
    versionData.version,
    ts,
    versionData.parentVersion || null,
    JSON.stringify(versionData.config),
    JSON.stringify(versionData.changeSummary || []),
    versionData.source,
    JSON.stringify(versionData.reviewAnalysis || null),
    versionData.isActive ? 1 : 0,
    versionData.isV1Floor ? 1 : 0,
    versionData.inputTokens || null,
    versionData.outputTokens || null,
    versionData.responseTimeMs || null,
  );
}

export function activateVersion(version) {
  updateDeactivateAllVersions.run();
  updateActivateVersion.run(version);
}

export function getActiveVersion() {
  return selectActiveVersion.get() || null;
}

export function getVersionByNumber(v) {
  return selectVersionByNumber.get(v) || null;
}

export function getAllVersions() {
  return selectAllVersions.all();
}

export function getV1Floor() {
  return selectV1Floor.get() || null;
}

export function getNextVersionNumber() {
  return selectNextVersionNumber.get().next_version;
}

export function savePhantomComparison(comp) {
  const ts = formatET(nowET());
  insertPhantomComparison.run(
    comp.tradeId,
    ts,
    comp.currentVersion,
    comp.previousVersion || null,
    comp.currentWouldEnter ? 1 : 0,
    comp.previousWouldEnter ? 1 : 0,
    comp.currentWouldExit || null,
    comp.previousWouldExit || null,
    comp.tradePnlDollars || null,
    comp.tradePnlPct || null,
    comp.assessment,
    JSON.stringify(comp.details || {}),
  );
}

export function getPhantomComparisonsForVersion(version) {
  return selectPhantomComparisonsForVersion.all(version);
}

export function getRecentPhantomComparisons(limit = 20) {
  return selectRecentPhantomComparisons.all(limit);
}

export function saveRollbackEvent(event) {
  const ts = formatET(nowET());
  insertRollbackEvent.run(
    ts,
    event.triggerType,
    event.fromVersion,
    event.toVersion,
    JSON.stringify(event.triggerDetails || {}),
    event.discordSent ? 1 : 0,
  );
}

export function getRecentRollbacks(limit = 20) {
  return selectRecentRollbacks.all(limit);
}

export function saveMorningBriefing(briefing) {
  const ts = formatET(nowET());
  insertMorningBriefing.run(
    briefing.date,
    briefing.version,
    typeof briefing.briefing === 'string' ? briefing.briefing : JSON.stringify(briefing.briefing),
    typeof briefing.changes === 'string' ? briefing.changes : JSON.stringify(briefing.changes || []),
    typeof briefing.performanceSummary === 'string' ? briefing.performanceSummary : JSON.stringify(briefing.performanceSummary || {}),
    ts,
  );
}

export function getMorningBriefing(date) {
  return selectMorningBriefingByDate.get(date) || null;
}

export function getLatestBriefing() {
  return selectLatestBriefing.get() || null;
}

export function getRecentClosedTrades(limit = 50) {
  return selectRecentClosedTrades.all(limit);
}

export function getTradesByDateRange(start, end) {
  return selectTradesByDateRange.all(start, end);
}

export function getTradesForVersion(versionLabel) {
  return selectTradesForVersion.all(versionLabel);
}

// ---- EOD Summary helpers ----

export function getDecisionsByDate(dateStr) {
  return db.prepare("SELECT * FROM decisions WHERE timestamp LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getTvSignalLogByDate(dateStr) {
  return db.prepare("SELECT * FROM tv_signal_log WHERE timestamp LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getGexSnapshotsByDate(dateStr) {
  return db.prepare("SELECT * FROM gex_snapshots WHERE timestamp LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getAlertsByDate(dateStr) {
  return db.prepare("SELECT * FROM alerts WHERE timestamp LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getPhantomTradesByDate(dateStr) {
  return db.prepare("SELECT * FROM trades WHERE is_phantom = 1 AND opened_at LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getTradesByDate(dateStr) {
  return db.prepare("SELECT * FROM trades WHERE is_phantom = 0 AND opened_at LIKE ? || '%' ORDER BY id ASC").all(dateStr);
}

export function getTradesByLane(lane, dateStr) {
  return db.prepare("SELECT * FROM trades WHERE strategy_lane = ? AND opened_at LIKE ? || '%' ORDER BY id ASC").all(lane, dateStr);
}

export function getTradesByTrigger(trigger, dateStr) {
  return db.prepare("SELECT * FROM trades WHERE entry_trigger = ? AND opened_at LIKE ? || '%' ORDER BY id ASC").all(trigger, dateStr);
}

/**
 * Get rolling pattern performance over multiple days.
 * Returns win rate, avg P&L by entry_trigger pattern.
 */
export function getPatternPerformance(daysBack = 7) {
  return db.prepare(`
    SELECT entry_trigger,
           COUNT(*) as total,
           SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl_dollars <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
           ROUND(AVG(CASE WHEN pnl_dollars > 0 THEN pnl_pct ELSE NULL END), 2) as avg_win_pct,
           ROUND(AVG(CASE WHEN pnl_dollars <= 0 THEN pnl_pct ELSE NULL END), 2) as avg_loss_pct
    FROM trades
    WHERE entry_trigger IS NOT NULL
      AND closed_at IS NOT NULL
      AND opened_at >= datetime('now', '-' || ? || ' days')
    GROUP BY entry_trigger
  `).all(daysBack);
}

// ---- Backtest preset helpers ----

export function saveBacktestPreset(name, config, description = null) {
  upsertBacktestPreset.run(name, JSON.stringify(config), description);
}

export function getBacktestPresets() {
  return selectAllBacktestPresets.all().map(p => ({
    ...p,
    config: JSON.parse(p.config),
  }));
}

export function getBacktestPreset(name) {
  const row = selectBacktestPreset.get(name);
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config) };
}

export function deleteBacktestPreset(name) {
  return deleteBacktestPresetStmt.run(name);
}

export function cleanupOldData(daysToKeep = 7) {
  const cutoff = formatET(nowET().minus({ days: daysToKeep }));
  const tables = ['gex_snapshots', 'wall_trends', 'alerts', 'health', 'predictions', 'tv_signal_log', 'decisions', 'multi_ticker_analysis'];
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table} WHERE timestamp < ?`).run(cutoff);
  }
  // trades uses opened_at instead of timestamp
  db.prepare('DELETE FROM trades WHERE opened_at < ?').run(cutoff);

  // Phase 5 tables: keep strategy_versions forever, clean others at 30 days
  const longCutoff = formatET(nowET().minus({ days: 30 }));
  db.prepare('DELETE FROM phantom_comparisons WHERE timestamp < ?').run(longCutoff);
  db.prepare('DELETE FROM rollback_events WHERE timestamp < ?').run(longCutoff);
  db.prepare('DELETE FROM morning_briefings WHERE created_at < ?').run(longCutoff);
  db.prepare('DELETE FROM gex_raw_snapshots WHERE timestamp < ?').run(longCutoff);

  log.info(`Cleaned up data older than ${daysToKeep} days (strategy/replay data: 30 days)`);
}

export default db;
