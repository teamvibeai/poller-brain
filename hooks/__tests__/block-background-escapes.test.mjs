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
// Keep every review row individually numbered, including the non-Bash payloads.
const matrix = [
  ["matrix 1", "allow", {"tool_name": "Bash", "tool_input": {"command": "sed 's/x/&y/' file"}}],
  ["matrix 2", "allow", {"tool_name": "Bash", "tool_input": {"command": "sed -i '' \"s/a/& b/\" file"}}],
  ["matrix 3", "allow", {"tool_name": "Bash", "tool_input": {"command": "awk '$1 ~ /a&b/ { print $0 }' file"}}],
  ["matrix 4", "allow", {"tool_name": "Bash", "tool_input": {"command": "perl -pe 's/a/&b/g' file"}}],
  ["matrix 5", "allow", {"tool_name": "Bash", "tool_input": {"command": "echo $((a & b))"}}],
  ["matrix 6", "allow", {"tool_name": "Bash", "tool_input": {"command": "(( a &= b ))"}}],
  ["matrix 7", "allow", {"tool_name": "Bash", "tool_input": {"command": "[[ $a == x && $b ]]"}}],
  ["matrix 8", "allow", {"tool_name": "Bash", "tool_input": {"command": "[[ $((a & b)) == 1 ]]"}}],
  ["matrix 9", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' $(cmd1 && cmd2)"}}],
  ["matrix 10", "allow", {"tool_name": "Bash", "tool_input": {"command": "echo `cmd1 && cmd2`"}}],
  ["matrix 11", "allow", {"tool_name": "Bash", "tool_input": {"command": "curl https://example.com/?a=1\\&x=1"}}],
  ["matrix 12", "allow", {"tool_name": "Bash", "tool_input": {"command": "find . -exec sh -c 'printf \"%s\\n\" \"a & b\"' \\;"}}],
  ["matrix 13", "allow", {"tool_name": "Bash", "tool_input": {"command": "npm test 2>&1 | tee /tmp/test.log"}}],
  ["matrix 14", "allow", {"tool_name": "Bash", "tool_input": {"command": "echo one && \\\necho two"}}],
  ["matrix 15", "allow", {"tool_name": "Bash", "tool_input": {"command": "while read -r line; do\nprintf '%s\\n' \"$line\" | cat\ndone < /dev/null"}}],
  ["matrix 16", "allow", {"tool_name": "Bash", "tool_input": {"command": "kill %1"}}],
  ["matrix 17", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf x | cat; wait $pid"}}],
  ["matrix 18", "deny", {"tool_name": "Bash", "tool_input": {"command": "python3 - <<'PY' &\nprint('hello & world')\nPY\n"}}],
  ["matrix 19", "allow", {"tool_name": "Bash", "tool_input": {"command": "python3 - <<'PY'\nvalue = 3 & 1\nprint(value)\nPY\nprintf done"}}],
  ["matrix 20", "allow", {"tool_name": "Bash", "tool_input": {"command": "curl --data 'a=1&b=2' https://example.com"}}],
  ["matrix 21", "deny", {"tool_name": "Bash", "tool_input": {"command": "curl https://example.com/?a=1&b=2"}}],
  ["matrix 22", "allow", {"tool_name": "Bash", "tool_input": {"command": "git log --format='%an & %ae'"}}],
  ["matrix 23", "allow", {"tool_name": "Bash", "tool_input": {"command": "npx tsx script.ts \"x & y\""}}],
  ["matrix 24", "deny", {"tool_name": "Bash", "tool_input": {"command": "printf '%s' 'a' & "}}],
  ["matrix 25", "allow", {"tool_name": "Bash", "tool_input": {"command": "echo \"ends with \\\"quote &\""}}],
  ["matrix 26", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' \"$(printf \"%s\" \"x & y\")\""}}],
  ["matrix 27", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' $'it\\'s & fine'"}}],
  ["matrix 28", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' $'x & y'"}}],
  ["matrix 29", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' \"${value//x/&}\""}}],
  ["matrix 30", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' ${value//x/&}"}}],
  ["matrix 31", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<E\"O\"'F'\ntext & text\nEOF\nprintf done"}}],
  ["matrix 32", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<\\EOF\ntext & text\nEOF\nprintf done"}}],
  ["matrix 33", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<-'END MARK'\n\ttext & text\n\tEND MARK\nprintf done"}}],
  ["matrix 34", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<'A' <<-\"B\"\nfirst &\nA\n\tsecond &\n\tB\nprintf done"}}],
  ["matrix 35", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<< $'it\\'s & fine'"}}],
  ["matrix 36", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<< \"$(printf \"%s\" \"x & y\")\""}}],
  ["matrix 37", "deny", {"tool_name": "Bash", "tool_input": {"command": "echo \"$(sleep 10 &)\""}}],
  ["matrix 38", "deny", {"tool_name": "Bash", "tool_input": {"command": "echo `sleep 10 &`"}}],
  ["matrix 39", "deny", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' $'it\\'s' &"}}],
  ["matrix 40", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<'EOF' # a comment with &\nhello &\nEOF\nprintf done"}}],
  ["matrix 41", "deny", {"tool_name": "Bash", "tool_input": {"command": "echo $((1 << 2))\nsleep 10 &"}}],
  ["matrix 42", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<\"E\\\"OF\"\nhello &\nE\"OF\nprintf '%s' 'a & b'"}}],
  ["matrix 43", "deny", {"tool_name": "Bash", "tool_input": {"command": "cat <<\"E\\\"OF\"\nhello\nE\"OF\nsleep 10 &"}}],
  ["matrix 44", "allow", {"tool_name": "Bash", "tool_input": {"command": "cat <<''\nhello &\n\nprintf done"}}],
  ["matrix 45", "allow", {"tool_name": "Bash", "tool_input": {"command": "bash -c 'echo \"$((1 & 3))\"; echo \"a & b\"'"}}],
  ["matrix 46", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' \"${v:-\"a & b\"}\""}}],
  ["matrix 47", "allow", {"tool_name": "Bash", "tool_input": {"command": "case $x in 'a&b') printf ok;; *) printf no;; esac"}}],
  ["matrix 48", "allow", {"tool_name": "Bash", "tool_input": {"command": "printf '%s\\n' `printf '%s' 'a & b'`"}}],
  ["matrix 49", "deny", {"tool_name": "Bash", "tool_input": {"command": "while true; do\nsleep 10 &\nbreak\ndone"}}],
  ["matrix 50", "allow", {"tool_name": "Bash", "tool_input": {"command": "echo $((1 << 2)); printf 'a & b'"}}],
  ["matrix 51", "allow", {"tool_name": "Bash", "tool_input": {"description": "No command"}}],
  ["matrix 52", "allow", {"tool_name": "Bash", "tool_input": {}}],
  ["matrix 53", "allow", {"tool_name": "Read", "tool_input": {"file_path": "a&b"}}],
  ["matrix 54", "allow", {"tool_name": "Other", "tool_input": {"command": "echo x &"}}],
  ["matrix 55", "allow", {"tool_name": "Agent", "tool_input": {"prompt": "work", "run_in_background": true}}],
];

// Explicit finding 2/3 examples, plus context boundaries and fail-open behavior.
const regression = [
  ['allow', String.raw`printf '%s\n' "$(printf "%s" "x & y")"`],
  ['allow', String.raw`printf '%s\n' $'it\'s & fine'`],
  ['allow', String.raw`cat <<< $'it\'s & fine'`],
  ['allow', 'echo "${v:-"a & b"}"'],
  ['deny', 'echo "$(sleep 10 &)"'],
  ['deny', 'echo $((1 << 2))\nsleep 10 &'],
  ['deny', 'cat <<"E\\"OF"\nhello\nE"OF\nsleep 10 &'],
  ['allow', 'echo ${v:-${other:-a&b}}'],
  ['allow', 'echo $(((1 & 3) << 2))'],
  ['deny', '(( a <<= 1 )); sleep 10 &'],
  ['deny', 'echo "$(echo "$(sleep 10 &)")"'],
  ['allow', 'echo "$(echo "$(printf "%s" "a & b")")"'],
  ['deny', 'cat <<< "$(sleep 10 &)"'],
  ['deny', 'echo `printf "%s" "a & b"; sleep 10 &`'],
  ['deny', "cat <<''\nhello &\n\nsleep 10 &"],
  ['deny', 'cat <<ONE <<-"TWO"\nhello &\nONE\n\tworld &\n\tTWO\nsleep 10 &'],
  ['allow', "echo 'unclosed &"],
  ['allow', 'sleep 10 &; echo "unclosed'],
  ['allow', "sleep 10 &; echo $'unclosed"],
  ['allow', 'sleep 10 &; echo ${unclosed'],
  ['allow', 'sleep 10 &; echo $((1 << 2)'],
  ['allow', 'sleep 10 &; echo $(unclosed'],
  ['allow', 'sleep 10 &; echo `unclosed'],
  ['allow', 'sleep 10 &; cat <<EOF\nunclosed'],
  ['allow', 'sleep 10 &; echo \\'],
  ['allow', '(sleep 10 &'],
  ['allow', '{ sleep 10 &'],
  ['allow', 'sleep 10 &; [[ unclosed'],
  ['allow', 'sleep 10 &; [[ x =~ [a&b] ]]'],
  ['allow', 'sleep 10 &; echo $[1&3]'],
  ['allow', 'sleep 10 &; cat <<'],
  ['allow', "sleep 10 &; cat <<$'EOF'\nhello\nEOF\n"],
  ['allow', 'sleep 10 &; cat <<$EOF\nhello\n$EOF\n'],
  ['allow', 'case x in x) sleep 10 &;; esac'],
  ['allow', "printf '%s' @(a&b)"],
  ['allow', 'items[1&2]=value'],
  ['allow', 'items=([1&2]=value)'],
  ['deny', 'echo <(sleep 10 &)'],
  ['allow', 'echo <(printf "a & b")'],
  ['deny', 'cat <<\"E\\xOF\"\nhello\nE\\xOF\nsleep 10 &'],
  ['deny', 'echo x#literal &'],
  ['allow', '[[ x == []] ]]'],
  ['deny', '[[ x == []] ]]; sleep 10 &'],
  ['allow', "echo \"$'a & b\""],
  ['deny', "echo \"$'a\" &"],
  ['allow', 'printf "%s$" "a & b"'],
  ['deny', 'printf "%s$" "a & b" &'],
  ['allow', 'cmd &\\\n& other'],
  ['allow', 'cmd |\\\n& other'],
  ['allow', 'cat <\\\n<EOF\nbody &\nEOF\n'],
  ['allow', 'echo $\\\n((a & b))'],
  ['deny', 'cmd && \\\nother &'],
];
const cases = [
  ...denied.map(([command, extra = {}], i) => [`original deny ${i + 1}`, 'deny', { tool_name: 'Bash', tool_input: { command, ...extra } }]),
  ...allowed.map(([command, extra = {}], i) => [`original allow ${i + 1}`, 'allow', { tool_name: 'Bash', tool_input: { command, ...extra } }]),
  ...matrix,
  ['Bash without command', 'allow', { tool_name: 'Bash', tool_input: { run_in_background: true } }],
  ['Bash non-string command', 'allow', { tool_name: 'Bash', tool_input: { command: null, run_in_background: true } }],
  ...regression.map(([expected, command], i) => [`regression ${i + 1}`, expected, { tool_name: 'Bash', tool_input: { command } }]),
];
let failures = 0;
for (const [label, expected, payload] of cases) {
  const result = spawnSync('bash', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  try {
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'exit status');
    assert.equal(result.stderr, '', 'silent stderr');
    if (expected === 'deny') {
      const response = JSON.parse(result.stdout);
      const reason = response.hookSpecificOutput?.permissionDecisionReason;
      assert.equal(typeof reason, 'string');
      assert.match(reason, /bg-task\.mjs/);
      assert.deepEqual(response, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }, 'original stdout JSON denial contract');
    } else {
      assert.equal(result.stdout, '', 'silent stdout');
    }
  } catch (error) {
    failures++;
    console.error(`FAIL ${label} (${expected}): ${JSON.stringify(payload)}: ${error.message}`);
  }
}
const denyCount = cases.filter(([, expected]) => expected === 'deny').length;
console.log(`${cases.length} total: ${denyCount} denied / ${cases.length - denyCount} allowed cases; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
