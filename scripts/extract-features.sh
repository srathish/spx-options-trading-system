#!/bin/bash
# Extract ML training features from all replay days (per-file mode, matches batch-replay.sh)
cd /Users/saiyeeshrathish/spx-options-trading-system

FEATURES_FILE="data/ml-training-data.json"
TEMP_DIR=$(mktemp -d)

echo "Extracting ML features from replay data..."

for json_file in data/gex-replay-202[56]-*.json; do
  date=$(echo "$json_file" | grep -oE '202[56]-[0-9]{2}-[0-9]{2}')
  # Run replay per file (same as batch-replay.sh) with features output to temp
  node -e "
    import { replayJsonFile } from './src/backtest/replay-json.js';
  " 2>/dev/null
  # Use --features on single file
  node src/backtest/replay-json.js "$json_file" --quiet --features-stdout 2>/dev/null
done | node -e "
  const lines = [];
  process.stdin.setEncoding('utf8');
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => {
    try {
      const trades = JSON.parse('[' + data.split('\n').filter(l => l.trim()).join(',') + ']');
      require('fs').writeFileSync('$FEATURES_FILE', JSON.stringify(trades, null, 2));
      console.log('Features: ' + trades.length + ' trades written to $FEATURES_FILE');
    } catch(e) { console.error(e); }
  });
"
