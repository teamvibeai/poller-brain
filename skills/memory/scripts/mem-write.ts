#!/usr/bin/env npx tsx
/**
 * Create a new tracked MEM key entry.
 *
 * Allocates a dated UTC/full-UUID identity and prints MEM_ID=<id> to stderr
 * before any file write. Performs two appends: TODAY, then the registry.
 * On failure re-run with --id <printed MEM_ID> and the same source and content to complete
 * the missing half without duplicating. Prevents malformed keys like [MEM-feedback].
 *
 * Usage:
 *   npx tsx mem-write.ts --source=user-session "category: detail"
 *   npx tsx mem-write.ts --id <printed MEM_ID> --source=user-session "category: detail"
 *   npx tsx mem-write.ts --source=user-session "deploy: staging vyžaduje SSO login"
 *   npx tsx mem-write.ts --source=user-session "komunikace: mužský rod, vždy česky"
 *
 * Output:
 *   Written [MEM-YYYY-MM-DD-HHMMSS-<uuid>] to memory/TODAY.md and memory/MEM_REGISTRY.md
 */

import * as fs from "fs";
import { parseSourceFlag } from "./lib/source-flag.js";
import { brainPath } from "./lib/brain-root.js";
import { planMemWrite } from "./lib/mem-write-core.js";
import { isMemId, newMemId, parseMemId } from "./lib/mem-id.js";
import { computeRollover } from "./lib/today-md-core.js";

const REGISTRY_PATH = brainPath("memory/MEM_REGISTRY.md");
const TODAY_PATH = brainPath("memory/TODAY.md");

const REGISTRY_HEADER = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
`;

function readOrEmpty(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function ensureRegistry(): void {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, REGISTRY_HEADER);
  }
}

// Rollover decision lives in lib/today-md-core.ts (fixture-tested — see
// mem-write.test.ts) so a stale TODAY.md header isn't left in place when
// mem-write.ts is the first write of a new UTC day (poller-brain#267 —
// log-write.ts got this fix in cffb04c/e2f5420, mem-write.ts never did).
function ensureToday(today: string): void {
  const existingContent = fs.existsSync(TODAY_PATH)
    ? fs.readFileSync(TODAY_PATH, "utf-8")
    : null;
  const action = computeRollover(existingContent, today);

  if (action.kind === "create") {
    fs.writeFileSync(TODAY_PATH, action.textToWrite);
  } else if (action.kind === "append-header") {
    fs.appendFileSync(TODAY_PATH, action.textToWrite);
  }
}

function main(): void {
  // Extract --id before source parsing so flags can appear on either side of it.
  const args = process.argv.slice(2);
  const idAt = args.indexOf("--id");
  if (idAt > 0) args.unshift(...args.splice(idAt, 2));
  const retry = args[0] === "--id";
  const suppliedId = retry ? args[1] : undefined;
  if (retry && (!suppliedId || !isMemId(suppliedId) || parseMemId(suppliedId)?.kind !== "dated")) {
    console.error("--id requires a dated MEM ID");
    process.exitCode = 2;
    return;
  }
  let parsed: ReturnType<typeof parseSourceFlag>;
  try { parsed = parseSourceFlag(args.slice(retry ? 2 : 0)); }
  catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const { source, content } = parsed;

  if (!content) {
    console.error('Usage: npx tsx mem-write.ts [--id <dated MEM ID>] [--source=maintenance|user-session] "category: detail"');
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const id = suppliedId ?? newMemId(now);
  if (!retry) console.error(`MEM_ID=${id}`);
  const plan = planMemWrite({
    today: readOrEmpty(TODAY_PATH),
    registry: readOrEmpty(REGISTRY_PATH),
    id,
    content,
    source,
  });
  if (plan.kind === "error") {
    console.error(plan.message);
    process.exitCode = plan.code;
    return;
  }
  if (!plan.todayAppend && !plan.registryAppend) {
    console.log(`Already written [${id}]`);
    return;
  }

  if (plan.todayAppend) {
    ensureToday(now.toISOString().slice(0, 10));
    fs.appendFileSync(TODAY_PATH, plan.todayAppend);
  }
  if (plan.registryAppend) {
    ensureRegistry();
    fs.appendFileSync(REGISTRY_PATH, plan.registryAppend);
  }
  console.log(`Written [${id}] to ${TODAY_PATH} and ${REGISTRY_PATH}`);
}

main();
