# Brain skills policy wrapper

Zero runtime dependencies: Node builtins, `git`, `gh` for upstream PRs, and
`npx`. No package.json or node_modules in the brain. The installed base-brain
entrypoint is `$CLAUDE_CONFIG_DIR/skills/skill-maintenance/scripts/brain-skills.ts`;
fall back to the absolute `scripts/brain-skills.ts` path in this skill's directory.
Run from the **brain repository root**, including in git worktrees.

```bash
export DO_NOT_TRACK=1 DISABLE_TELEMETRY=1
npx tsx "$CLAUDE_CONFIG_DIR/skills/skill-maintenance/scripts/brain-skills.ts" status
```

The exports also disable telemetry for the outer `npx tsx`. The wrapper always
sets both variables to `1` for every subprocess, including the pinned installer
`npx -y skills@1.7.2`. It uses `add --skill NAME --full-depth --copy -y --json
--agent claude-code`; the CLI owns discovery metadata, installation, and its lock.
Git clones/checkouts supply the policy's SHA verification and PR workflow.

| Command | Contract |
| --- | --- |
| `add SOURCE[#PATH] [--ref REF] [--name NAME]` | Require allowlisted git source, resolve branch/tag with `git ls-remote` (default `main`), select one skill, copy through the pinned CLI, verify SHA content, write provenance. Existing names refuse; use sync. |
| `add --new NAME` | Scaffold flat `.claude/skills/NAME/SKILL.md`; no lock entry. Replace the description/workflow templates before review. |
| `status [--json]` | Inventory and upstream SHA comparison using only `git ls-remote`, with no clone. JSON is always used. |
| `sync [NAME] [--force]` | Reinstall selected/all vendored entries at their recorded ref. Preflight local edits and allowlist before mutation. Refuse edits without `upstream_pr` unless forced; clear `upstream_pr` after reinstall. Use for a waiting copy only after its PR merges. |
| `push NAME` | Clone at locked SHA, copy the vendored changes including deletions, commit as the brain's git identity on a unique branch, push it and call `gh pr create`; save PR URL. Existing PR is an idempotent no-op. |
| `lint` | Check flat skills, frontmatter/name/description, referenced scripts, both locks and content drift; reject tracked `.agents/` files. No upstream network check. |
| `report` | Return maintenance-ready counts and entries; paste `data` under `skills`. |
| `ensure NAME SOURCE[#PATH] [--ref REF]` | Allowlist check, then no-op if locked and SKILL.md exists, preserving edits. Otherwise install or restore the missing locked skill. Never replace an existing brain-own skill. |

`--name` selects the upstream name, not an alias. Sources are GitHub shorthand
(`owner/repo`, `github.com/owner/repo`, HTTPS/SSH GitHub URLs), generic HTTPS/SSH
git URLs ending `.git`, absolute/relative local git paths, or `file://` git URLs.
`#PATH` is the wrapper's directory selector; `--ref` is a branch/tag, not a CLI
passthrough. Paths must remain inside the repository. Copies with symlinks refuse.
No command retries automatically. If `push` fails after pushing a branch, the
error leaves the branch upstream for manual recovery; inspect it before retrying.
Auth is supplied by existing git/gh credentials. No credentials are stored.

New skills and new sources always require a PR reviewed by the brain owner,
never auto-merge. Maintenance syncs only pure upstream SHA bumps, leaving local
edits and pending upstream PRs for review. Commit `.claude/skills/<name>`, both
locks, and the brain `.gitignore` together.
Multi-skill sync preflights all entries but commits each install separately to
its files; a later upstream failure can leave earlier successful installs ready
for review. A single failed installation restores that skill and both locks.

## Why two copies exist, only one is committed

The CLI uses `.agents/skills/<name>` as its canonical installation cache; the
wrapper requests `.claude/skills/<name>` as the Claude copy with `--copy --agent
claude-code`. A fresh copy install may create only the Claude tree, while CLI
restore/update operations can populate the canonical cache. When both exist,
keep both on disk so CLI metadata and hashes remain usable. Only
the `.claude/skills/<name>` skill copy is committed. After a successful `add`,
`ensure` (including a no-op), or `sync` (including an empty sync), the wrapper
appends `.agents/` to the brain `.gitignore` if absent, preserving existing text.
It never stages files. Lint rejects any tracked `.agents/` files even if ignored;
add the ignore line and run `git rm --cached -r .agents` to untrack existing
copies. Rollback also restores the uncommitted cache and `.gitignore` if an
installation fails.

## JSON output

Every command emits exactly one object on stdout; installer progress is captured.
Success exits 0; failures exit 1:

```json
{"ok":true,"data":{"entries":[]},"error":null}
```

```json
{"ok":false,"data":null,"error":"Source ... is outside the workspace allowlist; ask the brain owner to review a PR"}
```

`add`/installed `ensure`: `{name, source, path, ref, sha, upstream_pr,
content_hash, installer, changed:true}`. No-op ensure: `{name,changed:false}`.
Scaffold: `{name,state:"own",path}`. `sync`: `{entries:[provenance entries...]}`.
`push`: `{name,upstream_pr,branch,author,changed:true}` or no-op without `branch`
or `author`. `author` is the actual `Name <email>` used for the commit, read
from `git config user.name` and `git config user.email` in the brain's cwd.
Only an unset/empty field falls back to `JARVIS (Codex)` or
`jarvis@knedlopark.cz`, respectively; the returned author exposes that fallback.
`lint`: `{errors:[],count:N}`; structural errors appear in the failure's `error`.
`status`: `{entries:[{name,...provenance,state,upstream_sha,modified}]}`;
brain-own entries have `{name,state:"own"}`, nested entries additionally have
`path`. Upstream lookup failure returns an error rather than a guessed state.

`report` returns:

```json
{
  "ok": true,
  "data": {
    "counts": {"current":0,"outdated":0,"modified":0,"waiting-upstream":0,"own":0,"not-discovered":0},
    "entries": []
  },
  "error": null
}
```

State priority: `waiting-upstream` when a PR is recorded; otherwise `modified`
when files differ or are missing; otherwise `outdated` when upstream SHA changed;
otherwise `current`. Unlocked flat skills are `own`; nested SKILL.md files are
`not-discovered`. `modified` on a vendored status entry also exposes edits while
waiting. Upstream movement alone does not mean that changed skill content is safe;
review the resulting PR.

## Two locks

- Root `skills-lock.json` belongs exclusively to `npx skills`. The wrapper never
  edits its fields. It contains `version:1`, `skills`, and per-skill `source`,
  `sourceType`, `computedHash`, optionally `sourceUrl`, `ref`, `skillPath`.
- `.claude/skills/skills.lock.yaml` is wrapper-owned provenance and policy. It is
  serialized as block YAML with sorted mapping keys and quoted strings where
  needed, without a YAML dependency. Old JSON-shaped lock files still load and
  become block YAML on the next lock write. Do not hand-edit.

Example (hashes shortened for display):

```yaml
skills:
  work-management:
    content_hash: "0123456789abcdef..."
    installer:
      ref: "0123456789abcdef..."
      skillPath: work-management/SKILL.md
      source: knedlopark/shared-claude-skills
      sourceType: github
    path: work-management
    ref: main
    sha: "0123456789abcdef..."
    source: github.com/knedlopark/shared-claude-skills
    upstream_pr: null
```

`sha` is the full 40-character resolved upstream commit; `content_hash` is SHA256
of vendored file paths and bytes in `localeCompare` sorted path order, matching
CLI 1.7.2's `computedHash` (ignores `.git` and `node_modules`). `installer` records
the CLI's source/ref/path metadata verbatim, excluding its hash, so lint can
detect two-lock provenance drift without taking ownership of `skills-lock.json`.
A waiting PR permits on-disk edits, while the two recorded baseline hashes must
still agree. Brain-own skills have no entry in either lock.

Remote installs pass `#<SHA>` to the CLI. Local/file sources have no native ref
syntax: the wrapper uses the selected directory in the original local repo when
it is clean and at the resolved SHA; otherwise it supplies a temporary detached
checkout. In that latter case the CLI lock records a temporary local source that
is removed afterward. This is useful for local testing but cannot be replayed
with `experimental_install`; use wrapper `sync`, which resolves the durable
provenance source. Local-path locks are not portable between machines. Production
sources should use git URLs with native SHA support. Do not use direct CLI
`update` or `experimental_install` to maintain wrapper-managed Claude copies;
they bypass policy and do not keep both locks in sync.

## Allowlist and YAML

Missing `.claude/skills/allowlist.yaml` defaults to exactly
`knedlopark/shared-claude-skills` and `teamvibeai/poller-brain`. An existing empty
list permits no sources. Entries match canonical repository identities exactly,
not prefixes or wildcards; local paths/file URLs resolve to the same real path.

```yaml
sources:
  - knedlopark/shared-claude-skills
  - teamvibeai/poller-brain
```

A bare YAML/JSON list and an `allowlist:` list are also accepted. The zero-dependency
parser supports block mappings, scalar lists, quoted/plain scalars, JSON flow
values and literal/folded block strings. Duplicate keys, malformed indentation,
anchors, tags and unsupported YAML constructs fail closed. Frontmatter must be a
mapping with nonempty string `name` and `description`. Referenced literal
`scripts/...` paths must exist within that skill; computed paths are not inferred.

## Offline tests

Prime the external npm cache once before testing (this setup may use the npm
registry; it is not part of the test suite):

```bash
DO_NOT_TRACK=1 DISABLE_TELEMETRY=1 npx -y skills@1.7.2 --version
node --test skills/skill-maintenance/scripts/__tests__
# Also supported:
node --test skills/skill-maintenance/scripts/__tests__/*.test.mjs
node --test mcp/__tests__/*.test.mjs
```

Tests copy the JS-compatible TypeScript entrypoint to a temporary `.mjs` runner
so no tsx download is needed. Node 25 needs the directory's `index.js` runner for
an explicit directory argument. All fixtures live in temporary directories in
this worktree and are removed afterward. Tests use the real cached pinned CLI,
npm offline mode, a Node network-denial preload, git's file-only protocol guard,
local git upstreams (remote-looking URLs are rewritten to file URLs), and a fake
`gh` on PATH. No real GitHub repositories or network calls are used by tests.

CLI probe details: [docs/npx-skills-facts.md](docs/npx-skills-facts.md).
