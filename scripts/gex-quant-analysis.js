/**
 * Quantitative GEX Analysis — 60 days of SPX/SPY/QQQ trinity data
 * Extracts regime classifications, day-type patterns, wall behavior,
 * zero-cross analysis, cross-instrument correlation, and trading signals.
 */
import { readFileSync, readdirSync } from 'fs';

// ─── DATA LOADING ───────────────────────────────────────────────────

function parseGexFrame(tickerData) {
  const spot = tickerData.spotPrice;
  const strikes = tickerData.strikes;
  const totalByStrike = tickerData.gammaValues.map(gvArr => gvArr.reduce((s, v) => s + v, 0));
  const zdteByStrike = tickerData.gammaValues.map(gvArr => gvArr[0]); // 0DTE only

  const netGex = totalByStrike.reduce((s, v) => s + v, 0);
  const posGex = totalByStrike.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const negGex = totalByStrike.filter(v => v < 0).reduce((s, v) => s + v, 0);
  const netZdte = zdteByStrike.reduce((s, v) => s + v, 0);

  // Find walls (top 10 by absolute value)
  const walls = totalByStrike
    .map((v, i) => ({ strike: strikes[i], gamma: v }))
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, 10);

  // GEX at spot (interpolated between nearest strikes)
  const spotIdx = strikes.findIndex(s => s >= spot);
  const gexAtSpot = spotIdx > 0
    ? (totalByStrike[spotIdx - 1] + totalByStrike[spotIdx]) / 2
    : totalByStrike[spotIdx] || 0;

  // Largest positive wall above spot
  const callWalls = walls.filter(w => w.gamma > 0 && w.strike > spot).sort((a, b) => b.gamma - a.gamma);
  // Largest negative wall below spot
  const putWalls = walls.filter(w => w.gamma < 0 && w.strike < spot).sort((a, b) => a.gamma - b.gamma);

  // Zero-cross level: find strike where gamma flips sign near spot
  let zeroCrossStrike = null;
  for (let i = 1; i < totalByStrike.length; i++) {
    if ((totalByStrike[i - 1] > 0 && totalByStrike[i] < 0) || (totalByStrike[i - 1] < 0 && totalByStrike[i] > 0)) {
      if (Math.abs(strikes[i] - spot) < 50) {
        zeroCrossStrike = (strikes[i - 1] + strikes[i]) / 2;
        break;
      }
    }
  }

  return {
    spot, netGex, posGex, negGex, netZdte, gexAtSpot, walls,
    callWalls, putWalls, zeroCrossStrike, strikes, totalByStrike
  };
}

function loadDay(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const date = data.metadata.date;
  const frames = data.frames.map(f => {
    const ts = f.timestamp;
    const result = { timestamp: ts };
    for (const ticker of ['SPXW', 'SPY', 'QQQ']) {
      if (f.tickers && f.tickers[ticker]) {
        result[ticker] = parseGexFrame(f.tickers[ticker]);
      }
    }
    return result;
  });
  return { date, frames };
}

// ─── DAY CLASSIFICATION ─────────────────────────────────────────────

function classifyDay(frames) {
  if (frames.length < 10) return { type: 'INSUFFICIENT_DATA' };

  const spxFrames = frames.filter(f => f.SPXW);
  if (spxFrames.length < 10) return { type: 'INSUFFICIENT_DATA' };

  const openFrame = spxFrames[0];
  const closeFrame = spxFrames[spxFrames.length - 1];
  const openSpot = openFrame.SPXW.spot;
  const closeSpot = closeFrame.SPXW.spot;
  const openToClose = closeSpot - openSpot;

  // Find high/low
  let high = -Infinity, low = Infinity, highIdx = 0, lowIdx = 0;
  for (let i = 0; i < spxFrames.length; i++) {
    const s = spxFrames[i].SPXW.spot;
    if (s > high) { high = s; highIdx = i; }
    if (s < low) { low = s; lowIdx = i; }
  }
  const range = high - low;

  // 10AM frame (about 30 min in = ~60 frames if 30s intervals, ~30 if 1 min)
  const tenAmIdx = Math.min(Math.floor(spxFrames.length * 0.08), spxFrames.length - 1); // ~8% through
  const tenAmFrame = spxFrames[tenAmIdx];

  // Midday frame
  const midIdx = Math.floor(spxFrames.length / 2);
  const midFrame = spxFrames[midIdx];

  // Classify day type
  const changePct = (openToClose / openSpot) * 100;
  const rangePct = (range / openSpot) * 100;

  let dayType;
  const highInFirstHalf = highIdx < spxFrames.length * 0.4;
  const lowInFirstHalf = lowIdx < spxFrames.length * 0.4;
  const highInLastQuarter = highIdx > spxFrames.length * 0.75;
  const lowInLastQuarter = lowIdx > spxFrames.length * 0.75;

  if (Math.abs(changePct) < 0.05 && rangePct < 0.3) {
    dayType = 'CHOP';
  } else if (changePct > 0.15 && !highInFirstHalf) {
    if (lowInFirstHalf && (openSpot - low) > range * 0.3) {
      dayType = 'V_RECOVERY';
    } else {
      dayType = 'UP_TREND';
    }
  } else if (changePct < -0.15 && !lowInFirstHalf) {
    if (highInFirstHalf && (high - openSpot) > range * 0.3) {
      dayType = 'INVERTED_V';
    } else {
      dayType = 'DOWN_TREND';
    }
  } else if (changePct > 0.05) {
    dayType = 'UP_DAY';
  } else if (changePct < -0.05) {
    dayType = 'DOWN_DAY';
  } else {
    dayType = 'FLAT';
  }

  // Check for V-recovery: dipped significantly then recovered
  if (dayType === 'UP_DAY' || dayType === 'FLAT') {
    const dip = openSpot - low;
    const recovery = closeSpot - low;
    if (dip > 8 && recovery > dip * 0.7 && lowIdx < spxFrames.length * 0.6) {
      dayType = 'V_RECOVERY';
    }
  }

  // Check for reversal (inverted V)
  if (dayType === 'DOWN_DAY' || dayType === 'FLAT') {
    const rip = high - openSpot;
    const selloff = high - closeSpot;
    if (rip > 8 && selloff > rip * 0.7 && highIdx < spxFrames.length * 0.6) {
      dayType = 'INVERTED_V';
    }
  }

  // GEX regime at open
  const openNetGex = openFrame.SPXW.netGex;
  const tenAmNetGex = tenAmFrame.SPXW.netGex;

  // Check for zero-cross during session
  let zeroCrossed = false;
  let zeroCrossTime = null;
  let zeroCrossDirection = null; // 'POS_TO_NEG' or 'NEG_TO_POS'
  let prevGex = spxFrames[0].SPXW.netGex;
  for (let i = 1; i < spxFrames.length; i++) {
    const curGex = spxFrames[i].SPXW.netGex;
    if ((prevGex > 0 && curGex <= 0) || (prevGex <= 0 && curGex > 0)) {
      zeroCrossed = true;
      zeroCrossTime = spxFrames[i].timestamp;
      zeroCrossDirection = prevGex > 0 ? 'POS_TO_NEG' : 'NEG_TO_POS';
      break; // first cross only
    }
    prevGex = curGex;
  }

  // GEX readings throughout day
  const gexReadings = spxFrames.map(f => f.SPXW.netGex);
  const avgGex = gexReadings.reduce((s, v) => s + v, 0) / gexReadings.length;
  const minGex = Math.min(...gexReadings);
  const maxGex = Math.max(...gexReadings);

  // SPY/QQQ data
  const spyOpen = spxFrames[0].SPY?.spot;
  const spyClose = spxFrames[spxFrames.length - 1].SPY?.spot;
  const qqqOpen = spxFrames[0].QQQ?.spot;
  const qqqClose = spxFrames[spxFrames.length - 1].QQQ?.spot;

  const spyOpenGex = spxFrames[0].SPY?.netGex;
  const qqqOpenGex = spxFrames[0].QQQ?.netGex;
  const spyAvgGex = spxFrames.filter(f => f.SPY).reduce((s, f) => s + f.SPY.netGex, 0) / spxFrames.filter(f => f.SPY).length;
  const qqqAvgGex = spxFrames.filter(f => f.QQQ).reduce((s, f) => s + f.QQQ.netGex, 0) / spxFrames.filter(f => f.QQQ).length;

  // Wall analysis - most prominent walls at open
  const openWalls = openFrame.SPXW.walls;
  const largestWall = openWalls[0];

  // Price interaction with walls throughout day
  const wallInteractions = [];
  for (const wall of openWalls.slice(0, 5)) {
    let touched = false, broke = false, rejectedCount = 0;
    for (const f of spxFrames) {
      const dist = Math.abs(f.SPXW.spot - wall.strike);
      if (dist <= 5) {
        touched = true;
        // Check if price reversed after touching
        const idx = spxFrames.indexOf(f);
        if (idx < spxFrames.length - 5) {
          const future = spxFrames[idx + 5].SPXW.spot;
          const approaching = wall.strike > f.SPXW.spot ? 'FROM_BELOW' : 'FROM_ABOVE';
          if (approaching === 'FROM_BELOW' && future < f.SPXW.spot) rejectedCount++;
          if (approaching === 'FROM_ABOVE' && future > f.SPXW.spot) rejectedCount++;
        }
      }
      if ((wall.strike > openSpot && f.SPXW.spot > wall.strike + 5) ||
          (wall.strike < openSpot && f.SPXW.spot < wall.strike - 5)) {
        broke = true;
      }
    }
    wallInteractions.push({
      strike: wall.strike, gamma: wall.gamma, touched, broke, rejectedCount
    });
  }

  return {
    dayType, openSpot, closeSpot, high, low, range,
    openToClose, changePct, rangePct,
    highIdx: highIdx / spxFrames.length, // normalized position
    lowIdx: lowIdx / spxFrames.length,
    openNetGex, tenAmNetGex, avgGex, minGex, maxGex,
    zeroCrossed, zeroCrossTime, zeroCrossDirection,
    spyOpenGex, qqqOpenGex, spyAvgGex, qqqAvgGex,
    spyChange: spyClose && spyOpen ? ((spyClose - spyOpen) / spyOpen * 100) : null,
    qqqChange: qqqClose && qqqOpen ? ((qqqClose - qqqOpen) / qqqOpen * 100) : null,
    largestWall, wallInteractions,
    frames: spxFrames,
    gexReadings
  };
}

// ─── MAIN ANALYSIS ──────────────────────────────────────────────────

const files = readdirSync('data')
  .filter(f => f.match(/^gex-replay-20\d{2}-\d{2}-\d{2}\.json$/))
  .sort();

console.log(`Loading ${files.length} days of data...\n`);

const days = [];
for (const file of files) {
  try {
    const dayData = loadDay(`data/${file}`);
    const classified = classifyDay(dayData.frames);
    classified.date = dayData.date;
    days.push(classified);
  } catch (e) {
    console.error(`Error loading ${file}:`, e.message);
  }
}

console.log(`Successfully loaded ${days.length} days\n`);

// ═══════════════════════════════════════════════
// STEP 1: REGIME CLASSIFICATION
// ═══════════════════════════════════════════════

console.log('═'.repeat(70));
console.log('STEP 1: REGIME CLASSIFICATION');
console.log('═'.repeat(70));

// Determine GEX distribution to set thresholds
const openGexValues = days.map(d => d.openNetGex / 1e6);
openGexValues.sort((a, b) => a - b);
console.log('\nOpen GEX Distribution (millions):');
console.log(`  Min: ${openGexValues[0]?.toFixed(1)}M`);
console.log(`  25th: ${openGexValues[Math.floor(openGexValues.length * 0.25)]?.toFixed(1)}M`);
console.log(`  Median: ${openGexValues[Math.floor(openGexValues.length * 0.5)]?.toFixed(1)}M`);
console.log(`  75th: ${openGexValues[Math.floor(openGexValues.length * 0.75)]?.toFixed(1)}M`);
console.log(`  Max: ${openGexValues[openGexValues.length - 1]?.toFixed(1)}M`);

// Define thresholds from data
const medianGex = openGexValues[Math.floor(openGexValues.length * 0.5)];
const HIGH_POS_THRESHOLD = openGexValues[Math.floor(openGexValues.length * 0.75)]; // 75th percentile
const LOW_POS_THRESHOLD = 0;

function getRegime(gex) {
  const gexM = gex / 1e6;
  if (gexM > HIGH_POS_THRESHOLD) return 'HIGH_POSITIVE';
  if (gexM > LOW_POS_THRESHOLD) return 'LOW_POSITIVE';
  return 'NEGATIVE';
}

console.log(`\nThresholds: HIGH_POS > ${HIGH_POS_THRESHOLD.toFixed(1)}M | LOW_POS > 0 | NEGATIVE <= 0`);

const regimes = { HIGH_POSITIVE: [], LOW_POSITIVE: [], NEGATIVE: [], ZERO_CROSS: [] };
for (const d of days) {
  const regime = getRegime(d.openNetGex);
  regimes[regime].push(d);
  if (d.zeroCrossed) regimes.ZERO_CROSS.push(d);
}

for (const [regime, daysInRegime] of Object.entries(regimes)) {
  console.log(`\n─── ${regime} (${daysInRegime.length} days) ───`);
  if (daysInRegime.length === 0) continue;

  // Day type breakdown
  const typeCounts = {};
  for (const d of daysInRegime) {
    typeCounts[d.dayType] = (typeCounts[d.dayType] || 0) + 1;
  }
  console.log('  Day types:');
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t}: ${c} (${(c / daysInRegime.length * 100).toFixed(0)}%)`);
  }

  // Average range
  const avgRange = daysInRegime.reduce((s, d) => s + d.range, 0) / daysInRegime.length;
  const avgOTC = daysInRegime.reduce((s, d) => s + d.openToClose, 0) / daysInRegime.length;
  const avgChangePct = daysInRegime.reduce((s, d) => s + d.changePct, 0) / daysInRegime.length;
  console.log(`  Avg range: ${avgRange.toFixed(1)} pts`);
  console.log(`  Avg open-to-close: ${avgOTC >= 0 ? '+' : ''}${avgOTC.toFixed(1)} pts (${avgChangePct >= 0 ? '+' : ''}${avgChangePct.toFixed(3)}%)`);
  console.log(`  Up days: ${daysInRegime.filter(d => d.openToClose > 0).length} | Down days: ${daysInRegime.filter(d => d.openToClose <= 0).length}`);
}

// ═══════════════════════════════════════════════
// STEP 2: DAY-TYPE PATTERN ANALYSIS
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 2: DAY-TYPE PATTERN ANALYSIS');
console.log('═'.repeat(70));

const dayTypes = {};
for (const d of days) {
  if (!(d.dayType in dayTypes)) dayTypes[d.dayType] = [];
  dayTypes[d.dayType].push(d);
}

for (const [type, typeDays] of Object.entries(dayTypes).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n─── ${type} (${typeDays.length} days) ───`);

  // a) GEX at open and 10AM
  const avgOpenGex = typeDays.reduce((s, d) => s + d.openNetGex, 0) / typeDays.length / 1e6;
  const avgTenAmGex = typeDays.reduce((s, d) => s + d.tenAmNetGex, 0) / typeDays.length / 1e6;
  console.log(`  a) Avg GEX at open: ${avgOpenGex.toFixed(1)}M | at 10AM: ${avgTenAmGex.toFixed(1)}M`);

  // b) Regime distribution
  const regimeDist = {};
  for (const d of typeDays) {
    const r = getRegime(d.openNetGex);
    regimeDist[r] = (regimeDist[r] || 0) + 1;
  }
  console.log('  b) Regime distribution:');
  for (const [r, c] of Object.entries(regimeDist)) {
    console.log(`     ${r}: ${c} (${(c / typeDays.length * 100).toFixed(0)}%)`);
  }

  // c) Wall interactions
  let wallRespected = 0, wallTotal = 0;
  for (const d of typeDays) {
    for (const wi of d.wallInteractions) {
      if (wi.touched) {
        wallTotal++;
        if (wi.rejectedCount > 0 && !wi.broke) wallRespected++;
      }
    }
  }
  if (wallTotal > 0) {
    console.log(`  c) Wall respect rate: ${wallRespected}/${wallTotal} (${(wallRespected / wallTotal * 100).toFixed(0)}%)`);
  }

  // Average range
  const avgRange = typeDays.reduce((s, d) => s + d.range, 0) / typeDays.length;
  console.log(`  Range: avg ${avgRange.toFixed(1)} pts`);

  // Confidence
  console.log(`  Confidence: ${typeDays.length >= 20 ? 'HIGH' : typeDays.length >= 10 ? 'MEDIUM' : 'LOW'} (n=${typeDays.length})`);
}

// d) V-recovery analysis
const vDays = dayTypes['V_RECOVERY'] || [];
if (vDays.length > 0) {
  console.log('\n─── V-RECOVERY DEEP DIVE ───');
  for (const d of vDays) {
    const lowFrame = d.frames[Math.floor(d.lowIdx * d.frames.length)];
    console.log(`  ${d.date}: Low at ${d.low.toFixed(0)} (${(d.lowIdx * 100).toFixed(0)}% thru day), GEX at low: ${(lowFrame?.SPXW?.netGex / 1e6).toFixed(1)}M, recovered to ${d.closeSpot.toFixed(0)}`);
  }
}

// e) Chop analysis
const chopDays = dayTypes['CHOP'] || dayTypes['FLAT'] || [];
const trendDays = [...(dayTypes['UP_TREND'] || []), ...(dayTypes['DOWN_TREND'] || [])];
if (chopDays.length > 0 && trendDays.length > 0) {
  const chopAvgRange = chopDays.reduce((s, d) => s + d.range, 0) / chopDays.length;
  const trendAvgRange = trendDays.reduce((s, d) => s + d.range, 0) / trendDays.length;
  console.log(`\n─── CHOP vs TREND COMPARISON ───`);
  console.log(`  Chop avg range: ${chopAvgRange.toFixed(1)} pts (n=${chopDays.length})`);
  console.log(`  Trend avg range: ${trendAvgRange.toFixed(1)} pts (n=${trendDays.length})`);
  const chopAvgGex = chopDays.reduce((s, d) => s + d.avgGex, 0) / chopDays.length / 1e6;
  const trendAvgGex = trendDays.reduce((s, d) => s + d.avgGex, 0) / trendDays.length / 1e6;
  console.log(`  Chop avg GEX: ${chopAvgGex.toFixed(1)}M | Trend avg GEX: ${trendAvgGex.toFixed(1)}M`);
}

// ═══════════════════════════════════════════════
// STEP 3: GEX WALL BEHAVIOR
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 3: GEX WALL BEHAVIOR ANALYSIS');
console.log('═'.repeat(70));

// Track walls across all days
const wallFrequency = {};
for (const d of days) {
  // Round wall strikes to nearest 5 for aggregation
  for (const wi of d.wallInteractions) {
    const roundedStrike = Math.round(wi.strike / 5) * 5;
    if (!(roundedStrike in wallFrequency)) {
      wallFrequency[roundedStrike] = { count: 0, touched: 0, respected: 0, broke: 0, totalGamma: 0 };
    }
    wallFrequency[roundedStrike].count++;
    wallFrequency[roundedStrike].totalGamma += wi.gamma;
    if (wi.touched) {
      wallFrequency[roundedStrike].touched++;
      if (wi.rejectedCount > 0 && !wi.broke) wallFrequency[roundedStrike].respected++;
      if (wi.broke) wallFrequency[roundedStrike].broke++;
    }
  }
}

// Also track walls dynamically during the day
const wallInteractionDetails = [];
for (const d of days) {
  const frames = d.frames;
  // Get opening walls
  if (frames.length < 20) continue;
  const openWalls = frames[0].SPXW.walls.slice(0, 5);
  for (const wall of openWalls) {
    let firstTouch = null, touchCount = 0, brokeThrough = false;
    let priceAfterTouch = [];

    for (let i = 0; i < frames.length; i++) {
      const spot = frames[i].SPXW.spot;
      const dist = Math.abs(spot - wall.strike);
      if (dist <= 3) {
        touchCount++;
        if (!firstTouch) firstTouch = i;
        // Price 15 frames later
        if (i + 15 < frames.length) {
          const futureSpot = frames[i + 15].SPXW.spot;
          const move = futureSpot - spot;
          priceAfterTouch.push({
            direction: wall.gamma > 0 ? 'POSITIVE_WALL' : 'NEGATIVE_WALL',
            priceAbove: spot > wall.strike,
            move
          });
        }
      }
      if (wall.gamma > 0 && spot > wall.strike + 5 && wall.strike > frames[0].SPXW.spot) brokeThrough = true;
      if (wall.gamma < 0 && spot < wall.strike - 5 && wall.strike < frames[0].SPXW.spot) brokeThrough = true;
    }

    if (touchCount > 0) {
      wallInteractionDetails.push({
        date: d.date,
        strike: wall.strike,
        gamma: wall.gamma,
        wallType: wall.gamma > 0 ? 'POSITIVE' : 'NEGATIVE',
        touchCount,
        brokeThrough,
        avgMoveAfterTouch: priceAfterTouch.length > 0
          ? priceAfterTouch.reduce((s, p) => s + p.move, 0) / priceAfterTouch.length
          : null
      });
    }
  }
}

// a) Wall behavior summary
const posWallTouches = wallInteractionDetails.filter(w => w.wallType === 'POSITIVE');
const negWallTouches = wallInteractionDetails.filter(w => w.wallType === 'NEGATIVE');

console.log(`\na) Wall touches across all days:`);
console.log(`   Positive walls touched: ${posWallTouches.length} times`);
console.log(`   Negative walls touched: ${negWallTouches.length} times`);

// b) What happens at walls
const posWallBounce = posWallTouches.filter(w => w.avgMoveAfterTouch !== null);
const negWallBounce = negWallTouches.filter(w => w.avgMoveAfterTouch !== null);

if (posWallBounce.length > 0) {
  const avgMove = posWallBounce.reduce((s, w) => s + w.avgMoveAfterTouch, 0) / posWallBounce.length;
  const rejections = posWallBounce.filter(w => w.avgMoveAfterTouch < -1).length;
  console.log(`\nb) Positive wall behavior (n=${posWallBounce.length}):`);
  console.log(`   Avg 15-frame move after touch: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)} pts`);
  console.log(`   Rejection rate (move down >1pt): ${(rejections / posWallBounce.length * 100).toFixed(0)}%`);
  console.log(`   Broke through: ${posWallTouches.filter(w => w.brokeThrough).length}/${posWallTouches.length} (${(posWallTouches.filter(w => w.brokeThrough).length / posWallTouches.length * 100).toFixed(0)}%)`);
}

if (negWallBounce.length > 0) {
  const avgMove = negWallBounce.reduce((s, w) => s + w.avgMoveAfterTouch, 0) / negWallBounce.length;
  const rejections = negWallBounce.filter(w => w.avgMoveAfterTouch > 1).length;
  console.log(`\n   Negative wall behavior (n=${negWallBounce.length}):`);
  console.log(`   Avg 15-frame move after touch: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)} pts`);
  console.log(`   Rejection rate (bounce up >1pt): ${(rejections / negWallBounce.length * 100).toFixed(0)}%`);
  console.log(`   Broke through: ${negWallTouches.filter(w => w.brokeThrough).length}/${negWallTouches.length} (${(negWallTouches.filter(w => w.brokeThrough).length / negWallTouches.length * 100).toFixed(0)}%)`);
}

// c) What happens after wall break
const wallBreaks = wallInteractionDetails.filter(w => w.brokeThrough && w.avgMoveAfterTouch !== null);
if (wallBreaks.length > 0) {
  const posBreaks = wallBreaks.filter(w => w.wallType === 'POSITIVE');
  const negBreaks = wallBreaks.filter(w => w.wallType === 'NEGATIVE');
  console.log(`\nc) After wall break (n=${wallBreaks.length}):`);
  if (posBreaks.length > 0) {
    const avgFollowThru = posBreaks.reduce((s, w) => s + w.avgMoveAfterTouch, 0) / posBreaks.length;
    console.log(`   Positive wall breaks: ${posBreaks.length} | avg follow-through: ${avgFollowThru >= 0 ? '+' : ''}${avgFollowThru.toFixed(2)} pts`);
  }
  if (negBreaks.length > 0) {
    const avgFollowThru = negBreaks.reduce((s, w) => s + w.avgMoveAfterTouch, 0) / negBreaks.length;
    console.log(`   Negative wall breaks: ${negBreaks.length} | avg follow-through: ${avgFollowThru >= 0 ? '+' : ''}${avgFollowThru.toFixed(2)} pts`);
  }
}

// d) SPX vs SPY vs QQQ wall comparison
console.log('\nd) Cross-instrument wall comparison:');
for (const d of days.slice(0, 5)) {
  const spxwWall = d.wallInteractions[0];
  console.log(`   ${d.date}: SPXW largest wall at ${spxwWall?.strike} (${(spxwWall?.gamma / 1e6).toFixed(1)}M) | ${spxwWall?.touched ? 'TOUCHED' : 'not touched'} | ${spxwWall?.broke ? 'BROKE' : 'held'}`);
}

// ═══════════════════════════════════════════════
// STEP 4: ZERO-CROSS ANALYSIS
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 4: ZERO-CROSS ANALYSIS');
console.log('═'.repeat(70));

// Detailed zero-cross detection
const zeroCrossDays = [];
for (const d of days) {
  const frames = d.frames;
  const crosses = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].SPXW.netGex;
    const cur = frames[i].SPXW.netGex;
    if ((prev > 0 && cur <= 0) || (prev <= 0 && cur > 0)) {
      const ts = new Date(frames[i].timestamp);
      const hour = ts.getUTCHours() - 5; // rough ET conversion
      const min = ts.getUTCMinutes();
      const timeET = `${hour}:${min.toString().padStart(2, '0')}`;

      // Price behavior 30 frames before and after
      const beforeIdx = Math.max(0, i - 30);
      const afterIdx = Math.min(frames.length - 1, i + 30);
      const priceBefore = frames[i].SPXW.spot - frames[beforeIdx].SPXW.spot;
      const priceAfter = frames[afterIdx].SPXW.spot - frames[i].SPXW.spot;
      const direction = prev > 0 ? 'POS_TO_NEG' : 'NEG_TO_POS';

      crosses.push({
        frameIdx: i / frames.length,
        timeET,
        direction,
        spotAtCross: frames[i].SPXW.spot,
        priceBefore30: priceBefore,
        priceAfter30: priceAfter,
        gexBefore: prev / 1e6,
        gexAfter: cur / 1e6
      });
    }
  }
  if (crosses.length > 0) {
    zeroCrossDays.push({ date: d.date, dayType: d.dayType, crosses });
  }
}

console.log(`\na) ${zeroCrossDays.length} days had at least one zero-cross`);
const allCrosses = zeroCrossDays.flatMap(d => d.crosses);
console.log(`   Total cross events: ${allCrosses.length}`);

// Time distribution
const timeDistribution = {};
for (const c of allCrosses) {
  const hour = c.timeET.split(':')[0];
  timeDistribution[hour] = (timeDistribution[hour] || 0) + 1;
}
console.log('   Time distribution (ET):');
for (const [h, c] of Object.entries(timeDistribution).sort()) {
  console.log(`     ${h}:xx — ${c} crosses`);
}

// b) Price behavior before/after
const avgBefore = allCrosses.reduce((s, c) => s + c.priceBefore30, 0) / allCrosses.length;
const avgAfter = allCrosses.reduce((s, c) => s + c.priceAfter30, 0) / allCrosses.length;
console.log(`\nb) Avg price move 30 frames BEFORE cross: ${avgBefore >= 0 ? '+' : ''}${avgBefore.toFixed(2)} pts`);
console.log(`   Avg price move 30 frames AFTER cross:  ${avgAfter >= 0 ? '+' : ''}${avgAfter.toFixed(2)} pts`);

// c) Cross direction prediction
const posToNeg = allCrosses.filter(c => c.direction === 'POS_TO_NEG');
const negToPos = allCrosses.filter(c => c.direction === 'NEG_TO_POS');
console.log(`\nc) POS_TO_NEG crosses: ${posToNeg.length}`);
if (posToNeg.length > 0) {
  const bearishFollow = posToNeg.filter(c => c.priceAfter30 < 0).length;
  console.log(`   Price fell after: ${bearishFollow}/${posToNeg.length} (${(bearishFollow / posToNeg.length * 100).toFixed(0)}%)`);
  console.log(`   Avg follow-through: ${(posToNeg.reduce((s, c) => s + c.priceAfter30, 0) / posToNeg.length).toFixed(2)} pts`);
}
console.log(`   NEG_TO_POS crosses: ${negToPos.length}`);
if (negToPos.length > 0) {
  const bullishFollow = negToPos.filter(c => c.priceAfter30 > 0).length;
  console.log(`   Price rose after: ${bullishFollow}/${negToPos.length} (${(bullishFollow / negToPos.length * 100).toFixed(0)}%)`);
  console.log(`   Avg follow-through: ${(negToPos.reduce((s, c) => s + c.priceAfter30, 0) / negToPos.length).toFixed(2)} pts`);
}

// d) Zero-cross level as S/R
console.log('\nd) Zero-cross as S/R:');
let srRespected = 0, srTotal = 0;
for (const zd of zeroCrossDays) {
  for (const cross of zd.crosses) {
    const day = days.find(d => d.date === zd.date);
    if (!day) continue;
    const frames = day.frames;
    const crossLevel = cross.spotAtCross;
    // Check if price bounced off this level later in the day
    const crossIdx = Math.floor(cross.frameIdx * frames.length);
    let touchedLater = false, bouncedLater = false;
    for (let i = crossIdx + 30; i < frames.length; i++) {
      if (Math.abs(frames[i].SPXW.spot - crossLevel) < 3) {
        touchedLater = true;
        // Did it bounce?
        if (i + 10 < frames.length) {
          const futureMove = Math.abs(frames[i + 10].SPXW.spot - crossLevel);
          if (futureMove > 3) bouncedLater = true;
        }
      }
    }
    if (touchedLater) {
      srTotal++;
      if (bouncedLater) srRespected++;
    }
  }
}
if (srTotal > 0) {
  console.log(`   Zero-cross level retested: ${srTotal} times`);
  console.log(`   Acted as S/R (bounced >3pts): ${srRespected}/${srTotal} (${(srRespected / srTotal * 100).toFixed(0)}%)`);
}

// ═══════════════════════════════════════════════
// STEP 5: CROSS-INSTRUMENT CORRELATION
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 5: SPX vs QQQ vs SPY CORRELATION');
console.log('═'.repeat(70));

// a) Divergence analysis
console.log('\na) GEX Regime Divergence:');
let allAligned = 0, diverged = 0;
const divergenceDays = [];
for (const d of days) {
  if (d.spyOpenGex === undefined || d.qqqOpenGex === undefined) continue;
  const spxRegime = d.openNetGex > 0 ? 'POS' : 'NEG';
  const spyRegime = d.spyOpenGex > 0 ? 'POS' : 'NEG';
  const qqqRegime = d.qqqOpenGex > 0 ? 'POS' : 'NEG';

  if (spxRegime === spyRegime && spyRegime === qqqRegime) {
    allAligned++;
  } else {
    diverged++;
    divergenceDays.push({
      date: d.date,
      spx: spxRegime, spy: spyRegime, qqq: qqqRegime,
      spxChange: d.changePct,
      dayType: d.dayType,
      range: d.range
    });
  }
}
console.log(`   All 3 aligned: ${allAligned} days | Diverged: ${diverged} days`);

// Aligned vs diverged outcomes
const alignedDays = days.filter(d => {
  if (d.spyOpenGex === undefined) return false;
  const sr = d.openNetGex > 0 ? 'POS' : 'NEG';
  const spr = d.spyOpenGex > 0 ? 'POS' : 'NEG';
  const qr = d.qqqOpenGex > 0 ? 'POS' : 'NEG';
  return sr === spr && spr === qr;
});

if (alignedDays.length > 0) {
  const alignedAvgRange = alignedDays.reduce((s, d) => s + d.range, 0) / alignedDays.length;
  const alignedAvgAbsMove = alignedDays.reduce((s, d) => s + Math.abs(d.openToClose), 0) / alignedDays.length;
  console.log(`\n   Aligned days avg range: ${alignedAvgRange.toFixed(1)} pts | avg |move|: ${alignedAvgAbsMove.toFixed(1)} pts`);
}
if (divergenceDays.length > 0) {
  const divAvgRange = divergenceDays.reduce((s, d) => s + d.range, 0) / divergenceDays.length;
  console.log(`   Diverged days avg range: ${divAvgRange.toFixed(1)} pts`);

  console.log('\n   Divergence details:');
  for (const d of divergenceDays) {
    console.log(`     ${d.date}: SPX=${d.spx} SPY=${d.spy} QQQ=${d.qqq} | ${d.dayType} | range ${d.range.toFixed(1)} | ${d.spxChange >= 0 ? '+' : ''}${d.spxChange.toFixed(3)}%`);
  }
}

// b) All-same-regime prediction
console.log('\nb) All-positive vs All-negative regime:');
const allPos = alignedDays.filter(d => d.openNetGex > 0);
const allNeg = alignedDays.filter(d => d.openNetGex <= 0);
if (allPos.length > 0) {
  const avgRange = allPos.reduce((s, d) => s + d.range, 0) / allPos.length;
  const avgMove = allPos.reduce((s, d) => s + d.openToClose, 0) / allPos.length;
  const upDays = allPos.filter(d => d.openToClose > 0).length;
  console.log(`   All POSITIVE: ${allPos.length} days | avg range ${avgRange.toFixed(1)} | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} | up ${upDays}/${allPos.length}`);
}
if (allNeg.length > 0) {
  const avgRange = allNeg.reduce((s, d) => s + d.range, 0) / allNeg.length;
  const avgMove = allNeg.reduce((s, d) => s + d.openToClose, 0) / allNeg.length;
  const upDays = allNeg.filter(d => d.openToClose > 0).length;
  console.log(`   All NEGATIVE: ${allNeg.length} days | avg range ${avgRange.toFixed(1)} | avg move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} | up ${upDays}/${allNeg.length}`);
}

// c) Most predictive instrument
console.log('\nc) GEX-Price direction correlation by instrument:');
for (const instrument of ['SPXW', 'SPY', 'QQQ']) {
  let correct = 0, total = 0;
  for (const d of days) {
    let avgGex;
    if (instrument === 'SPXW') avgGex = d.avgGex;
    else if (instrument === 'SPY') avgGex = d.spyAvgGex;
    else avgGex = d.qqqAvgGex;
    if (avgGex === undefined || isNaN(avgGex)) continue;
    total++;
    // Positive GEX should predict mean reversion (smaller range, pull back to open)
    // Negative GEX should predict momentum (larger range, directional)
    // We test: does the sign of avg GEX predict whether it's a chop or trend day?
    const isTrend = Math.abs(d.changePct) > 0.15;
    const isNegGex = avgGex < 0;
    if ((isTrend && isNegGex) || (!isTrend && !isNegGex)) correct++;
  }
  if (total > 0) {
    console.log(`   ${instrument}: trend/chop prediction accuracy ${correct}/${total} (${(correct / total * 100).toFixed(0)}%)`);
  }
}

// ═══════════════════════════════════════════════
// STEP 6: SIGNAL EXTRACTION
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 6: SIGNAL EXTRACTION');
console.log('═'.repeat(70));

// Signal 1: High positive GEX + price at wall → FADE
console.log('\n─── SIGNAL 1: HIGH GEX WALL FADE ───');
let s1Hits = 0, s1Wins = 0, s1TotalMove = 0;
for (const d of days) {
  if (d.openNetGex / 1e6 < HIGH_POS_THRESHOLD) continue;
  for (const wi of d.wallInteractions) {
    if (wi.gamma > 0 && wi.touched) {
      s1Hits++;
      const rejected = wi.rejectedCount > 0 && !wi.broke;
      if (rejected) {
        s1Wins++;
        s1TotalMove += Math.abs(wi.gamma / 1e6); // proxy for move magnitude
      }
    }
  }
}
console.log(`  Condition: GEX > ${HIGH_POS_THRESHOLD.toFixed(0)}M at open + price touches positive wall`);
console.log(`  Observations: ${s1Hits} | Win rate: ${s1Hits > 0 ? (s1Wins / s1Hits * 100).toFixed(0) : 0}%`);
console.log(`  Confidence: ${s1Hits >= 20 ? 'HIGH' : s1Hits >= 10 ? 'MEDIUM' : 'LOW'}`);

// Signal 2: Negative GEX + momentum → FOLLOW
console.log('\n─── SIGNAL 2: NEGATIVE GEX MOMENTUM FOLLOW ───');
let s2Hits = 0, s2Wins = 0;
for (const d of days) {
  if (d.openNetGex >= 0) continue;
  // 10AM reading confirms direction
  const tenAmIdx = Math.floor(d.frames.length * 0.08);
  if (tenAmIdx >= d.frames.length) continue;
  const tenAmSpot = d.frames[tenAmIdx].SPXW.spot;
  const direction = tenAmSpot > d.openSpot ? 'UP' : 'DOWN';
  s2Hits++;
  // Did it continue?
  if (direction === 'UP' && d.closeSpot > tenAmSpot) s2Wins++;
  if (direction === 'DOWN' && d.closeSpot < tenAmSpot) s2Wins++;
}
console.log(`  Condition: GEX < 0 at open + 10AM direction established`);
console.log(`  Observations: ${s2Hits} | Win rate: ${s2Hits > 0 ? (s2Wins / s2Hits * 100).toFixed(0) : 0}%`);
console.log(`  Confidence: ${s2Hits >= 20 ? 'HIGH' : s2Hits >= 10 ? 'MEDIUM' : 'LOW'}`);

// Signal 3: Zero-cross → direction change
console.log('\n─── SIGNAL 3: ZERO-CROSS DIRECTION CHANGE ───');
const s3ptn = allCrosses.filter(c => c.direction === 'POS_TO_NEG');
const s3ntp = allCrosses.filter(c => c.direction === 'NEG_TO_POS');
console.log(`  POS_TO_NEG: ${s3ptn.length} obs | bearish follow: ${s3ptn.filter(c => c.priceAfter30 < 0).length}/${s3ptn.length} (${s3ptn.length > 0 ? (s3ptn.filter(c => c.priceAfter30 < 0).length / s3ptn.length * 100).toFixed(0) : 0}%)`);
console.log(`  NEG_TO_POS: ${s3ntp.length} obs | bullish follow: ${s3ntp.filter(c => c.priceAfter30 > 0).length}/${s3ntp.length} (${s3ntp.length > 0 ? (s3ntp.filter(c => c.priceAfter30 > 0).length / s3ntp.length * 100).toFixed(0) : 0}%)`);

// Signal 4: All instruments aligned positive → mean reversion day
console.log('\n─── SIGNAL 4: TRIPLE POSITIVE ALIGNMENT → RANGE BOUND ───');
if (allPos.length > 0) {
  const rangeUnder30 = allPos.filter(d => d.range < 30).length;
  console.log(`  Condition: SPX + SPY + QQQ all positive GEX at open`);
  console.log(`  Range < 30pts: ${rangeUnder30}/${allPos.length} (${(rangeUnder30 / allPos.length * 100).toFixed(0)}%)`);
  console.log(`  Avg range: ${(allPos.reduce((s, d) => s + d.range, 0) / allPos.length).toFixed(1)} pts`);
  console.log(`  Confidence: ${allPos.length >= 20 ? 'HIGH' : allPos.length >= 10 ? 'MEDIUM' : 'LOW'}`);
}

// Signal 5: GEX delta (change from prior frame) > threshold → momentum entry
console.log('\n─── SIGNAL 5: GEX DELTA MOMENTUM ───');
let s5Hits = 0, s5Wins = 0, s5TotalMove = 0;
for (const d of days) {
  const frames = d.frames;
  for (let i = 30; i < frames.length - 30; i++) {
    const gexNow = frames[i].SPXW.netGex / 1e6;
    const gex30Ago = frames[i - 30].SPXW.netGex / 1e6;
    const delta = gexNow - gex30Ago;
    if (Math.abs(delta) > 20) { // Large delta = regime shift
      s5Hits++;
      const spotNow = frames[i].SPXW.spot;
      const spotFuture = frames[Math.min(i + 30, frames.length - 1)].SPXW.spot;
      const move = spotFuture - spotNow;
      // Positive delta = stabilizing, should see mean reversion
      // Negative delta = destabilizing, should see momentum
      if ((delta < 0 && move < 0) || (delta > 0 && move > 0)) {
        s5Wins++;
        s5TotalMove += Math.abs(move);
      }
    }
  }
}
console.log(`  Condition: 30-frame GEX delta > 20M`);
console.log(`  Observations: ${s5Hits} | Win rate: ${s5Hits > 0 ? (s5Wins / s5Hits * 100).toFixed(0) : 0}%`);
console.log(`  Avg winning move: ${s5Wins > 0 ? (s5TotalMove / s5Wins).toFixed(2) : 0} pts`);
console.log(`  Confidence: ${s5Hits >= 20 ? 'HIGH' : s5Hits >= 10 ? 'MEDIUM' : 'LOW'}`);

// Signal 6: Large wall + price approaching → reversal
console.log('\n─── SIGNAL 6: LARGE WALL APPROACH REVERSAL ───');
let s6Hits = 0, s6Wins = 0, s6Moves = [];
for (const d of days) {
  const frames = d.frames;
  for (let i = 10; i < frames.length - 30; i++) {
    const walls = frames[i].SPXW.walls;
    const spot = frames[i].SPXW.spot;
    for (const wall of walls.slice(0, 3)) {
      if (Math.abs(wall.gamma) < 10e6) continue; // Only large walls (>$10M)
      const dist = wall.strike - spot;
      if (Math.abs(dist) > 3 && Math.abs(dist) < 10) {
        // Approaching a large wall
        s6Hits++;
        const futureSpot = frames[Math.min(i + 15, frames.length - 1)].SPXW.spot;
        const futureDist = futureSpot - spot;
        // Expect reversal: if approaching from below (dist > 0), price should pull back
        if ((dist > 0 && futureDist < 0) || (dist < 0 && futureDist > 0)) {
          s6Wins++;
          s6Moves.push(Math.abs(futureDist));
        }
      }
    }
  }
}
console.log(`  Condition: Price within 3-10pts of >$10M wall`);
console.log(`  Observations: ${s6Hits} | Win rate: ${s6Hits > 0 ? (s6Wins / s6Hits * 100).toFixed(0) : 0}%`);
console.log(`  Avg reversal move: ${s6Moves.length > 0 ? (s6Moves.reduce((s, v) => s + v, 0) / s6Moves.length).toFixed(2) : 0} pts`);
console.log(`  Confidence: ${s6Hits >= 20 ? 'HIGH' : s6Hits >= 10 ? 'MEDIUM' : 'LOW'}`);

// Signal 7: Opening GEX as day-type predictor
console.log('\n─── SIGNAL 7: OPENING GEX DAY-TYPE PREDICTION ───');
const gexBuckets = [
  { name: 'Strong Negative (<-20M)', filter: d => d.openNetGex / 1e6 < -20 },
  { name: 'Weak Negative (-20M to 0)', filter: d => d.openNetGex / 1e6 >= -20 && d.openNetGex / 1e6 < 0 },
  { name: 'Weak Positive (0 to 50M)', filter: d => d.openNetGex / 1e6 >= 0 && d.openNetGex / 1e6 < 50 },
  { name: 'Strong Positive (>50M)', filter: d => d.openNetGex / 1e6 >= 50 },
];
for (const bucket of gexBuckets) {
  const bDays = days.filter(bucket.filter);
  if (bDays.length === 0) continue;
  const avgRange = bDays.reduce((s, d) => s + d.range, 0) / bDays.length;
  const avgMove = bDays.reduce((s, d) => s + d.openToClose, 0) / bDays.length;
  const upPct = bDays.filter(d => d.openToClose > 0).length / bDays.length * 100;
  console.log(`  ${bucket.name}: ${bDays.length} days | range ${avgRange.toFixed(1)} | move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)} | up ${upPct.toFixed(0)}%`);
}

// ═══════════════════════════════════════════════
// STEP 7: REGIME LOOKUP TABLE
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('STEP 7: REGIME LOOKUP TABLE');
console.log('═'.repeat(70));

console.log('\n  GEX Regime     | Expected Behavior           | Trade Bias          | Risk Profile      | Best Instrument');
console.log('  ───────────────|─────────────────────────────|─────────────────────|───────────────────|────────────────');

// Build from actual data
for (const [regime, daysInRegime] of Object.entries(regimes)) {
  if (daysInRegime.length === 0) continue;
  const avgRange = daysInRegime.reduce((s, d) => s + d.range, 0) / daysInRegime.length;
  const avgAbsMove = daysInRegime.reduce((s, d) => s + Math.abs(d.openToClose), 0) / daysInRegime.length;
  const upPct = daysInRegime.filter(d => d.openToClose > 0).length / daysInRegime.length * 100;
  const moveRatio = avgAbsMove / avgRange; // Higher = more trending

  let behavior, bias, risk;
  if (avgRange < 25) {
    behavior = 'Range-bound, pinned';
    bias = 'FADE MOVES';
    risk = 'TIGHT STOPS';
  } else if (moveRatio > 0.4) {
    behavior = 'Directional, trending';
    bias = 'FOLLOW MOMENTUM';
    risk = 'WIDE STOPS';
  } else {
    behavior = 'Mixed, volatile';
    bias = 'WAIT FOR CONFIRMATION';
    risk = 'TIGHT STOPS';
  }

  const regimeName = regime.padEnd(15);
  const behaviorStr = `${behavior} (${avgRange.toFixed(0)}pt range)`.padEnd(29);
  const biasStr = bias.padEnd(21);
  const riskStr = risk.padEnd(19);
  console.log(`  ${regimeName}| ${behaviorStr}| ${biasStr}| ${riskStr}| SPX`);
}

// ═══════════════════════════════════════════════
// RAW DATA DUMP (for manual review)
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log('APPENDIX: PER-DAY RAW DATA');
console.log('═'.repeat(70));
console.log('\n  Date       | Type          | Open GEX(M) | Range  | O→C     | SPY GEX(M) | QQQ GEX(M) | Zero-X?');
console.log('  ──────────-|───────────────|─────────────|────────|─────────|────────────|────────────|────────');
for (const d of days) {
  const gex = (d.openNetGex / 1e6).toFixed(1).padStart(7);
  const range = d.range.toFixed(1).padStart(6);
  const otc = `${d.openToClose >= 0 ? '+' : ''}${d.openToClose.toFixed(1)}`.padStart(7);
  const spyGex = d.spyOpenGex !== undefined ? (d.spyOpenGex / 1e6).toFixed(1).padStart(7) : '    N/A';
  const qqqGex = d.qqqOpenGex !== undefined ? (d.qqqOpenGex / 1e6).toFixed(1).padStart(7) : '    N/A';
  const zx = d.zeroCrossed ? 'YES' : '  -';
  console.log(`  ${d.date} | ${d.dayType.padEnd(13)} | ${gex}M   | ${range} | ${otc} | ${spyGex}M  | ${qqqGex}M  | ${zx}`);
}
