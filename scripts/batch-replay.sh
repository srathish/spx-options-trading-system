#!/bin/bash
# Batch replay - runs replay-json.js across all GEX replay data files
# Outputs summary results for each day

cd /Users/saiyeeshrathish/spx-options-trading-system

RESULTS_FILE="data/batch-replay-results.txt"
echo "=== BATCH REPLAY RESULTS ===" > "$RESULTS_FILE"
echo "Run: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

TOTAL_PNL=0
TOTAL_TRADES=0
TOTAL_WINS=0
TOTAL_LOSSES=0

for json_file in data/gex-replay-202[56]-*.json; do
  date=$(echo "$json_file" | grep -oE '202[56]-[0-9]{2}-[0-9]{2}')
  echo "Replaying $date..."

  # Run replay and capture output
  output=$(node src/backtest/replay-json.js "$json_file" 2>&1)

  if [ $? -ne 0 ]; then
    echo "  ❌ ERROR"
    echo "[$date] ERROR: $output" >> "$RESULTS_FILE"
    echo "" >> "$RESULTS_FILE"
    continue
  fi

  # Extract key metrics from the SUMMARY line (last line of replay output)
  summary_line=$(echo "$output" | grep '^SUMMARY:')
  trades=$(echo "$summary_line" | grep -oE '[0-9]+ trades' | grep -oE '[0-9]+')
  wins=$(echo "$summary_line" | grep -oE '[0-9]+W' | grep -oE '[0-9]+')
  losses=$(echo "$summary_line" | grep -oE '[0-9]+L' | grep -oE '[0-9]+')
  net_pnl=$(echo "$summary_line" | grep -oE 'NET: [+-]?[0-9]+\.?[0-9]*' | grep -oE '[+-]?[0-9]+\.?[0-9]*')

  [ -z "$trades" ] && trades=0
  [ -z "$wins" ] && wins=0
  [ -z "$losses" ] && losses=0
  [ -z "$net_pnl" ] && net_pnl=0

  echo "  $trades trades | ${wins}W/${losses}L | NET: $net_pnl pts"

  # Accumulate
  TOTAL_TRADES=$((TOTAL_TRADES + trades))
  TOTAL_WINS=$((TOTAL_WINS + wins))
  TOTAL_LOSSES=$((TOTAL_LOSSES + losses))
  # Strip leading + sign (bc can't parse "0 + +3.5")
  clean_pnl=$(echo "$net_pnl" | sed 's/^+//')
  TOTAL_PNL=$(echo "$TOTAL_PNL + $clean_pnl" | bc 2>/dev/null || echo "$TOTAL_PNL")

  # Save full output
  echo "=== [$date] ===" >> "$RESULTS_FILE"
  echo "$output" >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"
done

echo "" >> "$RESULTS_FILE"
echo "=== GRAND TOTAL ===" >> "$RESULTS_FILE"
DAY_COUNT=$(ls data/gex-replay-202[56]-*.json 2>/dev/null | wc -l | tr -d ' ')
echo "Days: $DAY_COUNT | Trades: $TOTAL_TRADES | Wins: $TOTAL_WINS | Losses: $TOTAL_LOSSES | NET: $TOTAL_PNL pts" >> "$RESULTS_FILE"

echo ""
echo "=== GRAND TOTAL ==="
echo "Days: $DAY_COUNT | Trades: $TOTAL_TRADES | Wins: $TOTAL_WINS | Losses: $TOTAL_LOSSES | NET: $TOTAL_PNL pts"
echo ""
echo "Full results saved to: $RESULTS_FILE"
