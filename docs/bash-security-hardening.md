# Bash tool security hardening

Part of [teamvibeai/teamvibe.ai#52](https://github.com/teamvibeai/teamvibe.ai/issues/52)
(epic). This doc covers the two pieces shipped in
[#340](https://github.com/teamvibeai/teamvibe.ai/issues/340).

## A — Default deny-list (base-brain, applies to every channel)

`hooks/bash-deny-list.ts` is wired as a `PreToolUse` hook on the `Bash`
matcher in this repo's `settings.json`. It denies a short list of
catastrophic command patterns — see `hooks/lib/bash-deny-list-core.ts` for
the exact rules (currently: `rm -rf /`, pipe-to-shell downloads,
`/proc/*/mem` reads, `~/.ssh/*` reads, `.env` reads).

### Threat model — read this before treating it as "bash is solved"

This is a **floor, not a ceiling**. It protects against typos and naive
dangerous commands, **not** against a prompt-injected or adversarial agent:

- The spawned session runs as **root**. `settings.json` itself is
  writable by the running session — there is no OS-level enforcement
  boundary stopping an agent from editing or removing this hook.
- A `PreToolUse` hook can itself return an `allow` decision and bypass the
  permission system, so a compromised/adversarial agent isn't meaningfully
  constrained by this file existing.
- The deny-list is a plain regex scan of the raw command text. It is
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

Unit tests here only prove the regex matcher's own logic (see
`hooks/bash-deny-list.test.ts`). They do **not** prove the hook actually
fires and blocks inside a real poller/bot session. There is direct
precedent for that gap: `poller-brain#387` documents a different
`PreToolUse` hook (on `mcp__slack__send_message`) that returned the
correct deny JSON when invoked manually with the exact same payload, yet
silently did not fire in a live poller session — the tool call went
through anyway. `#387` is still open; a maintainer noted "needs a live
empirical test, not a code read." A nested end-to-end test from inside
another agent session isn't possible either — it requires a CLI login
this runtime doesn't have (confirmed while reviewing this issue).

So, before this deny-list can be relied on:

1. In an isolated/test channel brain, place a **fake** (non-functional)
   `~/.ssh/id_rsa` file — never a real key.
2. Through a real bot/poller session (not a manual script invocation),
   ask the agent to run `cat ~/.ssh/id_rsa`.
3. Confirm the tool call is denied (exit 2, no file content reaches the
   conversation) — not just that the hook script itself would have
   returned the right thing if invoked directly.
4. If it does *not* block: revert the `hooks.PreToolUse` entry in
   `settings.json` immediately (the deny-list becomes dead code, not a
   safety regression, if removed) and reopen `#340` with the empirical
   result, cross-linked to `#387`.

## B — Allowlist-only convention for high-security channel brains

The default `permissions.allow` in base-brain includes a blanket `"Bash"`
entry, which lets the agent run any command not caught by the deny-list
above (i.e., "block a known-bad list", not "only allow a known-good
list"). For a channel brain that handles unusually sensitive data or
credentials and wants a tighter default, a channel-brain-level
`.claude/settings.json` can **replace** the blanket `Bash` permission with
an explicit allowlist of specific commands instead:

```jsonc
// channel-brain .claude/settings.json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(npm test)"
      // ... explicit commands only — no blanket "Bash"
    ]
  }
}
```

This is purely a configuration convention — no new platform code. It is
opt-in per channel brain (this doc does not change any default), and it
still inherits the base-brain deny-list above for whatever commands *are*
allowed to run. Note this doesn't compose with a per-brain configurable
knob for the deny-list itself — that remains out of scope (tracked on the
parent epic #52) — this only lets an operator narrow `Bash` further, not
change what the shared deny-list blocks.
