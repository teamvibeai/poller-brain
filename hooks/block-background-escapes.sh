#!/bin/bash
# PreToolUse hook: deny Bash(run_in_background: true), manual setsid/disown
# detachment and plain shell backgrounding; use background-task (bg-task.mjs).
#
# Why: two independent bare `claude -p` tests (2026-09-22, poller-brain#478
# thread) confirmed run_in_background never survives past the end of the
# current turn -- Claude Code's own internal task manager kills it itself
# the moment the turn ends, regardless of our poller's watchdog or output
# format. An agent reaching for it to wait on something with an external
# waiting party (CI watch, deploy watch) silently loses the result. bg-task
# is the only path proven to survive, because it detaches via setsid into
# its own process group -- outside the reach of the session's own cleanup.
#
# setsid/disown typed directly into a plain Bash command is the same trick
# done by hand, without bg-task's safety net: no TTL, no tracking, no
# .inbox delivery. Worse than run_in_background -- it neither reports a
# result nor ever gets cleaned up, becoming a permanent untracked leak on
# shared poller storage. Plain shell backgrounding (including `nohup cmd &`)
# is blocked too (poller-brain#546): those children stay in the session's
# process group and die with turn/session cleanup, silently losing work.
# Foreground nohup alone is still allowed.
#
# Command-string pattern matching is not airtight (obfuscation is possible
# in principle) -- acceptable here since agents aren't adversarial, just
# reaching for familiar Unix patterns. See poller-brain#488.

node -e '
let data = "";
process.stdin.on("data", (d) => { data += d; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(0);
  }

  if (input?.tool_name !== "Bash") process.exit(0);

  const toolInput = input.tool_input || {};
  if (typeof toolInput.command !== "string") process.exit(0);
  const command = toolInput.command;

  const deny = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  };

  if (toolInput.run_in_background === true) {
    deny(
      "Bash(run_in_background: true) never survives past the end of this turn " +
      "-- Claude Code kills it itself the moment the turn ends (confirmed " +
      "empirically, poller-brain#478/#488). Use the background-task skill " +
      "(bg-task.mjs) for anything that needs to outlive this turn."
    );
    return;
  }

  if (/\bsetsid\b/.test(command) || /\bdisown\b/.test(command)) {
    deny(
      "setsid/disown manually re-implements the detachment trick bg-task " +
      "uses internally, without its safety net (no TTL, no tracking, no " +
      "delivery) -- the process escapes cleanup but never reports a " +
      "result, becoming a permanent untracked leak. Use the background-task " +
      "skill (bg-task.mjs) instead."
    );
    return;
  }

  // Classify operators only in executable shell context. Collect a candidate
  // first; an uncertain/unclosed construct anywhere makes this scan fail open.
  // This is a lexer, not a Bash grammar/evaluator. Parameter/arithmetic data
  // and heredoc bodies are opaque; executable substitutions are scanned anew.
  function hasBackground(source) {
    const SQ = String.fromCharCode(39);
    let i = 0;
    let background = false;
    const uncertain = () => { throw new Error("Unclassified shell syntax"); };
    const starts = (text) => source.startsWith(text, i);
    const arrayWord = /[A-Za-z_][A-Za-z0-9_]*(?:\+?=\(|\[)/y;
    const boundary = (c) => c === undefined || /[\s;&|<>()]/.test(c);
    const escape = () => {
      if (i + 1 >= source.length) uncertain();
      i += 2;
    };

    function quote(kind, inspect) {
      i++; // Opening quote (the dollar prefix, if any, is already consumed).
      while (i < source.length) {
        if (source[i] === (kind === "double" ? "\"" : SQ)) { i++; return; }
        if (kind !== "single" && source[i] === "\\") { escape(); continue; }
        if (kind === "double" && expansion(inspect, true)) continue;
        if (kind === "double" && source[i] === "`") { backtick(inspect); continue; }
        i++;
      }
      uncertain();
    }

    function backtick(inspect) {
      i++;
      let body = "";
      // Legacy substitution removes these backslashes before parsing its body.
      // Its terminating backtick is found before the inner shell parses quotes.
      while (i < source.length) {
        if (source[i] === "`") {
          i++;
          const found = hasBackground(body);
          if (inspect && found) background = true;
          return;
        }
        if (source[i] === "\\") {
          if (i + 1 >= source.length) uncertain();
          const next = source[i + 1];
          if ("$`\\\n".includes(next)) {
            if (next !== "\n") body += next;
            i += 2;
            continue;
          }
        }
        body += source[i++];
      }
      uncertain();
    }

    function parameter() {
      i += 2;
      let braces = 1;
      while (i < source.length) {
        if (source[i] === "\\") { escape(); continue; }
        if (source[i] === SQ) { quote("single", false); continue; }
        if (source[i] === "\"") { quote("double", false); continue; }
        if (expansion(false)) continue;
        if (source[i] === "`") { backtick(false); continue; }
        if (source[i] === "{") braces++;
        if (source[i++] === "}" && --braces === 0) return;
      }
      uncertain();
    }

    function arithmetic(prefix) {
      i += prefix;
      let parentheses = 0;
      while (i < source.length) {
        if (!parentheses && starts("))")) { i += 2; return; }
        if (source[i] === "\\") { escape(); continue; }
        if (source[i] === SQ) { quote("single", false); continue; }
        if (source[i] === "\"") { quote("double", false); continue; }
        if (expansion(false)) continue;
        if (source[i] === "`") { backtick(false); continue; }
        if (source[i] === "(") parentheses++;
        if (source[i] === ")" && --parentheses < 0) uncertain();
        i++;
      }
      uncertain();
    }

    function expansion(inspect, quoted = false) {
      if (!quoted && starts("$" + SQ)) { i++; quote("ansi", false); }
      else if (!quoted && starts("$\"")) { i++; quote("double", inspect); }
      else if (starts("${")) parameter();
      else if (starts("$((")) arithmetic(3);
      else if (starts("$(")) { i += 2; shell(")", inspect); }
      else if (starts("$[")) uncertain(); // Legacy arithmetic is not classified.
      else return false;
      return true;
    }

    function conditional(inspect) {
      i += 2;
      while (i < source.length) {
        if (starts("]]") && /\s/.test(source[i - 1]) && boundary(source[i + 2])) { i += 2; return; }
        // Regex character classes can contain apparent closing brackets.
        if (starts("=~")) uncertain();
        if (source[i] === "\\") { escape(); continue; }
        if (source[i] === SQ) { quote("single", false); continue; }
        if (source[i] === "\"") { quote("double", inspect); continue; }
        if (expansion(inspect)) continue;
        if (source[i] === "`") { backtick(inspect); continue; }
        i++;
      }
      uncertain();
    }

    function delimiter() {
      let value = "";
      let word = false;
      while (i < source.length && !/[\s<>&|;()]/.test(source[i])) {
        word = true;
        if (source[i] === SQ || source[i] === "\"") {
          const kind = source[i++];
          while (i < source.length && source[i] !== kind) {
            if (kind === "\"" && source[i] === "\\") {
              if (i + 1 >= source.length) uncertain();
              const next = source[i + 1];
              // In double quotes, other backslashes survive quote removal.
              if ("$`\"\\\n".includes(next)) {
                if (next !== "\n") value += next;
                i += 2;
                continue;
              }
            }
            value += source[i++];
          }
          if (i === source.length) uncertain();
          i++;
        } else if (source[i] === "\\") {
          if (i + 1 >= source.length) uncertain();
          if (source[i + 1] !== "\n") value += source[i + 1];
          i += 2;
        } else {
          // Expansion-like delimiter words have special Bash parsing rules;
          // ANSI-C/localized delimiter decoding is deliberately unsupported.
          if (source[i] === "$" || source[i] === "`") uncertain();
          value += source[i++];
        }
      }
      if (!word) uncertain();
      return value;
    }

    function bodies(heredocs) {
      for (const { value, stripTabs } of heredocs) {
        let terminated = false;
        while (i < source.length) {
          const newline = source.indexOf("\n", i);
          const end = newline < 0 ? source.length : newline;
          const line = source.slice(i, end);
          i = newline < 0 ? source.length : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === value) {
            terminated = true;
            break;
          }
        }
        if (!terminated) uncertain();
      }
      heredocs.length = 0;
    }

    function shell(stop = "", inspect = true) {
      const heredocs = [];
      let word = false;
      while (i < source.length) {
        const c = source[i];
        // Continuations inside an operator/opener require token reassembly.
        // Do not guess whether the fragments form &&, <<, $((, an extglob, etc.
        if (/[$&|<>()\[\]{}?*+@!]/.test(c) && source.startsWith("\\\n", i + 1)) uncertain();
        if (stop && c === stop && (stop !== "}" || (!word && boundary(source[i + 1])))) {
          if (heredocs.length) uncertain();
          i++;
          return;
        }
        if (c === "\\") {
          const continuation = source[i + 1] === "\n";
          escape();
          if (!continuation) word = true;
          continue;
        }
        if (c === "#" && !word) {
          const newline = source.indexOf("\n", i);
          i = newline < 0 ? source.length : newline;
          continue;
        }
        if (c === SQ) { quote("single", false); word = true; continue; }
        if (c === "\"") { quote("double", inspect); word = true; continue; }
        if (expansion(inspect)) { word = true; continue; }
        if (c === "`") { backtick(inspect); word = true; continue; }
        if (!word) {
          // Array assignments/subscripts need Bash word/assignment grammar.
          arrayWord.lastIndex = i;
          if (arrayWord.test(source)) uncertain();
        }
        // Extended-glob parentheses can contain literal shell metacharacters.
        if ("?*+@!".includes(c) && source[i + 1] === "(") uncertain();
        if (!word && c === "{" && boundary(source[i + 1])) {
          i++; shell("}", inspect); word = false; continue;
        }
        if (!word && c === "}" && boundary(source[i + 1])) uncertain();
        if (!word && starts("[[") && /\s/.test(source[i + 2] || "")) { conditional(inspect); continue; }
        if (starts("((")) { arithmetic(2); word = false; continue; }
        if (c === "(") { i++; shell(")", inspect); word = false; continue; }
        if (c === ")") uncertain(); // Includes case patterns: needs full grammar.
        if (starts("<<<")) {
          // The following word uses the same quote/expansion readers. Literal
          // ampersands inside it stay data; an unquoted & still ends the word.
          i += 3; word = false; continue;
        }
        if (starts("<<")) {
          i += 2;
          const stripTabs = source[i] === "-";
          if (stripTabs) i++;
          while (source[i] === " " || source[i] === "\t") i++;
          heredocs.push({ value: delimiter(), stripTabs });
          word = true;
          continue;
        }
        // Consume the other ampersand-bearing operators before a lone &.
        const operator = /^(?:&&|&>>?|[<>]&|\|&)/.exec(source.slice(i, i + 3));
        if (operator) { i += operator[0].length; word = false; continue; }
        if (c === "&" && inspect) background = true;
        i++;
        if (c === "\n") bodies(heredocs);
        word = !/[\s;&|<>()]/.test(c);
      }
      if (stop || heredocs.length) uncertain();
    }

    shell();
    return background;
  }

  let background = false;
  try {
    background = hasBackground(command);
  } catch {
    // Unknown syntax, unclosed contexts/heredocs, or excessive nesting: allow.
    // Earlier #490 run_in_background and setsid/disown checks remain intact.
    process.exit(0);
  }
  if (background) {
    deny(
      "Plain shell backgrounding (cmd &, including nohup cmd &) dies with " +
      "turn/session cleanup and can silently lose work (poller-brain#546). " +
      "Use the background-task skill (bg-task.mjs) for anything that needs " +
      "to outlive this turn."
    );
    return;
  }

  process.exit(0);
});
'
