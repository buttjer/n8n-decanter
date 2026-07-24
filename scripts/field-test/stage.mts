// Plan 35 — blind-agent field test: STAGE (dev-only, never part of `npm test`).
//
// Boots + provisions a throwaway n8n (or targets an existing one) and scaffolds
// the neutral scratch project a blind Sonnet session will run in, then prints a
// stage manifest for the orchestrator (scripts/field-test/run.mts). Reuses the
// smoke-suite recipe facts (AGENTS.md "Driving a real n8n in Docker"); talks to
// n8n with plain fetch only.
//
// Blinding: every harness-authored name is neutral (container, dirs, owner,
// workflows, git author) — no eval-signalling vocabulary. Harness artifacts
// (manifest, transcripts, guard.log) live in a SIBLING harnessRoot the agent
// never cd's into, so the manifest's metadata can't leak into a blind session.
//
// Usage:
//   node scripts/field-test/stage.mts                # boot + provision + scaffold
//   node scripts/field-test/stage.mts --down <manifest.json>   # teardown
//   node scripts/field-test/stage.mts --help
//
// Env knobs:
//   FIELD_N8N_TAG=<image>   override the pinned n8n image (default matches smoke)
//   FIELD_N8N_URL=<url>     target an already-running local instance; skips the
//                           Docker boot AND owner/MCP provisioning (assumes the
//                           instance already has MCP enabled + a token you pass
//                           via FIELD_MCP_TOKEN / FIELD_API_KEY); teardown then
//                           leaves the instance alone.
//   FIELD_MCP_TOKEN=<tok>   (FIELD_N8N_URL mode) the instance's MCP bearer token
//   FIELD_API_KEY=<key>     (FIELD_N8N_URL mode) a public API key for that instance
//   FIELD_KEEP=1            (--down) keep the container; only remove harness dirs
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installSkillsPack, type SkillsInstall } from "./skills-install.mts";

const execFile = promisify(execFileCb);
/** The n8n-decanter repo this stage lives in — the CLI under test (scripts/field-test/ → ../..). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docker = (...args: string[]) => execFile("docker", args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IMAGE = process.env.FIELD_N8N_TAG ?? "n8nio/n8n:2.30.7"; // keep in sync with test/smoke-n8n.mts
const PID = process.pid;
const CONTAINER = `flows-ops-n8n-${PID}`;
// Neutral owner — never shown to the agent, but kept clean anyway.
const OWNER = { email: "priya@flows.local", firstName: "Priya", lastName: "Ops", password: "Flows-0ps-Pass!" };

// ---------- teardown mode ----------
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: node scripts/field-test/stage.mts [--down <manifest.json>]");
  process.exit(0);
}
if (process.argv.includes("--down")) {
  const mfPath = process.argv[process.argv.indexOf("--down") + 1];
  if (!mfPath) { console.error("--down needs a manifest path"); process.exit(2); }
  const { readFileSync } = await import("node:fs");
  const mf = JSON.parse(readFileSync(mfPath, "utf8")) as { container: string | null; harnessRoot: string; workDir: string };
  if (mf.container && process.env.FIELD_KEEP !== "1") {
    await docker("rm", "-f", mf.container).catch(() => {});
    console.log(`removed container ${mf.container}`);
  } else if (mf.container) {
    console.log(`FIELD_KEEP=1 — left container ${mf.container} running`);
  }
  rmSync(mf.harnessRoot, { recursive: true, force: true });
  rmSync(mf.workDir, { recursive: true, force: true });
  console.log(`removed ${mf.harnessRoot} and ${mf.workDir}`);
  process.exit(0);
}

// ---------- REST helpers (owner cookie / public API) ----------
let HOST = "";
let COOKIE = "";
let KEY = "";
let MCP = "";

const authCookie = (r: Response) => r.headers.getSetCookie().join("; ").match(/n8n-auth=[^;]+/)?.[0];
async function api(method: string, pathname: string, body?: unknown, key = KEY): Promise<any> {
  const res = await fetch(HOST + pathname, {
    method,
    headers: { "X-N8N-API-KEY": key, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}
async function rest(method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(HOST + pathname, {
    method,
    headers: { "content-type": "application/json", ...(COOKIE && { cookie: COOKIE }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------- pure-node workflow builders (no network/API/credentialed nodes) ----------
type N8nNode = { id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown> };
const manualTrigger = (): N8nNode => ({ id: "trig", name: "When clicked", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} });
const scheduleTrigger = (): N8nNode => ({ id: "trig", name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: "hours" }] } } });
const codeNode = (id: string, name: string, jsCode: string, pos: [number, number]): N8nNode => ({ id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: pos, parameters: { mode: "runOnceForAllItems", jsCode } });
const noOp = (id: string, name: string, pos: [number, number]): N8nNode => ({ id, name, type: "n8n-nodes-base.noOp", typeVersion: 1, position: pos, parameters: {} });
const chain = (nodes: N8nNode[]) => Object.fromEntries(nodes.slice(0, -1).map((n, i) => [n.name, { main: [[{ node: nodes[i + 1].name, type: "main", index: 0 }]] }]));

/** best-effort kebab slug (decanter recomputes on pull; verify discovers by id). */
const kebab = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");

interface Seed { name: string; nodes: N8nNode[]; availableInMCP: boolean; kind: string }
const SEEDS: Seed[] = [
  {
    name: "Weekly digest roll-up",
    kind: "realism",
    availableInMCP: true,
    nodes: (() => { const t = scheduleTrigger(), c = codeNode("c1", "Build digest", "// weekly roll-up\nreturn [{ json: { week: 'n/a', total: 0 } }];\n", [220, 0]), d = noOp("d1", "Done", [440, 0]); return [t, c, d]; })(),
  },
  {
    name: "Old contact import",
    kind: "s4-archive-target",
    availableInMCP: true,
    nodes: (() => { const t = manualTrigger(), c = codeNode("c1", "Import", "// legacy importer — no longer used\nreturn $input.all();\n", [220, 0]), d = noOp("d1", "Done", [440, 0]); return [t, c, d]; })(),
  },
  {
    name: "Ad-hoc sandbox",
    kind: "realism-gated", // left availableInMCP=false — S1/pull may trip the gate (signal)
    availableInMCP: false,
    nodes: (() => { const t = manualTrigger(), c = codeNode("c1", "Scratch", "return [{ json: { ok: true } }];\n", [220, 0]); return [t, c]; })(),
  },
  {
    name: "Contact normalizer",
    kind: "s1-skeleton", // manual trigger -> EMPTY Code node "Normalize" -> Done; S1 authors the code
    availableInMCP: true,
    nodes: (() => { const t = manualTrigger(), c = codeNode("c1", "Normalize", "", [220, 0]), d = noOp("d1", "Done", [440, 0]); return [t, c, d]; })(),
  },
];

// ---------- boot + provision ----------
interface SeedResult { id: string; name: string; slug: string; availableInMCP: boolean; kind: string }
async function provision(): Promise<{ container: string | null; seeded: SeedResult[] }> {
  const external = process.env.FIELD_N8N_URL;
  let container: string | null = null;

  if (external) {
    HOST = external.replace(/\/+$/, "");
    MCP = process.env.FIELD_MCP_TOKEN ?? "";
    KEY = process.env.FIELD_API_KEY ?? "";
    if (!MCP) throw new Error("FIELD_N8N_URL mode needs FIELD_MCP_TOKEN (the instance's MCP bearer token)");
    console.log(`targeting existing instance ${HOST} (no boot, no owner/MCP provisioning)`);
  } else {
    try { await docker("version", "--format", "{{.Server.Version}}"); }
    catch { console.error("docker daemon not reachable — start Docker (or set FIELD_N8N_URL)"); process.exit(2); }
    console.log(`booting ${IMAGE} as ${CONTAINER} …`);
    await docker("run", "-d", "--name", CONTAINER, "-p", "127.0.0.1::5678",
      "-e", "N8N_SECURE_COOKIE=false", "-e", "N8N_DIAGNOSTICS_ENABLED=false",
      "-e", "N8N_PERSONALIZATION_ENABLED=false", "-e", "N8N_MCP_SERVER_RATE_LIMIT=10000",
      IMAGE);
    container = CONTAINER;
    const { stdout } = await docker("port", CONTAINER, "5678");
    HOST = `http://${stdout.trim().split("\n")[0]}`;

    // readiness: /healthz is liveness only — gate on /rest/settings returning JSON
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await fetch(`${HOST}/rest/settings`).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("application/json")).catch(() => false);
      if (!ready) await sleep(2000);
    }
    if (!ready) throw new Error(`n8n never became ready at ${HOST}`);
    console.log(`n8n ready at ${HOST}`);

    // owner setup (special-char password) → n8n-auth cookie
    const setup = await rest("POST", "/rest/owner/setup", OWNER);
    if (!setup.ok) throw new Error(`owner setup failed: ${setup.status} ${await setup.text()}`);
    COOKIE = authCookie(setup) ?? "";
    for (let i = 0; i < 5 && !COOKIE; i++) {
      const login = await rest("POST", "/rest/login", { emailOrLdapLoginId: OWNER.email, password: OWNER.password });
      COOKIE = authCookie(login) ?? "";
      if (!COOKIE) await sleep(1500);
    }
    if (!COOKIE) throw new Error("no n8n-auth cookie from setup or login");

    // scoped public API key (verify's byte-exact read + the agent's REST verbs)
    const keyRes = await rest("POST", "/rest/api-keys", {
      label: "flows-ops", expiresAt: null,
      scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:delete", "workflow:list", "workflow:activate", "workflow:deactivate", "execution:read", "execution:list", "tag:create", "tag:read", "workflowTags:update", "workflowTags:list"],
    });
    if (!keyRes.ok) throw new Error(`api key creation failed: ${keyRes.status} ${await keyRes.text()}`);
    KEY = JSON.parse(await keyRes.text()).data.rawApiKey;

    // enable MCP + mint the rotatable token
    const mcpEnable = await rest("PATCH", "/rest/mcp/settings", { mcpAccessEnabled: true });
    if (!mcpEnable.ok) throw new Error(`enabling MCP failed: ${mcpEnable.status} ${await mcpEnable.text()}`);
    const rotate = await rest("POST", "/rest/mcp/api-key/rotate");
    if (!rotate.ok) throw new Error(`MCP token rotate failed: ${rotate.status} ${await rotate.text()}`);
    MCP = JSON.parse(await rotate.text()).data.apiKey;
  }

  // realism + skeleton seeding via the public API (needs a key)
  if (!KEY) throw new Error("no public API key available for seeding (FIELD_N8N_URL mode needs FIELD_API_KEY)");
  const seeded: SeedResult[] = [];
  const toEnable: string[] = [];
  for (const s of SEEDS) {
    const created = await api("POST", "/api/v1/workflows", { name: s.name, nodes: s.nodes, connections: chain(s.nodes), settings: { executionOrder: "v1" } });
    seeded.push({ id: created.id, name: s.name, slug: kebab(s.name), availableInMCP: s.availableInMCP, kind: s.kind });
    if (s.availableInMCP) toEnable.push(created.id);
  }
  // per-workflow MCP opt-in for the available ones (REST toggle needs the owner cookie; skipped in external mode)
  if (toEnable.length && COOKIE) {
    const res = await rest("PATCH", "/rest/mcp/workflows/toggle-access", { availableInMCP: true, workflowIds: toEnable });
    if (!res.ok) throw new Error(`toggle-access failed: ${res.status} ${await res.text()}`);
  } else if (toEnable.length) {
    console.warn("external mode: cannot toggle availableInMCP without the owner cookie — enable these in the n8n UI:", toEnable.join(", "));
  }
  return { container, seeded };
}

// ---------- scaffold the neutral scratch project ----------
async function scaffold(): Promise<{ workDir: string; harnessRoot: string; skills: SkillsInstall; decanterInstalled: boolean }> {
  const base = os.tmpdir();
  const workDir = path.join(base, `flows-ops-${PID}`);
  const harnessRoot = path.join(base, `ftrun-${PID}`);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(harnessRoot, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(harnessRoot, "transcripts"), { recursive: true });

  // The blind session runs UNSANDBOXED (Plan 35 §Cast — nested claude needs to
  // reach the local n8n; the default Claude Code Bash sandbox allowlists only
  // npm/GitHub egress and would refuse 127.0.0.1:<n8n port>, forcing the agent
  // offline). Disable the nested session's sandbox via settings.local.json —
  // NOT settings.json, which is where init scaffolds the template's project
  // policy since Plan 56: a pre-existing settings.json would be `adopt`ed by the
  // template scan and decanter's permissions + hooks would never land. The local
  // slot is the right one for a harness override anyway, and run.mts merges its
  // allow-extension into this same file.
  mkdirSync(path.join(workDir, ".claude"), { recursive: true });
  writeFileSync(path.join(workDir, ".claude", "settings.local.json"), JSON.stringify({ sandbox: { enabled: false } }, null, 2) + "\n");

  // a git repo from the start (a real user "keeps flows in a git folder"); neutral author
  await execFile("git", ["-C", workDir, "init", "-q"]);
  await execFile("git", ["-C", workDir, "config", "user.email", OWNER.email]);
  await execFile("git", ["-C", workDir, "config", "user.name", "Priya Ops"]);
  await execFile("git", ["-C", workDir, "config", "commit.gpgsign", "false"]);

  // Pre-seed a CORRECT .env (the user already configured their creds — realistic
  // for a returning project) so every session/guard can actually REACH n8n. The
  // agent still runs `n8n-decanter init` to scaffold the template (.mcp.json
  // guard, AGENTS.md, config); init detects this .env and reuses the host without
  // re-prompting. This sidesteps round-1a's product FINDING that `init` writes
  // https:// for a local http instance (breaking the guard, which reads .env
  // directly) — that finding is logged for triage, not masked. `FIELD_NO_SEED_ENV=1`
  // omits this to exercise init's cold host-prompt path (and reproduce the bug).
  if (process.env.FIELD_NO_SEED_ENV !== "1") {
    writeFileSync(path.join(workDir, ".env"), `N8N_HOST=${HOST}\nN8N_MCP_TOKEN=${MCP}\nN8N_API_KEY=${KEY}\n`);
  }

  // Put OUR version of the CLI in the project — the code under test, not whatever
  // is published to npm. A WORKDIR-LOCAL install (node_modules/.bin) is the
  // breadcrumb + the runnable bin; run.mts prepends node_modules/.bin to the blind
  // session's PATH so a bare `n8n-decanter` resolves to this copy (guard + agent
  // alike). Deliberately NOT a global `npm link` — that mutates machine-global
  // state and leaves the user's global command dangling after teardown.
  //
  // Default: build + `npm pack` OUR repo to a tarball, install it locally (Node
  // won't type-strip .mts under node_modules, so the packed dist/ is the bin that
  // runs). FIELD_DECANTER_SPEC overrides with an npm spec (published version,
  // tarball, or git ref) when you deliberately want that instead.
  const spec = process.env.FIELD_DECANTER_SPEC;
  writeFileSync(path.join(workDir, "package.json"), JSON.stringify({ name: "flows-ops", private: true, dependencies: { "n8n-decanter": spec ?? "^0.6.0" } }, null, 2) + "\n");
  let decanterInstalled = false;
  try {
    if (spec) {
      await execFile("npm", ["install", "--no-audit", "--no-fund", spec], { cwd: workDir });
      console.log(`installed n8n-decanter (${spec}) into the project`);
    } else {
      // `npm pack` runs prepack (build → dist/) and prints the tarball name as JSON.
      const { stdout } = await execFile("npm", ["pack", "--pack-destination", workDir, "--json"], { cwd: PACKAGE_ROOT });
      const tgz = (JSON.parse(stdout) as Array<{ filename: string }>)[0].filename;
      await execFile("npm", ["install", "--no-audit", "--no-fund", path.join(workDir, tgz)], { cwd: workDir });
      console.log(`packed + locally installed n8n-decanter (${tgz}) — no global link`);
    }
    decanterInstalled = true;
  } catch (err) {
    console.warn(`providing n8n-decanter failed (${(err as Error).message.split("\n")[0]}) — the agent may not discover the CLI`);
  }

  // install the official n8n skills pack the way a real user would
  const skills = await installSkillsPack(workDir);
  return { workDir, harnessRoot, skills, decanterInstalled };
}

// ---------- allow-list extension (runner merges into settings.local.json post-init) ----------
// The mutating verbs a consenting user would approve, plus preflight (read-only,
// not yet in the template allow-list — Plan 36), plus git/npm/node bootstrap.
// The template DENY rules stay active (push --force, .decanter.json, .env) —
// deny wins over allow, so the guards under test hold.
const ALLOW_EXTENSION = [
  "Bash(npx n8n-decanter:*)", "Bash(npx n8n-decanter *)",
  "Bash(n8n-decanter init)", "Bash(n8n-decanter init:*)",
  "Bash(n8n-decanter push)", "Bash(n8n-decanter push:*)",
  "Bash(n8n-decanter publish)", "Bash(n8n-decanter publish:*)",
  "Bash(n8n-decanter unpublish)", "Bash(n8n-decanter unpublish:*)",
  "Bash(n8n-decanter test)", "Bash(n8n-decanter test:*)",
  "Bash(n8n-decanter preflight)", "Bash(n8n-decanter preflight:*)",
  "Bash(n8n-decanter watch)", "Bash(n8n-decanter watch:*)",
  "Bash(n8n-decanter scenario:*)", "Bash(n8n-decanter backup:*)",
  "Bash(git init:*)", "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(npm install)", "Bash(npm install:*)", "Bash(npm run:*)", "Bash(node:*)",
  "Bash(printf:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(mv:*)",
];

// ---------- run ----------
try {
  const { container, seeded } = await provision();
  const { workDir, harnessRoot, skills, decanterInstalled } = await scaffold();
  const manifest = {
    createdAt: new Date().toISOString(),
    n8nTag: process.env.FIELD_N8N_URL ? null : IMAGE,
    host: HOST,
    container,
    mcpToken: MCP,
    apiKey: KEY,
    owner: { email: OWNER.email },
    harnessRoot,
    workDir,
    root: "workflows",
    skills,
    decanterInstalled,
    seeded,
    allowExtension: ALLOW_EXTENSION,
  };
  const manifestPath = path.join(harnessRoot, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(harnessRoot, "allow-extension.json"), JSON.stringify({ permissions: { allow: ALLOW_EXTENSION } }, null, 2) + "\n");

  console.log("\n=== stage ready ===");
  console.log(`host        ${HOST}`);
  console.log(`container   ${container ?? "(external — FIELD_N8N_URL)"}`);
  console.log(`workDir     ${workDir}   (blind agent cwd)`);
  console.log(`harnessRoot ${harnessRoot}   (manifest, transcripts, guard.log — agent never enters)`);
  console.log(`skills      ${skills.found ? `${skills.count} vendored${skills.license ? ` (${skills.license})` : ""}` : "PACK ABSENT (clone failed)"} — ${skills.fidelity}`);
  console.log("seeded workflows:");
  for (const s of seeded) console.log(`  ${s.availableInMCP ? "✓" : "·"} ${s.name}  [${s.kind}]  ${s.id}`);
  console.log(`\nmanifest    ${manifestPath}`);
  console.log(`teardown    node scripts/field-test/stage.mts --down ${manifestPath}`);
  // machine-readable last line for the orchestrator
  console.log(`\nMANIFEST=${manifestPath}`);
} catch (err) {
  console.error("stage failed:", (err as Error).message);
  if (!process.env.FIELD_N8N_URL && process.env.FIELD_KEEP !== "1") await docker("rm", "-f", CONTAINER).catch(() => {});
  process.exit(1);
}
