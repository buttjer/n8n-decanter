// Unit tests for the field-test INVARIANT VERIFIER's offline checks
// (test/field-test/verify.mts), Plan 61 task 9.
//
// The verifier is the thing that makes a blind round cheap to repeat — its
// verdicts are what a maintainer reads instead of five transcripts. So its own
// checks must never be exercised for the first time by a real round: Plan 61's
// acceptance criterion says each new invariant has to demonstrably FAIL against
// a hand-broken fixture. That is this file.
//
// Only the LOCAL checks are covered here, and deliberately so — they run before
// the verifier touches the instance, which is what makes them assertable with no
// n8n, no Docker and no spend. The remote-comparison checks need a real
// instance and stay the smoke/round path's job.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const VERIFY = path.join(import.meta.dirname, "..", "field-test", "verify.mts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-verify-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * A minimal staged world: a git-initialised workDir with one tracked workflow
 * folder, plus a manifest pointing at a host that does not exist. The dead host
 * is the point — it proves the local checks are reported *before* the remote
 * read, so a scenario against a broken instance still gets them graded.
 */
async function stage(files: Record<string, string> = {}): Promise<{ manifest: string; workDir: string }> {
  const workDir = mkdtempSync(path.join(TMP, "work-"));
  const dir = path.join(workDir, "workflows", "wf-a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "id-a", nodes: {} }));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ nodes: [] }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  await execFile("git", ["-C", workDir, "init", "-q"]);
  await execFile("git", ["-C", workDir, "config", "user.email", "t@example.com"]);
  await execFile("git", ["-C", workDir, "config", "user.name", "T"]);
  await execFile("git", ["-C", workDir, "add", "-A"]);
  await execFile("git", ["-C", workDir, "commit", "-q", "-m", "decanter: pulled \"A\" (id-a)"]);

  const harness = mkdtempSync(path.join(TMP, "harness-"));
  const manifest = path.join(harness, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    host: "http://127.0.0.1:1", container: null, mcpToken: "", apiKey: "k",
    workDir, harnessRoot: harness, root: "workflows", allowExtension: [],
    cliTarball: null, decanterSpec: null, seeded: [{ id: "id-a", name: "A", kind: "realism", availableInMCP: true }],
  }, null, 2));
  return { manifest, workDir };
}

/** Run the verifier and return its per-check results (it exits 1 on violations). */
async function runVerify(manifest: string): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const out = path.join(path.dirname(manifest), "out.json");
  try {
    await execFile(process.execPath, [VERIFY, manifest, "--out", out]);
  } catch { /* exit 1 = violations found, which several of these tests want */ }
  const parsed = JSON.parse(readFileSync(out, "utf8")) as { workflows: Array<{ checks: Array<{ name: string; ok: boolean; detail: string }> }> };
  return parsed.workflows.flatMap((w) => w.checks);
}

const find = <T extends { name: string }>(checks: T[], needle: string): T | undefined => checks.find((c) => c.name.includes(needle));

describe("field-test verify — local invariants (Plan 61 task 9)", () => {
  it("passes a clean folder: no cached data in git, no scenarios to fault", async () => {
    const { manifest } = await stage();
    const checks = await runVerify(manifest);
    const cache = find(checks, "fetched caches never committed");
    assert.ok(cache, `check missing; got: ${checks.map((c) => c.name).join(" | ")}`);
    assert.equal(cache.ok, true, cache.detail);
  });

  it("FAILS when fetched execution data reached a commit", async () => {
    // the leak this exists for: a capture can carry production payloads, and
    // `git add -A` past the self-gitignore is a thing agents do
    const { manifest } = await stage({ "workflows/wf-a/executions/4812.json": JSON.stringify({ id: 4812 }) });
    const checks = await runVerify(manifest);
    const cache = find(checks, "fetched caches never committed");
    assert.equal(cache?.ok, false, `expected a violation, got: ${cache?.detail}`);
    assert.match(cache!.detail, /executions/);
  });

  it("FAILS when a data-table cache reached a commit", async () => {
    const { manifest } = await stage({ "data-tables/orders.json": JSON.stringify({ rows: [] }) });
    const checks = await runVerify(manifest);
    assert.equal(find(checks, "fetched caches never committed")?.ok, false);
  });

  it("passes a well-formed committed scenario", async () => {
    const { manifest } = await stage({
      "workflows/wf-a/scenarios/happy.json": JSON.stringify({
        id: "happy", data: { resultData: { runData: { Fetch: [{ data: { main: [[{ json: { ok: true } }], null] } }] } } },
      }),
    });
    const checks = await runVerify(manifest);
    assert.equal(find(checks, "committed scenarios are structurally valid")?.ok, true);
  });

  it("FAILS on a scenario whose items have no json field", async () => {
    const { manifest } = await stage({
      "workflows/wf-a/scenarios/broken.json": JSON.stringify({
        id: "broken", data: { resultData: { runData: { Fetch: [{ data: { main: [[{ nope: 1 }]] } }] } } },
      }),
    });
    const checks = await runVerify(manifest);
    const scen = find(checks, "committed scenarios are structurally valid");
    assert.equal(scen?.ok, false, `expected a violation, got: ${scen?.detail}`);
    assert.match(scen!.detail, /json/);
  });

  it("FAILS on a scenario that is not JSON at all", async () => {
    const { manifest } = await stage({ "workflows/wf-a/scenarios/junk.json": "{ not json" });
    const checks = await runVerify(manifest);
    assert.equal(find(checks, "committed scenarios are structurally valid")?.ok, false);
  });

  it("reports the local checks even though the instance is unreachable", async () => {
    // the S13 shape: the whole scenario is "the instance is broken". Local
    // hygiene must still be graded rather than short-circuited by the failed read.
    const { manifest } = await stage();
    const checks = await runVerify(manifest);
    assert.ok(find(checks, "remote code read"), "expected the remote read to fail in this fixture");
    assert.ok(find(checks, "fetched caches never committed"), "local checks must be reported before the remote read");
  });
});
