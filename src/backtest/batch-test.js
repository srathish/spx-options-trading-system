/**
 * Batch Strategy Tester
 * Tests N strategies across multiple dates and ranks by total P&L.
 *
 * Usage: node src/backtest/batch-test.js
 *
 * Each strategy runs as a forked child process (clean state per run).
 */

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPLAY_PATH = join(__dirname, 'replay.js');

const DATES = ['2026-03-03', '2026-03-02'];

// ---- Strategy Definitions ----
// Each strategy overrides specific config params.
// The base config comes from the active DB strategy.

const STRATEGIES = [
  {
    name: '1. Current simplified',
    desc: 'Chop=HIGH, TP chop block, no score gate',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '2. No chop gate',
    desc: 'No chop filtering anywhere',
    config: { chop_min_confidence: 'NONE', trend_pullback_chop_block: false, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '3. Chop=MEDIUM',
    desc: 'Require MEDIUM+ in chop (less strict)',
    config: { chop_min_confidence: 'MEDIUM', trend_pullback_chop_block: true, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '4. Chop=MEDIUM, TP free',
    desc: 'MEDIUM chop for GEX, no TP chop block',
    config: { chop_min_confidence: 'MEDIUM', trend_pullback_chop_block: false, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '5. TP disabled',
    desc: 'No trend pullback entries at all',
    config: { chop_min_confidence: 'HIGH', trend_pullback_enabled: false, gex_min_entry_score: 0 },
  },
  {
    name: '6. TP score>=50',
    desc: 'TP needs GEX score 50+, chop block',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, trend_pullback_min_score: 50, gex_min_entry_score: 0 },
  },
  {
    name: '7. TP score>=55',
    desc: 'TP needs GEX score 55+, chop block',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, trend_pullback_min_score: 55, gex_min_entry_score: 0 },
  },
  {
    name: '8. TP score>=40 + chop',
    desc: 'TP needs 40+ AND chop block',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, trend_pullback_min_score: 40, gex_min_entry_score: 0 },
  },
  {
    name: '9. GEX score>=50 all',
    desc: 'All entries need GEX score 50+',
    config: { chop_min_confidence: 'HIGH', gex_min_entry_score: 50, trend_pullback_chop_block: true, trend_pullback_min_score: 50 },
  },
  {
    name: '10. GEX score>=40 all',
    desc: 'All entries need GEX score 40+',
    config: { chop_min_confidence: 'HIGH', gex_min_entry_score: 40, trend_pullback_chop_block: true, trend_pullback_min_score: 40 },
  },
  {
    name: '11. Fast spacing (60s)',
    desc: '60s between entries, current gates',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, entry_min_spacing_ms: 60_000, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '12. Medium spacing (120s)',
    desc: '120s between entries',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, entry_min_spacing_ms: 120_000, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '13. 3 loss cooldown',
    desc: '3 consecutive losses before cooldown',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, consecutive_loss_limit: 3, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '14. 4 loss cooldown',
    desc: '4 consecutive losses before cooldown',
    config: { chop_min_confidence: 'HIGH', trend_pullback_chop_block: true, consecutive_loss_limit: 4, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '15. Aggressive',
    desc: 'No chop, no score, 60s, 4 loss limit',
    config: { chop_min_confidence: 'NONE', trend_pullback_chop_block: false, entry_min_spacing_ms: 60_000, consecutive_loss_limit: 4, gex_min_entry_score: 0, trend_pullback_min_score: 0 },
  },
  {
    name: '16. Conservative',
    desc: 'HIGH chop, score>=50, 300s, 2 loss limit',
    config: { chop_min_confidence: 'HIGH', gex_min_entry_score: 50, trend_pullback_min_score: 55, trend_pullback_chop_block: true, entry_min_spacing_ms: 300_000, consecutive_loss_limit: 2 },
  },
  {
    name: '17. GEX patterns only',
    desc: 'No TP, no chop gate, confidence drives entries',
    config: { trend_pullback_enabled: false, chop_min_confidence: 'NONE', gex_min_entry_score: 0 },
  },
  {
    name: '18. MEDIUM chop + score>=40',
    desc: 'Balanced: MEDIUM chop, low score floor',
    config: { chop_min_confidence: 'MEDIUM', gex_min_entry_score: 40, trend_pullback_chop_block: true, trend_pullback_min_score: 40 },
  },
  {
    name: '19. No chop + TP score>=50',
    desc: 'Free GEX entries, TP needs score 50',
    config: { chop_min_confidence: 'NONE', trend_pullback_chop_block: false, trend_pullback_min_score: 50, gex_min_entry_score: 0 },
  },
  {
    name: '20. MEDIUM chop + TP score>=55',
    desc: 'MEDIUM chop, TP needs score 55',
    config: { chop_min_confidence: 'MEDIUM', trend_pullback_chop_block: true, trend_pullback_min_score: 55, gex_min_entry_score: 0 },
  },
];

// ---- Runner ----

function runReplay(date, configOverride) {
  return new Promise((resolve, reject) => {
    const child = fork(REPLAY_PATH, [], { stdio: 'pipe' });
    let resolved = false;

    child.on('message', (msg) => {
      resolved = true;
      if (msg.type === 'result') resolve(msg.data);
      else reject(new Error(msg.message || 'Unknown error'));
    });

    child.on('error', (err) => { if (!resolved) reject(err); });
    child.on('exit', (code) => {
      if (!resolved) reject(new Error(`Child exited with code ${code}`));
    });

    child.send({ date, configOverride });
  });
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Batch Strategy Tester — ${STRATEGIES.length} strategies × ${DATES.length} dates`);
  console.log(`${'='.repeat(70)}\n`);

  const results = [];

  for (let i = 0; i < STRATEGIES.length; i++) {
    const strat = STRATEGIES[i];
    const dateResults = {};
    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;

    process.stdout.write(`  Testing ${strat.name}...`);

    for (const date of DATES) {
      try {
        const report = await runReplay(date, strat.config);
        dateResults[date] = report;
        totalPnl += report.totalPnlPts;
        totalTrades += report.totalTrades;
        totalWins += report.wins;
        totalLosses += report.losses;
      } catch (err) {
        console.error(`\n    ERROR on ${date}: ${err.message}`);
        dateResults[date] = { totalPnlPts: 0, totalTrades: 0, wins: 0, losses: 0 };
      }
    }

    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : 'N/A';
    console.log(` ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} pts (${totalTrades}T, ${totalWins}W/${totalLosses}L, ${winRate}%)`);

    results.push({
      strategy: strat.name,
      desc: strat.desc,
      config: strat.config,
      totalPnl,
      totalTrades,
      totalWins,
      totalLosses,
      winRate,
      dateResults,
    });
  }

  // Sort by total P&L descending
  results.sort((a, b) => b.totalPnl - a.totalPnl);

  // ---- Summary Table ----
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  RANKINGS — Sorted by Total P&L`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`${'Rank'.padStart(4)} | ${'Strategy'.padEnd(30)} | ${'Total P&L'.padStart(10)} | ${'Trades'.padStart(6)} | ${'WR'.padStart(4)} | ${DATES.map(d => d.slice(5).padStart(10)).join(' | ')}`);
  console.log(`${'-'.repeat(4)} | ${'-'.repeat(30)} | ${'-'.repeat(10)} | ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${DATES.map(() => '-'.repeat(10)).join(' | ')}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pnlStr = `${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(2)}`;
    const datePnls = DATES.map(d => {
      const dr = r.dateResults[d];
      const p = dr?.totalPnlPts ?? 0;
      return `${p >= 0 ? '+' : ''}${p.toFixed(2)}`.padStart(10);
    }).join(' | ');
    console.log(`${String(i + 1).padStart(4)} | ${r.strategy.padEnd(30)} | ${pnlStr.padStart(10)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate + '%').padStart(4)} | ${datePnls}`);
  }

  // ---- Top 3 detail ----
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  TOP 3 STRATEGIES — Detail`);
  console.log(`${'='.repeat(70)}`);

  for (let i = 0; i < Math.min(3, results.length); i++) {
    const r = results[i];
    console.log(`\n  #${i + 1}: ${r.strategy}`);
    console.log(`  ${r.desc}`);
    console.log(`  Config: ${JSON.stringify(r.config)}`);
    console.log(`  Total: ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(2)} pts | ${r.totalTrades}T ${r.totalWins}W/${r.totalLosses}L (${r.winRate}%)`);

    for (const date of DATES) {
      const dr = r.dateResults[date];
      if (!dr) continue;
      const pnl = `${dr.totalPnlPts >= 0 ? '+' : ''}${dr.totalPnlPts.toFixed(2)}`;
      console.log(`  ${date}: ${pnl} pts | ${dr.totalTrades}T ${dr.wins}W/${dr.losses}L`);
      if (dr.trades) {
        for (const t of dr.trades) {
          const tPnl = `${t.spxChange > 0 ? '+' : ''}${t.spxChange}`;
          console.log(`    ${t.openedAt.slice(11)} ${t.direction.padEnd(7)} ${t.pattern.padEnd(20)} ${tPnl.padStart(7)} pts ${t.exitReason}`);
        }
      }
    }
  }

  console.log(`\n${'='.repeat(70)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
