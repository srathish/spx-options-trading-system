#!/bin/bash
# Agent Strategy Tracker - shows status of all worktree agents
# Usage: watch -n 10 bash scripts/track-agents.sh

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           SPX Strategy Agent Tracker                        ║${NC}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║  Baseline: Mar9 +54.31 | Mar11 -25.47 | NET +28.84         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

WORKTREE_DIR=".claude/worktrees"

if [ ! -d "$WORKTREE_DIR" ]; then
  echo "No worktrees found."
  exit 0
fi

for dir in "$WORKTREE_DIR"/agent-*/; do
  if [ ! -d "$dir" ]; then continue; fi

  agent_name=$(basename "$dir")

  # Check for results file
  results_file="$dir/STRATEGY_RESULTS.md"
  replay_log="$dir/replay-output.log"

  # Check git log for recent changes
  branch=$(cd "$dir" && git branch --show-current 2>/dev/null || echo "unknown")
  last_commit=$(cd "$dir" && git log --oneline -1 2>/dev/null || echo "no commits")
  changed_files=$(cd "$dir" && git diff --name-only HEAD~1 2>/dev/null | wc -l | tr -d ' ')

  # Try to find strategy description
  strategy_desc=""
  if [ -f "$results_file" ]; then
    strategy_desc=$(head -1 "$results_file" | sed 's/^# //')
  fi

  # Check if replay was run and get results
  replay_result=""
  if [ -f "$replay_log" ]; then
    # Look for net P&L in replay output
    net_pnl=$(grep -o 'NET:.*pts' "$replay_log" 2>/dev/null | tail -1)
    if [ -n "$net_pnl" ]; then
      replay_result="$net_pnl"
    fi
  fi

  # Also check for results in any .txt or .log files
  if [ -z "$replay_result" ]; then
    for f in "$dir"/*.log "$dir"/*.txt; do
      if [ -f "$f" ]; then
        net_pnl=$(grep -o 'NET:.*pts' "$f" 2>/dev/null | tail -1)
        if [ -n "$net_pnl" ]; then
          replay_result="$net_pnl"
          break
        fi
      fi
    done
  fi

  # Status indicator
  if [ -n "$replay_result" ]; then
    status="${GREEN}✓ DONE${NC}"
  elif [ "$changed_files" -gt 0 ] 2>/dev/null; then
    status="${YELLOW}⚙ WORKING${NC}"
  else
    status="${CYAN}◌ PENDING${NC}"
  fi

  echo -e "${BOLD}${agent_name}${NC} [${status}]"
  echo -e "  Branch: ${branch}"
  echo -e "  Last: ${last_commit}"
  [ -n "$strategy_desc" ] && echo -e "  Strategy: ${CYAN}${strategy_desc}${NC}"
  [ -n "$replay_result" ] && echo -e "  Result: ${BOLD}${replay_result}${NC}"
  [ "$changed_files" -gt 0 ] 2>/dev/null && echo -e "  Files changed: ${changed_files}"
  echo ""
done

echo -e "${BOLD}─── Summary ───${NC}"
total=$(ls -d "$WORKTREE_DIR"/agent-*/ 2>/dev/null | wc -l | tr -d ' ')
echo "Total agents: $total"
echo "Updated: $(date '+%H:%M:%S')"
