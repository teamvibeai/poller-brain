# Diagnosing a session that vanished without a trace

**When to use this:** a session — usually scheduled/cron-triggered, or one that was waiting
on a session-bound mechanism like `ScheduleWakeup` or `Bash(run_in_background)` — was
expected to deliver output (a report, a `send_message`, a scheduled follow-up) and never
did, with no error anywhere.

This is advanced/opt-in troubleshooting, not default behavior — reach for it only when a
user explicitly asks you to root-cause a vanished session, or when you're deciding a
background/scheduled failure needs more than a guess before you escalate it (e.g. via
`submit_feedback`). It is not something to explain or offer to a regular user asking an
ordinary question.

## 1. Locate candidate session transcripts

Every session's transcript is a `.jsonl` file, one per session, at:

```
<base-brain-projects-dir>/<encoded-cwd>/<session-uuid>.jsonl
```

Some sessions also have a sibling `<session-uuid>/` directory with tool-result/background-task
output files — only sessions that actually produced such files get one, so its absence tells
you nothing. `<encoded-cwd>` is the session's working directory with every `/` replaced by
`-` — e.g. a brain running at `/data/brains/01ABC...` has its transcripts under a
`-data-brains-01ABC...` directory. Confirm the actual base directory on your own container
first (a currently-running session's own transcript is the reliable reference) rather than
assuming a path from this doc — it can differ from container to container.

Filter to a narrow window around the suspected failure time (GNU find/coreutils — the `-f`
form of `stat` is BSD/macOS-only and fails *silently* on Linux: it prints filesystem info
instead of mtime and still exits 0, easy to mistake for real output):

```bash
find /data/base-brain/projects/<encoded-cwd> -maxdepth 1 -name '*.jsonl' \
  -newermt '<start>' ! -newermt '<end>' \
  -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort
```

Use the full path, not `.` — `-maxdepth 1` run from the wrong directory (e.g. the brain's own
cwd instead of the projects dir) silently returns nothing rather than erroring.

**mtime is in the local system timezone, not necessarily UTC** — an easy off-by-timezone
mistake if you're comparing against a UTC log or a scheduled-message time. (Verify with
`date` vs `date -u` on the container you're doing this on — some run UTC natively, where
this isn't a live trap, but don't assume that fleet-wide.)

## 2. Identify which candidate matches which command/skill

The reliable signal — present in every session, not just skill-invoking ones — is the first
non-sidechain `type: "user"` record: it carries the message that triggered the session,
including the `**From:**` header and, for scheduled/maintenance sessions (the primary
audience for this technique), the full triggering prompt text:

```bash
jq -rs '[.[] | select(.type=="user" and (.isSidechain|not))][0].message.content
  | if type=="array" then .[0].text else . end' <file>.jsonl
```

If the session used a `Skill` tool, `grep -o '"skill": *"[^"]*"' <file>.jsonl` narrows it
further — but treat this as a **supplement, not the primary signal**: on a sampled brain,
only a small minority of transcripts contain any `Skill` tool_use at all, so an empty match
means "this session didn't use the Skill tool," not "wrong session" — most scheduled and
maintenance sessions, the main audience for this whole technique, never call it.

## 3. Turn the JSONL into a readable turn-by-turn log

Raw JSONL is not practically readable line-by-line. A short script that extracts `type`,
timestamp, and a truncated content preview per line is enough to see exactly where the
transcript ends and what the last recorded action was — e.g. a `ScheduleWakeup` call that
got a "scheduled" confirmation and then nothing.

## 4. Cross-check against a known-good run of the same skill/command

Compare against a transcript where the same skill/command completed successfully. If the
successful runs never needed the mechanism you suspect (e.g. never called `ScheduleWakeup`
because the underlying work finished fast enough not to need it), that's evidence the
divergence is mechanistic — not coincidental to this one run.

## Why this matters

This technique turned a multi-day "we have a hypothesis" investigation into a definitive,
evidence-backed root cause with exact reproducible session IDs — see
[poller-brain#385](https://github.com/teamvibeai/poller-brain/issues/385), found this way
against [poller-brain#383](https://github.com/teamvibeai/poller-brain/issues/383)'s original
report.
