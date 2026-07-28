#!/bin/bash
# bg-task.sh — launch a long-running command detached from the current agent session
# and get woken up in this channel when it ends.
#
#   bg-task.sh --name build --ttl 900 -- npm run build
#
# Reliability bar: BEST-EFFORT (see skill.md). The task survives the session that
# launched it. It does NOT survive a poller restart. Nothing here is a durability
# guarantee — never promise a user that a background task cannot be lost.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/bg-task-runner.sh"

TTL=900
NAME="task"
CHANNEL="${SLACK_CHANNEL:-}"
DRY="${BG_TASK_DRY:-0}"

usage() {
  echo "usage: bg-task.sh [--name NAME] [--ttl SECONDS] [--channel SLACK_CHANNEL] [--dry-run] -- <command...>" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ttl)     [ $# -ge 2 ] || { usage; exit 2; }; TTL="$2"; shift 2 ;;
    --name)    [ $# -ge 2 ] || { usage; exit 2; }; NAME="$2"; shift 2 ;;
    --channel) [ $# -ge 2 ] || { usage; exit 2; }; CHANNEL="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --)        shift; break ;;
    *)         echo "bg-task: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[ $# -gt 0 ] || { echo "bg-task: no command given (everything after -- is the command)" >&2; usage; exit 2; }

case "$TTL" in
  ''|*[!0-9]*) echo "bg-task: --ttl must be an integer number of seconds" >&2; exit 2 ;;
esac
# Floor keeps the wake path meaningful (scheduler tick is ~60 s); ceiling is 6 h so a
# forgotten task cannot hold a slot indefinitely.
[ "$TTL" -ge 30 ] && [ "$TTL" -le 21600 ] || { echo "bg-task: --ttl must be between 30 and 21600 seconds" >&2; exit 2; }

[ -n "$CHANNEL" ] || { echo "bg-task: no target channel — pass --channel or run where SLACK_CHANNEL is set" >&2; exit 2; }

for v in TEAMVIBE_API_URL TEAMVIBE_POLLER_TOKEN TEAMVIBE_WORKSPACE_ID TEAMVIBE_CHANNEL_ID; do
  [ -n "${!v:-}" ] || { echo "bg-task: missing environment variable $v — cannot deliver the finish signal" >&2; exit 2; }
done

command -v setsid  >/dev/null 2>&1 || { echo "bg-task: setsid not available — cannot detach from the session" >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "bg-task: timeout not available — cannot enforce --ttl" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "bg-task: python3 not available — needed to build the finish message" >&2; exit 2; }
[ -x "$RUNNER" ] || { echo "bg-task: runner not executable: $RUNNER" >&2; exit 2; }

ROOT="${BG_TASK_ROOT:-${PERSISTENT_STORAGE_PATH:-/tmp}/bg-tasks}"
SAFE_NAME="${NAME//[^A-Za-z0-9_-]/_}"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$SAFE_NAME"
DIR="$ROOT/$ID"
mkdir -p "$DIR" || { echo "bg-task: cannot create task directory $DIR" >&2; exit 1; }

# One argument per line — the reviewable record of what was actually launched.
printf '%s\n' "$@" > "$DIR/cmd"

# setsid gives the runner its own session and process group, so the spawner killing
# the claude process group at session teardown cannot reach it. This is the whole
# trick — verified empirically in pb#231 (survived a full session teardown).
setsid nohup "$RUNNER" "$DIR" "$TTL" "$NAME" "$CHANNEL" "$DRY" "$@" \
  > "$DIR/runner.stdout" 2>&1 < /dev/null &
disown 2>/dev/null

echo "bg-task launched: name=$NAME id=$ID ttl=${TTL}s"
echo "dir=$DIR (status, output.log, cmd)"
echo "You will be woken in this channel ~1-2 min after it ends. Do not poll — end your turn."
