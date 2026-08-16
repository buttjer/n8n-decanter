// Unit tests for the `preflight` verb (lib/preflight.mts, Plan 36): the pure
// scorer/verdict/coverage/require functions, the line renderer, and the
// orchestrator itself driven against a stubbed McpClient + a seeded capture —
// asserting the ladder runs, scores, and NEVER mutates.
//
// Plan 59: profiles are gone. Depth is the two orthogonal booleans
// `{simulate, offline}`, so the pure seam under test is `activeStages` and the
// orchestrator is driven by `flags`, not a preset name.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import {
  type ActiveStages, activeStages, applyRequire, type CheckFinding, coverageOf, describeFlags,
  exitCodeOf, formatCheckDetails, formatCheckLine, type PreflightContext, type PreflightFlags,
  renderPreflightSummary, runPreflight, scoreFindings, verdictOf,
} from "../../lib/preflight.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";
import { sha256 } from "../../lib/util.mts";

const finding = (over: Partial<CheckFinding>): CheckFinding => ({ id: "layout", tier: "static", status: "pass", message: "", durationMs: 0, ...over });

describe("preflight scoring (pure)", () => {
  it("starts at 100 and floors at 0", () => {
    assert.equal(scoreFindings([]), 100);
    assert.equal(scoreFindings([finding({ status: "pass" }), finding({ status: "info" }), finding({ status: "skip" })]), 100);
    assert.equal(scoreFindings(Array.from({ length: 5 }, () => finding({ id: "types", status: "fail" }))), 0, "5×−40 floors at 0");
  });
  it("weights fails −40, a CONFLICT drift −30, warns −10", () => {
    assert.equal(scoreFindings([finding({ id: "types", status: "fail" })]), 60);
    assert.equal(scoreFindings([finding({ id: "drift", status: "fail" })]), 70, "drift fail is −30, not −40");
    assert.equal(scoreFindings([finding({ status: "warn" }), finding({ status: "warn" })]), 80);
  });
});

describe("preflight verdict + exit code (pure)", () => {
  it("any fail → not ready; else any warn → caution; else ready", () => {
    assert.equal(verdictOf([finding({ status: "pass" })]), "ready");
    assert.equal(verdictOf([finding({ status: "warn" }), finding({ status: "pass" })]), "caution");
    assert.equal(verdictOf([finding({ status: "warn" }), finding({ status: "fail" })]), "not ready");
  });
  it("exit code: not-ready→1, caution→1 only with --fail-on=warn, ready→0", () => {
    assert.equal(exitCodeOf("not ready"), 1);
    assert.equal(exitCodeOf("caution"), 0);
    assert.equal(exitCodeOf("caution", { failOnWarn: true }), 1);
    assert.equal(exitCodeOf("ready", { failOnWarn: true }), 0);
  });
});

describe("preflight coverage + require (pure)", () => {
  it("coverage splits ran vs skipped with reasons", () => {
    const cov = coverageOf([finding({ id: "layout", status: "pass" }), finding({ id: "simulate", status: "skip", reason: "no capture", unlock: "run executions" })]);
    assert.deepEqual(cov.ran, ["layout"]);
    assert.deepEqual(cov.skipped, [{ id: "simulate", reason: "no capture", unlock: "run executions" }]);
  });
  it("--require promotes a skip of a named check to a fail; a ran check is untouched", () => {
    const promoted = applyRequire([finding({ id: "simulate", status: "skip", reason: "no capture", unlock: "run executions" }), finding({ id: "layout", status: "pass" })], ["simulate", "layout"]);
    assert.equal(promoted[0].status, "fail");
    assert.match(promoted[0].message, /required check "simulate" did not run/);
    assert.equal(promoted[1].status, "pass", "a required check that ran is left alone");
  });
});

describe("preflight depth flags (pure)", () => {
  // Plan 59's whole depth model, as the table the plan specifies. `--simulate`
  // is ADDITIVE, `--offline` SUBTRACTIVE; the static tier is unconditional and
  // therefore not part of the spec at all.
  //
  // Note the BREAKING inversion against the retired profiles: the old
  // `--offline` profile RAN the engine ({sync:false, simulate:true}); bare
  // `--offline` now runs nothing but the static tier — the old behaviour is
  // spelled `--offline --simulate`.
  const TABLE: ReadonlyArray<{ flags: PreflightFlags; stages: ActiveStages; label: string }> = [
    { flags: { simulate: false, offline: false }, stages: { sync: true, simulate: false }, label: "static + instance reads" },
    { flags: { simulate: true, offline: false }, stages: { sync: true, simulate: true }, label: "--simulate" },
    { flags: { simulate: false, offline: true }, stages: { sync: false, simulate: false }, label: "--offline" },
    { flags: { simulate: true, offline: true }, stages: { sync: false, simulate: true }, label: "--offline --simulate" },
  ];

  it("maps every flag combination to its active tiers", () => {
    assert.equal(TABLE.length, 4, "two booleans — the table must stay exhaustive");
    for (const { flags, stages } of TABLE) {
      assert.deepEqual(activeStages(flags), stages, `flags ${JSON.stringify(flags)}`);
    }
  });

  it("no two combinations run the same tiers — neither flag is ever a no-op", () => {
    const seen = new Map<string, string>();
    for (const { flags } of TABLE) {
      const key = JSON.stringify(activeStages(flags));
      const label = JSON.stringify(flags);
      assert.equal(seen.get(key), undefined, `${label} is identical to ${seen.get(key)}`);
      seen.set(key, label);
    }
  });

  it("describeFlags labels every combination for the header line", () => {
    for (const { flags, label } of TABLE) assert.equal(describeFlags(flags), label);
  });
});

describe("formatCheckLine", () => {
  it("shows a glyph, the id, and the message", () => {
    const line = formatCheckLine(finding({ id: "parity", status: "warn", message: "local differs" }));
    assert.match(line, /!/);
    assert.match(line, /parity/);
    assert.match(line, /local differs/);
  });
});

describe("formatCheckDetails", () => {
  // The `check` verb's full output survives here: one indented line per
  // violation, with embedded newlines (a multi-line tsc error) split apart so
  // the indent holds for every line.
  it("indents each detail and splits embedded newlines", () => {
    const lines = formatCheckDetails(finding({ details: ["one", "two\nthree"] }));
    assert.deepEqual(lines, ["      one", "      two", "      three"]);
  });
  it("is empty when a finding has nothing to expand", () => {
    assert.deepEqual(formatCheckDetails(finding({})), []);
  });
});

// ---------- orchestrator against stubs ----------

const runData = (items: Array<Record<string, unknown>>) => [{ data: { main: [items.map((json) => ({ json }))] } }];

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  id: "wf1", name: "Order Sync", connections: {}, active: false, versionId: "v1", activeVersionId: null,
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode: "return [{json:{x:1}}];\n" } },
  ],
  ...over,
});

describe("runPreflight (stubbed)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const config = (root: string): DecanterConfig => ({
    configDir: root, root, workflows: [], commitOnPush: false, commitOnPull: false,
    requestTimeoutMs: 30_000, dataTables: true, liveMirror: true, backupLimit: 20, host: "http://x", apiKey: "k",
  });

  /** Seed a pulled workflow folder in sync with a draft + a fresh capture. */
  function seed(root: string, jsCode = "return [{json:{x:1}}];\n"): string {
    const dir = path.join(root, "order-sync");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    mkdirSync(path.join(dir, "executions"), { recursive: true });
    writeFileSync(path.join(dir, "code", "compute.js"), jsCode);
    // lastPushedHash = the draft body, so a differing local file reads as
    // "push-pending" (local ahead of the draft), not a manufactured conflict.
    const draftHash = sha256("return [{json:{x:1}}];\n");
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", name: "Order Sync", nodes: { c: { file: "code/compute.js", lastPushedHash: draftHash, name: "Compute" } } }));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ ...wf(), nodes: wf().nodes.map((n) => n.id === "c" ? { ...n, parameters: { jsCode: "//@file:code/compute.js" } } : n) }));
    writeFileSync(path.join(dir, "executions", "301.json"), JSON.stringify({ id: 301, workflowId: "wf1", data: { resultData: { runData: { Hook: runData([{ n: 1 }]), Compute: runData([{ x: 1 }]) } } } }));
    return dir;
  }

  function stub(remote: Workflow, ranData: Record<string, unknown>, opts: { history?: Array<{ id: string; status: string }>; testStatus?: string; detailsError?: Error; searchThrows?: boolean } = {}) {
    const calls: string[] = [];
    const mcp = {
      callTool: async (name: string, _args: any) => {
        calls.push(name);
        if (name === "get_workflow_details") {
          if (opts.detailsError) throw opts.detailsError;
          return { workflow: structuredClone(remote) };
        }
        if (name === "test_workflow") return { executionId: opts.testStatus === "error" ? null : "exec-1", status: opts.testStatus ?? "success" };
        if (name === "get_execution") return { execution: {}, data: { resultData: { runData: ranData } } };
        if (name === "search_executions") {
          if (opts.searchThrows) throw new Error("search_executions is not supported on this instance");
          return { data: opts.history ?? [{ id: "9", status: "success" }], count: (opts.history ?? []).length, estimated: false };
        }
        throw new Error("unexpected tool " + name);
      },
    } as unknown as McpClient;
    return { mcp, calls };
  }

  const baseCtx = (dir: string, root: string, mcp: McpClient, over: Partial<PreflightContext> = {}): PreflightContext => ({
    config: config(root), dir, id: "wf1", name: "Order Sync", flags: { simulate: false, offline: false },
    noFetch: true, failFast: false, simVersion: "1.100.0", hasApiKey: false,
    mcp: () => mcp, api: () => { throw new Error("no api in this test"); },
    dockerAvailable: async () => false, ...over,
  });

  it("bare preflight: runs the ladder, passes, and NEVER mutates", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("layout")?.status, "pass");
    assert.equal(byId.get("connect")?.status, "pass");
    assert.equal(byId.get("access")?.status, "pass");
    assert.equal(byId.get("parity")?.status, "pass");
    assert.equal(byId.get("drift")?.status, "pass");
    assert.equal(byId.get("simulate")?.status, "skip", "the local-engine replay is --simulate only");
    assert.equal(report.verdict, "ready");
    assert.equal(report.subject.parity, "match");
    // The --json contract (Plan 59): `flags` replaced the `profile` string, and
    // agents key on it.
    assert.deepEqual(report.flags, { simulate: false, offline: false });
    assert.ok(!calls.some((c) => /update_workflow|publish|restore/.test(c)), "preflight issued no writes: " + calls.join(","));
  });

  // Plan 60's core contract: preflight never EXECUTES the workflow on the
  // instance. Not a write — a run. `test_workflow` grades the draft, which
  // before a push is not the code being shipped.
  it("never runs the workflow on the instance, in any flag combination", async () => {
    for (const offline of [false, true]) {
      for (const simulate of [false, true]) {
        const flags: PreflightFlags = { simulate, offline };
        tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
        const dir = seed(tmp);
        const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
        await runPreflight(baseCtx(dir, tmp, mcp, { flags }));
        assert.ok(!calls.some((c) => /test_workflow|execute_workflow|get_execution/.test(c)), `${JSON.stringify(flags)} executed on the instance: ${calls.join(",")}`);
        rmSync(tmp, { recursive: true, force: true });
        tmp = undefined;
      }
    }
  });

  // Plan 59: with `check` retired, the static tier is the ONLY view of a layout
  // violation — so the one-line message names the first and `details` carries
  // every one: all errors, then the warnings the summary line never mentions.
  it("a layout failure carries EVERY violation in details, not just the first", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    rmSync(path.join(dir, "code", "compute.js")); // placeholder points at a missing file
    writeFileSync(path.join(dir, "code", "stray.js"), "return [];\n"); // orphan: no placeholder points here
    const { mcp } = stub(wf(), {});
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate: false, offline: true } }));
    const layout = report.checks.find((c) => c.id === "layout")!;
    const details = layout.details ?? [];
    assert.equal(layout.status, "fail");
    assert.match(layout.message, /2 layout violations/, "the summary counts the ERRORS and names the first");
    assert.ok(/referenced file code\/compute\.js is missing/.test(details[0]), JSON.stringify(details));
    assert.ok(/orphan code file code\/stray\.js/.test(details[1]), JSON.stringify(details));
    // …and the warning that the "2 violations" summary line never mentions —
    // errors first, warnings after, so nothing `check` used to print is lost.
    assert.equal(details.length, 3, JSON.stringify(details));
    assert.ok(/still records|records code\/compute\.js/.test(details[2]), JSON.stringify(details));
    // `remediation` is contractually a runnable command; the fix here is editing
    // the files named above, so the finding deliberately carries none.
    assert.equal(layout.remediation, undefined);
  });

  it("--no-typecheck skips the types check (the escape hatch `check` had)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), {});
    const offline: PreflightFlags = { simulate: false, offline: true };
    const skipped = (await runPreflight(baseCtx(dir, tmp, mcp, { flags: offline, noTypecheck: true }))).checks.find((c) => c.id === "types")!;
    assert.equal(skipped.status, "skip");
    assert.match(skipped.reason!, /--no-typecheck was passed/);
    assert.match(skipped.unlock!, /drop --no-typecheck/);
    // Without the flag the check still runs — it lands on the no-tsconfig skip
    // here, a DIFFERENT skip, which is what proves the flag did the skipping.
    const ran = (await runPreflight(baseCtx(dir, tmp, mcp, { flags: offline }))).checks.find((c) => c.id === "types")!;
    assert.match(ran.reason!, /no tsconfig\.json/);
  });

  it("no check id reports on the draft: every verdict-bearing stage grades local code", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp, "return [{json:{x:999}}];\n"); // local ahead of the draft
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("parity")?.status, "warn", "the divergence is reported…");
    assert.match(byId.get("parity")!.message, /push to make it the draft, then test/, "…and points at the flow");
    assert.equal(report.subject.parity, "local-ahead");
    assert.equal(byId.get("simulate")?.status, "skip", "the only runtime stage is local-engine and opt-in");
    assert.ok(!calls.some((c) => /test_workflow/.test(c)), "no instance run of the stale draft: " + calls.join(","));
    assert.equal(report.verdict, "caution");
  });

  // The two sync checks read the same facts, so they must not contradict each
  // other on one screen: a conflicting node does NOT match the draft, and
  // "✓ parity local code matches the draft" printed one line above
  // "✗ drift CONFLICT" is the report telling the user both at once.
  it("parity never claims a match while drift reports a CONFLICT", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp, "return [{json:{local:1}}];\n"); // local, draft and last-sync all differ
    const { mcp } = stub(wf({ nodes: wf().nodes.map((n) => (n.id === "c" ? { ...n, parameters: { jsCode: "return [{json:{remote:1}}];\n" } } : n)) }), {});
    const byId = new Map((await runPreflight(baseCtx(dir, tmp, mcp))).checks.map((c) => [c.id, c]));
    assert.equal(byId.get("drift")?.status, "fail", "precondition: this is a real conflict");
    assert.notEqual(byId.get("parity")?.status, "pass", `parity said "${byId.get("parity")?.message}" for a node in conflict`);
  });

  it("history warns when recent production runs failed", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) }, { history: [{ id: "1", status: "success" }, { id: "2", status: "error" }] });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const hist = report.checks.find((c) => c.id === "history");
    assert.equal(hist?.status, "warn");
    assert.match(hist!.message, /1 of 2 recent runs failed/);
  });

  it("--offline --simulate skips the whole sync tier and still reaches the engine stage", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp, calls } = stub(wf(), {});
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate: true, offline: true } }));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("layout")?.status, "pass", "static tier still runs offline");
    for (const id of ["connect", "access", "parity", "drift", "history"] as const) assert.equal(byId.get(id)?.status, "skip", `${id} skipped offline`);
    assert.equal(byId.get("simulate")?.status, "skip", "the engine stage was reached, then skipped for lack of Docker");
    assert.match(byId.get("simulate")!.reason!, /Docker not available/);
    assert.equal(calls.length, 0, "offline made no MCP calls");
  });

  // The Plan 59 inversion, pinned at the orchestrator: the retired `--offline`
  // PROFILE implied the engine run; the flag does not.
  it("bare --offline does not reach the engine stage — the replay is opt-in", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), {});
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate: false, offline: true } }));
    const sim = report.checks.find((c) => c.id === "simulate")!;
    assert.equal(sim.status, "skip");
    assert.match(sim.reason!, /the local-engine replay is opt-in/);
    assert.match(sim.unlock!, /--simulate/);
  });

  it("--require promotes a skipped required check to a fail, pointing at --simulate", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { requireIds: ["simulate"] }));
    const sim = report.checks.find((c) => c.id === "simulate");
    assert.equal(sim?.status, "fail", "simulate was skipped as opt-in, then promoted by --require");
    // The unlock becomes the remediation — and it must name the FLAG now; the
    // pre-Plan-59 text said "pass --full (or --offline)".
    assert.match(sim!.remediation!, /--simulate/);
    assert.doesNotMatch(sim!.remediation!, /--full/);
    assert.equal(report.verdict, "not ready");
  });

  it("streams each finding via onCheck as it completes", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const streamed: string[] = [];
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { onCheck: (f) => streamed.push(f.id) }));
    assert.deepEqual(streamed, report.checks.map((c) => c.id), "every check streamed once, in order");
    // a summary render must not throw
    const lines: string[] = [];
    const log: Log = { info: (m) => lines.push(m), ok() {}, warn() {}, error() {} };
    renderPreflightSummary(report, log);
    assert.ok(lines.some((l) => /verdict:/.test(l)));
  });

  it("stays read-only on a TTY where local differs from an unpublished draft", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp, "return [{json:{x:999}}];\n"); // local ahead of the (unpublished) draft
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    // The sharpest case: `test` on an unpublished workflow pushes WITHOUT a
    // prompt. Plan 60 removed the seam that used to hold preflight back — the
    // guarantee now comes from preflight never invoking runTest at all.
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = true;
      (process.stdout as any).isTTY = true;
      const report = await runPreflight(baseCtx(dir, tmp, mcp));
      assert.equal(report.checks.find((c) => c.id === "parity")?.status, "warn");
      assert.ok(!calls.some((c) => /update_workflow|publish|restore|test_workflow/.test(c)), "no mutation and no run on a TTY: " + calls.join(","));
    } finally {
      (process.stdin as any).isTTY = origIn;
      (process.stdout as any).isTTY = origOut;
    }
  });

  it("connect failure fails the gate and skips the sync + runtime tiers", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), {}, { detailsError: new Error("connect ECONNREFUSED 127.0.0.1:5678") });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("connect")?.status, "fail");
    for (const id of ["access", "parity", "drift", "history"] as const) assert.equal(byId.get(id)?.status, "skip", `${id} skipped after connect fail`);
    assert.equal(report.verdict, "not ready");
  });

  it("an unavailable-in-MCP workflow passes connect, fails access, skips parity/drift", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), {}, { detailsError: new Error("Workflow is not available in MCP.") });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("connect")?.status, "pass", "reached + authed the server");
    assert.equal(byId.get("access")?.status, "fail", "the workflow is not opted into MCP");
    for (const id of ["parity", "drift", "snapshot", "lifecycle"] as const) assert.equal(byId.get(id)?.status, "skip");
    assert.equal(report.verdict, "not ready");
  });

  it("history falls back to the REST executions API when search_executions is unavailable", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) }, { searchThrows: true });
    let restLimit: number | undefined;
    let restIncludeData: boolean | undefined;
    const api = () => ({
      listExecutions: async (o: any) => {
        restLimit = o.limit;
        restIncludeData = o.includeData;
        return [{ status: "success" }, { status: "error" }, { status: "success" }];
      },
    }) as any;
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { hasApiKey: true, api }));
    const hist = report.checks.find((c) => c.id === "history");
    assert.equal(hist?.status, "warn", "the REST fallback surfaced the failed run");
    assert.match(hist!.message, /1 of 3 recent runs failed/);
    assert.equal(restIncludeData, false, "history probe is metadata-only (includeData:false)");
    assert.equal(restLimit, 20);
  });

  it("auto-fetches the newest capture before the runtime tier when a key is set", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    rmSync(path.join(dir, "executions", "301.json")); // no local capture → must auto-fetch
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    let fetched = false;
    const api = () => ({
      listExecutions: async () => {
        fetched = true;
        return [{ id: 305, workflowId: "wf1", data: { resultData: { runData: { Hook: runData([{ n: 1 }]), Compute: runData([{ x: 1 }]) } } } }];
      },
    }) as any;
    // --simulate: the runtime consumer that makes a pin source worth fetching
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate: true, offline: false }, hasApiKey: true, noFetch: false, api }));
    assert.equal(fetched, true, "auto-fetch ran");
    const capture = report.checks.find((c) => c.id === "capture");
    assert.match(capture!.message, /auto-fetched/);
  });

  it("without --simulate nothing auto-fetches — nothing would consume a capture", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    rmSync(path.join(dir, "executions", "301.json"));
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    let fetched = false;
    const api = () => ({ listExecutions: async () => { fetched = true; return []; } }) as any;
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { hasApiKey: true, noFetch: false, api }));
    assert.equal(fetched, false, "no runtime stage without --simulate → no fetch");
    assert.equal(report.checks.find((c) => c.id === "capture")?.status, "info", "a missing capture is informational, not a warning");
  });

  it("a stale capture is info when nothing consumes it, warn when the runtime tier does", async () => {
    // Same rule as the missing-capture case: only a run that actually EXECUTES a
    // runtime stage should lose points over a stale pin.
    for (const [simulate, expected] of [[false, "info"], [true, "warn"]] as const) {
      tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
      const dir = seed(tmp);
      const capFile = path.join(dir, "executions", "301.json");
      const cap = JSON.parse(readFileSync(capFile, "utf8"));
      cap.workflowVersionId = "v-predates-draft"; // wf() draft is v1 → stale
      writeFileSync(capFile, JSON.stringify(cap));
      const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
      const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate, offline: false } }));
      const capture = report.checks.find((c) => c.id === "capture");
      assert.equal(capture?.status, expected, `simulate=${simulate}: a stale capture should be ${expected}`);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a missing --execution id warns on capture and skips the runtime tier (no throw)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { flags: { simulate: true, offline: false }, executionId: "99999" }));
    const capture = report.checks.find((c) => c.id === "capture");
    assert.equal(capture?.status, "warn");
    assert.match(capture!.message, /#99999 not found/);
    assert.equal(report.checks.find((c) => c.id === "simulate")?.status, "skip", "runtime skips cleanly, no mid-run throw");
  });
});
