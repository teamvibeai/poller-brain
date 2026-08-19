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
# - If brain IS idle (last IDLE_STREAK_MIN consolidation reports promoted
#   nothing) → skip, up to IDLE_FALLBACK_HOURS (default 7d), then force a
#   run anyway (long-idle check-in)
# - If <24h since last run → skip
#
# Idle-skip rationale (teamvibeai/poller-brain#168): a brain with nothing to
# promote still produced a full report every day under the old time-only gate
# (measured: DevGuru brain generated 9 consecutive daily reports 2026-08-05..
# 08-13 with zero core/semantic/episodic/procedural promotions each time,
# despite real commit activity every one of those days — routine session
# `log:` entries and automated report commits never stop, so "commits since
# last run" cannot distinguish a genuinely unproductive brain from a busy
# one; only the reports' own promotion outcome can). The skill itself
# intentionally has no partial/lightweight mode (skills/memory/consolidate/
# skill.md — reinstated 2026-04-29 after skipping steps broke the
# summary-md-regenerated eval criterion), so the fix belongs here at the
# trigger, not inside the run: skip the ENTIRE run (no report) once a streak
# of recent runs has promoted nothing, never a partial one. Mirrors
# reflection-guard.sh's cadence-gate pattern (poller-brain#157) applied to
# the opposite problem (running too often instead of too rarely).

BRAIN_DIR="${1:-.}"
REPORTS_DIR="$BRAIN_DIR/reports"
INTERVAL_HOURS=24
FALLBACK_HOURS=48
IDLE_FALLBACK_HOURS="${CONSOLIDATION_IDLE_FALLBACK_HOURS:-168}"  # 7 days
IDLE_STREAK_MIN="${CONSOLIDATION_IDLE_STREAK_MIN:-2}"  # consecutive zero-promotion reports required
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

# Returns 0 (true/idle) only when we can positively confirm that the last
# IDLE_STREAK_MIN consolidation reports each promoted nothing, per their own
# mandatory `## Tier Coverage` section (skills/memory/consolidate/skill.md
# Step 12 / MAINTENANCE.md "Tier coverage check" — every report MUST include
# a 4-line block, one per memory tier, each line either "Updated ..." or a
# "No new content/significant events/workflows — confirmed" pass line).
#
# Reads the *.md* report, not the JSON one: the JSON report is deleted by
# the platform almost immediately after commit (platform v0.1.54, see
# MAINTENANCE.md's "Report file age check" note) — confirmed empirically on
# two real brains (DevGuru review poller-brain#168 round 2: 81 JSON adds +
# 81 JSON deletes in the same repo, 0 JSON files on disk; same 0-JSON count
# reproduced on this brain). A JSON-based check is a permanent no-op on any
# brain running platform >= v0.1.54, so it can't be the source of truth here
# regardless of how it parses.
#
# This is a retrospective check on actual report outcomes, not a forward
# guess from commit volume — DevGuru brain's own evidence (poller-brain#168
# review round 1) showed commit counts of 35/41/43 on days that still
# produced zero promotions, so "commits since last run" cannot serve as an
# idle proxy at all. Any detection failure (no reports dir, fewer than
# IDLE_STREAK_MIN consolidation reports on record, unreadable report file,
# a report missing/malformed Tier Coverage section) returns 1 (not idle) —
# a failed check must never cause a silent skip; it falls through to the
# existing time-only policy instead.
is_idle_since_last_run() {
  [ -d "$REPORTS_DIR" ] || return 1

  local reports
  reports=$(find "$REPORTS_DIR" -maxdepth 1 -name '*-memory-consolidation.md' 2>/dev/null | sort | tail -n "$IDLE_STREAK_MIN")
  [ -z "$reports" ] && return 1

  local found=0
  local report
  while IFS= read -r report; do
    [ -n "$report" ] || continue
    found=$((found + 1))
    [ -r "$report" ] || return 1

    # Extract the Tier Coverage block (from its heading to the next `## `
    # heading or EOF) and require it to be non-empty -- an older/malformed
    # report without this mandatory section can't be positively confirmed
    # zero-promotion, so it must not count toward the idle streak.
    local section
    section=$(awk '/^## Tier Coverage/{flag=1; print; next} /^## /{if(flag) exit} flag' "$report")
    [ -z "$section" ] && return 1

    # Any tier line saying "Updated ..." means this report promoted
    # something -> streak broken. Matching "Updated" too loosely elsewhere
    # in the report would only risk a false "not idle" (an unnecessary run,
    # never a wrongful skip) since the search is confined to the Tier
    # Coverage block, which is exactly what the "safe failure direction"
    # principle calls for.
    if echo "$section" | grep -qi 'Updated'; then
      return 1   # this report promoted something -> streak broken, not idle
    fi
  done <<< "$reports"

  [ "$found" -ge "$IDLE_STREAK_MIN" ]
}

# Source of truth for "when did consolidation last actually run": the
# newest reports/*-memory-consolidation.md file, not the separately-maintained
# memory/.last_consolidation marker (poller-brain#346). The marker depends on
# a deterministic-but-external write (poller hook, tv#128/pb#109/#112) firing
# *after* a report is POSTed — three real incidents (07-29, 08-01, 08-12..08-19)
# all trace back to the report simply never being produced (pb#257/PR#262
# targets that root cause), which left the marker stale/desynced regardless of
# how faithfully the poller hook itself worked. It's also gitignored (local to
# the container), so a re-clone always starts from "no marker" even when the
# committed reports/ history goes back further. Reading the report filename
# directly removes that dependency: if no new report exists, there was no new
# consolidation, full stop. Mirrors the same find-and-parse pattern already
# used by is_idle_since_last_run() above.
#
# The filename date is when the *report* was written, which is normally the
# same day the run happened — except after a backfill/recovery run that
# processes an older gap (e.g. today's run producing a report for a period
# that started days ago): in that case this reads slightly stale until the
# run completes and writes today's report, at most delaying the *next*
# trigger by one skipped-then-caught-up cycle, never causing a missed run.
#
# `[0-9]*` (not the bare `*` used above in is_idle_since_last_run) excludes
# non-date-prefixed report names (e.g. a `recovery-memory-consolidation.md`
# style file) from winning `sort | tail -n 1` — letters sort after digits, so
# an unprefixed name would otherwise mask the real newest dated report and
# permanently fail-open every single heartbeat instead of just once.
LATEST_REPORT=$(find "$REPORTS_DIR" -maxdepth 1 -name '[0-9]*-memory-consolidation.md' 2>/dev/null | sort | tail -n 1)

if [ -z "$LATEST_REPORT" ]; then
  echo "consolidation_needed: true (no consolidation report found)"
  exit 0
fi

LAST_DATE=$(basename "$LATEST_REPORT" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')

if [ -z "$LAST_DATE" ]; then
  echo "consolidation_needed: true (cannot parse date from report filename: $(basename "$LATEST_REPORT"))"
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
    echo "consolidation_needed: true (idle but overdue — last ran ${ELAPSED_HOURS}h ago, last ${IDLE_STREAK_MIN} report(s) promoted nothing, idle fallback threshold ${IDLE_FALLBACK_HOURS}h — forcing check-in run)"
    exit 0
  else
    echo "consolidation_needed: false (idle-skip — last ran ${ELAPSED_HOURS}h ago, last ${IDLE_STREAK_MIN} report(s) promoted nothing, idle fallback threshold ${IDLE_FALLBACK_HOURS}h)"
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
