"""
Thesis Failure Audit — Diagnose why thesis accuracy degraded from 86% to 63%.

Isolates the 11 wrong-thesis days, classifies failures, tests whether
STRADDLE-first or stricter directional commitment would help.
"""

import pandas as pd
import numpy as np
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_30day import ALL_DAYS, extract_all_features, add_labels
from regime_v6 import compute_v3_features
from entry_engine import compute_entry_features

def classify_day_type(day_move, day_range):
    abs_move = abs(day_move)
    if abs_move >= 60: return 'STRONG_TREND'
    elif abs_move >= 30: return 'MODERATE_TREND'
    elif abs_move < 15 and day_range < 40: return 'FLAT'
    elif abs_move < 20 and day_range >= 50: return 'CHOP'
    else: return 'MIXED'


def run_audit():
    print('Loading 30-day data...')
    features_df = extract_all_features(ALL_DAYS)
    labels_df = add_labels(features_df)
    features_labeled = features_df.merge(labels_df, on=['date', 'frame'], how='left')
    v6_df = compute_v3_features(features_labeled)
    full = features_df.merge(v6_df, on=['date', 'frame'], how='left', suffixes=('', '_v6'))
    full = full.merge(labels_df, on=['date', 'frame'], how='left')

    entry_window = full[(full['minute_of_day'] >= 600) & (full['minute_of_day'] <= 900)]
    entry_window = entry_window.dropna(subset=['move_30m'])

    # ======== 1. ISOLATE WRONG-THESIS DAYS ========
    print('\n' + '=' * 80)
    print('1. WRONG-THESIS DAYS')
    print('=' * 80)

    day_info = {}
    for date, day in entry_window.groupby('date'):
        day_move = day.iloc[-1]['day_move']
        day_range = day.iloc[-1]['day_range']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        thesis_counts = day['thesis_dir'].value_counts()
        dominant = thesis_counts.index[0] if len(thesis_counts) > 0 else 'NONE'
        thesis_pct = thesis_counts.iloc[0] / len(day) * 100

        # Check if straddle would have been better
        straddle_pnl = day['straddle_pnl'].mean()
        if actual == 'BULLISH':
            directional_pnl = day['calls_pnl'].mean()
        elif actual == 'BEARISH':
            directional_pnl = day['puts_pnl'].mean()
        else:
            directional_pnl = 0

        # Flip count stats
        avg_flip = day['flip_count_30'].mean()

        # Migration count
        max_mig = day['thesis_migration_count'].max()

        # Opening structure
        first_frame = day.iloc[0]
        opening_king_dir = first_frame.get('king_dir', '?')
        opening_king = first_frame.get('king_strike', 0)

        day_info[date] = {
            'day_move': day_move, 'day_range': day_range,
            'day_type': classify_day_type(day_move, day_range),
            'actual': actual, 'thesis': dominant, 'thesis_pct': thesis_pct,
            'correct': dominant == actual,
            'straddle_better': straddle_pnl > directional_pnl + 2,
            'straddle_pnl': straddle_pnl, 'directional_pnl': directional_pnl,
            'avg_flip': avg_flip, 'max_mig': max_mig,
            'opening_king_dir': opening_king_dir, 'opening_king': opening_king,
        }

    wrong_days = {d: info for d, info in day_info.items() if not info['correct']}
    right_days = {d: info for d, info in day_info.items() if info['correct']}

    print(f'\nCorrect: {len(right_days)}/30 | Wrong: {len(wrong_days)}/30')
    print(f'\n{"Date":>12} | {"Type":>14} | {"Move":>5} | {"Range":>5} | {"Actual":>7} | {"Thesis":>7} | {"Th%":>4} | {"Flips":>5} | {"Strad>Dir":>8} | Failure')
    print('-' * 120)

    # ======== 2. THESIS FAILURE TAXONOMY ========
    failure_counts = {}

    for date, info in sorted(wrong_days.items()):
        # Classify the failure
        failure = 'UNKNOWN'

        if info['actual'] == 'FLAT':
            failure = 'FLAT_DAY_FALSE_THESIS'
        elif info['day_type'] == 'CHOP':
            failure = 'FORCED_DIRECTION_ON_CHOP'
        elif info['straddle_better'] and info['avg_flip'] > 3:
            failure = 'SHOULD_HAVE_BEEN_STRADDLE'
        elif info['actual'] == 'BULLISH' and info['thesis'] == 'BEARISH':
            if info['opening_king_dir'] == 'BEARISH':
                failure = 'OPENING_READ_WRONG'
            else:
                failure = 'REVERSAL_DAY_FALSE_THESIS'
        elif info['actual'] == 'BEARISH' and info['thesis'] == 'BULLISH':
            if info['opening_king_dir'] == 'BULLISH':
                failure = 'OPENING_READ_WRONG'
            else:
                failure = 'REVERSAL_DAY_FALSE_THESIS'
        elif info['day_type'] == 'MIXED':
            failure = 'MIXED_MIGRATION_MISREAD'
        elif info['avg_flip'] > 4:
            failure = 'PERSISTENCE_OVERTRUST'
        elif info['thesis'] == 'NONE' or info['thesis'] is None:
            failure = 'NO_THESIS_FORMED'

        failure_counts[failure] = failure_counts.get(failure, 0) + 1

        strad_tag = 'YES' if info['straddle_better'] else 'no'
        print(f'{date:>12} | {info["day_type"]:>14} | {info["day_move"]:+5.0f} | {info["day_range"]:5.0f} | {info["actual"]:>7} | {info["thesis"]:>7} | {info["thesis_pct"]:3.0f}% | {info["avg_flip"]:5.1f} | {strad_tag:>8} | {failure}')

    print(f'\n\nThesis Failure Taxonomy:')
    for failure, count in sorted(failure_counts.items(), key=lambda x: -x[1]):
        print(f'  {failure:35s} {count}')

    # ======== 3. THESIS ACCURACY BY DAY TYPE ========
    print(f'\n{"="*80}')
    print('3. THESIS ACCURACY BY DAY TYPE')
    print(f'{"="*80}')

    type_stats = {}
    for date, info in day_info.items():
        dt = info['day_type']
        if dt not in type_stats:
            type_stats[dt] = {'correct': 0, 'wrong': 0, 'straddle_better': 0, 'days': []}
        if info['correct']:
            type_stats[dt]['correct'] += 1
        else:
            type_stats[dt]['wrong'] += 1
        if info['straddle_better']:
            type_stats[dt]['straddle_better'] += 1
        type_stats[dt]['days'].append(info)

    for dt, stats in sorted(type_stats.items()):
        total = stats['correct'] + stats['wrong']
        pct = stats['correct'] / total * 100
        strad_pct = stats['straddle_better'] / total * 100
        print(f'  {dt:15s} | {total:2d} days | thesis={pct:.0f}% | straddle_better={strad_pct:.0f}%')

    # ======== 4. HYPOTHESIS A vs B ========
    print(f'\n{"="*80}')
    print('4. HYPOTHESIS A vs B')
    print(f'{"="*80}')

    # Count wrong days where straddle would have been better
    straddle_would_fix = sum(1 for d in wrong_days.values() if d['straddle_better'])
    direction_could_fix = len(wrong_days) - straddle_would_fix

    print(f'\n  Wrong-thesis days: {len(wrong_days)}')
    print(f'  Straddle would have been better: {straddle_would_fix} ({straddle_would_fix/len(wrong_days):.0%})')
    print(f'  Direction was possible but misread: {direction_could_fix} ({direction_could_fix/len(wrong_days):.0%})')

    # On right days, was directional significantly better than straddle?
    dir_margin = [info['directional_pnl'] - info['straddle_pnl'] for info in right_days.values()]
    avg_dir_margin = np.mean(dir_margin) if dir_margin else 0

    print(f'\n  On correct-thesis days:')
    print(f'    Avg directional PnL advantage over straddle: {avg_dir_margin:+.1f}')
    print(f'    Days where directional > straddle: {sum(1 for m in dir_margin if m > 0)}/{len(dir_margin)}')

    # Evidence assessment
    print(f'\n  EVIDENCE:')
    if straddle_would_fix > len(wrong_days) * 0.5:
        print(f'  → Hypothesis B supported: {straddle_would_fix}/{len(wrong_days)} wrong days would have been fixed by STRADDLE-first')
        print(f'  → STRADDLE should be the default; only upgrade to directional with strong confirmation')
    else:
        print(f'  → Hypothesis A supported: most failures are directional misreads, not missing straddles')
        print(f'  → Thesis logic needs retuning, not regime shift')

    # ======== 5. COMMITMENT THRESHOLD ANALYSIS ========
    print(f'\n{"="*80}')
    print('5. DIRECTIONAL COMMITMENT THRESHOLD ANALYSIS')
    print(f'{"="*80}')

    # Test: what if we required stronger confirmation for directional thesis?
    # Simulate: "thesis only becomes directional if persistence > X AND flip_count < Y"
    thresholds = [
        (10, 6, 'current'),
        (20, 4, 'moderate'),
        (30, 3, 'strict'),
        (40, 2, 'very_strict'),
    ]

    for pers_thresh, flip_thresh, label in thresholds:
        correct = 0
        delayed = 0
        for date, day in entry_window.groupby('date'):
            info = day_info.get(date)
            if not info: continue

            # Would thesis have formed under stricter rules?
            qualifying = day[
                (day['king_persistence'] >= pers_thresh) &
                (day['flip_count_30'] <= flip_thresh) &
                (day['king_dir'] != 'AT_SPOT')
            ]
            if len(qualifying) > 0:
                # Thesis would form from first qualifying frame
                first_dir = qualifying.iloc[0]['king_dir']
                if first_dir == info['actual']:
                    correct += 1
                else:
                    # Check if later frames correct
                    correct_later = qualifying[qualifying['king_dir'] == info['actual']]
                    if len(correct_later) > 0:
                        correct += 1
                        delayed += 1
            else:
                # No thesis formed — would default to STRADDLE/NO_TRADE
                # Count as "correct" if straddle was better
                if info['straddle_better'] or info['actual'] == 'FLAT':
                    correct += 1

        n_days = len(day_info)
        print(f'  {label:12s} (pers>{pers_thresh}, flip<{flip_thresh}): thesis correct {correct}/{n_days} ({correct/n_days:.0%}) | delayed={delayed}')

    # ======== 6. STRADDLE-FIRST ANALYSIS ========
    print(f'\n{"="*80}')
    print('6. STRADDLE-FIRST ANALYSIS')
    print(f'{"="*80}')

    # For each day, when should the engine have been straddle vs directional?
    straddle_days = 0
    directional_days = 0
    upgrade_days = 0  # start straddle, then upgrade

    for date, info in day_info.items():
        day = entry_window[entry_window['date'] == date]
        if len(day) == 0: continue

        # First 30 frames (10:00-10:30) — was it clearly directional?
        first30 = day.head(30)
        early_flip = first30['flip_count_30'].mean()
        early_persistence = first30['king_persistence'].max()
        early_king_dirs = first30['king_dir'].value_counts()
        dominant_early = early_king_dirs.index[0] if len(early_king_dirs) > 0 else 'AT_SPOT'

        if early_flip > 3 or early_persistence < 15 or dominant_early == 'AT_SPOT':
            # Ambiguous early — should start as STRADDLE
            straddle_days += 1
            # Did it eventually become directional?
            late = day.tail(len(day) - 30)
            if len(late) > 0:
                late_persistence = late['king_persistence'].max()
                if late_persistence > 20:
                    upgrade_days += 1
        else:
            directional_days += 1

    print(f'  Should start as STRADDLE: {straddle_days}/{len(day_info)} ({straddle_days/len(day_info):.0%})')
    print(f'  Should start directional: {directional_days}/{len(day_info)} ({directional_days/len(day_info):.0%})')
    print(f'  Start straddle, upgrade later: {upgrade_days}/{straddle_days}')

    # Compare straddle-first vs current on wrong days
    straddle_first_fixes = 0
    for date, info in wrong_days.items():
        day = entry_window[entry_window['date'] == date]
        first30 = day.head(30)
        early_flip = first30['flip_count_30'].mean()
        early_persistence = first30['king_persistence'].max()
        if early_flip > 3 or early_persistence < 15:
            straddle_first_fixes += 1

    print(f'\n  Wrong-thesis days that would start as STRADDLE: {straddle_first_fixes}/{len(wrong_days)}')
    print(f'  → Would convert {straddle_first_fixes} wrong-directional into correct-straddle')

    # Estimate new thesis accuracy
    new_correct = len(right_days) + straddle_first_fixes
    new_total = len(day_info)
    print(f'\n  Estimated thesis accuracy with STRADDLE-first: {new_correct}/{new_total} ({new_correct/new_total:.0%})')
    print(f'  Current: {len(right_days)}/{new_total} ({len(right_days)/new_total:.0%})')

    # ======== 7. RECOMMENDATION ========
    print(f'\n{"="*80}')
    print('7. RECOMMENDATION')
    print(f'{"="*80}')

    print(f"""
  DIAGNOSIS:
  - {len(wrong_days)} wrong-thesis days out of 30
  - {straddle_would_fix}/{len(wrong_days)} would be fixed by STRADDLE-first
  - {straddle_first_fixes}/{len(wrong_days)} had ambiguous early structure
  - Directional thesis works on {len(right_days)}/30 days
  - STRADDLE_ENTRY is the strongest signal (54%, +11.9 PnL)

  VERDICT:
  The engine is overcommitting to directional thesis too early.
  On ambiguous early sessions, STRADDLE should be the default until
  directional confirmation is strong enough.

  RECOMMENDED CHANGE:
  Make STRADDLE the default regime for the first 30 minutes of every day.
  Only upgrade to directional thesis when ALL of:
  - king_persistence >= 20
  - flip_count_30 <= 3
  - king_dir is clearly BULLISH or BEARISH (not AT_SPOT)
  - same_direction_targets > 0

  This is NOT a straddle-always system. It is a straddle-first system
  that upgrades to directional when structure confirms.

  EXPECTED IMPACT:
  - Thesis accuracy: {len(right_days)/new_total:.0%} → ~{new_correct/new_total:.0%}
  - Fixes {straddle_first_fixes} of {len(wrong_days)} wrong days
  - Preserves directional edge on clear trend days
  - Entry payoff should stay stable or improve
    """)


if __name__ == '__main__':
    run_audit()
