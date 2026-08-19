# Secret Receiver Skill

Receive secrets (API tokens, credentials) from users securely via a temporary HTTP form tunneled through `cloudflared`. Submitted values are written to a 0600-mode file the spawning agent can read — **OS-agnostic**, no dependency on macOS Keychain, Linux `secret-tool`, or any other platform-specific store.

## How It Works

1. Agent starts a local Node.js HTTP server with a simple form
2. Agent runs `npx --yes cloudflared tunnel --url http://localhost:PORT` to create a temporary public HTTPS URL
3. Agent sends the URL to the user (e.g. via Slack)
4. User opens the URL, enters the secret, and submits
5. Server writes the secret to a 0600-mode file (path is announced on stdout), prints a `TOKEN_RECEIVED <path>` line, returns the success page, and shuts down 2s later
6. Agent reads the file directly into the consumer (e.g. `curl --data-binary @<path>`), then deletes the file

The secret never passes through Slack or any chat — it goes directly from the user's browser to the agent's machine via an encrypted tunnel. The plaintext value also never appears on the server's stdout — only the file path does, so the agent's Bash invocation can capture stdout safely without leaking the value into LLM context.

## Usage

### Starting the server

```bash
node $CLAUDE_CONFIG_DIR/skills/secret-receiver/server.mjs \
  --service "gitlab.com" \
  --title "GitLab Token" \
  --description "Paste your Personal Access Token"
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `--port` | `3456` | Local HTTP server port |
| `--service` | (required) | Display label shown on the form page (no longer a keychain key) |
| `--title` | `"Secret"` | Form page title |
| `--description` | `""` | Help text shown above the textarea |
| `--out-file` | random path under `os.tmpdir()` | Where to write the captured value (0600 mode). Override when you want a specific path, e.g. tmpfs |

### Starting the tunnel

```bash
npx --yes cloudflared tunnel --url http://localhost:3456
# The public URL is logged to stderr (not stdout), inside a bordered box:
# ...INF |  https://xyz-random-words.trycloudflare.com                |
```

No account or login is required — this is a Cloudflare "Quick Tunnel". Note the URL goes to **stderr**, unlike localtunnel's stdout — redirect `2>&1` when capturing it to a log file for grepping.

If `cloudflared`/`npx` fails to resolve (offline npm registry, corporate proxy blocking the binary download), fall back to `npx --yes localtunnel --port 3456` (`your url is: https://xyz-random.loca.lt` on stdout) — same server, same downstream flow, just a less reliable relay and a "Friendly Reminder" interstitial page on first visit.

### Discovering the output path

On startup the server prints two lines to stdout:

```
SERVER_READY on port 3456
OUT_FILE /var/folders/.../secret-receiver-ab12cd34.txt
```

On successful form submission it prints:

```
TOKEN_RECEIVED /var/folders/.../secret-receiver-ab12cd34.txt
```

Use the announced path — don't reconstruct it.

### Consuming the captured value

The plaintext lives in the output file with 0600 perms (owner-only). Read it into the consumer in a way that doesn't echo the value to the shell or to stdout. Two cross-platform options:

```bash
# Option A — node to construct a JSON body from the file + post
node -e '
  const fs = require("fs");
  const v = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(JSON.stringify({
    scope: "poller",
    scopeId: process.env.TEAMVIBE_POLLER_ID,
    name: "GITLAB_TOKEN",
    value: v,
  }));
' /var/folders/.../secret-receiver-ab12cd34.txt |
  curl -X PUT \
    -H "Authorization: Bearer $TEAMVIBE_POLLER_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$TEAMVIBE_API_URL/secrets"

# Option B — jq, if it's on the host
jq -Rs --arg scope poller --arg scopeId "$TEAMVIBE_POLLER_ID" --arg name GITLAB_TOKEN \
  '{scope: $scope, scopeId: $scopeId, name: $name, value: .}' \
  /var/folders/.../secret-receiver-ab12cd34.txt |
  curl -X PUT \
    -H "Authorization: Bearer $TEAMVIBE_POLLER_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$TEAMVIBE_API_URL/secrets"

# Delete the file immediately after the POST resolves
rm /var/folders/.../secret-receiver-ab12cd34.txt
```

Avoid `value=$(cat <file>)` — that pulls the plaintext into the shell environment and any subsequent `set -x` / `env` / process listing leaks it.

**Never diagnose the captured value by printing any part of its content** (`head -1`, "show me the first line", `wc -c` output piped through something that echoes the body, etc.). That is the one guarantee this skill exists to provide — the plaintext never reaches the agent's stdout or LLM context — and a debugging step that prints even a fragment defeats it. If the value looks wrong (auth fails, a downstream tool rejects it), assert over *derived* properties instead: byte length (`wc -c < <file>`), line count, a regex match (`grep -qE '^-----BEGIN' <file>`), or best of all, whether it actually works (sign something, call the API). If it's genuinely corrupt, ask the user to resubmit — don't inspect the broken value to find out why.

## Where the captured value can land

This skill only captures the value — it doesn't pick a destination. Decide that *before* you spin the form up:

- **Poller-scope** (e.g. an agent rotating its own GitLab PAT): `PUT $TEAMVIBE_API_URL/secrets` with `scope: "poller"` and `scopeId: $TEAMVIBE_POLLER_ID`. This is the only platform write the REST API accepts from a poller-token Bearer; see [teamvibe.ai#212](https://github.com/teamvibeai/teamvibe.ai/issues/212).
- **Workspace-scope**: REST is **denied** for poller tokens. The platform UI (`/settings/secrets`, Owner-role only via `withWorkspaceAuth` on the GraphQL `Mutation.putSecret`) is the canonical write path. If you've already captured a value via this skill and the user wants it in workspace scope, surface the file path in a follow-up Slack message so they can `cat <path> | pbcopy` (or equivalent) and paste it into the UI themselves, then `rm` the file.
- **Channel-scope**: REST accepts the write only if the target Channel row exists and isn't soft-deleted ([teamvibe.ai#213](https://github.com/teamvibeai/teamvibe.ai/issues/213)). If the channel exists, the consumer pattern above with `scope: "channel"`, `scopeId: $TEAMVIBE_WORKSPACE_ID`, `channelId: <id>` works. If it doesn't exist yet, route the user to `/channels/<id>` (UI, Owner-only).

In all cases the platform value is **write-only after save** — no list endpoint or UI surface returns the plaintext later. It only reappears in agent `process.env` via the per-spawn injection.

## Notes

- **No interstitial:** Unlike localtunnel, a `trycloudflare.com` Quick Tunnel has no "Friendly Reminder" / IP-gate page — the form loads on first visit.
- **Cross-platform:** Works on macOS, Linux, and Windows (Node's `fs` works everywhere; `chmod` is a no-op on Windows but the file still inherits the owner's user ACL).
- **One-shot:** The server automatically shuts down 2s after receiving a value. The output file persists until the agent deletes it — clean up as soon as the value is consumed.
- **Concurrent runs:** Default `--out-file` is randomly named, so multiple receiver instances on the same host don't collide on the same path.
- **Security:** The tunnel URL is random and short-lived. The server only accepts one submission before shutting down. The plaintext is written to a single 0600-mode file and never to the server's stdout.
- **No input masking:** The form field is a plain `<textarea>`, not a masked `<input type="password">` — a deliberate tradeoff, not an oversight. A single-line `<input>` runs the browser's value-sanitization algorithm on every keystroke/paste, which strips newlines outright — that's what silently corrupted multi-line secrets, not a submission-time encoding quirk; the shoulder-surf protection a masked field gives up is minor next to that data-loss risk. See [pb#326](https://github.com/teamvibeai/poller-brain/issues/326).

## Typical Agent Workflow

```bash
# 1. Start server in background, capture its stdout to grep the path
node $CLAUDE_CONFIG_DIR/skills/secret-receiver/server.mjs \
  --service "gitlab.com" --title "GitLab Token" > /tmp/sr.log 2>&1 &
SR_PID=$!

# 2. Start tunnel (cloudflared logs to stderr, hence 2>&1)
npx --yes cloudflared tunnel --url http://localhost:3456 > /tmp/lt.log 2>&1 &
LT_PID=$!
URL=$(timeout 15 grep -o 'https://[^ ]*trycloudflare.com' <(tail -F /tmp/lt.log) | head -1)

# 3. Send URL to user via Slack (via the slack MCP tool)

# 4. Wait for TOKEN_RECEIVED on the server's stdout
wait $SR_PID
OUT=$(grep -o 'TOKEN_RECEIVED .*' /tmp/sr.log | tail -1 | awk '{print $2}')

# 5. Pipe straight into the consumer (here: PUT /secrets at poller scope).
#    See "Consuming the captured value" above — never use $(cat) or -d
#    with the file contents, they pull plaintext through the shell env.
node -e '
  const fs = require("fs");
  const v = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(JSON.stringify({
    scope: "poller",
    scopeId: process.env.TEAMVIBE_POLLER_ID,
    name: "GITLAB_TOKEN",
    value: v,
  }));
' "$OUT" |
  curl -X PUT \
    -H "Authorization: Bearer $TEAMVIBE_POLLER_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$TEAMVIBE_API_URL/secrets"

# 6. Clean up
rm "$OUT"
kill $LT_PID 2>/dev/null
rm /tmp/sr.log /tmp/lt.log
```
