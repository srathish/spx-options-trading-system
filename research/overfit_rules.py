"""
Intentionally Overfit Rule Engine — 7-Day Research

Finds the rules that explain these specific 7 days as well as possible.
NOT for production — for learning which features actually matter.

Node Building Definitions:
- node_strength: absolute gamma value (>5M = weak, >10M = moderate, >20M = strong, >50M = dominant)
- node_persistence: frames the node has been >5M (>30 = persistent, <10 = flash)
- build_rate: gamma growth per minute over last 15 min
- magnet_score: abs_value × (1 / distance_from_spot) — bigger and closer = stronger pull
- newly_significant: was <5M 30 min ago, now >10M
"""

import pandas as pd
import numpy as np

def load_data():
    df = pd.read_csv('research/labeled.csv')
    return df

def node_building_features(df):
    """Compute node building signals from raw features."""

    # Magnet score: value × closeness
    df['above_magnet_score'] = df['above_abs'] / (df['above_dist'].abs().clip(lower=5))
    df['below_magnet_score'] = df['below_abs'] / (df['below_dist'].abs().clip(lower=5))

    # Build rate (growth per minute) — 15m window
    df['above_build_rate'] = df['above_growth_15m'] / 15
    df['below_build_rate'] = df['below_growth_15m'] / 15
    df['king_build_rate'] = df['king_growth_15m'] / 15

    # Dominant node: which is pulling harder?
    df['pull_bias'] = df['above_magnet_score'] - df['below_magnet_score']
    # Positive = above node pulling harder (bullish), negative = below pulling (bearish)

    # Node building imbalance: is new gamma being added above or below spot?
    df['flow_imbalance'] = df['nearby_flow_up'] - df['nearby_flow_down']

    # Growing vs dying
    df['above_growing'] = (df['above_pct_15m'] > 0.2).astype(int)
    df['below_growing'] = (df['below_pct_15m'] > 0.2).astype(int)
    df['above_dying'] = (df['above_pct_15m'] < -0.2).astype(int)
    df['below_dying'] = (df['below_pct_15m'] < -0.2).astype(int)

    return df

def find_rules(df):
    """Find rules that explain each day's optimal trades."""

    print('=' * 70)
    print('OVERFIT RULE DISCOVERY — 7 DAYS')
    print('=' * 70)

    # Only look at entry-worthy frames (after 10:00, before 15:00)
    entry_df = df[(df['minute_of_day'] >= 600) & (df['minute_of_day'] <= 900)].copy()
    entry_df = entry_df.dropna(subset=['move_30m'])

    print(f'\nEntry-worthy frames: {len(entry_df)}')
    print(f'Best trade distribution:')
    print(entry_df['best_trade'].value_counts())

    # ---- RULE 1: Follow the dominant growing node ----
    print('\n' + '=' * 50)
    print('RULE 1: Follow the dominant growing node')
    print('=' * 50)

    # When above node growing fast and below node dying → CALLS
    calls_signal = entry_df[
        (entry_df['above_growing'] == 1) &
        (entry_df['above_abs'] >= 8_000_000) &
        (entry_df['above_dist'] >= 15) &
        (entry_df['above_dist'] <= 60)
    ]
    if len(calls_signal) > 0:
        print(f'\nAbove node growing + significant: {len(calls_signal)} frames')
        print(f'  Avg move_30m: {calls_signal["move_30m"].mean():+.1f}')
        print(f'  Calls profitable: {(calls_signal["calls_pnl"] > 0).mean():.0%}')
        print(f'  Avg calls_pnl: {calls_signal["calls_pnl"].mean():+.1f}')

    puts_signal = entry_df[
        (entry_df['below_growing'] == 1) &
        (entry_df['below_abs'] >= 8_000_000) &
        (entry_df['below_dist'] <= -15) &
        (entry_df['below_dist'] >= -60)
    ]
    if len(puts_signal) > 0:
        print(f'\nBelow node growing + significant: {len(puts_signal)} frames')
        print(f'  Avg move_30m: {puts_signal["move_30m"].mean():+.1f}')
        print(f'  Puts profitable: {(puts_signal["puts_pnl"] > 0).mean():.0%}')
        print(f'  Avg puts_pnl: {puts_signal["puts_pnl"].mean():+.1f}')

    # ---- RULE 2: Node building + momentum alignment ----
    print('\n' + '=' * 50)
    print('RULE 2: Node building + price momentum alignment')
    print('=' * 50)

    bull_aligned = entry_df[
        (entry_df['above_growing'] == 1) &
        (entry_df['above_abs'] >= 8_000_000) &
        (entry_df['mom_15m'] > 5)  # price already moving toward the node
    ]
    if len(bull_aligned) > 0:
        print(f'\nBull aligned (above growing + mom up): {len(bull_aligned)} frames')
        print(f'  Avg move_30m: {bull_aligned["move_30m"].mean():+.1f}')
        print(f'  Calls profitable: {(bull_aligned["calls_pnl"] > 0).mean():.0%}')
        print(f'  Avg calls_pnl: {bull_aligned["calls_pnl"].mean():+.1f}')

    bear_aligned = entry_df[
        (entry_df['below_growing'] == 1) &
        (entry_df['below_abs'] >= 8_000_000) &
        (entry_df['mom_15m'] < -5)
    ]
    if len(bear_aligned) > 0:
        print(f'\nBear aligned (below growing + mom down): {len(bear_aligned)} frames')
        print(f'  Avg move_30m: {bear_aligned["move_30m"].mean():+.1f}')
        print(f'  Puts profitable: {(bear_aligned["puts_pnl"] > 0).mean():.0%}')
        print(f'  Avg puts_pnl: {bear_aligned["puts_pnl"].mean():+.1f}')

    # ---- RULE 3: Straddle conditions ----
    print('\n' + '=' * 50)
    print('RULE 3: Straddle conditions')
    print('=' * 50)

    straddle_cond = entry_df[
        (entry_df['above_growing'] == 1) &
        (entry_df['below_growing'] == 1) &
        (entry_df['above_abs'] >= 8_000_000) &
        (entry_df['below_abs'] >= 8_000_000) &
        (entry_df['realized_vol'] > entry_df['realized_vol'].quantile(0.7))
    ]
    if len(straddle_cond) > 0:
        print(f'\nBoth nodes growing + high vol: {len(straddle_cond)} frames')
        print(f'  Avg abs move_30m: {straddle_cond["move_30m"].abs().mean():.1f}')
        print(f'  Straddle profitable: {(straddle_cond["straddle_pnl"] > 0).mean():.0%}')
        print(f'  Avg straddle_pnl: {straddle_cond["straddle_pnl"].mean():+.1f}')
    else:
        print('\n  No frames with both nodes growing + high vol')

    # ---- RULE 4: Target shifting ----
    print('\n' + '=' * 50)
    print('RULE 4: New node appearing further out = target shift')
    print('=' * 50)

    new_above = entry_df[entry_df['new_nodes_above'] >= 1]
    new_below = entry_df[entry_df['new_nodes_below'] >= 1]

    if len(new_above) > 0:
        print(f'\nNew node appearing ABOVE: {len(new_above)} frames')
        print(f'  Avg move_30m: {new_above["move_30m"].mean():+.1f}')
        print(f'  Calls profitable: {(new_above["calls_pnl"] > 0).mean():.0%}')

    if len(new_below) > 0:
        print(f'\nNew node appearing BELOW: {len(new_below)} frames')
        print(f'  Avg move_30m: {new_below["move_30m"].mean():+.1f}')
        print(f'  Puts profitable: {(new_below["puts_pnl"] > 0).mean():.0%}')

    # ---- RULE 5: No trade conditions ----
    print('\n' + '=' * 50)
    print('RULE 5: When to sit out')
    print('=' * 50)

    no_trade = entry_df[
        (entry_df['above_growing'] == 0) &
        (entry_df['below_growing'] == 0) &
        (entry_df['concentration'] > 0.4)  # tight pin
    ]
    if len(no_trade) > 0:
        print(f'\nNo growth + concentrated (pinned): {len(no_trade)} frames')
        print(f'  Avg abs move_30m: {no_trade["move_30m"].abs().mean():.1f}')
        print(f'  Avg straddle_pnl: {no_trade["straddle_pnl"].mean():+.1f}')
        print(f'  → Should be NO_TRADE zone')

    # ---- PER-DAY OPTIMAL STRATEGY ----
    print('\n' + '=' * 50)
    print('PER-DAY OPTIMAL STRATEGY (overfit)')
    print('=' * 50)

    for date, day_df in entry_df.groupby('date'):
        day_df = day_df.sort_values('frame')
        total_move = day_df['day_move'].iloc[-1]
        best_calls = day_df['calls_pnl'].max()
        best_puts = day_df['puts_pnl'].max()
        best_straddle = day_df['straddle_pnl'].max()

        # Find the best single entry frame
        best_frame_calls = day_df.loc[day_df['calls_pnl'].idxmax()] if best_calls > 0 else None
        best_frame_puts = day_df.loc[day_df['puts_pnl'].idxmax()] if best_puts > 0 else None

        print(f'\n{date} | SPX {total_move:+.0f}')
        print(f'  Best calls entry: +{best_calls:.0f} pts', end='')
        if best_frame_calls is not None:
            print(f' @ frame {best_frame_calls["frame"]:.0f} (min {best_frame_calls["minute_of_day"]:.0f}), '
                  f'above_growth={best_frame_calls["above_pct_15m"]:.0%}, '
                  f'king={best_frame_calls["king_strike"]:.0f}')
        else:
            print()
        print(f'  Best puts entry:  +{best_puts:.0f} pts', end='')
        if best_frame_puts is not None:
            print(f' @ frame {best_frame_puts["frame"]:.0f} (min {best_frame_puts["minute_of_day"]:.0f}), '
                  f'below_growth={best_frame_puts["below_pct_15m"]:.0%}, '
                  f'king={best_frame_puts["king_strike"]:.0f}')
        else:
            print()
        print(f'  Best straddle:    +{best_straddle:.0f} pts')

    # ---- SUMMARY RULES ----
    print('\n' + '=' * 70)
    print('PROPOSED OVERFIT RULES')
    print('=' * 70)
    print("""
    RULE 1: ENTER CALLS when:
      - A node above spot is growing >20% in 15m
      - It's at least 8M absolute
      - 15-30 pts above spot
      - Price momentum (15m) is positive
      → Take profit at +15 or when node stops growing

    RULE 2: ENTER PUTS when:
      - A node below spot is growing >20% in 15m
      - It's at least 8M absolute
      - 15-30 pts below spot
      - Price momentum (15m) is negative
      → Take profit at +15 or when node stops growing

    RULE 3: STRADDLE when:
      - BOTH above and below nodes growing >20%
      - Realized vol is above 70th percentile
      - High opening range
      → Ride the first big move

    RULE 4: SHIFT TARGET when:
      - Currently in a winning trade
      - NEW node appears further in your direction
      - Original target node still alive
      → Move target to the new node

    RULE 5: NO TRADE when:
      - No nodes growing significantly
      - High concentration (gamma pinned)
      - Low realized vol
      - Morning ML score < 0.3 (CHOP_LIKELY)
    """)

if __name__ == '__main__':
    df = load_data()
    df = node_building_features(df)
    find_rules(df)
