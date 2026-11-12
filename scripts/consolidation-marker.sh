#!/bin/bash
# Durable local cycle lifecycle. Git metadata keeps the marker out of commits
# and gives linked worktrees their own marker. Inspect never changes anything.
# Usage: bash consolidation-marker.sh start|inspect|clear [BRAIN_DIR] [YYYY-MM-DD]
# inspect: 0 absent, 1 valid marker, 2 inspection required.
# Repair: repair [BRAIN_DIR] INSPECT_CAPTURE REVIEW_NOTES (paths relative to BRAIN_DIR).
set -uo pipefail
ACTION=${1:-}
BRAIN_DIR=${2:-.}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fail() { echo "consolidation_marker: inspect required ($1; do not start a fresh cycle)"; exit 2; }
cd "$BRAIN_DIR" 2>/dev/null || fail "cannot access brain directory"
MARKER=$(git rev-parse --git-path consolidation-start 2>/dev/null) || fail "git metadata unavailable"
valid_date() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  local parsed
  parsed=$(date -u -d "$1" +%F 2>/dev/null) || parsed=$(date -u -j -f '%Y-%m-%d' "$1" +%F 2>/dev/null) || return 1
  [ "$parsed" = "$1" ]
}
load_record() {
  local path=$1
  [ -f "$path" ] && [ -r "$path" ] && [ ! -L "$path" ] || fail "unreadable start marker: $path"
  RECORD=$(cat "$path" 2>/dev/null | LC_ALL=C tr -d '\000') || fail "cannot read start marker: $path"
  if [[ "$RECORD" =~ ^v1\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    CYCLE_DATE=${BASH_REMATCH[1]} START_HEAD=${BASH_REMATCH[2]}
  elif [[ "$RECORD" =~ ^v2\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9a-f]{40}|[0-9a-f]{64})\ ([a-zA-Z0-9._:@-]+)\ ([1-9][0-9]{0,9})\ ([a-zA-Z0-9._-]+)\ ([1-9][0-9]{0,9})$ ]]; then
    CYCLE_DATE=${BASH_REMATCH[1]} START_HEAD=${BASH_REMATCH[2]}
    # Read older v2 records for inspection/clear; extra metadata grants no authority.
  else
    fail "malformed start marker: $path"
  fi
  valid_date "$CYCLE_DATE" || fail "malformed start marker date: $path"
  # Require one canonical line, including its newline, rejecting binary bytes.
  printf '%s\n' "$RECORD" | cmp -s - "$path" || fail "malformed start marker bytes: $path"
}
inspect() {
  if [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ]; then
    [ ! -e "$MARKER.lock" ] || fail "start marker lifecycle lock exists; inspect existing work and lock"
    echo 'consolidation_marker: none'
    return 0
  fi
  load_record "$MARKER"
  echo "$RECORD"
  return 1
}
case "$ACTION" in
  inspect) inspect; exit $? ;;
  start|clear|repair) ;;
  *) fail 'usage: consolidation-marker.sh start|inspect|clear|repair [BRAIN_DIR] [YYYY-MM-DD | INSPECT_CAPTURE REVIEW_NOTES]' ;;
esac
if [ "$ACTION" = start ]; then
  STATE=$(bash "$SCRIPT_DIR/consolidation-state.sh" .)
  STATUS=$?
  [ "$STATUS" -eq 0 ] || fail "prior state requires inspection: $STATE"
fi
# Serialize lifecycle writers. A killed writer leaves a lock for inspection,
# never permission to overwrite an existing marker. Readers take no lock.
mkdir "$MARKER.lock" 2>/dev/null || fail "cannot acquire start marker lifecycle lock: $MARKER.lock"
TMP=''
trap 'if [ -n "$TMP" ]; then rm -f "$TMP"; fi; rmdir "$MARKER.lock" 2>/dev/null' EXIT
if [ "$ACTION" = repair ]; then
  [ -e "$MARKER" ] || [ -L "$MARKER" ] || fail 'no start marker to repair'
  INSPECTION=$(inspect)
  INSPECT_STATUS=$?
  [ "$INSPECT_STATUS" -eq 1 ] || [ "$INSPECT_STATUS" -eq 2 ] || fail 'no start marker to repair'
  CAPTURE=${3:-} NOTES_PATH=${4:-}
  [ -f "$CAPTURE" ] && [ -r "$CAPTURE" ] || fail 'repair requires captured inspect output'
  printf '%s\n' "$INSPECTION" | cmp -s - "$CAPTURE" || fail 'captured inspect output does not match current inspection'
  [ -f "$NOTES_PATH" ] && [ -r "$NOTES_PATH" ] || fail 'repair requires archive/report inspection notes'
  NOTES=$(cat "$NOTES_PATH") || fail 'cannot read repair review notes'
  printf '%s\n' "$NOTES" | LC_ALL=C grep -Eq '^Archives inspected: .+' || fail 'repair requires Archives inspected: details'
  printf '%s\n' "$NOTES" | LC_ALL=C grep -Eq '^Reports inspected: .+' || fail 'repair requires Reports inspected: details'
  STAMP=$(date -u +%Y%m%dT%H%M%SZ) || fail 'cannot timestamp repair'
  BACKUP="$MARKER.$STAMP.$$.broken"
  [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] && [ ! -e "$BACKUP.audit" ] || fail 'repair backup already exists'
  # Persist the audit before moving the original bytes. A failed move leaves
  # the marker untouched and an audit of the attempted repair, never a reset.
  TMP=$(mktemp "$MARKER.tmp.XXXXXX") || fail 'cannot create repair audit'
  printf 'Repair requested: %s\n%s\n%s\nBackup: %s\n' \
    "$STAMP" "$INSPECTION" "$NOTES" "$BACKUP" > "$TMP" || fail 'cannot write repair audit'
  mv -- "$TMP" "$BACKUP.audit" || fail 'cannot publish repair audit'
  TMP=''
  printf '%s repair requested: %s (audit %s.audit)\n' "$STAMP" "$BACKUP" "$BACKUP" >> "$MARKER.repair.log" || fail 'cannot log repair request'
  mv -- "$MARKER" "$BACKUP" || fail 'cannot move start marker aside'
  printf '%s repaired: %s\n' "$STAMP" "$BACKUP" >> "$MARKER.repair.log" || fail "marker preserved at $BACKUP but cannot log repair completion"
  echo "consolidation_marker: repaired ($BACKUP; audit $BACKUP.audit; inspect archives/reports and state before starting)"
  exit 0
fi
if [ "$ACTION" = start ]; then
  [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ] || fail 'start marker already exists; inspect, then run consolidation-marker.sh repair for an unfinished cycle'
  CYCLE_DATE=${3:-$(date -u +%F)}
  valid_date "$CYCLE_DATE" || fail 'invalid cycle date'
  START_HEAD=$(git rev-parse --verify HEAD 2>/dev/null) || fail 'starting HEAD unavailable'
  TMP=$(mktemp "$MARKER.tmp.XXXXXX") || fail 'cannot create start marker temporary file'
  printf 'v1 %s %s\n' "$CYCLE_DATE" "$START_HEAD" > "$TMP" || fail 'cannot write start marker'
  mv -- "$TMP" "$MARKER" || fail 'cannot publish start marker'
  TMP=''
  echo "consolidation_marker: started ($CYCLE_DATE; starting HEAD $START_HEAD)"
  exit 0
fi
RECORD_OUTPUT=$(inspect)
STATUS=$?
[ "$STATUS" -eq 1 ] || fail "no valid start marker to $ACTION: $RECORD_OUTPUT"
load_record "$MARKER"
STATE=$(bash "$SCRIPT_DIR/consolidation-state.sh" .)
STATUS=$?
[ "$STATUS" -eq 0 ] && [[ "$STATE" = "consolidation_state: complete ($CYCLE_DATE;"* ]] || fail "completion not verified: $STATE"
rm -- "$MARKER" || fail 'cannot clear verified start marker'
echo "consolidation_marker: cleared ($CYCLE_DATE; verified final commit/report evidence)"
