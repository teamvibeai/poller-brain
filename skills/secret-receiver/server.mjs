#!/usr/bin/env node

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "3456" },
    service: { type: "string" },
    title: { type: "string", default: "Enter Secret" },
    description: { type: "string", default: "Paste your secret below." },
  },
});

if (!args.service) {
  console.error("Error: --service is required (Keychain service label)");
  process.exit(1);
}

const PORT = parseInt(args.port, 10);
const SERVICE = args.service;
const TITLE = args.title;
const DESCRIPTION = args.description;

function htmlPage(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
    background: #f5f5f5; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    .card { background: #2a2a2a; border-color: #3a3a3a; }
    input { background: #333; color: #e5e5e5; border-color: #555; }
    input:focus { border-color: #6366f1; }
    .toggle-btn { color: #999; }
    .toggle-btn:hover { color: #ccc; }
  }
  .card {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 12px;
    padding: 2rem; max-width: 480px; width: 100%;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { font-size: 0.95rem; opacity: 0.7; margin-bottom: 1.5rem; line-height: 1.5; }
  .input-wrapper { position: relative; margin-bottom: 1rem; }
  input {
    width: 100%; padding: 0.75rem 3rem 0.75rem 0.75rem;
    font-size: 1rem; border: 1px solid #ccc; border-radius: 8px;
    outline: none; transition: border-color 0.2s;
    font-family: monospace;
  }
  input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.15); }
  .toggle-btn {
    position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; font-size: 1.2rem;
    color: #666; padding: 0.25rem 0.5rem;
  }
  .toggle-btn:hover { color: #333; }
  button[type="submit"] {
    width: 100%; padding: 0.75rem; font-size: 1rem; font-weight: 600;
    background: #4f46e5; color: #fff; border: none; border-radius: 8px;
    cursor: pointer; transition: background 0.2s;
  }
  button[type="submit"]:hover { background: #4338ca; }
  button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
  .success { text-align: center; }
  .success h1 { color: #16a34a; }
  .error { text-align: center; }
  .error h1 { color: #dc2626; }
</style>
</head>
<body>
<div class="card">${body}</div>
</body>
</html>`;
}

function formHTML() {
  return htmlPage(`
  <h1>${escapeHtml(TITLE)}</h1>
  <p>${escapeHtml(DESCRIPTION)}</p>
  <form method="POST" action="/save" id="form">
    <div class="input-wrapper">
      <input type="password" name="secret" id="secret" required
             placeholder="Enter value..." autocomplete="off" autofocus>
      <button type="button" class="toggle-btn" onclick="toggleVisibility()" title="Show/Hide" id="toggleBtn">&#128065;</button>
    </div>
    <button type="submit" id="submitBtn">Save</button>
  </form>
  <script>
    function toggleVisibility() {
      const input = document.getElementById('secret');
      const btn = document.getElementById('toggleBtn');
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = '&#128064;';
      } else {
        input.type = 'password';
        btn.innerHTML = '&#128065;';
      }
    }
    document.getElementById('form').addEventListener('submit', function() {
      document.getElementById('submitBtn').disabled = true;
      document.getElementById('submitBtn').textContent = 'Saving...';
    });
  </script>`);
}

function successHTML() {
  return htmlPage(`
  <div class="success">
    <h1>Saved</h1>
    <p>The secret has been stored securely. You can close this tab.</p>
  </div>`);
}

function errorHTML(message) {
  return htmlPage(`
  <div class="error">
    <h1>Error</h1>
    <p>${escapeHtml(message)}</p>
  </div>`);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  return params.get("secret") || "";
}

function saveToKeychain(service, secret) {
  execSync(
    `security add-generic-password -a "jarvis" -s ${JSON.stringify(service)} -w ${JSON.stringify(secret)} -U`,
    { stdio: "pipe" }
  );
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(formHTML());
    return;
  }

  if (req.method === "POST" && req.url === "/save") {
    let body = "";
    for await (const chunk of req) body += chunk;

    const secret = parseFormBody(body);
    if (!secret) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(errorHTML("No secret provided. Please go back and try again."));
      return;
    }

    try {
      saveToKeychain(SERVICE, secret);
      console.log("TOKEN_SAVED");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successHTML());
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 2000);
    } catch (err) {
      console.error("Keychain error:", err.message);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(errorHTML("Failed to store secret. " + err.message));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("SERVER_READY");
  console.log(`Listening on http://localhost:${PORT}`);
});
