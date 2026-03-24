/**
 * ML Feature Extractor
 *
 * Runs the LLM King replay on all days and extracts features + labels
 * for every LLM call. Outputs CSV for training a classifier.
 *
 * Usage: node scripts/ml-extract-features.js > data/ml-training.csv
 */

import { readFileSync, readdirSync } from 'fs';
import { parseGexResponse } from '../src/gex/gex-parser.js';

// ---- Technical Indicators (computed from 1-min price bars) ----

function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50; // neutral default
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function computeEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  // Simple average of last `period` TRs
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function computeVWAP(prices, volumes) {
  // No volume data in GEX replays — approximate with equal-weighted cumulative average
  // This is "time-weighted average price" which approximates VWAP for 1-min bars
  if (prices.length === 0) return 0;
  const sum = prices.reduce((s, p) => s + p, 0);
  return sum / prices.length;
}

// Reuse findKingNode from replay
function findKingNode(parsed) {
  if (!parsed?.strikes?.length || !parsed?.aggregatedGex) return null;
  const spot = parsed.spotPrice;
  if (!spot || spot <= 0) return null;

  let kingStrike = null, kingValue = 0, kingAbsValue = 0;
  let bearMagnet = null, bullMagnet = null;
  let posAbove = 0, posBelow = 0, negAbove = 0, negBelow = 0;
  let totalAbsGamma = 0;

  for (const strike of parsed.strikes) {
    const gex = parsed.aggregatedGex.get(strike) || 0;
    const absGex = Math.abs(gex);
    totalAbsGamma += absGex;
    if (absGex > kingAbsValue && Math.abs(strike - spot) < 200) {
      kingStrike = strike; kingValue = gex; kingAbsValue = absGex;
    }
    if (gex < 0 && absGex > 3_000_000 && Math.abs(strike - spot) < 150) {
      const dist = strike - spot;
      if (dist < 0 && (!bearMagnet || absGex > bearMagnet.absValue))
        bearMagnet = { strike, value: gex, absValue: absGex, dist };
      if (dist > 0 && (!bullMagnet || absGex > bullMagnet.absValue))
        bullMagnet = { strike, value: gex, absValue: absGex, dist };
    }
    if (gex > 0) { if (strike > spot) posAbove += gex; else posBelow += gex; }
    else { if (strike > spot) negAbove += Math.abs(gex); else negBelow += Math.abs(gex); }
  }
  if (!kingStrike) return null;

  const netGex = posAbove + posBelow - negAbove - negBelow;
  const regime = netGex >= 0 ? 'POSITIVE' : 'NEGATIVE';
  const squeezeUp = posAbove > negBelow * 1.5 && posAbove >= 20_000_000;
  const squeezeDown = posBelow > negAbove * 1.5 && posBelow >= 20_000_000;
  const top3 = [...parsed.aggregatedGex.entries()]
    .filter(([s]) => Math.abs(s - spot) < 150)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .reduce((s, [, v]) => s + Math.abs(v), 0);
  const concentration = totalAbsGamma > 0 ? top3 / totalAbsGamma : 0;

  // Flip level
  let flipLevel = null;
  const sortedStrikes = [...parsed.strikes].sort((a, b) => a - b);
  for (let i = 0; i < sortedStrikes.length - 1; i++) {
    const g1 = parsed.aggregatedGex.get(sortedStrikes[i]) || 0;
    const g2 = parsed.aggregatedGex.get(sortedStrikes[i + 1]) || 0;
    if ((g1 < 0 && g2 > 0) || (g1 > 0 && g2 < 0)) {
      flipLevel = (sortedStrikes[i] + sortedStrikes[i + 1]) / 2;
      break;
    }
  }

  // Vacuum zones
  let vacuumBelow = null, vacuumAbove = null;
  for (let i = 0; i < sortedStrikes.length - 1; i++) {
    const s1 = sortedStrikes[i], s2 = sortedStrikes[i + 1];
    const g1 = Math.abs(parsed.aggregatedGex.get(s1) || 0);
    const g2 = Math.abs(parsed.aggregatedGex.get(s2) || 0);
    if (g1 < 3_000_000 && g2 < 3_000_000 && s2 - s1 >= 10) {
      const zone = { from: s1, to: s2, pts: s2 - s1 };
      if (s2 < spot && (!vacuumBelow || zone.pts > vacuumBelow.pts)) vacuumBelow = zone;
      if (s1 > spot && (!vacuumAbove || zone.pts > vacuumAbove.pts)) vacuumAbove = zone;
    }
  }

  return {
    strike: kingStrike, value: kingValue, absValue: kingAbsValue,
    dist: kingStrike - spot,
    bearMagnet, bullMagnet,
    posAbove, posBelow, negAbove, negBelow,
    totalAbsGamma, netGex, regime,
    squeezeUp, squeezeDown, concentration,
    flipLevel, vacuumBelow, vacuumAbove,
    magnetStrike: (bearMagnet || bullMagnet)?.strike || null,
    magnetDist: (bearMagnet || bullMagnet)?.dist || null,
    magnetAbsValue: (bearMagnet || bullMagnet)?.absValue || 0,
  };
}

// Load LLM cache
const cache = JSON.parse(readFileSync('data/llm-king-cache-v2.json'));

// Load ES futures overnight data
let esData = {};
try { esData = JSON.parse(readFileSync('data/es-overnight.json')); } catch (e) { /* no ES data */ }

// CSV header
const header = [
  'date', 'time', 'minute_of_day', 'spot',
  // King node features
  'king_strike', 'king_value_M', 'king_abs_value_M', 'king_dist', 'king_is_negative',
  // Magnet features
  'bear_magnet_dist', 'bear_magnet_value_M', 'bull_magnet_dist', 'bull_magnet_value_M',
  'best_magnet_dist', 'best_magnet_pct_of_total',
  // Regime features
  'regime_negative', 'net_gex_M', 'pos_above_M', 'pos_below_M', 'neg_above_M', 'neg_below_M',
  'squeeze_up', 'squeeze_down', 'concentration',
  // Structure
  'flip_level_dist', 'vacuum_below_pts', 'vacuum_above_pts',
  // Price features
  'day_move', 'day_range', 'price_trend_10', 'price_trend_30',
  'move_from_hod', 'move_from_lod',
  // King history
  'king_stability_pct', 'unique_kings_count', 'king_growth_pct',
  // Opening features
  'opening_gamma_M', 'opening_range',
  // Time features
  'hours_since_open', 'is_morning', 'is_afternoon', 'is_power_hour',
  // State features
  'entries_so_far', 'losses_so_far',
  // LLM output
  'llm_direction', 'llm_confidence', 'llm_regime', 'llm_action',
  // Day move context (trade vs day direction)
  'day_move_agrees', 'day_move_magnitude', 'trade_fighting_day',
  // SPY/QQQ cross-asset features
  'spy_king_agrees', 'spy_king_is_negative', 'spy_magnet_dist',
  'qqq_king_agrees', 'qqq_king_is_negative', 'qqq_magnet_dist',
  'trinity_alignment', 'trinity_all_agree',
  // Technical indicators (computed from 1-min price bars)
  'rsi_14', 'price_vs_vwap', 'ema9_above_ema21', 'atr_14',
  'opening_range_broken', 'broke_which_side',
  // ES futures overnight
  'es_overnight_change',
  // Labels
  'move_10min', 'move_30min', 'abs_move_30min',
  'dir_correct_10', 'dir_correct_30',
  'profitable_entry',  // would a TREND entry here have been profitable?
];
console.log(header.join(','));

const files = readdirSync('data')
  .filter(f => f.startsWith('gex-replay-') && f.endsWith('.json'))
  .sort();

for (const file of files) {
  const rawJson = readFileSync(`data/${file}`, 'utf-8');
  const data = JSON.parse(rawJson);
  const { metadata, frames } = data;
  const dateStr = metadata?.date || file.replace('gex-replay-', '').replace('.json', '');
  const isTrinity = metadata?.mode === 'trinity' || (frames[0]?.tickers && typeof frames[0].tickers === 'object');

  // Local tracking
  let openPrice = 0, hod = -Infinity, lod = Infinity;
  let openingGamma = null;
  const kingHistory = [];
  const priceHistory = [];
  let entriesSoFar = 0, lossesSoFar = 0;

  // Technical indicator tracking (1-min bars)
  const allPrices = [];      // all spot prices for VWAP/EMA/RSI
  const barHighs = [];       // per-frame highs for ATR
  const barLows = [];        // per-frame lows for ATR
  const barCloses = [];      // per-frame closes for ATR
  let openingRangeHigh = -Infinity, openingRangeLow = Infinity;
  let openingRangeSet = false;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const spxwData = isTrinity ? frame.tickers?.SPXW : frame;
    if (!spxwData?.spotPrice || !spxwData?.gammaValues) continue;

    const raw = {
      CurrentSpot: spxwData.spotPrice,
      Strikes: spxwData.strikes || Object.keys(spxwData.gammaValues || {}).map(Number),
      GammaValues: spxwData.gammaValues,
      VannaValues: spxwData.vannaValues || [],
      Expirations: spxwData.expirations || [],
    };
    const parsed = parseGexResponse(raw);
    const spot = parsed.spotPrice;
    if (!spot || spot <= 0) continue;

    if (spot > hod) hod = spot;
    if (spot < lod) lod = spot;

    const king = findKingNode(parsed);
    if (!king) continue;

    // SPY/QQQ king nodes (trinity data)
    let spyKing = null, qqqKing = null;
    if (isTrinity) {
      for (const [ticker, setter] of [['SPY', 'spy'], ['QQQ', 'qqq']]) {
        const td = frame.tickers?.[ticker];
        if (td?.spotPrice && td?.gammaValues && td?.strikes?.length > 0) {
          const tRaw = { CurrentSpot: td.spotPrice, Strikes: td.strikes, GammaValues: td.gammaValues };
          const tParsed = parseGexResponse(tRaw);
          const tk = findKingNode(tParsed);
          if (setter === 'spy') spyKing = tk;
          else qqqKing = tk;
        }
      }
    }

    if (openPrice === 0) {
      openPrice = spot;
      openingGamma = king.totalAbsGamma;
    }

    // Track king history
    kingHistory.push({ strike: king.strike, absValue: king.absValue });
    if (kingHistory.length > 60) kingHistory.shift();

    // Track price for trend history (rolling 60)
    priceHistory.push(spot);
    if (priceHistory.length > 60) priceHistory.shift();

    // Track ALL prices for technicals (full day, no cap)
    allPrices.push(spot);
    barHighs.push(spot);  // 1-min bar = single price point
    barLows.push(spot);
    barCloses.push(spot);

    // Opening range: first 20 frames (9:30-9:50)
    if (i < 20) {
      if (spot > openingRangeHigh) openingRangeHigh = spot;
      if (spot < openingRangeLow) openingRangeLow = spot;
    } else if (!openingRangeSet) {
      openingRangeSet = true;
    }

    // Only extract at LLM call intervals
    if (i < 20 || i % 10 !== 0) continue;

    // Get LLM response from cache
    const et_h = Math.floor(((i * 60) + 9 * 3600 + 30 * 60) / 3600);
    const et_m = Math.floor((((i * 60) + 9 * 3600 + 30 * 60) % 3600) / 60);
    const etStr = `${String(et_h).padStart(2, '0')}:${String(et_m).padStart(2, '0')}`;
    const cacheKey = `${dateStr}_${etStr}`;
    const llmResult = cache[cacheKey];
    if (!llmResult) continue;

    const minuteOfDay = et_h * 60 + et_m;

    // Compute features
    const dayMove = spot - openPrice;
    const dayRange = hod - lod;

    // Price trends
    const priceTrend10 = priceHistory.length >= 10
      ? spot - priceHistory[priceHistory.length - 10] : 0;
    const priceTrend30 = priceHistory.length >= 30
      ? spot - priceHistory[priceHistory.length - 30] : 0;

    // King stability
    const recentKings = kingHistory.slice(-20);
    const currentKing = king.strike;
    const framesAsKing = recentKings.filter(h => h.strike === currentKing).length;
    const kingStabilityPct = recentKings.length > 0 ? framesAsKing / recentKings.length : 0;
    const uniqueKings = new Set(recentKings.map(h => h.strike)).size;
    const firstSeen = recentKings.find(h => h.strike === currentKing);
    const kingGrowthPct = firstSeen && firstSeen.absValue > 0
      ? (king.absValue - firstSeen.absValue) / firstSeen.absValue : 0;

    // Best magnet
    const bestMagnet = king.bearMagnet && king.bullMagnet
      ? (king.bearMagnet.absValue > king.bullMagnet.absValue ? king.bearMagnet : king.bullMagnet)
      : king.bearMagnet || king.bullMagnet;
    const bestMagnetPct = bestMagnet && king.totalAbsGamma > 0
      ? bestMagnet.absValue / king.totalAbsGamma : 0;

    // Opening range (first 20 frames)
    const openingRange = i >= 20 ? (() => {
      let orHigh = -Infinity, orLow = Infinity;
      for (let j = 0; j < Math.min(20, frames.length); j++) {
        const fd = isTrinity ? frames[j]?.tickers?.SPXW : frames[j];
        const s = fd?.spotPrice;
        if (s) { if (s > orHigh) orHigh = s; if (s < orLow) orLow = s; }
      }
      return orHigh - orLow;
    })() : 0;

    // Future moves (labels)
    const spot10 = (i + 10 < frames.length) ? (() => {
      const f = isTrinity ? frames[i + 10]?.tickers?.SPXW : frames[i + 10];
      return f?.spotPrice || null;
    })() : null;
    const spot30 = (i + 30 < frames.length) ? (() => {
      const f = isTrinity ? frames[i + 30]?.tickers?.SPXW : frames[i + 30];
      return f?.spotPrice || null;
    })() : null;
    // Would a TREND entry (in LLM direction) from this point profit?
    // Check max favorable excursion in next 60 frames
    let maxFavorable = 0;
    for (let j = i + 1; j < Math.min(i + 60, frames.length); j++) {
      const fd = isTrinity ? frames[j]?.tickers?.SPXW : frames[j];
      const fs = fd?.spotPrice;
      if (!fs) continue;
      const prog = llmResult.direction === 'BULLISH' ? fs - spot : spot - fs;
      if (prog > maxFavorable) maxFavorable = prog;
    }
    const profitableEntry = maxFavorable >= 15; // would have gotten +15 pts

    const move10 = spot10 ? spot10 - spot : null;
    const move30 = spot30 ? spot30 - spot : null;
    const dirCorrect10 = move10 !== null &&
      ((llmResult.direction === 'BULLISH' && move10 > 0) || (llmResult.direction === 'BEARISH' && move10 < 0));
    const dirCorrect30 = move30 !== null &&
      ((llmResult.direction === 'BULLISH' && move30 > 0) || (llmResult.direction === 'BEARISH' && move30 < 0));

    // Output CSV row
    const row = [
      dateStr, etStr, minuteOfDay, Math.round(spot),
      king.strike, (king.value / 1e6).toFixed(2), (king.absValue / 1e6).toFixed(2), king.dist.toFixed(1), king.value < 0 ? 1 : 0,
      king.bearMagnet ? king.bearMagnet.dist.toFixed(1) : '', king.bearMagnet ? (king.bearMagnet.absValue / 1e6).toFixed(2) : '',
      king.bullMagnet ? king.bullMagnet.dist.toFixed(1) : '', king.bullMagnet ? (king.bullMagnet.absValue / 1e6).toFixed(2) : '',
      bestMagnet ? Math.abs(bestMagnet.dist).toFixed(1) : '', (bestMagnetPct * 100).toFixed(1),
      king.regime === 'NEGATIVE' ? 1 : 0, (king.netGex / 1e6).toFixed(2),
      (king.posAbove / 1e6).toFixed(2), (king.posBelow / 1e6).toFixed(2),
      (king.negAbove / 1e6).toFixed(2), (king.negBelow / 1e6).toFixed(2),
      king.squeezeUp ? 1 : 0, king.squeezeDown ? 1 : 0, king.concentration.toFixed(3),
      king.flipLevel ? (king.flipLevel - spot).toFixed(1) : '',
      king.vacuumBelow ? king.vacuumBelow.pts : 0, king.vacuumAbove ? king.vacuumAbove.pts : 0,
      dayMove.toFixed(1), dayRange.toFixed(1), priceTrend10.toFixed(1), priceTrend30.toFixed(1),
      (spot - hod).toFixed(1), (spot - lod).toFixed(1),
      (kingStabilityPct * 100).toFixed(0), uniqueKings, (kingGrowthPct * 100).toFixed(0),
      openingGamma ? (openingGamma / 1e6).toFixed(1) : '', openingRange.toFixed(1),
      ((minuteOfDay - 570) / 60).toFixed(2), minuteOfDay < 660 ? 1 : 0, minuteOfDay >= 780 ? 1 : 0, minuteOfDay >= 900 ? 1 : 0,
      entriesSoFar, lossesSoFar,
      llmResult.direction === 'BULLISH' ? 1 : llmResult.direction === 'BEARISH' ? -1 : 0,
      llmResult.confidence === 'HIGH' ? 2 : llmResult.confidence === 'MEDIUM' ? 1 : 0,
      llmResult.regime === 'TREND' ? 2 : llmResult.regime === 'CHOP' ? 0 : 1,
      llmResult.action === 'ENTER' ? 1 : 0,
      // Day move context features
      (() => {
        const dir = llmResult.direction === 'BULLISH' ? 1 : llmResult.direction === 'BEARISH' ? -1 : 0;
        const agrees = (dir > 0 && dayMove > 10) || (dir < 0 && dayMove < -10);
        const fighting = (dir > 0 && dayMove < -30) || (dir < 0 && dayMove > 30);
        return [agrees ? 1 : 0, Math.abs(dayMove).toFixed(1), fighting ? 1 : 0];
      })(),
      // SPY/QQQ cross-asset features
      (() => {
        const tradeDir = bestMagnet ? (bestMagnet.dist < 0 ? -1 : 1) : 0;
        // SPY king direction: negative gamma below spot = bearish magnet
        const spyDir = spyKing ? (spyKing.value < 0 ? (spyKing.dist < 0 ? -1 : 1) : 0) : 0;
        const qqqDir = qqqKing ? (qqqKing.value < 0 ? (qqqKing.dist < 0 ? -1 : 1) : 0) : 0;
        const spxwAgrees = tradeDir !== 0 ? 1 : 0; // SPXW always agrees with itself
        const spyAgrees = spyDir !== 0 && spyDir === tradeDir ? 1 : 0;
        const qqqAgrees = qqqDir !== 0 && qqqDir === tradeDir ? 1 : 0;
        const alignment = spxwAgrees + spyAgrees + qqqAgrees;
        return [
          spyAgrees,
          spyKing ? (spyKing.value < 0 ? 1 : 0) : -1,
          spyKing ? Math.abs(spyKing.dist).toFixed(1) : 50,
          qqqAgrees,
          qqqKing ? (qqqKing.value < 0 ? 1 : 0) : -1,
          qqqKing ? Math.abs(qqqKing.dist).toFixed(1) : 50,
          alignment,
          alignment === 3 ? 1 : 0,
        ];
      })(),
      // Technical indicators
      computeRSI(allPrices, 14).toFixed(1),
      (spot - computeVWAP(allPrices)).toFixed(2),
      computeEMA(allPrices, 9) > computeEMA(allPrices, 21) ? 1 : 0,
      computeATR(barHighs, barLows, barCloses, 14).toFixed(2),
      (() => {
        if (!openingRangeSet) return [0, 0];
        const brokeHigh = spot > openingRangeHigh;
        const brokeLow = spot < openingRangeLow;
        const broken = brokeHigh || brokeLow ? 1 : 0;
        const side = brokeHigh ? 1 : brokeLow ? -1 : 0;
        return [broken, side];
      })(),
      // ES overnight
      esData[dateStr] ? esData[dateStr].overnight.toFixed(1) : 0,
      move10 !== null ? move10.toFixed(2) : '',
      move30 !== null ? move30.toFixed(2) : '',
      move30 !== null ? Math.abs(move30).toFixed(2) : '',
      dirCorrect10 ? 1 : 0,
      dirCorrect30 ? 1 : 0,
      profitableEntry ? 1 : 0,
    ];
    console.log(row.join(','));
  }
}
