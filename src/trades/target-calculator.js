/**
 * Target Calculator
 * Pure math for option price estimation using delta-gamma approximation.
 * No external dependencies — just math.
 */

const DEFAULT_HOURS_TO_TARGET = 1.5; // 0DTE average hold time

/**
 * Estimate option price change using delta-gamma-theta approximation.
 * V_new ≈ V + δ·dS + ½·γ·dS² + θ·dt
 *
 * @param {Object} params
 * @param {number} params.currentOptionPrice - Current option mid price
 * @param {number} params.currentSpot - Current SPX spot
 * @param {number} params.targetSpot - Target SPX price
 * @param {number} params.delta - Option delta
 * @param {number} params.gamma - Option gamma
 * @param {number} params.theta - Option theta (daily, negative for longs)
 * @param {number} [params.hoursToTarget] - Hours until target (default 1.5)
 * @returns {number} Estimated new option price
 */
export function estimateOptionPrice({
  currentOptionPrice,
  currentSpot,
  targetSpot,
  delta,
  gamma,
  theta,
  hoursToTarget = DEFAULT_HOURS_TO_TARGET,
}) {
  const dS = targetSpot - currentSpot;
  const dt = hoursToTarget / 24; // theta is in daily units

  const deltaComponent = delta * dS;
  const gammaComponent = 0.5 * gamma * dS * dS;
  const thetaComponent = theta * dt;

  const estimated = currentOptionPrice + deltaComponent + gammaComponent + thetaComponent;

  // Floor at 0.05 (min tick for SPX options)
  return Math.max(0.05, estimated);
}

/**
 * Calculate target and stop option prices + P&L percentages.
 *
 * @param {Object} params
 * @param {number} params.entryOptionPrice - Entry price of the option
 * @param {number} params.spotPrice - Current SPX spot
 * @param {number} params.targetSpx - Target SPX price (GEX wall)
 * @param {number} params.stopSpx - Stop-loss SPX price (GEX floor)
 * @param {Object} params.greeks - { delta, gamma, theta }
 * @param {number} [params.hoursToTarget] - Hours to target
 * @returns {Object} { targetOptionPrice, stopOptionPrice, targetPnlPct, stopPnlPct, rewardRiskRatio }
 */
export function calculateTargets({
  entryOptionPrice,
  spotPrice,
  targetSpx,
  stopSpx,
  greeks,
  hoursToTarget = DEFAULT_HOURS_TO_TARGET,
}) {
  const { delta, gamma, theta } = greeks;

  const targetOptionPrice = estimateOptionPrice({
    currentOptionPrice: entryOptionPrice,
    currentSpot: spotPrice,
    targetSpot: targetSpx,
    delta,
    gamma,
    theta,
    hoursToTarget,
  });

  const stopOptionPrice = estimateOptionPrice({
    currentOptionPrice: entryOptionPrice,
    currentSpot: spotPrice,
    targetSpot: stopSpx,
    delta,
    gamma,
    theta,
    hoursToTarget: hoursToTarget * 0.5, // stops hit faster
  });

  const targetPnlPct = ((targetOptionPrice - entryOptionPrice) / entryOptionPrice) * 100;
  const stopPnlPct = ((stopOptionPrice - entryOptionPrice) / entryOptionPrice) * 100;

  const reward = Math.abs(targetOptionPrice - entryOptionPrice);
  const risk = Math.abs(entryOptionPrice - stopOptionPrice);
  const rewardRiskRatio = risk > 0 ? reward / risk : 0;

  return {
    targetOptionPrice: Math.round(targetOptionPrice * 100) / 100,
    stopOptionPrice: Math.round(stopOptionPrice * 100) / 100,
    targetPnlPct: Math.round(targetPnlPct * 10) / 10,
    stopPnlPct: Math.round(stopPnlPct * 10) / 10,
    rewardRiskRatio: Math.round(rewardRiskRatio * 100) / 100,
  };
}

/**
 * Estimate current P&L for an open position (lightweight, per-cycle).
 *
 * @param {Object} position - { entryPrice, entrySpx, greeks: { delta, gamma, theta }, openedAt }
 * @param {number} currentSpot - Current SPX price
 * @returns {Object} { estimatedPrice, pnlDollars, pnlPct }
 */
export function estimateCurrentPnl(position, currentSpot) {
  const hoursHeld = (Date.now() - new Date(position.openedAt).getTime()) / (1000 * 60 * 60);

  const estimatedPrice = estimateOptionPrice({
    currentOptionPrice: position.entryPrice,
    currentSpot: position.entrySpx,
    targetSpot: currentSpot,
    delta: position.greeks.delta,
    gamma: position.greeks.gamma,
    theta: position.greeks.theta,
    hoursToTarget: hoursHeld,
  });

  const pnlDollars = estimatedPrice - position.entryPrice;
  const pnlPct = (pnlDollars / position.entryPrice) * 100;

  return {
    estimatedPrice: Math.round(estimatedPrice * 100) / 100,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    pnlPct: Math.round(pnlPct * 10) / 10,
  };
}
