# SPX 0DTE Options Trading System

Fully automated SPX 0DTE options trading system that reads real-time Gamma Exposure (GEX) data from 3 tickers (SPXW, SPY, QQQ), detects structural patterns in dealer hedging flows, and trades call/put entries with algorithmic exits.

---

## Data Pipeline (~5s cycles)

### 1. Fetch & Parse (`gex-ingester.js` -> `gex-parser.js`)

Every ~5 seconds during market hours, the system fetches raw GEX data from the Heatseeker/Skylit API for SPXW, SPY, and QQQ.

- **Source**: `https://app.skylit.ai` via JWT auth (auto-refreshed via Clerk)
- **Data**: 2D matrix of gamma values (strikes x expirations)
  - Column 0 (0DTE): primary decision-making
  - Columns 0-1 (near-term): multi-expiration confirmation
  - All columns: structural reference
- **Parsing**: Aggregates into GEX maps per strike, identifies walls (strikes with |GEX| >= $500K for SPXW/SPY, >= $100K for QQQ)
- **Output**: `parsed { spotPrice, strikes, aggregatedGex, allExpGex, walls }`

### Polling Schedule

| Phase | Time (ET) | Interval |
|-------|-----------|----------|
| Pre-market | 9:00-9:24 AM | 30s |
| Warm-up | 9:25-9:29 AM | 5s |
| Open volatility | 9:30-9:35 AM | 5s |
| Normal trading | 9:35 AM-3:29 PM | 5s |
| Theta warning | 3:30-3:59 PM | 5s |
| Market close | 4:00+ PM | Inactive |

### 2. Wall Trend Detection (`state.js`)

Each cycle, the system saves node snapshots (top 10 walls) and compares them across time windows (5/10/30/60 cycles ago):

- **GROWING**: Wall value increased >= 20%
- **WEAKENING**: Wall value decreased >= 20%
- **STABLE**: Within 20% of prior value
- **NEW**: Wall didn't exist in prior snapshot
- **GONE**: Wall disappeared from current snapshot

Also tracks `changePct10`, `changePct30`, `changePct60` for granular growth rate analysis.

### 3. GEX Scoring (`gex-scorer.js`)

Produces a 0-100 directional score for SPXW:

**Scoring dimensions:**
- **GEX at spot** (+30): Negative = volatile (dealers short gamma, amplifies moves). Positive = pinned (dealers long gamma, dampens moves)
- **Directional magnets** (+25): Negative wall above spot pulling price up (BULLISH) or below pulling down (BEARISH)
- **Support/floor** (+25): Positive GEX wall below spot providing support
- **Open air** (+20): Unobstructed path between spot and target
- **Wall trends** (+20): Target wall growing between reads
- **Momentum** (+/-25): 5min and 15min price movement. Strong (>= $15) = +25 aligned / -20 contrary. Moderate (>= $8) = +/-15
- **Cross-ticker bonus** (+10-15): Applied from multi-ticker alignment

**Confidence tiers:**
- HIGH: score >= 80
- MEDIUM: score >= 60
- LOW: score < 60
- NEUTRAL: score < 35

**Chop detection** (`checkChop()`): 5 conditions, needs >= 2 to flag as CHOP:
1. Pinned between positive walls above and below
2. > 85% positive GEX (everything dampened)
3. Tight range (small distance between key walls)
4. No significant walls (directionless)
5. Extreme pin zone (GEX@spot > $20M + positive walls on both sides)

**Output**: `scored { score, direction, confidence, isChop, wallsAbove, wallsBelow, floorWall, targetWall, gexAtSpot, momentum, environment }`

### 4. Multi-Ticker Analysis (`multi-ticker-analyzer.js`)

Cross-market confirmation using scored states from all 3 tickers:

- **King nodes**: Largest absolute GEX wall per ticker + proximity to spot (isNear <= 0.15%)
- **Alignment**: How many tickers agree on direction (0-3). Bonus: 0=+0, 1=+5, 2=+10, 3=+15
- **Rug setups**: Negative wall within 4 strikes of positive wall per ticker
- **Stacked walls**: 3+ consecutive same-sign strikes (strong barriers)
- **Driver**: Which ticker is catalyzing the move (priority: node slide > king node proximity > score strength)
- **Node slides**: Wall growing 100%+ between reads (institutional shift)
- **Wall classifications**: GATEKEEPER (at spot), MAGNET (negative), ANCHOR (positive far), NOISE (small)
- **Reshuffles**: 2+ new walls or 2+ disappeared = map rotation

**Output**: `multiAnalysis { bonus, alignment, king_nodes, rug_setups, stacked_walls, driver, multi_signal, wall_classifications, rolling_walls, reshuffles, hedge_nodes }`

---

## Pattern Detection (`gex-patterns.js`)

8 structural patterns detected from GEX walls + multi-ticker data. Each outputs `{ pattern, direction, confidence, target_strike, stop_strike, reasoning }`.

### Cross-Ticker Confidence Boost

All major patterns (RUG_PULL, REVERSE_RUG, KING_NODE_BOUNCE, PIKA_PILLOW, TRIPLE_CEILING/FLOOR) receive a confidence upgrade when SPY/QQQ king nodes structurally confirm the direction:
- SPY/QQQ king node near its own spot AND positioned as support (BULLISH) or resistance (BEARISH) = +1 confidence tier
- SPY/QQQ rug setups matching direction also count
- Both SPY + QQQ confirming = strong cross-ticker confirmation

### Pattern 1: RUG_PULL (BEARISH)
Negative wall pulling price through positive support. Setup: positive wall below + negative wall adjacent pulling down. Confidence boosted if multi-exp confirms, wall weakening, or cross-ticker confirms.

### Pattern 2: REVERSE_RUG (BULLISH)
Positive floor established below negative magnet. Setup: positive floor below + negative wall above pulling up. Confidence boosted if floor is GROWING, doubled in 30 cycles (changePct30 >= 1.0), or cross-ticker confirms.

### Pattern 3: KING_NODE_BOUNCE (Both directions)
Price arriving at the largest GEX wall (king node). Two paths:

**Positive king node** (support/resistance): Within 10pts of spot. First touch = HIGH confidence bounce, second touch = skip (weakened). Direction: below spot = BULLISH, above spot = BEARISH.

**Negative king node — magnet arrival** (new): Within 5pts of spot (tighter proximity required). When price arrives at a negative magnet, the pull is satisfied and price reverses. Starts at MEDIUM confidence (magnets less reliable). Direction: below spot = BULLISH reversal, above spot = BEARISH reversal.

Both paths get cross-ticker boost, trend adjustments, and king node flip detection (neg->pos = fresh support role).

KING_NODE_BOUNCE is exempt from chop gates and alignment gates in entry validation.

### Pattern 4: PIKA_PILLOW (BULLISH)
Large positive floor cushioning negative gamma environment. Requires: positive floor below spot + negative wall above (upside magnet). Confidence boosted in neg gamma environment, when floor is GROWING, or cross-ticker confirms.

### Pattern 5: TRIPLE_CEILING / TRIPLE_FLOOR (Both directions)
3+ stacked same-sign walls forming a barrier. Ceiling (positive above) = BEARISH. Floor (positive below) = BULLISH. Negative stacked above = magnet pulling up (BULLISH). Count >= 4 = HIGH confidence.

### Pattern 6: AIR_POCKET (Both directions)
3+ consecutive empty strikes (< 5% of target wall) between spot and target. Quality: 6+ empty = HIGH, 3-5 = MEDIUM. Points to fast directional move through uncontested territory.

### Pattern 7: RANGE_EDGE_FADE (Both directions)
Gatekeeper rejection at range boundary. Wall >= 30% of largest wall within 0.5% of spot. Price bouncing off the edge of the range.

### Pattern 8: WALL_FLIP (Both directions)
Wall sign change detection (positive -> negative or vice versa). Requires: wall flipped sign within lookback window, magnitude >= $5M, within 20pts of spot. Negative->positive below spot = BULLISH (former resistance became support). Positive->negative below spot = BEARISH (former support dissolved).

**Note**: WALL_FLIP has not yet fired in live trading (0 of 4,108+ trades). The pattern requires specific structural conditions (wall sign change detected by `getNodeSignChanges()` comparing current vs 10-30 cycles ago) that may be rare in practice.

### Pattern Deduplication
- Same direction + same strike: keep highest confidence only
- Conflicting directions: GEX direction wins, loser confidence downgraded
- Opposing current position: flagged but not blocked

---

## Trend Detection (`trend-detector.js`)

120-cycle rolling window (~10-12 min at 5s polling) detects sustained directional trends.

### 4 Conditions (BULLISH example):
1. **Floor strong**: Positive wall below spot >= $5M threshold
2. **Value grew**: Floor value increased >= 20% over window
3. **Directional bias**: >= 60% of readings in window are BULLISH
4. **Spot movement**: Price moved >= 15pts from window start

### Strength Progression:
- **EMERGING**: 3/4 conditions met
- **CONFIRMED**: 4/4 conditions met (activates trend-based entry/exit adjustments)
- **STRONG**: 4/4 conditions + floorRise >= 15pts + bias >= 70% + spotMove >= 20pts

### Hysteresis:
- CONFIRMED held for 30 cycles before allowing downgrade
- `dayTrendDirection`: sticky for full trading day once STRONG for 20+ cycles — suppresses counter-trend patterns
- `dayExitTrendDirection`: lighter version, activates faster for exit logic

### Metrics tracked:
- `growthRate`: ratio of recent floor value to old value (e.g., "2.7x" means floor tripled)
- `floorRise`/`ceilingDrop`: absolute movement of support floor or resistance ceiling
- `conditionsMet`: count of satisfied conditions

---

## Entry Decision (`entry-engine.js`)

### Lane A: GEX-Only (Live Trades)

Primary entry mechanism. No TradingView confirmation required.

1. Iterate detected patterns in confidence order (HIGH -> MEDIUM -> LOW)
2. Apply trend filter: suppress counter-trend patterns when `dayTrendDirection` is set
3. TV regime advisory: opposing TV regime downgrades confidence but does NOT block
4. Skip if confidence is LOW after adjustments
5. First pattern passing validation wins

**Validation gates (4 structural gates):**
- **Gate 0.5**: Chop environment — require HIGH confidence + score >= 80 (KING_NODE_BOUNCE and AIR_POCKET exempt; trend-aligned entries exempt)
- **Gate 1**: Alignment >= 2/3, OR GEX score >= 85 override (structural patterns RUG_PULL, REVERSE_RUG, KING_NODE_BOUNCE, PIKA_PILLOW bypass if confidence != LOW)
- **Gate 2**: Not at midpoint danger zone (breakout patterns exempt)
- **Gate 3**: GEX score >= 50 (>= 80 in power hour after 3:30 PM)
- **R:R check**: Target distance / stop distance >= 1.5x

### TREND_PULLBACK Entry

Separate from pattern detection — called independently after pattern checks. Does NOT conflict with pattern entries; both can fire but pattern entries are checked first.

**Requirements:**
- Trend state must be CONFIRMED or STRONG (not EMERGING)
- GEX direction must match trend direction
- GEX score >= 40
- Price within 8pts of support floor (BULLISH) or resistance ceiling (BEARISH)
- R:R >= 1.5x

**Confidence mapping:**
- STRONG trend -> VERY_HIGH confidence (can be downgraded by TV regime advisory)
- CONFIRMED trend -> HIGH confidence

### Lane B: GEX + TV Confirmation (Phantom Trades)

Same pattern detection and validation as Lane A, plus requires TradingView confirmation:

- TV weighted score >= 0.5 in pattern direction
- At least 1 TV indicator (Bravo 3m, Tango 3m, or Echo 3m) showing expected signal
- 5-minute cooldown between phantom trades
- Results stored as phantom trades (`is_phantom = 1`) for strategy comparison

Lane B is used for backtesting and strategy validation — it does not execute live trades.

---

## Entry Quality Gates (`entry-gates.js`)

14 active gates (Gate 6 removed). Every entry must pass ALL gates:

| Gate | Name | Rule |
|------|------|------|
| 1 | Entry Spacing | 60s minimum between entries (30s after trend wins) |
| 2 | Blackout Window | No entries 9:30-9:33 AM ET |
| 3 | Consecutive Loss Cooldown | 2+ same-direction losses -> 15min cooldown |
| 4 | TV Regime Gate | Lane B only — Pink Diamond blocks calls, Blue Diamond blocks puts. Lane A skips. |
| 5 | Re-entry Cooldown | Same direction after exit: 60s (30s in trend after wins) |
| ~~6~~ | ~~Daily Trade Limit~~ | ~~Removed — no daily trade cap~~ |
| 7 | Direction Stability | Must be stable for 3 cycles (skip during trend) |
| 8 | Recent Direction Flip | Wait 4 cycles after flip (skip during trend) |
| 9 | No Late Entries | No entries after 3:30 PM ET |
| 10 | Opening Caution | 9:33-9:40 AM: require score >= 85 AND alignment 3/3 |
| 11 | Chop Mode | Require score >= 80, enforce 120s spacing |
| 12 | Regime Conflict | Block entry against persistent opposing regime |
| 13 | Pattern Loss Cooldown | 3+ consecutive losses on specific pattern -> 30min cooldown |
| 14 | Max Trades Per Pattern | 8 trades per pattern per day (no overall daily cap) |
| 15 | Win Rate Filter | After 10+ trades: pattern needs >= 30% win rate to continue |

---

## Exit Engine (`trade-manager.js`)

14 exit triggers checked every cycle. First triggered wins. Priority order:

| # | Trigger | Type | Min Hold | Description |
|---|---------|------|----------|-------------|
| 1 | **TARGET_HIT** | Hard | None | SPX reached target wall price |
| 2 | **NODE_SUPPORT_BREAK** | Structural | None | Support/ceiling node broke. Trend-aware buffer: GONE=immediate, WEAKENING=0pt, GROWING=+1pt. Default buffer: 2pts |
| 3 | **TREND_FLOOR_BREAK** | Structural | None | Trend's support floor (BULLISH) or resistance ceiling (BEARISH) broke. 3pt buffer. Only during confirmed trends |
| 4 | **STOP_HIT** | Hard | None | SPX breached static stop level |
| 5 | **PROFIT_TARGET** | Percentage | None | SPX moved +0.15% (trend: x2.5 = +0.375%). Regime-adjusted, not static |
| 6 | **STOP_LOSS** | Percentage | None | SPX moved -0.20% (trend: x2.0 = -0.40%). Regime-adjusted, not static |
| 7 | **TV_COUNTER_FLIP** | Soft | 3 min | Both Bravo AND Tango 3m flipped against position |
| 8 | **OPPOSING_WALL** | Structural | 3 min | Large positive wall (>= $5M) materialized against position. Skipped during trend days |
| 9 | **MOMENTUM_TIMEOUT** | Soft | Phase 0: 90s | 4 progressive phases: Phase 0 (90s, +0.5pts), Phase 1 (5min, +2pts), Phase 2 (10min, 40% to target), Phase 3 (15min, net positive). Skipped during trend days |
| 10 | **TV_FLIP** | Soft | 3 min | Multiple 3m indicators turned against position (>= 2 opposing) |
| 11 | **TRAILING_STOP** | Dynamic | 3 min | Normal: activate at 8pts, trail at 5pts. Trend: activate at 5pts, trail at 8pts |
| 12 | **AGENT_EXIT** | Advisory | 3 min | Agent recommends exit BUT requires structural confirmation. Needs one of: price near support/ceiling node (3pts), momentum stalled (<1pt after 5min), or GEX score < 40 |
| 13 | **THETA_DEATH** | Hard | None | After configured time cutoff (default 3:30 PM ET) |
| 14 | **GEX_FLIP** | Soft | 3 min | GEX direction flipped against position. During trends: requires 3 consecutive opposing cycles |

### Regime-Adjusted Targets

Profit and stop targets are NOT static — they're multiplied during confirmed/strong trends:

| Parameter | Normal | Trend-Aligned |
|-----------|--------|---------------|
| Profit target | 0.15% SPX move | 0.375% (x2.5) |
| Stop loss | 0.20% SPX move | 0.40% (x2.0) |
| Trailing activate | 8 pts | 5 pts |
| Trailing distance | 5 pts | 8 pts |
| Momentum timeout | Standard phases | x2.5 longer phases |
| Structural stop | Standard buffer | x1.5 wider |

Trend-aligned means: trend is CONFIRMED/STRONG AND position direction matches trend direction, OR `dayExitTrendDirection` matches.

---

## State Tracking (`state.js`)

### Per-Ticker (SPXW, SPY, QQQ):
- **Node history**: Top 10 walls per cycle, 120-cycle buffer for trend/growth detection
- **Score history**: Last 60 scores for chop/regime detection
- **King node history**: Last 60 king nodes for type flip detection (`saveKingNode()` / `getKingNodeFlip()`)
- **Node sign changes**: Detects when walls flip positive <-> negative (`getNodeSignChanges()`)

### Global:
- **Current position**: State machine (FLAT -> PENDING -> IN_CALLS/IN_PUTS -> FLAT)
- **Trend state**: Direction, strength, support floor, resistance ceiling
- **TV signal state**: Echo/Bravo/Tango per ticker per timeframe
- **Node touches**: How many times price tested each wall (rate-limited to 1 per 60s)
- **Entry gate counters**: Spacing, loss streaks per pattern, trade counts
- **Daily P&L**: Running total + trade count

### Node Trending (In Development)

Per-wall trend tracking using `nodeTrends` Map:
- `trend`: GROWING / WEAKENING / STABLE / NEW / GONE
- `longTrend`: Same classification over 60-cycle window
- `changePct10/30/60`: Percentage change over 10/30/60 cycles
- Used by patterns for confidence adjustment (GROWING floor = stronger PIKA_PILLOW)
- Future: Will feed into regime classification and entry confidence weighting

### Regime Filter (In Development)

Persistent regime tracking using score and direction history:
- Detects sustained BULLISH/BEARISH/CHOP regimes over configurable windows
- Gate 12 blocks entries against persistent opposing regimes
- Future: Will integrate with trend detector for market-state classification (trending vs ranging vs transitioning)

---

## Storage (`db.js`)

SQLite database (`data/spx-bot.db`) with WAL mode for concurrent reads.

| Table | Purpose |
|-------|---------|
| `gex_snapshots` | Score, direction, walls per cycle |
| `gex_raw_snapshots` | Full parsed GEX + multi-analysis per cycle (for replay) |
| `trades` | Entry/exit details, P&L, pattern, context, greeks |
| `decisions` | Agent decision history + reasoning |
| `tv_signals` | Current state of all TV indicators |
| `tv_signal_log` | History of indicator changes |
| `alerts` | Sent alerts for deduplication + audit |
| `predictions` | GEX predictions for accuracy tracking |
| `health` | System health heartbeats |
| `strategy_versions` | Version control for config parameters |

---

## Alerts (`discord.js`)

Discord webhook notifications:
- Full GEX analysis (15min cooldown)
- Wall alerts: 20% growth or 30% shrinkage
- Direction flips
- Proximity alerts: price within 1 strike of target
- Trade entry/update/exit with P&L
- Opening summary + EOD recap
- Rate limited: 3 retries with exponential backoff

---

## Backtesting (`replay.js`)

Replays stored raw GEX snapshots with current config:

1. Load all `gex_raw_snapshots` for a date
2. Initialize with current strategy version
3. Process each cycle through full pipeline: parse -> score -> patterns -> entry gates -> execute/exit
4. All in-memory (no DB writes during replay)
5. Outputs: trade list, P&L summary, pattern effectiveness report
6. Wall narrative tool (`wall-narrative.js`) traces GEX wall evolution throughout the day

---

## Strategy Config (`strategy-store.js`)

100+ tunable parameters in V1_BASELINE. Key ones:

**Scoring**: `gex_only_min_score: 50`, `gex_strong_score: 80`
**Entry**: `alignment_min_for_entry: 2`, `min_entry_rr_ratio: 1.5`, `no_entry_after: '15:30'`
**Patterns**: `pattern_king_node_max_touches: 1`, `negative_king_node_max_dist_pts: 5`, `wall_flip_min_magnitude: 5_000_000`
**Exit**: `profit_target_pct: 0.15`, `stop_loss_pct: 0.20`, `trailing_stop_activate_pts: 8`
**Trend**: `trend_profit_target_multiplier: 2.5`, `trend_stop_loss_multiplier: 2.0`
**Limits**: `max_trades_per_pattern: 8`, `pattern_loss_limit: 3`
**Cross-ticker**: `pin_gex_at_spot_threshold: 20_000_000`

Versioning: V1 = baseline, versions branch as tree. Any version can be activated instantly. Phantom trades (Lane B) can test new configs alongside live (Lane A).

---

## Key Concepts

- **Positive GEX wall**: Dealers long gamma -> dampens moves -> support (below) or resistance (above)
- **Negative GEX wall**: Dealers short gamma -> amplifies moves -> magnet pulling price toward it
- **King node**: Largest absolute GEX wall on a ticker. Dominates price behavior
- **Magnet arrival**: When price reaches a negative king node, the pull is satisfied -> reversal zone
- **Rug setup**: Negative wall adjacent to positive wall -> support can collapse
- **Chop**: Positive walls on both sides + high GEX@spot -> price frozen, entries blocked
- **Cross-ticker confirmation**: SPY/QQQ king nodes structurally confirming SPXW pattern direction
- **Trend day**: Sustained directional move with rising floor (or dropping ceiling), detected by 4-condition system
