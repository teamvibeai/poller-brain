#!/usr/bin/env npx tsx
/**
 * Compute the row/entry-count-scaled byte threshold for MEM_REGISTRY.md or
 * LEARNINGS.md and report whether the file is currently over it.
 * See lib/mem-scaled-threshold-core.ts for the rationale
 * (poller-brain#324, poller-brain#300).
 *
 * Read-only — never writes. Used by consolidate skill.md Step 5c (preflight)
 * and Step 9b (Memory Metrics table) in place of the old flat "wc -c vs
 * 5000" check for these two files.
 *
 * Usage:
 *   npx tsx mem-scaled-threshold.ts --mode registry   # memory/MEM_REGISTRY.md
 *   npx tsx mem-scaled-threshold.ts --mode learnings  # memory/core/LEARNINGS.md
 */

import * as fs from "fs";
import { brainPath } from "./lib/brain-root.js";
import { countLearningsEntries } from "./lib/mem-learnings-trim-core.js";
import {
  countRegistryRows,
  evaluate,
  BASE_FLOOR_BYTES,
  LEARNINGS_OVERHEAD_BYTES,
  LEARNINGS_PER_ENTRY_BYTES,
  REGISTRY_OVERHEAD_BYTES,
  REGISTRY_PER_ROW_BYTES,
} from "./lib/mem-scaled-threshold-core.js";

const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : null;

if (mode !== "registry" && mode !== "learnings") {
  console.error('Usage: mem-scaled-threshold.ts --mode registry|learnings');
  process.exit(1);
}

const filePath =
  mode === "registry"
    ? brainPath("memory/MEM_REGISTRY.md")
    : brainPath("memory/core/LEARNINGS.md");
const label = mode === "registry" ? "MEM_REGISTRY.md" : "LEARNINGS.md";

if (!fs.existsSync(filePath)) {
  const result = { sizeBytes: 0, entryCount: 0, threshold: BASE_FLOOR_BYTES, overCap: false };
  console.log(`${label}: does not exist — skip.`);
  console.log(JSON.stringify(result));
  process.exit(0);
}

const text = fs.readFileSync(filePath, "utf-8");
const entryCount = mode === "registry" ? countRegistryRows(text) : countLearningsEntries(text);
const [overhead, perEntry] =
  mode === "registry"
    ? [REGISTRY_OVERHEAD_BYTES, REGISTRY_PER_ROW_BYTES]
    : [LEARNINGS_OVERHEAD_BYTES, LEARNINGS_PER_ENTRY_BYTES];
const result = evaluate(text, entryCount, overhead, perEntry);
const noun = mode === "registry" ? "rows" : "entries";

console.log(`${label}: ${result.sizeBytes}B, ${result.entryCount} ${noun}, threshold ${result.threshold}B ` +
  `(= max(5000, ${overhead} + ${result.entryCount}*${perEntry})) — ${result.overCap ? "OVER CAP ⚠️" : "OK ✅"}`);
console.log(JSON.stringify(result));
