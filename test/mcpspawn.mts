// Plan 58 Task 3 — prove the SCAFFOLDED guard command actually STARTS a guard,
// under both install shapes, on a PATH that gets no help from us.
//
// Why this suite exists: Plan 58 Task 1's bug (a bare `n8n-decanter` in the
// scaffolded .mcp.json resolves only under a GLOBAL install, and silently fails
// to start under a LOCAL one) survived every existing test because nothing
// tested process SPAWNING:
//   - test/guardproxy.mts imports `runStdioGuard` IN-PROCESS on PassThrough
//     pipes — the scaffolded command/args are never executed;
//   - no test asserted what `.mcp.json` actually contains;
//   - the field-test harness stages both install shapes but PATH-crutches both,
//     handing the agent a resolvable bare command a real user never gets.
// So this suite reads the template's scaffolded entry and spawns EXACTLY that
// argv as a child process, then speaks JSON-RPC to it.
//
// Deliberately NOT sandbox-hostile: it binds a localhost mock (like e2e) and
// spawns processes; no Docker, no real n8n.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStepRunner } from "./harness.mts";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-mcpspawn-"));

const { step, passedCount, hasFailed } = createStepRunner();

// ---------- a minimal mock MCP upstream ----------
// The guard forwards `initialize` to the instance, so the child only produces a
// JSON-RPC reply if it (a) resolved, (b) read the sync-dir config + creds, and
// (c) reached upstream. That end-to-end path is the point.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
    if (msg.method?.startsWith("notifications/")) return void res.writeHead(202).end();
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mock-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock-n8n", version: "0" } } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PORT = (server.address() as { port: number }).port;

// ---------- a sync dir carrying the SCAFFOLDED agent config ----------
const syncDir = path.join(TMP, "sync");
mkdirSync(path.join(syncDir, "workflows"), { recursive: true });
writeFileSync(path.join(syncDir, ".env"), `N8N_HOST=http://127.0.0.1:${PORT}\nN8N_MCP_TOKEN=test-mcp-token\n`);
writeFileSync(path.join(syncDir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [] }, null, 2));
// The file `init` materializes (template `X.example` -> `X`) — read it rather
// than hard-coding the argv, so this suite tracks whatever the template ships.
const scaffolded = JSON.parse(readFileSync(path.join(PROJECT, "template", ".mcp.json.example"), "utf8")) as {
  mcpServers: Record<string, { command?: string; args?: string[] }>;
};
writeFileSync(path.join(syncDir, ".mcp.json"), JSON.stringify(scaffolded, null, 2));

// ---------- PATHs that give the command no help ----------
// `npx` shells out via `sh`, so the system dirs must be present — they are also
// on every real agent's PATH, and they carry no n8n-decanter.
const SYS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((d) => existsSync(d)).join(path.delimiter);
const nodeBin = path.dirname(process.execPath);
/** node + npx only — no decanter of our making. */
const cleanBin = path.join(TMP, "cleanbin");
mkdirSync(cleanBin, { recursive: true });
for (const tool of ["node", "npx"]) {
  const src = path.join(nodeBin, tool);
  if (existsSync(src)) symlinkSync(src, path.join(cleanBin, tool));
}
const CLEAN_PATH = `${cleanBin}${path.delimiter}${SYS}`;

/** Is a global `n8n-decanter` reachable on this machine's ambient PATH? */
const globalInstalled = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some((dir) => dir !== "" && existsSync(path.join(dir, "n8n-decanter")));

/**
 * Spawn the scaffolded argv verbatim, speak one `initialize`, resolve the first
 * stdout line. Rejects on exit-without-output — which is exactly the shape of
 * the Task 1 bug (a guard that never started).
 */
async function initializeVia(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const server0 = scaffolded.mcpServers["n8n-instance"];
  assert.ok(server0?.command, "the scaffolded .mcp.json carries an n8n-instance command");
  const child = spawn(server0.command, server0.args ?? [], { cwd: syncDir, env });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no JSON-RPC reply within 20s; stderr:\n${err.slice(0, 600)}`)), 20_000);
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
        const nl = out.indexOf("\n");
        if (nl === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out.slice(0, nl)) as Record<string, unknown>);
        } catch (e) {
          reject(new Error(`stdout was not JSON-RPC: ${(e as Error).message}\nline: ${out.slice(0, 200)}`));
        }
      });
      child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`spawn failed: ${e.message}`)); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        // THE REGRESSION: the guard died without ever answering.
        reject(new Error(`the guard exited (code ${code}) without a JSON-RPC reply — the scaffolded command did not start a guard.\nstderr:\n${err.slice(0, 600)}`));
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "spawn-test", version: "0" } } })}\n`);
    });
  } finally {
    child.kill("SIGKILL");
  }
}

try {
  await step("the scaffolded command is resolvable-by-design (not a bare program name)", () => {
    const entry = scaffolded.mcpServers["n8n-instance"];
    const argv = [entry.command, ...(entry.args ?? [])].join(" ");
    // Plan 58 Task 1: a bare `n8n-decanter` only resolves under a global
    // install. Whatever the template ships must not regress to that.
    assert.notEqual(entry.command, "n8n-decanter", `the scaffolded command is a bare program name again — it will silently fail to start under a local install (got: ${argv})`);
    assert.match(argv, /n8n-decanter\b.*\bmcp\b.*\bconnect\b/, `the scaffolded entry should still invoke \`mcp connect\`: ${argv}`);
  });

  await step("LOCAL install: the scaffolded command starts a guard with no PATH help", async () => {
    // A local install is a bin in the project's node_modules/.bin — the shape
    // `npm i -D n8n-decanter` produces, and the one the bare command missed.
    // The shim drops a sentinel so we can prove the LOCAL copy is what ran
    // (a machine-global install must not be able to satisfy this step).
    const localBin = path.join(syncDir, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true });
    const sentinel = path.join(TMP, "local-shim-ran");
    rmSync(sentinel, { force: true });
    const shim = path.join(localBin, "n8n-decanter");
    writeFileSync(shim, `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
    chmodSync(shim, 0o755);

    const msg = await initializeVia({ PATH: CLEAN_PATH, HOME: TMP });
    assert.equal(msg.id, 1, `the guard answered initialize: ${JSON.stringify(msg).slice(0, 200)}`);
    assert.ok(existsSync(sentinel), "the LOCAL node_modules/.bin copy is what ran (not a machine-global install)");
  });

  await step("GLOBAL install: the same scaffolded command starts a guard", async () => {
    if (!globalInstalled) {
      // npm/npx re-adds its own node bin dir to PATH, so a *fake* global cannot
      // reliably win over a real one — the honest options are "use the real
      // global" or "skip". CI without a global install lands here; the LOCAL
      // step above is the one that guards the regression.
      console.log("     (no global n8n-decanter on PATH — skipping; `npm i -g n8n-decanter` to exercise it)");
      return;
    }
    // No local install in scope: resolution must come from the ambient PATH.
    rmSync(path.join(syncDir, "node_modules"), { recursive: true, force: true });
    const msg = await initializeVia({ PATH: process.env.PATH ?? SYS, HOME: os.homedir() });
    assert.equal(msg.id, 1, `the guard answered initialize: ${JSON.stringify(msg).slice(0, 200)}`);
  });

  await step("NEITHER install: the command fails LOUDLY, never silently", async () => {
    if (globalInstalled) {
      console.log("     (a global n8n-decanter is on PATH — cannot construct a no-install PATH here; skipping)");
      return;
    }
    rmSync(path.join(syncDir, "node_modules"), { recursive: true, force: true });
    // `--no-install` must refuse to fetch from npm; the value is that a missing
    // install is an ERROR, not a guard that quietly never starts.
    await assert.rejects(() => initializeVia({ PATH: CLEAN_PATH, HOME: TMP }), /did not start a guard|spawn failed/);
  });
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passedCount()} mcp-spawn steps passed`);
if (hasFailed()) process.exitCode = 1;
