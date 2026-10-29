---
name: brain-write
description: Create, edit, or delete channel-brain skills, commands, and agents under .claude/ through a constrained local script.
---

Run from the channel brain's git root (CWD), with the complete replacement content:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md --from /tmp/demo.md
printf '%s\n' '# Demo' | npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md
npx tsx "$CLAUDE_CONFIG_DIR/skills/brain-write/scripts/brain-write.ts" .claude/commands/demo.md --delete
```

Only files below `.claude/skills/`, `.claude/commands/`, and `.claude/agents/` are allowed.
Skill-local `hooks` files and files below skill-local `hooks/` directories are skill content and allowed.
All symlink components (even links within an allowed directory), absolute paths, `..`, and
`settings*.json` names anywhere are refused. `.claude/hooks/` is refused.
Input is limited to 512 KiB; writes create parents and atomically replace the file.
Deletion removes one regular file, never a directory. The script prints a change summary.
Commit changes as usual; the script does not commit.

Propose changes to `.claude/settings*.json` or `.claude/hooks/` via Slack approval.
Never use the GitHub API to bypass protected-path restrictions.
