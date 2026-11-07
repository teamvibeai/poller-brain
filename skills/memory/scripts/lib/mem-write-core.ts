/**
 * Pure MEM write planning and legacy scan behaviour.
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
 *     prose-drift risk — legacy-only scan ignores dated IDs and is defense-in-depth.
 *   - TODAY.md mixes canonical write rows with free-text prose that may
 *     mention a MEM key in passing. Restrict to anchored canonical rows
 *     (`- [MEM-N]` at line start), tolerating a trailing `:` for format drift.
 */

import { LEGACY_MEM_ID_PATTERN, isMemId, parseMemId } from "./mem-id.js";

export function scanMaxKey(content: string, pattern: RegExp): number {
  const matches = content.matchAll(pattern);
  let max = 0;
  for (const m of matches) {
    const id = parseMemId(m[1]);
    if (id?.kind !== "legacy") continue;
    const n = id.n;
    if (n > max) max = n;
  }
  return max;
}

export const REGISTRY_KEY_PATTERN = new RegExp(`\\b(${LEGACY_MEM_ID_PATTERN})\\b`, "g");
export const ARCHIVE_KEY_PATTERN = new RegExp(`\\b(${LEGACY_MEM_ID_PATTERN})\\b`, "g");
export const TODAY_CANONICAL_KEY_PATTERN = new RegExp(String.raw`^- \[(${LEGACY_MEM_ID_PATTERN})\][\s:\]]`, "gm");

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

export type MemWritePlan =
  | { kind: "ready"; todayAppend: string; registryAppend: string }
  | { kind: "error"; code: 2 | 3; message: string };

/** Retain escaped pipes in description cells rather than treating them as separators. */
function registryCells(line: string): string[] {
  return line.trim().split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
}

/** Decide both appends before either file is changed; never allocate an identity here. */
export function planMemWrite(input: {
  today: string;
  registry: string;
  id: string;
  content: string;
}): MemWritePlan {
  const { today, registry, id, content } = input;
  const parsed = parseMemId(id);
  if (!isMemId(id) || parsed?.kind !== "dated") {
    return { kind: "error", code: 2, message: "--id requires a dated MEM ID" };
  }

  const tag = `[${id}]`;
  const lines = today.split("\n");
  const contentLineCount = content.split("\n").length;
  let todayPresent = false;
  let conflict = false;
  for (let i = 0; i < lines.length; i++) {
    const tagAt = lines[i].indexOf(tag);
    if (tagAt === -1) continue;
    todayPresent = true;
    // Compare the full requested text, including continuation lines that may
    // themselves look like log rows. Additional prose is conflicting content;
    // a subsequent log row/date section and rollover whitespace are separate.
    const text = [lines[i].slice(tagAt + tag.length).replace(/^ /, ""),
      ...lines.slice(i + 1, i + contentLineCount)].join("\n");
    const following = lines.slice(i + contentLineCount).find((line) => line !== "");
    if (text !== content || (following !== undefined && !/^(?:- \[|# \d{4}-\d{2}-\d{2})/.test(following))) conflict = true;
  }

  const desc = content.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  let registryPresent = false;
  for (const line of registry.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = registryCells(line);
    if (cells[0] !== id) continue;
    registryPresent = true;
    if (cells[cells.length - 1] !== desc) conflict = true;
  }
  if (conflict) {
    return { kind: "error", code: 3, message: `MEM id ${id} already used with different content` };
  }

  // Keep the writer's existing four/five-column header detection.
  const headerLine = registry.split("\n").find((line) => line.startsWith("|") && /Key/.test(line));
  const colCount = headerLine ? headerLine.split("|").filter((cell) => cell.trim()).length : 5;
  const row = colCount <= 4
    ? `| ${id} | ACTIVE | ${parsed.date} | ${desc} |\n`
    : `| ${id} | ACTIVE | ${parsed.date} | — | ${desc} |\n`;
  return {
    kind: "ready",
    todayAppend: todayPresent ? "" : `- [${id}] ${content}\n`,
    registryAppend: registryPresent ? "" : row,
  };
}
