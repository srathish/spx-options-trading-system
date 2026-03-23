# GexClaw

Autonomous SPX 0DTE options trading system powered by real-time gamma exposure (GEX) analysis and LLM-driven narrative reasoning. Two systems: a mechanical pattern engine for high-frequency entries, and an LLM king node system that reads the full GEX landscape like a human trader — tracking magnets, squeezes, vacuum zones, and gamma flip levels every 10 minutes.

## Architecture

```
Heatseeker API ──┐
  (SPXW/SPY/QQQ) │     ┌───────────── ┐    ┌──────────────┐    ┌─────────────┐
                 ├───> │  GEX Engine  ├───>│  Algorithmic ├───>│  Trade Exec │
TradingView ─────┤     │  (scoring +  │    │  Entry Engine │    │  (SPX-based │
  (Echo/Bravo/   │     │  multi-ticker│    │  (Lane A/B)  │    │   P&L)      │
   Tango)        │     │  analysis)   │    └──────┬───────┘    └──────┬──────┘
                  │    └──────┬────── ┘           │                   │
                  │           │                   v                   v
                  │           │            ┌─────────────┐    ┌──────────────┐
                  │           │            │  Kimi K2.5   │    │  Dashboard   │
                  │           │            │  Exit Advisor│    │  (Next.js)   │
                  │           │            └──────┬──────┘    └──────────────┘
                  │           │                   │
                  │           │                   v
                  │           │            ┌─────────────┐
                  │           │            │  Discord     │
                  │           │            │  Alerts      │
                  │           │            └─────────────┘
                  │           v
                  │    ┌─────────────────────────────────────────────────────┐
                  │    │  Raw GEX Snapshots (SQLite)                         │
                  │    │  Strike-level Maps stored every cycle (30-day)      │
                  │    └──────────────────────┬──────────────────────────────┘
                  │                           │
                  │                           v
                  │    ┌─────────────────────────────────────────────────────┐
                  ├───>│  Self-Improvement Loop                              │
                  │    │  (Nightly reviews, phantom trades, auto-rollback)   │
                  │    └─────────────────────────────────────────────────────┘
                  │                           │
                  │                           v
                  │    ┌─────────────────────────────────────────────────────┐
                  └───>│  Replay Engine (./claw replay <date>)               │
                       │  Full-day backtesting with current strategy config   │
                       └─────────────────────────────────────────────────────┘
```

### Core Pipeline

Every 5 seconds during market hours (30s pre-market), the main loop:

1. **Fetches** GEX data for SPXW, SPY, and QQQ in parallel via the Heatseeker API
2. **Parses** gamma + vanna exposure across all strikes, identifies walls
3. **Scores** directional bias (0-100) with EMA smoothing, wall classification, midpoint detection, air pocket quality
4. **Analyzes** cross-market patterns (driver detection, alignment, stacked walls, rug setups, node slides, reshuffles)
5. **Tracks** node touches, wall strength trends (GROWING/STABLE/WEAKENING/GONE), regime persistence, chop mode
6. **Detects** entry patterns algorithmically (no AI needed): RUG_PULL, REVERSE_RUG, AIR_POCKET, KING_NODE_BOUNCE, PIKA_PILLOW, etc.
7. **Enters** via Lane A (GEX-only patterns → live trades) after passing 12 entry quality gates
8. **Manages** positions with 13 exit triggers (target, stop, profit target, trailing stop, momentum phases, TV flip, GEX flip, etc.)
9. **Advises** via Kimi K2.5 AI agent — called ONLY when in a position, for exit advisory (requires structural confirmation)
10. **Phantoms** blocked entries and Lane B (GEX+TV) signals as phantom trades for comparison
11. **Alerts** Discord with trade cards, signal changes, wall movements, and health heartbeats
12. **Snapshots** raw strike-level GEX data to SQLite for replay engine backtesting

### Two-Lane Entry System

Entries are fully algorithmic — no AI agent call needed. The system uses two lanes:

- **Lane A (GEX-only)**: Detected patterns pass 4 structural gates (alignment, midpoint, min score, power hour) + 12 quality gates → live trades
- **Lane B (GEX+TV)**: Same pattern detection + requires TradingView confirmation (min TV weight + indicator count) → phantom trades for performance comparison

When a Lane A entry is blocked by quality gates, a phantom trade is created to track what would have happened. This data feeds into nightly reviews.

### Trade Management

The system uses SPX-based P&L tracking (no live options pricing needed) with 13 exit triggers in priority order:

| # | Trigger | Type | Description |
|---|---------|------|-------------|
| 1 | TARGET_HIT | Immediate | SPX reached the target GEX wall |
| 2 | NODE_SUPPORT_BREAK | Immediate | Trend-aware: GONE = instant exit, WEAKENING = tighter buffer, GROWING = wider buffer |
| 3 | STOP_HIT | Immediate | SPX broke through the stop level |
| 4 | PROFIT_TARGET | Immediate | +0.15% SPX move (configurable) |
| 5 | STOP_LOSS | Immediate | -0.20% adverse move (configurable) |
| 6 | TV_COUNTER_FLIP | 3 min hold | Both Bravo AND Tango 3m flipped against position |
| 7 | OPPOSING_WALL | 3 min hold | Large positive wall ($5M+) materialized against position |
| 8 | MOMENTUM_TIMEOUT | Phase 0: 60s | Phase 0 catches dead trades (< 1pt after 60s); phases 1-3 at 5/10/15 min with progressive thresholds |
| 9 | TV_FLIP | 3 min hold | 2+ opposing 3m TradingView signals (all 3m indicators, not just Bravo/Tango) |
| 10 | TRAILING_STOP | 3 min hold | Activated after +8pt, trails 5pt behind best |
| 11 | AGENT_EXIT | 3 min hold | AI agent recommends exit — requires structural confirmation (price near node, momentum stalled, or GEX score dropped) |
| 12 | THETA_DEATH | Immediate | 3:30 PM ET cutoff for 0DTE |
| 13 | GEX_FLIP | 3 min hold | GEX direction flipped against position with score above exit threshold |

Note: MAP_RESHUFFLE is detected and flagged for agent review but does not auto-exit.

### Entry Quality Gates

12 gates validate every algorithmic entry signal:

1. **Entry spacing** — 60s minimum between any entries (configurable)
2. **Blackout period** — No entries 9:30-9:33 AM ET (first 3 minutes of market open)
3. **Consecutive loss cooldown** — 15 min cooldown after 2 consecutive same-direction losses
4. **TV Regime** — Pink Diamond = bearish regime blocks calls; Blue Diamond = bullish regime blocks puts (Lane A skips this gate)
5. **Re-entry cooldown** — Same spacing after exiting same direction
6. **Direction stability** — Score must agree 3 consecutive cycles
7. **Direction flip wait** — 4 cycles after a direction flip
8. **Time gate** — No entries after 3:30 PM ET (configurable via `no_entry_after`)
9. **Opening caution** — Score >= 85 and 3/3 alignment during 9:33-9:40 AM
10. **Chop mode** — Score >= 80 required when chop detected (6+ direction flips or score stddev > 20)
11. **Alignment** — Need 2/3 ticker alignment or high GEX score override (configurable)
12. **Regime persistence** — Blocks entries against a persistent opposing GEX regime (36+ consecutive cycles)

### Self-Improvement Loop

- **Nightly reviews** (4:10 PM ET, right after market close): Kimi analyzes the day's trades, adjusts strategy parameters, creates new strategy version, generates morning briefing
- **Weekly reviews** (Sundays): Broader pattern analysis across the week
- **Phantom trades**: Blocked entries and Lane B signals tracked as phantom trades for comparison against live performance
- **Phantom comparison**: After each trade close, compares live result against phantom alternatives
- **Auto-rollback**: If a new strategy version underperforms, automatically reverts to the previous version
- **Strategy versioning**: Every parameter change is versioned and auditable (40+ tunable params)
- **Pattern outcome tracking**: 7-day rolling win rate and P&L by entry trigger pattern, fed into nightly reviews for data-backed trigger weight adjustments
- **Replay engine**: Full-day backtesting against stored raw GEX snapshots — test strategy changes in minutes instead of waiting for live market sessions

### Replay Engine

Every cycle, the system stores raw strike-level GEX data (aggregatedGex, allExpGex, nearTermGex, vexMap) for SPXW, SPY, and QQQ. The replay engine reads these snapshots and drives the full pipeline — scoring, pattern detection, entry gates, exit triggers — using the current active strategy config.

```bash
./claw replay 2026-02-28       # Replay a specific date
./claw replay                  # Show available dates
```

Output includes trade log, P&L summary, pattern performance, and exit reason breakdown. Change a strategy parameter, re-run replay, compare results instantly.

### Chop Mode Detection

The system tracks GEX score history over a 30-minute rolling window and detects market chop:
- **Direction flips**: 6+ direction changes in 60 cycles = CHOP (configurable)
- **Score volatility**: Standard deviation > 20 = CHOP (configurable)
- During chop: entries require GEX score >= 80, agent receives `market_mode` context
- Dashboard shows a CHOP badge on the signal banner

## Project Structure

```
src/
  agent/           Kimi K2.5 exit advisor + system prompt + chat agent
  alerts/          Discord webhook alerts + throttling
  backtest/        Replay engine for backtesting against stored GEX snapshots
  dashboard/       Express + WebSocket server for Next.js dashboard
  gex/             GEX parsing, scoring, multi-ticker analysis, node tracking
    trinity.js       Multi-ticker parallel fetch (SPXW/SPY/QQQ)
    multi-ticker-analyzer.js  Driver detection, alignment, stacked walls, rug setups, node slides
  pipeline/        Main polling loop + loop status
  review/          Nightly/weekly reviews, phantom engine, rollback, strategy store
    phantom-engine.js  Post-trade phantom comparison
    rollback-engine.js Strategy rollback triggers
  store/           SQLite database (better-sqlite3) + state management
  trades/          Trade manager, entry engine, entry gates, phantom tracker
    entry-engine.js   Lane A (GEX-only) + Lane B (GEX+TV) algorithmic entries
    entry-gates.js    12 entry quality gates
    entry-context.js  Support/ceiling node context for exit tracking
  tv/              TradingView webhook server + multi-indicator signal store
  utils/           Config, logger, market hours
dashboard/         Next.js 14 dashboard (App Router + Tailwind)
  app/trading/     Real-time trading view (signals, positions, GEX, alerts)
  app/ideas/       Trade ideas feed + table with date navigation
  app/performance/ Trade log + P&L analytics
  app/strategy/    Strategy versions + wall map
  app/system/      Service health monitoring
claw               CLI tool for quick commands
```

## Dashboard

Real-time Next.js dashboard with WebSocket updates:

- **Trading** — Signal banner, position card (active or last trade), GEX panel, TV grid, alert feed, chop mode badge
- **Ideas** — Scrollable feed and compact table of all trade ideas with date picker (historical browsing)
- **Performance** — Trade log with P&L, win rate, and analytics
- **Strategy** — Version history, wall map visualization, rollback history
- **System** — Service health grid, connection status

## Setup

### Prerequisites

- Node.js 20+
- PM2 (`npm install -g pm2`)
- Heatseeker account (for GEX data)
- Moonshot AI API key (for Kimi K2.5)
- Discord webhook URL
- TradingView alerts configured to send webhooks (Echo, Bravo, Tango on SPX/SPY/QQQ)

### Installation

```bash
git clone https://github.com/srathish/spx-options-trading-system.git
cd spx-options-trading-system
npm install
cd dashboard && npm install && npm run build && cd ..
cp .env.example .env
# Edit .env with your API keys
```

### Running

```bash
# Production (via PM2)
pm2 start ecosystem.config.cjs
pm2 logs gexclaw

# CLI shortcuts
./claw status        # System status
./claw gex           # Latest GEX snapshot
./claw health        # Health check
./claw strategy      # Current strategy version
./claw replay <date> # Replay a day through current strategy
./claw review        # Run manual nightly review
./claw briefing      # Show latest morning briefing
```

## GEX Analysis Features

| Feature | Description |
|---------|-------------|
| **Multi-Ticker Trinity** | Simultaneous SPXW/SPY/QQQ analysis with driver detection and cross-market alignment |
| **Gatekeeper Nodes** | Classifies walls as GATEKEEPER (barrier), MAGNET (attractor), ANCHOR (structural), or NOISE |
| **Midpoint Danger Zone** | Detects when price is trapped between two walls with no directional edge |
| **Node Touch Counting** | Tracks how many times price tests each wall (1st touch = bounce, 3rd+ = breakthrough) |
| **Rolling Walls** | Detects ceilings/floors that shift strike between reads (dealer repositioning) |
| **Map Reshuffle** | Alerts when the GEX map changes dramatically (invalidates previous analysis) |
| **Air Pocket Quality** | Assesses path clarity to target: HIGH, MEDIUM, LOW, or BLOCKED |
| **Power Hour** | Adjusts behavior during 3:30-4:00 PM ET (0DTE expiration effects) |
| **OPEX Awareness** | Magnifies wall importance during monthly options expiration week/day |
| **Hedge Nodes** | Identifies institutional multi-day hedges via allExp/0DTE ratio analysis |
| **VEX Confluence** | Analyzes vanna + gamma alignment at walls (REINFORCING vs OPPOSING) |
| **Node Strength Trends** | Tracks wall growth/decay over time: GROWING, STABLE, WEAKENING, GONE |
| **Conflicting Pattern Resolution** | When BULLISH and BEARISH patterns fire simultaneously, downgrades the side opposing GEX structure |
| **Multi-Exp Wall Confirmation** | Walls with 50%+ extra GEX from non-0DTE expirations get confidence upgrades (structurally stronger) |
| **Position-Aware Patterns** | Patterns opposing current position flagged for exit consideration rather than entry |
| **GEX Regime Persistence** | Tracks consecutive same-direction cycles; 36+ cycles = persistent regime gates entries |
| **EMA Score Smoothing** | Smoothed GEX score reduces noise from cycle-to-cycle variance |
| **Spot Momentum** | 15-reading smoothed momentum tracking for trend confirmation |

## TradingView Indicators

3 indicators across SPX/SPY/QQQ on 1m and 3m timeframes (14 webhook alerts total):

| Indicator | Timeframes | Weight | Description |
|-----------|------------|--------|-------------|
| **Echo** | 3m (SPX only) | 0.75 | Fastest early warning. Blue = bullish, Pink = bearish |
| **Bravo** | 1m (0.75), 3m (1.0) | Primary | Confirmation indicator. Diamond signals set the TV regime (Pink Diamond = bearish, Blue Diamond = bullish) |
| **Tango** | 1m (1.0), 3m (1.5) | Highest | Slowest, highest conviction. When Tango confirms, confidence jumps |

TV confidence levels: MASTER (3/3 SPX 3m agree), INTERMEDIATE (2/3), BEGINNER (1/3), NONE.

Signal staleness: 1m signals expire after 3 min, 3m signals after 9 min.

## Tech Stack

- **Runtime**: Node.js 20+ (ES modules)
- **Database**: SQLite via better-sqlite3 (WAL mode, 7-day scored data + 30-day raw snapshots)
- **AI Agent**: Kimi K2.5 via Moonshot API (OpenAI-compatible) — exit advisory only, entries are algorithmic
- **Market Data**: Heatseeker (GEX), TradingView (technicals via webhooks)
- **Dashboard**: Next.js 14, Tailwind CSS, WebSocket real-time updates
- **Alerts**: Discord webhooks
- **Process Management**: PM2
- **Timezone**: All market logic in US Eastern Time (via Luxon)

## LLM King Node System

A second trading system (`src/backtest/replay-llm-king.js`) that uses Moonshot AI to analyze GEX snapshots every 10 minutes, reasoning about the data like a human trader watching the Heatseeker chart.

### Three GEX Forces
1. **Negative Gamma Magnets** — pull price toward them (core signal)
2. **Positive Gamma Pins** — hold price, but become squeeze accelerants when breached
3. **Gamma Squeezes** — when positive gamma overwhelms negative on one side, dealers hedge WITH price

### Five Trading Modes
| Mode | Trigger | When |
|------|---------|------|
| **TREND** | Big negative magnet far from spot, quality 55+ | 10:00-15:00 |
| **SQUEEZE** | Price breaches positive wall + squeeze pressure confirmed | Anytime |
| **DEFY** | Price moves 40+ pts against GEX in NEGATIVE regime | 11:00+ |
| **BREAKOUT** | Price escapes 20-60 pts from a big pin at spot | 10:30+ |

### What the LLM Sees
- King node vs biggest magnet (separated)
- Gamma balance with squeeze detection (POS vs NEG on each side)
- Net GEX regime: POSITIVE (pinning) vs NEGATIVE (amplifying)
- Gamma flip level (above = stable, below = moves accelerate)
- Vacuum zones (low-resistance corridors between walls)
- GEX concentration (tight gravity vs loose structure)
- SPY/QQQ cross-market alignment
- Narrative: king node history, growth, stability, competing nodes

### LLM Output Structure
The LLM must name contradictory signals explicitly:
```json
{
  "direction": "BEARISH",
  "confidence": "HIGH",
  "primary_signal": "6500 magnet at -45M, 60pts below, growing, no competition",
  "opposing_signal": "Squeeze UP: POS above 30M vs NEG below 20M",
  "why_primary_wins": "Magnet is 2x the squeeze force and has been dominant 90% of day"
}
```

### Safety Mechanisms
- **Thesis hold**: suppress price stop when target node still alive
- **Quality score (0-100)**: gates on distance, relative size, squeeze opposition, time
- **DEFY regime filter**: only in NEGATIVE GEX (dealers amplifying, not pinning)
- **SQUEEZE breach trigger**: price must cross through a positive wall (structural event)
- **Relative sanity check**: LLM exit ignored only if magnet still dominant (not just alive)
- **Wall breach detection**: tracks top positive walls, detects when price crosses through

### Backtesting
```bash
# Single day with narrative analysis
node src/backtest/replay-llm-king.js data/gex-replay-2026-03-20.json --verbose

# Full 62-day batch (caches all LLM calls)
node src/backtest/replay-llm-king.js --batch data/gex-replay-*.json
```

## License

UNLICENSED - Private use only.
