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
  // Baseline
  {
    name: '1. Baseline (current)',
    desc: 'Current config — no changes',
    config: {},
  },

  // Fix 1: Faster Phase 0 exit
  {
    name: '2. Phase0 60s',
    desc: 'Exit duds in 60s instead of 120s',
    config: { momentum_phase0_seconds: 60 },
  },
  {
    name: '3. Phase0 90s',
    desc: 'Exit duds in 90s',
    config: { momentum_phase0_seconds: 90 },
  },
  {
    name: '4. Phase0 60s +1pt',
    desc: '60s exit, need +1pt instead of +0.5',
    config: { momentum_phase0_seconds: 60, momentum_phase0_min_pts: 1.0 },
  },

  // Fix 2: Pattern loss limit
  {
    name: '5. PatLoss 2/15m',
    desc: '2 pattern losses → 15m cooldown',
    config: { pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000 },
  },
  {
    name: '6. PatLoss 2/10m',
    desc: '2 pattern losses → 10m cooldown',
    config: { pattern_loss_limit: 2, pattern_loss_cooldown_ms: 10 * 60_000 },
  },
  {
    name: '7. PatLoss 3/15m',
    desc: '3 pattern losses → 15m cooldown (tighter than 30m)',
    config: { pattern_loss_limit: 3, pattern_loss_cooldown_ms: 15 * 60_000 },
  },

  // Fix 3: Same-direction cap
  {
    name: '8. DirCap 3/VH',
    desc: '3 same-dir losses → need VERY_HIGH',
    config: { direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },
  {
    name: '9. DirCap 2/VH',
    desc: '2 same-dir losses → need VERY_HIGH',
    config: { direction_loss_cap: 2, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },
  {
    name: '10. DirCap 3/HIGH',
    desc: '3 same-dir losses → need HIGH (softer)',
    config: { direction_loss_cap: 3, direction_loss_cap_min_confidence: 'HIGH' },
  },

  // Combos: Fix 1 + Fix 2
  {
    name: '11. P0-60s + PL-2/15m',
    desc: 'Fast exit + tight pattern cooldown',
    config: { momentum_phase0_seconds: 60, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000 },
  },
  {
    name: '12. P0-90s + PL-2/15m',
    desc: '90s exit + tight pattern cooldown',
    config: { momentum_phase0_seconds: 90, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000 },
  },

  // Combos: Fix 1 + Fix 3
  {
    name: '13. P0-60s + DC-3/VH',
    desc: 'Fast exit + direction cap',
    config: { momentum_phase0_seconds: 60, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },

  // Combos: Fix 2 + Fix 3
  {
    name: '14. PL-2/15m + DC-3/VH',
    desc: 'Tight pattern cooldown + direction cap',
    config: { pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },

  // All 3 fixes combined
  {
    name: '15. ALL: P0-60 PL-2 DC-3',
    desc: 'All 3 fixes: 60s exit, 2-loss pattern, 3-dir cap',
    config: { momentum_phase0_seconds: 60, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },
  {
    name: '16. ALL: P0-90 PL-2 DC-3',
    desc: 'All 3 fixes: 90s exit, 2-loss pattern, 3-dir cap',
    config: { momentum_phase0_seconds: 90, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },
  {
    name: '17. ALL: P0-60 PL-2 DC-2',
    desc: 'All 3 fixes aggressive: 60s, 2-pat, 2-dir',
    config: { momentum_phase0_seconds: 60, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 2, direction_loss_cap_min_confidence: 'VERY_HIGH' },
  },

  // Wider entry spacing combos
  {
    name: '18. ALL + 120s spacing',
    desc: 'All 3 fixes + 120s between entries',
    config: { momentum_phase0_seconds: 60, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH', entry_min_spacing_ms: 120_000 },
  },

  // Phase 1 tighter too
  {
    name: '19. P0-60 + P1-5min',
    desc: 'Fast Phase 0 + tighter Phase 1 (5min instead of 7)',
    config: { momentum_phase0_seconds: 60, momentum_phase1_minutes: 5 },
  },

  // Kitchen sink: best guess
  {
    name: '20. Best guess',
    desc: 'P0-60, PL-2/15m, DC-3/VH, P1-5min',
    config: { momentum_phase0_seconds: 60, pattern_loss_limit: 2, pattern_loss_cooldown_ms: 15 * 60_000, direction_loss_cap: 3, direction_loss_cap_min_confidence: 'VERY_HIGH', momentum_phase1_minutes: 5 },
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
