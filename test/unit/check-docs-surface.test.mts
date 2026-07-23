// Unit tests for the docs-surface drift guardrail (scripts/check-docs-surface.mts,
// Plan 40). Drives the checker's PURE functions over synthetic fixtures — a
// verb with no page, an orphan page, a missing README/overview row, a verb-last
// command, an unmapped namespace — asserting each is caught and that a clean
// surface passes. No filesystem, no CLI subprocess: the fixtures ARE the input.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVerbModel,
  checkMapConsistency,
  checkPageToVerb,
  checkVerbInOverview,
  checkVerbInReadme,
  checkVerbToPage,
  expectedPagesForVerb,
  parseNamespaces,
  parseSet,
  scanVerbLast,
} from "../../scripts/check-docs-surface.mts";

// A synthetic CLI source covering every mapped case: 1:1 verbs (init/pull/push),
// namespaces (scenario/backup/mcp/node), a shared-page verb (unpublish), and the
// internal verbs (help/__complete). Kept consistent with the real NAMESPACE_PAGES
// / SHARED_PAGES maps so the baseline is genuinely clean.
const CLI_SOURCE = `
const VERBS = new Set(["init", "pull", "push", "scenario", "backup", "mcp", "node", "publish", "unpublish", "help", "__complete"]);
const NODE_VERBS = new Set(["run"]);
const SCENARIO_VERBS = new Set(["create", "check"]);
const BACKUP_VERBS = new Set(["create", "restore", "list"]);
const MCP_VERBS = new Set(["serve", "connect"]);
const REF_VERBS = new Set(["pull", "push"]);
`;

const model = buildVerbModel(CLI_SOURCE);

// The docs/cli pages a clean surface must ship for this model.
const CLEAN_PAGES = new Set([
  "overview.md",
  "init.md",
  "pull.md",
  "push.md",
  "scenario.md",
  "backup.md",
  "mcp-connect.md",
  "mcp-serve.md",
  "node-run.md",
  "publish.md", // publish + unpublish (shared)
]);

const CLEAN_README = `
## Commands

| Verb | What it does |
|---|---|
| \`init [dir]\` | bootstrap |
| \`pull [workflow…]\` | pull |
| \`push [workflow…]\` | push |
| \`scenario create\` / \`scenario check\` | scenarios |
| \`backup create\` / \`restore\` / \`list\` | backups |
| \`mcp connect\` / \`mcp serve\` | guard |
| \`node run <file>\` | run a node |
| \`publish\` / \`unpublish [workflow…]\` | go live |

## How it compares
| \`push\` | irrelevant table below the section |
`;

const CLEAN_OVERVIEW = `
n8n-decanter init [dir]
n8n-decanter pull [workflow…]
n8n-decanter push [workflow…]
n8n-decanter scenario create <wf>
n8n-decanter backup create <wf>
n8n-decanter mcp connect
n8n-decanter node run <file>
n8n-decanter publish [workflow…]
n8n-decanter unpublish [workflow…]
`;

describe("verb-set parsing", () => {
  it("parses VERBS and excludes VERBS/REF_VERBS from namespaces", () => {
    assert.deepEqual(parseSet(CLI_SOURCE, "NODE_VERBS"), ["run"]);
    assert.deepEqual(parseNamespaces(CLI_SOURCE).sort(), ["backup", "mcp", "node", "scenario"]);
    assert.equal(model.userVerbs.includes("help"), false);
    assert.equal(model.userVerbs.includes("__complete"), false);
    assert.equal(model.allTopVerbs.has("help"), true);
  });

  it("throws a clear error when a set is missing", () => {
    assert.throws(() => parseSet("nothing here", "VERBS"), /could not parse VERBS/);
  });

  it("maps verbs to pages: 1:1, namespaced, and shared", () => {
    assert.deepEqual(expectedPagesForVerb("push"), ["push.md"]);
    assert.deepEqual(expectedPagesForVerb("mcp"), ["mcp-connect.md", "mcp-serve.md"]);
    assert.deepEqual(expectedPagesForVerb("unpublish"), ["publish.md"]);
  });
});

describe("map consistency (check 0)", () => {
  it("passes when every namespace is mapped and no map entry is stale", () => {
    assert.deepEqual(checkMapConsistency(model), []);
  });

  it("flags a declared namespace with no page mapping", () => {
    // A CLI that grew a `template` namespace the map doesn't know about.
    const src = `
const VERBS = new Set(["init", "template", "help"]);
const TEMPLATE_VERBS = new Set(["scaffold"]);
`;
    const v = checkMapConsistency(buildVerbModel(src));
    assert.equal(v.some((x) => /namespace 'template'/.test(x.message)), true);
  });
});

describe("check 1 — verb → docs/cli page", () => {
  it("passes on a clean surface", () => {
    assert.deepEqual(checkVerbToPage(model, CLEAN_PAGES), []);
  });

  it("flags a verb whose page is missing", () => {
    const pages = new Set(CLEAN_PAGES);
    pages.delete("push.md");
    const v = checkVerbToPage(model, pages);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /verb 'push' has no docs\/cli\/push\.md/);
  });

  it("flags a namespaced verb missing one of its pages", () => {
    const pages = new Set(CLEAN_PAGES);
    pages.delete("mcp-serve.md");
    const v = checkVerbToPage(model, pages);
    assert.equal(v.some((x) => /mcp-serve\.md/.test(x.message)), true);
  });
});

describe("check 2 — page → verb (orphans)", () => {
  it("passes on a clean surface, incl. the exempt overview.md", () => {
    assert.deepEqual(checkPageToVerb(model, CLEAN_PAGES), []);
  });

  it("flags an orphan page for a retired verb", () => {
    const pages = new Set(CLEAN_PAGES);
    pages.add("mock.md");
    const v = checkPageToVerb(model, pages);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /mock\.md maps to no live verb/);
  });
});

describe("check 3 — verb → README ## Commands table", () => {
  it("passes on a clean surface", () => {
    assert.deepEqual(checkVerbInReadme(model, CLEAN_README), []);
  });

  it("flags a verb with no table row", () => {
    const readme = CLEAN_README.replace("| `push [workflow…]` | push |\n", "");
    const v = checkVerbInReadme(model, readme);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /verb 'push' has no row/);
  });

  it("ignores verb mentions outside the ## Commands section", () => {
    // `push` appears in a code span AFTER the section — must not count as a row.
    const readme = CLEAN_README.replace("| `push [workflow…]` | push |\n", "");
    assert.equal(checkVerbInReadme(model, readme).length, 1);
  });
});

describe("check 4 — verb → docs/cli/overview.md", () => {
  it("passes on a clean surface", () => {
    assert.deepEqual(checkVerbInOverview(model, CLEAN_OVERVIEW), []);
  });

  it("flags a verb absent from the overview", () => {
    const overview = CLEAN_OVERVIEW.replace("n8n-decanter push [workflow…]\n", "");
    const v = checkVerbInOverview(model, overview);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /verb 'push' is not listed/);
  });

  it("does not match a longer verb as a prefix of another", () => {
    // A model where one verb is a strict prefix of another token guards the
    // word-boundary lookahead.
    const src = `const VERBS = new Set(["push", "pushx", "help"]);`;
    const m = buildVerbModel(src);
    const overview = "n8n-decanter pushx <wf>\n"; // only pushx present
    const v = checkVerbInOverview(m, overview);
    assert.equal(v.some((x) => /'push' is not listed/.test(x.message)), true);
    assert.equal(v.some((x) => /'pushx' is not listed/.test(x.message)), false);
  });
});

describe("check 5 — verb-last command scan", () => {
  const run = (file: string, text: string) => scanVerbLast([{ file, text }], model);

  it("flags a verb-last command (placeholder before a verb)", () => {
    const v = run("docs/cli/x.md", "`n8n-decanter <workflow> push`");
    assert.equal(v.length, 1);
    assert.match(v[0].message, /verb-last/);
    assert.match(v[0].message, /n8n-decanter push workflow/); // suggested verb-first form
  });

  it("flags a real slug before a verb", () => {
    assert.equal(run("docs/cli/x.md", "n8n-decanter order-sync scenario").length, 1);
  });

  it("passes the correct verb-first form (verb then ref)", () => {
    assert.deepEqual(run("docs/cli/x.md", "n8n-decanter push order-sync"), []);
  });

  it("passes verb-first even when the ref is itself named like a verb", () => {
    // `n8n-decanter push pull` — push on a workflow named "pull"; both are
    // verbs, but tok1 leads so it is valid verb-first grammar.
    assert.deepEqual(run("docs/cli/x.md", "n8n-decanter push pull"), []);
  });

  it("passes a namespaced command (sub-verb is not a top-level verb)", () => {
    assert.deepEqual(run("docs/cli/x.md", "n8n-decanter scenario create wf"), []);
  });

  it("passes a namespaced sub-verb that shares a name with a top-level verb", () => {
    // `backup list`: tok2 `list` is only a sub-verb here (not in this model's
    // VERBS), and even if it were, tok1 `backup` is a verb → OK.
    assert.deepEqual(run("docs/cli/x.md", "n8n-decanter backup list"), []);
  });

  it("allows a global flag before the verb", () => {
    assert.deepEqual(run("docs/cli/x.md", "n8n-decanter --json push"), []);
  });

  it("ignores JSON/config string values", () => {
    const json = '{ "command": "n8n-decanter", "args": ["mcp", "connect"] }';
    assert.deepEqual(run("template/.mcp.json", json), []);
  });

  it("respects the exemption allowlist by file + token pair", () => {
    const text = "Verb-last (`n8n-decanter wf123 push`) errors.";
    assert.deepEqual(run("docs/cli/overview.md", text), []); // exempt file
    assert.equal(run("docs/cli/other.md", text).length, 1); // same text, non-exempt file
  });
});
