#!/bin/bash
# PreToolUse hook: deny Bash(run_in_background: true), manual setsid/disown
# detachment and plain shell backgrounding; use background-task (bg-task.mjs).
#
# Scanner contract: deny only when certain; uncertain segments allow silently.
# Opaque to bare &: quotes (including $'...'), ${...}, arithmetic, [[ ]],
# case patterns and heredoc bodies. Executable $(...), backticks and process
# substitutions recurse, including inside expandable words/terminated heredocs.
# Logical tokens join backslash-newline except in literal quotes/comments and
# quoted heredoc bodies. Readers commit only balanced, understood constructs;
# uncertainty rolls back their candidates, preserving independent segments.
# Deny: command-list &, command-position coproc, plus the existing independent
# setsid/disown text checks and run_in_background flag. Denials keep exit 0 and
# stdout JSON; allowed calls emit nothing. This is a lexer, not a Bash parser.
# Known limits: EOF-terminated expandable heredoc substitutions; exotic ANSI-C /
# Unicode heredoc delimiters needing byte/locale semantics; unclassified array
# words containing bare brackets (their siblings may be missed); unmodeled
# function compound bodies; unparseable or excessively nested syntax.
# Allowing uncertainty avoids blocking valid work; the Stop hook and
# background-task skill remain the safety net.
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

  // This lexer classifies command-list operators, not shell evaluation. Literal
  // spans suppress bare ampersands but still inspect executable substitutions.
  // A reader commits its result only after finding its own balanced closer.
  function hasBackground(source, dataOnly = false) {
    const SQ = String.fromCharCode(39);
    let i = 0;
    let background = false;
    let functionDepth = 0;
    const uncertain = () => { throw new Error("Unclassified shell syntax"); };
    const starts = (text) => source.startsWith(text, i);
    const boundary = (c) => c === undefined || /[\s;&|<>()]/.test(c);
    const keyword = (text) => starts(text) && boundary(source[i + text.length]);

    // Form logical tokens before recognizing operators/openers. Stop before
    // quotes and physical newlines: their readers own continuation handling,
    // especially literal single quotes and quoted-delimiter heredoc bodies.
    // Stop at # too: shell comments end at the physical newline.
    let logicalEnd = 0;
    function logical() {
      if (i < logicalEnd) return;
      let p = i;
      while (p < source.length && ![SQ, "\"", "`", "#", "\n"].includes(source[p])) {
        if (source[p] === "\\") {
          if (source[p + 1] === "\n") {
            source = source.slice(0, p) + source.slice(p + 2);
            continue;
          }
          p += 2;
        } else p++;
      }
      logicalEnd = p;
    }
    function escape() {
      if (i + 1 >= source.length) uncertain();
      i += 2;
    }

    // Recover only the unresolved word/construct up to the next list segment.
    // Quotes still protect separators. In particular an unfinished quote cannot
    // turn its literal text into an executable command on recovery.
    function recover(start) {
      i = start;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (c === SQ || c === "\"" || c === "`") {
          const q = source[i++];
          while (i < source.length && source[i] !== q) {
            if (q !== SQ && source[i] === "\\") i++;
            i++;
          }
          if (i < source.length) i++;
          continue;
        }
        if (/[\n;|]/.test(c) || starts("&&")) return;
        i++;
      }
    }
    function guarded(read) {
      const start = i;
      const saved = background;
      try { read(); }
      catch (error) {
        background = saved;
        // A function body must be understood as a whole compound command.
        // Its recovery text cannot supply command-position evidence.
        if (functionDepth) throw error;
        recover(start);
      }
    }

    function quote(kind) {
      i++;
      while (i < source.length) {
        if (kind === "double") logical();
        if (source[i] === (kind === "double" ? "\"" : SQ)) { i++; return; }
        if (kind !== "single" && source[i] === "\\") { escape(); continue; }
        if (kind === "double" && expansion(true)) continue;
        if (kind === "double" && source[i] === "`") { backtick(); continue; }
        i++;
      }
      uncertain();
    }
    function backtick() {
      i++;
      let body = "";
      // Backtick substitution removes these escapes before parsing its body.
      while (i < source.length) {
        if (source[i] === "`") {
          i++;
          if (hasBackground(body)) background = true;
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
    function parameter(quoted) {
      i += 2;
      while (i < source.length) {
        logical();
        if (source[i] === "}") { i++; return; }
        if (wordPart(quoted)) continue;
        // A bare { in a default value does not nest parameter expansions.
        i++;
      }
      uncertain();
    }
    function arithmetic(prefix, legacy = false) {
      i += prefix;
      let depth = 0;
      while (i < source.length) {
        logical();
        if (!depth && starts(legacy ? "]" : "))")) { i += legacy ? 1 : 2; return; }
        if (wordPart()) continue;
        if (source[i] === (legacy ? "[" : "(")) depth++;
        if (source[i] === (legacy ? "]" : ")") && --depth < 0) uncertain();
        i++;
      }
      uncertain();
    }
    function expansion(quoted = false) {
      if (!quoted && starts("$" + SQ)) { i++; quote("ansi"); }
      else if (!quoted && starts("$\"")) { i++; quote("double"); }
      else if (starts("${")) parameter(quoted);
      else if (starts("$((")) arithmetic(3);
      else if (starts("$[")) arithmetic(2, true);
      else if (starts("$(")) { i += 2; shell(")"); }
      else return false;
      return true;
    }
    function wordPart(quoted = false) {
      if (source[i] === "\\") escape();
      else if (!quoted && source[i] === SQ) quote("single");
      else if (source[i] === "\"") quote("double");
      else if (expansion(quoted)) { /* reader consumed it */ }
      else if (source[i] === "`") backtick();
      else if (!quoted && (source[i] === "<" || source[i] === ">") && source[i + 1] === "(") {
        i += 2; shell(")");
      } else return false;
      return true;
    }
    function conditional() {
      i += 2;
      while (i < source.length) {
        logical();
        // ]] is a reserved word: embedded regex/pattern brackets are data.
        if (starts("]]") && /\s/.test(source[i - 1]) && boundary(source[i + 2])) { i += 2; return; }
        if (wordPart()) continue;
        i++;
      }
      uncertain();
    }
    function opaque(close, array = false) {
      // Arrays, subscripts and extended globs are words, not command lists.
      // Their bare & may even be invalid Bash; it must never imply a launch.
      const saved = background;
      let certain = true;
      i++;
      try {
        while (i < source.length) {
          logical();
          if (source[i] === close) {
            i++;
            if (!certain) background = saved;
            return certain;
          }
          if (wordPart()) continue;
          if (source[i] === "(") { if (!opaque(")", array)) certain = false; continue; }
          if (source[i] === "[") {
            // A bare bracket in an array word need not have a matching ].
            // Do not guess subscript grammar or recover through sibling $().
            if (array) { certain = false; i++; }
            else opaque("]");
            continue;
          }
          i++;
        }
        uncertain();
      } catch (error) {
        if (certain) throw error;
        // No certain boundary remains: the unresolved array consumes the rest.
        // Recovery must never reinterpret its case terminators as launches.
        background = saved;
        i = source.length;
        return false;
      }
    }

    function ansiDelimiter() {
      i += 2;
      let value = "";
      let known = true;
      const escapes = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
      while (i < source.length) {
        if (source[i] === SQ) { i++; return { value: value.split("\0")[0], known }; }
        if (source[i] !== "\\") { value += source[i++]; continue; }
        i++;
        const c = source[i++];
        if (c === undefined) uncertain();
        if (c === "\n") { value += "\\\n"; continue; }
        if (c === "\\" || c === SQ || c === "\"") { value += c; continue; }
        if (Object.hasOwn(escapes, c)) { value += escapes[c]; continue; }
        const pattern = c === "x" ? /^[0-9a-fA-F]{1,2}/ : c === "u" ? /^[0-9a-fA-F]{1,4}/ : c === "U" ? /^[0-9a-fA-F]{1,8}/ : /[0-7]/.test(c) ? /^[0-7]{1,3}/ : null;
        if (pattern) {
          const offset = /[0-7]/.test(c) ? i - 1 : i;
          const digits = pattern.exec(source.slice(offset));
          if (!digits) { value += "\\" + c; continue; }
          const code = parseInt(digits[0], /[0-7]/.test(c) ? 8 : 16);
          // Non-ASCII escapes and invalid Unicode need byte/locale semantics.
          // Keep their entire heredoc opaque rather than guess a terminator.
          if (code > 127) known = false;
          else value += String.fromCodePoint(code);
          i = offset + digits[0].length;
          continue;
        }
        if (c === "c") {
          const control = source[i++];
          if (control === undefined) uncertain();
          const code = control === "?" ? 127 : control.toUpperCase().charCodeAt(0) & 31;
          if (control === "\\") known = false;
          else value += String.fromCharCode(code);
          continue;
        }
        value += "\\" + c;
      }
      uncertain();
    }
    function delimiter() {
      let value = "";
      let word = false;
      let quoted = false;
      let known = true;
      while (i < source.length) {
        logical();
        if (/[\s<>&|;()]/.test(source[i])) break;
        word = true;
        if (starts("$" + SQ)) {
          quoted = true;
          const decoded = ansiDelimiter();
          value += decoded.value;
          known = known && decoded.known;
          continue;
        }
        if (starts("$\"")) { quoted = true; i++; }
        if (source[i] === SQ || source[i] === "\"") {
          quoted = true;
          const kind = source[i++];
          while (i < source.length && source[i] !== kind) {
            if (kind === "\"" && source[i] === "\\") {
              if (i + 1 >= source.length) uncertain();
              const next = source[i + 1];
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
          quoted = true;
          if (i + 1 >= source.length) uncertain();
          value += source[i + 1];
          i += 2;
        } else {
          // Bash does not expand an ordinary $ in a delimiter word.
          value += source[i++];
        }
      }
      if (!word) uncertain();
      return { value, quoted, known };
    }
    function bodies(heredocs) {
      for (const { value, quoted, known, stripTabs } of heredocs) {
        if (!known) uncertain();
        let terminated = false;
        let body = "";
        while (i < source.length) {
          let line = "";
          let continued;
          do {
            const newline = source.indexOf("\n", i);
            const end = newline < 0 ? source.length : newline;
            let physical = source.slice(i, end);
            i = newline < 0 ? source.length : end + 1;
            const slashes = /\\+$/.exec(physical)?.[0].length || 0;
            continued = !quoted && newline >= 0 && slashes % 2 === 1;
            if (continued) physical = physical.slice(0, -1);
            line += physical;
          } while (continued && i < source.length);
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === value) {
            terminated = true;
            break;
          }
          body += line + "\n";
        }
        if (!terminated) uncertain();
        if (!quoted && hasBackground(body, true)) background = true;
      }
      heredocs.length = 0;
    }

    function caseStatement() {
      i += 4;
      // The selector is a word; substitutions in it can execute.
      while (i < source.length) {
        logical();
        if (keyword("in") && /\s/.test(source[i - 1])) { i += 2; break; }
        if (wordPart()) continue;
        i++;
      }
      while (i < source.length) {
        logical();
        if (/\s/.test(source[i])) { i++; continue; }
        if (source[i] === "#") {
          const newline = source.indexOf("\n", i);
          i = newline < 0 ? source.length : newline;
          continue;
        }
        if (keyword("esac")) { i += 4; return; }
        if (source[i] === "(") i++; // Optional pattern opener.
        let closed = false;
        while (i < source.length) {
          logical();
          if (source[i] === ")") { i++; closed = true; break; }
          if (wordPart()) continue;
          if ("?*+@!".includes(source[i]) && source[i + 1] === "(") { i++; opaque(")"); continue; }
          i++; // Pattern metacharacters, including &, are data.
        }
        if (!closed) uncertain();
        shell("case");
        if (keyword("esac")) { i += 4; return; }
        if (starts(";;&")) i += 3;
        else if (starts(";;") || starts(";&")) i += 2;
        else uncertain();
      }
      uncertain();
    }
    function shell(stop = "") {
      const heredocs = [];
      let word = false;
      let commandStart = true;
      while (i < source.length) {
        logical();
        if (i >= source.length) break;
        const c = source[i];
        if (stop === "case" && (starts(";;") || starts(";&") || (!word && commandStart && keyword("esac")))) {
          if (heredocs.length) uncertain();
          return;
        }
        if (stop && stop !== "case" && c === stop && (stop !== "}" || (!word && boundary(source[i + 1])))) {
          if (heredocs.length) uncertain();
          i++;
          return;
        }
        if (c === "#" && !word) {
          const newline = source.indexOf("\n", i);
          i = newline < 0 ? source.length : newline;
          continue;
        }
        if (c === "\\" || c === SQ || c === "\"" || c === "$" || c === "`" || ((c === "<" || c === ">") && source[i + 1] === "(")) {
          let consumed = false;
          guarded(() => { consumed = wordPart(); });
          if (consumed) { word = true; commandStart = false; continue; }
          // A dollar sign with no expansion is a normal word character.
        }
        if (!word) {
          // Both declaration forms leave a compound command in command position,
          // including inline case bodies whose ;& / ;;& are not backgrounding.
          const declaration = /^(?:[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\)|function[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?(?=[\s({]))/.exec(source.slice(i));
          if (commandStart && declaration) {
            const saved = background;
            i += declaration[0].length;
            functionDepth++;
            try {
              while (i < source.length) {
                logical();
                if (/\s/.test(source[i])) { i++; continue; }
                if (source[i] !== "#") break;
                const newline = source.indexOf("\n", i);
                i = newline < 0 ? source.length : newline;
              }
              if (keyword("case")) caseStatement();
              else if (source[i] === "{" && boundary(source[i + 1])) { i++; shell("}"); }
              else if (starts("[[") && /\s/.test(source[i + 2] || "")) conditional();
              else if (starts("((")) arithmetic(2);
              else if (source[i] === "(") { i++; shell(")"); }
              else uncertain(); // Other compound bodies are an intentional limit.
            } catch {
              background = saved;
              i = source.length; // Unknown body extent: never deny from recovery.
            } finally { functionDepth--; }
            commandStart = false;
            continue;
          }
          const assignment = /^[A-Za-z_][A-Za-z0-9_]*(?:\+?=\(|\[)/.exec(source.slice(i));
          if (assignment) {
            i += assignment[0].length - 1;
            guarded(() => opaque(source[i] === "(" ? ")" : "]", source[i] === "("));
            word = true;
            continue;
          }
          if (commandStart && keyword("case")) { guarded(caseStatement); word = false; continue; }
          if (commandStart && keyword("coproc")) { background = true; i += 6; commandStart = false; word = true; continue; }
          // These reserved words introduce another command position.
          const reserved = /^(?:time(?:[ \t]+-p)?|if|then|elif|else|while|until|do|!)(?=\s)/.exec(source.slice(i));
          if (commandStart && reserved) { i += reserved[0].length; continue; }
        }
        if ("?*+@!".includes(c) && source[i + 1] === "(") {
          i++; guarded(() => opaque(")")); word = true; continue;
        }
        if (!word && c === "{" && boundary(source[i + 1])) {
          guarded(() => { i++; shell("}"); }); word = false; continue;
        }
        if (!word && starts("[[") && /\s/.test(source[i + 2] || "")) {
          guarded(conditional); word = false; commandStart = false; continue;
        }
        if (starts("((")) { guarded(() => arithmetic(2)); word = false; commandStart = false; continue; }
        if (c === "(") { guarded(() => { i++; shell(")"); }); word = false; commandStart = false; continue; }
        if (c === ")" || (!word && c === "}" && boundary(source[i + 1]))) {
          // Unmatched closers are unresolved only in this segment.
          i++; recover(i); word = false; continue;
        }
        if (starts("<<<")) { i += 3; word = false; continue; }
        if (starts("<<")) {
          guarded(() => {
            i += 2;
            const stripTabs = source[i] === "-";
            if (stripTabs) i++;
            while (source[i] === " " || source[i] === "\t") i++;
            heredocs.push({ ...delimiter(), stripTabs });
          });
          word = true;
          continue;
        }
        const operator = /^(?:&&|&>>?|[<>]&|\|&)/.exec(source.slice(i, i + 3));
        if (operator) {
          i += operator[0].length; word = false;
          if (operator[0] === "&&" || operator[0] === "|&") commandStart = true;
          continue;
        }
        if (c === "&") background = true;
        i++;
        if (c === "\n" && heredocs.length) {
          // A missing terminator makes the remaining body literal/unknown;
          // it cannot erase an already classified command-list operator.
          try { bodies(heredocs); }
          catch { i = source.length; }
          heredocs.length = 0;
        }
        if (/[\n;&|]/.test(c)) commandStart = true;
        else if (!/\s/.test(c)) commandStart = false;
        word = !/[\s;&|<>()]/.test(c);
      }
      if (stop || heredocs.length) uncertain();
    }

    if (dataOnly) {
      // Heredoc quotes and bare & are literal. Only executable expansions and
      // backticks enter shell context; backslash can quote their opening byte.
      while (i < source.length) {
        if (source[i] === "\\" && "$`\\".includes(source[i + 1] || "\0")) { i += 2; continue; }
        if (source[i] === "$") { guarded(() => { if (!expansion(true)) i++; }); continue; }
        if (source[i] === "`") { guarded(backtick); continue; }
        i++;
      }
    } else {
      // No outer catch may erase detections from earlier complete segments.
      try { shell(); } catch { /* Incomplete queued heredoc at EOF. */ }
    }
    return background;
  }

  const background = hasBackground(command);
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
