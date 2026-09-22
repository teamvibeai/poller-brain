#!/bin/bash
# PreToolUse hook: deny mcp__slack__send_message when `text` contains GFM-style
# `**bold**` (double asterisk) instead of Slack's own `*bold*` (single asterisk).
#
# Why: Slack does not render `**text**` as bold -- it renders literally as
# `**text**` with the asterisks visible. Base-brain CLAUDE.md documents the
# correct single-asterisk syntax under Response Guidelines, but the model has
# a strong training-data prior toward standard GFM `**bold**` that overrides
# the documented convention often enough to be a repeated, cross-agent pattern
# (Jakub, poller-brain#494 feedback thread, 2026-09-22: "sem tam se stava, ze
# nekteri agenti pisou **boldem**" -- observed on a different agent/channel,
# not a one-off). A live example reached a real user-facing message before
# anyone caught it (channel C0AKRUB4MS7, an investment-advice thread).
#
# Catching this after the fact (a PostToolUse reminder) is too late -- the
# malformed message has already reached Slack. This denies BEFORE send, same
# pattern as block-background-escapes.sh, so the agent corrects the text and
# retries in the same turn.
#
# Code spans and fenced code blocks are stripped before matching, so a
# legitimate `**` inside a code sample (e.g. `2**8`) does not trip this.
# Pattern matching is not airtight (obfuscation is possible in principle) --
# acceptable here since agents aren't adversarial, just reaching for a
# familiar Markdown habit. See poller-brain#494 (feedback digest #475).

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
  const text = typeof toolInput.text === "string" ? toolInput.text : "";

  // Strip fenced code blocks and inline code spans first, so a literal `**`
  // inside a code sample cannot trigger a false positive.
  const stripped = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

  const match = stripped.match(/\*\*([^*\n]+)\*\*/);
  if (match) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Slack does not render **" + match[1].slice(0, 40) + "** as bold -- " +
          "the double asterisks show up literally. Use single-asterisk *bold* " +
          "instead (see CLAUDE.md Response Guidelines). Fix the text and resend.",
      },
    }));
    process.exit(0);
  }

  process.exit(0);
});
'
