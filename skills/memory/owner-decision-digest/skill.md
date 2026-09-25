---
name: owner-decision-digest
description: |
  Scans recent consolidation reports for items flagged under "## Needs Owner
  Decision" and posts a Slack digest for any not yet posted. Invoked only via
  a dedicated `create_scheduled_message` whose promptTemplate explicitly asks
  for this check — that ask is what authorizes posting. A bare
  maintenance/heartbeat trigger is NOT authorized to run this skill (see
  CLAUDE.md's unconditional-silence bullet, `poller-brain#327`).
---

# Owner Decision Digest

## When to run

Two triggers are legitimate: the `owner-decision-digest` scheduled message
(see Setup below), or an explicit live-thread ask ("check for pending
owner-decision items", "run the owner-decision-digest skill") — both carry
their own ask and are already authorized under the normal rule. Do NOT run
this from a bare maintenance/heartbeat session — that trigger shape carries
no ask and is not authorized to post to Slack (see the consolidate skill's
Step 11 "Do not post from here" note).

## Setup (one-time per brain)

**Only run this from a session with real Slack channel context** — a
live-thread ask from the owner (e.g. "set up owner-decision-digest"), never
a bare maintenance/heartbeat session. Consolidation detects a missing
schedule and flags it (`[blocked]` in `processImprovements` — see the
consolidate skill's Step 11), but the actual creation happens here, in a
session that knows where it's running.

**Do not default to "this session's channel."** A single TeamVibe channel
routinely covers multiple Slack channels (verified empirically: one brain's
own schedule list showed three distinct Slack `origin.channel` values under
one TeamVibe channel), so the thread you happen to be bootstrapping from is
not necessarily where digests should land — e.g. this could be a side
thread, and the owner's actual preference could be a dedicated ops channel.
**Ask the owner which channel they want the digest posted to, and use their
confirmed answer as `origin.channel`** — don't infer it from "where this
conversation happens to be." Also bake the owner's actual Slack user ID into
the `promptTemplate` (the digest run has no thread or conversation context
of its own — see `teamvibe-api/skill.md`'s "Writing promptTemplate" rule 5 —
so the `@mention` target must be spelled out now, not looked up later):

```
create_scheduled_message({
  cron: "0 8 * * 1-5",  // adjust to a reasonable hour in the channel's own timezone
  origin: { source: "slack", channel: "<channel ID the owner confirmed>" },
  promptTemplate: "Run the owner-decision-digest skill. Check recent consolidation reports for unposted '## Needs Owner Decision' items. If any are found, post one digest message to this channel mentioning <@OWNER_USER_ID> listing them; otherwise do nothing and exit silently."
})
```

**Verify before trusting it:** the response echoes a `delivery` block —
confirm `delivery.resolvedFrom == "explicit-origin"` and `delivery.channel`
matches the channel the owner actually confirmed, not just "some" channel.
Record the creation in that session's report or log — this skill has no
report of its own, so that note plus git history is the only trace of when
it was bootstrapped.

## Algorithm

1. **Collect.** Read the last 14 days of `reports/*-memory-consolidation.md`
   files still present in this brain's own repo (older ones may already be
   gone via the 30-day report-age cleanup — that's fine, this window is
   intentionally shorter than that). For each, extract the
   `## Needs Owner Decision` section if present and parse its
   `- key: <slug> — <description>` lines. Only consolidation reports are
   read — `reports/*-memory-reflection.md` is intentionally out of scope,
   even though reflection also writes `[blocked]` `processImprovements`
   entries; see the consolidate skill's Step 11 note on this boundary.
2. **Dedup.** Read `memory/owner_decisions_posted.md` (create it if
   missing). This file is the durable dedup state — it lives in the channel
   brain's own git history and survives the JSON-report cleanup. Format —
   one line per key, both dates on the same line:
   ```markdown
   # Owner Decisions Posted
   - key: brain-git-divergence — posted 2026-08-20 — last-seen-open 2026-08-24
   ```
   No `resolved` marker, deliberately — a separate resolution write would be
   written by consolidation and read by this skill, which is exactly the
   `poller-brain#328` shape (a status value nothing reliably writes, so it
   silently never fires). Instead, resolution is inferred from data both
   skills already produce: consolidation's Step 11 lists ALL still-open
   items every run, not just new ones (see that skill), so a **gap** in a
   key's appearance across the collected reports (step 3) is what signals
   resolution.

   `last-seen-open` is written and read only by this skill (never
   consolidation), so it doesn't reintroduce the split-writer problem above
   — but it exists to fix a second, subtler version of the same class of
   bug: the 14-day collect window can't see a gap that happened further back
   than 14 days. A `posted` date alone, checked only within the window,
   would read a key that's been continuously open for months as "unbroken"
   even if the *actual* history has a resolve-then-recur gap sitting outside
   the window — silently suppressing a recurrence nobody ever saw, one layer
   further down than the marker bug. `last-seen-open` fixes this by being
   refreshed every run a key is confirmed still-open (step 4), so it is
   never more than one cron interval old — the gap-check in step 3 always
   has a window it can actually see into.
3. **Diff.** For each key in this run's collect result:
   - No `posted` line at all → trivially new.
   - Has a `posted` line, but its `last-seen-open` (or `posted`, if
     `last-seen-open` was never written — the first check after the initial
     post) date falls **outside** the current 14-day collect window → the
     marker is unverifiable from here; do not assume continuity through a
     gap you can't see. Treat it as new — this fails toward a duplicate
     post, not silent permanent suppression, matching the ordering choice
     already made in step 4.
   - Otherwise, check every report in the collect window dated *after* the
     `last-seen-open` date, oldest to newest. If every one of them still
     lists the key, the chain is unbroken since the last confirmation —
     suppressed. If any of them does NOT list the key, the chain is broken;
     treat it as new (do not check reports from before `last-seen-open` —
     that period was already confirmed on a prior run).
   New items = every collected key that isn't suppressed by this check.
4. **Refresh, then post or stay silent.** First, for every key in this
   run's collect result that was judged suppressed in step 3 (still-open,
   unbroken chain), **find that key's existing line in
   `memory/owner_decisions_posted.md` and edit its `last-seen-open` date to
   today in place** — do not append a new line for a key that already has
   one; each key has exactly one line in this file, ever. This refresh is
   what keeps the marker inside future runs' 14-day window (see step 2) and
   must happen every run regardless of whether anything new gets posted
   below. This is a memory-state write, not a Slack post, so it's
   unaffected by the "silent if nothing was due" default — that default
   governs Slack output, not routine state bookkeeping.
   - New items empty → no Slack message. Still commit the `last-seen-open`
     refreshes from above if any were made (routine bookkeeping, not a
     "summary" — no conflict with the silent-by-default rule).
   - New items non-empty → post ONE Slack message listing all new items as a
     batch (not one message per item — see Message Format below), tagging
     the channel owner, THEN append one new line per new key (with today's
     date as both `posted` and initial `last-seen-open`) to
     `memory/owner_decisions_posted.md` alongside the in-place refreshes
     above, and commit everything together. Deliberately in this
     order, not the reverse: the Slack call and the git commit are two
     separate systems that can't be made atomic, so a crash between them is
     possible either way — post-then-commit means a crash there produces at
     worst a harmless duplicate post next cycle (the state file wasn't
     updated, so the item looks "new" again); commit-then-post would mean a
     crash there marks the item posted while the owner never actually saw
     it, silently recreating the exact failure this skill exists to fix.
     Prefer the failure mode that duplicates over the one that goes silent.
     **Known risk with this ordering:** it only stays a rare edge case if
     the commit reliably lands before the session ends. On a brain whose
     git commit/push is itself unreliable (session ends before pushing,
     etc. — this is a real, separately-tracked failure mode, not
     hypothetical — it is literally what the `brain-git-divergence` example
     item describes), the same item would repost on every cron firing, not
     just after an occasional crash. **Verify correctly, not just
     plausibly:** `git log -1 --oneline -- memory/owner_decisions_posted.md`
     alone is not sufficient — it prints the *previous* commit (exit 0, one
     line, looks identical to success) if today's append never got
     committed. Instead check `git diff --quiet HEAD --
     memory/owner_decisions_posted.md` (no uncommitted changes) AND that the
     file's latest commit actually contains today's key. And note the
     ceiling on this check: commit is not push — a commit that's never
     pushed is invisible on re-clone, so this verification catches a failed
     *commit*, not a failed *push*, which is a separate, real gap.
5. **Suppression is per-key and per-occurrence, not permanent.** An item
   still unresolved next cycle is NOT re-flagged — the diff logic in step 3
   keeps suppressing it as long as it keeps appearing in the collect result.
   It stops being suppressed automatically once consolidation stops listing
   it (implying resolution), with no separate write required from either
   skill. If the owner needs a reminder about a still-open item, that's a
   deliberate follow-up (e.g. a one-off `create_scheduled_message` for that
   specific item), not this digest's job. This skill's only contract is
   "surface each distinct decision-needed occurrence exactly once."

## Message format

```
🔔 *Needs your decision* (N new):
- <description> (`key`)
- <description> (`key`)
```

This is a base-brain skill shared across every channel — write the actual
message in whatever language the channel brain normally communicates in
(see that brain's own `CLAUDE.md`), keeping this bilingual-safe structure:
one 🔔-prefixed header line with a count, one bullet per new item. The
`@mention` target is not looked up here — it comes from the `promptTemplate`
this session was invoked with (see Setup: the owner's user ID is baked in at
bootstrap time, since a scheduled session has no thread or conversation
context to infer it from). Follow that instruction's mention as given; this
skill has no other source for who the owner is.
