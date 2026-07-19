// Unit tests for the minimal unified line diff behind `status --diff`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unifiedDiff } from "../../lib/diff.mts";

describe("unifiedDiff", () => {
  it("returns [] for identical inputs (trailing newline is not a line)", () => {
    assert.deepEqual(unifiedDiff("a\nb\n", "a\nb\n"), []);
    assert.deepEqual(unifiedDiff("a\nb", "a\nb\n"), []);
    assert.deepEqual(unifiedDiff("", ""), []);
  });

  it("marks additions with + and removals with -", () => {
    assert.deepEqual(unifiedDiff("a\nb\n", "a\nb\nc\n"), ["@@ -1,2 +1,3 @@", " a", " b", "+c"]);
    assert.deepEqual(unifiedDiff("a\nb\nc\n", "a\nc\n"), ["@@ -1,3 +1,2 @@", " a", "-b", " c"]);
  });

  it("renders a changed line as remove + add", () => {
    assert.deepEqual(unifiedDiff("keep\nold\nkeep2\n", "keep\nnew\nkeep2\n"), [
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " keep2",
    ]);
  });

  it("splits distant changes into separate hunks with correct positions", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const b = ["1x", "2", "3", "4", "5", "6", "7", "8", "9", "10x"].join("\n") + "\n";
    const out = unifiedDiff(a, b);
    assert.equal(out.filter((l) => l.startsWith("@@")).length, 2, out.join("\n"));
    assert.deepEqual(out.slice(0, 4), ["@@ -1,3 +1,3 @@", "-1", "+1x", " 2"]);
    assert.ok(out.includes("-10") && out.includes("+10x"));
  });

  it("handles empty-to-content and content-to-empty", () => {
    assert.deepEqual(unifiedDiff("", "a\n"), ["@@ -1,0 +1,1 @@", "+a"]);
    assert.deepEqual(unifiedDiff("a\n", ""), ["@@ -1,1 +1,0 @@", "-a"]);
  });
});
