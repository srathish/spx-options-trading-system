"""
Labeling System — What SHOULD have happened at each frame?

For each frame, looks forward to create labels:
1. Does price hit upper node or lower node first?
2. Next 15-min / 30-min move
3. Trend continuation or rejection
4. Best trade expression: CALLS, PUTS, STRADDLE, or NO_TRADE

No lookahead in features — only in labels (that's the point of labels).
"""

import pandas as pd
import numpy as np

def add_labels(df):
    """Add forward-looking labels to the feature dataset."""

    labels = []

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)
        spots = day_df['spot'].values
        frames = day_df['frame'].values

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']
            frame = row['frame']

            # ---- Forward price moves ----
            move_15 = spots[idx + 15] - spot if idx + 15 < len(spots) else np.nan
            move_30 = spots[idx + 30] - spot if idx + 30 < len(spots) else np.nan
            move_60 = spots[idx + 60] - spot if idx + 60 < len(spots) else np.nan

            # MFE/MAE in next 60 frames
            future = spots[idx+1:min(idx+61, len(spots))]
            mfe_60 = max(future - spot) if len(future) > 0 else 0
            mae_60 = min(future - spot) if len(future) > 0 else 0

            # ---- Does price hit upper or lower node first? ----
            upper_strike = row['above_strike']
            lower_strike = row['below_strike']
            hit_upper_first = 0
            hit_lower_first = 0
            frames_to_upper = np.nan
            frames_to_lower = np.nan

            if upper_strike > 0 and lower_strike < 0:
                # Won't work — lower_strike should be a price
                pass

            if upper_strike > 0:
                for j in range(idx + 1, min(idx + 120, len(spots))):
                    if spots[j] >= upper_strike - 5:
                        frames_to_upper = j - idx
                        break

            if lower_strike > 0:  # strike is always positive (it's a price)
                for j in range(idx + 1, min(idx + 120, len(spots))):
                    if spots[j] <= lower_strike + 5:
                        frames_to_lower = j - idx
                        break

            if not np.isnan(frames_to_upper) and not np.isnan(frames_to_lower):
                hit_upper_first = 1 if frames_to_upper < frames_to_lower else 0
                hit_lower_first = 1 if frames_to_lower < frames_to_upper else 0
            elif not np.isnan(frames_to_upper):
                hit_upper_first = 1
            elif not np.isnan(frames_to_lower):
                hit_lower_first = 1

            # ---- Trend continuation or rejection ----
            # If day_move and next 30m move are same sign → continuation
            day_move = row['day_move']
            continuation = 0
            rejection = 0
            if not np.isnan(move_30):
                if (day_move > 5 and move_30 > 5) or (day_move < -5 and move_30 < -5):
                    continuation = 1
                elif (day_move > 10 and move_30 < -5) or (day_move < -10 and move_30 > 5):
                    rejection = 1

            # ---- Best trade expression ----
            # CALLS: if next 30m > +10
            # PUTS: if next 30m < -10
            # STRADDLE: if abs(next 30m) > 15 but direction uncertain (MFE and MAE both > 10)
            # NO_TRADE: abs(next 30m) < 8
            best_trade = 'NO_TRADE'
            if not np.isnan(move_30):
                abs_move = abs(move_30)
                if abs_move < 8:
                    best_trade = 'NO_TRADE'
                elif mfe_60 >= 15 and mae_60 <= -15:
                    # Big move both ways — straddle territory
                    best_trade = 'STRADDLE'
                elif move_30 >= 10:
                    best_trade = 'CALLS'
                elif move_30 <= -10:
                    best_trade = 'PUTS'
                else:
                    best_trade = 'NO_TRADE'

            # ---- Profitable direction (simulated) ----
            # If we bought calls here with -12 stop, would we profit?
            calls_pnl = 0
            puts_pnl = 0
            if len(future) > 0:
                # Calls: +1 per pt up, stop at -12
                for j, f in enumerate(future):
                    p = f - spot
                    if p >= 15:
                        calls_pnl = 15; break
                    if p <= -12:
                        calls_pnl = -12; break
                else:
                    calls_pnl = future[-1] - spot if len(future) > 0 else 0

                # Puts: +1 per pt down, stop at -12
                for j, f in enumerate(future):
                    p = spot - f
                    if p >= 15:
                        puts_pnl = 15; break
                    if p <= -12:
                        puts_pnl = -12; break
                else:
                    puts_pnl = spot - future[-1] if len(future) > 0 else 0

            labels.append({
                'date': date,
                'frame': frame,
                'move_15m': move_15,
                'move_30m': move_30,
                'move_60m': move_60,
                'mfe_60m': mfe_60,
                'mae_60m': mae_60,
                'hit_upper_first': hit_upper_first,
                'hit_lower_first': hit_lower_first,
                'frames_to_upper': frames_to_upper,
                'frames_to_lower': frames_to_lower,
                'continuation': continuation,
                'rejection': rejection,
                'best_trade': best_trade,
                'calls_pnl': round(calls_pnl, 2),
                'puts_pnl': round(puts_pnl, 2),
                'straddle_pnl': round(max(calls_pnl, puts_pnl), 2),
            })

    labels_df = pd.DataFrame(labels)
    merged = df.merge(labels_df, on=['date', 'frame'], how='left')
    return merged


if __name__ == '__main__':
    print('Loading features...')
    df = pd.read_csv('research/features.csv')
    print(f'Features: {len(df)} rows')

    print('Adding labels...')
    labeled = add_labels(df)

    labeled.to_csv('research/labeled.csv', index=False)
    print(f'Saved {len(labeled)} rows to research/labeled.csv')

    # Quick stats
    print('\nLabel distribution:')
    print(labeled['best_trade'].value_counts())
    print(f'\nAvg calls_pnl: {labeled["calls_pnl"].mean():.2f}')
    print(f'Avg puts_pnl: {labeled["puts_pnl"].mean():.2f}')
    print(f'Avg straddle_pnl: {labeled["straddle_pnl"].mean():.2f}')
    print(f'\nHit upper first: {labeled["hit_upper_first"].mean():.1%}')
    print(f'Hit lower first: {labeled["hit_lower_first"].mean():.1%}')
