// Tests for server.mjs. Same style as skills/background-task/scripts/bg-task.test.mjs —
// plain node, hand-rolled counters, no framework, no package.json.
//
//   node server.test.mjs
//
// Covers the pb#326 regression: a browser CRLF-normalizes form-urlencoded values on
// submit (WHATWG late normalization), so a pasted multi-line secret arrives as \r\n,
// not \n. A test that POSTs %0A (what curl/a manual test sends) never exercises that
// path — these tests POST %0D%0A to match what a real browser actually sends.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗ FAIL', n, extra !== undefined ? `— ${extra}` : ''); }
};
const eq = (n, got, want) => ok(n, got === want, `expected [${JSON.stringify(want)}], got [${JSON.stringify(got)}]`);

const WORK = mkdtempSync(join(tmpdir(), 'secret-receiver-test-'));
let nextPort = 34567;

// Starts the server, POSTs `formBody` (already form-urlencoded) to /save, waits for
// it to shut down, and returns the captured file's raw bytes.
function submit(formBody) {
  return new Promise((resolve, reject) => {
    const port = nextPort++;
    const outFile = join(WORK, `out-${port}.txt`);
    const child = spawn(process.execPath, [
      SERVER, '--service', 'test', '--port', String(port), '--out-file', outFile,
    ]);

    let ready = false;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      if (!ready && d.toString().includes('SERVER_READY')) {
        ready = true;
        const req = http.request({
          hostname: 'localhost', port, path: '/save', method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody),
          },
        }, (res) => { res.resume(); });
        req.on('error', reject);
        req.end(formBody);
      }
    });

    child.on('exit', () => {
      try {
        resolve(readFileSync(outFile));
      } catch (e) {
        reject(new Error(`no output file (stderr: ${stderr})`));
      }
    });
    child.on('error', reject);

    setTimeout(() => { child.kill(); reject(new Error('timed out waiting for server')); }, 5000);
  });
}

// Like submit(), but for inputs expected to be REJECTED (400) — the server doesn't
// shut down on that path (only on a successful save), so this reads the HTTP
// response directly instead of waiting for process exit, then kills the child.
function submitExpectRejected(formBody) {
  return new Promise((resolve, reject) => {
    const port = nextPort++;
    const outFile = join(WORK, `out-${port}.txt`);
    const child = spawn(process.execPath, [
      SERVER, '--service', 'test', '--port', String(port), '--out-file', outFile,
    ]);

    child.stdout.on('data', (d) => {
      if (d.toString().includes('SERVER_READY')) {
        const req = http.request({
          hostname: 'localhost', port, path: '/save', method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody),
          },
        }, (res) => {
          res.resume();
          res.on('end', () => {
            setTimeout(() => {
              child.kill();
              resolve({ status: res.statusCode, fileExists: existsSync(outFile) });
            }, 200);
          });
        });
        req.on('error', reject);
        req.end(formBody);
      }
    });
    child.on('error', reject);

    setTimeout(() => { child.kill(); reject(new Error('timed out waiting for server')); }, 5000);
  });
}

console.log('server.mjs — CRLF / trailing-newline handling (pb#326)');

// A browser's form submission CRLF-normalizes the value: a pasted "line1\nline2\n"
// is sent as "line1%0D%0Aline2%0D%0A", not "line1%0A%0Aline2%0A".
const multiline = 'line1\nline2\nline3';
const browserBody = 'secret=' + encodeURIComponent(multiline).replaceAll('%0A', '%0D%0A');
const got1 = await submit(browserBody);
eq('CRLF-submitted multi-line value round-trips to \\n with exactly one trailing LF',
  got1.toString('utf8'), multiline + '\n');

// A trailing blank line / trailing whitespace-only line should collapse to one LF,
// not be preserved verbatim (mirrors the pre-existing single-line .trim() behavior).
const trailingBlank = 'line1\nline2\n\n   \n';
const browserBody2 = 'secret=' + encodeURIComponent(trailingBlank).replaceAll('%0A', '%0D%0A');
const got2 = await submit(browserBody2);
eq('trailing blank/whitespace lines collapse to a single trailing LF',
  got2.toString('utf8'), 'line1\nline2\n');

// Single-line values keep the old fully-trimmed behavior (leading/trailing
// whitespace stripped, no injected newline).
const singleLine = '  ghp_abc123  ';
const browserBody3 = 'secret=' + encodeURIComponent(singleLine);
const got3 = await submit(browserBody3);
eq('single-line value is fully trimmed, no trailing LF added',
  got3.toString('utf8'), 'ghp_abc123');

// curl-style submission (%0A only, no \r) must also still work — the fix must not
// regress the non-browser path.
const curlBody = 'secret=' + encodeURIComponent(multiline);
const got4 = await submit(curlBody);
eq('curl-style (LF-only) multi-line value also gets exactly one trailing LF',
  got4.toString('utf8'), multiline + '\n');

// A whitespace-only submission must be rejected (400, no file written) — the
// trailing-LF collapse in the multi-line branch above turns "" into "\n", which
// is truthy, so the emptiness guard has to check the *trimmed* value, not just
// truthiness (DevGuru round-2 finding: pre-fix this silently wrote a "\n" file
// and returned 200).
for (const whitespaceOnly of ['\n\n', ' \n ', '   ']) {
  const body = 'secret=' + encodeURIComponent(whitespaceOnly).replaceAll('%0A', '%0D%0A');
  const res = await submitExpectRejected(body);
  eq(`whitespace-only ${JSON.stringify(whitespaceOnly)} is rejected (400)`, res.status, 400);
  ok(`whitespace-only ${JSON.stringify(whitespaceOnly)} writes no file`, !res.fileExists);
}

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
