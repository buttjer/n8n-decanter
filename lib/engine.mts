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
  const rd = parsed.data?.resultData?.runData ?? {};
  const map = new Map<string, RunItem[]>();
  for (const [node, runs] of Object.entries(rd)) {
    const main = (runs as Array<{ data?: { main?: Array<Array<RunItem> | null> } }>)?.[0]?.data?.main;
    const items = Array.isArray(main) && Array.isArray(main[0]) ? main[0] : [];
    map.set(node, items);
  }
  const error = parsed.data?.resultData?.error?.message;
  return { runData: map, ok: error === undefined, error };
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
