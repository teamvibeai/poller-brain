/**
 * Secret-shaped substring redaction for bash.command telemetry
 * (teamvibeai/teamvibe.ai#341).
 *
 * The PostToolUse hook (../bash-telemetry.ts) sees the raw Bash command
 * text before shell/env expansion — so an ordinary `$ENV_VAR` reference in
 * a command is still literally the text "$ENV_VAR" at this point, not the
 * expanded secret value. That means we only need to catch *literal*
 * secret-shaped strings (known token prefixes, `KEY=<value>` assignments,
 * `--token <value>` flags, etc.) — a bare `$ENV_VAR` reference is never a
 * secret at this point and is intentionally left alone. See the "does not
 * redact $ENV_VAR references" test below.
 *
 * Field-exclusion isn't viable here: the command text IS the point of the
 * event (bash.command telemetry exists to observe what commands ran), so
 * we redact in place rather than dropping the field.
 *
 * Rules run in sequence as plain regex replacements (not one giant regex)
 * so each is independently readable, testable, and extendable. A rule that
 * fires can feed into a later rule's input (e.g. an assignment redacted by
 * one rule no longer matches a later rule) — that's fine, redaction never
 * needs to be idempotent-order-independent, only to never leave a literal
 * secret in the output.
 */

export interface RedactRule {
  name: string
  pattern: RegExp
  replace: (match: string, ...groups: string[]) => string
}

// A captured value is a `$VAR`/`${VAR}` reference — optionally wrapped in
// quotes, e.g. `"$TOKEN"` — if the whole thing (quotes stripped) is just
// that reference. It's never a literal secret at hook-time (see file
// header), so rules leave it unredacted by returning the original match.
function isEnvVarRef(value: string): boolean {
  const inner = /^"([^"]*)"$|^'([^']*)'$/.exec(value)
  const unquoted = inner ? (inner[1] ?? inner[2]) : value
  return /^\$\{?\w+\}?$/.test(unquoted)
}

export const RULES: RedactRule[] = [
  {
    // AWS access key IDs, e.g. AKIAABCDEFGHIJKLMNOP
    name: 'aws-access-key-id',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replace: () => '[REDACTED]',
  },
  {
    // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ followed by 36+ base62 chars
    name: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    replace: () => '[REDACTED]',
  },
  {
    // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs- followed by dash-separated segments
    name: 'slack-token',
    pattern: /xox[baprs]-[A-Za-z0-9-]+/g,
    replace: () => '[REDACTED]',
  },
  {
    // Generic KEY=/TOKEN=/SECRET=/PASSWORD=/PASS= assignment, case-insensitive,
    // e.g. `export FOO_TOKEN=abc123`, `PASSWORD=hunter2`, or a quoted
    // multi-word value like `DB_PASSWORD="correct horse battery staple"`.
    // Quoted form is tried first (`"[^"]*"|'[^']*'`) so a \S+-style
    // fallback doesn't truncate at the first space and leak the rest in
    // plaintext (DevGuru review round 1, teamvibe.ai#341). The unquoted
    // fallback (`[^\s"']+`) itself stops at any stray quote char rather
    // than consuming it — needed for e.g. `curl -H "Authorization: Bearer
    // $TOKEN"`, where the value isn't quoted itself but sits inside a
    // caller-quoted argument; a plain \S+ would swallow that trailing `"`
    // and defeat the $VAR exemption below (DevGuru review round 1, same
    // issue for authorization-bearer). The value is left alone (not
    // redacted) when it's a bare or quoted `$VAR` reference — see file
    // header.
    name: 'generic-secret-assignment',
    pattern: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/gi,
    replace: (match, name, value) => (isEnvVarRef(value) ? match : `${name}=[REDACTED]`),
  },
  {
    // --token/--password/--api-key/--secret/-p flag values. Same
    // quoted-first capture, stray-quote-safe fallback, and $VAR exemption
    // as the assignment rule above.
    name: 'cli-secret-flag',
    pattern: /(--token|--password|--api-key|--secret|-p)([ =]+)("[^"]*"|'[^']*'|[^\s"']+)/g,
    replace: (match, flag, sep, value) => (isEnvVarRef(value) ? match : `${flag}${sep}[REDACTED]`),
  },
  {
    // Authorization: Bearer <token> header-style strings. Same
    // stray-quote-safe capture and $VAR exemption as the two rules above —
    // this rule previously lacked both, over-redacting the common `curl -H
    // "Authorization: Bearer $TOKEN"` pattern (DevGuru review round 1,
    // teamvibe.ai#341).
    name: 'authorization-bearer',
    pattern: /(Authorization:\s*Bearer\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    replace: (match, prefix, value) => (isEnvVarRef(value) ? match : `${prefix}[REDACTED]`),
  },
  {
    // PEM-style private key blocks collapse entirely — no partial context
    // is useful/safe to keep for a key block.
    name: 'pem-private-key',
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
]

/**
 * Redacts secret-shaped substrings from a raw Bash command string,
 * replacing just the secret portion (keeping surrounding context, e.g.
 * `--token [REDACTED]` not the whole command blanked).
 */
export function redactSecrets(command: string): string {
  let result = command
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replace as (...args: string[]) => string)
  }
  return result
}
