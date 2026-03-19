import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '..', 'data', 'batch-replay-results.txt');
const raw = readFileSync(filePath, 'utf-8');
const lines = raw.split('\n');

// ── Parse trade log lines ──
// Format:  2025-12-15 10:01:00 | BEARISH RUG_PULL             | $6828.84 -> $6826.18 |    +2.66 pts | GEX_FLIP           | WIN
const tradeRegex = /^\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(BULLISH|BEARISH)\s+([\w]+)\s+\|\s+\$([0-9.]+)\s+->\s+\$([0-9.]+)\s+\|\s+([+-]?[0-9.]+)\s+pts\s+\|\s+([\w]+)\s+\|\s+(WIN|LOSS)/;

// ── Parse Lane A entry lines ──
// Format: [ReplayJSON] ENTRY 2025-12-15 10:01:00 | BEARISH @ $6828.84 via RUG_PULL (HIGH) | target=6820 stop=6830.00
const entryRegexA = /\[ReplayJSON\]\s+ENTRY\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(BULLISH|BEARISH)\s+@\s+\$([0-9.]+)\s+via\s+([\w]+)\s+\(\w+\)\s+\|\s+target=([0-9.]+)\s+stop=([0-9.]+)/;

// ── Parse Lane C entry lines ──
// Format: [LaneC] LANE C ENTRY 2026-01-02 09:45:00 | BULLISH @ $6875.06 via LC_REVERSE_RUG | stop=6860.06 (15pt wide)
const entryRegexC = /\[LaneC\]\s+LANE C ENTRY\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(BULLISH|BEARISH)\s+@\s+\$([0-9.]+)\s+via\s+([\w]+)\s+\|\s+stop=([0-9.]+)/;

const trades = [];
const entryMap = new Map(); // key: "date time" -> { spot, stop, stopDist }

// First pass: collect all entry lines
for (const line of lines) {
  let m = line.match(entryRegexA);
  if (m) {
    const key = `${m[1]} ${m[2]}`;
    const spot = parseFloat(m[4]);
    const stop = parseFloat(m[7]);
    const stopDist = Math.abs(spot - stop);
    entryMap.set(key, { spot, stop, stopDist, pattern: m[5] });
    continue;
  }
  m = line.match(entryRegexC);
  if (m) {
    const key = `${m[1]} ${m[2]}`;
    const spot = parseFloat(m[4]);
    const stop = parseFloat(m[6]);
    const stopDist = Math.abs(spot - stop);
    entryMap.set(key, { spot, stop, stopDist, pattern: m[5] });
    continue;
  }
}

// Second pass: collect all trade log lines
for (const line of lines) {
  const m = line.match(tradeRegex);
  if (m) {
    const date = m[1];
    const time = m[2];
    const direction = m[3];
    const pattern = m[4];
    const entryPrice = parseFloat(m[5]);
    const exitPrice = parseFloat(m[6]);
    const pnl = parseFloat(m[7]);
    const exitReason = m[8];
    const result = m[9];
    const hour = parseInt(time.split(':')[0]);
    const key = `${date} ${time}`;
    const entry = entryMap.get(key);
    trades.push({ date, time, hour, direction, pattern, entryPrice, exitPrice, pnl, exitReason, result, stopDist: entry?.stopDist ?? null });
  }
}

console.log(`\nParsed ${trades.length} trades from ${new Set(trades.map(t => t.date)).size} days\n`);

// ── Helpers ──
function fmt(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const s = n.toFixed(dec);
  return n > 0 ? `+${s}` : s;
}

function printTable(headers, rows, alignments) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const formatRow = (cells) => cells.map((c, i) => {
    const s = String(c);
    const w = widths[i];
    return alignments[i] === 'l' ? ` ${s.padEnd(w)} ` : ` ${s.padStart(w)} `;
  }).join('|');

  console.log(formatRow(headers));
  console.log(sep);
  rows.forEach(r => console.log(formatRow(r)));
}

// ════════════════════════════════════════════
// CUT 1: P&L by Pattern
// ════════════════════════════════════════════
console.log('='.repeat(80));
console.log('  CUT 1: P&L by Pattern');
console.log('='.repeat(80));

const patternMap = {};
for (const t of trades) {
  if (!patternMap[t.pattern]) patternMap[t.pattern] = { wins: [], losses: [] };
  if (t.result === 'WIN') patternMap[t.pattern].wins.push(t.pnl);
  else patternMap[t.pattern].losses.push(t.pnl);
}

const patHeaders = ['Pattern', 'Trades', 'WR%', 'Avg Win', 'Avg Loss', 'NET', 'Pts/Trade'];
const patRows = [];
for (const [pattern, data] of Object.entries(patternMap).sort((a, b) => {
  const netA = [...a[1].wins, ...a[1].losses].reduce((s, v) => s + v, 0);
  const netB = [...b[1].wins, ...b[1].losses].reduce((s, v) => s + v, 0);
  return netB - netA;
})) {
  const total = data.wins.length + data.losses.length;
  const wr = ((data.wins.length / total) * 100).toFixed(1);
  const avgWin = data.wins.length ? (data.wins.reduce((s, v) => s + v, 0) / data.wins.length) : 0;
  const avgLoss = data.losses.length ? (data.losses.reduce((s, v) => s + v, 0) / data.losses.length) : 0;
  const net = [...data.wins, ...data.losses].reduce((s, v) => s + v, 0);
  const ppt = net / total;
  patRows.push([pattern, total, wr, fmt(avgWin), fmt(avgLoss), fmt(net), fmt(ppt)]);
}

printTable(patHeaders, patRows, ['l', 'r', 'r', 'r', 'r', 'r', 'r']);

// ════════════════════════════════════════════
// CUT 2: P&L by Time Window
// ════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('  CUT 2: P&L by Time Window');
console.log('='.repeat(80));

const hourMap = {};
for (const t of trades) {
  if (!hourMap[t.hour]) hourMap[t.hour] = [];
  hourMap[t.hour].push(t);
}

const timeHeaders = ['Window', 'Trades', 'Wins', 'Losses', 'WR%', 'NET', 'Pts/Trade'];
const timeRows = [];
for (const hour of [9, 10, 11, 12, 13, 14, 15]) {
  const tds = hourMap[hour] || [];
  const wins = tds.filter(t => t.result === 'WIN').length;
  const losses = tds.filter(t => t.result === 'LOSS').length;
  const net = tds.reduce((s, t) => s + t.pnl, 0);
  const wr = tds.length ? ((wins / tds.length) * 100).toFixed(1) : '—';
  const ppt = tds.length ? net / tds.length : 0;
  timeRows.push([`${hour}:xx`, tds.length, wins, losses, wr, fmt(net), fmt(ppt)]);
}

printTable(timeHeaders, timeRows, ['l', 'r', 'r', 'r', 'r', 'r', 'r']);

// ════════════════════════════════════════════
// CUT 3: P&L by Exit Reason
// ════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('  CUT 3: P&L by Exit Reason');
console.log('='.repeat(80));

const exitMap = {};
for (const t of trades) {
  if (!exitMap[t.exitReason]) exitMap[t.exitReason] = [];
  exitMap[t.exitReason].push(t);
}

const exitHeaders = ['Exit Reason', 'Trades', 'Wins', 'Losses', 'NET', 'Avg PnL'];
const exitRows = [];
for (const [reason, tds] of Object.entries(exitMap).sort((a, b) => {
  const netA = a[1].reduce((s, t) => s + t.pnl, 0);
  const netB = b[1].reduce((s, t) => s + t.pnl, 0);
  return netB - netA;
})) {
  const wins = tds.filter(t => t.result === 'WIN').length;
  const losses = tds.filter(t => t.result === 'LOSS').length;
  const net = tds.reduce((s, t) => s + t.pnl, 0);
  const avg = net / tds.length;
  exitRows.push([reason, tds.length, wins, losses, fmt(net), fmt(avg)]);
}

printTable(exitHeaders, exitRows, ['l', 'r', 'r', 'r', 'r', 'r']);

// ════════════════════════════════════════════
// CUT 4: Stop Distance Distribution
// ════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('  CUT 4: Stop Distance Distribution');
console.log('='.repeat(80));

const buckets = [
  { label: '0-3 pts', min: 0, max: 3 },
  { label: '3-5 pts', min: 3, max: 5 },
  { label: '5-8 pts', min: 5, max: 8 },
  { label: '8-12 pts', min: 8, max: 12 },
  { label: '12+ pts', min: 12, max: Infinity },
];

const tradesWithStop = trades.filter(t => t.stopDist !== null);
console.log(`  (${tradesWithStop.length} of ${trades.length} trades matched to entry lines)\n`);

const stopHeaders = ['Bucket', 'Trades', 'Wins', 'Losses', 'WR%', 'NET', 'Pts/Trade'];
const stopRows = [];
for (const b of buckets) {
  const tds = tradesWithStop.filter(t => t.stopDist >= b.min && t.stopDist < b.max);
  const wins = tds.filter(t => t.result === 'WIN').length;
  const losses = tds.filter(t => t.result === 'LOSS').length;
  const net = tds.reduce((s, t) => s + t.pnl, 0);
  const wr = tds.length ? ((wins / tds.length) * 100).toFixed(1) : '—';
  const ppt = tds.length ? net / tds.length : 0;
  stopRows.push([b.label, tds.length, wins, losses, wr, fmt(net), fmt(ppt)]);
}

printTable(stopHeaders, stopRows, ['l', 'r', 'r', 'r', 'r', 'r', 'r']);

// ════════════════════════════════════════════
// CUT 5: Winner/Loser Summary
// ════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('  CUT 5: Winner/Loser Summary');
console.log('='.repeat(80));

const allWins = trades.filter(t => t.result === 'WIN');
const allLosses = trades.filter(t => t.result === 'LOSS');
const avgWinSize = allWins.length ? allWins.reduce((s, t) => s + t.pnl, 0) / allWins.length : 0;
const avgLossSize = allLosses.length ? allLosses.reduce((s, t) => s + t.pnl, 0) / allLosses.length : 0;
const targetHits = trades.filter(t => t.exitReason === 'TARGET_HIT').length;
const stopHits = trades.filter(t => t.exitReason === 'STOP_HIT' || t.exitReason === 'LC_STOP_HIT').length;
const totalNet = trades.reduce((s, t) => s + t.pnl, 0);

const maxWin = allWins.length ? Math.max(...allWins.map(t => t.pnl)) : 0;
const maxLoss = allLosses.length ? Math.min(...allLosses.map(t => t.pnl)) : 0;

console.log(`
  Total trades:      ${trades.length}
  Winners:           ${allWins.length}  (${((allWins.length / trades.length) * 100).toFixed(1)}%)
  Losers:            ${allLosses.length}  (${((allLosses.length / trades.length) * 100).toFixed(1)}%)

  Avg win:           ${fmt(avgWinSize)} pts
  Avg loss:          ${fmt(avgLossSize)} pts
  Reward/Risk:       ${Math.abs(avgWinSize / avgLossSize).toFixed(2)}

  Best trade:        ${fmt(maxWin)} pts
  Worst trade:       ${fmt(maxLoss)} pts

  TARGET_HIT:        ${targetHits}
  STOP_HIT:          ${stopHits} (incl. LC_STOP_HIT)
  T/S ratio:         ${stopHits ? (targetHits / stopHits).toFixed(2) : '—'}

  Total NET P&L:     ${fmt(totalNet)} pts
  Pts/trade:         ${fmt(totalNet / trades.length)} pts
`);
