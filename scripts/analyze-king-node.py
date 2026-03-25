#!/usr/bin/env python3
"""
Comprehensive King Node Analysis
Reads king-node-analysis.csv and finds patterns that separate winners from losers.
"""
import pandas as pd
import numpy as np
from collections import defaultdict

df = pd.read_csv('data/king-node-analysis.csv')

print("=" * 100)
print("KING NODE GEX ANALYSIS — ALL DAYS")
print("=" * 100)
print(f"\nTotal days analyzed: {len(df)}")
print(f"Date range: {df['date'].iloc[0]} to {df['date'].iloc[-1]}")

# ============================================================
# SECTION 1: Overall Results by Stop Level
# ============================================================
print("\n" + "=" * 100)
print("SECTION 1: OVERALL RESULTS BY STOP LEVEL")
print("=" * 100)

stop_levels = [8, 12, 15, 18, 20, 25]
for sl in stop_levels:
    rcol = f'result_s{sl}'
    pcol = f'pnl_s{sl}'
    wins = df[df[rcol] == 'TARGET_HIT']
    stops = df[df[rcol] == 'STOP_HIT']
    trails = df[df[rcol] == 'TRAIL_BE']
    eod = df[df[rcol] == 'EOD_EXIT']
    total_pnl = df[pcol].sum()
    win_pct = len(wins) / len(df) * 100
    avg_win = wins[pcol].mean() if len(wins) > 0 else 0
    avg_loss = stops[pcol].mean() if len(stops) > 0 else 0
    print(f"\n  Stop={sl}pt: TARGET={len(wins)} STOP={len(stops)} TRAIL_BE={len(trails)} EOD={len(eod)} | WR={win_pct:.0f}% | NET={total_pnl:+.1f}pts | AvgWin={avg_win:+.1f} AvgLoss={avg_loss:+.1f}")

# ============================================================
# SECTION 2: Day Type Breakdown (using s12 as default)
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 2: PERFORMANCE BY DAY TYPE (12pt stop)")
print("=" * 100)

for dt in ['BIG_TREND', 'MODERATE', 'CHOP']:
    sub = df[df['day_type'] == dt]
    if len(sub) == 0:
        continue
    wins = sub[sub['result_s12'] == 'TARGET_HIT']
    stops = sub[sub['result_s12'] == 'STOP_HIT']
    total = sub['pnl_s12'].sum()
    wr = len(wins) / len(sub) * 100 if len(sub) > 0 else 0
    avg_mfe = sub['mfe_s12'].mean()
    avg_mae = sub['mae_s12'].mean()
    print(f"\n  {dt} ({len(sub)} days):")
    print(f"    Results: TARGET={len(wins)} STOP={len(stops)} TRAIL_BE={len(sub[sub['result_s12']=='TRAIL_BE'])} EOD={len(sub[sub['result_s12']=='EOD_EXIT'])}")
    print(f"    Win Rate: {wr:.0f}% | Net P&L: {total:+.1f}pts | Avg P&L/day: {total/len(sub):+.1f}pts")
    print(f"    Avg MFE: {avg_mfe:.1f}pts | Avg MAE: {avg_mae:.1f}pts")
    print(f"    Avg SPX move: {sub['abs_move'].mean():.1f}pts | Avg range: {sub['range'].mean():.1f}pts")

    # Show each day
    for _, r in sub.iterrows():
        marker = "W" if r['result_s12'] == 'TARGET_HIT' else ("S" if r['result_s12'] == 'STOP_HIT' else "T/E")
        print(f"      {r['date']} [{marker}] move={r['spx_move']:+.0f} king={r['king_strike']} dist={r['king_dist']:+.0f} neg={r['king_is_negative']} pnl={r['pnl_s12']:+.1f} mfe={r['mfe_s12']:.0f} mae={r['mae_s12']:.0f}")

# ============================================================
# SECTION 3: What separates TARGET_HIT from STOP_HIT?
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 3: WHAT SEPARATES WINNERS FROM LOSERS? (12pt stop)")
print("=" * 100)

wins = df[df['result_s12'] == 'TARGET_HIT']
stops = df[df['result_s12'] == 'STOP_HIT']

features = ['king_abs_dist', 'king_value_M', 'king_pct_of_total', 'king_is_negative',
            'neg_gamma_pct', 'total_abs_gamma_M', 'gex_at_spot_M', 'abs_move', 'range',
            'wall_count_above', 'wall_count_below', 'air_pocket_up', 'air_pocket_down',
            'first30_move', 'first30_dir_matches_king']

print(f"\n{'Feature':<30} {'Winners (n={})'.format(len(wins)):<25} {'Losers (n={})'.format(len(stops)):<25} {'Delta':<15}")
print("-" * 95)
for feat in features:
    w_mean = wins[feat].mean() if len(wins) > 0 else 0
    l_mean = stops[feat].mean() if len(stops) > 0 else 0
    w_med = wins[feat].median() if len(wins) > 0 else 0
    l_med = stops[feat].median() if len(stops) > 0 else 0
    delta = w_mean - l_mean
    print(f"  {feat:<28} mean={w_mean:>8.2f} med={w_med:>8.2f}   mean={l_mean:>8.2f} med={l_med:>8.2f}   {delta:>+8.2f}")

# ============================================================
# SECTION 4: King Node Characteristics
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 4: KING NODE CHARACTERISTICS vs OUTCOME")
print("=" * 100)

# 4a: King node distance buckets
print("\n--- 4a: King Distance from Spot ---")
dist_buckets = [(0, 15, '0-15'), (15, 30, '15-30'), (30, 50, '30-50'), (50, 80, '50-80'), (80, 200, '80+')]
for lo, hi, label in dist_buckets:
    sub = df[(df['king_abs_dist'] >= lo) & (df['king_abs_dist'] < hi)]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    avg_mfe = sub['mfe_s12'].mean()
    print(f"  dist {label:>6}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f} | avg_pnl={net/len(sub):>+6.1f} | avg_mfe={avg_mfe:.0f}")

# 4b: King node sign (positive vs negative gamma)
print("\n--- 4b: King Node Sign (Positive vs Negative Gamma) ---")
for neg in [0, 1]:
    label = 'NEGATIVE' if neg == 1 else 'POSITIVE'
    sub = df[df['king_is_negative'] == neg]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    avg_mfe = sub['mfe_s12'].mean()
    print(f"  {label:>8}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f} | avg_pnl={net/len(sub):>+6.1f} | avg_mfe={avg_mfe:.0f}")

# 4c: King node % of total gamma
print("\n--- 4c: King Node % of Total Gamma ---")
pct_buckets = [(0, 5, '0-5%'), (5, 10, '5-10%'), (10, 20, '10-20%'), (20, 50, '20-50%'), (50, 100, '50%+')]
for lo, hi, label in pct_buckets:
    sub = df[(df['king_pct_of_total'] >= lo) & (df['king_pct_of_total'] < hi)]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    print(f"  {label:>6}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f} | avg_pnl={net/len(sub):>+6.1f}")

# 4d: King node value (absolute, in millions)
print("\n--- 4d: King Node Absolute Value ---")
val_buckets = [(0, 5, '0-5M'), (5, 10, '5-10M'), (10, 20, '10-20M'), (20, 50, '20-50M'), (50, 200, '50M+')]
for lo, hi, label in val_buckets:
    sub = df[(df['king_value_M'].abs() >= lo) & (df['king_value_M'].abs() < hi)]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    print(f"  {label:>6}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f} | avg_pnl={net/len(sub):>+6.1f}")

# ============================================================
# SECTION 5: Regime (Positive vs Negative GEX near spot)
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 5: REGIME (POSITIVE vs NEGATIVE GEX near spot)")
print("=" * 100)

for regime in ['POSITIVE', 'NEGATIVE']:
    sub = df[df['regime'] == regime]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    avg_mfe = sub['mfe_s12'].mean()
    avg_mae = sub['mae_s12'].mean()
    print(f"\n  {regime}: n={len(sub)} | W={w} S={s} | WR={wr:.0f}% | NET={net:+.1f} | avg_mfe={avg_mfe:.1f} avg_mae={avg_mae:.1f}")

    # Cross with day type
    for dt in ['BIG_TREND', 'MODERATE', 'CHOP']:
        sub2 = sub[sub['day_type'] == dt]
        if len(sub2) == 0:
            continue
        w2 = len(sub2[sub2['result_s12'] == 'TARGET_HIT'])
        net2 = sub2['pnl_s12'].sum()
        wr2 = w2 / len(sub2) * 100 if len(sub2) > 0 else 0
        print(f"    {dt}: n={len(sub2)} | W={w2} | WR={wr2:.0f}% | NET={net2:+.1f}")

# ============================================================
# SECTION 6: First 30-Minute Move Direction
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 6: FIRST 30-MINUTE MOVE vs OUTCOME")
print("=" * 100)

for matches in [1, 0]:
    label = 'ALIGNED' if matches == 1 else 'OPPOSED'
    sub = df[df['first30_dir_matches_king'] == matches]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    print(f"\n  First30 {label}: n={len(sub)} | W={w} S={s} | WR={wr:.0f}% | NET={net:+.1f}")

# Also check magnitude of first 30 move
print("\n  First30 move magnitude buckets:")
f30_buckets = [(0, 5, '0-5'), (5, 15, '5-15'), (15, 30, '15-30'), (30, 100, '30+')]
for lo, hi, label in f30_buckets:
    sub = df[(df['first30_move'].abs() >= lo) & (df['first30_move'].abs() < hi)]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    aligned = len(sub[sub['first30_dir_matches_king'] == 1])
    print(f"    |first30|={label:>5}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f} | aligned={aligned}/{len(sub)}")

# ============================================================
# SECTION 7: Entry Direction
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 7: ENTRY DIRECTION BREAKDOWN")
print("=" * 100)

for d in ['BULLISH', 'BEARISH']:
    sub = df[df['entry_dir'] == d]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    avg_mfe = sub['mfe_s12'].mean()
    print(f"\n  {d}: n={len(sub)} | W={w} S={s} | WR={wr:.0f}% | NET={net:+.1f} | avg_mfe={avg_mfe:.1f}")

# ============================================================
# SECTION 8: Optimal Stop Distance Analysis
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 8: OPTIMAL STOP DISTANCE")
print("=" * 100)

print(f"\n  {'Stop':<8} {'Trades':<8} {'Wins':<8} {'Stops':<8} {'Trail':<8} {'EOD':<8} {'WR%':<8} {'NET':<10} {'Avg':<10} {'AvgWin':<10} {'AvgLoss':<10}")
print("  " + "-" * 90)
for sl in stop_levels:
    rcol = f'result_s{sl}'
    pcol = f'pnl_s{sl}'
    w = len(df[df[rcol] == 'TARGET_HIT'])
    s = len(df[df[rcol] == 'STOP_HIT'])
    t = len(df[df[rcol] == 'TRAIL_BE'])
    e = len(df[df[rcol] == 'EOD_EXIT'])
    net = df[pcol].sum()
    wr = w / len(df) * 100
    avg = net / len(df)
    avg_w = df[df[rcol] == 'TARGET_HIT'][pcol].mean() if w > 0 else 0
    avg_l = df[df[rcol] == 'STOP_HIT'][pcol].mean() if s > 0 else 0
    print(f"  {sl:<8} {len(df):<8} {w:<8} {s:<8} {t:<8} {e:<8} {wr:<8.0f} {net:<+10.1f} {avg:<+10.1f} {avg_w:<+10.1f} {avg_l:<+10.1f}")

# ============================================================
# SECTION 9: Multi-Factor Analysis
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 9: MULTI-FACTOR FILTER ANALYSIS")
print("=" * 100)

# Test various filter combinations
filters = [
    ("king_abs_dist <= 30", df[df['king_abs_dist'] <= 30]),
    ("king_abs_dist <= 50", df[df['king_abs_dist'] <= 50]),
    ("king_abs_dist > 50", df[df['king_abs_dist'] > 50]),
    ("king_is_negative == 1", df[df['king_is_negative'] == 1]),
    ("king_is_negative == 1 AND dist <= 50", df[(df['king_is_negative'] == 1) & (df['king_abs_dist'] <= 50)]),
    ("king_is_negative == 1 AND dist <= 30", df[(df['king_is_negative'] == 1) & (df['king_abs_dist'] <= 30)]),
    ("king_pct >= 5%", df[df['king_pct_of_total'] >= 5]),
    ("king_pct >= 10%", df[df['king_pct_of_total'] >= 10]),
    ("NEGATIVE regime", df[df['regime'] == 'NEGATIVE']),
    ("first30 aligned", df[df['first30_dir_matches_king'] == 1]),
    ("neg king + first30 aligned", df[(df['king_is_negative'] == 1) & (df['first30_dir_matches_king'] == 1)]),
    ("neg king + dist<=50 + first30 aligned", df[(df['king_is_negative'] == 1) & (df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 1)]),
    ("pos king + dist<=20", df[(df['king_is_negative'] == 0) & (df['king_abs_dist'] <= 20)]),
    ("pos king + dist<=20 + first30 aligned", df[(df['king_is_negative'] == 0) & (df['king_abs_dist'] <= 20) & (df['first30_dir_matches_king'] == 1)]),
    ("NOT chop day (abs_move >= 30)", df[df['abs_move'] >= 30]),
    ("chop day only (abs_move < 30)", df[df['abs_move'] < 30]),
    ("king dist 15-50", df[(df['king_abs_dist'] >= 15) & (df['king_abs_dist'] <= 50)]),
    ("neg regime + neg king", df[(df['regime'] == 'NEGATIVE') & (df['king_is_negative'] == 1)]),
    ("air_pocket >= 3 in entry dir", df.apply(lambda r: r['air_pocket_up'] >= 3 if r['entry_dir'] == 'BULLISH' else r['air_pocket_down'] >= 3, axis=1)),
    ("gex_at_spot negative", df[df['gex_at_spot_M'] < 0]),
    ("neg_gamma_pct >= 40%", df[df['neg_gamma_pct'] >= 40]),
]

print(f"\n  {'Filter':<50} {'n':<5} {'W':<5} {'S':<5} {'WR%':<8} {'NET_s12':<10} {'Avg':<8} {'NET_s15':<10} {'NET_s20':<10}")
print("  " + "-" * 110)
for label, sub in filters:
    if isinstance(sub, pd.Series):
        sub = df[sub]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net12 = sub['pnl_s12'].sum()
    net15 = sub['pnl_s15'].sum()
    net20 = sub['pnl_s20'].sum()
    avg = net12 / len(sub)
    print(f"  {label:<50} {len(sub):<5} {w:<5} {s:<5} {wr:<8.0f} {net12:<+10.1f} {avg:<+8.1f} {net15:<+10.1f} {net20:<+10.1f}")

# ============================================================
# SECTION 10: COMBINED OPTIMAL FILTERS
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 10: PROPOSED TRADING RULES — COMBINED FILTERS")
print("=" * 100)

# Rule 1: Close king + first30 aligned
rule1 = df[(df['king_abs_dist'] <= 30) & (df['first30_dir_matches_king'] == 1)]
# Rule 2: Negative king + close
rule2 = df[(df['king_is_negative'] == 1) & (df['king_abs_dist'] <= 50)]
# Rule 3: Strong negative king close + first30 aligned
rule3 = df[(df['king_is_negative'] == 1) & (df['king_abs_dist'] <= 30) & (df['first30_dir_matches_king'] == 1)]
# Rule 4: King target close OR (negative king with first30 aligned)
rule4_mask = ((df['king_abs_dist'] <= 20)) | ((df['king_is_negative'] == 1) & (df['first30_dir_matches_king'] == 1))
rule4 = df[rule4_mask]
# Rule 5: Skip far kings (> 70pt) entirely
rule5 = df[df['king_abs_dist'] <= 70]

rules = [
    ("RULE 1: dist<=30 + first30 aligned", rule1),
    ("RULE 2: neg king + dist<=50", rule2),
    ("RULE 3: neg king + dist<=30 + first30 aligned", rule3),
    ("RULE 4: dist<=20 OR (neg king + first30 aligned)", rule4),
    ("RULE 5: dist<=70 (skip far kings)", rule5),
]

for label, sub in rules:
    print(f"\n  {label}")
    if len(sub) == 0:
        print("    No trades")
        continue
    for sl in [12, 15, 20]:
        rcol = f'result_s{sl}'
        pcol = f'pnl_s{sl}'
        w = len(sub[sub[rcol] == 'TARGET_HIT'])
        s = len(sub[sub[rcol] == 'STOP_HIT'])
        t = len(sub[sub[rcol] == 'TRAIL_BE'])
        e = len(sub[sub[rcol] == 'EOD_EXIT'])
        wr = w / len(sub) * 100
        net = sub[pcol].sum()
        avg = net / len(sub)
        print(f"    stop={sl}: n={len(sub)} W={w} S={s} T={t} E={e} | WR={wr:.0f}% | NET={net:+.1f} avg={avg:+.1f}")

# ============================================================
# SECTION 11: MFE/MAE Distribution
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 11: MFE/MAE DISTRIBUTION (12pt stop)")
print("=" * 100)

print("\n  --- ALL TRADES ---")
mfe_buckets = [(0, 5, '0-5'), (5, 10, '5-10'), (10, 15, '10-15'), (15, 25, '15-25'), (25, 50, '25-50'), (50, 200, '50+')]
print(f"  {'MFE bucket':<12} {'n':<5} {'mean_pnl':<10} {'mean_mae':<10}")
for lo, hi, label in mfe_buckets:
    sub = df[(df['mfe_s12'] >= lo) & (df['mfe_s12'] < hi)]
    if len(sub) == 0:
        continue
    avg_pnl = sub['pnl_s12'].mean()
    avg_mae = sub['mae_s12'].mean()
    print(f"  MFE {label:>6}: n={len(sub):>3} | avg_pnl={avg_pnl:>+7.1f} | avg_mae={avg_mae:>+7.1f}")

print(f"\n  {'MAE bucket':<12} {'n':<5} {'mean_pnl':<10} {'mean_mfe':<10}")
mae_buckets = [(0, -5, '0 to -5'), (-5, -10, '-5 to -10'), (-10, -15, '-10 to -15'), (-15, -30, '-15 to -30'), (-30, -100, '-30+')]
for hi, lo, label in mae_buckets:
    sub = df[(df['mae_s12'] <= hi) & (df['mae_s12'] > lo)]
    if len(sub) == 0:
        continue
    avg_pnl = sub['pnl_s12'].mean()
    avg_mfe = sub['mfe_s12'].mean()
    print(f"  MAE {label:>10}: n={len(sub):>3} | avg_pnl={avg_pnl:>+7.1f} | avg_mfe={avg_mfe:>+7.1f}")

# ============================================================
# SECTION 12: GEX at Spot Analysis
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 12: GEX AT SPOT ANALYSIS")
print("=" * 100)

gex_spot_buckets = [(-1000, -0.5, 'strong neg (<-0.5M)'), (-0.5, -0.01, 'weak neg'), (-0.01, 0.01, 'near zero'), (0.01, 0.5, 'weak pos'), (0.5, 1000, 'strong pos (>0.5M)')]
for lo, hi, label in gex_spot_buckets:
    sub = df[(df['gex_at_spot_M'] >= lo) & (df['gex_at_spot_M'] < hi)]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    print(f"  {label:>25}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f}")

# ============================================================
# SECTION 13: Wall Count Analysis
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 13: WALL STRUCTURE (blocking walls in path)")
print("=" * 100)

# For bullish entries, blocking walls = walls above spot (between spot and king)
# For bearish entries, blocking walls = walls below spot
df['blocking_walls'] = df.apply(
    lambda r: r['wall_count_above'] if r['entry_dir'] == 'BULLISH' else r['wall_count_below'],
    axis=1
)

for bw in sorted(df['blocking_walls'].unique()):
    sub = df[df['blocking_walls'] == bw]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    wr = w / len(sub) * 100
    net = sub['pnl_s12'].sum()
    print(f"  blocking_walls={bw}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f}")

# ============================================================
# SECTION 14: Cross-Tabulation Heatmaps
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 14: KING SIGN x DISTANCE x FIRST30 — NET P&L HEATMAP")
print("=" * 100)

for neg in [0, 1]:
    label = 'NEGATIVE KING' if neg == 1 else 'POSITIVE KING'
    print(f"\n  --- {label} ---")
    dist_header = 'dist \\ f30'
    print(f"  {dist_header:<15} {'OPPOSED':<20} {'ALIGNED':<20}")
    for lo, hi, dlabel in [(0, 20, '0-20'), (20, 50, '20-50'), (50, 80, '50-80'), (80, 200, '80+')]:
        row_parts = [f"  {dlabel:<15}"]
        for f30 in [0, 1]:
            sub = df[(df['king_is_negative'] == neg) & (df['king_abs_dist'] >= lo) & (df['king_abs_dist'] < hi) & (df['first30_dir_matches_king'] == f30)]
            if len(sub) == 0:
                row_parts.append(f"{'---':>20}")
            else:
                w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
                net = sub['pnl_s12'].sum()
                row_parts.append(f"n={len(sub)} W={w} net={net:+.0f}".rjust(20))
        print("".join(row_parts))

# ============================================================
# SECTION 15: DIRECTION + REGIME CROSS
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 15: ENTRY DIRECTION x REGIME")
print("=" * 100)

for d in ['BULLISH', 'BEARISH']:
    for reg in ['POSITIVE', 'NEGATIVE']:
        sub = df[(df['entry_dir'] == d) & (df['regime'] == reg)]
        if len(sub) == 0:
            continue
        w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
        s = len(sub[sub['result_s12'] == 'STOP_HIT'])
        wr = w / len(sub) * 100
        net = sub['pnl_s12'].sum()
        print(f"  {d} + {reg}: n={len(sub):>3} | W={w:>2} S={s:>2} | WR={wr:>4.0f}% | NET={net:>+7.1f}")

# ============================================================
# SECTION 16: PROPOSED SIMPLE TRADING SYSTEM
# ============================================================
print("\n\n" + "=" * 100)
print("SECTION 16: PROPOSED SIMPLE TRADING SYSTEM")
print("=" * 100)

# Test final system: enter ONLY when these criteria pass
# We'll test systematically
candidate_rules = []

# Generate all reasonable combinations
for max_dist in [30, 50, 70]:
    for neg_only in [True, False]:
        for require_f30 in [True, False]:
            for min_pct in [0, 5, 10]:
                for sl in [12, 15, 20]:
                    mask = (df['king_abs_dist'] <= max_dist)
                    if neg_only:
                        mask = mask & (df['king_is_negative'] == 1)
                    if require_f30:
                        mask = mask & (df['first30_dir_matches_king'] == 1)
                    if min_pct > 0:
                        mask = mask & (df['king_pct_of_total'] >= min_pct)

                    sub = df[mask]
                    if len(sub) < 10:  # need minimum trades
                        continue

                    rcol = f'result_s{sl}'
                    pcol = f'pnl_s{sl}'
                    w = len(sub[sub[rcol] == 'TARGET_HIT'])
                    s = len(sub[sub[rcol] == 'STOP_HIT'])
                    wr = w / len(sub) * 100
                    net = sub[pcol].sum()
                    avg = net / len(sub)

                    candidate_rules.append({
                        'max_dist': max_dist,
                        'neg_only': neg_only,
                        'require_f30': require_f30,
                        'min_pct': min_pct,
                        'stop': sl,
                        'n': len(sub),
                        'wins': w,
                        'stops': s,
                        'wr': wr,
                        'net': net,
                        'avg': avg,
                    })

# Sort by net P&L
candidate_rules.sort(key=lambda x: x['net'], reverse=True)

print("\n  TOP 20 RULE COMBINATIONS (by net P&L):")
print(f"  {'#':<4} {'max_dist':<10} {'neg_only':<10} {'f30':<6} {'min_pct':<10} {'stop':<6} {'n':<5} {'W':<5} {'S':<5} {'WR%':<8} {'NET':<10} {'Avg':<8}")
print("  " + "-" * 85)
for i, r in enumerate(candidate_rules[:20]):
    print(f"  {i+1:<4} {r['max_dist']:<10} {str(r['neg_only']):<10} {str(r['require_f30']):<6} {r['min_pct']:<10} {r['stop']:<6} {r['n']:<5} {r['wins']:<5} {r['stops']:<5} {r['wr']:<8.0f} {r['net']:<+10.1f} {r['avg']:<+8.2f}")

print("\n  TOP 10 BY AVERAGE P&L PER TRADE (min 15 trades):")
candidate_avg = [r for r in candidate_rules if r['n'] >= 15]
candidate_avg.sort(key=lambda x: x['avg'], reverse=True)
print(f"  {'#':<4} {'max_dist':<10} {'neg_only':<10} {'f30':<6} {'min_pct':<10} {'stop':<6} {'n':<5} {'W':<5} {'S':<5} {'WR%':<8} {'NET':<10} {'Avg':<8}")
print("  " + "-" * 85)
for i, r in enumerate(candidate_avg[:10]):
    print(f"  {i+1:<4} {r['max_dist']:<10} {str(r['neg_only']):<10} {str(r['require_f30']):<6} {r['min_pct']:<10} {r['stop']:<6} {r['n']:<5} {r['wins']:<5} {r['stops']:<5} {r['wr']:<8.0f} {r['net']:<+10.1f} {r['avg']:<+8.2f}")

# ============================================================
# FINAL SUMMARY
# ============================================================
print("\n\n" + "=" * 100)
print("FINAL SUMMARY: KEY FINDINGS")
print("=" * 100)

# Best overall rule
best = candidate_rules[0]
print(f"\n  Best NET rule: dist<={best['max_dist']}, neg_only={best['neg_only']}, f30={best['require_f30']}, min_pct={best['min_pct']}, stop={best['stop']}")
print(f"    -> {best['n']} trades, {best['wins']}W/{best['stops']}S, {best['wr']:.0f}% WR, NET={best['net']:+.1f}pts")

best_avg = candidate_avg[0]
print(f"\n  Best AVG rule: dist<={best_avg['max_dist']}, neg_only={best_avg['neg_only']}, f30={best_avg['require_f30']}, min_pct={best_avg['min_pct']}, stop={best_avg['stop']}")
print(f"    -> {best_avg['n']} trades, {best_avg['wins']}W/{best_avg['stops']}S, {best_avg['wr']:.0f}% WR, NET={best_avg['net']:+.1f}pts, AVG={best_avg['avg']:+.2f}/trade")

print("\n" + "=" * 100)
print("END OF ANALYSIS")
print("=" * 100)
