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
function shortOptionContext(words) {
  let i = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i] ?? "")) i++;
  };
  skipAssignments();
  while (["sudo", "command", "env"].includes(words[i])) {
    const wrapper = words[i++];
    if (wrapper === "env") skipAssignments();
    if (!words[i] || words[i].startsWith("-")) return {};
  }
  if (words[i] === "curl") return { start: i + 1, curl: true };
  if (words[i++] !== "git") return {};
  while (i < words.length) {
    if (words[i] === "--no-pager") i++;
    else if (words[i] === "-C" && words[i + 1]) i += 2;
    else break;
  }
  return words[i] === "log" ? { start: i + 1, curl: false } : {};
}

// A curl short option consumes the rest of its word as soon as it takes a
// value. In particular, p never exempts a bundled u/U or its argument. Unknown
// options withhold further exemptions; their characters cannot prove safety.
const CURL_NO_VALUE = new Set("012346aBfgGhiIjJklLnNOpqRsSvVZ");
const CURL_VALUE = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz");
const CURL_LONG_VALUE = new Set(["--proxy", "--header", "--user", "--proxy-user"]);
function shortOptionPolicy(words) {
  const nonsecretP = new Set(), credentials = new Set();
  const { start, curl } = shortOptionContext(words);
  if (start === undefined) return { nonsecretP, credentials };
  let uncertainStart;
  for (let i = start; i < words.length; i++) {
    const word = words[i];
    if (!curl) {
      if (/^-p[^\s]*$/.test(word)) nonsecretP.add(i);
      else if (CURL_LONG_VALUE.has(word) || ["-x", "-H", "-u", "-U"].includes(word)) i++;
      else break;
      continue;
    }
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equal = word.indexOf("=");
      const flag = equal === -1 ? word : word.slice(0, equal);
      if (["--user", "--proxy-user"].includes(flag)) {
        if (equal === -1) credentials.add(++i);
        else if (!isEnvVarRef(word.slice(equal + 1))) credentials.add(i);
      } else if (CURL_LONG_VALUE.has(flag)) {
        if (equal === -1) i++;
      } else uncertainStart ??= i;
      continue;
    }
    // curl allows options after URL operands as well.
    if (!word.startsWith("-") || word === "-") continue;
    if (word === "-p" && uncertainStart === undefined) nonsecretP.add(i);
    for (let j = 1; j < word.length; j++) {
      const flag = word[j];
      if (flag === "u" || flag === "U") {
        if (j + 1 === word.length) credentials.add(++i);
        else if (!isEnvVarRef(word.slice(j + 1))) credentials.add(i);
        break;
      }
      if (CURL_VALUE.has(flag)) {
        if (j + 1 === word.length) i++;
        break;
      }
      if (!CURL_NO_VALUE.has(flag)) uncertainStart ??= i;
    }
  }
  // After an unresolved option, even -- or another value-taking flag could
  // itself be an argument. Do not guess which later u/U occurrence is active.
  const omit = uncertainStart !== undefined && words.slice(uncertainStart).some(word =>
    /^--(?:user|proxy-user)(?:=|$)/.test(word) || (/^-[^-]/.test(word) && /[uU]/.test(word.slice(1))));
  return { nonsecretP, credentials, omit };
}

// Walk each candidate once, balancing nested subscripts and literal quotes.
// Shell quote removal loses provenance: a ]= at ANY depth may be the real
// terminator (e.g. TOKEN['public[0']=...). Only a single plain subscript is
// delegated to redactWord; uncertain/compound extents omit the whole command.
function unsupportedArrayAssignment(words) {
  if (words.some(word => word.includes("\0"))) return true;
  // Preserve word boundaries without confusing whitespace inside quoted words.
  const text = words.join("\0");
  const candidates = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*\[/g;
  while (candidates.exec(text)) {
    let depth = 1, quote = null, simple = true, sawEquals = false;
    let i = candidates.lastIndex;
    const indexStart = i;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\0" && depth === 0 && !quote) break;
      if (ch === "=" && (depth > 0 || quote)) sawEquals = true;
      if (ch === "]" && (text[i + 1] === "=" || text.slice(i + 1, i + 3) === "+=")) {
        if (!simple || depth !== 1 || quote || i === indexStart) return true;
        // A supported simple index is handled by redactWord, including any
        // trailing literal. Continue looking for other assignments in the word.
        break;
      }
      if (ch === "\\") {
        simple = false;
        // The escaped character could hide a terminator after quote removal.
        continue;
      }
      if (ch === "'" || ch === '"') {
        simple = false;
        if (quote === ch) quote = null;
        else if (!quote) quote = ch;
      } else if (!quote && ch === "[") {
        depth++;
        simple = false;
      } else if (!quote && ch === "]") {
        depth--;
        simple = false;
      } else if (!/[A-Za-z0-9_]/.test(ch)) simple = false;
    }
    if ((depth > 0 || quote) && sawEquals) return true;
    candidates.lastIndex = i + 1;
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
    const { nonsecretP: nonsecretPOptions, credentials, omit } = shortOptionPolicy(words);
    if (omit || unsupportedArrayAssignment(words)) {
      changed = true;
      return MARKER + (separator ? ` ${separator} ` : "");
    }
    const headers = redactHeaders(words);
    if (headers.length !== words.length || headers.some((word, i) => word !== words[i])) changed = true;
    const safe = headers.map((word, i) => {
      const nonsecretP = nonsecretPOptions.has(i);
      const shortValue = words[i - 1] === "-p" && (!nonsecretPOptions.has(i - 1) || mixedReference(word));
      const secretValue = credentials.has(i) || SECRET_FLAGS.has(words[i - 1]) || shortValue;
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
