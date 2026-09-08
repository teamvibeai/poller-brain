#!/usr/bin/env npx tsx
/**
 * Self-test for bash-telemetry-redact.ts. Run: npx tsx hooks/lib/bash-telemetry-redact.test.ts
 * Exits non-zero on the first failed assertion. Same hand-rolled style as
 * hooks/lib/bash-deny-list-core.ts's test (no framework, plain assertions) —
 * this repo's established convention for hook-support-library tests.
 */

import { redactSecrets } from "./bash-telemetry-redact.js";

let passed = 0;
function assertRedacted(cmd: string, mustNotContain: string, label: string): void {
  const result = redactSecrets(cmd);
  if (result.includes(mustNotContain)) {
    console.error(`FAIL (${label}): expected "${mustNotContain}" to be redacted from: ${cmd}\n  got: ${result}`);
    process.exit(1);
  }
  if (!result.includes("[REDACTED")) {
    console.error(`FAIL (${label}): expected a [REDACTED...] marker in output for: ${cmd}\n  got: ${result}`);
    process.exit(1);
  }
  passed++;
}
function assertUnchanged(cmd: string, label: string): void {
  const result = redactSecrets(cmd);
  if (result !== cmd) {
    console.error(`FAIL (${label}): expected no redaction for: ${cmd}\n  got: ${result}`);
    process.exit(1);
  }
  passed++;
}

// --- AWS access key IDs ------------------------------------------------------
assertRedacted("aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP", "aws-access-key-id");
assertUnchanged("echo 'hello world'", "aws-access-key-id negative control");

// --- GitHub tokens ------------------------------------------------------------
assertRedacted(
  "curl -H \"Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789\" https://api.github.com",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "github-token",
);

// --- Slack tokens ---------------------------------------------------------------
assertRedacted("export SLACK_TOKEN=xoxb-notarealtoken-fixture-value", "xoxb-notarealtoken-fixture-value", "slack-token");

// --- Generic KEY=/TOKEN=/SECRET=/PASSWORD=/PASS= assignments (case-insensitive) --
assertRedacted("export FOO_TOKEN=abc123", "abc123", "generic-secret-assignment TOKEN");
assertRedacted("PASSWORD=hunter2 ./run.sh", "hunter2", "generic-secret-assignment PASSWORD");
assertRedacted("db_secret=s3cr3t-value node app.js", "s3cr3t-value", "generic-secret-assignment lowercase SECRET");
assertRedacted("Pass=hunter2", "hunter2", "generic-secret-assignment case-insensitive PASS");

// --- CLI flag values (--token, --password, -p, --api-key, --secret) -------------
assertRedacted("gh auth login --token abc123def456", "abc123def456", "cli-secret-flag --token");
assertRedacted("mysql -u root -p hunter2", "hunter2", "cli-secret-flag -p");
assertRedacted("curl --api-key sk-abc123 https://api.example.com", "sk-abc123", "cli-secret-flag --api-key");
assertRedacted("some-cli --secret=my-secret-value", "my-secret-value", "cli-secret-flag --secret=");

// --- Authorization: Bearer <token> ----------------------------------------------
assertRedacted("curl -H 'Authorization: Bearer abc.def.ghi123'", "abc.def.ghi123", "authorization-bearer");

// --- Regression (DevGuru review round 1, teamvibe.ai#341): quoted multi-word ----
// secrets must be redacted whole, not truncated at the first space by a \S+
// fallback (which would leak the rest of the words in plaintext).
assertRedacted(
  'export DB_PASSWORD="correct horse battery staple"',
  "correct horse battery staple",
  "generic-secret-assignment quoted multi-word value",
);
{
  const result = redactSecrets('export DB_PASSWORD="correct horse battery staple"');
  if (result.includes("horse battery staple")) {
    console.error(`FAIL (quoted-assignment-no-partial-leak): trailing words leaked: ${result}`);
    process.exit(1);
  }
  passed++;
}
assertRedacted(
  'mysql --password "correct horse battery staple" -u root',
  "correct horse battery staple",
  "cli-secret-flag quoted multi-word value",
);
{
  const result = redactSecrets('mysql --password "correct horse battery staple" -u root');
  if (result.includes("horse battery staple")) {
    console.error(`FAIL (quoted-flag-no-partial-leak): trailing words leaked: ${result}`);
    process.exit(1);
  }
  passed++;
}

// --- Regression (DevGuru review round 1, teamvibe.ai#341): Authorization: -------
// Bearer $VAR must get the same $VAR exemption as the other two rules,
// including the common curl form where the value sits inside a caller-quoted
// -H argument rather than being quoted itself.
assertUnchanged('curl -H "Authorization: Bearer $TOKEN"', "authorization-bearer env-var reference inside caller-quoted -H arg");
assertUnchanged("curl -H 'Authorization: Bearer $TOKEN'", "authorization-bearer env-var reference inside single-quoted -H arg");
assertUnchanged("Authorization: Bearer $TOKEN", "authorization-bearer env-var reference bare");

// --- PEM-style private key blocks collapse to a single marker -------------------
{
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA1234567890abcdefghijklmnop",
    "moreKeyMaterialHereMoreKeyMaterialHere==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const result = redactSecrets(`cat <<'EOF' > id_rsa\n${pem}\nEOF`);
  if (result.includes("MIIEpAIBAAKCAQEA1234567890abcdefghijklmnop")) {
    console.error(`FAIL (pem-private-key): key material leaked: ${result}`);
    process.exit(1);
  }
  if (!result.includes("[REDACTED PRIVATE KEY]")) {
    console.error(`FAIL (pem-private-key): expected collapsed marker: ${result}`);
    process.exit(1);
  }
  passed++;
}

// --- Negative: plain command with no secrets passes through unchanged -----------
assertUnchanged("git status", "plain command negative control");
assertUnchanged("npm install && npm test", "plain command negative control 2");

// --- Edge: $ENV_VAR references are NOT redacted ---------------------------------
// Intentional, not a gap: the hook sees the raw command text before shell/env
// expansion, so `$SOME_ENV_VAR` at this point is still literally the variable
// *name*, never the expanded secret value — there is nothing secret-shaped to
// catch. See bash-telemetry-redact.ts file header for the full rationale.
assertUnchanged("echo $SOME_ENV_VAR", "env-var reference bare");
assertUnchanged("curl --token $GH_TOKEN https://api.example.com", "env-var reference in --token flag value");
assertUnchanged("export FOO_TOKEN=$SOME_ENV_VAR", "env-var reference in assignment value");

console.log(`OK: ${passed} assertions passed`);
