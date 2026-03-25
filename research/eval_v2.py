"""
Evaluation Framework v2 — Three-Layer Metrics

Layer A: Thesis accuracy — was the structural direction correct for the day?
Layer B: Regime alignment — was the regime call aligned with the chart structure?
Layer C: Trade payoff — did the next N minutes actually produce monetizable movement?

Also adds ENTRY vs HOLD distinction:
- CALLS_ENTRY: fresh directional signal, no prior thesis in that direction
- CALLS_HOLD: continuation of existing bullish thesis/migration
- Same for PUTS_ENTRY / PUTS_HOLD
"""

import pandas as pd
import numpy as np

def load_and_merge():
    features = pd.read_csv('research/features.csv')
    labeled = pd.read_csv('research/labeled.csv')
    v6 = pd.read_csv('research/regime_v6.csv')

    df = features.merge(v6, on=['date', 'frame'], how='left', suffixes=('', '_v6'))
    df = df.merge(labeled[['date', 'frame', 'move_15m', 'move_30m', 'move_60m',
                            'mfe_60m', 'mae_60m', 'calls_pnl', 'puts_pnl', 'straddle_pnl',
                            'best_trade', 'hit_upper_first', 'hit_lower_first']],
                  on=['date', 'frame'], how='left')
    return df


def classify_entry_vs_hold(df):
    """Add ENTRY vs HOLD classification based on thesis state."""

    results = []
    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)

        prev_thesis = None
        prev_regime = None
        thesis_entry_frame = None

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            regime = row.get('v3_regime', 'NO_TRADE')
            thesis = row.get('thesis_dir', None)

            # Classify
            if regime == 'CALLS':
                if prev_thesis != 'BULLISH' or prev_regime not in ('CALLS', 'STRADDLE'):
                    signal_type = 'CALLS_ENTRY'
                    thesis_entry_frame = row['frame']
                else:
                    signal_type = 'CALLS_HOLD'
            elif regime == 'PUTS':
                if prev_thesis != 'BEARISH' or prev_regime not in ('PUTS', 'STRADDLE'):
                    signal_type = 'PUTS_ENTRY'
                    thesis_entry_frame = row['frame']
                else:
                    signal_type = 'PUTS_HOLD'
            elif regime == 'STRADDLE':
                signal_type = 'STRADDLE'
            else:
                signal_type = 'NO_TRADE'

            results.append({
                'date': date,
                'frame': row['frame'],
                'signal_type': signal_type,
                'thesis_entry_frame': thesis_entry_frame,
            })

            prev_thesis = thesis
            prev_regime = regime

    return pd.DataFrame(results)


def compute_thesis_accuracy(df):
    """Layer A: Was the structural thesis correct for the day's direction?"""

    print('=' * 70)
    print('LAYER A: THESIS ACCURACY')
    print('Was the structural direction correct for the day?')
    print('=' * 70)

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame')
        entry = day_df[(day_df['minute_of_day'] >= 600) & (day_df['minute_of_day'] <= 900)]

        day_move = day_df.iloc[-1]['day_move']
        actual_dir = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'

        # What thesis did the engine hold for the majority of the day?
        thesis_counts = entry['thesis_dir'].value_counts()
        dominant_thesis = thesis_counts.index[0] if len(thesis_counts) > 0 else 'NONE'
        thesis_pct = thesis_counts.iloc[0] / len(entry) * 100 if len(entry) > 0 else 0

        # Was dominant thesis correct?
        thesis_correct = dominant_thesis == actual_dir

        # When did the correct thesis first appear?
        correct_frames = entry[entry['thesis_dir'] == actual_dir]
        first_correct = correct_frames.iloc[0]['minute_of_day'] if len(correct_frames) > 0 else None
        first_correct_str = f"{int(first_correct)//60}:{int(first_correct)%60:02d}" if first_correct else 'never'

        status = 'CORRECT' if thesis_correct else 'WRONG'
        print(f'  {date} | SPX {day_move:+.0f} | actual={actual_dir:>7} | thesis={dominant_thesis:>7} ({thesis_pct:.0f}%) | {status} | first correct at {first_correct_str}')


def compute_regime_alignment(df):
    """Layer B: Was the regime call aligned with the actual chart structure?"""

    print('\n' + '=' * 70)
    print('LAYER B: REGIME ALIGNMENT')
    print('Was the regime aligned with the structural direction?')
    print('=' * 70)

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame')
        entry = day_df[(day_df['minute_of_day'] >= 600) & (day_df['minute_of_day'] <= 900)]
        entry = entry.dropna(subset=['move_30m'])

        day_move = day_df.iloc[-1]['day_move']
        actual_dir = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'

        # Count aligned vs misaligned regimes
        aligned = 0
        misaligned = 0
        neutral = 0

        for _, row in entry.iterrows():
            regime = row.get('v3_regime', 'NO_TRADE')
            sig = row.get('signal_type', 'NO_TRADE')

            if regime == 'NO_TRADE' or regime == 'STRADDLE':
                neutral += 1
            elif actual_dir == 'BULLISH' and regime == 'CALLS':
                aligned += 1
            elif actual_dir == 'BEARISH' and regime == 'PUTS':
                aligned += 1
            elif actual_dir == 'BULLISH' and regime == 'PUTS':
                misaligned += 1
            elif actual_dir == 'BEARISH' and regime == 'CALLS':
                misaligned += 1
            elif actual_dir == 'FLAT':
                if regime in ('CALLS', 'PUTS'):
                    misaligned += 1
                else:
                    neutral += 1

        total = aligned + misaligned + neutral
        alignment_pct = aligned / total * 100 if total > 0 else 0
        misalign_pct = misaligned / total * 100 if total > 0 else 0

        # Entry vs Hold breakdown
        entries = entry[entry['signal_type'].isin(['CALLS_ENTRY', 'PUTS_ENTRY'])]
        holds = entry[entry['signal_type'].isin(['CALLS_HOLD', 'PUTS_HOLD'])]

        entry_aligned = 0
        for _, row in entries.iterrows():
            if actual_dir == 'BULLISH' and row['signal_type'] == 'CALLS_ENTRY':
                entry_aligned += 1
            elif actual_dir == 'BEARISH' and row['signal_type'] == 'PUTS_ENTRY':
                entry_aligned += 1

        print(f'  {date} | SPX {day_move:+.0f} | aligned={aligned}({alignment_pct:.0f}%) misaligned={misaligned}({misalign_pct:.0f}%) neutral={neutral} | entries={len(entries)} (aligned={entry_aligned}) holds={len(holds)}')


def compute_trade_payoff(df):
    """Layer C: Did the signals actually produce monetizable movement?"""

    print('\n' + '=' * 70)
    print('LAYER C: TRADE PAYOFF')
    print('Did the signal produce monetizable movement?')
    print('=' * 70)

    # Only look at ENTRY signals (not HOLD)
    entries = df[(df['signal_type'].isin(['CALLS_ENTRY', 'PUTS_ENTRY', 'STRADDLE'])) &
                 (df['minute_of_day'] >= 600) & (df['minute_of_day'] <= 900)]
    entries = entries.dropna(subset=['move_30m'])

    print(f'\n  Total entry signals: {len(entries)}')

    for sig_type in ['CALLS_ENTRY', 'PUTS_ENTRY', 'STRADDLE']:
        sig = entries[entries['signal_type'] == sig_type]
        if len(sig) == 0:
            continue

        if sig_type == 'CALLS_ENTRY':
            pnl_col = 'calls_pnl'
            move_correct = sig['move_30m'] > 5
        elif sig_type == 'PUTS_ENTRY':
            pnl_col = 'puts_pnl'
            move_correct = sig['move_30m'] < -5
        else:
            pnl_col = 'straddle_pnl'
            move_correct = sig['move_30m'].abs() > 8

        avg_pnl = sig[pnl_col].mean()
        win_rate = (sig[pnl_col] > 0).mean()
        avg_move = sig['move_30m'].mean()
        correct_pct = move_correct.mean()

        print(f'\n  {sig_type}: {len(sig)} signals')
        print(f'    30m direction correct: {correct_pct:.0%}')
        print(f'    Win rate (simulated): {win_rate:.0%}')
        print(f'    Avg PnL: {avg_pnl:+.1f}')
        print(f'    Avg 30m move: {avg_move:+.1f}')

    # HOLD signals — different evaluation
    holds = df[(df['signal_type'].isin(['CALLS_HOLD', 'PUTS_HOLD'])) &
               (df['minute_of_day'] >= 600) & (df['minute_of_day'] <= 900)]
    holds = holds.dropna(subset=['move_30m'])

    if len(holds) > 0:
        print(f'\n  HOLD signals: {len(holds)}')
        for hold_type in ['CALLS_HOLD', 'PUTS_HOLD']:
            h = holds[holds['signal_type'] == hold_type]
            if len(h) == 0:
                continue
            if hold_type == 'CALLS_HOLD':
                aligned = (h['move_30m'] > -5).mean()  # not losing > 5 = "hold was fine"
            else:
                aligned = (h['move_30m'] < 5).mean()
            print(f'    {hold_type}: {len(h)} frames | hold justified: {aligned:.0%} (30m didn\'t go 5+ pts against)')


def compute_summary(df):
    """Overall summary across all days."""

    print('\n' + '=' * 70)
    print('SUMMARY — ALL DAYS')
    print('=' * 70)

    entry_df = df[(df['minute_of_day'] >= 600) & (df['minute_of_day'] <= 900)]
    entry_df = entry_df.dropna(subset=['move_30m'])

    # Signal type distribution
    print('\nSignal distribution:')
    print(entry_df['signal_type'].value_counts().to_string())

    # Old metric (for comparison)
    old_correct = 0
    old_total = 0
    for _, row in entry_df.iterrows():
        regime = row.get('v3_regime', 'NO_TRADE')
        m30 = row['move_30m']
        if regime == 'CALLS' and m30 > 5: old_correct += 1
        elif regime == 'PUTS' and m30 < -5: old_correct += 1
        elif regime == 'STRADDLE' and abs(m30) > 8: old_correct += 1
        if regime in ('CALLS', 'PUTS', 'STRADDLE'): old_total += 1

    print(f'\nOld metric (30m move threshold): {old_correct}/{old_total} ({old_correct/old_total:.0%})' if old_total > 0 else '')

    # New: thesis alignment
    thesis_days = 0
    thesis_correct = 0
    for date, day_df in entry_df.groupby('date'):
        day_move = day_df.iloc[-1]['day_move']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        dominant = day_df['thesis_dir'].value_counts().index[0] if len(day_df) > 0 else 'NONE'
        thesis_days += 1
        if dominant == actual:
            thesis_correct += 1

    print(f'Thesis accuracy: {thesis_correct}/{thesis_days} days correct ({thesis_correct/thesis_days:.0%})')

    # New: regime alignment (not counting NO_TRADE/STRADDLE as wrong)
    aligned = 0
    misaligned = 0
    for _, row in entry_df.iterrows():
        regime = row.get('v3_regime', 'NO_TRADE')
        day_move = row['day_move']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        if regime == 'CALLS' and actual == 'BULLISH': aligned += 1
        elif regime == 'PUTS' and actual == 'BEARISH': aligned += 1
        elif regime == 'CALLS' and actual == 'BEARISH': misaligned += 1
        elif regime == 'PUTS' and actual == 'BULLISH': misaligned += 1

    total_directional = aligned + misaligned
    print(f'Regime alignment (directional only): {aligned}/{total_directional} ({aligned/total_directional:.0%})' if total_directional > 0 else '')

    # New: entry signal payoff
    entries_only = entry_df[entry_df['signal_type'].isin(['CALLS_ENTRY', 'PUTS_ENTRY'])]
    if len(entries_only) > 0:
        entry_right = 0
        for _, row in entries_only.iterrows():
            if row['signal_type'] == 'CALLS_ENTRY' and row['move_30m'] > 5: entry_right += 1
            elif row['signal_type'] == 'PUTS_ENTRY' and row['move_30m'] < -5: entry_right += 1
        print(f'Entry payoff (ENTRY signals only): {entry_right}/{len(entries_only)} ({entry_right/len(entries_only):.0%})')


if __name__ == '__main__':
    print('Loading data...')
    df = load_and_merge()
    print(f'{len(df)} rows')

    print('Classifying ENTRY vs HOLD...')
    signals = classify_entry_vs_hold(df)
    df = df.merge(signals, on=['date', 'frame'], how='left')

    # Per-day analysis
    compute_thesis_accuracy(df)
    compute_regime_alignment(df)
    compute_trade_payoff(df)
    compute_summary(df)
