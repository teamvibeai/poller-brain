#!/usr/bin/env npx tsx
/**
 * Relocate REMOVED audit rows from memory/MEM_REGISTRY.md into
 * memory/MEM_REGISTRY_ARCHIVE.md, leaving a single pointer stub in the live
 * registry. Keeps the live registry under threshold without deleting audit
 * history. See lib/mem-registry-archive-core.ts for the invariants.
 *
 * Invoked by the consolidate skill (Step 9d) when MEM_REGISTRY.md exceeds its
 * threshold. Safe to run anytime: a no-op when there are no REMOVED rows.
 *
 * Idempotent: a second consecutive run is a byte-identical no-op.
 * Count-verified: aborts (exit 1) on any invariant break — no silent drop.
 *
 * Usage:
 *   npx tsx mem-registry-archive.ts          # relocate + verify + write
 *   npx tsx mem-registry-archive.ts --check  # dry-run: report + verify, no write
 */

import * as fs from "fs";
import { brainPath } from "./lib/brain-root.js";
import {
  archiveRemovedRows,
  verifyStats,
} from "./lib/mem-registry-archive-core.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
const ARCHIVE_PATH = brainPath("memory/MEM_REGISTRY_ARCHIVE.md");

function main(): void {
  const dryRun = process.argv.includes("--check");

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.log(`No MEM_REGISTRY.md at ${REGISTRY_PATH} — nothing to archive.`);
    return;
  }

  const registryBefore = fs.readFileSync(REGISTRY_PATH, "utf-8");
  const archiveBefore = fs.existsSync(ARCHIVE_PATH)
    ? fs.readFileSync(ARCHIVE_PATH, "utf-8")
    : "";

  const { registry, archive, stats } = archiveRemovedRows(
    registryBefore,
    archiveBefore
  );

  // Machine count-verify BEFORE writing — throws (→ exit 1) on any violation.
  const checks = verifyStats(stats);

  if (stats.removedFromLive === 0) {
    console.log(
      `No REMOVED rows in live registry — already archived (${stats.totalArchived} in archive). No-op.`
    );
    return;
  }

  const registryChanged = registry !== registryBefore;
  const archiveChanged = archive !== archiveBefore;

  if (dryRun) {
    console.log("[--check] would relocate; no files written.");
  } else {
    if (archiveChanged) fs.writeFileSync(ARCHIVE_PATH, archive);
    if (registryChanged) fs.writeFileSync(REGISTRY_PATH, registry);
  }

  console.log(
    [
      `MEM_REGISTRY archival ${dryRun ? "(dry-run) " : ""}complete:`,
      `  relocated:        ${stats.archivedKeys.join(", ") || "(none)"}`,
      `  removedFromLive:  ${stats.removedFromLive}`,
      `  newlyArchived:    ${stats.newlyArchived}`,
      `  alreadyInArchive: ${stats.alreadyInArchive}`,
      `  totalArchived:    ${stats.totalArchived}`,
      `  liveRemovedAfter: ${stats.liveRemovedAfter}`,
      `  registry size:    ${Buffer.byteLength(registryBefore)} → ${Buffer.byteLength(registry)} bytes`,
      ...checks.map((c) => `  verify: ${c}`),
    ].join("\n")
  );
}

main();
