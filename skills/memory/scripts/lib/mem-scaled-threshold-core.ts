/**
 * Scaled byte thresholds for LEARNINGS.md and MEM_REGISTRY.md
 * (poller-brain#324, poller-brain#300, poller-brain#536).
 *
 * Both files are lifecycle-append-only in practice: MEM_REGISTRY.md never
 * deletes a REMOVED row in place (Step 1c / Step 9d relocate, never
 * delete), and LEARNINGS.md's own reduction gates (Step 5c/5d) only fire
 * on OBSOLETE/REMOVED-keyed or demonstrably-duplicated entries — a
 * mature, healthy, ACTIVE-heavy brain's row/entry count only grows. A flat
 * 5000-byte cap is therefore not a "trim harder" signal on such a brain,
 * it's mathematically unreachable: even every row/entry rewritten to its
 * shortest possible form still totals more than 5000B once the count is
 * high enough. Measured on poller-brain#324 (tina-kb, 2026-08-17):
 * MEM_REGISTRY.md had 58 live rows, 231B non-row overhead, 85B shortest
 * real row — floor = 58*85+231 = 5161B, already over cap with EVERY row at
 * its practical minimum.
 *
 * The fix: scale the threshold by the file's own row/entry count instead
 * of using a flat number, so the metric tracks per-row/per-entry
 * verbosity (which is controllable — see Step 9e / mem-write.ts's
 * write-time description cap, poller-brain#283/#284) rather than total
 * count (which structurally is not, for an append-only audit log).
 * `Math.max(BASE_FLOOR_BYTES, ...)` keeps the original 5000B floor for
 * small/young brains, so a brain with few rows/entries doesn't get an
 * artificially tight threshold that trips on completely normal content.
 *
 * #536 adds evaluateRegistry(): recognized trim pointers receive at least
 * their complete emitted byte footprint, while other rows keep 150B. This
 * accounts for dated IDs, both pointer paths in five-column rows, and the
 * current writer's unbounded heading hooks. Large pointer labels therefore
 * do not warn; narrative rows and excess non-row prose still do. A fixed
 * hook allowance would require a separate change to the trim writer's
 * hook contract to guarantee that every valid trim output fits.
 *
 * PREFERENCES.md deliberately has no scaled-threshold path here: unlike
 * LEARNINGS.md/MEM_REGISTRY.md it has no enforced entry format and no
 * existing parser (no reduction step has ever been built for it — see
 * SKILL.md Step 9b's "Tracking only for now" note), so there's nothing
 * reliable to count entries against yet. It keeps its flat 5000B
 * tracking-only threshold unchanged; revisit once a real over-threshold
 * brain and an entry-format convention exist to calibrate against.
 */

import { MEM_ID_PATTERN } from "./mem-id.js";
import { parseRegistryCells } from "./mem-registry-trim-core.js";

export const BASE_FLOOR_BYTES = 5000;

/** Non-table prose overhead (title, HOLD-rule sections, etc.) is brain-specific and NOT
 * modeled here — a brain with a large embedded prose section will still and correctly
 * flag as over-threshold; this overhead constant only accounts for the table header/
 * divider or a short file preamble, matching poller-brain#324's measured 231B. */
export const REGISTRY_OVERHEAD_BYTES = 300;
/** Minimum row allowance: sits above the measured 85B absolute-minimum pointer
 * row and below the 300B write-time cap (poller-brain#284), close to the 127B measured
 * median pointer length (poller-brain#324). #536 budgets recognized trim pointers
 * separately, since IDs, paths and the writer's unbounded hooks can exceed 150B. */
export const REGISTRY_PER_ROW_BYTES = 150;

export const LEARNINGS_OVERHEAD_BYTES = 300;
/** Healthy post-trim entry target, derived the same way as REGISTRY_PER_ROW_BYTES: from
 * the actual `- [MEM-N] → see <file>:<line> — <hook>` pointer line Step 5d writes (same
 * sentence shape as the registry's pointer rows, just prefixed `-`/`###` instead of a
 * table cell). Measured against 10 real already-trimmed pointer entries live in this
 * brain's own LEARNINGS.md (poller-brain vibe-keeper-brain, 2026-08-20): 93B min, 137B
 * median, 216B max — 150 sits just above the median, matching the registry's own margin
 * over its 127B median. DevGuru caught the previous unanchored 400B guess flipping a
 * 4th sample brain (24110B/84 entries) from OVER to OK — a bare guess had no way to know
 * that. 150 was checked against the same sample and stays correctly OVER (threshold
 * 300+84*150=12900 < 24110). */
export const LEARNINGS_PER_ENTRY_BYTES = 150;

// Module-scoped with /g — safe with .match() (used below, resets per call) but stateful
// (lastIndex) if ever called with .test() instead. Keep call sites on .match()/matchAll();
// don't add a .test() use of this constant without dropping /g first.
const REGISTRY_ROW_RE = new RegExp(String.raw`^\|\s*${MEM_ID_PATTERN}\s*\|`, "gm");
const REGISTRY_DATA_ROW_RE = new RegExp(String.raw`^\|\s*${MEM_ID_PATTERN}\s*\|`);

/** Count live data rows in a MEM_REGISTRY.md-shaped table (any status — ACTIVE, OBSOLETE,
 * or a REMOVED row not yet relocated by Step 9d this cycle). Matches poller-brain#324's
 * own "58 data rows" measurement method. */
export function countRegistryRows(text: string): number {
  return (text.match(REGISTRY_ROW_RE) || []).length;
}

/**
 * Not monotonic with respect to Step 9d archival: REGISTRY_PER_ROW_BYTES (150) is a
 * healthy-average target, but a relocated REMOVED row is typically shorter than that
 * (poller-brain#324 measured 85B min / 127B median) — so a successful archival removes
 * both bytes AND a row, and the threshold can drop faster than the size does. On #324's
 * own numbers (8689B / 58 rows / threshold 9000 = OK today), archiving k rows flips OK
 * to OVER once `8689 - 127k > 300 + 150*(58-k)`, i.e. k > 13.5 — 14+ rows relocated in
 * one cycle. Rare (Step 9d already runs at most once per consolidation cycle) but real;
 * if it shows up in practice, evaluate Step 9d's threshold check against the pre-
 * archival row count rather than re-measuring after the relocation.
 */
export function scaledThreshold(
  entryCount: number,
  overheadBytes: number,
  perEntryBytes: number
): number {
  return Math.max(BASE_FLOOR_BYTES, overheadBytes + entryCount * perEntryBytes);
}

export interface ScaledThresholdResult {
  sizeBytes: number;
  entryCount: number;
  threshold: number;
  overCap: boolean;
}

export interface RegistryThresholdResult extends ScaledThresholdResult {
  /** Complete, escape-aware four/five-column pointers matching the trim writer. */
  pointerRows: number;
  /** Includes ordinary narrative rows and malformed key-bearing rows. */
  nonPointerRows: number;
  /** Sum of max(150, pointer row bytes including its newline), or 150 for other rows. */
  rowBudgetBytes: number;
  /** Additional allowance above the old 150B/row policy. */
  structuralExtraBytes: number;
  diagnostics: { line: number; reason: string }[];
}

/** Recognize the actual trim encoding, rather than rewarding arbitrary long cells.
 * Five-column rows must repeat the same path in Obsoleted and Description. Four-
 * column rows carry the path only in Description. The trim writer does not cap hook
 * length or constrain preserved Status/Created cells, so the complete recognized
 * pointer row is budgeted, including its label and original formatting. This makes
 * every valid emitted pointer fit without teaching the metric to excuse narrative
 * descriptions or non-row prose. It deliberately does not measure pointer verbosity.
 */
function isTrimPointer(cells: string[]): boolean {
  const description = cells[cells.length - 2].trim();
  if (cells.length === 7) {
    const pointer = /^(.+\.md):[1-9]\d*$/.exec(cells[4].trim());
    return pointer !== null && [" — ", " - "].some((separator) =>
      description.startsWith(`see ${pointer[1]}${separator}`) &&
      description.length > `see ${pointer[1]}${separator}`.length);
  }
  return /^see .+\.md (?:—|-) .+$/u.test(description);
}

/** Registry-specific structural budget (#536). Non-row overhead stays fixed:
 * title/table headers fit within 300B; large embedded prose can still exceed it.
 * Removing rows can lower the threshold faster than file size (as before).
 * Keep generic evaluate()/scaledThreshold() unchanged for LEARNINGS consumers.
 */
export function evaluateRegistry(text: string): RegistryThresholdResult {
  let entryCount = 0;
  let pointerRows = 0;
  let rowBudgetBytes = 0;
  const diagnostics: RegistryThresholdResult["diagnostics"] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!REGISTRY_DATA_ROW_RE.test(line)) continue;
    entryCount++;
    const cells = parseRegistryCells(line);
    let rowBytes = REGISTRY_PER_ROW_BYTES;
    if (cells && isTrimPointer(cells)) {
      pointerRows++;
      // Preserve byte accounting for UTF-8, escaped delimiters, CRLF, original
      // padding and an absent final newline. Never scale by whole-file size.
      rowBytes = Buffer.byteLength(line, "utf-8") + (index < lines.length - 1 ? 1 : 0);
    } else if (!cells || cells[cells.length - 2].trim().startsWith("see ")) {
      diagnostics.push({ line: index + 1, reason: cells
        ? "unrecognized pointer encoding; using 150B row allowance"
        : "expected four or five bounded cells; using 150B row allowance" });
    }
    rowBudgetBytes += Math.max(REGISTRY_PER_ROW_BYTES, rowBytes);
  }
  const sizeBytes = Buffer.byteLength(text, "utf-8");
  const threshold = Math.max(BASE_FLOOR_BYTES, REGISTRY_OVERHEAD_BYTES + rowBudgetBytes);
  return { sizeBytes, entryCount, threshold, overCap: sizeBytes > threshold,
    pointerRows, nonPointerRows: entryCount - pointerRows, rowBudgetBytes,
    structuralExtraBytes: rowBudgetBytes - entryCount * REGISTRY_PER_ROW_BYTES, diagnostics };
}

export function evaluate(
  text: string,
  entryCount: number,
  overheadBytes: number,
  perEntryBytes: number
): ScaledThresholdResult {
  const sizeBytes = Buffer.byteLength(text, "utf-8");
  const threshold = scaledThreshold(entryCount, overheadBytes, perEntryBytes);
  return { sizeBytes, entryCount, threshold, overCap: sizeBytes > threshold };
}
