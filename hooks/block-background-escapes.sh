#!/bin/bash
# PreToolUse hook: deny Bash(run_in_background: true) and manual
# setsid/disown detachment in favor of the background-task skill (bg-task.mjs).
#
# Why: two independent bare `claude -p` tests (2026-09-22, poller-brain#478
# thread) confirmed run_in_background never survives past the end of the
# current turn -- Claude Code's own internal task manager kills it itself
# the moment the turn ends, regardless of our poller's watchdog or output
# format. An agent reaching for it to wait on something with an external
# waiting party (CI watch, deploy watch) silently loses the result. bg-task
# is the only path proven to survive, because it detaches via setsid into
# its own process group -- outside the reach of the session's own cleanup.
#
# setsid/disown typed directly into a plain Bash command is the same trick
# done by hand, without bg-task's safety net: no TTL, no tracking, no
# .inbox delivery. Worse than run_in_background -- it neither reports a
# result nor ever gets cleaned up, becoming a permanent untracked leak on
# shared poller storage. nohup alone is NOT blocked here: it only ignores
# SIGHUP, not SIGTERM/SIGKILL, so a plain `nohup cmd &` child stays in the
# session's process group and is still caught by the existing
# sweepProcessGroup() cleanup -- it doesn't actually escape.
#
# Command-string pattern matching is not airtight (obfuscation is possible
# in principle) -- acceptable here since agents aren't adversarial, just
# reaching for familiar Unix patterns. See poller-brain#488.

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

  const toolInput = input.tool_input || {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";

  const deny = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  };

  if (toolInput.run_in_background === true) {
    deny(
      "Bash(run_in_background: true) never survives past the end of this turn " +
      "-- Claude Code kills it itself the moment the turn ends (confirmed " +
      "empirically, poller-brain#478/#488). Use the background-task skill " +
      "(bg-task.mjs) for anything that needs to outlive this turn."
    );
    return;
  }

  if (/\bsetsid\b/.test(command) || /\bdisown\b/.test(command)) {
    deny(
      "setsid/disown manually re-implements the detachment trick bg-task " +
      "uses internally, without its safety net (no TTL, no tracking, no " +
      "delivery) -- the process escapes cleanup but never reports a " +
      "result, becoming a permanent untracked leak. Use the background-task " +
      "skill (bg-task.mjs) instead."
    );
    return;
  }

  process.exit(0);
});
'
