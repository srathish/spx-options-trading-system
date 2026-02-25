/**
 * Claude Sonnet client for nightly/weekly strategy reviews.
 * Uses Anthropic SDK — separate from the Kimi client used for real-time decisions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Sonnet');

let client = null;

function getClient() {
  if (!client && config.anthropicApiKey) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/**
 * Call Claude Sonnet with a system prompt and user content.
 * Returns { parsed, raw, tokenUsage }.
 * Handles markdown code fence stripping since Sonnet doesn't have response_format.
 */
export async function callSonnet(systemPrompt, userContent, opts = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const start = Date.now();

  const response = await c.messages.create({
    model: config.sonnetModel || 'claude-sonnet-4-20250514',
    max_tokens: opts.maxTokens || config.sonnetMaxTokens || 4096,
    temperature: opts.temperature ?? 0.3,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent),
    }],
  });

  const text = response.content?.[0]?.text || '';
  const elapsed = Date.now() - start;

  log.info(`Sonnet response: ${elapsed}ms | ${response.usage?.input_tokens || 0}+${response.usage?.output_tokens || 0} tokens`);

  // Parse JSON — strip markdown fences if present
  let parsed;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    log.error('Sonnet returned invalid JSON:', text.slice(0, 500));
    throw new Error('Invalid JSON from Sonnet');
  }

  return {
    parsed,
    raw: text,
    tokenUsage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      responseTimeMs: elapsed,
    },
  };
}
