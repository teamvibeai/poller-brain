#!/usr/bin/env npx tsx
/**
 * Create a new tracked MEM key entry.
 *
 * Atomically writes to both memory/TODAY.md and memory/MEM_REGISTRY.md
 * with the next sequential number. Prevents malformed keys like [MEM-feedback].
 *
 * Usage:
 *   npx tsx mem-write.ts "category: detail"
 *   npx tsx mem-write.ts "deploy: staging vyžaduje SSO login"
 *   npx tsx mem-write.ts "komunikace: mužský rod, vždy česky"
 *
 * Output:
 *   Written [MEM-4] to memory/TODAY.md and memory/MEM_REGISTRY.md
 */

import * as fs from "fs";
import { brainPath } from "./lib/brain-root.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
const ARCHIVE_PATH = brainPath("memory/MEM_REGISTRY_ARCHIVE.md");
const TODAY_PATH = brainPath("memory/TODAY.md");

const REGISTRY_HEADER = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
`;

function scanMaxKey(filePath: string, pattern: RegExp): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = content.matchAll(pattern);
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function getNextKey(): number {
  // REGISTRY rows are pipe-tabled (`| MEM-N | ACTIVE | ...`) and have no prose drift risk — full scan is safe and acts as defense-in-depth.
  const fromRegistry = scanMaxKey(REGISTRY_PATH, /MEM-(\d+)/g);
  // MEM_REGISTRY_ARCHIVE.md holds REMOVED rows relocated out of the live registry
  // (see mem-registry-archive.ts). If the highest-numbered key was REMOVED and
  // archived, it no longer appears as a table row in the live registry — scan the
  // archive too so the counter never reuses an archived number.
  const fromArchive = scanMaxKey(ARCHIVE_PATH, /MEM-(\d+)/g);
  // TODAY.md mixes canonical write rows with prose mentions (e.g. review summaries). Restrict to anchored canonical rows: `- [MEM-N] ...`. Permit whitespace or colon after `]` for forward-compat with format drift.
  const fromToday = scanMaxKey(TODAY_PATH, /^- \[MEM-(\d+)\][\s:\]]/gm);
  return Math.max(fromRegistry, fromArchive, fromToday) + 1;
}

function ensureRegistry(): void {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, REGISTRY_HEADER);
  }
}

function ensureToday(): void {
  if (!fs.existsSync(TODAY_PATH)) {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(TODAY_PATH, `# ${today}\n\n`);
  }
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const content = process.argv.slice(2).join(" ").trim();

  if (!content) {
    console.error("Usage: npx tsx mem-write.ts \"category: detail\"");
    console.error("");
    console.error("Examples:");
    console.error('  npx tsx mem-write.ts "deploy: staging vyžaduje SSO login"');
    console.error('  npx tsx mem-write.ts "komunikace: mužský rod, vždy česky"');
    process.exit(1);
  }

  ensureRegistry();
  ensureToday();

  const key = getNextKey();
  const today = getToday();

  // Escape pipes (markdown table separator) and collapse newlines; keep full content per #150
  const desc = content.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

  // Append to TODAY.md
  fs.appendFileSync(TODAY_PATH, `- [MEM-${key}] ${content}\n`);

  // Append to MEM_REGISTRY.md — detect 4 vs 5 column format
  const registry = fs.readFileSync(REGISTRY_PATH, "utf-8");
  const headerLine = registry.split("\n").find((l) => l.startsWith("|") && /Key/.test(l));
  const colCount = headerLine ? headerLine.split("|").filter((c) => c.trim()).length : 5;
  const row =
    colCount <= 4
      ? `| MEM-${key} | ACTIVE | ${today} | ${desc} |`
      : `| MEM-${key} | ACTIVE | ${today} | — | ${desc} |`;
  fs.appendFileSync(REGISTRY_PATH, row + "\n");

  console.log(`Written [MEM-${key}] to ${TODAY_PATH} and ${REGISTRY_PATH}`);
}

main();
