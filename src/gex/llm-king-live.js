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

// ---- Morning Trend Score ----
// Price-based ML model (500 days training, AUC 0.803 OOS).
// Predicts "is today a 40+ pt trend day?" from prior price action.
// Fetched once at morning alongside VIX.
import { loadModel as loadXgbModel, predict as xgbPredict, buildFeatureVector } from '../ml/xgb-scorer.js';
import Database from 'better-sqlite3';

let trendModel = null;
try {
  trendModel = loadXgbModel('data/ml-price-model-trees.json');
  log.info(`Trend model loaded: ${trendModel.trees.length} trees`);
} catch (e) {
  log.warn('Trend model not found — morning score unavailable');
}

// ---- ML Lane B (GEX entry model) ----
let gexModel = null;
try {
  gexModel = loadXgbModel('data/ml-model-trees.json');
  log.info(`GEX ML model loaded: ${gexModel.trees.length} trees`);
} catch (e) {
  log.warn('GEX ML model not found — Lane B phantom unavailable');
}

// Lane B phantom state
let mlPhantom = null;  // { direction, entrySpx, targetStrike, openedAt, mfe, mae, mlScore }
let mlPhantomTrades = [];

// Ensure phantom_ml table exists
try {
  const db = new Database('./data/spx-bot.db');
  db.exec(`CREATE TABLE IF NOT EXISTS phantom_ml (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT, entry_spx REAL, exit_spx REAL, target_strike REAL,
    pnl REAL, exit_reason TEXT, ml_score REAL,
    opened_at TEXT, closed_at TEXT, mfe REAL, mae REAL
  )`);
  db.close();
} catch (e) { /* table may already exist */ }

function logMlPhantomTrade(trade) {
  try {
    const db = new Database('./data/spx-bot.db');
    db.prepare(`INSERT INTO phantom_ml (direction, entry_spx, exit_spx, target_strike, pnl, exit_reason, ml_score, opened_at, closed_at, mfe, mae)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      trade.direction, trade.entrySpx, trade.exitSpx, trade.targetStrike,
      trade.pnl, trade.exitReason, trade.mlScore,
      trade.openedAt, trade.closedAt, trade.mfe, trade.mae
    );
    db.close();
  } catch (e) {
    log.warn(`Failed to log ML phantom: ${e.message}`);
  }
}

let cachedTrendScore = null;
let trendScoreDate = null;

async function fetchMorningTrendScore() {
  const today = nowET().toFormat('yyyy-MM-dd');
  if (trendScoreDate === today && cachedTrendScore !== null) return cachedTrendScore;
  if (!trendModel) return null;

  try {
    // Fetch 30 days of daily data for SPX, SPY, VIX, VIX9D, 10Y, Dollar, ES
    const tickers = [
      ['^GSPC', 'spx'], ['SPY', 'spy'], ['^VIX', 'vix'],
      ['^VIX9D', 'vix9d'], ['^TNX', 'tnx'], ['DX-Y.NYB', 'dxy'], ['ES=F', 'es'],
    ];
    const data = {};
    for (const [ticker, key] of tickers) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1mo`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      const ts = r?.timestamp || [];
      const q = r?.indicators?.quote?.[0] || {};
      for (let i = 0; i < ts.length; i++) {
        const d = new Date(ts[i] * 1000).toISOString().split('T')[0];
        if (!data[d]) data[d] = {};
        data[d][key] = { open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] };
      }
    }

    const dates = Object.keys(data).sort();
    if (dates.length < 21) { log.warn('Not enough daily data for trend score'); return null; }

    // Use the most recent day as "today" (or yesterday if before market open)
    const latest = dates[dates.length - 1];
    const prev1 = data[dates[dates.length - 2]];
    const prev2 = data[dates[dates.length - 3]];
    const prev3 = data[dates[dates.length - 4]];
    const prev5 = data[dates[dates.length - 6]];
    const todayD = data[latest];

    // Compute features (same as train-price-ml.py)
    const spxPrevClose = prev1?.spx?.close || 0;
    const overnightGap = (todayD?.spx?.open || 0) - spxPrevClose;
    const esGap = (todayD?.es?.open || 0) - (prev1?.es?.close || 0);
    const ret1d = prev2?.spx?.close ? ((prev1?.spx?.close || 0) - prev2.spx.close) / prev2.spx.close * 100 : 0;
    const ret3d = prev3?.spx?.close ? ((prev1?.spx?.close || 0) - (data[dates[dates.length - 5]]?.spx?.close || prev3.spx.close)) / prev3.spx.close * 100 : 0;
    const ret5d = prev5?.spx?.close ? ((prev1?.spx?.close || 0) - prev5.spx.close) / prev5.spx.close * 100 : 0;

    // 5-day and 20-day avg range
    const ranges = [];
    for (let j = 2; j <= Math.min(21, dates.length); j++) {
      const p = data[dates[dates.length - j]];
      if (p?.spx?.high && p?.spx?.low) ranges.push(p.spx.high - p.spx.low);
    }
    const avgRange5d = ranges.slice(0, 5).reduce((s, v) => s + v, 0) / Math.max(ranges.slice(0, 5).length, 1);
    const avgRange20d = ranges.slice(0, 20).reduce((s, v) => s + v, 0) / Math.max(ranges.slice(0, 20).length, 1);

    const vix = todayD?.vix?.close || prev1?.vix?.close || 0;
    const vixOpen = todayD?.vix?.open || vix;
    const vixPrev = prev1?.vix?.close || 0;
    const vix9d = todayD?.vix9d?.close || 0;
    const vixChange = vixOpen - vixPrev;
    const vixTerm = vix9d && vix ? vix9d - vix : 0;

    const tnxChange = (todayD?.tnx?.close || 0) - (prev1?.tnx?.close || 0);
    const dxyChange = (todayD?.dxy?.close || 0) - (prev1?.dxy?.close || 0);

    // SPY volume ratio
    const spyVol = todayD?.spy?.volume || prev1?.spy?.volume || 0;
    const spyVols = [];
    for (let j = 2; j <= Math.min(21, dates.length); j++) {
      const v = data[dates[dates.length - j]]?.spy?.volume;
      if (v) spyVols.push(v);
    }
    const avgSpyVol = spyVols.length > 0 ? spyVols.reduce((s, v) => s + v, 0) / spyVols.length : 1;
    const volRatio = spyVol / avgSpyVol;

    // Consecutive days
    let consecDown = 0, consecUp = 0;
    for (let j = 2; j <= Math.min(7, dates.length); j++) {
      const p = data[dates[dates.length - j]];
      if (p?.spx?.close && p?.spx?.open && p.spx.close < p.spx.open) { consecDown++; } else break;
    }
    for (let j = 2; j <= Math.min(7, dates.length); j++) {
      const p = data[dates[dates.length - j]];
      if (p?.spx?.close && p?.spx?.open && p.spx.close > p.spx.open) { consecUp++; } else break;
    }

    const dow = new Date(latest).getDay() - 1; // Mon=0

    // RSI(14)
    const closes14 = [];
    for (let j = 1; j <= Math.min(16, dates.length); j++) {
      const c = data[dates[dates.length - j]]?.spx?.close;
      if (c) closes14.unshift(c);
    }
    let rsi = 50;
    if (closes14.length >= 15) {
      let gains = 0, losses = 0;
      for (let k = 1; k < closes14.length; k++) {
        const ch = closes14[k] - closes14[k - 1];
        if (ch > 0) gains += ch; else losses -= ch;
      }
      rsi = 100 - (100 / (1 + (gains / 14) / (losses / 14 + 1e-9)));
    }

    // 20d high/low
    let high20 = 0, low20 = 99999;
    for (let j = 1; j <= Math.min(21, dates.length); j++) {
      const p = data[dates[dates.length - j]];
      if (p?.spx?.high && p.spx.high > high20) high20 = p.spx.high;
      if (p?.spx?.low && p.spx.low < low20) low20 = p.spx.low;
    }
    const spxOpen = todayD?.spx?.open || spxPrevClose;
    const pctFrom20dHigh = high20 ? (spxOpen - high20) / high20 * 100 : 0;
    const pctFrom20dLow = low20 < 99999 ? (spxOpen - low20) / low20 * 100 : 0;

    const prevDayRange = prev1?.spx?.high && prev1?.spx?.low ? prev1.spx.high - prev1.spx.low : 0;
    const prevDayMove = prev1?.spx?.close && prev1?.spx?.open ? prev1.spx.close - prev1.spx.open : 0;

    // Feature vector (must match training order exactly)
    const features = [
      overnightGap, esGap, ret1d, ret3d, ret5d,
      avgRange5d, avgRange20d, avgRange5d / (avgRange20d + 1e-9),
      vix, vixChange, vixTerm, vix9d > vix ? 1 : 0,
      tnxChange, dxyChange, volRatio,
      consecDown, consecUp, dow, rsi,
      pctFrom20dHigh, pctFrom20dLow,
      prevDayRange, prevDayMove,
    ];

    const score = xgbPredict(trendModel, features);
    const regime = score >= 0.6 ? 'TREND_LIKELY' : score >= 0.4 ? 'NORMAL' : 'CHOP_LIKELY';

    cachedTrendScore = { score: Math.round(score * 100) / 100, regime, date: latest };
    trendScoreDate = today;
    log.info(`Morning trend score: ${cachedTrendScore.score} (${regime}) | VIX=${vix.toFixed(1)} VIX9D=${vix9d.toFixed(1)} range5d=${avgRange5d.toFixed(0)}`);
  } catch (err) {
    log.warn(`Morning trend score failed: ${err.message}`);
  }
  return cachedTrendScore;
}

// ---- State (persists across cycles, reset daily) ----
let cycleCount = 0;
const LLM_CALL_INTERVAL = 10; // every 10 cycles
let lastLlmResult = null;
let dailyState = {
  hod: -Infinity, lod: Infinity, openPrice: 0, openingGamma: null,
  vix: null,  // { level, prevClose, regime } — fetched once at morning
  trendScore: null,  // { score, regime } — morning ML prediction
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
function buildLiveSnapshot(king, spot, spyKing, qqqKing, position, velocity) {
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
    morning_trend_score: dailyState.trendScore ? `${dailyState.trendScore.score} (${dailyState.trendScore.regime}) — ${dailyState.trendScore.regime === 'TREND_LIKELY' ? 'ML predicts big move today, trade aggressively with TREND/DEFY' : dailyState.trendScore.regime === 'CHOP_LIKELY' ? 'ML predicts chop, reduce entries or sit out' : 'normal day, use standard rules'}` : 'not yet scored',
    gamma_velocity: velocity ? (() => {
      const risers = (velocity.topRisers || []).slice(0, 3).map(r =>
        `${r.strike} ${r.trend} +${(r.pct15m || 0).toFixed(0)}%/15m vel=${(r.velocity/1e6).toFixed(1)}M`
      ).join(' | ');
      const fallers = (velocity.topFallers || []).slice(0, 3).map(r =>
        `${r.strike} ${r.trend} ${(r.pct15m || 0).toFixed(0)}%/15m vel=${(r.velocity/1e6).toFixed(1)}M`
      ).join(' | ');
      return `GROWING: ${risers || 'none'}. SHRINKING: ${fallers || 'none'}. Fast-growing nodes = strong conviction, shrinking nodes = thesis dying.`;
    })() : 'not available',
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
    // Fetch VIX + morning trend score on first cycle (non-blocking)
    fetchVixOpen().then(vix => { if (vix) dailyState.vix = vix; }).catch(() => {});
    fetchMorningTrendScore().then(ts => { if (ts) dailyState.trendScore = ts; }).catch(() => {});
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

  // ---- Lane B phantom: manage open position every cycle ----
  if (mlPhantom) {
    const isBull = mlPhantom.direction === 'BULLISH';
    const progress = isBull ? spot - mlPhantom.entrySpx : mlPhantom.entrySpx - spot;
    if (progress > mlPhantom.mfe) mlPhantom.mfe = progress;
    if (progress < mlPhantom.mae) mlPhantom.mae = progress;

    let exitReason = null;
    // Target hit
    if (mlPhantom.targetStrike) {
      const hit = isBull ? spot >= mlPhantom.targetStrike - 8 : spot <= mlPhantom.targetStrike + 8;
      if (hit) exitReason = 'TARGET_HIT';
    }
    // Trailing lock
    if (!exitReason && mlPhantom.mfe >= 20 && progress <= Math.max(5, mlPhantom.mfe * 0.15)) {
      exitReason = 'ML_LOCK';
    }
    // Max loss
    if (!exitReason && progress <= -12) exitReason = 'MAX_LOSS';
    // EOD
    const minuteNow = et.hour * 60 + et.minute;
    if (!exitReason && minuteNow >= 945) exitReason = 'EOD_CLOSE';

    if (exitReason) {
      const pnl = exitReason === 'MAX_LOSS' ? -12 : Math.round(progress * 100) / 100;
      const trade = {
        direction: mlPhantom.direction, entrySpx: mlPhantom.entrySpx, exitSpx: spot,
        targetStrike: mlPhantom.targetStrike, pnl, exitReason, mlScore: mlPhantom.mlScore,
        openedAt: mlPhantom.openedAt, closedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
        mfe: Math.round(mlPhantom.mfe * 100) / 100, mae: Math.round(mlPhantom.mae * 100) / 100,
      };
      logMlPhantomTrade(trade);
      const tag = pnl > 0 ? 'WIN' : 'LOSS';
      log.info(`[PHANTOM-B] EXIT ${mlPhantom.direction} ${exitReason} | ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} pts | ML=${mlPhantom.mlScore.toFixed(2)} | ${tag}`);
      mlPhantom = null;
    }
  }

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
  const snapshot = buildLiveSnapshot(king, spot, spyKing, qqqKing, currentPosition, parsed._velocity);

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

  // ---- Lane B phantom: ML entry check ----
  if (gexModel && !mlPhantom && minuteOfDay >= 590 && minuteOfDay <= 900) {
    const overrides = {
      priceTrend10: 0, priceTrend30: 0,
      spyKingAgrees: 0, spyKingIsNegative: spyKing ? (spyKing.value < 0 ? 1 : 0) : -1,
      spyMagnetDist: spyKing ? Math.abs(spyKing.dist) : 50,
      qqqKingAgrees: 0, qqqKingIsNegative: qqqKing ? (qqqKing.value < 0 ? 1 : 0) : -1,
      qqqMagnetDist: qqqKing ? Math.abs(qqqKing.dist) : 50,
      trinityAlignment: 0, trinityAllAgree: 0,
    };

    // Compute cross-asset agreement
    const bestMag = king.bearMagnet && king.bullMagnet
      ? (king.bearMagnet.absValue > king.bullMagnet.absValue ? king.bearMagnet : king.bullMagnet)
      : king.bearMagnet || king.bullMagnet;
    if (bestMag) {
      const tradeDir = bestMag.dist < 0 ? -1 : 1;
      const spyDir = spyKing ? (spyKing.value < 0 ? (spyKing.dist < 0 ? -1 : 1) : 0) : 0;
      const qqqDir = qqqKing ? (qqqKing.value < 0 ? (qqqKing.dist < 0 ? -1 : 1) : 0) : 0;
      overrides.spyKingAgrees = spyDir !== 0 && spyDir === tradeDir ? 1 : 0;
      overrides.qqqKingAgrees = qqqDir !== 0 && qqqDir === tradeDir ? 1 : 0;
      const alignment = 1 + overrides.spyKingAgrees + overrides.qqqKingAgrees;
      overrides.trinityAlignment = alignment;
      overrides.trinityAllAgree = alignment === 3 ? 1 : 0;

      const mlFV = buildFeatureVector(king, spot, dailyState, llmResult, minuteOfDay, overrides);
      const mlScore = xgbPredict(gexModel, mlFV);

      // Hard gate: don't enter against day direction
      const mlDir = bestMag.dist < 0 ? 'BEARISH' : 'BULLISH';
      const fightingDay = (mlDir === 'BULLISH' && dayMove < -35) || (mlDir === 'BEARISH' && dayMove > 35);

      if (mlScore >= 0.5 && !fightingDay) {
        mlPhantom = {
          direction: mlDir,
          entrySpx: spot,
          targetStrike: bestMag.strike,
          openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
          mfe: 0, mae: 0,
          mlScore,
        };
        log.info(`[PHANTOM-B] ENTER ${mlDir} ML=${mlScore.toFixed(2)} @ $${Math.round(spot)} → ${bestMag.strike} (${Math.abs(bestMag.dist).toFixed(0)}pts)`);
      } else if (mlScore >= 0.5 && fightingDay) {
        log.debug(`[PHANTOM-B] BLOCKED ${mlDir} ML=${mlScore.toFixed(2)} | FIGHTING_DAY (dayMove=${dayMove.toFixed(0)})`);
      }
    }
  }

  lastLlmResult = patterns;
  return patterns;
}

// ---- Accessor for morning trend score ----
export function getDailyTrendScore() {
  return dailyState.trendScore;
}

// ---- Reset daily state ----
export function resetLlmKingDaily() {
  cycleCount = 0;
  lastLlmResult = null;
  dailyState = {
    hod: -Infinity, lod: Infinity, openPrice: 0, openingGamma: null,
    vix: null,
    trendScore: null,
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
  trendScoreDate = null;
  mlPhantom = null;  // close any open phantom
  log.info('Daily state reset');
}
