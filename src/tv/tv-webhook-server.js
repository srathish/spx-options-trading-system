/**
 * TradingView Webhook Server
 * Express.js server receiving alerts from TradingView Startup indicators.
 */

import express from 'express';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { updateSignal, getSignalSnapshot, getDetailedState } from './tv-signal-store.js';
import { saveTvSignalLog } from '../store/db.js';

const log = createLogger('TV-Webhook');

let server = null;

const VALID_INDICATORS = ['bravo', 'tango'];

/**
 * Start the webhook server.
 */
export function startWebhookServer() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'openclaw-tv-webhook' });
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

    // 2. Validate payload
    const { ind, sig, tf, ticker, time, level } = req.body;

    if (!ind || !sig) {
      log.warn('Rejected: missing ind or sig in payload');
      return res.status(400).json({ error: 'Missing required fields: ind, sig' });
    }

    const indicator = ind.toLowerCase();
    if (!VALID_INDICATORS.includes(indicator)) {
      log.warn(`Rejected: unknown indicator "${indicator}"`);
      return res.status(400).json({ error: `Unknown indicator: ${ind}` });
    }

    // 3. Update signal store
    const oldState = undefined; // signal store handles old state tracking internally
    updateSignal(indicator, sig, level || null);

    // 4. Log to database
    try {
      saveTvSignalLog(indicator, null, sig.toUpperCase(), JSON.stringify(req.body));
    } catch (err) {
      log.error('Failed to log signal:', err.message);
    }

    // 5. Return success
    log.info(`Received: ${indicator} → ${sig} | tf=${tf || '?'} | ticker=${ticker || '?'}`);
    res.status(200).json({ ok: true, indicator, state: sig.toUpperCase() });
  });

  // Start listening
  const port = config.tvWebhookPort;
  server = app.listen(port, () => {
    log.info(`TV webhook server listening on port ${port}`);
    log.info(`Endpoint: POST http://localhost:${port}/webhook/tv?token=YOUR_SECRET`);
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
