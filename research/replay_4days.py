"""
5-Minute Replay Tables for Feb 6, Mar 20, Feb 11, Feb 5

Shows regime, dominance, persistence, flip count, and annotated comments
for manual inspection.
"""

import pandas as pd
import numpy as np

def replay_day(df, date_str, comments=None):
    """Print a 5-minute replay table with annotations."""
    day = df[df['date'] == date_str].sort_values('frame')
    if len(day) == 0:
        print(f'No data for {date_str}')
        return

    total_move = day.iloc[-1]['day_move']
    print(f'\n{"="*140}')
    print(f'  {date_str} | SPX {total_move:+.0f}')
    print(f'{"="*140}')
    print(f'{"Time":>5} | {"Spot":>7} | {"Move":>5} | {"King":>5} | {"Upper":>20} | {"Lower":>20} | {"Dom":>5} | {"Flp":>3} | {"Per":>3} | {"Regime":>8} {"Scr":>3} | {"30m":>5} | {"Fail":>30} | Comment')
    print('-' * 140)

    for _, row in day.iterrows():
        if row['frame'] % 5 != 0:
            continue  # every 5 frames = 5 min

        h = int(row['minute_of_day']) // 60
        m = int(row['minute_of_day']) % 60
        time_str = f'{h}:{m:02d}'

        move = row['day_move']
        king = row['king_strike']

        # Upper node info
        if row['above_strike'] > 0 and row['above_abs'] > 0:
            up_sign = '+' if row['above_is_positive'] else '-'
            above_str = f"{row['above_strike']:.0f} {up_sign}{row['above_abs']/1e6:.0f}M {row['above_pct_15m']*100:+.0f}%"
        else:
            above_str = '—'

        # Lower node info
        if row['below_strike'] > 0 and row['below_abs'] > 0:
            lo_sign = '+' if row['below_is_positive'] else '-'
            below_str = f"{row['below_strike']:.0f} {lo_sign}{row['below_abs']/1e6:.0f}M {row['below_pct_15m']*100:+.0f}%"
        else:
            below_str = '—'

        move_30 = row.get('move_30m', float('nan'))
        m30 = f'{move_30:+.0f}' if not np.isnan(move_30) else ' ?'

        dom = row.get('node_dominance', 0)
        flip = row.get('flip_rate', 0) * 30  # convert to count per 30 frames
        pers = row.get('king_persistence', 0)
        regime = row.get('regime', '?')
        score = row.get('regime_score', 0)
        fail = row.get('failure_reason', '')
        if not fail or fail == 'nan' or (isinstance(fail, float) and np.isnan(fail)):
            fail = ''

        # Get manual comment if provided
        comment = ''
        if comments and row['frame'] in comments:
            comment = comments[row['frame']]

        print(f'{time_str:>5} | ${row["spot"]:7.0f} | {move:+5.0f} | {king:5.0f} | {above_str:>20} | {below_str:>20} | {dom:+5.0f} | {flip:3.0f} | {pers:3.0f} | {regime:>8} {score:3.0f} | {m30:>5} | {fail:>30} | {comment}')


if __name__ == '__main__':
    df = pd.read_csv('research/regime_tagged.csv')
    print(f'Loaded {len(df)} rows')

    # Feb 6 comments — key moments to inspect
    feb6_comments = {
        0: 'OPEN: 6835 neg magnet dominant, 6900 pos weak',
        10: '6910 pos node appears, starting to build',
        30: '6910 overtaking 6835 as dominant? Check dominance',
        55: '10:25 — first CALLS entry opportunity',
        85: '10:55 — price at 6883, 6910 still growing',
        120: '11:30 — 6925 starting to appear',
        150: '12:00 — 6910 reached +27M, target shift?',
        180: '12:30 — 6925 at +35M, new nodes building',
        240: '1:30 — massive gamma into 6910/6925',
        300: '2:30 — 6925 dominant, 6935 emerging',
        360: '3:30 — final push to 6935',
    }

    mar20_comments = {
        0: 'OPEN: 6500 neg magnet already huge',
        20: '9:50 — 6500 at -19M, starting to accelerate',
        30: '10:00 — 6500 at -32M, +76% growth',
        60: '10:30 — price at 6546, 6500 pulling hard',
        120: '11:30 — 6500 at -45M, persistence=60',
        180: '12:30 — 6500 still dominant, no node shift',
        240: '1:30 — 6500 accelerating, -35M',
        270: '2:00 — 6500 at -45M, approaching target',
        300: '2:30 — 6500 at -91M, massive build',
        330: '3:00 — within range of target',
    }

    feb11_comments = {
        0: 'OPEN: 6950 pos, 6900 neg — balanced',
        30: '10:00 — first sell pressure, 6900 growing',
        50: '10:20 — sharp drop to 6928, PUTS firing',
        80: '10:50 — bounce! 6980 building, FLIP',
        120: '11:30 — another flip, back to PUTS',
        150: '12:00 — STRADDLE territory, both growing',
        180: '12:30 — still flipping, chop_score high',
        210: '1:00 — dead zone, no edge',
        240: '1:30 — more flips, NO TRADE here',
        300: '2:30 — late day STRADDLE may work',
    }

    feb5_comments = {
        0: 'OPEN: minimal structure, 6900 pos weak',
        10: '9:40 — already -37 from open, fast selloff',
        30: '10:00 — 6745 neg node appearing, first signal?',
        50: '10:20 — 6720 at -5M, growing, PUTS viable',
        80: '10:50 — 6720 at -17M, strong but price bouncing',
        110: '11:20 — bounce to 6803, PERSISTENCE TEST',
        140: '11:50 — 6795 new node, shift from 6720',
        180: '12:30 — 6795 at -13M, stable for 60 bars',
        240: '1:30 — 6785 building, -38M, big acceleration',
        300: '2:30 — 6785 at -42M, final push down',
    }

    replay_day(df, '2026-02-06', feb6_comments)
    replay_day(df, '2026-03-20', mar20_comments)
    replay_day(df, '2026-02-11', feb11_comments)
    replay_day(df, '2026-02-05', feb5_comments)

    # Summary questions to answer per day
    print(f'\n{"="*80}')
    print('QUESTIONS TO ANSWER FROM MANUAL INSPECTION')
    print(f'{"="*80}')
    print("""
FEB 6 (+140 rally):
  Q1: At what frame did 6910 dominance FIRST exceed 6835? (dom > 0)
  Q2: How many consecutive bars was 6910 dominant before the move started?
  Q3: Was acceptance_up positive before or after the entry?
  Q4: When did 6925 first appear as a valid target shift?
  Q5: Could a straddle at open have been better than waiting for direction?

MAR 20 (-116 selloff):
  Q1: Was 6500 node growing BEFORE or AFTER price started dropping?
  Q2: At what persistence level did the move accelerate?
  Q3: Was price already below VWAP when the node started building?
  Q4: Did the node ever lose >30% from peak? (would our exit have fired?)
  Q5: Why did some PUTS signals fail in the 11:30-12:30 window?

FEB 11 (+3 chop):
  Q1: What was the max persistence of ANY node today?
  Q2: How many times did dominance cross zero?
  Q3: At what flip_count threshold would ALL directional signals have been blocked?
  Q4: Were there ANY windows of genuine persistence (>20 bars)?
  Q5: Would STRADDLE_ONLY mode have been profitable?

FEB 5 (-86 selloff):
  Q1: First frame where a negative node persisted >15 bars?
  Q2: When did dominance first go strongly negative (< -30)?
  Q3: Was there a point where straddle should have converted to puts?
  Q4: What made the 11:30-12:30 bounce "fake" vs the selloff "real"?
  Q5: Could persistence_score have distinguished the two?
    """)
