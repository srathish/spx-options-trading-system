/**
 * Wall Narrative Tool
 * Traces the evolution of GEX walls throughout a trading day from stored snapshots.
 * Usage: node src/backtest/wall-narrative.js <YYYY-MM-DD>
 */

import { getRawSnapshotsByDateTicker, reconstructParsedData } from '../store/db.js';
import { identifyWalls } from '../gex/gex-parser.js';

const dateStr = process.argv[2] || '2026-03-02';
const rows = getRawSnapshotsByDateTicker(dateStr, 'SPXW');

if (rows.length === 0) {
  console.error(`No SPXW snapshots for ${dateStr}`);
  process.exit(1);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  GEX Wall Narrative: ${dateStr} (${rows.length} SPXW snapshots)`);
console.log(`${'='.repeat(70)}\n`);

// Sample at specific times to catch key phases
const targetTimes = [
  '09:35', '09:40', '09:45', '09:50', '09:55',
  '10:00', '10:05', '10:10', '10:15', '10:20', '10:25', '10:30', '10:35', '10:40', '10:45', '10:50',
  '11:00', '11:10', '11:20', '11:30', '11:40', '11:50',
  '12:00', '12:15', '12:30', '12:45',
  '13:00', '13:15', '13:30', '13:45',
  '14:00', '14:15', '14:30', '14:45',
  '15:00', '15:15', '15:25',
];

// Find closest snapshot to each target time
let lastKing = '';
let lastPhase = '';

for (const target of targetTimes) {
  const [th, tm] = target.split(':').map(Number);
  const targetMin = th * 60 + tm;

  // Find closest row
  let bestRow = null;
  let bestDist = Infinity;
  for (const row of rows) {
    const parts = row.timestamp.split(' ')[1].split(':');
    const rowMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    const dist = Math.abs(rowMin - targetMin);
    if (dist < bestDist) {
      bestDist = dist;
      bestRow = row;
    }
  }
  if (!bestRow || bestDist > 3) continue;

  const parsed = reconstructParsedData(bestRow);
  const walls = identifyWalls(parsed);
  const spot = bestRow.spot_price;
  const ts = bestRow.timestamp.split(' ')[1].substring(0, 5);
  const score = bestRow.scored_score;
  const dir = bestRow.scored_direction;

  // Separate walls
  const wallsAbove = walls.filter(w => w.strike > spot).sort((a, b) => b.absGexValue - a.absGexValue);
  const wallsBelow = walls.filter(w => w.strike <= spot).sort((a, b) => b.absGexValue - a.absGexValue);
  const posAbove = wallsAbove.filter(w => w.type === 'positive');
  const negAbove = wallsAbove.filter(w => w.type === 'negative');
  const posBelow = wallsBelow.filter(w => w.type === 'positive');
  const negBelow = wallsBelow.filter(w => w.type === 'negative');

  const king = walls[0];
  const gexAtSpot = parsed.aggregatedGex.get(Math.round(spot / 5) * 5) || 0;
  const allValues = [...parsed.aggregatedGex.values()];
  const posPct = allValues.length > 0
    ? (allValues.filter(v => v > 0).length / allValues.length * 100).toFixed(0)
    : '?';

  // Detect king node shift
  const kingStr = king ? `${king.strike}` : '?';
  const kingShifted = kingStr !== lastKing;
  lastKing = kingStr;

  // Detect phase
  let phase = '';
  if (negAbove.length > 0 && negAbove[0].absGexValue > (posAbove[0]?.absGexValue || 0)) {
    phase = 'BEARISH_MAGNET_ABOVE';
  } else if (negBelow.length > 0 && negBelow[0].absGexValue > (posBelow[0]?.absGexValue || 0)) {
    phase = 'BEARISH_MAGNET_BELOW';
  } else if (posAbove.length > 0 && posBelow.length > 0) {
    const ratio = Math.min(posAbove[0].absGexValue, posBelow[0].absGexValue) /
                  Math.max(posAbove[0].absGexValue, posBelow[0].absGexValue);
    if (ratio > 0.50) phase = 'PIN_ZONE';
    else phase = posAbove[0].absGexValue > posBelow[0].absGexValue ? 'CEILING_DOMINANT' : 'FLOOR_DOMINANT';
  }
  const phaseChanged = phase !== lastPhase;
  lastPhase = phase;

  // Format
  const formatW = (w) => w ? `${w.strike}(${w.type === 'positive' ? '+' : '-'}${(w.absGexValue / 1e6).toFixed(1)}M)` : '';

  const markers = [];
  if (kingShifted) markers.push(`KING→${kingStr}`);
  if (phaseChanged) markers.push(`PHASE→${phase}`);
  const markerStr = markers.length > 0 ? ` <<< ${markers.join(', ')}` : '';

  console.log(`${ts} | $${spot.toFixed(0)} | ${dir.padEnd(7)} ${String(score).padStart(2)} | gex@spot ${gexAtSpot > 0 ? '+' : ''}${(gexAtSpot / 1e6).toFixed(1)}M | ${posPct}% pos${markerStr}`);

  // Top 3 walls above and below
  const top3Above = walls.filter(w => w.strike > spot).sort((a, b) => b.absGexValue - a.absGexValue).slice(0, 3);
  const top3Below = walls.filter(w => w.strike <= spot).sort((a, b) => b.absGexValue - a.absGexValue).slice(0, 3);

  console.log(`  ▲ ${top3Above.map(formatW).join('  ')}`);
  console.log(`  ▼ ${top3Below.map(formatW).join('  ')}`);
  console.log('');
}

// Price range summary
const spots = rows.map(r => r.spot_price);
const high = Math.max(...spots);
const low = Math.min(...spots);
console.log(`${'='.repeat(70)}`);
console.log(`Day Range: $${low.toFixed(2)} - $${high.toFixed(2)} (${(high - low).toFixed(1)} pts)`);
console.log(`Open: $${rows[0].spot_price.toFixed(2)} | Close: $${rows[rows.length - 1].spot_price.toFixed(2)}`);
