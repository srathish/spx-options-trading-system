/**
 * LLM King Node Live Module
 *
 * Runs alongside the existing GEX pattern engine. Every 10 cycles (~10 min at 1-min polling),
 * builds a GEX snapshot with full taxonomy (magnets, squeezes, vacuums, flip level) and
 * calls Moonshot AI for directional analysis.
 *
 * Returns pattern objects in the same format as detectAllPatterns() so they flow through
 * the existing entry engine and gate system.
 *
 * Port of src/backtest/replay-llm-king.js to production.
 */

import OpenAI from 'openai';
import { config } from '../utils/config.js';
import { getActiveConfig } from '../review/strategy-store.js';
import { nowET } from '../utils/market-hours.js';
import { createLogger } from '../utils/logger.js';
import { getNodeTrends, getGexConviction } from '../store/state.js';

const log = createLogger('LLM-King');

// ---- VIX Fetch ----
// Pull VIX once at morning to give LLM macro regime context.
// Uses Yahoo Finance (free, no API key). Cached daily.
let cachedVix = null;
let vixFetchDate = null;

async function fetchVixOpen() {
  const today = nowET().toFormat('yyyy-MM-dd');
  if (vixFetchDate === today && cachedVix !== null) return cachedVix;

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const quote = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const prevClose = data?.chart?.result?.[0]?.meta?.chartPreviousClose;
    if (quote && quote > 0) {
      cachedVix = {
        level: Math.round(quote * 100) / 100,
        prevClose: prevClose ? Math.round(prevClose * 100) / 100 : null,
        regime: quote >= 30 ? 'EXTREME' : quote >= 22 ? 'HIGH' : quote >= 16 ? 'MODERATE' : 'LOW',
      };
      vixFetchDate = today;
      log.info(`VIX fetched: ${cachedVix.level} (${cachedVix.regime})${prevClose ? ` prev=${cachedVix.prevClose}` : ''}`);
    }
  } catch (err) {
    log.warn(`VIX fetch failed: ${err.message} — LLM will proceed without VIX context`);
  }
  return cachedVix;
}

// ---- State (persists across cycles, reset daily) ----
let cycleCount = 0;
const LLM_CALL_INTERVAL = 10; // every 10 cycles
let lastLlmResult = null;
let dailyState = {
  hod: -Infinity, lod: Infinity, openPrice: 0, openingGamma: null,
  vix: null,  // { level, prevClose, regime } — fetched once at morning
  kingHistory: [],
  entriesPerDir: { BULLISH: 0, BEARISH: 0 },
  dirLosses: { BULLISH: 0, BEARISH: 0 },
  dayPnl: 0,
  prevPosWalls: [],
  prevSpot: 0,
  breachUp: false, breachDown: false,
  priceTrend: [],
};

// ---- LLM Client ----
let client = null;
if (config.kimiApiKey) {
  client = new OpenAI({
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: config.kimiApiKey,
  });
}

// ---- System Prompt (same as backtest) ----
const SYSTEM_PROMPT = `You are a GEX (gamma exposure) trader for SPX 0DTE. Analyze the data step by step.

GEX FORCES — there are THREE forces acting on price:

1. NEGATIVE GAMMA MAGNETS: Pull price TOWARD them.
   - "biggest_magnet" shows the strongest one. Below spot = BEARISH, above spot = BULLISH.
   - Growing magnet = stronger pull. Stable magnet = reliable. Flipping = unreliable.

2. POSITIVE GAMMA PINS: Hold price AT that level.
   - Large positive GEX at spot = price pinned, range-bound.
   - BUT if price breaks THROUGH a positive wall with momentum, dealers unwind hedges
     in the same direction → the PIN becomes a SQUEEZE ACCELERANT.

3. GAMMA SQUEEZE: When "gamma_balance" shows "SQUEEZE UP" or "SQUEEZE DOWN":
   - POS gamma above spot > 2x NEG gamma below → dealers forced to BUY as price rises
   - This OVERPOWERS bearish magnets. Do NOT go bearish during a squeeze up.
   - Similarly, SQUEEZE DOWN overpowers bullish magnets.

KEY DATA FIELDS:
- "net_gex_regime": POSITIVE = stabilizing/pinning, NEGATIVE = amplifying/trending
- "gamma_flip_level": THE critical level. Above it = stable. Below it = moves accelerate.
- "vacuum_zones": Low-resistance corridors with near-zero GEX. Price moves FAST through vacuums.
- "concentration": High = tight gravity field, hard to trend. Low/spread = loose, easy to trend.
- "gamma_balance": The squeeze check. Most important safety check before entering.

ANALYSIS STEPS:
1. Check net_gex_regime: NEGATIVE gamma = trending day, POSITIVE = pinning day
2. Check gamma_flip_level: Is price above or below? Below = amplified moves
3. Find the magnet (biggest_magnet) and check its direction, size, stability
4. CHECK SQUEEZE (gamma_balance) — if squeeze opposes your magnet, DO NOT TRADE the magnet
5. Check vacuum_zones — vacuum between spot and magnet = fast move likely
6. Check SPY/QQQ alignment
7. If we have a current_position, check if thesis is intact

Respond JSON only:
{
  "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "regime": "TREND" | "CHOP" | "PINNED",
  "action": "ENTER" | "HOLD" | "EXIT" | "WAIT",
  "primary_signal": "<what supports this direction>",
  "opposing_signal": "<what opposes, or 'none'>",
  "why_primary_wins": "<why primary is stronger>"
}`;

// ---- Core: findKingNode (same as backtest) ----
function findKingNode(parsed) {
  const { aggregatedGex, strikes, spotPrice } = parsed;
  if (!strikes || strikes.length === 0) return null;

  let kingStrike = null, kingValue = 0, kingAbsValue = 0;
  let magnetStrike = null, magnetValue = 0, magnetAbsValue = 0;
  let totalAbsGamma = 0;
  let posAbove = 0, posBelow = 0, negAbove = 0, negBelow = 0;
  let bearMagnet = null, bullMagnet = null;

  for (const strike of strikes) {
    const gex = aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    if (Math.abs(strike - spotPrice) < 150) totalAbsGamma += absGex;
    if (absGex > kingAbsValue) { kingAbsValue = absGex; kingValue = gex; kingStrike = strike; }
    if (gex < 0 && absGex > magnetAbsValue && Math.abs(strike - spotPrice) < 150) {
      magnetAbsValue = absGex; magnetValue = gex; magnetStrike = strike;
    }
    if (Math.abs(strike - spotPrice) > 100) continue;
    if (gex > 0 && strike > spotPrice + 5) posAbove += gex;
    if (gex > 0 && strike < spotPrice - 5) posBelow += gex;
    if (gex < 0 && strike > spotPrice + 5) negAbove += Math.abs(gex);
    if (gex < 0 && strike < spotPrice - 5) negBelow += Math.abs(gex);
    if (gex < 0 && absGex >= 5_000_000) {
      const dist = strike - spotPrice;
      if (dist < -5 && (!bearMagnet || absGex > bearMagnet.absValue))
        bearMagnet = { strike, value: gex, absValue: absGex, dist };
      if (dist > 5 && (!bullMagnet || absGex > bullMagnet.absValue))
        bullMagnet = { strike, value: gex, absValue: absGex, dist };
    }
  }

  if (kingStrike === null) return null;

  // Gamma flip level
  let flipLevel = null, netGex = 0;
  const sorted = [...strikes].sort((a, b) => a - b);
  let running = 0;
  for (const s of sorted) {
    const prev = running;
    running += aggregatedGex.get(s) || 0;
    if (prev <= 0 && running > 0 && Math.abs(s - spotPrice) < 100) { flipLevel = s; break; }
  }
  for (const s of strikes) {
    if (Math.abs(s - spotPrice) < 80) netGex += aggregatedGex.get(s) || 0;
  }

  return {
    strike: kingStrike, value: kingValue, absValue: kingAbsValue,
    dist: kingStrike - spotPrice,
    magnetStrike, magnetValue, magnetAbsValue,
    magnetDist: magnetStrike ? magnetStrike - spotPrice : 0,
    bearMagnet, bullMagnet, totalAbsGamma,
    posAbove, posBelow, negAbove, negBelow,
    squeezeUp: posAbove > negBelow * 2,
    squeezeDown: posBelow > negAbove * 2,
    flipLevel, regime: netGex > 0 ? 'POSITIVE' : 'NEGATIVE', netGex,
  };
}

// ---- Build snapshot for LLM ----
function buildLiveSnapshot(king, spot, spyKing, qqqKing, position) {
  const et = nowET();
  const { kingHistory, hod, lod, openPrice } = dailyState;

  // King node narrative
  let kingStory = '';
  if (kingHistory.length >= 5) {
    const currentStrike = king.strike;
    let firstSeen = null, firstValue = 0, framesAsKing = 0;
    for (const h of kingHistory) {
      if (h.strike === currentStrike) {
        if (!firstSeen) { firstSeen = h.time; firstValue = h.absValue; }
        framesAsKing++;
      }
    }
    const totalGrowth = firstValue > 0 ? ((king.absValue - firstValue) / firstValue * 100).toFixed(0) : 0;
    const stabilityPct = Math.round(framesAsKing / kingHistory.length * 100);
    if (firstSeen) {
      kingStory = `${currentStrike} node first appeared at ${firstSeen} with ${(firstValue/1e6).toFixed(1)}M. Grown to ${(king.absValue/1e6).toFixed(1)}M (+${totalGrowth}%). Stable ${stabilityPct}% of the time.`;
    }
    const uniqueKings = new Set(kingHistory.map(h => h.strike));
    if (uniqueKings.size >= 4) kingStory += ` WARNING: ${uniqueKings.size} different king strikes — choppy.`;
  }

  const dayMove = spot - openPrice;

  return {
    time_et: et.toFormat('HH:mm'),
    spot: Math.round(spot),
    king_node: `${king.strike} at ${(king.value/1e6).toFixed(1)}M, ${Math.abs(king.dist).toFixed(0)}pts ${king.dist < 0 ? 'below' : 'above'} spot`,
    computed_direction: king.value < 0 ? (king.dist < 0 ? 'BEARISH' : 'BULLISH') : 'PINNED',
    biggest_magnet: king.magnetStrike ? `${king.magnetStrike} at ${(king.magnetValue/1e6).toFixed(1)}M, ${Math.abs(king.magnetDist).toFixed(0)}pts ${king.magnetDist < 0 ? 'BELOW' : 'ABOVE'} spot` : 'none',
    gamma_balance: `POS above: ${(king.posAbove/1e6).toFixed(0)}M | POS below: ${(king.posBelow/1e6).toFixed(0)}M | NEG above: ${(king.negAbove/1e6).toFixed(0)}M | NEG below: ${(king.negBelow/1e6).toFixed(0)}M${king.squeezeUp ? ' | SQUEEZE UP' : ''}${king.squeezeDown ? ' | SQUEEZE DOWN' : ''}`,
    net_gex_regime: `${king.regime} gamma (${(king.netGex/1e6).toFixed(0)}M)`,
    gamma_flip_level: king.flipLevel ? `${king.flipLevel}` : 'not found',
    narrative: kingStory,
    opening_gamma: dailyState.openingGamma ? `${(dailyState.openingGamma / 1e6).toFixed(0)}M at open — ${dailyState.openingGamma >= 80_000_000 ? 'HIGH gamma = dealers positioned, watch for squeezes' : 'LOW gamma = less dealer positioning, directional moves expected'}` : 'not yet captured',
    vix: dailyState.vix ? `${dailyState.vix.level} (${dailyState.vix.regime})${dailyState.vix.prevClose ? ` — prev close ${dailyState.vix.prevClose}, change ${dailyState.vix.level > dailyState.vix.prevClose ? '+' : ''}${((dailyState.vix.level - dailyState.vix.prevClose) / dailyState.vix.prevClose * 100).toFixed(1)}%` : ''}. ${dailyState.vix.regime === 'HIGH' || dailyState.vix.regime === 'EXTREME' ? 'HIGH VIX = macro-driven, bigger moves, be skeptical of squeezes and trust TREND/DEFY over pins' : 'Normal VIX = gamma-driven, trust GEX signals'}` : 'not available',
    day_move: Math.round(dayMove),
    hod: Math.round(hod), lod: Math.round(lod),
    spy_magnet: spyKing ? `${spyKing.strike} (${(spyKing.value/1e6).toFixed(1)}M)` : 'no data',
    qqq_magnet: qqqKing ? `${qqqKing.strike} (${(qqqKing.value/1e6).toFixed(1)}M)` : 'no data',
    current_position: position ? {
      direction: position.direction,
      entry_price: Math.round(position.entrySpx),
      current_pnl: position.spxChange || 0,
    } : null,
  };
}

// ---- Call LLM ----
async function callLlm(snapshot) {
  if (!client) return null;
  try {
    const response = await client.chat.completions.create({
      model: 'moonshot-v1-auto',
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(snapshot) },
      ],
    });
    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch (err) {
    log.error(`LLM call failed: ${err.message}`);
    return null;
  }
}

// ---- Main: called every cycle from main-loop ----
export async function runLlmKingCycle(parsed, scored, multiAnalysis, currentPosition) {
  const cfg = getActiveConfig() || {};
  if (cfg.llm_king_node_enabled === false) return [];

  const spot = parsed.spotPrice;
  if (!spot || spot <= 0) return [];

  // Update daily state
  if (spot > dailyState.hod) dailyState.hod = spot;
  if (spot < dailyState.lod) dailyState.lod = spot;

  const king = findKingNode(parsed);
  if (!king) return [];

  if (dailyState.openPrice === 0) {
    dailyState.openPrice = spot;
    // Fetch VIX on first cycle of the day (non-blocking)
    fetchVixOpen().then(vix => { if (vix) dailyState.vix = vix; }).catch(() => {});
    dailyState.openingGamma = king.totalAbsGamma;
  }

  // Update king history
  const et = nowET();
  dailyState.kingHistory.push({
    time: et.toFormat('HH:mm'),
    strike: king.strike,
    value: king.value,
    absValue: king.absValue,
  });

  // Breach detection every cycle
  const posWallsNow = [];
  for (const s of parsed.strikes) {
    const g = parsed.aggregatedGex.get(s) || 0;
    if (g > 5_000_000 && Math.abs(s - spot) < 50) posWallsNow.push({ strike: s, value: g });
  }
  if (dailyState.prevPosWalls.length > 0 && dailyState.prevSpot) {
    for (const wall of dailyState.prevPosWalls) {
      if (dailyState.prevSpot < wall.strike && spot > wall.strike + 2) dailyState.breachUp = true;
      if (dailyState.prevSpot > wall.strike && spot < wall.strike - 2) dailyState.breachDown = true;
    }
  }
  dailyState.prevPosWalls = posWallsNow.sort((a, b) => b.value - a.value).slice(0, 3);
  dailyState.prevSpot = spot;

  // Only call LLM every N cycles
  cycleCount++;
  if (cycleCount % LLM_CALL_INTERVAL !== 0) {
    // Return last result if still valid
    return lastLlmResult || [];
  }

  // Session energy filter
  const dayRange = dailyState.hod - dailyState.lod;
  const dayMove = spot - dailyState.openPrice;
  const minuteOfDay = et.hour * 60 + et.minute;
  const sessionHasEnergy = minuteOfDay < 660 || dayRange >= 20 || Math.abs(dayMove) >= 20;
  if (!sessionHasEnergy) {
    lastLlmResult = [];
    return [];
  }

  // Time gates
  if (minuteOfDay < 590 || minuteOfDay > 930) { // before 9:50 or after 15:30
    lastLlmResult = [];
    return [];
  }

  // Build snapshot and call LLM
  const spyKing = multiAnalysis?.king_nodes?.SPY || null;
  const qqqKing = multiAnalysis?.king_nodes?.QQQ || null;
  const snapshot = buildLiveSnapshot(king, spot, spyKing, qqqKing, currentPosition);

  log.info(`LLM call: spot=$${Math.round(spot)} | king=${king.strike} ${(king.value/1e6).toFixed(1)}M | ${king.regime} regime`);

  const llmResult = await callLlm(snapshot);
  if (!llmResult) {
    lastLlmResult = [];
    return [];
  }

  log.info(`LLM result: ${llmResult.direction} ${llmResult.confidence} ${llmResult.regime} | ${llmResult.action} | ${llmResult.primary_signal?.substring(0, 60)}`);

  // Convert LLM result to pattern format for entry engine
  const patterns = [];
  const llmDir = llmResult.direction;
  const llmConf = llmResult.confidence;
  const llmAction = llmResult.action;

  if (llmAction === 'ENTER' && llmConf === 'HIGH' && llmDir !== 'NEUTRAL') {
    // Find target from magnet
    const target = king.magnetStrike || king.strike;
    const stopDist = 12;
    const stopStrike = llmDir === 'BULLISH' ? spot - stopDist : spot + stopDist;

    // Squeeze gate: don't enter against a squeeze
    const squeezeBlocsTrend = (llmDir === 'BEARISH' && king.squeezeUp) || (llmDir === 'BULLISH' && king.squeezeDown);
    if (squeezeBlocsTrend) {
      log.warn(`LLM says ${llmDir} but squeeze opposes — blocking`);
    } else {
      patterns.push({
        pattern: 'LLM_KING_NODE',
        direction: llmDir,
        confidence: llmConf,
        target_strike: target,
        stop_strike: stopStrike,
        reasoning: `LLM: ${llmResult.primary_signal}`,
      });
    }
  }

  lastLlmResult = patterns;
  return patterns;
}

// ---- Reset daily state ----
export function resetLlmKingDaily() {
  cycleCount = 0;
  lastLlmResult = null;
  dailyState = {
    hod: -Infinity, lod: Infinity, openPrice: 0, openingGamma: null,
    vix: null,
    kingHistory: [],
    entriesPerDir: { BULLISH: 0, BEARISH: 0 },
    dirLosses: { BULLISH: 0, BEARISH: 0 },
    dayPnl: 0,
    prevPosWalls: [],
    prevSpot: 0,
    breachUp: false, breachDown: false,
    priceTrend: [],
  };
  vixFetchDate = null;  // force re-fetch on next day
  log.info('Daily state reset');
}
