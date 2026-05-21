# Contributing to poller-brain

> **Not for runtime agents.** This guide applies only when authoring changes to the base-brain repo itself. End-user agents who have this repo cloned into user scope (`$CLAUDE_CONFIG_DIR`) can safely ignore this file — its rules are checked at PR-creation time, not at runtime.

`poller-brain` is the shared base brain used by **all** TeamVibe brain agents. Every change here propagates to ~10+ deployed brains today, scaling to hundreds. Treat changes accordingly.

## Cross-brain blast radius claims must be evidence-backed

The hardest mistake to catch in a base-brain PR is **underestimating blast radius via GitHub-based enumeration**. Channel brain repos live in *customer* GitHub organizations (e.g. `customer-x/brain-01KP...`), not in `teamvibeai`. The `teamvibeai` org account has structural read-blindness to all channel brains — you cannot enumerate them, search their contents, or read their files via GitHub APIs.

If a PR's rationale contains a claim like *"only N brains use X"*, *"no brains do Y"*, or *"this is safe for all brains"*, that claim must be backed by one of:

1. A query against the **maintenance report stream** (Internal API → eval pipeline aggregation), OR
2. A query against **DynamoDB / AppSync** brain config records, OR
3. An explicit `/metrics/top` query showing the relevant signal across the fleet.

Enumerating *channel brain contents* via GitHub (e.g. `gh api repos/<customer-org>/<brain>/contents/...`, `gh search code` over customer org repos, `gh repo list teamvibeai | grep -i brain` to estimate brain count) is **not acceptable evidence** — those paths are structurally blind to brains living in customer orgs.

If no data-plane path can yet answer the question, **the right response is to extend the data plane** (add a field to the maintenance report JSON, a measure to the metrics schema, etc.), not to skip the criterion or route around it. The PR author owns that extension.

If the gap is too large to bridge in-PR, the safe default is *"assume this PR could affect any brain; design with isolation and fault-tolerance accordingly"* (try/catch, fail-soft, additive-only schemas).

### OK / NOT-OK patterns

| Pattern | Verdict | Reason |
|---|---|---|
| `gh pr list --repo teamvibeai/poller-brain` | **OK** | Shared infra repo, owned by `teamvibeai` |
| `gh issue list --repo teamvibeai/teamvibe.ai` | **OK** | Same |
| `gh search code --repo teamvibeai/poller-brain "MAINTENANCE.md"` | **OK** | Searching shared infra content |
| `gh run list --repo teamvibeai/poller-brain-eval` | **OK** | Eval pipeline runs in shared infra |
| `gh repo list teamvibeai \| grep -i brain` to count brains | **NOT OK** | Returns only meta-repos; blind to customer-owned channel brains |
| `gh api repos/<customer-org>/<brain-id>/contents/HEARTBEAT.md` | **NOT OK** | Won't resolve — no read access |
| Claim "no brain has X" based on `gh search` of `teamvibeai/*` | **NOT OK** | Only proves no *shared infra* file matches |
| Query maintenance reports via Internal API for "brains with field X set" | **OK** | Data plane, fleet-wide |
| `curl $TEAMVIBE_API_URL/metrics/top?metric=<field>` to estimate distribution | **OK** | Data plane, fleet-wide |

Reviewers are empowered to block a base-brain PR on missing or GitHub-enumeration-based evidence. The PR template includes a one-line check for this.

## Why this guide is here, not in `CLAUDE.md`

`CLAUDE.md` is loaded as system prompt for **every agent session** across the fleet. Per-conversation token cost. This contribution guide is read only when someone authors a PR — that's where it belongs.
