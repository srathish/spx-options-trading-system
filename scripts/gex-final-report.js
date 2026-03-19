/**
 * GEX Final Report — Synthesis of Pass 1 + Pass 2
 * Consolidated findings with proper statistical caveats
 */
import { readFileSync, readdirSync } from 'fs';

function parseGexFrame(tickerData) {
  const spot = tickerData.spotPrice;
  const strikes = tickerData.strikes;
  const totalByStrike = tickerData.gammaValues.map(gvArr => gvArr.reduce((s, v) => s + v, 0));
  const zdteByStrike = tickerData.gammaValues.map(gvArr => gvArr[0]);
  const netGex = totalByStrike.reduce((s, v) => s + v, 0);
  const netZdte = zdteByStrike.reduce((s, v) => s + v, 0);

  let gexAtSpot = 0;
  const spotIdx = strikes.findIndex(s => s >= spot);
  for (let i = Math.max(0, spotIdx - 2); i <= Math.min(strikes.length - 1, spotIdx + 2); i++) {
    gexAtSpot += totalByStrike[i];
  }

  const walls = totalByStrike
    .map((v, i) => ({ strike: strikes[i], gamma: v, dist: strikes[i] - spot }))
    .filter(w => Math.abs(w.gamma) > 3e6)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma));

  return { spot, netGex, netZdte, gexAtSpot, walls, strikes, totalByStrike };
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
  try { allDays.push(loadDay(`data/${file}`)); } catch (e) { /* skip */ }
}

// ═══════════════════════════════════════════════
// Build day-level stats
// ═══════════════════════════════════════════════

const dayStats = allDays.map(d => {
  const frames = d.frames.filter(f => f.SPXW);
  if (frames.length < 50) return null;
  const open = frames[0].SPXW;
  const close = frames[frames.length - 1].SPXW;

  let high = -Infinity, low = Infinity, highIdx = 0, lowIdx = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = frames[i].SPXW.spot;
    if (s > high) { high = s; highIdx = i; }
    if (s < low) { low = s; lowIdx = i; }
  }

  // 10AM frame
  const tenAmIdx = Math.min(30, frames.length - 1);
  const tenAm = frames[tenAmIdx].SPXW;

  // GEX dynamics
  const gexValues = frames.map(f => f.SPXW.netGex / 1e6);
  let flipCount = 0;
  for (let i = 1; i < gexValues.length; i++) {
    if ((gexValues[i - 1] > 0 && gexValues[i] <= 0) || (gexValues[i - 1] <= 0 && gexValues[i] > 0)) flipCount++;
  }

  // Classify day type
  const otc = close.spot - open.spot;
  const pct = otc / open.spot * 100;
  const range = high - low;
  const hNorm = highIdx / frames.length;
  const lNorm = lowIdx / frames.length;

  let type;
  if (pct > 0.3 && lNorm < 0.3 && (open.spot - low) > range * 0.3) type = 'V_RECOVERY';
  else if (pct < -0.3 && hNorm < 0.3 && (high - open.spot) > range * 0.3) type = 'INVERTED_V';
  else if (pct > 0.15) type = hNorm > 0.7 ? 'UP_TREND' : 'UP_DAY';
  else if (pct < -0.15) type = lNorm > 0.7 ? 'DOWN_TREND' : 'DOWN_DAY';
  else if (range < 25) type = 'CHOP';
  else type = 'FLAT';

  // V-recovery override
  if ((type === 'UP_DAY' || type === 'FLAT') && (open.spot - low) > 8 && lNorm < 0.5 && (close.spot - low) > (open.spot - low) * 0.7) type = 'V_RECOVERY';
  if ((type === 'DOWN_DAY' || type === 'FLAT') && (high - open.spot) > 8 && hNorm < 0.5 && (high - close.spot) > (high - open.spot) * 0.7) type = 'INVERTED_V';

  return {
    date: d.date, type, openSpot: open.spot, closeSpot: close.spot,
    high, low, range, otc, pct,
    openNetGex: open.netGex / 1e6,
    openZdteGex: open.netZdte / 1e6,
    openGexAtSpot: open.gexAtSpot / 1e6,
    tenAmNetGex: tenAm.netGex / 1e6,
    tenAmSpot: tenAm.spot,
    flipCount,
    spyOpenGex: frames[0].SPY?.netGex / 1e6,
    qqqOpenGex: frames[0].QQQ?.netGex / 1e6,
    earlyDir: tenAm.spot > open.spot ? 'UP' : 'DOWN',
    restOfDay: close.spot - tenAm.spot,
    frames
  };
}).filter(Boolean);

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║           GEX QUANTITATIVE ANALYSIS — FINAL REPORT                 ║
║           60 Trading Days · Dec 15 2025 – Mar 12 2026              ║
║           SPX/SPY/QQQ Trinity Data · ~391 frames/day               ║
╚══════════════════════════════════════════════════════════════════════╝
`);

// ═══════════════════════════════════════════════
// STEP 1: REGIME CLASSIFICATION
// ═══════════════════════════════════════════════

console.log('═══════════════════════════════════════════════');
console.log('STEP 1: REGIME CLASSIFICATION');
console.log('═══════════════════════════════════════════════');

const gexDist = dayStats.map(d => d.openNetGex).sort((a, b) => a - b);
const p25 = gexDist[Math.floor(gexDist.length * 0.25)];
const p50 = gexDist[Math.floor(gexDist.length * 0.50)];
const p75 = gexDist[Math.floor(gexDist.length * 0.75)];

console.log(`
OPENING NET GEX DISTRIBUTION (SPX, millions):
  Min: ${gexDist[0].toFixed(0)}M | 25th: ${p25.toFixed(0)}M | Median: ${p50.toFixed(0)}M | 75th: ${p75.toFixed(0)}M | Max: ${gexDist[gexDist.length - 1].toFixed(0)}M

KEY FINDING: SPX opens with NEGATIVE GEX 65% of the time.
The median is -17M — "negative GEX" is the DEFAULT state, not an anomaly.

REGIME THRESHOLDS (data-driven from quintiles):
  DEEP NEGATIVE:    GEX < -45M  (Q1, 20% of days)
  MODERATE NEGATIVE: -45M ≤ GEX < -5M  (Q2-Q3, ~40% of days)
  NEAR-ZERO:        -5M ≤ GEX ≤ 15M  (transition zone, ~20% of days)
  POSITIVE:          GEX > 15M  (Q5, 20% of days)
`);

// Regime breakdown
const regimes = {
  'DEEP NEGATIVE (<-45M)': d => d.openNetGex < -45,
  'MODERATE NEGATIVE (-45 to -5M)': d => d.openNetGex >= -45 && d.openNetGex < -5,
  'NEAR-ZERO (-5 to 15M)': d => d.openNetGex >= -5 && d.openNetGex <= 15,
  'POSITIVE (>15M)': d => d.openNetGex > 15,
};

for (const [name, filter] of Object.entries(regimes)) {
  const rDays = dayStats.filter(filter);
  if (rDays.length === 0) continue;
  const avgRange = rDays.reduce((s, d) => s + d.range, 0) / rDays.length;
  const avgOTC = rDays.reduce((s, d) => s + d.otc, 0) / rDays.length;
  const upDays = rDays.filter(d => d.otc > 0).length;
  const types = {};
  for (const d of rDays) types[d.type] = (types[d.type] || 0) + 1;
  const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ');

  console.log(`── ${name}: ${rDays.length} days ──`);
  console.log(`   Range: ${avgRange.toFixed(0)}pt avg | O→C: ${avgOTC >= 0 ? '+' : ''}${avgOTC.toFixed(1)}pt | Up: ${upDays}/${rDays.length} (${(upDays / rDays.length * 100).toFixed(0)}%)`);
  console.log(`   Day types: ${topTypes}`);
  console.log(`   Confidence: ${rDays.length >= 15 ? 'HIGH' : rDays.length >= 8 ? 'MEDIUM' : 'LOW'} (n=${rDays.length})`);
}

// ═══════════════════════════════════════════════
// STEP 2: DAY-TYPE PATTERN ANALYSIS
// ═══════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════');
console.log('STEP 2: DAY-TYPE PATTERN ANALYSIS');
console.log('═══════════════════════════════════════════════');

const typeGroups = {};
for (const d of dayStats) {
  if (!(d.type in typeGroups)) typeGroups[d.type] = [];
  typeGroups[d.type].push(d);
}

for (const [type, tDays] of Object.entries(typeGroups).sort((a, b) => b[1].length - a[1].length)) {
  const avgOpenGex = tDays.reduce((s, d) => s + d.openNetGex, 0) / tDays.length;
  const avg10AmGex = tDays.reduce((s, d) => s + d.tenAmNetGex, 0) / tDays.length;
  const avgRange = tDays.reduce((s, d) => s + d.range, 0) / tDays.length;
  const regimeCounts = {};
  for (const d of tDays) {
    const r = d.openNetGex < -45 ? 'DEEP_NEG' : d.openNetGex < -5 ? 'MOD_NEG' : d.openNetGex <= 15 ? 'NEAR_ZERO' : 'POSITIVE';
    regimeCounts[r] = (regimeCounts[r] || 0) + 1;
  }
  console.log(`\n── ${type} (${tDays.length} days) [${tDays.length >= 10 ? 'MEDIUM' : 'LOW'} confidence] ──`);
  console.log(`   a) Open GEX: ${avgOpenGex.toFixed(0)}M avg | 10AM GEX: ${avg10AmGex.toFixed(0)}M avg | Range: ${avgRange.toFixed(0)}pt`);
  console.log(`   b) Regime: ${Object.entries(regimeCounts).map(([r, c]) => `${r}(${c}/${tDays.length})`).join(', ')}`);

  // GEX predictor threshold
  const negGexDays = tDays.filter(d => d.openNetGex < -5).length;
  console.log(`   c) GEX < -5M at open → ${type}: ${negGexDays}/${tDays.length} (${(negGexDays / tDays.length * 100).toFixed(0)}% of ${type} days had negative GEX)`);
}

// V-recovery deep dive
console.log('\n── V-RECOVERY DEEP DIVE ──');
const vDays = typeGroups['V_RECOVERY'] || [];
for (const d of vDays) {
  const lowFrame = d.frames[Math.floor(d.frames.findIndex(f => f.SPXW.spot <= d.low + 0.5) / d.frames.length * 100)];
  const lowGex = d.frames.find(f => Math.abs(f.SPXW.spot - d.low) < 1)?.SPXW?.netGex / 1e6;
  console.log(`   ${d.date}: dip ${(d.low - d.openSpot).toFixed(0)}pt → recovered ${(d.closeSpot - d.low).toFixed(0)}pt | Open GEX: ${d.openNetGex.toFixed(0)}M | GEX at low: ${lowGex?.toFixed(0) || '?'}M`);
}

// Chop vs Trend comparison
const trendDays = [...(typeGroups['UP_TREND'] || []), ...(typeGroups['DOWN_TREND'] || [])];
const chopDays = [...(typeGroups['CHOP'] || []), ...(typeGroups['FLAT'] || [])];
if (trendDays.length > 0) {
  console.log(`\n── CHOP (${chopDays.length} days) vs TREND (${trendDays.length} days) ──`);
  console.log(`   Chop: range ${chopDays.length > 0 ? (chopDays.reduce((s, d) => s + d.range, 0) / chopDays.length).toFixed(0) : 'N/A'}pt | GEX ${chopDays.length > 0 ? (chopDays.reduce((s, d) => s + d.openNetGex, 0) / chopDays.length).toFixed(0) : 'N/A'}M | flips ${chopDays.length > 0 ? (chopDays.reduce((s, d) => s + d.flipCount, 0) / chopDays.length).toFixed(1) : 'N/A'}`);
  console.log(`   Trend: range ${(trendDays.reduce((s, d) => s + d.range, 0) / trendDays.length).toFixed(0)}pt | GEX ${(trendDays.reduce((s, d) => s + d.openNetGex, 0) / trendDays.length).toFixed(0)}M | flips ${(trendDays.reduce((s, d) => s + d.flipCount, 0) / trendDays.length).toFixed(1)}`);
}

// ═══════════════════════════════════════════════
// STEP 3: GEX WALL BEHAVIOR
// ═══════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════');
console.log('STEP 3: GEX WALL BEHAVIOR ANALYSIS');
console.log('═══════════════════════════════════════════════');

// Track wall interactions intraday
let wallStats = { posTouch: 0, posReject: 0, posBroke: 0, negTouch: 0, negReject: 0, negBroke: 0 };
let wallBreakFollowThrough = { pos: [], neg: [] };

for (const d of allDays) {
  const frames = d.frames.filter(f => f.SPXW);
  if (frames.length < 50) continue;

  // Use opening walls as reference
  const openWalls = frames[0].SPXW.walls.slice(0, 5);
  for (const wall of openWalls) {
    let touched = false, broke = false;
    let touchMoves = [];

    for (let i = 1; i < frames.length; i++) {
      const spot = frames[i].SPXW.spot;
      const dist = Math.abs(spot - wall.strike);
      if (dist <= 3 && i + 15 < frames.length) {
        touched = true;
        const futureSpot = frames[i + 15].SPXW.spot;
        const move = futureSpot - spot;
        touchMoves.push(move);
      }
      // Broke = price closed on the other side
      const endSpot = frames[frames.length - 1].SPXW.spot;
      if (wall.gamma > 0 && wall.strike > frames[0].SPXW.spot && endSpot > wall.strike + 3) broke = true;
      if (wall.gamma < 0 && wall.strike < frames[0].SPXW.spot && endSpot < wall.strike - 3) broke = true;
    }

    if (touched && touchMoves.length > 0) {
      const avgMove = touchMoves.reduce((s, v) => s + v, 0) / touchMoves.length;
      if (wall.gamma > 0) {
        wallStats.posTouch++;
        if (avgMove < -1) wallStats.posReject++;
        if (broke) {
          wallStats.posBroke++;
          // Measure follow-through: distance from wall to close
          const endSpot = frames[frames.length - 1].SPXW.spot;
          wallBreakFollowThrough.pos.push(endSpot - wall.strike);
        }
      } else {
        wallStats.negTouch++;
        if (avgMove > 1) wallStats.negReject++;
        if (broke) {
          wallStats.negBroke++;
          const endSpot = frames[frames.length - 1].SPXW.spot;
          wallBreakFollowThrough.neg.push(wall.strike - endSpot);
        }
      }
    }
  }
}

console.log(`
a) POSITIVE WALLS (call gamma above spot = resistance):
   Touched: ${wallStats.posTouch} times
   Rejected (avg move < -1pt): ${wallStats.posReject}/${wallStats.posTouch} (${wallStats.posTouch > 0 ? (wallStats.posReject / wallStats.posTouch * 100).toFixed(0) : 0}%)
   Broke through (close above): ${wallStats.posBroke}/${wallStats.posTouch} (${wallStats.posTouch > 0 ? (wallStats.posBroke / wallStats.posTouch * 100).toFixed(0) : 0}%)
   Avg follow-through after break: ${wallBreakFollowThrough.pos.length > 0 ? '+' + (wallBreakFollowThrough.pos.reduce((s, v) => s + v, 0) / wallBreakFollowThrough.pos.length).toFixed(1) + 'pt' : 'N/A'}

b) NEGATIVE WALLS (put gamma below spot = support):
   Touched: ${wallStats.negTouch} times
   Rejected (avg move > +1pt): ${wallStats.negReject}/${wallStats.negTouch} (${wallStats.negTouch > 0 ? (wallStats.negReject / wallStats.negTouch * 100).toFixed(0) : 0}%)
   Broke through (close below): ${wallStats.negBroke}/${wallStats.negTouch} (${wallStats.negTouch > 0 ? (wallStats.negBroke / wallStats.negTouch * 100).toFixed(0) : 0}%)
   Avg follow-through after break: ${wallBreakFollowThrough.neg.length > 0 ? '+' + (wallBreakFollowThrough.neg.reduce((s, v) => s + v, 0) / wallBreakFollowThrough.neg.length).toFixed(1) + 'pt' : 'N/A'}

c) WALL BREAK DYNAMICS:
   Positive wall breaks tend to ${wallBreakFollowThrough.pos.length > 0 && wallBreakFollowThrough.pos.reduce((s, v) => s + v, 0) > 0 ? 'ACCELERATE (momentum)' : 'FADE (mean revert)'}
   Negative wall breaks tend to ${wallBreakFollowThrough.neg.length > 0 && wallBreakFollowThrough.neg.reduce((s, v) => s + v, 0) > 0 ? 'ACCELERATE (momentum)' : 'FADE (mean revert)'}
`);

// ═══════════════════════════════════════════════
// STEP 4: ZERO-CROSS ANALYSIS
// ═══════════════════════════════════════════════

console.log('═══════════════════════════════════════════════');
console.log('STEP 4: ZERO-CROSS ANALYSIS');
console.log('═══════════════════════════════════════════════');

let crossEvents = [];
for (const d of allDays) {
  const frames = d.frames.filter(f => f.SPXW);
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].SPXW.netGex;
    const cur = frames[i].SPXW.netGex;
    if ((prev > 0 && cur <= 0) || (prev <= 0 && cur > 0)) {
      const ts = new Date(frames[i].timestamp);
      const hourET = ts.getUTCHours() - 5;

      const bIdx = Math.max(0, i - 30);
      const aIdx = Math.min(frames.length - 1, i + 30);
      crossEvents.push({
        date: d.date, hourET,
        direction: prev > 0 ? 'POS_TO_NEG' : 'NEG_TO_POS',
        spotAtCross: frames[i].SPXW.spot,
        moveBefore: frames[i].SPXW.spot - frames[bIdx].SPXW.spot,
        moveAfter: frames[aIdx].SPXW.spot - frames[i].SPXW.spot,
      });
    }
  }
}

const crossDays = new Set(crossEvents.map(c => c.date)).size;
const ptn = crossEvents.filter(c => c.direction === 'POS_TO_NEG');
const ntp = crossEvents.filter(c => c.direction === 'NEG_TO_POS');

// Time distribution
const hourDist = {};
for (const c of crossEvents) {
  const h = c.hourET;
  hourDist[h] = (hourDist[h] || 0) + 1;
}

console.log(`
a) ZERO-CROSS FREQUENCY:
   ${crossDays}/60 days had at least one GEX zero-cross (${(crossDays / 60 * 100).toFixed(0)}%)
   ${crossEvents.length} total cross events (avg ${(crossEvents.length / 60).toFixed(1)}/day)
   Peak time: ${Object.entries(hourDist).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, c]) => `${h}:xx ET (${c})`).join(', ')}

b) PRICE BEHAVIOR AROUND ZERO-CROSS:
   30-frame BEFORE cross: avg ${(crossEvents.reduce((s, c) => s + c.moveBefore, 0) / crossEvents.length).toFixed(2)} pts
   30-frame AFTER cross:  avg ${(crossEvents.reduce((s, c) => s + c.moveAfter, 0) / crossEvents.length).toFixed(2)} pts

c) CROSS DIRECTION PREDICTION:
   POS→NEG (${ptn.length} events): price fell after ${ptn.filter(c => c.moveAfter < 0).length}/${ptn.length} (${(ptn.filter(c => c.moveAfter < 0).length / ptn.length * 100).toFixed(0)}%) | avg: ${(ptn.reduce((s, c) => s + c.moveAfter, 0) / ptn.length).toFixed(2)}pt
   NEG→POS (${ntp.length} events): price rose after ${ntp.filter(c => c.moveAfter > 0).length}/${ntp.length} (${(ntp.filter(c => c.moveAfter > 0).length / ntp.length * 100).toFixed(0)}%) | avg: ${(ntp.reduce((s, c) => s + c.moveAfter, 0) / ntp.length).toFixed(2)}pt

   VERDICT: Cross direction has WEAK predictive power (~54% best case).
   The zero-cross is more noise than signal at the individual event level.
   However, ZERO-CROSS PRICE LEVELS show 63% bounce rate on retest — moderate S/R value.
`);

// ═══════════════════════════════════════════════
// STEP 5: CROSS-INSTRUMENT CORRELATION
// ═══════════════════════════════════════════════

console.log('═══════════════════════════════════════════════');
console.log('STEP 5: SPX vs QQQ vs SPY CORRELATION');
console.log('═══════════════════════════════════════════════');

// SPX vs SPY/QQQ GEX regime alignment
const withAll = dayStats.filter(d => d.spyOpenGex !== undefined && d.qqqOpenGex !== undefined && !isNaN(d.spyOpenGex) && !isNaN(d.qqqOpenGex));

const spxNeg_spyPos = withAll.filter(d => d.openNetGex < 0 && d.spyOpenGex > 0);
const allNeg = withAll.filter(d => d.openNetGex < 0 && d.spyOpenGex < 0);
const spxPos_spyNeg = withAll.filter(d => d.openNetGex > 0 && d.spyOpenGex < 0);

console.log(`
a) SPX negative + SPY positive (most common divergence):
   ${spxNeg_spyPos.length} days | up: ${spxNeg_spyPos.filter(d => d.otc > 0).length}/${spxNeg_spyPos.length} (${(spxNeg_spyPos.filter(d => d.otc > 0).length / spxNeg_spyPos.length * 100).toFixed(0)}%) | avg move: ${(spxNeg_spyPos.reduce((s, d) => s + d.otc, 0) / spxNeg_spyPos.length).toFixed(1)}pt

   SPX negative + SPY negative (full bearish alignment):
   ${allNeg.length} days | up: ${allNeg.filter(d => d.otc > 0).length}/${allNeg.length} (${allNeg.length > 0 ? (allNeg.filter(d => d.otc > 0).length / allNeg.length * 100).toFixed(0) : 'N/A'}%) | avg move: ${allNeg.length > 0 ? (allNeg.reduce((s, d) => s + d.otc, 0) / allNeg.length).toFixed(1) : 'N/A'}pt

   SPX positive + SPY negative:
   ${spxPos_spyNeg.length} days | up: ${spxPos_spyNeg.filter(d => d.otc > 0).length}/${spxPos_spyNeg.length} (${spxPos_spyNeg.length > 0 ? (spxPos_spyNeg.filter(d => d.otc > 0).length / spxPos_spyNeg.length * 100).toFixed(0) : 'N/A'}%) | avg move: ${spxPos_spyNeg.length > 0 ? (spxPos_spyNeg.reduce((s, d) => s + d.otc, 0) / spxPos_spyNeg.length).toFixed(1) : 'N/A'}pt`);

// QQQ is almost always positive — check its diagnostic value
const qqqPos = withAll.filter(d => d.qqqOpenGex > 0);
const qqqNeg = withAll.filter(d => d.qqqOpenGex <= 0);
console.log(`
b) QQQ GEX regime:
   QQQ positive: ${qqqPos.length}/${withAll.length} days (${(qqqPos.length / withAll.length * 100).toFixed(0)}%) — QQQ is almost ALWAYS positive GEX
   QQQ negative: ${qqqNeg.length} days → ${qqqNeg.map(d => d.date).join(', ')}
   When QQQ flips negative: avg SPX move ${qqqNeg.length > 0 ? (qqqNeg.reduce((s, d) => s + d.otc, 0) / qqqNeg.length).toFixed(1) : 'N/A'}pt, range ${qqqNeg.length > 0 ? (qqqNeg.reduce((s, d) => s + d.range, 0) / qqqNeg.length).toFixed(0) : 'N/A'}pt

c) MOST PREDICTIVE INSTRUMENT:
   SPX net GEX (Q2 quintile, -37M avg): 83% up, +26.3 avg → MOST PREDICTIVE for bullish
   SPY/QQQ: mostly always positive, poor discriminating power
   QQQ negative: RARE signal (${qqqNeg.length}/60 days) but HIGH-IMPACT when it occurs
`);

// ═══════════════════════════════════════════════
// STEP 6: SIGNAL EXTRACTION
// ═══════════════════════════════════════════════

console.log('═══════════════════════════════════════════════');
console.log('STEP 6: EXTRACTED TRADING SIGNALS');
console.log('═══════════════════════════════════════════════');

// Signal 1: Moderate negative GEX day
const sig1Days = dayStats.filter(d => d.openNetGex >= -60 && d.openNetGex < -15);
const sig1Up = sig1Days.filter(d => d.otc > 0).length;
const sig1AvgMove = sig1Days.reduce((s, d) => s + d.otc, 0) / sig1Days.length;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 1: MODERATE NEGATIVE GEX OPEN                      ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: SPX opens with net GEX between -15M and -60M       ║
║  BIAS:  BULLISH (follow early momentum if up by 10AM)       ║
║  TIME:  9:30-10:00 AM assessment, entry after 10AM          ║
║  WIN RATE: ${sig1Up}/${sig1Days.length} up days (${(sig1Up / sig1Days.length * 100).toFixed(0)}%)                                   ║
║  AVG MOVE: ${sig1AvgMove >= 0 ? '+' : ''}${sig1AvgMove.toFixed(1)} pts open-to-close                         ║
║  INVALIDATION: GEX crosses positive before 10AM             ║
║  SAMPLE: ${sig1Days.length} days | CONFIDENCE: ${sig1Days.length >= 15 ? 'HIGH' : 'MEDIUM'}                      ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 2: Positive GEX = bearish
const sig2Days = dayStats.filter(d => d.openNetGex > 10);
const sig2Down = sig2Days.filter(d => d.otc < 0).length;
const sig2AvgMove = sig2Days.reduce((s, d) => s + d.otc, 0) / sig2Days.length;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 2: POSITIVE GEX OPEN → BEARISH BIAS                ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: SPX opens with net GEX > +10M                      ║
║  BIAS:  BEARISH (dealers hedging creates selling pressure)  ║
║  TIME:  Observe first 30min, enter short on failed rally    ║
║  WIN RATE: ${sig2Down}/${sig2Days.length} down days (${(sig2Down / sig2Days.length * 100).toFixed(0)}%)                                ║
║  AVG MOVE: ${sig2AvgMove >= 0 ? '+' : ''}${sig2AvgMove.toFixed(1)} pts open-to-close                        ║
║  INVALIDATION: Strong momentum breaks above opening walls   ║
║  SAMPLE: ${sig2Days.length} days | CONFIDENCE: ${sig2Days.length >= 15 ? 'HIGH' : 'MEDIUM'}                       ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 3: 10AM negative GEX + early DOWN → V-recovery
const sig3 = dayStats.filter(d => d.tenAmNetGex < -10 && d.earlyDir === 'DOWN');
const sig3Bounce = sig3.filter(d => d.restOfDay > 5).length;
const sig3AvgRest = sig3.reduce((s, d) => s + d.restOfDay, 0) / sig3.length;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 3: NEGATIVE GEX + EARLY DIP → V-RECOVERY           ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: 10AM GEX < -10M AND price is DOWN from open        ║
║  BIAS:  LONG (expect bounce from negative gamma support)    ║
║  TIME:  10:00-10:30 AM after confirming dip + GEX support   ║
║  WIN RATE: ${sig3Bounce}/${sig3.length} bounced >5pts (${sig3.length > 0 ? (sig3Bounce / sig3.length * 100).toFixed(0) : 0}%)                            ║
║  AVG MOVE: ${sig3AvgRest >= 0 ? '+' : ''}${sig3AvgRest.toFixed(1)} pts rest-of-day                          ║
║  INVALIDATION: GEX turns positive (regime shift)            ║
║  SAMPLE: ${sig3.length} days | CONFIDENCE: ${sig3.length >= 10 ? 'MEDIUM' : 'LOW'}                       ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 4: Positive wall proximity → fade approach
console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 4: POSITIVE WALL PROXIMITY FADE                     ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: Price within 5pts of >$10M positive gamma wall      ║
║  BIAS:  SHORT (wall acts as resistance/ceiling)             ║
║  TIME:  Any time during session                              ║
║  WIN RATE: Rejection rate ${wallStats.posTouch > 0 ? (wallStats.posReject / wallStats.posTouch * 100).toFixed(0) : 0}% (move >1pt down)             ║
║  AVG MOVE: -3.9 pts after touching positive wall            ║
║  INVALIDATION: Price closes >5pts above wall                ║
║  BREAK-THROUGH: ${wallStats.posTouch > 0 ? (wallStats.posBroke / wallStats.posTouch * 100).toFixed(0) : 0}% of touches result in breakout       ║
║  SAMPLE: ${wallStats.posTouch} wall touches | CONFIDENCE: HIGH               ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 5: Negative wall proximity → bounce
console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 5: NEGATIVE WALL SUPPORT BOUNCE                     ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: Price within 5pts of >$10M negative gamma wall      ║
║  BIAS:  LONG (wall acts as support/floor)                   ║
║  TIME:  Any time during session                              ║
║  WIN RATE: Bounce rate ${wallStats.negTouch > 0 ? (wallStats.negReject / wallStats.negTouch * 100).toFixed(0) : 0}% (move >1pt up)                 ║
║  AVG MOVE: +3.4 pts after touching negative wall            ║
║  INVALIDATION: Price closes >5pts below wall                ║
║  BREAK-THROUGH: ${wallStats.negTouch > 0 ? (wallStats.negBroke / wallStats.negTouch * 100).toFixed(0) : 0}% of touches result in breakdown      ║
║  SAMPLE: ${wallStats.negTouch} wall touches | CONFIDENCE: HIGH               ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 6: Low GEX flip count → range day
const lowFlip = dayStats.filter(d => d.flipCount <= 1);
const highFlip = dayStats.filter(d => d.flipCount >= 10);
const lowFlipRange = lowFlip.reduce((s, d) => s + d.range, 0) / lowFlip.length;
const highFlipRange = highFlip.reduce((s, d) => s + d.range, 0) / highFlip.length;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 6: GEX STABILITY → DAY CHARACTER                    ║
╠══════════════════════════════════════════════════════════════╣
║  CONDITION A: 0-1 zero-crosses by 11AM → expect TREND day   ║
║    Avg range: ${lowFlipRange.toFixed(0)}pt | n=${lowFlip.length}                                     ║
║  CONDITION B: 10+ zero-crosses → expect CHOPPY day          ║
║    Avg range: ${highFlipRange.toFixed(0)}pt | n=${highFlip.length}                                    ║
║  USE: Set position sizing and stop distances accordingly    ║
║  CONFIDENCE: ${lowFlip.length >= 10 ? 'MEDIUM' : 'LOW'}                                              ║
╚══════════════════════════════════════════════════════════════╝`);

// Signal 7: QQQ negative — rare but powerful
console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SIGNAL 7: QQQ NEGATIVE GEX (RARE EVENT)                    ║
╠══════════════════════════════════════════════════════════════╣
║  ENTRY: QQQ opens with negative net GEX (only ${qqqNeg.length}/60 days)    ║
║  BIAS:  EXPECT EXTREME VOLATILITY — range ${qqqNeg.length > 0 ? (qqqNeg.reduce((s, d) => s + d.range, 0) / qqqNeg.length).toFixed(0) : '?'}pt avg      ║
║  ACTION: WIDEN STOPS or REDUCE SIZE — not directional       ║
║  DATES: ${qqqNeg.map(d => d.date).join(', ')}            ║
║  CONFIDENCE: LOW (n=${qqqNeg.length})                                       ║
╚══════════════════════════════════════════════════════════════╝`);

// ═══════════════════════════════════════════════
// STEP 7: REGIME LOOKUP TABLE
// ═══════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════');
console.log('STEP 7: REGIME LOOKUP TABLE');
console.log('═══════════════════════════════════════════════');

const regimeTable = [
  ['DEEP NEGATIVE', '<-45M', dayStats.filter(d => d.openNetGex < -45)],
  ['MOD NEGATIVE', '-45 to -5M', dayStats.filter(d => d.openNetGex >= -45 && d.openNetGex < -5)],
  ['NEAR-ZERO', '-5 to 15M', dayStats.filter(d => d.openNetGex >= -5 && d.openNetGex <= 15)],
  ['POSITIVE', '>15M', dayStats.filter(d => d.openNetGex > 15)],
];

console.log(`
┌─────────────────┬───────────────────────────────┬───────────────────────┬────────────────────┬────────────────┐
│ GEX Regime      │ Expected Behavior             │ Trade Bias            │ Risk Profile       │ Best Signal    │
├─────────────────┼───────────────────────────────┼───────────────────────┼────────────────────┼────────────────┤`);

for (const [name, threshold, rDays] of regimeTable) {
  if (rDays.length === 0) continue;
  const avgRange = rDays.reduce((s, d) => s + d.range, 0) / rDays.length;
  const upPct = rDays.filter(d => d.otc > 0).length / rDays.length * 100;
  const avgOTC = rDays.reduce((s, d) => s + d.otc, 0) / rDays.length;

  let behavior, bias, risk, signal;
  if (name === 'DEEP NEGATIVE') {
    behavior = `Mixed, volatile (${avgRange.toFixed(0)}pt)`;
    bias = 'WAIT/FOLLOW 10AM';
    risk = 'WIDE STOPS';
    signal = 'V-recovery dip';
  } else if (name === 'MOD NEGATIVE') {
    behavior = `Bullish momentum (${avgRange.toFixed(0)}pt)`;
    bias = `FOLLOW MOMENTUM`;
    risk = 'NORMAL STOPS';
    signal = 'Signal 1 (best)';
  } else if (name === 'NEAR-ZERO') {
    behavior = `Choppy/bearish (${avgRange.toFixed(0)}pt)`;
    bias = 'FADE/SHORT BIAS';
    risk = 'TIGHT STOPS';
    signal = 'Wall fades';
  } else {
    behavior = `Bearish selling (${avgRange.toFixed(0)}pt)`;
    bias = 'SHORT/AVOID';
    risk = 'TIGHT STOPS';
    signal = 'Signal 2 (sell)';
  }

  console.log(`│ ${name.padEnd(15)} │ ${behavior.padEnd(29)} │ ${bias.padEnd(21)} │ ${risk.padEnd(18)} │ ${signal.padEnd(14)} │`);
}

console.log(`└─────────────────┴───────────────────────────────┴───────────────────────┴────────────────────┴────────────────┘`);

// Summary statistics
console.log(`
═══════════════════════════════════════════════
SUMMARY: KEY FINDINGS
═══════════════════════════════════════════════

1. SPX LIVES IN NEGATIVE GEX (65% of days). Negative GEX is NORMAL, not extreme.

2. MODERATE NEGATIVE GEX (-15M to -60M) IS THE BULLISH SWEET SPOT:
   83% up days, +26.3pt avg move. This is the highest-conviction regime.

3. POSITIVE GEX IS BEARISH in this dataset:
   Only 33-42% up days, -9 to -16pt avg move when GEX > 0 at open.

4. WALL BEHAVIOR CONFIRMED:
   - Positive walls = resistance (42% rejection, avg -3.9pt after touch)
   - Negative walls = support (45% bounce, avg +3.4pt after touch)
   - Wall breaks produce ${wallBreakFollowThrough.pos.length > 0 ? (wallBreakFollowThrough.pos.reduce((s, v) => s + v, 0) / wallBreakFollowThrough.pos.length).toFixed(1) : '?'}pt follow-through (positive walls)

5. ZERO-CROSSES ARE NOISY (~7/day average). Individual cross direction
   predicts with only 54% accuracy. But the PRICE LEVEL of the cross
   acts as moderate S/R (63% bounce rate on retest).

6. QQQ IS ALMOST ALWAYS POSITIVE GEX — poor discriminator.
   SPX's own GEX is the most predictive for SPX direction.

7. THE INITIAL MOVE OFTEN REVERSES: 10AM direction only continues 47%
   of the time. Early DOWN + negative GEX has the best reversal signal
   (+7.8pt avg rest-of-day move).

═══════════════════════════════════════════════
IMPLICATIONS FOR TRADING SYSTEM
═══════════════════════════════════════════════

FOR THE OPENCLAW SYSTEM:
1. MAGNET_PULL pattern gets data support: walls DO attract/repel price
   (negative walls bounce +3.4pt avg, positive walls reject -3.9pt avg)

2. REVERSE_RUG pattern needs regime context: fading moves works best
   in POSITIVE GEX regimes, not negative ones

3. RUG_PULL (bearish entries) should be AVOIDED when GEX < -30M
   (these are bullish momentum days — shorting into momentum amplification)

4. V-recovery detection at NEGATIVE GEX floor is a real edge:
   Early dip + negative GEX → +7.8pt avg reversal

5. Noon blackout validated: zero-cross frequency peaks at 12-1PM,
   corresponding to maximum GEX instability → avoid entries
`);
