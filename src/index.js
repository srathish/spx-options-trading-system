/**
 * OpenClaw SPX Trading System — Entry Point
 * Phase 1: GEX monitor + Discord alerts
 * Phase 2: TradingView signals + Kimi K2.5 AI agent
 * Phase 3: Options intelligence + trade execution via Polygon.io
 */

import { config } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { initTokenManager, getAuthStatus } from './gex/token-manager.js';
import { startMainLoop, stopMainLoop } from './pipeline/main-loop.js';
import { startWebhookServer, stopWebhookServer } from './tv/tv-webhook-server.js';
import { isAgentAvailable } from './agent/agent.js';
import { isPolygonAvailable, testConnection } from './polygon/polygon-client.js';
import { startDashboardServer, stopDashboardServer } from './dashboard/dashboard-server.js';

const log = createLogger('OpenClaw');

log.info('OpenClaw SPX Trading System starting...');
log.info(`Environment: ${config.nodeEnv}`);
log.info(`Data directory: ${config.dataDir}`);
log.info(`Discord webhook: ${config.discordWebhookUrl ? 'configured' : 'NOT SET'}`);

// Validate required config
if (!config.discordWebhookUrl) {
  log.error('DISCORD_WEBHOOK_URL is required. Set it in .env');
  process.exit(1);
}

// Initialize token manager (Clerk auto-refresh)
initTokenManager();
const auth = getAuthStatus();
log.info(`Auth method: ${auth.method}`);

if (auth.method === 'none') {
  log.error('No auth configured. Set CLERK_SESSION_ID + CLERK_CLIENT_COOKIE (recommended) or HEATSEEKER_JWT in .env');
  process.exit(1);
}

// Start TV webhook server (Phase 2)
if (config.tvWebhookSecret) {
  startWebhookServer();
  log.info(`TV webhook server: port ${config.tvWebhookPort}`);
} else {
  log.warn('TV_WEBHOOK_SECRET not set — TV webhook server disabled');
}

// Log agent status (Phase 2)
if (isAgentAvailable()) {
  log.info(`AI agent: ${config.agentModel} ready`);
} else {
  log.warn('AI agent not available — set KIMI_API_KEY to enable');
}

// Log Polygon status (Phase 3)
if (isPolygonAvailable()) {
  log.info('Polygon.io: API key configured (15-min delayed quotes)');
  testConnection().then(ok => {
    if (ok) log.info('Polygon.io: connection verified');
    else log.warn('Polygon.io: connection test failed — will retry on first trade');
  });
} else {
  log.warn('Polygon.io not available — set POLYGON_API_KEY to enable trade cards');
}

// Start dashboard server (Phase 4)
startDashboardServer();
log.info(`Dashboard server: port ${config.dashboardPort}`);

// Start the main loop
startMainLoop();

// Graceful shutdown
function shutdown(signal) {
  log.info(`Received ${signal} — shutting down...`);
  stopMainLoop();
  stopWebhookServer();
  stopDashboardServer();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection:', err);
});
