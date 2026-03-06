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
  // Baseline: current config (P0 60s, +1pt)
  {
    name: '1. Baseline (60s/+1pt)',
    desc: 'Current config — exit if <+1pt at 60s',
    config: {},
  },

  // ---- "Exit if losing" approach: negative min_pts = max allowed loss ----
  // 60s timeframe
  {
    name: '2. 60s/-1pt',
    desc: '60s: exit only if losing >1pt',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: -1.0 },
  },
  {
    name: '3. 60s/-2pt',
    desc: '60s: exit only if losing >2pts',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: -2.0 },
  },
  {
    name: '4. 60s/-3pt',
    desc: '60s: exit only if losing >3pts',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: -3.0 },
  },

  // 90s timeframe
  {
    name: '5. 90s/-1pt',
    desc: '90s: exit only if losing >1pt',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: -1.0 },
  },
  {
    name: '6. 90s/-2pt',
    desc: '90s: exit only if losing >2pts',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: -2.0 },
  },
  {
    name: '7. 90s/-3pt',
    desc: '90s: exit only if losing >3pts',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: -3.0 },
  },

  // 120s timeframe
  {
    name: '8. 120s/-1pt',
    desc: '120s: exit only if losing >1pt',
    config: { momentum_phase0_seconds: 120, momentum_phase0_min_pts: -1.0 },
  },
  {
    name: '9. 120s/-2pt',
    desc: '120s: exit only if losing >2pts',
    config: { momentum_phase0_seconds: 120, momentum_phase0_min_pts: -2.0 },
  },
  {
    name: '10. 120s/-3pt',
    desc: '120s: exit only if losing >3pts',
    config: { momentum_phase0_seconds: 120, momentum_phase0_min_pts: -3.0 },
  },

  // ---- Hybrid: softer gain requirement (not as strict as +1pt) ----
  {
    name: '11. 60s/+0.5pt',
    desc: '60s: exit if <+0.5pt (original threshold)',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: 0.5 },
  },
  {
    name: '12. 90s/+0.5pt',
    desc: '90s: exit if <+0.5pt',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: 0.5 },
  },
  {
    name: '13. 90s/+1pt',
    desc: '90s: exit if <+1pt (more time to develop)',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: 1.0 },
  },
  {
    name: '14. 120s/+1pt',
    desc: '120s: exit if <+1pt',
    config: { momentum_phase0_seconds: 120, momentum_phase0_min_pts: 1.0 },
  },

  // ---- "Break even or better" ----
  {
    name: '15. 60s/0pt',
    desc: '60s: exit only if losing (must be >=0)',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: 0 },
  },
  {
    name: '16. 90s/0pt',
    desc: '90s: exit only if losing (must be >=0)',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: 0 },
  },
  {
    name: '17. 120s/0pt',
    desc: '120s: exit only if losing (must be >=0)',
    config: { momentum_phase0_seconds: 120, momentum_phase0_min_pts: 0 },
  },

  // ---- No Phase 0 at all (disable early exit) ----
  {
    name: '18. No Phase 0',
    desc: 'Disable Phase 0 entirely (first check at Phase 1 / 7min)',
    config: { momentum_phase0_seconds: 0 },
  },

  // ---- Best combos with Phase 1 tuning ----
  {
    name: '19. 90s/-2pt + P1-5min',
    desc: '90s max loss 2pt + Phase 1 at 5min',
    config: { momentum_phase0_seconds: 90, momentum_phase0_min_pts: -2.0, momentum_phase1_minutes: 5 },
  },
  {
    name: '20. 60s/-2pt + P1-5min',
    desc: '60s max loss 2pt + Phase 1 at 5min',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: -2.0, momentum_phase1_minutes: 5 },
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
