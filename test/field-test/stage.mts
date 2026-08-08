// Plan 35 — blind-agent field test: STAGE (dev-only, never part of `npm test`).
//
// Boots + provisions a throwaway n8n (or targets an existing one) and scaffolds
// the neutral scratch project a blind Sonnet session will run in, then prints a
// stage manifest for the orchestrator (test/field-test/run.mts). Reuses the
// smoke-suite recipe facts (AGENTS.md "Driving a real n8n in Docker"); talks to
// n8n with plain fetch only.
//
// Blinding: every harness-authored name is neutral (container, dirs, owner,
// workflows, git author) — no eval-signalling vocabulary. Harness artifacts
// (manifest, transcripts, guard.log) live in a SIBLING harnessRoot the agent
// never cd's into, so the manifest's metadata can't leak into a blind session.
//
// Usage:
//   node test/field-test/stage.mts                # boot + provision + scaffold
//   node test/field-test/stage.mts --n8n-tag n8nio/n8n:2.33.3   # a different n8n
//   node test/field-test/stage.mts --down <manifest.json>   # teardown
//   node test/field-test/stage.mts --help
//
// Env knobs:
//   FIELD_N8N_TAG=<image>   override the pinned n8n image (default matches smoke).
//                           Prefer the `--n8n-tag` FLAG: an inline `VAR=… node …`
//                           prefix breaks agent-sandbox allowlist matching, so an
//                           env-only knob is one a sandboxed agent cannot set.
//   FIELD_N8N_URL=<url>     target an already-running local instance; skips the
//                           Docker boot AND owner/MCP provisioning (assumes the
//                           instance already has MCP enabled + a token you pass
//                           via FIELD_MCP_TOKEN / FIELD_API_KEY); teardown then
//                           leaves the instance alone.
//   FIELD_MCP_TOKEN=<tok>   (FIELD_N8N_URL mode) the instance's MCP bearer token
//   FIELD_API_KEY=<key>     (FIELD_N8N_URL mode) a public API key for that instance
//   FIELD_KEEP=1            (--down) keep the container; only remove harness dirs
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installSkillsPack, type SkillsInstall } from "./skills-install.mts";

const execFile = promisify(execFileCb);
/** The n8n-decanter repo this stage lives in — the CLI under test (test/field-test/ → ../..). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");
const docker = (...args: string[]) => execFile("docker", args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `--n8n-tag <image>` (or `FIELD_N8N_TAG`): which n8n to boot. The flag wins.
 *
 * A flag, not just an env var, on purpose: every archived round to date ran
 * against ONE n8n version, which makes every claim version-locked — and the
 * knob that would have varied it was reachable only as `FIELD_N8N_TAG=… node …`,
 * a form agent sandboxes refuse. Same reasoning as `--step=` on the e2e runner. */
const IMAGE = process.argv.includes("--n8n-tag")
  ? process.argv[process.argv.indexOf("--n8n-tag") + 1]
  : (process.env.FIELD_N8N_TAG ?? "n8nio/n8n:2.30.7"); // default keeps in sync with test/smoke-n8n.mts
if (IMAGE === undefined || IMAGE.startsWith("--")) { console.error("--n8n-tag needs an image, e.g. --n8n-tag n8nio/n8n:2.33.3"); process.exit(2); }
const PID = process.pid;
const CONTAINER = `flows-ops-n8n-${PID}`;
// Neutral owner — never shown to the agent, but kept clean anyway.
const OWNER = { email: "priya@flows.local", firstName: "Priya", lastName: "Ops", password: "Flows-0ps-Pass!" };

// ---------- teardown mode ----------
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "usage: node test/field-test/stage.mts [--seeds <pack>] [--n8n-tag <image>]",
    "       node test/field-test/stage.mts --down <manifest.json>",
    "",
    "  --n8n-tag <image>  n8n image to boot (default n8nio/n8n:2.30.7)",
  ].join("\n"));
  process.exit(0);
}
if (process.argv.includes("--down")) {
  const mfPath = process.argv[process.argv.indexOf("--down") + 1];
  if (!mfPath) { console.error("--down needs a manifest path"); process.exit(2); }
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

const splitInBatches = (id: string, name: string, batchSize: number, pos: [number, number]): N8nNode => ({ id, name, type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: pos, parameters: { batchSize, options: {} } });

interface Seed { name: string; nodes: N8nNode[]; availableInMCP: boolean; kind: string; connections?: Record<string, unknown>; origin?: { repo: string; sha: string; file: string } }

/**
 * The four workflows every round has ever staged. Kept as its own pack so
 * adding wave-2 material cannot perturb the world S1–S6 were measured in:
 * a fifth workflow changes what `list --remote` shows, which is an input to
 * S1's discovery beat and S6's fresh-clone measurement (Plan 61, D1).
 */
const BUILTIN_SEEDS: Seed[] = [
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

/**
 * Wave-2 additions (Plan 61). Two workflows the S8/S9 ladder scenarios need and
 * `builtin` deliberately lacks:
 *
 * - `s8-ladder` — TWO chained Code nodes, so a run gives the second one a real
 *   INPUT sample. A single self-contained Code node would produce a capture
 *   whose input is the manual trigger's empty item, which is precisely the
 *   synthetic-pin shape S8 exists to move past (D4).
 * - `loop-preview` — a `splitInBatches` loop, the one graph shape whose local
 *   replay is viewer-only and hard-errors headless. The corpus has no loop
 *   worth reusing, so it is hand-built.
 */
const ORDERS_FIXTURE = `// upstream system hands us the week's orders
const orders = [
  { id: 'A-1', customer: 'ada', amount: 42.5, kind: 'sale' },
  { id: 'A-2', customer: 'bo', amount: 13.25, kind: 'sale' },
  { id: 'A-3', customer: 'ada', amount: -13.25, kind: 'refund' },
  { id: 'A-4', customer: 'cy', amount: 99.999, kind: 'sale' },
  { id: 'A-5', customer: 'bo', amount: 7.005, kind: 'sale' },
  { id: 'A-6', customer: 'cy', amount: -99.999, kind: 'refund' },
];
return orders.map((json) => ({ json }));
`;
const TOTALS_CODE = `// weekly totals per customer
const totals = {};
for (const item of $input.all()) {
  const { customer, amount } = item.json;
  totals[customer] = (totals[customer] ?? 0) + amount;
}
return Object.entries(totals).map(([customer, total]) => ({ json: { customer, total } }));
`;
const WAVE2_SEEDS: Seed[] = [
  {
    name: "Weekly revenue totals",
    kind: "s8-ladder",
    availableInMCP: true,
    nodes: (() => {
      const t = manualTrigger();
      const fetch = codeNode("c1", "Fetch orders", ORDERS_FIXTURE, [220, 0]);
      const totals = codeNode("c2", "Build totals", TOTALS_CODE, [440, 0]);
      const d = noOp("d1", "Done", [660, 0]);
      return [t, fetch, totals, d];
    })(),
  },
  {
    name: "Order backlog in chunks",
    kind: "loop-preview",
    availableInMCP: true,
    nodes: (() => {
      const t = manualTrigger();
      const make = codeNode("c1", "Make batches", "return Array.from({ length: 7 }, (_, i) => ({ json: { order: i + 1 } }));\n", [220, 0]);
      const loop = splitInBatches("l1", "Loop", 3, [440, 0]);
      const process = codeNode("c2", "Process chunk", "return $input.all().map((i) => ({ json: { ...i.json, seen: true } }));\n", [660, 120]);
      const d = noOp("d1", "Done", [660, -120]);
      return [t, make, loop, process, d];
    })(),
    // splitInBatches has TWO outputs — 0 is "done", 1 is the loop body — so the
    // straight-line `chain()` helper cannot express it.
    connections: {
      "When clicked": { main: [[{ node: "Make batches", type: "main", index: 0 }]] },
      "Make batches": { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      Loop: { main: [[{ node: "Done", type: "main", index: 0 }], [{ node: "Process chunk", type: "main", index: 0 }]] },
      "Process chunk": { main: [[{ node: "Loop", type: "main", index: 0 }]] },
    },
  },
];

/**
 * Seed packs, selected with `--seeds <pack>` / `FIELD_SEED_PACK`. `builtin` is
 * the default and reproduces every earlier round's world exactly.
 */
/**
 * A seed pack read from `seeds/<pack>.json` (Plan 61 wave 2b) — a DECLARATIVE
 * manifest, never vendored workflow JSON. `n8n-io/test-workflows` ships no
 * license file, so its content is fetched at stage time, cached outside git, and
 * never committed; the manifest records `repo@sha` + filename so a round stays
 * reproducible without copying anything.
 */
interface PackFile {
  source: { repo: string; sha: string; path: string };
  seeds: Array<{ inline?: string; file?: string; kind?: string; why?: string; availableInMCP?: boolean }>;
}

/** Corpus JSON cached by sha, OUTSIDE the repo — fetched once, reused by later stages. */
const corpusCache = (sha: string) => path.join(os.tmpdir(), `decanter-corpus-${sha.slice(0, 12)}`);

async function fetchCorpusFile(source: PackFile["source"], file: string): Promise<any> {
  const cacheDir = corpusCache(source.sha);
  const cached = path.join(cacheDir, file);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.sha}/${source.path}/${file}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`corpus fetch failed: ${url} -> ${res.status}`);
  const text = await res.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, text);
  return JSON.parse(text);
}

/**
 * Vet + modernize on import (Plan 61 D2/task 6). Rewrites are **explicit and
 * logged**, never silent: `n8n-nodes-base.start` no longer ships in n8n 2.30.7,
 * so a raw import would land an unrecognized trigger. `function` → `code` is
 * deliberately NOT done — the un-converted workflow is the interesting case.
 */
function modernize(wf: any, file: string): { nodes: N8nNode[]; connections: Record<string, unknown>; transforms: string[] } {
  const transforms: string[] = [];
  const nodes = (wf.nodes ?? []).map((n: N8nNode) => {
    if (n.type !== "n8n-nodes-base.start") return n;
    transforms.push(`${n.name}: n8n-nodes-base.start → manualTrigger (Start was removed from n8n)`);
    return { ...n, type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} };
  });
  if (wf.active === true) transforms.push("dropped active:true (a seeded workflow never starts live)");
  if (transforms.length > 0) console.log(`  ${file}: ${transforms.join("; ")}`);
  return { nodes, connections: wf.connections ?? {}, transforms };
}

/**
 * Node types the instance actually registers, or `null` when we cannot tell.
 *
 * `/rest/node-types` is internal and version-fragile, so a stage that cannot
 * read it must say the vet was **skipped** rather than claim a pass — the whole
 * point of the vet is that a seed with an unknown node type fails the STAGE, not
 * a scenario mid-round.
 */
async function registeredNodeTypes(): Promise<Set<string> | null> {
  if (!COOKIE) return null;
  try {
    // `/types/nodes.json` is the editor's registry — a flat array of every
    // installed node's description, cookie-authed. (`/rest/node-types` is a
    // *lookup* endpoint: POST it a list and it echoes those back, so it can
    // never enumerate. Verified on 2.30.7: GET /rest/node-types 404s.)
    // …and it is served LAZILY: seconds after owner setup it can still 404 while
    // the editor bundle is being assembled, so a single probe would make the vet
    // skip itself by timing alone. Retry briefly before concluding it is absent.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await rest("GET", "/types/nodes.json");
      if (res.ok) {
        const body = (await res.json()) as Array<{ name?: string }>;
        const names = (Array.isArray(body) ? body : []).map((n) => n.name).filter((n): n is string => typeof n === "string");
        if (names.length > 0) return new Set(names);
      }
      await sleep(2000);
    }
    return null;
  } catch {
    return null;
  }
}

const SEED_PACKS: Record<string, Seed[]> = {
  builtin: BUILTIN_SEEDS,
  wave2: [...BUILTIN_SEEDS, ...WAVE2_SEEDS],
};
const SEED_PACK = process.argv.includes("--seeds") ? process.argv[process.argv.indexOf("--seeds") + 1] : (process.env.FIELD_SEED_PACK ?? "builtin");
const PACK_FILE = path.join(HERE, "seeds", `${SEED_PACK}.json`);
if (SEED_PACKS[SEED_PACK] === undefined && !existsSync(PACK_FILE)) {
  console.error(`unknown seed pack ${JSON.stringify(SEED_PACK)} — known: ${[...Object.keys(SEED_PACKS), ...readdirSync(path.join(HERE, "seeds")).filter((f: string) => f.endsWith(".json")).map((f: string) => f.slice(0, -5))].join(", ")}`);
  process.exit(2);
}
const BUILTIN_BY_KIND = new Map(BUILTIN_SEEDS.concat(WAVE2_SEEDS).map((s) => [s.kind, s]));

/**
 * `--list-packs`: which kinds each pack seeds, as JSON, without booting anything.
 *
 * Plan 77. `--isolate` stages once PER UNIT, so each unit can have the pack its
 * scenario actually needs — but only if the caller can find out what a pack
 * contains. This keeps that knowledge here, where the packs are defined, instead
 * of duplicating a kind→pack table into `run.mts` for it to drift from.
 */
if (process.argv.includes("--list-packs")) {
  const packs: Record<string, string[]> = {};
  for (const [name, seeds] of Object.entries(SEED_PACKS)) packs[name] = seeds.map((s) => s.kind);
  for (const file of readdirSync(path.join(HERE, "seeds")).filter((f: string) => f.endsWith(".json"))) {
    const name = file.slice(0, -5);
    const manifest = JSON.parse(readFileSync(path.join(HERE, "seeds", file), "utf8")) as { seeds?: Array<{ kind?: string; inline?: string }> };
    packs[name] = (manifest.seeds ?? []).map((e) => e.kind ?? e.inline ?? "").filter((k) => k !== "");
  }
  console.log(JSON.stringify(packs, null, 2));
  process.exit(0);
}

/**
 * Resolve the selected pack to concrete seeds. A code pack is returned as-is; a
 * `seeds/<pack>.json` manifest is expanded — inline entries map back to the
 * hand-built builders by `kind`, corpus entries are fetched, vetted and
 * modernized. **A pack that cannot be seeded fails the STAGE**, never a scenario
 * mid-round (Plan 61 task 6).
 */
async function resolveSeeds(): Promise<Seed[]> {
  const code = SEED_PACKS[SEED_PACK];
  if (code !== undefined) return code;
  const pack = JSON.parse(readFileSync(PACK_FILE, "utf8")) as PackFile;
  const registered = await registeredNodeTypes();
  console.log(registered === null
    ? "  seed vet: the instance never served its node registry — SKIPPED (node types are NOT checked)"
    : `  seed vet: ${registered.size} node types registered on this instance`);
  const out: Seed[] = [];
  for (const entry of pack.seeds) {
    if (entry.inline !== undefined) {
      const seed = BUILTIN_BY_KIND.get(entry.inline);
      if (!seed) throw new Error(`pack ${SEED_PACK}: no built-in seed of kind "${entry.inline}"`);
      out.push(seed);
      continue;
    }
    if (entry.file === undefined || entry.kind === undefined) throw new Error(`pack ${SEED_PACK}: an entry needs either "inline" or "file" + "kind"`);
    const wf = await fetchCorpusFile(pack.source, entry.file);
    const { nodes, connections } = modernize(wf, entry.file);
    if (registered !== null) {
      const unknown = [...new Set(nodes.map((n) => n.type))].filter((t) => !registered.has(t));
      if (unknown.length > 0) {
        throw new Error(`pack ${SEED_PACK}: ${entry.file} ("${wf.name}") uses node type(s) this n8n does not register: ${unknown.join(", ")} — fix the pack or the transforms, do not run a round on it`);
      }
    }
    out.push({
      name: wf.name ?? entry.file,
      kind: entry.kind,
      availableInMCP: entry.availableInMCP !== false,
      nodes,
      connections,
      origin: { repo: pack.source.repo, sha: pack.source.sha, file: entry.file },
    });
  }
  return out;
}

// ---------- boot + provision ----------
interface SeedResult { id: string; name: string; slug: string; availableInMCP: boolean; kind: string; origin?: { repo: string; sha: string; file: string }; nodeTypes?: number; codeNodes?: number; credentialRefs?: number }
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
      scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:delete", "workflow:list", "workflow:activate", "workflow:deactivate", "execution:read", "execution:list", "tag:create", "tag:read", "workflowTags:update", "workflowTags:list", "dataTable:create", "dataTable:list", "dataTable:read", "dataTableColumn:create", "dataTableColumn:read", "dataTableRow:create", "dataTableRow:read"],
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
  for (const s of await resolveSeeds()) {
    const created = await api("POST", "/api/v1/workflows", { name: s.name, nodes: s.nodes, connections: s.connections ?? chain(s.nodes), settings: { executionOrder: "v1" } });
    seeded.push({
      id: created.id, name: s.name, slug: kebab(s.name), availableInMCP: s.availableInMCP, kind: s.kind,
      // provenance travels into the manifest so a round is reproducible without
      // the corpus ever entering git (Plan 61 task 5)
      ...(s.origin !== undefined ? { origin: s.origin } : {}),
      nodeTypes: [...new Set(s.nodes.map((n) => n.type))].length,
      codeNodes: s.nodes.filter((n) => n.type === "n8n-nodes-base.code").length,
      credentialRefs: s.nodes.filter((n) => (n as { credentials?: unknown }).credentials !== undefined).length,
    });
    if (s.availableInMCP) toEnable.push(created.id);
  }
  // S12 asks "what's in the Orders table?" — a pack that stages workflows but no
  // table would measure the agent hunting for something that does not exist.
  // Public-API create + row insert, the same recipe the smoke suite uses; a
  // too-old n8n 404s the surface, and that is a skip, not a stage failure.
  if (SEED_PACK !== "builtin") {
    try {
      const probe = await fetch(`${HOST}/api/v1/data-tables`, { headers: { "X-N8N-API-KEY": KEY, accept: "application/json" } });
      if (probe.status === 404) {
        console.log("  data table: /api/v1/data-tables is absent on this n8n — skipped");
      } else {
        const table = await api("POST", "/api/v1/data-tables", {
          name: "Orders",
          columns: [{ name: "reference", type: "string" }, { name: "status", type: "string" }, { name: "total", type: "number" }],
        });
        await api("POST", `/api/v1/data-tables/${table.id}/rows`, {
          data: [
            { reference: "A-1001", status: "pending", total: 42.5 },
            { reference: "A-1002", status: "shipped", total: 13.25 },
            { reference: "A-1003", status: "pending", total: 99.99 },
            { reference: "A-1004", status: "cancelled", total: 0 },
            { reference: "A-1005", status: "pending", total: 7.01 },
          ],
        });
        console.log(`  data table "Orders" seeded with 5 rows (${table.id})`);
      }
    } catch (err) {
      console.warn(`  data table seeding failed (${(err as Error).message.split("\n")[0]}) — S12's table question will find nothing`);
    }
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


/**
 * Merge harness overrides into the workDir's `.claude/settings.local.json` — the
 * LOCAL layer (highest precedence), which the HARNESS owns. The template's
 * `settings.json` (the project contract: the DENY rules this test verifies) is
 * never touched, so the two layers stay separated regardless of which filename
 * the template ships. Creates the file when absent.
 */
function mergeLocalSettings(workDir: string, patch: Record<string, unknown>): void {
  const file = path.join(workDir, '.claude', 'settings.local.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* absent or unreadable — start fresh */ }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

/**
 * Strip the harness's own npm scripts from a packed CLI tarball — IN PLACE.
 *
 * `npm pack` ships the whole `scripts` block, so an installed decanter carries
 * `"field-test:stage": …` into the blind session's `node_modules`. A round-2
 * agent read that `package.json` and saw them (it did not infer an evaluation,
 * so the round stayed gradeable — but the next one might).
 *
 * Rewriting the TARBALL rather than an installed copy is deliberate: it is the
 * single point both install paths flow through — host mode's
 * `npm install <tgz>` into the workDir, and container mode's `npm install -g`
 * inside the fenced image, which the harness never touches afterwards.
 *
 * Only `field-test:*` is removed. Everything else (`test`, `test:smoke`,
 * `lint`, …) is what a genuine `npm i n8n-decanter` also shows, and stripping
 * more would make the blind environment LESS like a real user's — the opposite
 * of what this harness is for.
 */
async function unblindTarball(tgz: string): Promise<string[]> {
  const work = path.join(path.dirname(tgz), ".unblind");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    await execFile("tar", ["-xzf", tgz, "-C", work]);
    const pkgFile = path.join(work, "package", "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> };
    const removed = Object.keys(pkg.scripts ?? {}).filter((s) => s.startsWith("field-test:"));
    if (removed.length === 0) return [];
    for (const s of removed) delete pkg.scripts![s];
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    // Repack with the same `package/` root npm expects. COPYFILE_DISABLE=1 keeps
    // macOS `tar` from serialising extended attributes as AppleDouble sidecars:
    // `template/.env.example` carries `com.apple.provenance` here, so the repack
    // shipped a `template/._.env.example`, which `init` then dutifully installed
    // into the blind project as `._.env` ("added ._.env from the template"). Two
    // cold rounds' agents spent a command working out it was junk. npm's own pack
    // is node-tar and never does this — the artifact was ours, not the product's.
    await execFile("tar", ["-czf", tgz, "-C", work, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return removed;
  } catch (err) {
    // never fail a stage over blinding hygiene — say so and carry on
    console.warn(`could not strip field-test scripts from the packed CLI (${(err as Error).message.split("\n")[0]}) — the blind session may see them`);
    return [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- scaffold the neutral scratch project ----------
async function scaffold(): Promise<{ workDir: string; harnessRoot: string; skills: SkillsInstall; decanterInstalled: boolean; inited: boolean; cliTarball: string | null; decanterSpec: string | null; noCli: boolean; seedEnv: boolean }> {
  const base = os.tmpdir();
  const workDir = path.join(base, `flows-ops-${PID}`);
  const harnessRoot = path.join(base, `ftrun-${PID}`);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(harnessRoot, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(harnessRoot, "transcripts"), { recursive: true });

  mkdirSync(path.join(workDir, ".claude"), { recursive: true });
  // NB: the harness's own overrides (sandbox-disable, allow-extension) are merged
  // into `.claude/settings.local.json` AFTER init — see mergeLocalSettings below.
  // They deliberately do NOT live in `.claude/settings.json`: that file is the
  // TEMPLATE's project contract (the DENY rules this test verifies), while
  // settings.local.json is the local override layer with the highest precedence.
  // Writing them pre-init used to be necessary only because the stage ran before
  // init could clobber the file; the stage runs init itself now, so the ordering
  // constraint is gone and the two layers stay cleanly separated.

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
  // omits this to stage the COLD-START condition (S14): no credentials anywhere,
  // the agent has to obtain them. See the matching removal after `init` below —
  // skipping the pre-seed alone does not stage it, because init writes a .env too.
  const seedEnv = process.env.FIELD_NO_SEED_ENV !== "1";
  if (seedEnv) {
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
  // The packed tarball (host mode installs it into workDir; CONTAINER mode bakes
  // it into the fenced agent image at build time — the runtime fence has no npm).
  let cliTarball: string | null = null;
  try {
    if (spec) {
      await execFile("npm", ["install", "--no-audit", "--no-fund", spec], { cwd: workDir });
      console.log(`installed n8n-decanter (${spec}) into the project`);
    } else {
      // `npm pack` runs prepack (build → dist/) and prints the tarball name as JSON.
      const { stdout } = await execFile("npm", ["pack", "--pack-destination", workDir, "--json"], { cwd: PACKAGE_ROOT });
      const tgz = (JSON.parse(stdout) as Array<{ filename: string }>)[0].filename;
      cliTarball = path.join(workDir, tgz);
      const stripped = await unblindTarball(cliTarball);
      await execFile("npm", ["install", "--no-audit", "--no-fund", cliTarball], { cwd: workDir });
      console.log(`packed + locally installed n8n-decanter (${tgz}) — no global link${stripped.length ? `; stripped ${stripped.length} blinding script(s): ${stripped.join(", ")}` : ""}`);
    }
    decanterInstalled = true;
  } catch (err) {
    console.warn(`providing n8n-decanter failed (${(err as Error).message.split("\n")[0]}) — the agent may not discover the CLI`);
  }

  // Pre-run `init` so the blind session starts from a READY project (maintainer
  // call 2026-07-24: setup is not what the scenarios measure — the agent should
  // arrive at a configured dir like a returning user). Scaffolds .mcp.json (the
  // guard the agent will use), AGENTS.md, .claude/, decanter.config.json,
  // tsconfig, n8n-globals.d.ts. Driven by the NON-INTERACTIVE flags (#144) — the
  // very path round-1 finding 3 produced — so it also works under
  // FIELD_NO_SEED_ENV=1, where there is no .env to reuse.
  let inited = false;
  if (decanterInstalled) {
    try {
      const bin = path.join(workDir, "node_modules", ".bin", "n8n-decanter");
      const args = ["init", ".", "--host", HOST, "--token", MCP];
      if (KEY) args.push("--api-key", KEY);
      await execFile(bin, args, { cwd: workDir });
      inited = true;
      console.log("ran `n8n-decanter init` (non-interactive) — the agent arrives at a configured project");
      // …and install the sync dir's own devDeps (typescript, the ts plugin) that
      // init's package.json declares, so the blind agent never has to run
      // `npm install` either. Setup is not what the scenarios measure.
      await execFile("npm", ["install", "--no-audit", "--no-fund"], { cwd: workDir })
        .then(() => console.log("ran `npm install` in the project — devDeps present before the blind session"))
        .catch((e) => console.warn(`npm install after init failed (${(e as Error).message.split("\n")[0]})`));
      // The blind session runs UNSANDBOXED (Plan 35 §Cast — nested claude must
      // reach the local n8n; Claude Code's default Bash sandbox allowlists only
      // npm/GitHub egress and would refuse 127.0.0.1:<n8n port>). In CONTAINER
      // mode the container is the real boundary, so this is belt-and-braces.
      // Merged into the LOCAL layer, never the template's settings.json.
      mergeLocalSettings(workDir, { sandbox: { enabled: false } });
      // FIELD_NO_SEED_ENV=1 — take the credentials back OUT. The stage runs init
      // with the non-interactive flags, so init WRITES a working .env; skipping
      // the pre-seed above is not enough on its own (the flag silently stopped
      // staging its condition when the stage took init over — a whole S14 round
      // graded a fully configured project before this was caught). Deleting the
      // credential files after the scaffold is exactly a fresh clone: the
      // template files are committed, .env and .decanter-auth.json are not.
      if (!seedEnv) {
        // `._.env` too: a macOS AppleDouble sidecar survives the .env removal and
        // the first cold round's agent spent a command working out that it was an
        // artifact, not a config file. Don't leave a distractor in the condition.
        for (const f of [".env", "._.env", ".decanter-auth.json"]) rmSync(path.join(workDir, f), { force: true });
        console.log("FIELD_NO_SEED_ENV=1 — removed .env + .decanter-auth.json after init: scaffold present, NO credentials (cold start)");
      }
    } catch (err) {
      console.warn(`init failed (${(err as Error).message.split("\n")[0]}) — the blind agent would have to run it itself`);
    }
  }

  // install the official n8n skills pack the way a real user would
  const skills = await installSkillsPack(workDir);

  // FIELD_NO_CLI=1 — the FRESH-CLONE condition (Plan 57 direction 4).
  //
  // Everything above ran, so the project carries the full committed evidence a
  // teammate would have pushed: AGENTS.md, .mcp.json, decanter.config.json,
  // workflows/, package.json declaring n8n-decanter. Then the *installed* copy
  // is removed — exactly what `git clone` gives you before `npm install`.
  //
  // This is the deliberate, repeatable version of round 1's accidental
  // no-CLI condition. What it measures: does the agent READ the project's own
  // evidence and get the CLI running (npm install / npx), or does it bypass to
  // raw n8n MCP and edit jsCode inline? Nothing here blocks either path.
  //
  // Deliberately NOT staged: a project with no decanter evidence at all. That
  // is a different question (can an agent discover a tool it has never heard
  // of — near-certainly no, and arguable without spending a round), and it is
  // not what "without the CLI pre-installed" meant.
  let noCli = false;
  if (process.env.FIELD_NO_CLI === "1") {
    if (!inited) {
      console.warn("FIELD_NO_CLI=1 but init did not run — the project has no decanter evidence to find; staging it anyway");
    }
    // `npm install <tgz>` rewrote package.json to a `file:` spec pointing at the
    // stage's tarball. Left as-is, the agent's `npm install` would either
    // succeed for the WRONG reason (an offline tarball no clone would carry, and
    // a harness tell) or fail for the wrong reason once the tarball is gone.
    // A real repo pins a version range, so restore one: the recovery path
    // becomes the genuine "install it from the registry" the persona would take.
    // NOTE: that installs the PUBLISHED CLI, not this working copy — fine here,
    // because the scenario measures the agent's ROUTE, not our unreleased code.
    try {
      const pkgPath = path.join(workDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const ourVersion = (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
      const range = spec ?? `^${ourVersion}`;
      if (pkg.dependencies?.["n8n-decanter"]) pkg.dependencies["n8n-decanter"] = range;
      if (pkg.devDependencies?.["n8n-decanter"]) pkg.devDependencies["n8n-decanter"] = range;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`package.json now declares n8n-decanter ${range} (registry install is the agent's recovery path)`);
    } catch (err) {
      console.warn(`could not restore a version range in package.json (${(err as Error).message.split("\n")[0]})`);
    }
    // Drop the tarball BEFORE committing — committing it would bake a harness
    // artifact into the very git history the persona is meant to read.
    if (cliTarball) rmSync(cliTarball, { force: true });
    rmSync(path.join(workDir, "package-lock.json"), { force: true }); // would re-pin the file: spec
    // A clone's evidence lives in git history, and `git log` showing a
    // teammate's commit is part of what the agent can read. (Only this mode
    // commits — the other scenarios' dirty-tree start is deliberate.)
    try {
      await execFile("git", ["-C", workDir, "add", "-A"]);
      await execFile("git", ["-C", workDir, "commit", "-qm", "workflows synced from n8n"]);
      console.log("committed the scaffolded project (fresh-clone story: the evidence is in git)");
    } catch (err) {
      console.warn(`could not commit the scaffolding (${(err as Error).message.split("\n")[0]})`);
    }
    rmSync(path.join(workDir, "node_modules"), { recursive: true, force: true });
    noCli = true;
    console.log("FIELD_NO_CLI=1 — removed node_modules (fresh-clone state): the project's decanter evidence is committed, the CLI is NOT runnable");
  }

  return { workDir, harnessRoot, skills, decanterInstalled: decanterInstalled && !noCli, inited, cliTarball: noCli ? null : cliTarball, decanterSpec: spec ?? null, noCli, seedEnv };
}

// ---------- allow-list extension (runner merges into settings.local.json post-init) ----------
// The mutating verbs a consenting user would approve, plus the read-only gate
// verbs (`preflight` — Plan 36 — and `diff` — Plan 59), plus git/npm/node
// bootstrap. The read-only pair is belt-and-braces: the template ships them
// too, but a permission prompt mid-round costs an expensive, irreproducible
// agentic session, so the harness never depends on the template for them.
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
  "Bash(n8n-decanter diff)", "Bash(n8n-decanter diff:*)",
  "Bash(n8n-decanter watch)", "Bash(n8n-decanter watch:*)",
  "Bash(n8n-decanter scenario:*)", "Bash(n8n-decanter backup:*)",
  "Bash(git init:*)", "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(npm install)", "Bash(npm install:*)", "Bash(npm run:*)", "Bash(node:*)",
  "Bash(printf:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(mv:*)",
];

// ---------- run ----------
try {
  const { container, seeded } = await provision();
  const { workDir, harnessRoot, skills, decanterInstalled, inited, cliTarball, decanterSpec, noCli, seedEnv } = await scaffold();
  const manifest = {
    createdAt: new Date().toISOString(),
    n8nTag: process.env.FIELD_N8N_URL ? null : IMAGE,
    host: HOST,
    container,
    mcpToken: MCP,
    apiKey: KEY,
    // The owner cookie is the ONLY way to reach n8n's internal /rest/mcp/*
    // surface, which is what S13's failure-mode pre-hooks need in order to
    // revoke a workflow's MCP availability, rotate the token out from under the
    // session, or switch the MCP server off. Empty in FIELD_N8N_URL mode (no
    // owner setup ran), and redacted out of every committed archive.
    ownerCookie: COOKIE,
    owner: { email: OWNER.email },
    harnessRoot,
    workDir,
    root: "workflows",
    skills,
    decanterInstalled,
    // FIELD_NO_CLI=1: the project's decanter evidence is committed but the CLI
    // is NOT installed (fresh-clone state) — the Plan 57 discoverability
    // condition. Recorded so a round's archive states which world it measured.
    noCli,
    // FIELD_NO_SEED_ENV=1: no pre-seeded `.env`, so the project has NO
    // credentials and `init` must actually be driven — the Plan 62 task 2
    // condition. Recorded so a scenario can refuse a stage that would make it
    // measure nothing (S14), and so a round's archive states which world it saw.
    seedEnv,
    // the stage pre-ran init, so scenarios start from a configured project
    inited,
    // Container mode (run.mts --container) bakes one of these into the fenced
    // agent image: the local packed tarball, or the npm spec (FIELD_DECANTER_SPEC).
    cliTarball,
    decanterSpec,
    seedPack: SEED_PACK,
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
  console.log(`seed pack   ${SEED_PACK}`);
  console.log("seeded workflows:");
  for (const s of seeded) console.log(`  ${s.availableInMCP ? "✓" : "·"} ${s.name}  [${s.kind}]  ${s.id}`);
  console.log(`\nmanifest    ${manifestPath}`);
  console.log(`teardown    node test/field-test/stage.mts --down ${manifestPath}`);
  // machine-readable last line for the orchestrator
  console.log(`\nMANIFEST=${manifestPath}`);
} catch (err) {
  console.error("stage failed:", (err as Error).message);
  if (!process.env.FIELD_N8N_URL && process.env.FIELD_KEEP !== "1") await docker("rm", "-f", CONTAINER).catch(() => {});
  process.exit(1);
}
