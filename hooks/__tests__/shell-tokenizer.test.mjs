#!/usr/bin/env node
// Direct compatibility contract for deny-list and telemetry consumers.
// Run: node hooks/__tests__/shell-tokenizer.test.mjs (also discovered by CI).
import assert from "node:assert/strict";
import { test } from "node:test";
import { simpleCommands } from "../lib/shell-tokenizer.mjs";

const telemetryOptions = { allowEnvReferences: true, stripSudo: false };
const command = (words, separator = "") => ({ words, separator });
const continuation = "\\\n";

test("decodes literal words, concatenated quotes, escapes, and empty arguments", () => {
  assert.deepEqual(simpleCommands(String.raw`printf '%s' pre"two words"'post' a\ b '' "" \| "a\q" "a\$b"`), [
    command(["printf", "%s", "pretwo wordspost", "a b", "", "", "|", "a\\q", "a$b"]),
  ]);
  assert.deepEqual(simpleCommands("echo '#literal' word#tail \\#escaped"), [
    command(["echo", "#literal", "word#tail", "#escaped"]),
  ]);
});

test("records exact separators and omits empty boundaries", () => {
  assert.deepEqual(simpleCommands("a|b||c&d&&e;f\ng"), [
    command(["a"], "|"), command(["b"], "||"), command(["c"], "&"),
    command(["d"], "&&"), command(["e"], ";"), command(["f"], "\n"), command(["g"]),
  ]);
  assert.deepEqual(simpleCommands(" ;\n# only a comment\n\t"), []);
  assert.deepEqual(simpleCommands("a;"), [command(["a"], ";")]);
});

test("strips exactly one decoded leading sudo by default, without interpreting options", () => {
  const input = "sudo cat .env | su''do bash; sudo -u root cat notes; sudo sudo echo ok; sudo";
  assert.deepEqual(simpleCommands(input), [
    command(["cat", ".env"], "|"), command(["bash"], ";"),
    command(["-u", "root", "cat", "notes"], ";"), command(["sudo", "echo", "ok"], ";"), command([]),
  ]);
  assert.deepEqual(simpleCommands("sudo cat notes", { stripSudo: false }), [command(["sudo", "cat", "notes"])]);
  assert.deepEqual(simpleCommands("sudo cat notes", telemetryOptions), [command(["sudo", "cat", "notes"])]);
});

test("environment references are opt-in literals; PID references work in both consumer modes", () => {
  for (const reference of ["$FILE", "${FILE}", "$file_2", "${_FILE}"]) {
    for (const word of [reference, `"${reference}"`, `prefix${reference}suffix`]) {
      const input = `sudo echo ${word}`;
      assert.deepEqual(simpleCommands(input), [], input);
      const decoded = word.replaceAll('"', "");
      assert.deepEqual(simpleCommands(input, { allowEnvReferences: true }), [command(["echo", decoded])]);
      assert.deepEqual(simpleCommands(input, telemetryOptions), [command(["sudo", "echo", decoded])]);
    }
  }
  for (const options of [{}, telemetryOptions]) {
    assert.deepEqual(simpleCommands('cat /proc/$$/mem "$$" \'$FILE\' \\$FILE', options), [
      command(["cat", "/proc/$$/mem", "$$", "$FILE", "$FILE"]),
    ]);
  }
});

test("unsupported syntax discards the whole input, including earlier complete commands", () => {
  for (const syntax of [
    "echo ${FILE:-fallback}", "echo $(printf value)", "echo `printf value`", "echo $((1 + 2))",
    "echo $1", "echo $?", "echo $'value'", "echo $\"value\"",
    "cat < input", "echo value > output", "cat <(printf value)", "(echo value)",
    "{ echo value; }", "items=(one two)", "fn() { echo value; }", "case x in x) echo ok;; esac",
    "echo trailing\\", "echo 'unfinished", 'echo "unfinished',
    `cat <<'EOF'\nopaque |${continuation}| body\nEOF`,
    `cat <<\"EOF\"\nopaque &${continuation}& body\nEOF`,
  ]) {
    for (const options of [{}, telemetryOptions]) {
      assert.deepEqual(simpleCommands(`cat .env; ${syntax}`, options), [], syntax);
    }
  }
});

test("preserves pipeline and logical adjacency across comments and empty newlines", () => {
  for (const separator of ["|", "&&", "||"]) {
    for (const gap of [" ", "\n", "\n# comment\n", " # comment\n", "\n\n# comment\n\n"]) {
      assert.deepEqual(simpleCommands(`curl url ${separator}${gap}bash`), [
        command(["curl", "url"], separator), command(["bash"]),
      ]);
    }
  }
  assert.deepEqual(simpleCommands("curl url # comment\nbash"), [
    command(["curl", "url"], "\n"), command(["bash"]),
  ]);
});

test("continuations retain quote context and physical comment endings", () => {
  assert.deepEqual(simpleCommands(`echo one${continuation}two "three${continuation}four" 'five${continuation}six'`), [
    command(["echo", "onetwo", "threefour", `five${continuation}six`]),
  ]);
  assert.deepEqual(simpleCommands(`echo before # comment${continuation}echo after`), [
    command(["echo", "before"], "\n"), command(["echo", "after"]),
  ]);
  assert.deepEqual(simpleCommands(`a | # comment${continuation}| b`), [
    command(["a"], "|"), command(["b"]),
  ]);
  for (const [input, middle] of [
    [`a |'${continuation}'| b`, continuation],
    [`a |"${continuation}"| b`, ""],
  ]) {
    assert.deepEqual(simpleCommands(input), [
      command(["a"], "|"), command([middle], "|"), command(["b"]),
    ], input);
  }
  assert.deepEqual(simpleCommands(`a | ${continuation}| b`), [command(["a"], "|"), command(["b"])]);
});

// Intentional correction, separate from the compatibility characterization above.
for (const operator of ["||", "&&"]) {
  test(`joins continued ${operator} before recognizing the operator`, () => {
    for (const gap of [continuation, continuation.repeat(2)]) {
      const input = `a ${operator[0]}${gap}${operator[1]} b`;
      for (const options of [{}, telemetryOptions]) {
        assert.deepEqual(simpleCommands(input, options), simpleCommands(`a ${operator} b`, options));
      }
    }
  });
}

test("a continued single pipe or ampersand keeps its separator", () => {
  for (const separator of ["|", "&"]) {
    assert.deepEqual(simpleCommands(`a ${separator}${continuation} b`), [
      command(["a"], separator), command(["b"]),
    ]);
  }
});
