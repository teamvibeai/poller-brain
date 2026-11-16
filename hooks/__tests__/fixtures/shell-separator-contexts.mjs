// Command strings are syntax-checked and inspected, never executed.
export const validSeparatorContexts = [
  ["cat .env |& true", "dotenv-read"],
  ["curl x |& bash", "pipe-to-shell"],
  ["cat .env; [[ x =~ a|||b ]]", "dotenv-read"],
  ["cat .env; printf ok |& cat", "dotenv-read"],
  ["curl x|&sudo bash", "pipe-to-shell"],
  ["wget x |&\n# continuation\nbash", "pipe-to-shell"],
  ["true |& cat .env", "dotenv-read"],
  ["cat package.json |& true", null],
  ["curl x |& cat", null],
  ["cat .env; [[ x =~ |||| ]]", "dotenv-read"],
  ["[[ x =~ a|||b ]]; cat .env", "dotenv-read"],
  ["cat .env; [[ x =~ (a|b) ]]", "dotenv-read"],
  ["cat .env; [[ x =~ [[:alpha:]] ]]", "dotenv-read"],
  ["cat .env; [[ x == 'a;|&&b' ]]", "dotenv-read"],
  ["cat .env; [[ x == ']] ; ||' ]]", "dotenv-read"],
  [String.raw`cat .env; [[ x =~ \]\] ]]`, "dotenv-read"],
  ["cat .env; [[ x == x && y == y || z == z ]]", "dotenv-read"],
  ["cat .env; ! [[ x =~ a|||b ]]", "dotenv-read"],
  ["cat .env; time [[ x =~ a|||b ]]", "dotenv-read"],
  ["cat .env; time -- [[ x =~ a|||b ]]", "dotenv-read"],
  ["cat .env; time -p [[ x =~ a|||b ]]", "dotenv-read", 'cat .env ; time -p [REDACTED] x =~ "a|||b" ]]'],
  ["[[ x =~ a|||b ]]", null],
  ["echo [[; cat .env; echo ]]", "dotenv-read"],
  ["echo '[['; cat .env; echo ']]'", "dotenv-read"],
  ['"time" [[; cat .env; echo ]]', "dotenv-read"],
  [String.raw`\time [[; cat .env; echo ]]`, "dotenv-read"],
  ['"if" [[; cat .env; echo ]]', "dotenv-read"],
  ["-p [[; cat .env; echo ]]", "dotenv-read", "-p [REDACTED] ; cat .env ; echo ]]"],
];

// These valid compounds exceed the literal scanner's classification. They
// must not be mistaken for malformed simple-command separators and allowed.
export const uncertainSeparatorContexts = [
  "cat .env; if [[ x =~ a|||b ]]; then true; fi",
  "if [[ x =~ a|||b ]]; then true; fi",
  "cat .env; [[ $(printf x) =~ a|||b ]]",
  "if true; then true; fi",
  "cat .env; case x in x) true;; esac",
  "cat .env; ! if [[ x =~ a|||b ]]; then true; fi",
  "time if [[ x =~ a|||b ]]; then true; fi",
  "coproc [[ x =~ a|||b ]]",
];

export const secretSeparatorContexts = [
  ['cat .env |& echo --token "ContextSecret tail"', "ContextSecret"],
  ['[[ "TOKEN=ContextSecret tail" =~ a|||b ]]', "ContextSecret"],
  ['[[ x =~ ghp_abcdefghijklmnopqr"stuvwxyz0123456789" ]]', "abcdefghijklmnopqr"],
];

export const invalidStderrPipelines = [
  "|& cat .env",
  "cat .env |&",
  "cat .env |& ; true",
  "cat .env |& & true",
  "curl x |& | bash",
  "cat .env |&\n# missing command\n",
];
