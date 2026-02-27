import 'dotenv/config';
import { fetchGexData } from './src/gex/gex-ingester.js';
import { parseGexResponse, identifyWalls } from './src/gex/gex-parser.js';
import { scoreSpxGex } from './src/gex/gex-scorer.js';
import { detectAllPatterns } from './src/gex/gex-patterns.js';
import { analyzeMultiTicker } from './src/gex/multi-ticker-analyzer.js';
import { initStrategyStore } from './src/review/strategy-store.js';
import { initTokenManager } from './src/gex/token-manager.js';

initTokenManager();
initStrategyStore();

const raw = await fetchGexData('SPXW');
const spot = raw.CurrentSpot;
const numRows = raw.GammaValues.length;
const strikeStep = 5;
const startStrike = Math.round((spot - (numRows / 2) * strikeStep) / strikeStep) * strikeStep;
const atmIdx = Math.round((spot - startStrike) / strikeStep);

console.log('========================================');
console.log('STAGE 1: RAW HEATSEEKER API');
console.log('========================================');
console.log('Spot:', spot);
console.log('Expirations:', JSON.stringify(raw.Expirations));
console.log('Grid:', numRows, 'strikes x', raw.GammaValues[0].length, 'expirations');
console.log('Top-level keys:', Object.keys(raw).join(', '));

const lo = Math.max(0, atmIdx - 20);
const hi = Math.min(numRows, atmIdx + 20);

console.log('\nRaw GammaValues (40 strikes near spot ' + spot + '):');
const expLabels = raw.Expirations || [];
console.log('Strike  | 0DTE(' + (expLabels[0]||'?').slice(5) + ') | ' + (expLabels[1]||'?').slice(5) + '       | ' + (expLabels[2]||'?').slice(5) + '       | ' + (expLabels[3]||'?').slice(5) + '       | ' + (expLabels[4]||'?').slice(5));
for (let i = lo; i < hi; i++) {
  const strike = startStrike + i * strikeStep;
  const row = raw.GammaValues[i];
  const marker = Math.abs(strike - spot) < 3 ? ' <<SPOT' : '';
  const vals = row.map(v => (v >= 0 ? '+' : '') + v.toFixed(0)).map(s => s.padStart(12)).join(' |');
  console.log(String(strike).padStart(6) + '  |' + vals + marker);
}

// STAGE 2
const parsed = parseGexResponse(raw, 'SPXW');
parsed.walls = identifyWalls(parsed);
console.log('\n========================================');
console.log('STAGE 2: PARSED (0DTE aggregated GEX)');
console.log('========================================');

console.log('\n0DTE GEX Map (±100 strikes from spot):');
const entries = [...parsed.aggregatedGex.entries()].sort((a,b) => a[0]-b[0]);
for (const [strike, val] of entries) {
  if (Math.abs(strike - spot) <= 100) {
    const barLen = Math.min(50, Math.round(Math.abs(val) / 200000));
    const bar = val > 0 ? '#'.repeat(barLen) : '-'.repeat(barLen);
    const marker = Math.abs(strike - spot) < 3 ? ' <<< SPOT' : '';
    console.log(String(strike).padStart(6) + ' | ' + ((val>=0?'+':'')+val.toFixed(0)).padStart(12) + ' | ' + bar + marker);
  }
}

console.log('\nWalls (all identified):');
for (const w of parsed.walls) {
  console.log('  ' + String(w.strike).padStart(6) + ' | ' + w.type.padEnd(8) + ' | GEX: ' + ((w.gexValue>=0?'+':'')+w.gexValue.toFixed(0)).padStart(12) + ' | abs: ' + w.absGexValue.toFixed(0).padStart(10) + ' | ' + w.relativeToSpot.padEnd(5) + ' | dist: ' + w.distancePct.toFixed(2) + '%');
}

// STAGE 3
const scored = scoreSpxGex(parsed);
console.log('\n========================================');
console.log('STAGE 3: SCORED');
console.log('========================================');
console.log('Score:', scored.score, scored.direction, '(' + scored.confidence + ')');
console.log('Environment:', scored.environment);
console.log('GEX at spot:', scored.gexAtSpot?.toFixed(0));
console.log('Target wall:', scored.targetWall ? scored.targetWall.strike + ' (' + scored.targetWall.type + ' GEX=' + scored.targetWall.gexValue?.toFixed(0) + ')' : 'NONE');
console.log('Floor wall:', scored.floorWall ? scored.floorWall.strike + ' (' + scored.floorWall.type + ' GEX=' + scored.floorWall.gexValue?.toFixed(0) + ')' : 'NONE');
console.log('Walls above spot:', scored.wallsAbove.map(w => w.strike + '(' + w.type[0] + ':' + w.gexValue?.toFixed(0) + ')').join(', '));
console.log('Walls below spot:', scored.wallsBelow.map(w => w.strike + '(' + w.type[0] + ':' + w.gexValue?.toFixed(0) + ')').join(', '));
console.log('Scoring breakdown:', scored.breakdown.join(' | '));

// STAGE 4 — build proper ticker state (mirrors buildTickerState in trinity.js)
const spotIdx = parsed.strikes.findIndex(s => s >= spot);
const stStartIdx = Math.max(0, spotIdx - 20);
const stEndIdx = Math.min(parsed.strikes.length, spotIdx + 20);
const stStrikes = [];
let stMaxAbsGex = 0;
for (let i = stStartIdx; i < stEndIdx; i++) {
  const strike = parsed.strikes[i];
  const gexValue = parsed.aggregatedGex.get(strike) || 0;
  stMaxAbsGex = Math.max(stMaxAbsGex, Math.abs(gexValue));
  stStrikes.push({ strike, gexValue });
}
let stLargestWall = null;
let stLargestAbsGex = 0;
for (const strike of parsed.strikes) {
  const gex = parsed.aggregatedGex.get(strike) || 0;
  if (Math.abs(gex) > stLargestAbsGex) {
    stLargestAbsGex = Math.abs(gex);
    stLargestWall = {
      strike, gexValue: gex, absGexValue: Math.abs(gex),
      type: gex > 0 ? 'positive' : 'negative',
      relativeToSpot: strike > spot ? 'above' : strike < spot ? 'below' : 'at',
      distanceFromSpot: Math.abs(strike - spot),
      distancePct: (Math.abs(strike - spot) / spot * 100),
    };
  }
}
const spxState = {
  ticker: 'SPXW', spotPrice: spot,
  scored: {
    score: scored.score, direction: scored.direction, confidence: scored.confidence,
    environment: scored.environment, envDetail: scored.envDetail,
    gexAtSpot: scored.gexAtSpot, smoothedGexAtSpot: scored.smoothedGexAtSpot,
    breakdown: scored.breakdown, targetWall: scored.targetWall, floorWall: scored.floorWall,
    distanceToTarget: scored.distanceToTarget, wallsAbove: scored.wallsAbove, wallsBelow: scored.wallsBelow,
  },
  strikes: stStrikes, maxAbsGex: stMaxAbsGex, topWalls: parsed.walls.slice(0, 10),
  largestWall: stLargestWall, wallTrends: [],
  aggregatedGex: parsed.aggregatedGex, allExpGex: parsed.allExpGex, vexMap: parsed.vexMap,
};
const multi = analyzeMultiTicker(spxState, null, null);

console.log('\n========================================');
console.log('STAGE 4: MULTI-TICKER INPUTS TO PATTERNS');
console.log('========================================');
console.log('\nStacked walls (SPXW):');
const stacked = multi?.stacked_walls?.filter(s => s.ticker === 'SPXW') || [];
for (const s of stacked) {
  console.log('  type=' + s.type + ' | strikes ' + s.startStrike + '-' + s.endStrike + ' | count=' + s.count + ' | sign=' + s.sign + ' | distPct=' + s.distFromSpotPct?.toFixed(2) + '%');
}

console.log('\nRug setups (SPXW):');
const rugs = multi?.rug_setups?.filter(r => r.ticker === 'SPXW') || [];
for (const r of rugs) {
  console.log('  type=' + r.type + ' | posStrike=' + r.posStrike + ' negStrike=' + r.negStrike + ' | distPct=' + r.distFromSpotPct?.toFixed(2) + '%');
}
if (!rugs.length) console.log('  (none)');

console.log('\nKing nodes (SPXW):');
console.log(JSON.stringify(multi?.king_nodes?.SPXW, null, 2));

console.log('\nWall classifications (SPXW):');
const wc = multi?.wall_classifications?.filter(w => w.ticker === 'SPXW') || [];
for (const w of wc.slice(0, 10)) {
  console.log('  ' + w.strike + ' | ' + w.classification + ' | ' + w.type + ' | near_spot=' + w.near_spot + ' | size_pct=' + w.size_pct?.toFixed(2));
}

// STAGE 5
console.log('\n========================================');
console.log('STAGE 5: PATTERN DETECTION');
console.log('========================================');

const patterns = detectAllPatterns(scored, parsed, multi, {});
console.log('Detected:', patterns.length, 'pattern(s)\n');
for (const p of patterns) {
  console.log('>>> ' + p.pattern + ' ' + p.direction + ' (' + p.confidence + ')');
  console.log('    entry=' + p.entry_strike + ' target=' + p.target_strike + ' stop=' + p.stop_strike);
  console.log('    reasoning:', p.reasoning);
  console.log('    walls:', JSON.stringify(p.walls));
  console.log();
}
if (!patterns.length) console.log('  (none detected — check why below)');

// WHY patterns might not fire
console.log('\n========================================');
console.log('PATTERN ELIGIBILITY DIAGNOSTIC');
console.log('========================================');

// TRIPLE_FLOOR/CEILING check
console.log('\nTRIPLE_FLOOR/CEILING:');
console.log('  Need: stacked_walls with count>=3 and midStrike within 1% of spot');
for (const s of stacked) {
  const midStrike = (s.startStrike + s.endStrike) / 2;
  const distPct = Math.abs(midStrike - spot) / spot * 100;
  console.log('  Stack: ' + s.type + ' ' + s.startStrike + '-' + s.endStrike + ' count=' + s.count + ' sign=' + s.sign + ' midDist=' + distPct.toFixed(2) + '% ' + (s.count >= 3 && distPct <= 1.0 ? 'ELIGIBLE' : 'SKIP'));
}

// RUG_PULL check
console.log('\nRUG_PULL/REVERSE_RUG:');
console.log('  Need: rug_setups from multi-ticker with SPXW and posStrike within 1% of spot');
if (rugs.length === 0) console.log('  No rug setups detected by multi-ticker');
for (const r of rugs) {
  console.log('  ' + r.type + ': pos=' + r.posStrike + ' neg=' + r.negStrike + ' dist=' + r.distFromSpotPct?.toFixed(2) + '% ' + (r.distFromSpotPct <= 1.0 ? 'ELIGIBLE' : 'TOO FAR'));
}

// KING_NODE check
console.log('\nKING_NODE_BOUNCE:');
const kn = multi?.king_nodes?.SPXW;
if (kn) {
  console.log('  King node: strike=' + kn.strike + ' type=' + kn.type + ' isNear=' + kn.isNear + ' size_pct=' + kn.size_pct?.toFixed(2));
  if (!kn.isNear) console.log('  SKIP: not near spot');
  if (kn.type === 'negative') console.log('  SKIP: negative type (magnet, not bounce)');
} else {
  console.log('  No king node detected');
}

// PIKA_PILLOW check
console.log('\nPIKA_PILLOW:');
console.log('  Need: floorWall (positive below spot) + gexAtSpot < 0 + floor within 0.3% of spot');
if (scored.floorWall) {
  const distPct = Math.abs(scored.floorWall.strike - spot) / spot * 100;
  console.log('  Floor: ' + scored.floorWall.strike + ' type=' + scored.floorWall.type + ' dist=' + distPct.toFixed(2) + '%');
  console.log('  gexAtSpot: ' + scored.gexAtSpot?.toFixed(0) + ' (' + (scored.gexAtSpot < 0 ? 'NEGATIVE OK' : 'POSITIVE — SKIP') + ')');
  console.log('  ' + (scored.floorWall.type === 'positive' && scored.gexAtSpot < 0 && distPct <= 0.3 ? 'ELIGIBLE' : 'SKIP'));
} else {
  console.log('  No floor wall — SKIP');
}

// AIR_POCKET check
console.log('\nAIR_POCKET:');
console.log('  Need: targetWall + gexAtSpot < 0 + targetWall.type === negative');
if (scored.targetWall) {
  console.log('  Target: ' + scored.targetWall.strike + ' type=' + scored.targetWall.type);
  console.log('  gexAtSpot: ' + scored.gexAtSpot?.toFixed(0) + ' (' + (scored.gexAtSpot < 0 ? 'NEGATIVE OK' : 'POSITIVE — SKIP') + ')');
  console.log('  ' + (scored.targetWall.type === 'negative' && scored.gexAtSpot < 0 ? 'ELIGIBLE' : 'SKIP: target type=' + scored.targetWall.type));
} else {
  console.log('  No target wall — SKIP');
}

// RANGE_EDGE_FADE check
console.log('\nRANGE_EDGE_FADE:');
console.log('  Need: GATEKEEPER classification near spot, positive type');
const gatekeepers = wc.filter(w => w.classification === 'GATEKEEPER' && w.near_spot && w.type === 'positive');
if (gatekeepers.length === 0) console.log('  No qualifying gatekeepers near spot');
for (const g of gatekeepers) {
  console.log('  Gatekeeper: ' + g.strike + ' size_pct=' + g.size_pct?.toFixed(2) + ' ELIGIBLE');
}

process.exit(0);
