/**
 * Rejected trim reviews only (#530). Discovery and apply stay authoritative.
 * Working state is pending until the normal consolidation final + report pair
 * completes. Never read approvals, drafts, or an older convenient completion.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { completedReport } from "../../../../scripts/consolidation-retry.mjs";
import { isMemId, MEM_ID_PATTERN } from "./mem-id.js";
import { learningsReviewSpans } from "./mem-learnings-trim-core.js";
import type { DestinationFile } from "./citation-detect.js";

export const REVIEW_POLICY_VERSION = "trim-rejection-v1";
export const REVIEW_STATE_PATH = "memory/.trim-review-state.json";
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => hash(JSON.stringify(value));
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const sources = ["memory/core/LEARNINGS.md", "memory/MEM_REGISTRY.md"] as const;
const destinationPath = (value: unknown): value is string => typeof value === "string" &&
  /^(core|semantic|episodic|procedural)\/.+\.md$/.test(value) &&
  !value.split("/").some(p => p === "." || p === "..") && !value.includes("\\");

export interface ReviewCandidate {
  key: string;
  file: string;
  line: number;
  lineText: string;
  hook: string;
  entryStartLine?: number;
  entryEndLine?: number;
}
export interface ReviewEvidence {
  source: string;
  key: string;
  entryDigest: string;
  entryStartLine: number;
  entryEndLine: number;
  ambiguous: boolean;
  destination: string;
  citingLine: number;
  citingText: string;
  hook: string;
  contextDigest: string;
  inventoryDigest: string;
  policyVersion: string;
  policyDigest: string;
}
export interface Rejection extends ReviewEvidence {
  id: string;
  verdict: "rejected";
  reason: string;
  reviewedAt: string;
}
interface Ledger { version: 1; rejections: Rejection[] }
export interface ReviewItem<T> { candidate: T; evidence: ReviewEvidence; id: string }

// Locations are navigation, not identity, except when identical spans have no
// unambiguous owner. Those records can be saved for audit but NEVER reused.
function reviewId(e: ReviewEvidence): string {
  const { entryStartLine, entryEndLine, ...identity } = e;
  return digest([identity, e.ambiguous ? [entryStartLine, entryEndLine] : null]);
}
function parseLedger(text: string): Ledger {
  const ledger = JSON.parse(text);
  if (ledger?.version !== 1 || !Array.isArray(ledger.rejections)) throw new Error("incompatible review state");
  const ids = new Set<string>();
  for (const e of ledger.rejections) {
    if (!e || !sources.includes(e.source) || !isMemId(e.key) || !sha(e.entryDigest) ||
        !positive(e.entryStartLine) || !positive(e.entryEndLine) || e.entryEndLine < e.entryStartLine ||
        typeof e.ambiguous !== "boolean" || !destinationPath(e.destination) || !positive(e.citingLine) ||
        typeof e.citingText !== "string" || !e.citingText.trim() || typeof e.hook !== "string" || !e.hook.trim() ||
        !sha(e.contextDigest) || !sha(e.inventoryDigest) || typeof e.policyVersion !== "string" ||
        !e.policyVersion || !sha(e.policyDigest) || e.verdict !== "rejected" ||
        typeof e.reason !== "string" || !e.reason.trim() || typeof e.reviewedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.reviewedAt) ||
        !Number.isFinite(Date.parse(e.reviewedAt)) || new Date(e.reviewedAt).toISOString() !== e.reviewedAt ||
        Date.parse(e.reviewedAt) > Date.now() || !sha(e.id) || ids.has(e.id)) throw new Error("invalid rejection record");
    // Select known evidence fields so added verdict/reason metadata cannot
    // affect the proposal fingerprint or sneak approval into the lookup.
    if (reviewId(evidenceFrom(e)) !== e.id) throw new Error("review identity mismatch");
    ids.add(e.id);
  }
  return ledger;
}
function evidenceFrom(e: ReviewEvidence): ReviewEvidence {
  return { source: e.source, key: e.key, entryDigest: e.entryDigest,
    entryStartLine: e.entryStartLine, entryEndLine: e.entryEndLine, ambiguous: e.ambiguous,
    destination: e.destination, citingLine: e.citingLine, citingText: e.citingText, hook: e.hook,
    contextDigest: e.contextDigest, inventoryDigest: e.inventoryDigest,
    policyVersion: e.policyVersion, policyDigest: e.policyDigest };
}

// One exact state path, no user-supplied output path, links or special files.
function statePath(root: string): string {
  let current = fs.realpathSync(root);
  for (const [index, part] of REVIEW_STATE_PATH.split("/").entries()) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || (index === 0 ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) {
        throw new Error("unsafe review-state path");
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return current;
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
}
// Only command metadata may be trimmed. Blob contents must retain the exact
// source text (including CRLF and trailing spaces) used by reviewItems.
function gitMetadata(root: string, ...args: string[]): string {
  return git(root, ...args).trimEnd();
}
// A record must have one continuous, unambiguous owner since it was saved.
// Checking just today's multiplicity would resurrect a unique-span verdict
// after an identical duplicate appeared in a completed cycle and disappeared.
// Inspect only commits affecting sources/state, stopping per record when its
// exact reviewed metadata changes (a fresh explicit review starts a new chain).
function continuousOwners(root: string, at: string, final: string, records: Rejection[]): Rejection[] {
  const active = new Map(records.map(e => [e.id, e]));
  const invalid = new Set<string>();
  const afterFinal = new Set(gitMetadata(root, "rev-list", "--first-parent", `${final}..${at}`).split("\n"));
  const history = gitMetadata(root, "log", "--first-parent", "--format=%H %P", at, "--", REVIEW_STATE_PATH, ...sources).split("\n");
  for (const line of history) {
    if (!active.size) break;
    const [commit, ...parents] = line.split(" ");
    let ledger: Ledger;
    try { ledger = parseLedger(git(root, "show", `${commit}:${REVIEW_STATE_PATH}`)); }
    catch { ledger = { version: 1, rejections: [] }; }
    for (const [id, e] of active) {
      if (!ledger.rejections.some(old => digest(old) === digest(e))) {
        if (afterFinal.has(commit)) invalid.add(id);
        active.delete(id);
      }
    }
    // Merged ownership cannot be proved by a first-parent path walk.
    if (parents.length > 1) {
      for (const id of active.keys()) invalid.add(id);
      break;
    }
    for (const source of sources) {
      const relevant = [...active.values()].filter(e => e.source === source);
      if (!relevant.length) continue;
      let text: string;
      try { text = git(root, "show", `${commit}:${source}`); }
      catch {
        // A removed source invalidates its own reviews, never unrelated owners.
        for (const e of relevant) { invalid.add(e.id); active.delete(e.id); }
        continue;
      }
      const lines = text.split("\n");
      const owners = source === "memory/core/LEARNINGS.md" ? learningsReviewSpans(text) :
        lines.flatMap((line, i) => {
          const key = line.match(new RegExp(String.raw`^\|\s*(${MEM_ID_PATTERN})\s*\|`))?.[1];
          return key ? [{ key, start: i + 1, end: i + 1 }] : [];
        });
      for (const e of relevant) {
        const sameKey = owners.filter(o => o.key === e.key);
        const matching = sameKey.filter(o => hash(lines.slice(o.start - 1, o.end).join("\n")) === e.entryDigest);
        if (matching.length !== 1 || (source === "memory/MEM_REGISTRY.md" && sameKey.length !== 1)) {
          invalid.add(e.id);
          active.delete(e.id);
        }
      }
    }
  }
  return records.filter(e => !invalid.has(e.id));
}

export function completedRejections(root: string, completedAt?: string): { records: Rejection[]; reference: string } {
  try {
    const file = statePath(root);
    try {
      fs.lstatSync(`${file}.lock`);
      throw new Error("interrupted review-state write");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE ||
        gitMetadata(root, "rev-parse", "--show-toplevel") !== fs.realpathSync(root)) throw new Error("uncertain brain Git root");
    // Missing/corrupt working state fails open even if history has a valid copy.
    const working = parseLedger(fs.readFileSync(file, "utf8"));
    const at = completedAt ?? gitMetadata(root, "rev-parse", "HEAD");
    const report = completedReport(root, at);
    const entry = gitMetadata(root, "ls-tree", report.final, "--", REVIEW_STATE_PATH);
    if (!/^100644 blob |^100755 blob /.test(entry)) throw new Error("completed review state unavailable");
    const completed = parseLedger(git(root, "show", `${report.final}:${REVIEW_STATE_PATH}`));
    // A working deletion/reconsideration cannot resurrect a historic record.
    const present = new Set(working.rejections.map(e => digest(e)));
    return { records: continuousOwners(root, at, report.final, completed.rejections.filter(e => !e.ambiguous && present.has(digest(e)))),
      reference: `${report.path}@${report.final}` };
  } catch { return { records: [], reference: "no valid completed review state" }; }
}

/** Full inventory intentionally invalidates even for a newly available alternate
 * citation that sorts after the selected one. No mtime/size shortcuts. */
export function reviewItems<T extends ReviewCandidate>(root: string, source: string, text: string, candidates: T[],
  destinations: DestinationFile[], policyVersion = REVIEW_POLICY_VERSION): ReviewItem<T>[] {
  if (!sources.includes(source as typeof sources[number])) throw new Error("unsupported trim source");
  // Fingerprint exact valid UTF-8 snapshots, not replacement-decoded bytes.
  // A concurrent change or uncertain encoding disables this optional cache.
  for (const [file, expected] of [[source, text], ...destinations.map(d => [`memory/${d.file}`, d.text])]) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (!Buffer.from(expected).equals(bytes)) throw new Error("review input changed or is not valid UTF-8");
  }
  const policyRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const policyFiles = ["CLAUDE.md", "MAINTENANCE.md", "scripts/consolidation-retry.mjs",
    "skills/memory/SKILL.md", "skills/memory/consolidate/SKILL.md",
    ...["mem-learnings-trim.ts", "mem-registry-trim.ts", "lib/trim-review-state.ts", "lib/mem-id.ts",
      "lib/brain-root.ts", "lib/citation-detect.ts", "lib/mem-learnings-trim-core.ts", "lib/mem-registry-trim-core.ts"]
      .map(p => `skills/memory/scripts/${p}`)];
  const policyDigest = digest([
    ...policyFiles.map(p => [p, hash(fs.readFileSync(path.join(policyRoot, p)))]),
    ...["CLAUDE.md", "MAINTENANCE.md"].map(p => ["brain:" + p,
      fs.existsSync(path.join(root, p)) ? hash(fs.readFileSync(path.join(root, p))) : "missing"]),
  ]);
  const inventoryDigest = digest(destinations.map(d => [d.file, hash(d.text)]));
  const lines = text.split("\n");
  const rows = new RegExp(String.raw`^\|\s*(${MEM_ID_PATTERN})\s*\|`);
  const rowLocations = new Map<string, number[]>();
  if (source === "memory/MEM_REGISTRY.md") {
    lines.forEach((line, i) => {
      const key = line.match(rows)?.[1];
      if (key) rowLocations.set(key, [...(rowLocations.get(key) ?? []), i + 1]);
    });
  }
  const evidence = candidates.map(c => {
    const rowLines = rowLocations.get(c.key) ?? [];
    const start = c.entryStartLine ?? (rowLines.length === 1 ? rowLines[0] : 0);
    const end = c.entryEndLine ?? start;
    const dest = destinations.filter(d => d.file === c.file);
    if (!positive(start) || !positive(end) || dest.length !== 1 || !destinationPath(c.file)) throw new Error("uncertain review evidence");
    return { source, key: c.key, entryDigest: hash(lines.slice(start - 1, end).join("\n")),
      entryStartLine: start, entryEndLine: end, ambiguous: false, destination: c.file,
      citingLine: c.line, citingText: c.lineText, hook: c.hook, contextDigest: hash(dest[0].text),
      inventoryDigest, policyVersion, policyDigest };
  });
  const counts = new Map<string, number>();
  for (const e of evidence) { const owner = digest([e.key, e.entryDigest]); counts.set(owner, (counts.get(owner) ?? 0) + 1); }
  return evidence.map((e, i) => {
    e.ambiguous = counts.get(digest([e.key, e.entryDigest]))! > 1;
    return { candidate: candidates[i], evidence: e, id: reviewId(e) };
  });
}

/** Atomic publish; a killed writer leaves a lock, forcing normal review until
 * inspected. The existing memory checkpoints/final commit persist this file. */
export function recordRejection(root: string, item: ReviewItem<ReviewCandidate>, reason: string): void {
  if (!reason.trim()) throw new Error("--reason must be non-empty");
  const file = statePath(root);
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  const temp = path.join(path.dirname(file), `.trim-review-state-${randomUUID()}.tmp`);
  try {
    let ledger: Ledger;
    try { ledger = parseLedger(fs.readFileSync(file, "utf8")); }
    catch { ledger = { version: 1, rejections: [] }; }
    const record: Rejection = { ...item.evidence, id: item.id, verdict: "rejected", reason: reason.trim(), reviewedAt: new Date().toISOString() };
    ledger.rejections = [...ledger.rejections.filter(e => e.id !== item.id), record];
    const bytes = JSON.stringify(ledger, null, 2) + "\n";
    parseLedger(bytes);
    const out = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(out, bytes); fs.fsyncSync(out); } finally { fs.closeSync(out); }
    statePath(root);
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function collectTrimDestinations(root: string, dirs: string[]): DestinationFile[] {
  const out: DestinationFile[] = [];
  function walk(rel: string): void {
    const abs = path.join(root, "memory", rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const file = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      // consolidation-history archives get a mandatory append every cycle (#516);
      // they are a log, never a trim destination, and must not churn the cache.
      else if (entry.name.endsWith(".md") && !/^episodic\/archive\/mistakes-.*\.md$/.test(file) &&
        !/^episodic\/archive\/consolidation-history-\d{4}-H[12]\.md$/.test(file) &&
        !/^episodic\/consolidation-progress-\d{4}-\d\d-\d\d\.md$/.test(file)) {
        out.push({ file, text: fs.readFileSync(path.join(abs, entry.name), "utf8") });
      }
    }
  }
  for (const dir of dirs) walk(dir);
  return out;
}

/** Propose only. Failures in optional bookkeeping always expose normal review.
 * --reject uses the printed fingerprint, never a bare MEM key or stale line. */
export function reviewProposals<T extends ReviewCandidate>(root: string, source: string, text: string,
  candidates: T[], destinations: DestinationFile[]): T[] | null {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--") || args.lastIndexOf(flag) !== index) throw new Error(`invalid ${flag}`);
    return args[index + 1];
  };
  const reject = value("--reject");
  const reason = value("--reason");
  const completedAt = value("--completed-at");
  if (reason !== undefined && reject === undefined) throw new Error("--reason requires --reject");
  let items: ReviewItem<T>[];
  try { items = reviewItems(root, source, text, candidates, destinations); }
  catch (e) {
    if (reject) throw e;
    console.log("previously rejected, unchanged: 0 (review fingerprint unavailable; review normally)");
    return candidates;
  }
  if (reject !== undefined) {
    if (args.includes("--only") || !sha(reject) || !reason?.trim()) throw new Error("record with --reject <review-ref> --reason <explanation>; no --only");
    const matches = items.filter(i => i.id === reject);
    if (matches.length !== 1) throw new Error("review-ref no longer identifies exactly one current proposal; rerun and review");
    recordRejection(root, matches[0], reason);
    console.log(`Recorded explicit rejection ${reject} in ${REVIEW_STATE_PATH}; pending completed consolidation + report pair.`);
    return null;
  }
  const completed = args.includes("--reconsider") ? { records: [], reference: "explicit reconsideration" } : completedRejections(root, completedAt);
  const hits = items.filter(i => !i.evidence.ambiguous && completed.records.some(e => !e.ambiguous && e.id === i.id));
  console.log(`previously rejected, unchanged: ${hits.length}`);
  for (const i of hits) {
    const record = completed.records.find(e => e.id === i.id)!;
    console.log(`  ${i.candidate.key}@${i.evidence.entryStartLine}: ${REVIEW_STATE_PATH}#${i.id} — ${JSON.stringify(record.reason)} (${record.reviewedAt}; ${completed.reference})`);
  }
  const pending = items.filter(i => !hits.includes(i));
  for (const i of pending) console.log(`review-ref ${i.candidate.key}@${i.evidence.entryStartLine}: ${i.id}`);
  return pending.map(i => i.candidate);
}

export function checkReviewApplyFlags(): void {
  if (process.argv.includes("--apply") && ["--reject", "--reason", "--reconsider", "--completed-at"].some(f => process.argv.includes(f))) {
    throw new Error("review-state flags are propose-only; apply requires its own explicit --only approval");
  }
}
