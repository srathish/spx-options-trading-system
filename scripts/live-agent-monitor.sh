#!/bin/bash
# Live Agent Monitor - shows real-time progress of all strategy agents
# Usage: bash scripts/live-agent-monitor.sh
# Auto-refreshes every 15 seconds

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
NC='\033[0m'

TASK_DIR="/private/tmp/claude-501/-Users-saiyeeshrathish-spx-options-trading-system/tasks"
WORKTREE_DIR=".claude/worktrees"

while true; do
  clear
  echo -e "${BOLD}╔════════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║          🔬 SPX Strategy Agent Live Monitor                      ║${NC}"
  echo -e "${BOLD}║          Baseline: Mar9 +54.31 | Mar11 -25.47 | NET +28.84       ║${NC}"
  echo -e "${BOLD}║          Best so far: Progressive Loss Throttle NET +43.58        ║${NC}"
  echo -e "${BOLD}╚════════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}Last updated: $(date '+%H:%M:%S')  |  Refreshes every 15s  |  Ctrl+C to exit${NC}"
  echo ""

  # --- WORKTREE AGENTS ---
  echo -e "${BOLD}━━━ Worktree Agents (Code Changes) ━━━${NC}"
  echo ""

  if [ -d "$WORKTREE_DIR" ]; then
    for dir in "$WORKTREE_DIR"/agent-*/; do
      [ ! -d "$dir" ] && continue
      agent_name=$(basename "$dir")

      # Get branch and recent changes
      branch=$(cd "$dir" && git branch --show-current 2>/dev/null || echo "?")
      changed_files=$(cd "$dir" && git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
      last_file=$(cd "$dir" && git diff --name-only HEAD 2>/dev/null | tail -1)

      # Check for results file
      results=""
      if [ -f "$dir/STRATEGY_RESULTS.md" ]; then
        # Extract NET result
        net_line=$(grep -i 'NET\|net.*pts\|Total.*pts' "$dir/STRATEGY_RESULTS.md" 2>/dev/null | head -1)
        if [ -n "$net_line" ]; then
          results="$net_line"
        fi
      fi

      # Status
      if [ -n "$results" ]; then
        # Check if positive or negative
        if echo "$results" | grep -q '+'; then
          status="${GREEN}✅ DONE${NC}"
        else
          status="${RED}❌ DONE${NC}"
        fi
      elif [ "$changed_files" -gt 0 ] 2>/dev/null; then
        status="${YELLOW}⚡ ACTIVE${NC}"
      else
        status="${DIM}⏳ STARTING${NC}"
      fi

      echo -e "  ${BOLD}${agent_name}${NC}  [${status}]"
      if [ "$changed_files" -gt 0 ] 2>/dev/null; then
        echo -e "    ${DIM}Files: ${changed_files} changed | Latest: ${last_file}${NC}"
      fi
      if [ -n "$results" ]; then
        echo -e "    ${CYAN}Result: ${results}${NC}"
      fi
    done
  fi

  echo ""
  echo -e "${BOLD}━━━ Background Task Agents ━━━${NC}"
  echo ""

  # --- TASK OUTPUT FILES ---
  if [ -d "$TASK_DIR" ]; then
    for f in "$TASK_DIR"/*.output; do
      [ ! -f "$f" ] && continue
      task_id=$(basename "$f" .output)
      size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
      lines=$(wc -l < "$f" 2>/dev/null | tr -d ' ')

      # Get last meaningful line (skip empty lines)
      last_line=$(tail -20 "$f" 2>/dev/null | grep -v '^$' | tail -1 | cut -c1-80)

      # Check for completion markers
      if grep -q "STRATEGY_RESULTS\|Final Report\|## Results\|NET.*pts\|completed" "$f" 2>/dev/null; then
        net_result=$(grep -oE '(NET|net)[^0-9]*[+-]?[0-9]+\.?[0-9]*\s*pts' "$f" 2>/dev/null | tail -1)
        if [ -n "$net_result" ]; then
          if echo "$net_result" | grep -q '+'; then
            status="${GREEN}✅${NC}"
          else
            status="${RED}❌${NC}"
          fi
          echo -e "  ${status} ${BOLD}${task_id:0:12}...${NC}  ${CYAN}${net_result}${NC}"
        else
          echo -e "  ${GREEN}✅${NC} ${BOLD}${task_id:0:12}...${NC}  ${DIM}Done (${lines} lines)${NC}"
        fi
      elif [ "$size" -gt 100 ]; then
        echo -e "  ${YELLOW}⚡${NC} ${BOLD}${task_id:0:12}...${NC}  ${DIM}${lines} lines | ${last_line}${NC}"
      else
        echo -e "  ${DIM}⏳ ${task_id:0:12}...  Starting (${size}b)${NC}"
      fi
    done
  fi

  echo ""
  echo -e "${BOLD}━━━ Summary ━━━${NC}"
  total_wt=$(ls -d "$WORKTREE_DIR"/agent-*/ 2>/dev/null | wc -l | tr -d ' ')
  total_tasks=$(ls "$TASK_DIR"/*.output 2>/dev/null | wc -l | tr -d ' ')
  echo -e "  Worktrees: ${total_wt} | Task outputs: ${total_tasks}"

  sleep 15
done
