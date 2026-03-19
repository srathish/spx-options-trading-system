import re

wins, losses = [], []
with open('data/batch-replay-results.txt') as f:
    for line in f:
        line = line.strip()
        # Pattern lines with time in 9:33-9:49
        m = re.match(r'^(\d{4}-\d{2}-\d{2} 09:[3-4]\d:\d{2})\s*\|\s*(BULLISH|BEARISH)\s+(\w+)\s*\|\s*\S+\s*->\s*\S+\s*\|\s*([+-]?\s*[\d.]+)\s*pts\s*\|\s*(\w+)\s*\|\s*(WIN|LOSS)', line)
        if not m:
            continue
        dt, direction, pattern, pnl, exit_r, outcome = m.groups()
        pnl = float(pnl.replace(' ',''))
        if outcome == 'WIN':
            wins.append({'dt': dt, 'pnl': pnl, 'exit': exit_r, 'dir': direction, 'pat': pattern})
        else:
            losses.append({'dt': dt, 'pnl': pnl, 'exit': exit_r, 'dir': direction, 'pat': pattern})

total_win = sum(x['pnl'] for x in wins)
total_loss = sum(x['pnl'] for x in losses)
print(f"9:33-9:49 window:")
print(f"  Wins: {len(wins)} | total: {total_win:+.2f}")
print(f"  Losses: {len(losses)} | total: {total_loss:+.2f}")
print(f"  Net: {total_win + total_loss:+.2f}")

print("\nTop 8 wins:")
for x in sorted(wins, key=lambda x: -x['pnl'])[:8]:
    print(f"  {x['dt']} {x['dir']} {x['pat']} +{x['pnl']:.2f} {x['exit']}")

print("\nPattern breakdown:")
from collections import defaultdict
stats = defaultdict(lambda: {'w':0,'l':0,'net':0})
for x in wins:
    k = x['dir'] + ' ' + x['pat']
    stats[k]['w'] += 1
    stats[k]['net'] += x['pnl']
for x in losses:
    k = x['dir'] + ' ' + x['pat']
    stats[k]['l'] += 1
    stats[k]['net'] += x['pnl']
for k, v in sorted(stats.items(), key=lambda x: x[1]['net']):
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f"  {k:35} {v['w']}W/{v['l']}L ({wr:.0f}%) NET: {v['net']:+.2f}")
