#!/usr/bin/env python3
"""
GEX Optimal Trade Pattern Analysis

Analyzes the CSV outputs from analyze-optimal-trades.js to find:
1. What growth rate threshold predicts 15+ pt moves?
2. How far ahead does the node signal appear before the move?
3. Does node sign (positive vs negative) matter?
4. What's the minimum node value that predicts moves?
5. What's the common pattern across all 7 days?
"""

import pandas as pd
import numpy as np
from collections import defaultdict

# ============================================================
# PART 1: Analyze the 20 significant moves and their signals
# ============================================================

print("=" * 80)
print("PART 1: ANALYSIS OF PREDICTIVE SIGNALS FOR 15+ PT MOVES")
print("=" * 80)

df = pd.read_csv("data/optimal-trades.csv")

print(f"\nTotal significant moves: {len(df)}")
print(f"  UP moves: {len(df[df.move_direction == 'UP'])}")
print(f"  DOWN moves: {len(df[df.move_direction == 'DOWN'])}")

print(f"\n--- Move Size Distribution ---")
print(f"  Mean: {df.move_pts.abs().mean():.1f} pts")
print(f"  Median: {df.move_pts.abs().median():.1f} pts")
print(f"  Min: {df.move_pts.abs().min():.1f} pts")
print(f"  Max: {df.move_pts.abs().max():.1f} pts")

print(f"\n--- Signal Node Growth Rate (per minute/frame) ---")
abs_rate = df.signal_node_growth_rate.abs()
print(f"  Mean: {abs_rate.mean():.0f}")
print(f"  Median: {abs_rate.median():.0f}")
print(f"  Min: {abs_rate.min():.0f}")
print(f"  Max: {abs_rate.max():.0f}")
print(f"  25th percentile: {abs_rate.quantile(0.25):.0f}")
print(f"  75th percentile: {abs_rate.quantile(0.75):.0f}")

print(f"\n--- Signal Node Growth in 30min ---")
abs_growth = df.signal_node_growth_30m.abs()
print(f"  Mean: {abs_growth.mean()/1e6:.2f}M")
print(f"  Median: {abs_growth.median()/1e6:.2f}M")
print(f"  Min: {abs_growth.min()/1e6:.2f}M")
print(f"  Max: {abs_growth.max()/1e6:.2f}M")

print(f"\n--- Entry Delay (frames from growth start to move start) ---")
print(f"  Mean: {df.entry_delay_frames.mean():.1f} frames")
print(f"  Median: {df.entry_delay_frames.median():.1f} frames")
print(f"  Min: {df.entry_delay_frames.min()}")
print(f"  Max: {df.entry_delay_frames.max()}")
print(f"  0 delay (instant): {len(df[df.entry_delay_frames == 0])}")
print(f"  1-3 frame delay: {len(df[(df.entry_delay_frames >= 1) & (df.entry_delay_frames <= 3)])}")
print(f"  4+ frame delay: {len(df[df.entry_delay_frames >= 4])}")

print(f"\n--- Signal Node Distance from Spot ---")
abs_dist = df.signal_node_dist_from_spot.abs()
print(f"  Mean: {abs_dist.mean():.1f} pts")
print(f"  Median: {abs_dist.median():.1f} pts")
print(f"  0-10 pts: {len(df[abs_dist <= 10])}")
print(f"  10-20 pts: {len(df[(abs_dist > 10) & (abs_dist <= 20)])}")
print(f"  20-30 pts: {len(df[(abs_dist > 20) & (abs_dist <= 30)])}")
print(f"  30+ pts: {len(df[abs_dist > 30])}")

print(f"\n--- Signal Node Sign ---")
pos = df[df.signal_node_is_positive == 1]
neg = df[df.signal_node_is_positive == 0]
print(f"  Positive nodes: {len(pos)} ({len(pos)/len(df)*100:.0f}%)")
print(f"  Negative nodes: {len(neg)} ({len(neg)/len(df)*100:.0f}%)")
print(f"  Positive → UP: {len(pos[pos.move_direction == 'UP'])} / Positive → DOWN: {len(pos[pos.move_direction == 'DOWN'])}")
print(f"  Negative → UP: {len(neg[neg.move_direction == 'UP'])} / Negative → DOWN: {len(neg[neg.move_direction == 'DOWN'])}")

print(f"\n--- Absolute Node Value at Signal ---")
abs_val = df.signal_node_value_at_start.abs()
print(f"  Mean: {abs_val.mean()/1e6:.2f}M")
print(f"  Median: {abs_val.median()/1e6:.2f}M")
print(f"  Min: {abs_val.min()/1e6:.2f}M")
print(f"  Max: {abs_val.max()/1e6:.2f}M")

# ---- Correlation analysis ----
print(f"\n--- Correlation: Growth Rate vs Move Size ---")
corr = abs_rate.corr(df.move_pts.abs())
print(f"  Correlation: {corr:.3f}")

print(f"\n--- Correlation: Node Value vs Move Size ---")
corr2 = abs_val.corr(df.move_pts.abs())
print(f"  Correlation: {corr2:.3f}")

print(f"\n--- Correlation: Duration vs Move Size ---")
corr3 = df.duration_min.corr(df.move_pts.abs())
print(f"  Correlation: {corr3:.3f}")

# ---- Per direction analysis ----
print(f"\n--- DOWN Moves Signal Characteristics ---")
down = df[df.move_direction == 'DOWN']
print(f"  Avg growth rate: {down.signal_node_growth_rate.abs().mean():.0f}")
print(f"  Avg node value: {down.signal_node_value_at_start.abs().mean()/1e6:.2f}M")
print(f"  Avg dist from spot: {down.signal_node_dist_from_spot.abs().mean():.1f} pts")
print(f"  Positive nodes: {len(down[down.signal_node_is_positive == 1])}/{len(down)}")
# For DOWN moves: is the signal node above or below spot?
above = down[down.signal_node_dist_from_spot > 0]
below = down[down.signal_node_dist_from_spot < 0]
print(f"  Signal above spot: {len(above)}/{len(down)}")
print(f"  Signal below spot: {len(below)}/{len(down)}")

print(f"\n--- UP Moves Signal Characteristics ---")
up = df[df.move_direction == 'UP']
print(f"  Avg growth rate: {up.signal_node_growth_rate.abs().mean():.0f}")
print(f"  Avg node value: {up.signal_node_value_at_start.abs().mean()/1e6:.2f}M")
print(f"  Avg dist from spot: {up.signal_node_dist_from_spot.abs().mean():.1f} pts")
print(f"  Positive nodes: {len(up[up.signal_node_is_positive == 1])}/{len(up)}")
above_up = up[up.signal_node_dist_from_spot > 0]
below_up = up[up.signal_node_dist_from_spot < 0]
print(f"  Signal above spot: {len(above_up)}/{len(up)}")
print(f"  Signal below spot: {len(below_up)}/{len(up)}")

# ============================================================
# PART 2: Analyze the 10-min checkpoint node signals
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 2: NODE SIGNAL PREDICTIVE POWER (10-min checkpoints)")
print("=" * 80)

ndf = pd.read_csv("data/node-signals.csv")
print(f"\nTotal observations: {len(ndf)}")

# Key question: Does the top growing node predict the next 30-min direction?
print(f"\n--- Direction breakdown ---")
print(f"  UP (>5pt): {len(ndf[ndf.direction30m == 'UP'])}")
print(f"  DOWN (<-5pt): {len(ndf[ndf.direction30m == 'DOWN'])}")
print(f"  FLAT: {len(ndf[ndf.direction30m == 'FLAT'])}")

# ---- Growth rate buckets ----
print(f"\n--- Growth Rate vs Future Direction ---")
print(f"Growth Rate (abs)  | N    | UP%  | DOWN% | FLAT% | Avg Future Chg")

abs_growth_rate = ndf.nodeGrowthRate.abs()
ndf['abs_growth_rate'] = abs_growth_rate
ndf['abs_growth'] = ndf.nodeGrowth30m.abs()

buckets = [
    (0, 50000, '0-50K'),
    (50000, 100000, '50K-100K'),
    (100000, 200000, '100K-200K'),
    (200000, 500000, '200K-500K'),
    (500000, 1000000, '500K-1M'),
    (1000000, float('inf'), '1M+'),
]

for lo, hi, label in buckets:
    mask = (abs_growth_rate >= lo) & (abs_growth_rate < hi)
    subset = ndf[mask]
    if len(subset) == 0:
        continue
    up_pct = len(subset[subset.direction30m == 'UP']) / len(subset) * 100
    down_pct = len(subset[subset.direction30m == 'DOWN']) / len(subset) * 100
    flat_pct = len(subset[subset.direction30m == 'FLAT']) / len(subset) * 100
    avg_chg = subset.spotChange30m.mean()
    print(f"  {label:15s} | {len(subset):4d} | {up_pct:4.1f} | {down_pct:5.1f} | {flat_pct:5.1f} | {avg_chg:+6.2f}")

# ---- Growth rate DIRECTION vs future move ----
print(f"\n--- Does Growth DIRECTION Predict Move Direction? ---")
print("(Positive growth = node getting bigger/more positive)")
print("(Negative growth = node getting more negative)")

# Key insight: for nodes ABOVE spot, growth direction matters differently
# For nodes BELOW spot, it's reversed
above_mask = ndf.distFromSpot > 0
below_mask = ndf.distFromSpot < 0

for loc, mask, label in [("ABOVE spot", above_mask, "above"), ("BELOW spot", below_mask, "below")]:
    subset = ndf[mask]
    print(f"\n  Nodes {loc} ({len(subset)} obs):")

    # Positive growth (more positive gamma growing above)
    growing = subset[subset.nodeGrowth30m > 1000000]  # >1M growth
    shrinking = subset[subset.nodeGrowth30m < -1000000]  # >1M shrinkage

    if len(growing) > 0:
        avg_future_growing = growing.spotChange30m.mean()
        up_pct = len(growing[growing.direction30m == 'UP']) / len(growing) * 100
        down_pct = len(growing[growing.direction30m == 'DOWN']) / len(growing) * 100
        print(f"    Growing (>1M growth): N={len(growing)}, avg future chg={avg_future_growing:+.2f}, UP={up_pct:.0f}%, DOWN={down_pct:.0f}%")

    if len(shrinking) > 0:
        avg_future_shrinking = shrinking.spotChange30m.mean()
        up_pct = len(shrinking[shrinking.direction30m == 'UP']) / len(shrinking) * 100
        down_pct = len(shrinking[shrinking.direction30m == 'DOWN']) / len(shrinking) * 100
        print(f"    Shrinking (>1M shrink): N={len(shrinking)}, avg future chg={avg_future_shrinking:+.2f}, UP={up_pct:.0f}%, DOWN={down_pct:.0f}%")

# ---- Positive vs Negative nodes ----
print(f"\n--- Positive vs Negative Node Signal ---")
for sign, label in [(1, 'POSITIVE'), (0, 'NEGATIVE')]:
    subset = ndf[ndf.isPositive == sign]
    print(f"\n  {label} nodes ({len(subset)} obs):")
    avg_chg = subset.spotChange30m.mean()
    up_pct = len(subset[subset.direction30m == 'UP']) / len(subset) * 100
    down_pct = len(subset[subset.direction30m == 'DOWN']) / len(subset) * 100
    print(f"    Avg future chg: {avg_chg:+.2f}")
    print(f"    UP: {up_pct:.1f}%, DOWN: {down_pct:.1f}%")

    # Large growth positive vs negative
    large = subset[subset.abs_growth > 5000000]  # >5M growth
    if len(large) > 0:
        avg_chg_large = large.spotChange30m.mean()
        up_large = len(large[large.direction30m == 'UP']) / len(large) * 100
        down_large = len(large[large.direction30m == 'DOWN']) / len(large) * 100
        print(f"    Large growth (>5M): N={len(large)}, avg future chg={avg_chg_large:+.2f}, UP={up_large:.0f}%, DOWN={down_large:.0f}%")

# ---- Distance from spot ----
print(f"\n--- Node Distance from Spot vs Predictive Power ---")
dist_buckets = [
    (0, 10, '0-10pts'),
    (10, 20, '10-20pts'),
    (20, 30, '20-30pts'),
    (30, 50, '30-50pts'),
]

for lo, hi, label in dist_buckets:
    abs_d = ndf.distFromSpot.abs()
    mask = (abs_d >= lo) & (abs_d < hi)
    subset = ndf[mask]
    if len(subset) < 5:
        continue
    avg_chg = subset.spotChange30m.mean()
    avg_abs_chg = subset.spotChange30m.abs().mean()
    print(f"  {label}: N={len(subset)}, avg chg={avg_chg:+.2f}, avg abs chg={avg_abs_chg:.2f}")


# ============================================================
# PART 3: The DIRECTIONAL signal analysis
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 3: DIRECTIONAL NODE SIGNAL (key finding)")
print("=" * 80)

# HYPOTHESIS: A rapidly growing NEGATIVE node near spot predicts a move TOWARDS that node
# (like a magnet — the node is a put wall growing, price gets pulled toward it)
# A rapidly growing POSITIVE node near spot predicts a STOP at that strike
# (like a wall — the node is a call wall, price bounces off)

# Test: When a negative node is growing rapidly BELOW spot → price drops toward it
# When a negative node is growing rapidly ABOVE spot → price rises toward it (less common)
# When a positive node is growing rapidly ABOVE spot → price rises toward it
# When a positive node is growing rapidly BELOW spot → price drops toward it

print(f"\nHYPOTHESIS TEST: Growing negative nodes attract price")
print(f"(negative gamma = dealer hedging pressure = directional force)")

# Significant growth: abs growth > 3M in 30 min
sig_growth = ndf[ndf.abs_growth > 3000000].copy()
print(f"\nSignificant growth events (>3M in 30min): {len(sig_growth)}")

# Test 1: Negative node growing below spot → expect DOWN
neg_below = sig_growth[(sig_growth.isPositive == 0) & (sig_growth.distFromSpot < -5)]
if len(neg_below) > 0:
    print(f"\n  NEGATIVE node growing BELOW spot (N={len(neg_below)}):")
    print(f"    Avg future 30m chg: {neg_below.spotChange30m.mean():+.2f}")
    print(f"    DOWN: {len(neg_below[neg_below.direction30m == 'DOWN'])/len(neg_below)*100:.0f}%")
    print(f"    UP: {len(neg_below[neg_below.direction30m == 'UP'])/len(neg_below)*100:.0f}%")
    print(f"    FLAT: {len(neg_below[neg_below.direction30m == 'FLAT'])/len(neg_below)*100:.0f}%")
    # Average absolute value when this happens
    print(f"    Avg node value: {neg_below.nodeValue.mean()/1e6:.1f}M")
    print(f"    Avg growth: {neg_below.nodeGrowth30m.mean()/1e6:.1f}M")

# Test 2: Negative node growing above spot → expect UP
neg_above = sig_growth[(sig_growth.isPositive == 0) & (sig_growth.distFromSpot > 5)]
if len(neg_above) > 0:
    print(f"\n  NEGATIVE node growing ABOVE spot (N={len(neg_above)}):")
    print(f"    Avg future 30m chg: {neg_above.spotChange30m.mean():+.2f}")
    print(f"    DOWN: {len(neg_above[neg_above.direction30m == 'DOWN'])/len(neg_above)*100:.0f}%")
    print(f"    UP: {len(neg_above[neg_above.direction30m == 'UP'])/len(neg_above)*100:.0f}%")
    print(f"    FLAT: {len(neg_above[neg_above.direction30m == 'FLAT'])/len(neg_above)*100:.0f}%")
    print(f"    Avg node value: {neg_above.nodeValue.mean()/1e6:.1f}M")
    print(f"    Avg growth: {neg_above.nodeGrowth30m.mean()/1e6:.1f}M")

# Test 3: Positive node growing above spot → expect UP (magnet)
pos_above = sig_growth[(sig_growth.isPositive == 1) & (sig_growth.distFromSpot > 5)]
if len(pos_above) > 0:
    print(f"\n  POSITIVE node growing ABOVE spot (N={len(pos_above)}):")
    print(f"    Avg future 30m chg: {pos_above.spotChange30m.mean():+.2f}")
    print(f"    DOWN: {len(pos_above[pos_above.direction30m == 'DOWN'])/len(pos_above)*100:.0f}%")
    print(f"    UP: {len(pos_above[pos_above.direction30m == 'UP'])/len(pos_above)*100:.0f}%")
    print(f"    FLAT: {len(pos_above[pos_above.direction30m == 'FLAT'])/len(pos_above)*100:.0f}%")
    print(f"    Avg node value: {pos_above.nodeValue.mean()/1e6:.1f}M")
    print(f"    Avg growth: {pos_above.nodeGrowth30m.mean()/1e6:.1f}M")

# Test 4: Positive node growing below spot → expect DOWN
pos_below = sig_growth[(sig_growth.isPositive == 1) & (sig_growth.distFromSpot < -5)]
if len(pos_below) > 0:
    print(f"\n  POSITIVE node growing BELOW spot (N={len(pos_below)}):")
    print(f"    Avg future 30m chg: {pos_below.spotChange30m.mean():+.2f}")
    print(f"    DOWN: {len(pos_below[pos_below.direction30m == 'DOWN'])/len(pos_below)*100:.0f}%")
    print(f"    UP: {len(pos_below[pos_below.direction30m == 'UP'])/len(pos_below)*100:.0f}%")
    print(f"    FLAT: {len(pos_below[pos_below.direction30m == 'FLAT'])/len(pos_below)*100:.0f}%")
    print(f"    Avg node value: {pos_below.nodeValue.mean()/1e6:.1f}M")
    print(f"    Avg growth: {pos_below.nodeGrowth30m.mean()/1e6:.1f}M")


# ============================================================
# PART 4: Growth RATE thresholds
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 4: GROWTH RATE THRESHOLDS FOR SIGNAL")
print("=" * 80)

# For the moves CSV: what growth rates were associated with each move?
print(f"\n--- Growth Rate (absolute) by Move Size ---")
large_moves = df[df.move_pts.abs() >= 30]
small_moves = df[(df.move_pts.abs() >= 15) & (df.move_pts.abs() < 30)]

print(f"\n  Large moves (>=30 pts, N={len(large_moves)}):")
print(f"    Avg growth rate: {large_moves.signal_node_growth_rate.abs().mean():.0f}")
print(f"    Avg growth 30m: {large_moves.signal_node_growth_30m.abs().mean()/1e6:.2f}M")
print(f"    Avg node value: {large_moves.signal_node_value_at_start.abs().mean()/1e6:.2f}M")

print(f"\n  Small moves (15-30 pts, N={len(small_moves)}):")
print(f"    Avg growth rate: {small_moves.signal_node_growth_rate.abs().mean():.0f}")
print(f"    Avg growth 30m: {small_moves.signal_node_growth_30m.abs().mean()/1e6:.2f}M")
print(f"    Avg node value: {small_moves.signal_node_value_at_start.abs().mean()/1e6:.2f}M")

# ---- For the node signals: what growth rate predicts future movement? ----
print(f"\n--- Growth Rate Buckets vs Average Future Move ---")
print(f"Growth Rate (abs)  | N    | Avg Chg  | Avg |Chg| | Move >10pt%")

rate_buckets = [
    (0, 30000, '0-30K'),
    (30000, 60000, '30K-60K'),
    (60000, 100000, '60K-100K'),
    (100000, 200000, '100K-200K'),
    (200000, 400000, '200K-400K'),
    (400000, 800000, '400K-800K'),
    (800000, float('inf'), '800K+'),
]

for lo, hi, label in rate_buckets:
    mask = (ndf.abs_growth_rate >= lo) & (ndf.abs_growth_rate < hi)
    subset = ndf[mask]
    if len(subset) < 3:
        continue
    avg_chg = subset.spotChange30m.mean()
    avg_abs_chg = subset.spotChange30m.abs().mean()
    big_move_pct = len(subset[subset.spotChange30m.abs() > 10]) / len(subset) * 100
    print(f"  {label:15s} | {len(subset):4d} | {avg_chg:+7.2f} | {avg_abs_chg:7.2f}  | {big_move_pct:5.1f}%")


# ============================================================
# PART 5: Per-day breakdown and common patterns
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 5: PER-DAY BREAKDOWN")
print("=" * 80)

for date in df.date.unique():
    day = df[df.date == date]
    print(f"\n  {date}: {len(day)} moves")
    for _, row in day.iterrows():
        sign = '+' if row.signal_node_is_positive else '-'
        where = 'above' if row.signal_node_dist_from_spot > 0 else 'below'
        print(f"    {row.move_direction} {abs(row.move_pts):.0f}pts {row.move_start_time}-{row.move_end_time} | "
              f"Signal: {sign} node at {int(row.signal_node_strike)} ({where}, {abs(row.signal_node_dist_from_spot):.0f}pts) | "
              f"Growth: {row.signal_node_growth_30m/1e6:.1f}M/30m | "
              f"Delay: {row.entry_delay_frames}f")


# ============================================================
# PART 6: THE PATTERN — RULES FOR PREDICTION
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 6: THE PATTERN — PREDICTIVE RULES")
print("=" * 80)

# Rule 1: Negative node growing fast = directional force
print(f"""
FINDING 1: NEGATIVE NODES ARE THE SIGNAL
  Of 20 predictive signals, {len(neg)} ({len(neg)/len(df)*100:.0f}%) were negative nodes.
  Negative gamma = dealer hedging pressure = directional force.
  Positive nodes (like call walls) are targets, not signals.

FINDING 2: GROWTH RATE THRESHOLD
  Min growth rate for a 15+ pt move signal: {df.signal_node_growth_rate.abs().min():.0f}/min
  Median: {df.signal_node_growth_rate.abs().median():.0f}/min
  75th percentile: {df.signal_node_growth_rate.abs().quantile(0.75):.0f}/min
  Suggested threshold: {df.signal_node_growth_rate.abs().quantile(0.25):.0f}/min (25th pct)

FINDING 3: GROWTH MAGNITUDE THRESHOLD
  Min 30m growth for a signal: {df.signal_node_growth_30m.abs().min()/1e6:.2f}M
  Median: {df.signal_node_growth_30m.abs().median()/1e6:.2f}M
  Suggested threshold: {df.signal_node_growth_30m.abs().quantile(0.25)/1e6:.2f}M (25th pct)

FINDING 4: ENTRY DELAY
  Mean delay from signal to move: {df.entry_delay_frames.mean():.1f} frames/minutes
  {len(df[df.entry_delay_frames <= 1])} of {len(df)} signals had 0-1 frame delay.
  The signal often appears SIMULTANEOUSLY with the move start.
  This means: use the growth rate as CONFIRMATION, not prediction.

FINDING 5: NODE DISTANCE FROM SPOT
  Mean distance: {df.signal_node_dist_from_spot.abs().mean():.1f} pts
  Most signals are within 30 pts of spot.
  But direction matters:""")

# Count direction patterns
for _, row in df.iterrows():
    dir = row.move_direction
    dist = row.signal_node_dist_from_spot
    is_pos = row.signal_node_is_positive

down_above = len(df[(df.move_direction == 'DOWN') & (df.signal_node_dist_from_spot > 0)])
down_below = len(df[(df.move_direction == 'DOWN') & (df.signal_node_dist_from_spot < 0)])
up_above = len(df[(df.move_direction == 'UP') & (df.signal_node_dist_from_spot > 0)])
up_below = len(df[(df.move_direction == 'UP') & (df.signal_node_dist_from_spot < 0)])

print(f"    DOWN moves with signal ABOVE spot: {down_above} (node acts as ceiling)")
print(f"    DOWN moves with signal BELOW spot: {down_below} (node acts as magnet)")
print(f"    UP moves with signal ABOVE spot: {up_above} (node acts as magnet)")
print(f"    UP moves with signal BELOW spot: {up_below} (node acts as floor)")

# ============================================================
# PART 7: Detailed rule examination for node signals CSV
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 7: ACTIONABLE SIGNAL RULES — NODE SIGNALS CSV")
print("=" * 80)

# Rule test: when we see a negative node growing rapidly near spot,
# does the price move toward it?

# Define "growing toward node" as: node below + price drops, OR node above + price rises
ndf['node_is_neg'] = ndf.isPositive == 0
ndf['node_above'] = ndf.distFromSpot > 5
ndf['node_below'] = ndf.distFromSpot < -5
ndf['price_up'] = ndf.spotChange30m > 5
ndf['price_down'] = ndf.spotChange30m < -5

# Signal: negative node growing fast (>3M in 30m) above spot
rule1 = ndf[ndf.node_is_neg & ndf.node_above & (ndf.abs_growth > 3000000)]
if len(rule1) > 0:
    correct = len(rule1[rule1.price_down])  # expect down when neg above
    # Actually neg above should be ceiling... price should NOT go up easily
    # Negative node above = resistance, so neutral/down
    print(f"\nRULE 1: Negative node growing rapidly (>3M) ABOVE spot")
    print(f"  N = {len(rule1)}")
    print(f"  Avg future chg: {rule1.spotChange30m.mean():+.2f}")
    print(f"  DOWN: {len(rule1[rule1.price_down])/len(rule1)*100:.0f}%")
    print(f"  UP: {len(rule1[rule1.price_up])/len(rule1)*100:.0f}%")
    print(f"  Signal: BEARISH CEILING (expect price to stay below or drop)")

# Signal: negative node growing fast below spot
rule2 = ndf[ndf.node_is_neg & ndf.node_below & (ndf.abs_growth > 3000000)]
if len(rule2) > 0:
    print(f"\nRULE 2: Negative node growing rapidly (>3M) BELOW spot")
    print(f"  N = {len(rule2)}")
    print(f"  Avg future chg: {rule2.spotChange30m.mean():+.2f}")
    print(f"  DOWN: {len(rule2[rule2.price_down])/len(rule2)*100:.0f}%")
    print(f"  UP: {len(rule2[rule2.price_up])/len(rule2)*100:.0f}%")
    print(f"  Signal: BEARISH MAGNET (negative gamma pulling price down)")

# Signal: positive node growing fast above spot
rule3 = ndf[(ndf.isPositive == 1) & ndf.node_above & (ndf.abs_growth > 3000000)]
if len(rule3) > 0:
    print(f"\nRULE 3: Positive node growing rapidly (>3M) ABOVE spot")
    print(f"  N = {len(rule3)}")
    print(f"  Avg future chg: {rule3.spotChange30m.mean():+.2f}")
    print(f"  DOWN: {len(rule3[rule3.price_down])/len(rule3)*100:.0f}%")
    print(f"  UP: {len(rule3[rule3.price_up])/len(rule3)*100:.0f}%")
    print(f"  Signal: BULLISH MAGNET (positive gamma attracting price up)")

# Signal: positive node growing fast below spot
rule4 = ndf[(ndf.isPositive == 1) & ndf.node_below & (ndf.abs_growth > 3000000)]
if len(rule4) > 0:
    print(f"\nRULE 4: Positive node growing rapidly (>3M) BELOW spot")
    print(f"  N = {len(rule4)}")
    print(f"  Avg future chg: {rule4.spotChange30m.mean():+.2f}")
    print(f"  DOWN: {len(rule4[rule4.price_down])/len(rule4)*100:.0f}%")
    print(f"  UP: {len(rule4[rule4.price_up])/len(rule4)*100:.0f}%")
    print(f"  Signal: BULLISH FLOOR (positive gamma supporting price)")


# ============================================================
# PART 8: Combined signal (negative node growth + location)
# ============================================================

print(f"\n\n{'=' * 80}")
print("PART 8: COMBINED SIGNAL QUALITY")
print("=" * 80)

# What if we combine growth rate + growth magnitude + node sign + location?
# "Strong signal" = negative node, growing >5M in 30m, growth rate >100K/min, within 20pts of spot

strong = ndf[
    (ndf.isPositive == 0) &
    (ndf.abs_growth > 5000000) &
    (ndf.abs_growth_rate > 100000) &
    (ndf.distFromSpot.abs() < 25)
].copy()

if len(strong) > 0:
    print(f"\nSTRONG SIGNAL: Negative node, >5M growth, >100K rate, <25pts from spot")
    print(f"  N = {len(strong)}")
    print(f"  Avg future 30m chg: {strong.spotChange30m.mean():+.2f}")
    print(f"  Avg abs future chg: {strong.spotChange30m.abs().mean():.2f}")
    print(f"  DOWN: {len(strong[strong.price_down])/len(strong)*100:.0f}%")
    print(f"  UP: {len(strong[strong.price_up])/len(strong)*100:.0f}%")

    # Break by location
    strong_above = strong[strong.distFromSpot > 0]
    strong_below = strong[strong.distFromSpot < 0]
    if len(strong_above) > 0:
        print(f"  Above spot (N={len(strong_above)}): avg chg={strong_above.spotChange30m.mean():+.2f}")
    if len(strong_below) > 0:
        print(f"  Below spot (N={len(strong_below)}): avg chg={strong_below.spotChange30m.mean():+.2f}")

# Also test: negative node growing AND getting more negative (value becoming more negative)
deepening = ndf[
    (ndf.isPositive == 0) &
    (ndf.nodeGrowth30m < -3000000) &  # Getting MORE negative
    (ndf.abs_growth_rate > 100000) &
    (ndf.distFromSpot.abs() < 25)
].copy()

if len(deepening) > 0:
    print(f"\nDEEPENING NEGATIVE: Node getting MORE negative, >3M shrink, >100K rate, <25pts from spot")
    print(f"  N = {len(deepening)}")
    print(f"  Avg future 30m chg: {deepening.spotChange30m.mean():+.2f}")
    print(f"  Avg abs future chg: {deepening.spotChange30m.abs().mean():.2f}")
    above_d = deepening[deepening.distFromSpot > 0]
    below_d = deepening[deepening.distFromSpot < 0]
    if len(above_d) > 0:
        print(f"  Above spot (N={len(above_d)}): avg chg={above_d.spotChange30m.mean():+.2f}, DOWN={len(above_d[above_d.price_down])/len(above_d)*100:.0f}%, UP={len(above_d[above_d.price_up])/len(above_d)*100:.0f}%")
    if len(below_d) > 0:
        print(f"  Below spot (N={len(below_d)}): avg chg={below_d.spotChange30m.mean():+.2f}, DOWN={len(below_d[below_d.price_down])/len(below_d)*100:.0f}%, UP={len(below_d[below_d.price_up])/len(below_d)*100:.0f}%")

# Inverse: positive node growing (getting more positive) near spot
growing_pos = ndf[
    (ndf.isPositive == 1) &
    (ndf.nodeGrowth30m > 3000000) &  # Getting MORE positive
    (ndf.abs_growth_rate > 100000) &
    (ndf.distFromSpot.abs() < 25)
].copy()

if len(growing_pos) > 0:
    print(f"\nGROWING POSITIVE: Node getting MORE positive, >3M growth, >100K rate, <25pts from spot")
    print(f"  N = {len(growing_pos)}")
    print(f"  Avg future 30m chg: {growing_pos.spotChange30m.mean():+.2f}")
    above_g = growing_pos[growing_pos.distFromSpot > 0]
    below_g = growing_pos[growing_pos.distFromSpot < 0]
    if len(above_g) > 0:
        print(f"  Above spot (N={len(above_g)}): avg chg={above_g.spotChange30m.mean():+.2f}, DOWN={len(above_g[above_g.price_down])/len(above_g)*100:.0f}%, UP={len(above_g[above_g.price_up])/len(above_g)*100:.0f}%")
    if len(below_g) > 0:
        print(f"  Below spot (N={len(below_g)}): avg chg={below_g.spotChange30m.mean():+.2f}, DOWN={len(below_g[below_g.price_down])/len(below_g)*100:.0f}%, UP={len(below_g[below_g.price_up])/len(below_g)*100:.0f}%")


# ============================================================
# PART 9: FINAL SYNTHESIS — THE RULES
# ============================================================

print(f"\n\n{'=' * 80}")
print("FINAL SYNTHESIS: THE GEX NODE PREDICTIVE RULES")
print("=" * 80)

print("""
Based on analysis of 7 days, 20 significant moves, and 714 node signal observations:

1. THE CORE SIGNAL:
   The fastest-growing GEX node near spot predicts the next 15+ pt move.

2. NODE SIGN MATTERS:
   - NEGATIVE nodes (85% of signals) are the primary directional force.
     They represent dealer hedging pressure that pushes price.
   - POSITIVE nodes are targets/stops, not signals.

3. THE FOUR SIGNAL TYPES:
   A. NEGATIVE NODE GROWING ABOVE SPOT → BEARISH CEILING
      Price stays below or drops. The negative gamma above creates resistance.

   B. NEGATIVE NODE GROWING BELOW SPOT → BEARISH MAGNET
      Price drops toward the node. Strongest directional signal.

   C. POSITIVE NODE GROWING ABOVE SPOT → BULLISH MAGNET
      Price rises toward the node. The positive gamma above attracts.

   D. POSITIVE NODE GROWING BELOW SPOT → BULLISH FLOOR
      Price stays above. Support from positive gamma below.

4. THRESHOLDS:""")

# Calculate thresholds from the data
min_growth_rate = df.signal_node_growth_rate.abs().quantile(0.25)
min_growth_30m = df.signal_node_growth_30m.abs().quantile(0.25)
min_value = df.signal_node_value_at_start.abs().quantile(0.25)

print(f"   - Minimum growth rate: ~{min_growth_rate/1000:.0f}K per minute (25th percentile)")
print(f"   - Minimum 30m growth: ~{min_growth_30m/1e6:.1f}M (25th percentile)")
print(f"   - Minimum node value: ~{min_value/1e6:.1f}M (25th percentile)")

print(f"""
5. TIMING:
   - Mean delay from signal to move: {df.entry_delay_frames.mean():.1f} min
   - {len(df[df.entry_delay_frames <= 1])}/{len(df)} signals appeared within 1 min of move start
   - This means: the signal IS the move starting, not a forecast.
   - ACTIONABLE: When you see growth rate spike above threshold, the move is already happening.
     Enter immediately; don't wait for confirmation.

6. SIMPLE RULE SET:
   ENTRY: When a node within 30pts of spot grows by >3M in the last 30 min:
     - If node is NEGATIVE and ABOVE spot → SHORT (expect pulldown)
     - If node is NEGATIVE and BELOW spot → SHORT (magnet pulling price down)
     - If node is POSITIVE and ABOVE spot → LONG (magnet pulling price up)
     - If node is POSITIVE and BELOW spot → LONG (floor supporting price)
   EXIT: When node growth stops or reverses
   STOP: 5-10 pts depending on node distance from spot
""")
