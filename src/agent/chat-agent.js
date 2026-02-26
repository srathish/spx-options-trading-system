/**
 * Chat Agent — Conversational Kimi K2.5 endpoint for the dashboard chat panel.
 * Separate from the trading decision agent (agent.js).
 * Every message gets fresh system state injected for full context.
 */

import OpenAI from 'openai';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ChatAgent');

const CHAT_SYSTEM_PROMPT = `You are GexClaw, a trading system monitoring SPX, SPY, and QQQ. You are talking to your operator.

RULES — FOLLOW THESE EXACTLY:

1. ALWAYS use specific numbers from the CURRENT STATE provided. Never say "the algorithm" or "historical data" or "internal logic." Say "SPX is at 6835, the 6800 wall is $17.4M, Bravo is PINK_1."

2. When asked WHY something is happening, look at the actual data and explain WHAT you see, not theory about how algorithms work. Bad: "The GEX algorithm might not weight TV signals heavily." Good: "GEX is 100 bullish because there's -$14.8M negative gamma at 6835 pulling price up and $10.4M positive at 6800 as a floor. But Bravo is PINK_1 on all 3 tickers and price dropped from 6909 to 6835, so momentum disagrees with the wall setup."

3. Keep responses SHORT. 2-4 sentences for simple questions. No numbered lists of possibilities. Give your ONE best read, not 6 maybes.

4. Be direct and opinionated. Say "I think bearish here because..." not "it could be bullish or bearish depending on..." Your operator wants your read, not a hedge.

5. If the data conflicts (like bullish GEX + bearish TV), say so directly: "The data is conflicting — GEX says X because of Y, but Bravo says Z. I'd weight [one] more here because [specific reason]."

6. Reference walls by strike and dollar value. Reference indicators by their exact state. Reference prices to the dollar.

7. You are NOT a textbook. You are a trader looking at live data. Talk like one.`;

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
 * Format system state into a clean, readable snapshot the chat agent will actually reference.
 */
function formatStateForChat(state) {
  if (!state) return 'No state available.';

  const lines = [];

  lines.push(`[LIVE DATA — ${state.serverTime || 'N/A'} ET]`);

  // Prices from trinity
  const spxSpot = state.gex?.spotPrice || state.trinity?.spxw?.spotPrice;
  const spySpot = state.trinity?.spy?.spotPrice;
  const qqqSpot = state.trinity?.qqq?.spotPrice;
  lines.push(`\nPRICES: SPX $${spxSpot?.toFixed(2) || 'N/A'} | SPY $${spySpot?.toFixed(2) || 'N/A'} | QQQ $${qqqSpot?.toFixed(2) || 'N/A'}`);

  // SPX GEX detail
  if (state.gex) {
    const g = state.gex;
    lines.push(`\nSPX GEX: Score ${g.score}/100 ${g.direction} | Environment: ${g.environment}`);
    if (g.wallsAbove?.length) {
      lines.push(`  Walls above: ${g.wallsAbove.map(w => `${w.strike} (${formatWallVal(w.gexValue || w.gex || w.absGexValue)})`).join(', ')}`);
    }
    if (g.wallsBelow?.length) {
      lines.push(`  Walls below: ${g.wallsBelow.map(w => `${w.strike} (${formatWallVal(w.gexValue || w.gex || w.absGexValue)})`).join(', ')}`);
    }
    if (g.breakdown?.length) {
      lines.push(`  Score breakdown: ${g.breakdown.join(' | ')}`);
    }
  }

  // SPY + QQQ from trinity
  const spyScored = state.trinity?.spy?.scored;
  const qqqScored = state.trinity?.qqq?.scored;
  if (spyScored) lines.push(`SPY GEX: Score ${spyScored.score}/100 ${spyScored.direction} | ${spyScored.environment}`);
  if (qqqScored) lines.push(`QQQ GEX: Score ${qqqScored.score}/100 ${qqqScored.direction} | ${qqqScored.environment}`);

  // Multi-ticker analysis from trinity
  const analysis = state.trinity?.analysis;
  if (analysis) {
    lines.push(`\nALIGNMENT: ${analysis.alignment?.count || 0}/3 ${analysis.alignment?.direction || 'N/A'}`);
    if (analysis.driver) {
      lines.push(`DRIVER: ${analysis.driver.ticker} — ${analysis.driver.reason || 'N/A'}`);
    }
  }

  // TV Signals — per ticker
  if (state.tv?.snapshot) {
    const snap = state.tv.snapshot;
    lines.push(`\nTV SIGNALS:`);
    for (const tkr of ['spx', 'spy', 'qqq']) {
      const t = snap[tkr];
      if (t) {
        const conf = t.confirmations || {};
        lines.push(`  ${tkr.toUpperCase()}: Bravo=${t.bravo || 'NONE'} Tango=${t.tango || 'NONE'} (${conf.bullish || 0} bull / ${conf.bearish || 0} bear)`);
      }
    }
    if (state.tv.detailed?.length) {
      const staleList = state.tv.detailed.filter(d => d.isStale);
      if (staleList.length > 0) {
        lines.push(`  STALE: ${staleList.map(d => d.indicator).join(', ')}`);
      }
    }
  }

  // Current decision
  if (state.decision) {
    const d = state.decision.decision || state.decision;
    lines.push(`\nCURRENT SIGNAL: ${d.action || state.decision.action || 'WAIT'} (${d.confidence || state.decision.confidence || 'N/A'})`);
    if (d.reason) lines.push(`  Reason: ${d.reason}`);
  }

  // Position
  if (state.position?.details) {
    const pos = state.position.details;
    lines.push(`\nPOSITION: ${state.position.state} — ${pos.contract || pos.direction || 'N/A'}`);
    if (pos.entryPrice) lines.push(`  Entry: $${pos.entryPrice} | SPX at entry: $${pos.entrySpx || 'N/A'}`);
  } else {
    lines.push(`\nPOSITION: ${state.position?.state || 'FLAT'}`);
  }

  // Phase
  lines.push(`\nPHASE: ${state.phase?.phase || 'Unknown'} — ${state.phase?.description || ''}`);

  return lines.join('\n');
}

function formatWallVal(val) {
  if (val == null) return '?';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
