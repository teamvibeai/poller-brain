import http from 'node:http';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

// OS-agnostic — does NOT depend on macOS `security` CLI, Linux
// `secret-tool`, Windows credential APIs, or any other platform-specific
// storage. Captures the value to a 0600-mode file (or a caller-supplied
// path) so the spawning agent can read it via Bash + pipe-to-curl
// without ever putting the plaintext into LLM context.

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '3456' },
    service: { type: 'string' },
    title: { type: 'string', default: 'Secret' },
    description: { type: 'string', default: '' },
    'out-file': { type: 'string' },
  },
});

if (!args.service) {
  console.error('Error: --service is required (label shown on the form)');
  process.exit(1);
}

const PORT = parseInt(args.port, 10);
const SERVICE = args.service;
const TITLE = args.title;
const DESCRIPTION = args.description;

// Default to a temp file with a random suffix so the agent can run
// multiple instances concurrently without collisions. Override via
// --out-file for tighter control (e.g., a tmpfs-mounted path).
const OUT_FILE =
  args['out-file'] ??
  join(tmpdir(), `secret-receiver-${randomBytes(8).toString('hex')}.txt`);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function htmlPage(body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(TITLE)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 440px; margin: 60px auto; padding: 20px;
    background: #f5f5f5; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    textarea { background: #2a2a2a; color: #e5e5e5; border-color: #444; }
    button { background: #6b4fbb; }
    button:hover { background: #7b5fcb; }
  }
  h2 { margin: 0 0 8px; }
  p.desc { color: #666; font-size: 14px; margin: 0 0 16px; }
  @media (prefers-color-scheme: dark) { p.desc { color: #999; } }
  .field { margin-bottom: 16px; }
  textarea {
    width: 100%; padding: 12px; font-size: 16px; font-family: ui-monospace, monospace;
    border: 2px solid #ddd; border-radius: 8px; outline: none;
    resize: vertical; min-height: 6em;
  }
  textarea:focus { border-color: #6b4fbb; }
  button[type="submit"] {
    background: #6b4fbb; color: white; border: none;
    padding: 12px 32px; font-size: 16px; border-radius: 8px;
    cursor: pointer; width: 100%;
  }
  button[type="submit"]:hover { background: #5a3fa8; }
  .ok { text-align: center; margin-top: 40px; }
  .ok h2 { color: #22c55e; }
</style>
</head><body>${body}</body></html>`;
}

const FORM_HTML = htmlPage(`
  <h2>${escapeHtml(TITLE)}</h2>
  ${DESCRIPTION ? `<p class="desc">${escapeHtml(DESCRIPTION)}</p>` : ''}
  <form method="POST" action="/save">
    <div class="field">
      <textarea id="secret" name="secret" rows="8" placeholder="Paste secret here..." required autofocus spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"></textarea>
    </div>
    <button type="submit">Submit</button>
  </form>
`);

const OK_HTML = htmlPage(`
  <div class="ok">
    <h2>✓ Received</h2>
    <p>Secret received. You can close this page — the agent will pick it up shortly.</p>
  </div>
`);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FORM_HTML);
    return;
  }

  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      // Browsers CRLF-normalize form-urlencoded values on submit (WHATWG late
      // normalization), so a pasted \n comes back as \r\n here — undo that first.
      // A multi-line value keeps exactly one trailing LF (many secret formats,
      // e.g. OpenSSH private keys, are only valid with one); a single-line value
      // is fully trimmed as before.
      const raw = (params.get('secret') ?? '').replace(/\r\n/g, '\n');
      const secret = raw.includes('\n') ? raw.replace(/[ \t\r\n]*$/, '\n') : raw.trim();

      if (!secret || !secret.trim()) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing secret');
        return;
      }

      try {
        // Ensure parent dir exists; cheap idempotent guard for callers
        // who hand us a custom path under a non-existent directory.
        mkdirSync(dirname(OUT_FILE), { recursive: true });
        writeFileSync(OUT_FILE, secret, { encoding: 'utf8' });
        // 0600 — readable only by the owner. On Windows the chmod is a
        // no-op but the file still inherits the process's user ACL.
        try { chmodSync(OUT_FILE, 0o600); } catch { /* best-effort */ }
        // The agent reads this line over stdout to discover the file
        // path — the plaintext never appears in stdout.
        console.log(`TOKEN_RECEIVED ${OUT_FILE}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(OK_HTML);
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 2000);
      } catch (err) {
        console.error('SAVE_ERROR:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to save: ' + err.message);
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  // Print both lines so the agent's stdout parser can capture them
  // before the form ever loads.
  console.log(`SERVER_READY on port ${PORT}`);
  console.log(`OUT_FILE ${OUT_FILE}`);
});
