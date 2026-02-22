import 'dotenv/config';
import { resolve } from 'path';

export const config = {
  // Heatseeker auth (static fallback)
  heatseekerJwt: process.env.HEATSEEKER_JWT || '',
  heatseekerCookies: process.env.HEATSEEKER_COOKIES || '',

  // Clerk auto-refresh auth (primary — log in once, never touch again)
  clerkSessionId: process.env.CLERK_SESSION_ID || '',
  clerkClientCookie: process.env.CLERK_CLIENT_COOKIE || '',
  clerkClientUat: process.env.CLERK_CLIENT_UAT || '',

  // Discord
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',

  // TradingView Webhook
  tvWebhookPort: parseInt(process.env.TV_WEBHOOK_PORT || '3001', 10),
  tvWebhookSecret: process.env.TV_WEBHOOK_SECRET || '',

  // Kimi K2.5 Agent
  kimiApiKey: process.env.KIMI_API_KEY || '',
  agentModel: process.env.AGENT_MODEL || 'kimi-k2.5',
  agentTemperature: parseFloat(process.env.AGENT_TEMPERATURE || '0'),
  agentMaxTokens: parseInt(process.env.AGENT_MAX_TOKENS || '500', 10),

  // Polygon.io (free tier = 15-min delayed quotes)
  polygonApiKey: process.env.POLYGON_API_KEY || '',

  // Dashboard
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3002', 10),

  // System
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  cycleIntervalMs: parseInt(process.env.CYCLE_INTERVAL_MS || '30000', 10),
};
