#!/usr/bin/env npx tsx
/**
 * Rewrite MEM_REGISTRY.md rows already promoted into consolidated prose
 * (core/semantic/episodic/procedural) to a short pointer, leaving
 * Key/Status/Created untouched and all not-yet-promoted rows as-is. Keeps
 * the live registry under threshold without deleting audit history or
 * requiring a particular status-lifecycle convention.
 * See lib/mem-registry-trim-core.ts for the invariants.
 *
 * Invoked by the consolidate skill (Step 9e) when MEM_REGISTRY.md exceeds
 * its threshold. Safe to run anytime: a no-op when no row is both
 * not-yet-a-pointer and cited in a destination file.
 *
 * Idempotent: a second consecutive run is a byte-identical no-op.
 * Count-verified: aborts (exit 1) on any invariant break — no silent drop.
 *
 * Usage:
 *   npx tsx mem-registry-trim.ts          # trim + verify + write
 *   npx tsx mem-registry-trim.ts --check  # dry-run: report + verify, no write
 */

import * as fs from "fs";
import * as path from "path";
import { brainPath } from "./lib/brain-root.js";
import {
  trimPromotedRows,
  verifyTrimStats,
  type DestinationFile,
} from "./lib/mem-registry-trim-core.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
// episodic/ is deliberately excluded: dated journals/reflections routinely
// mention a MEM-N key in bookkeeping context (day-N countdown, "merge this
// later" TODOs, status tallies) rather than as condensed promoted prose.
// DevGuru caught this against a real 24-key sample (poller-brain#244 review):
// 14/41 candidate trims relied solely on an episodic citation, and auditing
// them found the "citation" was a passing mention of an unrelated fact, not
// the row's actual promoted content — a false positive here means
// irreversibly overwriting real narrative with an unrelated pointer, so we
// accept lower recall (false-negative) over any false-positive risk here.
const DEST_DIRS = ["core", "semantic", "procedural"];

function walk(absDir: string, relDir: string, out: DestinationFile[]): void {
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.join(relDir, entry.name);
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walk(absPath, relPath, out);
    } else if (entry.name.endsWith(".md")) {
      out.push({ file: relPath, text: fs.readFileSync(absPath, "utf-8") });
    }
  }
}

function collectDestinations(): DestinationFile[] {
  const destinations: DestinationFile[] = [];
  for (const dir of DEST_DIRS) {
    walk(brainPath("memory", dir), dir, destinations);
  }
  return destinations;
}

function main(): void {
  const dryRun = process.argv.includes("--check");

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.log(`No MEM_REGISTRY.md at ${REGISTRY_PATH} — nothing to trim.`);
    return;
  }

  const registryBefore = fs.readFileSync(REGISTRY_PATH, "utf-8");
  const destinations = collectDestinations();

  const { registry, stats } = trimPromotedRows(registryBefore, destinations);

  // Machine count-verify BEFORE writing — throws (→ exit 1) on any violation.
  const checks = verifyTrimStats(stats);

  if (stats.trimmedRows === 0) {
    console.log(
      `No promoted rows to trim (${stats.alreadyPointer} already pointers, ` +
        `${stats.candidateRows} candidate row(s) checked against ${destinations.length} destination file(s), ` +
        `none cited). No-op.`
    );
    return;
  }

  if (dryRun) {
    console.log("[--check] would trim; no files written.");
  } else {
    fs.writeFileSync(REGISTRY_PATH, registry);
  }

  console.log(
    [
      `MEM_REGISTRY trim ${dryRun ? "(dry-run) " : ""}complete:`,
      `  trimmed:        ${stats.trimmedKeys.join(", ") || "(none)"}`,
      `  alreadyPointer: ${stats.alreadyPointer}`,
      `  candidateRows:  ${stats.candidateRows}`,
      `  registry size:  ${stats.bytesBefore} → ${stats.bytesAfter} bytes`,
      ...checks.map((c) => `  verify: ${c}`),
    ].join("\n")
  );
}

main();
