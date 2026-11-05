# Bash tool security hardening

Part of [teamvibeai/teamvibe.ai#52](https://github.com/teamvibeai/teamvibe.ai/issues/52)
(epic). This doc covers the two pieces shipped in
[#340](https://github.com/teamvibeai/teamvibe.ai/issues/340).

## A — Default deny-list (base-brain, applies to every channel)

`hooks/bash-deny-list.mjs` is wired as a `PreToolUse` hook on the `Bash`
matcher in this repo's `settings.json`. It denies a short list of
catastrophic command patterns — see `hooks/lib/bash-deny-list-core.mjs` for
the exact rules (currently: `rm -rf /`, pipe-to-shell downloads,
`/proc/*/mem` reads, `~/.ssh/*` reads, `.env` reads).

The hook runs with plain `node` (no install/build step). A denial exits 0
and writes the same `hookSpecificOutput` JSON as the other `PreToolUse`
hooks; an allow or malformed payload exits 0 without output. CI discovers
`hooks/__tests__/bash-deny-list.test.mjs` and runs it directly with Node.

### Compatibility and false positives

The matcher splits literal shell words, respecting quotes and command
boundaries (`&&`, `||`, `;`, `|`, `&`, and newlines). Rules inspect the
command word and its arguments; the download-to-shell rule checks adjacent
pipeline stages. Quoted command text in commit messages or prompts is allowed.
Unsupported syntax (including redirects and most expansions) or unclosed quotes
is allowed silently, following the policy to deny only when certain.

Some broad file rules still affect legitimate reads:

- `rm -rf ./dist` is allowed (a scoped deletion).
- `cat .env.example` is denied: `.env` followed by a dot matches the same
  rule as `.env.production`. The hook cannot determine whether it is a
  secret or an example file.
- `grep -r foo ~/.ssh/config` is allowed: `grep` is outside the fixed list
  of read commands. This keeps a routine configuration search working,
  but also leaves a known bypass; it is not evidence that `grep` is safe.
- `cat ~/.ssh/config` and `cat ~/.ssh/known_hosts` are denied along with
  private keys; the rule covers every file under `.ssh/`.
- `echo 'cat .env'` and `cat package.json && git check-ignore .env` are allowed:
  neither simple command reads a matching file.

### Threat model — read this before treating it as "bash is solved"

This is a **floor, not a ceiling**. It protects against typos and naive
dangerous commands, **not** against a prompt-injected or adversarial agent:

- The spawned session runs as **root**. `settings.json` itself is
  writable by the running session — there is no OS-level enforcement
  boundary stopping an agent from editing or removing this hook.
- A `PreToolUse` hook can itself return an `allow` decision and bypass the
  permission system, so a compromised/adversarial agent isn't meaningfully
  constrained by this file existing.
- The deny-list only understands literal simple commands. It is
  **trivially bypassed** by `bash -c '...'`, variable indirection
  (`$VAR`), `base64 -d | sh`-style decode-pipes, or any command that
  doesn't literally match one of the patterns. This is a known, accepted
  limitation — not a bug to fix here.

The only real hard boundary — `managed-settings.json` +
`allowManagedHooksOnly` + `allowManagedPermissionRulesOnly` +
non-root execution — is tracked separately as
[teamvibeai/teamvibe.ai#344](https://github.com/teamvibeai/teamvibe.ai/issues/344)
and is out of scope here.

### Live-fire verification — REQUIRED immediately after merge, not deferred

Tests here prove the matcher's logic and the hook's stdin/stdout
contract (see `hooks/__tests__/bash-deny-list.test.mjs`). They do **not**
prove the hook actually fires and blocks inside a real poller/bot session.
There is direct
precedent for that gap: `poller-brain#387` documents a different
`PreToolUse` hook (on `mcp__slack__send_message`) that returned the
correct deny JSON when invoked manually with the exact same payload, yet
silently did not fire in a live poller session — the tool call went
through anyway. At the original review, `#387` was still open; a maintainer
noted "needs a live empirical test, not a code read." A nested end-to-end test from inside
another agent session isn't possible either — it requires a CLI login
this runtime doesn't have (confirmed while reviewing this issue).

So, before this deny-list can be relied on:

1. In an isolated/test channel brain, place a **fake** (non-functional)
   `~/.ssh/id_rsa` file — never a real key.
2. Through a real bot/poller session (not a manual script invocation),
   ask the agent to run `cat ~/.ssh/id_rsa`.
3. Confirm the tool call is denied (no file content reaches the
   conversation; the hook itself exits 0 with stdout JSON containing
   `hookSpecificOutput.permissionDecision: "deny"`) — not just that the
   hook script itself would have returned the right thing if invoked directly.
4. If it does *not* block: revert the `hooks.PreToolUse` entry in
   `settings.json` immediately (the deny-list becomes dead code, not a
   safety regression, if removed) and reopen `#340` with the empirical
   result, cross-linked to `#387`.

## B — Project allowlists do not remove inherited Bash access

The base-brain `permissions.allow` includes a blanket `"Bash"` grant.
Claude Code [merges lists across settings files](https://code.claude.com/docs/en/settings#lists-merge-instead-of-overriding),
including `permissions.allow`. A channel-brain `.claude/settings.json` with
only specific Bash commands adds grants; it does not replace the inherited
blanket grant. Allowlist-only mode is therefore not achievable from a
project file today while this base-brain grant remains.

The deny-list hook above still blocks its matching commands. Project
`permissions.deny` rules can add restrictions because deny rules take
precedence over allow rules; they do not turn an additive allowlist into
allowlist-only mode. Removing inherited grants requires changing the source
configuration or managed policy, outside this project-file convention.
