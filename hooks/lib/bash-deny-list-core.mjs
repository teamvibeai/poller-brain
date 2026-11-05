/**
 * Default bash deny-list — typo/accident protection, NOT adversarial
 * defense. See docs/bash-security-hardening.md and teamvibeai/teamvibe.ai#340.
 * Only literal simple commands are understood; uncertain syntax fails open.
 * Shell wrappers, expansions, etc. remain accepted bypasses. The enforcement
 * boundary is tracked separately as teamvibeai/teamvibe.ai#344.
 */

// Split literal words and command boundaries without executing shell input.
// Unsupported syntax (expansions, redirects, compound commands) fails open.
function simpleCommands(input) {
  const commands = [];
  let words = [], word = "", started = false, quote = null;
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") {
      const next = input[++i];
      if (next === undefined) return [];
      if (next !== "\n") {
        // Inside double quotes, backslash only escapes these characters.
        if (quote === '"' && !'\\"$`'.includes(next)) word += "\\";
        word += next;
        started = true;
      }
    } else if (quote && ch === quote) {
      quote = null;
    } else if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      started = true;
    } else if (quote !== "'" && (ch === "`" || ch === "$")) {
      if (ch !== "$" || input[i + 1] !== "$") return [];
      word += "$$"; // Known PID expansion, used in /proc/$$/mem.
      started = true;
      i++;
    } else if (quote) {
      word += ch;
    } else if ("<>(){}".includes(ch)) {
      return [];
    } else if (ch === "#" && !started) {
      while (i < input.length && input[i] !== "\n") i++;
      i--; // Let the newline finish this simple command.
    } else if ("&;|\n".includes(ch)) {
      finishWord();
      let separator = ch;
      if ("&|".includes(ch) && input[i + 1] === ch) separator += input[++i];
      // Empty boundaries (including continuation newlines/comments) keep adjacency.
      if (words.length) commands.push({ words, separator });
      words = [];
    } else if (ch === " " || ch === "\t") {
      finishWord();
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  finishWord();
  if (words.length) commands.push({ words, separator: "" });
  // Support the existing literal `sudo command ...` forms, without guessing options.
  return commands.map(({ words, separator }) => ({
    words: words[0] === "sudo" ? words.slice(1) : words,
    separator,
  }));
}

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
