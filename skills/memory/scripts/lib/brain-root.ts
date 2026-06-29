/**
 * Resolve the brain repo root deterministically.
 *
 * Memory scripts (log-write, mem-write) write to `memory/TODAY.md` and
 * `memory/MEM_REGISTRY.md`. When invoked with a relative path, those files
 * resolve against `process.cwd()` — so if a session has chdir'd into a
 * subdirectory (skills/, .local/tmp/, etc.) the scripts will silently
 * create a nested `memory/` tree under that subdir, splitting the daily log
 * and forking the MEM key counter off the global registry.
 *
 * Reference: poller-brain#189 (feedback/bug/high), #192, #194, #195.
 *
 * Resolution order:
 *   1. `BRAIN_ROOT` env var (explicit escape hatch) — must point at a dir
 *      containing both `CLAUDE.md` and `memory/`.
 *   2. Walk up from `process.cwd()` looking for the same dual marker.
 *   3. Throw with an actionable message.
 */

import * as fs from "fs";
import * as path from "path";

let cached: string | null = null;

function hasBrainMarkers(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "CLAUDE.md")) &&
    fs.existsSync(path.join(dir, "memory"))
  );
}

function walkUp(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (hasBrainMarkers(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveBrainRoot(): string {
  if (cached) return cached;

  const fromEnv = process.env.BRAIN_ROOT;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (!hasBrainMarkers(abs)) {
      throw new Error(
        `BRAIN_ROOT="${fromEnv}" does not look like a brain repo ` +
          `(missing CLAUDE.md and/or memory/). Unset BRAIN_ROOT or point it at a brain dir.`
      );
    }
    cached = abs;
    return abs;
  }

  const found = walkUp(process.cwd());
  if (!found) {
    throw new Error(
      `Brain root not found. Walked up from cwd="${process.cwd()}" looking for a ` +
        `directory containing both CLAUDE.md and memory/. ` +
        `Run this script from inside a brain repo, or set BRAIN_ROOT to its absolute path.`
    );
  }
  cached = found;
  return found;
}

export function brainPath(...segments: string[]): string {
  return path.join(resolveBrainRoot(), ...segments);
}
