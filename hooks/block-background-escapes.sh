#!/bin/bash
# PreToolUse hook: deny Bash(run_in_background: true), manual setsid/disown
# detachment and plain shell backgrounding; use background-task (bg-task.mjs).
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
# shared poller storage. Plain shell backgrounding (including `nohup cmd &`)
# is blocked too (poller-brain#546): those children stay in the session's
# process group and die with turn/session cleanup, silently losing work.
# Foreground nohup alone is still allowed.
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
    process.stderr.write(reason + "\n");
    process.exit(2);
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

  // Mask data before looking for operators. This is deliberately a small
  // shell-text scanner, not a full Bash parser: quoted strings, escaped
  // characters, comments and queued heredoc bodies are ignored here.
  const heredocs = [];
  let shell = "";
  for (let i = 0; i < command.length;) {
    const rest = command.slice(i);
    const quoted = /^(?:\x27[^\x27]*\x27|"(?:\\[\s\S]|[^"\\])*")/.exec(rest);
    if (quoted) {
      shell += "Q";
      i += quoted[0].length;
      continue;
    }
    if (rest[0] === "\\") {
      // A line continuation joins tokens; other escapes are literal data.
      shell += rest[1] === "\n" ? "" : "Q";
      i += Math.min(2, rest.length);
      continue;
    }
    if (rest[0] === "#" && (i === 0 || /[\s;(){}|&]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
      continue;
    }
    // <<< is a here-string, not a heredoc. Delimiters can be bare,
    // single/double quoted or backslash quoted; <<- strips leading tabs.
    const heredoc = /^<<(-)?[ \t]*((?:\x27[^\x27]*\x27|"[^"\n]*"|\\[^\n]|[^\s<>;&|(){}\x27"\\])+)/.exec(rest);
    if (rest.startsWith("<<<")) {
      shell += "<<<";
      i += 3;
      continue;
    }
    if (heredoc) {
      const delimiter = heredoc[2].replace(/\x27([^\x27]*)\x27|"([^"]*)"|\\(.)/g,
        (_, single, double, escaped) => single ?? double ?? escaped);
      heredocs.push({ delimiter, stripTabs: Boolean(heredoc[1]) });
      shell += "<<Q";
      i += heredoc[0].length;
      continue;
    }
    shell += command[i++];
    if (rest[0] === "\n") {
      // Bodies begin after the command line; consume multiple heredocs
      // in declaration order, preserving commands after their terminators.
      while (heredocs.length) {
        const { delimiter, stripTabs } = heredocs.shift();
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
    }
  }

  // Consume non-background ampersand operators first: AND, redirects
  // (including fd duplication), and stderr pipes. Any remaining & is a
  // shell async-list terminator, even before another command (cmd & wait).
  const ampersands = /&&|&>>?|[<>]&|\|&|(&)/g;
  if ([...shell.matchAll(ampersands)].some((match) => match[1])) {
    deny(
      "Plain shell backgrounding (cmd &, including nohup cmd &) dies with " +
      "turn/session cleanup and can silently lose work (poller-brain#546). " +
      "Use the background-task skill (bg-task.mjs) for anything that needs " +
      "to outlive this turn."
    );
    return;
  }

  process.exit(0);
});
'
