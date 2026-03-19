import sys, re

stats = {}
matched = 0

with open('data/batch-replay-results.txt') as f:
    for line in f:
        stripped = line.strip()
        if not stripped:
            continue
        # Pattern Performance lines start with a date like "2025-12-15 ..."
        m = re.match(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\|\s*(BULLISH|BEARISH)\s+(\w+)', stripped)
        if not m:
            continue
        parts = stripped.split('|')
        if len(parts) < 6:
            continue
        try:
            dt = parts[0].strip()
            dir_pat = parts[1].strip().split()
            direction = dir_pat[0]
            pattern = dir_pat[1]
            pnl_str = parts[3].strip().replace(' pts', '').strip()
            pnl = float(pnl_str)
            exit_r = parts[4].strip()
            outcome = parts[5].strip()
            matched += 1

            key = (direction, pattern)
            if key not in stats:
                stats[key] = {'w': 0, 'l': 0, 'net': 0.0}
            if outcome == 'WIN':
                stats[key]['w'] += 1
            else:
                stats[key]['l'] += 1
            stats[key]['net'] += pnl
        except Exception as e:
            continue

print(f'Matched: {matched} trades')
print('\nDirection/Pattern breakdown:')
for (d, p), v in sorted(stats.items(), key=lambda x: -x[1]['net']):
    total = v['w'] + v['l']
    wr = v['w']/total*100 if total > 0 else 0
    print(f'  {d:10} {p:20} {v["w"]}W/{v["l"]}L ({wr:.0f}%) NET: {v["net"]:+.2f}')
