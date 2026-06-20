import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '3456' },
    service: { type: 'string' },
    title: { type: 'string', default: 'Secret' },
    description: { type: 'string', default: '' },
    account: { type: 'string', default: 'jarvis' },
  },
});

if (!args.service) {
  console.error('Error: --service is required (keychain service name)');
  process.exit(1);
}

const PORT = parseInt(args.port, 10);
const SERVICE = args.service;
const TITLE = args.title;
const DESCRIPTION = args.description;
const ACCOUNT = args.account;

function htmlPage(body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 440px; margin: 60px auto; padding: 20px;
    background: #f5f5f5; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    input { background: #2a2a2a; color: #e5e5e5; border-color: #444; }
    button { background: #6b4fbb; }
    button:hover { background: #7b5fcb; }
    .toggle { color: #aaa; }
    .toggle:hover { color: #ccc; }
  }
  h2 { margin: 0 0 8px; }
  p.desc { color: #666; font-size: 14px; margin: 0 0 16px; }
  @media (prefers-color-scheme: dark) { p.desc { color: #999; } }
  .field { position: relative; margin-bottom: 16px; }
  input {
    width: 100%; padding: 12px 44px 12px 12px; font-size: 16px;
    border: 2px solid #ddd; border-radius: 8px; outline: none;
  }
  input:focus { border-color: #6b4fbb; }
  .toggle {
    position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; font-size: 18px;
    color: #666; padding: 4px;
  }
  .toggle:hover { color: #333; }
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
  <h2>${TITLE}</h2>
  ${DESCRIPTION ? `<p class="desc">${DESCRIPTION}</p>` : ''}
  <form method="POST" action="/save">
    <div class="field">
      <input type="password" id="secret" name="secret" placeholder="Paste secret here..." required autofocus>
      <button type="button" class="toggle" onclick="
        const inp = document.getElementById('secret');
        const isPassword = inp.type === 'password';
        inp.type = isPassword ? 'text' : 'password';
        this.textContent = isPassword ? '🙈' : '👁';
      ">👁</button>
    </div>
    <button type="submit">Save to Keychain</button>
  </form>
`);

const OK_HTML = htmlPage(`
  <div class="ok">
    <h2>✓ Saved</h2>
    <p>Secret stored in Keychain as <code>${SERVICE}</code>.<br>You can close this page.</p>
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
      const secret = params.get('secret')?.trim();

      if (!secret) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing secret');
        return;
      }

      try {
        // -U updates if exists, creates if not
        execFileSync('security', [
          'add-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w', secret, '-U',
        ]);
        console.log('TOKEN_SAVED');
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
  console.log(`SERVER_READY on port ${PORT}`);
});
