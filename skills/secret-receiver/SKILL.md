# Secret Receiver Skill

Receive secrets (API tokens, credentials) from users securely via a temporary HTTP form tunneled through localtunnel. Submitted values are stored in macOS Keychain.

## How It Works

1. Agent starts a local Node.js HTTP server with a simple form
2. Agent runs `npx localtunnel --port PORT` to create a temporary public HTTPS URL
3. Agent sends the URL to the user (e.g. via Slack)
4. User opens the URL, enters the secret, and submits
5. Server saves the secret to macOS Keychain and shuts down

The secret never passes through Slack or any chat — it goes directly from the user's browser to the agent's machine via an encrypted tunnel.

## Usage

### Starting the server

```bash
node skills/shared/secret-receiver/server.mjs --service "gitlab.com" --title "GitLab Token" --description "Paste your Personal Access Token"
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `--port` | `3456` | Local HTTP server port |
| `--service` | (required) | Keychain service name (used as lookup key) |
| `--title` | `"Secret"` | Form page title |
| `--description` | `""` | Help text shown above the input field |
| `--account` | `jarvis` | Keychain account name |

### Starting the tunnel

```bash
npx --yes localtunnel --port 3456
# Output: your url is: https://xyz-random.loca.lt
```

### Retrieving stored secrets

```bash
security find-generic-password -s "SERVICE_NAME" -w
```

Example:
```bash
GITLAB_TOKEN=$(security find-generic-password -s "gitlab.com" -w)
curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://gitlab.com/api/v4/projects
```

## Notes

- **Localtunnel interstitial:** The first visit shows a "Friendly Reminder" page. The user must click "Click to Continue" or enter their IP address to proceed.
- **macOS only:** Uses `security` CLI (macOS Keychain). Won't work on Linux without modification.
- **One-shot:** The server automatically shuts down after receiving one secret.
- **`-U` flag:** If a keychain entry with the same service name already exists, it will be updated (not duplicated).
- **Security:** The tunnel URL is random and short-lived. The server only accepts one submission before shutting down.

## Typical Agent Workflow

```javascript
// 1. Start server in background
// node secret-receiver/server.mjs --service "gitlab.com" --title "GitLab Token" &

// 2. Start tunnel
// npx localtunnel --port 3456
// -> capture the URL

// 3. Send URL to user via Slack/chat

// 4. Wait for TOKEN_SAVED in stdout or check keychain:
// security find-generic-password -s "gitlab.com" -w

// 5. Clean up (server auto-exits, kill tunnel)
// pkill -f localtunnel
```
