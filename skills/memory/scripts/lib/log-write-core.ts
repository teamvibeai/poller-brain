/**
 * Pure date-rollover decision logic for log-write.ts.
 *
 * Extracted so the day-boundary branch (new day -> fresh "# YYYY-MM-DD"
 * section) can be fixture-tested without touching a real brain's TODAY.md.
 * Must check the LAST date header, not the first, so a same-day call after
 * an earlier rollover does not append a duplicate section.
 *
 * Reference: poller-brain#184 (DevGuru review of PR#183).
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
