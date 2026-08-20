#!/usr/bin/env npx tsx
/**
 * Propose (or, given an explicit approved key list, apply) memory/core/
 * LEARNINGS.md pointer rewrites for entries whose content has already been
 * promoted into a deeper narrative file (semantic/episodic/procedural).
 * See lib/mem-learnings-trim-core.ts for the invariants, the scoping
 * decisions (destinations exclude core/, single-key entries only,
 * entry-level not line-level parsing), and how this relates to consolidate
 * Step 5c.
 *
 * DEFAULT MODE IS PROPOSE-ONLY — it never writes LEARNINGS.md. This mirrors
 * mem-registry-trim.ts (poller-brain#244): "a destination file cites this
 * key" is evidence worth a human's attention, not proof strong enough to
 * auto-write. Each candidate prints its FULL citing line so a reviewer can
 * judge it without opening the destination file.
 *
 * Applying is a separate, explicit, opt-in step — pass the exact keys you
 * (or DevGuru, or whoever reviewed the proposal) have approved:
 *   npx tsx mem-learnings-trim.ts --apply --only MEM-99,MEM-104
 *
 * There is no "--apply --all" / blind-trust-everything mode on purpose.
 *
 * SPAN SELECTORS (poller-brain#334): a key can have MORE THAN ONE candidate
 * — e.g. its own real entry, and an unrelated entry that merely mentions the
 * key once in passing (a cross-reference bullet inside a DIFFERENT key's
 * entry, which the parser reads as its own single-key "entry" — a known,
 * documented false-positive shape). A bare `--only MEM-25` is only accepted
 * when MEM-25 has exactly ONE candidate; with 2+, it's rejected as
 * ambiguous and you must disambiguate with `MEM-25@<entryStartLine>` (the
 * line number `mem-learnings-trim.ts` (no `--apply`) prints next to each
 * candidate) to pick exactly the one you reviewed and approved:
 *   npx tsx mem-learnings-trim.ts --apply --only MEM-25@67
 * This prevents silently applying BOTH the genuine candidate and the bogus
 * one just because they share a key.
 *
 * Idempotent: re-running --apply with a key that's already a pointer is a
 * no-op for that key. Count-verified: aborts (exit 1) on any invariant
 * break — no silent drop.
 *
 * Usage:
 *   npx tsx mem-learnings-trim.ts                            # propose: list candidates, write nothing
 *   npx tsx mem-learnings-trim.ts --apply --only MEM-1,MEM-5  # apply exactly these approved keys
 *   npx tsx mem-learnings-trim.ts --apply --only MEM-25@67    # apply MEM-25's candidate at entryStartLine 67 specifically
 */

import * as fs from "fs";
import * as path from "path";
import { brainPath } from "./lib/brain-root.js";
import {
  findLearningsTrimCandidates,
  applyLearningsTrimCandidates,
  verifyLearningsTrimStats,
  parseOnlySelectors,
  groupCandidatesByKey,
  unambiguousHeadlineKeys,
  type DestinationFile,
  type LearningsTrimCandidate,
  type OnlySelector,
  type UnreliableHook,
} from "./lib/mem-learnings-trim-core.js";
import type { IndexRejection } from "./lib/citation-detect.js";

const LEARNINGS_PATH = brainPath("memory/core/LEARNINGS.md");
// Deliberately excludes "core" — LEARNINGS.md entries self-cite their own
// key in the trailing "(Source: ..., [MEM-N])"; scanning core/LEARNINGS.md
// as its own destination would make every single-key entry a spurious
// candidate for itself. See lib/mem-learnings-trim-core.ts module doc.
const DEST_DIRS = ["semantic", "episodic", "procedural"];

// Same 5000B convention as the skill.md Step 5d/9e preflight (consolidate
// only invokes this script once the brain's own LEARNINGS.md is over cap) —
// duplicated here so the CLI's own fail-safe (below) doesn't depend on
// being invoked correctly by the skill.
const LEARNINGS_CAP_BYTES = 5000;
const HAS_MEM_KEY_RE = /\bMEM-\d+\b/;

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

function parseOnlyFlag(): OnlySelector[] | null {
  const idx = process.argv.indexOf("--only");
  if (idx === -1) return null;
  const raw = process.argv[idx + 1];
  if (!raw) {
    console.error(
      "--only requires a comma-separated key list, e.g. --only MEM-1,MEM-5 " +
        "(or MEM-25@67 to disambiguate a key with more than one candidate)"
    );
    process.exit(1);
  }
  try {
    return parseOnlySelectors(raw);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function printProposals(candidates: LearningsTrimCandidate[]): void {
  const byKey = groupCandidatesByKey(candidates);
  const selectorFor = (c: LearningsTrimCandidate): string =>
    byKey.get(c.key)!.length > 1 ? `${c.key}@${c.entryStartLine}` : c.key;

  // DevGuru catch (poller-brain#334 review round 1, blocking 2): the
  // headline copy-paste command used to pre-expand to EVERY candidate,
  // including ALL span selectors for an ambiguous key — copy-pasting it
  // verbatim applied both the genuine candidate and the bogus cross-ref
  // one, silently overwriting the cross-ref bullet with a duplicate
  // pointer (verify checks stay green because distinct-key count doesn't
  // change). The headline now only lists keys with exactly ONE candidate
  // (`unambiguousHeadlineKeys`); ambiguous keys are left OUT on purpose and
  // called out below, so copy-pasting the headline can never apply more
  // than one candidate for the same key — a reviewer must explicitly pick a
  // span selector per ambiguous key from the per-candidate list.
  const unambiguousKeys = unambiguousHeadlineKeys(candidates);
  const ambiguousKeys = [...new Set(candidates.filter((c) => byKey.get(c.key)!.length > 1).map((c) => c.key))];

  console.log(`${candidates.length} trim candidate(s) found. Nothing written — review, then apply with:`);
  console.log(`  npx tsx mem-learnings-trim.ts --apply --only ${unambiguousKeys.join(",") || "<keys>"}`);
  if (ambiguousKeys.length > 0) {
    console.log(
      `(${ambiguousKeys.length} key(s) have 2+ candidates and are deliberately NOT in the command above — ` +
        `pick a span selector (MEM-N@<line>, shown below) for each and add it by hand: ${ambiguousKeys.join(", ")})\n`
    );
  } else {
    console.log("(or a hand-picked subset of the keys above)\n");
  }
  for (const c of candidates) {
    const span = c.entryStartLine === c.entryEndLine ? `${c.entryStartLine}` : `${c.entryStartLine}-${c.entryEndLine}`;
    const marker = c.format === "heading" ? "###" : "-";
    console.log(`${selectorFor(c)} (LEARNINGS.md:${span}, ${c.format} entry) → ${c.file}:${c.line}`);
    console.log(`  citing line:      ${c.lineText.trim()}`);
    // Must match applyLearningsTrimCandidates' actual write, verbatim — a
    // reviewer approves THIS text (DevGuru catch, poller-brain#300 review
    // round 1: printed proposal previously omitted ":line" that the write
    // included).
    console.log(`  proposed pointer: ${marker} [${c.key}] → see ${c.file}:${c.line} — ${c.hook}`);
    console.log();
  }
}

/** Always printed, propose AND apply — a 0 must be visibly a measured 0, never inferred from silence (DevGuru catch, poller-brain#300 review round 2). */
function printParseSummary(result: {
  totalEntries: number;
  multiKeyEntries: number;
  alreadyPointer: number;
  candidates: LearningsTrimCandidate[];
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
  console.log(
    `index-shaped destination lines rejected as evidence: ${indexRejections.length} ` +
      `(pointer/lookup rows, not condensed narrative — excluded from citation search):`
  );
  for (const r of indexRejections) {
    console.log(`  ${r.key} @ ${r.file}:${r.line}  ${r.lineText.trim()}`);
  }
  console.log();
}

/**
 * Always printed, even when 0. Here the hook is the ONLY content that
 * survives a rewrite — an untrustworthy hook must never silently vanish
 * from the output (DevGuru catch, poller-brain#300 review round 3: live
 * data produced a hook that was literally the paragraph label
 * "How to apply:", and a wrapped-line fragment starting `> `).
 */
function printUnreliableHooks(unreliableHooks: UnreliableHook[]): void {
  if (unreliableHooks.length === 0) {
    console.log("keys excluded for an unreliable extracted hook: 0\n");
    return;
  }
  console.log(
    `keys excluded for an unreliable extracted hook: ${unreliableHooks.length} ` +
      `(cited, but the hook was too short or fragment-shaped to trust — not proposed):`
  );
  for (const u of unreliableHooks) {
    console.log(`  ${u.key} @ ${u.file}:${u.line}  hook="${u.hook}"  line: ${u.lineText.trim()}`);
  }
  console.log();
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const onlyKeys = parseOnlyFlag();

  if (apply && !onlyKeys) {
    console.error(
      "--apply requires --only <comma-separated keys> — there is no blind-trust-everything mode. " +
        "See the file header for why."
    );
    process.exit(1);
  }

  if (!fs.existsSync(LEARNINGS_PATH)) {
    console.log(`No LEARNINGS.md at ${LEARNINGS_PATH} — nothing to trim.`);
    return;
  }

  const learningsBefore = fs.readFileSync(LEARNINGS_PATH, "utf-8");
  const destinations = collectDestinations();
  const { candidates, totalEntries, multiKeyEntries, alreadyPointer, indexRejections, unreliableHooks } =
    findLearningsTrimCandidates(learningsBefore, destinations);

  if (!apply) {
    printParseSummary({ totalEntries, multiKeyEntries, alreadyPointer, candidates });
    printIndexRejections(indexRejections);
    printUnreliableHooks(unreliableHooks);

    // Stronger fail-safe than a bare "0 entries" check (DevGuru catch,
    // poller-brain#300 review round 2): 0 entries is only ALARMING when the
    // file is simultaneously (a) over the size cap this whole trim family
    // exists to relieve, AND (b) actually contains MEM- keys (so it's a
    // real memory file, not e.g. an empty/template LEARNINGS.md). Either
    // condition alone can be a legitimate 0 (a small clean file, or a cap-
    // exceeding file that's genuinely 0-entries-eligible for some other
    // reason); both together means the parser almost certainly doesn't
    // recognize this brain's entry format — the exact silent-no-op-forever
    // shape round 1 introduced.
    const overCap = Buffer.byteLength(learningsBefore) > LEARNINGS_CAP_BYTES;
    const hasMemKeys = HAS_MEM_KEY_RE.test(learningsBefore);
    if (totalEntries === 0 && overCap && hasMemKeys) {
      console.warn(
        `⚠️  0 entries parsed from a ${Buffer.byteLength(learningsBefore)}B LEARNINGS.md that is over the ` +
          `${LEARNINGS_CAP_BYTES}B cap and contains MEM- keys. This looks like an entry-format mismatch ` +
          `(only "### " and top-level "- " entry starts are recognized), NOT a confirmed-clean 0-candidates ` +
          `result — this brain's LEARNINGS.md convention may not be supported yet. Skipping.`
      );
      return;
    }
    if (candidates.length === 0) {
      console.log(
        `No promoted entries to propose (${alreadyPointer} already pointers out of ${totalEntries} entries, ` +
          `checked against ${destinations.length} destination file(s)). No-op.`
      );
      return;
    }
    printProposals(candidates);
    return;
  }

  printParseSummary({ totalEntries, multiKeyEntries, alreadyPointer, candidates });

  const byKey = groupCandidatesByKey(candidates);
  const toApply: LearningsTrimCandidate[] = [];
  const errors: string[] = [];
  for (const sel of onlyKeys!) {
    const forKey = byKey.get(sel.key) ?? [];
    if (sel.line === null) {
      if (forKey.length === 0) {
        errors.push(`${sel.key}: no trim candidate (not found, or already a pointer)`);
      } else if (forKey.length > 1) {
        errors.push(
          `${sel.key}: ${forKey.length} candidates (entryStartLine ${forKey
            .map((c) => c.entryStartLine)
            .join(", ")}) — ambiguous, a bare key is not enough. Use a span selector, ` +
            `e.g. --only ${sel.key}@${forKey[0].entryStartLine}`
        );
      } else {
        toApply.push(forKey[0]);
      }
    } else {
      const match = forKey.find((c) => c.entryStartLine === sel.line);
      if (!match) {
        errors.push(
          `${sel.key}@${sel.line}: no candidate at that entryStartLine — available: ` +
            `${forKey.map((c) => c.entryStartLine).join(", ") || "(none)"}`
        );
      } else {
        toApply.push(match);
      }
    }
  }
  if (errors.length > 0) {
    console.error(
      [`--only has unresolved selector(s):`, ...errors.map((e) => `  ${e}`), `Aborting — no write performed.`].join(
        "\n"
      )
    );
    process.exit(1);
  }

  const { learnings, stats } = applyLearningsTrimCandidates(learningsBefore, toApply);

  // Machine count-verify BEFORE writing — throws (→ exit 1) on any violation.
  const checks = verifyLearningsTrimStats(stats);

  fs.writeFileSync(LEARNINGS_PATH, learnings);

  console.log(
    [
      `LEARNINGS.md trim applied:`,
      `  trimmed:        ${stats.trimmedKeys.join(", ") || "(none)"}`,
      `  size:           ${stats.bytesBefore} → ${stats.bytesAfter} bytes`,
      ...checks.map((c) => `  verify: ${c}`),
    ].join("\n")
  );
}

main();
