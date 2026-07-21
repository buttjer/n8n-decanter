// Plan 7 — the engine backend for `simulate`. Runs a transformed simulation
// workflow through a *real* n8n via route B (validated by the Plan 7 spike):
// `n8n import:workflow` + `n8n execute --id --rawOutput` in a throwaway
// container, no server and no credentials, output scraped from the result JSON.
//
// Backend: Docker (`n8nio/n8n:<version>`). The plan's eventual default is a
// dependency-free `npx n8n@<ver>` backend; that needs its own validation
// (heavy native install) and is a follow-up — the backend is pluggable, Docker
// is what's proven. `--network none` adds an enforced outbound cutoff on top of
// the structural guarantee (no I/O-capable node survives the transform).
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Log, Workflow } from "./types.mts";
import type { RunItem } from "./simulate.mts";

const execFile = promisify(execFileCb);

/** n8n version the engine defaults to — the smoke-suite pin (Plan 7 version policy). */
/* Keep in sync with test/smoke-n8n.mts IMAGE and .github/workflows/ci.yml smoke floor. */
export const DEFAULT_N8N_VERSION = "2.30.7";

/** Fixed workflow id the sim copy is imported under (throwaway DB, one workflow). */
const SIM_WORKFLOW_ID = "decantersim0000";
const EXEC_MARKER = "---DECANTER-EXEC---";

export interface EngineOptions {
  /** n8n version tag (e.g. "2.30.7"). */
  version: string;
  /** Enforce Docker `--network none` — the opt-in hard-isolation mode. */
  networkNone?: boolean;
}

export interface EngineRun {
  /** Per-node output items (first run, first output), keyed by node name. */
  runData: Map<string, RunItem[]>;
  /** True when the engine reported the run as successful. */
  ok: boolean;
  /** Engine error message when the run failed (else undefined). */
  error?: string;
}

const docker = (args: string[], opts: { timeoutMs?: number } = {}) =>
  execFile("docker", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 });

/** True when a Docker daemon is reachable — lets `simulate`/`test:sim` skip cleanly. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Isolation env for the engine container (Plan 7 task 4): telemetry/notifications/
 *  template fetches off, Code-node module allowlists emptied. Credentials never
 *  enter — `docker run` passes only these `-e` values, so host `N8N_*` stays out. */
function isolationEnv(): string[] {
  return [
    "N8N_DIAGNOSTICS_ENABLED=false",
    "N8N_VERSION_NOTIFICATIONS_ENABLED=false",
    "N8N_TEMPLATES_ENABLED=false",
    "N8N_PERSONALIZATION_ENABLED=false",
    "EXTERNAL_FRONTEND_HOOKS_URLS=",
    "NODE_FUNCTION_ALLOW_EXTERNAL=",
    "N8N_USER_FOLDER=/tmp/n8n",
  ];
}

/** Normalize an n8n `runData` object (from CLI JSON or the API) into a per-node item map. */
function runDataToMap(rd: Record<string, unknown>): Map<string, RunItem[]> {
  const map = new Map<string, RunItem[]>();
  for (const [node, runs] of Object.entries(rd)) {
    const main = (runs as Array<{ data?: { main?: Array<Array<RunItem> | null> } }>)?.[0]?.data?.main;
    map.set(node, Array.isArray(main) && Array.isArray(main[0]) ? main[0] : []);
  }
  return map;
}

/** Parse the `--rawOutput` result JSON that follows our marker, into a runData map. */
function parseRunData(stdout: string): EngineRun {
  const after = stdout.includes(EXEC_MARKER) ? stdout.slice(stdout.indexOf(EXEC_MARKER) + EXEC_MARKER.length) : stdout;
  const start = after.indexOf("{");
  const end = after.lastIndexOf("}");
  if (start === -1 || end <= start) {
    const tail = stdout.trim().split("\n").slice(-4).join(" | ").slice(0, 400);
    return { runData: new Map(), ok: false, error: `engine produced no result JSON — ${tail}` };
  }
  let parsed: { data?: { resultData?: { runData?: Record<string, unknown>; error?: { message?: string } } } };
  try {
    parsed = JSON.parse(after.slice(start, end + 1));
  } catch (err) {
    return { runData: new Map(), ok: false, error: `unparsable engine result JSON (${(err as Error).message})` };
  }
  const error = parsed.data?.resultData?.error?.message;
  return { runData: runDataToMap(parsed.data?.resultData?.runData ?? {}), ok: error === undefined, error };
}

/**
 * Import the simulation workflow into a throwaway n8n and execute it, returning
 * per-node output. Throws only on infrastructure failure (no Docker, image
 * missing); a workflow that errors inside the engine comes back as `ok: false`
 * with the message — the caller decides what a failed run means.
 */
export async function runEngine(workflow: Workflow, opts: EngineOptions, log: Log): Promise<EngineRun> {
  const image = `n8nio/n8n:${opts.version}`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-sim-"));
  const simFile = path.join(tmp, "sim.json");
  const container = `decanter-sim-${process.pid}-${Date.now()}`;
  writeFileSync(simFile, JSON.stringify({ ...workflow, id: SIM_WORKFLOW_ID, active: false }));
  const runArgs = [
    "run", "--rm", "--name", container,
    ...(opts.networkNone ? ["--network", "none"] : []),
    ...isolationEnv().flatMap((e) => ["-e", e]),
    "-v", `${simFile}:/tmp/sim.json:ro`,
    "--entrypoint", "sh", image,
    "-c", `mkdir -p /tmp/n8n && n8n import:workflow --input=/tmp/sim.json >/tmp/import.log 2>&1 && echo '${EXEC_MARKER}' && n8n execute --id=${SIM_WORKFLOW_ID} --rawOutput 2>/dev/null`,
  ];
  log.info(`engine: ${image}${opts.networkNone ? " (network: none)" : ""} — importing + executing simulation`);
  try {
    const { stdout, stderr } = await docker(runArgs, { timeoutMs: 180_000 });
    return parseRunData(stdout + stderr);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // A non-zero exit with a result JSON still means "ran, workflow errored".
    if ((e.stdout ?? "").includes(EXEC_MARKER)) return parseRunData((e.stdout ?? "") + (e.stderr ?? ""));
    throw new Error(`engine run failed (${image}): ${(e.stderr || e.message || "").split("\n").slice(0, 3).join(" ").slice(0, 300)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await docker(["rm", "-f", container], { timeoutMs: 15_000 }).catch(() => {});
  }
}

/** Stable name of the kept-alive viewer container (one at a time; replaced per run). */
export const VIEWER_CONTAINER = "decanter-sim-viewer";
/** Fixed local owner for the throwaway viewer — printed so you can log in to browse. */
export const VIEWER_LOGIN = { email: "simulate@decanter.local", password: "Decanter-Sim-0000", firstName: "Decanter", lastName: "Simulate" };

export interface Viewer {
  /** URL of the saved execution in the (kept-alive) local n8n UI. */
  url: string;
  /** Local login for the throwaway viewer instance (n8n requires auth). */
  login: { email: string; password: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch a *kept-alive* local n8n that has the simulation run saved and
 * browsable: import + `n8n execute` (persists the run) + `n8n start` (serves
 * it). Returns the execution's UI URL and a local login (n8n requires auth; we
 * seed a fixed throwaway owner). The container is left running (bound to
 * 127.0.0.1 only, throwaway data, no credentials) and replaced on the next
 * viewer run. The diff comes from the separate headless run, so nothing is read
 * back here. Incompatible with `--network none` (a published port needs a
 * network). Throwaway DB ⇒ the run is always execution id 1.
 */
export async function startViewer(workflow: Workflow, opts: EngineOptions, log: Log): Promise<Viewer> {
  const image = `n8nio/n8n:${opts.version}`;
  // A *stable* file the long-lived viewer bind-mounts: `docker run -d` is
  // detached and the container reads it at startup, so it must outlive this call
  // (unlike the headless run, which isn't detached). Reap the previous viewer
  // before overwriting it, so nothing is holding the old mount.
  const simFile = path.join(os.tmpdir(), "decanter-sim-viewer.json");
  await docker(["rm", "-f", VIEWER_CONTAINER], { timeoutMs: 15_000 }).catch(() => {});
  // `n8n execute` only persists the run (needed for it to be browsable) when the
  // workflow opts in — force the save settings on the viewer copy.
  const viewerWf = {
    ...workflow, id: SIM_WORKFLOW_ID, active: false,
    settings: { ...workflow.settings, saveDataSuccessExecution: "all", saveDataErrorExecution: "all", saveManualExecutions: true },
  };
  writeFileSync(simFile, JSON.stringify(viewerWf));
  log.info(`engine: ${image} — starting a local viewer (kept alive so you can open the run)`);
  // Minimal env: enough to save the run and serve it over http. The strict
  // task-runner isolation (empty module allowlist, etc.) belongs to the headless
  // dry run — the viewer's safety is structural (no credentials survive the
  // transform), and it needs a network for the browser anyway.
  await docker([
    "run", "-d", "--name", VIEWER_CONTAINER, "-p", "127.0.0.1::5678",
    "-e", "N8N_SECURE_COOKIE=false", "-e", "N8N_DIAGNOSTICS_ENABLED=false", "-e", "N8N_PERSONALIZATION_ENABLED=false",
    "-e", "EXECUTIONS_DATA_SAVE_ON_SUCCESS=all", "-e", "EXECUTIONS_DATA_SAVE_ON_ERROR=all", "-e", "EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=true",
    "-v", `${simFile}:/tmp/sim.json:ro`, "--entrypoint", "sh", image,
    "-c", `n8n import:workflow --input=/tmp/sim.json && n8n execute --id=${SIM_WORKFLOW_ID}; n8n start`,
  ], { timeoutMs: 60_000 });

  const host = `http://${(await docker(["port", VIEWER_CONTAINER, "5678"])).stdout.trim().split("\n")[0]}`;
  // wait for REST to serve real JSON (readiness, not just /healthz liveness)
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    ready = await fetch(`${host}/rest/settings`).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json")).catch(() => false);
    if (!ready) await sleep(2000);
  }
  if (!ready) throw new Error(`viewer n8n never became ready at ${host}`);

  // Seed a fixed local owner so the browser lands on a login (not the setup
  // wizard), and so we can read the saved run back to confirm it's browsable.
  const authCookie = (r: Response) => r.headers.getSetCookie().join("; ").match(/n8n-auth=[^;]+/)?.[0];
  await fetch(`${host}/rest/owner/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VIEWER_LOGIN) }).catch(() => undefined);
  let cookie: string | undefined;
  for (let i = 0; i < 5 && !cookie; i++) {
    const l = await fetch(`${host}/rest/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emailOrLdapLoginId: VIEWER_LOGIN.email, password: VIEWER_LOGIN.password }) }).catch(() => undefined);
    cookie = l && authCookie(l); if (!cookie) await sleep(1000);
  }

  // Poll until the saved run is queryable (it lands a beat after the server
  // finishes initializing) and use its real id for the URL.
  let execId = "1";
  for (let i = 0; i < 20 && cookie; i++) {
    const list = await fetch(`${host}/rest/executions`, { headers: { cookie } }).then((r) => r.json()).catch(() => undefined);
    const first = (list?.data?.results ?? list?.data ?? [])[0];
    if (first?.id) { execId = String(first.id); break; }
    await sleep(1000);
  }
  return {
    url: `${host}/workflow/${SIM_WORKFLOW_ID}/executions/${execId}`,
    login: { email: VIEWER_LOGIN.email, password: VIEWER_LOGIN.password },
  };
}
