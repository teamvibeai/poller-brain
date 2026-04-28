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
import * as path from "path";

const REGISTRY_PATH = "memory/MEM_REGISTRY.md";
const TODAY_PATH = "memory/TODAY.md";

const REGISTRY_HEADER = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
`;

function scanMaxKey(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = content.matchAll(/MEM-(\d+)/g);
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function getNextKey(): number {
  const fromRegistry = scanMaxKey(REGISTRY_PATH);
  const fromToday = scanMaxKey(TODAY_PATH);
  return Math.max(fromRegistry, fromToday) + 1;
}

function ensureRegistry(): void {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, REGISTRY_HEADER);
  }
}

function ensureToday(): void {
  if (!fs.existsSync(TODAY_PATH)) {
    fs.mkdirSync(path.dirname(TODAY_PATH), { recursive: true });
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

  // Short description for registry (first 60 chars)
  const desc = content.length > 60 ? content.slice(0, 57) + "..." : content;

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
