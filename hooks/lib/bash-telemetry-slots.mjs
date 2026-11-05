// Cross-process admission for optional telemetry. Never wait for a slot.
// A nonempty directory is published atomically with rename, so concurrent
// callers cannot both claim it. Keep slots until the owning worker PID is
// dead: releasing just before exit could briefly exceed the process cap.
import { mkdirSync, readdirSync, renameSync, writeFileSync, unlinkSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_WORKERS = 4;
const PENDING_STALE_MS = 10_000; // Beyond both the parent and worker hard lifetimes.

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function removeOwner(slot, owner) {
  try {
    // Remove only the owner we inspected. If another caller already removed
    // it, stop. rmdir cannot delete a newly published, nonempty claim.
    unlinkSync(join(slot, owner));
    rmdirSync(slot);
  } catch { /* Busy/new owner or already removed: drop telemetry if needed. */ }
}

function reap(slot) {
  try {
    for (const owner of readdirSync(slot)) {
      const match = /^(pending|worker)-(\d+)-[a-f0-9-]+$/.exec(owner);
      if (!match || alive(Number(match[2]))) continue;
      // A parent could die between spawn and PID handoff. Its pending slot
      // must outlive any possible orphan worker before it can be reclaimed.
      if (match[1] === "pending" && Date.now() - statSync(join(slot, owner)).mtimeMs < PENDING_STALE_MS) continue;
      removeOwner(slot, owner);
    }
  } catch { /* Missing/busy slot is handled by atomic publication below. */ }
}

export function acquireWorkerSlot() {
  let staging;
  try {
    const root = join(tmpdir(), `teamvibe-bash-telemetry-${process.getuid?.() ?? "user"}`);
    mkdirSync(root, { mode: 0o700, recursive: true });
    // Reap abandoned staging directories too (a crash before publication).
    for (const entry of readdirSync(root)) {
      const match = /^claim-(\d+)-[a-f0-9-]+$/.exec(entry);
      if (match && !alive(Number(match[1]))) {
        const abandoned = join(root, entry);
        reap(abandoned);
        try {
          if (Date.now() - statSync(abandoned).mtimeMs >= PENDING_STALE_MS) rmdirSync(abandoned);
        } catch { /* Nonempty or already reclaimed. */ }
      }
    }
    const id = randomUUID();
    const owner = `pending-${process.pid}-${id}`;
    staging = join(root, `claim-${process.pid}-${id}`);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, owner), "", { flag: "wx", mode: 0o600 });
    for (let i = 0; i < MAX_WORKERS; i++) {
      const slot = join(root, `slot-${i}`);
      reap(slot);
      try {
        renameSync(staging, slot);
        staging = undefined;
        return { slot, owner, id };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
    }
  } catch { /* Filesystem failures fail open without starting a worker. */ }
  finally {
    if (staging) {
      try {
        for (const owner of readdirSync(staging)) unlinkSync(join(staging, owner));
        rmdirSync(staging);
      } catch { /* Best effort; later calls clean up dead staging owners. */ }
    }
  }
  return undefined;
}

export function assignWorkerSlot(lease, pid) {
  const owner = `worker-${pid}-${lease.id}`;
  renameSync(join(lease.slot, lease.owner), join(lease.slot, owner));
  lease.owner = owner;
}

export function releaseWorkerSlot(lease) {
  if (lease) removeOwner(lease.slot, lease.owner);
}
