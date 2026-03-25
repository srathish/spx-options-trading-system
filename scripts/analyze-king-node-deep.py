#!/usr/bin/env python3
"""
Deep-dive analysis on the key finding: first30 alignment is the dominant predictor.
Stress-test it. Also look at the 2 losses in the best rule to understand failure modes.
"""
import pandas as pd

df = pd.read_csv('data/king-node-analysis.csv')

print("=" * 100)
print("DEEP DIVE: STRESS-TESTING THE FIRST30 ALIGNMENT SIGNAL")
print("=" * 100)

# ============================================================
# 1: Show all 27 trades in the best rule (dist<=50 + f30 aligned)
# ============================================================
print("\n--- ALL TRADES: dist<=50 + first30 aligned (s12) ---")
best = df[(df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 1)]
print(f"{'date':<12} {'dir':<8} {'king_str':<8} {'dist':<6} {'neg':<4} {'king_M':<8} {'pct':<6} {'f30':<6} {'result':<12} {'pnl':<8} {'mfe':<6} {'mae':<6} {'day_type':<12} {'spx_move':<8}")
print("-" * 110)
for _, r in best.iterrows():
    print(f"{r['date']:<12} {r['entry_dir']:<8} {int(r['king_strike']):<8} {r['king_dist']:>+5.0f} {int(r['king_is_negative']):<4} {r['king_value_M']:>+7.1f} {r['king_pct_of_total']:>5.1f} {r['first30_move']:>+5.0f} {r['result_s12']:<12} {r['pnl_s12']:>+7.1f} {r['mfe_s12']:>5.0f} {r['mae_s12']:>5.0f} {r['day_type']:<12} {r['spx_move']:>+7.0f}")
total = best['pnl_s12'].sum()
wins = len(best[best['result_s12'] == 'TARGET_HIT'])
stops = len(best[best['result_s12'] == 'STOP_HIT'])
print(f"\nTOTAL: {len(best)} trades, {wins}W/{stops}S, NET={total:+.1f}pts, AVG={total/len(best):+.1f}pts/trade")

# ============================================================
# 2: Show the MISSED trades (aligned + close king but filtered out)
# ============================================================
print("\n\n--- MISSED: first30 aligned + dist>50 ---")
missed = df[(df['king_abs_dist'] > 50) & (df['first30_dir_matches_king'] == 1)]
for _, r in missed.iterrows():
    print(f"  {r['date']} {r['entry_dir']:<8} king={int(r['king_strike'])} dist={r['king_dist']:+.0f} f30={r['first30_move']:+.0f} {r['result_s12']:<12} pnl={r['pnl_s12']:+.1f} mfe={r['mfe_s12']:.0f}")
print(f"  NET of missed: {missed['pnl_s12'].sum():+.1f}pts")

# ============================================================
# 3: Show the BLOCKED trades (dist<=50 but first30 OPPOSED)
# ============================================================
print("\n\n--- BLOCKED (correctly): dist<=50 + first30 OPPOSED ---")
blocked = df[(df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 0)]
for _, r in blocked.iterrows():
    print(f"  {r['date']} {r['entry_dir']:<8} king={int(r['king_strike'])} dist={r['king_dist']:+.0f} f30={r['first30_move']:+.0f} {r['result_s12']:<12} pnl={r['pnl_s12']:+.1f} mfe={r['mfe_s12']:.0f}")
print(f"  NET of blocked: {blocked['pnl_s12'].sum():+.1f}pts")

# ============================================================
# 4: Losses in the best rule — understand failure modes
# ============================================================
print("\n\n--- LOSS ANALYSIS: Which trades in best rule lost? ---")
losses = best[(best['pnl_s12'] <= 0)]
for _, r in losses.iterrows():
    print(f"  {r['date']} {r['entry_dir']:<8} king={int(r['king_strike'])} dist={r['king_dist']:+.0f} king_M={r['king_value_M']:+.1f} neg={int(r['king_is_negative'])} pct={r['king_pct_of_total']:.1f}%")
    print(f"    f30_move={r['first30_move']:+.0f} result={r['result_s12']} pnl={r['pnl_s12']:+.1f} mfe={r['mfe_s12']:.0f} mae={r['mae_s12']:.0f} day={r['day_type']} spx_move={r['spx_move']:+.0f}")

# ============================================================
# 5: Is first30 timing robust? What if we check first 20 min instead?
# ============================================================
print("\n\n--- ROBUSTNESS: How stable is the aligned signal across time windows? ---")
# We only have first30_move. But let's check if there's a relationship between
# first30 magnitude and win rate within aligned trades
aligned = df[df['first30_dir_matches_king'] == 1]
print("\n  Within ALIGNED trades, does first30 magnitude matter?")
f30_buckets = [(0, 3, '0-3'), (3, 8, '3-8'), (8, 15, '8-15'), (15, 100, '15+')]
for lo, hi, label in f30_buckets:
    sub = aligned[(aligned['first30_move'].abs() >= lo) & (aligned['first30_move'].abs() < hi)]
    if len(sub) < 2:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    net = sub['pnl_s12'].sum()
    wr = w / len(sub) * 100
    print(f"    |f30|={label:>5}: n={len(sub)} W={w} | WR={wr:.0f}% | NET={net:+.1f}")

# ============================================================
# 6: Monthly breakdown of best rule
# ============================================================
print("\n\n--- MONTHLY BREAKDOWN: dist<=50 + f30 aligned, s12 ---")
best_copy = best.copy()
best_copy['month'] = best_copy['date'].str[:7]
for month in sorted(best_copy['month'].unique()):
    sub = best_copy[best_copy['month'] == month]
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    net = sub['pnl_s12'].sum()
    print(f"  {month}: n={len(sub)} W={w} | NET={net:+.1f}")

# ============================================================
# 7: What about the 40 trades we skip? Are any profitable?
# ============================================================
print("\n\n--- SKIPPED TRADES: dist>50 OR first30 opposed ---")
skipped = df[~((df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 1))]
print(f"  Skipped: {len(skipped)} trades | NET={skipped['pnl_s12'].sum():+.1f}")
# Break down by category
skip_aligned_far = skipped[(skipped['first30_dir_matches_king'] == 1) & (skipped['king_abs_dist'] > 50)]
skip_opposed_close = skipped[(skipped['first30_dir_matches_king'] == 0) & (skipped['king_abs_dist'] <= 50)]
skip_opposed_far = skipped[(skipped['first30_dir_matches_king'] == 0) & (skipped['king_abs_dist'] > 50)]
print(f"  Aligned but far (dist>50): n={len(skip_aligned_far)} NET={skip_aligned_far['pnl_s12'].sum():+.1f}")
print(f"  Opposed but close (dist<=50): n={len(skip_opposed_close)} NET={skip_opposed_close['pnl_s12'].sum():+.1f}")
print(f"  Opposed and far: n={len(skip_opposed_far)} NET={skip_opposed_far['pnl_s12'].sum():+.1f}")

# ============================================================
# 8: Compare stop levels for the best filter
# ============================================================
print("\n\n--- STOP LEVEL COMPARISON for dist<=50 + f30 aligned ---")
for sl in [8, 12, 15, 18, 20, 25]:
    rcol = f'result_s{sl}'
    pcol = f'pnl_s{sl}'
    w = len(best[best[rcol] == 'TARGET_HIT'])
    s = len(best[best[rcol] == 'STOP_HIT'])
    t = len(best[best[rcol] == 'TRAIL_BE'])
    e = len(best[best[rcol] == 'EOD_EXIT'])
    net = best[pcol].sum()
    wr = w / len(best) * 100
    avg = net / len(best)
    print(f"  stop={sl:>2}: W={w} S={s} T={t} E={e} | WR={wr:.0f}% | NET={net:+.1f} avg={avg:+.1f}")

# ============================================================
# 9: What if we add a "minimum first30 move" filter?
# ============================================================
print("\n\n--- MINIMUM FIRST30 MOVE FILTER (dist<=50 + aligned) ---")
for min_f30 in [0, 3, 5, 8, 10, 15]:
    sub = df[(df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 1) & (df['first30_move'].abs() >= min_f30)]
    if len(sub) < 5:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    net = sub['pnl_s12'].sum()
    wr = w / len(sub) * 100
    print(f"  min_f30={min_f30:>2}: n={len(sub)} W={w} S={s} | WR={wr:.0f}% | NET={net:+.1f} avg={net/len(sub):+.1f}")

# ============================================================
# 10: Direction-specific analysis
# ============================================================
print("\n\n--- DIRECTION SPLIT within best rule ---")
for d in ['BULLISH', 'BEARISH']:
    sub = best[best['entry_dir'] == d]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    s = len(sub[sub['result_s12'] == 'STOP_HIT'])
    net = sub['pnl_s12'].sum()
    wr = w / len(sub) * 100
    print(f"  {d}: n={len(sub)} W={w} S={s} | WR={wr:.0f}% | NET={net:+.1f}")

# ============================================================
# 11: What if the king node direction disagrees with the SPX daily move?
# ============================================================
print("\n\n--- KING DIRECTION vs ACTUAL DAY DIRECTION (within best rule) ---")
best_copy = best.copy()
best_copy['day_agrees'] = best_copy.apply(
    lambda r: 1 if (r['entry_dir'] == 'BULLISH' and r['spx_move'] > 0) or (r['entry_dir'] == 'BEARISH' and r['spx_move'] < 0) else 0, axis=1)
for agrees in [1, 0]:
    label = 'KING CORRECT' if agrees == 1 else 'KING WRONG'
    sub = best_copy[best_copy['day_agrees'] == agrees]
    if len(sub) == 0:
        continue
    w = len(sub[sub['result_s12'] == 'TARGET_HIT'])
    net = sub['pnl_s12'].sum()
    wr = w / len(sub) * 100
    print(f"  {label}: n={len(sub)} W={w} | WR={wr:.0f}% | NET={net:+.1f}")

# ============================================================
# 12: FINAL PROPOSED SYSTEM
# ============================================================
print("\n\n" + "=" * 100)
print("FINAL PROPOSED SIMPLE TRADING SYSTEM")
print("=" * 100)

print("""
ENTRY RULES (ALL must be true):
  1. King node within 50 pts of spot
  2. First 30 minutes of trading confirms direction toward king
     (price moved toward king since entry time)
  3. Enter in direction of king node (BULLISH if king above, BEARISH if king below)

EXIT RULES:
  - Target: King node strike (within 5 pts)
  - Stop: -12 pts (fixed)
  - Trailing BE: if MFE >= 15 pts, move stop to breakeven

BACKTEST (67 days):
""")

best_final = df[(df['king_abs_dist'] <= 50) & (df['first30_dir_matches_king'] == 1)]
w = len(best_final[best_final['result_s12'] == 'TARGET_HIT'])
s = len(best_final[best_final['result_s12'] == 'STOP_HIT'])
t = len(best_final[best_final['result_s12'] == 'TRAIL_BE'])
e = len(best_final[best_final['result_s12'] == 'EOD_EXIT'])
net = best_final['pnl_s12'].sum()
print(f"  Trades: {len(best_final)} ({len(best_final)/67*100:.0f}% of days)")
print(f"  Results: {w}W / {s}S / {t}T / {e}E")
print(f"  Win Rate: {w/len(best_final)*100:.0f}%")
print(f"  Net P&L: {net:+.1f} pts")
print(f"  Avg P&L/trade: {net/len(best_final):+.1f} pts")
print(f"  Avg win: {best_final[best_final['result_s12']=='TARGET_HIT']['pnl_s12'].mean():+.1f} pts")
print(f"  Avg loss: {best_final[best_final['result_s12']=='STOP_HIT']['pnl_s12'].mean():+.1f} pts" if s > 0 else "  Avg loss: N/A")

# Profit factor
gross_wins = best_final[best_final['pnl_s12'] > 0]['pnl_s12'].sum()
gross_losses = abs(best_final[best_final['pnl_s12'] < 0]['pnl_s12'].sum())
pf = gross_wins / gross_losses if gross_losses > 0 else float('inf')
print(f"  Profit factor: {pf:.1f}")
print(f"  Gross wins: {gross_wins:+.1f} | Gross losses: {-gross_losses:+.1f}")

# Max consecutive losses
results = best_final['result_s12'].values
max_consec_loss = 0
current = 0
for r in results:
    if r == 'STOP_HIT':
        current += 1
        max_consec_loss = max(max_consec_loss, current)
    else:
        current = 0
print(f"  Max consecutive stops: {max_consec_loss}")

# Equity curve
print(f"\n  Equity curve (cumulative P&L):")
cumsum = 0
for _, r in best_final.iterrows():
    cumsum += r['pnl_s12']
    marker = 'W' if r['result_s12'] == 'TARGET_HIT' else ('S' if r['result_s12'] == 'STOP_HIT' else 'T')
    bar = '+' * max(0, int(cumsum / 5)) if cumsum >= 0 else '-' * max(0, int(-cumsum / 5))
    print(f"    {r['date']} [{marker}] {r['pnl_s12']:>+7.1f} -> cum={cumsum:>+7.1f} |{bar}")

print("\n\nADDITIONAL TIGHTENED RULE (for higher selectivity):")
tight = df[(df['king_abs_dist'] <= 30) & (df['first30_dir_matches_king'] == 1)]
w2 = len(tight[tight['result_s12'] == 'TARGET_HIT'])
s2 = len(tight[tight['result_s12'] == 'STOP_HIT'])
net2 = tight['pnl_s12'].sum()
print(f"  dist<=30 + f30 aligned: {len(tight)} trades, {w2}W/{s2}S, WR={w2/len(tight)*100:.0f}%, NET={net2:+.1f}")

print("\n" + "=" * 100)
