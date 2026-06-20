# Secret Receiver Skill

Receive secrets (API tokens, credentials) from users securely via a temporary HTTP form tunneled through localtunnel. Submitted values are written to a 0600-mode file the spawning agent can read — **OS-agnostic**, no dependency on macOS Keychain, Linux `secret-tool`, or any other platform-specific store.

## How It Works

1. Agent starts a local Node.js HTTP server with a simple form
2. Agent runs `npx localtunnel --port PORT` to create a temporary public HTTPS URL
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
| `--description` | `""` | Help text shown above the input field |
| `--out-file` | random path under `os.tmpdir()` | Where to write the captured value (0600 mode). Override when you want a specific path, e.g. tmpfs |

### Starting the tunnel

```bash
npx --yes localtunnel --port 3456
# Output: your url is: https://xyz-random.loca.lt
```

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

## Notes

- **Localtunnel interstitial:** The first visit shows a "Friendly Reminder" page. The user must click "Click to Continue" or enter their IP address to proceed.
- **Cross-platform:** Works on macOS, Linux, and Windows (Node's `fs` works everywhere; `chmod` is a no-op on Windows but the file still inherits the owner's user ACL).
- **One-shot:** The server automatically shuts down 2s after receiving a value. The output file persists until the agent deletes it — clean up as soon as the value is consumed.
- **Concurrent runs:** Default `--out-file` is randomly named, so multiple receiver instances on the same host don't collide on the same path.
- **Security:** The tunnel URL is random and short-lived. The server only accepts one submission before shutting down. The plaintext is written to a single 0600-mode file and never to the server's stdout.

## Typical Agent Workflow

```bash
# 1. Start server in background, capture its stdout to grep the path
node $CLAUDE_CONFIG_DIR/skills/secret-receiver/server.mjs \
  --service "gitlab.com" --title "GitLab Token" > /tmp/sr.log 2>&1 &
SR_PID=$!

# 2. Start tunnel
npx --yes localtunnel --port 3456 > /tmp/lt.log 2>&1 &
LT_PID=$!
URL=$(timeout 10 grep -o 'https://[^ ]*' <(tail -F /tmp/lt.log) | head -1)

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
