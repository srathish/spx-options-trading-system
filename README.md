# OpenClaw

Autonomous SPX 0DTE options trading system. Analyzes gamma exposure (GEX) data from Heatseeker, combines it with TradingView technical indicator signals, and uses a Kimi K2.5 AI decision engine to generate structured trading decisions in real time.

## Architecture

```
Heatseeker API ──┐
  (SPXW/SPY/QQQ) │    ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
                  ├───>│  GEX Engine  ├───>│  Decision    ├───>│  Trade Exec │
TradingView ─────┤    │  (scoring +  │    │  Engine      │    │  (Polygon   │
  (7 indicators) │    │  multi-ticker│    │  (Kimi K2.5) │    │   options)  │
                  │    │  analysis)   │    └──────┬───────┘    └──────┬──────┘
Polygon.io ──────┘    └─────────────┘           │                    │
                                                 v                    v
                                          ┌─────────────┐    ┌──────────────┐
                                          │  Discord     │    │  Dashboard   │
                                          │  Alerts      │    │  (Next.js)   │
                                          └─────────────┘    └──────────────┘
```

### Core Pipeline

Every 15-30 seconds (depending on market phase), the main loop:

1. **Fetches** GEX data for SPXW, SPY, and QQQ via the Heatseeker API
2. **Parses** gamma + vanna exposure across all strikes
3. **Scores** directional bias (0-100) with wall classification, midpoint detection, air pocket quality
4. **Analyzes** cross-market patterns (driver detection, alignment, stacked walls, rug setups, node slides)
5. **Combines** with TradingView signals (helix, diamonds, mountain, voila, echo, bravo, tango)
6. **Decides** via Kimi K2.5 AI agent: ENTER_CALLS, ENTER_PUTS, EXIT_CALLS, EXIT_PUTS, or WAIT
7. **Executes** trades via Polygon options chain (strike selection, target/stop calculation)
8. **Alerts** Discord with trade cards, signal changes, wall movements, and health heartbeats

### Self-Improvement Loop

- **Nightly reviews** (2 AM ET): Kimi analyzes the day's trades, adjusts strategy parameters, creates new strategy version
- **Weekly reviews** (Sundays): Broader pattern analysis across the week
- **Phantom trades**: When already in a position, alternative entries are tracked as "phantom" trades for comparison
- **Auto-rollback**: If a new strategy version underperforms, automatically reverts to the previous version
- **Strategy versioning**: Every parameter change is versioned and auditable

## Project Structure

```
src/
  agent/           Kimi K2.5 decision engine + system prompt
  alerts/          Discord webhook alerts + throttling
  dashboard/       Express + WebSocket server for Next.js dashboard
  gex/             GEX parsing, scoring, multi-ticker analysis, node tracking
  pipeline/        Main polling loop + loop status
  polygon/         Polygon.io client, options chain, price feed
  review/          Nightly/weekly reviews, phantom engine, rollback, strategy store
  store/           SQLite database (better-sqlite3)
  trades/          Trade manager, strike selector, target calculator, phantom tracker
  tv/              TradingView webhook server + signal store
  utils/           Config, logger, market hours
dashboard/         Next.js 14 dashboard (App Router + Tailwind)
claw               CLI tool for quick commands
```

## Setup

### Prerequisites

- Node.js 20+
- PM2 (`npm install -g pm2`)
- Heatseeker account (for GEX data)
- Polygon.io API key (free tier works)
- Moonshot AI API key (for Kimi K2.5)
- Discord webhook URL
- TradingView alerts configured to send webhooks

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
# Development
npm run dev

# Production (via PM2)
pm2 start ecosystem.config.cjs
pm2 logs openclaw

# CLI shortcuts
./claw status        # System status
./claw score         # Current GEX score
./claw decision      # Latest agent decision
./claw trades        # Trade history
./claw health        # Health check
./claw strategy      # Current strategy version
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

## TradingView Indicators

The system integrates 7 TradingView indicators via webhook:

| Indicator | Signal Type | Description |
|-----------|-------------|-------------|
| **Helix** | Trend | Green steep/shallow (bullish) or purple steep/shallow (bearish). Flat helix blocks all entries |
| **Echo** | Momentum | Blue (bullish) or pink (bearish) diamonds. Fast signal, good for timing |
| **Bravo** | Reversal | Blue/pink/white diamonds. White = highest conviction |
| **Tango** | Slow Trend | Blue or pink diamonds. Slowest timeframe, highest conviction |
| **Mountain** | Trend | Up (bullish) or down (bearish) envelope |
| **Voila** | S/R Levels | Gold (strongest), green/purple, silver support/resistance levels |
| **Oscar** | Baseline | Support/resistance baseline reference |

## Tech Stack

- **Runtime**: Node.js 20+ (ES modules)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **AI Agent**: Kimi K2.5 via Moonshot API (OpenAI-compatible)
- **Market Data**: Heatseeker (GEX), Polygon.io (options chains), TradingView (technicals)
- **Dashboard**: Next.js 14, Tailwind CSS, WebSocket real-time updates
- **Alerts**: Discord webhooks
- **Process Management**: PM2
- **Timezone**: All market logic in US Eastern Time (via Luxon)

## License

UNLICENSED - Private use only.
