// Split literal words and command boundaries without executing shell input.
// Unsupported syntax (expansions, redirects, compound commands) fails open.
export function simpleCommands(input, { allowEnvReferences = false, stripSudo = true } = {}) {
  const commands = [];
  let words = [], word = "", started = false, quote = null;
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") {
      const next = input[++i];
      if (next === undefined) return [];
      if (next !== "\n") {
        // Inside double quotes, backslash only escapes these characters.
        if (quote === '"' && !'\\"$`'.includes(next)) word += "\\";
        word += next;
        started = true;
      }
    } else if (quote && ch === quote) {
      quote = null;
    } else if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      started = true;
    } else if (quote !== "'" && (ch === "`" || ch === "$")) {
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
      if (ch !== "$" || input[i + 1] !== "$") return [];
      word += "$$"; // Known PID expansion, used in /proc/$$/mem.
      started = true;
      i++;
    } else if (quote) {
      word += ch;
    } else if ("<>(){}".includes(ch)) {
      return [];
    } else if (ch === "#" && !started) {
      while (i < input.length && input[i] !== "\n") i++;
      i--; // Let the newline finish this simple command.
    } else if ("&;|\n".includes(ch)) {
      finishWord();
      let separator = ch;
      if ("&|".includes(ch) && input[i + 1] === ch) separator += input[++i];
      // Empty boundaries (including continuation newlines/comments) keep adjacency.
      if (words.length) commands.push({ words, separator });
      words = [];
    } else if (ch === " " || ch === "\t") {
      finishWord();
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  finishWord();
  if (words.length) commands.push({ words, separator: "" });
  // Support the existing literal `sudo command ...` forms, without guessing options.
  return commands.map(({ words, separator }) => ({
    words: stripSudo && words[0] === "sudo" ? words.slice(1) : words,
    separator,
  }));
}
