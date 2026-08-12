#!/usr/bin/env npx tsx
/**
 * Propose (or, given an explicit approved key list, apply) MEM_REGISTRY.md
 * pointer rewrites for rows already promoted into consolidated prose
 * (core/semantic/episodic/procedural). Leaves Key/Status/Created untouched
 * and all not-yet-promoted rows as-is. See lib/mem-registry-trim-core.ts
 * for the invariants and the false-positive history behind this design.
 *
 * DEFAULT MODE IS PROPOSE-ONLY — it never writes MEM_REGISTRY.md. Content-
 * based citation detection went through three adversarial review rounds
 * with DevGuru and still surfaced a new false-positive shape each time
 * (poller-brain#244); "a destination file cites this key" is evidence
 * worth a human's attention, not proof strong enough to auto-write for
 * historical backfill. Each candidate prints its FULL citing line (not
 * just the extracted hook) so a reviewer can judge it without opening the
 * destination file.
 *
 * Applying is a separate, explicit, opt-in step — pass the exact keys you
 * (or DevGuru, or whoever reviewed the proposal) have approved:
 *   npx tsx mem-registry-trim.ts --apply --only MEM-99,MEM-104
 *
 * There is no "--apply --all" / blind-trust-everything mode on purpose.
 * The one case where immediate auto-write IS appropriate is a FRESH
 * same-day promotion the consolidate skill just wrote and grep-verified
 * itself (Step 1b/4) — in that case the caller already knows the exact
 * key/file/line with certainty (no scanning/ambiguity involved), so it can
 * pass `--apply --only <that key>` right after verifying, without needing
 * a human review pass. See skill.md Step 9e for both usage patterns.
 *
 * Idempotent: re-running --apply with a key that's already a pointer is a
 * no-op for that key. Count-verified: aborts (exit 1) on any invariant
 * break — no silent drop.
 *
 * Usage:
 *   npx tsx mem-registry-trim.ts                          # propose: list candidates, write nothing
 *   npx tsx mem-registry-trim.ts --apply --only MEM-1,MEM-5  # apply exactly these approved keys
 */

import * as fs from "fs";
import * as path from "path";
import { brainPath } from "./lib/brain-root.js";
import {
  findTrimCandidates,
  applyTrimCandidates,
  verifyTrimStats,
  type DestinationFile,
  type TrimCandidate,
  type IndexRejection,
  type UnreliableHook,
} from "./lib/mem-registry-trim-core.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
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

function printProposals(candidates: TrimCandidate[]): void {
  console.log(`${candidates.length} trim candidate(s) found. Nothing written — review, then apply with:`);
  console.log(`  npx tsx mem-registry-trim.ts --apply --only ${candidates.map((c) => c.key).join(",") || "<keys>"}`);
  console.log("(or a hand-picked subset of the keys below)\n");
  for (const c of candidates) {
    console.log(`${c.key} → ${c.file}:${c.line}`);
    console.log(`  citing line:      ${c.lineText.trim()}`);
    console.log(`  proposed pointer: see ${c.file} — ${c.hook}`);
    console.log();
  }
}

/**
 * Always printed, even when 0 — a silently narrowed scan (destinations
 * skipped as index-shaped) must never read as "nothing was there" (DevGuru
 * catch, poller-brain#300 review round 2).
 */
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
 * Always printed, even when 0 — a key with a real citation but an
 * untrustworthy hook must never silently vanish from the output (DevGuru
 * catch, poller-brain#300 review round 3: live data produced a hook that
 * was literally the paragraph label "How to apply:", and a wrapped-line
 * fragment starting `> `).
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

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.log(`No MEM_REGISTRY.md at ${REGISTRY_PATH} — nothing to trim.`);
    return;
  }

  const registryBefore = fs.readFileSync(REGISTRY_PATH, "utf-8");
  const destinations = collectDestinations();
  const { candidates, totalDataRows, alreadyPointer, indexRejections, unreliableHooks } = findTrimCandidates(
    registryBefore,
    destinations
  );

  if (!apply) {
    printIndexRejections(indexRejections);
    printUnreliableHooks(unreliableHooks);
    if (candidates.length === 0) {
      console.log(
        `No promoted rows to propose (${alreadyPointer} already pointers out of ${totalDataRows} data rows, ` +
          `checked against ${destinations.length} destination file(s)). No-op.`
      );
      return;
    }
    printProposals(candidates);
    return;
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
  const { registry, stats } = applyTrimCandidates(registryBefore, toApply);

  // Machine count-verify BEFORE writing — throws (→ exit 1) on any violation.
  const checks = verifyTrimStats(stats);

  fs.writeFileSync(REGISTRY_PATH, registry);

  console.log(
    [
      `MEM_REGISTRY trim applied:`,
      `  trimmed:        ${stats.trimmedKeys.join(", ") || "(none)"}`,
      `  registry size:  ${stats.bytesBefore} → ${stats.bytesAfter} bytes`,
      ...checks.map((c) => `  verify: ${c}`),
    ].join("\n")
  );
}

main();
