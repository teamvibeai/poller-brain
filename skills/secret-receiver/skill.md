---
name: secret-receiver
description: |
  Receive secrets from users securely via a temporary HTTP form tunneled through localtunnel.
  Stores received values in macOS Keychain.
---

# Secret Receiver

Securely receive secrets (API tokens, credentials) from users without them passing through Slack.
A temporary HTTP server with an HTML form is exposed via localtunnel. The user opens the URL,
submits the secret, and it is stored directly in macOS Keychain.

This skill is NOT user-invocable. Use it programmatically when you need to collect a secret from a user.

## Workflow

1. Start the server: `node /path/to/skills/secret-receiver/server.mjs --service "SERVICE_NAME"`
2. In a separate process, start localtunnel: `npx localtunnel --port 3456`
3. Send the localtunnel URL to the user via Slack
4. User opens the URL — localtunnel shows a "Friendly Reminder" page first; user clicks "Continue"
5. User fills in the secret and submits
6. Server saves to macOS Keychain, prints `TOKEN_SAVED`, and auto-shuts down

## Parameters

| Parameter       | Flag            | Default | Description                                      |
|-----------------|-----------------|---------|--------------------------------------------------|
| Service name    | `--service`     | —       | **(required)** Keychain service label             |
| Port            | `--port`        | `3456`  | HTTP server port                                  |
| Form title      | `--title`       | `"Enter Secret"` | Heading shown on the form                  |
| Form description| `--description` | `"Paste your secret below."` | Help text shown above the input |

## Example

```bash
# Terminal 1 — start the server
node "$CLAUDE_CONFIG_DIR/skills/secret-receiver/server.mjs" \
  --service "gitlab.com" \
  --title "GitLab Token" \
  --description "Paste your GitLab personal access token."

# Terminal 2 — expose via localtunnel
npx localtunnel --port 3456
# prints: your url is: https://xxx.loca.lt
```

Then send the URL to the user. When the user submits, the server prints `TOKEN_SAVED` and exits.

## Retrieving Stored Secrets

```bash
security find-generic-password -s "SERVICE_NAME" -w
```

Example:
```bash
security find-generic-password -s "gitlab.com" -w
```

## Notes

- The server auto-shuts down after receiving one secret — it is single-use.
- Localtunnel shows a "Friendly Reminder" interstitial page. The user must click "Continue" to reach the form.
- Secrets are stored with account `jarvis` in macOS Keychain. The `-U` flag updates if an entry already exists.
- The server prints `SERVER_READY` to stdout when listening, and `TOKEN_SAVED` when the secret is saved.
