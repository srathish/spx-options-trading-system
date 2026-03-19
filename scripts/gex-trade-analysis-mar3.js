/**
 * GEX Trade Analysis for March 3, 2026 Replay
 *
 * Cross-references actual Skylit GEX data with replay trades to determine
 * which trades had good/bad GEX setups.
 *
 * NOTE: The GEX JSON spotPrice is from Skylit's feed (live SPX), while our replay
 * used Polygon's 15-min delayed SPY*10. The gamma values at each strike are still
 * correct — we look up gamma at the TRADE ENTRY price, not the frame's spot.
 */

import fs from 'fs';

const GEX_DATA_PATH = '/Users/saiyeeshrathish/gex-data-replay-reader/data/gex-replay-2026-03-03.json';

// All 12 trades from Mar 3 replay (times in ET)
const TRADES = [
  { id: 1,  time: '09:54:44', dir: 'BEARISH', pattern: 'RUG_PULL',        entry: 6744.22, exit: 6736.82, pnl: +7.40,  result: 'WIN',  exitReason: 'OPPOSING_WALL' },
  { id: 2,  time: '10:02:11', dir: 'BEARISH', pattern: 'RUG_PULL',        entry: 6745.24, exit: 6749.18, pnl: -3.94,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
  { id: 3,  time: '10:14:27', dir: 'BEARISH', pattern: 'TRIPLE_CEILING',  entry: 6745.81, exit: 6749.73, pnl: -3.92,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
  { id: 4,  time: '10:20:12', dir: 'BULLISH', pattern: 'REVERSE_RUG',     entry: 6741.26, exit: 6752.19, pnl: -10.93, result: 'LOSS', exitReason: 'STOP_LOSS' },
  { id: 5,  time: '10:27:01', dir: 'BULLISH', pattern: 'REVERSE_RUG',     entry: 6748.47, exit: 6738.73, pnl: -9.74,  result: 'LOSS', exitReason: 'NODE_SUPPORT_BREAK' },
  { id: 6,  time: '10:38:46', dir: 'BEARISH', pattern: 'TRIPLE_CEILING',  entry: 6735.99, exit: 6734.50, pnl: +1.49,  result: 'WIN',  exitReason: 'TRAILING_STOP' },
  { id: 7,  time: '10:49:50', dir: 'BEARISH', pattern: 'TRIPLE_CEILING',  entry: 6735.90, exit: 6742.10, pnl: -6.20,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
  { id: 8,  time: '11:04:12', dir: 'BEARISH', pattern: 'TRIPLE_CEILING',  entry: 6740.14, exit: 6728.37, pnl: +11.77, result: 'WIN',  exitReason: 'PROFIT_TARGET' },
  { id: 9,  time: '11:15:58', dir: 'BEARISH', pattern: 'PIKA_PILLOW',     entry: 6721.07, exit: 6720.62, pnl: +0.45,  result: 'WIN',  exitReason: 'TARGET_HIT' },
  { id: 10, time: '11:25:38', dir: 'BEARISH', pattern: 'PIKA_PILLOW',     entry: 6716.79, exit: 6717.61, pnl: -0.82,  result: 'LOSS', exitReason: 'OPPOSING_WALL' },
  { id: 11, time: '11:33:45', dir: 'BEARISH', pattern: 'AIR_POCKET',      entry: 6714.14, exit: 6683.30, pnl: +30.84, result: 'WIN',  exitReason: 'TRAILING_STOP' },
  { id: 12, time: '12:08:20', dir: 'BEARISH', pattern: 'TRIPLE_FLOOR',    entry: 6684.32, exit: 6686.74, pnl: -2.42,  result: 'LOSS', exitReason: 'NODE_SUPPORT_BREAK' },
];

// Convert ET time string to UTC Date for Mar 3, 2026
function etToUtc(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(2026, 2, 3, h + 5, m, s));
}

function findNearestFrame(frames, targetUtc) {
  let best = null;
  let bestDiff = Infinity;
  for (const frame of frames) {
    const diff = Math.abs(new Date(frame.timestamp).getTime() - targetUtc.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = frame;
    }
  }
  return { frame: best, diffMs: bestDiff };
}

function nearestStrikeIdx(strikes, price) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const diff = Math.abs(strikes[i] - price);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function totalGamma(gammaArr) {
  return gammaArr.reduce((a, b) => a + b, 0);
}

// Just 0DTE gamma (first expiration index)
function odteGamma(gammaArr) {
  return gammaArr[0];
}

function classifyGamma(val) {
  const abs = Math.abs(val);
  if (abs < 500000) return 'MINOR';
  if (abs < 2000000) return 'MODERATE';
  if (abs < 5000000) return 'STRONG';
  return 'MASSIVE';
}

function gammaSign(val) {
  return val > 0 ? 'CALL(+)' : 'PUT(-)';
}

function analyzeGexRegime(frame, entryPrice) {
  const { strikes, gammaValues } = frame;
  const spotIdx = nearestStrikeIdx(strikes, entryPrice);

  const gexAtSpot = totalGamma(gammaValues[spotIdx]);
  const odteAtSpot = odteGamma(gammaValues[spotIdx]);

  // Sum gamma above spot (next 12 strikes = 60 pts)
  let gammaAbove = 0;
  let odteAbove = 0;
  let wallsAbove = [];
  for (let i = spotIdx + 1; i <= Math.min(spotIdx + 12, strikes.length - 1); i++) {
    const g = totalGamma(gammaValues[i]);
    const o = odteGamma(gammaValues[i]);
    gammaAbove += g;
    odteAbove += o;
    if (Math.abs(g) > 1000000) {
      wallsAbove.push({ strike: strikes[i], gamma: g, odte: o, dist: strikes[i] - entryPrice });
    }
  }

  // Sum gamma below spot (next 12 strikes = 60 pts)
  let gammaBelow = 0;
  let odteBelow = 0;
  let wallsBelow = [];
  for (let i = spotIdx - 1; i >= Math.max(spotIdx - 12, 0); i--) {
    const g = totalGamma(gammaValues[i]);
    const o = odteGamma(gammaValues[i]);
    gammaBelow += g;
    odteBelow += o;
    if (Math.abs(g) > 1000000) {
      wallsBelow.push({ strike: strikes[i], gamma: g, odte: o, dist: entryPrice - strikes[i] });
    }
  }

  // Build the profile for display (4 above, spot, 4 below)
  const profileStart = Math.max(0, spotIdx - 4);
  const profileEnd = Math.min(strikes.length - 1, spotIdx + 4);
  const profile = [];
  for (let i = profileStart; i <= profileEnd; i++) {
    const g = totalGamma(gammaValues[i]);
    const o = odteGamma(gammaValues[i]);
    const marker = i === spotIdx ? ' << SPOT' : '';
    profile.push({ strike: strikes[i], gamma: g, odte: o, strength: classifyGamma(g), type: gammaSign(g), marker });
  }

  // Find the nearest MASSIVE wall in each direction
  let nearestMassiveAbove = null;
  for (let i = spotIdx + 1; i <= Math.min(spotIdx + 20, strikes.length - 1); i++) {
    const g = totalGamma(gammaValues[i]);
    if (Math.abs(g) >= 5000000) {
      nearestMassiveAbove = { strike: strikes[i], gamma: g, dist: strikes[i] - entryPrice };
      break;
    }
  }
  let nearestMassiveBelow = null;
  for (let i = spotIdx - 1; i >= Math.max(spotIdx - 20, 0); i--) {
    const g = totalGamma(gammaValues[i]);
    if (Math.abs(g) >= 5000000) {
      nearestMassiveBelow = { strike: strikes[i], gamma: g, dist: entryPrice - strikes[i] };
      break;
    }
  }

  return {
    gexAtSpot, odteAtSpot,
    gammaAbove, gammaBelow, odteAbove, odteBelow,
    wallsAbove, wallsBelow,
    nearestMassiveAbove, nearestMassiveBelow,
    profile,
    spotStrike: strikes[spotIdx],
    regime: gexAtSpot > 0 ? 'POSITIVE_GAMMA (mean-revert)' : 'NEGATIVE_GAMMA (trend-follow)',
  };
}

function assessSetup(trade, gex) {
  const reasons = [];
  let score = 0;

  if (trade.dir === 'BEARISH') {
    // --- GEX@spot regime ---
    if (gex.gexAtSpot < -500000) {
      score += 2;
      reasons.push(`GEX@spot strongly NEGATIVE (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- amplifies downward move`);
    } else if (gex.gexAtSpot < 0) {
      score += 1;
      reasons.push(`GEX@spot mildly negative (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- slight trend amplification`);
    } else if (gex.gexAtSpot > 2000000) {
      score -= 2;
      reasons.push(`GEX@spot STRONGLY POSITIVE (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- heavy mean-reversion pressure resists downside`);
    } else {
      score -= 1;
      reasons.push(`GEX@spot positive (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- mild mean-reversion pressure`);
    }

    // --- Net gamma imbalance ---
    // For bearish: want more negative gamma above (put walls = resistance) and less support below
    if (gex.gammaAbove < -5000000) {
      score += 1;
      reasons.push(`Strong net negative gamma above (${(gex.gammaAbove/1e6).toFixed(1)}M) -- dealer hedging caps upside`);
    }

    // --- Immediate support below (call walls within 15 pts) ---
    const immediateSupport = gex.wallsBelow.filter(w => w.gamma > 2000000 && w.dist <= 15);
    if (immediateSupport.length > 0) {
      score -= 2;
      reasons.push(`DANGER: Strong call wall(s) within 15pts below at ${immediateSupport.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M, ${w.dist.toFixed(0)}pts)`).join(', ')} -- floor blocks downside`);
    }

    // --- Nearby support below (call walls 15-30 pts) ---
    const nearbySupport = gex.wallsBelow.filter(w => w.gamma > 2000000 && w.dist > 15 && w.dist <= 30);
    if (nearbySupport.length > 0) {
      score -= 1;
      reasons.push(`Call wall(s) 15-30pts below at ${nearbySupport.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M)`).join(', ')} -- nearby support`);
    }

    // --- Massive negative (put) wall below = magnet pull ---
    if (gex.nearestMassiveBelow && gex.nearestMassiveBelow.gamma < 0) {
      score += 1;
      reasons.push(`Massive put wall below at $${gex.nearestMassiveBelow.strike} (${(gex.nearestMassiveBelow.gamma/1e6).toFixed(1)}M, ${gex.nearestMassiveBelow.dist.toFixed(0)}pts away) -- magnetic pull DOWN`);
    }

    // --- 0DTE gamma concentration (intraday amplifier) ---
    if (gex.odteAtSpot < -500000) {
      score += 1;
      reasons.push(`0DTE gamma at spot: ${(gex.odteAtSpot/1e6).toFixed(2)}M -- 0DTE dealers amplifying downward moves`);
    }

  } else { // BULLISH
    // --- GEX@spot regime ---
    if (gex.gexAtSpot > 2000000) {
      score += 2;
      reasons.push(`GEX@spot strongly POSITIVE (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- heavy mean-reversion supports bounce`);
    } else if (gex.gexAtSpot > 0) {
      score += 1;
      reasons.push(`GEX@spot positive (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- mild mean-reversion supports bounce`);
    } else if (gex.gexAtSpot < -2000000) {
      score -= 3;
      reasons.push(`GEX@spot STRONGLY NEGATIVE (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- trend amplification AGAINST bullish; dealers push it lower`);
    } else {
      score -= 1;
      reasons.push(`GEX@spot negative (${(gex.gexAtSpot/1e6).toFixed(2)}M) -- trend amplification against bullish`);
    }

    // --- Massive put walls above = resistance ---
    const putWallsAbove = gex.wallsAbove.filter(w => w.gamma < -2000000 && w.dist <= 20);
    if (putWallsAbove.length > 0) {
      score -= 2;
      reasons.push(`DANGER: Massive put wall(s) above within 20pts at ${putWallsAbove.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M, ${w.dist.toFixed(0)}pts)`).join(', ')} -- blocks upside`);
    }

    // --- Support floor below (call walls) ---
    const supportBelow = gex.wallsBelow.filter(w => w.gamma > 2000000 && w.dist <= 20);
    if (supportBelow.length > 0) {
      score += 1;
      reasons.push(`Call wall(s) below within 20pts at ${supportBelow.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M)`).join(', ')} -- support floor`);
    }

    // --- Net negative gamma below = magnetic pull DOWN (bad for bull) ---
    if (gex.gammaBelow < -5000000) {
      score -= 1;
      reasons.push(`Heavy net negative gamma below (${(gex.gammaBelow/1e6).toFixed(1)}M) -- magnetic pull down if support breaks`);
    }

    // --- 0DTE gamma negative at spot = bad for bull ---
    if (gex.odteAtSpot < -500000) {
      score -= 1;
      reasons.push(`0DTE gamma at spot: ${(gex.odteAtSpot/1e6).toFixed(2)}M -- 0DTE dealers amplifying AGAINST bullish`);
    }
  }

  let verdict;
  if (score >= 3) verdict = 'STRONG SETUP';
  else if (score >= 1) verdict = 'DECENT SETUP';
  else if (score >= -1) verdict = 'MARGINAL SETUP';
  else verdict = 'BAD SETUP';

  return { score, verdict, reasons };
}

// ─── Main ───
async function main() {
  console.log('Loading GEX data...');
  const raw = fs.readFileSync(GEX_DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  console.log(`Loaded ${data.frames.length} frames from ${data.frames[0].timestamp} to ${data.frames[data.frames.length-1].timestamp}`);
  console.log(`NOTE: GEX frame spotPrice = live Skylit SPX. Trade entries = Polygon delayed SPY*10.`);
  console.log(`      Gamma profiles are looked up at TRADE ENTRY strike, not frame spot.\n`);

  const SEP = '='.repeat(105);
  const THIN = '-'.repeat(105);

  const results = []; // store for summary

  for (const trade of TRADES) {
    const utcTime = etToUtc(trade.time);
    const { frame, diffMs } = findNearestFrame(data.frames, utcTime);
    const gex = analyzeGexRegime(frame, trade.entry);
    const assessment = assessSetup(trade, gex);

    results.push({ trade, gex, assessment, frameTs: frame.timestamp, frameSpot: frame.spotPrice, diffMs });

    console.log(SEP);
    console.log(`TRADE #${trade.id}: ${trade.dir} ${trade.pattern} @ ${trade.time} ET`);
    console.log(`  Entry: $${trade.entry} -> Exit: $${trade.exit} | P&L: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} pts (${trade.result}) [${trade.exitReason}]`);
    console.log(`  GEX frame: ${frame.timestamp} (${(diffMs/1000).toFixed(0)}s offset) | Skylit spot: $${frame.spotPrice} | Spot-Entry delta: ${(frame.spotPrice - trade.entry).toFixed(0)}pts`);
    console.log(THIN);

    // GEX profile
    console.log(`  GEX PROFILE at entry $${trade.entry} (nearest strike $${gex.spotStrike}):`);
    console.log(`  ${'Strike'.padEnd(8)} ${'allExp'.padStart(12)} ${'0DTE'.padStart(12)} ${'Str'.padStart(8)} ${'Type'.padStart(8)}`);
    for (const p of gex.profile) {
      const gStr = (p.gamma / 1e6).toFixed(2) + 'M';
      const oStr = (p.odte / 1e6).toFixed(2) + 'M';
      const bar = p.gamma > 0
        ? '+'.repeat(Math.min(25, Math.round(Math.abs(p.gamma) / 500000)))
        : '-'.repeat(Math.min(25, Math.round(Math.abs(p.gamma) / 500000)));
      console.log(`  ${String(p.strike).padEnd(8)} ${gStr.padStart(12)} ${oStr.padStart(12)} ${p.strength.padStart(8)} ${p.type.padStart(8)} ${bar}${p.marker}`);
    }

    console.log(`\n  GEX@SPOT: ${(gex.gexAtSpot / 1e6).toFixed(2)}M (0DTE: ${(gex.odteAtSpot / 1e6).toFixed(2)}M) | ${gex.regime}`);
    console.log(`  Net gamma ABOVE: ${(gex.gammaAbove / 1e6).toFixed(1)}M (0DTE: ${(gex.odteAbove / 1e6).toFixed(1)}M)`);
    console.log(`  Net gamma BELOW: ${(gex.gammaBelow / 1e6).toFixed(1)}M (0DTE: ${(gex.odteBelow / 1e6).toFixed(1)}M)`);

    if (gex.wallsAbove.length) {
      console.log(`  Walls ABOVE: ${gex.wallsAbove.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M, 0DTE:${(w.odte/1e6).toFixed(1)}M, ${w.dist.toFixed(0)}pts)`).join(' | ')}`);
    }
    if (gex.wallsBelow.length) {
      console.log(`  Walls BELOW: ${gex.wallsBelow.map(w => `$${w.strike}(${(w.gamma/1e6).toFixed(1)}M, 0DTE:${(w.odte/1e6).toFixed(1)}M, ${w.dist.toFixed(0)}pts)`).join(' | ')}`);
    }
    if (gex.nearestMassiveAbove) {
      console.log(`  Nearest MASSIVE above: $${gex.nearestMassiveAbove.strike} (${(gex.nearestMassiveAbove.gamma/1e6).toFixed(1)}M, ${gex.nearestMassiveAbove.dist.toFixed(0)}pts)`);
    }
    if (gex.nearestMassiveBelow) {
      console.log(`  Nearest MASSIVE below: $${gex.nearestMassiveBelow.strike} (${(gex.nearestMassiveBelow.gamma/1e6).toFixed(1)}M, ${gex.nearestMassiveBelow.dist.toFixed(0)}pts)`);
    }

    // Assessment
    console.log(`\n  >>> VERDICT: ${assessment.verdict} (score: ${assessment.score}) <<<`);
    for (const r of assessment.reasons) {
      console.log(`      ${r}`);
    }

    const aligned = (assessment.score >= 1 && trade.result === 'WIN') || (assessment.score < 1 && trade.result === 'LOSS');
    console.log(`  GEX predicted outcome: ${aligned ? 'YES' : 'NO'}`);
    console.log('');
  }

  // ========== SUMMARY ==========
  console.log('\n' + SEP);
  console.log('SUMMARY');
  console.log(SEP);

  const totalPnl = results.reduce((s, r) => s + r.trade.pnl, 0);
  const good = results.filter(r => r.assessment.score >= 1);
  const marginal = results.filter(r => r.assessment.score >= -1 && r.assessment.score < 1);
  const bad = results.filter(r => r.assessment.score < -1);

  const goodPnl = good.reduce((s, r) => s + r.trade.pnl, 0);
  const marginalPnl = marginal.reduce((s, r) => s + r.trade.pnl, 0);
  const badPnl = bad.reduce((s, r) => s + r.trade.pnl, 0);

  const goodWins = good.filter(r => r.trade.result === 'WIN').length;
  const marginalWins = marginal.filter(r => r.trade.result === 'WIN').length;
  const badWins = bad.filter(r => r.trade.result === 'WIN').length;

  console.log(`\nTotal: ${results.length} trades | P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
  console.log(`\n  GOOD setups (score >= 1):    ${good.length} trades | ${goodWins}W ${good.length - goodWins}L | Win rate: ${good.length ? (goodWins/good.length*100).toFixed(0) : 0}% | P&L: ${goodPnl >= 0 ? '+' : ''}${goodPnl.toFixed(2)} pts`);
  console.log(`    Trades: ${good.map(r => `#${r.trade.id}(${r.trade.pnl >= 0 ? '+' : ''}${r.trade.pnl.toFixed(1)})`).join(', ')}`);
  console.log(`  MARGINAL setups (-1 to 0):  ${marginal.length} trades | ${marginalWins}W ${marginal.length - marginalWins}L | Win rate: ${marginal.length ? (marginalWins/marginal.length*100).toFixed(0) : 0}% | P&L: ${marginalPnl >= 0 ? '+' : ''}${marginalPnl.toFixed(2)} pts`);
  console.log(`    Trades: ${marginal.map(r => `#${r.trade.id}(${r.trade.pnl >= 0 ? '+' : ''}${r.trade.pnl.toFixed(1)})`).join(', ')}`);
  console.log(`  BAD setups (score < -1):     ${bad.length} trades | ${badWins}W ${bad.length - badWins}L | Win rate: ${bad.length ? (badWins/bad.length*100).toFixed(0) : 0}% | P&L: ${badPnl >= 0 ? '+' : ''}${badPnl.toFixed(2)} pts`);
  console.log(`    Trades: ${bad.map(r => `#${r.trade.id}(${r.trade.pnl >= 0 ? '+' : ''}${r.trade.pnl.toFixed(1)})`).join(', ')}`);

  // Hypothetical filtered P&L
  console.log(`\n  IF WE BLOCKED BAD SETUPS: ${results.length - bad.length} trades, P&L: ${(totalPnl - badPnl) >= 0 ? '+' : ''}${(totalPnl - badPnl).toFixed(2)} pts (avoided ${badPnl.toFixed(2)} in losses)`);
  console.log(`  IF WE ONLY TOOK GOOD SETUPS: ${good.length} trades, P&L: ${goodPnl >= 0 ? '+' : ''}${goodPnl.toFixed(2)} pts`);

  // Per-pattern
  console.log(`\n${'-'.repeat(70)}`);
  console.log('PER-PATTERN BREAKDOWN:');
  const patterns = [...new Set(TRADES.map(t => t.pattern))];
  for (const pat of patterns) {
    const patResults = results.filter(r => r.trade.pattern === pat);
    const patPnl = patResults.reduce((s, r) => s + r.trade.pnl, 0);
    const patWins = patResults.filter(r => r.trade.result === 'WIN').length;
    const avgScore = (patResults.reduce((s, r) => s + r.assessment.score, 0) / patResults.length).toFixed(1);
    console.log(`  ${pat.padEnd(18)} ${patResults.length} trades | ${patWins}W ${patResults.length - patWins}L | P&L: ${patPnl >= 0 ? '+' : ''}${patPnl.toFixed(2).padStart(7)} | Avg GEX score: ${avgScore}`);
  }

  // ========== KEY FINDINGS ==========
  console.log(`\n${'='.repeat(105)}`);
  console.log('KEY FINDINGS');
  console.log('='.repeat(105));

  console.log(`
1. THE REVERSE_RUG DISASTER (Trades #4, #5: -20.67 pts combined)
   Both bullish REVERSE_RUG trades entered at ~6741-6748 where:
   - GEX@spot was NEGATIVE (-0.05M and -4.41M) = trend-follow regime
   - MASSIVE put walls sat directly above at $6750 (-3.8M to -4.4M, only 2-9pts away)
   - These put walls acted as a ceiling the bullish trades could never break through
   - Meanwhile, negative gamma amplified the downward move against them
   LESSON: Never enter bullish counter-trend trades when GEX@spot is negative AND
   massive put walls sit directly above. The $6750 put wall was the dominant feature
   of the entire morning session.

2. THE $6750 PUT WALL — The Day's Defining Feature
   The -2.6M to -16.4M put wall at $6750 appeared in frames for trades #1 through #8.
   It acted as an impenetrable ceiling for bullish trades and a springboard for bearish
   ones. Trades that recognized this wall (bearish entries below 6750) generally worked;
   trades that fought it (bullish entries trying to push through 6750) got crushed.

3. THE AIR_POCKET JACKPOT (Trade #11: +30.84 pts)
   Entry at $6714 with GEX@spot +1.24M (positive gamma = mild mean-reversion).
   HOWEVER, this trade won despite "wrong" regime because:
   - Massive CALL walls below at $6705 (+10.5M) and $6700 (+2.8M) did NOT hold
   - Once $6705 broke, there was an air pocket to $6675 (-9.6M put wall magnet)
   - The 0DTE gamma was the key amplifier on this leg down
   LESSON: On trend days, even "support" call walls get steamrolled. The air pocket
   pattern correctly identified that the wall WOULD break.

4. POSITIVE GAMMA DIDN'T MEAN REVERSAL ON THIS TREND DAY
   7 of 10 bearish trades entered with positive GEX@spot (mean-revert regime),
   yet 4 of those 7 still WON. On a strong trend day like Mar 3 (SPX dropped 113 pts),
   the macro trend overwhelmed the local GEX mean-reversion signal.
   LESSON: GEX@spot sign alone is insufficient. Must combine with:
   - Put wall density above (resistance structure)
   - Where the nearest MASSIVE wall is (target/floor)
   - Whether 0DTE gamma is amplifying the move

5. THE 0DTE GAMMA AMPLIFIER
   Looking at 0DTE gamma separately reveals the intraday acceleration:`);

  // Show 0DTE analysis for key trades
  for (const r of results) {
    const odteStr = (r.gex.odteAtSpot/1e6).toFixed(2);
    const totalStr = (r.gex.gexAtSpot/1e6).toFixed(2);
    const flag = Math.abs(r.gex.odteAtSpot) > Math.abs(r.gex.gexAtSpot) * 0.5 ? '***' : '';
    console.log(`   #${r.trade.id}: 0DTE=${odteStr}M vs Total=${totalStr}M  ${r.trade.result.padEnd(4)} ${r.trade.pnl >= 0 ? '+' : ''}${r.trade.pnl.toFixed(2).padStart(7)}  ${flag}`);
  }

  console.log(`
6. ACTIONABLE GATE RULES FROM THIS DATA:
   a) BLOCK bullish entries when GEX@spot < 0 AND put wall > 2M within 10pts above
   b) BLOCK bearish entries when GEX@spot > +3M AND call wall > 3M within 10pts below
   c) BOOST bearish confidence when net gamma above is < -5M (strong ceiling)
   d) BOOST confidence when 0DTE gamma aligns with trade direction
   e) On confirmed trend days, treat positive-gamma mean-reversion as WEAK signal
      (don't block trend trades just because GEX@spot is slightly positive)
`);
}

main().catch(console.error);
