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
# that Stop block/force-continue genuinely works, so no separate timeout
# logic is added here; a task that never finishes just runs out the
# existing turn budget like any other stuck work would.

node -e '
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

  if (tasks.length === 0) {
    process.exit(0);
  }

  const desc = tasks
    .map((t) => (t && (t.description || t.task_id)) || "background task")
    .join(", ");

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `Unresolved background subagent(s) still running: ${desc}. ` +
      "Do not end this turn yet -- if the session goes idle before they " +
      "finish, delivery is not guaranteed (poller-brain#496). Check on " +
      "them (e.g. ListAgents); if still running, pace your checks (a " +
      "short sleep, or other independent work in between) instead of " +
      "retrying immediately -- this hook fires again on every check " +
      "until they finish, and --max-turns bounds the worst case, not " +
      "the cost.",
  }));
});
'
