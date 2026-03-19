# Claude Code Instructions for GexClaw

## Project Context
SPX 0DTE options trading system (Node.js ES modules). Real-time GEX (gamma exposure) analysis drives algorithmic entries/exits. Runs 24/7 on Mac Mini via PM2.

**Key constraint**: Every change to strategy logic affects real money. Verify rigorously before deploying.

## Working Effectively

### Break Down Complex Problems
Divide large features into smaller, verifiable steps. If a task is too complex (e.g., "make the system profitable"), break it into atomic sub-problems:
- Identify one specific drain (e.g., "REVERSE_RUG morning has 0% WR")
- Implement one targeted fix (e.g., add Gate 20 morning blackout)
- Verify with batch replay before moving to next improvement

### Backtest-First Workflow
Always verify changes with the 60-day batch replay before committing:
```bash
bash scripts/batch-replay.sh 2>/dev/null | tail -3
node scripts/analyze-results.js 2>/dev/null | head -40
```
Never assume a change helps — run the numbers.

### Overfitting Check
Before accepting any change, ask:
1. How many trades does this rule affect?
2. What's the win rate of blocked trades?
3. Is the win rate lower than system average (45.7%)?
If any rule affects < 5 trades, treat the result with skepticism.

## Architecture Quick Reference
- **Entry point**: `src/index.js` → `src/pipeline/main-loop.js`
- **GEX scoring**: `src/gex/gex-scorer.js`
- **Pattern detection**: `src/gex/gex-patterns.js`
- **Entry gates**: `src/trades/entry-gates.js` — all pre-entry validation
- **Replay engine**: `src/backtest/replay-json.js` — 60-day backtest
- **Strategy config**: DB `strategy_versions` table, read via `getActiveConfig()`
- **Batch replay data**: `data/gex-replay-*.json` (60 files, trinity SPXW+SPY+QQQ)

## Strategy Config (DB-driven)
All tunable parameters live in `strategy_versions` table. The active version is used by both live system and replay. To test a change:
```javascript
// In Node.js REPL or script:
const db = new Database('./data/spx-bot.db');
const v = db.prepare('SELECT config FROM strategy_versions WHERE is_active = 1').get();
const cfg = JSON.parse(v.config);
cfg.some_param = new_value;
// Insert new version, activate it, then run batch replay
```

## Key Patterns
- **Logger**: `createLogger('Name')` from `src/utils/logger.js`
- **Config**: `getActiveConfig()` from `src/review/strategy-store.js`
- **ES modules**: Use `import/export` (not `require`). Exception: `.cjs` files for PM2.
- **SQLite**: `better-sqlite3` (synchronous). WAL mode. Never use async SQLite.

## Adding Entry Gates
Entry gates live in `src/trades/entry-gates.js`. To add a new gate:
1. Add after the last gate, before `return { allowed: true }`
2. Use `pattern` (from `opts.pattern`) and `timeET` (already computed)
3. Return `{ allowed: false, reason: 'Description' }` to block
4. Add corresponding config key to DB strategy config

## Replay Output Analysis
The batch replay produces `data/batch-replay-results.txt`. Parse it with:
- `node scripts/analyze-results.js` — aggregated stats
- `python3 scripts/direction-analysis.py` — breakdown by direction+pattern
- `python3 scripts/morning-analysis.py` — early-morning (9:33-9:49) breakdown
- `python3 scripts/score-analysis.py` — GEX score vs outcome distribution

## Current Performance Baseline (v16, 2026-03-16)
- 60-day batch: **479 trades | 219W/260L (45.7% WR) | NET +780.84 pts**
- Key patterns: MAGNET_PULL +576, RUG_PULL +161, REVERSE_RUG +44
- Main drains: STOP_HIT -400, TM_STOP_HIT -231, GEX_FLIP -41
- Best exits: TM_TARGET_HIT +518, TM_TRAILING_STOP +504, TM_PROFIT_TARGET +339

## Do Not
- Deploy to live system without running the 60-day batch replay first
- Add per-day or per-date overrides (obvious overfitting)
- Skip the `getActiveConfig()` pattern — never hardcode strategy params
- Use `require()` in `.js` files (ES module project, use `import`)
