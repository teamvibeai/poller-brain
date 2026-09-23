#!/bin/bash
# Stop hook: refuse to end the turn while this session still has
# unresolved background Agent-tool subagents (Agent(run_in_background: true)).
#
# Why: poller-brain#496 -- background subagents write their result to
# /tmp/.../tasks/<agentId>.output, not to .inbox/<thread>/new/, which is
# the only path the poller watches to wake a fresh session. If the calling
# turn ends and the session goes idle before a background subagent
# finishes, delivery is not guaranteed -- confirmed empirically (poller-
# brain#496 thread, 2026-09-22) and corroborated by a real incident
# (Jakub's TIK-190 report: a background subagent was lost mid-work when
# its session restarted, leaving only an ambiguous "no completion record
# found" signal on next resume).
#
# Blocking the *input* (Agent run_in_background=true, the #488/#490
# pattern) was considered and rejected: it would kill same-turn subagent
# concurrency entirely, which is this fleet's primary mechanism for
# delegating parallel work (research, code review, design rundy -- see
# #213). This hook instead blocks the *output* -- the moment the turn
# would end -- which is exactly where the loss actually happens, and
# preserves concurrency for everything before that point.
#
# --max-turns (already set on the poller's claude invocation) is the
# existing safety valve against a permanently stuck task -- verified live
# that Stop block/force-continue genuinely works. It's also verified
# (poller-brain#496 thread, 2026-09-23) that running out of --max-turns
# while this hook is still blocking exits with code 1, which the poller
# surfaces as a visible Slack error (not silence) -- so a stuck task fails
# loud, it just still loses the background result. Blocking alone doesn't
# make a genuinely long task (minutes, or with an external waiting party
# like a CI/deploy watch) safe -- that's still bg-task's job, not this
# hook's. The escalating hint below exists to catch that case while it's
# still happening, since a written rule alone has not reliably held here
# before (MEM-221->MEM-281, and same-day sentinel recidivism).

node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");

let data = "";
process.stdin.on("data", (d) => { data += d; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(0);
  }

  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  // transcript_path/cwd are per-session and always present alongside
  // session_id in practice; falling back to them (instead of a shared
  // "unknown" literal) keeps two sessions that both somehow lack
  // session_id from sharing -- and corrupting -- the elapsed-time state
  // of the other (DevGuru, poller-brain#498 review).
  const sessionKey = input.session_id || input.transcript_path || input.cwd || "unknown";
  const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const stateFile = path.join(os.tmpdir(), `.stop-hook-pending-since-${safeKey}`);

  // Best-effort sweep of stale state files from sessions that never hit
  // the "tasks empty" cleanup branch below -- e.g. one killed by
  // --max-turns while still blocking, exactly the case this hint targets
  // (DevGuru, poller-brain#498 review). Bounds the /tmp leak to ~1h of
  // junk regardless of how a prior session ended.
  const STALE_AFTER_MS = 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(".stop-hook-pending-since-")) continue;
      const full = path.join(os.tmpdir(), name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > STALE_AFTER_MS) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}

  if (tasks.length === 0) {
    try { fs.unlinkSync(stateFile); } catch {}
    process.exit(0);
  }

  const now = Date.now();
  let since = now;
  try {
    since = parseInt(fs.readFileSync(stateFile, "utf8"), 10) || now;
  } catch {
    try { fs.writeFileSync(stateFile, String(now)); } catch {}
  }
  const elapsedSec = Math.round((now - since) / 1000);

  const desc = tasks
    .map((t) => (t && (t.description || t.task_id)) || "background task")
    .join(", ");

  const ESCALATE_AFTER_SEC = 45;
  const base = `Unresolved background subagent(s) still running: ${desc}. ` +
    "Do not end this turn yet -- if the session goes idle before they " +
    "finish, delivery is not guaranteed (poller-brain#496). Check on " +
    "them (e.g. ListAgents); if still running, pace your checks (a " +
    "short sleep, or other independent work in between) instead of " +
    "retrying immediately -- this hook fires again on every check " +
    "until they finish, and --max-turns bounds the worst case, not " +
    "the cost.";

  const reason = elapsedSec < ESCALATE_AFTER_SEC ? base : base +
    ` This has now been blocking for ~${elapsedSec}s. If this is expected ` +
    "to take on the order of minutes, or has an external waiting party " +
    "(CI/deploy watch, a long build), you are at real risk of losing the " +
    "result to --max-turns exhaustion -- that failure is now visible " +
    "(poller surfaces it as a Slack error), not silent, but the result " +
    "is still lost. For anything that long, this is not the right tool: " +
    "use the background-task skill (bg-task.mjs) instead, which survives " +
    "independently of this session.";

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
});
'
