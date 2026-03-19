/**
 * GEX Quantitative Analysis — Pass 2
 * Refined signals based on Pass 1 findings:
 * 1. Negative opening GEX is bullish (68% up, +8.9 avg) — investigate deeper
 * 2. Zero-cross levels as S/R (95% bounce) — validate
 * 3. Wall break follow-through — quantify per regime
 * 4. GEX-at-spot vs net GEX — which predicts better?
 * 5. Intraday GEX dynamics — how fast does GEX shift?
 */
import { readFileSync, readdirSync } from 'fs';

function parseGexFrame(tickerData) {
  const spot = tickerData.spotPrice;
  const strikes = tickerData.strikes;
  const totalByStrike = tickerData.gammaValues.map(gvArr => gvArr.reduce((s, v) => s + v, 0));
  const zdteByStrike = tickerData.gammaValues.map(gvArr => gvArr[0]);

  const netGex = totalByStrike.reduce((s, v) => s + v, 0);
  const netZdte = zdteByStrike.reduce((s, v) => s + v, 0);

  // GEX at spot — sum gamma within ±10 strikes of spot
  const spotIdx = strikes.findIndex(s => s >= spot);
  let gexAtSpot = 0;
  for (let i = Math.max(0, spotIdx - 2); i <= Math.min(strikes.length - 1, spotIdx + 2); i++) {
    gexAtSpot += totalByStrike[i];
  }

  // Positive gamma above spot (resistance), negative gamma below spot (support)
  let gammaAbove = 0, gammaBelow = 0;
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i] > spot) gammaAbove += totalByStrike[i];
    else gammaBelow += totalByStrike[i];
  }

  // Find largest wall
  const walls = totalByStrike
    .map((v, i) => ({ strike: strikes[i], gamma: v, dist: strikes[i] - spot }))
    .filter(w => Math.abs(w.gamma) > 3e6)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma));

  const largestCallWall = walls.filter(w => w.gamma > 0 && w.strike > spot)[0];
  const largestPutWall = walls.filter(w => w.gamma < 0 && w.strike < spot)[0];

  return {
    spot, netGex, netZdte, gexAtSpot, gammaAbove, gammaBelow,
    walls, largestCallWall, largestPutWall, strikes, totalByStrike
  };
}

function loadDay(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const frames = data.frames.map(f => {
    const result = { timestamp: f.timestamp };
    for (const ticker of ['SPXW', 'SPY', 'QQQ']) {
      if (f.tickers?.[ticker]) result[ticker] = parseGexFrame(f.tickers[ticker]);
    }
    return result;
  });
  return { date: data.metadata.date, frames };
}

const files = readdirSync('data')
  .filter(f => f.match(/^gex-replay-20\d{2}-\d{2}-\d{2}\.json$/))
  .sort();

const allDays = [];
for (const file of files) {
  try {
    allDays.push(loadDay(`data/${file}`));
  } catch (e) {
    console.error(`Error: ${file}: ${e.message}`);
  }
}
console.log(`Loaded ${allDays.length} days\n`);

// ═══════════════════════════════════════════════
// ANALYSIS 1: Opening GEX vs Daily Direction — Refined
// ═══════════════════════════════════════════════

console.log('═'.repeat(70));
console.log('ANALYSIS 1: OPENING GEX → DAILY DIRECTION (refined)');
console.log('═'.repeat(70));

const dayStats = allDays.map(d => {
  const frames = d.frames.filter(f => f.SPXW);
  if (frames.length < 50) return null;
  const open = frames[0].SPXW;
  const close = frames[frames.length - 1].SPXW;

  // Find 10AM frame (~30 frames in)
  const tenAmIdx = Math.min(30, frames.length - 1);
  const tenAm = frames[tenAmIdx].SPXW;

  // Find high/low
  let high = -Infinity, low = Infinity, highFrame = null, lowFrame = null;
  for (const f of frames) {
    if (f.SPXW.spot > high) { high = f.SPXW.spot; highFrame = f; }
    if (f.SPXW.spot < low) { low = f.SPXW.spot; lowFrame = f; }
  }

  return {
    date: d.date,
    openSpot: open.spot, closeSpot: close.spot,
    high, low, range: high - low,
    openToClose: close.spot - open.spot,
    changePct: (close.spot - open.spot) / open.spot * 100,
    openNetGex: open.netGex,
    openZdteGex: open.netZdte,
    openGexAtSpot: open.gexAtSpot,
    openGammaAbove: open.gammaAbove,
    openGammaBelow: open.gammaBelow,
    tenAmNetGex: tenAm.netGex,
    tenAmGexAtSpot: tenAm.gexAtSpot,
    openLargestCallWall: open.largestCallWall,
    openLargestPutWall: open.largestPutWall,
    frames
  };
}).filter(Boolean);

// Sort days by opening GEX quintiles
dayStats.sort((a, b) => a.openNetGex - b.openNetGex);
const quintileSize = Math.ceil(dayStats.length / 5);
console.log('\nOpening NET GEX quintiles:');
for (let q = 0; q < 5; q++) {
  const slice = dayStats.slice(q * quintileSize, (q + 1) * quintileSize);
  const avgGex = slice.reduce((s, d) => s + d.openNetGex / 1e6, 0) / slice.length;
  const avgMove = slice.reduce((s, d) => s + d.openToClose, 0) / slice.length;
  const avgRange = slice.reduce((s, d) => s + d.range, 0) / slice.length;
  const upDays = slice.filter(d => d.openToClose > 0).length;
  console.log(`  Q${q + 1} (avg GEX ${avgGex.toFixed(0)}M): ${slice.length} days | up ${upDays}/${slice.length} (${(upDays / slice.length * 100).toFixed(0)}%) | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} | range ${avgRange.toFixed(1)}`);
}

// 0DTE GEX vs total GEX comparison
console.log('\n0DTE GEX quintiles:');
dayStats.sort((a, b) => a.openZdteGex - b.openZdteGex);
for (let q = 0; q < 5; q++) {
  const slice = dayStats.slice(q * quintileSize, (q + 1) * quintileSize);
  const avgGex = slice.reduce((s, d) => s + d.openZdteGex / 1e6, 0) / slice.length;
  const avgMove = slice.reduce((s, d) => s + d.openToClose, 0) / slice.length;
  const upDays = slice.filter(d => d.openToClose > 0).length;
  console.log(`  Q${q + 1} (avg 0DTE ${avgGex.toFixed(0)}M): ${slice.length} days | up ${upDays}/${slice.length} (${(upDays / slice.length * 100).toFixed(0)}%) | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)}`);
}

// GEX-at-spot quintiles
console.log('\nGEX-at-spot quintiles:');
dayStats.sort((a, b) => a.openGexAtSpot - b.openGexAtSpot);
for (let q = 0; q < 5; q++) {
  const slice = dayStats.slice(q * quintileSize, (q + 1) * quintileSize);
  const avgGex = slice.reduce((s, d) => s + d.openGexAtSpot / 1e6, 0) / slice.length;
  const avgMove = slice.reduce((s, d) => s + d.openToClose, 0) / slice.length;
  const upDays = slice.filter(d => d.openToClose > 0).length;
  console.log(`  Q${q + 1} (avg GAS ${avgGex.toFixed(0)}M): ${slice.length} days | up ${upDays}/${slice.length} (${(upDays / slice.length * 100).toFixed(0)}%) | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)}`);
}

// Gamma skew (above vs below) quintiles
console.log('\nGamma skew (above-below spot) quintiles:');
const skewStats = dayStats.map(d => ({
  ...d,
  gammaSkew: d.openGammaAbove - d.openGammaBelow
}));
skewStats.sort((a, b) => a.gammaSkew - b.gammaSkew);
for (let q = 0; q < 5; q++) {
  const slice = skewStats.slice(q * quintileSize, (q + 1) * quintileSize);
  const avgSkew = slice.reduce((s, d) => s + d.gammaSkew / 1e6, 0) / slice.length;
  const avgMove = slice.reduce((s, d) => s + d.openToClose, 0) / slice.length;
  const upDays = slice.filter(d => d.openToClose > 0).length;
  console.log(`  Q${q + 1} (avg skew ${avgSkew.toFixed(0)}M): ${slice.length} days | up ${upDays}/${slice.length} (${(upDays / slice.length * 100).toFixed(0)}%) | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)}`);
}

// ═══════════════════════════════════════════════
// ANALYSIS 2: Zero-cross as S/R — Refined validation
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('ANALYSIS 2: ZERO-CROSS LEVELS AS SUPPORT/RESISTANCE');
console.log('═'.repeat(70));

let zcSRTests = [];
for (const d of allDays) {
  const frames = d.frames.filter(f => f.SPXW);
  if (frames.length < 50) continue;

  // Find zero-cross events
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].SPXW.netGex;
    const cur = frames[i].SPXW.netGex;
    if ((prev > 0 && cur <= 0) || (prev <= 0 && cur > 0)) {
      const crossSpot = frames[i].SPXW.spot;
      const crossIdx = i;
      const direction = prev > 0 ? 'POS_TO_NEG' : 'NEG_TO_POS';

      // Track price relative to this level for next 60 frames
      let touchCount = 0, bounceCount = 0, breakCount = 0;
      for (let j = crossIdx + 10; j < Math.min(crossIdx + 120, frames.length); j++) {
        const dist = frames[j].SPXW.spot - crossSpot;
        if (Math.abs(dist) < 2) {
          touchCount++;
          // Check 10 frames later
          if (j + 10 < frames.length) {
            const futureDist = frames[j + 10].SPXW.spot - crossSpot;
            if (Math.abs(futureDist) > 3) bounceCount++;
            // Check if it broke through
            if ((dist > -1 && futureDist < -3) || (dist < 1 && futureDist > 3)) breakCount++;
          }
        }
      }

      if (touchCount > 0) {
        zcSRTests.push({
          date: d.date, direction, crossSpot,
          touchCount, bounceCount, breakCount,
          bounceRate: bounceCount / touchCount,
          afterMove30: crossIdx + 30 < frames.length ? frames[crossIdx + 30].SPXW.spot - crossSpot : null,
          afterMove60: crossIdx + 60 < frames.length ? frames[crossIdx + 60].SPXW.spot - crossSpot : null,
        });
      }
    }
  }
}

console.log(`\nZero-cross S/R events analyzed: ${zcSRTests.length}`);
if (zcSRTests.length > 0) {
  const avgBounceRate = zcSRTests.reduce((s, t) => s + t.bounceRate, 0) / zcSRTests.length;
  console.log(`Avg bounce rate (move >3pts after retest): ${(avgBounceRate * 100).toFixed(0)}%`);

  // Separate by direction
  const ptn = zcSRTests.filter(t => t.direction === 'POS_TO_NEG');
  const ntp = zcSRTests.filter(t => t.direction === 'NEG_TO_POS');
  console.log(`\nPOS_TO_NEG crosses (${ptn.length} events):`);
  if (ptn.length > 0) {
    const withAfter = ptn.filter(t => t.afterMove30 !== null);
    const avgAfter30 = withAfter.reduce((s, t) => s + t.afterMove30, 0) / withAfter.length;
    const avgAfter60 = ptn.filter(t => t.afterMove60 !== null).reduce((s, t) => s + t.afterMove60, 0) / ptn.filter(t => t.afterMove60 !== null).length;
    console.log(`  Avg move +30 frames: ${avgAfter30 >= 0 ? '+' : ''}${avgAfter30.toFixed(2)} pts`);
    console.log(`  Avg move +60 frames: ${avgAfter60 >= 0 ? '+' : ''}${avgAfter60.toFixed(2)} pts`);
    console.log(`  Avg bounce rate: ${(ptn.reduce((s, t) => s + t.bounceRate, 0) / ptn.length * 100).toFixed(0)}%`);
  }
  console.log(`\nNEG_TO_POS crosses (${ntp.length} events):`);
  if (ntp.length > 0) {
    const withAfter = ntp.filter(t => t.afterMove30 !== null);
    const avgAfter30 = withAfter.reduce((s, t) => s + t.afterMove30, 0) / withAfter.length;
    const avgAfter60 = ntp.filter(t => t.afterMove60 !== null).reduce((s, t) => s + t.afterMove60, 0) / ntp.filter(t => t.afterMove60 !== null).length;
    console.log(`  Avg move +30 frames: ${avgAfter30 >= 0 ? '+' : ''}${avgAfter30.toFixed(2)} pts`);
    console.log(`  Avg move +60 frames: ${avgAfter60 >= 0 ? '+' : ''}${avgAfter60.toFixed(2)} pts`);
    console.log(`  Avg bounce rate: ${(ntp.reduce((s, t) => s + t.bounceRate, 0) / ntp.length * 100).toFixed(0)}%`);
  }
}

// ═══════════════════════════════════════════════
// ANALYSIS 3: Wall distance at entry → outcome predictor
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('ANALYSIS 3: WALL PROXIMITY & PRICE BEHAVIOR');
console.log('═'.repeat(70));

// How does distance from largest call wall predict next 30-frame move?
let wallDistTests = [];
for (const d of allDays) {
  const frames = d.frames.filter(f => f.SPXW);
  for (let i = 0; i < frames.length - 30; i += 5) { // sample every 5th frame
    const f = frames[i];
    const callWall = f.SPXW.largestCallWall;
    const putWall = f.SPXW.largestPutWall;
    const spot = f.SPXW.spot;
    const futureSpot = frames[i + 30].SPXW.spot;
    const move = futureSpot - spot;

    if (callWall) {
      wallDistTests.push({
        type: 'CALL_WALL',
        dist: callWall.strike - spot,
        wallSize: callWall.gamma / 1e6,
        move,
        netGex: f.SPXW.netGex / 1e6
      });
    }
    if (putWall) {
      wallDistTests.push({
        type: 'PUT_WALL',
        dist: spot - putWall.strike,
        wallSize: Math.abs(putWall.gamma / 1e6),
        move,
        netGex: f.SPXW.netGex / 1e6
      });
    }
  }
}

// Bucket by distance to call wall
console.log('\nDistance to nearest CALL wall (positive gamma above spot):');
const callWDT = wallDistTests.filter(t => t.type === 'CALL_WALL');
const distBuckets = [
  { label: '0-5 pts', min: 0, max: 5 },
  { label: '5-10 pts', min: 5, max: 10 },
  { label: '10-20 pts', min: 10, max: 20 },
  { label: '20-40 pts', min: 20, max: 40 },
  { label: '40+ pts', min: 40, max: 999 },
];
for (const b of distBuckets) {
  const bTests = callWDT.filter(t => t.dist >= b.min && t.dist < b.max);
  if (bTests.length === 0) continue;
  const avgMove = bTests.reduce((s, t) => s + t.move, 0) / bTests.length;
  const upPct = bTests.filter(t => t.move > 0).length / bTests.length * 100;
  console.log(`  ${b.label.padEnd(10)}: ${bTests.length} obs | avg 30f move: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)} | up: ${upPct.toFixed(0)}%`);
}

console.log('\nDistance to nearest PUT wall (negative gamma below spot):');
const putWDT = wallDistTests.filter(t => t.type === 'PUT_WALL');
for (const b of distBuckets) {
  const bTests = putWDT.filter(t => t.dist >= b.min && t.dist < b.max);
  if (bTests.length === 0) continue;
  const avgMove = bTests.reduce((s, t) => s + t.move, 0) / bTests.length;
  const upPct = bTests.filter(t => t.move > 0).length / bTests.length * 100;
  console.log(`  ${b.label.padEnd(10)}: ${bTests.length} obs | avg 30f move: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)} | up: ${upPct.toFixed(0)}%`);
}

// ═══════════════════════════════════════════════
// ANALYSIS 4: Intraday GEX dynamics → regime shift speed
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('ANALYSIS 4: INTRADAY GEX DYNAMICS');
console.log('═'.repeat(70));

// How quickly does GEX shift intraday? Measure GEX volatility
const dayGexStats = allDays.map(d => {
  const frames = d.frames.filter(f => f.SPXW);
  if (frames.length < 50) return null;
  const gexValues = frames.map(f => f.SPXW.netGex / 1e6);
  const mean = gexValues.reduce((s, v) => s + v, 0) / gexValues.length;
  const variance = gexValues.reduce((s, v) => s + (v - mean) ** 2, 0) / gexValues.length;
  const stddev = Math.sqrt(variance);
  const min = Math.min(...gexValues);
  const max = Math.max(...gexValues);
  const gexRange = max - min;

  // GEX flip count (sign changes)
  let flipCount = 0;
  for (let i = 1; i < gexValues.length; i++) {
    if ((gexValues[i - 1] > 0 && gexValues[i] <= 0) || (gexValues[i - 1] <= 0 && gexValues[i] > 0)) {
      flipCount++;
    }
  }

  const open = frames[0].SPXW;
  const close = frames[frames.length - 1].SPXW;
  return {
    date: d.date,
    gexMean: mean, gexStddev: stddev, gexRange, gexMin: min, gexMax: max,
    flipCount,
    openToClose: close.spot - open.spot,
    priceRange: Math.max(...frames.map(f => f.SPXW.spot)) - Math.min(...frames.map(f => f.SPXW.spot)),
    changePct: (close.spot - open.spot) / open.spot * 100,
  };
}).filter(Boolean);

// GEX volatility vs price range correlation
console.log('\nGEX intraday volatility (stddev) quintiles:');
dayGexStats.sort((a, b) => a.gexStddev - b.gexStddev);
const qs = Math.ceil(dayGexStats.length / 5);
for (let q = 0; q < 5; q++) {
  const slice = dayGexStats.slice(q * qs, (q + 1) * qs);
  const avgStd = slice.reduce((s, d) => s + d.gexStddev, 0) / slice.length;
  const avgRange = slice.reduce((s, d) => s + d.priceRange, 0) / slice.length;
  const avgMove = slice.reduce((s, d) => s + d.openToClose, 0) / slice.length;
  const avgFlips = slice.reduce((s, d) => s + d.flipCount, 0) / slice.length;
  console.log(`  Q${q + 1} (σ=${avgStd.toFixed(0)}M): ${slice.length} days | price range ${avgRange.toFixed(1)} | O→C ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} | flips ${avgFlips.toFixed(1)}`);
}

// GEX flip count vs outcome
console.log('\nGEX flip count (zero-cross events) quintiles:');
dayGexStats.sort((a, b) => a.flipCount - b.flipCount);
for (let q = 0; q < 5; q++) {
  const slice = dayGexStats.slice(q * qs, (q + 1) * qs);
  const avgFlips = slice.reduce((s, d) => s + d.flipCount, 0) / slice.length;
  const avgRange = slice.reduce((s, d) => s + d.priceRange, 0) / slice.length;
  const avgAbsMove = slice.reduce((s, d) => s + Math.abs(d.openToClose), 0) / slice.length;
  console.log(`  Q${q + 1} (${avgFlips.toFixed(0)} flips): ${slice.length} days | range ${avgRange.toFixed(1)} | |move| ${avgAbsMove.toFixed(1)}`);
}

// ═══════════════════════════════════════════════
// ANALYSIS 5: 10AM GEX reading as refined predictor
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('ANALYSIS 5: 10AM GEX READING AS DIRECTION PREDICTOR');
console.log('═'.repeat(70));

// At 10AM, we have 30 min of data. Test: does 10AM GEX + price direction predict rest of day?
const tenAmPredictions = dayStats.map(d => {
  const frames = d.frames;
  if (frames.length < 100) return null;
  const tenAmFrame = frames[30]; // ~10AM
  if (!tenAmFrame?.SPXW) return null;

  const openSpot = frames[0].SPXW.spot;
  const tenAmSpot = tenAmFrame.SPXW.spot;
  const closeSpot = frames[frames.length - 1].SPXW.spot;
  const earlyDir = tenAmSpot > openSpot ? 'UP' : 'DOWN';
  const tenAmGex = tenAmFrame.SPXW.netGex / 1e6;
  const restOfDayMove = closeSpot - tenAmSpot;

  return {
    date: d.date, earlyDir, tenAmGex, tenAmSpot,
    restOfDayMove,
    continued: (earlyDir === 'UP' && restOfDayMove > 0) || (earlyDir === 'DOWN' && restOfDayMove < 0),
    reversed: (earlyDir === 'UP' && restOfDayMove < -5) || (earlyDir === 'DOWN' && restOfDayMove > 5),
  };
}).filter(Boolean);

console.log(`\n10AM prediction analysis (${tenAmPredictions.length} days):`);
const continued = tenAmPredictions.filter(p => p.continued).length;
const reversed = tenAmPredictions.filter(p => p.reversed).length;
console.log(`  Early direction continued: ${continued}/${tenAmPredictions.length} (${(continued / tenAmPredictions.length * 100).toFixed(0)}%)`);
console.log(`  Hard reversal (>5pts): ${reversed}/${tenAmPredictions.length} (${(reversed / tenAmPredictions.length * 100).toFixed(0)}%)`);

// Split by GEX regime at 10AM
console.log('\n  When 10AM GEX is NEGATIVE + early move UP:');
const negUp = tenAmPredictions.filter(p => p.tenAmGex < 0 && p.earlyDir === 'UP');
if (negUp.length > 0) {
  const cont = negUp.filter(p => p.continued).length;
  const avgFollow = negUp.reduce((s, p) => s + p.restOfDayMove, 0) / negUp.length;
  console.log(`    ${negUp.length} obs | continued: ${cont}/${negUp.length} (${(cont / negUp.length * 100).toFixed(0)}%) | avg rest-of-day: ${avgFollow >= 0 ? '+' : ''}${avgFollow.toFixed(1)}`);
}

console.log('  When 10AM GEX is NEGATIVE + early move DOWN:');
const negDown = tenAmPredictions.filter(p => p.tenAmGex < 0 && p.earlyDir === 'DOWN');
if (negDown.length > 0) {
  const cont = negDown.filter(p => p.continued).length;
  const avgFollow = negDown.reduce((s, p) => s + p.restOfDayMove, 0) / negDown.length;
  console.log(`    ${negDown.length} obs | continued: ${cont}/${negDown.length} (${(cont / negDown.length * 100).toFixed(0)}%) | avg rest-of-day: ${avgFollow >= 0 ? '+' : ''}${avgFollow.toFixed(1)}`);
}

console.log('  When 10AM GEX is POSITIVE + early move UP:');
const posUp = tenAmPredictions.filter(p => p.tenAmGex > 0 && p.earlyDir === 'UP');
if (posUp.length > 0) {
  const cont = posUp.filter(p => p.continued).length;
  const avgFollow = posUp.reduce((s, p) => s + p.restOfDayMove, 0) / posUp.length;
  console.log(`    ${posUp.length} obs | continued: ${cont}/${posUp.length} (${(cont / posUp.length * 100).toFixed(0)}%) | avg rest-of-day: ${avgFollow >= 0 ? '+' : ''}${avgFollow.toFixed(1)}`);
}

console.log('  When 10AM GEX is POSITIVE + early move DOWN:');
const posDown = tenAmPredictions.filter(p => p.tenAmGex > 0 && p.earlyDir === 'DOWN');
if (posDown.length > 0) {
  const cont = posDown.filter(p => p.continued).length;
  const avgFollow = posDown.reduce((s, p) => s + p.restOfDayMove, 0) / posDown.length;
  console.log(`    ${posDown.length} obs | continued: ${cont}/${posDown.length} (${(cont / posDown.length * 100).toFixed(0)}%) | avg rest-of-day: ${avgFollow >= 0 ? '+' : ''}${avgFollow.toFixed(1)}`);
}

// ═══════════════════════════════════════════════
// ANALYSIS 6: GEX "gravity" — does price converge to high-GEX nodes?
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('ANALYSIS 6: GEX NODE GRAVITY / MAGNETIC PULL');
console.log('═'.repeat(70));

let magnetTests = [];
for (const d of allDays) {
  const frames = d.frames.filter(f => f.SPXW);
  // Sample every 20th frame
  for (let i = 0; i < frames.length - 60; i += 20) {
    const f = frames[i];
    const spot = f.SPXW.spot;
    const walls = f.SPXW.walls.filter(w => Math.abs(w.dist) > 5 && Math.abs(w.dist) < 40 && Math.abs(w.gamma) > 5e6);

    for (const wall of walls.slice(0, 3)) {
      const initDist = wall.strike - spot;
      // Check if price moved toward this wall over next 60 frames
      const futureSpot = frames[i + 60].SPXW.spot;
      const futureDist = wall.strike - futureSpot;
      const closedDistance = Math.abs(initDist) - Math.abs(futureDist);

      magnetTests.push({
        wallSize: Math.abs(wall.gamma / 1e6),
        wallType: wall.gamma > 0 ? 'POSITIVE' : 'NEGATIVE',
        initDist: Math.abs(initDist),
        closedDistance,
        attracted: closedDistance > 2, // price moved >2pts closer
      });
    }
  }
}

console.log(`\nMagnet pull tests: ${magnetTests.length}`);
if (magnetTests.length > 0) {
  // By wall size
  console.log('\nAttraction rate by wall size:');
  const sizeBuckets = [
    { label: '$5-10M', min: 5, max: 10 },
    { label: '$10-20M', min: 10, max: 20 },
    { label: '$20-50M', min: 20, max: 50 },
    { label: '$50M+', min: 50, max: 999 },
  ];
  for (const b of sizeBuckets) {
    const bTests = magnetTests.filter(t => t.wallSize >= b.min && t.wallSize < b.max);
    if (bTests.length === 0) continue;
    const attracted = bTests.filter(t => t.attracted).length;
    const avgClosed = bTests.reduce((s, t) => s + t.closedDistance, 0) / bTests.length;
    console.log(`  ${b.label.padEnd(10)}: ${bTests.length} obs | attracted: ${attracted}/${bTests.length} (${(attracted / bTests.length * 100).toFixed(0)}%) | avg distance closed: ${avgClosed >= 0 ? '+' : ''}${avgClosed.toFixed(1)} pts`);
  }

  // By wall type
  console.log('\nAttraction rate by wall type:');
  for (const type of ['POSITIVE', 'NEGATIVE']) {
    const tTests = magnetTests.filter(t => t.wallType === type);
    if (tTests.length === 0) continue;
    const attracted = tTests.filter(t => t.attracted).length;
    const avgClosed = tTests.reduce((s, t) => s + t.closedDistance, 0) / tTests.length;
    console.log(`  ${type.padEnd(10)}: ${tTests.length} obs | attracted: ${attracted}/${tTests.length} (${(attracted / tTests.length * 100).toFixed(0)}%) | avg closed: ${avgClosed >= 0 ? '+' : ''}${avgClosed.toFixed(1)} pts`);
  }
}

// ═══════════════════════════════════════════════
// FINAL: REFINED TRADING SIGNALS
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('REFINED TRADING SIGNALS (data-driven)');
console.log('═'.repeat(70));

// Signal A: Strong negative open GEX + 10AM confirms direction
console.log('\n─── SIGNAL A: STRONG NEGATIVE GEX + 10AM CONFIRMATION ───');
const sigA = tenAmPredictions.filter(p => {
  const d = dayStats.find(ds => ds.date === p.date);
  return d && d.openNetGex / 1e6 < -20;
});
if (sigA.length > 0) {
  const upCont = sigA.filter(p => p.earlyDir === 'UP');
  const upContWin = upCont.filter(p => p.continued).length;
  const downCont = sigA.filter(p => p.earlyDir === 'DOWN');
  const downContWin = downCont.filter(p => p.continued).length;
  console.log(`  GEX < -20M at open (${sigA.length} days):`);
  console.log(`    Early UP → continued: ${upContWin}/${upCont.length} (${upCont.length > 0 ? (upContWin / upCont.length * 100).toFixed(0) : 0}%) | avg follow: ${upCont.length > 0 ? (upCont.reduce((s, p) => s + p.restOfDayMove, 0) / upCont.length).toFixed(1) : 'N/A'}`);
  console.log(`    Early DOWN → continued: ${downContWin}/${downCont.length} (${downCont.length > 0 ? (downContWin / downCont.length * 100).toFixed(0) : 0}%) | avg follow: ${downCont.length > 0 ? (downCont.reduce((s, p) => s + p.restOfDayMove, 0) / downCont.length).toFixed(1) : 'N/A'}`);
}

// Signal B: Positive GEX + price selling → don't fight it
console.log('\n─── SIGNAL B: POSITIVE GEX + EARLY SELLING ───');
const sigB = tenAmPredictions.filter(p => {
  const d = dayStats.find(ds => ds.date === p.date);
  return d && d.openNetGex / 1e6 > 0 && p.earlyDir === 'DOWN';
});
if (sigB.length > 0) {
  const contSell = sigB.filter(p => p.continued).length;
  const avgMove = sigB.reduce((s, p) => s + p.restOfDayMove, 0) / sigB.length;
  console.log(`  GEX > 0 + early selling (${sigB.length} days):`);
  console.log(`    Continued selling: ${contSell}/${sigB.length} (${(contSell / sigB.length * 100).toFixed(0)}%)`);
  console.log(`    Avg rest-of-day: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} pts`);
}

// Signal C: Large wall magnet (>$20M, 10-30pts away)
console.log('\n─── SIGNAL C: LARGE WALL MAGNET (>$20M, 10-30pts) ───');
const bigMagnets = magnetTests.filter(t => t.wallSize >= 20 && t.initDist >= 10 && t.initDist <= 30);
if (bigMagnets.length > 0) {
  const attracted = bigMagnets.filter(t => t.attracted).length;
  const avgClosed = bigMagnets.reduce((s, t) => s + t.closedDistance, 0) / bigMagnets.length;
  console.log(`  Observations: ${bigMagnets.length}`);
  console.log(`  Price attracted (>2pts closer): ${attracted}/${bigMagnets.length} (${(attracted / bigMagnets.length * 100).toFixed(0)}%)`);
  console.log(`  Avg distance closed in 60 frames: ${avgClosed >= 0 ? '+' : ''}${avgClosed.toFixed(1)} pts`);
  console.log(`  Confidence: ${bigMagnets.length >= 20 ? 'HIGH' : bigMagnets.length >= 10 ? 'MEDIUM' : 'LOW'}`);
}
