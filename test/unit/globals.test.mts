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

  // Plan 63 task 5. A fixture pins ONE items array per node, so there is no
  // honest answer for a second branch — and the old code accepted the argument
  // and returned output 0 anyway. That is WRONG data, not missing data: a node
  // reading an IF's false branch got the true branch's items and looked correct,
  // while `n8n-globals.d.ts` declared the parameter and the docs called these
  // calls fully covered. Signposting is the same pattern `$vars`/`$secrets` use.
  it("a branch index other than 0 signposts instead of silently returning output 0", async () => {
    const g = await buildGlobals({ input: [{ json: { seed: 1 } }], nodes: { Fetch: [{ json: { id: 7 } }] } });
    const node = (g.$ as (n: string) => { all: (b?: number) => unknown[] })("Fetch");
    const items = g.$items as (n?: string, o?: number) => unknown[];
    const input = g.$input as { all: (b?: number) => unknown[] };

    // branch 0 (and the bare call) stay emulated — this is the common case
    assert.equal(node.all().length, 1);
    assert.equal(node.all(0).length, 1);
    assert.equal(items("Fetch", 0).length, 1);
    assert.equal(input.all(0).length, 1);

    // an output the fixture does NOT pin still refuses, names the call, says how
    // many outputs it has, and points at the two ways out
    assert.throws(() => node.all(1), /\$\("Fetch"\)\.all\(1\) asks for output 1.*supplies 1 output\(s\).*PER OUTPUT.*n8n-decanter test/s);
    assert.throws(() => items("Fetch", 1), /\$\("Fetch"\)\.all\(1\) asks for output 1/s);
    assert.throws(() => input.all(2), /\$input\.all\(2\) asks for output 2/s);
  });

  // Plan 66 task 4: the refusal above is right only while the fixture cannot
  // express the branch. A per-output entry can, so it is answered — the honest
  // fix for a node that reads an IF's false branch or an error output.
  it("a per-output fixture entry makes the branch readable", async () => {
    const g = await buildGlobals({
      input: [[{ json: { from: "input 0" } }], [{ json: { from: "input 1" } }]],
      nodes: { Decide: [[{ json: { side: "true" } }], [{ json: { side: "false" } }, { json: { side: "false again" } }]] },
    });
    const node = (g.$ as (n: string) => { all: (b?: number) => Array<{ json: { side: string } }>; first: (b?: number) => { json: { side: string } }; last: (b?: number) => { json: { side: string } } })("Decide");
    const items = g.$items as (n?: string, o?: number) => Array<{ json: { side: string } }>;
    const input = g.$input as { all: (b?: number) => Array<{ json: { from: string } }> };

    assert.deepEqual(node.all(0).map((i) => i.json.side), ["true"]);
    assert.deepEqual(node.all(1).map((i) => i.json.side), ["false", "false again"]);
    assert.deepEqual(items("Decide", 1).map((i) => i.json.side), ["false", "false again"]);
    // first/last take the branch too — n8n declares the parameter on all three
    assert.equal(node.first(1).json.side, "false");
    assert.equal(node.last(1).json.side, "false again");
    // $input's index is the node's INPUT (a Merge node's second input)
    assert.equal(input.all(1)[0].json.from, "input 1");
    // an output beyond what the fixture pins is still refused, not invented
    assert.throws(() => node.all(2), /asks for output 2.*supplies 2 output\(s\)/s);
  });

  it("an empty output is a pinned output, not a missing one", async () => {
    const g = await buildGlobals({ nodes: { Decide: [[{ json: { side: "true" } }], []] } });
    const node = (g.$ as (n: string) => { all: (b?: number) => unknown[] })("Decide");
    assert.deepEqual(node.all(1), [], "the false branch took no items — that IS the answer");
  });

  it("a single-output fixture keeps its old meaning, arrays-as-items included", async () => {
    // The nested form is recognised only when EVERY element is an array, so an
    // items array of objects is unchanged...
    const plain = await buildGlobals({ nodes: { Fetch: [{ json: { id: 7 } }] } });
    assert.deepEqual((plain.$ as (n: string) => { all: () => Array<{ json: { id: number } }> })("Fetch").all().map((i) => i.json.id), [7]);
    // ...and a node whose single output carries ARRAY-valued json is written in
    // the explicit item form, which is not an array of arrays.
    const arrays = await buildGlobals({ nodes: { Fetch: [{ json: [1, 2] }] } });
    assert.deepEqual((arrays.$ as (n: string) => { all: () => Array<{ json: number[] }> })("Fetch").all()[0].json, [1, 2]);
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
