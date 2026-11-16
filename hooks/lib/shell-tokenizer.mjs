// Split literal words and command boundaries without executing shell input.
// Keep proven invalid separators distinct from syntax whose grammar is unknown.
const COMPOUND_WORDS = new Set([
  "if", "then", "elif", "else", "fi", "while", "until", "for", "select",
  "do", "done", "case", "esac", "in", "function", "coproc",
]);
const tokenBoundary = ch => ch === undefined || " \t\n;&|<>()".includes(ch);
function conditionalPrefix(words, literalWords) {
  for (let i = 0; i < words.length; i++) {
    if (!literalWords[i]) return false;
    if (words[i] === "!") continue;
    if (words[i] !== "time") return false;
    if (words[i + 1] === "-p" && literalWords[i + 1]) i++;
    if (words[i + 1] === "--" && literalWords[i + 1]) i++;
  }
  return true;
}

export function parseSimpleCommands(input, { allowEnvReferences = false, stripSudo = true } = {}) {
  const commands = [];
  let words = [], word = "", started = false, quote = null;
  let literal = true, literalWords = [];
  let requiresCommand = false, conditional = false, compound = false;
  const result = status => ({
    status,
    // Uncertain input may still contain earlier, definite policy matches.
    commands: ["complete", "uncertain"].includes(status) ? commands.map(({ words, separator }) => ({
      words: stripSudo && words[0] === "sudo" ? words.slice(1) : words,
      separator,
    })) : [],
  });
  const invalid = () => result(compound ? "uncertain" : "invalid");
  const unsupported = () => result(conditional || compound ? "uncertain" : "unsupported");
  const finishWord = () => {
    if (started) {
      if (literal && COMPOUND_WORDS.has(word) && conditionalPrefix(words, literalWords)) compound = true;
      words.push(word);
      literalWords.push(literal);
    }
    word = "";
    started = false;
    literal = true;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") {
      const next = input[++i];
      if (next === undefined) return invalid();
      if (next !== "\n") {
        literal = false;
        // Inside double quotes, backslash only escapes these characters.
        if (quote === '"' && !'\\"$`'.includes(next)) word += "\\";
        word += next;
        started = true;
      }
    } else if (quote && ch === quote) {
      quote = null;
    } else if (!quote && (ch === "'" || ch === '"')) {
      literal = false;
      quote = ch;
      started = true;
    } else if (quote !== "'" && (ch === "`" || ch === "$")) {
      literal = false;
      // Telemetry may retain literal variable names, never evaluate them. Other
      // expansions stay unsupported; the deny-list keeps its original defaults.
      if (allowEnvReferences && ch === "$") {
        const ref = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(input.slice(i));
        if (ref) {
          word += ref[0];
          started = true;
          i += ref[0].length - 1;
          continue;
        }
      }
      if (ch !== "$" || input[i + 1] !== "$") return unsupported();
      word += "$$"; // Known PID expansion, used in /proc/$$/mem.
      started = true;
      i++;
    } else if (quote) {
      word += ch;
    } else if (ch === "#" && !started) {
      while (i < input.length && input[i] !== "\n") i++;
      i--; // Let the newline finish this simple command.
    } else if (!conditional && !started && input.startsWith("[[", i) && tokenBoundary(input[i + 2]) &&
      (conditionalPrefix(words, literalWords) || compound)) {
      // [[ is reserved only in command position, not in `echo [[` arguments.
      // A surrounding compound needs a fuller parser; never call it malformed.
      if (compound) return result("uncertain");
      conditional = true;
      word = "[[";
      started = true;
      i++;
    } else if (conditional && !started && input.startsWith("]]", i) && tokenBoundary(input[i + 2])) {
      conditional = false;
      word = "]]";
      started = true;
      i++;
    } else if (conditional) {
      // Conditional operators and ERE metacharacters are not shell command
      // separators. Still decode quotes/escapes above for safe telemetry.
      if (" \t\n".includes(ch)) finishWord();
      else {
        word += ch;
        started = true;
      }
    } else if ("<>(){}".includes(ch)) {
      return unsupported();
    } else if ("&;|\n".includes(ch)) {
      finishWord();
      let separator = ch;
      if (["&&", "||", "|&"].includes(input.slice(i, i + 2))) separator += input[++i];
      if (words.length) {
        commands.push({ words, separator });
        requiresCommand = ["|", "|&", "&&", "||"].includes(separator);
      } else if (separator !== "\n") {
        // Only newlines/comments may intervene before the next command.
        // Reject the whole parse, including any earlier matching commands.
        return invalid();
      }
      words = [];
      literalWords = [];
    } else if (ch === " " || ch === "\t") {
      finishWord();
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return invalid();
  if (conditional) return result("uncertain");
  finishWord();
  if (words.length) commands.push({ words, separator: "" });
  else if (requiresCommand) return invalid();
  // Support the existing literal `sudo command ...` forms, without guessing options.
  return result(compound ? "uncertain" : "complete");
}

// Existing telemetry callers omit incomplete/unsupported input as a whole.
export function simpleCommands(input, options) {
  const parsed = parseSimpleCommands(input, options);
  return parsed.status === "complete" ? parsed.commands : [];
}
