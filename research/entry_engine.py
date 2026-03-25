"""
Entry Engine — Timing layer on top of frozen v6 structural engine.

The structural engine tells us WHAT to trade (calls/puts/straddle).
This engine tells us WHEN to enter.

Output: CALLS_ENTRY / CALLS_HOLD / PUTS_ENTRY / PUTS_HOLD / STRADDLE_ENTRY / NO_TRADE
"""

import pandas as pd
import numpy as np

def compute_entry_features(df):
    """Add entry-timing features on top of structural features."""

    results = []

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)
        spots = day_df['spot'].values

        # Track local range for breakout detection
        local_high_20 = []  # rolling 20-frame high
        local_low_20 = []

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']
            frame = row['frame']

            # ---- DISTANCE FEATURES ----
            king_strike = row.get('king_strike', spot)
            king_dist = abs(row.get('king_dist', 0))
            above_strike = row.get('above_strike', 0)
            below_strike = row.get('below_strike', 0)
            above_dist = row.get('above_dist', 0)
            below_dist = abs(row.get('below_dist', 0))
            thesis_dir = row.get('thesis_dir', None)

            # Distance to next same-direction target
            if thesis_dir == 'BULLISH':
                dist_to_target = above_dist if above_strike > 0 else 999
            elif thesis_dir == 'BEARISH':
                dist_to_target = below_dist if below_strike > 0 else 999
            else:
                dist_to_target = min(above_dist, below_dist) if above_strike > 0 and below_strike > 0 else 999

            target_too_close = 1 if dist_to_target < 8 else 0

            # ---- VELOCITY / ACCELERATION ----
            mom_5 = row.get('mom_5m', 0)
            mom_15 = row.get('mom_15m', 0)

            # Price acceleration: is momentum increasing?
            if idx >= 10:
                prev_mom_5 = day_df.iloc[idx - 5].get('mom_5m', 0) if idx >= 5 else 0
                price_accel = mom_5 - prev_mom_5
            else:
                price_accel = 0

            # Toward-target velocity: is price moving toward the thesis target?
            toward_target = 0
            if thesis_dir == 'BULLISH' and mom_5 > 0:
                toward_target = mom_5
            elif thesis_dir == 'BEARISH' and mom_5 < 0:
                toward_target = abs(mom_5)

            # ---- VWAP FEATURES ----
            vwap_dist = row.get('price_vs_vwap', 0)

            # VWAP reclaim/reject: did price just cross VWAP?
            vwap_reclaim = 0
            vwap_reject = 0
            if idx >= 5:
                prev_vwap = day_df.iloc[idx - 5].get('price_vs_vwap', 0)
                if prev_vwap < 0 and vwap_dist > 0:
                    vwap_reclaim = 1  # crossed above VWAP
                elif prev_vwap > 0 and vwap_dist < 0:
                    vwap_reject = 1  # lost VWAP

            # ---- OPENING RANGE ----
            or_position = 0  # -1 = below, 0 = inside, 1 = above
            if row.get('above_opening_range', 0) == 1:
                or_position = 1
            elif row.get('below_opening_range', 0) == 1:
                or_position = -1

            # ---- EXTENSION FROM OPEN ----
            day_move = row.get('day_move', 0)
            day_range = row.get('day_range', 0)
            already_extended = 1 if abs(day_move) > 50 else 0
            move_pct_of_range = abs(day_move) / max(day_range, 1)

            # ---- LOCAL RANGE BREAKOUT ----
            local_high_20.append(spot)
            local_low_20.append(spot)
            if len(local_high_20) > 20:
                local_high_20.pop(0)
                local_low_20.pop(0)

            local_high = max(local_high_20)
            local_low = min(local_low_20)
            local_range = local_high - local_low

            breakout_up = 1 if spot >= local_high and local_range > 5 else 0
            breakout_down = 1 if spot <= local_low and local_range > 5 else 0

            # ---- NODE GROWTH ACCELERATION ----
            above_growth = row.get('above_pct_15m', 0)
            below_growth = row.get('below_pct_15m', 0)
            same_dir_growth = row.get('same_dir_growth', 0)

            # Is target growth accelerating? Compare 5m vs 15m growth
            above_growth_5 = row.get('above_pct_5m', 0)
            below_growth_5 = row.get('below_pct_5m', 0)
            growth_accelerating = 0
            if thesis_dir == 'BULLISH':
                growth_accelerating = 1 if above_growth_5 > above_growth * 0.3 and above_growth_5 > 0.1 else 0
            elif thesis_dir == 'BEARISH':
                growth_accelerating = 1 if below_growth_5 > below_growth * 0.3 and below_growth_5 > 0.1 else 0

            # ---- FIRST TOUCH vs RETEST vs POST-CONTACT ----
            touch_state = 'NONE'
            if king_dist < 8:
                # At king contact zone
                if idx >= 30:
                    # Was king_dist > 15 sometime in last 30 frames?
                    prev_dists = [abs(day_df.iloc[max(0, idx-j)].get('king_dist', 0)) for j in range(1, 31)]
                    if max(prev_dists) > 15:
                        # First time approaching after being far
                        recent_close = sum(1 for d in prev_dists[:10] if d < 10)
                        if recent_close < 3:
                            touch_state = 'FIRST_TOUCH'
                        else:
                            touch_state = 'RETEST'
                    else:
                        touch_state = 'AT_CONTACT'
                else:
                    touch_state = 'FIRST_TOUCH'
            elif king_dist > 15 and toward_target > 3:
                touch_state = 'APPROACHING'

            # ---- MIGRATION PHASE ----
            mig_count = row.get('thesis_migration_count', 0)
            thesis_bars = row.get('thesis_bars', 0)
            if thesis_bars < 30:
                migration_phase = 'EARLY'
            elif mig_count <= 1:
                migration_phase = 'MID'
            else:
                migration_phase = 'LATE'

            # ---- TIME OF DAY ----
            minute = row.get('minute_of_day', 600)
            is_morning = 1 if minute < 660 else 0  # before 11
            is_lunch = 1 if 720 <= minute <= 780 else 0  # 12-1
            is_afternoon = 1 if minute >= 840 else 0  # after 2
            is_power_hour = 1 if minute >= 900 else 0  # after 3

            # ---- CHOP STATE ----
            flip_count = row.get('flip_count_30', 0)
            is_choppy = 1 if flip_count >= 4 else 0

            # ---- RSI EXTREMES ----
            rsi = row.get('rsi_14', 50)
            rsi_overbought = 1 if rsi > 70 else 0
            rsi_oversold = 1 if rsi < 30 else 0

            # ============================
            # ENTRY SCORING
            # ============================
            regime = row.get('v3_regime', 'NO_TRADE')

            entry_score = 0
            action = 'HOLD' if regime in ('CALLS', 'PUTS') else regime

            if regime == 'CALLS':
                # Bullish entry timing score
                entry_score = 0
                # Toward target velocity: +20
                if toward_target > 3: entry_score += 20
                elif toward_target > 1: entry_score += 10
                # Node growth accelerating: +15
                if growth_accelerating: entry_score += 15
                # VWAP reclaim: +15
                if vwap_reclaim: entry_score += 15
                elif vwap_dist > 0: entry_score += 5
                # Breakout: +15
                if breakout_up: entry_score += 15
                # First touch / approaching: +10
                if touch_state == 'APPROACHING': entry_score += 10
                elif touch_state == 'FIRST_TOUCH': entry_score += 5
                # Morning bonus: +10
                if is_morning: entry_score += 10
                # Migration phase bonus
                if migration_phase == 'EARLY': entry_score += 10
                elif migration_phase == 'MID': entry_score += 5

                # Penalties
                if target_too_close: entry_score -= 20
                if already_extended: entry_score -= 15
                if is_lunch: entry_score -= 15
                if is_choppy: entry_score -= 15
                if touch_state == 'RETEST': entry_score -= 10
                if touch_state == 'AT_CONTACT': entry_score -= 15
                if rsi_overbought: entry_score -= 10

                action = 'CALLS_ENTRY' if entry_score >= 30 else 'CALLS_HOLD'

            elif regime == 'PUTS':
                entry_score = 0
                if toward_target > 3: entry_score += 20
                elif toward_target > 1: entry_score += 10
                if growth_accelerating: entry_score += 15
                if vwap_reject: entry_score += 15
                elif vwap_dist < 0: entry_score += 5
                if breakout_down: entry_score += 15
                if touch_state == 'APPROACHING': entry_score += 10
                elif touch_state == 'FIRST_TOUCH': entry_score += 5
                if is_morning: entry_score += 10
                if migration_phase == 'EARLY': entry_score += 10
                elif migration_phase == 'MID': entry_score += 5

                if target_too_close: entry_score -= 20
                if already_extended: entry_score -= 15
                if is_lunch: entry_score -= 15
                if is_choppy: entry_score -= 15
                if touch_state == 'RETEST': entry_score -= 10
                if touch_state == 'AT_CONTACT': entry_score -= 15
                if rsi_oversold: entry_score -= 10

                action = 'PUTS_ENTRY' if entry_score >= 30 else 'PUTS_HOLD'

            elif regime == 'STRADDLE':
                entry_score = 0
                if row.get('realized_vol', 0) > 2: entry_score += 15
                if abs(mom_5) > 5: entry_score += 10  # momentum picking up
                if local_range < 10: entry_score += 10  # compressed range = about to break
                if not is_lunch: entry_score += 10
                if abs(price_accel) > 2: entry_score += 10

                action = 'STRADDLE_ENTRY' if entry_score >= 25 else 'NO_TRADE'

            # ---- ENTRY FAILURE TAGGING ----
            failure = ''
            m30 = row.get('move_30m', np.nan)
            if not np.isnan(m30) and action in ('CALLS_ENTRY', 'PUTS_ENTRY', 'STRADDLE_ENTRY'):
                is_bad = False
                if action == 'CALLS_ENTRY' and m30 < -3: is_bad = True
                elif action == 'PUTS_ENTRY' and m30 > 3: is_bad = True
                elif action == 'STRADDLE_ENTRY' and abs(m30) < 5: is_bad = True

                if is_bad:
                    if already_extended: failure = 'EXTENDED_FROM_OPEN'
                    elif is_lunch: failure = 'LUNCH_ENTRY'
                    elif target_too_close: failure = 'TARGET_TOO_CLOSE'
                    elif abs(price_accel) < 0.5 and abs(mom_5) < 2: failure = 'NO_ACCELERATION'
                    elif touch_state in ('RETEST', 'AT_CONTACT'): failure = 'ENTRY_AT_CONTACT'
                    elif is_choppy: failure = 'CHOP_AFTER_ENTRY'
                    elif migration_phase == 'LATE' and abs(day_move) > 40: failure = 'CHASED_TOO_LATE'
                    elif vwap_reject and action == 'CALLS_ENTRY': failure = 'FAILED_RECLAIM'
                    elif vwap_reclaim and action == 'PUTS_ENTRY': failure = 'FAILED_BREAKOUT'
                    else: failure = 'GOOD_THESIS_BAD_TIMING'

            results.append({
                'date': date,
                'frame': frame,
                'entry_score': entry_score,
                'action': action,
                'dist_to_target': round(dist_to_target, 1),
                'toward_target': round(toward_target, 2),
                'price_accel': round(price_accel, 2),
                'growth_accelerating': growth_accelerating,
                'touch_state': touch_state,
                'migration_phase': migration_phase,
                'vwap_reclaim': vwap_reclaim,
                'vwap_reject': vwap_reject,
                'breakout_up': breakout_up,
                'breakout_down': breakout_down,
                'target_too_close': target_too_close,
                'already_extended': already_extended,
                'entry_failure': failure,
            })

    return pd.DataFrame(results)


def evaluate_entries(df, entry_df):
    """Evaluate entry engine on the 7-day set."""

    merged = df.merge(entry_df, on=['date', 'frame'], how='left')
    entry_window = merged[(merged['minute_of_day'] >= 600) & (merged['minute_of_day'] <= 900)]
    entry_window = entry_window.dropna(subset=['move_30m'])

    print('=' * 70)
    print('ENTRY ENGINE EVALUATION')
    print('=' * 70)

    # Signal distribution
    print('\nAction distribution:')
    print(entry_window['action'].value_counts().to_string())

    # Layer A: Thesis accuracy (should be unchanged)
    thesis_days = 0
    thesis_correct = 0
    for date, day in entry_window.groupby('date'):
        day_move = day.iloc[-1]['day_move']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        dominant = day['thesis_dir'].value_counts().index[0] if len(day) > 0 else 'NONE'
        thesis_days += 1
        if dominant == actual: thesis_correct += 1
    print(f'\nThesis accuracy: {thesis_correct}/{thesis_days} ({thesis_correct/thesis_days:.0%}) [should be same as v6]')

    # Layer B: Regime alignment (should be unchanged)
    aligned = misaligned = 0
    for _, row in entry_window.iterrows():
        act = row['action']
        day_move = row['day_move']
        actual = 'BULLISH' if day_move > 10 else 'BEARISH' if day_move < -10 else 'FLAT'
        if act.startswith('CALLS') and actual == 'BULLISH': aligned += 1
        elif act.startswith('PUTS') and actual == 'BEARISH': aligned += 1
        elif act.startswith('CALLS') and actual == 'BEARISH': misaligned += 1
        elif act.startswith('PUTS') and actual == 'BULLISH': misaligned += 1
    total_dir = aligned + misaligned
    print(f'Regime alignment: {aligned}/{total_dir} ({aligned/total_dir:.0%})' if total_dir > 0 else '')

    # Layer C: Entry payoff (the new focus)
    print('\n--- ENTRY PAYOFF ---')

    for action in ['CALLS_ENTRY', 'PUTS_ENTRY', 'STRADDLE_ENTRY']:
        entries = entry_window[entry_window['action'] == action]
        if len(entries) == 0:
            print(f'  {action}: 0 signals')
            continue

        if action == 'CALLS_ENTRY':
            correct = (entries['move_30m'] > 5).mean()
            avg_pnl = entries['calls_pnl'].mean()
            mfe = entries['mfe_60m'].mean()
        elif action == 'PUTS_ENTRY':
            correct = (entries['move_30m'] < -5).mean()
            avg_pnl = entries['puts_pnl'].mean()
            mfe = (-entries['mae_60m']).mean()  # MAE is negative for puts direction
        else:
            correct = (entries['move_30m'].abs() > 8).mean()
            avg_pnl = entries['straddle_pnl'].mean()
            mfe = entries['mfe_60m'].abs().mean()

        print(f'  {action}: {len(entries)} signals | 30m correct: {correct:.0%} | avg PnL: {avg_pnl:+.1f} | avg MFE: {mfe:.1f}')

    # HOLD comparison
    print('\n--- HOLD JUSTIFIED ---')
    for hold in ['CALLS_HOLD', 'PUTS_HOLD']:
        h = entry_window[entry_window['action'] == hold]
        if len(h) == 0: continue
        if hold == 'CALLS_HOLD':
            justified = (h['move_30m'] > -5).mean()
        else:
            justified = (h['move_30m'] < 5).mean()
        print(f'  {hold}: {len(h)} frames | hold justified: {justified:.0%}')

    # Entry failure analysis
    failures = entry_window[entry_window['entry_failure'] != '']
    if len(failures) > 0:
        print(f'\n--- ENTRY FAILURES ({len(failures)}) ---')
        print(failures['entry_failure'].value_counts().to_string())

    # Compare to old "all entries" metric
    old_entries = entry_window[entry_window['action'].str.contains('ENTRY')]
    if len(old_entries) > 0:
        old_correct = 0
        for _, row in old_entries.iterrows():
            if row['action'] == 'CALLS_ENTRY' and row['move_30m'] > 5: old_correct += 1
            elif row['action'] == 'PUTS_ENTRY' and row['move_30m'] < -5: old_correct += 1
            elif row['action'] == 'STRADDLE_ENTRY' and abs(row['move_30m']) > 8: old_correct += 1
        print(f'\n--- COMPARISON ---')
        print(f'  New entry payoff: {old_correct}/{len(old_entries)} ({old_correct/len(old_entries):.0%})')
        print(f'  Old entry payoff (all regimes as entry): 39%')

    # Per-day breakdown
    print('\n--- PER-DAY ENTRY SUMMARY ---')
    for date, day in entry_window.groupby('date'):
        day_move = day.iloc[-1]['day_move']
        n_entry = len(day[day['action'].str.contains('ENTRY')])
        n_hold = len(day[day['action'].str.contains('HOLD')])
        n_notrade = len(day[day['action'] == 'NO_TRADE'])
        entries = day[day['action'].str.contains('ENTRY')]
        if len(entries) > 0:
            if day_move > 10:
                pnl = entries['calls_pnl'].sum()
            elif day_move < -10:
                pnl = entries['puts_pnl'].sum()
            else:
                pnl = entries['straddle_pnl'].sum()
        else:
            pnl = 0
        print(f'  {date} | SPX {day_move:+.0f} | entries={n_entry} holds={n_hold} no_trade={n_notrade} | entry PnL≈{pnl:+.0f}')


if __name__ == '__main__':
    print('Loading data...')
    features = pd.read_csv('research/features.csv')
    labeled = pd.read_csv('research/labeled.csv')
    v6 = pd.read_csv('research/regime_v6.csv')

    df = features.merge(v6, on=['date', 'frame'], how='left', suffixes=('', '_v6'))
    df = df.merge(labeled[['date', 'frame', 'move_15m', 'move_30m', 'move_60m',
                            'mfe_60m', 'mae_60m', 'calls_pnl', 'puts_pnl', 'straddle_pnl',
                            'best_trade']],
                  on=['date', 'frame'], how='left')
    print(f'{len(df)} rows')

    print('Computing entry features...')
    entry_df = compute_entry_features(df)
    entry_df.to_csv('research/entry_scored.csv', index=False)
    print(f'Saved {len(entry_df)} rows')

    evaluate_entries(df, entry_df)
