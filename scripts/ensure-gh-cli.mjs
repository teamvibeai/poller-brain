#!/usr/bin/env node
// SessionStart hook: self-heal a missing `gh` CLI (teamvibeai/teamvibe.ai#315).
//
// The base harness instructs every session to use `gh` for all GitHub work,
// but the fleet doesn't provision it uniformly — confirmed missing entirely
// from this session's filesystem on 2026-08-19, with no install step
// anywhere in teamvibe.ai or poller-brain, while DevGuru's own container
// (same image family) has it dpkg-owned from build time. This is a
// stopgap: it fixes the symptom (agents falling back to slower/more
// error-prone curl+GITHUB_TOKEN calls) without needing access to wherever
// the session image/bootstrap actually lives. The real fix is infra-side
// (tv#315); once that ships fleet-wide, this hook becomes a fast no-op
// (`gh` already present) rather than dead weight to remove.
//
// Fails open: any error here must never block session start. Worst case,
// `gh` stays missing and the harness's own curl+GITHUB_TOKEN fallback still
// works, exactly as it does today.
//
// DevGuru round-1 review (tv#315, 2026-08-19) drove: sh -c 'command -v'
// instead of `which` (deprecated/removed in some Debian releases); a
// pinned+checksum-verified binary fallback instead of unauthenticated
// releases/latest (rate-limit + supply-chain risk, same class as the
// @teamvibe/poller@latest issue fixed elsewhere in this same round); a
// throttle stamp so N brains sharing one container don't all pay full
// install cost (or fight over the dpkg lock) every session; and a
// declared hook timeout that actually covers the worst-case install path.
//
// DevGuru round 2 caught the first timeout budget was still wrong (175s
// against a declared 150s, since the apt and binary paths run
// sequentially, not exclusively) and that a killed run never wrote the
// throttle stamp — the one expensive failure path would repeat every
// session forever, silently. Fixed: tighter per-step timeouts (~135s
// total), the failure stamp now written before attempting (not after),
// and the binary fallback verifies by actually running `gh --version`
// rather than just checking the file was copied.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pinned deliberately, like POLLER_VERSION in packages/poller/Dockerfile —
// bump by hand when there's a reason to, not silently via `latest`.
const GH_VERSION = "2.63.0";
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h backoff after a failed attempt
const STAMP_FILE = join(process.env.PERSISTENT_STORAGE_PATH || tmpdir(), ".gh-selfheal-state.json");

function commandExists(cmd) {
  const result = spawnSync("sh", ["-c", `command -v -- ${cmd}`]);
  return result.status === 0;
}

let lastErrorMessage = null;

function logDetail(msg) {
  // Verbose per-attempt diagnostics — not meant to surface every session,
  // only useful when actively debugging a failing install. Also captured
  // as lastErrorMessage so a failed outcome line (stdout) can carry the
  // reason instead of pointing at stderr nothing surfaces.
  lastErrorMessage = msg;
  console.error(`[ensure-gh-cli] ${msg}`);
}

function logOutcome(msg) {
  // One line per actual attempt (success or exhausted-retry failure).
  // stdout so it lands in session context, per DevGuru round-1 point #4.
  console.log(`[ensure-gh-cli] ${msg}`);
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(state) {
  try {
    writeFileSync(STAMP_FILE, JSON.stringify(state));
  } catch (err) {
    logDetail(`could not write throttle stamp: ${err.message}`);
  }
}

function tryAptInstall() {
  if (!commandExists("apt-get")) {
    logDetail("apt-get not available, skipping apt path");
    return false;
  }
  if (process.getuid?.() !== 0) {
    logDetail("not running as root, skipping apt path");
    return false;
  }
  try {
    // Lock::Timeout: wait for a concurrent apt run (sibling brain in the
    // same container) instead of racing/failing hard on lock contention.
    execFileSync(
      "apt-get",
      ["update", "-qq", "-o", "DPkg::Lock::Timeout=30"],
      { stdio: "ignore", timeout: 30_000 },
    );
    execFileSync(
      "apt-get",
      ["install", "-y", "--no-install-recommends", "-qq", "-o", "DPkg::Lock::Timeout=30", "gh"],
      { stdio: "ignore", timeout: 45_000 },
    );
    return commandExists("gh");
  } catch (err) {
    logDetail(`apt-get install failed: ${err.message}`);
    return false;
  }
}

function archTag() {
  const arch = process.arch; // 'x64' | 'arm64' | ...
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  return null;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tryBinaryInstall() {
  const arch = archTag();
  if (!arch) {
    logDetail(`unsupported arch ${process.arch}, skipping binary fallback`);
    return false;
  }

  const installDir = process.env.PERSISTENT_STORAGE_PATH
    ? join(process.env.PERSISTENT_STORAGE_PATH, "bin")
    : "/usr/local/bin";
  try {
    mkdirSync(installDir, { recursive: true });
  } catch (err) {
    logDetail(`cannot create install dir ${installDir}: ${err.message}`);
    return false;
  }

  const tarballName = `gh_${GH_VERSION}_linux_${arch}.tar.gz`;
  const releaseBase = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
  const tarballUrl = `${releaseBase}/${tarballName}`;
  const checksumsUrl = `${releaseBase}/gh_${GH_VERSION}_checksums.txt`;
  const work = join(tmpdir(), `gh-install-${process.pid}`);

  try {
    mkdirSync(work, { recursive: true });

    const checksumsPath = join(work, "checksums.txt");
    execFileSync("curl", ["-fsSL", "--max-time", "15", "-o", checksumsPath, checksumsUrl], {
      timeout: 15_000,
    });
    const checksumsText = readFileSync(checksumsPath, "utf8");
    const line = checksumsText.split("\n").find((l) => l.trim().endsWith(tarballName));
    const expectedSha256 = line?.trim().split(/\s+/)[0];
    if (!expectedSha256) {
      logDetail(`no checksum entry found for ${tarballName}, refusing to install unverified`);
      return false;
    }

    const tarballPath = join(work, "gh.tar.gz");
    execFileSync("curl", ["-fsSL", "--max-time", "25", "-o", tarballPath, tarballUrl], {
      timeout: 25_000,
    });

    const actualSha256 = sha256File(tarballPath);
    if (actualSha256 !== expectedSha256) {
      logDetail(`checksum mismatch for ${tarballName}: expected ${expectedSha256}, got ${actualSha256}`);
      return false;
    }

    execFileSync("tar", ["-xzf", tarballPath, "-C", work], { timeout: 10_000 });
    const extractedBin = join(work, `gh_${GH_VERSION}_linux_${arch}`, "bin", "gh");
    if (!existsSync(extractedBin)) {
      logDetail("extracted archive missing expected gh binary");
      return false;
    }
    const dest = join(installDir, "gh");
    execFileSync("cp", [extractedBin, dest], { timeout: 5_000 });
    chmodSync(dest, 0o755);
    // Not commandExists("gh") here: installDir (persistent-storage bin, or
    // /usr/local/bin) may not be on THIS process's PATH yet even though the
    // harness guarantees it for the session proper. Run the binary itself
    // instead — proves it's the right arch, executable, and not truncated,
    // which a plain existsSync() wouldn't catch (DevGuru round 2).
    execFileSync(dest, ["--version"], { timeout: 5_000 });
    return true;
  } catch (err) {
    logDetail(`binary fallback install failed: ${err.message}`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  if (commandExists("gh")) return; // fast path — no output, no noise

  const stamp = readStamp();
  const now = Date.now();
  if (stamp?.lastFailureAt && now - stamp.lastFailureAt < RETRY_WINDOW_MS) {
    return; // still in backoff window — silent, no repeat cost/noise
  }

  // Write the failure stamp BEFORE attempting, not after: the internal
  // timeout budget (~135s) sits close to the hook's declared 150s ceiling,
  // and if the harness ever kills this process mid-install, a stamp
  // written only on completion would never land — so the same expensive
  // failure path would repeat every session, silently, forever (DevGuru
  // round 2). Overwritten with lastSuccessAt below on an actual success.
  writeStamp({ lastFailureAt: now });

  const installed = tryAptInstall() || tryBinaryInstall();
  if (installed) {
    logOutcome("gh CLI installed successfully");
    writeStamp({ lastSuccessAt: now });
  } else {
    logOutcome(
      `gh CLI install failed (${lastErrorMessage ?? "unknown reason"}) — curl+GITHUB_TOKEN fallback still works, will retry after backoff window`,
    );
  }
}

try {
  main();
} catch (err) {
  // Never let a self-heal bug block session start.
  logDetail(`unexpected error, skipping: ${err.message}`);
}
