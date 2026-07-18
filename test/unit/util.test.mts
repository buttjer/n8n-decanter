// Fast, offline unit tests for the pure core in lib/util.mts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Workflow } from "../../lib/types.mts";
import {
  findNodeRefs,
  forEachConnectionTarget,
  kebabCase,
  placeholderFile,
  publicationState,
  renameNodeRefs,
  sanitizeFilename,
  sanitizeForPut,
  sha256,
  splitMarker,
  stableWorkflowJson,
  withMarker,
  workflowStructureHash,
} from "../../lib/util.mts";

const HEX = "0123456789abcdef".repeat(4);
const MARKER = `// @ts-n8n sha256:${HEX}`;

describe("splitMarker", () => {
  it("splits a trailing marker, keeping the body byte-exact", () => {
    const r = splitMarker(`return [];\n${MARKER}`);
    assert.equal(r.body, "return [];\n");
    assert.equal(r.marker, MARKER);
    assert.equal(r.markerHash, `sha256:${HEX}`);
  });

  it("tolerates trailing whitespace and newline variants after the marker", () => {
    for (const tail of ["\n", " \t\n", "\n\n", " \t", "\n \n\t"]) {
      const r = splitMarker(`x\n${MARKER}${tail}`);
      assert.equal(r.body, "x\n", JSON.stringify(tail));
      assert.equal(r.marker, MARKER, JSON.stringify(tail));
    }
  });

  it("does not match a marker that is not the last non-blank line", () => {
    const r = splitMarker(`a\n${MARKER}\nmore code\n`);
    assert.equal(r.marker, null);
    assert.equal(r.body, `a\n${MARKER}\nmore code\n`);
  });

  it("returns the input unchanged when there is no marker", () => {
    const code = "return $input.all();\n";
    assert.deepEqual(splitMarker(code), { body: code, marker: null, markerHash: null });
  });

  it("handles marker-only input (empty body)", () => {
    const r = splitMarker(MARKER);
    assert.equal(r.body, "");
    assert.equal(r.marker, MARKER);
  });

  it("rejects malformed hashes", () => {
    assert.equal(splitMarker(`x\n// @ts-n8n sha256:short`).marker, null);
    assert.equal(splitMarker(`x\n// @ts-n8n md5:${HEX}`).marker, null);
  });

  it("round-trips withMarker: hash(body) equals the recorded hash", () => {
    for (const compiled of ["return [];", "return [];\n", "", "a\nb\n"]) {
      const { jsCode, hash } = withMarker(compiled);
      const { body, markerHash } = splitMarker(jsCode);
      assert.equal(sha256(body), hash, JSON.stringify(compiled));
      assert.equal(markerHash, hash, JSON.stringify(compiled));
    }
  });

  it("withMarker adds a trailing newline to the body when missing", () => {
    assert.ok(withMarker("return [];").jsCode.startsWith("return [];\n// @ts-n8n "));
    assert.equal(withMarker("return [];\n").hash, withMarker("return [];").hash);
  });
});

describe("sanitizeFilename", () => {
  it("replaces reserved characters with dashes", () => {
    assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  });
  it("strips control characters", () => {
    assert.equal(sanitizeFilename("a\x00b\x1fc"), "abc");
  });
  it("trims whitespace and trailing dots", () => {
    assert.equal(sanitizeFilename("  name... "), "name");
  });
  it("falls back to 'unnamed' when nothing survives", () => {
    assert.equal(sanitizeFilename(""), "unnamed");
    assert.equal(sanitizeFilename(" ... "), "unnamed");
  });
});

describe("kebabCase", () => {
  it("kebab-cases spaces and punctuation", () => {
    assert.equal(kebabCase("Parse Order"), "parse-order");
    assert.equal(kebabCase("Transform: EU/US"), "transform-eu-us");
  });
  it("splits camelCase and digit boundaries", () => {
    assert.equal(kebabCase("parseOrder"), "parse-order");
    assert.equal(kebabCase("v2Feed"), "v2-feed");
  });
  it("splits acronym boundaries", () => {
    assert.equal(kebabCase("HTTPRequest"), "http-request");
    assert.equal(kebabCase("parseHTTPResponse"), "parse-http-response");
  });
  it("keeps Unicode letters", () => {
    assert.equal(kebabCase("Über Prüfung"), "über-prüfung");
  });
  it("falls back to 'unnamed'", () => {
    assert.equal(kebabCase(""), "unnamed");
    assert.equal(kebabCase("!!!"), "unnamed");
  });
});

describe("findNodeRefs", () => {
  it("finds all three quote styles and dedupes", () => {
    const refs = findNodeRefs("$('A') + $(\"B\") + $(`C`) + $('A')");
    assert.deepEqual(refs.sort(), ["A", "B", "C"]);
  });
  it("unescapes escaped quotes in the name", () => {
    assert.deepEqual(findNodeRefs("$('It\\'s')"), ["It's"]);
  });
  it("skips template refs containing ${…}", () => {
    assert.deepEqual(findNodeRefs("$(`Node ${suffix}`)"), []);
  });
  it("skips non-literal and multi-arg calls", () => {
    assert.deepEqual(findNodeRefs("$(someVar) + $('a', 2) + $()"), []);
  });
});

describe("renameNodeRefs", () => {
  it("rewrites only the matching name, preserving each call's quote style", () => {
    const src = "$('Old') $(\"Old\") $(`Old`) $('Other')";
    assert.equal(renameNodeRefs(src, "Old", "New"), "$('New') $(\"New\") $(`New`) $('Other')");
  });
  it("escapes the quote character in the new name", () => {
    assert.equal(renameNodeRefs("$('Old')", "Old", "It's"), "$('It\\'s')");
  });
  it("matches escaped-quote spellings of the old name", () => {
    assert.equal(renameNodeRefs("$('It\\'s')", "It's", "Plain"), "$('Plain')");
  });
  it("leaves non-literal calls untouched", () => {
    assert.equal(renameNodeRefs("$(someVar)", "Old", "New"), "$(someVar)");
  });
});

describe("placeholderFile", () => {
  const node = (jsCode: string) =>
    ({ id: "n", name: "N", type: "n8n-nodes-base.code", parameters: { jsCode } }) as never;
  it("extracts and trims the referenced file", () => {
    assert.equal(placeholderFile(node("//@file: code/x.js ")), "code/x.js");
  });
  it("returns null for inline code", () => {
    assert.equal(placeholderFile(node("return [];")), null);
  });
});

describe("forEachConnectionTarget", () => {
  it("visits every object target with source and type", () => {
    const seen: string[] = [];
    forEachConnectionTarget(
      {
        A: { main: [[{ node: "B", index: 0 }], [{ node: "C" }]], error: [[{ node: "D" }]] },
        broken: "not an object",
        alsoBroken: { main: "nope" },
        nullTargets: { main: [[null, 42]] },
      },
      (target, source, type) => seen.push(`${source}/${type}/${String(target.node)}`),
    );
    assert.deepEqual(seen.sort(), ["A/error/D", "A/main/B", "A/main/C"]);
  });
});

// ---------- workflow-level helpers ----------

const baseWorkflow = (): Workflow => ({
  versionId: "v1",
  id: "wf1",
  name: "Test",
  active: true,
  updatedAt: "2026-07-18T00:00:00.000Z",
  connections: { Hook: { main: [[{ node: "Code", type: "main", index: 0 }]] } },
  settings: { timezone: "Europe/Berlin", executionOrder: "v1" },
  staticData: null,
  nodes: [
    { parameters: { path: "x" }, id: "n1", name: "Hook", type: "n8n-nodes-base.webhook", position: [0, 0] },
    { parameters: { jsCode: "return [];\n" }, id: "n2", name: "Code", type: "n8n-nodes-base.code", position: [200, 0] },
  ],
});

describe("stableWorkflowJson", () => {
  it("orders keys deterministically and ends with a newline", () => {
    const json = stableWorkflowJson(baseWorkflow());
    assert.ok(json.endsWith("}\n"));
    const parsed = JSON.parse(json);
    assert.deepEqual(Object.keys(parsed), ["id", "name", "active", "updatedAt", "nodes", "connections", "settings", "staticData", "versionId"]);
    assert.deepEqual(Object.keys(parsed.nodes[0]), ["id", "name", "type", "position", "parameters"]);
  });

  it("is insensitive to input key order", () => {
    const base = baseWorkflow();
    const shuffled = Object.fromEntries(Object.keys(base).reverse().map((k) => [k, base[k]])) as Workflow;
    shuffled.nodes = base.nodes.map((n) => ({ position: n.position, parameters: n.parameters, type: n.type, name: n.name, id: n.id }));
    assert.equal(stableWorkflowJson(shuffled), stableWorkflowJson(base));
  });
});

describe("sanitizeForPut", () => {
  it("keeps only the PUT fields and whitelisted settings", () => {
    const put = sanitizeForPut(baseWorkflow());
    assert.deepEqual(Object.keys(put).sort(), ["connections", "name", "nodes", "settings"]);
    assert.deepEqual(put.settings, { timezone: "Europe/Berlin" }); // executionOrder is not whitelisted
  });
  it("drops null staticData but keeps a real object", () => {
    assert.ok(!("staticData" in sanitizeForPut(baseWorkflow())));
    const wf = { ...baseWorkflow(), staticData: { counter: 1 } };
    assert.deepEqual(sanitizeForPut(wf).staticData, { counter: 1 });
  });
});

describe("publicationState", () => {
  it("maps the active flag to published/unpublished", () => {
    assert.equal(publicationState({ ...baseWorkflow(), active: true }), "published");
    assert.equal(publicationState({ ...baseWorkflow(), active: false }), "unpublished");
  });
  it("is undefined without a boolean active field", () => {
    const wf = baseWorkflow();
    delete wf.active;
    assert.equal(publicationState(wf), undefined);
    assert.equal(publicationState({ ...baseWorkflow(), active: "yes" as unknown as boolean }), undefined);
    assert.equal(publicationState(undefined), undefined);
  });
});

describe("workflowStructureHash", () => {
  it("is invariant to key order and non-PUT fields", () => {
    const a = baseWorkflow();
    const b = baseWorkflow();
    b.active = false;
    b.updatedAt = "2027-01-01T00:00:00.000Z";
    b.versionId = "v2";
    b.nodes = b.nodes.map((n) => ({ name: n.name, id: n.id, type: n.type, parameters: n.parameters, position: n.position }));
    assert.equal(workflowStructureHash(a), workflowStructureHash(b));
  });
  it("ignores Code-node jsCode edits", () => {
    const edited = baseWorkflow();
    edited.nodes[1].parameters.jsCode = "return $input.all(); // changed\n";
    assert.equal(workflowStructureHash(edited), workflowStructureHash(baseWorkflow()));
  });
  it("changes on structural edits", () => {
    const moved = baseWorkflow();
    moved.nodes[0].position = [999, 0];
    assert.notEqual(workflowStructureHash(moved), workflowStructureHash(baseWorkflow()));
    const reconnected = baseWorkflow();
    reconnected.connections = {};
    assert.notEqual(workflowStructureHash(reconnected), workflowStructureHash(baseWorkflow()));
    const retimed = baseWorkflow();
    retimed.settings = { ...retimed.settings, timezone: "UTC" };
    assert.notEqual(workflowStructureHash(retimed), workflowStructureHash(baseWorkflow()));
  });
});
