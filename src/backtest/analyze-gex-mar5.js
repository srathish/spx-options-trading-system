/**
 * GEX Replay Analysis — 2026-03-05
 *
 * Reads the raw GEX replay JSON and produces:
 *   1. Opening GEX profile (09:30 ET)
 *   2. Spot price movement every 30 minutes
 *   3. Biggest walls (>$10M) and their evolution
 *   4. GEX@spot at each 30-minute checkpoint
 *   5. Key regime shifts (GEX@spot sign changes)
 *   6. Closing GEX profile
 */

import { readFileSync } from 'fs';

const DATA_PATH = '/Users/saiyeeshrathish/gex-data-replay-reader/data/gex-replay-2026-03-05.json';
const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const { frames } = data;

// ── Helpers ────────────────────────────────────────────────────────────────

function toET(utcIso) {
  const d = new Date(utcIso);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}

function totalGamma(frame, strikeIdx) {
  return frame.gammaValues[strikeIdx].reduce((s, v) => s + v, 0);
}

function gexProfile(frame) {
  return frame.strikes.map((strike, i) => ({
    strike,
    gamma: totalGamma(frame, i),
  }));
}

/**
 * GEX@spot — interpolate gamma between the two strikes bracketing spot.
 */
function gexAtSpot(frame) {
  const { strikes, spotPrice } = frame;
  // Find the first strike >= spotPrice
  let upperIdx = strikes.findIndex(s => s >= spotPrice);
  if (upperIdx <= 0) upperIdx = 1;
  const lowerIdx = upperIdx - 1;

  const lowerStrike = strikes[lowerIdx];
  const upperStrike = strikes[upperIdx];
  const lowerGamma = totalGamma(frame, lowerIdx);
  const upperGamma = totalGamma(frame, upperIdx);

  // Linear interpolation
  const frac = (spotPrice - lowerStrike) / (upperStrike - lowerStrike);
  return lowerGamma + frac * (upperGamma - lowerGamma);
}

function fmt(n) { return (n / 1e6).toFixed(2); }
function fmtK(n) { return (n / 1e3).toFixed(0) + 'K'; }

function printProfile(frame, label) {
  const profile = gexProfile(frame);
  const sorted = [...profile].sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma));
  const topN = sorted.slice(0, 15);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}  |  Spot: $${frame.spotPrice.toFixed(2)}  |  Time: ${toET(frame.timestamp)} ET`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  ${'Strike'.padEnd(10)} ${'Total GEX'.padStart(12)}   ${'Bar'}`);
  console.log(`  ${'─'.repeat(60)}`);

  // For bar chart scaling
  const maxAbs = Math.max(...topN.map(t => Math.abs(t.gamma)));

  topN.sort((a, b) => a.strike - b.strike);
  for (const t of topN) {
    const val = fmt(t.gamma);
    const barLen = Math.round((Math.abs(t.gamma) / maxAbs) * 30);
    const bar = t.gamma >= 0
      ? '+'.repeat(barLen)
      : '-'.repeat(barLen);
    const marker = Math.abs(t.strike - frame.spotPrice) <= 5 ? ' <-- SPOT' : '';
    console.log(`  ${String(t.strike).padEnd(10)} ${val.padStart(10)}M   ${bar}${marker}`);
  }

  const gas = gexAtSpot(frame);
  console.log(`\n  GEX@Spot: ${fmt(gas)}M  (${gas >= 0 ? 'POSITIVE — supportive/pinning' : 'NEGATIVE — volatile/repelling'})`);
}

// ── 1. Opening Profile ────────────────────────────────────────────────────

const openFrame = frames[0]; // 14:30 UTC = 09:30 ET
printProfile(openFrame, '1. OPENING PROFILE (09:30 ET)');

// ── 2 & 4. Spot Movement + GEX@Spot every 30 min ─────────────────────────

console.log(`\n\n${'═'.repeat(70)}`);
console.log(`  2 & 4. SPOT PRICE + GEX@SPOT — 30-MINUTE CHECKPOINTS`);
console.log(`${'═'.repeat(70)}`);
console.log(`  ${'Time'.padEnd(8)} ${'Spot'.padStart(10)} ${'Chg'.padStart(8)} ${'GEX@Spot'.padStart(12)} ${'Regime'.padStart(12)} ${'Nearest Wall'.padStart(20)}`);
console.log(`  ${'─'.repeat(68)}`);

const checkpoints = [];
const thirtyMin = 30 * 60 * 1000;
const startTime = new Date(frames[0].timestamp).getTime();
const endTime = new Date(frames[frames.length - 1].timestamp).getTime();

let prevSpot = null;
for (let t = startTime; t <= endTime; t += thirtyMin) {
  // Find nearest frame
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const diff = Math.abs(new Date(frames[i].timestamp).getTime() - t);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  const frame = frames[bestIdx];
  const spot = frame.spotPrice;
  const gas = gexAtSpot(frame);
  const chg = prevSpot !== null ? (spot - prevSpot).toFixed(2) : '---';
  const regime = gas >= 0 ? 'POSITIVE' : 'NEGATIVE';

  // Find nearest big wall (|gamma| > 2M) to spot
  const profile = gexProfile(frame);
  const walls = profile
    .filter(p => Math.abs(p.gamma) > 2e6)
    .map(p => ({ ...p, dist: Math.abs(p.strike - spot) }))
    .sort((a, b) => a.dist - b.dist);
  const nearestWall = walls[0] ? `${walls[0].strike} (${fmt(walls[0].gamma)}M)` : 'none';

  console.log(`  ${toET(frame.timestamp).padEnd(8)} ${('$' + spot.toFixed(2)).padStart(10)} ${String(chg).padStart(8)} ${(fmt(gas) + 'M').padStart(12)} ${regime.padStart(12)} ${nearestWall.padStart(20)}`);
  checkpoints.push({ time: toET(frame.timestamp), spot, gas, regime, frame, frameIdx: bestIdx });
  prevSpot = spot;
}

// ── 3. Biggest Walls and Evolution ────────────────────────────────────────

console.log(`\n\n${'═'.repeat(70)}`);
console.log(`  3. BIG WALL EVOLUTION (|GEX| > $5M at any point)`);
console.log(`${'═'.repeat(70)}`);

// First find all strikes that ever had |gamma| > 5M
const bigWallStrikes = new Set();
for (const frame of frames) {
  frame.strikes.forEach((strike, i) => {
    if (Math.abs(totalGamma(frame, i)) > 5e6) {
      bigWallStrikes.add(strike);
    }
  });
}

const wallStrikes = [...bigWallStrikes].sort((a, b) => a - b);
console.log(`\n  Strikes that hit >$5M at any point: ${wallStrikes.join(', ')}`);

// Track evolution at checkpoints
console.log(`\n  ${'Strike'.padEnd(8)} ${checkpoints.map(c => c.time.padStart(8)).join(' ')}`);
console.log(`  ${'─'.repeat(8 + checkpoints.length * 9)}`);

for (const strike of wallStrikes) {
  const row = [String(strike).padEnd(8)];
  for (const cp of checkpoints) {
    const sIdx = cp.frame.strikes.indexOf(strike);
    if (sIdx === -1) {
      row.push('   ---  ');
    } else {
      const g = totalGamma(cp.frame, sIdx);
      row.push((fmt(g) + 'M').padStart(8));
    }
  }
  console.log(`  ${row.join(' ')}`);
}

// ── 5. Regime Shifts ─────────────────────────────────────────────────────

console.log(`\n\n${'═'.repeat(70)}`);
console.log(`  5. REGIME SHIFTS (GEX@Spot sign changes)`);
console.log(`${'═'.repeat(70)}`);

let prevSign = null;
let regimeShifts = [];
// Check every frame for sign changes
for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  const gas = gexAtSpot(frame);
  const sign = gas >= 0 ? 'POSITIVE' : 'NEGATIVE';

  if (prevSign !== null && sign !== prevSign) {
    regimeShifts.push({
      time: toET(frame.timestamp),
      spot: frame.spotPrice,
      gas,
      from: prevSign,
      to: sign,
      frameIdx: i,
    });
  }
  prevSign = sign;
}

if (regimeShifts.length === 0) {
  console.log('\n  No regime shifts detected — GEX@spot stayed same sign all day.');
} else {
  // Consolidate rapid oscillations: group shifts within 3 minutes
  const consolidated = [];
  for (const shift of regimeShifts) {
    const last = consolidated[consolidated.length - 1];
    if (last && shift.frameIdx - last.frameIdx <= 3 && shift.to === last.from) {
      // Oscillation — update the last entry to note it
      last.oscillation = true;
    } else {
      consolidated.push({ ...shift });
    }
  }

  console.log(`\n  Total raw sign changes: ${regimeShifts.length}`);
  console.log(`  Sustained regime shifts (>3 min apart):\n`);

  // Show sustained shifts
  const sustained = consolidated.filter(s => !s.oscillation);

  if (sustained.length === 0) {
    console.log('  All sign changes were rapid oscillations (spot near zero-gamma boundary).');
    // Still show the raw data grouped
    console.log('\n  Oscillation zones:');
    let zoneStart = regimeShifts[0];
    let zoneEnd = regimeShifts[0];
    for (let i = 1; i < regimeShifts.length; i++) {
      if (regimeShifts[i].frameIdx - zoneEnd.frameIdx <= 5) {
        zoneEnd = regimeShifts[i];
      } else {
        console.log(`    ${zoneStart.time}-${zoneEnd.time} ET | Spot ~$${zoneStart.spot.toFixed(0)}-$${zoneEnd.spot.toFixed(0)} | ${zoneEnd.frameIdx - zoneStart.frameIdx + 1} flips`);
        zoneStart = regimeShifts[i];
        zoneEnd = regimeShifts[i];
      }
    }
    console.log(`    ${zoneStart.time}-${zoneEnd.time} ET | Spot ~$${zoneStart.spot.toFixed(0)}-$${zoneEnd.spot.toFixed(0)} | ${zoneEnd.frameIdx - zoneStart.frameIdx + 1} flips`);
  } else {
    for (const s of sustained) {
      console.log(`  ${s.time} ET | Spot: $${s.spot.toFixed(2)} | ${s.from} -> ${s.to} | GEX@Spot: ${fmt(s.gas)}M`);
    }
  }

  // Also show high-level regime periods
  console.log('\n  Regime periods:');
  let periodStart = { time: toET(frames[0].timestamp), regime: gexAtSpot(frames[0]) >= 0 ? 'POSITIVE' : 'NEGATIVE', spot: frames[0].spotPrice };
  for (const shift of regimeShifts) {
    // Only log sustained changes
    if (shift.frameIdx > 5 || regimeShifts.indexOf(shift) === 0) {
      // Check if this shift is sustained (next shift not within 3 frames)
      const nextIdx = regimeShifts.indexOf(shift) + 1;
      const isSustained = nextIdx >= regimeShifts.length || regimeShifts[nextIdx].frameIdx - shift.frameIdx > 5;
      if (isSustained && shift.to !== periodStart.regime) {
        console.log(`    ${periodStart.time} - ${shift.time} ET: ${periodStart.regime} (Spot $${periodStart.spot.toFixed(0)} -> $${shift.spot.toFixed(0)})`);
        periodStart = { time: shift.time, regime: shift.to, spot: shift.spot };
      }
    }
  }
  const lastFrame = frames[frames.length - 1];
  console.log(`    ${periodStart.time} - ${toET(lastFrame.timestamp)} ET: ${periodStart.regime} (Spot $${periodStart.spot.toFixed(0)} -> $${lastFrame.spotPrice.toFixed(0)})`);
}

// ── 6. Closing Profile ────────────────────────────────────────────────────

const closeFrame = frames[frames.length - 1];
printProfile(closeFrame, '6. CLOSING PROFILE (16:00 ET)');

// ── 7. Day Summary ────────────────────────────────────────────────────────

console.log(`\n\n${'═'.repeat(70)}`);
console.log(`  7. DAY SUMMARY & TRADING IMPLICATIONS`);
console.log(`${'═'.repeat(70)}`);

const dayHigh = Math.max(...frames.map(f => f.spotPrice));
const dayLow = Math.min(...frames.map(f => f.spotPrice));
const dayOpen = frames[0].spotPrice;
const dayClose = frames[frames.length - 1].spotPrice;
const dayRange = dayHigh - dayLow;

console.log(`\n  Open:  $${dayOpen.toFixed(2)}`);
console.log(`  High:  $${dayHigh.toFixed(2)}  (${frames.findIndex(f => f.spotPrice === dayHigh)} min from open)`);
console.log(`  Low:   $${dayLow.toFixed(2)}  (${frames.findIndex(f => f.spotPrice === dayLow)} min from open)`);
console.log(`  Close: $${dayClose.toFixed(2)}`);
console.log(`  Range: $${dayRange.toFixed(2)}  (${(dayRange / dayOpen * 100).toFixed(2)}%)`);
console.log(`  Day:   ${dayClose >= dayOpen ? 'UP' : 'DOWN'} $${Math.abs(dayClose - dayOpen).toFixed(2)} (${((dayClose - dayOpen) / dayOpen * 100).toFixed(3)}%)`);

// GEX@spot distribution
let posCount = 0, negCount = 0;
const gasValues = frames.map(f => gexAtSpot(f));
gasValues.forEach(g => g >= 0 ? posCount++ : negCount++);
console.log(`\n  GEX@Spot distribution:`);
console.log(`    POSITIVE: ${posCount} frames (${(posCount / frames.length * 100).toFixed(1)}%)`);
console.log(`    NEGATIVE: ${negCount} frames (${(negCount / frames.length * 100).toFixed(1)}%)`);

// Spot vs walls analysis
console.log(`\n  Key wall interactions:`);
const openProfile = gexProfile(openFrame);
const bigWalls = openProfile
  .filter(p => Math.abs(p.gamma) > 5e6)
  .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma));

for (const wall of bigWalls) {
  const touched = frames.some(f => Math.abs(f.spotPrice - wall.strike) <= 3);
  const dir = wall.gamma >= 0 ? 'SUPPORT/PIN' : 'REPEL/VOLATILE';
  console.log(`    ${wall.strike}: ${fmt(wall.gamma)}M (${dir}) — ${touched ? 'TOUCHED by spot' : 'Not reached'}`);
}

// Find where spot spent the most time (5-point buckets)
const buckets = {};
for (const f of frames) {
  const bucket = Math.round(f.spotPrice / 5) * 5;
  buckets[bucket] = (buckets[bucket] || 0) + 1;
}
const sortedBuckets = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
console.log(`\n  Price zones where spot dwelled most:`);
for (const [price, count] of sortedBuckets.slice(0, 8)) {
  const pct = (count / frames.length * 100).toFixed(1);
  const bar = '#'.repeat(Math.round(count / frames.length * 50));
  console.log(`    $${price}: ${count} min (${pct}%) ${bar}`);
}

console.log(`\n${'═'.repeat(70)}\n`);
