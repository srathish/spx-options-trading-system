import re
from collections import defaultdict

trades = []
with open('data/batch-replay-results.txt') as f:
    for line in f:
        line = line.strip()
        m = re.match(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\|\s*(BULLISH|BEARISH)\s+(\w+)\s*\|\s*\S+\s*->\s*\S+\s*\|\s*([+-]?\s*[\d.]+)\s*pts\s*\|\s*(\w+)\s*\|\s*(WIN|LOSS)\s*\|\s*score=(\S+)', line)
        if m:
            dt, direction, pattern, pnl, exit_r, outcome, score = m.groups()
            try:
                score_f = float(score)
            except:
                score_f = 0
            hour = int(dt[11:13])
            conf = 'HIGH' if score_f >= 80 else ('MEDIUM' if score_f >= 60 else 'LOW')
            trades.append({'dt':dt, 'dir':direction, 'pat':pattern, 'pnl':float(pnl.replace(' ','')), 'exit':exit_r, 'out':outcome, 'score':score_f, 'hour':hour, 'conf':conf})

# 9AM MAGNET_PULL by confidence
print('9AM MAGNET_PULL by confidence:')
mp9 = defaultdict(lambda: {'w':0,'l':0,'net':0})
for t in trades:
    if t['pat'] == 'MAGNET_PULL' and t['hour'] == 9:
        mp9[t['conf']]['net'] += t['pnl']
        if t['out'] == 'WIN':
            mp9[t['conf']]['w'] += 1
        else:
            mp9[t['conf']]['l'] += 1
for c in ['LOW','MEDIUM','HIGH']:
    v = mp9[c]
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f'  {c}: {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f} ({tot} trades)')

# All patterns by confidence
print('\nAll patterns by confidence:')
all_conf = defaultdict(lambda: {'w':0,'l':0,'net':0})
for t in trades:
    all_conf[t['conf']]['net'] += t['pnl']
    if t['out'] == 'WIN':
        all_conf[t['conf']]['w'] += 1
    else:
        all_conf[t['conf']]['l'] += 1
for c in ['LOW','MEDIUM','HIGH']:
    v = all_conf[c]
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f'  {c}: {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f} ({tot} trades)')

# MEDIUM confidence (score 60-79) by hour
print('\nMEDIUM confidence (score 60-79) by hour:')
med_hour = defaultdict(lambda: {'w':0,'l':0,'net':0})
for t in trades:
    if t['conf'] == 'MEDIUM':
        med_hour[t['hour']]['net'] += t['pnl']
        if t['out'] == 'WIN':
            med_hour[t['hour']]['w'] += 1
        else:
            med_hour[t['hour']]['l'] += 1
for h in sorted(med_hour.keys()):
    v = med_hour[h]
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f'  {h:02}:00 {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f} ({tot} trades)')
