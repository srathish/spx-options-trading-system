/**
 * LLM-Powered King Node Backtester
 *
 * Every 10 minutes of replay data, sends a GEX snapshot to Moonshot AI
 * and asks: "Is this a directional day? Where is price going?"
 * Only shows data UP TO the current time — no future leakage.
 *
 * Usage:
 *   node src/backtest/replay-llm-king.js data/gex-replay-2026-03-20.json
 *   node src/backtest/replay-llm-king.js --batch data/gex-replay-*.json
 *   node src/backtest/replay-llm-king.js --verbose data/gex-replay-2026-03-20.json
 *   node src/backtest/replay-llm-king.js --dry-run data/gex-replay-2026-03-20.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DateTime } from 'luxon';
import { parseGexResponse } from '../gex/gex-parser.js';
import OpenAI from 'openai';
import 'dotenv/config';

// ---- Config ----

const CONFIG = {
  call_interval_frames: 10,       // call LLM every 10 frames (~10 min)
  min_history_frames: 20,         // need 20 min of data before first call
  model: process.env.LLM_KING_MODEL || 'moonshot-v1-auto',
  provider: process.env.LLM_KING_PROVIDER || 'moonshot',  // 'moonshot' or 'claude'
  temperature: 0,
  max_tokens: 500,
  api_delay_ms: 200,
  cache_file: 'data/llm-king-cache-v2.json',  // new cache for new prompt

  // Trade simulation
  max_loss_pts: 12,
  target_proximity_pts: 8,         // close enough to target = take the win
  entry_start_time: '09:50',
  entry_end_time: '15:00',
  eod_exit_time: '15:45',
};

// ---- System prompt ----

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
   - This is the #1 reason trades fail: fighting a gamma squeeze.

KEY DATA FIELDS:
- "net_gex_regime": POSITIVE = stabilizing/pinning, NEGATIVE = amplifying/trending
- "gamma_flip_level": THE critical level. Above it = stable. Below it = moves accelerate.
  If price is below the flip level in NEGATIVE gamma → expect large directional moves.
- "vacuum_zones": Low-resistance corridors with near-zero GEX. Price moves FAST through vacuums.
  If there's a vacuum between spot and the magnet → price can reach the magnet quickly.
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

Respond JSON — you MUST name the opposing signal if one exists:
{
  "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "regime": "TREND" | "CHOP" | "PINNED",
  "action": "ENTER" | "HOLD" | "EXIT" | "WAIT",
  "primary_signal": "<what supports this direction — cite the specific data>",
  "opposing_signal": "<what opposes this direction — cite specific data, or 'none'>",
  "why_primary_wins": "<why the primary signal is stronger, or why you're cautious>"
}`;

// ---- Helpers ----

function frameToRaw(frame) {
  return {
    CurrentSpot: frame.spotPrice,
    Strikes: frame.strikes,
    GammaValues: frame.gammaValues,
    VannaValues: frame.vannaValues || [],
    Expirations: frame.expirations || [],
  };
}

function frameTimestampToET(utcTimestamp) {
  return DateTime.fromISO(utcTimestamp, { zone: 'UTC' }).setZone('America/New_York');
}

function fmtVal(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '+';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function findKingNode(parsed) {
  const { aggregatedGex, strikes, spotPrice } = parsed;
  let kingStrike = null, kingValue = 0, kingAbsValue = 0;
  let magnetStrike = null, magnetValue = 0, magnetAbsValue = 0;
  let totalAbsGamma = 0; // total gamma near spot — for relative sizing
  for (const strike of strikes) {
    const gex = aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    if (Math.abs(strike - spotPrice) < 150) totalAbsGamma += absGex;
    if (absGex > kingAbsValue) {
      kingAbsValue = absGex; kingValue = gex; kingStrike = strike;
    }
    if (gex < 0 && absGex > magnetAbsValue && Math.abs(strike - spotPrice) < 150) {
      magnetAbsValue = absGex; magnetValue = gex; magnetStrike = strike;
    }
  }
  if (kingStrike === null) return null;

  // Find biggest negative magnet on EACH side of spot (for competing magnet detection)
  // AND total positive gamma on each side (for squeeze detection)
  let bearMagnet = null, bullMagnet = null;
  let posAbove = 0, posBelow = 0, negAbove = 0, negBelow = 0;
  for (const strike of strikes) {
    const gex = aggregatedGex.get(strike) || 0;
    if (Math.abs(strike - spotPrice) > 100) continue;

    if (gex > 0 && strike > spotPrice + 5) posAbove += gex;
    if (gex > 0 && strike < spotPrice - 5) posBelow += gex;
    if (gex < 0 && strike > spotPrice + 5) negAbove += Math.abs(gex);
    if (gex < 0 && strike < spotPrice - 5) negBelow += Math.abs(gex);

    if (gex >= 0) continue;
    const absGex = Math.abs(gex);
    if (absGex < 5_000_000) continue;
    const dist = strike - spotPrice;
    if (dist < -5 && (!bearMagnet || absGex > bearMagnet.absValue)) {
      bearMagnet = { strike, value: gex, absValue: absGex, dist };
    }
    if (dist > 5 && (!bullMagnet || absGex > bullMagnet.absValue)) {
      bullMagnet = { strike, value: gex, absValue: absGex, dist };
    }
  }

  // === GAMMA FLIP LEVEL: price where total GEX changes sign ===
  // Above flip = positive gamma (stabilizing), below flip = negative gamma (amplifying)
  let flipLevel = null;
  const sortedStrikes = [...strikes].sort((a, b) => a - b);
  let runningGex = 0;
  for (const s of sortedStrikes) {
    const prevRunning = runningGex;
    runningGex += aggregatedGex.get(s) || 0;
    if (prevRunning <= 0 && runningGex > 0 && Math.abs(s - spotPrice) < 100) {
      flipLevel = s;
      break; // take the first (nearest) crossing, not the last
    }
  }

  // === NET GEX REGIME: sum of all GEX near spot ===
  let netGex = 0;
  for (const s of strikes) {
    if (Math.abs(s - spotPrice) < 80) netGex += aggregatedGex.get(s) || 0;
  }
  const regime = netGex > 0 ? 'POSITIVE' : 'NEGATIVE'; // positive = pinning, negative = amplifying

  // === VACUUM ZONES: strikes with near-zero GEX between walls ===
  // Find the biggest gap (lowest GEX corridor) between spot and the nearest major wall
  let vacuumBelow = null, vacuumAbove = null;
  const nearStrikes = sortedStrikes.filter(s => Math.abs(s - spotPrice) < 80);
  // Check below spot for vacuum
  const belowStrikes = nearStrikes.filter(s => s < spotPrice - 5).reverse();
  let vacuumStartBelow = null;
  for (const s of belowStrikes) {
    const g = Math.abs(aggregatedGex.get(s) || 0);
    if (g < 2_000_000 && !vacuumStartBelow) vacuumStartBelow = s;
    if (g >= 5_000_000 && vacuumStartBelow) {
      vacuumBelow = { from: s, to: vacuumStartBelow, pts: vacuumStartBelow - s };
      break;
    }
  }
  // Check above spot for vacuum
  const aboveStrikes = nearStrikes.filter(s => s > spotPrice + 5);
  let vacuumStartAbove = null;
  for (const s of aboveStrikes) {
    const g = Math.abs(aggregatedGex.get(s) || 0);
    if (g < 2_000_000 && !vacuumStartAbove) vacuumStartAbove = s;
    if (g >= 5_000_000 && vacuumStartAbove) {
      vacuumAbove = { from: vacuumStartAbove, to: s, pts: s - vacuumStartAbove };
      break;
    }
  }

  // === GEX CONCENTRATION: how tight or spread is the structure ===
  let top3Total = 0;
  const allGex = strikes.map(s => ({ s, g: Math.abs(aggregatedGex.get(s) || 0) }))
    .filter(x => Math.abs(x.s - spotPrice) < 80)
    .sort((a, b) => b.g - a.g);
  for (let j = 0; j < Math.min(3, allGex.length); j++) top3Total += allGex[j].g;
  const concentration = totalAbsGamma > 0 ? top3Total / totalAbsGamma : 0;

  return {
    strike: kingStrike, value: kingValue, absValue: kingAbsValue, dist: kingStrike - spotPrice,
    magnetStrike, magnetValue, magnetAbsValue, magnetDist: magnetStrike ? magnetStrike - spotPrice : 0,
    bearMagnet, bullMagnet, totalAbsGamma,
    posAbove, posBelow, negAbove, negBelow,
    squeezeUp: posAbove > negBelow * 2,
    squeezeDown: posBelow > negAbove * 2,
    flipLevel, regime, netGex,
    vacuumBelow, vacuumAbove, concentration,
  };
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

// ---- Snapshot Builder (NO future data) ----

function buildSnapshot(localState, parsed, king, spot, et, spyKing, qqqKing, position) {
  const { kingHistory, wallHistory, hod, lod, openPrice } = localState;

  // Top 10 walls with trend (compare to 10 min ago)
  const walls = [];
  const sortedWalls = [...(parsed.walls || [])].sort((a, b) =>
    (b.absGexValue || Math.abs(b.gexValue || 0)) - (a.absGexValue || Math.abs(a.gexValue || 0))
  ).slice(0, 10);

  const pastWalls = wallHistory.length >= 11 ? wallHistory[wallHistory.length - 11] : null;
  const pastWallMap = new Map();
  if (pastWalls) pastWalls.forEach(w => pastWallMap.set(w.strike, w.value));

  for (const w of sortedWalls) {
    const val = w.gexValue || 0;
    const absVal = w.absGexValue || Math.abs(val);
    const pastVal = pastWallMap.get(w.strike);
    let trend = 'NEW';
    if (pastVal !== undefined) {
      const pctChange = Math.abs(pastVal) > 0 ? (absVal - Math.abs(pastVal)) / Math.abs(pastVal) : 0;
      if (pctChange >= 0.20) trend = 'GROWING';
      else if (pctChange <= -0.20) trend = 'WEAKENING';
      else trend = 'STABLE';
    }
    walls.push({
      strike: w.strike,
      gamma_M: parseFloat((val / 1e6).toFixed(1)),
      type: val >= 0 ? 'positive' : 'negative',
      dist_from_spot: w.strike - spot,
      trend,
    });
  }

  // King node history (last 30 min, sampled every 5 min)
  const kingHistSampled = [];
  for (let i = kingHistory.length - 1; i >= 0 && kingHistSampled.length < 6; i -= 5) {
    if (i >= 0) {
      const h = kingHistory[i];
      kingHistSampled.unshift({
        time: h.time,
        strike: h.strike,
        value_M: parseFloat((h.absValue / 1e6).toFixed(1)),
      });
    }
  }

  // King node tenure (how many consecutive frames at this strike)
  let tenure = 0;
  for (let i = kingHistory.length - 1; i >= 0; i--) {
    if (kingHistory[i].strike === king.strike) tenure++;
    else break;
  }

  // Growth rate vs 10 min ago
  const kingPast = kingHistory.length >= 11 ? kingHistory[kingHistory.length - 11] : null;
  let growthPct = 0;
  if (kingPast && kingPast.strike === king.strike && kingPast.absValue > 0) {
    growthPct = ((king.absValue - kingPast.absValue) / kingPast.absValue * 100);
  }

  // === BUILD NARRATIVE: the story of what's happening ===
  // This is what a human trader sees watching the GEX chart over time

  // 1. King node story: how has it evolved?
  let kingStory = '';
  if (kingHistory.length >= 20) {
    // Find earliest reading of current king strike
    const currentStrike = king.strike;
    let firstSeen = null, firstValue = 0, peakValue = 0;
    let framesAsKing = 0;
    for (const h of kingHistory) {
      if (h.strike === currentStrike) {
        if (!firstSeen) { firstSeen = h.time; firstValue = h.absValue; }
        if (h.absValue > peakValue) peakValue = h.absValue;
        framesAsKing++;
      }
    }
    const totalGrowth = firstValue > 0 ? ((king.absValue - firstValue) / firstValue * 100).toFixed(0) : 0;
    const stabilityPct = Math.round(framesAsKing / kingHistory.length * 100);

    if (firstSeen) {
      kingStory = `The ${currentStrike} node first appeared at ${firstSeen} with ${(firstValue/1e6).toFixed(1)}M. It has grown to ${(king.absValue/1e6).toFixed(1)}M (+${totalGrowth}%). It has been the king node ${stabilityPct}% of the time (${framesAsKing}/${kingHistory.length} frames). Peak value: ${(peakValue/1e6).toFixed(1)}M.`;
    }

    // How many different strikes have been king?
    const uniqueKings = new Set(kingHistory.map(h => h.strike));
    if (uniqueKings.size >= 4) {
      kingStory += ` WARNING: King node has been at ${uniqueKings.size} different strikes — this is choppy, unstable.`;
    } else if (uniqueKings.size <= 2) {
      kingStory += ` The king node has been very stable (only ${uniqueKings.size} strikes).`;
    }
  }

  // 2. Competing nodes: is there a strong node on the OTHER side of spot?
  let competingStory = '';
  const nodesAbove = walls.filter(w => w.dist_from_spot > 10 && w.gamma_M < -5);
  const nodesBelow = walls.filter(w => w.dist_from_spot < -10 && w.gamma_M < -5);
  if (king.dist < 0) { // king below spot (bearish)
    if (nodesAbove.length > 0) {
      competingStory = `Competing: ${nodesAbove.length} negative node(s) ABOVE spot pulling price up: ${nodesAbove.map(w => w.strike + ' (' + w.gamma_M + 'M)').join(', ')}.`;
    } else {
      competingStory = 'No competing negative nodes above spot — clear path for bearish move.';
    }
  } else { // king above spot (bullish)
    if (nodesBelow.length > 0) {
      competingStory = `Competing: ${nodesBelow.length} negative node(s) BELOW spot pulling price down: ${nodesBelow.map(w => w.strike + ' (' + w.gamma_M + 'M)').join(', ')}.`;
    } else {
      competingStory = 'No competing negative nodes below spot — clear path for bullish move.';
    }
  }

  // 3. Price action story
  const moveFromOpen = Math.round(spot - openPrice);
  const priceStory = `SPX opened ${Math.round(openPrice)}, now ${Math.round(spot)} (${moveFromOpen >= 0 ? '+' : ''}${moveFromOpen}). HOD ${Math.round(hod)}, LOD ${Math.round(lod)}, range ${Math.round(hod-lod)}pts.`;

  // 4. Cross-market story
  let crossStory = '';
  if (spyKing && qqqKing) {
    const spySide = spyKing.dist < 0 ? 'below' : 'above';
    const qqqSide = qqqKing.dist < 0 ? 'below' : 'above';
    const kingNodeSide = king.dist < 0 ? 'below' : 'above';
    const aligned = (spySide === kingNodeSide && qqqSide === kingNodeSide);
    crossStory = `SPY king: ${spyKing.strike} (${spySide} spot). QQQ king: ${qqqKing.strike} (${qqqSide} spot). ${aligned ? 'ALL THREE ALIGNED ' + kingNodeSide + ' spot.' : 'NOT aligned with SPX.'}`;
  }

  return {
    time_et: et.toFormat('HH:mm'),
    spot: Math.round(spot),
    king_node: `${king.strike} at ${(king.value/1e6).toFixed(1)}M (${king.value >= 0 ? 'POSITIVE gamma = PIN, NOT a directional signal' : 'NEGATIVE gamma = MAGNET pulling price toward it'}), ${Math.abs(king.dist).toFixed(0)}pts ${king.dist < 0 ? 'below' : 'above'} spot`,
    king_tenure_min: tenure,
    computed_direction: king.value < 0 ? (king.dist < 0 ? 'BEARISH — negative magnet below pulling price DOWN' : 'BULLISH — negative magnet above pulling price UP') : (Math.abs(king.dist) < 10 ? 'PINNED — positive gamma at spot keeping price stuck' : 'WEAK — positive gamma node is support/resistance, not a magnet'),
    biggest_magnet: king.magnetStrike ? `${king.magnetStrike} at ${(king.magnetValue/1e6).toFixed(1)}M, ${Math.abs(king.magnetDist).toFixed(0)}pts ${king.magnetDist < 0 ? 'BELOW' : 'ABOVE'} spot — THIS is the true magnet pulling price ${king.magnetDist < 0 ? 'DOWN' : 'UP'}` : 'no significant negative gamma magnet found',
    gamma_balance: `POS above: ${(king.posAbove/1e6).toFixed(0)}M | POS below: ${(king.posBelow/1e6).toFixed(0)}M | NEG above: ${(king.negAbove/1e6).toFixed(0)}M | NEG below: ${(king.negBelow/1e6).toFixed(0)}M${king.squeezeUp ? ' | ⚠️ SQUEEZE UP: POS above is 2x NEG below — dealers forced to BUY as price rises' : ''}${king.squeezeDown ? ' | ⚠️ SQUEEZE DOWN: POS below is 2x NEG above — dealers forced to SELL as price falls' : ''}`,
    net_gex_regime: `${king.regime} gamma (net ${(king.netGex/1e6).toFixed(0)}M) — ${king.regime === 'POSITIVE' ? 'dealers absorb moves, PINNING/STABILIZING' : 'dealers amplify moves, TRENDING/VOLATILE'}`,
    gamma_flip_level: king.flipLevel ? `${king.flipLevel} (${king.flipLevel > spot ? (king.flipLevel - spot).toFixed(0) + 'pts ABOVE' : (spot - king.flipLevel).toFixed(0) + 'pts BELOW'} spot) — above this level market stabilizes, below it moves accelerate` : 'not found',
    vacuum_zones: `${king.vacuumBelow && king.vacuumBelow.pts >= 10 ? 'BELOW: ' + king.vacuumBelow.pts + 'pt corridor from ' + king.vacuumBelow.from + ' to ' + king.vacuumBelow.to + ' (low resistance, fast move zone)' : 'no significant vacuum below'}${king.vacuumAbove && king.vacuumAbove.pts >= 10 ? ' | ABOVE: ' + king.vacuumAbove.pts + 'pt corridor from ' + king.vacuumAbove.from + ' to ' + king.vacuumAbove.to + ' (low resistance, fast move zone)' : ' | no significant vacuum above'}`,
    concentration: `Top 3 strikes hold ${(king.concentration * 100).toFixed(0)}% of total GEX — ${king.concentration > 0.5 ? 'CONCENTRATED (tight gravity field, strong pin)' : 'SPREAD (loose structure, easier to trend)'}`,
    narrative: [kingStory, competingStory, priceStory, crossStory].filter(Boolean).join(' '),
    spy_magnet: spyKing ? `SPY king at ${spyKing.strike}, ${Math.abs(spyKing.dist).toFixed(0)}pts ${spyKing.dist < 0 ? 'BELOW' : 'ABOVE'} spot (${(spyKing.value/1e6).toFixed(1)}M)` : 'no data',
    qqq_magnet: qqqKing ? `QQQ king at ${qqqKing.strike}, ${Math.abs(qqqKing.dist).toFixed(0)}pts ${qqqKing.dist < 0 ? 'BELOW' : 'ABOVE'} spot (${(qqqKing.value/1e6).toFixed(1)}M)` : 'no data',
    top_5_walls: walls.slice(0, 5).map(w => `${w.strike}: ${w.gamma_M}M (${w.trend}, ${w.dist_from_spot > 0 ? '+' : ''}${w.dist_from_spot}pts)`),
    current_position: position ? {
      direction: position.direction,
      mode: position.mode,
      entry_price: Math.round(position.entrySpx),
      target: position.targetStrike,
      current_pnl: Math.round((position.direction === 'BULLISH' ? spot - position.entrySpx : position.entrySpx - spot) * 100) / 100,
    } : null,
  };
}

// ---- LLM Call ----

const client = process.env.KIMI_API_KEY ? new OpenAI({
  baseURL: 'https://api.moonshot.ai/v1',
  apiKey: process.env.KIMI_API_KEY,
}) : null;

async function callLLM(snapshot, cache, cacheKey) {
  // Check cache
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (!client) {
    return { regime: 'CHOP', direction: 'NEUTRAL', confidence: 'LOW', king_node_target: null, action: 'WAIT', reasoning: 'No API key' };
  }

  const userMessage = JSON.stringify(snapshot);

  try {
    const response = await client.chat.completions.create({
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.max_tokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const result = {
      regime: parsed.regime || 'CHOP',
      direction: parsed.direction || 'NEUTRAL',
      confidence: parsed.confidence || 'LOW',
      king_node_target: parsed.king_node_target || null,
      action: parsed.action || 'WAIT',
      reasoning: parsed.reasoning || '',
    };

    cache.set(cacheKey, result);
    await new Promise(r => setTimeout(r, CONFIG.api_delay_ms));
    return result;
  } catch (err) {
    console.error(`  LLM ERROR: ${err.message}`);
    return { regime: 'CHOP', direction: 'NEUTRAL', confidence: 'LOW', king_node_target: null, action: 'WAIT', reasoning: `Error: ${err.message}` };
  }
}

// ---- Cache management ----

function loadCache() {
  const cache = new Map();
  if (existsSync(CONFIG.cache_file)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG.cache_file, 'utf-8'));
      for (const [k, v] of Object.entries(data)) cache.set(k, v);
    } catch { /* ignore corrupt cache */ }
  }
  return cache;
}

function saveCache(cache) {
  const obj = {};
  for (const [k, v] of cache) obj[k] = v;
  writeFileSync(CONFIG.cache_file, JSON.stringify(obj, null, 2));
}

// ---- Core Replay ----

async function replayLLMKing(jsonPath, cache, verbose = false, dryRun = false) {
  const rawJson = readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(rawJson);
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity' || (frames[0]?.tickers && typeof frames[0].tickers === 'object');

  if (verbose) console.log(`\n[LLM-King] ${dateStr} | ${frames.length} frames | ${isTrinity ? 'trinity' : 'SPXW-only'}`);

  // Local state (no imports from state.js)
  const localState = {
    kingHistory: [],
    wallHistory: [],
    hod: -Infinity,
    lod: Infinity,
    openPrice: 0,
    _entriesPerDir: { BULLISH: 0, BEARISH: 0 },
    _dirLosses: { BULLISH: 0, BEARISH: 0 },
    _dirWins: { BULLISH: 0, BEARISH: 0 },
    _trendWins: { BULLISH: 0, BEARISH: 0 },
    _defyCount: 0,
    _dayPnl: 0,
  };

  const calls = [];      // LLM call log
  const entryStartMin = timeToMinutes(CONFIG.entry_start_time);
  const entryEndMin = timeToMinutes(CONFIG.entry_end_time);
  const eodMin = timeToMinutes(CONFIG.eod_exit_time);

  // Simulated position
  let position = null;
  const trades = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const spxwData = isTrinity ? frame.tickers?.SPXW : frame;
    if (!spxwData?.spotPrice || !spxwData?.gammaValues) continue;

    const et = frameTimestampToET(frame.timestamp);
    const etStr = et.toFormat('HH:mm');
    const minuteOfDay = et.hour * 60 + et.minute;
    const raw = frameToRaw(spxwData);
    const parsed = parseGexResponse(raw);
    const spot = parsed.spotPrice;
    const walls = [...(parsed.walls || [])];

    if (localState.openPrice === 0) localState.openPrice = spot;
    if (spot > localState.hod) localState.hod = spot;
    if (spot < localState.lod) localState.lod = spot;

    const king = findKingNode(parsed);
    if (!king) continue;

    // === BREACH DETECTION — runs EVERY frame, not just LLM frames ===
    // Track top positive walls and detect when price crosses through one
    const posWallsNow = [];
    for (const s of parsed.strikes) {
      const g = parsed.aggregatedGex.get(s) || 0;
      if (g > 5_000_000 && Math.abs(s - spot) < 50) posWallsNow.push({ strike: s, value: g });
    }
    posWallsNow.sort((a, b) => b.value - a.value);
    const topPosWallsNow = posWallsNow.slice(0, 3);

    if (!localState._breachUp) localState._breachUp = false;
    if (!localState._breachDown) localState._breachDown = false;
    if (!localState._breachedWall) localState._breachedWall = null;

    if (localState._prevPosWallsFrame && localState._prevSpotFrame) {
      for (const wall of localState._prevPosWallsFrame) {
        if (localState._prevSpotFrame < wall.strike && spot > wall.strike + 2) {
          localState._breachUp = true; localState._breachedWall = wall; break;
        }
        if (localState._prevSpotFrame > wall.strike && spot < wall.strike - 2) {
          localState._breachDown = true; localState._breachedWall = wall; break;
        }
      }
    }
    localState._prevPosWallsFrame = topPosWallsNow;
    localState._prevSpotFrame = spot;

    // Update local history
    localState.kingHistory.push({ time: etStr, strike: king.strike, value: king.value, absValue: king.absValue });
    localState.wallHistory.push(walls.map(w => ({
      strike: w.strike,
      value: w.absGexValue || Math.abs(w.gexValue || 0),
    })));

    // Parse SPY/QQQ king nodes
    let spyKing = null, qqqKing = null;
    if (isTrinity) {
      for (const [ticker, ref] of [['SPY', 'spyKing'], ['QQQ', 'qqqKing']]) {
        const td = frame.tickers?.[ticker];
        if (td?.spotPrice && td?.gammaValues) {
          const tRaw = frameToRaw(td);
          const tParsed = parseGexResponse(tRaw);
          const tk = findKingNode(tParsed);
          if (ticker === 'SPY') spyKing = tk;
          else qqqKing = tk;
        }
      }
    }

    // ---- Manage open position ----
    if (position) {
      const isBull = position.direction === 'BULLISH';
      const progress = isBull ? spot - position.entrySpx : position.entrySpx - spot;
      if (progress > position.mfe) position.mfe = progress;
      if (progress < position.mae) position.mae = progress;

      let exitReason = null;
      const mode = position.mode || 'TREND';

      if (mode === 'PINNED') {
        const t = position._pinnedTarget || 5;
        const s = position._pinnedStop || 8;
        if (progress >= t) exitReason = 'PIN_TARGET';
        else if (progress <= -s) exitReason = 'PIN_STOP';
        else if (minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
      } else if (mode === 'RANGE') {
        const t = position._rangeTarget || 10;
        const s = position._rangeStop || 8;
        if (progress >= t) exitReason = 'RANGE_TARGET';
        else if (progress <= -s) exitReason = 'RANGE_STOP';
        else if (minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
        else if (position.llmSaysExit) exitReason = 'LLM_EXIT';
      } else if (mode === 'SQUEEZE') {
        // Squeeze trades: target 25 pts, stop 12, lock at 40% of MFE
        if (progress >= 25) exitReason = 'SQUEEZE_TARGET';
        else if (position.mfe >= 15 && progress <= position.mfe * 0.4) exitReason = 'SQUEEZE_LOCK';
        else if (progress <= -12) exitReason = 'SQUEEZE_STOP';
        else if (minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
        // Exit if squeeze condition disappears
        else if (position.direction === 'BULLISH' && !king.squeezeUp && progress <= 0) exitReason = 'SQUEEZE_GONE';
        else if (position.direction === 'BEARISH' && !king.squeezeDown && progress <= 0) exitReason = 'SQUEEZE_GONE';
        else if (position.llmSaysExit) exitReason = 'LLM_EXIT';
      } else if (mode === 'BREAKOUT') {
        const t = 20;
        const s = position._breakStop || 12;
        if (progress >= t) exitReason = 'BREAK_TARGET';
        // Lock at 30% of MFE once we hit +12 (was +15/+5 which was too tight)
        else if (position.mfe >= 12 && progress <= Math.max(3, position.mfe * 0.3)) exitReason = 'BREAK_LOCK';
        else if (progress <= -s) exitReason = 'BREAK_STOP';
        else if (minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
      } else if (mode === 'DEFY') {
        const t = 30;
        const s = position._defyStop || 15;
        if (progress >= t) exitReason = 'DEFY_TARGET';
        // Profit lock for DEFY: tighter on pinning days, wider on trending days
        // In NEGATIVE GEX (trending), let it breathe — lock at 25% of MFE
        // In POSITIVE GEX (pinning), tighter — lock at 40% of MFE
        else if (position.mfe >= 15) {
          const defyLockPct = king.regime === 'NEGATIVE' ? 0.25 : 0.4;
          if (progress <= position.mfe * defyLockPct) exitReason = 'DEFY_LOCK';
        }
        else if (progress <= -s) exitReason = 'DEFY_STOP';
        else if (minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
      } else {
        // TREND MODE
        if (position.targetStrike) {
          const hit = isBull ? spot >= position.targetStrike - CONFIG.target_proximity_pts
            : spot <= position.targetStrike + CONFIG.target_proximity_pts;
          if (hit) exitReason = 'TARGET_HIT';
        }
        // Trend-aware dynamic lock: only lock when you've captured 60%+ of the magnet distance
        const magnetDist = Math.abs(position.targetStrike - position.entrySpx);
        const capturedPct = magnetDist > 0 ? progress / magnetDist : 1;
        if (!exitReason && position.mfe >= 25 && progress <= 10 && capturedPct >= 0.6) {
          exitReason = 'TREND_LOCK';
        }
        // Early cut disabled — thesis hold + max loss handle this better
        // MAX LOSS — but check if our magnet is still alive first
        if (!exitReason && progress <= -CONFIG.max_loss_pts) {
          const ourMagnet = position.direction === 'BEARISH' ? king.bearMagnet : king.bullMagnet;
          const magnetAlive = ourMagnet && ourMagnet.absValue >= 10_000_000;
          const hardLimit = progress <= -25; // absolute max, never hold beyond -25
          if (magnetAlive && !hardLimit) {
            // Magnet still pulling — hold through the bounce
          } else {
            exitReason = 'MAX_LOSS';
          }
        }
        // After 2:30 PM, tighten profit lock — lock in any gains before close
        if (!exitReason && minuteOfDay >= timeToMinutes('14:30') && position.mfe >= 10 && progress > 0 && progress <= Math.max(3, position.mfe * 0.3)) {
          exitReason = 'LATE_LOCK';
        }
        if (!exitReason && minuteOfDay >= eodMin) exitReason = 'EOD_CLOSE';
        if (!exitReason && position.llmSaysExit) exitReason = 'LLM_EXIT';
      }

      if (exitReason) {
        const pnl = exitReason === 'MAX_LOSS' ? -CONFIG.max_loss_pts
          : exitReason === 'PIN_STOP' ? -(position._pinnedStop || 8)
          : exitReason === 'RANGE_STOP' ? -(position._rangeStop || 8)
          : exitReason === 'SQUEEZE_STOP' ? -12
          : exitReason === 'BREAK_STOP' ? -(position._breakStop || 12)
          : exitReason === 'DEFY_STOP' ? -(position._defyStop || 15)
          : Math.round(progress * 100) / 100;
        trades.push({
          mode: position.mode || 'TREND',
          direction: position.direction,
          entrySpx: position.entrySpx,
          exitSpx: spot,
          targetStrike: position.targetStrike,
          pnl,
          exitReason,
          openedAt: position.openedAt,
          closedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
          mfe: Math.round(position.mfe * 100) / 100,
          mae: Math.round(position.mae * 100) / 100,
        });
        if (!localState._dirLosses) localState._dirLosses = { BULLISH: 0, BEARISH: 0 };
        if (!localState._dirWins) localState._dirWins = { BULLISH: 0, BEARISH: 0 };
        if (pnl <= 0) {
          localState._dirLosses[position.direction]++;
        } else if (pnl >= 10) {
          localState._dirWins[position.direction]++;
          if (position.mode === 'TREND' && pnl >= 20) {
            // Only count as a TREND win for DEFY-blocking purposes if pnl >= 20
            // A TREND_LOCK at +12 is an incomplete capture, not a "won direction" signal
            localState._trendWins[position.direction]++;
          }
        }
        if (pnl >= 10) {
          // Reset defy count on wins to allow re-entry
          if (localState._defyCount) localState._defyCount = Math.max(0, localState._defyCount - 1);
        }
        if (pnl >= 15) {
          // Big win — reset direction entries to allow re-entry
          localState._entriesPerDir[position.direction] = Math.max(0, (localState._entriesPerDir[position.direction] || 1) - 1);
        }
        localState._dayPnl += pnl;
        if (verbose) {
          const tag = pnl > 0 ? 'WIN' : 'LOSS';
          console.log(`  EXIT  ${etStr} | ${position.direction} ${exitReason} | ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} pts | dayPnl=${localState._dayPnl.toFixed(1)} | ${tag}`);
        }
        position = null;
      }
    }

    // ---- LLM call every 10 frames ----
    if (i >= CONFIG.min_history_frames && i % CONFIG.call_interval_frames === 0) {
      const snapshot = buildSnapshot(localState, parsed, king, spot, et, spyKing, qqqKing, position);
      const cacheKey = `${dateStr}_${etStr}`;

      let llmResult;
      if (dryRun) {
        if (verbose) console.log(`  [DRY] ${etStr} | spot=$${Math.round(spot)} | king=${king.strike} ${fmtVal(king.value)}`);
        continue;
      }

      llmResult = await callLLM(snapshot, cache, cacheKey);

      // Score: what happens next 10/30 min?
      const spot10 = (i + 10 < frames.length) ? (() => {
        const f = isTrinity ? frames[i + 10]?.tickers?.SPXW : frames[i + 10];
        return f?.spotPrice || null;
      })() : null;
      const spot30 = (i + 30 < frames.length) ? (() => {
        const f = isTrinity ? frames[i + 30]?.tickers?.SPXW : frames[i + 30];
        return f?.spotPrice || null;
      })() : null;

      const move10 = spot10 ? spot10 - spot : null;
      const move30 = spot30 ? spot30 - spot : null;
      const dirCorrect10 = move10 !== null && (
        (llmResult.direction === 'BULLISH' && move10 > 0) ||
        (llmResult.direction === 'BEARISH' && move10 < 0)
      );
      const dirCorrect30 = move30 !== null && (
        (llmResult.direction === 'BULLISH' && move30 > 0) ||
        (llmResult.direction === 'BEARISH' && move30 < 0)
      );

      calls.push({
        time: etStr,
        spot: Math.round(spot),
        king_strike: king.strike,
        king_value_M: parseFloat((king.absValue / 1e6).toFixed(1)),
        ...llmResult,
        move10: move10 ? Math.round(move10 * 100) / 100 : null,
        move30: move30 ? Math.round(move30 * 100) / 100 : null,
        dir_correct_10: dirCorrect10,
        dir_correct_30: dirCorrect30,
      });

      if (verbose) {
        const confEmoji = llmResult.confidence === 'HIGH' ? '***' : llmResult.confidence === 'MEDIUM' ? ' * ' : '   ';
        const m10 = move10 ? (move10 > 0 ? '+' : '') + move10.toFixed(0) : '?';
        const m30 = move30 ? (move30 > 0 ? '+' : '') + move30.toFixed(0) : '?';
        console.log(`  ${etStr} | ${confEmoji} ${llmResult.regime.padEnd(11)} ${llmResult.direction.padEnd(7)} ${llmResult.confidence.padEnd(6)} | ${llmResult.action.padEnd(5)} | king=${king.strike} ${fmtVal(king.value)} | 10m:${m10} 30m:${m30} | ${llmResult.reasoning}`);
      }

      // ---- Trade simulation: 3 regimes ----
      const kingDist = Math.abs(king.dist);
      const llmDir = llmResult.direction;
      const llmConf = llmResult.confidence;
      const llmRegime = llmResult.regime;

      // Track consecutive HIGH DIRECTIONAL calls in same direction for trend confirmation
      if (!localState._consecutiveDir) localState._consecutiveDir = { dir: null, count: 0 };
      if (llmConf === 'HIGH' && ( llmRegime === 'DIRECTIONAL' || llmRegime === 'TREND' ) && llmDir !== 'NEUTRAL') {
        if (llmDir === localState._consecutiveDir.dir) {
          localState._consecutiveDir.count++;
        } else {
          localState._consecutiveDir = { dir: llmDir, count: 1 };
        }
      } else {
        localState._consecutiveDir.count = 0;
      }

      // Track 30-min price trend (3 LLM frames × 10 min = 30 min)
      if (!localState._priceTrend) localState._priceTrend = [];
      localState._priceTrend.push(spot);
      if (localState._priceTrend.length > 3) localState._priceTrend.shift();
      const priceTrend30 = localState._priceTrend.length >= 3
        ? spot - localState._priceTrend[0] : 0;

      // Track entries per direction today (max 1 re-entry after stop)
      if (!localState._entriesPerDir) localState._entriesPerDir = { BULLISH: 0, BEARISH: 0 };

      // Daily P&L circuit breaker
      const dailyLossLimit = -25;
      // Session energy filter: after 11 AM, need dayRange >= 20 OR abs(dayMove) >= 20
      const dayRange = localState.hod - localState.lod;
      const dayMove = spot - localState.openPrice;
      const sessionHasEnergy = minuteOfDay < 660 || dayRange >= 20 || Math.abs(dayMove) >= 20;
      if (!position && minuteOfDay >= entryStartMin && minuteOfDay <= entryEndMin && localState._dayPnl > dailyLossLimit && sessionHasEnergy) {

        // === MECHANICAL QUALITY SCORE ===
        // Score the setup 0-100. Only setups scoring 70+ go to LLM for confirmation.
        // This prevents the LLM from generating false positives on weak setups.

        const bearM = king.bearMagnet;
        const bullM = king.bullMagnet;

        // === SQUEEZE ENTRY: requires WALL BREACH, not just squeeze pressure ===
        // Track top positive walls and detect when price crosses through one.
        // The squeeze happens at the BREACH moment — when price breaks a positive wall,
        // dealers unwind hedges in the same direction, accelerating the move.
        // Use per-frame breach detection (runs every frame, not just LLM frames)
        const squeezeConfirmsUp = localState._breachUp && king.squeezeUp;
        const squeezeConfirmsDown = localState._breachDown && king.squeezeDown;
        // Reset breach flags after checking (one-shot event)
        if (squeezeConfirmsUp || squeezeConfirmsDown) {
          localState._breachUp = false;
          localState._breachDown = false;
        }

        // Gate SQUEEZE on breach + squeeze ratio + minimum momentum
        // The squeeze ratio alone triggers on flat days with no directional energy
        const squeezeDir2 = squeezeConfirmsUp ? 'BULLISH' : 'BEARISH';
        const squeezeHasMomentum = (squeezeDir2 === 'BULLISH' && dayMove >= 20) || (squeezeDir2 === 'BEARISH' && dayMove <= -20);
        if ((squeezeConfirmsUp || squeezeConfirmsDown) && llmRegime !== 'CHOP' && squeezeHasMomentum) {
          const squeezeDir = king.squeezeUp ? 'BULLISH' : 'BEARISH';
          const sqDirEntries = localState._entriesPerDir[squeezeDir] || 0;
          const sqDirLosses = localState._dirLosses[squeezeDir] || 0;
          // Target: nearest positive gamma wall in squeeze direction, fallback +25
          let squeezeTarget = squeezeDir === 'BULLISH'
            ? Math.round((spot + 25) / 5) * 5
            : Math.round((spot - 25) / 5) * 5;
          // Find actual nearest positive wall in squeeze direction
          for (const s of parsed.strikes) {
            const g = parsed.aggregatedGex.get(s) || 0;
            if (g < 5_000_000) continue; // only significant positive walls
            const dist = Math.abs(s - spot);
            if (dist < 10 || dist > 60) continue; // within reasonable range
            if (squeezeDir === 'BULLISH' && s > spot) { squeezeTarget = s; break; }
            if (squeezeDir === 'BEARISH' && s < spot) { squeezeTarget = s; break; }
          }

          if (sqDirEntries < 2 && sqDirLosses < 1) {
            position = {
              mode: 'SQUEEZE',
              direction: squeezeDir,
              entrySpx: spot,
              targetStrike: squeezeTarget,
              openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
              entryMinute: minuteOfDay,
              mfe: 0, mae: 0, llmSaysExit: false,
            };
            localState._entriesPerDir[squeezeDir]++;
            if (verbose) console.log(`  SQUEEZE ${etStr} | ${squeezeDir} @ $${Math.round(spot)} → ${squeezeTarget} | POS above ${(king.posAbove/1e6).toFixed(0)}M vs NEG below ${(king.negBelow/1e6).toFixed(0)}M | LLM=${llmRegime}`);
          }
        }

        // === MAGNET ENTRY (existing logic) ===
        // Pick the best magnet (price trend breaks ties when competing)
        let bestMagnet = null;
        if (bearM && bullM) {
          if (priceTrend30 >= 10 && bullM.absValue >= 10_000_000) bestMagnet = bullM;
          else if (priceTrend30 <= -10 && bearM.absValue >= 10_000_000) bestMagnet = bearM;
          else bestMagnet = bearM.absValue > bullM.absValue ? bearM : bullM;
        } else {
          bestMagnet = bearM || bullM;
        }

        if (bestMagnet) {
          const dir = bestMagnet.dist < 0 ? 'BEARISH' : 'BULLISH';
          const dist = Math.abs(bestMagnet.dist);
          const value = bestMagnet.absValue;
          const oppMagnet = dir === 'BEARISH' ? bullM : bearM;

          // === QUALITY SCORE ===
          // Uses RELATIVE magnet size (% of total gamma) not just absolute value
          const magnetPct = king.totalAbsGamma > 0 ? (value / king.totalAbsGamma * 100) : 0;
          let quality = 0;

          // Distance: 25pts=10, 40pts=25, 60pts+=40 (max 40)
          quality += Math.min(40, Math.max(0, (dist - 20) * 2));

          // Relative size: 8%=10, 12%=20, 18%+=30 (max 30) — how dominant is this magnet?
          quality += Math.min(30, Math.max(0, (magnetPct - 5) * 2.5));

          // No competing magnet: +20 if no opponent, -10 if opponent is bigger
          if (!oppMagnet || oppMagnet.absValue < 5_000_000) quality += 20;
          else if (oppMagnet.absValue > value) quality -= 10;

          // Price aligned with magnet direction: +10
          if ((dir === 'BEARISH' && dayMove < 0) || (dir === 'BULLISH' && dayMove > 0)) quality += 10;
          // Price fighting magnet: -20
          if ((dir === 'BEARISH' && dayMove > 40) || (dir === 'BULLISH' && dayMove < -40)) quality -= 20;

          // Entry limits per direction
          const dirEntries = localState._entriesPerDir[dir] || 0;
          if (!localState._dirLosses) localState._dirLosses = { BULLISH: 0, BEARISH: 0 };
          if (!localState._dirWins) localState._dirWins = { BULLISH: 0, BEARISH: 0 };
          const dirLosses = localState._dirLosses[dir] || 0;
          const dirWins = localState._dirWins[dir] || 0;

          // After a loss, no re-entry in same direction
          if (dirLosses >= 1) quality = 0;
          // Max 3 entries if winning, max 2 otherwise
          if (dirWins > 0 && dirEntries >= 3) quality = 0;
          else if (dirWins === 0 && dirEntries >= 2) quality = 0;

          // No win bonus — a prior win doesn't validate the next trade's structural setup.
          // The magnet size and trend already capture whether the setup is still valid.

          // Time-band structural penalty for TREND mode:
          // 10:00-12:00 = best for TREND (regime confirms)
          // 12:00-14:00 = dead zone, pinning strongest, TREND fails
          // 14:00-close = gamma collapsing, momentum dominates over magnets
          if (minuteOfDay >= 720 && minuteOfDay <= 840) quality -= 20; // 12:00-14:00 dead zone
          if (minuteOfDay >= 840) quality -= 10; // after 14:00, magnets weaken

          // Late to the party penalty
          if ((dir === 'BEARISH' && dayMove < -80) || (dir === 'BULLISH' && dayMove > 80)) quality -= 30;

          // GAMMA SQUEEZE penalty: if positive gamma on opposite side overwhelms our magnet,
          // dealers are hedging AGAINST our direction. Don't fight the squeeze.
          if (dir === 'BEARISH' && king.squeezeUp) quality -= 25;
          if (dir === 'BULLISH' && king.squeezeDown) quality -= 25;

          // Magnet rapidly growing = penalty (46% of losses vs 16% of wins)
          // Stable/established magnets work better than rapidly building ones
          if (!localState._prevMagnetValue) localState._prevMagnetValue = [];
          localState._prevMagnetValue.push(value);
          if (localState._prevMagnetValue.length > 3) localState._prevMagnetValue.shift();
          if (localState._prevMagnetValue.length >= 3) {
            const prev = localState._prevMagnetValue[0];
            if (prev > 0 && value > prev * 1.3) quality -= 10; // grew 30%+ in 20 min = penalty
          }

          if (verbose && quality >= 50) {
            console.log(`  QUALITY ${etStr} | ${dir} score=${quality.toFixed(0)} | magnet ${bestMagnet.strike} (${dist.toFixed(0)}pts, ${fmtVal(bestMagnet.value)}, ${magnetPct.toFixed(0)}% of total) | opp=${oppMagnet ? fmtVal(oppMagnet.value) : 'none'} | day=${dayMove > 0 ? '+' : ''}${dayMove.toFixed(0)}`);
          }

          // Quality 60+ goes to LLM for confirmation. Quality 75+ overrides LLM.
          // Minimum: 20pts away and either $10M absolute OR 8% relative
          const meetsMinimum = dist >= 20 && value >= 10_000_000 && magnetPct >= 6;
          if (quality >= 55 && meetsMinimum) {
            const llmConfirms = llmConf === 'HIGH' && llmRegime !== 'CHOP';
            const qualityOverride = quality >= 75;
            const superQuality = quality >= 80; // very strong setup, enter regardless

            // Hard squeeze gate: NEVER enter TREND against an active squeeze
            const squeezeBlocsTrend = (dir === 'BEARISH' && king.squeezeUp) || (dir === 'BULLISH' && king.squeezeDown);
            if ((llmConfirms || qualityOverride || superQuality) && !squeezeBlocsTrend) {
              position = {
                mode: 'TREND',
                direction: dir,
                entrySpx: spot,
                targetStrike: bestMagnet.strike,
                openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
                entryMinute: minuteOfDay,
                mfe: 0, mae: 0, llmSaysExit: false,
                _quality: quality,
              };
              localState._entriesPerDir[dir]++;
              if (verbose) console.log(`  ENTER ${etStr} | ${dir} Q=${quality} @ $${Math.round(spot)} → ${bestMagnet.strike} (${dist.toFixed(0)}pts, ${fmtVal(bestMagnet.value)}) LLM=${llmRegime}`);
            } else if (verbose) {
              console.log(`  BLOCKED by LLM: ${llmRegime} ${llmConf} (need HIGH + not CHOP)`);
            }
          }
        }

        // === GEX-DEFYING MOMENTUM ===
        // When price moves 40+ pts AGAINST the net gamma pull, something external
        // is overpowering gamma. The selling/buying is real. Trade WITH price, not GEX.
        // Jan 20: SPX dropped 149 pts while GEX pulled bullish the entire day.
        // Feb 12: SPX dropped 108 pts while GEX pulled bullish.
        if (!position && (bearM || bullM)) {
          const totalNegBelow = bearM ? bearM.absValue : 0;
          const totalNegAbove = bullM ? bullM.absValue : 0;
          const gexPullDir = totalNegBelow > totalNegAbove ? 'BEARISH' : 'BULLISH';
          const priceDir = dayMove > 0 ? 'BULLISH' : 'BEARISH';
          // Dynamic DEFY: big move from open, not reversing, and still room to run
          const reversing = (priceDir === 'BULLISH' && priceTrend30 < -15) || (priceDir === 'BEARISH' && priceTrend30 > 15);
          const bigMove = Math.abs(dayMove) >= 40;
          // Don't enter if 30-min trend shows price bouncing back 15+ pts
          // REGIME FILTER: DEFY only in NEGATIVE GEX (dealers amplifying moves).
          // In POSITIVE GEX, a 40pt move against a wall is a fade setup, not a trend.
          const defyRegimeOk = king.regime === 'NEGATIVE';
          const defying = gexPullDir !== priceDir && bigMove && !reversing && defyRegimeOk;
          const dirEntries = localState._entriesPerDir[priceDir] || 0;
          if (!localState._defyCount) localState._defyCount = 0;

          const alreadyWonTrend = (localState._trendWins[priceDir] || 0) > 0;
          // Soft LLM block: if LLM says CHOP HIGH, don't DEFY
          const llmBlocksDefy = llmRegime === 'CHOP' && llmConf === 'HIGH';
          const defyMax = 2;
          if (defying && !alreadyWonTrend && !llmBlocksDefy && dirEntries < 2 && localState._defyCount < defyMax && minuteOfDay >= timeToMinutes('11:00')) {
            // Price is overpowering gamma — trade with price momentum
            // Find a reasonable target: the next round number in price direction
            const targetStrike = priceDir === 'BEARISH'
              ? Math.round((spot - 30) / 5) * 5  // 30 pts below, rounded to 5
              : Math.round((spot + 30) / 5) * 5;
            const defyDist = Math.abs(targetStrike - spot);

            if (defyDist >= 20 && defyDist <= 60) {
              position = {
                mode: 'DEFY',
                direction: priceDir,
                entrySpx: spot,
                targetStrike,
                openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
                mfe: 0, mae: 0, llmSaysExit: false,
                _defyStop: 15, // wider stop for momentum trades
              };
              localState._entriesPerDir[priceDir]++;
              localState._defyCount++;
              if (verbose) console.log(`  DEFY ${etStr} | ${priceDir} @ $${Math.round(spot)} → ${targetStrike} | price ${dayMove > 0 ? '+' : ''}${dayMove.toFixed(0)} AGAINST ${gexPullDir} gamma`);
            }
          }
        }

        // === BREAKOUT: big magnet at spot, price broke away ===
        // Dec 23: 6885 magnet at spot, SPX rallied to 6908 (+30)
        // Jan 5: 6930 magnet at spot, SPX rallied to 6920 (+43)
        // When a big magnet is within 15pts of spot but price has moved 20+ away, breakout
        // LLM CHOP gate: don't breakout if LLM sees chop with high confidence
        const breakoutChopBlock = llmRegime === 'CHOP' && llmConf === 'HIGH';
        if (!position && !breakoutChopBlock && king.magnetStrike && Math.abs(king.magnetDist) <= 15 && king.magnetAbsValue >= 15_000_000) {
          const breakDist = Math.abs(dayMove);
          if (breakDist >= 20 && breakDist <= 60 && minuteOfDay >= timeToMinutes('10:30')) {
            const breakDir = dayMove > 0 ? 'BULLISH' : 'BEARISH';
            const breakTarget = breakDir === 'BULLISH'
              ? Math.round((spot + 20) / 5) * 5
              : Math.round((spot - 20) / 5) * 5;
            const bDirEntries = localState._entriesPerDir[breakDir] || 0;
            if (bDirEntries < 1) {
              position = {
                mode: 'BREAKOUT',
                direction: breakDir,
                entrySpx: spot,
                targetStrike: breakTarget,
                openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
                mfe: 0, mae: 0, llmSaysExit: false,
                _breakStop: 12,
              };
              localState._entriesPerDir[breakDir]++;
              if (verbose) console.log(`  BREAKOUT ${etStr} | ${breakDir} @ $${Math.round(spot)} → ${breakTarget} | broke ${breakDist}pts from pin at ${king.magnetStrike}`);
            }
          }
        }

        // === REGIME 2: PINNED — DISABLED
        if (false && kingDist < 15 && king.absValue >= 10_000_000) {
          const driftFromKing = spot - king.strike;
          const driftAbs = Math.abs(driftFromKing);
          if (driftAbs >= 10) {
            const fadeDir = driftFromKing > 0 ? 'BEARISH' : 'BULLISH';
            position = {
              mode: 'PINNED',
              direction: fadeDir,
              entrySpx: spot,
              targetStrike: king.strike,
              openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
              mfe: 0, mae: 0, llmSaysExit: false,
              _pinnedStop: 5,
              _pinnedTarget: Math.max(5, Math.round(driftAbs * 0.5)),
            };
            if (verbose) console.log(`  PIN ${etStr} | ${fadeDir} @ $${Math.round(spot)} → fade ${driftAbs.toFixed(0)}pts to king ${king.strike}`);
          }
        }

        // === REGIME 3: RANGE (king node 10-25 pts from spot, LLM directional) ===
        // If there's also a far magnet on the same side, upgrade to TREND mode
        else if (false && kingDist >= 10 && kingDist < 25 && king.absValue >= 10_000_000
                 && llmConf === 'HIGH' && llmDir !== 'NEUTRAL') {
          const dir = king.strike < spot ? 'BEARISH' : 'BULLISH';
          // Check if there's a far magnet on same side → upgrade to TREND
          const sameSideMagnet = dir === 'BEARISH' ? king.bearMagnet : king.bullMagnet;
          const hasFarMagnet = sameSideMagnet && Math.abs(sameSideMagnet.dist) >= 25 && sameSideMagnet.absValue >= 10_000_000;
          if (dir === llmDir) {
            if (hasFarMagnet) {
              // Upgrade to TREND — there's a far magnet on our side
              position = {
                mode: 'TREND',
                direction: dir,
                entrySpx: spot,
                targetStrike: sameSideMagnet.strike,
                openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
                mfe: 0, mae: 0, llmSaysExit: false,
              };
              if (verbose) console.log(`  TREND(upgraded) ${etStr} | ${dir} @ $${Math.round(spot)} → magnet ${sameSideMagnet.strike} (${Math.abs(sameSideMagnet.dist).toFixed(0)}pts, ${fmtVal(sameSideMagnet.value)})`);
            } else {
              position = {
                mode: 'RANGE',
                direction: dir,
                entrySpx: spot,
                targetStrike: king.strike,
                openedAt: et.toFormat('yyyy-MM-dd HH:mm:ss'),
                mfe: 0, mae: 0, llmSaysExit: false,
                _rangeStop: 6,
                _rangeTarget: Math.round(kingDist * 0.6),
              };
              if (verbose) console.log(`  RANGE ${etStr} | ${dir} @ $${Math.round(spot)} → ${king.strike} (${kingDist.toFixed(0)}pts)`);
            }
          }
        }
      }

      // LLM exit logic — require 2 CONSECUTIVE opposite signals before exiting.
      // One LLM wobble shouldn't kill a thesis that's been correct for hours.
      // Also: sanity check — if king node is still on our side, LLM direction flip is wrong.
      if (position) {
        // Check if our magnet is still the DOMINANT force, not just alive
        const ourMagnet = position.direction === 'BEARISH' ? king.bearMagnet : king.bullMagnet;
        const oppMagnet = position.direction === 'BEARISH' ? king.bullMagnet : king.bearMagnet;
        const oppSqueeze = (position.direction === 'BEARISH' && king.squeezeUp) || (position.direction === 'BULLISH' && king.squeezeDown);
        const magnetStillAlive = ourMagnet && ourMagnet.absValue >= 10_000_000;
        // RELATIVE check: is our magnet still dominant, or has something bigger emerged?
        const magnetStillDominant = magnetStillAlive
          && (!oppMagnet || ourMagnet.absValue >= oppMagnet.absValue * 0.7)
          && !oppSqueeze; // a squeeze on the other side overpowers our magnet

        const llmWantsExit = llmResult.action === 'EXIT'
          || (llmResult.confidence !== 'LOW' && llmResult.direction !== 'NEUTRAL'
              && llmResult.direction !== position.direction);

        if (llmWantsExit && !magnetStillDominant) {
          // Our magnet is no longer dominant — LLM exit is valid
          position._exitSignals = (position._exitSignals || 0) + 1;
        } else if (llmWantsExit && magnetStillDominant) {
          // Sanity: our magnet is still there. LLM is confused about direction. Ignore.
          if (verbose) {
            console.log(`  SANITY: LLM said ${llmResult.direction} but our ${position.direction} magnet at ${ourMagnet.strike} still ${fmtVal(ourMagnet.value)} — ignoring`);
          }
          position._exitSignals = 0;
        } else {
          // LLM agrees with our position — reset exit counter
          position._exitSignals = 0;
        }

        // Need 2 consecutive exit signals to actually exit
        if ((position._exitSignals || 0) >= 2) {
          position.llmSaysExit = true;
        }
      }
    }
  }

  // Force close any open position at EOD
  if (position) {
    const lastSpxw = isTrinity ? frames[frames.length - 1]?.tickers?.SPXW : frames[frames.length - 1];
    const lastSpot = lastSpxw?.spotPrice || position.entrySpx;
    const isBull = position.direction === 'BULLISH';
    const pnl = Math.round((isBull ? lastSpot - position.entrySpx : position.entrySpx - lastSpot) * 100) / 100;
    trades.push({
      direction: position.direction, entrySpx: position.entrySpx, exitSpx: lastSpot,
      targetStrike: position.targetStrike, pnl, exitReason: 'EOD_FORCE',
      openedAt: position.openedAt, closedAt: 'EOD', mfe: Math.round(position.mfe * 100) / 100,
      mae: Math.round(position.mae * 100) / 100,
    });
    position = null;
  }

  // ---- Scoring ----
  const highConfCalls = calls.filter(c => c.confidence === 'HIGH');
  const medConfCalls = calls.filter(c => c.confidence === 'MEDIUM');
  const dirCalls = calls.filter(c => c.direction !== 'NEUTRAL');
  const correct30 = dirCalls.filter(c => c.dir_correct_30).length;
  const highCorrect30 = highConfCalls.filter(c => c.dir_correct_30).length;
  const enterCalls = calls.filter(c => c.action === 'ENTER' && c.confidence === 'HIGH');

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Summary
  console.log(`\n${dateStr} | ${calls.length} LLM calls | Dir accuracy: ${correct30}/${dirCalls.length} (${dirCalls.length > 0 ? (correct30 / dirCalls.length * 100).toFixed(0) : 0}%) | HIGH: ${highCorrect30}/${highConfCalls.length} | ENTER signals: ${enterCalls.length}`);
  if (trades.length > 0) {
    console.log(`  Trades: ${trades.length} (${wins}W/${losses}L) | NET: ${netPnl > 0 ? '+' : ''}${netPnl.toFixed(2)} pts`);
    for (const t of trades) {
      console.log(`    ${t.openedAt} -> ${t.closedAt} | ${t.direction} | target=${t.targetStrike} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)} pts | ${t.exitReason} | MFE=${t.mfe} MAE=${t.mae}`);
    }
  } else {
    console.log(`  No trades (sat flat)`);
  }

  return { date: dateStr, calls, trades, netPnl, wins, losses };
}

// ---- CLI ----

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const dryRun = args.includes('--dry-run');
  const isBatch = args.includes('--batch');
  const files = args.filter(a => !a.startsWith('--') && a.endsWith('.json'));

  if (files.length === 0) {
    console.log('Usage: node src/backtest/replay-llm-king.js [--verbose] [--dry-run] [--batch] <file.json ...>');
    process.exit(1);
  }

  const cache = loadCache();
  const allResults = [];

  for (const file of files) {
    try {
      const result = await replayLLMKing(file, cache, verbose, dryRun);
      allResults.push(result);
      // Save cache after each day so progress isn't lost
      if (!dryRun) saveCache(cache);
    } catch (err) {
      console.error(`ERROR on ${file}: ${err.message}`);
      if (!dryRun) saveCache(cache);
    }
  }

  // Save cache
  saveCache(cache);

  // Batch summary
  if (isBatch && allResults.length > 1) {
    const totalCalls = allResults.reduce((s, r) => s + r.calls.length, 0);
    const totalTrades = allResults.reduce((s, r) => s + r.trades.length, 0);
    const totalWins = allResults.reduce((s, r) => s + r.wins, 0);
    const totalLosses = allResults.reduce((s, r) => s + r.losses, 0);
    const totalPnl = allResults.reduce((s, r) => s + r.netPnl, 0);
    const tradeDays = allResults.filter(r => r.trades.length > 0).length;
    const flatDays = allResults.filter(r => r.trades.length === 0).length;

    const allCalls = allResults.flatMap(r => r.calls);
    const allDir = allCalls.filter(c => c.direction !== 'NEUTRAL');
    const allDirCorrect = allDir.filter(c => c.dir_correct_30).length;
    const allHigh = allCalls.filter(c => c.confidence === 'HIGH');
    const allHighCorrect = allHigh.filter(c => c.dir_correct_30).length;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  BATCH SUMMARY: ${allResults.length} days`);
    console.log(`${'='.repeat(60)}`);
    console.log(`LLM Calls: ${totalCalls} | Dir accuracy: ${allDirCorrect}/${allDir.length} (${allDir.length > 0 ? (allDirCorrect / allDir.length * 100).toFixed(0) : 0}%)`);
    console.log(`HIGH conf accuracy: ${allHighCorrect}/${allHigh.length} (${allHigh.length > 0 ? (allHighCorrect / allHigh.length * 100).toFixed(0) : 0}%)`);
    console.log(`Trades: ${totalTrades} (${totalWins}W/${totalLosses}L) | NET: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
    console.log(`Trade days: ${tradeDays} | Flat days: ${flatDays}`);
    if (totalWins > 0) {
      const avgWin = allResults.flatMap(r => r.trades).filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / totalWins;
      const avgLoss = totalLosses > 0 ? allResults.flatMap(r => r.trades).filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / totalLosses : 0;
      console.log(`Avg Win: +${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)} | R:R ${totalLosses > 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A'}`);
    }

    // Breakdown by mode
    const allTrades = allResults.flatMap(r => r.trades);
    // Breakdown by ALL modes
    console.log('');
    for (const mode of ['TREND', 'SQUEEZE', 'DEFY', 'BREAKOUT', 'PINNED']) {
      const modeTrades = allTrades.filter(t => t.mode === mode);
      if (modeTrades.length === 0) continue;
      const mw = modeTrades.filter(t => t.pnl > 0).length;
      const ml = modeTrades.filter(t => t.pnl <= 0).length;
      const mp = modeTrades.reduce((s, t) => s + t.pnl, 0);
      console.log(`${mode.padEnd(10)} ${modeTrades.length} trades (${mw}W/${ml}L) | NET: ${mp > 0 ? '+' : ''}${mp.toFixed(2)} pts`);
    }

    // Exit reason breakdown
    const exitCounts = {};
    for (const t of allTrades) {
      const key = t.exitReason;
      if (!exitCounts[key]) exitCounts[key] = { count: 0, pnl: 0 };
      exitCounts[key].count++;
      exitCounts[key].pnl += t.pnl;
    }
    console.log('\nExit reasons:');
    for (const [reason, data] of Object.entries(exitCounts).sort((a, b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${reason.padEnd(15)} ${data.count.toString().padStart(4)} trades | ${data.pnl > 0 ? '+' : ''}${data.pnl.toFixed(2)} pts`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
