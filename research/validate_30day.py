"""
30-Day Validation — Frozen v6 + Entry Engine + 50pt Extension Gate

One controlled change: block fresh directional entries after abs(day_move) >= 50.
Everything else frozen.
"""

import pandas as pd
import numpy as np
import json
import os
import sys

# Import the feature extractor and engines
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# We'll import the computation functions directly
from extract_features import compute_features, parse_frame, RESEARCH_DAYS
from regime_v6 import compute_v3_features
from entry_engine import compute_entry_features

# ---- Select 30 days (not just the 7 research days) ----
ALL_DAYS = sorted([
    f'data/gex-replay-{d}.json' for d in [
        # Original 7 research days
        '2026-02-06', '2026-03-20', '2026-02-23', '2026-01-14',
        '2026-02-11', '2026-03-12', '2026-02-05',
        # 23 additional days for validation
        '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-09',
        '2026-01-20', '2026-01-21', '2026-01-23', '2026-01-27',
        '2026-01-30', '2026-02-02', '2026-02-03', '2026-02-04',
        '2026-02-09', '2026-02-10', '2026-02-12', '2026-02-13',
        '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
        '2026-02-24', '2026-02-25', '2026-02-26',
    ]
])

def extract_all_features(days):
    """Run feature extraction on all days."""
    all_rows = []
    for filepath in days:
        if not os.path.exists(filepath):
            continue
        data = json.load(open(filepath))
        date_str = data.get('metadata', {}).get('date', '')
        is_trinity = data.get('metadata', {}).get('mode') == 'trinity'
        rows = compute_features(date_str, data['frames'], is_trinity)
        all_rows.extend(rows)
    return pd.DataFrame(all_rows)


def add_labels(df):
    """Add forward-looking labels."""
    labels = []
    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)
        spots = day_df['spot'].values

        for idx in range(len(day_df)):
            spot = spots[idx]
            frame = day_df.iloc[idx]['frame']

            move_15 = spots[idx + 15] - spot if idx + 15 < len(spots) else np.nan
            move_30 = spots[idx + 30] - spot if idx + 30 < len(spots) else np.nan
            move_60 = spots[idx + 60] - spot if idx + 60 < len(spots) else np.nan

            future = spots[idx+1:min(idx+61, len(spots))]
            mfe_60 = max(future - spot) if len(future) > 0 else 0
            mae_60 = min(future - spot) if len(future) > 0 else 0

            # Simulated PnL
            calls_pnl = puts_pnl = 0
            if len(future) > 0:
                for f in future:
                    p = f - spot
                    if p >= 15: calls_pnl = 15; break
                    if p <= -12: calls_pnl = -12; break
                else:
                    calls_pnl = future[-1] - spot
                for f in future:
                    p = spot - f
                    if p >= 15: puts_pnl = 15; break
                    if p <= -12: puts_pnl = -12; break
                else:
                    puts_pnl = spot - future[-1]

            labels.append({
                'date': date, 'frame': frame,
                'move_15m': move_15, 'move_30m': move_30, 'move_60m': move_60,
                'mfe_60m': mfe_60, 'mae_60m': mae_60,
                'calls_pnl': round(calls_pnl, 2), 'puts_pnl': round(puts_pnl, 2),
                'straddle_pnl': round(max(calls_pnl, puts_pnl), 2),
            })

    return pd.DataFrame(labels)


def apply_50pt_gate(entry_df, features_df):
    """Apply the 50pt extension gate to directional entries."""
    merged = entry_df.merge(features_df[['date', 'frame', 'day_move']], on=['date', 'frame'], how='left')

    blocked = 0
    for idx in merged.index:
        action = merged.at[idx, 'action']
        day_move = abs(merged.at[idx, 'day_move'])
        if action in ('CALLS_ENTRY', 'PUTS_ENTRY') and day_move >= 50:
            merged.at[idx, 'action'] = 'CALLS_HOLD' if action == 'CALLS_ENTRY' else 'PUTS_HOLD'
            blocked += 1

    merged = merged.drop(columns=['day_move'])
    return merged, blocked


def classify_day_type(day_move, day_range):
    """Classify a day by its character."""
    abs_move = abs(day_move)
    if abs_move >= 60:
        return 'STRONG_TREND'
    elif abs_move >= 30:
        return 'MODERATE_TREND'
    elif abs_move < 15 and day_range < 40:
        return 'FLAT'
    elif abs_move < 20 and day_range >= 50:
        return 'CHOP'
    else:
        return 'MIXED'


def evaluate_30day(df, entry_df, labels_df):
    """Full 30-day evaluation."""

    # Ensure labels are merged
    if 'move_30m' not in df.columns:
        df = df.merge(labels_df, on=['date', 'frame'], how='left', suffixes=('', '_lbl'))
    if 'action' not in df.columns:
        df = df.merge(entry_df[['date', 'frame', 'action', 'entry_score', 'entry_failure',
                                 'dist_to_target', 'toward_target', 'price_accel',
                                 'growth_accelerating', 'target_too_close', 'already_extended',
                                 'vwap_reclaim', 'vwap_reject', 'breakout_up', 'breakout_down',
                                 'touch_state', 'migration_phase']],
                      on=['date', 'frame'], how='left', suffixes=('', '_e2'))

    merged = df
    entry_window = merged[(merged['minute_of_day'] >= 600) & (merged['minute_of_day'] <= 900)]
    entry_window = entry_window.dropna(subset=['move_30m'])

    n_days = entry_window['date'].nunique()

    # ======== A. STRUCTURAL METRICS ========
    print('=' * 70)
    print(f'A. STRUCTURAL METRICS ({n_days} days)')
    print('=' * 70)

    # Thesis accuracy
    thesis_correct = 0
    day_types = {}
    for date, day in entry_window.groupby('date'):
        day_move = day.iloc[-1]['day_move']
        day_range = day.iloc[-1]['day_range']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        dominant = day['thesis_dir'].value_counts().index[0] if len(day) > 0 else 'NONE'
        if dominant == actual:
            thesis_correct += 1
        day_types[date] = {
            'move': day_move, 'range': day_range, 'actual': actual,
            'thesis': dominant, 'correct': dominant == actual,
            'type': classify_day_type(day_move, day_range),
        }

    print(f'  Thesis accuracy: {thesis_correct}/{n_days} ({thesis_correct/n_days:.0%})')

    # Regime alignment
    aligned = misaligned = 0
    for _, row in entry_window.iterrows():
        act = row.get('action', 'NO_TRADE')
        actual = 'BULLISH' if row['day_move'] > 10 else 'BEARISH' if row['day_move'] < -10 else 'FLAT'
        if act.startswith('CALLS') and actual == 'BULLISH': aligned += 1
        elif act.startswith('PUTS') and actual == 'BEARISH': aligned += 1
        elif act.startswith('CALLS') and actual == 'BEARISH': misaligned += 1
        elif act.startswith('PUTS') and actual == 'BULLISH': misaligned += 1
    total_dir = aligned + misaligned
    print(f'  Regime alignment: {aligned}/{total_dir} ({aligned/total_dir:.0%})' if total_dir > 0 else '')

    # Hold justified
    for hold in ['CALLS_HOLD', 'PUTS_HOLD']:
        h = entry_window[entry_window['action'] == hold]
        if len(h) == 0: continue
        just = (h['move_30m'] > -5).mean() if hold == 'CALLS_HOLD' else (h['move_30m'] < 5).mean()
        print(f'  {hold} justified: {just:.0%} ({len(h)} frames)')

    # ======== B. ENTRY METRICS ========
    print(f'\n{"="*70}')
    print(f'B. ENTRY METRICS')
    print(f'{"="*70}')

    print('\n  Signal distribution:')
    print(entry_window['action'].value_counts().to_string())

    for action in ['CALLS_ENTRY', 'PUTS_ENTRY', 'STRADDLE_ENTRY']:
        entries = entry_window[entry_window['action'] == action]
        if len(entries) == 0:
            print(f'\n  {action}: 0 signals')
            continue
        if action == 'CALLS_ENTRY':
            correct = (entries['move_30m'] > 5).mean()
            avg_pnl = entries['calls_pnl'].mean()
        elif action == 'PUTS_ENTRY':
            correct = (entries['move_30m'] < -5).mean()
            avg_pnl = entries['puts_pnl'].mean()
        else:
            correct = (entries['move_30m'].abs() > 8).mean()
            avg_pnl = entries['straddle_pnl'].mean()
        print(f'\n  {action}: {len(entries)} signals | 30m correct: {correct:.0%} | avg PnL: {avg_pnl:+.1f}')

    # ======== C. FAILURE TAXONOMY ========
    print(f'\n{"="*70}')
    print(f'C. ENTRY FAILURE TAXONOMY')
    print(f'{"="*70}')

    failures = entry_window[entry_window['entry_failure'] != '']
    if len(failures) > 0:
        print(f'  Total failures: {len(failures)}')
        print(failures['entry_failure'].value_counts().to_string())
    else:
        print('  No failures tagged')

    # ======== D. BY DAY TYPE ========
    print(f'\n{"="*70}')
    print(f'D. RESULTS BY DAY TYPE')
    print(f'{"="*70}')

    type_stats = {}
    for date, info in day_types.items():
        dt = info['type']
        if dt not in type_stats:
            type_stats[dt] = {'days': 0, 'thesis_correct': 0, 'entries': 0, 'entry_right': 0}
        type_stats[dt]['days'] += 1
        if info['correct']:
            type_stats[dt]['thesis_correct'] += 1

        day_entries = entry_window[(entry_window['date'] == date) & (entry_window['action'].str.contains('ENTRY'))]
        type_stats[dt]['entries'] += len(day_entries)
        for _, row in day_entries.iterrows():
            if row['action'] == 'CALLS_ENTRY' and row['move_30m'] > 5: type_stats[dt]['entry_right'] += 1
            elif row['action'] == 'PUTS_ENTRY' and row['move_30m'] < -5: type_stats[dt]['entry_right'] += 1
            elif row['action'] == 'STRADDLE_ENTRY' and abs(row['move_30m']) > 8: type_stats[dt]['entry_right'] += 1

    for dt, stats in sorted(type_stats.items()):
        thesis_pct = stats['thesis_correct'] / stats['days'] * 100 if stats['days'] > 0 else 0
        entry_pct = stats['entry_right'] / stats['entries'] * 100 if stats['entries'] > 0 else 0
        print(f'  {dt:15s} | {stats["days"]:2d} days | thesis={thesis_pct:.0f}% | entries={stats["entries"]:3d} | entry_payoff={entry_pct:.0f}%')

    # ======== E. FEATURE SURVIVAL ========
    print(f'\n{"="*70}')
    print(f'E. FEATURE SURVIVAL (7-day → 30-day)')
    print(f'{"="*70}')

    # Check which features still separate good from bad entries
    entries_all = entry_window[entry_window['action'].str.contains('ENTRY')]
    if len(entries_all) > 0:
        entries_all = entries_all.copy()
        entries_all['entry_correct'] = 0
        for idx in entries_all.index:
            row = entries_all.loc[idx]
            if row['action'] == 'CALLS_ENTRY' and row['move_30m'] > 5: entries_all.at[idx, 'entry_correct'] = 1
            elif row['action'] == 'PUTS_ENTRY' and row['move_30m'] < -5: entries_all.at[idx, 'entry_correct'] = 1
            elif row['action'] == 'STRADDLE_ENTRY' and abs(row['move_30m']) > 8: entries_all.at[idx, 'entry_correct'] = 1

        feature_cols = ['entry_score', 'dist_to_target', 'toward_target', 'price_accel',
                       'growth_accelerating', 'target_too_close', 'already_extended',
                       'vwap_reclaim', 'vwap_reject', 'breakout_up', 'breakout_down']

        print(f'\n  Feature separation (correct vs incorrect entries):')
        for col in feature_cols:
            if col not in entries_all.columns:
                continue
            correct = entries_all[entries_all['entry_correct'] == 1][col].mean()
            incorrect = entries_all[entries_all['entry_correct'] == 0][col].mean()
            diff = correct - incorrect
            verdict = 'SURVIVES' if abs(diff) > 0.1 else 'WEAK' if abs(diff) > 0.03 else 'NOISE'
            print(f'    {col:25s} | correct={correct:+.2f} incorrect={incorrect:+.2f} | diff={diff:+.2f} | {verdict}')

    # ======== F. CALLS_ENTRY DIAGNOSTIC ========
    print(f'\n{"="*70}')
    print(f'F. CALLS_ENTRY DIAGNOSTIC')
    print(f'{"="*70}')

    bullish_days = [d for d, info in day_types.items() if info['actual'] == 'BULLISH']
    print(f'  Bullish days: {len(bullish_days)}')

    for date in bullish_days:
        day = entry_window[entry_window['date'] == date]
        n_calls_entry = len(day[day['action'] == 'CALLS_ENTRY'])
        n_calls_hold = len(day[day['action'] == 'CALLS_HOLD'])
        day_move = day.iloc[-1]['day_move'] if len(day) > 0 else 0
        print(f'    {date} | SPX {day_move:+.0f} | CALLS_ENTRY={n_calls_entry} CALLS_HOLD={n_calls_hold}')

    # ======== G. VWAP PULLBACK ANALYSIS ========
    print(f'\n{"="*70}')
    print(f'G. VWAP PULLBACK OPPORTUNITY (not implemented, just analysis)')
    print(f'{"="*70}')

    # On bullish thesis days, find frames where vwap_reclaim=1 and thesis=BULLISH
    bullish_reclaims = entry_window[
        (entry_window['thesis_dir'] == 'BULLISH') &
        (entry_window.get('vwap_reclaim', pd.Series(dtype=float)) == 1)
    ] if 'vwap_reclaim' in entry_window.columns else pd.DataFrame()

    if len(bullish_reclaims) > 0:
        avg_30m = bullish_reclaims['move_30m'].mean()
        pct_positive = (bullish_reclaims['move_30m'] > 5).mean()
        print(f'  Bullish thesis + VWAP reclaim: {len(bullish_reclaims)} frames')
        print(f'  Avg 30m move: {avg_30m:+.1f} | 30m > +5: {pct_positive:.0%}')
    else:
        print('  No VWAP reclaim data available in merged set')

    bearish_rejects = entry_window[
        (entry_window['thesis_dir'] == 'BEARISH') &
        (entry_window.get('vwap_reject', pd.Series(dtype=float)) == 1)
    ] if 'vwap_reject' in entry_window.columns else pd.DataFrame()

    if len(bearish_rejects) > 0:
        avg_30m = bearish_rejects['move_30m'].mean()
        pct_negative = (bearish_rejects['move_30m'] < -5).mean()
        print(f'  Bearish thesis + VWAP reject: {len(bearish_rejects)} frames')
        print(f'  Avg 30m move: {avg_30m:+.1f} | 30m < -5: {pct_negative:.0%}')

    # ======== SUMMARY ========
    print(f'\n{"="*70}')
    print(f'SUMMARY — 30-DAY VALIDATION')
    print(f'{"="*70}')
    print(f'  Days: {n_days}')
    print(f'  Thesis accuracy: {thesis_correct}/{n_days} ({thesis_correct/n_days:.0%})')
    alignment_pct = aligned / total_dir * 100 if total_dir > 0 else 0
    print(f'  Regime alignment: {aligned}/{total_dir} ({alignment_pct:.0f}%)')

    all_entries = entry_window[entry_window['action'].str.contains('ENTRY')]
    if len(all_entries) > 0:
        entry_right = 0
        for _, row in all_entries.iterrows():
            if row['action'] == 'CALLS_ENTRY' and row['move_30m'] > 5: entry_right += 1
            elif row['action'] == 'PUTS_ENTRY' and row['move_30m'] < -5: entry_right += 1
            elif row['action'] == 'STRADDLE_ENTRY' and abs(row['move_30m']) > 8: entry_right += 1
        print(f'  Entry payoff: {entry_right}/{len(all_entries)} ({entry_right/len(all_entries):.0%})')


if __name__ == '__main__':
    print('PHASE 1: Extracting features for 30 days...')
    features_df = extract_all_features(ALL_DAYS)
    print(f'  {len(features_df)} frames across {features_df["date"].nunique()} days')

    print('\nPHASE 2: Adding labels...')
    labels_df = add_labels(features_df)

    print('\nPHASE 3: Running structural engine (v6)...')
    # Merge features for v6
    features_labeled = features_df.merge(labels_df, on=['date', 'frame'], how='left')
    v6_df = compute_v3_features(features_labeled)
    features_with_v6 = features_df.merge(v6_df, on=['date', 'frame'], how='left', suffixes=('', '_v6'))
    features_with_v6 = features_with_v6.merge(labels_df, on=['date', 'frame'], how='left')

    print('\nPHASE 4: Running entry engine...')
    entry_df = compute_entry_features(features_with_v6)

    print('\nPHASE 5: Applying 50pt extension gate...')
    entry_gated, n_blocked = apply_50pt_gate(entry_df, features_df)
    print(f'  Blocked {n_blocked} directional entries (day_move >= 50)')

    # Final merge: combine all data
    final = features_with_v6.merge(entry_gated, on=['date', 'frame'], how='left', suffixes=('', '_ent'))

    print('\nPHASE 6: Evaluation...\n')
    evaluate_30day(final, entry_gated, labels_df)
