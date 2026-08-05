// Unit tests for the field-test SCENARIO PACK (test/field-test/scenarios/*.md),
// Plan 35 + Plan 61.
//
// A scenario file is executable input: `run.mts` parses its `## Orchestration`
// block and replays the turns verbatim at ~$0.20 a turn. Every defect in that
// block is therefore paid for in real money at the worst possible moment —
// mid-round, after the stage has booted. The known-expensive failures so far:
//
//   - a scenario acting on state an earlier one builds, run alone (ftrun-93355,
//     $0.70 for zero signal) — hence `requires`, which this file checks resolves
//   - a `preHook` name nothing implements, which silently staged NOTHING and let
//     the round "measure" an intact environment (Plan 61; `run.mts` now refuses)
//   - blinding leaks: evaluation-signalling vocabulary in a harness-authored
//     prompt makes the round unusable — STYLE.md's hard rule, checked here
//     because a leak is only visible once the transcripts are already paid for
//
// All offline: this reads the markdown, nothing else. No n8n, no claude, no spend.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "field-test", "scenarios");

interface Spine {
  id?: unknown;
  turns?: unknown;
  verifyWorkflows?: unknown;
  preHook?: unknown;
  requires?: unknown;
  requiresNoCli?: unknown;
  requiresSeedKinds?: unknown;
  persona?: unknown;
  unsandboxedOnly?: unknown;
  optional?: unknown;
}

const files = readdirSync(SCENARIO_DIR).filter((f) => /^S\d+\.md$/.test(f)).sort();
const ids = new Set(files.map((f) => f.replace(/\.md$/, "")));

/** The same extraction `run.mts` does — if this regex misses, the runner throws. */
function spineOf(file: string): Spine {
  const md = readFileSync(path.join(SCENARIO_DIR, file), "utf8");
  const m = md.match(/##\s*Orchestration[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert.ok(m, `${file} has no \`\`\`json Orchestration block — run.mts refuses to load it`);
  return JSON.parse(m[1]) as Spine;
}

/**
 * STYLE.md's banned vocabulary. Deliberately NOT including `test`/`scenario`:
 * both are shipped decanter verbs the agent legitimately sees in `--help`, and
 * contorting a prompt to avoid them would be its own distortion.
 */
const BANNED = /\b(eval|evals|evaluation|evaluated|benchmark|rubric|graded|grading|blind run|test subject|experiment)\b/i;

/** Verbs Plan 59 removed — a harness prompt must never put one in the agent's mouth. */
const REMOVED_VERBS = /\bn8n-decanter\s+(check|status|simulate)\b/;

describe("field-test scenario pack", () => {
  it("has scenario files at all (a wildcard typo would silently pass everything else)", () => {
    assert.ok(files.length >= 6, `expected the S1… pack, found ${files.length} file(s)`);
  });

  for (const file of files) {
    const id = file.replace(/\.md$/, "");

    describe(id, () => {
      it("parses, and its id matches the filename", () => {
        const spine = spineOf(file);
        assert.equal(spine.id, id, `${file} declares id ${JSON.stringify(spine.id)}`);
      });

      it("declares at least one non-empty turn", () => {
        const { turns } = spineOf(file);
        assert.ok(Array.isArray(turns) && turns.length > 0, `${file}: turns must be a non-empty array`);
        for (const [i, t] of (turns as unknown[]).entries()) {
          assert.equal(typeof t, "string", `${file}: turn ${i + 1} is not a string`);
          assert.ok((t as string).trim().length > 20, `${file}: turn ${i + 1} is too short to be a user message`);
        }
      });

      it("declares a verify scope", () => {
        const { verifyWorkflows } = spineOf(file);
        // "none" is an explicit answer for a scenario that leaves no verifiable
        // local state; `[]` is NOT — it resolves to "verify every folder".
        const ok = verifyWorkflows === "all" || verifyWorkflows === "none" || (Array.isArray(verifyWorkflows) && verifyWorkflows.length > 0);
        assert.ok(ok, `${file}: verifyWorkflows must be "all", "none", or a non-empty array of manifest kinds`);
      });

      it("only requires scenarios that exist", () => {
        for (const need of (spineOf(file).requires ?? []) as string[]) {
          assert.ok(ids.has(need), `${file}: requires ${need}, which is not in the pack`);
        }
      });

      it("names its preHook in the kebab shape run.mts dispatches on", () => {
        const { preHook } = spineOf(file);
        if (preHook === undefined) return;
        assert.equal(typeof preHook, "string");
        assert.match(preHook as string, /^[a-z][a-z0-9-]*$/, `${file}: preHook ${JSON.stringify(preHook)} is not a hook name`);
      });

      it("declares seed kinds as a non-empty array of kebab names, when it declares any", () => {
        const kinds = spineOf(file).requiresSeedKinds;
        if (kinds === undefined) return;
        assert.ok(Array.isArray(kinds) && kinds.length > 0, `${file}: requiresSeedKinds must be a non-empty array`);
        for (const k of kinds as unknown[]) assert.match(String(k), /^[a-z][a-z0-9-]*$/, `${file}: seed kind ${JSON.stringify(k)}`);
      });

      it("keeps evaluation-signalling vocabulary out of the turns (STYLE.md, hard rule)", () => {
        for (const [i, t] of (spineOf(file).turns as string[]).entries()) {
          const hit = t.match(BANNED);
          assert.equal(hit, null, `${file}: turn ${i + 1} leaks ${JSON.stringify(hit?.[0])} — a blinding leak makes the round unusable`);
        }
      });

      it("never puts a removed verb in the user's mouth", () => {
        for (const [i, t] of (spineOf(file).turns as string[]).entries()) {
          const hit = t.match(REMOVED_VERBS);
          assert.equal(hit, null, `${file}: turn ${i + 1} names the removed verb ${JSON.stringify(hit?.[1])} (Plan 59)`);
        }
      });
    });
  }
});
