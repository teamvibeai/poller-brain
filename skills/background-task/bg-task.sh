#!/bin/bash
# bg-task.sh — run a long command detached from the current agent session and get
# woken up when it finishes.
#
#   bg-task.sh --name build --ttl 900 -- npm run build
#
# Reliability bar: BEST-EFFORT. The task survives the session that launched it, but
# it lives in the poller container — a poller restart kills it. No durability guarantee.
# See skill.md for the full contract.
set -uo pipefail

TTL=900; NAME="task"; CHANNEL="${SLACK_CHANNEL:-}"; THREAD="${SLACK_THREAD_TS:-}"
DRY="${BG_TASK_DRY:-0}"

# Delay between the task ending and the wake message becoming due.
#
# NOT a scheduler requirement: the scheduler ticks every minute and picks up rows with
# nextRunAt <= now, so a wake dated "now" fires on the very next tick. The delay exists
# because the wake ALWAYS spawns a new session (scheduler stamps its own threadId), and a
# new session running concurrently with the still-live launching session shares one brain
# repo. Observed 2026-07-28: two concurrent sessions swept each other's uncommitted work
# into unrelated commits (teamvibe.ai#232). The delay shrinks that overlap window; it does
# not close it. Do not drop it to 0 to save latency until #232 is fixed.
WAKE_DELAY="${BG_TASK_WAKE_DELAY:-30}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ttl) TTL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --thread) THREAD="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: bg-task.sh [--name N] [--ttl S] [--channel C] [--thread TS] -- <command...>" >&2; exit 2; }
case "$TTL" in ''|*[!0-9]*) echo "--ttl must be seconds (integer)" >&2; exit 2 ;; esac
[ "$TTL" -ge 30 ] && [ "$TTL" -le 21600 ] || { echo "--ttl must be 30..21600 s" >&2; exit 2; }
case "$WAKE_DELAY" in ''|*[!0-9]*) echo "BG_TASK_WAKE_DELAY must be seconds (integer)" >&2; exit 2 ;; esac
[ -n "$CHANNEL" ] || { echo "no channel: pass --channel or have SLACK_CHANNEL set" >&2; exit 2; }
for v in TEAMVIBE_API_URL TEAMVIBE_POLLER_TOKEN TEAMVIBE_WORKSPACE_ID TEAMVIBE_CHANNEL_ID; do
  [ -n "${!v:-}" ] || { echo "missing env $v" >&2; exit 2; }
done

# Task dirs are namespaced per channel. This is hygiene (no ID collisions between brains
# sharing this poller container), NOT isolation — every brain here runs as the same uid,
# so file permissions grant nothing. See skill.md "What other brains can see".
ROOT="${BG_TASK_ROOT:-${PERSISTENT_STORAGE_PATH:-/tmp}/bg-tasks/${TEAMVIBE_CHANNEL_ID}}"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-${NAME//[^A-Za-z0-9_-]/_}"
DIR="$ROOT/$ID"; mkdir -p "$DIR" || exit 1
printf '%s ' "$@" > "$DIR/cmd"; printf '\n' >> "$DIR/cmd"

# The runner is what actually outlives the session: setsid gives it its own
# session+pgid, so the spawner's proc.kill() of the claude PID cannot reach it.
cat > "$DIR/runner.sh" <<'RUNNER'
#!/bin/bash
DIR="$1"; TTL="$2"; NAME="$3"; CHANNEL="$4"; THREAD="$5"; DRY="$6"; WAKE_DELAY="$7"; shift 7
LOG="$DIR/output.log"; META="$DIR/status"
START=$(date +%s)
echo "started=$(date -u +%FT%TZ) pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d ' ') ttl=${TTL}s" >> "$META"
timeout "$TTL" "$@" >> "$LOG" 2>&1
RC=$?
ELAPSED=$(( $(date +%s) - START ))
# rc=124 is timeout(1)'s "I killed it" code. A command that exits 124 on its own is
# indistinguishable here — noted in skill.md rather than papered over.
if [ "$RC" -eq 124 ]; then STATE=timed-out; else STATE=finished; fi
echo "$STATE=$(date -u +%FT%TZ) rc=$RC elapsed=${ELAPSED}s" >> "$META"

# Sibling tasks still running for THIS channel: a task dir with no terminal line in status.
SIBLINGS=0
for d in "$(dirname "$DIR")"/*/; do
  [ "${d%/}" = "$DIR" ] && continue
  [ -f "$d/status" ] || continue
  grep -qE '^(finished|timed-out)=' "$d/status" || SIBLINGS=$((SIBLINGS + 1))
done

# Finish signal. The ONLY agent-reachable enqueue path that can spawn an IDLE session
# is POST /scheduled-messages ONE_TIME (/events is telemetry-only, an .inbox/ drop is
# inject-if-running). origin.channel/thread_ts must be explicit — they freeze at
# creation time (poller-brain#124).
export BG_TASK_WHEN=$(date -u -d "+${WAKE_DELAY} seconds" +%FT%TZ)
WHEN="$BG_TASK_WHEN"
PROMPT=$(python3 - "$DIR" "$NAME" "$STATE" "$RC" "$TTL" "$ELAPSED" "$SIBLINGS" <<'PY'
import sys, os
d, name, state, rc, ttl, elapsed, siblings = sys.argv[1:8]
log = os.path.join(d, "output.log")

def read(path, limit=None):
    try:
        with open(path, "rb") as f:
            if limit:
                f.seek(0, 2); f.seek(max(0, f.tell() - limit))
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""

cmd = read(os.path.join(d, "cmd")) or "(unknown)"
tail = read(log, 1500)
mins, secs = divmod(int(elapsed), 60)
ran_for = f"{mins}m {secs}s" if mins else f"{secs}s"
why = (f"hit its {ttl}s TTL and was killed" if state == "timed-out"
       else f"finished with exit code {rc}")
extra = f"\nOther background tasks still running in this channel: {siblings}" if siblings != "0" else ""
print(f"""A background task you launched in an earlier session has {why}.

Task: {name}
Command: {cmd}
Status: {state} (rc={rc}) after {ran_for}
Working dir: {d}   (full output: {log}){extra}

Last output (tail, up to 1500 B):
{tail or '(no output)'}

Pick the work back up where you left it. If the task failed or timed out, say so instead of retrying blindly.""")
PY
)
BODY=$(python3 - "$PROMPT" "$CHANNEL" "$THREAD" <<'PY'
import json, os, sys
prompt, channel, thread = sys.argv[1], sys.argv[2], sys.argv[3]
origin = {"source": "slack", "channel": channel}
if thread:
    origin["thread_ts"] = thread
print(json.dumps({
    "workspaceId": os.environ["TEAMVIBE_WORKSPACE_ID"],
    "channelId": os.environ["TEAMVIBE_CHANNEL_ID"],
    "scheduleType": "ONE_TIME",
    "scheduledAt": os.environ["BG_TASK_WHEN"],
    "promptTemplate": prompt,
    "origin": origin,
    "status": "ACTIVE",
}))
PY
)
if [ "$DRY" = "1" ]; then
  echo "dry-run=1 would_enqueue_at=$WHEN bytes=${#BODY} siblings=$SIBLINGS" >> "$META"
  printf '%s' "$BODY" > "$DIR/enqueue.json"
else
  RESP=$(curl -s -X POST "$TEAMVIBE_API_URL/scheduled-messages" \
    -H "Authorization: Bearer $TEAMVIBE_POLLER_TOKEN" \
    -H 'Content-Type: application/json' -d "$BODY")
  echo "enqueued=$(date -u +%FT%TZ) scheduledAt=$WHEN siblings=$SIBLINGS resp=${RESP:0:200}" >> "$META"
fi
RUNNER
chmod +x "$DIR/runner.sh"

BG_TASK_WHEN=placeholder setsid nohup "$DIR/runner.sh" "$DIR" "$TTL" "$NAME" "$CHANNEL" "$THREAD" "$DRY" "$WAKE_DELAY" "$@" \
  > "$DIR/runner.stdout" 2>&1 < /dev/null &
disown 2>/dev/null

echo "launched task=$NAME id=$ID ttl=${TTL}s dir=$DIR"
echo "wake goes to channel=$CHANNEL thread=${THREAD:-<none: top-level>}"
echo "you will be woken ~${WAKE_DELAY}s + up to 1 scheduler tick after it ends; nothing to poll"
