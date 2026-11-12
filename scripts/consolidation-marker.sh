#!/bin/bash
# Durable local cycle lifecycle. Git metadata keeps the marker out of commits
# and gives linked worktrees their own marker. Inspect never changes anything.
# Usage: bash consolidation-marker.sh start|inspect|claim|owned|clear [BRAIN_DIR] [YYYY-MM-DD]
# inspect: 0 absent, 1 valid marker, 2 inspection required. v2 adds owner identity.
# claim is exclusive and persists until verified clear (or recovery of a dead claimant).
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
  OWNER_SESSION='' OWNER_PID='' OWNER_HOST='' OWNER_TIME=''
  if [[ "$RECORD" =~ ^v1\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    CYCLE_DATE=${BASH_REMATCH[1]} START_HEAD=${BASH_REMATCH[2]}
  elif [[ "$RECORD" =~ ^v2\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9a-f]{40}|[0-9a-f]{64})\ ([a-zA-Z0-9._:@-]+)\ ([1-9][0-9]{0,9})\ ([a-zA-Z0-9._-]+)\ ([1-9][0-9]{0,9})$ ]]; then
    CYCLE_DATE=${BASH_REMATCH[1]} START_HEAD=${BASH_REMATCH[2]}
    OWNER_SESSION=${BASH_REMATCH[3]} OWNER_PID=${BASH_REMATCH[4]}
    OWNER_HOST=${BASH_REMATCH[5]} OWNER_TIME=${BASH_REMATCH[6]}
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
    [ ! -e "$MARKER.recovery" ] && [ ! -L "$MARKER.recovery" ] || fail 'recovery claim exists without start marker'
    echo 'consolidation_marker: none'
    return 0
  fi
  load_record "$MARKER"
  echo "$RECORD"
  return 1
}
caller() {
  CALLER_HOST=$(hostname 2>/dev/null) || fail 'cannot determine owner host'
  CALLER_PID=${CONSOLIDATION_OWNER_PID:-$PPID}
  CALLER_SESSION=${CONSOLIDATION_SESSION_ID:-$CALLER_HOST:$CALLER_PID}
  [[ "$CALLER_HOST" =~ ^[a-zA-Z0-9._-]+$ && "$CALLER_PID" =~ ^[1-9][0-9]{0,9}$ && "$CALLER_SESSION" =~ ^[a-zA-Z0-9._:@-]+$ ]] || fail 'invalid owner identity'
}
same_owner() {
  [ "$OWNER_HOST" = "$CALLER_HOST" ] && [ "$OWNER_PID" = "$CALLER_PID" ] && [ "$OWNER_SESSION" = "$CALLER_SESSION" ]
}
load_claim() {
  local original_date=$CYCLE_DATE original_head=$START_HEAD
  [ -d "$MARKER.recovery" ] && [ ! -L "$MARKER.recovery" ] || fail 'invalid recovery claim'
  load_record "$MARKER.recovery/owner"
  [[ "$RECORD" = v2\ * ]] || fail 'malformed recovery claim owner'
  [ "$CYCLE_DATE" = "$original_date" ] && [ "$START_HEAD" = "$original_head" ] || fail 'recovery claim disagrees with marker'
}
owner_gone() {
  local path=$1 pids now age_limit
  if [ "$OWNER_HOST" = "$CALLER_HOST" ]; then
    kill -0 "$OWNER_PID" 2>/dev/null && return 1
    # A failed kill can mean permission denied. Require a successful process
    # listing that positively excludes the PID; errors never prove death.
    pids=$(ps -e -o pid= 2>/dev/null) || return 1
    printf '%s\n' "$pids" | awk -v pid="$OWNER_PID" '$1 == pid { found=1 } END { exit found ? 1 : 0 }'
    return $?
  fi
  # Remote owners and legacy v1 (unknown owner) use a conservative 24h lease.
  # Legacy age is the marker mtime. Clock skew / invalid policy fails closed.
  age_limit=${CONSOLIDATION_OWNER_STALE_SECONDS:-86400}
  [[ "$age_limit" =~ ^[1-9][0-9]{0,8}$ ]] || return 1
  if [ -z "$OWNER_TIME" ]; then
    OWNER_TIME=$(stat -c %Y "$path" 2>/dev/null) || OWNER_TIME=$(stat -f %m "$path" 2>/dev/null) || return 1
  fi
  now=$(date -u +%s) || return 1
  [[ "$OWNER_TIME" =~ ^[1-9][0-9]{0,9}$ && "$now" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  [ "$((now - OWNER_TIME))" -ge "$age_limit" ]
}
publish_owner() {
  local target=$1 started
  started=$(date -u +%s) || fail 'cannot determine owner start time'
  TMP=$(mktemp "$MARKER.tmp.XXXXXX") || fail 'cannot create start marker temporary file'
  printf 'v2 %s %s %s %s %s %s\n' "$CYCLE_DATE" "$START_HEAD" "$CALLER_SESSION" "$CALLER_PID" "$CALLER_HOST" "$started" > "$TMP" || fail 'cannot write start marker'
  mv -- "$TMP" "$target" || fail 'cannot publish start marker'
  TMP=''
}
case "$ACTION" in
  inspect) inspect; exit $? ;;
  owned)
    caller
    load_record "$MARKER"
    if [ -e "$MARKER.recovery" ] || [ -L "$MARKER.recovery" ]; then
      load_claim
    fi
    same_owner || fail 'active cycle elsewhere; caller does not own cycle'
    echo 'consolidation_marker: caller owns cycle'
    exit 0 ;;
  start|clear|claim|repair) ;;
  *) fail 'usage: consolidation-marker.sh start|inspect|claim|owned|clear|repair [BRAIN_DIR] [YYYY-MM-DD | INSPECT_CAPTURE REVIEW_NOTES]' ;;
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
caller
if [ "$ACTION" = repair ]; then
  [ ! -e "$MARKER.recovery" ] && [ ! -L "$MARKER.recovery" ] || fail 'repair forbidden while a recovery claim is held'
  [ -e "$MARKER" ] || [ -L "$MARKER" ] || fail 'no malformed marker to repair'
  INSPECTION=$(inspect)
  [ "$?" -eq 2 ] || fail 'repair requires a malformed/unreadable marker; valid markers require verified clear'
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
  printf 'Repair requested: %s session=%s pid=%s host=%s\n%s\n%s\nBackup: %s\n' \
    "$STAMP" "$CALLER_SESSION" "$CALLER_PID" "$CALLER_HOST" "$INSPECTION" "$NOTES" "$BACKUP" > "$TMP" || fail 'cannot write repair audit'
  mv -- "$TMP" "$BACKUP.audit" || fail 'cannot publish repair audit'
  TMP=''
  printf '%s repair requested: %s (audit %s.audit)\n' "$STAMP" "$BACKUP" "$BACKUP" >> "$MARKER.repair.log" || fail 'cannot log repair request'
  mv -- "$MARKER" "$BACKUP" || fail 'cannot move malformed marker aside'
  printf '%s repaired: %s (session %s)\n' "$STAMP" "$BACKUP" "$CALLER_SESSION" >> "$MARKER.repair.log" || fail "marker preserved at $BACKUP but cannot log repair completion"
  echo "consolidation_marker: repaired ($BACKUP; audit $BACKUP.audit; inspect archives/reports and state before starting)"
  exit 0
fi
if [ "$ACTION" = start ]; then
  [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ] || fail 'start marker already exists; inspect existing work and resume, or clear verified completion first'
  CYCLE_DATE=${3:-$(date -u +%F)}
  valid_date "$CYCLE_DATE" || fail 'invalid cycle date'
  START_HEAD=$(git rev-parse --verify HEAD 2>/dev/null) || fail 'starting HEAD unavailable'
  [ ! -e "$MARKER.recovery" ] && [ ! -L "$MARKER.recovery" ] || fail 'recovery claim already exists'
  publish_owner "$MARKER"
  echo "consolidation_marker: started ($CYCLE_DATE; starting HEAD $START_HEAD)"
  exit 0
fi
RECORD_OUTPUT=$(inspect)
STATUS=$?
[ "$STATUS" -eq 1 ] || fail "no valid start marker to $ACTION: $RECORD_OUTPUT"
load_record "$MARKER"
if [ "$ACTION" = claim ]; then
  owner_gone "$MARKER" || fail 'active cycle elsewhere; cycle owner may still be alive'
  if [ -e "$MARKER.recovery" ] || [ -L "$MARKER.recovery" ]; then
    load_claim
    owner_gone "$MARKER.recovery/owner" || fail 'active cycle elsewhere; recovery claim held'
    rm -- "$MARKER.recovery/owner" && rmdir "$MARKER.recovery" || fail 'cannot retire dead recovery claim'
  fi
  mkdir "$MARKER.recovery" 2>/dev/null || fail 'active cycle elsewhere; cannot acquire recovery claim'
  publish_owner "$MARKER.recovery/owner"
  echo "consolidation_marker: recovery claimed ($CYCLE_DATE; $CALLER_SESSION)"
  exit 0
fi
if [ -e "$MARKER.recovery" ] || [ -L "$MARKER.recovery" ]; then
  load_claim
  same_owner || fail 'active cycle elsewhere; only recovery owner can clear'
  load_record "$MARKER"
elif [ -n "$OWNER_PID" ] && ! same_owner; then
  owner_gone "$MARKER" || fail 'active cycle elsewhere; only live cycle owner can clear'
fi
STATE=$(bash "$SCRIPT_DIR/consolidation-state.sh" .)
STATUS=$?
[ "$STATUS" -eq 0 ] && [[ "$STATE" = "consolidation_state: complete ($CYCLE_DATE;"* ]] || fail "completion not verified: $STATE"
rm -- "$MARKER" || fail 'cannot clear verified start marker'
if [ -d "$MARKER.recovery" ]; then
  rm -- "$MARKER.recovery/owner" && rmdir "$MARKER.recovery" || fail 'cannot release recovery claim'
fi
echo "consolidation_marker: cleared ($CYCLE_DATE; verified final commit/report evidence)"
