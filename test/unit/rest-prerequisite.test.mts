// Plan 89: the workflow-scoped REST verbs (`executions`, `backup`) need a
// pulled workflow, and pulling needs the workflow opted into MCP. A user who
// just built a workflow in the n8n UI hits that wall first, so every message on
// it has to name the whole chain: pull it, and `pull` needs MCP access enabled.
//
// Driven through the real CLI as an async subprocess (a sync exec would
// deadlock against the in-process mock) — the CLI process is the surface users
// touch. The mock serves the public REST execution reads and makes MCP
// unreachable by destroying every socket to it: the REST path must fail with
// its local message and never open an MCP connection (its independence from
// MCP is load-bearing — plan Notes).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { ENABLE_MCP_HINT } from "../../lib/mcp.mts";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-restprereq-"));
/** A second sync dir with nothing pulled — pins the `nothing pulled yet` ending. */
const EMPTY = mkdtempSync(path.join(os.tmpdir(), "decanter-restprereq-empty-"));

/** The one seeded, pulled workflow — so `pulled workflows:` has an entry. */
const PULLED = { id: "wfPulled1", name: "Order Sync", slug: "order-sync" };
/** An execution that exists on the instance but belongs to an unpulled workflow. */
const FOREIGN_EXEC = { id: "77", workflowId: "wfOther42" };

let server: http.Server;
let host = "";
let mcpRequests = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/mcp-server/")) {
      // MCP unreachable: count the attempt, then drop the connection.
      mcpRequests++;
      req.socket.destroy();
      return;
    }
    const exec = /^\/api\/v1\/executions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && exec) {
      if (decodeURIComponent(exec[1]) === FOREIGN_EXEC.id) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: FOREIGN_EXEC.id,
          workflowId: FOREIGN_EXEC.workflowId,
          status: "success",
          mode: "manual",
          startedAt: "2026-10-25T10:00:00.000Z",
          stoppedAt: "2026-10-25T10:00:01.000Z",
          data: { resultData: { runData: {} } },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end('{"code":404,"message":"The requested execution was not found"}');
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end('{"code":404,"message":"unrouted in mock"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Sync dir, per AGENTS.md "Verifying changes at the CLI surface". The pulled
  // workflow is seeded by hand (state shape: lib/state.mts readState /
  // listWorkflowRefs) rather than bootstrapped with `pull`, so MCP stays off
  // for the whole suite and the request counter never has to be reset.
  for (const dir of [TMP, EMPTY]) {
    writeFileSync(path.join(dir, ".env"), `N8N_HOST=${host}\nN8N_MCP_TOKEN=test-mcp-token\nN8N_API_KEY=test\n`);
    writeFileSync(path.join(dir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: dir === TMP ? [PULLED.id] : [], commitOnPush: false, commitOnPull: false }));
    mkdirSync(path.join(dir, "workflows"), { recursive: true });
    await run(["git", "init", "-q"], undefined, dir);
    await run(["git", "config", "user.name", "Test"], undefined, dir);
    await run(["git", "config", "user.email", "test@example.invalid"], undefined, dir);
  }
  const wf = path.join(TMP, "workflows", PULLED.slug);
  mkdirSync(path.join(wf, "code"), { recursive: true });
  writeFileSync(path.join(wf, ".decanter.json"), JSON.stringify({ workflowId: PULLED.id, name: PULLED.name, nodes: {} }, null, 2));
  writeFileSync(path.join(wf, "workflow.json"), JSON.stringify({ id: PULLED.id, name: PULLED.name, nodes: [], connections: {} }, null, 2));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(TMP, { recursive: true, force: true });
  rmSync(EMPTY, { recursive: true, force: true });
});

beforeEach(() => { mcpRequests = 0; });

/** Spawn any program in the sync dir; resolves with code + combined output. */
function run(argv: string[], env?: NodeJS.ProcessEnv, cwd: string = TMP): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

/**
 * The CLI, with the mock's credentials in the child's env as well as `.env`:
 * `loadEnv` never overrides an inherited variable, so an operator's shell would
 * otherwise win. The two decanter knobs that would redirect auth or the sync
 * dir are dropped for the same reason.
 */
async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  return cliIn(TMP, ...args);
}

async function cliIn(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, N8N_HOST: host, N8N_MCP_TOKEN: "test-mcp-token", N8N_API_KEY: "test" };
  delete env.N8N_DECANTER_AUTH;
  delete env.N8N_DECANTER_DIR;
  delete env.DEBUG;
  const r = await run([process.execPath, CLI, ...args], env, cwd);
  // ANSI codes appear even when piped (Plan 11) — strip before matching.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return { code: r.code, out: r.out.replace(/\x1b\[[0-9;]*m/g, "") };
}

/** The chain: names pulling the workflow, and the MCP opt-in verbatim. */
function assertChain(out: string): void {
  assert.match(out, /\bpull\b/, "tells the user to pull");
  assert.ok(out.includes(ENABLE_MCP_HINT), `names the MCP opt-in (ENABLE_MCP_HINT) — got:\n${out}`);
}

describe("REST verbs name the whole prerequisite chain (Plan 89)", () => {
  it("executions 999 (404): the execution hint, not just 404 Not Found", async () => {
    const { code, out } = await cli("executions", "999");
    assert.equal(code, 1);
    assert.match(out, /\b404\b/);
    assert.match(out, /999/);
    assert.match(out, /(does not|doesn't|no longer) exist/i, `says the execution does not exist — got:\n${out}`);
    assert.match(out, /retention|prun/i, "names retention pruning as a cause");
    assert.ok(!out.includes(ENABLE_MCP_HINT), "a mistyped execution id must not send the user to pull a workflow");
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it("executions <id> of an unpulled workflow: keeps the not-pulled message, adds the chain", async () => {
    const { code, out } = await cli("executions", FOREIGN_EXEC.id);
    assert.equal(code, 1);
    assert.match(out, new RegExp(`execution ${FOREIGN_EXEC.id} belongs to workflow ${FOREIGN_EXEC.workflowId}, which is not pulled`), "the 404 hint must not shadow it");
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it("executions <id-shaped unpulled workflow ref>: names pull and the MCP opt-in", async () => {
    const { code, out } = await cli("executions", "wfNotPulled99");
    assert.equal(code, 1);
    assert.match(out, /workflow wfNotPulled99 not found under .* — pull it first/);
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it("backup create <id-shaped unpulled ref>: names pull and the MCP opt-in", async () => {
    const { code, out } = await cli("backup", "create", "wfNotPulled99");
    assert.equal(code, 1);
    assert.match(out, /workflow wfNotPulled99 not found under .* — pull it first/);
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it('backup create "My New Workflow": names pull and the MCP opt-in, keeps the pulled list', async () => {
    const { code, out } = await cli("backup", "create", "My New Workflow");
    assert.equal(code, 1);
    assert.match(out, /no workflow matches "My New Workflow"/);
    assert.match(out, new RegExp(`pulled workflows: .*"${PULLED.name}"`), "the candidate list stays");
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it('backup create "My New Workflow" with nothing pulled: keeps "nothing pulled yet", adds the chain', async () => {
    const { code, out } = await cliIn(EMPTY, "backup", "create", "My New Workflow");
    assert.equal(code, 1);
    assert.match(out, /no workflow matches "My New Workflow" — nothing pulled yet/);
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  it('executions "My New Workflow": names pull and the MCP opt-in', async () => {
    const { code, out } = await cli("executions", "My New Workflow");
    assert.equal(code, 1);
    assert.match(out, /no workflow matches "My New Workflow"/);
    assert.match(out, new RegExp(`pulled workflows: .*"${PULLED.name}"`), "the candidate list stays");
    assertChain(out);
    assert.equal(mcpRequests, 0, "the REST path opens no MCP connection");
  });

  // Regression guard — green today, must stay green. For `pull`, no match means
  // nothing on the instance matches (or the remote list failed), so "pull it
  // first" would be wrong advice. Never assert a bare /pull/: "pulled
  // workflows" and the "could not list remote workflows" warning contain it.
  it('pull "No Such Flow" (MCP unreachable): fails without telling the user to pull it first', async () => {
    const { code, out } = await cli("pull", "No Such Flow");
    assert.equal(code, 1);
    assert.match(out, /no workflow matches "No Such Flow"/);
    assert.doesNotMatch(out, /pull it first/);
    assert.ok(!out.includes(ENABLE_MCP_HINT), `pull must not carry the chain — got:\n${out}`);
    assert.ok(mcpRequests > 0, "pull did try the remote list, so this is the fall-through path");
  });
});
