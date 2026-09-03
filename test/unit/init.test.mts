// Unit tests for init's package-root resolution — the regression guard for
// the 2026-07-18 release blocker: from the published build (dist/lib/), a
// plain `../template` URL resolved to the nonexistent dist/template.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { init, nestedWiringNote, normalizeHostInput, packageRootFrom, projectRootAbove } from "../../lib/init.mts";
import type { Log } from "../../lib/types.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-init-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("packageRootFrom", () => {
  it("finds the package root from the checkout layout (lib/)", () => {
    const pkg = path.join(TMP, "checkout");
    mkdirSync(path.join(pkg, "lib"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(pkg, "lib")), pkg);
  });

  it("finds the package root from the published layout (dist/lib/, no package.json in dist)", () => {
    const pkg = path.join(TMP, "published");
    mkdirSync(path.join(pkg, "dist", "lib"), { recursive: true });
    mkdirSync(path.join(pkg, "template"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(pkg, "dist", "lib")), pkg);
  });

  it("stops at the nearest package.json, not a higher one", () => {
    const outer = path.join(TMP, "outer");
    const inner = path.join(outer, "node_modules", "n8n-decanter");
    mkdirSync(path.join(inner, "dist", "lib"), { recursive: true });
    writeFileSync(path.join(outer, "package.json"), "{}");
    writeFileSync(path.join(inner, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(inner, "dist", "lib")), inner);
  });
});

describe("normalizeHostInput", () => {
  it("keeps a scheme the user typed, stripping trailing slashes", () => {
    assert.equal(normalizeHostInput("http://127.0.0.1:5678"), "http://127.0.0.1:5678");
    assert.equal(normalizeHostInput("https://n8n.example.com/"), "https://n8n.example.com");
    assert.equal(normalizeHostInput("  https://n8n.example.com//  "), "https://n8n.example.com");
  });

  it("defaults LOCAL scheme-less hosts to http (Plan 35 finding)", () => {
    for (const h of ["localhost:5678", "127.0.0.1:5678", "127.0.0.1", "0.0.0.0:5678", "10.0.0.4:5678", "192.168.1.20:5678", "172.16.0.5", "n8n.local", "[::1]:5678", "::1"]) {
      assert.equal(normalizeHostInput(h), "http://" + h.trim(), `local host ${h} should default to http`);
    }
  });

  it("defaults non-local scheme-less hosts to https", () => {
    assert.equal(normalizeHostInput("n8n.example.com"), "https://n8n.example.com");
    assert.equal(normalizeHostInput("my-instance.app.n8n.cloud"), "https://my-instance.app.n8n.cloud");
    assert.equal(normalizeHostInput("203.0.113.10:5678"), "https://203.0.113.10:5678");
  });
});

describe("init (non-interactive flags)", () => {
  const nullLog: Log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };

  it("throws instead of prompting when a setup flag is passed but the host is missing (Plan 35 finding)", async () => {
    const dir = path.join(TMP, "flag-no-host");
    // A setup flag makes init non-interactive: with no host (and no .env), a
    // flag-less init would prompt "n8n host:" and hang on non-TTY stdin; flag
    // mode must error with the fix-it hint and read no stdin at all.
    await assert.rejects(init(dir, { token: "tok" }, nullLog), /host is required — pass --host <url>/);
  });

  // Agents read MCP servers, permission config and hooks at STARTUP, and `init`
  // is normally run from inside the session it configures — so the guarded
  // `n8n-instance` server and the deny rules it writes (`.decanter.json`,
  // `.env`, `push --force`) are inert until a restart. Saying so once is the
  // whole fix; saying it on every re-init is how a hint becomes noise nobody
  // reads.
  it("says the agent wiring needs a restart — once, when it first writes it", async () => {
    const dir = path.join(TMP, "settings-hint");
    const lines: string[] = [];
    const log: Log = { info: (m) => void lines.push(m), ok: () => {}, warn: () => {}, error: () => {} };
    const opts = { host: "http://127.0.0.1:9", token: "tok" };

    await init(dir, opts, log);
    assert.ok(
      lines.some((l) => /restart your agent .* load at agent STARTUP/.test(l)),
      `first init must say it: ${lines.join("|")}`,
    );

    lines.length = 0;
    await init(dir, opts, log);
    assert.ok(
      !lines.some((l) => /restart your agent/.test(l)),
      `a re-init in a set-up dir must stay quiet: ${lines.join("|")}`,
    );
  });
});

// Plan 87: the old advice for a spent refresh token was a bare `init`, which
// reuses .decanter-auth.json whenever the host matches and never re-mints — so
// following it re-probed with the same dead credentials and ended in
// "credentials written anyway". `--reauth` is the way out; init's own verify
// step now offers it instead of shrugging.
describe("init --reauth (Plan 87)", () => {
  const nullLog: Log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };
  const capture = (lines: string[]): Log => ({
    info: (m) => void lines.push(m),
    ok: (m) => void lines.push(m),
    warn: (m) => void lines.push(m),
    error: (m) => void lines.push(m),
  });

  /** Discovery + a token endpoint that refuses every grant, like a spent token. */
  async function deadTokenServer(): Promise<{ host: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          authorization_endpoint: "http://x/mcp-oauth/authorize",
          token_endpoint: "http://x/mcp-oauth/token",
          registration_endpoint: "http://x/mcp-oauth/register",
        }));
      }
      if (req.url === "/mcp-oauth/token") {
        return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const host = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    return { host, close: () => new Promise((r) => server.close(() => r())) };
  }

  it("refuses on a non-TTY and names the flag that works without a browser", async () => {
    const dir = path.join(TMP, "reauth-no-tty");
    await assert.rejects(
      init(dir, { reauth: true, host: "http://127.0.0.1:9" }, nullLog),
      /--reauth needs a terminal[\s\S]*init --token <mcp-token>/,
    );
  });

  it("refuses BEFORE the browser when N8N_MCP_TOKEN would win over the minted credentials anyway", async () => {
    const dir = path.join(TMP, "reauth-vs-token");
    await assert.rejects(
      init(dir, { reauth: true, host: "http://127.0.0.1:9", token: "tok" }, nullLog),
      /--reauth mints OAuth credentials, but an MCP token is set[\s\S]*always wins/,
    );
  });

  it("a spent refresh token at the verify step names --reauth instead of 'credentials written anyway'", async () => {
    const srv = await deadTokenServer();
    const dir = path.join(TMP, "reauth-verify-spent");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    try {
      // credentials that look fine and are not: exactly the state a user is in
      // when a rotation is lost and the next run reports a dead session.
      writeFileSync(path.join(dir, ".decanter-auth.json"), JSON.stringify({ host: srv.host, clientId: "c1", refreshToken: "spent" }));
      await init(dir, { host: srv.host }, capture(lines));
      const out = lines.join("\n");
      assert.match(out, /refresh token is spent or was revoked/, out);
      assert.match(out, /n8n-decanter init --reauth/, out);
      assert.ok(!/credentials written anyway/.test(out), `the shrug is what this plan removes: ${out}`);
    } finally {
      await srv.close();
    }
  });

  /**
   * The other half of the loop: an instance that refuses every refresh grant
   * (the token is spent) but completes a fresh consent, then accepts the
   * access token it just issued. Enough to prove `--reauth` ends in working
   * credentials rather than merely printing something nicer.
   */
  async function reconsentServer(): Promise<{ host: string; close: () => Promise<void> }> {
    const json = (res: http.ServerResponse, code: number, body: unknown): void =>
      void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    const readBody = (req: http.IncomingMessage, done: (s: string) => void): void => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => done(b));
    };
    const server = http.createServer((req, res) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          authorization_endpoint: "http://internal/mcp-oauth/authorize",
          token_endpoint: "http://internal/mcp-oauth/token",
          registration_endpoint: "http://internal/mcp-oauth/register",
        });
      }
      if (req.url === "/mcp-oauth/register") return readBody(req, () => json(res, 201, { client_id: "client-1" }));
      if (req.url === "/mcp-oauth/token") {
        return readBody(req, (b) => {
          const p = new URLSearchParams(b);
          // the OLD credential stays dead — only a real consent gets tokens
          if (p.get("grant_type") !== "authorization_code") return json(res, 400, { error: "invalid_grant" });
          json(res, 200, { access_token: "acc-new", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-new" });
        });
      }
      if (req.url === "/mcp-server/http") {
        if (req.headers.authorization !== "Bearer acc-new") return void res.writeHead(401).end();
        return readBody(req, (b) => {
          const msg = JSON.parse(b);
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          const result = msg.method === "initialize"
            ? { protocolVersion: "2025-03-26" }
            : { content: [{ type: "text", text: JSON.stringify({ workflows: [{ id: "w1", name: "One", availableInMCP: true }] }) }] };
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const host = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    return { host, close: () => new Promise((r) => server.close(() => r())) };
  }

  // Timeout, not just assertions: a consent this test fails to drive lands on
  // the verify step's `[Y/n]` prompt, which reads a stdin node:test never
  // feeds — so the failure mode without it is a hang, not a red test.
  it("closes the loop: --reauth replaces a spent token with credentials that work", { timeout: 20_000 }, async () => {
    const srv = await reconsentServer();
    const dir = path.join(TMP, "reauth-happy");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    // The consent step branches on a TTY, and the flow always PRINTS the
    // authorize URL (for headless users), so the test can play the browser
    // off the log without an injection point of its own.
    const realIsTTY = process.stdin.isTTY;
    const noBrowser = process.env.DECANTER_NO_BROWSER;
    try {
      process.stdin.isTTY = true;
      process.env.DECANTER_NO_BROWSER = "1";
      writeFileSync(path.join(dir, ".decanter-auth.json"), JSON.stringify({ host: srv.host, clientId: "old-client", refreshToken: "spent" }));
      const log: Log = {
        info: (m) => {
          lines.push(m);
          // The line reads `… open this URL yourself: <url>)` — the closing
          // paren is prose, and leaving it on corrupts `state` into a CSRF
          // mismatch (which then hangs on the re-consent prompt, not fails).
          const url = /open this URL yourself: (\S+)/.exec(m)?.[1]?.replace(/\)$/, "");
          if (url !== undefined) {
            const u = new URL(url);
            const redirect = new URL(u.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "auth-code-1");
            redirect.searchParams.set("state", u.searchParams.get("state")!);
            void fetch(redirect); // the browser approving consent
          }
        },
        ok: (m) => void lines.push(m),
        warn: (m) => void lines.push(m),
        error: (m) => void lines.push(m),
      };
      // `--host` keeps the run prompt-free; --reauth is what forces consent.
      await init(dir, { reauth: true, host: srv.host }, log);
      const out = lines.join("\n");
      assert.ok(!/using existing MCP OAuth credentials/.test(out), `--reauth must SKIP the reuse branch: ${out}`);
      const persisted = JSON.parse(readFileSync(path.join(dir, ".decanter-auth.json"), "utf8")) as { refreshToken: string; clientId: string };
      assert.equal(persisted.refreshToken, "ref-new", "the spent token is gone from disk");
      assert.equal(persisted.clientId, "client-1", "and so is the client it was minted for");
      // The whole point: the run ENDS verified, not in "written anyway".
      assert.match(out, /MCP connection verified/, out);
      assert.ok(!/credentials written anyway/.test(out), out);
    } finally {
      process.stdin.isTTY = realIsTTY;
      if (noBrowser === undefined) delete process.env.DECANTER_NO_BROWSER;
      else process.env.DECANTER_NO_BROWSER = noBrowser;
      await srv.close();
    }
  });

  it("stays narrow: an unreachable host is still 'credentials written anyway', not an offer to re-consent", async () => {
    const dir = path.join(TMP, "reauth-verify-offline");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    // Port 9 (discard) refuses instantly — a transport failure says NOTHING
    // about the credential, so re-consenting would burn a working token.
    const host = "http://127.0.0.1:9";
    writeFileSync(path.join(dir, ".decanter-auth.json"), JSON.stringify({ host, clientId: "c1", refreshToken: "probably-fine" }));
    await init(dir, { host }, capture(lines));
    const out = lines.join("\n");
    assert.match(out, /MCP check failed[\s\S]*credentials written anyway/, out);
    assert.ok(!/--reauth/.test(out.replace(/re-consent with `init --reauth`/g, "")), `no re-consent offer on a network error: ${out}`);
  });
});

// Plan 81: a sync dir nested inside a bigger project. `.mcp.json` is merged
// from every ancestor of the dir the agent STARTS in and `.claude/settings.json`
// is read from that dir alone — so an agent started at the surrounding project
// root loads neither of the files init just wrote next to the workflows.
describe("projectRootAbove", () => {
  it("finds the ancestor holding .git", () => {
    const root = path.join(TMP, "pra-git");
    const sync = path.join(root, "flows");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(sync, { recursive: true });
    assert.equal(projectRootAbove(sync), root);
  });

  it("counts a .git FILE — the shape worktrees and submodules use", () => {
    const root = path.join(TMP, "pra-gitfile");
    const sync = path.join(root, "flows");
    mkdirSync(sync, { recursive: true });
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    assert.equal(projectRootAbove(sync), root);
  });

  it("finds an ancestor package.json when there is no git", () => {
    const root = path.join(TMP, "pra-pkg");
    const sync = path.join(root, "svc", "flows");
    mkdirSync(sync, { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}");
    assert.equal(projectRootAbove(sync), root);
  });

  it("prefers the git root over a nearer package.json — that is the dir people open", () => {
    const root = path.join(TMP, "pra-mono");
    const sub = path.join(root, "pkgs", "svc");
    const sync = path.join(sub, "flows");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(sync, { recursive: true });
    writeFileSync(path.join(sub, "package.json"), "{}");
    assert.equal(projectRootAbove(sync), root);
  });

  it("ignores the sync dir's OWN package.json and .git — strict ancestors only", () => {
    const sync = path.join(TMP, "pra-standalone", "flows");
    mkdirSync(path.join(sync, ".git"), { recursive: true });
    writeFileSync(path.join(sync, "package.json"), "{}");
    assert.equal(projectRootAbove(sync), null);
  });
});

describe("nestedWiringNote", () => {
  const root = path.join(TMP, "note-root");
  const sync = path.join(root, "svc", "flows");
  const jsonBlocks = (note: string): string[] => note.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.startsWith("{"));

  it("carries BOTH halves of the root wiring, and every glob prefixed", () => {
    mkdirSync(sync, { recursive: true });
    const note = nestedWiringNote(sync, root);
    // Half 1: the env pin — without it the guard's upward search starts at the
    // root and finds no decanter.config.json.
    assert.match(note, /"N8N_DECANTER_DIR": "svc\/flows"/);
    // Hooks are declared at the root, so their script paths must reach down.
    assert.match(note, /node svc\/flows\/\.claude\/hooks\/verify\.mjs/);
    assert.match(note, /node svc\/flows\/\.claude\/hooks\/rename-refs\.mjs/);
    assert.match(note, /node svc\/flows\/\.claude\/hooks\/mcp-route-check\.mjs/);
    // The sharp end: a verbatim hoist would guard the ROOT's .env instead.
    assert.match(note, /"Read\(svc\/flows\/\.env\)"/);
    assert.match(note, /"Edit\(svc\/flows\/\.env\)"/);
    assert.ok(!/"Read\(\.env\)"/.test(note) && !/"Edit\(\.env\)"/.test(note), `unprefixed .env rules must never be printed: ${note}`);
    // Option A is the recommendation, so it comes first.
    assert.ok(note.indexOf("A. Recommended") < note.indexOf("B. Or wire up"), "Option A must lead");
    assert.match(note, /does not load then/); // Option A's one stated cost
  });

  it("prints only paste-able JSON — all three snippets parse", () => {
    mkdirSync(sync, { recursive: true });
    const blocks = jsonBlocks(nestedWiringNote(sync, root));
    assert.equal(blocks.length, 3, `expected the .mcp.json, opencode.json and settings.json snippets: ${blocks.length}`);
    for (const b of blocks) assert.doesNotThrow(() => JSON.parse(b), `not valid JSON:\n${b}`);
  });

  it("names ${CLAUDE_PROJECT_DIR} only to warn — it expands to the parent", () => {
    mkdirSync(sync, { recursive: true });
    const note = nestedWiringNote(sync, root);
    assert.match(note, /Do not reach for \$\{CLAUDE_PROJECT_DIR\}/);
    for (const b of jsonBlocks(note)) assert.ok(!b.includes("CLAUDE_PROJECT_DIR"), `snippet must not use it:\n${b}`);
  });

  it("uses the repo-relative local bin when one is installed, the bare name otherwise", () => {
    const bare = path.join(TMP, "note-bare", "flows");
    mkdirSync(bare, { recursive: true });
    const bareNote = nestedWiringNote(bare, path.dirname(bare));
    assert.match(bareNote, /"command": "n8n-decanter"/);
    assert.match(bareNote, /assumes a global install/);

    const local = path.join(TMP, "note-local", "flows");
    mkdirSync(path.join(local, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(local, "node_modules", ".bin", "n8n-decanter"), "#!/bin/sh\n");
    const localNote = nestedWiringNote(local, path.dirname(local));
    // Repo-relative, never absolute: a committed root config is read on every
    // teammate's machine.
    assert.match(localNote, /"command": "flows\/node_modules\/\.bin\/n8n-decanter"/);
    assert.ok(!localNote.includes(`"command": "${local}`), "an absolute bin path would break for every other clone");
  });
});

describe("init (nested sync dir)", () => {
  const opts = { host: "http://127.0.0.1:9", token: "tok" };
  const capture = (lines: string[]): Log => ({ info: (m) => void lines.push(m), ok: () => {}, warn: () => {}, error: () => {} });

  it("prints the full nested note when a project root sits above the target", async () => {
    const root = path.join(TMP, "nested-init");
    const dir = path.join(root, "flows");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const lines: string[] = [];
    await init(dir, opts, capture(lines));
    const out = lines.join("\n");
    assert.match(out, /This sync dir is nested inside/);
    assert.match(out, /"N8N_DECANTER_DIR": "flows"/);
    assert.match(out, /node flows\/\.claude\/hooks\/verify\.mjs/);
    assert.match(out, /"Read\(flows\/\.env\)", "Edit\(flows\/\.env\)"/);
  });

  // Plan 83: the bare "restart your agent" line is TRUE only where a restart
  // can help. Here the wiring sits below wherever the agent was started, and
  // startup discovery only walks UP — so a restart re-misses this file every
  // time. A blind field-test agent read the unconditional line, concluded
  // "restart", and had no next idea; the nested run must name the real fix
  // instead of advice that cannot work.
  it("does not tell a nested dir to just restart — it names where the wiring loads from (Plan 83)", async () => {
    const root = path.join(TMP, "nested-no-restart");
    const dir = path.join(root, "flows");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const lines: string[] = [];
    await init(dir, opts, capture(lines));
    const out = lines.join("\n");
    assert.ok(!/restart your agent/.test(out), `the dead-end advice must not fire when nested: ${out}`);
    assert.match(out, /from the dir the agent was STARTED in/);
    assert.match(out, /no restart ever loads them/);
  });

  it("stays completely silent for a standalone sync dir", async () => {
    const dir = path.join(TMP, "standalone-init", "flows");
    mkdirSync(dir, { recursive: true });
    // Precondition, asserted so a polluted /tmp fails loudly instead of
    // silently making this test vacuous.
    assert.equal(projectRootAbove(dir), null, "the temp tree must not look like a project root");
    const lines: string[] = [];
    await init(dir, opts, capture(lines));
    const out = lines.join("\n");
    assert.match(out, /restart your agent/); // the pre-existing hint still fires
    assert.ok(!/nested inside|N8N_DECANTER_DIR/.test(out), `no nested noise on the normal path: ${out}`);
  });
});
