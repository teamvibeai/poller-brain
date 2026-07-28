#!/bin/bash
# bg-task.test.sh — self-test for bg-task.sh / bg-task-runner.sh.
# No dependencies beyond what the skill itself requires (bash, python3, setsid, timeout).
#
#   ./bg-task.test.sh                    # fast cases only (~5 s)
#   BG_TASK_TEST_SLOW=1 ./bg-task.test.sh   # + real TTL-kill case (~35 s)
#
# Every case runs with --dry-run, so nothing is ever POSTed to the API.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BG="$HERE/bg-task.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; [ $# -ge 2 ] && echo "         $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$3] not found in: ${2:0:300}" ;; esac; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export BG_TASK_ROOT="$WORK/tasks"
export BG_TASK_DRY=1
export TEAMVIBE_API_URL="https://example.invalid"
export TEAMVIBE_POLLER_TOKEN="test-token"
export TEAMVIBE_WORKSPACE_ID="01TESTWORKSPACE"
export TEAMVIBE_CHANNEL_ID="01TESTCHANNEL"
export SLACK_CHANNEL="C0TEST"

run() { "$BG" "$@" > "$WORK/out" 2> "$WORK/err"; echo $?; }

# Wait for the detached runner to write a terminal line into status.
wait_done() {
  local dir="$1" i=0
  while [ $i -lt "${2:-100}" ]; do
    grep -q '^state=' "$dir/status" 2>/dev/null && return 0
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

latest_dir() { ls -1dt "$BG_TASK_ROOT"/*/ 2>/dev/null | head -1 | sed 's:/$::'; }

echo "validation"
check "no command → exit 2"            "$(run --name x)"                       2
check "unknown flag → exit 2"          "$(run --nope -- true)"                 2
check "--ttl non-numeric → exit 2"     "$(run --ttl abc -- true)"              2
contains "validation errors go to stderr, prefixed" "$(cat "$WORK/err")" "bg-task: --ttl must be an integer"
check "--ttl below floor → exit 2"     "$(run --ttl 10 -- true)"               2
contains "range error names the bounds" "$(cat "$WORK/err")" "between 30 and 21600"
check "--ttl above ceiling → exit 2"   "$(run --ttl 99999 -- true)"            2
check "--ttl missing value → exit 2"   "$(run --ttl)"                          2
contains "flag with no value prints usage" "$(cat "$WORK/err")" "usage: bg-task.sh"

check "no channel → exit 2" "$(SLACK_CHANNEL= run -- true)" 2
contains "no-channel message names the fix" "$(cat "$WORK/err")" "--channel"

check "missing TEAMVIBE_POLLER_TOKEN → exit 2" "$(TEAMVIBE_POLLER_TOKEN= run -- true)" 2
contains "missing-env message names the variable" "$(cat "$WORK/err")" "TEAMVIBE_POLLER_TOKEN"
check "missing TEAMVIBE_API_URL → exit 2" "$(TEAMVIBE_API_URL= run -- true)" 2

echo "launch + finish path"
check "launch exits 0" "$(run --name unit-ok --ttl 60 -- /bin/echo hello-from-task)" 0
contains "launch prints the task id" "$(cat "$WORK/out")" "bg-task launched: name=unit-ok"
contains "launch tells the agent not to poll" "$(cat "$WORK/out")" "Do not poll"

D="$(latest_dir)"
if wait_done "$D"; then
  contains "state=finished on clean exit" "$(cat "$D/status")" "state=finished"
  contains "rc=0 recorded"                "$(cat "$D/status")" "rc=0"
  contains "dry run does not POST"         "$(cat "$D/status")" "dry_run=1"
  contains "command output captured"       "$(cat "$D/output.log")" "hello-from-task"
  contains "cmd file records the argv"     "$(cat "$D/cmd")" "hello-from-task"

  # The detached runner must NOT share the launcher's session id — that is what makes
  # it survive the spawner tearing down the session's process group.
  RSID="$(sed -n 's/^sid=//p' "$D/status" | head -1)"
  MYSID="$(ps -o sess= -p $$ | tr -d ' ')"
  if [ -n "$RSID" ] && [ "$RSID" != "$MYSID" ]; then
    ok "runner runs in its own session ($RSID != $MYSID)"
  else
    bad "runner runs in its own session" "runner sid=[$RSID] launcher sid=[$MYSID]"
  fi

  BODY="$(cat "$D/enqueue.json")"
  if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$D/enqueue.json"; then
    ok "enqueue body is valid JSON"
  else
    bad "enqueue body is valid JSON"
  fi
  contains "schedule is ONE_TIME"          "$BODY" '"scheduleType": "ONE_TIME"'
  contains "origin.channel is explicit"    "$BODY" '"channel": "C0TEST"'
  contains "workspace id from env"         "$BODY" "01TESTWORKSPACE"
  contains "prompt carries the task name"  "$BODY" "unit-ok"
  contains "prompt carries the output tail" "$BODY" "hello-from-task"
  contains "prompt states the state"       "$BODY" "finished with exit code 0"
  case "$BODY" in
    *'"cronExpression"'*) bad "ONE_TIME body has no cron field" ;;
    *) ok "ONE_TIME body has no cron field" ;;
  esac
else
  bad "runner reached a terminal state" "no state= line in $D/status"
fi

echo "non-zero exit is still a finish, not a timeout"
check "launch exits 0" "$(run --name unit-fail --ttl 60 -- /bin/false)" 0
D="$(latest_dir)"
if wait_done "$D"; then
  contains "state=finished" "$(cat "$D/status")" "state=finished"
  contains "rc=1"           "$(cat "$D/status")" "rc=1"
  contains "prompt reports the failing code" "$(cat "$D/enqueue.json")" "finished with exit code 1"
else
  bad "runner reached a terminal state (unit-fail)"
fi

echo "--channel overrides SLACK_CHANNEL"
check "launch exits 0" "$(run --name unit-chan --ttl 60 --channel C0OTHER -- true)" 0
D="$(latest_dir)"
if wait_done "$D"; then
  contains "origin.channel uses the override" "$(cat "$D/enqueue.json")" '"channel": "C0OTHER"'
else
  bad "runner reached a terminal state (unit-chan)"
fi

echo "empty output is reported, not omitted"
check "launch exits 0" "$(run --name unit-quiet --ttl 60 -- true)" 0
D="$(latest_dir)"
if wait_done "$D"; then
  contains "prompt says there was no output" "$(cat "$D/enqueue.json")" "(no output)"
else
  bad "runner reached a terminal state (unit-quiet)"
fi

if [ "${BG_TASK_TEST_SLOW:-0}" = "1" ]; then
  echo "TTL kill (slow: ~35 s)"
  check "launch exits 0" "$(run --name unit-ttl --ttl 30 -- sleep 300)" 0
  D="$(latest_dir)"
  if wait_done "$D" 250; then
    contains "state=timed-out" "$(cat "$D/status")" "state=timed-out"
    contains "rc=124"          "$(cat "$D/status")" "rc=124"
    contains "prompt says it was killed" "$(cat "$D/enqueue.json")" "hit its 30s TTL and was killed"
  else
    bad "TTL kill reached a terminal state"
  fi
else
  echo "TTL kill — skipped (set BG_TASK_TEST_SLOW=1 to run it)"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
