#!/bin/bash
# Checks if maintenance consolidation should run.
# Exit 0 = consolidation needed, exit 1 = skip (not time yet).
# Usage: bash scripts/maintenance-guard.sh [brain_dir]
#
# brain_dir defaults to current working directory.
#
# Consolidation ("dreaming") should run during quiet hours to avoid
# disrupting active user sessions. Mid-day consolidation can cause the
# bot to "forget" things the user said minutes ago (TODAY.md gets archived
# and reset). Nighttime runs are more natural — like sleep-based memory
# consolidation.
#
# Policy:
# - Preferred window: 00:00–06:00 UTC (configurable via CONSOLIDATION_WINDOW_START/END)
# - If 24h+ since last run AND inside the window → run
# - If 48h+ since last run → run regardless of time (safety fallback)
# - If <24h since last run → skip

BRAIN_DIR="${1:-.}"
GUARD_FILE="$BRAIN_DIR/memory/.last_consolidation"
INTERVAL_HOURS=24
FALLBACK_HOURS=48
WINDOW_START="${CONSOLIDATION_WINDOW_START:-0}"   # hour UTC (inclusive)
WINDOW_END="${CONSOLIDATION_WINDOW_END:-6}"       # hour UTC (exclusive)

# Get current UTC hour
CURRENT_HOUR=$(date -u +%H | sed 's/^0//')
if [ -z "$CURRENT_HOUR" ]; then
  CURRENT_HOUR=0
fi

# Check if we're inside the preferred consolidation window
in_window() {
  if [ "$WINDOW_START" -lt "$WINDOW_END" ]; then
    # Normal range (e.g., 0-6)
    [ "$CURRENT_HOUR" -ge "$WINDOW_START" ] && [ "$CURRENT_HOUR" -lt "$WINDOW_END" ]
  else
    # Wrapping range (e.g., 22-6)
    [ "$CURRENT_HOUR" -ge "$WINDOW_START" ] || [ "$CURRENT_HOUR" -lt "$WINDOW_END" ]
  fi
}

if [ ! -f "$GUARD_FILE" ]; then
  echo "consolidation_needed: true (no guard file found)"
  exit 0
fi

LAST_DATE=$(cat "$GUARD_FILE" | tr -d '[:space:]')

if [ -z "$LAST_DATE" ]; then
  echo "consolidation_needed: true (guard file empty)"
  exit 0
fi

# Parse date and compare (works on both macOS and Linux)
if date -d "$LAST_DATE" +%s >/dev/null 2>&1; then
  # GNU date (Linux)
  LAST_EPOCH=$(date -d "$LAST_DATE" +%s)
elif date -j -f "%Y-%m-%d" "$LAST_DATE" +%s >/dev/null 2>&1; then
  # BSD date (macOS)
  LAST_EPOCH=$(date -j -f "%Y-%m-%d" "$LAST_DATE" +%s)
else
  echo "consolidation_needed: true (cannot parse date: $LAST_DATE)"
  exit 0
fi

NOW_EPOCH=$(date +%s)
ELAPSED_HOURS=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))

# Case 1: Ran recently — always skip
if [ "$ELAPSED_HOURS" -lt "$INTERVAL_HOURS" ]; then
  echo "consolidation_needed: false (last ran ${ELAPSED_HOURS}h ago, threshold ${INTERVAL_HOURS}h)"
  exit 1
fi

# Case 2: Overdue (48h+) — run regardless of time window (safety fallback)
if [ "$ELAPSED_HOURS" -ge "$FALLBACK_HOURS" ]; then
  echo "consolidation_needed: true (overdue — last ran ${ELAPSED_HOURS}h ago, fallback threshold ${FALLBACK_HOURS}h, running outside window)"
  exit 0
fi

# Case 3: Due (24h+) — only run inside the preferred window
if in_window; then
  echo "consolidation_needed: true (last ran ${ELAPSED_HOURS}h ago, inside window ${WINDOW_START}:00-${WINDOW_END}:00 UTC)"
  exit 0
else
  echo "consolidation_needed: false (last ran ${ELAPSED_HOURS}h ago, outside window ${WINDOW_START}:00-${WINDOW_END}:00 UTC, current hour ${CURRENT_HOUR} UTC)"
  exit 1
fi
