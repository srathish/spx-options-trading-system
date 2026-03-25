"""
Regime Framework v0.2 — Score-Based 4-Regime System

Regimes:
  STRADDLE:  Both nodes growing, high vol, uncertain direction
  CALLS:     Upper node dominant + growing, price momentum up
  PUTS:      Lower node dominant + growing, price momentum down
  NO_TRADE:  Nodes flipping, low persistence, pinned, no edge

Score-based: each regime gets a continuous score 0-100.
Highest score wins. Below 30 = NO_TRADE.

New features:
  - node_dominance_score: which node is pulling harder (signed, +bullish -bearish)
  - node_flip_rate: how often the king node strike changes (high = chop)
  - acceptance_rejection: did price accept or reject a node touch?
"""

import pandas as pd
import numpy as np
from collections import deque

def compute_regime_features(df):
    """Add regime-specific features to the labeled dataset."""

    results = []

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)

        # Full-day tracking
        king_history = deque(maxlen=60)  # last 60 frames of king strikes
        node_touches = []  # track when price touches a node

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']

            # ---- NODE DOMINANCE SCORE ----
            # Combines: which node is bigger, growing faster, and closer
            # Positive = bullish pull, Negative = bearish pull
            above_pull = 0
            below_pull = 0

            if row['above_abs'] > 0 and row['above_dist'] > 0:
                # Closeness (closer = stronger pull): 1/dist, capped
                closeness = min(1.0, 20.0 / max(row['above_dist'], 5))
                # Size (bigger = stronger): normalized to 50M scale
                size = min(1.0, row['above_abs'] / 50_000_000)
                # Growth momentum (growing = strengthening pull)
                growth = max(0, min(1.0, row['above_pct_15m']))
                above_pull = (closeness * 0.3 + size * 0.4 + growth * 0.3) * 100

            if row['below_abs'] > 0 and row['below_dist'] < 0:
                closeness = min(1.0, 20.0 / max(abs(row['below_dist']), 5))
                size = min(1.0, row['below_abs'] / 50_000_000)
                growth = max(0, min(1.0, row['below_pct_15m']))
                below_pull = (closeness * 0.3 + size * 0.4 + growth * 0.3) * 100

            node_dominance = above_pull - below_pull  # +bullish, -bearish

            # ---- NODE FLIP RATE ----
            # How often the king node strike changes in the last 30 frames
            king_history.append(row['king_strike'])
            flips = 0
            if len(king_history) >= 2:
                for i in range(1, len(king_history)):
                    if king_history[i] != king_history[i-1]:
                        flips += 1
            flip_rate = flips / max(len(king_history) - 1, 1)  # 0 = stable, 1 = every frame

            # Node persistence: how many consecutive frames the current king has been king
            persistence = 0
            for i in range(len(king_history) - 1, -1, -1):
                if king_history[i] == row['king_strike']:
                    persistence += 1
                else:
                    break

            # ---- ACCEPTANCE / REJECTION ----
            # Did price recently touch a node and bounce (rejection) or continue (acceptance)?
            above_touched = abs(row['above_dist']) < 8 if row['above_strike'] > 0 else False
            below_touched = abs(row['below_dist']) < 8 if row['below_strike'] > 0 else False

            above_acceptance = 0  # 1 = price accepted (staying near/past), -1 = rejected
            below_acceptance = 0

            if above_touched and idx >= 5:
                # Was price closer 5 frames ago? If so, it's approaching (accepting)
                prev_dist = day_df.iloc[idx-5]['above_dist'] if 'above_dist' in day_df.columns else 99
                if row['above_dist'] < prev_dist:
                    above_acceptance = 1  # getting closer = accepting
                else:
                    above_acceptance = -1  # bounced away = rejection

            if below_touched and idx >= 5:
                prev_dist = day_df.iloc[idx-5]['below_dist'] if 'below_dist' in day_df.columns else -99
                if abs(row['below_dist']) < abs(prev_dist):
                    below_acceptance = 1
                else:
                    below_acceptance = -1

            # ---- REGIME SCORES (0-100 each) ----

            # == CALLS SCORE ==
            calls_score = 0
            # Above node growing: +25
            if row['above_pct_15m'] > 0.2 and row['above_abs'] >= 8_000_000:
                calls_score += 25
            if row['above_pct_15m'] > 0.5:
                calls_score += 10  # bonus for strong growth
            # Price momentum up: +20
            if row['mom_15m'] > 5:
                calls_score += 20
            elif row['mom_15m'] > 0:
                calls_score += 10
            # Above VWAP: +10
            if row['price_vs_vwap'] > 0:
                calls_score += 10
            # Node dominance bullish: +15
            if node_dominance > 20:
                calls_score += 15
            elif node_dominance > 0:
                calls_score += 5
            # Low flip rate (stable): +10
            if flip_rate < 0.3:
                calls_score += 10
            # Above opening range: +10
            if row.get('above_opening_range', 0) == 1:
                calls_score += 10
            # Penalty: below node also growing strongly = mixed signal
            if row['below_pct_15m'] > 0.3 and row['below_abs'] >= 8_000_000:
                calls_score -= 15

            # == PUTS SCORE ==
            puts_score = 0
            if row['below_pct_15m'] > 0.2 and row['below_abs'] >= 8_000_000:
                puts_score += 25
            if row['below_pct_15m'] > 0.5:
                puts_score += 10
            if row['mom_15m'] < -5:
                puts_score += 20
            elif row['mom_15m'] < 0:
                puts_score += 10
            if row['price_vs_vwap'] < 0:
                puts_score += 10
            if node_dominance < -20:
                puts_score += 15
            elif node_dominance < 0:
                puts_score += 5
            if flip_rate < 0.3:
                puts_score += 10
            if row.get('below_opening_range', 0) == 1:
                puts_score += 10
            if row['above_pct_15m'] > 0.3 and row['above_abs'] >= 8_000_000:
                puts_score -= 15

            # == STRADDLE SCORE ==
            straddle_score = 0
            # Both nodes growing: +30
            both_growing = (row['above_pct_15m'] > 0.15 and row['above_abs'] >= 5_000_000 and
                           row['below_pct_15m'] > 0.15 and row['below_abs'] >= 5_000_000)
            if both_growing:
                straddle_score += 30
            # High realized vol: +20
            if row['realized_vol'] > 2.0:
                straddle_score += 20
            elif row['realized_vol'] > 1.0:
                straddle_score += 10
            # Day range already big: +15
            if row['day_range'] > 30:
                straddle_score += 15
            # High flip rate (uncertainty): +15
            if flip_rate > 0.4:
                straddle_score += 15
            elif flip_rate > 0.2:
                straddle_score += 5
            # Node dominance near zero (balanced): +10
            if abs(node_dominance) < 15:
                straddle_score += 10
            # Low node dominance = unclear direction
            if abs(node_dominance) < 5:
                straddle_score += 10

            # == NO_TRADE INDICATORS ==
            no_trade_score = 0
            # No nodes growing: +30
            if row['above_pct_15m'] <= 0 and row['below_pct_15m'] <= 0:
                no_trade_score += 30
            # High concentration (pinned): +20
            if row['concentration'] > 0.45:
                no_trade_score += 20
            # Low vol: +15
            if row['realized_vol'] < 0.5:
                no_trade_score += 15
            # Time too early or too late: +10
            if row['minute_of_day'] < 590 or row['minute_of_day'] > 930:
                no_trade_score += 20

            # ---- DETERMINE REGIME ----
            scores = {
                'CALLS': calls_score,
                'PUTS': puts_score,
                'STRADDLE': straddle_score,
                'NO_TRADE': no_trade_score,
            }
            best_regime = max(scores, key=scores.get)
            best_score = scores[best_regime]

            # Minimum threshold: need 30+ to have conviction
            if best_score < 30:
                best_regime = 'NO_TRADE'
                best_score = no_trade_score

            # ---- SIGNAL FAILURE TAGS ----
            # For post-hoc analysis of why a signal failed
            failure_tag = ''
            if idx < len(day_df) - 30:
                future_move = day_df.iloc[idx + 30]['spot'] - spot if idx + 30 < len(day_df) else 0
                if best_regime == 'CALLS' and future_move < -5:
                    if row['below_pct_15m'] > 0.3:
                        failure_tag = 'OPPOSING_NODE_GROWING'
                    elif flip_rate > 0.4:
                        failure_tag = 'HIGH_FLIP_RATE'
                    elif row['mom_15m'] < -3:
                        failure_tag = 'MOMENTUM_DIVERGED'
                    else:
                        failure_tag = 'UNKNOWN_CALLS_FAIL'
                elif best_regime == 'PUTS' and future_move > 5:
                    if row['above_pct_15m'] > 0.3:
                        failure_tag = 'OPPOSING_NODE_GROWING'
                    elif flip_rate > 0.4:
                        failure_tag = 'HIGH_FLIP_RATE'
                    elif row['mom_15m'] > 3:
                        failure_tag = 'MOMENTUM_DIVERGED'
                    else:
                        failure_tag = 'UNKNOWN_PUTS_FAIL'

            results.append({
                'date': date,
                'frame': row['frame'],
                'spot': spot,
                'node_dominance': round(node_dominance, 1),
                'flip_rate': round(flip_rate, 3),
                'king_persistence': persistence,
                'above_acceptance': above_acceptance,
                'below_acceptance': below_acceptance,
                'calls_score': calls_score,
                'puts_score': puts_score,
                'straddle_score': straddle_score,
                'no_trade_score': no_trade_score,
                'regime': best_regime,
                'regime_score': best_score,
                'failure_tag': failure_tag,
            })

    regime_df = pd.DataFrame(results)
    merged = df.merge(regime_df, on=['date', 'frame'], how='left', suffixes=('', '_regime'))
    return merged


def build_replay_table(df, date_str):
    """Build a human-readable replay table for one day."""

    day = df[df['date'] == date_str].sort_values('frame')
    if len(day) == 0:
        print(f'No data for {date_str}')
        return

    total_move = day.iloc[-1]['day_move']
    print(f'\n{"="*100}')
    print(f'REPLAY: {date_str} | SPX {total_move:+.0f}')
    print(f'{"="*100}')
    print(f'{"Time":>5} | {"Spot":>7} | {"King":>6} | {"Above":>16} | {"Below":>16} | {"Dom":>5} | {"Flip":>4} | {"Pers":>4} | {"Regime":>10} | {"Score":>5} | {"30m":>6} | Failure')
    print('-' * 120)

    for _, row in day.iterrows():
        if row['frame'] % 10 != 0 and row['frame'] > 0:
            continue  # show every 10 frames

        h = int(row['minute_of_day']) // 60
        m = int(row['minute_of_day']) % 60
        time_str = f'{h}:{m:02d}'

        above_str = f"{row['above_strike']:.0f} {row['above_abs']/1e6:.0f}M {row['above_pct_15m']*100:+.0f}%"
        below_str = f"{abs(row['below_strike']):.0f} {row['below_abs']/1e6:.0f}M {row['below_pct_15m']*100:+.0f}%"

        move_30 = row.get('move_30m', float('nan'))
        move_str = f'{move_30:+.0f}' if not np.isnan(move_30) else '  ?'

        regime = row.get('regime', '?')
        score = row.get('regime_score', 0)
        failure = row.get('failure_tag', '')

        dom = row.get('node_dominance', 0)
        flip = row.get('flip_rate', 0)
        pers = row.get('king_persistence', 0)

        print(f'{time_str:>5} | ${row["spot"]:7.0f} | {row["king_strike"]:6.0f} | {above_str:>16} | {below_str:>16} | {dom:+5.0f} | {flip:.2f} | {pers:4.0f} | {regime:>10} | {score:5.0f} | {move_str:>6} | {failure}')


def analyze_regime_performance(df):
    """How well does each regime predict the next 30m?"""

    entry_df = df[(df['minute_of_day'] >= 600) & (df['minute_of_day'] <= 900)].copy()
    entry_df = entry_df.dropna(subset=['move_30m'])

    print(f'\n{"="*70}')
    print('REGIME PERFORMANCE (v0.2 scores)')
    print(f'{"="*70}')

    for regime in ['CALLS', 'PUTS', 'STRADDLE', 'NO_TRADE']:
        r = entry_df[entry_df['regime'] == regime]
        if len(r) == 0:
            continue

        avg_move = r['move_30m'].mean()
        avg_abs_move = r['move_30m'].abs().mean()

        if regime == 'CALLS':
            win_rate = (r['calls_pnl'] > 0).mean()
            avg_pnl = r['calls_pnl'].mean()
        elif regime == 'PUTS':
            win_rate = (r['puts_pnl'] > 0).mean()
            avg_pnl = r['puts_pnl'].mean()
        elif regime == 'STRADDLE':
            win_rate = (r['straddle_pnl'] > 0).mean()
            avg_pnl = r['straddle_pnl'].mean()
        else:
            win_rate = 0
            avg_pnl = 0

        # High-conviction subset (score > 50)
        high_conv = r[r['regime_score'] > 50]
        if len(high_conv) > 0:
            if regime == 'CALLS':
                hc_wr = (high_conv['calls_pnl'] > 0).mean()
                hc_pnl = high_conv['calls_pnl'].mean()
            elif regime == 'PUTS':
                hc_wr = (high_conv['puts_pnl'] > 0).mean()
                hc_pnl = high_conv['puts_pnl'].mean()
            elif regime == 'STRADDLE':
                hc_wr = (high_conv['straddle_pnl'] > 0).mean()
                hc_pnl = high_conv['straddle_pnl'].mean()
            else:
                hc_wr, hc_pnl = 0, 0
        else:
            hc_wr, hc_pnl = 0, 0

        print(f'\n{regime} ({len(r)} frames, {len(high_conv)} high-conviction):')
        print(f'  Avg 30m move: {avg_move:+.1f} | Abs: {avg_abs_move:.1f}')
        print(f'  Win rate: {win_rate:.0%} | Avg PnL: {avg_pnl:+.1f}')
        if len(high_conv) > 0:
            print(f'  HIGH CONVICTION (score>50): WR={hc_wr:.0%} | PnL={hc_pnl:+.1f} | N={len(high_conv)}')

    # Failure analysis
    failures = entry_df[entry_df['failure_tag'] != '']
    if len(failures) > 0:
        print(f'\n{"="*50}')
        print(f'SIGNAL FAILURES ({len(failures)} total)')
        print(f'{"="*50}')
        print(failures['failure_tag'].value_counts().to_string())


if __name__ == '__main__':
    print('Loading labeled data...')
    df = pd.read_csv('research/labeled.csv')
    print(f'{len(df)} rows')

    print('Computing regime features...')
    df = compute_regime_features(df)
    df.to_csv('research/regime_scored.csv', index=False)
    print(f'Saved to research/regime_scored.csv')

    # Replay tables for 4 key days
    for date in ['2026-02-06', '2026-03-20', '2026-02-11', '2026-02-05']:
        build_replay_table(df, date)

    # Overall performance
    analyze_regime_performance(df)
