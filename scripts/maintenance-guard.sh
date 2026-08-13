#!/bin/bash
# Checks if maintenance consolidation should run.
# Exit 0 = consolidation needed, exit 1 = skip (not time yet, or idle brain).
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
# - If 48h+ since last run AND brain is NOT idle → run regardless of time (safety fallback)
# - If brain IS idle (no non-consolidation commits since last run) → skip, up to
#   IDLE_FALLBACK_HOURS (default 7d), then force a run anyway (long-idle check-in)
# - If <24h since last run → skip
#
# Idle-skip rationale (teamvibeai/poller-brain#168): a brain with zero session
# activity since its last consolidation still produced a full report every day
# under the old time-only gate (measured: DevGuru brain generated 9 consecutive
# daily reports 2026-08-05..08-13 with zero core/semantic/episodic promotions
# each time). The skill itself intentionally has no partial/lightweight mode
# (skills/memory/consolidate/skill.md — reinstated 2026-04-29 after skipping
# steps broke the summary-md-regenerated eval criterion), so the fix belongs
# here at the trigger, not inside the run: skip the ENTIRE run (no report) on
# an idle day, never a partial one. Mirrors reflection-guard.sh's cadence-gate
# pattern (poller-brain#157) applied to the opposite problem (running too
# often instead of too rarely).

BRAIN_DIR="${1:-.}"
GUARD_FILE="$BRAIN_DIR/memory/.last_consolidation"
INTERVAL_HOURS=24
FALLBACK_HOURS=48
IDLE_FALLBACK_HOURS="${CONSOLIDATION_IDLE_FALLBACK_HOURS:-168}"  # 7 days
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

# Returns 0 (true/idle) only when we can positively confirm zero
# non-consolidation commits since $LAST_DATE. Any detection failure (not a
# git repo, git missing, malformed date) returns 1 (not idle) — a failed
# check must never cause a silent skip; it falls through to the existing
# time-only policy instead.
is_idle_since_last_run() {
  if ! git -C "$BRAIN_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi
  local commit_count
  commit_count=$(git -C "$BRAIN_DIR" log --oneline --since="$LAST_DATE 00:00:00 UTC" \
    --invert-grep --grep='^chore: consolidate memory' 2>/dev/null | wc -l | tr -d '[:space:]')
  if ! [ "$commit_count" -ge 0 ] 2>/dev/null; then
    return 1
  fi
  [ "$commit_count" -eq 0 ]
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

# Case 1: Ran recently — always skip, regardless of idle state
if [ "$ELAPSED_HOURS" -lt "$INTERVAL_HOURS" ]; then
  echo "consolidation_needed: false (last ran ${ELAPSED_HOURS}h ago, threshold ${INTERVAL_HOURS}h)"
  exit 1
fi

# 24h+ elapsed from here on — check idle state before any time-based escalation.
if is_idle_since_last_run; then
  if [ "$ELAPSED_HOURS" -ge "$IDLE_FALLBACK_HOURS" ]; then
    echo "consolidation_needed: true (idle but overdue — last ran ${ELAPSED_HOURS}h ago with 0 non-consolidation commits, idle fallback threshold ${IDLE_FALLBACK_HOURS}h — forcing check-in run)"
    exit 0
  else
    echo "consolidation_needed: false (idle-skip — last ran ${ELAPSED_HOURS}h ago with 0 non-consolidation commits, idle fallback threshold ${IDLE_FALLBACK_HOURS}h)"
    exit 1
  fi
fi

# Not idle from here on — original time-only policy applies unchanged.

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
