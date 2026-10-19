# Verified skills CLI 1.7.2 facts

Empirical probes on 2026-10-17, macOS, Node 25.8.0. Package metadata identifies
`https://github.com/vercel-labs/skills`; `npx -y skills@1.7.2 --version` prints
`1.7.2` and exits 0. Every invocation used `DO_NOT_TRACK=1
DISABLE_TELEMETRY=1`. All upstreams were temporary local git repositories in this
worktree. No real GitHub repository was used for these probes.

Base fixture: git repository on `main`, `demo/SKILL.md` with `name: demo` and a
nonempty description, tag `v1` at its first commit, later commits changing the
body. Destination: a fresh git brain. Generic URL tests used
`https://fixture.invalid/upstream.git`, rewritten by git into the fixture's
`file://` URL via process-scoped `GIT_CONFIG_COUNT/KEY/VALUE`, with
`GIT_ALLOW_PROTOCOL=file`. This exercises git URL parsing/ref handling without
accessing a server. The local-path and `file://` probes used their literal sources.

| Probe | Exit | Observed result |
| --- | --- | --- |
| `add /absolute/upstream --skill demo --agent claude-code --copy -y --json` | 0 | Flat copied `.claude/skills/demo`; JSON array on stdout, progress on stderr. Fresh copy installs need not create `.agents/skills/demo` (see follow-up below). |
| `add file:///absolute/upstream --skill demo --agent claude-code --copy -y --json` | 0 | Same copied layout; git source includes `skillPath` in lock. |
| `add ... --skill absent ... --json` | 1 | JSON array with `{name:"absent",status:"skipped",reason:"No matching skill found in source"}`. |
| Invalid git repository | 1 | JSON array with `{status:"failed",error:"Failed to clone repository..."}`. |
| `list --json` | 0 | JSON array of installed entries, no progress text on stdout. |
| `experimental_install --agent claude-code -y` with matching files | 0 | Reports `Restored demo`; restores `.agents/skills`, not the Claude copy. Agent option does not change this. |
| `experimental_install` with changed `.agents` and `.claude` copies | 0 | Replaces `.agents` with source content; leaves `.claude` edits intact; unchanged upstream means unchanged lock. |
| `experimental_install` after upstream changes at `main` | 0 | Installs new upstream content into `.agents`, rewrites `computedHash`, still leaves `.claude` edits intact. It does not enforce the old hash. |
| Second local-path `add` of same name after Claude edit | 0 | Reports `installed`; overwrites the Claude copy, restoring upstream bytes. |
| `update` on local-path lock | 0 | `No project skills to update`; copy remains at its previous version. |
| `update` on generic git URL lock at `main` after new commit | 0 | Reports one update; refreshes `.agents` and `.claude` copies and lock hash, overwriting a Claude edit. |
| `update` on generic git URL lock at unchanged tag `v1` | 0 | Reports all skills up to date; remains at tag content. |
| `add file:///upstream#v1 ...` | 1 | Treats `#v1` as part of repository URL; clone fails. |
| `add file:///upstream@v1 ...` | 1 | Treats `@v1` as part of repository URL; clone fails. |
| `add file:///upstream --ref v1 ...` | 0 | **Silently ignores `--ref`**, returns `ref:null` and installs default branch content. |
| `add https://fixture.invalid/upstream.git#v1 ...` (local rewrite) | 0 | Returns `ref:"v1"`, installs original tag content, records ref and path. |
| `add https://fixture.invalid/upstream.git#<40-char-SHA> ...` (local rewrite; offline integration tests) | 0 | Installs exact commit even when newer commits/uncommitted files exist upstream. |

Follow-up isolation check: the original observation of two trees after `add`
included canonical cache state from other CLI operations. A fresh wrapper copy
install can leave `.agents/` absent. The cached 1.7.2 CLI's `installSkillForAgent`
copy branch writes only the selected agent directory. Restore/update can leave
both trees present. Those copy-mode observations are historical: the owner's
2026-10-19 decision supersedes the previous ignore policy. The wrapper now uses
default symlink mode, commits `.agents/skills/<name>` as canonical content and
`.claude/skills/<name>` as a relative symlink. Claude Code discovery through that
symlink was verified by the owner's headless probe that day. Current wrapper
tests exercise the real pinned CLI's default symlink mode and copy fallback.

## Output and lock shapes

Successful add stdout (absolute paths abbreviated):

```json
[
  {
    "name": "demo",
    "status": "installed",
    "source": "/absolute/upstream",
    "ref": null,
    "hash": "b69ae13686823424ed661a4279599d569917d0797f0b1315bebb18728efa5276",
    "path": "/absolute/brain/.claude/skills/demo",
    "scope": "project",
    "agents": ["Claude Code"],
    "mode": "copy",
    "security": null
  }
]
```

Root `skills-lock.json`, local directory source:

```json
{
  "version": 1,
  "skills": {
    "demo": {
      "source": "../upstream",
      "sourceType": "local",
      "computedHash": "b69ae13686823424ed661a4279599d569917d0797f0b1315bebb18728efa5276"
    }
  }
}
```

Generic git URL entry (including `file://`): `source`, `sourceUrl`, `sourceType:
"git"`, `skillPath:"demo/SKILL.md"`, `computedHash`, plus `ref` when supplied via
supported fragment syntax. `sourceUrl` equals the original URL. Local-path
sources are stored relative to the brain; no `skillPath` or `ref` is recorded.
The CLI owns this file; the wrapper never constructs or edits its entries.

`list --json` emits entries with `name`, `path`, `scope`, `agents`, `source`,
`sourceUrl`, `sourceType`; the local example has `sourceUrl:null` and an absolute
source path. It does not provide wrapper states or resolved upstream commits.

## Source parsing and hashing inspection

The installed 1.7.2 bundle was also inspected to distinguish verified execution
from unsupported assumptions:

- `parseFragmentRef` supports `#ref` for GitHub shorthand/URLs and supported
  generic git URLs (`https://...git`, `ssh://...git`, `git@...`). Local paths are
  parsed before fragments; `file://` is excluded from fragment recognition.
- GitHub shorthand `owner/repo@name` is a **skill selector**, not a ref.
  `owner/repo#ref@name` combines a ref and selector. This syntax observation is
  from source inspection; no GitHub calls were made to probe it.
- `computeSkillFolderHash` recursively collects regular files, skips `.git` and
  `node_modules`, normalizes separators to `/`, sorts paths with `localeCompare`,
  and hashes each relative path followed by its bytes with SHA256, without a
  separator. The wrapper mirrors that hash so both locks can be compared.
- `experimental_install` uses universal agents and source reinstall logic rather
  than validating the recorded content hash; the differing-file probes above
  confirm this. It is not a frozen install for Claude copies.

## Wrapper consequences

Use native `#SHA` for supported remote sources and pass the skill selector
separately. A wrapper `#path` must never be passed through as a CLI `#ref`.
For local/file sources the wrapper supplies an exact local directory after
resolving and verifying the SHA; older/dirty checkouts use a temporary detached
snapshot. The CLI may record that temporary source; refresh through `sync` using
the provenance lock, not through direct `experimental_install`. See the README
for this local-fixture portability limitation.

Use wrapper `sync` rather than direct `update`/`experimental_install`: the wrapper
protects edits, checks the allowlist, pins the resolved commit, and maintains
provenance alongside the CLI-owned hash lock. The wrapper's JSON object envelope
is distinct from the CLI's JSON array.
