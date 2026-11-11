---
name: brain-write
description: Create, edit, or delete channel-brain skills, commands, and agents under .claude/, or the brain-root .mcp.json, through a constrained local script.
---

Run from the channel brain's git root (CWD), with the complete replacement content:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md --from /tmp/demo.md
printf '%s\n' '# Demo' | npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md --delete
```

Allowed targets are files below `.claude/skills/`, `.claude/commands/`, and `.claude/agents/`,
plus the literal brain-root `.mcp.json`.
CWD must not resolve to or inside `$CLAUDE_CONFIG_DIR` or `$BRAIN_ROOT`: the base brain is never writable.
Skill-local `hooks` files and files below skill-local `hooks/` directories are skill content and allowed.
All symlink components (even links within an allowed directory), absolute paths, `..`, and
`settings*.json` names anywhere are refused. `.claude/hooks/` is refused.
Input is limited to 512 KiB; writes create parents and atomically replace the file.
Parent directories are opened and their real locations and identities verified before filesystem mutations.
Linux operations use directory descriptor paths; other platforms retain a small check-to-syscall race
because Node has no directory-relative mutation API there.
Deletion removes one regular file, never a directory. The script prints a change summary.
Commit changes as usual; the script does not commit.

Use this skill to add, update, or remove channel MCP server declarations in the protected
brain-root `.mcp.json`. Supply the complete replacement JSON, preserving any other servers:

```bash
cat > /tmp/channel-mcp.json <<'JSON'
{"mcpServers":{"sitebrew":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"${SITEBREW_MCP_AUTHORIZATION:-}"}}}}
JSON
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .mcp.json --from /tmp/channel-mcp.json
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" --delete .mcp.json
```

Only `mcpServers` is allowed at the top level. Each server must use stdio (`command`, optional
`args`/`env`, optional `type: "stdio"`) or `type: "http"|"sse"` (`url`, optional `headers`).
URLs require HTTPS, except HTTP on localhost or loopback addresses. Userinfo (`user:pass@`),
query strings, fragments, and whole-URL `${VAR}` references are refused. Unknown fields are refused.
Names use 1–64 letters, digits, underscores, or hyphens; `slack`, `teamvibe-api`, and `teamvibe`
are reserved for the poller's legacy and merged base transports
([teamvibe.ai main, mcp-session.ts:159](https://github.com/teamvibeai/teamvibe.ai/blob/main/packages/poller/src/mcp-session.ts#L159),
[merged transport:187](https://github.com/teamvibeai/teamvibe.ai/blob/main/packages/poller/src/mcp-session.ts#L187)).
The input and canonical output are each limited to 64 KiB and 32 servers. Every string
(including command, each arg, URL, env/header values, and names/map keys) is limited to 4 KiB.
UTF-8 BOMs and duplicate object keys at any depth are refused. After validation the script writes
exactly `JSON.stringify(parsed, null, 2) + "\n"`; formatting-only changes report unchanged.

Credential names are split on hyphens, underscores, dots, and camelCase, then lowercased.
A name is credential-bearing if any segment is `secret`, `token`, `password`, `passwd`, `pwd`,
`credential`, `credentials`, `auth`, `authorization`, `bearer`, `cookie`, `apikey`, or `privatekey`,
or a segment pair is `api`, `access`, `private`, `secret`, `client`, or `signing` followed by `key`.
`key` alone, `sort-key`, and `primary-key` are ordinary names. This same rule applies to env keys,
header names (including `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, and
`X-Auth-Token`), and arg names in `--flag=value`, `--flag value`, or anchored `NAME=value` forms.
Credential values must be exactly `${VAR}` or `${VAR:-}` (empty default only), optionally
preceded by exactly `Bearer `, `Basic `, or `Token `. Variable names must match `[A-Z_][A-Z0-9_]*`.
Store credentials via platform secrets. Literal defaults, mixed literal/reference values,
multiple references, and missing credential flag values are refused.

Other env/header values may be ordinary literals, such as `NODE_ENV=production` or
`User-Agent: my-client`. Every env, header, arg, command, and URL value is still checked for
literal secrets: Bearer/Basic/Token values without references, known token prefixes (`sk-`,
`ghp_`, `gho_`, `github_pat_`, `xox[abpr]-`, `AKIA`, `glpat-`), JWTs with three base64url segments,
and PEM headers. No header name bypasses this check.

The poller's 4 KiB reminder budget also applies: 128 bytes are reserved for its summary, and
server metadata lines include separators, sorted/deduplicated reference names, and the largest
possible missing-variable list (or `none`, if longer). This check assumes any required variable
may be absent, regardless of the writer's environment, and refuses the entire write if any server
would exceed the budget. It mirrors #795 (`ac085e9f`),
[teamvibe.ai main, brain-mcp.ts:9](https://github.com/teamvibeai/teamvibe.ai/blob/main/packages/poller/src/brain-mcp.ts#L9),
[line accounting:64](https://github.com/teamvibeai/teamvibe.ai/blob/main/packages/poller/src/brain-mcp.ts#L64), and
[references/missing names:125](https://github.com/teamvibeai/teamvibe.ai/blob/main/packages/poller/src/brain-mcp.ts#L125).
Output lists server and referenced variable names only.
Tools require poller ≥ 0.8.12 to be auto-allowed.

Propose changes to `.claude/settings*.json` or `.claude/hooks/` via Slack approval.
Never use the GitHub API to bypass protected-path restrictions.
