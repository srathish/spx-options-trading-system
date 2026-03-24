/**
 * 1DTE Opportunity Analyzer for LLM King Node Backtest
 *
 * Runs the full batch replay, then for each trade analyzes:
 * 1. MAX_LOSS exits: did price continue in entry direction after the stop?
 * 2. TREND_LOCK / LATE_LOCK exits: how much move was left on the table?
 * 3. EOD_CLOSE exits that were profitable: would 1DTE have captured more?
 * 4. Simulates -20 stop (vs -12) and no time locks
 *
 * Usage: node scripts/analyze-1dte-opportunity.js
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { DateTime } from 'luxon';
import { parseGexResponse } from '../src/gex/gex-parser.js';

// ---- Borrowed from replay-llm-king.js ----

function frameToRaw(frame) {
  return {
    CurrentSpot: frame.spotPrice,
    Strikes: frame.strikes,
    GammaValues: frame.gammaValues,
    VannaValues: frame.vannaValues || [],
    Expirations: frame.expirations || [],
  };
}

function frameTimestampToET(utcTimestamp) {
  return DateTime.fromISO(utcTimestamp, { zone: 'UTC' }).setZone('America/New_York');
}

// ---- Main Analysis ----

async function analyzeDay(jsonPath) {
  const rawJson = readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(rawJson);
  const { metadata, frames } = data;
  const dateStr = metadata?.date || 'unknown';
  const isTrinity = metadata?.mode === 'trinity' || (frames[0]?.tickers && typeof frames[0].tickers === 'object');

  // Build price series indexed by ET time string
  const priceSeries = [];
  let openPrice = 0;
  let hod = -Infinity, lod = Infinity;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const spxwData = isTrinity ? frame.tickers?.SPXW : frame;
    if (!spxwData?.spotPrice) continue;

    const et = frameTimestampToET(frame.timestamp);
    const spot = spxwData.spotPrice;
    if (openPrice === 0) openPrice = spot;
    if (spot > hod) hod = spot;
    if (spot < lod) lod = spot;

    priceSeries.push({
      frameIdx: i,
      time: et.toFormat('HH:mm'),
      timeET: et,
      minuteOfDay: et.hour * 60 + et.minute,
      spot,
    });
  }

  if (priceSeries.length === 0) return null;

  const lastSpot = priceSeries[priceSeries.length - 1].spot;
  const closeTime = priceSeries[priceSeries.length - 1].time;
  const dayRange = hod - lod;
  const dayMove = lastSpot - openPrice;

  return {
    date: dateStr,
    priceSeries,
    openPrice,
    hod,
    lod,
    lastSpot,
    closeTime,
    dayRange,
    dayMove,
  };
}

function findPostExitPriceAction(priceSeries, exitTime, direction) {
  // Find the frame at or after exit time
  const exitMinute = timeToMinutes(exitTime);
  const exitIdx = priceSeries.findIndex(p => p.minuteOfDay >= exitMinute);
  if (exitIdx < 0) return null;

  const exitSpot = priceSeries[exitIdx].spot;
  const isBull = direction === 'BULLISH';

  // Track max favorable excursion AFTER exit
  let maxFavorableAfter = 0;
  let maxFavorableTime = exitTime;
  let maxFavorableSpot = exitSpot;
  let eodSpot = exitSpot;

  for (let i = exitIdx; i < priceSeries.length; i++) {
    const p = priceSeries[i];
    const favorable = isBull ? p.spot - exitSpot : exitSpot - p.spot;
    if (favorable > maxFavorableAfter) {
      maxFavorableAfter = favorable;
      maxFavorableTime = p.time;
      maxFavorableSpot = p.spot;
    }
    eodSpot = p.spot;
  }

  // Also track: from entry, how much total move happened in the day
  return {
    exitSpot,
    maxFavorableAfterExit: Math.round(maxFavorableAfter * 100) / 100,
    maxFavorableTime,
    maxFavorableSpot: Math.round(maxFavorableSpot * 100) / 100,
    eodSpot: Math.round(eodSpot * 100) / 100,
    eodFavorable: Math.round((isBull ? eodSpot - exitSpot : exitSpot - eodSpot) * 100) / 100,
  };
}

function timeToMinutes(t) {
  // Handle full datetime "2026-01-20 12:30:00" or just "12:30"
  const parts = t.includes(' ') ? t.split(' ')[1] : t;
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

function extractExitTime(closedAt) {
  if (closedAt === 'EOD') return '15:50';
  // "2026-01-20 12:30:00" -> "12:30"
  const parts = closedAt.split(' ');
  if (parts.length >= 2) return parts[1].substring(0, 5);
  return closedAt;
}

function extractEntryTime(openedAt) {
  const parts = openedAt.split(' ');
  if (parts.length >= 2) return parts[1].substring(0, 5);
  return openedAt;
}

async function main() {
  // Run the batch replay and capture output
  console.log('Running LLM King Node batch replay...\n');

  const files = readdirSync('data')
    .filter(f => f.match(/^gex-replay-2026-.*\.json$/))
    .map(f => `data/${f}`)
    .sort();
  console.log(`Found ${files.length} replay files\n`);

  // Parse the replay output to extract trades
  // Instead of re-running the LLM replay (which needs API/cache), we'll parse
  // the existing batch output. But first let's run it and capture.

  const { execSync } = await import('child_process');
  let replayOutput;
  try {
    replayOutput = execSync(
      `node src/backtest/replay-llm-king.js --batch ${files.join(' ')}`,
      {
        cwd: '/Users/saiyeeshrathish/spx-options-trading-system',
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 600000, // 10 min
      }
    );
  } catch (err) {
    // execSync throws on non-zero exit, but stdout is still available
    replayOutput = err.stdout || '';
    if (err.stderr) console.error('STDERR:', err.stderr.substring(0, 500));
  }

  console.log('=== RAW REPLAY OUTPUT ===');
  console.log(replayOutput);
  console.log('=== END RAW OUTPUT ===\n');

  // Parse trades from output
  // Format: "    2026-01-20 10:30:00 -> 2026-01-20 12:30:00 | BEARISH | target=5800 | -12.00 pts | MAX_LOSS | MFE=3.5 MAE=-12"
  const allTrades = [];
  let currentDate = null;

  for (const line of replayOutput.split('\n')) {
    // Match date headers: "2026-01-20 | openGamma=..."
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}) \| openGamma/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }

    // Match trade lines
    const tradeMatch = line.match(/^\s+([\d-]+ [\d:]+) -> ([\d-]+ [\d:]+|EOD) \| (\w+)(?: (\w+))? \| target=([\d.]+) \| ([+-]?[\d.]+) pts \| (\w+) \| MFE=([\d.-]+) MAE=([\d.-]+)/);
    if (tradeMatch) {
      const [, openedAt, closedAt, direction, mode, target, pnlStr, exitReason, mfeStr, maeStr] = tradeMatch;
      allTrades.push({
        date: currentDate,
        openedAt,
        closedAt,
        direction,
        mode: mode || 'TREND',
        target: parseFloat(target),
        pnl: parseFloat(pnlStr),
        exitReason,
        mfe: parseFloat(mfeStr),
        mae: parseFloat(maeStr),
      });
    }
  }

  // Try more lenient parsing if the above didn't catch trades
  if (allTrades.length === 0) {
    // The output format uses mode in the trade line differently
    // Re-parse: "    2026-01-20 10:30:00 -> 2026-01-20 12:30:00 | BEARISH | target=5800 | -12.00 pts | MAX_LOSS | MFE=3.5 MAE=-12"
    for (const line of replayOutput.split('\n')) {
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}) \|/);
      if (dateMatch && line.includes('openGamma')) {
        currentDate = dateMatch[1];
        continue;
      }

      const m = line.match(/\s+([\d-]+ [\d:]+)\s*->\s*([\d-]+ [\d:]+|EOD)\s*\|\s*(\w+)\s*\|\s*target=([\d.]+)\s*\|\s*([+-]?[\d.]+)\s*pts\s*\|\s*(\w+)\s*\|\s*MFE=([\d.-]+)\s*MAE=([\d.-]+)/);
      if (m) {
        allTrades.push({
          date: currentDate,
          openedAt: m[1],
          closedAt: m[2],
          direction: m[3],
          target: parseFloat(m[4]),
          pnl: parseFloat(m[5]),
          exitReason: m[6],
          mfe: parseFloat(m[7]),
          mae: parseFloat(m[8]),
        });
      }
    }
  }

  console.log(`\nParsed ${allTrades.length} trades from replay output\n`);

  if (allTrades.length === 0) {
    console.log('No trades found. Check replay output format above.');
    return;
  }

  // Now analyze each trade against the price data
  console.log('Loading price data for post-exit analysis...\n');

  const dayDataCache = new Map();

  async function getDayData(date) {
    if (dayDataCache.has(date)) return dayDataCache.get(date);
    const path = `data/gex-replay-${date}.json`;
    if (!existsSync(path)) return null;
    const dayData = await analyzeDay(path);
    dayDataCache.set(date, dayData);
    return dayData;
  }

  // ==========================================
  // SECTION 1: MAX_LOSS Analysis
  // ==========================================
  console.log('=' .repeat(80));
  console.log('  SECTION 1: MAX_LOSS TRADES — Did price continue after the stop?');
  console.log('=' .repeat(80));

  const maxLossTrades = allTrades.filter(t => t.exitReason === 'MAX_LOSS');
  let maxLossWouldHaveRecovered = 0;
  let maxLossContinuedAgainst = 0;
  let totalAdditionalPnlWith20Stop = 0;

  for (const trade of maxLossTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;

    const exitTime = extractExitTime(trade.closedAt);
    const entryTime = extractEntryTime(trade.openedAt);
    const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
    if (!postExit) continue;

    // How much did price move in our direction AFTER stop?
    const continuedInDir = postExit.maxFavorableAfterExit;
    // If price went 12+ pts further in our direction after stop, 1DTE would have recovered
    const wouldRecover = continuedInDir >= 12;
    if (wouldRecover) maxLossWouldHaveRecovered++;
    else maxLossContinuedAgainst++;

    // Entry spot
    const isBull = trade.direction === 'BULLISH';
    const entryFrame = dayData.priceSeries.find(p => p.minuteOfDay >= timeToMinutes(entryTime));
    const entrySpot = entryFrame ? entryFrame.spot : 0;

    // With -20 stop: would we still have been stopped?
    // The actual MAE tells us how far against the trade went
    const wouldSurvive20 = trade.mae >= -20;  // MAE is negative, so > -20 means didn't hit -20

    // If survived with -20, what would the exit have been?
    // Best case: they hit target. Otherwise use EOD close.
    let simPnlWith20 = trade.pnl; // default: same loss
    if (wouldSurvive20) {
      // Not stopped at -20, so we need to see what the eventual exit would be
      // Use maxFavorableAfterExit as an optimistic proxy, or EOD
      const totalFavorableFromEntry = isBull
        ? dayData.lastSpot - entrySpot
        : entrySpot - dayData.lastSpot;
      // Conservative: use the EOD close relative to entry
      simPnlWith20 = Math.round(totalFavorableFromEntry * 100) / 100;
      // But cap at the MFE post-entry (they would likely have some lock mechanism)
      // For this analysis, use raw EOD as the simplest proxy
    }

    const tag = wouldRecover ? '*** RECOVERED ***' : 'stayed dead';
    console.log(`\n  ${trade.date} | ${trade.direction} | Entry ${entryTime} @ ${entrySpot ? Math.round(entrySpot) : '?'} → target ${trade.target}`);
    console.log(`    EXIT: ${exitTime} | PnL: ${trade.pnl} | MFE: ${trade.mfe} | MAE: ${trade.mae}`);
    console.log(`    After stop: max ${continuedInDir.toFixed(1)}pts in our dir (at ${postExit.maxFavorableTime}), EOD ${postExit.eodFavorable.toFixed(1)}pts | ${tag}`);
    console.log(`    Day: open=${Math.round(dayData.openPrice)} close=${Math.round(dayData.lastSpot)} move=${dayData.dayMove > 0 ? '+' : ''}${dayData.dayMove.toFixed(0)} range=${dayData.dayRange.toFixed(0)}`);
    if (wouldSurvive20) {
      console.log(`    -20 stop: Would SURVIVE (MAE=${trade.mae}). EOD PnL would be ${simPnlWith20 > 0 ? '+' : ''}${simPnlWith20.toFixed(1)}`);
      totalAdditionalPnlWith20Stop += (simPnlWith20 - trade.pnl);
    } else {
      console.log(`    -20 stop: Would STILL be stopped (MAE=${trade.mae})`);
    }
  }

  console.log(`\n  MAX_LOSS Summary: ${maxLossTrades.length} trades`);
  console.log(`    Would have recovered (price went 12+ pts in our dir after stop): ${maxLossWouldHaveRecovered}`);
  console.log(`    Stayed dead: ${maxLossContinuedAgainst}`);
  console.log(`    Additional PnL with -20 stop (vs -12): ${totalAdditionalPnlWith20Stop > 0 ? '+' : ''}${totalAdditionalPnlWith20Stop.toFixed(2)} pts`);

  // ==========================================
  // SECTION 2: TREND_LOCK / LATE_LOCK Analysis
  // ==========================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 2: TREND_LOCK / LATE_LOCK — Money left on the table');
  console.log('='.repeat(80));

  const lockTrades = allTrades.filter(t =>
    t.exitReason === 'TREND_LOCK' || t.exitReason === 'LATE_LOCK' ||
    t.exitReason === 'SQUEEZE_LOCK' || t.exitReason === 'BREAK_LOCK' ||
    t.exitReason === 'DEFY_LOCK'
  );
  let totalLeftOnTable = 0;

  for (const trade of lockTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;

    const exitTime = extractExitTime(trade.closedAt);
    const entryTime = extractEntryTime(trade.openedAt);
    const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
    if (!postExit) continue;

    const isBull = trade.direction === 'BULLISH';
    const entryFrame = dayData.priceSeries.find(p => p.minuteOfDay >= timeToMinutes(entryTime));
    const entrySpot = entryFrame ? entryFrame.spot : 0;

    // Total favorable from entry to max after lock
    const exitSpot = postExit.exitSpot;
    const totalMFEAfterLock = isBull
      ? postExit.maxFavorableSpot - entrySpot
      : entrySpot - postExit.maxFavorableSpot;
    const leftOnTable = Math.max(0, totalMFEAfterLock - trade.pnl);
    totalLeftOnTable += leftOnTable;

    // EOD from entry
    const eodFromEntry = isBull
      ? dayData.lastSpot - entrySpot
      : entrySpot - dayData.lastSpot;

    console.log(`\n  ${trade.date} | ${trade.direction} ${trade.exitReason} | Locked: +${trade.pnl.toFixed(1)} | MFE: ${trade.mfe}`);
    console.log(`    Entry ${entryTime} @ ${Math.round(entrySpot)} | Exit ${exitTime} @ ${Math.round(exitSpot)}`);
    console.log(`    After lock: price went ${postExit.maxFavorableAfterExit.toFixed(1)}pts further (at ${postExit.maxFavorableTime})`);
    console.log(`    Total MFE from entry (incl. post-lock): ${totalMFEAfterLock.toFixed(1)} | Left on table: ${leftOnTable.toFixed(1)} pts`);
    console.log(`    EOD from entry: ${eodFromEntry > 0 ? '+' : ''}${eodFromEntry.toFixed(1)}`);
  }

  console.log(`\n  LOCK Summary: ${lockTrades.length} trades`);
  console.log(`    Total locked profit: +${lockTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)} pts`);
  console.log(`    Total left on table: +${totalLeftOnTable.toFixed(2)} pts`);

  // ==========================================
  // SECTION 3: EOD_CLOSE Analysis (profitable)
  // ==========================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 3: EOD_CLOSE (profitable) — Trades that wanted to keep running');
  console.log('='.repeat(80));

  const eodTrades = allTrades.filter(t =>
    (t.exitReason === 'EOD_CLOSE' || t.exitReason === 'EOD_FORCE') && t.pnl > 0
  );

  for (const trade of eodTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;

    const entryTime = extractEntryTime(trade.openedAt);
    const entryFrame = dayData.priceSeries.find(p => p.minuteOfDay >= timeToMinutes(entryTime));
    const entrySpot = entryFrame ? entryFrame.spot : 0;

    console.log(`\n  ${trade.date} | ${trade.direction} EOD | PnL: +${trade.pnl.toFixed(1)} | MFE: ${trade.mfe}`);
    console.log(`    Entry ${entryTime} @ ${Math.round(entrySpot)} | Day move: ${dayData.dayMove > 0 ? '+' : ''}${dayData.dayMove.toFixed(0)}`);
    console.log(`    Still profitable at close — 1DTE could capture overnight gap continuation`);
  }

  console.log(`\n  EOD_CLOSE Summary: ${eodTrades.length} profitable trades held to close`);
  console.log(`    Total EOD profit: +${eodTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)} pts`);

  // ==========================================
  // SECTION 4: Other stops (DEFY_STOP, BREAK_STOP, SQUEEZE_STOP)
  // ==========================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 4: ALL STOP EXITS — Post-stop price action');
  console.log('='.repeat(80));

  const stopTrades = allTrades.filter(t =>
    t.exitReason.includes('STOP') && t.exitReason !== 'MAX_LOSS'
  );

  let stopRecoveredCount = 0;
  let stopTotalRecoveryPts = 0;

  for (const trade of stopTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;

    const exitTime = extractExitTime(trade.closedAt);
    const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
    if (!postExit) continue;

    const wouldRecover = postExit.maxFavorableAfterExit >= Math.abs(trade.pnl);
    if (wouldRecover) {
      stopRecoveredCount++;
      stopTotalRecoveryPts += (postExit.maxFavorableAfterExit + trade.pnl);
    }

    console.log(`\n  ${trade.date} | ${trade.direction} ${trade.exitReason} | PnL: ${trade.pnl.toFixed(1)} | MAE: ${trade.mae}`);
    console.log(`    After stop: max ${postExit.maxFavorableAfterExit.toFixed(1)}pts in our dir | ${wouldRecover ? '*** RECOVERED ***' : 'stayed dead'}`);
  }

  console.log(`\n  Other Stops Summary: ${stopTrades.length} trades`);
  console.log(`    Would have recovered: ${stopRecoveredCount}/${stopTrades.length}`);

  // ==========================================
  // SECTION 5: SIMULATION — What if -20 stops + no time locks?
  // ==========================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 5: SIMULATION — -20 stops, no time locks, no THETA_DEATH');
  console.log('='.repeat(80));

  let currentPnl = 0;
  let simPnl = 0;

  for (const trade of allTrades) {
    currentPnl += trade.pnl;

    const dayData = await getDayData(trade.date);
    if (!dayData) { simPnl += trade.pnl; continue; }

    const entryTime = extractEntryTime(trade.openedAt);
    const exitTime = extractExitTime(trade.closedAt);
    const entryFrame = dayData.priceSeries.find(p => p.minuteOfDay >= timeToMinutes(entryTime));
    const entrySpot = entryFrame ? entryFrame.spot : 0;
    const isBull = trade.direction === 'BULLISH';

    if (trade.exitReason === 'MAX_LOSS') {
      // Sim: -20 stop instead of -12
      if (trade.mae >= -20) {
        // Not stopped at -20, so use EOD close
        const eodPnl = isBull ? dayData.lastSpot - entrySpot : entrySpot - dayData.lastSpot;
        // But cap loss at -20 (in case EOD is worse)
        simPnl += Math.max(-20, Math.round(eodPnl * 100) / 100);
      } else {
        // Still stopped at -20
        simPnl += -20;
      }
    } else if (trade.exitReason === 'TREND_LOCK' || trade.exitReason === 'LATE_LOCK') {
      // Sim: no time locks, hold to EOD or target
      const eodPnl = isBull ? dayData.lastSpot - entrySpot : entrySpot - dayData.lastSpot;
      // Check if target was hit after lock
      const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
      if (postExit) {
        // Use the MFE from entry (including post-lock) but cap at target distance
        const targetDist = Math.abs(trade.target - entrySpot);
        const totalMFE = isBull
          ? postExit.maxFavorableSpot - entrySpot
          : entrySpot - postExit.maxFavorableSpot;
        // If they would have hit target, use target. Otherwise use EOD.
        if (totalMFE >= targetDist) {
          simPnl += targetDist;
        } else {
          simPnl += Math.max(-20, Math.round(eodPnl * 100) / 100);
        }
      } else {
        simPnl += trade.pnl; // fallback
      }
    } else if (trade.exitReason === 'SQUEEZE_LOCK' || trade.exitReason === 'BREAK_LOCK' || trade.exitReason === 'DEFY_LOCK') {
      // Sim: no locks, hold to EOD
      const eodPnl = isBull ? dayData.lastSpot - entrySpot : entrySpot - dayData.lastSpot;
      simPnl += Math.max(-20, Math.round(eodPnl * 100) / 100);
    } else {
      // All other exits: keep as-is
      simPnl += trade.pnl;
    }
  }

  console.log(`\n  Current system PnL:   ${currentPnl > 0 ? '+' : ''}${currentPnl.toFixed(2)} pts (${allTrades.length} trades)`);
  console.log(`  Simulated PnL (-20s, no locks): ${simPnl > 0 ? '+' : ''}${simPnl.toFixed(2)} pts`);
  console.log(`  Delta: ${(simPnl - currentPnl) > 0 ? '+' : ''}${(simPnl - currentPnl).toFixed(2)} pts`);

  // ==========================================
  // SECTION 6: Summary — Where does 1DTE help most?
  // ==========================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 6: WHERE 1DTE HELPS MOST');
  console.log('='.repeat(80));

  // Group MAX_LOSS by whether the day was a trend day
  const maxLossByDayType = { trend: [], chop: [] };
  for (const trade of maxLossTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;
    const isTrend = dayData.dayRange >= 40 || Math.abs(dayData.dayMove) >= 30;
    if (isTrend) maxLossByDayType.trend.push(trade);
    else maxLossByDayType.chop.push(trade);
  }

  console.log(`\n  MAX_LOSS on TREND days (range>=40 or move>=30): ${maxLossByDayType.trend.length} trades`);
  for (const t of maxLossByDayType.trend) {
    const dd = await getDayData(t.date);
    console.log(`    ${t.date} | ${t.direction} | day move=${dd?.dayMove?.toFixed(0)} range=${dd?.dayRange?.toFixed(0)} | MAE=${t.mae}`);
  }

  console.log(`\n  MAX_LOSS on CHOP days (range<40 and move<30): ${maxLossByDayType.chop.length} trades`);
  for (const t of maxLossByDayType.chop) {
    const dd = await getDayData(t.date);
    console.log(`    ${t.date} | ${t.direction} | day move=${dd?.dayMove?.toFixed(0)} range=${dd?.dayRange?.toFixed(0)} | MAE=${t.mae}`);
  }

  // KEY QUESTION: Which specific days had trades where 1DTE would have changed the outcome?
  console.log(`\n  1DTE IMPACT CANDIDATES (MAX_LOSS trades where price later moved 15+ in our dir):`);
  for (const trade of maxLossTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;
    const exitTime = extractExitTime(trade.closedAt);
    const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
    if (!postExit) continue;
    if (postExit.maxFavorableAfterExit >= 15) {
      console.log(`    *** ${trade.date} | ${trade.direction} | stopped at -12, then price went ${postExit.maxFavorableAfterExit.toFixed(1)}pts in our dir (at ${postExit.maxFavorableTime})`);
    }
  }

  console.log(`\n  1DTE LOCK CANDIDATES (LOCK exits where 15+ more pts left on table):`);
  for (const trade of lockTrades) {
    const dayData = await getDayData(trade.date);
    if (!dayData) continue;
    const exitTime = extractExitTime(trade.closedAt);
    const postExit = findPostExitPriceAction(dayData.priceSeries, exitTime, trade.direction);
    if (!postExit) continue;
    const isBull = trade.direction === 'BULLISH';
    const entryFrame = dayData.priceSeries.find(p => p.minuteOfDay >= timeToMinutes(extractEntryTime(trade.openedAt)));
    const entrySpot = entryFrame ? entryFrame.spot : 0;
    const totalMFE = isBull
      ? postExit.maxFavorableSpot - entrySpot
      : entrySpot - postExit.maxFavorableSpot;
    const leftOnTable = totalMFE - trade.pnl;
    if (leftOnTable >= 15) {
      console.log(`    *** ${trade.date} | ${trade.direction} | locked at +${trade.pnl.toFixed(1)}, total MFE was ${totalMFE.toFixed(1)} | ${leftOnTable.toFixed(1)}pts left`);
    }
  }

  // Exit reason breakdown with recovery stats
  console.log('\n' + '='.repeat(80));
  console.log('  EXIT REASON BREAKDOWN');
  console.log('='.repeat(80));

  const exitGroups = {};
  for (const t of allTrades) {
    if (!exitGroups[t.exitReason]) exitGroups[t.exitReason] = { count: 0, pnl: 0, trades: [] };
    exitGroups[t.exitReason].count++;
    exitGroups[t.exitReason].pnl += t.pnl;
    exitGroups[t.exitReason].trades.push(t);
  }

  for (const [reason, data] of Object.entries(exitGroups).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason.padEnd(18)} ${String(data.count).padStart(3)} trades | ${data.pnl > 0 ? '+' : ''}${data.pnl.toFixed(2)} pts | avg ${(data.pnl / data.count).toFixed(1)}/trade`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
