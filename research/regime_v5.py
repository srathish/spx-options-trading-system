"""
Regime Engine v5 — Migration Lock

v5 fix: When bullish thesis is active and same-direction migration
remains intact (6910→6925→6935 stacking), PUTS are structurally
blocked unless a real opposite-direction takeover is confirmed.

Hierarchy:
1. Active migration → CALLS/HOLD_CALLS (PUTS zeroed)
2. Contact/wobble/retest → CALLS/HOLD_CALLS (PUTS capped)
3. Migration stalled → allow reduced PUTS
4. Real opposite takeover confirmed → allow full PUTS

Same logic applies symmetrically for bearish migration blocking CALLS.

Core principles:
1. King node persistence drives trade bias (not raw dominance/proximity)
2. King above spot + stable = CALLS. King below spot + stable = PUTS.
3. Same-direction king migration (6910→6925→6935) = continuation, not contradiction
4. Opposite-direction king replacement = thesis failure
5. Pullback during same-direction strengthening ≠ panic exit
"""

import pandas as pd
import numpy as np
from collections import deque

# ---- New Feature Definitions ----

def compute_v3_features(df):
    """Compute king-persistence-first features for the entire dataset."""

    results = []

    for date, day_df in df.groupby('date'):
        day_df = day_df.sort_values('frame').reset_index(drop=True)

        king_strike_history = []       # full day: [(frame, strike)]
        king_value_history = []        # full day: [(frame, abs_value)]
        prev_king_strike = None
        prev_king_dir = None           # 'BULLISH' or 'BEARISH'
        thesis_dir = None              # current thesis direction
        thesis_start_frame = 0
        thesis_king_strikes = set()    # all king strikes during this thesis

        for idx in range(len(day_df)):
            row = day_df.iloc[idx]
            spot = row['spot']
            frame = row['frame']

            # ---- KING NODE BASICS ----
            king_strike = row['king_strike']
            king_value = row['king_value']  # signed
            king_abs = row['king_abs']
            king_dist = row['king_dist']

            # King direction: where is the king relative to spot?
            if king_dist > 5:
                king_dir = 'BULLISH'
            elif king_dist < -5:
                king_dir = 'BEARISH'
            else:
                king_dir = 'AT_SPOT'

            king_strike_history.append((frame, king_strike))
            king_value_history.append((frame, king_abs))

            # ---- KING PERSISTENCE ----
            # How many consecutive frames has this EXACT strike been king?
            persistence_bars = 0
            for i in range(len(king_strike_history) - 1, -1, -1):
                if king_strike_history[i][1] == king_strike:
                    persistence_bars += 1
                else:
                    break

            # ---- KING STRENGTH CHANGE ----
            king_strength_5m = 0
            king_strength_15m = 0
            if len(king_value_history) >= 5:
                king_strength_5m = king_abs - king_value_history[-5][1]
            if len(king_value_history) >= 15:
                king_strength_15m = king_abs - king_value_history[-15][1]

            king_strengthening = king_strength_15m > 0
            king_weakening = king_strength_15m < -king_abs * 0.2  # lost 20%+

            # ---- SAME-DIRECTION TARGET MIGRATION ----
            # Count significant nodes building in the SAME direction as king
            same_dir_targets = 0
            same_dir_growth = 0
            opp_dir_threat = 0
            opp_dir_growth = 0

            # Check all significant nodes
            above_strike = row['above_strike']
            above_abs = row['above_abs']
            above_growth = row['above_pct_15m']
            below_strike = row['below_strike']
            below_abs = row['below_abs']
            below_growth = row['below_pct_15m']

            # FIX A: Use thesis_dir for same-direction when AT_SPOT
            scan_dir = king_dir if king_dir != 'AT_SPOT' else thesis_dir

            if scan_dir == 'BULLISH':
                # Same direction = more bullish targets above
                if above_abs >= 5_000_000 and above_strike > king_strike:
                    same_dir_targets += 1
                    same_dir_growth += max(0, above_growth)
                if above_abs >= 5_000_000 and above_strike > spot and above_growth > 0.1:
                    same_dir_targets += 1
                    same_dir_growth += above_growth
                # Opposite = bearish nodes below strengthening
                if below_abs >= 8_000_000 and below_growth > 0.2:
                    opp_dir_threat += 1
                    opp_dir_growth += below_growth
            elif scan_dir == 'BEARISH':
                if below_abs >= 5_000_000 and below_strike < king_strike:
                    same_dir_targets += 1
                    same_dir_growth += max(0, below_growth)
                if below_abs >= 5_000_000 and below_strike < spot and below_growth > 0.1:
                    same_dir_targets += 1
                    same_dir_growth += below_growth
                if above_abs >= 8_000_000 and above_growth > 0.2:
                    opp_dir_threat += 1
                    opp_dir_growth += above_growth

            # ---- TARGET MIGRATION SCORE ----
            # Did the king shift to a SAME-DIRECTION strike? That's migration, not failure.
            king_migrated_same_dir = False
            if prev_king_strike and prev_king_strike != king_strike:
                if king_dir == 'BULLISH' and prev_king_dir == 'BULLISH' and king_strike > prev_king_strike:
                    king_migrated_same_dir = True  # 6910 → 6925 = bullish continuation
                elif king_dir == 'BEARISH' and prev_king_dir == 'BEARISH' and king_strike < prev_king_strike:
                    king_migrated_same_dir = True  # 6500 → 6475 = bearish continuation

            # ---- OPPOSITE-DIRECTION TAKEOVER RISK ----
            # Is a node in the opposite direction threatening to become king?
            takeover_risk = 0
            if king_dir == 'BULLISH' and below_abs >= king_abs * 0.7 and below_growth > 0.2:
                takeover_risk = min(100, int(below_abs / king_abs * 100))
            elif king_dir == 'BEARISH' and above_abs >= king_abs * 0.7 and above_growth > 0.2:
                takeover_risk = min(100, int(above_abs / king_abs * 100))

            # ---- THESIS TRACKING ----
            # A thesis is the sustained directional bias. It changes when:
            # 1. King direction flips to opposite AND persists 10+ bars
            # 2. OR opposite takeover actually happens
            if thesis_dir is None:
                thesis_dir = king_dir if king_dir != 'AT_SPOT' else None
                thesis_start_frame = frame
                thesis_king_strikes = {king_strike}

            if king_dir != 'AT_SPOT':
                if king_dir == thesis_dir:
                    thesis_king_strikes.add(king_strike)
                else:
                    # Potential thesis flip — requires STRUCTURAL handoff, not wobble
                    # Distance from old thesis king strikes (must be displaced, not contact wobble)
                    min_dist_from_old_kings = min(
                        (abs(king_strike - old_k) for old_k in thesis_king_strikes),
                        default=0
                    ) if thesis_king_strikes else 999

                    real_takeover = (
                        persistence_bars >= 20 and      # sustained opposite control
                        king_abs >= 10_000_000 and      # significant node
                        abs(king_dist) >= 15 and        # not AT_SPOT wobble
                        min_dist_from_old_kings >= 20 and  # displaced from old king zone
                        same_dir_targets == 0 and       # old thesis targets stopped building
                        not king_migrated_same_dir       # not a same-dir migration
                    )

                    if real_takeover:
                        thesis_dir = king_dir
                        thesis_start_frame = frame
                        thesis_king_strikes = {king_strike}
            # AT_SPOT does NOT flip thesis — price reached the king,
            # thesis continues if same-direction targets are building

            thesis_bars = frame - thesis_start_frame
            thesis_migration_count = len(thesis_king_strikes)

            # ---- DIP VS STRUCTURE SCORE ----
            # Is price pulling back while same-direction targets still strengthen?
            # Positive = structure supports thesis despite price dip
            # Negative = structure weakening with price
            dip_vs_structure = 0
            mom_15 = row.get('mom_15m', 0)

            # FIX A: Use thesis_dir for dip_vs_structure when king is AT_SPOT
            effective_dir = king_dir if king_dir != 'AT_SPOT' else thesis_dir

            if effective_dir == 'BULLISH':
                price_dipping = mom_15 < -3
                targets_still_growing = same_dir_growth > 0.1
                if price_dipping and targets_still_growing:
                    dip_vs_structure = 30
                elif price_dipping and not targets_still_growing:
                    dip_vs_structure = -20
                elif not price_dipping and targets_still_growing:
                    dip_vs_structure = 50
            elif effective_dir == 'BEARISH':
                price_dipping = mom_15 > 3
                targets_still_growing = same_dir_growth > 0.1
                if price_dipping and targets_still_growing:
                    dip_vs_structure = 30
                elif price_dipping and not targets_still_growing:
                    dip_vs_structure = -20
                elif not price_dipping and targets_still_growing:
                    dip_vs_structure = 50

            # ---- AT_SPOT CONTINUATION SCORE ----
            # When king is AT_SPOT, check if thesis is still alive via targets
            at_spot_continuation = 0
            if king_dir == 'AT_SPOT' and thesis_dir and thesis_bars >= 20:
                if same_dir_targets > 0 and same_dir_growth > 0.05:
                    at_spot_continuation = 40  # thesis alive, targets building
                elif same_dir_targets > 0:
                    at_spot_continuation = 20  # targets exist but not growing much
                # If thesis was bullish and we reached the king, that's a WIN
                # but the thesis may continue if higher targets build

            # ---- v5: MIGRATION LOCK ----
            # When thesis is active with same-direction migration, the opposite
            # direction is structurally blocked. This is a hierarchy:
            #   1. migration_active → opposite zeroed
            #   2. contact/retest → opposite capped
            #   3. migration_stalled → opposite allowed reduced
            #   4. real_takeover → opposite allowed full
            bullish_migration_active = (
                thesis_dir == 'BULLISH' and
                thesis_migration_count >= 1 and
                same_dir_targets > 0 and
                same_dir_growth >= 0 and  # not decaying
                takeover_risk < 50
            )
            bearish_migration_active = (
                thesis_dir == 'BEARISH' and
                thesis_migration_count >= 1 and
                same_dir_targets > 0 and
                same_dir_growth >= 0 and
                takeover_risk < 50
            )

            # Migration state classification
            if bullish_migration_active and same_dir_growth > 0.05:
                migration_state = 'ACTIVE'      # full lock: PUTS zeroed
            elif bullish_migration_active:
                migration_state = 'CONTACT'     # targets exist but flat: PUTS capped
            elif thesis_dir == 'BULLISH' and thesis_bars >= 30 and same_dir_targets == 0:
                migration_state = 'STALLED'     # targets gone: reduced PUTS allowed
            else:
                migration_state = 'NONE'        # no lock

            if bearish_migration_active and same_dir_growth > 0.05:
                migration_state_bear = 'ACTIVE'
            elif bearish_migration_active:
                migration_state_bear = 'CONTACT'
            elif thesis_dir == 'BEARISH' and thesis_bars >= 30 and same_dir_targets == 0:
                migration_state_bear = 'STALLED'
            else:
                migration_state_bear = 'NONE'

            # ---- FLIP COUNT (for chop detection) ----
            flip_count_30 = 0
            recent = king_strike_history[-30:] if len(king_strike_history) >= 30 else king_strike_history
            for i in range(1, len(recent)):
                if recent[i][1] != recent[i-1][1]:
                    flip_count_30 += 1

            # ===============================
            # REGIME SCORING v3
            # ===============================

            # ---- FIX B: CHOP OVERRIDE ----
            # High flip count kills directional confidence
            is_choppy = flip_count_30 >= 4
            is_very_choppy = flip_count_30 >= 8
            chop_penalty = min(60, flip_count_30 * 8) if is_choppy else 0

            # -- CALLS SCORE --
            calls_score = 0

            # FIX A: AT_SPOT with thesis continuation
            if king_dir == 'AT_SPOT' and thesis_dir == 'BULLISH' and at_spot_continuation > 0:
                # Thesis alive — price reached king but higher targets building
                calls_score += at_spot_continuation  # 20-40 pts
                calls_score += min(20, thesis_bars // 5)  # long thesis = more trust
                if same_dir_growth > 0.1:
                    calls_score += 15
                if mom_15 > 0:
                    calls_score += 10

            elif king_dir == 'BULLISH':
                # Normal bullish king scoring
                calls_score += 25
                calls_score += min(30, persistence_bars * 1.0)
                if king_strengthening:
                    calls_score += 15
                calls_score += min(20, same_dir_targets * 10)
                calls_score += min(15, same_dir_growth * 30)
                if king_migrated_same_dir:
                    calls_score += 15
                if mom_15 > 3:
                    calls_score += 10
                if dip_vs_structure > 0:
                    calls_score += 10
                if takeover_risk > 50:
                    calls_score -= 20
                if king_weakening:
                    calls_score -= 15

            # FIX B: Apply chop penalty
            calls_score -= chop_penalty

            # -- PUTS SCORE --
            puts_score = 0

            # FIX A: AT_SPOT with thesis continuation (bearish)
            if king_dir == 'AT_SPOT' and thesis_dir == 'BEARISH' and at_spot_continuation > 0:
                puts_score += at_spot_continuation
                puts_score += min(20, thesis_bars // 5)
                if same_dir_growth > 0.1:
                    puts_score += 15
                if mom_15 < 0:
                    puts_score += 10

            elif king_dir == 'BEARISH':
                puts_score += 25
                puts_score += min(30, persistence_bars * 1.0)
                if king_strengthening:
                    puts_score += 15
                puts_score += min(20, same_dir_targets * 10)
                puts_score += min(15, same_dir_growth * 30)
                if king_migrated_same_dir:
                    puts_score += 15
                if mom_15 < -3:
                    puts_score += 10
                if dip_vs_structure > 0:
                    puts_score += 10
                if takeover_risk > 50:
                    puts_score -= 20
                if king_weakening:
                    puts_score -= 15

            # FIX B: Apply chop penalty
            puts_score -= chop_penalty

            # ---- v5: APPLY MIGRATION LOCK TO OPPOSITE DIRECTION ----
            # Bullish migration active → structurally block PUTS
            if migration_state == 'ACTIVE':
                puts_score = min(puts_score, 0)   # zero out PUTS entirely
            elif migration_state == 'CONTACT':
                puts_score = min(puts_score, 15)  # cap PUTS at noise level
            elif migration_state == 'STALLED':
                puts_score = int(puts_score * 0.5)  # reduce but allow

            # Bearish migration active → structurally block CALLS
            if migration_state_bear == 'ACTIVE':
                calls_score = min(calls_score, 0)
            elif migration_state_bear == 'CONTACT':
                calls_score = min(calls_score, 15)
            elif migration_state_bear == 'STALLED':
                calls_score = int(calls_score * 0.5)

            # -- STRADDLE SCORE --
            straddle_score = 0
            both_growing = (row.get('above_pct_15m', 0) > 0.15 and above_abs >= 5_000_000 and
                           row.get('below_pct_15m', 0) > 0.15 and below_abs >= 5_000_000)
            if both_growing:
                straddle_score += 30
            if row.get('realized_vol', 0) > 2.0:
                straddle_score += 20
            if flip_count_30 > 4:
                straddle_score += 15
            if is_choppy:
                straddle_score += 20  # FIX B: chop days favor straddle
            if takeover_risk > 30 and takeover_risk < 70:
                straddle_score += 10
            if abs(calls_score - puts_score) < 15:
                straddle_score += 10

            # -- NO TRADE SCORE --
            no_trade_score = 0
            if persistence_bars < 5 and king_abs < 8_000_000:
                no_trade_score += 25
            if is_very_choppy:
                no_trade_score += 30  # FIX B: very choppy = sit out
            elif is_choppy:
                no_trade_score += 15
            if row.get('concentration', 0) > 0.5:
                no_trade_score += 15
            minute = row.get('minute_of_day', 0)
            if 720 <= minute <= 780:
                no_trade_score += 20
            if minute < 590 or minute > 930:
                no_trade_score += 25

            # -- SELECT REGIME --
            scores = {'CALLS': calls_score, 'PUTS': puts_score,
                     'STRADDLE': straddle_score, 'NO_TRADE': no_trade_score}
            regime = max(scores, key=scores.get)
            best_score = scores[regime]

            if best_score < 25:
                regime = 'NO_TRADE'
                best_score = no_trade_score

            prev_king_strike = king_strike
            prev_king_dir = king_dir

            results.append({
                'date': date,
                'frame': frame,
                'spot': spot,
                # New v3 features
                'king_dir': king_dir,
                'king_persistence': persistence_bars,
                'king_strength_5m': king_strength_5m,
                'king_strength_15m': king_strength_15m,
                'king_strengthening': 1 if king_strengthening else 0,
                'king_weakening': 1 if king_weakening else 0,
                'same_dir_targets': same_dir_targets,
                'same_dir_growth': round(same_dir_growth, 3),
                'king_migrated_same_dir': 1 if king_migrated_same_dir else 0,
                'takeover_risk': takeover_risk,
                'thesis_dir': thesis_dir,
                'thesis_bars': thesis_bars,
                'thesis_migration_count': thesis_migration_count,
                'dip_vs_structure': dip_vs_structure,
                'flip_count_30': flip_count_30,
                # Scores
                'v3_calls_score': calls_score,
                'v3_puts_score': puts_score,
                'v3_straddle_score': straddle_score,
                'v3_no_trade_score': no_trade_score,
                'v3_regime': regime,
                'v3_regime_score': best_score,
            })

    return pd.DataFrame(results)


def compare_engines(df, v3_df, date_str):
    """Side-by-side comparison of v2 vs v3 for one day."""

    day = df[df['date'] == date_str].sort_values('frame')
    v3_day = v3_df[v3_df['date'] == date_str].sort_values('frame')

    if len(day) == 0:
        return

    total_move = day.iloc[-1]['day_move']
    print(f'\n{"="*150}')
    print(f'  {date_str} | SPX {total_move:+.0f} | v2 vs v3 COMPARISON')
    print(f'{"="*150}')
    print(f'{"Time":>5} | {"Spot":>7} | {"King":>5} {"KDir":>5} {"Pers":>4} | {"v2 Regime":>10} {"v2":>3} | {"v3 Regime":>10} {"v3":>3} | {"Thesis":>7} {"ThBars":>5} {"Mig":>3} | {"Tkov":>4} | {"DipStr":>5} | {"30m":>5} | Changed?')
    print('-' * 150)

    merged = day.merge(v3_day[['date', 'frame', 'king_dir', 'king_persistence',
                                'same_dir_targets', 'same_dir_growth', 'king_migrated_same_dir',
                                'takeover_risk', 'thesis_dir', 'thesis_bars', 'thesis_migration_count',
                                'dip_vs_structure', 'flip_count_30',
                                'v3_calls_score', 'v3_puts_score', 'v3_straddle_score',
                                'v3_regime', 'v3_regime_score']],
                       on=['date', 'frame'], how='left')

    for _, row in merged.iterrows():
        if row['frame'] % 10 != 0:
            continue

        h = int(row['minute_of_day']) // 60
        m = int(row['minute_of_day']) % 60
        time_str = f'{h}:{m:02d}'

        v2_regime = row.get('regime', '?')
        v2_score = row.get('regime_score', 0)
        v3_regime = row.get('v3_regime', '?')
        v3_score = row.get('v3_regime_score', 0)

        king_dir = row.get('king_dir', '?')
        pers = row.get('king_persistence', 0)
        thesis = row.get('thesis_dir', '?')
        thesis_bars = row.get('thesis_bars', 0)
        mig = row.get('thesis_migration_count', 0)
        tkov = row.get('takeover_risk', 0)
        dip = row.get('dip_vs_structure', 0)

        move_30 = row.get('move_30m', float('nan'))
        m30 = f'{move_30:+.0f}' if not np.isnan(move_30) else ' ?'

        changed = '← CHANGED' if v2_regime != v3_regime else ''
        # Highlight improvements
        if changed:
            if v2_regime in ['PUTS', 'NO_TRADE'] and v3_regime == 'CALLS' and not np.isnan(move_30) and move_30 > 5:
                changed = '← FIXED (was wrong)'
            elif v2_regime == 'CALLS' and v3_regime in ['PUTS', 'STRADDLE'] and not np.isnan(move_30) and move_30 < -5:
                changed = '← FIXED (was wrong)'
            elif v2_regime == 'CALLS' and v3_regime == 'CALLS':
                changed = ''

        print(f'{time_str:>5} | ${row["spot"]:7.0f} | {row["king_strike"]:5.0f} {king_dir:>5} {pers:4.0f} | {v2_regime:>10} {v2_score:3.0f} | {v3_regime:>10} {v3_score:3.0f} | {thesis:>7} {thesis_bars:5.0f} {mig:3.0f} | {tkov:4.0f} | {dip:+5.0f} | {m30:>5} | {changed}')


def score_comparison(df, v3_df, date_str):
    """Compute aggregate accuracy of v2 vs v3 for one day."""

    day = df[df['date'] == date_str].sort_values('frame')
    v3_day = v3_df[v3_df['date'] == date_str].sort_values('frame')

    merged = day.merge(v3_day[['date', 'frame', 'v3_regime']], on=['date', 'frame'], how='left')
    entry = merged[(merged['minute_of_day'] >= 600) & (merged['minute_of_day'] <= 900)]
    entry = entry.dropna(subset=['move_30m'])

    for version, regime_col in [('v2', 'regime'), ('v3', 'v3_regime')]:
        calls_right = ((entry[regime_col] == 'CALLS') & (entry['move_30m'] > 5)).sum()
        calls_wrong = ((entry[regime_col] == 'CALLS') & (entry['move_30m'] < -5)).sum()
        calls_total = (entry[regime_col] == 'CALLS').sum()

        puts_right = ((entry[regime_col] == 'PUTS') & (entry['move_30m'] < -5)).sum()
        puts_wrong = ((entry[regime_col] == 'PUTS') & (entry['move_30m'] > 5)).sum()
        puts_total = (entry[regime_col] == 'PUTS').sum()

        straddle_right = ((entry[regime_col] == 'STRADDLE') & (entry['move_30m'].abs() > 8)).sum()
        straddle_total = (entry[regime_col] == 'STRADDLE').sum()

        total_right = calls_right + puts_right + straddle_right
        total_signals = calls_total + puts_total + straddle_total

        accuracy = total_right / total_signals if total_signals > 0 else 0
        print(f'  {version}: {total_right}/{total_signals} correct ({accuracy:.0%}) | C:{calls_right}/{calls_total} P:{puts_right}/{puts_total} S:{straddle_right}/{straddle_total}')


if __name__ == '__main__':
    print('Loading data...')
    df = pd.read_csv('research/regime_tagged.csv')

    print('Computing v3 features...')
    v3_df = compute_v3_features(df)
    v3_df.to_csv('research/regime_v5.csv', index=False)
    print(f'Saved {len(v3_df)} rows')

    # Compare on all 4 key days
    for date in ['2026-02-06', '2026-03-20', '2026-02-11', '2026-02-05']:
        compare_engines(df, v3_df, date)
        print(f'\n  Accuracy comparison for {date}:')
        score_comparison(df, v3_df, date)

    # Overall accuracy
    print(f'\n{"="*60}')
    print('OVERALL ACCURACY (all 7 days)')
    print(f'{"="*60}')

    all_merged = df.merge(v3_df[['date', 'frame', 'v3_regime']], on=['date', 'frame'], how='left')
    entry = all_merged[(all_merged['minute_of_day'] >= 600) & (all_merged['minute_of_day'] <= 900)]
    entry = entry.dropna(subset=['move_30m'])

    for version, regime_col in [('v2', 'regime'), ('v3', 'v3_regime')]:
        calls_right = ((entry[regime_col] == 'CALLS') & (entry['move_30m'] > 5)).sum()
        calls_total = (entry[regime_col] == 'CALLS').sum()
        puts_right = ((entry[regime_col] == 'PUTS') & (entry['move_30m'] < -5)).sum()
        puts_total = (entry[regime_col] == 'PUTS').sum()
        straddle_right = ((entry[regime_col] == 'STRADDLE') & (entry['move_30m'].abs() > 8)).sum()
        straddle_total = (entry[regime_col] == 'STRADDLE').sum()
        total_right = calls_right + puts_right + straddle_right
        total_signals = calls_total + puts_total + straddle_total
        accuracy = total_right / total_signals if total_signals > 0 else 0
        print(f'{version}: {total_right}/{total_signals} ({accuracy:.0%}) | C:{calls_right}/{calls_total} P:{puts_right}/{puts_total} S:{straddle_right}/{straddle_total}')
