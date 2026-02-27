# GexClaw

Autonomous SPX 0DTE options trading system. Analyzes gamma exposure (GEX) data from Heatseeker, combines it with TradingView technical indicator signals (Echo + Bravo + Tango), and uses a Kimi K2.5 AI decision engine to generate structured trading decisions in real time.

## Architecture

```
Heatseeker API ──┐
  (SPXW/SPY/QQQ) │    ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
                  ├───>│  GEX Engine  ├───>│  Decision    ├───>│  Trade Exec │
TradingView ─────┤    │  (scoring +  │    │  Engine      │    │  (SPX-based │
  (Echo/Bravo/   │    │  multi-ticker│    │  (Kimi K2.5) │    │   P&L)      │
   Tango)        │    │  analysis)   │    └──────┬───────┘    └──────┬──────┘
                  │    └──────┬──────┘           │                    │
                  │           │                   v                    v
                  │           │            ┌─────────────┐    ┌──────────────┐
                  │           │            │  Discord     │    │  Dashboard   │
                  │           │            │  Alerts      │    │  (Next.js)   │
                  │           │            └─────────────┘    └──────────────┘
                  │           │
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

Every 15-30 seconds (depending on market phase), the main loop:

1. **Fetches** GEX data for SPXW, SPY, and QQQ via the Heatseeker API
2. **Parses** gamma + vanna exposure across all strikes
3. **Scores** directional bias (0-100) with wall classification, midpoint detection, air pocket quality
4. **Analyzes** cross-market patterns (driver detection, alignment, stacked walls, rug setups, node slides)
5. **Combines** with TradingView signals (Echo, Bravo, Tango across SPX/SPY/QQQ on 1m and 3m timeframes)
6. **Decides** via Kimi K2.5 AI agent: ENTER_CALLS, ENTER_PUTS, EXIT_CALLS, EXIT_PUTS, or WAIT
7. **Manages** positions with 12 exit triggers (target, stop, profit target, trailing stop, phase 0 momentum, TV flip, etc.)
8. **Alerts** Discord with trade cards, signal changes, wall movements, and health heartbeats
9. **Records** trade ideas to SQLite for historical analysis via the dashboard Ideas tab

### Trade Management

The system uses SPX-based P&L tracking (no live options pricing needed) with 12 exit triggers in priority order:

| # | Trigger | Type | Description |
|---|---------|------|-------------|
| 1 | TARGET_HIT | Immediate | SPX reached the target GEX wall |
| 2 | STOP_HIT | Immediate | SPX broke through the stop level |
| 3 | PROFIT_TARGET | Immediate | +0.15% SPX move (configurable) |
| 4 | STOP_LOSS | Immediate | -0.20% adverse move (configurable) |
| 5 | NODE_SUPPORT_BREAK | Immediate | Trend-aware: GONE = instant exit, WEAKENING = tighter buffer, GROWING = wider buffer |
| 6 | OPPOSING_WALL | 3 min hold | Large positive wall ($5M+) materialized against position |
| 7 | TV_FLIP | 3 min hold | 2+ opposing 3m TradingView signals |
| 8 | MOMENTUM_TIMEOUT | Phase 0: 60s | Phase 0 catches dead trades at 60s; phases 1-3 at 5/10/15 min |
| 9 | MAP_RESHUFFLE | 3 min hold | GEX map changed dramatically |
| 10 | TRAILING_STOP | 3 min hold | Activated after +8pt, trails 5pt behind best |
| 11 | AGENT_EXIT | 3 min hold | AI agent recommends exit |
| 12 | THETA_DEATH | Immediate | 3:30 PM ET cutoff for 0DTE |

### Entry Guardrails

12 rules gate every entry signal from the AI agent:

1. **TV Regime** — Pink Diamond = bearish regime (no calls until Blue Diamond)
2. **Alignment + TV** — Need 2/3 ticker alignment or TV confirmation (configurable)
3. **Re-entry cooldown** — 5 min after exiting same direction
4. **Max trades/day** — 8 trades maximum
5. **Min time between entries** — 5 min between any entries
6. **Direction stability** — Score must agree 3 consecutive cycles
7. **Direction flip wait** — 4 cycles after a direction flip
8. **Time gate** — No entries after 3:00 PM ET
9. **Opening caution** — Score >= 85 and 3/3 alignment during 9:30-9:40 AM
10. **Chop mode** — Score >= 80 required when chop detected (6+ direction flips or score stddev > 20)
11. **Consecutive loss cooldown** — 15 min cooldown after 2 consecutive losses
12. **Regime persistence** — Blocks entries against a persistent opposing GEX regime (36+ consecutive cycles)

### Self-Improvement Loop

- **Nightly reviews** (2 AM ET): Kimi analyzes the day's trades, adjusts strategy parameters, creates new strategy version
- **Weekly reviews** (Sundays): Broader pattern analysis across the week
- **Phantom trades**: When already in a position, alternative entries are tracked as "phantom" trades for comparison
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
- **Direction flips**: 6+ direction changes in 60 cycles = CHOP
- **Score volatility**: Standard deviation > 20 = CHOP
- During chop: entries require GEX score >= 80, agent receives `market_mode` context
- Dashboard shows a CHOP badge on the signal banner

## Project Structure

```
src/
  agent/           Kimi K2.5 decision engine + system prompt + chat agent
  alerts/          Discord webhook alerts + throttling
  backtest/        Replay engine for backtesting against stored GEX snapshots
  dashboard/       Express + WebSocket server for Next.js dashboard
  gex/             GEX parsing, scoring, multi-ticker analysis, node tracking
  pipeline/        Main polling loop + loop status
  review/          Nightly/weekly reviews, phantom engine, rollback, strategy store
  store/           SQLite database (better-sqlite3) + state management
  trades/          Trade manager, target calculator, phantom tracker
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

- **Trading** — Signal banner, position card (active or last trade), GEX panel, TV grid, alert feed
- **Ideas** — Scrollable feed and compact table of all trade ideas with date picker (historical browsing)
- **Performance** — Trade log with P&L, win rate, and analytics
- **Strategy** — Version history, wall map visualization
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

## TradingView Indicators

3 indicators across SPX/SPY/QQQ on 1m and 3m timeframes (14 webhook alerts total):

| Indicator | Timeframes | Weight | Description |
|-----------|------------|--------|-------------|
| **Echo** | 3m (SPX only) | 0.75 | Fastest early warning. Blue = bullish, Pink = bearish |
| **Bravo** | 1m (0.75), 3m (1.0) | Primary | Confirmation indicator. Diamond signals set the TV regime |
| **Tango** | 1m (1.0), 3m (1.5) | Highest | Slowest, highest conviction. When Tango confirms, confidence jumps |

TV confidence levels: MASTER (3/3 SPX 3m agree), INTERMEDIATE (2/3), BEGINNER (1/3), NONE.

## Tech Stack

- **Runtime**: Node.js 20+ (ES modules)
- **Database**: SQLite via better-sqlite3 (WAL mode, 7-day data retention)
- **AI Agent**: Kimi K2.5 via Moonshot API (OpenAI-compatible)
- **Market Data**: Heatseeker (GEX), TradingView (technicals via webhooks)
- **Dashboard**: Next.js 14, Tailwind CSS, WebSocket real-time updates
- **Alerts**: Discord webhooks
- **Process Management**: PM2
- **Timezone**: All market logic in US Eastern Time (via Luxon)

## License

UNLICENSED - Private use only.
