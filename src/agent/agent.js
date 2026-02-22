/**
 * Kimi K2.5 AI Agent — OpenAI-compatible API wrapper.
 * Sends GEX + TV snapshot, returns structured trading decision.
 */

import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { getActiveConfig } from '../review/strategy-store.js';

const log = createLogger('Agent');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load system prompt template once at startup
let promptTemplate = '';
try {
  promptTemplate = readFileSync(join(__dirname, 'system-prompt.md'), 'utf-8');
  log.info(`System prompt template loaded (${promptTemplate.length} chars)`);
} catch (err) {
  log.error('Failed to load system-prompt.md:', err.message);
}

/**
 * Build the system prompt by replacing {placeholders} with active config values.
 */
function buildSystemPrompt() {
  const cfg = getActiveConfig();
  if (!cfg) return promptTemplate;

  return promptTemplate
    .replace(/\{gex_min_score\}/g, cfg.gex_min_score)
    .replace(/\{gex_strong_score\}/g, cfg.gex_strong_score)
    .replace(/\{min_confirmations\}/g, cfg.min_confirmations)
    .replace(/\{gex_exit_threshold\}/g, cfg.gex_exit_threshold)
    .replace(/\{gex_chop_zone_low\}/g, cfg.gex_chop_zone_low)
    .replace(/\{gex_chop_zone_high\}/g, cfg.gex_chop_zone_high)
    .replace(/\{wall_min_value\}/g, (cfg.wall_min_value / 1_000_000).toFixed(0))
    .replace(/\{wall_dominant_value\}/g, (cfg.wall_dominant_value / 1_000_000).toFixed(0))
    .replace(/\{no_entry_after\}/g, cfg.no_entry_after)
    .replace(/\{min_rr_ratio\}/g, cfg.min_rr_ratio);
}

// Initialize OpenAI client for Kimi
let client = null;
if (config.kimiApiKey) {
  client = new OpenAI({
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: config.kimiApiKey,
  });
  log.info(`Kimi agent initialized | Model: ${config.agentModel}`);
} else {
  log.warn('KIMI_API_KEY not set — agent calls will return WAIT');
}

// Default WAIT response for errors/fallback
const WAIT_RESPONSE = {
  action: 'WAIT',
  confidence: 'LOW',
  reason: 'Agent unavailable',
  confirmations: 0,
  confirmation_mode: 'BEGINNER',
  target_wall: null,
  stop_level: null,
  bullish_signals: [],
  bearish_signals: [],
  key_risk: 'Agent not available — defaulting to WAIT',
};

/**
 * Call the Kimi K2.5 agent with structured GEX + TV input.
 * Returns: { action, confidence, reason, confirmations, ..., input_tokens, output_tokens, response_time_ms }
 */
export async function callAgent(input) {
  if (!client) {
    return { ...WAIT_RESPONSE, reason: 'Kimi API key not configured' };
  }

  const startTime = Date.now();

  try {
    const systemPrompt = buildSystemPrompt();
    const response = await client.chat.completions.create({
      model: config.agentModel,
      temperature: config.agentTemperature,
      max_tokens: config.agentMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });

    const responseTimeMs = Date.now() - startTime;
    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      log.error('Agent returned empty response');
      return { ...WAIT_RESPONSE, reason: 'Agent returned empty response', response_time_ms: responseTimeMs };
    }

    let result;
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      log.error('Agent returned invalid JSON:', content.slice(0, 200));
      // Retry once
      return await retryAgent(input, startTime);
    }

    // Validate required fields
    if (!result.action || !result.confidence) {
      log.warn('Agent response missing required fields, defaulting');
      result.action = result.action || 'WAIT';
      result.confidence = result.confidence || 'LOW';
      result.reason = result.reason || 'Incomplete agent response';
    }

    // Normalize action
    result.action = result.action.toUpperCase();
    result.confidence = result.confidence.toUpperCase();

    const inputTokens = response.usage?.prompt_tokens || 0;
    const outputTokens = response.usage?.completion_tokens || 0;

    log.info(`Agent: ${result.action} (${result.confidence}) | ${responseTimeMs}ms | ${inputTokens}+${outputTokens} tokens`);
    log.debug(`Reason: ${result.reason}`);

    return {
      ...result,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      response_time_ms: responseTimeMs,
    };

  } catch (err) {
    const responseTimeMs = Date.now() - startTime;
    log.error(`Agent API error (${responseTimeMs}ms):`, err.message);

    return {
      ...WAIT_RESPONSE,
      reason: `Agent API error: ${err.message}`,
      response_time_ms: responseTimeMs,
    };
  }
}

/**
 * Retry the agent call once on parse failure.
 */
async function retryAgent(input, originalStartTime) {
  log.warn('Retrying agent call...');
  try {
    const systemPrompt = buildSystemPrompt();
    const response = await client.chat.completions.create({
      model: config.agentModel,
      temperature: config.agentTemperature,
      max_tokens: config.agentMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });

    const responseTimeMs = Date.now() - originalStartTime;
    const content = response.choices?.[0]?.message?.content;
    const result = JSON.parse(content);

    result.action = (result.action || 'WAIT').toUpperCase();
    result.confidence = (result.confidence || 'LOW').toUpperCase();

    return {
      ...result,
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
      response_time_ms: responseTimeMs,
    };
  } catch (retryErr) {
    const responseTimeMs = Date.now() - originalStartTime;
    log.error('Agent retry also failed:', retryErr.message);
    return {
      ...WAIT_RESPONSE,
      reason: `Agent retry failed: ${retryErr.message}`,
      response_time_ms: responseTimeMs,
    };
  }
}

/**
 * Check if the agent is configured and available.
 */
export function isAgentAvailable() {
  return !!client && !!promptTemplate;
}
