/**
 * Pure date-rollover decision logic for memory/TODAY.md, shared by
 * log-write.ts and mem-write.ts (both write to TODAY.md and must agree on
 * when a UTC day boundary requires a fresh "# YYYY-MM-DD" section).
 *
 * Extracted so the day-boundary branch can be fixture-tested without
 * touching a real brain's TODAY.md. Must check the LAST date header, not the
 * first, so a same-day call after an earlier rollover does not append a
 * duplicate section.
 *
 * Reference: poller-brain#184 (DevGuru review of PR#183); poller-brain#267
 * (mem-write.ts never got this fix — module renamed from log-write-core.ts
 * so its shared nature is obvious from the name).
 */

export type RolloverAction =
  | { kind: "create"; textToWrite: string }
  | { kind: "append-header"; textToWrite: string }
  | { kind: "none" };

const DATE_HEADER_PATTERN = /^# (\d{4}-\d{2}-\d{2})/gm;

export function computeRollover(
  existingContent: string | null,
  today: string
): RolloverAction {
  if (existingContent === null) {
    return { kind: "create", textToWrite: `# ${today}\n\n` };
  }

  const headers = [...existingContent.matchAll(DATE_HEADER_PATTERN)];
  const lastHeader = headers[headers.length - 1];
  if (!lastHeader || lastHeader[1] !== today) {
    return { kind: "append-header", textToWrite: `\n# ${today}\n\n` };
  }

  return { kind: "none" };
}

/** Return a refusal message at/above the cap; invalid env values use 15 KiB. */
export function todayMdCapMessage(sizeBytes: number, maxBytesEnv?: string): string | null {
  const parsed = maxBytesEnv && /^[0-9]+$/.test(maxBytesEnv) ? Number(maxBytesEnv) : NaN;
  const cap = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 15360;
  if (sizeBytes < cap) return null;

  return `TODAY.md is ${(sizeBytes / 1024).toFixed(2)} KB (cap ${(cap / 1024).toFixed(2)} KB); entry NOT written. 1) Compact TODAY.md (archive it to memory/daily/ per the memory skill) before logging more. 2) Check whether you are logging too much: TODAY.md is short-term memory — write only information worth remembering later (facts, findings, preferences, non-obvious context). Event records (decisions, acks, starts, status) already live in GitHub/git/Slack or the originating system, and session state belongs to the session, task tracker or a scheduled message. Tracked lessons can still be written with mem-write.ts.`;
}
