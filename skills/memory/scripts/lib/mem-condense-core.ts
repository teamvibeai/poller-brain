/** Bounded relocation planning (#530). Pure; never infers approval from a ledger.
 * New dedicated tier files only. Linked/grouped narrative needs a separate review.
 */
import { distinctCitedKeysInLine } from "./citation-detect.js";
import { MEM_ID_PATTERN, isMemId } from "./mem-id.js";
import { learningsReviewSpans, findLearningsTrimCandidates, applyLearningsTrimCandidates,
  verifyLearningsTrimStats, pointerFor, type LearningsTrimCandidate, countLearningsEntries } from "./mem-learnings-trim-core.js";
import { parseRegistryCells, isPointerDescription, findTrimCandidates, applyTrimCandidates,
  verifyTrimStats } from "./mem-registry-trim-core.js";
import { evaluate, evaluateRegistry, LEARNINGS_OVERHEAD_BYTES, LEARNINGS_PER_ENTRY_BYTES } from "./mem-scaled-threshold-core.js";

export type Mode = "learnings" | "registry";
export const sources = { learnings: "memory/core/LEARNINGS.md", registry: "memory/MEM_REGISTRY.md" };
export const MAX_TOPIC_BYTES = 8192;
export const isCondensationDestination = (file: unknown): file is string => typeof file === "string" &&
  /^(semantic|procedural|episodic)\/[A-Za-z0-9_-]+\.md$/.test(file) &&
  !/^episodic\/consolidation-(?:progress|history)-/.test(file);
export const measure = (mode: Mode, text: string) => {
  const result = mode === "registry" ? evaluateRegistry(text) :
    evaluate(text, countLearningsEntries(text), LEARNINGS_OVERHEAD_BYTES, LEARNINGS_PER_ENTRY_BYTES);
  return { ...result, overage: Math.max(0, result.sizeBytes - result.threshold) };
};
export interface Topic { key: string; start: number; end: number; original: string; description?: string }
export interface CondensationOptions { rule: string; destination?: string }
export const condensationDestination = (topic: Topic, options: CondensationOptions) =>
  options.destination ?? `semantic/condensation-${topic.key.toLowerCase()}.md`;
function learningsCandidate(topic: Topic, options: CondensationOptions): LearningsTrimCandidate {
  return { key: topic.key, format: topic.original.startsWith("-") ? "bullet" : "heading",
    entryStartLine: topic.start, entryEndLine: topic.end, file: condensationDestination(topic, options), line: 3,
    lineText: `[${topic.key}] ${options.rule}`, hook: options.rule };
}
function pointerText(mode: Mode, topic: Topic, options: CondensationOptions): string {
  const candidate = learningsCandidate(topic, options);
  return mode === "learnings" ? pointerFor(topic.original, candidate) :
    applyTrimCandidates(topic.original, [candidate]).registry;
}
function usesExternalReference(lines: string[], topic: Topic): boolean {
  // Conservative label scan, including bracketed prose/code and definitions in
  // containers. Do not move/copy definitions or assume a renderer's context.
  const normalize = (label: string) => label.replace(/\\(.)/g, "$1").trim().replace(/\s+/gu, " ").toUpperCase();
  const external = new Set<string>();
  for (const outside of [lines.slice(0, topic.start - 1), lines.slice(topic.end)]) {
    for (const match of outside.join("\n").matchAll(/\[((?:\\[\s\S]|[^\[\]\\])+)\]:/g)) external.add(normalize(match[1]));
  }
  // The second label catches full references; the first catches collapsed and
  // shortcut references. A bare [MEM-ID] is harmless without a definition.
  return [...topic.original.matchAll(/\[((?:\\[\s\S]|[^\[\]\\])+)\]/g)].some(m => external.has(normalize(m[1])));
}
export function selectTopic(mode: Mode, text: string, options: CondensationOptions): { topic: Topic | null; refusals: string[] } {
  const lines = text.split("\n");
  const refusals: string[] = [];
  let topics: Topic[];
  if (mode === "learnings") {
    const parsed = findLearningsTrimCandidates(text, []);
    if (parsed.multiKeyEntries) refusals.push(`multi-key/grouped learnings refused: ${parsed.multiKeyEntries}`);
    refusals.push(...parsed.skippedEntries.map(e => `unsupported span ${e.entryStartLine}: ${e.reason}`));
    topics = learningsReviewSpans(text).map(t => ({ ...t, original: lines.slice(t.start - 1, t.end).join("\n") }));
  } else {
    topics = lines.flatMap((line, i) => {
      const key = line.match(new RegExp(String.raw`^\|\s*(${MEM_ID_PATTERN})\s*\|`))?.[1];
      if (!key) return [];
      const cells = parseRegistryCells(line);
      if (!cells) { refusals.push(`malformed registry row: ${key}`); return []; }
      const description = cells[cells.length - 2].trim();
      if (isPointerDescription(description)) return [];
      const keys = distinctCitedKeysInLine(line);
      if (keys.length !== 1) { refusals.push(`multi-key registry row refused: ${key}`); return []; }
      return [{ key, start: i + 1, end: i + 1, original: line, description }];
    });
  }
  const eligible = topics.filter(t => {
    const occurrences = mode === "registry" ? lines.filter(l => l.match(new RegExp(String.raw`^\|\s*${t.key}\s*\|`))).length :
      (distinctCitedKeysInLine([...lines.slice(0, t.start - 1), ...lines.slice(t.end)].join("\n")).includes(t.key) ? 2 : 1);
    const reason = occurrences !== 1 ? "duplicate key" : Buffer.byteLength(t.original) > MAX_TOPIC_BYTES ? "topic exceeds 8192B bound" :
      /\.md\b|\]\(|\[\[|href\s*=/i.test(t.original) ? "linked narrative needs separate pointer review" :
      usesExternalReference(lines, t) ? "reference link definition outside topic needs separate pointer review" :
      Buffer.byteLength(pointerText(mode, t, options)) >= Buffer.byteLength(t.original) ? "pointer cannot shrink topic" : null;
    if (reason) refusals.push(`${t.key}: ${reason}`);
    return !reason;
  });
  eligible.sort((a, b) => Buffer.byteLength(a.original) - Buffer.byteLength(b.original) || a.start - b.start);
  return { topic: eligible[0] ?? null, refusals };
}
export function buildCondensation(mode: Mode, before: string, topic: Topic, options: CondensationOptions) {
  const destination = condensationDestination(topic, options), { rule } = options;
  if (!isMemId(topic.key) || !isCondensationDestination(destination)) throw new Error("unsafe destination; use a new dedicated tier file");
  if (rule !== rule.trim() || Buffer.byteLength(rule) < 20 || Buffer.byteLength(rule) > 240 ||
      /[\x00-\x1f\x7f|<>\[\]`#]|\.md\b|\bMEM-/i.test(rule)) throw new Error("provide one actionable rule, 20–240B, without links, MEM IDs or markup");
  const selected = selectTopic(mode, before, options).topic;
  if (!selected || JSON.stringify(selected) !== JSON.stringify(topic)) throw new Error("topic is stale or is not the one bounded selection");
  const pre = measure(mode, before);
  if (!pre.overCap) throw new Error("source is under its scaled cap; fallback not needed");
  // Complete original bytes plus provenance survive. Registry coverage gets its
  // own complete Description line; the raw row also preserves every audit cell.
  const destinationText = `# Condensed memory\n\n[${topic.key}] ${rule}\n\n` +
    (mode === "registry" ? `${topic.description}\n\nOriginal registry row (verbatim):\n${topic.original}\n` : topic.original + "\n");
  let after: string;
  if (mode === "registry") {
    // Re-run #505 on the selected destination, never synthesize covered status.
    const found = findTrimCandidates(before, [{ file: destination, text: destinationText }]);
    const candidate = found.candidates.find(c => c.key === topic.key);
    if (!candidate || found.contentCoverage.find(c => c.key === topic.key)?.status !== "covered") throw new Error("#505 coverage/citation guard rejected relocation");
    const result = applyTrimCandidates(before, [{ ...candidate, hook: rule }]);
    verifyTrimStats(result.stats);
    after = result.registry;
    const oldCells = parseRegistryCells(topic.original)!;
    const newCells = parseRegistryCells(after.split("\n")[topic.start - 1])!;
    if ([1, 2, 3].some(i => oldCells[i] !== newCells[i])) throw new Error("registry lifecycle cells changed");
  } else {
    const candidate = learningsCandidate(topic, options);
    const result = applyLearningsTrimCandidates(before, [candidate]);
    verifyLearningsTrimStats(result.stats);
    after = result.learnings;
  }
  const beforeLines = before.split("\n"), afterLines = after.split("\n");
  if (beforeLines.slice(0, topic.start - 1).join("\n") !== afterLines.slice(0, topic.start - 1).join("\n") ||
      beforeLines.slice(topic.end).join("\n") !== afterLines.slice(topic.start).join("\n")) throw new Error("non-target bytes changed");
  const post = measure(mode, after);
  if (post.sizeBytes >= pre.sizeBytes || post.overage >= pre.overage) throw new Error("unsafe/no-shrink relocation; keep over-cap warning");
  if (!destinationText.includes(topic.original) || !destinationText.split("\n")[2].includes(`[${topic.key}]`)) throw new Error("narrative or pointer target missing");
  const pointer = afterLines[topic.start - 1];
  if (!pointer.includes(destination) || !pointer.includes(rule) || !pointer.includes(topic.key)) throw new Error("unresolvable hot-path pointer");
  return { after, destinationText, before: pre, afterMetrics: post };
}
