/**
 * Default bash deny-list — typo/accident protection, NOT adversarial
 * defense. See docs/bash-security-hardening.md and teamvibeai/teamvibe.ai#340.
 * Only literal simple commands are understood; uncertain syntax fails open.
 * Shell wrappers, expansions, etc. remain accepted bypasses. The enforcement
 * boundary is tracked separately as teamvibeai/teamvibe.ai#344.
 */

import { simpleCommands } from "./shell-tokenizer.mjs";

const READ_COMMANDS = new Set([
  "cat", "less", "more", "head", "tail", "strings", "xxd", "hexdump", "od", "base64",
]);
const RULES = [
  {
    id: "rm-rf-root",
    matches: ([cmd, ...args]) => {
      const flags = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
      return cmd === "rm" && args.some(arg => arg === "/" || arg === "/*") &&
        flags.some(arg => arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg)) &&
        flags.some(arg => arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg));
    },
    reason: "recursive force-delete of the root filesystem (rm -rf /)",
  },
  {
    id: "pipe-to-shell",
    matches: ([cmd], next, separator) =>
      ["curl", "wget"].includes(cmd) && separator === "|" &&
      ["sh", "bash", "zsh"].includes(next?.words[0]),
    reason: "piping a network download directly into a shell interpreter",
  },
  {
    id: "proc-mem-read",
    matches: ([cmd, ...args]) =>
      (READ_COMMANDS.has(cmd) && args.some(arg => /^\/proc\/(?:\d+|\$\$|self)\/mem$/.test(arg))) ||
      (cmd === "dd" && args.some(arg => /^if=\/proc\/(?:\d+|\$\$|self)\/mem$/.test(arg))),
    reason: "reading process memory via /proc/*/mem",
  },
  {
    id: "ssh-key-read",
    matches: ([cmd, ...args]) => READ_COMMANDS.has(cmd) &&
      args.some(arg => /(?:^|\/)\.ssh\/.+/.test(arg)),
    reason: "reading files under ~/.ssh/",
  },
  {
    id: "dotenv-read",
    matches: ([cmd, ...args]) => READ_COMMANDS.has(cmd) &&
      args.some(arg => /(?:^|\/)\.env(?:$|\.)/.test(arg)),
    reason: "reading a .env file",
  },
];

export function checkBashCommand(command) {
  const commands = simpleCommands(command);
  for (const rule of RULES) {
    if (commands.some(({ words, separator }, i) => rule.matches(words, commands[i + 1], separator))) {
      return { denied: true, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { denied: false };
}
