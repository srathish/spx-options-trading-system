/**
 * Strike Selector
 * Picks the best 0DTE SPX option contract for a given trade signal.
 * Candidates: ATM and ATM+5 (calls) or ATM-5 (puts).
 * Scoring: R:R 40%, delta 25%, liquidity 20%, theta 15%.
 */

import { calculateTargets } from './target-calculator.js';
import { getActiveConfig } from '../review/strategy-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StrikeSelect');

// Static filters
const MIN_OI = 100;
const MAX_SPREAD_PCT = 15;

// Normalization caps
const RR_CAP = 3.0;
const OI_NORM = 5000;

/**
 * Select the best strike for a trade.
 *
 * @param {Object} params
 * @param {string} params.direction - 'BULLISH' or 'BEARISH'
 * @param {number} params.spotPrice - Current SPX spot
 * @param {number} params.atm - ATM strike
 * @param {Array} params.calls - Normalized call contracts
 * @param {Array} params.puts - Normalized put contracts
 * @param {number} params.targetSpx - Target SPX (GEX wall)
 * @param {number} params.stopSpx - Stop SPX (GEX floor)
 * @returns {Object} { selected, candidates, rejectReasons }
 */
export function selectStrike({ direction, spotPrice, atm, calls, puts, targetSpx, stopSpx }) {
  const cfg = getActiveConfig() || {};
  const W_RR = cfg.rr_weight || 0.40;
  const W_DELTA = cfg.delta_weight || 0.25;
  const W_LIQUIDITY = cfg.liquidity_weight || 0.20;
  const W_THETA = cfg.theta_weight || 0.15;
  const MIN_RR = cfg.min_rr_ratio || 1.0;
  const IDEAL_DELTA = (cfg.delta_sweet_spot_low + cfg.delta_sweet_spot_high) / 2 || 0.45;

  const isBullish = direction === 'BULLISH';
  const contracts = isBullish ? calls : puts;
  const candidateStrikes = isBullish
    ? [atm, atm + 5]        // ATM call, 1 strike OTM call
    : [atm, atm - 5];       // ATM put, 1 strike OTM put

  const candidates = [];
  const rejectReasons = [];

  for (const strike of candidateStrikes) {
    const contract = contracts.find(c => c.strike === strike);

    if (!contract) {
      rejectReasons.push({ strike, reason: 'Contract not found in chain' });
      continue;
    }

    // Apply filters
    if (contract.openInterest < MIN_OI) {
      rejectReasons.push({ strike, reason: `Low OI: ${contract.openInterest} < ${MIN_OI}` });
      continue;
    }

    if (contract.lastQuote.spreadPct > MAX_SPREAD_PCT) {
      rejectReasons.push({ strike, reason: `Wide spread: ${contract.lastQuote.spreadPct.toFixed(1)}% > ${MAX_SPREAD_PCT}%` });
      continue;
    }

    if (contract.lastQuote.bid === 0) {
      rejectReasons.push({ strike, reason: 'No bid (bid=0)' });
      continue;
    }

    // Calculate targets using entry at midpoint
    const entryPrice = contract.lastQuote.midpoint || contract.fmv;
    if (!entryPrice || entryPrice <= 0) {
      rejectReasons.push({ strike, reason: 'No valid entry price' });
      continue;
    }

    const targets = calculateTargets({
      entryOptionPrice: entryPrice,
      spotPrice,
      targetSpx,
      stopSpx,
      greeks: contract.greeks,
    });

    if (targets.rewardRiskRatio < MIN_RR) {
      rejectReasons.push({ strike, reason: `Low R:R: ${targets.rewardRiskRatio} < ${MIN_RR}` });
      continue;
    }

    // Score the candidate
    const rrScore = Math.min(targets.rewardRiskRatio / RR_CAP, 1.0);
    const deltaScore = 1 - Math.min(Math.abs(Math.abs(contract.greeks.delta) - IDEAL_DELTA) / IDEAL_DELTA, 1.0);
    const liqScore = Math.min(contract.openInterest / OI_NORM, 1.0);
    const thetaScore = 1 - Math.min(Math.abs(contract.greeks.theta) / 20, 1.0); // less negative = better

    const totalScore =
      W_RR * rrScore +
      W_DELTA * deltaScore +
      W_LIQUIDITY * liqScore +
      W_THETA * thetaScore;

    candidates.push({
      contract,
      entryPrice,
      targets,
      score: Math.round(totalScore * 1000) / 1000,
      breakdown: {
        rr: Math.round(rrScore * 100),
        delta: Math.round(deltaScore * 100),
        liquidity: Math.round(liqScore * 100),
        theta: Math.round(thetaScore * 100),
      },
    });
  }

  if (candidates.length === 0) {
    log.warn(`No valid candidates for ${direction} at ATM=$${atm}`);
    return { selected: null, candidates: [], rejectReasons };
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // If top two within 10% score, prefer ATM
  let selected = candidates[0];
  if (candidates.length > 1) {
    const scoreDiff = (candidates[0].score - candidates[1].score) / candidates[0].score;
    if (scoreDiff < 0.10 && candidates[1].contract.strike === atm) {
      selected = candidates[1];
      log.info('Scores within 10% — defaulting to ATM');
    }
  }

  log.info(
    `Selected: ${selected.contract.ticker} @ $${selected.entryPrice.toFixed(2)} | ` +
    `R:R ${selected.targets.rewardRiskRatio}:1 | score=${selected.score}`
  );

  return { selected, candidates, rejectReasons };
}
