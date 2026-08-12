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
# - daysSinceReflection >= REFLECTION_OVERDUE_THRESHOLD_DAYS -> reflection needed
# - Otherwise -> skip

BRAIN_DIR="${1:-.}"
REFLECTION_DIR="$BRAIN_DIR/memory/episodic"
OVERDUE_THRESHOLD_DAYS="${REFLECTION_OVERDUE_THRESHOLD_DAYS:-3}"

emit_status() {
  # $1=lastDate(or empty) $2=daysSince(or empty) $3=isOverdue(true/false) $4=nonConformingCount(default 0)
  local last_date_json="null"
  local days_since_json="null"
  local nonconforming="${4:-0}"
  [ -n "$1" ] && last_date_json="\"$1\""
  [ -n "$2" ] && days_since_json="$2"
  echo "REFLECTION_STATUS_JSON: {\"lastReflectionDate\":${last_date_json},\"daysSinceReflection\":${days_since_json},\"overdueThresholdDays\":${OVERDUE_THRESHOLD_DAYS},\"isOverdue\":$3,\"nonConformingReflectionFiles\":${nonconforming}}"
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
  echo "reflection_needed: true (last ran ${DAYS_SINCE}d ago, threshold ${OVERDUE_THRESHOLD_DAYS}d)"
  emit_status "$LAST_DATE" "$DAYS_SINCE" "true" "$NONCONFORMING"
  exit 0
else
  echo "reflection_needed: false (last ran ${DAYS_SINCE}d ago, threshold ${OVERDUE_THRESHOLD_DAYS}d)"
  emit_status "$LAST_DATE" "$DAYS_SINCE" "false" "$NONCONFORMING"
  exit 1
fi
