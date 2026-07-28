#!/bin/bash
# bg-task-runner.sh — the detached half of bg-task. Never invoke directly; bg-task.sh
# starts it under setsid so it outlives the agent session.
#
#   bg-task-runner.sh <dir> <ttl> <name> <channel> <dry> -- <command...>
#
# Contract: run the command under `timeout <ttl>`, then send exactly one finish signal.
# Completion is EXPLICIT (this script reaching the enqueue step) — never inferred from
# the command producing output, because a task may legitimately sit silent for hours.
set -uo pipefail

DIR="$1"; TTL="$2"; NAME="$3"; CHANNEL="$4"; DRY="$5"; shift 5

STATUS="$DIR/status"
LOG="$DIR/output.log"

stamp() { date -u +%FT%TZ; }

{
  echo "started=$(stamp)"
  echo "pid=$$"
  echo "sid=$(ps -o sess= -p $$ 2>/dev/null | tr -d ' ')"
  echo "ttl=${TTL}s"
} >> "$STATUS"

timeout "$TTL" "$@" >> "$LOG" 2>&1
RC=$?

if [ "$RC" -eq 124 ]; then STATE="timed-out"; else STATE="finished"; fi
{
  echo "state=$STATE"
  echo "rc=$RC"
  echo "ended=$(stamp)"
} >> "$STATUS"

# --- finish signal ---------------------------------------------------------------
# POST /scheduled-messages with a ONE_TIME schedule is the only agent-reachable path
# that can spawn an IDLE session (pb#231):
#   * POST /events is telemetry-only — whitelisted event types, writes a DDB row, never
#     touches the message queue.
#   * dropping a file into .inbox/ is inject-if-running only — a drained/idle session
#     has no filesystem watcher, so the message is never picked up.
# origin.channel must be explicit: it is frozen at creation time (pb#124), and the
# creating session's env is gone by the time the schedule fires.
WHEN="$(date -u -d '+65 seconds' +%FT%TZ)"   # one scheduler tick (~60 s) of headroom

BODY="$(
  BG_NAME="$NAME" BG_STATE="$STATE" BG_RC="$RC" BG_TTL="$TTL" BG_DIR="$DIR" \
  BG_CHANNEL="$CHANNEL" BG_WHEN="$WHEN" \
  python3 <<'PY'
import json, os

d = os.environ["BG_DIR"]
name = os.environ["BG_NAME"]
state = os.environ["BG_STATE"]
rc = os.environ["BG_RC"]
ttl = os.environ["BG_TTL"]

log = os.path.join(d, "output.log")
tail = ""
try:
    with open(log, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 1500))
        tail = f.read().decode("utf-8", "replace")
except OSError:
    pass

why = (f"hit its {ttl}s TTL and was killed"
       if state == "timed-out" else f"finished with exit code {rc}")

prompt = f"""A background task you launched in an earlier session has {why}.

Task: {name}
State: {state} (rc={rc})
Directory: {d}   (full output: {log})

Last output:
{tail.strip() or "(no output)"}

Pick the work back up from here. Report the real outcome — if it failed or timed out,
say so instead of retrying blindly."""

print(json.dumps({
    "workspaceId": os.environ["TEAMVIBE_WORKSPACE_ID"],
    "channelId": os.environ["TEAMVIBE_CHANNEL_ID"],
    "scheduleType": "ONE_TIME",
    "scheduledAt": os.environ["BG_WHEN"],
    "promptTemplate": prompt,
    "origin": {"source": "slack", "channel": os.environ["BG_CHANNEL"]},
}))
PY
)"

if [ -z "$BODY" ]; then
  echo "enqueue_failed=$(stamp) reason=body-build-failed" >> "$STATUS"
  exit 1
fi

if [ "$DRY" = "1" ]; then
  printf '%s' "$BODY" > "$DIR/enqueue.json"
  echo "dry_run=1 would_enqueue_at=$WHEN bytes=${#BODY}" >> "$STATUS"
  exit 0
fi

RESP="$(curl -sS -X POST "$TEAMVIBE_API_URL/scheduled-messages" \
  -H "Authorization: Bearer $TEAMVIBE_POLLER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" 2>&1)"
CURL_RC=$?

# The response is the only evidence that the wake was accepted; keep it verbatim in the
# task dir. If this fails, the work is done but nobody gets told — that is the
# best-effort edge, and it must be visible here rather than silently dropped.
{
  echo "enqueued=$(stamp)"
  echo "scheduled_at=$WHEN"
  echo "curl_rc=$CURL_RC"
} >> "$STATUS"
printf '%s' "$RESP" > "$DIR/enqueue-response.json"
