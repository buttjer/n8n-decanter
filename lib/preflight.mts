// The `preflight` verb (Plan 36): one command that runs the whole verification
// ladder — local static (layout/types) → instance read-only (connect/access/
// parity/drift/snapshot/lifecycle/history/capture) → pinned draft runs (test/
// simulate) — ordered fast→slow, and condenses them into a scored, CI-gateable
// verdict. It adds ZERO execution paths: every stage reuses existing machinery
// (validate/status/testrun/simulate/executions), quietly (a silent Log), and
// scores the returned facts. Nothing here mutates: no push, no publish, no
// restore, no draft write — `runTest` is always invoked in its never-mutate mode
// and `runSimulation` headless with `--network-none` forced on.
import { existsSync, readFileSync } from "node:fs";
import type { N8nApi } from "./api.mts";
import { fetchExecutions, latestCaptureId, migrateScenariosDir } from "./executions.mts";
import { ENABLE_MCP_HINT, getWorkflowDetails, isUnavailableInMcp, type McpClient, searchExecutions } from "./mcp.mts";
import { computeSyncFacts, type SyncFacts } from "./status.mts";
import { runTest } from "./testrun.mts";
import { readScenarioMeta, runSimulation, type SimSource, sourceFile } from "./simulate.mts";
import type { DecanterConfig, Execution, Log, Workflow } from "./types.mts";
import { runTypecheckResult, validateWorkflowDir } from "./validate.mts";
import { publicationState, publishedVersionLagsDraft } from "./util.mts";

// ---------- model ----------

export type CheckId =
  | "layout" | "types"
  | "connect" | "access" | "parity" | "drift" | "snapshot" | "lifecycle" | "history" | "capture"
  | "test" | "simulate";

export type Tier = "static" | "sync" | "runtime";
export type CheckStatus = "pass" | "warn" | "fail" | "skip" | "info";
export type Verdict = "ready" | "caution" | "not ready";
export type Profile = "quick" | "default" | "full" | "offline";

export const ALL_CHECK_IDS: readonly CheckId[] = [
  "layout", "types", "connect", "access", "parity", "drift", "snapshot", "lifecycle", "history", "capture", "test", "simulate",
];

export interface CheckFinding {
  id: CheckId;
  tier: Tier;
  status: CheckStatus;
  /** One-line human summary for the card. */
  message: string;
  /** The exact next command to fix a warn/fail (agent + human contract). */
  remediation?: string;
  durationMs: number;
  /** Skip-only: why it didn't run … */
  reason?: string;
  /** … and the flag/command that unlocks it. */
  unlock?: string;
}

export interface PreflightSubject {
  draftVersionId?: string;
  publishedVersionId?: string | null;
  /** Local code vs the draft the runtime checks actually cover. */
  parity: "match" | "local-ahead" | "unknown";
}

export interface Coverage {
  ran: CheckId[];
  skipped: Array<{ id: CheckId; reason: string; unlock?: string }>;
}

export interface PreflightReport {
  workflow: string;
  id: string;
  profile: Profile;
  subject: PreflightSubject;
  checks: CheckFinding[];
  score: number;
  verdict: Verdict;
  coverage: Coverage;
}

// ---------- pure scoring / verdict / coverage (unit-tested; no IO) ----------

/**
 * 0–100 trend score (the verdict is the gate; this is presentation). Each `fail`
 * costs 40 (a CONFLICT `drift` fail 30); each `warn` costs 10; floor 0.
 * `info`/`skip`/`pass` cost nothing. Weights are starting values — tunable.
 */
export function scoreFindings(checks: CheckFinding[]): number {
  let score = 100;
  for (const c of checks) {
    if (c.status === "fail") score -= c.id === "drift" ? 30 : 40;
    else if (c.status === "warn") score -= 10;
  }
  return Math.max(0, score);
}

/** Deterministic verdict: any fail → not ready; else any warn → caution; else ready. */
export function verdictOf(checks: CheckFinding[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "not ready";
  if (checks.some((c) => c.status === "warn")) return "caution";
  return "ready";
}

/** Exit code: not-ready → 1; caution → 1 only with `--fail-on=warn`; else 0. */
export function exitCodeOf(verdict: Verdict, { failOnWarn = false }: { failOnWarn?: boolean } = {}): 0 | 1 {
  if (verdict === "not ready") return 1;
  if (verdict === "caution" && failOnWarn) return 1;
  return 0;
}

export function coverageOf(checks: CheckFinding[]): Coverage {
  return {
    ran: checks.filter((c) => c.status !== "skip").map((c) => c.id),
    skipped: checks.filter((c) => c.status === "skip").map((c) => ({ id: c.id, reason: c.reason ?? c.message, unlock: c.unlock })),
  };
}

/**
 * `--require=<ids>`: turn a *skip* of a named check into a *fail* — the CI teeth
 * for "must have runtime coverage". A required check that ran is left untouched.
 */
export function applyRequire(checks: CheckFinding[], requireIds: CheckId[]): CheckFinding[] {
  if (requireIds.length === 0) return checks;
  const req = new Set(requireIds);
  return checks.map((c) =>
    req.has(c.id) && c.status === "skip"
      ? { ...c, status: "fail" as const, message: `required check "${c.id}" did not run — ${c.reason ?? c.message}`, remediation: c.unlock ?? c.remediation }
      : c,
  );
}

interface ProfileSpec {
  /** run the instance read-only tier (connect/access/parity/drift/…/history/capture). */
  sync: boolean;
  /** run the instance-side pinned `test_workflow` run. */
  test: boolean;
  /** run the local-engine `simulate` replay. */
  simulate: boolean;
}

const PROFILES: Record<Profile, ProfileSpec> = {
  quick: { sync: true, test: false, simulate: false },
  default: { sync: true, test: true, simulate: false },
  full: { sync: true, test: true, simulate: true },
  offline: { sync: false, test: false, simulate: true },
};

export function profileSpec(profile: Profile): ProfileSpec {
  return PROFILES[profile];
}

// ---------- orchestrator ----------

const SILENT: Log = { info() {}, ok() {}, warn() {}, error() {} };

export interface PreflightContext {
  config: DecanterConfig;
  dir: string;
  id: string;
  name: string;
  profile: Profile;
  /** Pin source: an explicit `--scenario <slug>` or (else) a capture. */
  scenarioSlug?: string;
  /** Explicit `--execution <id>`; without it a capture defaults to the newest. */
  executionId?: string;
  trigger?: string;
  noFetch: boolean;
  failFast: boolean;
  /** `--require=<ids>`: a skip of any of these check ids is promoted to a fail. */
  requireIds?: CheckId[];
  /** Engine version for the `simulate` stage. */
  simVersion: string;
  /** True when N8N_API_KEY is set (REST auto-fetch + `history` fallback). */
  hasApiKey: boolean;
  /** Lazy default-timeout MCP client (throws on missing creds — caught by `connect`). */
  mcp: () => McpClient;
  /** Lazy ≥320 s-timeout MCP client for `test_workflow`'s 5-min server cap. */
  testMcp: () => McpClient;
  /** Lazy REST client (throws without a key). */
  api: () => N8nApi;
  /** Docker probe for the `simulate` stage. */
  dockerAvailable: () => Promise<boolean>;
  /** Streamed callback — fired as each check finalizes (undefined for --json). */
  onCheck?: (finding: CheckFinding) => void;
}

/** Run the ladder for one workflow and return the scored report. Never mutates. */
export async function runPreflight(ctx: PreflightContext): Promise<PreflightReport> {
  const spec = PROFILES[ctx.profile];
  const checks: CheckFinding[] = [];
  const requireSet = new Set(ctx.requireIds ?? []);
  let anyFailed = false;

  const emit = (finding: CheckFinding): CheckFinding => {
    // --require: promote a skip of a required check to a fail BEFORE streaming,
    // so the live line and the summary agree and --fail-fast sees the fail.
    const f: CheckFinding = finding.status === "skip" && requireSet.has(finding.id)
      ? { ...finding, status: "fail", message: `required check "${finding.id}" did not run — ${finding.reason ?? finding.message}`, remediation: finding.unlock ?? finding.remediation }
      : finding;
    checks.push(f);
    if (f.status === "fail") anyFailed = true;
    ctx.onCheck?.(f);
    return f;
  };
  const skip = (id: CheckId, tier: Tier, reason: string, unlock?: string): void => {
    emit({ id, tier, status: "skip", message: reason, reason, unlock, durationMs: 0 });
  };
  /** Run one check fn (returns a partial finding), timing + streaming it. `--fail-fast` short-circuits to skip once anything has failed. */
  const run = async (id: CheckId, tier: Tier, fn: () => Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">>): Promise<CheckFinding> => {
    if (ctx.failFast && anyFailed) {
      const f: CheckFinding = { id, tier, status: "skip", message: "fail-fast: a prior check failed", reason: "fail-fast: a prior check failed", unlock: "drop --fail-fast to run every check", durationMs: 0 };
      return emit(f);
    }
    const started = performance.now();
    let partial: Omit<CheckFinding, "id" | "tier" | "durationMs">;
    try {
      partial = await fn();
    } catch (err) {
      partial = { status: "fail", message: (err as Error).message.split("\n")[0] };
    }
    return emit({ id, tier, durationMs: Math.round(performance.now() - started), ...partial });
  };

  const subject: PreflightSubject = { parity: "unknown" };
  const cli = (verb: string) => `n8n-decanter ${verb} ${ctx.name}`;

  // ---- STATIC (offline, ms) — always runs ----
  await run("layout", "static", async () => {
    const { errors, warnings } = validateWorkflowDir(ctx.dir);
    if (errors.length > 0) return { status: "fail", message: `${errors.length} layout violation${errors.length === 1 ? "" : "s"}: ${errors[0]}`, remediation: cli("check") };
    if (warnings.length > 0) return { status: "warn", message: `${warnings.length} layout warning${warnings.length === 1 ? "" : "s"}: ${warnings[0]}`, remediation: cli("check") };
    return { status: "pass", message: "layout compliant" };
  });
  await run("types", "static", async () => {
    const r = await runTypecheckResult(ctx.config.configDir, [ctx.dir]);
    if (r.status === "failed") return { status: "fail", message: `typecheck failed: ${(r.output ?? "").split("\n")[0]}`, remediation: cli("check") };
    if (r.status === "skipped") return { status: "skip", message: "no tsconfig.json — typecheck skipped", reason: "no tsconfig.json found", unlock: "add a tsconfig.json to enable type checks" };
    return { status: "pass", message: "node files typecheck clean" };
  });

  // ---- SYNC (instance, read-only) ----
  let remote: Workflow | undefined;
  let facts: SyncFacts | undefined;
  if (!spec.sync) {
    for (const id of ["connect", "access", "parity", "drift", "snapshot", "lifecycle", "history"] as CheckId[]) {
      skip(id, "sync", `--${ctx.profile} skips the instance tier`, "drop --offline to run instance checks");
    }
  } else {
    // connect + access: one getWorkflowDetails read. Reaching + authing the
    // server = connect pass; an availability refusal (isUnavailableInMcp) means
    // connect passed but access fails; any other error = connect fail.
    let connectOk = false;
    let unavailable = false;
    await run("connect", "sync", async () => {
      try {
        remote = await getWorkflowDetails(ctx.mcp(), ctx.id);
        connectOk = true;
        return { status: "pass", message: "MCP reachable, auth valid" };
      } catch (err) {
        if (isUnavailableInMcp(err)) {
          connectOk = true;
          unavailable = true;
          return { status: "pass", message: "MCP reachable, auth valid" };
        }
        return { status: "fail", message: `cannot reach MCP: ${(err as Error).message.split("\n")[0]}`, remediation: `n8n-decanter init  (or check N8N_HOST / N8N_MCP_TOKEN)` };
      }
    });

    if (!connectOk) {
      for (const id of ["access", "parity", "drift", "snapshot", "lifecycle", "history"] as CheckId[]) {
        skip(id, "sync", "MCP unreachable (connect failed)", "fix the connect failure above");
      }
    } else {
      await run("access", "sync", async () => {
        if (unavailable) return { status: "fail", message: "workflow is not available in MCP", remediation: ENABLE_MCP_HINT };
        return { status: "pass", message: "workflow available in MCP" };
      });

      if (remote !== undefined) {
        subject.draftVersionId = typeof remote.versionId === "string" ? remote.versionId : undefined;
        subject.publishedVersionId = remote.activeVersionId ?? undefined;
        facts = await computeSyncFacts(remote, ctx.dir);

        await run("parity", "sync", async () => {
          const off = facts!.nodes.filter((n) => n.state === "push-pending" || n.state === "local-missing");
          if (off.length === 0) {
            subject.parity = "match";
            return { status: "pass", message: "local code matches the draft" };
          }
          subject.parity = "local-ahead";
          const missing = off.some((n) => n.state === "local-missing");
          return {
            status: "warn",
            message: missing
              ? `${off.length} node(s) differ from the draft (a local file is missing) — the runtime verdict covers the draft, not local`
              : `local code differs from the draft in ${off.length} node(s) — the runtime verdict covers the draft; push first, or --full to simulate local`,
            remediation: cli("push"),
          };
        });

        await run("drift", "sync", async () => {
          const conflict = facts!.nodes.filter((n) => n.state === "conflict");
          if (conflict.length > 0) {
            return { status: "fail", message: `CONFLICT — ${conflict.length} node(s) changed both locally and remotely`, remediation: `${cli("status")} --diff` };
          }
          const moved = facts!.nodes.filter((n) => n.state === "changed-remotely" || n.state === "unknown-locally");
          if (moved.length > 0 || facts!.deleted.length > 0) {
            const n = moved.length + facts!.deleted.length;
            return { status: "warn", message: `${n} node(s) changed remotely — pull before publishing`, remediation: cli("pull") };
          }
          return { status: "pass", message: "no remote code drift" };
        });

        await run("snapshot", "sync", async () => {
          if (facts!.snapshot === "stale") return { status: "warn", message: "structure snapshot out of date — pull to refresh workflow.json", remediation: cli("pull") };
          if (facts!.snapshot === "unreadable") return { status: "warn", message: "workflow.json unreadable — pull to rewrite the snapshot", remediation: cli("pull") };
          return { status: "pass", message: "structure snapshot current" };
        });

        await run("lifecycle", "sync", async () => {
          const pub = publicationState(remote);
          if (publishedVersionLagsDraft(remote) === true) return { status: "info", message: "published — the live version is older than the draft (publish to go live)" };
          if (pub === "published") return { status: "info", message: "published — live matches the draft" };
          if (pub === "unpublished") return { status: "info", message: "unpublished — draft only" };
          return { status: "info", message: "publication state unknown" };
        });
      } else {
        for (const id of ["parity", "drift", "snapshot", "lifecycle"] as CheckId[]) {
          skip(id, "sync", "workflow not available in MCP", ENABLE_MCP_HINT);
        }
      }

      // history: production-run health. MCP search_executions preferred; REST
      // listExecutions (no run data) fallback; neither → skip. Never fails —
      // the draft isn't guilty of the live workflow's past.
      await run("history", "sync", async () => historyCheck(ctx));
    }
  }

  // ---- capture (+ auto-fetch): a pin source for the runtime tier ----
  migrateScenariosDir(ctx.dir, SILENT);
  const runtimeActive = spec.test || spec.simulate;
  const src = await resolveSource(ctx, remote, runtimeActive);
  await run("capture", "sync", async () => src.finding);

  // ---- RUNTIME (executes; minutes) ----
  await runtimeCheck(ctx, "test", spec.test, remote !== undefined, src, run, () => runTestStage(ctx, src));
  await runtimeCheck(ctx, "simulate", spec.simulate, true, src, run, () => runSimulateStage(ctx, src));

  const score = scoreFindings(checks);
  const verdict = verdictOf(checks);
  return { workflow: ctx.name, id: ctx.id, profile: ctx.profile, subject, checks, score, verdict, coverage: coverageOf(checks) };
}

// ---------- stage helpers ----------

/** Resolved pin source for the runtime tier. */
interface ResolvedSource {
  source: SimSource;
  /** slug or execution id; undefined when nothing is available to pin from. */
  ref?: string;
  /** The finding for the `capture` check. */
  finding: Omit<CheckFinding, "id" | "tier" | "durationMs">;
}

/**
 * Pick the pin source (explicit scenario/execution or the newest capture) and,
 * for a `capture` source with no explicit id, auto-fetch the newest execution
 * when a key is present and the local capture is missing/stale (read-only;
 * gitignored). Returns the source plus the `capture` check finding.
 */
async function resolveSource(ctx: PreflightContext, remote: Workflow | undefined, runtimeActive: boolean): Promise<ResolvedSource> {
  const bothPaths = "capture a run (n8n-decanter executions " + ctx.name + ") or scaffold one (n8n-decanter scenario create " + ctx.name + " --scaffold)";
  if (ctx.scenarioSlug !== undefined) {
    const file = sourceFile(ctx.dir, ctx.scenarioSlug, "scenario");
    if (file === null || !existsSync(file)) {
      return { source: "scenario", finding: { status: runtimeActive ? "warn" : "info", message: `scenario "${ctx.scenarioSlug}" not found`, remediation: `n8n-decanter scenario create ${ctx.name} "${ctx.scenarioSlug}"` } };
    }
    const stale = captureStaleness(ctx.dir, ctx.scenarioSlug, "scenario", remote);
    return { source: "scenario", ref: ctx.scenarioSlug, finding: staleFinding(`scenario "${ctx.scenarioSlug}"`, stale, ctx) };
  }

  // capture source
  let ref = ctx.executionId ?? latestCaptureId(ctx.dir) ?? undefined;
  let autoFetched = false;
  if (ctx.executionId === undefined && runtimeActive && !ctx.noFetch && ctx.hasApiKey && remote !== undefined) {
    const stale = ref !== undefined ? captureStaleness(ctx.dir, ref, "capture", remote) : "missing";
    if (stale === "missing" || stale === "stale") {
      try {
        await fetchExecutions(ctx.api(), ctx.config.root, ctx.id, { limit: 1 }, SILENT);
        ref = latestCaptureId(ctx.dir) ?? ref;
        autoFetched = true;
      } catch {
        // read-only best effort — a fetch failure just leaves the existing capture (or none)
      }
    }
  }
  if (ref === undefined) {
    const message = ctx.hasApiKey || !runtimeActive ? "no capture or scenario to pin the runtime tier from" : "no capture or scenario, and no N8N_API_KEY to auto-fetch one";
    return { source: "capture", finding: { status: runtimeActive ? "warn" : "info", message, remediation: bothPaths, reason: message, unlock: bothPaths } };
  }
  const stale = captureStaleness(ctx.dir, ref, "capture", remote);
  if (stale === "missing") {
    // an explicit --execution id with no local capture file: warn and drop the
    // ref so the runtime tier skips cleanly instead of throwing mid-run.
    const message = `capture #${ref} not found under executions/`;
    const unlock = `n8n-decanter executions ${ctx.name} --limit=1  (or drop --execution to use the newest)`;
    return { source: "capture", finding: { status: runtimeActive ? "warn" : "info", message, remediation: unlock, reason: message, unlock } };
  }
  const fresh = staleFinding(`capture #${ref}${autoFetched ? " (auto-fetched)" : ""}`, stale, ctx);
  return { source: "capture", ref, finding: fresh };
}

type Staleness = "fresh" | "stale" | "unknown" | "missing";

/** Compare a capture/scenario's create-time draft version to the current draft. */
function captureStaleness(dir: string, ref: string, source: SimSource, remote: Workflow | undefined): Staleness {
  const file = sourceFile(dir, ref, source);
  if (file === null || !existsSync(file)) return "missing";
  const draft = remote !== undefined && typeof remote.versionId === "string" ? remote.versionId : undefined;
  if (draft === undefined) return "unknown";
  try {
    const exec = JSON.parse(readFileSync(file, "utf8")) as Execution;
    const ranVersion = source === "scenario" ? readScenarioMeta(exec)?.workflowVersionId : (typeof exec.workflowVersionId === "string" ? exec.workflowVersionId : undefined);
    if (ranVersion === undefined) return "unknown";
    return ranVersion === draft ? "fresh" : "stale";
  } catch {
    return "unknown";
  }
}

function staleFinding(label: string, stale: Staleness, ctx: PreflightContext): Omit<CheckFinding, "id" | "tier" | "durationMs"> {
  if (stale === "stale") return { status: "warn", message: `${label} predates the current draft — refetch so runtime checks pin against fresh reality`, remediation: `n8n-decanter executions ${ctx.name}` };
  return { status: "pass", message: `${label}${stale === "fresh" ? " (fresh)" : ""} available to pin from` };
}

/** Shared skip/gating logic for the two runtime checks. */
async function runtimeCheck(
  ctx: PreflightContext,
  id: "test" | "simulate",
  active: boolean,
  instanceOk: boolean,
  src: ResolvedSource,
  run: (id: CheckId, tier: Tier, fn: () => Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">>) => Promise<CheckFinding>,
  stage: () => Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">>,
): Promise<void> {
  if (!active) {
    const unlock = id === "test" ? "run the default profile (drop --quick / --offline)" : "pass --full (or --offline) to add simulate";
    await run(id, "runtime", async () => ({ status: "skip", message: `${id} not in the ${ctx.profile} profile`, reason: `${id} not in the ${ctx.profile} profile`, unlock }));
    return;
  }
  if (id === "test" && !instanceOk) {
    await run(id, "runtime", async () => ({ status: "skip", message: "instance unreachable / workflow not available in MCP", reason: "instance unreachable / workflow not available in MCP", unlock: ENABLE_MCP_HINT }));
    return;
  }
  if (src.ref === undefined) {
    await run(id, "runtime", async () => ({ status: "skip", message: "no capture or scenario to pin from", reason: "no capture or scenario to pin from", unlock: src.finding.unlock ?? "n8n-decanter executions " + ctx.name }));
    return;
  }
  await run(id, "runtime", stage);
}

async function runTestStage(ctx: PreflightContext, src: ResolvedSource): Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">> {
  const report = await runTest(ctx.testMcp(), ctx.config, ctx.dir, ctx.id, { ref: src.ref!, source: src.source, trigger: ctx.trigger, neverMutate: true }, SILENT);
  if (report.status !== "success") return { status: "fail", message: `instance run failed: ${report.error ?? report.status}`, remediation: `${cliRef(ctx, "test")} --execution <id>` };
  if (report.syntheticPins) return { status: "pass", message: `ran on the instance — synthetic pins (authored/scaffolded): proves executability, not output correctness (no per-node diff)` };
  if (report.divergent.length > 0) return { status: "fail", message: `${report.divergent.length} node(s) diverged from the capture: ${report.divergent.join(", ")}`, remediation: `${cliRef(ctx, "test")} --execution <id> --diff` };
  return { status: "pass", message: `${report.diffs.length} node(s) ran on the instance, all matched the capture (${report.pinned.length} pinned)` };
}

async function runSimulateStage(ctx: PreflightContext, src: ResolvedSource): Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">> {
  if (!(await ctx.dockerAvailable())) {
    return { status: "skip", message: "Docker not available — the simulate engine needs it", reason: "Docker not available", unlock: "start Docker (or wait for the npx engine backend)" };
  }
  // safety contract: headless + --network-none always on; the viewer never applies here.
  const report = await runSimulation(ctx.dir, src.ref!, { version: ctx.simVersion, source: src.source, networkNone: true, viewer: false }, SILENT);
  if (!report.engineOk) return { status: "fail", message: `local engine run failed: ${report.engineError ?? "unknown error"}`, remediation: `${cliRef(ctx, "simulate")} --network-none` };
  if (report.syntheticPins) return { status: "pass", message: `local engine ran clean — synthetic pins: proves executability, not output correctness (no per-node diff)` };
  if (report.divergent.length > 0) return { status: "fail", message: `${report.divergent.length} node(s) diverged from the capture: ${report.divergent.join(", ")}`, remediation: `${cliRef(ctx, "simulate")}` };
  return { status: "pass", message: `${report.pure.length} node(s) ran on a local engine, all matched the capture` };
}

async function historyCheck(ctx: PreflightContext): Promise<Omit<CheckFinding, "id" | "tier" | "durationMs">> {
  const LIMIT = 20;
  let rows: Array<{ status?: string; startedAt?: string | null; stoppedAt?: string | null }> | undefined;
  try {
    rows = await searchExecutions(ctx.mcp(), { workflowId: ctx.id, limit: LIMIT });
  } catch {
    if (ctx.hasApiKey) {
      try {
        rows = await ctx.api().listExecutions({ workflowId: ctx.id, limit: LIMIT, includeData: false });
      } catch {
        rows = undefined;
      }
    }
  }
  if (rows === undefined) {
    const reason = ctx.hasApiKey ? "search_executions unavailable and the REST executions probe failed" : "no MCP search_executions and no N8N_API_KEY for the REST fallback";
    return { status: "skip", message: reason, reason, unlock: "upgrade n8n for search_executions, or set N8N_API_KEY" };
  }
  if (rows.length === 0) return { status: "info", message: "no recent production runs" };
  const failed = rows.filter((r) => r.status === "error" || r.status === "crashed");
  if (failed.length === 0) return { status: "pass", message: `${rows.length} recent run(s), none failed` };
  const last = failed.map((r) => r.stoppedAt ?? r.startedAt ?? "").filter(Boolean).sort().at(-1);
  const when = last !== undefined && last !== "" ? ` (last ${last.slice(0, 10)})` : "";
  return { status: "warn", message: `${failed.length} of ${rows.length} recent runs failed${when}`, remediation: `n8n-decanter executions ${ctx.name} --status=error` };
}

function cliRef(ctx: PreflightContext, verb: string): string {
  return `n8n-decanter ${verb} ${ctx.name}`;
}

// ---------- rendering ----------

const GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "⤷", info: "·" };

/** Style-agnostic colorizer so this module doesn't hard-depend on a TTY at import. */
export interface Palette {
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

const PLAIN: Palette = { green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s };

function colorFor(status: CheckStatus, p: Palette): (s: string) => string {
  if (status === "pass") return p.green;
  if (status === "warn") return p.yellow;
  if (status === "fail") return p.red;
  return p.dim;
}

/** One streamed check line: `  ✓ parity    <message>   (0.1s)`. */
export function formatCheckLine(f: CheckFinding, palette: Palette = PLAIN): string {
  const color = colorFor(f.status, palette);
  const glyph = color(GLYPH[f.status]);
  const id = f.id.padEnd(9);
  const dur = f.durationMs >= 100 ? palette.dim(` (${(f.durationMs / 1000).toFixed(1)}s)`) : "";
  return `  ${glyph} ${palette.bold(id)} ${f.message}${dur}`;
}

/** The header + score/verdict/coverage summary + warn/fail/skip detail lines. */
export function renderPreflightSummary(report: PreflightReport, log: Log, palette: Palette = PLAIN): void {
  const verdictColor = report.verdict === "ready" ? palette.green : report.verdict === "caution" ? palette.yellow : palette.red;
  const ranN = report.coverage.ran.length;
  const totalN = report.checks.length;
  log.info(`score ${report.score}/100 · verdict: ${verdictColor(report.verdict)} · ${ranN}/${totalN} checks ran`);
  for (const c of report.checks) {
    if (c.status === "warn" || c.status === "fail") {
      const color = colorFor(c.status, palette);
      log.info(`  ${color(GLYPH[c.status])} ${c.id}: ${c.message}${c.remediation !== undefined ? palette.dim(` → ${c.remediation}`) : ""}`);
    }
  }
  for (const s of report.coverage.skipped) {
    log.info(palette.dim(`  ⤷ skipped ${s.id}: ${s.reason}${s.unlock !== undefined ? ` — ${s.unlock}` : ""}`));
  }
}

/** Full non-streamed render (header + every check line + summary) — used by tests. */
export function renderPreflight(report: PreflightReport, log: Log, palette: Palette = PLAIN): void {
  const subj = report.subject;
  const bits = [
    subj.draftVersionId !== undefined ? `draft ${subj.draftVersionId}` : undefined,
    subj.publishedVersionId != null ? `published ${subj.publishedVersionId}` : undefined,
  ].filter(Boolean);
  log.info(`${palette.bold(`preflight: ${report.workflow}`)}${bits.length > 0 ? "   " + palette.dim(bits.join(" · ")) : ""}  ${palette.dim(`[${report.profile}]`)}`);
  for (const c of report.checks) log.info(formatCheckLine(c, palette));
  renderPreflightSummary(report, log, palette);
}
