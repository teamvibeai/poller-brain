/**
 * Secret-shaped literal redaction for bash.command telemetry. Reuse the
 * deny-list's tokenizer to decode concatenated quotes and escaped characters.
 * Variable names stay literal; substitutions, heredocs, redirects, comments,
 * and other uncertain syntax omit the entire command. Never execute input.
 * This catches the signatures below, not arbitrary unlabelled credentials.
 */
import { simpleCommands } from "./shell-tokenizer.mjs";

const MARKER = "[REDACTED]";
const SECRET_FLAGS = new Set(["--token", "--password", "--api-key", "--secret"]);
const BOOLEAN_OPTIONS = new Set(["--passWithNoTests", "--pass-with-no-tests"]);
const PEM = /-----BEGIN [^-]*PRIVATE KEY-----/;

// The hook sees the command before shell expansion. A whole $VAR/${VAR}
// reference contains a variable name, not its secret value. Mixed literals
// and references must still be redacted.
function isEnvVarRef(value) {
  return /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value);
}

// These operate on decoded words, so value captures include spaces and quotes.
// Redact the WHOLE word on a match, including any otherwise unmatched tail.
const SIGNATURES = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
];
const VALUES = [
  /(?:--token|--password|--api-key|--secret)[ =]+([\s\S]+)/,
];

// Resolve only literal, explicitly supported invocation forms. Unknown wrappers
// and git options keep password semantics; a later command name proves nothing.
function nonsecretShortPStart(words) {
  let i = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i] ?? "")) i++;
  };
  skipAssignments();
  while (["sudo", "command", "env"].includes(words[i])) {
    const wrapper = words[i++];
    if (wrapper === "env") skipAssignments();
    if (!words[i] || words[i].startsWith("-")) return Infinity;
  }
  if (words[i] === "curl") return i + 1;
  if (words[i++] !== "git") return Infinity;
  while (i < words.length) {
    if (words[i] === "--no-pager") i++;
    else if (words[i] === "-C" && words[i + 1]) i += 2;
    else break;
  }
  return words[i] === "log" ? i + 1 : Infinity;
}

// Assignment-shaped subscripts may span decoded words or contain quoted ']'.
// Do not assume decoded brackets balance. Match an assignment terminator and
// omit uncertain extents; ordinary bracket paths have no such terminator.
function unsupportedArrayAssignment(words) {
  const text = words.join(" ");
  let start = -1;
  for (const match of text.matchAll(/(?<![A-Za-z0-9_./-])[A-Za-z_][A-Za-z0-9_]*\[|\]\+?=/g)) {
    if (match[0].endsWith("[")) start = match.index + match[0].length;
    else if (start !== -1 && !/^[A-Za-z0-9_]+$/.test(text.slice(start, match.index))) return true;
  }
  return false;
}

function mixedReference(value) {
  return /\$(?:[A-Za-z_]|\{)/.test(value) && !isEnvVarRef(value);
}
function credentialHeader(word) {
  // Match each label once, then inspect its suffix. Searching for a suffix
  // directly can backtrack quadratically over long hyphenated arguments.
  for (const match of word.matchAll(/(?:^|[\s=])([A-Za-z0-9_-]+)[ \t]*:/g)) {
    const name = match[1].toLowerCase();
    if (name === "authorization" || name === "proxy-authorization" ||
      ["api-key", "token", "secret", "cookie"].some(suffix => name === suffix || name.endsWith(`-${suffix}`))) {
      return { authorization: name.endsWith("authorization"), value: word.slice(match.index + match[0].length).trim() };
    }
  }
}

function headerIsReference(value, authorization) {
  if (isEnvVarRef(value)) return true;
  const scheme = /^[^\s]+\s+([\s\S]+)$/.exec(value);
  return authorization && scheme && isEnvVarRef(scheme[1]);
}

function redactHeaders(words) {
  const safe = [...words];
  for (let i = 0; i < words.length; i++) {
    // curl also accepts -HAuthorization:... with no intervening space.
    const header = credentialHeader(words[i].replace(/^-H/, ""));
    if (!header) continue;
    const { authorization, value } = header;
    if (headerIsReference(value, authorization)) continue;
    // Bare headers can put their scheme/value in subsequent decoded words.
    // Retain whole references, but omit the command if a literal header's
    // extent is uncertain rather than accidentally retaining a trailing value.
    if (!value || (authorization && !/\s/.test(value))) {
      const next = words[i + 1] ?? "";
      const splitValue = value ? `${value} ${next}` : `${next} ${words[i + 2] ?? ""}`;
      if ((!value && isEnvVarRef(next)) ||
        (authorization && headerIsReference(splitValue.trim(), true))) continue;
      return [MARKER];
    }
    safe[i] = MARKER;
  }
  return safe;
}

function redactWord(word, knownTokens, nonsecretP) {
  // A configured credential may be quote/backslash-split in the raw shell
  // spelling. Inspect decoded words and omit the WHOLE matching word.
  if (knownTokens.some(token => token && word.includes(token))) return MARKER;
  if (SIGNATURES.some(pattern => pattern.test(word))) return MARKER;
  // Split the assignment name from its value before testing the name. Nested
  // greedy quantifiers here could make long key-like words stall the hook.
  for (const match of word.matchAll(/((?<![A-Za-z0-9_-])--[A-Za-z0-9_-]+|\b[A-Za-z0-9_]+)(?:\[[A-Za-z0-9_]+\])?\+?=/g)) {
    const value = word.slice(match.index + match[0].length);
    if (BOOLEAN_OPTIONS.has(match[1]) && match[0] === `${match[1]}=`) {
      if (!/^(?:true|false)$/.test(value) && !isEnvVarRef(value)) return MARKER;
      continue;
    }
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASS)/i.test(match[1]) &&
      !isEnvVarRef(value)) return MARKER;
  }
  for (const pattern of VALUES) {
    const match = pattern.exec(word);
    if (match && !isEnvVarRef(match[1])) return MARKER;
  }
  // Apply the same command policy to separated and attached -p values, while
  // preserving the old protection for embedded flag text in quoted arguments.
  const short = /-p[ =]+([\s\S]+)/.exec(word) ?? /^-p([\s\S]+)/.exec(word);
  if (short && !isEnvVarRef(short[1]) &&
    (!nonsecretP || short.index !== 0 || mixedReference(short[1]))) return MARKER;
  return word;
}

export function redactSecrets(command, { knownTokens = [] } = {}) {
  if (PEM.test(command)) return "[REDACTED PRIVATE KEY]";
  // The shared tokenizer intentionally discards comments. Omit them rather
  // than return uninspected text, even if '#' was inside a quoted argument.
  if (command.includes("#")) return MARKER;
  const commands = simpleCommands(command, { allowEnvReferences: true, stripSudo: false });
  if (!commands.length) return command.trim() ? MARKER : command;
  // Shell quote concatenation can split BEGIN or KEY in the raw text. Detect
  // markers in decoded words too, and omit the whole key-bearing command.
  if (commands.some(({ words }) => PEM.test(words.join(" ")))) return "[REDACTED PRIVATE KEY]";
  let changed = false;
  const sanitized = commands.map(({ words, separator }) => {
    if (unsupportedArrayAssignment(words)) {
      changed = true;
      return MARKER + (separator ? ` ${separator} ` : "");
    }
    const headers = redactHeaders(words);
    const nonsecretPStart = nonsecretShortPStart(words);
    if (headers.length !== words.length || headers.some((word, i) => word !== words[i])) changed = true;
    const safe = headers.map((word, i) => {
      const nonsecretP = i >= nonsecretPStart;
      const shortValue = words[i - 1] === "-p" && (!nonsecretP || mixedReference(word));
      const secretValue = SECRET_FLAGS.has(words[i - 1]) || shortValue;
      const redacted = secretValue && !isEnvVarRef(word) ? MARKER : redactWord(word, knownTokens, nonsecretP);
      if (redacted !== word) changed = true;
      return redacted;
    });
    // This is a readable telemetry representation, never evaluated as shell.
    return safe.map(word => /[\s'";|&]/.test(word) ? JSON.stringify(word) : word).join(" ") +
      (separator ? ` ${separator} ` : "");
  }).join("").trimEnd();
  return changed ? sanitized : command;
}
