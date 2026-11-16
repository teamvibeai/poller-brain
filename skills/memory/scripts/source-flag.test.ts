import { strict as assert } from "node:assert";
import { parseSourceFlag, sourceTag } from "./lib/source-flag.js";

assert.deepEqual(parseSourceFlag(["hello", "world"]), { source: "maintenance", content: "hello world" });
for (const source of ["maintenance", "user-session"] as const) {
  assert.deepEqual(parseSourceFlag([`--source=${source}`, " content "]), { source, content: "content" });
  assert.deepEqual(parseSourceFlag(["content", `--source=${source}`, `--source=${source}`]), { source, content: "content" });
  assert.equal(sourceTag(source), source === "maintenance" ? "[maint]" : "[user]");
}
for (const args of [["--source=bad", "content"], ["--source=", "content"], ["--source", "user-session", "content"],
  ["--source=maintenance", "--source=user-session", "content"], ["--source=user-session", "--source=maintenance", "content"]]) {
  assert.throws(() => parseSourceFlag(args), /source/i);
}
for (const args of [[], [" "], ["--source=maintenance"], ["--source=user-session", " "]]) {
  assert.equal(parseSourceFlag(args).content, "");
}
assert.equal(parseSourceFlag(["detail: --source=user-session"]).source, "maintenance", "content cannot set metadata");
console.log("source-flag: all assertions passed");
