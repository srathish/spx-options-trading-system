import re
from collections import defaultdict, Counter

trades = []
with open('data/batch-replay-results.txt') as f:
    for line in f:
        line = line.strip()
        m = re.match(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\|\s*(BULLISH|BEARISH)\s+(\w+)\s*\|\s*\S+\s*->\s*\S+\s*\|\s*([+-]?\s*[\d.]+)\s*pts\s*\|\s*(\w+)\s*\|\s*(WIN|LOSS)\s*\|\s*score=(\S+)', line)
        if m:
            dt, direction, pattern, pnl, exit_r, outcome, score = m.groups()
            try:
                score = float(score)
            except:
                score = 0
            hour = int(dt[11:13])
            trades.append({'dt':dt, 'dir':direction, 'pat':pattern, 'pnl':float(pnl.replace(' ','')), 'exit':exit_r, 'out':outcome, 'score':score, 'hour':hour})

print(f'Total trades parsed: {len(trades)}')

# Score distribution for MAGNET_PULL
print('\n=== MAGNET_PULL entry score distribution ===')
score_buckets = defaultdict(lambda: {'w':0,'l':0,'net':0})
for t in trades:
    if t['pat'] != 'MAGNET_PULL':
        continue
    bucket = int(t['score'] // 10) * 10
    score_buckets[bucket]['net'] += t['pnl']
    if t['out'] == 'WIN':
        score_buckets[bucket]['w'] += 1
    else:
        score_buckets[bucket]['l'] += 1
for b in sorted(score_buckets.keys()):
    v = score_buckets[b]
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f'  Score {b}-{b+9}: {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f} ({tot} trades)')

# Score for STOP_HIT MAGNET_PULL
print('\n=== MAGNET_PULL STOP_HIT entry score distribution ===')
stop_scores = [t['score'] for t in trades if t['pat'] == 'MAGNET_PULL' and t['exit'] in ('STOP_HIT', 'TM_STOP_HIT')]
score_counts = Counter(int(s) for s in stop_scores)
for s in sorted(score_counts.keys()):
    print(f'  Score {s}: {score_counts[s]} stop hits')

# Win MAGNET_PULL
print('\n=== MAGNET_PULL WIN entry score distribution ===')
win_scores = [t['score'] for t in trades if t['pat'] == 'MAGNET_PULL' and t['out'] == 'WIN']
win_counts = Counter(int(s) for s in win_scores)
for s in sorted(win_counts.keys()):
    print(f'  Score {s}: {win_counts[s]} wins')

# Score bucket for all patterns
print('\n=== ALL PATTERNS score bucket performance ===')
all_buckets = defaultdict(lambda: {'w':0,'l':0,'net':0})
for t in trades:
    bucket = int(t['score'] // 10) * 10
    all_buckets[bucket]['net'] += t['pnl']
    if t['out'] == 'WIN':
        all_buckets[bucket]['w'] += 1
    else:
        all_buckets[bucket]['l'] += 1
for b in sorted(all_buckets.keys()):
    v = all_buckets[b]
    tot = v['w'] + v['l']
    wr = v['w']/tot*100 if tot > 0 else 0
    print(f'  Score {b}-{b+9}: {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f} ({tot} trades)')
