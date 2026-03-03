# GexClaw — SPX 0DTE Options Trading System

Fully automated SPX 0DTE options trading system. Reads real-time Gamma Exposure (GEX) data from 3 tickers (SPXW, SPY, QQQ), detects structural patterns in dealer hedging flows, and trades call/put entries with algorithmic exits. Every decision is data-driven — no discretionary trading.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Pipeline](#data-pipeline)
3. [GEX Scoring Engine](#gex-scoring-engine)
4. [Multi-Ticker Analysis](#multi-ticker-analysis)
5. [Pattern Detection](#pattern-detection)
6. [Trend Detection](#trend-detection)
7. [Entry Decision Engine](#entry-decision-engine)
8. [Entry Quality Gates](#entry-quality-gates)
9. [Exit Engine](#exit-engine)
10. [State Tracking](#state-tracking)
11. [TradingView Integration](#tradingview-integration)
12. [AI Agent (Exit Advisor)](#ai-agent-exit-advisor)
13. [Self-Improvement Loop](#self-improvement-loop)
14. [Backtesting / Replay Engine](#backtesting--replay-engine)
15. [Storage](#storage)
16. [Discord Alerts](#discord-alerts)
17. [Dashboard](#dashboard)
18. [Strategy Configuration](#strategy-configuration)
19. [Key Concepts Glossary](#key-concepts-glossary)
20. [Project Structure](#project-structure)

---

## Architecture Overview

```
Heatseeker API ──┐
  (SPXW/SPY/QQQ) │     ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
                  ├───> │  GEX Engine   ├───>│  Algorithmic  ├───>│  Trade Exec │
TradingView ─────┤     │  (scoring +   │    │  Entry Engine │    │  (SPX-based │
  (Echo/Bravo/   │     │  multi-ticker) │    │  (Lane A/B)   │    │   P&L)      │
   Tango)        │     └──────┬────────┘    └──────┬────────┘    └──────┬──────┘
                 │            │                    │                    │
                 │            │                    v                    v
                 │            │             ┌─────────────┐    ┌──────────────┐
                 │            │             │  Kimi K2.5   │    │  Dashboard   │
                 │            │             │  Exit Advisor│    │  (Next.js)   │
                 │            │             └──────┬──────┘    └──────────────┘
                 │            │                    │
                 │            │                    v
                 │            │             ┌─────────────┐
                 │            │             │  Discord     │
                 │            │             │  Alerts      │
                 │            │             └─────────────┘
                 │            v
                 │     ┌─────────────────────────────────────────────────────┐
                 │     │  Raw GEX Snapshots (SQLite)                         │
                 │     │  Strike-level Maps stored every cycle (30-day)      │
                 │     └──────────────────────┬──────────────────────────────┘
                 │                            │
                 │                            v
                 │     ┌─────────────────────────────────────────────────────┐
                 ├───> │  Self-Improvement Loop                              │
                 │     │  (Nightly reviews, phantom trades, auto-rollback)   │
                 │     └─────────────────────────────────────────────────────┘
                 │                            │
                 │                            v
                 │     ┌─────────────────────────────────────────────────────┐
                 └───> │  Replay Engine (./claw replay <date>)               │
                       │  Full-day backtesting with current strategy config   │
                       └─────────────────────────────────────────────────────┘
```

### Core Loop (every ~5 seconds)

1. **Fetch** GEX for SPXW, SPY, QQQ sequentially via Heatseeker API (50ms stagger)
2. **Parse** gamma + vanna matrices into per-strike GEX maps (0DTE, near-term, all-exp)
3. **Score** SPXW directionally (0-100) with EMA smoothing
4. **Analyze** cross-ticker patterns (alignment, driver, stacked walls, rug setups, node slides, reshuffles)
5. **Track** node touches, wall trends, regime persistence, chop mode, spot momentum
6. **Detect** structural entry patterns (10 named patterns)
7. **Detect** trend day conditions (4-condition system with strength progression)
8. **Enter** via Lane A (GEX-only → live trades) after 15 quality gates + 4 structural validation gates
9. **Manage** open positions with 16 exit triggers (checked every cycle)
10. **Advise** via AI agent (Kimi K2.5) — exit advisory only, requires structural confirmation
11. **Phantom** blocked entries + Lane B (GEX+TV) signals for strategy comparison
12. **Alert** Discord with trade cards, signal changes, wall movements, health heartbeats
13. **Snapshot** raw strike-level GEX to SQLite for replay engine

---

## Data Pipeline

### Source: Heatseeker / Skylit API

- **URL**: `https://app.skylit.ai/api/data?symbol={SYMBOL}&nocache={random}`
- **Auth**: JWT via Clerk auto-refresh (~60s TTL). Cookie from `__client` → POST token endpoint → fresh Bearer token.
- **Tickers**: SPXW, SPY, QQQ (fetched sequentially with 50ms stagger)
- **Timeout**: 15s per request. No retry on 403 (auth expired).
- **Data shape**: `{ CurrentSpot, Expirations[], GammaValues[][], Strikes[], VannaValues[][] }`
  - Rows = strikes, Columns = expirations
  - Column 0 = 0DTE (today's expiration) — **primary for scoring and walls**
  - Columns 0-1 = near-term (today + tomorrow)
  - All columns = structural reference

### Parsing (`gex-parser.js`)

**Three GEX aggregations built per ticker:**

| Map | Source | Used For |
|-----|--------|----------|
| `aggregatedGex` | Column 0 only (0DTE) | Scoring, walls, patterns, air pockets |
| `nearTermGex` | Columns 0+1 (today + tomorrow) | Reference |
| `allExpGex` | All columns summed | Hedge node detection (allExp/0DTE ratio ≥ 3.0) |

**VEX (Vanna Exposure):**
- `vexMap`: Column 0 of `VannaValues` (0DTE vanna per strike)
- Used for confluence analysis (REINFORCING vs OPPOSING gamma)

**Wall Identification** (`identifyWalls()`):
1. Compute P90 percentile of all absolute GEX values
2. Take top 10 strikes by absolute value within ±100pts of spot
3. Add any P90-qualifying strikes within ±150pts
4. Filter: `|GEX| >= $500K` (SPXW/SPY) or `$100K` (QQQ)
5. Sort descending by absolute value
6. Output: `{ strike, gexValue, absGexValue, type (positive/negative), relativeToSpot, distancePct, percentileRank }`

### Polling Schedule

| Phase | Time (ET) | Interval |
|-------|-----------|----------|
| Pre-market | 9:00-9:24 AM | 30s |
| Warm-up | 9:25-9:29 AM | 5s |
| Open volatility | 9:30-9:35 AM | 5s |
| Normal trading | 9:35 AM-3:29 PM | 5s |
| Theta warning | 3:30-3:59 PM | 5s |
| Market close | 4:00+ PM | Inactive |

### Trinity Fetch (`trinity.js`)

Fetches all 3 tickers sequentially (not parallel — to avoid rate limits), building `trinityState`:

Per ticker:
1. `fetchGexData(ticker)` → raw API response
2. `parseGexResponse(raw)` → parsed data with GEX maps
3. `identifyWalls(parsed)` → wall list
4. `saveGexRead(parsed, ticker)` → persist to spot buffer + GEX history
5. `saveNodeSnapshot(walls, ticker)` → persist to node history
6. `scoreSpxGex(parsed, wallTrends, 0, ticker)` → score each ticker independently (no cross-ticker bonus yet)
7. Build `tickerState` with ±20 strikes around spot, top 10 walls, scored data, trends

After all 3: `analyzeMultiTicker()` computes cross-ticker bonus, then SPXW re-scored with bonus applied.

---

## GEX Scoring Engine

**File**: `gex-scorer.js`
**Output**: 0-100 directional score per ticker

### Scoring Dimensions (BULLISH example)

| Condition | Points | Logic |
|-----------|--------|-------|
| Negative GEX at spot | +30 | `smoothedGexAtSpot < 0` AND momentum not opposing. Dealers short gamma = volatility, amplifies moves |
| Directional magnet | +25 | Significant negative wall ABOVE spot (pulling price up) |
| Unobstructed expansion | +25 | `gexAtSpot < 0` AND no significant positive walls above (alternative to magnet) |
| Support floor | +25 | Significant positive wall BELOW spot (dealers long gamma = dampens downside) |
| Open air (path clear) | +20 | No wall > 30% of target between spot and target |
| Open air (unobstructed) | +20 | No significant positive GEX in next 20 strikes |
| Open air (wall growth) | +20 | Target wall growing (wallTrend data) |
| Conflicting wall penalty | -20 | Positive wall above larger than negative target. Reduced to -5 if within 4 strikes (rug setup) |

Score clamped to [0, 100]. BEARISH scoring mirrors with opposite directions.

### Momentum Application (after both directions scored)

- Short-window: `spotBuffer` (60 readings, ~5 min). `$15+` = STRONG, `$8+` = MODERATE
- Long-window drift: `driftBuffer` (180 readings, ~15 min). `$12+` = STRONG, `$6+` = MODERATE. 45% consistency filter. Upgrades short-window if short is WEAK but drift is meaningful.
- Aligned momentum: +25 (STRONG) or +15 (MODERATE) to matching direction
- Contrary momentum: -20 to opposing direction
- Momentum conflict override: If direction wins but momentum opposes (STRONG only), apply penalty `min(30, |pts| * 2)` with floor at 25

### GEX-at-Spot Smoothing

Rolling median of 3 readings prevents single-cycle oscillation at gamma boundaries. Buffer: `gexAtSpotBuffer` (3 per ticker).

### EMA Score Smoothing

`smoothed = round(0.3 * rawScore + 0.7 * previousSmoothed)` — reduces noise from cycle-to-cycle variance.

### Direction + Confidence

- `score < 35` → NEUTRAL (no directional call)
- `score >= 80` → HIGH confidence
- `score >= 60` → MEDIUM confidence
- `score < 60` → LOW confidence

### Chop Detection (`checkChop()`)

5 conditions, needs ≥ 2 to flag as CHOP:

1. **Pinned**: Positive walls on both sides, `min/max ratio > 0.50`
2. **Highly positive**: > 85% of strikes have positive GEX
3. **Tight range**: Positive walls on both sides within 30 SPX points
4. **No walls**: No significant walls anywhere (directionless)
5. **Extreme pin**: `GEX@spot > $20M` AND positive walls on both sides

Chop is a FLAG that tightens entry requirements — it does NOT override direction.

### Additional Scoring Utilities

**Midpoint Danger Zone** (`detectMidpointDanger()`):
- Finds closest wall above and below spot
- `midpoint = (above + below) / 2`
- `in_danger_zone` if within 0.15% of midpoint
- Used by entry validation Gate 2

**Air Pocket Quality** (`characterizeAirPocket()`):
- Scans strikes between spot and target
- `noiseThreshold = targetWallSize * 5%`
- HIGH: 6+ empty strikes, largest obstacle ≤ noise threshold
- MEDIUM: 3-5 empty, largest < 30% of target
- LOW: 1+ empty
- BLOCKED: no empty strikes

**VEX Confluence** (`detectVexConfluence()`):
- For each wall: `ratio = |vex| / |gex|`
- If `ratio ≥ 0.20`: REINFORCING (same sign) or OPPOSING (opposite sign)
- If `ratio < 0.20`: NEUTRAL
- Strong ratio threshold: 0.50 (defined but not yet used in scoring)

---

## Multi-Ticker Analysis

**File**: `multi-ticker-analyzer.js`
**Purpose**: Cross-market confirmation using scored states from SPXW, SPY, QQQ

### 12 Sub-Analyses (in order)

#### 1. King Nodes

Largest absolute GEX wall per ticker. `isNear = distancePct ≤ 0.15%` (~10 SPX points).

#### 2. Stacked Walls

3+ consecutive same-sign strikes where `|GEX| ≥ 5%` of largest wall:
- Positive above spot → `ceiling` (BEARISH barrier)
- Positive below spot → `floor` (BULLISH support)
- Negative above spot → `magnet_above` (BULLISH pull)
- Negative below spot → `magnet_below` (BEARISH pull)

#### 3. Rug Setups

Negative wall within 4 strike steps of positive wall:
- `rug` (BEARISH): negative below positive — support being pulled
- `reverse_rug` (BULLISH): positive below negative — floor established

#### 4. Node Slides

Wall growing 100%+ between reads (`WALL_GROWTH` with `growthPct ≥ 1.0`). Implies institutional shift. Directional implication based on wall sign + position relative to spot.

#### 5. Alignment

How many tickers agree on direction (0-3):
- `bullish ≥ 2` → BULLISH alignment, count = bullish count
- `bearish ≥ 2` → BEARISH alignment
- Otherwise MIXED, count = 0

Alignment bonus: `{0: +0, 1: +5, 2: +10, 3: +15}` pts to SPXW score.

#### 6. Driver Detection

Which ticker is catalyzing the move. Priority:
1. **Node slide**: Ticker with largest magnitude node slide
2. **Near king node**: Closest king node to its spot (by distancePct)
3. **Highest score**: Strongest setup by raw score

Driver direction match adds +5 to SPXW score. Max total cross-ticker bonus: 20.

#### 7. Multi-Signal Synthesis

Evidence scoring across all sub-analyses:
- Alignment: +count to matching direction
- Driver: +2 to driver's direction
- Stacked walls, rug setups, node slides: +1 each to matching direction

Confidence tiers:
- VERY_HIGH: alignment ≥ 3 AND dominance ≥ 75%
- HIGH: alignment ≥ 2 AND dominance ≥ 65%
- MEDIUM: alignment ≥ 2 OR dominance ≥ 60%
- LOW: everything else

#### 8. Wall Classifications

Per wall:
- `|value| < 30%` of king node → **NOISE**
- Negative wall → **MAGNET** (attractor)
- Near spot (≤ 0.5%) and positive → **GATEKEEPER** (barrier)
- Otherwise → **ANCHOR** (structural, far away)

#### 9. Rolling Walls

Detects ceilings/floors that shifted strike between reads:
- A wall disappeared (70%+ shrink) AND a similar-sized wall appeared nearby
- Same sign, size within 50%, shift ≥ 1 strike step
- Implies dealer repositioning

#### 10. Map Reshuffles

Alerts when GEX map changes dramatically:
- `≥ 2` new walls, OR `≥ 2` disappeared, OR `combined ≥ 3`
- Flags for agent review (does NOT auto-exit)

#### 11. Hedge Nodes

Institutional multi-day hedges:
- Wall size ≥ 15% of largest wall
- `allExpGex / 0DTEGex ≥ 3.0` = hedge node
- These walls reflect multi-week positioning, more durable than 0DTE walls

#### 12. Cross-Ticker Confirmation (`getCrossTickerConfirmation()`)

Used by patterns for confidence boost:
- SPY/QQQ king node near its own spot AND positioned as support (BULLISH) or resistance (BEARISH)
- SPY/QQQ rug setups matching direction
- `confirmed = count ≥ 1`, `strong = count ≥ 2`

---

## Pattern Detection

**File**: `gex-patterns.js`
**Output per pattern**: `{ pattern, direction, confidence, entry_strike, target_strike, stop_strike, reasoning, walls }`

### Post-Detection Pipeline

1. **Validity filter**: BULLISH target must be above spot, stop below. BEARISH opposite. Invalid patterns dropped.
2. **Sort** by confidence: HIGH → MEDIUM �� LOW
3. **Deduplicate** by `direction:target_strike` — highest confidence wins
4. **Conflict resolution**: If both BULLISH and BEARISH fire, patterns opposing `scored.direction` downgraded one tier, flagged `conflicting: true`
5. **Multi-expiration upgrade**: If pattern's key strike has `allExpGex/0DTEGex ≥ 1.5` AND `0DTE value ≥ $1M`, confidence upgraded. Tagged `[MULTI-EXP confirmed]`
6. **Opposing position flag**: Patterns opposing current position get `opposing_position: true`

### Pattern 1: RUG_PULL (BEARISH)

**Source**: `multiAnalysis.rug_setups` where `type === 'rug'` and `ticker === 'SPXW'`

**Conditions**: Distance from spot ≤ 1.5% of spot price

**Confidence** (starts MEDIUM):
- `gexAtSpot < 0` → HIGH (negative gamma amplifies the pull)
- Node touched ≥ 2 times (wall weakened) → HIGH
- Distance > 0.75% → LOW
- Node trend WEAKENING → upgrade; GROWING → downgrade
- Cross-ticker BEARISH confirmation → upgrade

**Target**: The negative wall strike (below spot), or nearest wall below, or spot - 15

### Pattern 2: REVERSE_RUG (BULLISH)

**Source**: `multiAnalysis.rug_setups` where `type === 'reverse_rug'` and `ticker === 'SPXW'`

**Conditions**: Distance from spot ≤ 1.5%

**Confidence** (starts MEDIUM):
- `gexAtSpot < 0` → HIGH
- Touches ≥ 2 → HIGH
- Distance > 0.75% → LOW
- Floor trend GROWING → upgrade; WEAKENING → downgrade
- Floor doubled in 30 cycles (`changePct30 ≥ 1.0`) → additional upgrade
- Cross-ticker BULLISH confirmation → upgrade

**Stacked wall capture**: Stores `initial_stack` (magnet_above/ceiling stacks from SPXW) for STACK_DISPERSED exit trigger

### Pattern 3: KING_NODE_BOUNCE (Both directions)

The king node is the largest absolute GEX wall on a ticker. Two sub-paths:

#### 3A: Negative King Node (Magnet Arrival)

When price arrives at a negative magnet, the pull is satisfied → reversal zone.

- **Proximity**: Within `negative_king_node_max_dist_pts` (default 5) of spot
- **Dwell check**: `getNodeDwellAnalysis()` — if price ACCEPTED (sliced through), skip pattern entirely
- **Touch limit**: Skipped if `touches > pattern_king_node_max_touches` (default 1)
- **Confidence** (starts MEDIUM):
  - King node < 30% of largest wall above → LOW
  - Node trend: GROWING → upgrade, WEAKENING → downgrade; doubled in 30 cycles → upgrade
  - Cross-ticker confirmation → upgrade
  - Dwell REJECTED (price bounced) → upgrade
  - Stack persistence ≥ 5 cycles → upgrade; GONE or < 3 cycles → downgrade
- **Direction**: King node above spot → BEARISH reversal; below → BULLISH reversal
- **Stop**: 5 pts beyond king node strike

#### 3B: Positive King Node (Structural Bounce)

Traditional support/resistance bounce at largest positive wall.

- **Proximity**: Within 10 pts of spot
- **Dwell check**: Same as 3A — ACCEPTED skips pattern
- **Touch limit**: Same as 3A
- **Confidence**:
  - 0 touches → HIGH (fresh node); else MEDIUM
  - Same adjustments as 3A (trend, cross-ticker, dwell, stack persistence)
  - King node flip detection (neg→pos = fresh support role) → upgrade
- **Direction**: Below spot → BULLISH bounce; above → BEARISH bounce

**Exempt from**: Chop gates, alignment gates in entry validation

### Pattern 4: PIKA_PILLOW (BULLISH)

Large positive floor cushioning a negative gamma environment.

**Conditions**:
- `scored.floorWall` exists and is positive
- Distance ≤ `pattern_pika_max_dist_pct` (default 0.20%) OR ≤ 15 pts (whichever more permissive)
- A negative wall above spot must exist (upside magnet target)

**Confidence** (starts MEDIUM):
- Close (≤ 5pts) AND score ≥ 70 → HIGH
- Far (> 10pts) → LOW
- Positive gamma at spot: downgrade (less amplification)
- Floor trend GROWING → upgrade; WEAKENING → downgrade
- Floor doubled in 30 cycles → upgrade
- Cross-ticker BULLISH → upgrade

### Pattern 5: TRIPLE_CEILING / TRIPLE_FLOOR (Both directions)

3+ stacked same-sign walls forming a barrier.

**Source**: `multiAnalysis.stacked_walls` where `ticker === 'SPXW'` and `count ≥ 3`

**Conditions**: Mid-strike of stack within 1.0% of spot

**Direction mapping**:

| Stack type | Sign | Direction | Logic |
|------------|------|-----------|-------|
| ceiling / magnet_above | positive | BEARISH | Positive resistance overhead |
| ceiling / magnet_above | negative | BULLISH | Negative magnets pulling up |
| floor / magnet_below | positive | BULLISH | Positive support underneath |
| floor / magnet_below | negative | BEARISH | Negative magnets pulling down |

**Confidence**: Count ≥ 4 → HIGH, else MEDIUM. Distance > 0.5% → downgrade. Cross-ticker → upgrade.

### Pattern 6: AIR_POCKET (Both directions)

Unobstructed path to target — 3+ consecutive empty strikes.

**Conditions**:
- `scored.targetWall` must exist
- Air pocket quality ≥ `pattern_air_pocket_min_quality` (default MEDIUM)
- Trade direction must be BULLISH or BEARISH (not NEUTRAL)

**Confidence**:
- Quality HIGH → HIGH confidence
- Score < 60 → LOW
- Positive gamma at spot OR positive target wall → downgrade
- Target wall trend: GROWING → upgrade; WEAKENING → downgrade

### Pattern 7: RANGE_EDGE_FADE (Both directions)

Gatekeeper rejection at range boundary.

**Source**: `multiAnalysis.wall_classifications` where `classification === 'GATEKEEPER'`, `near_spot === true`, `type === 'positive'`

**Conditions**:
- Touches ≤ `pattern_range_fade_max_touches` (default 1)
- Distance ≤ 0.20% from spot

**Confidence**:
- 0 touches → MEDIUM, else LOW
- Very large (size_pct > 0.50) and fresh → HIGH
- Node trend adjustments

### Pattern 8: WALL_FLIP (Both directions)

Wall sign change detection.

**Source**: `nodeSignChanges` array (comparing current vs 10-30 cycles ago)

**Conditions**:
- `magnitude ≥ wall_flip_min_magnitude` (default $5M)
- Change is not from `'absent'` (must be a real sign flip)
- Within 20 pts of spot

**Direction**:
- negative → positive below spot → BULLISH (former resistance became support)
- positive → negative below spot → BEARISH (former support dissolved)
- positive → negative above spot → BULLISH (magnet pulling up)

**Note**: WALL_FLIP has not yet fired in live trading. The conditions appear to be rare.

### Pattern 9: TREND_PULLBACK (Both directions)

Separate from pattern detection — called independently by entry engine.

- Requires CONFIRMED or STRONG trend
- GEX direction matches trend direction
- Score ≥ 40
- Price within 8 pts of support floor (BULLISH) or resistance ceiling (BEARISH)
- R:R ≥ 1.5x
- Confidence: STRONG trend → VERY_HIGH, CONFIRMED → HIGH

---

## Trend Detection

**File**: `trend-detector.js`
**Buffer**: 120 cycles (~60 min at 30s polling, ~10 min at 5s polling)

### Per-Cycle Update

Each cycle, records: `{ spotPrice, supportFloorStrike/Value, resistanceCeilingStrike/Value, score, direction }`. Support floor = highest positive wall ≥ $5M below spot. Resistance ceiling = lowest positive wall ≥ $5M above spot.

### 4 Conditions (BULLISH example)

| # | Condition | How Evaluated |
|---|-----------|---------------|
| 1 | Floor strong | Median of last 20 entries' support floor values ≥ $10M |
| 2 | Value grew | Recent floor median ≥ old floor median × 1.2 (20% growth), OR old was 0 |
| 3 | Directional bias | ≥ 60% of last 60 cycles scored BULLISH |
| 4 | Spot movement | Price moved ≥ 10 pts from start of 120-cycle buffer |

BEARISH conditions mirror (resistance ceiling instead of support floor, price falling).

### Strength Progression

| Strength | Conditions | Additional Requirements |
|----------|-----------|------------------------|
| EMERGING | 3/4 met | — |
| CONFIRMED | 4/4 met | — |
| STRONG | 4/4 met | Floor rise ≥ 15 pts AND bias ≥ 70% AND spot move ≥ 20 pts |

### Hysteresis (Prevents Flapping)

- **Grace period**: CONFIRMED held for 30 cycles before allowing downgrade. If conditions drop below 3/4 but within grace period, stay at CONFIRMED.
- **Deactivation check** (outside grace): Requires BOTH:
  - Recent bias < 40% (direction lost), OR
  - Floor dropped 10+ pts from peak (structural breakdown)

### Sticky Day Trends

Two sticky flags, once set they persist for the full trading day:

**`dayTrendDirection`** (conservative, for entry filtering):
- Requires STRONG strength
- Must persist for 20 consecutive cycles (~100s)
- Suppresses counter-trend pattern entries via `checkGexOnlyEntry()`

**`dayExitTrendDirection`** (lighter, for exit logic):
- Requires CONFIRMED strength (lower bar)
- Must persist for 10 consecutive cycles (~50s)
- Suppresses momentum timeouts and relaxes exit thresholds

### Impact on Trading

When trend-aligned (position direction = trend direction):

| Parameter | Normal | Trend-Aligned |
|-----------|--------|---------------|
| Profit target % | 0.15% | 0.375% (×2.5) |
| Stop loss % | 0.20% | 0.40% (×2.0) |
| Trailing activate | 8 pts | 5 pts (earlier) |
| Trailing distance | 5 pts | 8 pts (wider) |
| Momentum timeout | Standard phases | Skipped entirely |
| Structural stop buffer | Standard | ×1.5 wider |
| GEX flip exit | Immediate | Requires 3 consecutive opposing cycles |
| Entry re-spacing | 60s | 30s (faster re-entry after wins) |
| Breakout stop | Standard | ×1.3 wider (if score ≥ 90) |

---

## Entry Decision Engine

**File**: `entry-engine.js`

### Lane A: GEX-Only (Live Trades)

Primary entry mechanism. No TradingView confirmation required.

**Flow**:
1. Iterate detected patterns in confidence order (HIGH → MEDIUM → LOW)
2. **Trend filter**: Suppress counter-trend patterns when `dayTrendDirection` is set
3. **Structural validation** (4 gates — see below)
4. **R:R check**: `targetDist / stopDist ≥ min_entry_rr_ratio` (default 1.5)
5. **TV regime advisory**: Opposing TV regime downgrades confidence one tier (does NOT block)
6. Skip if confidence is LOW after all adjustments
7. First pattern passing all checks wins

**Confidence upgrades in entry engine** (`getGexOnlyConfidence()`):
- 3/3 alignment → upgrade one tier
- Fresh king node (0 touches) → upgrade one tier
- 2/3 alignment matching direction → upgrade to HIGH (if was MEDIUM)
- 3/3 alignment matching direction → set to VERY_HIGH

### 4 Structural Validation Gates

| Gate | Name | Rule | Exemptions |
|------|------|------|------------|
| 0.5 | Chop filter | HIGH confidence + score ≥ 80 required | AIR_POCKET, KING_NODE_BOUNCE exempt; trend-aligned exempt |
| 1 | Alignment | ≥ 2/3 tickers aligned | Structural patterns (RUG_PULL, REVERSE_RUG, KNB, PIKA) bypass if confidence ≠ LOW; score ≥ 85 overrides with 1/3 alignment |
| 2 | Midpoint | Not at midpoint danger zone (0.15%) | AIR_POCKET, KING_NODE_BOUNCE exempt |
| 3 | Min GEX score | Score ≥ 50 (power hour: ≥ 80) | Structural patterns bypass to `structural_min_score` (60) if confidence ≠ LOW |

### Trend Pullback Entry

Runs independently after pattern checks (both can fire, patterns checked first):
- Trend must be CONFIRMED or STRONG
- GEX direction matches trend
- Score ≥ 40, price within 8 pts of floor/ceiling
- Confidence: STRONG → VERY_HIGH, CONFIRMED → HIGH

### Lane B: GEX + TV Confirmation (Phantom Trades)

Same pattern detection + structural validation as Lane A, plus:
- TV weighted score ≥ 0.5 in pattern direction
- At least 1 TV indicator (Bravo/Tango/Echo 3m) confirming direction
- 5-minute cooldown between Lane B phantoms
- Results stored as phantom trades (`is_phantom = 1`) for strategy comparison

---

## Entry Quality Gates

**File**: `entry-gates.js`

Every entry must pass ALL 15 gates (Gate 6 removed):

| Gate | Name | Rule | Trend Override |
|------|------|------|----------------|
| 1 | Entry Spacing | 60s min between entries | 30s after trend wins |
| 2 | Blackout Window | No entries 9:30-9:33 AM ET | — |
| 3 | Consecutive Loss Cooldown | 2+ same-direction losses → 15 min cooldown | — |
| 4 | TV Regime Gate | Pink Diamond blocks calls, Blue Diamond blocks puts | Lane A skips entirely |
| 5 | Re-entry Cooldown | Same direction after exit: 60s | 30s after trend wins |
| ~~6~~ | ~~Daily Trade Limit~~ | ~~Removed~~ | — |
| 7 | Direction Stability | Score stable for 3 consecutive cycles | Skipped during trend |
| 8 | Recent Direction Flip | Wait 4 cycles after direction flip | Skipped during trend |
| 9 | Time Gate | No entries after 3:30 PM ET | — |
| 10 | Opening Caution | 9:33-9:40 AM: score ≥ 85 AND alignment 3/3 | — |
| 11 | Chop Mode | Score ≥ 80, enforce 120s spacing | — |
| 12 | Regime Conflict | Block entry against persistent opposing regime (36+ cycles) | — |
| 13 | Pattern Loss Cooldown | 3+ consecutive losses on specific pattern → 30 min cooldown | — |
| 14 | Max Trades Per Pattern | 8 trades per pattern per day | — |
| 15 | Win Rate Filter | After 10+ trades: pattern needs ≥ 30% win rate | — |

### Loss Tracking

- **Per-direction**: 2+ consecutive same-direction losses → 15 min cooldown. Reset on win.
- **Per-pattern**: 3+ consecutive pattern losses → 30 min cooldown. Reset on win.
- **Win rate**: Running `patternWins / patternTotal`. Below 30% after 10+ trades blocks that pattern.
- **Daily reset**: All counters cleared at 9:25 AM ET.

### Chop Detection (for Gate 11)

Uses `scoreHistory` (last 60 entries). `isChop` when:
- `flips ≥ 4 AND stddev > 15`, OR
- `flipRate > 0.30` (30%+ of cycles had direction changes)

---

## Exit Engine

**File**: `trade-manager.js`

### Constants

- `AUTO_CONFIRM_MS = 60s` — PENDING → IN_CALLS/IN_PUTS
- `POSITION_UPDATE_MS = 5 min` — Discord update interval
- `MIN_HOLD_BEFORE_SOFT_EXIT_MS = 3 min` — minimum hold before soft exits can fire

### 16 Exit Triggers (Priority Order)

Every cycle, all triggers are checked. First triggered wins.

#### 1. TARGET_HIT + Magnet Walk Continuation

**Standard**: BULLISH `spot ≥ targetSpx`, BEARISH `spot ≤ targetSpx`. Exits immediately.

**Magnet walk** (for KING_NODE_BOUNCE and REVERSE_RUG only):
- Checks: `magnet_walk_enabled` (default true), `walkCount < magnet_walk_max_steps` (default 2), `multiAnalysis` available
- `findNextMagnet()`: Searches `stacked_walls` for next magnet beyond current target, within `magnet_walk_max_dist_pts` (default 25 pts)
  - BULLISH: looks for `magnet_above` with `startStrike > currentTarget`
  - BEARISH: looks for `magnet_below` with `endStrike < currentTarget`
- If next magnet found:
  - Extends `targetSpx` to new magnet strike
  - Ratchets stop: `newStop = prevTarget ± magnet_walk_stop_ratchet_pts` (default 3), takes max/min of current and new stop
  - Increments `_walkCount`
  - Persists to DB via `updateTradeTargetDb()`
  - Does NOT exit — continues managing
- If no next magnet: exits with TARGET_HIT

#### 2. NODE_SUPPORT_BREAK

Requires entry context with `support_node` (BULLISH) or `ceiling_node` (BEARISH):
- Node trend GONE → immediate exit (no buffer)
- Buffer: `node_break_buffer_pts` (default 2), adjusted by trend:
  - WEAKENING → buffer = 0
  - GROWING → buffer += 1
- BULLISH: exit if `spot < support_node.strike - buffer`
- BEARISH: exit if `spot > ceiling_node.strike + buffer`

#### 3. TREND_FLOOR_BREAK

Only fires during confirmed trends with `supportFloor` (BULLISH) or `resistanceCeiling` (BEARISH):
- `floorBuffer = trend_floor_break_buffer_pts` (default 3)
- BULLISH: exit if `spot < supportFloor.strike - floorBuffer`
- BEARISH: exit if `spot > resistanceCeiling.strike + floorBuffer`

#### 4. STOP_HIT

Hard stop — BULLISH: `spot ≤ stopSpx`, BEARISH: `spot ≥ stopSpx`. No hold gate.

#### 5. PROFIT_TARGET

Percentage-based:
- `profitTargetPct = profit_target_pct` (default 0.20%)
- Trend-aligned: multiplied by `trend_profit_target_multiplier` (default 2.5) = 0.50%
- Exit if `movePct ≥ profitTargetPct`

#### 6. STOP_LOSS

Percentage-based:
- `stopLossPct = stop_loss_pct` (default 0.15%)
- Trend-aligned: multiplied by `trend_stop_loss_multiplier` (default 2.0) = 0.30%
- Exit if `movePct ≤ -stopLossPct`

#### 7. TV_COUNTER_FLIP (3 min hold gate)

Both Bravo 3m AND Tango 3m flipped against position:
- Each counts as "against" if: not stale AND opposing direction
- `minIndicators = tv_counter_flip_min_indicators` (default 2)
- Exit if `counterCount ≥ minIndicators`

#### 8. OPPOSING_WALL (3 min hold gate, skipped during trends)

Large positive wall (`≥ opposing_wall_exit_value`, default $5M) materialized against position:
- BULLISH: searches `wallsBelow` for positive wall
- BEARISH: searches `wallsAbove` for positive wall

#### 9. STACK_DISPERSED (3 min hold gate)

**Only for KNB and REVERSE_RUG** with `initial_stack.count > 0`:
- Uses `getStackPersistence('SPXW', direction)`
- **Full exit**: If `stackPersistence.disappeared` (stack was present majority of time, now completely gone)
- **Trailing stop tightening**: If stack shrunk > 50% (`shrinkRatio < 0.5`), sets `_stackShrinkTightened = true`:
  - `trailActivate = max(3, round(trailActivate * 0.6))`
  - `trailDistance = max(3, round(trailDistance * 0.7))`

#### 10. MOMENTUM_TIMEOUT (4 progressive phases)

Skipped entirely during trend days (both `isTrendAligned` and `dayExitTrendDirection`).

| Phase | Time Gate | Threshold | Hold Gate |
|-------|-----------|-----------|-----------|
| Phase 0 | ≥ 90s | `moveInDirection < 0.5 pts` | None (90s is the gate) |
| Phase 1 | ≥ 5 min (7 min for HIGH conf) | `spxProgress < 2 pts` | 3 min |
| Phase 2 | ≥ 10 min | `spxProgress < 40% of target distance` | 3 min |
| Phase 3 | ≥ 15 min | `spxProgress ≤ 0` (not net positive) | 3 min |

Phase 0 is also skipped for breakout entries (trend-aligned + score ≥ 90 at entry).

#### 11. TV_FLIP (3 min hold gate)

Scans ALL 3m signals. `≥ tv_against_exit_count` (default 2) opposing indicators → exit.

#### 12. TRAILING_STOP (3 min hold gate)

| Parameter | Normal | Trend-Aligned | Stack-Shrink Tightened |
|-----------|--------|---------------|------------------------|
| Activate | 8 pts | 5 pts | ×0.6 (min 3) |
| Distance | 5 pts | 8 pts | ×0.7 (min 3) |

Tracks `bestSpxChange` (running max of directional progress). Exit if `drawdown ≥ trailDistance` after activation.

#### 13. AGENT_EXIT (3 min hold gate)

AI agent recommends exit. Requires structural confirmation (any one of):
1. Price within 3 pts of support/ceiling node
2. After 5+ min hold, `spxProgress < 1 pt`
3. `scored.score < gex_exit_threshold` (default 40)

Without confirmation: logs "NO structural confirmation — holding" and continues.

#### 14. THETA_DEATH (no hold gate)

Immediate exit after `no_entry_after` time (default 3:30 PM ET). Hard cutoff for 0DTE.

#### 15. GEX_FLIP (3 min hold gate)

GEX direction flipped against position with `score ≥ gex_exit_threshold` (default 60):
- Normal: immediate exit
- Trend-aligned: requires `trend_gex_flip_required_cycles` (default 3) consecutive opposing cycles
- Counter resets if GEX re-aligns

#### 16. MAP_RESHUFFLE (NOT an exit — advisory only)

Detected and flagged (`reshuffleDetected = true`) for agent review. No automatic exit.

---

## State Tracking

**File**: `state.js`

### Per-Ticker Buffers

| Buffer | Size | Interval | Purpose |
|--------|------|----------|---------|
| `spotBuffer` | 60 | ~5 min @ 5s | Short-window momentum, node dwell analysis |
| `driftBuffer` | 180 | ~15 min @ 5s | Long-window drift detection (slow grinds) |
| `gexAtSpotBuffer` | 3 | ~15s | Rolling median for GEX-at-spot smoothing |
| `gexHistory` | 10 | ~50s | Recent GEX reads for wall trend detection |
| `nodeHistory` | 120 | ~10 min | Top 10 walls per cycle for node trends (GROWING/WEAKENING/STABLE/NEW/GONE) |
| `scoreHistory` | 60 | ~5 min | Score + direction history for chop/regime detection |
| `directionHistory` | 10 | ~50s | Direction stability detection |
| `kingNodeHistory` | 60 | ~5 min | King node type flip detection (neg→pos or pos→neg) |
| `stackSnapshots` | 30 | ~2.5 min | Stacked wall persistence tracking |
| `regimeState` | 1 | — | Current regime direction + cycle count (persistent = ≥ 36 cycles) |
| `smoothedScores` | 1 | — | EMA-smoothed score (α = 0.3) |

### Key State Functions

**`getNodeTrends(ticker)`**: Compares current walls to snapshots at 5/10/30/60 cycles ago:
- `changePct10 ≥ 0.20` → GROWING; `≤ -0.20` → WEAKENING; in range → STABLE
- Wall not in current snapshot → GONE (with changePct = -1)
- `longTrend`: Same classification over 60-cycle window

**`getSpotMomentum(ticker)`**: 5-min short window + 15-min drift:
- `$15+` = STRONG, `$8+` = MODERATE momentum
- Drift upgrades short-window if short is WEAK but drift is MODERATE+ (catches slow grinds)
- 45% consistency filter on drift (prevents noisy oscillation from registering)

**`getNodeDwellAnalysis(strike, ticker)`**: Analyzes how price behaves at a king node:
- `zonePts = 5` — within ±5 pts of strike counts as "at node"
- `minDwellCycles = 3`, `maxOscillation = 8` pts
- **REJECTED**: Price dwelled ≥ 3 cycles, oscillated ≤ 8 pts, now moving AWAY from arrival direction
- **ACCEPTED**: Price broke through (> 5 pts away), continued in arrival direction or dwelled < 3 cycles
- **INCONCLUSIVE**: Neither condition met

**`getStackPersistence(ticker, direction)`**: Tracks stacked wall zones across cycles:
- BULLISH relevant: `magnet_above`, `ceiling`; BEARISH: `magnet_below`, `floor`
- `disappeared = !hasRelevantNow && presentCycles > 50%` of total
- Trend: `changePct ≥ 0.30` → GROWING; `≤ -0.30` → SHRINKING; disappeared → GONE

**`detectChopMode(ticker)`**: `isChop` when `(flips ≥ 4 AND stddev > 15) OR flipRate > 0.30`

**`getNodeSignChanges(ticker)`**: Compares nodeHistory current vs 10-30 cycles ago for sign flips (positive ↔ negative at same strike)

**`getKingNodeFlip(ticker)`**: Looks back 10-30 cycles for same strike with different type in king node history

### Daily Reset (9:25 AM ET)

Clears: `smoothedScores`, `directionHistory`, `scoreHistory`, `nodeHistory`, `kingNodeHistory`, `stackSnapshots`, `regimeState`, node touches, entry gate counters, trend detector. Does NOT clear: `spotBuffer`, `driftBuffer`, `gexAtSpotBuffer`, `latestSpot`.

---

## TradingView Integration

### Webhook Server (`tv-webhook-server.js`)

- **Port**: `config.tvWebhookPort` (default 3001)
- **Endpoint**: `POST /webhook/tv?token={secret}&ticker={ticker}&tf={timeframe}&timing={close|open}`
- **Auth**: `?token=` must match `config.tvWebhookSecret`
- **Format**: Plain text `"Startup Bravo Blue Diamond 3"` or JSON `{ ind, sig, tf, ticker }`
- **Health**: `GET /health`, **Signals**: `GET /signals`

### Signal Store (`tv-signal-store.js`)

**13 signal slots** across 3 tickers × indicators × timeframes:

| Slot | Weight |
|------|--------|
| `spx_echo_3` | 0.75 |
| `spx_bravo_1` | 0.75 |
| `spx_bravo_3` | 1.0 |
| `spx_tango_1` | 1.0 |
| `spx_tango_3` | 1.5 (highest weight) |
| `spy_bravo_1/3`, `spy_tango_1/3` | Same weights |
| `qqq_bravo_1/3`, `qqq_tango_1/3` | Same weights |

Echo is SPX-only, 3m-only.

**Signal Classification**:
- BULLISH: Echo (`BLUE_1`, `BLUE_2`, `WHITE`), Bravo (`BLUE_1`, `BLUE_2`, `WHITE`), Tango (`BLUE_1`, `BLUE_2`)
- BEARISH: All three (`PINK_1`, `PINK_2`)
- Note: Tango does NOT classify WHITE as bullish

**Staleness**: 1m signals expire after 3 min, 3m signals after 9 min. Stale signals classified as NEUTRAL.

**TV Regime** (set by Bravo 3m only):
- Pink Diamond → BEARISH regime
- Blue Diamond (not WHITE) → BULLISH regime
- WHITE does NOT update regime
- 30-minute expiry on regime
- Lane A skips regime gate; Lane B blocks against regime

**TV Confidence Levels**:
- MASTER: 3/3 SPX 3m signals agree
- INTERMEDIATE: 2/3
- BEGINNER: 1/3
- NONE: 0/3

---

## AI Agent (Exit Advisor)

**File**: `decision-engine.js`
**Model**: Kimi K2.5 via Moonshot API (OpenAI-compatible)
**Role**: Exit advisory ONLY — entries are fully algorithmic

### When Called

Only when NOT FLAT (position is open). Pre-filtered by `shouldCallAgent()`:
- GEX score changed ≥ 5 pts or direction changed
- TV signal updated
- Multi-ticker driver or alignment changed, or node slide detected
- Power hour transition
- Reshuffle detected

If none of these changed → agent call skipped (saves API cost).

### Agent Input

Structured JSON with:
- `price`: SPX, SPY, QQQ spot prices
- `gex.spx`: Score, direction, walls, trends, midpoint, air pocket, VEX confluence, top nodes, gone nodes
- `gex.spy`, `gex.qqq`: Compact versions
- `multi_ticker`: Driver, alignment, stacked walls, rug setups, node slides, reshuffles, hedge nodes
- `tv`: Full signal snapshot
- `position`: Contract, direction, entry_spx, current_pnl_pct, target, stop
- `patterns_detected`: Current patterns
- `market_context`: Power hour, OPEX, chop mode, regime
- `node_touches`: Per-strike touch counts

### Agent Output

Actions: `WAIT`, `EXIT_CALLS`, `EXIT_PUTS`, `EXIT`
- Agent exit requires **structural confirmation** (any one of): price near node (3 pts), momentum stalled (< 1 pt after 5 min), or GEX score < 40
- Without confirmation: agent recommendation is logged but NOT acted on

---

## Self-Improvement Loop

### Nightly Review (`nightly-review.js`) — 4:10 PM ET

**Guard conditions**:
- Skip if learning period active
- Skip if < 5 closed trades
- Skip if no Anthropic API key

**10-Dimension Analysis** (built from DB queries):
1. Overall metrics (win rate, avg P&L, best/worst trade)
2. Performance by GEX range (60-70, 70-80, 80-90, 90+)
3. Performance by alignment (0/3, 1/3, 2/3, 3/3)
4. Performance by TV indicator (with vs without signal)
5. Performance by TV confirmations (0/2, 1/2, 2/2)
6. Performance by time of day (hourly buckets)
7. Performance by direction (BULLISH vs BEARISH)
8. Performance by exit reason
9. Strike effectiveness (planned R:R, target hit rate, stop hit rate)
10. Phantom comparisons (current vs previous version)

**Enrichment data**: Blocked entry reasons, GEX score distribution, TV signal transitions, previous review, lane A vs B comparison, trigger effectiveness, 7-day pattern performance.

**AI Review** (Claude Sonnet):
- Max 3 adjustments per review
- Every adjustment must cite specific data
- No adjustments if win rate > 65% AND avg P&L positive
- Min 5 trades per category before adjusting
- Max 20% change per numeric parameter
- Changes validated and clamped before proposing

**Changes are NOT auto-applied** — proposed to user via Discord for review.

### Weekly Review — Sundays at 4:10 PM ET

Broader pattern analysis across the full week.

### Phantom Engine (`phantom-engine.js`)

After each trade closes:
1. Evaluate entry under CURRENT config AND PARENT config
2. Determine if current or parent would have entered
3. Assess: `CURRENT_BETTER`, `PREVIOUS_BETTER`, or `SAME`
4. Feeds into rollback triggers

### Rollback Engine (`rollback-engine.js`)

4 automatic rollback triggers (checked after every trade close):

| Trigger | Condition | Min Trades |
|---------|-----------|-----------|
| WIN_RATE_DROP | Current win rate 15+ percentage points below parent | 5 |
| AVOIDABLE_LOSSES | 3+ consecutive losses AND 2+ would have been avoided by parent | 5 |
| AVG_PNL_DROP | Current avg P&L < 70% of parent avg P&L (parent must be positive) | 5 |
| DRAWDOWN | Total P&L ≤ -$2000 across all trades on current version | 5 |

**V1 Floor Guarantee**: If current version has both lower win rate AND lower avg P&L than V1 baseline, automatically rolls back to V1. Checked after the 4 primary triggers.

### Strategy Versioning

- V1 = baseline (never modified)
- Each review creates a new version branching from current
- Any version can be activated instantly
- Full config diff tracked in `strategy_versions` table

---

## Backtesting / Replay Engine

**File**: `backtest/replay.js`
**Command**: `./claw replay 2026-03-02`

### How It Works

1. Load all `gex_raw_snapshots` for the date (stored every cycle during live trading)
2. Initialize with current active strategy version (or override)
3. For each snapshot:
   - Reconstruct `parsedData`, `walls`, `wallTrends` for SPXW, SPY, QQQ
   - Score SPXW with cross-ticker bonus
   - Detect patterns, run entry engine + entry gates
   - Manage open positions with all exit triggers
   - Record phantom trades for blocked entries
4. All in-memory — no DB writes
5. Time-gated: uses snapshot timestamps, NOT real clock

### Output

- Trade log with entry/exit details
- P&L summary (total points, win/loss count)
- Pattern effectiveness breakdown
- Exit reason distribution
- Wall narrative (optional, via `wall-narrative.js`)

### Exit Logic Mirroring

Replay engine contains an inline copy of all exit triggers from `trade-manager.js`, including:
- TARGET_HIT with magnet walk continuation
- STACK_DISPERSED with stack persistence tracking
- Trailing stop tightening when stack shrinks
- All 16 exit triggers in the same priority order

This ensures replay results exactly match live behavior.

---

## Storage

**File**: `store/db.js`
**Database**: SQLite (`data/spx-bot.db`) with WAL mode for concurrent reads.

| Table | Purpose | Retention |
|-------|---------|-----------|
| `gex_snapshots` | Score, direction, walls per cycle | 7 days |
| `gex_raw_snapshots` | Full parsed GEX + multi-analysis per cycle | 30 days |
| `trades` | Entry/exit details, P&L, pattern, context, greeks | Permanent |
| `decisions` | Agent decision history + reasoning | 7 days |
| `tv_signals` | Current state of all TV indicator slots | Current only |
| `tv_signal_log` | History of indicator state changes | 7 days |
| `alerts` | Sent alerts for deduplication + audit | 7 days |
| `predictions` | GEX direction predictions for accuracy tracking | 7 days |
| `health` | System health heartbeats | 7 days |
| `strategy_versions` | Version control for config parameters | Permanent |
| `phantom_comparisons` | Current vs previous config comparison | Permanent |
| `rollback_events` | Strategy rollback audit log | Permanent |

### Key Prepared Statements

- `saveSnapshot`: Persist scored GEX state
- `saveRawSnapshot`: Persist full parsed data for replay
- `openTrade` / `closeTrade`: Trade lifecycle
- `updateTradeTargetDb`: Dynamic target update (magnet walk)
- `saveDecision`: Agent decision with full JSON context
- `saveTvSignalLog`: TV signal state changes
- `savePhantomComparison`: Phantom comparison results
- `saveRollbackEvent`: Rollback audit
- `cleanupOldData(days)`: Purge scored data older than N days

---

## Discord Alerts

**File**: `alerts/discord.js`
**Transport**: Discord webhooks with rate limiting (3 retries, exponential backoff)

### Alert Types

| Alert | Trigger | Cooldown |
|-------|---------|----------|
| Full GEX Analysis | Score ≥ 60 AND (15 min elapsed OR score changed ≥ 20 pts) | 15 min |
| Direction Flip | GEX direction changed | Dedup key |
| Wall Growth | Wall value increased ≥ 20% | 15 min per strike |
| Wall Shrink | Wall value decreased ≥ 30% | 15 min per strike |
| Spot Move | Price moved ≥ 0.3% since last cycle | Dedup key |
| Proximity | Price within 1 strike step of target wall | Dedup key |
| Map Reshuffle | 2+ walls appeared or disappeared | Per event |
| Trade Opened | Lane A entry executed | Per trade |
| Position Update | Every 5 min while in position | 5 min |
| Trade Closed | Position exited (with P&L, exit reason) | Per trade |
| Entry Blocked | Lane A entry blocked by quality gates | Per event |
| Opening Summary | 9:15 AM ET (once per day) | Daily |
| EOD Summary | 4:05 PM ET (once per day) | Daily |
| Health Heartbeat | Every 5 min | 5 min |
| Strategy Rollback | Automatic rollback triggered | Per event |
| Review Report | Nightly/weekly review results | Daily |

### Exit Reason Labels

| Code | Label |
|------|-------|
| TARGET_HIT | Target Hit |
| STOP_HIT | Stop Hit |
| PROFIT_TARGET | Profit Target |
| STOP_LOSS | Stop Loss |
| TRAILING_STOP | Trailing Stop |
| MOMENTUM_TIMEOUT | Momentum Timeout |
| TV_FLIP | TV Flip |
| TV_COUNTER_FLIP | TV Counter Flip |
| GEX_FLIP | GEX Flip |
| OPPOSING_WALL | Opposing Wall |
| NODE_SUPPORT_BREAK | Node Support Break |
| THETA_DEATH | Theta Death |
| AGENT_EXIT | Agent Exit |
| TREND_FLOOR_BREAK | Trend Floor Break |
| STACK_DISPERSED | Stack Dispersed |

---

## Dashboard

**Location**: `dashboard/` (Next.js 14, App Router + Tailwind CSS)
**Port**: 3000 (production via `next start`)
**WebSocket**: Express + WS server at `src/dashboard/dashboard-server.js`

### Pages

| Route | Purpose |
|-------|---------|
| `/trading` | Real-time signal banner, position card, GEX panel, TV grid, alert feed |
| `/ideas` | Trade ideas feed + compact table with date navigation |
| `/performance` | Trade log with P&L, win rate analytics |
| `/strategy` | Strategy version history, wall map, rollback history |
| `/system` | Service health monitoring |

### WebSocket Events

| Event | Source | Data |
|-------|--------|------|
| `gex_update` | Main loop | Spot, score, direction, walls, breakdown, environment |
| `trinity_update` | Main loop | Full trinityState + multiAnalysis |
| `patterns_detected` | Main loop | Detected patterns array |
| `trend_update` | Main loop | Trend state (direction, strength, floor, ceiling) |
| `decision_update` | Decision engine | Agent action + confidence |
| `trade_opened` | Trade execution | Trade entry details |
| `trade_closed` | Trade exit | Exit reason, P&L, duration |
| `position_update` | Trade manager | Current P&L, hold time |
| `entry_blocked` | Entry gates | Block reason, pattern that was blocked |
| `alert` | Various | Alert type + message |
| `strategy_update` | Nightly review | New strategy version |
| `strategy_rollback` | Rollback engine | Rollback details |

**Important**: Source changes require `npm run build` in `dashboard/` before `pm2 restart openclaw-dashboard`.

---

## Strategy Configuration

**File**: `review/strategy-store.js`
**Total**: 100+ tunable parameters in V1_BASELINE

### GEX Scoring Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gex_min_score` | 60 | Minimum score for nightly review evaluation |
| `gex_strong_score` | 80 | "Strong" score threshold |
| `gex_chop_zone_low` | 40 | Lower chop zone |
| `gex_chop_zone_high` | 60 | Upper chop zone |
| `wall_min_value` | 2,000,000 | Minimum wall value for analysis |
| `wall_dominant_value` | 5,000,000 | "Dominant" wall threshold |
| `noise_filter_pct` | 0.10 | Filter walls < 10% of largest |

### Multi-Ticker

| Parameter | Default | Description |
|-----------|---------|-------------|
| `alignment_min_for_entry` | 2 | Min tickers agreeing for entry |
| `driver_bonus_confidence` | true | Driver match adds confidence |
| `king_node_first_tap_bias` | 'REJECT' | Expected behavior on first touch |
| `king_node_second_tap_bias` | 'BREAK' | Expected behavior on second touch |
| `node_slide_weight` | 1.5 | Node slide detection weight |
| `negative_king_node_max_dist_pts` | 5 | Max distance for negative KNB |

### TV Weights

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tv_weight_bravo` | 1.0 | Bravo indicator weight |
| `tv_weight_tango` | 1.5 | Tango indicator weight (highest) |
| `gex_strong_threshold` | 80 | Score to override TV requirement |

### Entry Rules

| Parameter | Default | Description |
|-----------|---------|-------------|
| `min_rr_ratio` | 1.0 | R:R floor for consideration |
| `min_entry_rr_ratio` | 1.5 | R:R required for entry |
| `no_entry_after` | '15:30' | Hard cutoff for new entries |
| `theta_warning_time` | '15:00' | Warning phase start |
| `stop_buffer_pct` | 0.05 | Stop buffer as % of spot |
| `gex_only_min_score` | 50 | Min GEX score for Lane A |
| `structural_min_score` | 40 | Min score for structural pattern bypass |
| `alignment_override_gex_score` | 85 | Score to override alignment gate |
| `power_hour_min_gex_score` | 80 | Min score during power hour |
| `midpoint_danger_zone_pct` | 0.08 | Midpoint danger zone threshold |

### Exit Tuning

| Parameter | Default | Description |
|-----------|---------|-------------|
| `profit_target_pct` | 0.20 | Profit target (% SPX move) |
| `stop_loss_pct` | 0.15 | Stop loss (% adverse move) |
| `trailing_stop_activate_pts` | 8 | Trailing stop activation threshold |
| `trailing_stop_distance_pts` | 5 | Trailing stop trail distance |
| `opposing_wall_exit_value` | 5,000,000 | Min wall value for opposing wall exit |
| `gex_exit_threshold` | 40 | GEX score threshold for flip exit |
| `tv_against_exit_count` | 2 | Min TV indicators for TV flip exit |

### Momentum Timeout Phases

| Parameter | Default | Description |
|-----------|---------|-------------|
| `momentum_phase0_seconds` | 90 | Phase 0 time gate |
| `momentum_phase0_min_pts` | 0.5 | Phase 0 min progress |
| `momentum_min_hold_minutes` | 3 | Min hold for soft exits |
| `momentum_phase1_minutes` | 5 | Phase 1 time gate |
| `momentum_phase1_min_pts` | 2 | Phase 1 min progress |
| `momentum_phase1_high_conf_minutes` | 7 | Phase 1 for HIGH confidence |
| `momentum_phase2_minutes` | 10 | Phase 2 time gate |
| `momentum_phase2_target_pct` | 0.40 | Phase 2: % of target needed |
| `momentum_phase3_minutes` | 15 | Phase 3 time gate |

### TV Exit

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tv_counter_flip_enabled` | true | Enable TV counter flip exit |
| `tv_counter_flip_min_indicators` | 2 | Min indicators for counter flip |

### Trend Day Detection

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trend_min_floor_value` | 5,000,000 | Min floor value for trend |
| `trend_min_lookback_cycles` | 60 | Lookback window for trend |
| `trend_min_floor_rise_pts` | 15 | Floor migration for STRONG |
| `trend_min_directional_bias_pct` | 0.60 | Min directional bias % |
| `trend_min_spot_move_pts` | 10 | Min price movement |
| `trend_deactivate_floor_drop_pts` | 10 | Floor drop to deactivate |
| `trend_deactivate_bias_threshold` | 0.40 | Bias below this deactivates |

### Trend Day Exit Adjustments

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trend_profit_target_multiplier` | 2.5 | Profit target multiplier during trend |
| `trend_stop_loss_multiplier` | 2.0 | Stop loss multiplier during trend |
| `trend_stop_multiplier` | 1.5 | Structural stop multiplier |
| `trend_trail_activate_pts` | 5 | Trailing stop activate (trend) |
| `trend_trail_distance_pts` | 8 | Trailing stop trail (trend) |
| `trend_momentum_time_multiplier` | 2.5 | Momentum phase time multiplier |
| `trend_momentum_phase1_min_pts` | 1 | Phase 1 min pts during trend |
| `trend_gex_flip_required_cycles` | 3 | Consecutive GEX flips to exit |
| `trend_floor_break_buffer_pts` | 3 | Trend floor break buffer |
| `breakout_score_threshold` | 90 | Score for breakout classification |
| `breakout_stop_multiplier` | 1.3 | Breakout stop multiplier |

### Trend Pullback

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trend_pullback_enabled` | true | Enable trend pullback entries |
| `trend_pullback_min_score` | 40 | Min GEX score for pullback |
| `trend_pullback_max_dist_pts` | 8 | Max distance from floor/ceiling |
| `trend_pullback_stop_buffer_pts` | 5 | Stop buffer for pullback |
| `trend_reentry_spacing_ms` | 30,000 | Re-entry spacing after trend wins |

### Magnet Walk

| Parameter | Default | Description |
|-----------|---------|-------------|
| `magnet_walk_enabled` | true | Enable magnet walk continuation |
| `magnet_walk_max_steps` | 2 | Max walk extensions per trade |
| `magnet_walk_max_dist_pts` | 25 | Max distance to next magnet |
| `magnet_walk_stop_ratchet_pts` | 3 | Stop ratchet per walk |

### Pattern Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pattern_min_wall_pct` | 0.15 | Min wall as % of largest |
| `pattern_rug_max_gap_strikes` | 2 | Max gap for rug setup |
| `pattern_king_node_max_touches` | 1 | Max touches before skip |
| `pattern_pika_max_dist_pct` | 0.20 | Max distance for pika |
| `pattern_air_pocket_min_quality` | 'MEDIUM' | Min air pocket quality |
| `pattern_range_fade_max_touches` | 1 | Max touches for fade |
| `pattern_triple_min_walls` | 3 | Min walls for triple |
| `wall_flip_min_magnitude` | 5,000,000 | Min flip magnitude |
| `pin_gex_at_spot_threshold` | 20,000,000 | Extreme pin zone |

### Pattern Trigger Weights

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trigger_weight_rug_pull` | 1.2 | Rug pull priority |
| `trigger_weight_reverse_rug` | 1.1 | Reverse rug priority |
| `trigger_weight_king_node_bounce` | 1.0 | KNB priority |
| `trigger_weight_pika_pillow` | 1.0 | Pika pillow priority |
| `trigger_weight_triple_ceiling` | 0.9 | Triple ceiling priority |
| `trigger_weight_triple_floor` | 0.9 | Triple floor priority |
| `trigger_weight_air_pocket` | 1.1 | Air pocket priority |
| `trigger_weight_range_edge_fade` | 0.8 | Range edge fade priority |

### Pattern Risk Management

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_trades_per_pattern` | 8 | Per-pattern daily trade limit |
| `pattern_loss_limit` | 3 | Consecutive losses before cooldown |
| `pattern_loss_cooldown_ms` | 1,800,000 | 30 min pattern cooldown |
| `pattern_win_rate_min` | 0.30 | Min win rate to keep trading |
| `pattern_win_rate_min_trades` | 10 | Min trades before win rate gate |
| `rug_pull_min_value` | 3,000,000 | Min rug pull wall value |
| `pika_pillow_min_value` | 5,000,000 | Min pika pillow floor value |
| `king_node_min_value` | 3,000,000 | Min king node value |

### Entry Quality Gates

| Parameter | Default | Description |
|-----------|---------|-------------|
| `entry_min_spacing_ms` | 60,000 | 60s between entries |
| `entry_blackout_start` | '09:30' | Blackout start |
| `entry_blackout_end` | '09:33' | Blackout end |
| `consecutive_loss_limit` | 2 | Losses before cooldown |
| `consecutive_loss_cooldown_ms` | 900,000 | 15 min loss cooldown |
| `chop_lookback_cycles` | 60 | Chop detection window |
| `chop_flip_threshold` | 4 | Min flips for chop |
| `chop_stddev_threshold` | 15 | Min stddev for chop |
| `chop_flip_rate_threshold` | 0.30 | Flip rate for chop |
| `chop_entry_spacing_ms` | 120,000 | 120s spacing in chop |
| `chop_min_entry_score` | 80 | Min score in chop |

### Dual-Lane Config

| Parameter | Default | Description |
|-----------|---------|-------------|
| `lane_a_enabled` | true | Enable live trading (Lane A) |
| `lane_b_enabled` | true | Enable phantom trading (Lane B) |
| `lane_b_min_tv_weight` | 0.5 | Min TV weight for Lane B |
| `lane_b_min_tv_indicators` | 1 | Min TV indicators for Lane B |

### Strike Selection

| Parameter | Default | Description |
|-----------|---------|-------------|
| `rr_weight` | 0.40 | R:R in strike scoring (40%) |
| `delta_weight` | 0.25 | Delta in strike scoring (25%) |
| `liquidity_weight` | 0.20 | OI in strike scoring (20%) |
| `theta_weight` | 0.15 | Theta in strike scoring (15%) |
| `delta_sweet_spot_low` | 0.35 | Ideal delta lower bound |
| `delta_sweet_spot_high` | 0.55 | Ideal delta upper bound |

### Self-Improvement

| Parameter | Default | Description |
|-----------|---------|-------------|
| `learning_period_days` | 0 | Days before reviews start |
| `min_trades_for_adjustment` | 5 | Min trades for review |
| `max_adjustments_per_review` | 3 | Max changes per review |

---

## Key Concepts Glossary

| Term | Definition |
|------|-----------|
| **Positive GEX wall** | Dealers long gamma → dampens moves → support (below) or resistance (above) |
| **Negative GEX wall** | Dealers short gamma → amplifies moves → magnet pulling price toward it |
| **King node** | Largest absolute GEX wall on a ticker. Dominates price behavior for the day |
| **Gatekeeper** | Positive wall near spot (≤ 0.5%) acting as a range boundary barrier |
| **Magnet** | Negative wall attracting price. Becomes reversal zone once price arrives |
| **Anchor** | Positive wall far from spot. Structural but not immediately actionable |
| **Noise** | Wall < 30% of king node. Not significant for pattern detection |
| **Rug setup** | Negative wall adjacent to positive wall. Support can collapse as negative pulls through |
| **Reverse rug** | Positive floor established below negative magnet. Floor launching price upward |
| **Magnet arrival** | When price reaches a negative king node, the pull is satisfied → reversal zone |
| **Node dwell** | How long price stays at a key node. Measured by spotBuffer readings in zone (±5 pts) |
| **Node rejection** | Price dwelled at node ≥ 3 cycles, oscillated ≤ 8 pts, then reversed. High-quality bounce |
| **Node acceptance** | Price sliced through node without dwelling. Bounce pattern invalid |
| **Magnet walk** | Price walks node-to-node through stacked magnets. Target extends to next magnet |
| **Stack persistence** | Tracking whether stacked magnet zones persist across cycles. GONE = stack disappeared |
| **Trinity** | The 3-ticker system (SPXW + SPY + QQQ) analyzed together for cross-market confirmation |
| **Alignment** | How many of the 3 tickers agree on direction (0-3). 3/3 = strongest confirmation |
| **Driver** | Which ticker is catalyzing the current move (priority: node slide > king node > score) |
| **Chop** | Market pinned between positive walls with high GEX@spot. No directional edge |
| **Trend day** | Sustained directional move with rising floor (BULLISH) or dropping ceiling (BEARISH) |
| **Day trend** | Sticky flag set after 20+ cycles of STRONG trend. Suppresses counter-trend entries |
| **Regime** | Persistent same-direction reading for 36+ cycles. Blocks opposing entries |
| **Lane A** | GEX-only entry path → live trades |
| **Lane B** | GEX + TV confirmation path → phantom trades for comparison |
| **Phantom trade** | Simulated trade tracking what would have happened under alternative conditions |
| **Pika** | Skylit term for bright yellow nodes that absorb price movement (positive GEX = dampening) |
| **Barney** | Skylit term for dark purple nodes that amplify price movement (negative GEX = volatility) |
| **Hedge node** | Wall where allExpGex >> 0DTE GEX (ratio ≥ 3.0). Institutional multi-day hedge |
| **Rolling wall** | Wall that shifted strike but maintained size between reads. Dealer repositioning |
| **Map reshuffle** | Many walls appearing/disappearing at once. Previous analysis may be invalidated |
| **Node slide** | Wall growing 100%+ between reads. Institutional shift in positioning |
| **Air pocket** | 3+ consecutive empty strikes between spot and target. Fast move through uncontested territory |

---

## Project Structure

```
src/
  agent/              Kimi K2.5 exit advisor + system prompt
    decision-engine.js  Agent pre-filter, input builder, decision cycle
    agent.js            Moonshot API call wrapper
    system-prompt.js    Agent system prompt with GEX education
  alerts/             Discord webhook alerts
    discord.js          Alert formatting, embedding, throttling
  backtest/           Replay engine for backtesting
    replay.js           Full-day replay through current config
    wall-narrative.js   Wall evolution tracing
  dashboard/          Express + WebSocket server
    dashboard-server.js WS event emitter for Next.js frontend
  gex/                GEX data processing
    gex-ingester.js     Heatseeker API fetch + Clerk auth
    gex-parser.js       Raw → parsed GEX maps + wall identification
    gex-scorer.js       0-100 directional scoring engine
    gex-patterns.js     10 structural pattern detectors
    multi-ticker-analyzer.js  12 cross-ticker analyses
    trinity.js          Multi-ticker parallel fetch orchestrator
    trend-detector.js   Trend day detection (4 conditions + hysteresis)
    constants.js        All thresholds, weights, intervals
  pipeline/           Main loop
    main-loop.js        Core orchestrator (21 steps per cycle)
    loop-status.js      Loop state for health monitoring
  review/             Self-improvement
    strategy-store.js   100+ config params, versioning, V1 baseline
    nightly-review.js   10-dimension nightly analysis via Claude Sonnet
    phantom-engine.js   Post-trade current vs previous config comparison
    rollback-engine.js  4 automatic rollback triggers + V1 floor
  store/              Data persistence
    db.js               SQLite (better-sqlite3, WAL mode), all tables
    state.js            In-memory buffers (spotBuffer, nodeHistory, etc.)
  trades/             Trade execution
    trade-manager.js    16 exit triggers, position management
    entry-engine.js     Lane A/B entry logic, 4 structural validation gates
    entry-gates.js      15 quality gates
    entry-context.js    Per-pattern support/ceiling node context
    target-calculator.js Option price estimation (delta+gamma+theta)
    strike-selector.js  ATM/OTM selection with 4-factor scoring
    phantom-tracker.js  Phantom trade lifecycle
  tv/                 TradingView integration
    tv-webhook-server.js Express webhook receiver (port 3001)
    tv-signal-store.js   13 signal slots, regime, staleness, weights
  utils/              Shared utilities
    config.js           Environment variable loader
    logger.js           createLogger('Name') factory
    market-hours.js     ET timezone, schedule phases, power hour
dashboard/            Next.js 14 frontend
  app/trading/        Real-time trading view
  app/ideas/          Trade ideas + historical browsing
  app/performance/    P&L analytics
  app/strategy/       Strategy version history
  app/system/         Service health
claw                  CLI tool (replay, status, health, strategy, review, briefing)
ecosystem.config.cjs  PM2 process config (CommonJS required by PM2)
```

### Tech Stack

- **Runtime**: Node.js 20+ (ES modules, `"type": "module"`)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **AI**: Kimi K2.5 via Moonshot API (exit advisory), Claude Sonnet (nightly reviews)
- **Market Data**: Heatseeker/Skylit (GEX), TradingView (technical indicators via webhooks)
- **Dashboard**: Next.js 14, Tailwind CSS, WebSocket
- **Alerts**: Discord webhooks
- **Process Management**: PM2
- **Timezone**: All market logic in US Eastern Time (via Luxon)
- **Auth**: Clerk auto-refresh for Heatseeker JWT (~60s TTL)
