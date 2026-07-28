---
name: background-task
description: |
  Run a command that takes longer than a session can wait — builds, test suites, long
  scrapes, batch jobs, anything blocking on an external confirmation — without blocking
  your turn. The task is detached from your session and you are woken up when it ends.
  Use this instead of polling, sleeping, or asking the user to check back later.
---

# Background Tasks

You cannot sit and wait for a 20-minute build. Your session gets torn down, and anything
you started in the foreground dies with it. This skill runs the command *outside* your
session and delivers the result back to you as a new message when it ends.

```bash
node "$CLAUDE_CONFIG_DIR/skills/background-task/scripts/bg-task.mjs" \
  --name build --ttl 1800 --thread "$SLACK_THREAD_TS" -- npm run build
```

Then **end your turn.** Tell the user the task is running and that you'll report back.
Do not poll, do not `sleep`, do not keep the session alive waiting.

## What you get back

When the command ends, a message arrives and wakes a **new session** with the task name,
the command, the state, the exit code, how long it ran, the task directory, the last
~1500 bytes of output, and a note if other tasks are still running.

Two things to know about that wake, because both have bitten people:

- **It is always a new session, not a continuation of yours.** Even if your session is
  still alive when the task ends, the scheduler mints a fresh session
  (`threadId=scheduled:<id>:<ts>`). You will not have your old context — the message has
  to stand on its own, which is why it carries the command and not just the exit code.
- **It lands wherever you pointed it.** Pass `--thread "$SLACK_THREAD_TS"` if you want
  the reply in the thread you launched from; without it the wake goes to the channel
  top level and the user has to work out what it refers to.

Measured latency from end-of-command to a live session: **~110 s** (two canary runs at
112 s and 111 s — about 50 s of that is platform overhead after `scheduledAt`).

Two terminal states:

| State | Meaning |
|---|---|
| `finished` | The command exited on its own. `rc` is its exit code — `rc != 0` means it *failed*, not that it timed out. |
| `timed-out` | The command was still running at `--ttl` and was killed. `rc=124`. |

Report the real outcome. A failed build is a failed build — don't retry blindly and don't
describe a timeout as a success.

## Options

| Flag | Default | Notes |
|---|---|---|
| `--name NAME` | `task` | Shows up in the wake message. Use something you'll recognise. |
| `--ttl SECONDS` | `900` | 30–21600 (6 h). The task is **killed** at this limit — set it above the realistic worst case. |
| `--thread TS` | `$SLACK_THREAD_TS` | Thread for the wake message. Pass it explicitly for anything a user is waiting on. |
| `--channel C…` | `$SLACK_CHANNEL` | Where the wake goes. Only override to deliver into a different channel on purpose. |
| `--dry-run` | off | Runs the command but writes the wake payload to `enqueue.json` instead of sending it. |
| `-- <command…>` | required | Everything after `--` is the command. Not a shell string — no pipes or redirects unless you wrap it in `bash -c "…"`. |

Artifacts live in `$PERSISTENT_STORAGE_PATH/bg-tasks/<channel id>/<task id>/`: `cmd` (the argv),
`output.log` (full stdout+stderr), `status` (timestamps, pid, session id, state, rc), and
the enqueue response. The wake message tells you the path — read `output.log` there when
the tail isn't enough.

## Reliability bar: best-effort

This is **not** a durability guarantee, and you must not describe it to a user as one.

- **Survives** your session ending, including a full teardown of the launching session.
- **Does not survive** a poller restart or redeploy — the task lives in the poller
  container. In-flight tasks are lost and no wake arrives.
- The finish signal is a single API call. If it fails, the command still ran and the
  output is still on disk, but nobody is told. The failure is recorded in `status` and
  `enqueue-response.json`.

Safe for "this takes a while", wrong for "this must not be lost". If a task absolutely
has to complete, say that constraint out loud instead of hiding it behind a background
task.

## Task storage is shared, not private

On a poller hosting several brains, `$PERSISTENT_STORAGE_PATH` is **shared between them**.
Task directories are namespaced per channel (`bg-tasks/<channel id>/…`) so two brains
cannot collide on one directory — but that is hygiene, not isolation: every brain on the
poller runs as the same user and can read every task directory, whatever the file
permissions say.

**Do not run background tasks whose output contains secrets** — tokens, credentials,
customer data. The output log sits on disk until cleaned up, readable by anything else
running on that poller.

## Interim output is not delivered (yet)

You get **one** message, at the end. If the command prints something you need to act on
*while it runs* — a device-auth URL, a confirmation prompt, a code to paste — that output
sits in `output.log` and nothing tells you about it. For now, prefer commands that need
no mid-run interaction, or keep such a task short and check `output.log` yourself in the
same session.

## How the wake works (and what not to try)

The finish signal is a one-time scheduled message posted to `POST /scheduled-messages`
with an explicit `origin.channel`. That is the only agent-reachable path that can wake an
**idle** session. Two nearby paths look like they would work and don't:

- `POST /events` is telemetry-only — it whitelists a fixed set of event types and writes
  a pipeline row. It never touches the message queue.
- Dropping a file into `.inbox/` is *inject-if-running* only. There is no filesystem
  watcher, so a drained session never sees it.

`origin.channel` must be passed explicitly because it is frozen at creation time — the
launching session's environment is gone by the time the schedule fires.

## Self-test

```bash
cd "$CLAUDE_CONFIG_DIR/skills/background-task/scripts"
node bg-task.test.mjs                       # fast cases, ~5 s, no network
BG_TASK_TEST_SLOW=1 node bg-task.test.mjs   # + real TTL-kill case, ~35 s
```

All cases run with `--dry-run`; nothing is posted to the API.
