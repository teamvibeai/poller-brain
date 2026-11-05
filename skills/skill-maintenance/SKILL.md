---
name: skill-maintenance
description: Install, vendor, or update a brain skill; resolve a "skill missing" request; inspect the skills inventory; or run skill checks during a maintenance run.
---

# Skill maintenance

Operate from the channel brain repository root. The base brain supplies the tool;
its cwd selects the brain to maintain. Use the policy wrapper, which delegates
installation to `npx -y skills@1.7.2` with telemetry disabled.

New skill or new source = PR for the brain owner, never auto-merge. The workspace
allowlist is `.claude/skills/allowlist.yaml`; absent means only
`knedlopark/shared-claude-skills` and `teamvibeai/poller-brain`. An unlisted source
requires an owner-reviewed allowlist change. Do not bypass this with direct CLI
installation. Commit canonical `.agents/skills/<name>/` content, the relative
`.claude/skills/<name> -> ../../.agents/skills/<name>` symlink, and both locks
together. This is one shared, committed copy for Codex, OpenCode and other CLIs;
Claude Code discovers it through the symlink (verified by headless probe on
2026-10-19). The pinned installer uses default symlink mode without `--copy`;
the wrapper verifies the layout and converts any fallback copy to a symlink.
Brain-own skills stay as flat real `.claude/skills/<name>/` directories with no
`.agents` entry or lock entry. Lint rejects invalid/dangling links, nested skills,
missing canonical content and duplicate canonical/real Claude directories.
The wrapper does not edit `.gitignore`; remove any legacy `.agents/` ignore rule
when adopting this layout. Git must preserve symlinks (`core.symlinks=true`).
Windows is not supported.

During **every maintenance session**, run `status` and `report` as required by
MAINTENANCE.md. Sync only `outdated` entries with no local edits or upstream PR
(pure SHA bumps), then run `lint` and `report` again. Paste the report command's
`data` object under the maintenance JSON report's `skills` field. Leave modified
copies for review; use `push` for authorized upstream contributions, and sync a
waiting copy after its upstream PR has merged. Brain-own skills have no provenance
entry and are never overwritten by sync. Nested skills are not discovered; a
migration requires a reviewed PR.

Resolve the script as `$CLAUDE_CONFIG_DIR/skills/skill-maintenance/scripts/brain-skills.ts`.
If `CLAUDE_CONFIG_DIR` is unset or that file is absent, use `scripts/brain-skills.ts`
relative to **this skill's own directory**, not relative to the channel brain.

```bash
export DO_NOT_TRACK=1 DISABLE_TELEMETRY=1
BRAIN_SKILLS="$CLAUDE_CONFIG_DIR/skills/skill-maintenance/scripts/brain-skills.ts"
# With the fallback, set BRAIN_SKILLS to this skill's absolute scripts/brain-skills.ts path.
npx tsx "$BRAIN_SKILLS" status --json
npx tsx "$BRAIN_SKILLS" report
npx tsx "$BRAIN_SKILLS" add knedlopark/shared-claude-skills#work-management --ref main
npx tsx "$BRAIN_SKILLS" ensure work-management knedlopark/shared-claude-skills#work-management --ref main
npx tsx "$BRAIN_SKILLS" add --new my-skill
npx tsx "$BRAIN_SKILLS" sync work-management
npx tsx "$BRAIN_SKILLS" push work-management
npx tsx "$BRAIN_SKILLS" lint
```

`ensure` is the idempotent entrypoint for mandatory skills such as
`work-management`: invoke it only when that skill is required by the brain's
maintenance policy. A first installation still needs the owner's PR review.
`--name` selects an upstream frontmatter name; it does not rename a skill.
`--force` explicitly discards local edits. All commands emit one JSON object and
exit 1 on failure. Read [README.md](README.md) for command contracts and lock
semantics; [docs/npx-skills-facts.md](docs/npx-skills-facts.md) records the CLI probes.
