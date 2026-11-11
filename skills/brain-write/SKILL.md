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
{"mcpServers":{"sitebrew":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${SITEBREW_MCP_TOKEN:-}"}}}}
JSON
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .mcp.json --from /tmp/channel-mcp.json
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" --delete .mcp.json
```

Only `mcpServers` is allowed at the top level. Each server must use stdio (`command`, optional
`args`/`env`, optional `type: "stdio"`) or `type: "http"|"sse"` (`url`, optional `headers`).
URLs require HTTPS, except HTTP on localhost or loopback addresses. Unknown fields are refused.
Names use 1–64 letters, digits, underscores, or hyphens; `slack` and `teamvibe-api` are reserved.
The file is limited to 64 KiB and 32 servers; each env/header value is limited to 4 KiB.
Store credentials via platform secrets and reference them as `${VAR}` or `${VAR:-default}`;
literal credentials in env/headers are refused. Output lists server and referenced variable names only.
Tools require poller ≥ 0.8.12 to be auto-allowed.

Propose changes to `.claude/settings*.json` or `.claude/hooks/` via Slack approval.
Never use the GitHub API to bypass protected-path restrictions.
