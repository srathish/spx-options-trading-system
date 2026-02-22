/**
 * Chat Agent — Conversational Kimi K2.5 endpoint for the dashboard chat panel.
 * Separate from the trading decision agent (agent.js).
 * Every message gets fresh system state injected for full context.
 */

import OpenAI from 'openai';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ChatAgent');

const CHAT_SYSTEM_PROMPT = `You are OpenClaw's conversational trading assistant. You help the operator understand the current market setup, GEX positioning, TV signal states, and the automated trading system's decisions.

Key rules:
- You have FULL real-time data access — it's injected below as context. Use specific numbers, levels, and states in your answers.
- Be direct and concise. No filler. Use trading terminology naturally.
- You are NOT making trading decisions — the automated 30-second loop handles that. You explain, analyze, and discuss.
- Never give financial advice. Discuss data and system state objectively.
- If asked "why" the system is doing something, reference the specific GEX score, TV confirmations, thresholds, and rules that drive the decision.
- Format responses with short paragraphs. Use bullet points for lists of levels or signals.`;

// Initialize OpenAI client for Kimi
let client = null;
if (config.kimiApiKey) {
  client = new OpenAI({
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: config.kimiApiKey,
  });
  log.info('Chat agent initialized');
} else {
  log.warn('KIMI_API_KEY not set — chat agent unavailable');
}

/**
 * Check if the chat agent is available.
 */
export function isAgentAvailable() {
  return client !== null;
}

/**
 * Call Kimi K2.5 for a conversational chat response.
 * @param {string} message - User's message
 * @param {object} currentState - Full system state from buildFullState()
 * @param {Array} history - Recent chat history [{sender, text}]
 * @returns {{ reply: string, tokens_used: number, response_time_ms: number }}
 */
export async function callKimiChat(message, currentState, history = []) {
  if (!client) {
    return {
      reply: 'Chat agent is not available — KIMI_API_KEY not configured.',
      tokens_used: 0,
      response_time_ms: 0,
    };
  }

  const start = Date.now();

  // Build state context string
  const stateContext = formatStateForChat(currentState);

  // Build messages array
  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'system', content: `## Current System State\n${stateContext}` },
  ];

  // Add recent history (last 10 exchanges)
  const recentHistory = history.slice(-10);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text,
    });
  }

  // Add current user message
  messages.push({ role: 'user', content: message });

  try {
    const response = await client.chat.completions.create({
      model: config.agentModel,
      messages,
      temperature: 0.3,
      max_tokens: 800,
    });

    const reply = response.choices[0]?.message?.content || 'No response generated.';
    const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);

    log.debug(`Chat response: ${tokensUsed} tokens, ${Date.now() - start}ms`);

    return {
      reply,
      tokens_used: tokensUsed,
      response_time_ms: Date.now() - start,
    };
  } catch (err) {
    log.error(`Chat agent error: ${err.message}`);
    return {
      reply: `Error: ${err.message}`,
      tokens_used: 0,
      response_time_ms: Date.now() - start,
    };
  }
}

/**
 * Format system state into a readable context string for the chat agent.
 */
function formatStateForChat(state) {
  if (!state) return 'No state available.';

  const lines = [];

  // Market phase
  lines.push(`**Phase:** ${state.phase?.phase || 'Unknown'} — ${state.phase?.description || ''}`);
  lines.push(`**Server Time:** ${state.serverTime || 'N/A'}`);

  // GEX
  if (state.gex) {
    lines.push(`\n**GEX:**`);
    lines.push(`- SPX Spot: $${state.gex.spotPrice}`);
    lines.push(`- Score: ${state.gex.score} | Direction: ${state.gex.direction} | Confidence: ${state.gex.confidence}`);
    lines.push(`- Environment: ${state.gex.environment}`);
    if (state.gex.wallsAbove?.length) {
      lines.push(`- Walls Above: ${state.gex.wallsAbove.map(w => `$${w.strike} (${(w.gex / 1e6).toFixed(0)}M)`).join(', ')}`);
    }
    if (state.gex.wallsBelow?.length) {
      lines.push(`- Walls Below: ${state.gex.wallsBelow.map(w => `$${w.strike} (${(w.gex / 1e6).toFixed(0)}M)`).join(', ')}`);
    }
  } else {
    lines.push('\n**GEX:** No data');
  }

  // TV Signals
  if (state.tv?.snapshot) {
    const tvSnap = state.tv.snapshot;
    lines.push(`\n**TV Signals:**`);
    lines.push(`- Bullish confirmations: ${tvSnap.confirmations?.bullish || 0}/2`);
    lines.push(`- Bearish confirmations: ${tvSnap.confirmations?.bearish || 0}/2`);
    if (state.tv.detailed) {
      for (const ind of state.tv.detailed) {
        lines.push(`- ${ind.indicator}: ${ind.state} → ${ind.classification}${ind.isStale ? ' (STALE)' : ''}`);
      }
    }
  } else {
    lines.push('\n**TV Signals:** No data');
  }

  // Current decision
  if (state.decision) {
    lines.push(`\n**Current Decision:** ${state.decision.action || 'WAIT'}`);
    lines.push(`- Reason: ${state.decision.reason || 'N/A'}`);
    lines.push(`- Confidence: ${state.decision.confidence || 'N/A'}`);
  }

  // Position
  if (state.position?.details) {
    const pos = state.position.details;
    lines.push(`\n**Position:** ${state.position.state}`);
    lines.push(`- Direction: ${pos.direction} | Entry: $${pos.entryPrice}`);
    if (pos.currentPnl !== undefined) {
      lines.push(`- Current P&L: $${pos.currentPnl?.toFixed(2) || '0'} (${pos.currentPnlPct?.toFixed(1) || '0'}%)`);
    }
  } else {
    lines.push(`\n**Position:** ${state.position?.state || 'FLAT'}`);
  }

  // Trinity
  if (state.trinity) {
    lines.push(`\n**Trinity Cross-Market:**`);
    for (const [sym, data] of Object.entries(state.trinity)) {
      if (data) {
        lines.push(`- ${sym.toUpperCase()}: ${data.direction || 'N/A'} (score: ${data.score || 'N/A'})`);
      }
    }
  }

  // Strategy
  if (state.strategy) {
    lines.push(`\n**Strategy:** v${state.strategy.version} (${state.strategy.label || 'default'})`);
  }

  return lines.join('\n');
}
