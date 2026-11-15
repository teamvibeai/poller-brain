#!/usr/bin/env npx tsx
/** #530 fallback. Propose one small topic in scratch; apply only a reviewed plan.
 * Propose: --mode learnings|registry --scratch /outside/brain --rule 'Action with conditions and exceptions' [--destination semantic/topic.md]
 * Status after normal paths: --mode ... --status --before-bytes N [--completed-at START_HEAD]
 * Apply: --apply --plan /scratch/plan.json --only MEM-ID@line --cycle-date YYYY-MM-DD
 * A new dedicated destination avoids changing other topics or introducing cycles.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBrainRoot } from "./lib/brain-root.js";
import { buildCondensation, selectTopic, measure, sources, isCondensationDestination, type Mode } from "./lib/mem-condense-core.js";
import { collectTrimDestinations, reviewItems, completedRejections } from "./lib/trim-review-state.js";
import { findTrimCandidates } from "./lib/mem-registry-trim-core.js";
import { findLearningsTrimCandidates } from "./lib/mem-learnings-trim-core.js";
import { printExhaustion } from "./lib/trim-exhaustion.js";
const args = process.argv.slice(2);
const allowed = new Set(["--mode", "--scratch", "--rule", "--destination", "--status", "--exhausted", "--before-bytes", "--completed-at", "--apply", "--plan", "--only", "--cycle-date"]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i]) || args.indexOf(args[i]) !== i) throw new Error(`unknown or repeated flag: ${args[i]}`);
  if (!["--apply", "--status", "--exhausted"].includes(args[i])) {
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`missing value: ${args[i]}`);
    i++;
  }
}
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const root = fs.realpathSync(resolveBrainRoot());
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
// Refuse links/special files at every component. Read exact UTF-8, never replacement decoding.
function safeMemory(file: string): string | null {
  let current = root;
  const parts = file.split("/");
  for (const [i, part] of parts.entries()) {
    if (!part || part === "." || part === ".." || part.includes("\\")) throw new Error("unsafe memory path");
    current = path.join(current, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(current); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) throw new Error("unsafe memory path component");
  }
  const bytes = fs.readFileSync(current), text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("invalid UTF-8 memory");
  return text;
}
function corpusBytes(dir = "memory"): number {
  let total = 0;
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("corpus contains symlink; cannot measure safely");
    if (entry.isDirectory()) total += corpusBytes(rel);
    else if (entry.isFile() && entry.name.endsWith(".md")) total += Buffer.byteLength(safeMemory(rel)!);
  }
  return total;
}
function reviewStatus(mode: Mode, before: string) {
  const destinations = collectTrimDestinations(root, mode === "learnings" ? ["semantic", "episodic", "procedural"] : ["core", "semantic", "episodic", "procedural"]);
  const candidates = mode === "learnings" ? findLearningsTrimCandidates(before, destinations).candidates : findTrimCandidates(before, destinations).candidates;
  try {
    const items = reviewItems(root, sources[mode], before, candidates, destinations);
    const completed = completedRejections(root, value("--completed-at"));
    const hits = items.filter(i => !i.evidence.ambiguous && completed.records.some(r => r.id === i.id));
    return { unchanged: hits.length, pending: candidates.length - hits.length };
  } catch { return { unchanged: 0, pending: candidates.length }; }
}
function budgetUsed(): boolean {
  const markerPath = path.resolve(root, git("rev-parse", "--git-path", "consolidation-start"));
  if (!fs.existsSync(markerPath)) return false;
  const marker = fs.readFileSync(markerPath, "utf8").trim().split(" ");
  if (marker.length !== 3 || marker[0] !== "v1" || !/^[a-f0-9]{40,64}$/.test(marker[2])) throw new Error("invalid active cycle marker");
  return /— step (?:5d|9e) condensation$/m.test(git("log", "--first-parent", "--format=%s", `${marker[2]}..HEAD`));
}
function main() {
  const apply = args.includes("--apply");
  if (apply && args.some(a => ["--mode", "--scratch", "--rule", "--destination", "--status", "--exhausted", "--before-bytes", "--completed-at"].includes(a))) throw new Error("apply accepts only --plan, --only and --cycle-date; cache never approves apply");
  if (!apply && args.some(a => ["--plan", "--only", "--cycle-date"].includes(a))) throw new Error("approval flags require --apply");
  const plan = apply ? JSON.parse(fs.readFileSync(value("--plan") ?? "", "utf8")) : null;
  const mode: Mode = plan?.mode ?? value("--mode");
  if (mode !== "learnings" && mode !== "registry") throw new Error("--mode learnings|registry required");
  const source = sources[mode], before = safeMemory(source);
  if (before === null) throw new Error("missing hot-path source");
  const status = reviewStatus(mode, before);
  const beforeBytes = value("--before-bytes") === undefined ? Buffer.byteLength(before) : Number(value("--before-bytes"));
  if (!Number.isSafeInteger(beforeBytes) || beforeBytes < 0) throw new Error("invalid --before-bytes");
  printExhaustion(root, mode, before, status.unchanged, args.includes("--exhausted") ? 0 : status.pending, { beforeBytes, completedAt: value("--completed-at") });
  console.log(`hot-path bytes: ${Buffer.byteLength(before)}; total corpus bytes (all memory/**/*.md): ${corpusBytes()}`);
  if (args.includes("--status")) return;
  if (!apply && budgetUsed()) { console.log("One-topic condensation budget already used this cycle; no further proposal. Keep any over-cap warning."); return; }
  const { topic, refusals } = selectTopic(mode, before);
  for (const refusal of refusals) console.log(`refused: ${refusal}`);
  if (!topic) {
    if (apply) throw new Error("no safe bounded topic to apply; proposal is stale or unsupported");
    console.log("No safe bounded topic; nothing changed. Keep the over-cap warning."); return;
  }
  if (!apply && status.pending && !args.includes("--exhausted")) throw new Error("normal trim proposals still need review; finish Steps 5d/9e first, then assert --exhausted after explicit review");
  const destination = apply ? plan.destination : value("--destination") ?? `semantic/condensation-${topic.key.toLowerCase()}.md`;
  // Validate path grammar before any filesystem access to the proposed destination.
  if (!isCondensationDestination(destination)) throw new Error("unsafe destination");
  if (safeMemory(`memory/${destination}`) !== null) throw new Error("destination must be a new dedicated file");
  const rule = apply ? plan.rule : value("--rule") ?? "";
  const result = buildCondensation(mode, before, topic, destination, rule);
  const baseline = git("rev-parse", "HEAD");
  const corpusBefore = corpusBytes();
  const metrics = { hotPathBefore: result.before, hotPathAfter: result.afterMetrics,
    corpusBefore, corpusAfter: corpusBefore - Buffer.byteLength(before) + Buffer.byteLength(result.after) + Buffer.byteLength(result.destinationText) };
  const prepared = { version: 1, mode, baseline, source, sourceDigest: hash(before), topic, destination, rule,
    sourceAfter: result.after, destinationText: result.destinationText, metrics };
  if (!apply) {
    if (!value("--scratch")) throw new Error("--scratch required (outside the brain)");
    const scratch = path.resolve(value("--scratch")!);
    let parent = scratch;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const canonicalParent = fs.realpathSync(parent);
    if (canonicalParent === root || canonicalParent.startsWith(root + path.sep) || fs.lstatSync(parent).isSymbolicLink()) throw new Error("scratch must be outside the brain and not a symlink");
    fs.mkdirSync(scratch, { recursive: true });
    if (fs.readdirSync(scratch).length) throw new Error("scratch must be a new empty directory outside the brain");
    for (const [name, text] of [["plan.json", JSON.stringify(prepared, null, 2) + "\n"], ["source.md", result.after], ["destination.md", result.destinationText]]) fs.writeFileSync(path.join(scratch, name), text, { flag: "wx" });
    console.log(JSON.stringify(metrics, null, 2));
    console.log(`One proposal: ${topic.key}@${topic.start} → ${destination}:3\nRule: ${rule}\nReview plan.json, source.md and destination.md together, including every condition/exception. Nothing applied.`);
    console.log(`Apply explicitly: mem-condense.ts --apply --plan ${path.join(scratch, "plan.json")} --only ${topic.key}@${topic.start} --cycle-date YYYY-MM-DD`);
    return;
  }
  const planDir = path.dirname(path.resolve(value("--plan")!));
  if (fs.readFileSync(path.join(planDir, "source.md"), "utf8") !== result.after ||
      fs.readFileSync(path.join(planDir, "destination.md"), "utf8") !== result.destinationText) throw new Error("scratch previews differ from validated plan; repropose and review");
  if (JSON.stringify(plan) !== JSON.stringify(prepared)) throw new Error("stale or altered plan; repropose and review");
  if (value("--only") !== `${topic.key}@${topic.start}` || !/^\d{4}-\d\d-\d\d$/.test(value("--cycle-date") ?? "")) throw new Error("apply requires exact --only MEM-ID@line and --cycle-date");
  // One accepted relocation across both hot files in the durable cycle. This is
  // a limit, never approval. The transaction rechecks baseline and both files.
  const markerPath = path.resolve(root, git("rev-parse", "--git-path", "consolidation-start"));
  const marker = fs.readFileSync(markerPath, "utf8").trim().split(" ");
  if (marker.length !== 3 || marker[0] !== "v1" || marker[1] !== value("--cycle-date")) throw new Error("active cycle marker required");
  if (/— step (?:5d|9e) condensation$/m.test(git("log", "--first-parent", "--format=%s", `${marker[2]}..HEAD`))) throw new Error("one-topic condensation budget already used this cycle");
  const manifest = { version: 1, baseline, validation: { alarms: [] }, mutations: [
    { op: "write", path: source, before: hash(before), content: result.after },
    { op: "write", path: `memory/${destination}`, before: null, content: result.destinationText },
  ] };
  const transaction = fileURLToPath(new URL("../../../scripts/consolidation-apply.sh", import.meta.url));
  const submitted = spawnSync("bash", [transaction, root, value("--cycle-date")!, `step ${mode === "learnings" ? "5d" : "9e"} condensation`], { input: JSON.stringify(manifest), encoding: "utf8", env: process.env });
  if (submitted.status !== 0) throw new Error(submitted.stdout + submitted.stderr);
  console.log(submitted.stdout.trim());
  console.log(JSON.stringify(metrics, null, 2));
  if (measure(mode, result.after).overCap) console.log("⚠️ Still over cap; keep the warning. One-topic budget exhausted for this cycle.");
}
try { main(); } catch (e) { console.error(`${(e as Error).message}\nNo safe completed condensation; keep any over-cap warning and inspect transaction errors before retrying.`); process.exitCode = 1; }
