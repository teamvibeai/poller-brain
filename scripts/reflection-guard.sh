#!/bin/bash
# Checks if memory reflection should run, and reports reflection cadence status.
# Exit 0 = reflection needed, exit 1 = skip (recent enough).
# Usage: bash scripts/reflection-guard.sh [brain_dir]
#
# brain_dir defaults to current working directory.
#
# Mirrors scripts/maintenance-guard.sh's mechanical-gate pattern (poller-brain#157).
# Previously, reflection cadence was enforced only by a prose instruction in
# MAINTENANCE.md's "Twice Weekly" section ("if 3+ days old, run"), evaluated
# by the agent itself each session -- the same class of bug documented
# repeatedly elsewhere (text rules alone don't prevent recidivism; a
# mechanical gate does). This script makes the decision deterministic and
# also emits the fields needed for the consolidation report's
# `reflectionStatus` JSON schema field.
#
# Unlike maintenance-guard.sh, there is no separate marker file: the source
# of truth is the newest memory/episodic/reflection-*.md filename itself,
# which is self-verifying (can't drift out of sync with a marker).
#
# Policy:
# - No prior reflection-*.md file -> reflection needed (isOverdue=true)
# - daysSinceReflection >= REFLECTION_OVERDUE_THRESHOLD_DAYS:
#   - if no consolidation report since the last reflection promoted anything
#     (idle since last reflection, poller-brain#171 follow-up) -> skip,
#     unless daysSinceReflection >= REFLECTION_IDLE_FALLBACK_DAYS (forced
#     check-in, same rationale as maintenance-guard.sh's IDLE_FALLBACK_HOURS)
#   - otherwise -> reflection needed
# - Otherwise (daysSinceReflection < threshold) -> skip
#
# Idle-skip rationale (teamvibeai/poller-brain#171, follow-up to #168): #168
# already stops consolidation itself from producing ritual reports on a
# chronically idle brain, but reflection-guard kept firing on the fixed
# REFLECTION_OVERDUE_THRESHOLD_DAYS regardless -- a brain with nothing new
# promoted since its last reflection still got a full reflection run every
# 3 days, reviewing the same (or now entirely absent, thanks to #168's own
# skip) consolidation output. is_idle_since_last_reflection() below mirrors
# maintenance-guard.sh's is_idle_since_last_run() (#168) but scoped to the
# window since the last reflection date rather than a fixed report-count
# streak, since it's reflection's own cadence being gated here, not a
# rolling window. It deliberately treats ZERO consolidation reports since
# the last reflection as idle too (not just reports with no "Updated" line)
# -- #168 means a chronically idle brain now produces no report at all on
# idle days, so "no reports since last reflection" and "reports since last
# reflection but none promoted anything" are the same signal and must skip
# the same way -- PROVIDED consolidation itself is actually still running
# (see the staleness check below); it must not be conflated with
# consolidation being stalled/broken entirely.

BRAIN_DIR="${1:-.}"
REFLECTION_DIR="$BRAIN_DIR/memory/episodic"
REPORTS_DIR="$BRAIN_DIR/reports"
OVERDUE_THRESHOLD_DAYS="${REFLECTION_OVERDUE_THRESHOLD_DAYS:-3}"
IDLE_FALLBACK_DAYS="${REFLECTION_IDLE_FALLBACK_DAYS:-7}"
# Same env var maintenance-guard.sh uses for its own forced check-in cap --
# deliberately shared, not a second knob to keep in sync: a healthy brain's
# newest consolidation report is never older than this by construction
# (#168 forces a run at that point), so it doubles for free as the
# discriminator between "healthy idle" and "consolidation stalled/broken"
# below (DevGuru review, poller-brain#391 round 1).
CONSOLIDATION_STALE_FALLBACK_HOURS="${CONSOLIDATION_IDLE_FALLBACK_HOURS:-168}"

# Parses a YYYY-MM-DD date string to UTC-midnight epoch seconds on stdout;
# returns 1 if unparseable (GNU vs BSD date fallback, same shape as the
# top-level LAST_DATE parse further down). Local helper so the fallback
# isn't duplicated a further two times inside this function; it's still
# duplicated against maintenance-guard.sh's own copies of the same pattern
# -- flagged as a cross-script follow-up, out of scope for this pass
# (DevGuru review, poller-brain#391 round 1, nit b).
_epoch_of() {
  local d="$1"
  date -u -d "$d 00:00:00 UTC" +%s 2>/dev/null && return 0
  date -u -j -f "%Y-%m-%d" "$d" +%s 2>/dev/null && return 0
  return 1
}

# Returns 0 (true/idle) only when:
#   (a) the newest consolidation report on disk, of ANY date, is no older
#       than CONSOLIDATION_STALE_FALLBACK_HOURS -- otherwise consolidation
#       itself looks stalled/broken (exactly the class of incident
#       maintenance-guard.sh's own header cites: 07-29/08-01/08-12..08-19),
#       and a broken pipeline must never be read as "healthy idle": without
#       this check, a report 40 days stale would idle-skip reflection
#       forever with isOverdue staying false, silently passing the
#       reflection-overdue eval criterion the whole time (DevGuru review,
#       poller-brain#391 round 1); AND
#   (b) every consolidation report dated on/after $1 (the last reflection
#       date) positively confirms, via its own mandatory Tier Coverage
#       section, that it promoted nothing. Same-date reports are included
#       (>=, not >) since daily-granularity filenames can't order same-day
#       reflection-vs-consolidation runs within a day, and silently
#       excluding a same-day report that had "Updated" would hide real new
#       content from this check -- costs at most one extra (harmless) run
#       in the other direction (DevGuru review, poller-brain#391 round 1,
#       nit a). Direct consequence of that same >=: the reflection that
#       runs on a brain's *first* threshold-hit after any productive day
#       always counts as "not idle" (its own same-date report still has
#       "Updated"), even if the brain has gone fully quiet since. Idle-skip
#       only engages starting the NEXT threshold-hit, once a full
#       consolidation report exists that postdates that reflection and
#       shows nothing promoted. This is expected, not a bug -- named here
#       so it doesn't read as broken idle-skip later (DevGuru review,
#       poller-brain#391 round 2).
# Any detection failure (no reports dir, no reports at all, unreadable
# report, missing/malformed Tier Coverage section) returns 1 (not idle) --
# a failed check must never cause a silent skip; it falls through to the
# existing threshold-only policy.
is_idle_since_last_reflection() {
  local since_date="$1" since_epoch report report_date report_epoch section
  local newest_report newest_date newest_epoch fallback_seconds
  # Not part of this function's inputs -- defaults to "now" so a future
  # caller that doesn't happen to have the top-level NOW_EPOCH assignment
  # run first yet gets a correct age, not a silent always-fresh false
  # negative (empty NOW_EPOCH would make the subtraction below negative,
  # so the staleness check would always pass and no failure branch would
  # fire -- DevGuru review, poller-brain#391 round 2 nit).
  local now_epoch="${NOW_EPOCH:-$(date -u +%s)}"

  [ -d "$REPORTS_DIR" ] || return 1

  newest_report=$(find "$REPORTS_DIR" -maxdepth 1 -name '[0-9]*-memory-consolidation.md' 2>/dev/null | sort | tail -n 1)
  [ -z "$newest_report" ] && return 1

  newest_date=$(basename "$newest_report" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
  [ -n "$newest_date" ] || return 1
  newest_epoch=$(_epoch_of "$newest_date") || return 1

  fallback_seconds=$(( CONSOLIDATION_STALE_FALLBACK_HOURS * 3600 ))
  [ $(( now_epoch - newest_epoch )) -gt "$fallback_seconds" ] && return 1

  since_epoch=$(_epoch_of "$since_date") || return 1

  for report in "$REPORTS_DIR"/[0-9]*-memory-consolidation.md; do
    [ -e "$report" ] || continue
    report_date=$(basename "$report" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
    [ -n "$report_date" ] || continue
    report_epoch=$(_epoch_of "$report_date") || continue
    [ "$report_epoch" -ge "$since_epoch" ] || continue

    [ -r "$report" ] || return 1
    section=$(awk '/^## Tier Coverage/{flag=1; print; next} /^## /{if(flag) exit} flag' "$report")
    [ -z "$section" ] && return 1
    if echo "$section" | grep -qi 'Updated'; then
      return 1
    fi
  done

  return 0
}

emit_status() {
  # $1=lastDate(or empty) $2=daysSince(or empty) $3=isOverdue(true/false) $4=nonConformingCount(default 0) $5=idleSkipped(true/false, default false)
  local last_date_json="null"
  local days_since_json="null"
  local nonconforming="${4:-0}"
  local idle_skipped="${5:-false}"
  [ -n "$1" ] && last_date_json="\"$1\""
  [ -n "$2" ] && days_since_json="$2"
  echo "REFLECTION_STATUS_JSON: {\"lastReflectionDate\":${last_date_json},\"daysSinceReflection\":${days_since_json},\"overdueThresholdDays\":${OVERDUE_THRESHOLD_DAYS},\"isOverdue\":$3,\"nonConformingReflectionFiles\":${nonconforming},\"idleSkipped\":${idle_skipped}}"
}

ALL_REFLECTION_FILES=$(ls "$REFLECTION_DIR"/reflection-*.md 2>/dev/null)
# Filter to the strict reflection-YYYY-MM-DD.md shape BEFORE sort|tail --
# `ls | sort | tail -1` alone picks the lexicographically last filename, not
# the most recent date, so any non-dated file (e.g. reflection-template.md)
# would permanently shadow real dated entries (DevGuru review pb#157).
LATEST_FILE=$(echo "$ALL_REFLECTION_FILES" | grep -E '/reflection-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | sort | tail -n 1)

# Computed unconditionally (not just in the empty-LATEST_FILE branch) --
# a non-conforming file (e.g. reflection-template.md, or a split
# reflection-2026-08-12-part2.md) can coexist with a real dated file, and
# nonConformingReflectionFiles must reflect that too, not just report 0
# whenever a dated file happens to be found (DevGuru review pb#157 round 3b).
NONCONFORMING=$(echo "$ALL_REFLECTION_FILES" | grep -vE '/reflection-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | grep -c .)
NONCONFORMING_NAMES=$(echo "$ALL_REFLECTION_FILES" | grep -vE '/reflection-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | xargs -n1 basename 2>/dev/null | tr '\n' ' ')

if [ -z "$LATEST_FILE" ]; then
  # Distinguish "never reflected" from "reflected, but under a filename the
  # guard can't parse" (e.g. reflection-2026-08-12-part2.md) -- both hit
  # this branch, but they're very different fleet states and were
  # indistinguishable in the output (DevGuru review pb#157 round 3).
  if [ "$NONCONFORMING" -gt 0 ]; then
    echo "reflection_needed: true (no dated reflection-*.md found, but $NONCONFORMING non-conforming file(s): $NONCONFORMING_NAMES)"
  else
    echo "reflection_needed: true (no prior reflection-*.md found)"
  fi
  emit_status "" "" "true" "$NONCONFORMING"
  exit 0
fi

BASENAME=$(basename "$LATEST_FILE")
LAST_DATE=$(echo "$BASENAME" | sed -E 's/^reflection-([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/\1/')

if [ "$LAST_DATE" = "$BASENAME" ] || [ -z "$LAST_DATE" ]; then
  echo "reflection_needed: true (cannot parse date from filename: $BASENAME)"
  emit_status "" "" "true" "$NONCONFORMING"
  exit 0
fi

# Parse date as UTC midnight (works on both macOS and Linux) -- a runner
# outside UTC comparing against local-midnight would be off by a day right
# at the overdue threshold boundary (DevGuru review pb#157).
if date -u -d "$LAST_DATE 00:00:00 UTC" +%s >/dev/null 2>&1; then
  # GNU date (Linux)
  LAST_EPOCH=$(date -u -d "$LAST_DATE 00:00:00 UTC" +%s)
elif date -u -j -f "%Y-%m-%d" "$LAST_DATE" +%s >/dev/null 2>&1; then
  # BSD date (macOS)
  LAST_EPOCH=$(date -u -j -f "%Y-%m-%d" "$LAST_DATE" +%s)
else
  echo "reflection_needed: true (cannot parse date: $LAST_DATE)"
  emit_status "" "" "true" "$NONCONFORMING"
  exit 0
fi

NOW_EPOCH=$(date -u +%s)
DAYS_SINCE=$(( (NOW_EPOCH - LAST_EPOCH) / 86400 ))

if [ "$DAYS_SINCE" -ge "$OVERDUE_THRESHOLD_DAYS" ]; then
  if is_idle_since_last_reflection "$LAST_DATE"; then
    if [ "$DAYS_SINCE" -ge "$IDLE_FALLBACK_DAYS" ]; then
      echo "reflection_needed: true (idle but overdue — last ran ${DAYS_SINCE}d ago, no consolidation promotions since, idle fallback threshold ${IDLE_FALLBACK_DAYS}d — forcing check-in run)"
      emit_status "$LAST_DATE" "$DAYS_SINCE" "true" "$NONCONFORMING"
      exit 0
    else
      echo "reflection_needed: false (idle-skip — last ran ${DAYS_SINCE}d ago, no consolidation promotions since last reflection, idle fallback threshold ${IDLE_FALLBACK_DAYS}d)"
      emit_status "$LAST_DATE" "$DAYS_SINCE" "false" "$NONCONFORMING" "true"
      exit 1
    fi
  fi
  echo "reflection_needed: true (last ran ${DAYS_SINCE}d ago, threshold ${OVERDUE_THRESHOLD_DAYS}d)"
  emit_status "$LAST_DATE" "$DAYS_SINCE" "true" "$NONCONFORMING"
  exit 0
else
  echo "reflection_needed: false (last ran ${DAYS_SINCE}d ago, threshold ${OVERDUE_THRESHOLD_DAYS}d)"
  emit_status "$LAST_DATE" "$DAYS_SINCE" "false" "$NONCONFORMING"
  exit 1
fi
