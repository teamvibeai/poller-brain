import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../block-background-escapes.sh', import.meta.url));
const denied = [
  ['cmd &'],
  ['nohup cmd &'], // Explicitly allowed by #490; the gap addressed by #546.
  ['(cmd) &'],
  ['cmd > log 2>&1 &'],
  ['{ cmd; } &'],
  ['cmd & wait'],
  ['cmd & jobs'],
  ['cmd &; next'],
  ['cmd &\nnext'],
  ['(cmd &)'],
  ['{ cmd & }'],
  ['cmd & next'],
  ['cmd&'],
  ['cmd && other &'],
  ['cmd &>log &'],
  ['cmd & # background job'],
  ['echo "a&b"; cmd &'],
  ["cat <<EOF &\nbody &\nEOF\n"],
  ["cat <<EOF\nbody &\nEOF\ncmd &"],
  ['cmd \\& &'],
  ['cmd', { run_in_background: true }], // #490
  ['setsid cmd &'], // #490
  ['disown'], // #490
];
const allowed = [
  ['cmd && other'],
  ['cmd > log 2>&1'],
  ['cmd >&2'],
  ['cmd &>file'],
  ['cmd &>>file'],
  ['cmd |& other'],
  ["echo 'a&b'"],
  ['grep "a&b" file'],
  ['curl "https://example.com/?a=1&b=2"'],
  ["curl 'https://example.com/?a=1&b=2'"],
  ['wait'],
  ['jobs'],
  ['nohup cmd'],
  ['echo hello'], // #490 ordinary command
  ['echo \\&'],
  ['echo ok # cmd &'],
  ["cat <<EOF\ncmd &\nEOF\n"],
  ["cat <<'EOF'\ncmd &\nEOF\n"],
  ['cat <<"EOF"\ncmd &\nEOF\n'],
  ["cat <<-EOF\n\tcmd &\n\tEOF\n"],
  ["cat <<ONE <<'TWO'\ncmd &\nONE\nother &\nTWO\n"],
  ['echo "escaped \\" quote &"'],
  ['echo "<<EOF"; echo ok'],
  ['cat <<< "a&b"'],
  ['cmd', { run_in_background: false }],
];
let failures = 0;
for (const [expected, cases] of [['deny', denied], ['allow', allowed]]) {
  for (const [command, extra = {}] of cases) {
    const result = spawnSync('bash', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, ...extra } }),
      encoding: 'utf8',
    });
    try {
      assert.ifError(result.error);
      assert.equal(result.status, expected === 'deny' ? 2 : 0, 'exit status');
      assert.equal(result.stdout, '', 'no stdout protocol');
      if (expected === 'deny') {
        assert.match(result.stderr, /bg-task\.mjs/);
      } else {
        assert.equal(result.stderr, '', 'no warning for allowed command');
      }
    } catch (error) {
      failures++;
      console.error(`FAIL ${expected}: ${JSON.stringify(command)}${extra.run_in_background === true ? ' (run_in_background: true)' : ''}: ${error.message}`);
    }
  }
}
console.log(`${denied.length} denied / ${allowed.length} allowed cases; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
