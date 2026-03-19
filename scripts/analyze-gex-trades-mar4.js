/**
 * GEX Trade Analysis — March 4, 2026
 * Cross-references replay trades with actual Skylit GEX data
 * to evaluate whether each trade was well-supported by gamma positioning.
 */

import fs from 'fs';

// ─── Load GEX Data ─────────────────────────────────────────────
const gexData = JSON.parse(
  fs.readFileSync('/Users/saiyeeshrathish/gex-data-replay-reader/data/gex-replay-2026-03-04.json', 'utf8')
);

const frames = gexData.frames;

// ─── Trade List ────────────────────────────────────────────────
const trades = [
  { id: 1,  time: '09:46:23', dir: 'BEARISH', pattern: 'TRIPLE_FLOOR',     entry: 6823.46, exit: 6826.07, pnl: -2.61,  result: 'LOSS', exitReason: 'NODE_SUPPORT_BREAK' },
  { id: 2,  time: '10:00:55', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6837.22, exit: 6826.73, pnl: -10.49, result: 'LOSS', exitReason: 'STOP_LOSS' },
  { id: 3,  time: '10:08:49', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6844.07, exit: 6866.18, pnl: +22.11, result: 'WIN',  exitReason: 'TRAILING_STOP' },
  { id: 4,  time: '10:41:33', dir: 'BULLISH', pattern: 'REVERSE_RUG',      entry: 6859.34, exit: 6861.44, pnl: +2.10,  result: 'WIN',  exitReason: 'NODE_SUPPORT_BREAK' },
  { id: 5,  time: '10:48:41', dir: 'BULLISH', pattern: 'REVERSE_RUG',      entry: 6858.09, exit: 6863.71, pnl: +5.62,  result: 'WIN',  exitReason: 'TV_COUNTER_FLIP' },
  { id: 6,  time: '10:58:01', dir: 'BULLISH', pattern: 'REVERSE_RUG',      entry: 6870.75, exit: 6880.38, pnl: +9.63,  result: 'WIN',  exitReason: 'TARGET_HIT' },
  { id: 7,  time: '11:08:24', dir: 'BULLISH', pattern: 'REVERSE_RUG',      entry: 6871.47, exit: 6870.36, pnl: -1.11,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
  { id: 8,  time: '11:15:38', dir: 'BULLISH', pattern: 'REVERSE_RUG',      entry: 6859.90, exit: 6860.48, pnl: +0.58,  result: 'WIN',  exitReason: 'GEX_FLIP' },
  { id: 9,  time: '11:37:54', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6869.04, exit: 6870.71, pnl: +1.67,  result: 'WIN',  exitReason: 'OPPOSING_WALL' },
  { id: 10, time: '11:53:58', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6876.80, exit: 6873.80, pnl: -3.00,  result: 'LOSS', exitReason: 'OPPOSING_WALL' },
  { id: 11, time: '12:23:12', dir: 'BEARISH', pattern: 'RUG_PULL',         entry: 6871.21, exit: 6872.74, pnl: -1.53,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
  { id: 12, time: '12:35:37', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6871.93, exit: 6870.82, pnl: -1.11,  result: 'LOSS', exitReason: 'OPPOSING_WALL' },
  { id: 13, time: '12:53:52', dir: 'BULLISH', pattern: 'MAGNET_PULL',      entry: 6878.03, exit: 6874.63, pnl: -3.40,  result: 'LOSS', exitReason: 'OPPOSING_WALL' },
  { id: 14, time: '13:06:43', dir: 'BEARISH', pattern: 'RANGE_EDGE_FADE',  entry: 6874.07, exit: 6877.92, pnl: -3.85,  result: 'LOSS', exitReason: 'MOMENTUM_TIMEOUT' },
];

// ─── Helpers ───────────────────────────────────────────────────

/** Convert ET time (HH:MM:SS) on 2026-03-04 to UTC timestamp string */
function etToUtc(timeStr) {
  // ET is UTC-5 on March 4 (EST)
  const [h, m, s] = timeStr.split(':').map(Number);
  const utcH = h + 5;
  return `2026-03-04T${String(utcH).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.000Z`;
}

/** Find the closest frame to a given UTC time */
function findFrame(utcTime) {
  const target = new Date(utcTime).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const f of frames) {
    const diff = Math.abs(new Date(f.timestamp).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  return best;
}

/** Find nearest strike index to a price */
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

/** Sum all expirations for a given strike's gamma */
function totalGamma(gammaValues, strikeIdx) {
  return gammaValues[strikeIdx].reduce((a, b) => a + b, 0);
}

/** Format number with commas and sign */
function fmtNum(n) {
  const sign = n >= 0 ? '+' : '';
  return sign + Math.round(n).toLocaleString();
}

/** Determine GEX regime from surrounding strikes */
function analyzeRegime(frame, centerIdx, numStrikesEachSide = 4) {
  const { strikes, gammaValues } = frame;
  const start = Math.max(0, centerIdx - numStrikesEachSide);
  const end = Math.min(strikes.length - 1, centerIdx + numStrikesEachSide);

  let totalPos = 0;
  let totalNeg = 0;
  let netGamma = 0;

  for (let i = start; i <= end; i++) {
    const g = totalGamma(gammaValues, i);
    netGamma += g;
    if (g > 0) totalPos += g;
    else totalNeg += g;
  }

  return { netGamma, totalPos, totalNeg, regime: netGamma > 0 ? 'POSITIVE' : 'NEGATIVE' };
}

/** Find walls (large gamma concentrations) above and below spot */
function findWalls(frame, centerIdx, rangeStrikes = 10) {
  const { strikes, gammaValues } = frame;
  const start = Math.max(0, centerIdx - rangeStrikes);
  const end = Math.min(strikes.length - 1, centerIdx + rangeStrikes);

  const wallsAbove = [];
  const wallsBelow = [];

  for (let i = start; i <= end; i++) {
    const g = totalGamma(gammaValues, i);
    const absG = Math.abs(g);
    if (absG > 1_000_000) { // significant wall threshold
      const wall = { strike: strikes[i], gamma: g, absGamma: absG };
      if (i < centerIdx) wallsBelow.push(wall);
      else if (i > centerIdx) wallsAbove.push(wall);
    }
  }

  // Sort by absolute magnitude descending
  wallsAbove.sort((a, b) => b.absGamma - a.absGamma);
  wallsBelow.sort((a, b) => b.absGamma - a.absGamma);

  return { wallsAbove, wallsBelow };
}

/** Determine if the nearest magnet/attractor is above or below */
function findMagnets(frame, centerIdx, rangeStrikes = 12) {
  const { strikes, gammaValues } = frame;
  const start = Math.max(0, centerIdx - rangeStrikes);
  const end = Math.min(strikes.length - 1, centerIdx + rangeStrikes);

  // Large negative gamma = dealer short gamma = magnet (price attracted to it)
  // Large positive gamma = dealer long gamma = wall (price repelled from it)
  let biggestMagnetAbove = null;
  let biggestMagnetBelow = null;
  let biggestWallAbove = null;
  let biggestWallBelow = null;

  for (let i = start; i <= end; i++) {
    if (i === centerIdx) continue;
    const g = totalGamma(gammaValues, i);

    if (i > centerIdx) {
      if (g < 0 && (!biggestMagnetAbove || g < biggestMagnetAbove.gamma)) {
        biggestMagnetAbove = { strike: strikes[i], gamma: g, dist: strikes[i] - frame.spotPrice };
      }
      if (g > 0 && (!biggestWallAbove || g > biggestWallAbove.gamma)) {
        biggestWallAbove = { strike: strikes[i], gamma: g, dist: strikes[i] - frame.spotPrice };
      }
    } else {
      if (g < 0 && (!biggestMagnetBelow || g < biggestMagnetBelow.gamma)) {
        biggestMagnetBelow = { strike: strikes[i], gamma: g, dist: frame.spotPrice - strikes[i] };
      }
      if (g > 0 && (!biggestWallBelow || g > biggestWallBelow.gamma)) {
        biggestWallBelow = { strike: strikes[i], gamma: g, dist: frame.spotPrice - strikes[i] };
      }
    }
  }

  return { biggestMagnetAbove, biggestMagnetBelow, biggestWallAbove, biggestWallBelow };
}

// ─── Analyze Each Trade ────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  GEX TRADE ANALYSIS — March 4, 2026');
console.log('  Cross-referencing replay trades with actual Skylit GEX levels');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];

for (const trade of trades) {
  const utc = etToUtc(trade.time);
  const frame = findFrame(utc);
  const frameTime = new Date(frame.timestamp);
  const etH = frameTime.getUTCHours() - 5;
  const etM = frameTime.getUTCMinutes();
  const frameTimeET = `${String(etH).padStart(2,'0')}:${String(etM).padStart(2,'0')}`;

  const centerIdx = nearestStrikeIdx(frame.strikes, trade.entry);
  const gexAtSpot = totalGamma(frame.gammaValues, centerIdx);

  // Get 4 strikes each side = 9 strikes total
  const profileStart = Math.max(0, centerIdx - 4);
  const profileEnd = Math.min(frame.strikes.length - 1, centerIdx + 4);

  const regime = analyzeRegime(frame, centerIdx);
  const magnets = findMagnets(frame, centerIdx);
  const walls = findWalls(frame, centerIdx);

  // ─── Assess trade quality ───
  let gexAlignment = 'NEUTRAL';
  let issues = [];
  let strengths = [];

  // 1. GEX@spot sign vs direction
  //    Positive gamma at spot → mean-reverting (walls repel), good for fades
  //    Negative gamma at spot → trending (magnets attract), good for momentum plays
  if (trade.dir === 'BULLISH') {
    // Bullish trade: want negative gamma above (magnets pulling up) or positive gamma below (walls supporting)
    if (magnets.biggestMagnetAbove && Math.abs(magnets.biggestMagnetAbove.gamma) > 1_000_000) {
      strengths.push(`Strong magnet ABOVE at ${magnets.biggestMagnetAbove.strike} (${fmtNum(magnets.biggestMagnetAbove.gamma)}) pulling price up`);
    }
    if (magnets.biggestWallBelow && magnets.biggestWallBelow.gamma > 1_000_000) {
      strengths.push(`Wall BELOW at ${magnets.biggestWallBelow.strike} (${fmtNum(magnets.biggestWallBelow.gamma)}) providing support`);
    }
    if (magnets.biggestWallAbove && magnets.biggestWallAbove.gamma > 2_000_000) {
      issues.push(`MASSIVE WALL ABOVE at ${magnets.biggestWallAbove.strike} (${fmtNum(magnets.biggestWallAbove.gamma)}) blocking upside`);
    }
    if (magnets.biggestMagnetBelow && Math.abs(magnets.biggestMagnetBelow.gamma) > 2_000_000) {
      issues.push(`Strong magnet BELOW at ${magnets.biggestMagnetBelow.strike} (${fmtNum(magnets.biggestMagnetBelow.gamma)}) pulling price down`);
    }
  } else {
    // Bearish trade: want negative gamma below (magnets pulling down) or positive gamma above (walls capping)
    if (magnets.biggestMagnetBelow && Math.abs(magnets.biggestMagnetBelow.gamma) > 1_000_000) {
      strengths.push(`Strong magnet BELOW at ${magnets.biggestMagnetBelow.strike} (${fmtNum(magnets.biggestMagnetBelow.gamma)}) pulling price down`);
    }
    if (magnets.biggestWallAbove && magnets.biggestWallAbove.gamma > 1_000_000) {
      strengths.push(`Wall ABOVE at ${magnets.biggestWallAbove.strike} (${fmtNum(magnets.biggestWallAbove.gamma)}) capping upside`);
    }
    if (magnets.biggestWallBelow && magnets.biggestWallBelow.gamma > 2_000_000) {
      issues.push(`MASSIVE WALL BELOW at ${magnets.biggestWallBelow.strike} (${fmtNum(magnets.biggestWallBelow.gamma)}) blocking downside`);
    }
    if (magnets.biggestMagnetAbove && Math.abs(magnets.biggestMagnetAbove.gamma) > 2_000_000) {
      issues.push(`Strong magnet ABOVE at ${magnets.biggestMagnetAbove.strike} (${fmtNum(magnets.biggestMagnetAbove.gamma)}) pulling price up`);
    }
  }

  // 2. Net regime alignment
  if (regime.regime === 'POSITIVE' && trade.dir === 'BULLISH' && trade.pattern === 'MAGNET_PULL') {
    issues.push(`Net POSITIVE gamma regime (${fmtNum(regime.netGamma)}) — mean-reverting, MAGNET_PULL may stall`);
  }
  if (regime.regime === 'NEGATIVE' && trade.dir === 'BULLISH' && trade.pattern === 'MAGNET_PULL') {
    strengths.push(`Net NEGATIVE gamma regime (${fmtNum(regime.netGamma)}) — trending, supports MAGNET_PULL`);
  }

  // 3. GEX@spot magnitude
  if (Math.abs(gexAtSpot) > 3_000_000) {
    if (gexAtSpot > 0) {
      issues.push(`GEX@spot strongly POSITIVE (${fmtNum(gexAtSpot)}) — dealers hedging against movement at this level`);
    } else {
      strengths.push(`GEX@spot strongly NEGATIVE (${fmtNum(gexAtSpot)}) — dealer hedging amplifies moves from here`);
    }
  }

  // Score
  let score;
  if (strengths.length >= 2 && issues.length === 0) score = 'STRONG SETUP';
  else if (strengths.length > issues.length) score = 'DECENT SETUP';
  else if (issues.length > strengths.length) score = 'POOR SETUP';
  else if (issues.length >= 2) score = 'BAD SETUP';
  else score = 'NEUTRAL';

  // Override: if result was a big win with strengths, mark strong
  if (trade.pnl > 10 && strengths.length >= 1) score = 'STRONG SETUP';

  const resultEntry = {
    id: trade.id,
    score,
    pnl: trade.pnl,
    result: trade.result,
    issues: issues.length,
    strengths: strengths.length
  };
  results.push(resultEntry);

  // ─── Print ───
  const pnlColor = trade.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  const scoreColor = score.includes('STRONG') ? '\x1b[32m' : score.includes('POOR') || score.includes('BAD') ? '\x1b[31m' : '\x1b[33m';

  console.log(`───────────────────────────────────────────────────────────────────`);
  console.log(`  TRADE #${trade.id} │ ${trade.time} ET │ ${trade.dir} ${trade.pattern}`);
  console.log(`  Entry: $${trade.entry} │ Exit: $${trade.exit} │ ${pnlColor}P&L: ${trade.pnl > 0 ? '+' : ''}${trade.pnl}${reset} │ ${trade.exitReason}`);
  console.log(`  Frame: ${frameTimeET} ET │ Spot: $${frame.spotPrice} │ ${scoreColor}${score}${reset}`);
  console.log();

  // GEX Profile
  console.log(`  GEX Profile (9 strikes near spot):`);
  console.log(`  ${'Strike'.padEnd(8)} ${'0DTE'.padStart(10)} ${'AllExp'.padStart(10)} ${'Bar'.padStart(1)}`);
  for (let i = profileStart; i <= profileEnd; i++) {
    const strike = frame.strikes[i];
    const zdte = frame.gammaValues[i][0];
    const total = totalGamma(frame.gammaValues, i);
    const isSpot = i === centerIdx;
    const marker = isSpot ? ' ◄ SPOT' : '';
    const barLen = Math.min(30, Math.round(Math.abs(total) / 500_000));
    const bar = total >= 0
      ? ' '.repeat(15) + '█'.repeat(barLen)
      : ' '.repeat(Math.max(0, 15 - barLen)) + '█'.repeat(barLen);
    console.log(`  ${String(strike).padEnd(8)} ${fmtNum(zdte).padStart(10)} ${fmtNum(total).padStart(10)}  ${bar}${marker}`);
  }

  console.log();
  console.log(`  GEX@Spot (${frame.strikes[centerIdx]}): ${fmtNum(gexAtSpot)} │ Net regime: ${regime.regime} (${fmtNum(regime.netGamma)})`);

  if (strengths.length > 0) {
    console.log(`  ${'\x1b[32m'}STRENGTHS:${reset}`);
    strengths.forEach(s => console.log(`    ✓ ${s}`));
  }
  if (issues.length > 0) {
    console.log(`  ${'\x1b[31m'}ISSUES:${reset}`);
    issues.forEach(s => console.log(`    ✗ ${s}`));
  }

  console.log();
}

// ─── Summary ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════\n');

const strong = results.filter(r => r.score === 'STRONG SETUP');
const decent = results.filter(r => r.score === 'DECENT SETUP');
const neutral = results.filter(r => r.score === 'NEUTRAL');
const poor = results.filter(r => r.score === 'POOR SETUP');
const bad = results.filter(r => r.score === 'BAD SETUP');

console.log(`  STRONG SETUP: ${strong.length} trades → ${strong.filter(r=>r.result==='WIN').length}W ${strong.filter(r=>r.result==='LOSS').length}L │ P&L: ${strong.reduce((s,r)=>s+r.pnl,0).toFixed(2)}`);
console.log(`  DECENT SETUP: ${decent.length} trades → ${decent.filter(r=>r.result==='WIN').length}W ${decent.filter(r=>r.result==='LOSS').length}L │ P&L: ${decent.reduce((s,r)=>s+r.pnl,0).toFixed(2)}`);
console.log(`  NEUTRAL:      ${neutral.length} trades → ${neutral.filter(r=>r.result==='WIN').length}W ${neutral.filter(r=>r.result==='LOSS').length}L │ P&L: ${neutral.reduce((s,r)=>s+r.pnl,0).toFixed(2)}`);
console.log(`  POOR SETUP:   ${poor.length} trades → ${poor.filter(r=>r.result==='WIN').length}W ${poor.filter(r=>r.result==='LOSS').length}L │ P&L: ${poor.reduce((s,r)=>s+r.pnl,0).toFixed(2)}`);
console.log(`  BAD SETUP:    ${bad.length} trades → ${bad.filter(r=>r.result==='WIN').length}W ${bad.filter(r=>r.result==='LOSS').length}L │ P&L: ${bad.reduce((s,r)=>s+r.pnl,0).toFixed(2)}`);

const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
console.log(`\n  Total: ${results.length} trades │ ${results.filter(r=>r.result==='WIN').length}W ${results.filter(r=>r.result==='LOSS').length}L │ Net P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)}`);

// ─── Key Observations ──────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  KEY OBSERVATIONS');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Check afternoon chop
const afternoonTrades = trades.filter(t => {
  const h = parseInt(t.time.split(':')[0]);
  return h >= 12;
});
const afternoonPnl = afternoonTrades.reduce((s, t) => s + t.pnl, 0);
console.log(`  Afternoon trades (12:00+): ${afternoonTrades.length} trades, all LOSSES, P&L: ${afternoonPnl.toFixed(2)}`);
console.log(`    → GEX often flattens in afternoon as 0DTE gamma decays. Walls lose potency.`);

// Check MAGNET_PULL success
const magnetPulls = trades.filter(t => t.pattern === 'MAGNET_PULL');
const mpWins = magnetPulls.filter(t => t.result === 'WIN');
const mpLosses = magnetPulls.filter(t => t.result === 'LOSS');
console.log(`\n  MAGNET_PULL trades: ${magnetPulls.length} total, ${mpWins.length}W ${mpLosses.length}L`);
console.log(`    P&L: ${magnetPulls.reduce((s,t)=>s+t.pnl,0).toFixed(2)}`);

// Check REVERSE_RUG success
const reverseRugs = trades.filter(t => t.pattern === 'REVERSE_RUG');
const rrWins = reverseRugs.filter(t => t.result === 'WIN');
const rrLosses = reverseRugs.filter(t => t.result === 'LOSS');
console.log(`\n  REVERSE_RUG trades: ${reverseRugs.length} total, ${rrWins.length}W ${rrLosses.length}L`);
console.log(`    P&L: ${reverseRugs.reduce((s,t)=>s+t.pnl,0).toFixed(2)}`);

// Spot price journey
console.log('\n  SPOT PRICE JOURNEY (key moments):');
const keyTimes = ['14:30', '14:46', '15:00', '15:08', '15:30', '15:45', '16:00', '16:15', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '20:00', '21:00'];
for (const kt of keyTimes) {
  const f = frames.find(f => f.timestamp >= `2026-03-04T${kt}:00`);
  if (f) {
    const utcH = new Date(f.timestamp).getUTCHours();
    const utcM = new Date(f.timestamp).getUTCMinutes();
    const etH = utcH - 5;
    console.log(`    ${String(etH).padStart(2,'0')}:${String(utcM).padStart(2,'0')} ET → $${f.spotPrice.toFixed(2)}`);
  }
}

// Deep dive: What was above spot when we kept going BULLISH?
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  DEEP DIVE: 6870-6880 WALL ZONE');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Check frames around 11:00-13:00 when many trades were in 6870-6880
const checkTimes = ['16:00', '16:30', '17:00', '17:30', '18:00'];
for (const ct of checkTimes) {
  const f = frames.find(f => f.timestamp >= `2026-03-04T${ct}:00`);
  if (!f) continue;
  const utcH = new Date(f.timestamp).getUTCHours();
  const etH = utcH - 5;
  const etM = new Date(f.timestamp).getUTCMinutes();

  console.log(`  At ${String(etH).padStart(2,'0')}:${String(etM).padStart(2,'0')} ET (spot $${f.spotPrice.toFixed(2)}):`);

  // Show 6855-6895
  const startIdx = f.strikes.findIndex(s => s >= 6855);
  const endIdx = f.strikes.findIndex(s => s >= 6895);

  for (let i = startIdx; i <= endIdx && i < f.strikes.length; i++) {
    const strike = f.strikes[i];
    const total = totalGamma(f.gammaValues, i);
    const zdte = f.gammaValues[i][0];
    const barLen = Math.min(30, Math.round(Math.abs(total) / 500_000));
    const sign = total >= 0 ? '+' : '-';
    const marker = Math.abs(strike - f.spotPrice) < 3 ? ' ◄ SPOT' : '';
    console.log(`    ${strike}  ${sign}${Math.abs(Math.round(total/1000))}k  ${'|'.repeat(barLen)}${marker}`);
  }
  console.log();
}
