#!/usr/bin/env npx tsx
/**
 * Read-only catalog audit for consolidation Step 9a-catalog.
 * Usage: npx tsx mem-catalog-audit.ts [--catalog index.md] [--json]
 * BRAIN_ROOT / cwd resolution follows the other memory scripts.
 * Exit 0: complete inventory (possibly discoverability warnings).
 * Exit 1: incomplete/error. Never writes or repairs memory files.
 */
import { brainPath } from "./lib/brain-root.js";
import { auditCatalog, formatAudit } from "./lib/mem-catalog-audit-core.js";

function main(): void {
  let catalog: string | undefined;
  let json = false;
  const args = process.argv.slice(2);
  while (args.length) {
    const arg = args.shift();
    if (arg === "--json" && !json) json = true;
    else if (arg === "--catalog" && catalog === undefined && args[0] && !args[0].startsWith("--")) catalog = args.shift();
    else throw new Error("Usage: mem-catalog-audit.ts [--catalog <memory-relative-path>] [--json]");
  }
  const result = auditCatalog(brainPath("memory"), catalog);
  console.log(json ? JSON.stringify(result) : formatAudit(result));
  if (result.status === "incomplete") process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error("Memory Catalog Audit: incomplete/error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
