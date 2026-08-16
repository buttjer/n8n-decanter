// The scaffolded sync-dir `AGENTS.md` is the one file every agent in a synced
// project reads before touching the instance. It has to carry the prerequisites
// an agent cannot discover from the code — /docs covers them (quickstart,
// troubleshooting), but nobody reads /docs mid-task.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const TEMPLATE_AGENTS = path.join(import.meta.dirname, "../../template/AGENTS.md.example");

describe("scaffolded AGENTS.md — n8n-side prerequisites", () => {
  // Reported from a real project: the CLI's own error message is exemplary, but
  // the agent only meets it after `pull` has already failed. MCP access is a
  // PER-WORKFLOW switch in n8n, and until it is on, pull/push/diff all fail.
  it("has a prerequisites section naming the per-workflow MCP switch", () => {
    const text = readFileSync(TEMPLATE_AGENTS, "utf8");
    // Sections, so the answer sits under a heading an agent can find — not
    // buried as a parenthetical in an unrelated bullet list.
    const sections = text.split(/\n(?=## )/).slice(1);
    const section = sections.find((s) => /^## .*(prerequisite|mcp access|before you)/i.test(s));
    assert.ok(section, `no prerequisites/MCP-access section — headings are:\n${sections.map((s) => s.split("\n")[0]).join("\n")}`);
    assert.match(section, /available in mcp/i, "name the n8n switch exactly as the UI labels it");
    assert.match(section, /each workflow|per.workflow|every workflow|workflow by workflow/i, "the per-workflow granularity is the surprising part");
    assert.match(section, /pull/i);
    assert.match(section, /push|diff/i, "it gates the whole sync surface, not just pull");
  });
});
