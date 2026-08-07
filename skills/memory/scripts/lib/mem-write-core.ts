/**
 * Pure MEM-key counter logic for mem-write.ts.
 *
 * Extracted so the scan behavior can be fixture-tested without touching a
 * real brain's memory/ files. Directly targets the 2026-06-08 incident class:
 * a silent over-match on a prose mention of "MEM-N" (e.g. a review summary
 * sentence) inflating the counter past the next real canonical key.
 *
 * Reference: poller-brain#184 (DevGuru review of PR#183).
 *
 * Scan rules (do not loosen without a fixture proving the old bug stays fixed):
 *   - MEM_REGISTRY.md / MEM_REGISTRY_ARCHIVE.md: pipe-table rows have no
 *     prose-drift risk — full `MEM-(\d+)` scan is safe and is defense-in-depth.
 *   - TODAY.md mixes canonical write rows with free-text prose that may
 *     mention a MEM key in passing. Restrict to anchored canonical rows
 *     (`- [MEM-N]` at line start), tolerating a trailing `:` for format drift.
 */

export function scanMaxKey(content: string, pattern: RegExp): number {
  const matches = content.matchAll(pattern);
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

export const REGISTRY_KEY_PATTERN = /MEM-(\d+)/g;
export const ARCHIVE_KEY_PATTERN = /MEM-(\d+)/g;
export const TODAY_CANONICAL_KEY_PATTERN = /^- \[MEM-(\d+)\][\s:\]]/gm;

export function getNextKeyFromContents(
  registryContent: string,
  archiveContent: string,
  todayContent: string
): number {
  const fromRegistry = scanMaxKey(registryContent, REGISTRY_KEY_PATTERN);
  const fromArchive = scanMaxKey(archiveContent, ARCHIVE_KEY_PATTERN);
  const fromToday = scanMaxKey(todayContent, TODAY_CANONICAL_KEY_PATTERN);
  return Math.max(fromRegistry, fromArchive, fromToday) + 1;
}

/**
 * MEM_REGISTRY.md's Description column is meant to be an always-relevant
 * index, not a second copy of the full narrative — TODAY.md (and later its
 * archived form under memory/daily/) already holds the verbatim content, so
 * nothing is lost by capping the registry row itself.
 *
 * Reference: poller-brain#283 (feedback: unbounded registry rows, ~1000-1400B
 * each, drove MEM_REGISTRY.md to 8x the size threshold — same root cause
 * pb#244/PR#277 trims retroactively; this caps growth at write time instead).
 */
export const MAX_REGISTRY_DESC_LENGTH = 300;

/**
 * Byte-aware (not JS string.length): MEM_REGISTRY.md descriptions are
 * frequently Czech prose, where diacritics (č/ř/š/ž/é...) are 2B each in
 * UTF-8. A code-unit-length cap silently lets those rows land 300-450B on
 * disk, missing the "<=300B" acceptance criterion for a non-hypothetical
 * share of real descriptions (DevGuru review, poller-brain#283).
 */
export function truncateRegistryDescription(
  desc: string,
  dailyLogPath: string,
  maxLength: number = MAX_REGISTRY_DESC_LENGTH
): string {
  if (Buffer.byteLength(desc, "utf8") <= maxLength) return desc;
  const pointer = ` [full: ${dailyLogPath}]`;
  const ellipsis = "…";
  const budget =
    maxLength - Buffer.byteLength(pointer, "utf8") - Buffer.byteLength(ellipsis, "utf8");

  let truncated = "";
  let bytes = 0;
  for (const ch of desc) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > Math.max(0, budget)) break;
    truncated += ch;
    bytes += chBytes;
  }
  truncated = truncated.trimEnd();
  return `${truncated}${ellipsis}${pointer}`;
}
