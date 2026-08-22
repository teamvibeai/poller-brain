#!/usr/bin/env npx tsx
/**
 * Propose (or, given an explicit approved key list, apply) memory/core/
 * MISTAKES.md trim: relocate an entry's full text to
 * memory/episodic/archive/mistakes-YYYY-Hn.md and replace it with a
 * pointer, once its lesson has been demonstrably promoted into
 * core/LEARNINGS.md, semantic/, or procedural/. See
 * lib/mem-mistakes-trim-core.ts for the invariants and poller-brain#328
 * for why this exists (consolidate Step 5's status:new-based promotion
 * path never fires — see that file's module doc).
 *
 * DEFAULT MODE IS PROPOSE-ONLY — it never writes. Mirrors
 * mem-registry-trim.ts / mem-learnings-trim.ts: a destination citing this
 * key is evidence worth a human's attention, not proof strong enough to
 * auto-write.
 *
 *   npx tsx mem-mistakes-trim.ts                          # propose: list candidates, write nothing
 *   npx tsx mem-mistakes-trim.ts --apply --only MEM-1,MEM-5  # apply exactly these approved keys
 *
 * There is no "--apply --all" mode on purpose.
 */

import * as fs from "fs";
import * as path from "path";
import { brainPath } from "./lib/brain-root.js";
import {
  findMistakesTrimCandidates,
  applyMistakesTrimCandidates,
  verifyMistakesTrimStats,
  DEFAULT_ARCHIVE_HEADER,
  type DestinationFile,
  type MistakesTrimCandidate,
  type UnreliableHook,
} from "./lib/mem-mistakes-trim-core.js";
import type { IndexRejection } from "./lib/citation-detect.js";

const MISTAKES_PATH = brainPath("memory/core/MISTAKES.md");
// core/LEARNINGS.md IS a valid destination here (unlike mem-learnings-trim's
// DEST_DIRS, which excludes all of core/) — see lib module doc for why.
// Deliberately excludes "episodic" — this script writes its OWN archive to
// episodic/archive/mistakes-*.md, and scanning it back as a destination
// would let a freshly-archived entry's own self-citation count as evidence
// of promotion. See the matching episodic/archive exclusion added to
// mem-learnings-trim.ts/mem-registry-trim.ts's own DEST_DIRS walk for the
// same risk in the other direction (poller-brain#328 review round 1).
const DEST_FILES = ["core/LEARNINGS.md"];
const DEST_DIRS = ["semantic", "procedural"];

const MISTAKES_CAP_BYTES = 5000;
const HAS_MEM_KEY_RE = /\bMEM-\d+\b/;
// Below this, "the entries we found" cover too little of the file to trust
// the parse — see mem-mistakes-trim-core.ts module doc for the real-data
// case this guards against (0% of real entries recognized, sub-bullets
// misread as entries, MISTAKES.md#328 issue's own over-cap file).
const MIN_COVERAGE_RATIO = 0.5;

/** Returns a warning message if this looks like an entry-format mismatch, else null. Checked on BOTH propose and apply paths — see NIT2, poller-brain#328 review round 1. */
function formatMismatchWarning(mistakesBefore: string, coverageRatio: number): string | null {
  const overCap = Buffer.byteLength(mistakesBefore) > MISTAKES_CAP_BYTES;
  const hasMemKeys = HAS_MEM_KEY_RE.test(mistakesBefore);
  if (!overCap || !hasMemKeys || coverageRatio >= MIN_COVERAGE_RATIO) return null;
  return (
    `⚠️  recognized entries cover only ${(coverageRatio * 100).toFixed(1)}% of a ` +
    `${Buffer.byteLength(mistakesBefore)}B MISTAKES.md that is over the ${MISTAKES_CAP_BYTES}B cap and contains ` +
    `MEM- keys. This looks like an entry-format mismatch (only "## "/"### " heading starts and top-level "- " ` +
    `bullets are recognized), not a confirmed-clean parse — a low-coverage parse can misread body sub-bullets as ` +
    `entries even when totalEntries > 0.`
  );
}

function halfYearBucket(d: Date): string {
  const half = d.getUTCMonth() < 6 ? "H1" : "H2";
  return `${d.getUTCFullYear()}-${half}`;
}

function archivePath(bucket: string): string {
  return brainPath("memory", "episodic", "archive", `mistakes-${bucket}.md`);
}

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
  for (const rel of DEST_FILES) {
    const abs = brainPath("memory", rel);
    if (fs.existsSync(abs)) {
      destinations.push({ file: rel, text: fs.readFileSync(abs, "utf-8") });
    } else {
      console.warn(`⚠️  destination file not found, skipped: memory/${rel}`);
    }
  }
  for (const dir of DEST_DIRS) {
    walk(brainPath("memory", dir), dir, destinations);
  }
  return destinations;
}

function parseOnlyFlag(): string[] | null {
  const idx = process.argv.indexOf("--only");
  if (idx === -1) return null;
  const raw = process.argv[idx + 1];
  if (!raw) {
    console.error("--only requires a comma-separated key list, e.g. --only MEM-1,MEM-5");
    process.exit(1);
  }
  return raw.split(",").map((k) => k.trim()).filter(Boolean);
}

function printProposals(candidates: MistakesTrimCandidate[], archiveLabel: string): void {
  console.log(`${candidates.length} trim candidate(s) found. Nothing written — review, then apply with:`);
  console.log(`  npx tsx mem-mistakes-trim.ts --apply --only ${candidates.map((c) => c.key).join(",") || "<keys>"}`);
  console.log("(or a hand-picked subset of the keys below)\n");
  for (const c of candidates) {
    const span = c.entryStartLine === c.entryEndLine ? `${c.entryStartLine}` : `${c.entryStartLine}-${c.entryEndLine}`;
    console.log(`${c.key} (MISTAKES.md:${span}, ${c.format} entry) → ${c.file}:${c.line}`);
    console.log(`  citing line:      ${c.lineText.trim()}`);
    console.log(`  proposed pointer: ${c.marker} [${c.key}] → see ${c.file}:${c.line} — ${c.hook}`);
    console.log(`  archived to:      ${archiveLabel} (full original text, verbatim)`);
    console.log();
  }
}

function printParseSummary(result: {
  totalEntries: number;
  multiKeyEntries: number;
  alreadyPointer: number;
  candidates: MistakesTrimCandidate[];
}): void {
  console.log(
    `parse summary: entries=${result.totalEntries}, multi-key=${result.multiKeyEntries}, ` +
      `pointers=${result.alreadyPointer}, candidates=${result.candidates.length}`
  );
}

function printIndexRejections(indexRejections: IndexRejection[]): void {
  if (indexRejections.length === 0) {
    console.log("index-shaped destination lines rejected as evidence: 0\n");
    return;
  }
  console.log(`index-shaped destination lines rejected as evidence: ${indexRejections.length}:`);
  for (const r of indexRejections) console.log(`  ${r.key} @ ${r.file}:${r.line}  ${r.lineText.trim()}`);
  console.log();
}

function printUnreliableHooks(unreliableHooks: UnreliableHook[]): void {
  if (unreliableHooks.length === 0) {
    console.log("keys excluded for an unreliable extracted hook: 0\n");
    return;
  }
  console.log(`keys excluded for an unreliable extracted hook: ${unreliableHooks.length}:`);
  for (const u of unreliableHooks) console.log(`  ${u.key} @ ${u.file}:${u.line}  hook="${u.hook}"  line: ${u.lineText.trim()}`);
  console.log();
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const onlyKeys = parseOnlyFlag();

  if (apply && !onlyKeys) {
    console.error(
      "--apply requires --only <comma-separated keys> — there is no blind-trust-everything mode."
    );
    process.exit(1);
  }

  if (!fs.existsSync(MISTAKES_PATH)) {
    console.log(`No MISTAKES.md at ${MISTAKES_PATH} — nothing to trim.`);
    return;
  }

  const mistakesBefore = fs.readFileSync(MISTAKES_PATH, "utf-8");
  const destinations = collectDestinations();
  const { candidates, totalEntries, multiKeyEntries, alreadyPointer, indexRejections, unreliableHooks, coverageRatio } =
    findMistakesTrimCandidates(mistakesBefore, destinations);

  const bucket = halfYearBucket(new Date());
  const archiveAbsPath = archivePath(bucket);
  const archiveLabel = `episodic/archive/mistakes-${bucket}.md`;

  if (!apply) {
    printParseSummary({ totalEntries, multiKeyEntries, alreadyPointer, candidates });
    printIndexRejections(indexRejections);
    printUnreliableHooks(unreliableHooks);

    const mismatch = formatMismatchWarning(mistakesBefore, coverageRatio);
    if (mismatch) {
      console.warn(mismatch);
      return;
    }
    if (candidates.length === 0) {
      console.log(
        `No promoted entries to propose (${alreadyPointer} already pointers out of ${totalEntries} entries, ` +
          `checked against ${destinations.length} destination file(s)). No-op.`
      );
      return;
    }
    printProposals(candidates, archiveLabel);
    return;
  }

  printParseSummary({ totalEntries, multiKeyEntries, alreadyPointer, candidates });

  const mismatch = formatMismatchWarning(mistakesBefore, coverageRatio);
  if (mismatch) {
    console.error(mismatch.replace("⚠️ ", "❌") + " Aborting --apply — no write performed.");
    process.exit(1);
  }

  const approved = new Set(onlyKeys!);
  const unknown = [...approved].filter((k) => !candidates.some((c) => c.key === k));
  if (unknown.length > 0) {
    console.error(
      `--only lists key(s) with no trim candidate (not found, or already a pointer): ${unknown.join(", ")}. ` +
        `Aborting — no write performed.`
    );
    process.exit(1);
  }

  const toApply = candidates.filter((c) => approved.has(c.key));
  const archiveBefore = fs.existsSync(archiveAbsPath) ? fs.readFileSync(archiveAbsPath, "utf-8") : "";
  const archiveDate = new Date().toISOString().slice(0, 10);
  const { mistakes, archive, stats } = applyMistakesTrimCandidates(
    mistakesBefore,
    archiveBefore,
    toApply,
    archiveDate,
    DEFAULT_ARCHIVE_HEADER(bucket)
  );

  const checks = verifyMistakesTrimStats(stats);

  fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
  fs.writeFileSync(MISTAKES_PATH, mistakes);
  fs.writeFileSync(archiveAbsPath, archive);

  console.log(
    [
      `MISTAKES.md trim applied:`,
      `  trimmed:        ${stats.trimmedKeys.join(", ") || "(none)"}`,
      `  archived to:    ${archiveLabel} (${stats.archivedKeys.join(", ") || "none newly archived — already present"})`,
      `  MISTAKES.md:    ${stats.mistakesBytesBefore} → ${stats.mistakesBytesAfter} bytes`,
      ...checks.map((c) => `  verify: ${c}`),
    ].join("\n")
  );
}

main();
