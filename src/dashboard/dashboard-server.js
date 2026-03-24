/**
 * Dashboard Server — Express REST + WebSocket on a shared HTTP server.
 * Serves live data to the Next.js dashboard on port 3002.
 *
 * EventEmitter pattern: main-loop.js emits events → broadcast to WS clients.
 * REST endpoints for historical data (trades, performance, system health).
 */

import { createServer } from 'http';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { getLoopStatus } from '../pipeline/loop-status.js';
import { getSchedulePhase, nowET, formatET } from '../utils/market-hours.js';
import { getLatestSnapshot, getHealth, getTodaysTrades, getOpenPhantoms, getPhantomTradesByDate, getTodaysDecisions, getCheckedPredictionsToday, getTodaysPredictions, getPredictionsByDate, getAllVersions, getRecentRollbacks, getLatestBriefing, getAlertsFeed, getRawSnapshotDates, saveBacktestPreset, getBacktestPresets, deleteBacktestPreset } from '../store/db.js';
import { getPositionState, getCurrentPosition } from '../trades/trade-manager.js';
import { getCurrentDecision } from '../agent/decision-engine.js';
import { getSignalSnapshot, getDetailedState, updateSignal } from '../tv/tv-signal-store.js';
import { saveTvSignalLog } from '../store/db.js';
import { getTrinityState } from '../gex/trinity.js';
import { getActiveVersionNumber, getActiveConfig, getVersionLabel } from '../review/strategy-store.js';
import { callKimiChat, isAgentAvailable, callBacktestChat } from '../agent/chat-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('Dashboard');

// ---- EventEmitter (main-loop pushes events here) ----

export const dashboardEmitter = new EventEmitter();

// ---- Server state ----

let httpServer = null;
let wss = null;

// In-memory chat history (resets on restart)
const chatHistory = [];
const MAX_CHAT_HISTORY = 20;

// ---- WebSocket broadcast ----

function broadcast(event, data) {
  if (!wss) return;
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  }
}

// Wire emitter events to WS broadcast
const EVENTS = ['gex_update', 'tv_update', 'decision_update', 'position_update', 'trade_opened', 'trade_closed', 'health_update', 'trinity_update', 'strategy_update', 'strategy_rollback', 'alert', 'entry_blocked'];
for (const evt of EVENTS) {
  dashboardEmitter.on(evt, (data) => {
    try {
      broadcast(evt, data);
    } catch (err) {
      log.error(`Broadcast error (${evt}): ${err.message}`);
    }
  });
}

// ---- Build full state snapshot (sent on WS connect) ----

function buildFullState() {
  const loopStatus = getLoopStatus();
  const phase = getSchedulePhase();
  const snapshot = getLatestSnapshot();
  const decision = getCurrentDecision();
  const positionState = getPositionState();
  const position = getCurrentPosition();
  const tvSnapshot = getSignalSnapshot();
  const tvDetailed = getDetailedState();

  return {
    loop: loopStatus,
    phase: { phase: phase.phase, description: phase.description, pollIntervalMs: phase.pollIntervalMs, alertsActive: phase.alertsActive },
    gex: snapshot ? {
      timestamp: snapshot.timestamp,
      spotPrice: snapshot.spot_price,
      score: snapshot.score,
      direction: snapshot.direction,
      confidence: snapshot.confidence,
      environment: snapshot.environment,
      wallsAbove: JSON.parse(snapshot.walls_above || '[]'),
      wallsBelow: JSON.parse(snapshot.walls_below || '[]'),
      breakdown: JSON.parse(snapshot.breakdown || '[]'),
    } : null,
    decision: decision,
    position: { state: positionState, details: position },
    tv: { snapshot: tvSnapshot, detailed: tvDetailed },
    trinity: getTrinityState(),
    strategy: { version: getActiveVersionNumber(), label: getVersionLabel(), config: getActiveConfig() },
    serverTime: formatET(nowET()),
  };
}

// ---- REST API ----

function createApi() {
  const app = express();

  // CORS for Next.js dev server
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Parse JSON bodies for POST endpoints
  app.use(express.json());

  // GET /api/status — full state
  app.get('/api/status', (req, res) => {
    try {
      res.json(buildFullState());
    } catch (err) {
      log.error('GET /api/status error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/position — current position
  app.get('/api/position', (req, res) => {
    try {
      res.json({ state: getPositionState(), details: getCurrentPosition() });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/trades/today — today's trades
  app.get('/api/trades/today', (req, res) => {
    try {
      res.json(getTodaysTrades());
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/phantoms — open phantom trades
  app.get('/api/phantoms', (req, res) => {
    try {
      res.json(getOpenPhantoms());
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/phantoms/today — all phantoms (open + closed) for a date
  app.get('/api/phantoms/today', (req, res) => {
    try {
      const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : nowET().toFormat('yyyy-MM-dd');
      res.json(getPhantomTradesByDate(date));
    } catch (err) {
      log.error('GET /api/phantoms/today error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/performance — aggregated performance
  app.get('/api/performance', (req, res) => {
    try {
      const trades = getTodaysTrades();
      const predictions = getCheckedPredictionsToday();

      const closedTrades = trades.filter(t => t.exit_reason);
      const wins = closedTrades.filter(t => t.pnl_dollars > 0);
      const losses = closedTrades.filter(t => t.pnl_dollars <= 0);

      res.json({
        trades: closedTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length * 100).toFixed(1) : 0,
        totalPnl: closedTrades.reduce((s, t) => s + (t.pnl_dollars || 0), 0),
        bestTrade: closedTrades.sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0))[0] || null,
        worstTrade: closedTrades.sort((a, b) => (a.pnl_pct || 0) - (b.pnl_pct || 0))[0] || null,
        predictions: {
          total: predictions.length,
          correct: predictions.filter(p => p.result_win).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/system/health — health + loop status
  app.get('/api/system/health', (req, res) => {
    try {
      const health = getHealth();
      const loop = getLoopStatus();
      res.json({ health, loop });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/system/costs — token usage today
  app.get('/api/system/costs', (req, res) => {
    try {
      const decisions = getTodaysDecisions();
      const totalInput = decisions.reduce((s, d) => s + (d.input_tokens || 0), 0);
      const totalOutput = decisions.reduce((s, d) => s + (d.output_tokens || 0), 0);
      const agentCalls = decisions.filter(d => !d.skipped).length;

      res.json({
        agentCalls,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        estimatedCost: ((totalInput * 0.002 + totalOutput * 0.006) / 1000).toFixed(4),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/trinity — trinity cross-market state
  app.get('/api/trinity', (req, res) => {
    try {
      res.json(getTrinityState() || { spxw: null, spy: null, qqq: null });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/decisions — today's decisions
  app.get('/api/decisions', (req, res) => {
    try {
      const decisions = getTodaysDecisions();
      res.json(decisions.slice(0, 50));
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/alerts — recent alert feed
  app.get('/api/alerts', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const alerts = getAlertsFeed(limit).map(a => ({
        id: a.id,
        timestamp: a.timestamp,
        type: a.type,
        content: (() => { try { return JSON.parse(a.content); } catch { return a.content; } })(),
        discord_sent: !!a.discord_sent,
      }));
      res.json(alerts);
    } catch (err) {
      log.error('GET /api/alerts error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/trade-ideas — trade ideas (predictions), ?date=YYYY-MM-DD for history
  app.get('/api/trade-ideas', (req, res) => {
    try {
      const date = req.query.date;
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.json(getPredictionsByDate(date));
      } else {
        res.json(getTodaysPredictions());
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Phase 5: Strategy endpoints ----

  // GET /api/strategy/active — active version + config
  app.get('/api/strategy/active', (req, res) => {
    try {
      res.json({
        version: getActiveVersionNumber(),
        label: getVersionLabel(),
        config: getActiveConfig(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/strategy/versions — all versions
  app.get('/api/strategy/versions', (req, res) => {
    try {
      const versions = getAllVersions().map(v => ({
        ...v,
        config: JSON.parse(v.config || '{}'),
        change_summary: JSON.parse(v.change_summary || '[]'),
        review_analysis: v.review_analysis ? JSON.parse(v.review_analysis) : null,
      }));
      res.json(versions);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/strategy/rollbacks — recent rollback events
  app.get('/api/strategy/rollbacks', (req, res) => {
    try {
      const rollbacks = getRecentRollbacks(20).map(r => ({
        ...r,
        trigger_details: r.trigger_details ? JSON.parse(r.trigger_details) : null,
      }));
      res.json(rollbacks);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/strategy/briefing — today's or latest morning briefing
  app.get('/api/strategy/briefing', (req, res) => {
    try {
      const briefing = getLatestBriefing();
      if (!briefing) {
        res.json(null);
        return;
      }
      // Parse JSON fields — handle double-encoded values from older saves
      let changes = briefing.changes || '[]';
      try { changes = JSON.parse(changes); } catch { changes = []; }
      if (typeof changes === 'string') { try { changes = JSON.parse(changes); } catch { changes = []; } }

      let perfSummary = briefing.performance_summary || '{}';
      try { perfSummary = JSON.parse(perfSummary); } catch { perfSummary = {}; }
      if (typeof perfSummary === 'string') { try { perfSummary = JSON.parse(perfSummary); } catch { perfSummary = {}; }  }

      let briefingText = briefing.briefing || '';
      if (briefingText.startsWith('"') && briefingText.endsWith('"')) {
        try { briefingText = JSON.parse(briefingText); } catch { /* keep as-is */ }
      }

      res.json({
        ...briefing,
        briefing: briefingText,
        changes,
        performance_summary: perfSummary,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Manual TV Signal Input ----

  // POST /api/signals/manual — user sends TV shape signals from the dashboard
  app.post('/api/signals/manual', (req, res) => {
    try {
      const { indicator, signal, ticker } = req.body;

      if (!indicator || !signal) {
        return res.status(400).json({ error: 'indicator and signal are required' });
      }

      const ind = indicator.toLowerCase();
      const tkr = (ticker || 'spx').toLowerCase();

      if (!['bravo', 'tango'].includes(ind)) {
        return res.status(400).json({ error: `Unknown indicator: ${ind}` });
      }
      if (!['spx', 'spy', 'qqq'].includes(tkr)) {
        return res.status(400).json({ error: `Unknown ticker: ${tkr}` });
      }

      // Update the TV signal store (same as webhook)
      updateSignal(ind, signal, tkr);

      // Log to DB
      try {
        saveTvSignalLog(`${tkr}_${ind}`, null, signal.toUpperCase(), JSON.stringify({ source: 'manual', ...req.body }));
      } catch (_) {}

      // Broadcast TV update to all dashboard clients
      broadcast('tv_update', { snapshot: getSignalSnapshot(), detailed: getDetailedState() });

      log.info(`Manual signal: ${tkr.toUpperCase()} ${ind.toUpperCase()} → ${signal} (from dashboard)`);
      res.json({ ok: true, ticker: tkr, indicator: ind, signal });
    } catch (err) {
      log.error('POST /api/signals/manual error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Backtest endpoints ----

  // GET /api/backtest/dates — list available replay dates
  app.get('/api/backtest/dates', (req, res) => {
    try {
      const dates = getRawSnapshotDates(30);
      res.json(dates);
    } catch (err) {
      log.error('GET /api/backtest/dates error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /api/backtest/run — run replay in forked child process
  app.post('/api/backtest/run', (req, res) => {
    try {
      const { date, configOverride } = req.body;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) is required' });
      }

      const replayScript = join(__dirname, '..', 'backtest', 'replay.js');
      const child = fork(replayScript, [], { silent: true });
      let responded = false;

      child.send({ date, configOverride: configOverride || null });

      child.on('message', (msg) => {
        if (responded) return;
        responded = true;
        if (msg.type === 'result') {
          res.json(msg.data);
        } else {
          res.status(500).json({ error: msg.message || 'Replay failed' });
        }
      });

      child.on('error', (err) => {
        if (responded) return;
        responded = true;
        log.error('Replay fork error:', err.message);
        res.status(500).json({ error: err.message });
      });

      child.on('exit', (code) => {
        if (responded) return;
        responded = true;
        if (code !== 0) {
          res.status(500).json({ error: `Replay process exited with code ${code}` });
        }
      });

      // Timeout after 120s
      setTimeout(() => {
        if (responded) return;
        responded = true;
        child.kill();
        res.status(504).json({ error: 'Replay timeout (120s)' });
      }, 120_000);

    } catch (err) {
      log.error('POST /api/backtest/run error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /api/backtest/chat — backtest strategy advisor chat
  app.post('/api/backtest/chat', async (req, res) => {
    try {
      const { message, currentConfig, lastRunResults, history } = req.body;
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }

      if (!isAgentAvailable()) {
        return res.status(503).json({ error: 'Chat agent not available — KIMI_API_KEY not set' });
      }

      const result = await callBacktestChat(
        message.trim(),
        currentConfig || getActiveConfig(),
        lastRunResults || null,
        history || [],
      );

      res.json({
        reply: result.reply,
        suggestedConfig: result.suggestedConfig,
        tokens_used: result.tokens_used,
        response_time_ms: result.response_time_ms,
      });
    } catch (err) {
      log.error('POST /api/backtest/chat error:', err.message);
      res.status(500).json({ error: 'Chat request failed' });
    }
  });

  // GET /api/backtest/presets — list all saved presets
  app.get('/api/backtest/presets', (req, res) => {
    try {
      res.json(getBacktestPresets());
    } catch (err) {
      log.error('GET /api/backtest/presets error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /api/backtest/presets — save a preset
  app.post('/api/backtest/presets', (req, res) => {
    try {
      const { name, config: presetConfig, description } = req.body;
      if (!name || !presetConfig) {
        return res.status(400).json({ error: 'name and config are required' });
      }
      saveBacktestPreset(name, presetConfig, description || null);
      res.json({ ok: true, name });
    } catch (err) {
      log.error('POST /api/backtest/presets error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // DELETE /api/backtest/presets/:name — delete a preset
  app.delete('/api/backtest/presets/:name', (req, res) => {
    try {
      const { name } = req.params;
      deleteBacktestPreset(decodeURIComponent(name));
      res.json({ ok: true });
    } catch (err) {
      log.error('DELETE /api/backtest/presets error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Chat endpoints ----

  // GET /api/chat/history — return current session chat history
  app.get('/api/chat/history', (req, res) => {
    res.json(chatHistory);
  });

  // POST /api/chat — send a message to the chat agent
  app.post('/api/chat', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }

      if (!isAgentAvailable()) {
        return res.status(503).json({ error: 'Chat agent not available — KIMI_API_KEY not set' });
      }

      const currentState = buildFullState();
      const result = await callKimiChat(message.trim(), currentState, chatHistory);

      // Save to in-memory history
      chatHistory.push({ sender: 'user', text: message.trim(), timestamp: Date.now() });
      chatHistory.push({ sender: 'agent', text: result.reply, timestamp: Date.now() });

      // Trim history to max
      while (chatHistory.length > MAX_CHAT_HISTORY * 2) {
        chatHistory.shift();
      }

      res.json({
        reply: result.reply,
        tokens_used: result.tokens_used,
        response_time_ms: result.response_time_ms,
      });
    } catch (err) {
      log.error('POST /api/chat error:', err.message);
      res.status(500).json({ error: 'Chat request failed' });
    }
  });

  return app;
}

// ---- Start / Stop ----

export function startDashboardServer() {
  const app = createApi();
  httpServer = createServer(app);

  // WebSocket server on /ws path
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    log.info(`Dashboard client connected (${wss.clients.size} total)`);

    // Send full state on connect
    try {
      const state = buildFullState();
      ws.send(JSON.stringify({ event: 'FULL_STATE', data: state, ts: Date.now() }));
    } catch (err) {
      log.error('Failed to send FULL_STATE:', err.message);
    }

    ws.on('close', () => {
      log.debug(`Dashboard client disconnected (${wss?.clients?.size ?? 0} remaining)`);
    });

    ws.on('error', (err) => {
      log.error('WebSocket client error:', err.message);
    });
  });

  // Health heartbeat every 5 min
  const heartbeat = setInterval(() => {
    try {
      broadcast('health_update', { loop: getLoopStatus(), time: formatET(nowET()) });
    } catch (err) {
      log.error('Heartbeat error:', err.message);
    }
  }, 5 * 60_000);

  const port = config.dashboardPort;
  httpServer.listen(port, () => {
    log.info(`Dashboard server listening on port ${port}`);
    log.info(`  REST: http://localhost:${port}/api/status`);
    log.info(`  WS:   ws://localhost:${port}/ws`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} already in use. Change DASHBOARD_PORT in .env`);
    } else {
      log.error('Dashboard server error:', err.message);
    }
  });

  // Store heartbeat ref for cleanup
  httpServer._heartbeat = heartbeat;
}

export function stopDashboardServer() {
  if (httpServer) {
    clearInterval(httpServer._heartbeat);
    wss?.close();
    httpServer.close(() => {
      log.info('Dashboard server stopped');
    });
    httpServer = null;
    wss = null;
  }
}
