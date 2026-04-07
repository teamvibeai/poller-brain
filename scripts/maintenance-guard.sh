#!/bin/bash
# Checks if maintenance consolidation should run.
# Exit 0 = consolidation needed, exit 1 = skip (ran recently).
# Usage: bash scripts/maintenance-guard.sh [brain_dir]
#
# brain_dir defaults to current working directory.

BRAIN_DIR="${1:-.}"
GUARD_FILE="$BRAIN_DIR/memory/.last_consolidation"
INTERVAL_HOURS=24

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

if [ "$ELAPSED_HOURS" -lt "$INTERVAL_HOURS" ]; then
  echo "consolidation_needed: false (last ran ${ELAPSED_HOURS}h ago, threshold ${INTERVAL_HOURS}h)"
  exit 1
fi

echo "consolidation_needed: true (last ran ${ELAPSED_HOURS}h ago, threshold ${INTERVAL_HOURS}h)"
exit 0
