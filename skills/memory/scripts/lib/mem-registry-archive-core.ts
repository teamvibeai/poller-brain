/**
 * Pure relocation logic for MEM_REGISTRY.md REMOVED-row archival.
 *
 * Why a step exists: `MEM_REGISTRY.md` is append-only for audit reasons —
 * REMOVED rows are never deleted, so the registry grows unbounded (11 REMOVED
 * rows already push it 4× over its 5000-byte threshold with no in-channel
 * reduction path). This module relocates dead REMOVED audit rows to
 * `MEM_REGISTRY_ARCHIVE.md`, leaving a single navigable stub pointer in the
 * live registry. ACTIVE / OBSOLETE rows and all prose stay untouched.
 *
 * Reference: poller-brain#175 (LEARNINGS gate — kept manual, gate not built);
 * this covers only the mechanical dead-data relocation DevGuru ACK'd.
 *
 * Design constraints (DevGuru review conditions):
 *   1. Idempotent — consolidate can run twice in a row (gap-day /
 *      reflection-only sequences). A second run must be a byte-identical
 *      no-op: REMOVED rows are gone, the regenerated stub is not a data row,
 *      so nothing is re-matched or duplicated.
 *   2. Count-verifiable — every REMOVED row leaving the live table must land
 *      in the archive (round-trip identity, MEM-6), and the live REMOVED count
 *      must be 0 afterward. Callers assert on the returned stats and FAIL LOUD.
 *   3. Stub is a pointer (count + link + key list), never a bare deletion.
 *
 * This module is intentionally fs-free so the invariants can be unit-tested
 * against string fixtures without touching a real brain's memory/.
 */

export const ARCHIVE_HEADER = `# MEM Registry — Archive

REMOVED audit rows relocated from \`MEM_REGISTRY.md\` to keep the live registry
under threshold. Appended by \`skills/memory/scripts/mem-registry-archive.ts\`
during consolidation — do not hand-edit. Full lifecycle history lives here;
the live registry keeps only ACTIVE / OBSOLETE rows plus a pointer stub.

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
`;

/** Matches the pointer stub so it can be regenerated (never appended twice). */
export const STUB_RE = /^> 📦 \d+ REMOVED /;

const DATA_ROW_RE = /^\|\s*(MEM-\d+)\s*\|/;

export interface ArchiveStats {
  /** REMOVED data rows found in the live registry before the run. */
  removedFromLive: number;
  /** Rows newly appended to the archive this run (were not already there). */
  newlyArchived: number;
  /** REMOVED rows already present in the archive (idempotent re-run / partial). */
  alreadyInArchive: number;
  /** Total distinct MEM keys in the archive after the run. */
  totalArchived: number;
  /** REMOVED data rows still in the live registry after the run (must be 0). */
  liveRemovedAfter: number;
  /** Keys that failed round-trip (removed from live but absent from archive). */
  missing: string[];
  /** Keys relocated this run, sorted. */
  archivedKeys: string[];
}

export interface ArchiveResult {
  registry: string;
  archive: string;
  stats: ArchiveStats;
}

function dataKey(line: string): string | null {
  const m = line.match(DATA_ROW_RE);
  return m ? m[1] : null;
}

function statusOf(line: string): string {
  // cells: ["", " MEM-N ", " STATUS ", ...] — index 2 is the status column.
  const cells = line.split("|");
  return cells.length > 2 ? cells[2].trim() : "";
}

function keysIn(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const k = dataKey(line);
    if (k) keys.add(k);
  }
  return keys;
}

function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort(
    (a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10)
  );
}

/**
 * Relocate REMOVED rows from a live registry into an archive.
 *
 * @param registry current MEM_REGISTRY.md content
 * @param archive  current MEM_REGISTRY_ARCHIVE.md content ("" if it doesn't exist)
 * @returns new registry + archive content and machine-checkable stats
 */
export function archiveRemovedRows(
  registry: string,
  archive: string
): ArchiveResult {
  const removedRows: { key: string; line: string }[] = [];
  const kept: string[] = [];

  for (const line of registry.split("\n")) {
    const key = dataKey(line);
    if (key && statusOf(line) === "REMOVED") {
      removedRows.push({ key, line });
    } else if (STUB_RE.test(line)) {
      // Drop any prior stub; it is regenerated below from the archive total.
      continue;
    } else {
      kept.push(line);
    }
  }

  // Seed / extend the archive, deduping by key so re-runs never duplicate.
  const archiveBody = archive.trim().length ? archive : ARCHIVE_HEADER;
  const archiveLines = archiveBody.replace(/\n+$/, "").split("\n");
  const archiveKeys = keysIn(archiveBody);

  let newlyArchived = 0;
  let alreadyInArchive = 0;
  for (const { key, line } of removedRows) {
    if (archiveKeys.has(key)) {
      alreadyInArchive++;
    } else {
      archiveLines.push(line);
      archiveKeys.add(key);
      newlyArchived++;
    }
  }
  const newArchive = archiveLines.join("\n") + "\n";

  // Round-trip guard: every relocated key must exist in the archive now.
  const archiveKeysAfter = keysIn(newArchive);
  const missing = removedRows
    .map((r) => r.key)
    .filter((k) => !archiveKeysAfter.has(k));

  // Regenerate the pointer stub from the archive total, placed right after the
  // last live data row so re-runs land it in the identical spot (idempotent).
  const archivedKeys = sortKeys(archiveKeysAfter);
  let newRegistry: string;
  if (archivedKeys.length === 0) {
    newRegistry = kept.join("\n");
  } else {
    const stub =
      `> 📦 ${archivedKeys.length} REMOVED audit ${archivedKeys.length === 1 ? "entry" : "entries"} ` +
      `archived to [MEM_REGISTRY_ARCHIVE.md](MEM_REGISTRY_ARCHIVE.md) — ` +
      `Keys: ${archivedKeys.join(", ")}`;
    let lastDataIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (dataKey(kept[i])) lastDataIdx = i;
    }
    if (lastDataIdx === -1) {
      // No data rows left (registry was all-REMOVED) — append stub at end.
      newRegistry = [...kept, stub].join("\n");
    } else {
      newRegistry = [
        ...kept.slice(0, lastDataIdx + 1),
        stub,
        ...kept.slice(lastDataIdx + 1),
      ].join("\n");
    }
  }

  const liveRemovedAfter = newRegistry
    .split("\n")
    .filter((l) => dataKey(l) && statusOf(l) === "REMOVED").length;

  return {
    registry: newRegistry,
    archive: newArchive,
    stats: {
      removedFromLive: removedRows.length,
      newlyArchived,
      alreadyInArchive,
      totalArchived: archiveKeysAfter.size,
      liveRemovedAfter,
      missing,
      archivedKeys: sortKeys(removedRows.map((r) => r.key)),
    },
  };
}

/**
 * Machine count-verify. Throws with an actionable message on any invariant
 * break so the CLI / consolidate step fails loud rather than silently
 * dropping a line. Returns the list of assertions that passed.
 */
export function verifyStats(stats: ArchiveStats): string[] {
  const checks: string[] = [];

  if (stats.missing.length > 0) {
    throw new Error(
      `Round-trip failure: ${stats.missing.length} REMOVED key(s) left the live ` +
        `registry but are absent from the archive: ${stats.missing.join(", ")}. ` +
        `Aborting — no write performed.`
    );
  }
  checks.push(`round-trip: all ${stats.removedFromLive} relocated keys present in archive ✅`);

  // "živé REMOVED odebrané == archive přidané" — in the normal path every
  // relocated row is newly archived; a re-run may find some already there.
  if (stats.newlyArchived + stats.alreadyInArchive !== stats.removedFromLive) {
    throw new Error(
      `Count mismatch: removedFromLive=${stats.removedFromLive} but ` +
        `newlyArchived(${stats.newlyArchived}) + alreadyInArchive(${stats.alreadyInArchive}) ` +
        `= ${stats.newlyArchived + stats.alreadyInArchive}.`
    );
  }
  checks.push(
    `count: removedFromLive(${stats.removedFromLive}) == newlyArchived(${stats.newlyArchived}) + alreadyInArchive(${stats.alreadyInArchive}) ✅`
  );

  if (stats.liveRemovedAfter !== 0) {
    throw new Error(
      `Live registry still has ${stats.liveRemovedAfter} REMOVED row(s) after archival — expected 0.`
    );
  }
  checks.push(`live REMOVED count after run == 0 ✅`);

  return checks;
}
