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
// All four tiers are scanned. episodic/ was briefly excluded outright, but
// DevGuru proved (poller-brain#244 review, against real data) the same
// "family/sibling cross-reference" false positive occurs in core/ and
// semantic/ too — the actual hazard is a line citing 2+ MEM-N keys together
// (ambiguous: condensed prose for one of them, or just a group listing?),
// not the directory it lives in. That ambiguity is rejected at the source in
// mem-registry-trim-core.ts's firstCitations() (single-distinct-key-per-line
// gate), so directory-level exclusion is no longer needed as a safety net —
// and excluding episodic/ wholesale was throwing away genuine single-key
// citations that live there (real postmortem prose, not bookkeeping).
const DEST_DIRS = ["core", "semantic", "episodic", "procedural"];

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
