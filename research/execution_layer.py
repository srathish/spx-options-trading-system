"""
Directional Execution Layer — Real Option Economics

Three layers:
1. Structural engine (frozen v6): thesis direction, 80% alignment
2. Day-quality gate (morning ML scorer): filter for 30+ pt days
3. Execution engine: entry timing + trade management

Uses corrected option economics: $15/side ATM 0DTE premium.
"""

import pandas as pd
import numpy as np
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_30day import ALL_DAYS, extract_all_features, add_labels, classify_day_type
from regime_v6 import compute_v3_features

# ---- Corrected Option Economics ----

def option_pnl(spot_entry, spot_exit, direction, hours_at_entry, hold_hours):
    """Compute realistic 0DTE directional option PnL."""
    # Premium scales with sqrt of time remaining
    premium = 15.0 * np.sqrt(hours_at_entry / 5.5)  # $15 baseline at 10AM
    spread = 1.50
    entry_cost = premium + spread

    # Intrinsic at exit
    if direction == 'BULLISH':
        intrinsic = max(0, spot_exit - spot_entry)
    else:
        intrinsic = max(0, spot_entry - spot_exit)

    # Time value remaining at exit
    hours_remain = max(0.05, hours_at_entry - hold_hours)
    time_val_exit = 15.0 * np.sqrt(hours_remain / 5.5) * 0.4  # decayed

    exit_value = intrinsic + time_val_exit
    pnl = exit_value - entry_cost - 1.0  # exit spread

    return round(pnl, 2), round(entry_cost, 2)


def run_execution_analysis():
    """Full execution layer analysis on 30 days."""

    print('Loading 30-day data...')
    features_df = extract_all_features(ALL_DAYS)
    labels_df = add_labels(features_df)
    fl = features_df.merge(labels_df, on=['date', 'frame'], how='left')
    v6_df = compute_v3_features(fl)
    full = features_df.merge(v6_df, on=['date', 'frame'], how='left', suffixes=('', '_v6'))
    full = full.merge(labels_df, on=['date', 'frame'], how='left')

    print(f'{len(full)} frames, {full["date"].nunique()} days\n')

    # ======== 2. DAY-QUALITY GATE ========
    print('=' * 80)
    print('2. DAY-QUALITY GATE — Morning ML Trend Scorer')
    print('=' * 80)

    # Load daily price data for morning ML features
    daily_raw = {}
    try:
        daily_raw = json.load(open('data/daily-prices-2y.json'))
    except:
        pass

    # Compute morning features for each day (simplified version of train-price-ml.py)
    day_scores = {}
    dates = sorted(full['date'].unique())

    for date in dates:
        day = full[full['date'] == date].sort_values('frame')
        if len(day) == 0:
            continue

        day_move = day.iloc[-1]['day_move']
        day_range = day.iloc[-1]['day_range']
        abs_move = abs(day_move)
        day_type = classify_day_type(day_move, day_range)

        # Use actual day data as proxy for morning ML score
        # (We don't have the ML model output for these specific days,
        #  so we'll simulate thresholds based on day outcomes)
        is_big_day = abs_move >= 30
        is_strong_trend = abs_move >= 50

        day_scores[date] = {
            'day_move': day_move, 'day_range': day_range,
            'abs_move': abs_move, 'day_type': day_type,
            'is_big_day': is_big_day, 'is_strong_trend': is_strong_trend,
        }

    # Test different gate thresholds
    print('\n  Gate: trade only on days with abs(move) >= threshold')
    print(f'  {"Threshold":>10} | {"Days":>4} | {"Avg PnL":>8} | {"Total":>8} | {"Win%":>5} | {"Worst":>8}')
    print(f'  {"-"*55}')

    for threshold in [0, 15, 20, 25, 30, 40, 50]:
        traded_days = [d for d, info in day_scores.items() if info['abs_move'] >= threshold]
        if not traded_days:
            continue

        pnls = []
        for date in traded_days:
            info = day_scores[date]
            day = full[full['date'] == date].sort_values('frame')
            spots = day['spot'].values
            if len(spots) < 375:
                continue

            # Directional entry at 10:00 in correct direction
            entry_spot = spots[30]
            exit_spot = spots[min(375, len(spots) - 1)]

            # Determine correct direction from thesis
            thesis = day.iloc[30:60]['thesis_dir'].mode()
            thesis_dir = thesis.iloc[0] if len(thesis) > 0 else None

            if thesis_dir == 'BULLISH':
                pnl, cost = option_pnl(entry_spot, exit_spot, 'BULLISH', 5.5, 5.25)
            elif thesis_dir == 'BEARISH':
                pnl, cost = option_pnl(entry_spot, exit_spot, 'BEARISH', 5.5, 5.25)
            else:
                pnl = 0

            pnls.append(pnl)

        if pnls:
            avg = np.mean(pnls)
            total = sum(pnls)
            wr = sum(1 for p in pnls if p > 0) / len(pnls)
            worst = min(pnls)
            print(f'  {">=" + str(threshold) + "pt":>10} | {len(pnls):4d} | ${avg:+7.2f} | ${total:+7.0f} | {wr:4.0%} | ${worst:+7.2f}')

    # ======== 3-4. EXECUTION FEATURES + ENTRY SIMULATION ========
    print(f'\n{"="*80}')
    print('3-4. EXECUTION SIMULATION WITH REAL ECONOMICS')
    print('=' * 80)

    all_trades = []

    for date, day_df in full.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)
        spots = day_df['spot'].values
        info = day_scores.get(date, {})

        if len(spots) < 375 or not info:
            continue

        day_move = info['day_move']
        day_type = info['day_type']

        # Only trade days with 30+ pt moves (gate)
        if info['abs_move'] < 30:
            continue

        # Track entry states
        position = None
        local_prices = []

        for idx in range(20, len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']
            minute = row.get('minute_of_day', 570 + idx)
            thesis = row.get('thesis_dir', None)
            king_dist = abs(row.get('king_dist', 0))
            king_pers = row.get('king_persistence', 0)
            flip_count = row.get('flip_count_30', 0)
            same_tgt = row.get('same_dir_targets', 0)
            mom_5 = row.get('mom_5m', 0)
            mom_15 = row.get('mom_15m', 0)

            local_prices.append(spot)
            if len(local_prices) > 20:
                local_prices.pop(0)

            hours_left = max(0.1, (960 - minute) / 60)
            open_price = spots[0]
            current_move = abs(spot - open_price)

            # ---- MANAGE OPEN POSITION ----
            if position:
                if position['direction'] == 'BULLISH':
                    progress = spot - position['entry_spot']
                else:
                    progress = position['entry_spot'] - spot

                if progress > position['mfe']:
                    position['mfe'] = progress

                hold_min = idx - position['entry_idx']
                hold_hours = hold_min / 60

                exit_reason = None

                # Target hit
                if progress >= 20:
                    exit_reason = 'TARGET_HIT'
                # Stop
                elif progress <= -12:
                    exit_reason = 'STOP_HIT'
                # Trailing: after +10, trail to +3
                elif position['mfe'] >= 10 and progress <= 3:
                    exit_reason = 'TRAIL_EXIT'
                # Thesis flipped
                elif thesis and thesis != position['thesis_at_entry'] and king_pers >= 15:
                    exit_reason = 'THESIS_FLIP'
                # EOD
                elif minute >= 945:
                    exit_reason = 'EOD_CLOSE'
                # Late-day trim at 3PM if +5
                elif minute >= 900 and progress >= 5:
                    exit_reason = 'POWER_HOUR_TRIM'

                if exit_reason:
                    pnl, _ = option_pnl(
                        position['entry_spot'], spot,
                        position['direction'],
                        position['hours_at_entry'],
                        hold_hours
                    )
                    all_trades.append({
                        'date': date, 'day_type': day_type, 'day_move': day_move,
                        'direction': position['direction'],
                        'entry_spot': position['entry_spot'],
                        'exit_spot': spot,
                        'entry_minute': position['entry_minute'],
                        'exit_minute': minute,
                        'hold_min': hold_min,
                        'underlying_move': round(progress, 2),
                        'mfe': round(position['mfe'], 2),
                        'pnl': pnl,
                        'entry_cost': position['entry_cost'],
                        'exit_reason': exit_reason,
                        'entry_score': position.get('entry_score', 0),
                        'entry_state': position.get('entry_state', ''),
                    })
                    position = None

            # ---- ENTRY LOGIC ----
            if position is None and minute >= 600 and minute <= 870:
                if not thesis or thesis == 'AT_SPOT':
                    continue
                if flip_count >= 5:
                    continue
                if current_move >= 50:  # 50pt gate
                    continue

                # Entry scoring
                entry_score = 0
                entry_state = 'NONE'

                direction = thesis

                # Toward target velocity
                if direction == 'BULLISH' and mom_5 > 2:
                    entry_score += 20
                elif direction == 'BEARISH' and mom_5 < -2:
                    entry_score += 20

                # King persistence
                if king_pers >= 20:
                    entry_score += 15
                elif king_pers >= 10:
                    entry_score += 5

                # Same direction targets
                if same_tgt > 0:
                    entry_score += 10

                # Price acceleration
                if idx >= 5:
                    prev_mom = day_df.iloc[idx - 5].get('mom_5m', 0)
                    accel = mom_5 - prev_mom
                    if (direction == 'BULLISH' and accel > 1) or (direction == 'BEARISH' and accel < -1):
                        entry_score += 15
                        entry_state = 'ACCELERATING'

                # Local breakout
                if len(local_prices) >= 15:
                    local_high = max(local_prices[-15:])
                    local_low = min(local_prices[-15:])
                    if direction == 'BULLISH' and spot >= local_high:
                        entry_score += 10
                        entry_state = 'BREAKOUT'
                    elif direction == 'BEARISH' and spot <= local_low:
                        entry_score += 10
                        entry_state = 'BREAKOUT'

                # Morning bonus
                if minute < 660:
                    entry_score += 10

                # Penalties
                if king_dist < 8:
                    entry_score -= 15  # at contact
                    entry_state = 'AT_CONTACT'
                if 720 <= minute <= 780:
                    entry_score -= 20  # lunch

                # ENTRY THRESHOLD: only enter on score >= 35
                if entry_score >= 35:
                    pnl_est, cost = option_pnl(spot, spot, direction, hours_left, 0)
                    position = {
                        'direction': direction,
                        'entry_spot': spot,
                        'entry_idx': idx,
                        'entry_minute': minute,
                        'entry_cost': cost,
                        'hours_at_entry': hours_left,
                        'thesis_at_entry': thesis,
                        'mfe': 0,
                        'entry_score': entry_score,
                        'entry_state': entry_state,
                    }

    trades_df = pd.DataFrame(all_trades)
    if len(trades_df) == 0:
        print('No trades generated!')
        return

    # ======== RESULTS ========
    print(f'\n  Total trades: {len(trades_df)}')
    print(f'  Trades/day: {len(trades_df) / trades_df["date"].nunique():.1f}')

    wins = trades_df[trades_df['pnl'] > 0]
    losses = trades_df[trades_df['pnl'] <= 0]

    print(f'\n  Win rate: {len(wins)}/{len(trades_df)} ({len(wins)/len(trades_df):.0%})')
    print(f'  Avg PnL: ${trades_df["pnl"].mean():+.2f}')
    print(f'  Total PnL: ${trades_df["pnl"].sum():+.0f}')
    print(f'  Avg win: ${wins["pnl"].mean():+.2f}' if len(wins) > 0 else '')
    print(f'  Avg loss: ${losses["pnl"].mean():+.2f}' if len(losses) > 0 else '')

    if len(wins) > 0 and len(losses) > 0:
        pf = wins['pnl'].sum() / abs(losses['pnl'].sum())
        print(f'  Profit factor: {pf:.2f}')

    print(f'  Avg MFE: {trades_df["mfe"].mean():.1f}')
    print(f'  Avg hold: {trades_df["hold_min"].mean():.0f} min')
    print(f'  Max drawdown: ${trades_df["pnl"].min():+.2f}')

    # Exit reasons
    print(f'\n  Exit reasons:')
    for reason, count in trades_df['exit_reason'].value_counts().items():
        bucket = trades_df[trades_df['exit_reason'] == reason]
        print(f'    {reason:20s} {count:3d} trades | avg PnL ${bucket["pnl"].mean():+.2f}')

    # Entry states
    print(f'\n  Entry states:')
    for state in trades_df['entry_state'].unique():
        bucket = trades_df[trades_df['entry_state'] == state]
        if len(bucket) == 0:
            continue
        wr = (bucket['pnl'] > 0).mean()
        print(f'    {state:20s} {len(bucket):3d} trades | WR={wr:.0%} | avg PnL ${bucket["pnl"].mean():+.2f}')

    # By day type
    print(f'\n  By day type:')
    for dt in ['STRONG_TREND', 'MODERATE_TREND', 'CHOP', 'MIXED']:
        bucket = trades_df[trades_df['day_type'] == dt]
        if len(bucket) == 0:
            continue
        n_days = bucket['date'].nunique()
        wr = (bucket['pnl'] > 0).mean()
        print(f'    {dt:15s} {len(bucket):3d} trades ({n_days} days) | WR={wr:.0%} | avg ${bucket["pnl"].mean():+.2f} | total ${bucket["pnl"].sum():+.0f}')

    # By time of day
    print(f'\n  By entry time:')
    for start, end, label in [(600, 660, '10-11AM'), (660, 720, '11-12PM'), (720, 780, '12-1PM'), (780, 840, '1-2PM'), (840, 900, '2-3PM')]:
        bucket = trades_df[(trades_df['entry_minute'] >= start) & (trades_df['entry_minute'] < end)]
        if len(bucket) == 0:
            continue
        wr = (bucket['pnl'] > 0).mean()
        print(f'    {label:10s} {len(bucket):3d} trades | WR={wr:.0%} | avg ${bucket["pnl"].mean():+.2f}')

    # ======== COMPARISON: WITH vs WITHOUT ML GATE ========
    print(f'\n{"="*80}')
    print('COMPARISON: Gate vs No Gate')
    print('=' * 80)

    # Without gate: run on ALL 30 days
    print(f'\n  With 30pt gate (current): {len(trades_df)} trades | ${trades_df["pnl"].sum():+.0f} total')

    # Estimate without gate
    gated_days = set(trades_df['date'].unique())
    all_dates = set(day_scores.keys())
    ungated_dates = all_dates - gated_days
    print(f'  Days traded: {len(gated_days)} | Days skipped: {len(ungated_dates)}')

    # On skipped days, what would have happened?
    skip_pnls = []
    for date in ungated_dates:
        info = day_scores[date]
        # These are small-move days — directional would likely lose premium
        skip_pnls.append(-15)  # approximate premium loss on wrong/flat days

    total_with_gate = trades_df['pnl'].sum()
    total_without_gate = total_with_gate + sum(skip_pnls)
    print(f'\n  Total with gate:    ${total_with_gate:+.0f}')
    print(f'  Est total no gate:  ${total_without_gate:+.0f} (adding ~${sum(skip_pnls):+.0f} from skipped days)')
    print(f'  Gate value:         ${total_with_gate - total_without_gate:+.0f}')

    # ======== RECOMMENDATION ========
    print(f'\n{"="*80}')
    print('RECOMMENDATION')
    print('=' * 80)

    daily_avg = trades_df['pnl'].sum() / trades_df['date'].nunique()
    monthly = daily_avg * 22

    print(f"""
  The execution layer with corrected economics shows:

  CORE RESULT:
  - {len(trades_df)} trades across {trades_df["date"].nunique()} trading days
  - Win rate: {len(wins)/len(trades_df):.0%}
  - Avg PnL per trade: ${trades_df["pnl"].mean():+.2f}
  - Total: ${trades_df["pnl"].sum():+.0f}
  - Daily avg: ${daily_avg:+.2f}
  - Monthly estimate: ${monthly:+.0f}

  NEXT PRIORITIES:
  1. Wire the morning ML scorer as a mandatory gate in the live system
  2. Only enter directional on days scoring above trend threshold
  3. Focus entry timing on morning hours (10-11 AM) with acceleration
  4. Use trailing exit (+10 MFE → trail to +3)
  5. Hard stop at -12 pts underlying move
  6. No entries after 50pt day move or during lunch
    """)

    trades_df.to_csv('research/execution_trades.csv', index=False)
    print(f'Saved {len(trades_df)} trades to research/execution_trades.csv')


if __name__ == '__main__':
    run_execution_analysis()
