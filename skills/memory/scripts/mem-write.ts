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
import { getNextKeyFromContents, truncateRegistryDescription } from "./lib/mem-write-core.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
const ARCHIVE_PATH = brainPath("memory/MEM_REGISTRY_ARCHIVE.md");
const TODAY_PATH = brainPath("memory/TODAY.md");

const REGISTRY_HEADER = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
`;

function readOrEmpty(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

// Scan/precedence rules live in lib/mem-write-core.ts (fixture-tested — see
// mem-write.test.ts) so a future refactor of this CLI can't silently regress
// the prose-vs-canonical-row distinction (poller-brain#184, incident 2026-06-08).
function getNextKey(): number {
  return getNextKeyFromContents(
    readOrEmpty(REGISTRY_PATH),
    readOrEmpty(ARCHIVE_PATH),
    readOrEmpty(TODAY_PATH)
  );
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
  const escaped = content.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

  // Append to TODAY.md — full, untruncated content is the durable source of
  // truth (archived verbatim to memory/daily/ by consolidation).
  fs.appendFileSync(TODAY_PATH, `- [MEM-${key}] ${content}\n`);

  // Registry row is capped (#283) — TODAY.md's archived form is the pointer target.
  const dailyLogPath = `memory/daily/${today}.md`;
  const desc = truncateRegistryDescription(escaped, dailyLogPath);

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
