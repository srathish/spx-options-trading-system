"""
Failure Tagging — Classify why signals failed.

Replaces the simple "UNKNOWN_CALLS_FAIL" with specific failure reasons
from the taxonomy in feature_spec.md.
"""

import pandas as pd
import numpy as np
from collections import deque

def tag_failures(df):
    """Tag every failed signal with a specific failure reason."""

    failure_tags = []

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)
        spots = day_df['spot'].values

        # Pre-compute rolling dominance for the day
        dominance_history = deque(maxlen=60)
        king_history = deque(maxlen=60)

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']
            regime = row.get('regime', 'NO_TRADE')
            move_30 = row.get('move_30m', np.nan)

            # Track dominance and king history
            dom = row.get('node_dominance', 0)
            dominance_history.append(dom)
            king_history.append(row.get('king_strike', 0))

            # Flip count in last 30 frames
            flip_count_30 = 0
            if len(king_history) >= 2:
                for i in range(1, len(king_history)):
                    if king_history[i] != king_history[i - 1]:
                        flip_count_30 += 1

            # Dominance rate of change
            dom_roc = 0
            if len(dominance_history) >= 15:
                dom_roc = dominance_history[-1] - dominance_history[-15]

            # Determine if this frame had a failed signal
            is_failed = False
            if np.isnan(move_30):
                failure_tags.append({'date': date, 'frame': row['frame'], 'failure_reason': ''})
                continue

            if regime == 'CALLS' and move_30 < -5:
                is_failed = True
            elif regime == 'PUTS' and move_30 > 5:
                is_failed = True
            elif regime == 'STRADDLE' and abs(move_30) < 5:
                is_failed = True

            if not is_failed:
                failure_tags.append({'date': date, 'frame': row['frame'], 'failure_reason': ''})
                continue

            # ---- TAG THE FAILURE ----
            reason = 'UNCLASSIFIED'
            minute = row.get('minute_of_day', 0)

            # 1. LUNCH_CHOP: signal during dead zone
            if 720 <= minute <= 780:
                reason = 'LUNCH_CHOP'

            # 2. KING_FLIPPED_FAST: king changed within last 10 frames
            elif flip_count_30 >= 8:
                reason = 'KING_FLIPPED_FAST'

            # 3. BOTH_SIDES_ACTIVE: both nodes growing, directional was wrong
            elif (row.get('above_pct_15m', 0) > 0.15 and row.get('above_abs', 0) >= 5_000_000 and
                  row.get('below_pct_15m', 0) > 0.15 and row.get('below_abs', 0) >= 5_000_000):
                reason = 'BOTH_SIDES_ACTIVE'

            # 4. NODE_GREW_NO_ACCEPTANCE: node growing but price going wrong way
            elif regime == 'CALLS' and row.get('mom_15m', 0) < -3:
                reason = 'NODE_GREW_NO_ACCEPTANCE'
            elif regime == 'PUTS' and row.get('mom_15m', 0) > 3:
                reason = 'NODE_GREW_NO_ACCEPTANCE'

            # 5. LARGER_TREND_OVERRIDE: day move overwhelmed local signal
            elif regime == 'CALLS' and row.get('day_move', 0) < -30:
                reason = 'LARGER_TREND_OVERRIDE'
            elif regime == 'PUTS' and row.get('day_move', 0) > 30:
                reason = 'LARGER_TREND_OVERRIDE'

            # 6. PRICE_STRETCHED_VWAP: too far from VWAP
            elif regime == 'CALLS' and row.get('price_vs_vwap', 0) < -15:
                reason = 'PRICE_STRETCHED_VWAP'
            elif regime == 'PUTS' and row.get('price_vs_vwap', 0) > 15:
                reason = 'PRICE_STRETCHED_VWAP'

            # 7. PERSISTENCE_COLLAPSED: king was stable then changed
            elif row.get('king_persistence', 0) < 5 and idx >= 10:
                prev_persistence = day_df.iloc[max(0, idx-10)].get('king_persistence', 0)
                if prev_persistence > 20:
                    reason = 'PERSISTENCE_COLLAPSED'
                else:
                    reason = 'LOW_PERSISTENCE'

            # 8. VOL_EXPANSION_NO_DIRECTION: big MFE and MAE
            elif (row.get('mfe_60m', 0) > 10 and row.get('mae_60m', 0) < -10):
                reason = 'VOL_EXPANSION_NO_DIRECTION'

            # 9. NODE_GREW_TOO_LATE: day move already happened
            elif abs(row.get('day_move', 0)) > 40:
                if regime == 'CALLS' and row.get('day_move', 0) > 40:
                    reason = 'NODE_GREW_TOO_LATE'
                elif regime == 'PUTS' and row.get('day_move', 0) < -40:
                    reason = 'NODE_GREW_TOO_LATE'
                elif regime == 'CALLS' and row.get('day_move', 0) < -40:
                    reason = 'LARGER_TREND_OVERRIDE'
                elif regime == 'PUTS' and row.get('day_move', 0) > 40:
                    reason = 'LARGER_TREND_OVERRIDE'

            # 10. Dominance shifting against signal
            elif regime == 'CALLS' and dom_roc < -15:
                reason = 'DOMINANCE_SHIFTING_AGAINST'
            elif regime == 'PUTS' and dom_roc > 15:
                reason = 'DOMINANCE_SHIFTING_AGAINST'

            failure_tags.append({'date': date, 'frame': row['frame'], 'failure_reason': reason})

    tags_df = pd.DataFrame(failure_tags)
    return tags_df


if __name__ == '__main__':
    print('Loading regime-scored data...')
    df = pd.read_csv('research/regime_scored.csv')
    print(f'{len(df)} rows')

    print('Tagging failures...')
    tags = tag_failures(df)

    # Merge back
    df = df.drop(columns=['failure_tag'], errors='ignore')
    df = df.merge(tags, on=['date', 'frame'], how='left')

    # Stats
    failures = df[df['failure_reason'] != '']
    print(f'\nTotal failures tagged: {len(failures)}')
    print(f'\nFailure distribution:')
    print(failures['failure_reason'].value_counts().to_string())

    # How many are no longer UNCLASSIFIED?
    classified = failures[failures['failure_reason'] != 'UNCLASSIFIED']
    print(f'\nClassified: {len(classified)}/{len(failures)} ({len(classified)/len(failures):.0%})')
    print(f'Unclassified: {len(failures) - len(classified)}')

    # Per-day breakdown
    print(f'\nPer-day failure breakdown:')
    for date, day_f in failures.groupby('date'):
        counts = day_f['failure_reason'].value_counts()
        top = counts.head(3)
        print(f'  {date}: {len(day_f)} failures — {", ".join(f"{r}({c})" for r, c in top.items())}')

    df.to_csv('research/regime_tagged.csv', index=False)
    print(f'\nSaved to research/regime_tagged.csv')
