# Feature Specification v0.2

## Core Derived Features

### A. Dominance Score
Measures which side (upper vs lower node) has relative control of price.

```
upper_magnet_score = upper_node_abs / max(upper_dist_from_spot, 5)
lower_magnet_score = lower_node_abs / max(abs(lower_dist_from_spot), 5)

dominance_score = upper_magnet_score - lower_magnet_score
```
- Positive = bullish pull dominant
- Negative = bearish pull dominant
- Range: roughly -100 to +100

**Rolling variants:**
```
dominance_5m  = dominance_score averaged over last 5 frames
dominance_15m = dominance_score averaged over last 15 frames
dominance_roc = dominance_score - dominance_15m  (rate of change)
```
- `dominance_roc > 0` = bullish side strengthening
- `dominance_roc < 0` = bearish side strengthening

### B. Flip Count / Chop Score
Counts how often the dominant node (king) changes strike.

```
flip_count_15m = count of king_strike changes in last 15 frames
flip_count_30m = count of king_strike changes in last 30 frames
flip_count_60m = count of king_strike changes in last 60 frames

chop_score = flip_count_30m * 2 + flip_count_60m - abs(dominance_score) / 10
```
- High flip + weak dominance = NO_TRADE or STRADDLE
- Low flip + strong dominance = directional confidence
- Thresholds: `chop_score > 15` = definite chop, `< 5` = trending

### C. Persistence Score
How long the current dominant node has remained dominant.

```
persistence_bars = consecutive frames where king_strike == current king_strike
persistence_score = persistence_bars / 30  (normalized to 30-frame window)
```
- `persistence_score > 1.0` = 30+ bars, very stable
- `persistence_score < 0.3` = less than 10 bars, unstable

**Also track:**
```
persistence_minutes = persistence_bars (since 1 frame ≈ 1 min)
persistence_vs_prev = current persistence / average persistence today
```

### D. Acceptance Score
Does price actually move toward and stay near a growing node?

**For upper node:**
```
# Distance trend: is price getting closer to the upper node?
dist_5_ago = upper_dist at frame[i-5]
dist_now = upper_dist at frame[i]
closing_rate_up = dist_5_ago - dist_now  # positive = getting closer

# VWAP alignment
vwap_confirms_up = 1 if spot > vwap else 0

# Momentum alignment
mom_confirms_up = 1 if mom_15m > 3 else 0

# Rejection check: did price touch within 8pts and bounce away?
touched_and_bounced_up = 1 if (min_dist_to_upper_in_last_10 < 8 AND current_dist > 15)

acceptance_up = (
    closing_rate_up * 0.3 +
    vwap_confirms_up * 10 +
    mom_confirms_up * 10 -
    touched_and_bounced_up * 20
)
```

**For lower node:** mirror logic.

## Regime Scoring Engine

### STRADDLE Score
```
straddle_score = 0
+ both_nodes_growing_15m * 30        # both above_pct_15m > 0.15 AND below_pct_15m > 0.15
+ realized_vol_percentile * 20       # vol vs today's range so far
+ flip_count_30m * 3                 # uncertainty = straddle territory
+ (20 - abs(dominance_score)) * 0.5  # balanced = good for straddle
- abs(mom_15m) * 1                   # strong momentum = directional, not straddle
```

### CALLS Score
```
calls_score = 0
+ above_growth_score * 25            # above_pct_15m > 0.2 and above_abs > 8M
+ persistence_score * 15             # king stable on upper side
+ acceptance_up * 10                 # price actually moving toward it
+ (price_vs_vwap > 0) * 10          # above institutional avg
+ (above_opening_range) * 10         # above morning range
+ dominance_roc * 5                  # dominance shifting bullish
- flip_count_30m * 3                 # uncertainty penalty
- (spot_pct_from_hod < -0.3) * 10   # stretched below HOD
- below_growing_strong * 15          # opposing node kills directional
```

### PUTS Score
```
puts_score = 0
+ below_growth_score * 25
+ persistence_score * 15
+ acceptance_down * 10
+ (price_vs_vwap < 0) * 10
+ (below_opening_range) * 10
+ (-dominance_roc) * 5
- flip_count_30m * 3
- (spot_pct_from_lod < -0.3) * 10
- above_growing_strong * 15
```

### NO_TRADE Conditions
```
no_trade_score = 0
+ (chop_score > 15) * 30            # too choppy
+ (no_nodes_growing) * 30           # nothing happening
+ (concentration > 0.45) * 20       # pinned
+ (realized_vol < median) * 15      # dead vol
+ (minute_of_day in [720, 810]) * 15 # lunch dead zone
```

### Regime Selection
```
regime = argmax(calls_score, puts_score, straddle_score, no_trade_score)
if max_score < 30: regime = NO_TRADE
regime_confidence = max_score - second_highest_score
```

## Failure Reason Taxonomy

| Tag | Description | Detection Logic |
|-----|-------------|-----------------|
| `NODE_GREW_NO_ACCEPTANCE` | Node growing but price never moved toward it | growth > 20% but closing_rate < 0 |
| `NODE_GREW_TOO_LATE` | Node started growing after price already moved 60%+ | entry frame > move_midpoint |
| `KING_FLIPPED_FAST` | King node changed within 5 bars of signal | flip in position.targetStrike within 5 frames |
| `BOTH_SIDES_ACTIVE` | Both nodes growing, directional was wrong call | both_pct_15m > 0.2 at signal time |
| `VOL_EXPANSION_NO_DIRECTION` | Big move but whipsawed | abs(mae) > 10 AND abs(mfe) > 10 |
| `TARGET_SHIFTED_EARLY` | Target moved before entry adapted | new dominant strike appeared < 10 frames in |
| `PRICE_STRETCHED_VWAP` | Too far from VWAP at entry | abs(price_vs_vwap) > 15 at entry |
| `PERSISTENCE_COLLAPSED` | Node looked stable then died in 1-2 bars | persistence was > 20 then dropped to < 5 |
| `LUNCH_CHOP` | Signal during 12:00-13:00 dead zone | minute_of_day in [720, 780] |
| `LARGER_TREND_OVERRIDE` | Day trend (day_move) overrode local signal | signal dir opposite to day_move when abs(day_move) > 30 |

## Success Metrics (80% Explained)

1. 80% of profitable straddles correctly labeled as STRADDLE regime
2. 80% of bad directional signals have a tagged failure reason (not UNKNOWN)
3. 70%+ of target shifts captured by rule logic
4. NO_TRADE filter blocks at least 60% of Feb 11-style false directionals
5. First valid directional signal occurs before 50% of day's move is gone
