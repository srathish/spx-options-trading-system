/**
 * Lightweight XGBoost Scorer for Node.js
 *
 * Evaluates an exported XGBoost model (JSON tree dump) without any
 * native dependencies. Walks each decision tree and sums leaf values,
 * then applies sigmoid to get probability.
 *
 * Usage:
 *   import { loadModel, predict } from './ml/xgb-scorer.js';
 *   const model = loadModel('data/ml-model-trees.json');
 *   const prob = predict(model, featureVector);
 */

import { readFileSync } from 'fs';

/**
 * Load an exported XGBoost model from JSON.
 * @param {string} path - Path to ml-model-trees.json
 * @returns {{ trees: object[], baseScore: number }}
 */
export function loadModel(path) {
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return {
    trees: data.trees,
    baseScore: data.base_score || 0.5,
  };
}

/**
 * Walk a single tree and return the leaf value.
 */
function evaluateTree(node, features) {
  if ('leaf' in node) return node.leaf;

  const featureIdx = parseInt(node.split.replace('f', ''), 10);
  const value = features[featureIdx] ?? 0;
  const threshold = node.split_condition;
  const missingGoesLeft = node.missing === node.yes;

  // Handle missing values
  if (value === null || value === undefined || isNaN(value)) {
    const childIdx = missingGoesLeft ? 0 : 1;
    return evaluateTree(node.children[childIdx], features);
  }

  // Standard split: left if < threshold, right otherwise
  if (value < threshold) {
    return evaluateTree(node.children[0], features);
  } else {
    return evaluateTree(node.children[1], features);
  }
}

/**
 * Sigmoid function.
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Predict probability for a single sample.
 * @param {object} model - Loaded model from loadModel()
 * @param {number[]} features - Feature vector (same order as training)
 * @returns {number} Probability 0-1
 */
export function predict(model, features) {
  let logit = 0;
  for (const tree of model.trees) {
    logit += evaluateTree(tree, features);
  }
  return sigmoid(logit);
}

/**
 * Feature names in order (must match training).
 */
export const FEATURE_NAMES = [
  'best_magnet_dist', 'best_magnet_pct_of_total', 'regime_negative',
  'squeeze_up', 'squeeze_down', 'king_stability_pct', 'day_move', 'day_range',
  'minute_of_day', 'king_dist', 'king_abs_value_M', 'king_is_negative',
  'concentration', 'opening_gamma_M', 'price_trend_10', 'price_trend_30',
  'move_from_hod', 'move_from_lod', 'unique_kings_count', 'net_gex_M',
  'llm_direction', 'llm_confidence', 'llm_regime', 'llm_action',
];

/**
 * Build feature vector from GEX king data + state.
 * Convenience function that takes the same objects the replay/live system has.
 */
export function buildFeatureVector(king, spot, localState, llmResult, minuteOfDay, overrides = {}) {
  const bestMagnet = king.bearMagnet && king.bullMagnet
    ? (king.bearMagnet.absValue > king.bullMagnet.absValue ? king.bearMagnet : king.bullMagnet)
    : king.bearMagnet || king.bullMagnet;
  const bestMagnetPct = bestMagnet && king.totalAbsGamma > 0
    ? (bestMagnet.absValue / king.totalAbsGamma) * 100 : 0;

  const dayMove = spot - localState.openPrice;
  const dayRange = localState.hod - localState.lod;

  // King stability from history
  const recentKings = (localState.kingHistory || []).slice(-20);
  const framesAsKing = recentKings.filter(h => h.strike === king.strike).length;
  const kingStabilityPct = recentKings.length > 0 ? (framesAsKing / recentKings.length) * 100 : 50;
  const uniqueKings = new Set(recentKings.map(h => h.strike)).size;

  // Price trends — accept overrides or compute from history
  const prices = localState.priceTrend || [];
  const priceTrend10 = overrides.priceTrend10 ?? (prices.length >= 10 ? spot - prices[prices.length - 10] : 0);
  const priceTrend30 = overrides.priceTrend30 ?? (prices.length >= 30 ? spot - prices[prices.length - 30] : 0);

  // LLM encoding
  const llmDir = llmResult?.direction === 'BULLISH' ? 1 : llmResult?.direction === 'BEARISH' ? -1 : 0;
  const llmConf = llmResult?.confidence === 'HIGH' ? 2 : llmResult?.confidence === 'MEDIUM' ? 1 : 0;
  const llmRegime = llmResult?.regime === 'TREND' ? 2 : llmResult?.regime === 'CHOP' ? 0 : 1;
  const llmAction = llmResult?.action === 'ENTER' ? 1 : 0;

  return [
    bestMagnet ? Math.abs(bestMagnet.dist) : 0,  // best_magnet_dist
    bestMagnetPct,                                 // best_magnet_pct_of_total
    king.regime === 'NEGATIVE' ? 1 : 0,           // regime_negative
    king.squeezeUp ? 1 : 0,                       // squeeze_up
    king.squeezeDown ? 1 : 0,                     // squeeze_down
    kingStabilityPct,                              // king_stability_pct
    dayMove,                                       // day_move
    dayRange,                                      // day_range
    minuteOfDay,                                   // minute_of_day
    king.dist,                                     // king_dist
    king.absValue / 1e6,                           // king_abs_value_M
    king.value < 0 ? 1 : 0,                       // king_is_negative
    king.concentration,                            // concentration
    (localState.openingGamma || 0) / 1e6,          // opening_gamma_M
    priceTrend10,                                  // price_trend_10
    priceTrend30,                                  // price_trend_30
    spot - localState.hod,                         // move_from_hod
    spot - localState.lod,                         // move_from_lod
    uniqueKings,                                   // unique_kings_count
    king.netGex / 1e6,                             // net_gex_M
    llmDir,                                        // llm_direction
    llmConf,                                       // llm_confidence
    llmRegime,                                     // llm_regime
    llmAction,                                     // llm_action
  ];
}
