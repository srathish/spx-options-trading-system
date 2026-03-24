/**
 * Deep 1DTE analysis: for each trade that would benefit from 1DTE,
 * check what happened on the NEXT trading day.
 *
 * This answers: would holding overnight with a 1DTE option have captured more?
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { DateTime } from 'luxon';

// Get sorted list of replay files
const files = readdirSync('data')
  .filter(f => f.match(/^gex-replay-2026-.*\.json$/))
  .map(f => `data/${f}`)
  .sort();

// Extract dates
const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean);

function getNextTradingDay(date) {
  const idx = dates.indexOf(date);
  if (idx < 0 || idx >= dates.length - 1) return null;
  return dates[idx + 1];
}

function loadDayPrices(date) {
  const path = `data/gex-replay-${date}.json`;
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const { frames, metadata } = data;
  const isTrinity = metadata?.mode === 'trinity' || (frames[0]?.tickers && typeof frames[0].tickers === 'object');

  const prices = [];
  for (const frame of frames) {
    const spxw = isTrinity ? frame.tickers?.SPXW : frame;
    if (!spxw?.spotPrice) continue;
    const et = DateTime.fromISO(frame.timestamp, { zone: 'UTC' }).setZone('America/New_York');
    prices.push({ time: et.toFormat('HH:mm'), spot: spxw.spotPrice, min: et.hour * 60 + et.minute });
  }
  return prices;
}

function analyzeTrade(date, direction, entrySpot, exitPnl, exitReason, mfe) {
  const isBull = direction === 'BULLISH';

  // Get same-day remaining action
  const prices = loadDayPrices(date);
  if (!prices) return null;

  // Get next-day action
  const nextDate = getNextTradingDay(date);
  const nextPrices = nextDate ? loadDayPrices(nextDate) : null;

  // Same-day stats
  const dayClose = prices[prices.length - 1]?.spot;
  const dayHi = Math.max(...prices.map(p => p.spot));
  const dayLo = Math.min(...prices.map(p => p.spot));

  // Next-day stats
  let nextOpen = null, nextHi = null, nextLo = null, nextClose = null;
  let nextMaxFavorable = 0, nextMaxFavorableTime = null;
  if (nextPrices && nextPrices.length > 0) {
    nextOpen = nextPrices[0].spot;
    nextHi = Math.max(...nextPrices.map(p => p.spot));
    nextLo = Math.min(...nextPrices.map(p => p.spot));
    nextClose = nextPrices[nextPrices.length - 1].spot;

    // Max favorable from entry on next day
    for (const p of nextPrices) {
      const fav = isBull ? p.spot - entrySpot : entrySpot - p.spot;
      if (fav > nextMaxFavorable) {
        nextMaxFavorable = fav;
        nextMaxFavorableTime = p.time;
      }
    }
  }

  // Gap analysis: overnight gap in our direction?
  const gapFromClose = nextOpen ? (isBull ? nextOpen - dayClose : dayClose - nextOpen) : 0;

  return {
    dayClose: Math.round(dayClose),
    dayHi: Math.round(dayHi),
    dayLo: Math.round(dayLo),
    nextDate,
    nextOpen: nextOpen ? Math.round(nextOpen) : null,
    nextHi: nextHi ? Math.round(nextHi) : null,
    nextLo: nextLo ? Math.round(nextLo) : null,
    nextClose: nextClose ? Math.round(nextClose) : null,
    gapFromClose: Math.round(gapFromClose * 100) / 100,
    nextMaxFavorable: Math.round(nextMaxFavorable * 100) / 100,
    nextMaxFavorableTime,
    // 1DTE PnL: from entry, how much would we capture on next day?
    // Conservative: use next-day close relative to entry
    nextDayPnlFromEntry: nextClose ? Math.round((isBull ? nextClose - entrySpot : entrySpot - nextClose) * 100) / 100 : null,
    // Optimistic: use next-day max favorable
    nextDayBestFromEntry: Math.round(nextMaxFavorable * 100) / 100,
  };
}

console.log('='.repeat(90));
console.log('  1DTE DEEP ANALYSIS: Next-Day Continuation');
console.log('='.repeat(90));

// ---- MAX_LOSS trades that recovered same-day ----
console.log('\n--- MAX_LOSS TRADES: Would 1DTE with wider stop have helped? ---\n');

const maxLossTrades = [
  { date: '2026-01-13', dir: 'BULLISH', entry: 6973, pnl: -12, mfe: 1.51, mae: -14.87, afterMax: 17.6 },
  { date: '2026-01-21', dir: 'BEARISH', entry: 6835, pnl: -12, mfe: 0.44, mae: -26.44, afterMax: 55.7 },
  { date: '2026-01-30', dir: 'BULLISH', entry: 6960, pnl: -12, mfe: 0, mae: -13.9, afterMax: 2.4 },
  { date: '2026-02-05', dir: 'BEARISH', entry: 6783, pnl: -12, mfe: 1.46, mae: -29.96, afterMax: 28.6 },
  { date: '2026-02-11', dir: 'BEARISH', entry: 6932, pnl: -12, mfe: 8.13, mae: -16.02, afterMax: 13.0 },
  { date: '2026-02-13', dir: 'BEARISH', entry: 6830, pnl: -12, mfe: 1.99, mae: -31.85, afterMax: 44.3 },
  { date: '2026-03-09', dir: 'BEARISH', entry: 6692, pnl: -12, mfe: 0, mae: -34.36, afterMax: 32.6 },
  { date: '2026-03-19', dir: 'BEARISH', entry: 6586, pnl: -12, mfe: 0, mae: -12.45, afterMax: 32.8 },
];

let totalCurrentMaxLoss = 0;
let total1dtePnlMaxLoss = 0;

for (const t of maxLossTrades) {
  const analysis = analyzeTrade(t.date, t.dir, t.entry, t.pnl, 'MAX_LOSS', t.mfe);
  if (!analysis) continue;

  totalCurrentMaxLoss += t.pnl;

  // For 1DTE: the key question is whether a -25 stop with next-day hold would have helped
  // If MAE > -25, they survive same-day. Then check next day.
  const survives25 = t.mae > -25;
  let dte1Pnl = t.pnl; // default: same

  if (survives25 && analysis.nextDayPnlFromEntry !== null) {
    // Would have survived with -25 stop. Use next-day close as exit.
    dte1Pnl = Math.max(-25, analysis.nextDayPnlFromEntry);
  } else if (!survives25 && analysis.nextDate) {
    // Stopped even at -25 same day. Still -25.
    dte1Pnl = -25;
  }

  total1dtePnlMaxLoss += dte1Pnl;

  console.log(`  ${t.date} | ${t.dir} @ ${t.entry} | Current: ${t.pnl} | MAE: ${t.mae}`);
  console.log(`    Same-day: after stop, price went ${t.afterMax.toFixed(1)}pts in our dir`);
  if (analysis.nextDate) {
    console.log(`    Next day (${analysis.nextDate}): gap ${analysis.gapFromClose > 0 ? '+' : ''}${analysis.gapFromClose} | best from entry: ${analysis.nextDayBestFromEntry > 0 ? '+' : ''}${analysis.nextDayBestFromEntry} (at ${analysis.nextMaxFavorableTime}) | close from entry: ${analysis.nextDayPnlFromEntry > 0 ? '+' : ''}${analysis.nextDayPnlFromEntry}`);
    console.log(`    1DTE sim (${survives25 ? '-25 stop, hold to next close' : 'still stopped at -25'}): ${dte1Pnl > 0 ? '+' : ''}${dte1Pnl.toFixed(1)}`);
  } else {
    console.log(`    No next-day data available`);
  }
}

console.log(`\n  MAX_LOSS 1DTE Summary:`);
console.log(`    Current total: ${totalCurrentMaxLoss} pts`);
console.log(`    1DTE sim total: ${total1dtePnlMaxLoss.toFixed(1)} pts`);
console.log(`    Delta: ${(total1dtePnlMaxLoss - totalCurrentMaxLoss).toFixed(1)} pts`);

// ---- LOCK trades that left money ----
console.log('\n\n--- LOCK TRADES: Would no time restriction have captured more? ---\n');

const lockTrades = [
  { date: '2026-01-05', dir: 'BULLISH', entry: 6895, pnl: 9.20, mfe: 24.27, leftOnTable: 9.4, reason: 'SQUEEZE_LOCK' },
  { date: '2026-01-09', dir: 'BULLISH', entry: 6957, pnl: 3.85, mfe: 13.4, leftOnTable: 17.6, reason: 'BREAK_LOCK' },
  { date: '2026-01-21', dir: 'BULLISH', entry: 6888, pnl: 2.97, mfe: 21.35, leftOnTable: 0.4, reason: 'DEFY_LOCK' },
  { date: '2026-02-04', dir: 'BULLISH', entry: 6846, pnl: 7.81, mfe: 24.75, leftOnTable: 51.2, reason: 'SQUEEZE_LOCK' },
  { date: '2026-02-09', dir: 'BULLISH', entry: 6964, pnl: 3.45, mfe: 14.05, leftOnTable: 11.8, reason: 'BREAK_LOCK' },
  { date: '2026-02-19', dir: 'BEARISH', entry: 6853, pnl: 2.37, mfe: 13.74, leftOnTable: 14.6, reason: 'BREAK_LOCK' },
  { date: '2026-03-06', dir: 'BEARISH', entry: 6763, pnl: 3.47, mfe: 28.2, leftOnTable: 33.4, reason: 'DEFY_LOCK' },
  { date: '2026-03-11', dir: 'BULLISH', entry: 6752, pnl: 9.39, mfe: 24.99, leftOnTable: 14.2, reason: 'SQUEEZE_LOCK' },
  { date: '2026-03-12', dir: 'BULLISH', entry: 6698, pnl: 9.00, mfe: 22.79, leftOnTable: 13.6, reason: 'SQUEEZE_LOCK' },
];

let totalLockCurrent = 0;
let totalLockOptimal = 0;

for (const t of lockTrades) {
  const analysis = analyzeTrade(t.date, t.dir, t.entry, t.pnl, t.reason, t.mfe);
  if (!analysis) continue;

  totalLockCurrent += t.pnl;
  // The "optimal" for locks is the same-day MFE (not 1DTE, since locks fire same-day)
  // But 1DTE question: would holding overnight have captured more?
  const sameDay = t.pnl + t.leftOnTable; // max they could have gotten same day

  console.log(`  ${t.date} | ${t.dir} ${t.reason} @ ${t.entry} | Locked: +${t.pnl.toFixed(1)} | Left: ${t.leftOnTable.toFixed(1)}pts`);
  if (analysis.nextDate) {
    console.log(`    Next day (${analysis.nextDate}): gap ${analysis.gapFromClose > 0 ? '+' : ''}${analysis.gapFromClose} | best from entry: ${analysis.nextDayBestFromEntry > 0 ? '+' : ''}${analysis.nextDayBestFromEntry} | close from entry: ${analysis.nextDayPnlFromEntry > 0 ? '+' : ''}${analysis.nextDayPnlFromEntry}`);
    // Would 1DTE have captured the next-day continuation?
    if (analysis.nextDayBestFromEntry > sameDay) {
      const extraCapture = analysis.nextDayBestFromEntry - t.pnl;
      console.log(`    *** 1DTE BETTER: could have captured +${analysis.nextDayBestFromEntry.toFixed(1)} (vs locked +${t.pnl.toFixed(1)}) — extra ${extraCapture.toFixed(1)}pts`);
      totalLockOptimal += analysis.nextDayBestFromEntry;
    } else {
      totalLockOptimal += sameDay;
      console.log(`    Same-day MFE was better (${sameDay.toFixed(1)} vs next-day ${analysis.nextDayBestFromEntry.toFixed(1)})`);
    }
  } else {
    totalLockOptimal += sameDay;
  }
}

console.log(`\n  LOCK 1DTE Summary:`);
console.log(`    Current locked: +${totalLockCurrent.toFixed(1)} pts`);
console.log(`    Optimal (best of same-day MFE or 1DTE): +${totalLockOptimal.toFixed(1)} pts`);
console.log(`    Additional capture opportunity: +${(totalLockOptimal - totalLockCurrent).toFixed(1)} pts`);

// ---- EOD_CLOSE profitable trades ----
console.log('\n\n--- EOD_CLOSE (PROFITABLE): Would overnight hold have captured gap? ---\n');

const eodTrades = [
  { date: '2026-01-13', dir: 'BEARISH', entry: 6952, pnl: 4.71 },
  { date: '2026-01-26', dir: 'BULLISH', entry: 6952, pnl: 6.70 },
  { date: '2026-01-27', dir: 'BULLISH', entry: 6980, pnl: 1.89 },
  { date: '2026-02-06', dir: 'BULLISH', entry: 6915, pnl: 13.05 },
  { date: '2026-02-24', dir: 'BULLISH', entry: 6888, pnl: 0.87 },
  { date: '2026-03-11', dir: 'BULLISH', entry: 6755, pnl: 16.69 },
  { date: '2026-03-20', dir: 'BEARISH', entry: 6505, pnl: 12.89 },
];

let totalEodCurrent = 0;
let totalEod1dte = 0;

for (const t of eodTrades) {
  const analysis = analyzeTrade(t.date, t.dir, t.entry, t.pnl, 'EOD_CLOSE', 0);
  if (!analysis) continue;

  totalEodCurrent += t.pnl;

  if (analysis.nextDate) {
    // With 1DTE, we hold overnight and exit next day
    // Conservative: use next-day 10 AM price (early exit to avoid next-day chop)
    const nextPrices = loadDayPrices(analysis.nextDate);
    let next10amSpot = null;
    if (nextPrices) {
      const frame10 = nextPrices.find(p => p.min >= 600); // 10:00
      next10amSpot = frame10?.spot;
    }

    const pnlAtNext10 = next10amSpot
      ? Math.round((t.dir === 'BULLISH' ? next10amSpot - t.entry : t.entry - next10amSpot) * 100) / 100
      : null;

    const use1dte = analysis.nextDayBestFromEntry > t.pnl;
    const dte1Pnl = use1dte ? Math.max(-25, analysis.nextDayPnlFromEntry) : t.pnl;
    totalEod1dte += dte1Pnl;

    console.log(`  ${t.date} | ${t.dir} @ ${t.entry} | EOD PnL: +${t.pnl.toFixed(1)}`);
    console.log(`    Next day (${analysis.nextDate}): gap ${analysis.gapFromClose > 0 ? '+' : ''}${analysis.gapFromClose} | open ${analysis.nextOpen}`);
    console.log(`    Next-day best from entry: ${analysis.nextDayBestFromEntry > 0 ? '+' : ''}${analysis.nextDayBestFromEntry} (at ${analysis.nextMaxFavorableTime})`);
    console.log(`    Next-day close from entry: ${analysis.nextDayPnlFromEntry > 0 ? '+' : ''}${analysis.nextDayPnlFromEntry}`);
    if (pnlAtNext10) console.log(`    Next-day 10 AM from entry: ${pnlAtNext10 > 0 ? '+' : ''}${pnlAtNext10}`);
    console.log(`    ${use1dte ? '*** 1DTE BETTER' : 'Same-day was better'}: 1DTE exit=${dte1Pnl > 0 ? '+' : ''}${dte1Pnl.toFixed(1)} vs 0DTE=${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(1)}`);
  } else {
    totalEod1dte += t.pnl;
    console.log(`  ${t.date} | ${t.dir} @ ${t.entry} | EOD PnL: +${t.pnl.toFixed(1)} | No next-day data`);
  }
}

console.log(`\n  EOD 1DTE Summary:`);
console.log(`    Current EOD: +${totalEodCurrent.toFixed(1)} pts`);
console.log(`    1DTE sim: ${totalEod1dte > 0 ? '+' : ''}${totalEod1dte.toFixed(1)} pts`);
console.log(`    Delta: ${(totalEod1dte - totalEodCurrent) > 0 ? '+' : ''}${(totalEod1dte - totalEodCurrent).toFixed(1)} pts`);

// ---- ALL STOP EXITS: 1DTE with wider stop ----
console.log('\n\n--- ALL STOP EXITS: Would wider stops + next-day hold help? ---\n');

const allStops = [
  { date: '2026-01-06', dir: 'BULLISH', entry: 6930, pnl: -12, mae: -12, reason: 'BREAK_STOP' },
  { date: '2026-01-14', dir: 'BEARISH', entry: 6903, pnl: -12, mae: -12.33, reason: 'BREAK_STOP' },
  { date: '2026-01-15', dir: 'BULLISH', entry: 6971, pnl: -12, mae: -13.3, reason: 'BREAK_STOP' },
  { date: '2026-01-22', dir: 'BULLISH', entry: 6914, pnl: -12, mae: -16.24, reason: 'BREAK_STOP' },
  { date: '2026-01-29', dir: 'BULLISH', entry: 6940, pnl: -12, mae: -13.21, reason: 'SQUEEZE_STOP' },
  { date: '2026-02-09', dir: 'BULLISH', entry: 7002, pnl: -15, mae: -15.64, reason: 'DEFY_STOP' },
  { date: '2026-02-17', dir: 'BEARISH', entry: 6774, pnl: -12, mae: -15.22, reason: 'BREAK_STOP', exitTime: '10:48' },
  { date: '2026-02-17', dir: 'BULLISH', entry: 6842, pnl: -12, mae: -12.73, reason: 'BREAK_STOP', exitTime: '15:25' },
  { date: '2026-02-18', dir: 'BULLISH', entry: 6880, pnl: -12, mae: -13.58, reason: 'SQUEEZE_STOP' },
  { date: '2026-02-19', dir: 'BULLISH', entry: 6849, pnl: -12, mae: -13.7, reason: 'SQUEEZE_STOP' },
  { date: '2026-02-20', dir: 'BULLISH', entry: 6911, pnl: -12, mae: -12.49, reason: 'BREAK_STOP' },
  { date: '2026-02-26', dir: 'BEARISH', entry: 6894, pnl: -12, mae: -12.31, reason: 'BREAK_STOP' },
  { date: '2026-03-10', dir: 'BULLISH', entry: 6830, pnl: -12, mae: -13.64, reason: 'SQUEEZE_STOP' },
  { date: '2026-03-12', dir: 'BULLISH', entry: 6698, pnl: -12, mae: -14.54, reason: 'SQUEEZE_STOP' },
  { date: '2026-03-13', dir: 'BULLISH', entry: 6715, pnl: -12, mae: -13.35, reason: 'BREAK_STOP' },
  { date: '2026-03-17', dir: 'BULLISH', entry: 6762, pnl: -12, mae: -12.03, reason: 'SQUEEZE_STOP' },
];

let totalStopsCurrent = 0;
let totalStops1dte = 0;
let stopsHelped = 0;
let stopsHurt = 0;

for (const t of allStops) {
  const analysis = analyzeTrade(t.date, t.dir, t.entry, t.pnl, t.reason, 0);
  if (!analysis) continue;

  totalStopsCurrent += t.pnl;

  // With 1DTE: use -25 stop, hold to next-day close
  const survives25 = t.mae > -25;
  let dte1Pnl = t.pnl;

  if (survives25 && analysis.nextDayPnlFromEntry !== null) {
    dte1Pnl = Math.max(-25, analysis.nextDayPnlFromEntry);
  } else if (!survives25) {
    dte1Pnl = -25;
  }

  totalStops1dte += dte1Pnl;
  if (dte1Pnl > t.pnl) stopsHelped++;
  else stopsHurt++;

  if (analysis.nextDate && dte1Pnl !== t.pnl) {
    const delta = dte1Pnl - t.pnl;
    console.log(`  ${t.date} | ${t.dir} ${t.reason} @ ${t.entry} | 0DTE: ${t.pnl} → 1DTE: ${dte1Pnl > 0 ? '+' : ''}${dte1Pnl.toFixed(1)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)})`);
  }
}

console.log(`\n  STOPS 1DTE Summary:`);
console.log(`    Current total: ${totalStopsCurrent} pts`);
console.log(`    1DTE sim total: ${totalStops1dte.toFixed(1)} pts`);
console.log(`    Delta: ${(totalStops1dte - totalStopsCurrent) > 0 ? '+' : ''}${(totalStops1dte - totalStopsCurrent).toFixed(1)} pts`);
console.log(`    Helped: ${stopsHelped} | Hurt: ${stopsHurt}`);

// ---- GRAND TOTAL ----
console.log('\n' + '='.repeat(90));
console.log('  GRAND TOTAL: 1DTE vs 0DTE');
console.log('='.repeat(90));
console.log(`\n  Current system (0DTE):          +256.00 pts across 69 trades`);
const totalDelta = (total1dtePnlMaxLoss - totalCurrentMaxLoss)
  + (totalEod1dte - totalEodCurrent);
console.log(`  MAX_LOSS 1DTE delta:             ${(total1dtePnlMaxLoss - totalCurrentMaxLoss) > 0 ? '+' : ''}${(total1dtePnlMaxLoss - totalCurrentMaxLoss).toFixed(1)} pts`);
console.log(`  EOD_CLOSE 1DTE delta:            ${(totalEod1dte - totalEodCurrent) > 0 ? '+' : ''}${(totalEod1dte - totalEodCurrent).toFixed(1)} pts`);
console.log(`  All STOPS 1DTE delta:            ${(totalStops1dte - totalStopsCurrent) > 0 ? '+' : ''}${(totalStops1dte - totalStopsCurrent).toFixed(1)} pts`);
console.log(`  LOCK improvement (same-day fix): +${(totalLockOptimal - totalLockCurrent).toFixed(1)} pts (NOT 1DTE, just better lock logic)`);
console.log(`\n  KEY FINDING: 1DTE is ${totalDelta > 0 ? 'BETTER' : 'WORSE'} by ${Math.abs(totalDelta).toFixed(1)} pts for stop/EOD trades`);
console.log(`  The real opportunity is in LOCK EXITS: ${(totalLockOptimal - totalLockCurrent).toFixed(1)} pts left on table same-day\n`);
