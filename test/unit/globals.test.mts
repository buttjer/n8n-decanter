// Plan 43 — the "one surface" parity invariant. The globals declared in the
// shipped `n8n-globals.d.ts` (the authoring contract) and the globals
// `buildGlobals` actually provides to `node run` must be the SAME set: every
// declared global is either emulated, pinnable from the fixture, or a friendly
// signpost to `test` — nothing declared may fall through to a bare
// ReferenceError, and `run` may not provide a global the `.d.ts` doesn't
// declare. This test also pins the emulation of `$jmespath` and the friendly
// boundary for instance-scoped globals.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGlobals } from "../../lib/run.mts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The value-level globals the shipped .d.ts declares (const/function/class). */
function declaredGlobals(): Set<string> {
  const dts = readFileSync(path.join(ROOT, "n8n-globals.d.ts"), "utf8");
  const names = new Set<string>();
  for (const m of dts.matchAll(/^(?:export )?declare (?:const|let|var|function|class) (\$[\w$]*|[A-Za-z_][\w$]*)/gm)) names.add(m[1]);
  return names;
}

describe("n8n globals surface (Plan 43 parity)", () => {
  it("declared .d.ts globals == the keys buildGlobals provides (two-way closure)", async () => {
    const declared = declaredGlobals();
    const provided = new Set(Object.keys(await buildGlobals({})));
    const missing = [...declared].filter((n) => !provided.has(n)); // declared but would ReferenceError
    const undeclared = [...provided].filter((n) => !declared.has(n)); // provided but never authored
    assert.deepEqual(missing, [], `declared globals with no buildGlobals entry (would ReferenceError): ${missing.join(", ")}`);
    assert.deepEqual(undeclared, [], `buildGlobals provides globals the .d.ts doesn't declare: ${undeclared.join(", ")}`);
    assert.ok(declared.size > 20, "sanity: the .d.ts declares a real surface");
  });

  it("does NOT declare the expression-only extensions ($if/$min/$max/$ifEmpty)", () => {
    const declared = declaredGlobals();
    for (const n of ["$if", "$min", "$max", "$ifEmpty"]) {
      assert.ok(!declared.has(n), `${n} is an n8n expression-language extension, not a Code-node global — must not be declared`);
    }
  });

  it("$jmespath is emulated (data-first search) and $jmesPath is the alias", async () => {
    const g = await buildGlobals({});
    // Matches n8n's $jmespath, which is jmespath.search(data, expr).
    assert.equal((g.$jmespath as (d: unknown, e: string) => unknown)({ locations: [{ name: "a" }, { name: "b" }] }, "locations[*].name | [1]"), "b");
    assert.equal(g.$jmespath, g.$jmesPath, "$jmesPath is the same function as $jmespath");
  });

  it("$items / $node are views over the fixture nodes map", async () => {
    const g = await buildGlobals({ input: [{ json: { seed: 1 } }], nodes: { Fetch: [{ json: { id: 7 } }] } });
    assert.deepEqual((g.$node as Record<string, { first(): { json: unknown } }>).Fetch.first().json, { id: 7 });
    assert.deepEqual((g.$items as (n?: string) => Array<{ json: unknown }>)("Fetch").map((i) => i.json), [{ id: 7 }]);
    assert.deepEqual((g.$items as (n?: string) => Array<{ json: unknown }>)().map((i) => i.json), [{ seed: 1 }], "$items() with no name = current input");
  });

  it("emulated proxies serialize cleanly — returning $node/$vars must not crash run's output", async () => {
    const g = await buildGlobals({ nodes: { Fetch: [{ json: { id: 7 } }] } });
    // runNode ends in JSON.stringify(output); a node returning a proxy must not throw on toJSON.
    assert.equal(JSON.stringify({ snapshot: g.$node }), '{"snapshot":{}}');
    assert.equal(JSON.stringify({ v: g.$vars }), '{"v":{}}');
    assert.throws(() => (g.$node as Record<string, unknown>).Missing, /has no fixture data/, "a real (non-probe) key still errors");
  });

  it("an instance-scoped global signposts `test` — never a bare ReferenceError", async () => {
    const g = await buildGlobals({});
    assert.throws(() => (g.$vars as Record<string, unknown>).apiBase, /\$vars is not emulated in `run`.*n8n-decanter test.*pin `vars`/s);
    assert.throws(() => (g.$secrets as Record<string, unknown>).vault, /\$secrets is not emulated in `run`.*n8n-decanter test.*pin `secrets`/s);
    assert.throws(() => (g.$evaluateExpression as (e: string) => unknown)("{{ 1 + 1 }}"), /\$evaluateExpression is not emulated in `run`.*expression engine.*n8n-decanter test/s);
  });

  it("$vars / $secrets are pinnable from the fixture (then no signpost)", async () => {
    const g = await buildGlobals({ vars: { region: "eu" }, secrets: { vault: { key: "v" } } });
    assert.equal((g.$vars as Record<string, string>).region, "eu");
    assert.deepEqual((g.$secrets as Record<string, unknown>).vault, { key: "v" });
  });

  it("is single-source: no template/*.example duplicate, and the root file ships (Task 4)", () => {
    assert.ok(!existsSync(path.join(ROOT, "template", "n8n-globals.d.ts.example")), "the byte-identical template duplicate must be gone — init sources the single root file");
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    assert.ok(pkg.files.includes("n8n-globals.d.ts"), "root n8n-globals.d.ts must be in `files` so init can copy it from the published package");
  });

  it("$nodeId/$nodeVersion/$webhookId come from the node context, stubbed when absent", async () => {
    const bare = await buildGlobals({});
    assert.equal(bare.$nodeId, "local");
    assert.equal(bare.$nodeVersion, 1);
    assert.equal(bare.$webhookId, undefined);
    const withNode = await buildGlobals({}, { node: { id: "abc", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, webhookId: "wh1", parameters: {} } });
    assert.equal(withNode.$nodeId, "abc");
    assert.equal(withNode.$nodeVersion, 2);
    assert.equal(withNode.$webhookId, "wh1");
  });
});
