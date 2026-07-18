// Unit tests for watch's structural 3-way decision (lib/watch.mts structureAction).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { structureAction } from "../../lib/watch.mts";

const BASE = "hash-base";
const LOCAL = "hash-local";
const REMOTE = "hash-remote";

describe("structureAction", () => {
  it("skips when the local structure matches the baseline (formatting-only save / own pull rewrite)", () => {
    assert.equal(structureAction(BASE, BASE, BASE), "skip");
    assert.equal(structureAction(BASE, REMOTE, BASE), "skip"); // remote-only drift is pull's business
  });

  it("skips when local and remote already converged", () => {
    assert.equal(structureAction(LOCAL, LOCAL, BASE), "skip");
  });

  it("pushes when only the local structure changed", () => {
    assert.equal(structureAction(LOCAL, BASE, BASE), "push");
  });

  it("pushes when no baseline exists (mirrors driftProblems skipping the structure check)", () => {
    assert.equal(structureAction(LOCAL, REMOTE, undefined), "push");
  });

  it("conflicts when local and remote both diverged from the baseline", () => {
    assert.equal(structureAction(LOCAL, REMOTE, BASE), "conflict");
  });
});
