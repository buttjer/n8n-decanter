// Plan 58 Task 3 — prove the SCAFFOLDED guard command actually STARTS a guard,
// under both install shapes, on a PATH that gets no help from us. Plan 81 adds
// the third dimension the first two hold constant: the directory the agent is
// LAUNCHED in, which is the sync dir only when the sync dir is also the project
// root.
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
import { execFileSync, spawn } from "node:child_process";
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

// ---------- a NESTED sync dir: `repo/flows` inside a bigger project ----------
// Plan 81. The shape that breaks is an agent launched at the REPO ROOT: the
// config search only walks UP, so a guard spawned there can never see `flows/`.
// The two steps at the bottom spawn the same scaffolded argv from `repoRoot`
// (what a `.mcp.json` hoisted to the root does) and differ in exactly one
// thing — the `N8N_DECANTER_DIR` entry of the `env` block.
//
// **The install sits at the repo root on purpose.** Root-launched `npx
// --no-install` resolves against the ROOT's node_modules, so a sync-dir-local
// install would fail here on the *other* half of the root-hoist problem (bin
// resolution — the LOCAL/GLOBAL steps already own that one) and mask the half
// under test. Held fixed, a failure can only mean the config lookup.
const repoRoot = path.join(TMP, "repo");
const nestedSyncDir = path.join(repoRoot, "flows");
mkdirSync(path.join(nestedSyncDir, "workflows"), { recursive: true });
writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "host-repo", version: "0.0.0", private: true }, null, 2));
writeFileSync(path.join(nestedSyncDir, ".env"), `N8N_HOST=http://127.0.0.1:${PORT}\nN8N_MCP_TOKEN=test-mcp-token\n`);
writeFileSync(path.join(nestedSyncDir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [] }, null, 2));
// Same sentinel trick as the LOCAL step: npx re-adds its own node bin dir to
// PATH, so a machine-global install could otherwise satisfy these steps — and a
// released global predating `--dir` would fail them for the wrong reason.
const repoShimRan = path.join(TMP, "repo-shim-ran");
const repoShim = path.join(repoRoot, "node_modules", ".bin", "n8n-decanter");
mkdirSync(path.dirname(repoShim), { recursive: true });
writeFileSync(repoShim, `#!/bin/sh\n: > ${JSON.stringify(repoShimRan)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
chmodSync(repoShim, 0o755);

// ---------- a LINKED GIT WORKTREE of a repo whose sync dir holds the creds ----------
// The fourth dimension: the credential files are gitignored, so a fresh
// worktree has NEITHER and the guard used to die on HOST_UNSET before it could
// say why — an agent with no n8n-instance tools, which is the agent most likely
// to go looking for an unguarded route to n8n.
//
// **The install is placed in the worktree on purpose.** A real worktree also
// lacks `node_modules`, but that is a *different* failure (bin resolution — the
// LOCAL/GLOBAL steps own it) and one decanter cannot fix from inside, since the
// command never resolves. Held fixed here, a failure can only mean credentials.
const wtMain = path.join(TMP, "wt-main");
const wtMainSync = path.join(wtMain, "flows");
mkdirSync(path.join(wtMainSync, "workflows"), { recursive: true });
const wtGit = (...args: string[]) => execFileSync("git", args, { cwd: wtMain, stdio: "ignore" });
writeFileSync(path.join(wtMainSync, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [] }, null, 2));
writeFileSync(path.join(wtMain, ".gitignore"), "node_modules/\n.env\n");
wtGit("init", "-b", "main");
wtGit("config", "user.name", "spawn-test");
wtGit("config", "user.email", "spawn-test@example.com");
wtGit("add", "-A");
wtGit("commit", "-m", "sync dir");
// Written after the commit to make the point: this file is gitignored, so it
// exists in the main checkout and nowhere else.
writeFileSync(path.join(wtMainSync, ".env"), `N8N_HOST=http://127.0.0.1:${PORT}\nN8N_MCP_TOKEN=test-mcp-token\n`);

const worktree = path.join(TMP, "wt-linked");
execFileSync("git", ["worktree", "add", "-b", "spawn-probe", worktree, "main"], { cwd: wtMain, stdio: "ignore" });
const wtSync = path.join(worktree, "flows");
const wtShimRan = path.join(TMP, "wt-shim-ran");
const wtShim = path.join(wtSync, "node_modules", ".bin", "n8n-decanter");
mkdirSync(path.dirname(wtShim), { recursive: true });
writeFileSync(wtShim, `#!/bin/sh\n: > ${JSON.stringify(wtShimRan)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
chmodSync(wtShim, 0o755);

// A second upstream, distinguishable by name: the local-wins step asserts WHICH
// instance answered, which is the only way to prove precedence end-to-end.
const server2 = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
    if (msg.method?.startsWith("notifications/")) return void res.writeHead(202).end();
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mock-session-2" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock-n8n-staging", version: "0" } } }));
  });
});
await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
const PORT2 = (server2.address() as { port: number }).port;

/** Is a global `n8n-decanter` reachable on this machine's ambient PATH? */
const globalInstalled = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some((dir) => dir !== "" && existsSync(path.join(dir, "n8n-decanter")));

/**
 * Spawn the scaffolded argv verbatim, speak one `initialize`, resolve the first
 * stdout line. Rejects on exit-without-output — which is exactly the shape of
 * the Task 1 bug (a guard that never started).
 *
 * `cwd` is the agent's LAUNCH directory, and it is a real variable rather than
 * a constant: an MCP entry hoisted to a repo root spawns the guard there, not
 * in the sync dir (Plan 81). The install-shape steps keep the default.
 */
async function initializeVia(env: NodeJS.ProcessEnv, cwd: string = syncDir): Promise<Record<string, unknown>> {
  const server0 = scaffolded.mcpServers["n8n-instance"];
  assert.ok(server0?.command, "the scaffolded .mcp.json carries an n8n-instance command");
  const child = spawn(server0.command, server0.args ?? [], { cwd, env });
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

  await step("NESTED sync dir: N8N_DECANTER_DIR starts the guard from the repo root", async () => {
    rmSync(repoShimRan, { force: true });
    // Repo-RELATIVE on purpose: that is the value a *committed* root .mcp.json
    // can carry, and it only survives a clone on someone else's machine if it
    // resolves against the spawn cwd. An answered `initialize` proves the whole
    // chain — resolved the command, found `flows/` downward-of-cwd, read its
    // .env and creds, reached upstream.
    const msg = await initializeVia({ PATH: CLEAN_PATH, HOME: TMP, N8N_DECANTER_DIR: "flows" }, repoRoot);
    assert.equal(msg.id, 1, `the guard answered initialize from the repo root: ${JSON.stringify(msg).slice(0, 200)}`);
    assert.ok(existsSync(repoShimRan), "the fixture's own CLI answered (not a machine-global install npx re-added to PATH)");
  });

  await step("NESTED sync dir: without the override the command fails LOUDLY", async () => {
    rmSync(repoShimRan, { force: true });
    await assert.rejects(
      () => initializeVia({ PATH: CLEAN_PATH, HOME: TMP }, repoRoot),
      (err: Error) => {
        // An agent gets no stderr channel from a spawned MCP server it can act
        // on, so the only tolerable failure is a fast, noisy death: a guard that
        // half-starts and then waits forever is the worst version of this bug.
        assert.match(err.message, /did not start a guard/, `the guard must EXIT, not hang: ${err.message.slice(0, 300)}`);
        // And it must name THIS situation. The pre-Plan-81 message sent the user
        // to `init`, which here would scaffold a second sync dir on top of a
        // perfectly good one sitting a single level down.
        assert.match(err.message, /sits BELOW the working directory/, `the error should name the nested case: ${err.message.slice(0, 600)}`);
        assert.match(err.message, /N8N_DECANTER_DIR/, `the error should name the fix the previous step proved: ${err.message.slice(0, 600)}`);
        assert.ok(existsSync(repoShimRan), "the CLI itself refused (a failure to resolve the command would prove nothing about the config lookup)");
        return true;
      },
    );
  });

  await step("WORKTREE: a credential-less worktree starts the guard on the main checkout's creds", async () => {
    rmSync(wtShimRan, { force: true });
    // The worktree's own sync dir has decanter.config.json (tracked) and no
    // credentials (gitignored) — the exact state `git worktree add` leaves. An
    // answered `initialize` proves the whole chain: resolved the command, found
    // the worktree's config, followed .git back to the main checkout, read ITS
    // credentials, and reached the upstream they name.
    assert.ok(!existsSync(path.join(wtSync, ".env")), "the fixture worktree really has no credentials of its own");
    const msg = await initializeVia({ PATH: CLEAN_PATH, HOME: TMP }, wtSync);
    assert.equal(msg.id, 1, `the guard answered initialize from the worktree: ${JSON.stringify(msg).slice(0, 200)}`);
    assert.ok(existsSync(wtShimRan), "the fixture's own CLI answered (not a machine-global install npx re-added to PATH)");
  });

  await step("WORKTREE: the worktree's OWN credentials win over the main checkout's", async () => {
    rmSync(wtShimRan, { force: true });
    // Precedence is what makes the fallback safe to have on unconditionally: a
    // worktree deliberately aimed at another instance must keep aiming there.
    // Asserting WHICH upstream answered is the only end-to-end proof of that —
    // both files are well-formed, so a wrong pick still yields a valid reply.
    writeFileSync(path.join(wtSync, ".env"), `N8N_HOST=http://127.0.0.1:${PORT2}\nN8N_MCP_TOKEN=test-mcp-token\n`);
    try {
      const msg = await initializeVia({ PATH: CLEAN_PATH, HOME: TMP }, wtSync);
      const info = (msg.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
      assert.equal(info?.name, "mock-n8n-staging", `the worktree's own credentials chose the upstream: ${JSON.stringify(msg).slice(0, 200)}`);
    } finally {
      rmSync(path.join(wtSync, ".env"), { force: true });
    }
  });
} finally {
  server.close();
  server2.close();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passedCount()} mcp-spawn steps passed`);
if (hasFailed()) process.exitCode = 1;
