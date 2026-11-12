#!/bin/bash
# Durable local cycle lifecycle. Git metadata keeps the marker out of commits
# and gives linked worktrees their own marker. Inspect never changes anything.
# Usage: bash consolidation-marker.sh start|inspect|clear [BRAIN_DIR] [YYYY-MM-DD]
# inspect: 0 absent, 1 valid marker (v1 DATE START_HEAD), 2 inspection required.
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
inspect() {
  if [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ]; then
    [ ! -e "$MARKER.lock" ] || fail "start marker lifecycle lock exists; inspect existing work and lock"
    echo 'consolidation_marker: none'
    return 0
  fi
  [ -f "$MARKER" ] && [ -r "$MARKER" ] && [ ! -L "$MARKER" ] || fail "unreadable start marker: $MARKER"
  # Require one canonical line, including the newline; reject extra fields,
  # binary data and unsupported versions rather than trusting partial state.
  RECORD=$(cat "$MARKER" 2>/dev/null | LC_ALL=C tr -d '\000') || fail "cannot read start marker: $MARKER"
  [[ "$RECORD" =~ ^v1\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "malformed start marker: $MARKER"
  CYCLE_DATE=${BASH_REMATCH[1]}
  START_HEAD=${BASH_REMATCH[2]}
  valid_date "$CYCLE_DATE" || fail "malformed start marker date: $MARKER"
  printf '%s\n' "$RECORD" | cmp -s - "$MARKER" || fail "malformed start marker bytes: $MARKER"
  echo "$RECORD"
  return 1
}
case "$ACTION" in
  inspect) inspect; exit $? ;;
  start|clear) ;;
  *) fail 'usage: consolidation-marker.sh start|inspect|clear [BRAIN_DIR] [YYYY-MM-DD]' ;;
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
if [ "$ACTION" = start ]; then
  [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ] || fail 'start marker already exists; inspect existing work and resume, or clear verified completion first'
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
[ "$STATUS" -eq 1 ] || fail "no valid start marker to clear: $RECORD_OUTPUT"
read -r _ CYCLE_DATE START_HEAD <<< "$RECORD_OUTPUT"
STATE=$(bash "$SCRIPT_DIR/consolidation-state.sh" .)
STATUS=$?
[ "$STATUS" -eq 0 ] && [[ "$STATE" = "consolidation_state: complete ($CYCLE_DATE;"* ]] || fail "completion not verified: $STATE"
rm -- "$MARKER" || fail 'cannot clear verified start marker'
echo "consolidation_marker: cleared ($CYCLE_DATE; verified final commit/report evidence)"
