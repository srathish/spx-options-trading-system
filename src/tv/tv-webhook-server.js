/**
 * TradingView Webhook Server
 * Express.js server receiving alerts from TradingView Startup indicators.
 * Supports Echo, Bravo, Tango across SPX/SPY/QQQ on 1m and 3m timeframes.
 */

import express from 'express';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { updateSignal, getSignalSnapshot, getDetailedState } from './tv-signal-store.js';
import { saveTvSignalLog } from '../store/db.js';

const log = createLogger('TV-Webhook');

let server = null;

const VALID_INDICATORS = ['echo', 'bravo', 'tango'];
const VALID_TICKERS = ['spx', 'spy', 'qqq'];
const VALID_TIMEFRAMES = ['1', '3', '5'];

// Signal level mapping from alert text
const SIGNAL_LEVELS = {
  diamond: '1',
  triangle: '2',
};

/**
 * Parse TradingView plain-text alert into structured signal data.
 * Format: "Startup <Indicator> <Color> <Pattern> <Timeframe>"
 * Example: "Startup Tango Pink Diamond 3" → { ind: 'tango', sig: 'PINK_1', tf: '3' }
 * Example: "Startup Echo Blue Diamond 1" → { ind: 'echo', sig: 'BLUE_1', tf: '1' }
 */
function parseAlertText(text) {
  if (typeof text !== 'string') return null;

  const cleaned = text.trim();
  // Match: Startup <Indicator> <Color> <Pattern> <TF>
  const match = cleaned.match(/^Startup\s+(Echo|Bravo|Tango)\s+(Blue|Pink|White)\s+(\w+)\s+(\d+)$/i);
  if (!match) return null;

  const [, indicator, color, pattern, tf] = match;
  const level = SIGNAL_LEVELS[pattern.toLowerCase()] || '1';
  const sig = `${color.toUpperCase()}_${level}`;

  return {
    ind: indicator.toLowerCase(),
    sig,
    tf,
    ticker: null, // comes from query param
    rawText: cleaned,
  };
}

/**
 * Start the webhook server.
 */
export function startWebhookServer() {
  const app = express();
  app.use(express.json());
  app.use(express.text());

  // TradingView sometimes sends text/plain — try to parse as JSON
  app.use((req, res, next) => {
    if (typeof req.body === 'string') {
      try { req.body = JSON.parse(req.body); } catch { /* leave as-is */ }
    }
    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'gexclaw-tv-webhook' });
  });

  // Signal state endpoint
  app.get('/signals', (req, res) => {
    res.json({
      snapshot: getSignalSnapshot(),
      detailed: getDetailedState(),
    });
  });

  // TradingView webhook endpoint
  app.post('/webhook/tv', (req, res) => {
    // 1. Validate secret token
    const token = req.query.token;
    if (!token || token !== config.tvWebhookSecret) {
      log.warn(`Rejected: invalid token from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // 2. Parse payload — supports both JSON and plain-text alerts
    log.info(`Webhook raw body: ${JSON.stringify(req.body).slice(0, 500)}`);

    let ind, sig, tf, ticker;

    if (typeof req.body === 'string') {
      // Plain-text alert: "Startup Tango Pink Diamond 3"
      const parsed = parseAlertText(req.body);
      if (parsed) {
        ind = parsed.ind;
        sig = parsed.sig;
        tf = parsed.tf;
        ticker = parsed.ticker;
        log.info(`Parsed text alert: "${req.body}" → ind=${ind} sig=${sig} tf=${tf}`);
      }
    } else if (req.body && typeof req.body === 'object') {
      // JSON payload: { ind, sig, tf, ticker }
      ({ ind, sig, tf, ticker } = req.body);
    }

    if (!ind || !sig) {
      log.warn(`Rejected: could not parse payload — raw: ${JSON.stringify(req.body).slice(0, 300)}`);
      return res.status(400).json({ error: 'Could not parse signal from payload' });
    }

    const indicator = ind.toLowerCase();
    if (!VALID_INDICATORS.includes(indicator)) {
      log.warn(`Rejected: unknown indicator "${indicator}"`);
      return res.status(400).json({ error: `Unknown indicator: ${ind}` });
    }

    // Resolve ticker: query param > payload > default 'spx'
    const resolvedTicker = (req.query.ticker || ticker || 'spx').toLowerCase();
    if (!VALID_TICKERS.includes(resolvedTicker)) {
      log.warn(`Rejected: unknown ticker "${resolvedTicker}"`);
      return res.status(400).json({ error: `Unknown ticker: ${resolvedTicker}` });
    }

    // Resolve timeframe: from parsed text > payload > query param > default '3'
    const resolvedTf = String(tf || req.query.tf || '3');
    if (!VALID_TIMEFRAMES.includes(resolvedTf)) {
      log.warn(`Rejected: unknown timeframe "${resolvedTf}"`);
      return res.status(400).json({ error: `Unknown timeframe: ${resolvedTf}` });
    }

    // Resolve timing: "open" (early) or "close" (confirmed)
    const timing = (req.query.timing || 'close').toLowerCase();
    const confirmed = timing !== 'open';

    // 3. Update signal store (per-ticker, per-timeframe, with timing)
    updateSignal(indicator, sig, resolvedTicker, resolvedTf, confirmed);

    // 4. Log to database (with full key: ticker_indicator_timeframe)
    try {
      saveTvSignalLog(`${resolvedTicker}_${indicator}_${resolvedTf}`, null, sig.toUpperCase(), JSON.stringify({ ...req.body, timing, tf: resolvedTf }));
    } catch (err) {
      log.error('Failed to log signal:', err.message);
    }

    // 5. Return success
    const timingLabel = confirmed ? 'CONFIRMED' : 'EARLY';
    log.info(`Signal updated: ${resolvedTicker.toUpperCase()} ${indicator} ${resolvedTf}m → ${sig} [${timingLabel}]`);
    res.status(200).json({
      ok: true,
      ticker: resolvedTicker,
      indicator,
      timeframe: resolvedTf,
      state: sig.toUpperCase(),
      timing: timingLabel,
    });
  });

  // Start listening
  const port = config.tvWebhookPort;
  server = app.listen(port, () => {
    log.info(`TV webhook server listening on port ${port}`);
    log.info(`Endpoint: POST http://localhost:${port}/webhook/tv?token=YOUR_SECRET&ticker=spx`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} is already in use. Change TV_WEBHOOK_PORT in .env`);
    } else {
      log.error('Server error:', err.message);
    }
  });
}

/**
 * Stop the webhook server.
 */
export function stopWebhookServer() {
  if (server) {
    server.close(() => {
      log.info('TV webhook server stopped');
    });
    server = null;
  }
}
