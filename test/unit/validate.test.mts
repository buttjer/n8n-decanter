// Unit tests for the compliance guard (lib/validate.mts) against throwaway
// temp dirs — pins every error/warning string that push/check/rename surface.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Workflow } from "../../lib/types.mts";
import { validateNodeFile, validateWorkflowDir } from "../../lib/validate.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-validate-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
interface Scaffold {
  state?: string | null; // .decanter.json content; null = omit the file
  workflow?: Partial<Workflow> | string | null; // object, raw string, or null = omit
  files?: Record<string, string>; // extra files, relative to the dir
}

/** Build a workflow dir; defaults form a minimal compliant layout. */
function scaffold({ state, workflow, files = {} }: Scaffold = {}): string {
  const dir = path.join(TMP, `wf-${seq++}`);
  mkdirSync(path.join(dir, "code"), { recursive: true });
  if (state !== null) {
    writeFileSync(path.join(dir, ".decanter.json"), state ?? JSON.stringify({ workflowId: "wf1", nodes: { n2: { file: "code/main.js" } } }));
  }
  if (workflow !== null) {
    const content = typeof workflow === "string"
      ? workflow
      : JSON.stringify({
          id: "wf1",
          name: "Test",
          connections: {},
          nodes: [{ id: "n2", name: "Main", type: "n8n-nodes-base.code", parameters: { jsCode: "//@file:code/main.js" } }],
          ...workflow,
        });
    writeFileSync(path.join(dir, "workflow.json"), content);
  }
  for (const [rel, content] of Object.entries({ "code/main.js": "return [];\n", ...files })) {
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const codeNode = (id: string, name: string, jsCode: string) =>
  ({ id, name, type: "n8n-nodes-base.code", parameters: { jsCode } });

describe("validateWorkflowDir", () => {
  it("passes a compliant layout with no errors or warnings", () => {
    assert.deepEqual(validateWorkflowDir(scaffold()), { errors: [], warnings: [] });
  });

  it("errors on missing .decanter.json", () => {
    const { errors } = validateWorkflowDir(scaffold({ state: null }));
    assert.deepEqual(errors, ["missing .decanter.json — pull first"]);
  });

  it("errors on corrupt .decanter.json instead of crashing", () => {
    const { errors } = validateWorkflowDir(scaffold({ state: "{ not json" }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^corrupt \.decanter\.json \(/);
  });

  it("errors on missing workflow.json", () => {
    const { errors } = validateWorkflowDir(scaffold({ workflow: null }));
    assert.deepEqual(errors, ["missing workflow.json — pull first"]);
  });

  it("errors on invalid workflow.json JSON", () => {
    const { errors } = validateWorkflowDir(scaffold({ workflow: "{ nope" }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^workflow\.json: invalid JSON \(/);
  });

  it("errors on duplicate node names and ids", () => {
    const nodes = [
      codeNode("n2", "Main", "//@file:code/main.js"),
      { id: "n2", name: "Main", type: "n8n-nodes-base.set", parameters: {} },
    ];
    const { errors } = validateWorkflowDir(scaffold({ workflow: { nodes } }));
    assert.ok(errors.includes('duplicate node name "Main" — node names must be unique'), errors.join("\n"));
    assert.ok(errors.includes('duplicate node id "n2" — node ids must be unique'), errors.join("\n"));
  });

  it("errors on dangling connection sources and targets", () => {
    const connections = {
      Ghost: { main: [[{ node: "Main", type: "main", index: 0 }]] },
      Main: { main: [[{ node: "Nowhere", type: "main", index: 0 }]] },
    };
    const { errors } = validateWorkflowDir(scaffold({ workflow: { connections } }));
    assert.ok(errors.includes('connections: source "Ghost" is not a node in this workflow'), errors.join("\n"));
    assert.ok(errors.includes('connections: "Main" (main) targets missing node "Nowhere"'), errors.join("\n"));
  });

  it("errors on inline code in workflow.json", () => {
    const { errors } = validateWorkflowDir(scaffold({ workflow: { nodes: [codeNode("n2", "Main", "return [];")] } }));
    assert.equal(errors.length, 2); // inline error + code/main.js becomes an orphan
    assert.match(errors[0], /node "Main": inline code in workflow\.json — node code belongs in its own file/);
  });

  it("errors on a dangling $('…') reference in a node source file", () => {
    const dir = scaffold({ files: { "code/main.js": "return $('Deleted Node').all();\n" } });
    const { errors } = validateWorkflowDir(dir);
    assert.deepEqual(errors, [`node "Main": code/main.js references $('Deleted Node') — no node by that name`]);
  });

  it("errors on a dangling $('…') reference in an expression parameter", () => {
    const nodes = [
      codeNode("n2", "Main", "//@file:code/main.js"),
      { id: "n3", name: "Set", type: "n8n-nodes-base.set", parameters: { value: "={{ $('Also Gone').first().json.x }}" } },
    ];
    const { errors } = validateWorkflowDir(scaffold({ workflow: { nodes } }));
    assert.deepEqual(errors, [`node "Set": a parameter references $('Also Gone') — no node by that name`]);
  });

  it("errors on orphan code files; .d.ts is exempt", () => {
    const dir = scaffold({ files: { "code/orphan.js": "return [];\n", "stray.ts": "export {};\n", "code/types.d.ts": "type X = 1;\n" } });
    const { errors } = validateWorkflowDir(dir);
    assert.deepEqual(errors.sort(), [
      "orphan code file code/orphan.js — no //@file: placeholder references it; delete it or point a Code node at it",
      "orphan code file stray.ts — no //@file: placeholder references it; delete it or point a Code node at it",
    ]);
  });

  it("warns on a stray .remote.js no placeholder covers", () => {
    const { warnings, errors } = validateWorkflowDir(scaffold({ files: { "code/gone.remote.js": "// old\n" } }));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, ["stray remote copy code/gone.remote.js — no placeholder references its node; port or delete it"]);
  });

  it("warns on an unresolved workflow.remote.json", () => {
    const { warnings, errors } = validateWorkflowDir(scaffold({ files: { "workflow.remote.json": "{}\n" } }));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, ["unresolved structural conflict workflow.remote.json — reconcile into workflow.json, then delete it"]);
  });
});

describe("validateNodeFile", () => {
  it("errors on a placeholder referencing the conflict artifact", () => {
    const { errors } = validateNodeFile(scaffold(), "code/main.remote.js");
    assert.deepEqual(errors, ["code/main.remote.js: placeholder references the conflict artifact code/main.remote.js — resolve it into the real node file instead"]);
  });

  it("errors on non-.js/.ts references", () => {
    const { errors } = validateNodeFile(scaffold(), "code/main.py");
    assert.deepEqual(errors, ["code/main.py: referenced file code/main.py must be .js or .ts"]);
  });

  it("errors on files outside code/ (flat and nested)", () => {
    for (const file of ["Main.js", "code/deeper/main.js"]) {
      const { errors } = validateNodeFile(scaffold({ files: { [file.startsWith("code/") ? "code/main.js" : file]: "return [];\n" } }), file);
      assert.ok(errors.some((e) => e.includes(`node file ${file} sits outside code/`)), `${file}: ${errors.join("\n")}`);
    }
  });

  it("errors on a missing referenced file", () => {
    const { errors } = validateNodeFile(scaffold(), "code/nope.js");
    assert.deepEqual(errors, ["code/nope.js: referenced file code/nope.js is missing"]);
  });

  it("errors on an @ts-n8n marker inside a .js file", () => {
    const marker = "// @ts-n8n sha256:" + "0".repeat(64);
    const dir = scaffold({ files: { "code/main.js": `return [];\n${marker}\n` } });
    const { errors } = validateNodeFile(dir, "code/main.js");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /code\/main\.js ends with an @ts-n8n marker/);
  });

  it("errors on an import in a .js node — verbatim tier, imports never bundle", () => {
    const dir = scaffold({ files: { "code/main.js": 'import { x } from "../shared/x";\nreturn [x];\n' } });
    const { errors } = validateNodeFile(dir, "code/main.js");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /\.js nodes run verbatim in n8n.*convert the node to \.ts/);
  });

  it("errors on a builtin/unlisted import in a .ts node, warns on a mid-file import", () => {
    const dir = scaffold({
      state: JSON.stringify({ workflowId: "wf1", nodes: { n2: { file: "code/main.ts" } } }),
      files: { "code/main.ts": 'import { createHash } from "node:crypto";\nconst x = 1;\nimport late from "./x";\nreturn [x];\n' },
    });
    const { errors, warnings } = validateNodeFile(dir, "code/main.ts");
    assert.ok(errors.some((e) => /Node builtin "node:crypto"/.test(e)), errors.join("\n"));
    assert.ok(warnings.some((w) => /import below the first statement/.test(w)), warnings.join("\n"));
  });

  it("warns on an unresolved .remote.js sibling", () => {
    const dir = scaffold({ files: { "code/main.remote.js": "// remote\n" } });
    const { errors, warnings } = validateNodeFile(dir, "code/main.js");
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, ["code/main.js: unresolved remote copy code/main.remote.js — its remote edits will be overwritten on push; port them, then delete the file"]);
  });

  it("uses the label for messages when given", () => {
    const { errors } = validateNodeFile(scaffold(), "code/nope.js", 'node "Main"');
    assert.match(errors[0], /^node "Main": referenced file/);
  });
});
