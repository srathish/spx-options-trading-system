/**
 * Technical Agent — Layer 2+3 of the signal framework.
 *
 * Computes from raw price data (no GEX knowledge):
 *   - VWAP (volume-weighted average price, approximated from tick data)
 *   - EMA stack (8/21/50 period on ~1min frames ≈ 8min/21min/50min EMAs)
 *   - QQQ lead signal (QQQ momentum relative to SPX)
 *   - RSI (14-period, for divergence detection at GEX walls)
 *   - Rate of change (momentum into levels)
 *
 * Usage:
 *   const ta = new TechnicalAgent();
 *   ta.addTick('SPXW', 6050.5, timestamp);
 *   ta.addTick('SPY', 604.2, timestamp);
 *   ta.addTick('QQQ', 520.1, timestamp);
 *   const signals = ta.getSignals('SPXW');
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('TechAgent');

class TickerState {
  constructor(ticker) {
    this.ticker = ticker;
    this.prices = [];       // rolling price history
    this.timestamps = [];   // corresponding timestamps
    this.ema8 = null;
    this.ema21 = null;
    this.ema50 = null;
    this.vwap = null;
    this.vwapSum = 0;       // cumulative price sum (proxy for price*volume)
    this.vwapSqSum = 0;     // cumulative price^2 sum (for VWAP std dev)
    this.vwapCount = 0;     // tick count
    this.rsi = null;
    this.rsiGains = [];
    this.rsiLosses = [];
    this.prevClose = null;
    this.openPrice = null;  // first price of day
  }

  reset() {
    this.prices = [];
    this.timestamps = [];
    this.ema8 = null;
    this.ema21 = null;
    this.ema50 = null;
    this.vwap = null;
    this.vwapSum = 0;
    this.vwapSqSum = 0;
    this.vwapCount = 0;
    this.rsi = null;
    this.rsiGains = [];
    this.rsiLosses = [];
    this.prevClose = null;
    this.openPrice = null;
  }
}

function computeEMA(prevEma, price, period) {
  const k = 2 / (period + 1);
  if (prevEma === null) return price;
  return price * k + prevEma * (1 - k);
}

function computeRSI(gains, losses, period = 14) {
  if (gains.length < period) return 50; // neutral if not enough data
  const recentGains = gains.slice(-period);
  const recentLosses = losses.slice(-period);
  const avgGain = recentGains.reduce((s, g) => s + g, 0) / period;
  const avgLoss = recentLosses.reduce((s, l) => s + l, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export class TechnicalAgent {
  constructor() {
    this.tickers = {};
    this.qqqLeadBuffer = [];  // stores {spxRoC, qqqRoC, timestamp}
  }

  _getOrCreate(ticker) {
    if (!this.tickers[ticker]) {
      this.tickers[ticker] = new TickerState(ticker);
    }
    return this.tickers[ticker];
  }

  resetDaily() {
    for (const key of Object.keys(this.tickers)) {
      this.tickers[key].reset();
    }
    this.qqqLeadBuffer = [];
  }

  /**
   * Feed a new price tick for a ticker.
   * Call once per frame (~60s intervals).
   */
  addTick(ticker, price, timestamp) {
    if (!price || price <= 0) return;
    const state = this._getOrCreate(ticker);

    // Store price history (keep last 100 for RoC calculations)
    state.prices.push(price);
    state.timestamps.push(timestamp);
    if (state.prices.length > 100) {
      state.prices.shift();
      state.timestamps.shift();
    }

    // First price of day
    if (state.openPrice === null) {
      state.openPrice = price;
    }

    // VWAP (price-only approximation: equal-weighted since we don't have volume)
    // In practice this is the session average price — still useful as a mean-reversion anchor
    state.vwapCount++;
    state.vwapSum += price;
    state.vwapSqSum += price * price;
    state.vwap = state.vwapSum / state.vwapCount;

    // EMA updates
    state.ema8 = computeEMA(state.ema8, price, 8);
    state.ema21 = computeEMA(state.ema21, price, 21);
    state.ema50 = computeEMA(state.ema50, price, 50);

    // RSI
    if (state.prevClose !== null) {
      const change = price - state.prevClose;
      state.rsiGains.push(change > 0 ? change : 0);
      state.rsiLosses.push(change < 0 ? Math.abs(change) : 0);
      if (state.rsiGains.length > 50) {
        state.rsiGains.shift();
        state.rsiLosses.shift();
      }
      state.rsi = computeRSI(state.rsiGains, state.rsiLosses);
    }
    state.prevClose = price;
  }

  /**
   * Get the full technical signal set for a ticker.
   */
  getSignals(ticker) {
    const state = this._getOrCreate(ticker);
    const price = state.prices[state.prices.length - 1] || 0;
    const n = state.prices.length;

    // EMA stack analysis
    const emaStack = this._analyzeEmaStack(state, price);

    // VWAP relationship
    const vwapSignal = this._analyzeVwap(state, price);

    // Rate of change (momentum)
    const roc = this._computeRoC(state);

    // RSI
    const rsi = state.rsi ?? 50;

    return {
      price,
      vwap: state.vwap,
      vwapSignal,
      ema8: state.ema8,
      ema21: state.ema21,
      ema50: state.ema50,
      emaStack,
      rsi,
      roc,
      tickCount: n,
    };
  }

  /**
   * Get QQQ lead signal relative to SPX.
   * Compares QQQ's rate of change to SPX's rate of change.
   * QQQ leading = QQQ moving first, SPX should follow.
   */
  getQqqLeadSignal() {
    const spx = this.tickers['SPXW'];
    const qqq = this.tickers['QQQ'];

    if (!spx || !qqq || spx.prices.length < 5 || qqq.prices.length < 5) {
      return { active: false, direction: 'NONE', strength: 0, divergence: false };
    }

    // 5-frame (~5 min) rate of change for both
    const spxPrices = spx.prices;
    const qqqPrices = qqq.prices;
    const lookback = 5;

    const spxRoC = (spxPrices[spxPrices.length - 1] - spxPrices[spxPrices.length - 1 - lookback]) / spxPrices[spxPrices.length - 1 - lookback] * 100;
    const qqqRoC = (qqqPrices[qqqPrices.length - 1] - qqqPrices[qqqPrices.length - 1 - lookback]) / qqqPrices[qqqPrices.length - 1 - lookback] * 100;

    // QQQ is "leading" when it's moving more aggressively than SPX in a direction
    const qqqLeading = Math.abs(qqqRoC) > Math.abs(spxRoC) * 1.2; // QQQ 20% more aggressive

    // Direction of QQQ's lead
    let direction = 'NONE';
    if (qqqRoC > 0.02) direction = 'BULLISH';
    else if (qqqRoC < -0.02) direction = 'BEARISH';

    // Divergence: QQQ and SPX moving in opposite directions
    const divergence = (qqqRoC > 0.01 && spxRoC < -0.01) || (qqqRoC < -0.01 && spxRoC > 0.01);

    // Strength: magnitude of QQQ's move
    const strength = Math.min(Math.abs(qqqRoC) / 0.1, 3); // 0-3 scale

    // Store for trend analysis
    this.qqqLeadBuffer.push({ spxRoC, qqqRoC, direction });
    if (this.qqqLeadBuffer.length > 20) this.qqqLeadBuffer.shift();

    // Sustained lead: QQQ has been leading in same direction for 3+ readings
    const recent = this.qqqLeadBuffer.slice(-3);
    const sustainedLead = recent.length >= 3 &&
      recent.every(r => r.direction === direction && r.direction !== 'NONE');

    return {
      active: qqqLeading || sustainedLead,
      direction,
      strength,
      divergence,
      sustainedLead,
      qqqRoC: Math.round(qqqRoC * 1000) / 1000,
      spxRoC: Math.round(spxRoC * 1000) / 1000,
    };
  }

  /**
   * Get confluence score: how many technical signals agree with a proposed direction.
   * This is the Layer 4 logic — qualifying GEX signals with technicals.
   *
   * @param {string} direction - 'BULLISH' or 'BEARISH'
   * @param {number} entryPrice - proposed entry price
   * @returns {object} { score: 0-5, signals: string[], conflicts: string[], recommendation }
   */
  getConfluence(direction, entryPrice) {
    const spx = this.getSignals('SPXW');
    const qqq = this.getSignals('QQQ');
    const qqqLead = this.getQqqLeadSignal();
    const isBullish = direction === 'BULLISH';

    const signals = [];
    const conflicts = [];

    // 1. VWAP relationship
    if (spx.vwap) {
      const aboveVwap = entryPrice > spx.vwap;
      if (isBullish && aboveVwap) {
        signals.push('VWAP: price above VWAP (bullish context)');
      } else if (!isBullish && !aboveVwap) {
        signals.push('VWAP: price below VWAP (bearish context)');
      } else if (isBullish && !aboveVwap) {
        conflicts.push('VWAP: buying below VWAP (mean reversion risk)');
      } else {
        conflicts.push('VWAP: selling above VWAP (mean reversion risk)');
      }
    }

    // 2. EMA stack
    if (spx.emaStack.direction !== 'CHOP') {
      if (spx.emaStack.direction === direction) {
        signals.push(`EMA: ${spx.emaStack.label}`);
      } else {
        conflicts.push(`EMA: stack is ${spx.emaStack.direction} (opposing trade)`);
      }
    }

    // 3. QQQ lead
    if (qqqLead.active) {
      if (qqqLead.direction === direction) {
        signals.push(`QQQ lead: ${qqqLead.direction} (RoC ${qqqLead.qqqRoC}%)`);
      } else if (qqqLead.direction !== 'NONE') {
        conflicts.push(`QQQ lead: ${qqqLead.direction} (opposing, RoC ${qqqLead.qqqRoC}%)`);
      }
    }
    if (qqqLead.divergence) {
      conflicts.push('QQQ divergence: QQQ and SPX moving opposite directions');
    }

    // 4. RSI
    if (spx.rsi !== null) {
      if (isBullish && spx.rsi < 30) {
        signals.push(`RSI oversold (${spx.rsi.toFixed(0)}): bounce likely`);
      } else if (!isBullish && spx.rsi > 70) {
        signals.push(`RSI overbought (${spx.rsi.toFixed(0)}): pullback likely`);
      } else if (isBullish && spx.rsi > 70) {
        conflicts.push(`RSI overbought (${spx.rsi.toFixed(0)}): buying into exhaustion`);
      } else if (!isBullish && spx.rsi < 30) {
        conflicts.push(`RSI oversold (${spx.rsi.toFixed(0)}): selling into exhaustion`);
      }
    }

    // 5. Momentum (rate of change aligned with direction)
    if (spx.roc.roc5min !== 0) {
      const momentumAligned = (isBullish && spx.roc.roc5min > 0) || (!isBullish && spx.roc.roc5min < 0);
      if (momentumAligned) {
        signals.push(`Momentum: ${Math.abs(spx.roc.roc5min).toFixed(2)} pts in ${isBullish ? 'up' : 'down'} direction`);
      } else if (Math.abs(spx.roc.roc5min) > 2) {
        conflicts.push(`Momentum: ${Math.abs(spx.roc.roc5min).toFixed(2)} pts AGAINST trade direction`);
      }
    }

    const score = signals.length;
    const conflictCount = conflicts.length;

    let recommendation;
    if (score >= 4 && conflictCount === 0) {
      recommendation = 'STRONG_ENTRY';
    } else if (score >= 3 && conflictCount <= 1) {
      recommendation = 'ENTRY';
    } else if (score >= 2 && conflictCount <= 1) {
      recommendation = 'WEAK_ENTRY';
    } else if (conflictCount >= 3) {
      recommendation = 'BLOCK';
    } else if (conflictCount >= 2 && score <= 1) {
      recommendation = 'BLOCK';
    } else {
      recommendation = 'NEUTRAL';
    }

    return {
      score,
      conflictCount,
      signals,
      conflicts,
      recommendation,
      details: {
        vwapDist: spx.vwap ? Math.round((entryPrice - spx.vwap) * 100) / 100 : null,
        emaStack: spx.emaStack,
        qqqLead,
        rsi: spx.rsi,
        roc: spx.roc,
      },
    };
  }

  // ---- Internal helpers ----

  _analyzeEmaStack(state, price) {
    if (state.ema8 === null || state.ema21 === null || state.ema50 === null) {
      return { direction: 'CHOP', label: 'insufficient data', strength: 0 };
    }

    const bullishStack = state.ema8 > state.ema21 && state.ema21 > state.ema50;
    const bearishStack = state.ema8 < state.ema21 && state.ema21 < state.ema50;
    const priceAboveAll = price > state.ema8;
    const priceBelowAll = price < state.ema8;

    if (bullishStack && priceAboveAll) {
      return { direction: 'BULLISH', label: 'EMA 8>21>50, price above all', strength: 3 };
    } else if (bullishStack) {
      return { direction: 'BULLISH', label: 'EMA 8>21>50 (price dipping)', strength: 2 };
    } else if (bearishStack && priceBelowAll) {
      return { direction: 'BEARISH', label: 'EMA 8<21<50, price below all', strength: 3 };
    } else if (bearishStack) {
      return { direction: 'BEARISH', label: 'EMA 8<21<50 (price bouncing)', strength: 2 };
    }

    // Partial stack
    if (state.ema8 > state.ema21) {
      return { direction: 'BULLISH', label: 'EMA 8>21 (partial bullish)', strength: 1 };
    } else if (state.ema8 < state.ema21) {
      return { direction: 'BEARISH', label: 'EMA 8<21 (partial bearish)', strength: 1 };
    }

    return { direction: 'CHOP', label: 'EMAs converging', strength: 0 };
  }

  _analyzeVwap(state, price) {
    if (!state.vwap) return { position: 'UNKNOWN', distance: 0, strength: 0 };

    const dist = price - state.vwap;
    const distPct = (dist / state.vwap) * 100;

    // VWAP standard deviation for band context
    const variance = state.vwapCount > 1
      ? (state.vwapSqSum / state.vwapCount - state.vwap * state.vwap)
      : 0;
    const stdDev = Math.sqrt(Math.max(0, variance));

    let position, strength;
    if (dist > stdDev) {
      position = 'ABOVE_UPPER_BAND';
      strength = 2;
    } else if (dist > 0) {
      position = 'ABOVE';
      strength = 1;
    } else if (dist < -stdDev) {
      position = 'BELOW_LOWER_BAND';
      strength = 2;
    } else {
      position = 'BELOW';
      strength = 1;
    }

    return { position, distance: Math.round(dist * 100) / 100, distPct: Math.round(distPct * 1000) / 1000, strength, stdDev: Math.round(stdDev * 100) / 100 };
  }

  _computeRoC(state) {
    const prices = state.prices;
    const n = prices.length;

    const roc5min = n >= 5 ? prices[n - 1] - prices[n - 5] : 0;
    const roc10min = n >= 10 ? prices[n - 1] - prices[n - 10] : 0;
    const roc20min = n >= 20 ? prices[n - 1] - prices[n - 20] : 0;

    return {
      roc5min: Math.round(roc5min * 100) / 100,
      roc10min: Math.round(roc10min * 100) / 100,
      roc20min: Math.round(roc20min * 100) / 100,
    };
  }
}
