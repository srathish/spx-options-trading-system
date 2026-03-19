import { readFileSync } from 'fs';

const file = process.argv[2] || 'data/batch-replay-results.txt';
const data = readFileSync(file, 'utf-8');
const trades = [];
const tradeRegex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \| (\w+)\s+(\w+)\s+\| \$(\d+\.\d+) -> \$(\d+\.\d+) \|\s+([+-]?\d+\.?\d*) pts \| (\w+)\s+\| (WIN|LOSS)/g;
let m;
while ((m = tradeRegex.exec(data)) !== null) {
  trades.push({
    date: m[1].split(' ')[0],
    time: m[1], direction: m[2], pattern: m[3].trim(),
    entry: parseFloat(m[4]), exit: parseFloat(m[5]),
    pnl: parseFloat(m[6]), exitReason: m[7].trim(), isWin: m[8] === 'WIN',
    hour: parseInt(m[1].split(' ')[1].split(':')[0]),
  });
}

console.log(`Parsed ${trades.length} trades\n`);

console.log('=== PATTERN BREAKDOWN (all 19 days) ===');
const byPattern = {};
for (const t of trades) {
  if (!byPattern[t.pattern]) byPattern[t.pattern] = { wins: 0, losses: 0, pnl: 0, trades: [] };
  if (t.isWin) byPattern[t.pattern].wins++; else byPattern[t.pattern].losses++;
  byPattern[t.pattern].pnl += t.pnl;
  byPattern[t.pattern].trades.push(t);
}
for (const [p, s] of Object.entries(byPattern).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const total = s.wins + s.losses;
  const wr = ((s.wins / total) * 100).toFixed(0);
  const avgWin = s.trades.filter(t => t.isWin).reduce((a, t) => a + t.pnl, 0) / (s.wins || 1);
  const avgLoss = s.trades.filter(t => !t.isWin).reduce((a, t) => a + t.pnl, 0) / (s.losses || 1);
  console.log(`  ${p.padEnd(20)} ${String(total).padStart(3)} trades | ${s.wins}W/${s.losses}L (${wr.padStart(3)}%) | NET ${s.pnl > 0 ? '+' : ''}${s.pnl.toFixed(2).padStart(8)} | avgW: +${avgWin.toFixed(2)} avgL: ${avgLoss.toFixed(2)}`);
}

console.log('\n=== EXIT REASON BREAKDOWN ===');
const byExit = {};
for (const t of trades) {
  if (!byExit[t.exitReason]) byExit[t.exitReason] = { wins: 0, losses: 0, pnl: 0 };
  if (t.isWin) byExit[t.exitReason].wins++; else byExit[t.exitReason].losses++;
  byExit[t.exitReason].pnl += t.pnl;
}
for (const [r, s] of Object.entries(byExit).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const total = s.wins + s.losses;
  console.log(`  ${r.padEnd(22)} ${String(total).padStart(3)} | ${s.wins}W/${s.losses}L | NET ${s.pnl > 0 ? '+' : ''}${s.pnl.toFixed(2)}`);
}

console.log('\n=== HOUR-OF-DAY PERFORMANCE ===');
const byHour = {};
for (const t of trades) {
  if (!byHour[t.hour]) byHour[t.hour] = { wins: 0, losses: 0, pnl: 0 };
  if (t.isWin) byHour[t.hour].wins++; else byHour[t.hour].losses++;
  byHour[t.hour].pnl += t.pnl;
}
for (const h of Object.keys(byHour).sort()) {
  const s = byHour[h];
  const total = s.wins + s.losses;
  const wr = ((s.wins / total) * 100).toFixed(0);
  console.log(`  ${h}:00  ${String(total).padStart(3)} trades | ${s.wins}W/${s.losses}L (${wr.padStart(3)}%) | NET ${s.pnl > 0 ? '+' : ''}${s.pnl.toFixed(2)}`);
}

console.log('\n=== OVERALL STATS ===');
const winPnls = trades.filter(t => t.isWin).map(t => t.pnl);
const lossPnls = trades.filter(t => !t.isWin).map(t => t.pnl);
console.log(`  Total Trades: ${trades.length}`);
console.log(`  Avg Win:  +${(winPnls.reduce((a, b) => a + b, 0) / winPnls.length).toFixed(2)} pts`);
console.log(`  Avg Loss: ${(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length).toFixed(2)} pts`);
console.log(`  Win Rate: ${((winPnls.length / trades.length) * 100).toFixed(1)}%`);
console.log(`  R:R Ratio: ${Math.abs((winPnls.reduce((a, b) => a + b, 0) / winPnls.length) / (lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length)).toFixed(2)}`);
console.log(`  Expectancy: ${((winPnls.reduce((a, b) => a + b, 0) + lossPnls.reduce((a, b) => a + b, 0)) / trades.length).toFixed(2)} pts/trade`);

// Biggest winners and losers
const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
console.log('\n=== TOP 5 WINNERS ===');
for (const t of sorted.slice(0, 5)) {
  console.log(`  ${t.time} | ${t.pattern.padEnd(16)} | +${t.pnl.toFixed(2)} pts | ${t.exitReason}`);
}
console.log('\n=== TOP 5 LOSERS ===');
for (const t of sorted.slice(-5).reverse()) {
  console.log(`  ${t.time} | ${t.pattern.padEnd(16)} | ${t.pnl.toFixed(2)} pts | ${t.exitReason}`);
}

// Stop distance analysis
console.log('\n=== STOP_HIT ANALYSIS ===');
const stopHits = trades.filter(t => t.exitReason === 'STOP_HIT');
if (stopHits.length > 0) {
  const avgStopLoss = stopHits.reduce((a, t) => a + t.pnl, 0) / stopHits.length;
  console.log(`  ${stopHits.length} stop hits | avg loss: ${avgStopLoss.toFixed(2)} pts`);
  for (const t of stopHits) {
    const dist = Math.abs(t.entry - t.exit);
    console.log(`    ${t.time} | ${t.pattern.padEnd(16)} | ${t.pnl.toFixed(2)} pts | stop dist: ${dist.toFixed(2)}`);
  }
}
