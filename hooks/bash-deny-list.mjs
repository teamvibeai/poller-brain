#!/usr/bin/env node
/**
 * PreToolUse hook for the Bash tool — denies a short list of catastrophic
 * command patterns (typo/accident protection, not adversarial defense).
 *
 * See hooks/lib/bash-deny-list-core.mjs and
 * docs/bash-security-hardening.md for the pattern list and threat model.
 *
 * Wired via settings.json:
 *   hooks.PreToolUse[] matcher "Bash" -> this script.
 *
 * Contract (matches the other PreToolUse hooks): read tool-call JSON from
 * stdin, exit 0 with stdout JSON permissionDecision: "deny" to block,
 * exit 0 silently to allow. Any parse/shape failure
 * fails OPEN (exit 0) rather than blocking unrelated tool calls — this is
 * a best-effort floor, not a boundary that must never fail closed.
 */

import { checkBashCommand } from "./lib/bash-deny-list-core.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  if (payload?.tool_name !== "Bash") {
    process.exit(0);
    return;
  }

  const command = payload.tool_input?.command;
  if (typeof command !== "string") {
    process.exit(0);
    return;
  }

  const match = checkBashCommand(command);
  if (match.denied) {
    const reason =
      `Blocked by bash-deny-list (${match.ruleId}): ${match.reason}\n` +
        `This is a floor against typos/naive commands, not a security boundary — ` +
        `see docs/bash-security-hardening.md. If this command is genuinely intended, ` +
        `it cannot be run as written; rephrase or ask a human to run it out-of-band.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
  }

  process.exit(0);
}

main();
