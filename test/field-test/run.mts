// Plan 35 — blind-agent field test: ORCHESTRATOR (dev-only, unsandboxed).
//
// Drives one or more scenarios as blind, headless `claude -p --model sonnet`
// sessions against a staged n8n, captures transcripts + the guard's stderr, and
// runs the scripted invariant verifier after each. This is the REPRODUCIBLE
// spine — it replays each scenario's linear scripted turns (the `## Orchestration`
// block in test/field-test/scenarios/S*.md). ADAPTIVE beats (the prose
// "Beats" sections) are for a live orchestrator/grader to layer on; a fully
// deterministic script cannot judge "did the agent stall". GRADING (Opus over
// transcripts) is a separate, unblinded pass.
//
// Blind-run mechanics (verified against the current CLI in the validation pass):
//   - each turn is `claude -p "<msg>" --model sonnet --output-format stream-json
//     --verbose` run in the scratch workDir (the agent's cwd)
//   - turn 1 carries a generous --allowedTools bootstrap set (permission-UX is
//     out of scope; the template DENY rules still apply); the session id is read
//     from the stream, and turns 2..n use `--resume <id>` (fresh process, re-reads
//     .claude/ + .mcp.json from cwd each turn)
//   - AFTER turn 1 (init): merge the manifest's allowExtension into the
//     init-scaffolded .claude/settings.local.json (deny rules preserved) and
//     rewrite .mcp.json's n8n-instance command to capture the guard's stderr:
//     `sh -c 'n8n-decanter mcp connect 2>><harnessRoot>/guard.log'`
//
// Usage:
//   node test/field-test/run.mts <manifest.json> [S1 S2 …]   # default: S1–S4
//   node test/field-test/run.mts <manifest.json> --dry-run    # print turns, spawn nothing
//   node test/field-test/run.mts --help
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SESSION_START_NUDGE } from "./skills-install.mts";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");
// Declared up here, not next to the other container constants, because the
// `--isolate` pre-flight below needs it BEFORE the first stage boots.
const ENV_FILE = path.join(HERE, ".env"); // gitignored; holds the one credential
const VERIFY = path.join(HERE, "verify.mts");
const REPORT = path.join(HERE, "report.mts");

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log([
    "usage: node test/field-test/run.mts <manifest.json> [S1 S2 …] [--dry-run]",
    "       node test/field-test/run.mts --isolate [S1 S2 …]   one fresh instance per unit",
    "       node test/field-test/run.mts --isolate --all       every scenario, each isolated",
    "",
    "  --seeds <pack>    pin every unit to one pack; omit it and each unit gets the",
    "                    smallest pack covering its own requiresSeedKinds",
    "  --model <name>    model for the blind sessions (default sonnet)",
    "  --n8n-tag <image> n8n image each unit boots (default n8nio/n8n:2.30.7)",
  ].join("\n"));
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
// Container mode (Plan 35): run the blind agents in a Docker container, egress
// fenced to Anthropic-only — the safe way to run them UNATTENDED (see the
// container-mode design in the plan + test/field-test/docker/).
const containerMode = argv.includes("--container");
/** `--seeds <pack>`: pins every unit to one pack. Omit it and each unit gets the
 * smallest pack that covers its own `requiresSeedKinds` (Plan 77). */
const SEED_PACK_ARG = argv.includes("--seeds") ? argv[argv.indexOf("--seeds") + 1] : undefined;
/** `--model <name>`: which model drives the blind sessions (default `sonnet`).
 *
 * Every archived round to date ran on Sonnet, which leaves the harness unable to
 * separate "the scaffolded AGENTS.md steers agents file-first" from "Sonnet
 * happens to work that way" — the single claim the whole agent-facing case rests
 * on. A flag rather than an env var for the sandbox reason in `stage.mts`. */
const MODEL = (argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : process.env.FIELD_MODEL) ?? "sonnet";
/** `--n8n-tag <image>`: forwarded verbatim to each `--isolate` stage. */
const N8N_TAG_ARG = argv.includes("--n8n-tag") ? argv[argv.indexOf("--n8n-tag") + 1] : undefined;
for (const [flag, value] of [["--model", MODEL], ["--n8n-tag", N8N_TAG_ARG]] as const) {
  if (argv.includes(flag) && (value === undefined || value.startsWith("--"))) { console.error(`${flag} needs a value`); process.exit(2); }
}
// A flag's VALUE is not a scenario id — without this, `--model opus` would leave
// "opus" as a positional and be read as a manifest path or a scenario.
const VALUED_FLAGS = new Set(["--seeds", "--model", "--n8n-tag"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED_FLAGS.has(argv[i - 1] ?? ""));

/** Every scenario in the pack, numerically — `S2` before `S10`. */
function allScenarioIds(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => /^S\d+\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ""))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/**
 * Which seed pack does this unit need? (Plan 77.)
 *
 * `--isolate` stages once per unit, so the pack is a per-unit choice — that is
 * what makes a full sweep possible at all: S8/S9 want `wave2`'s kinds and
 * S7/S10/S12 want the corpus ones, and no single pack has to carry everything.
 * Picks the SMALLEST pack covering the unit's declared kinds, so an ordinary
 * scenario still gets `builtin` and does not pay for a corpus fetch.
 */
function packFor(unit: string[], packs: Record<string, string[]>): string {
  const needed = new Set(unit.flatMap((id) => loadScenario(id).requiresSeedKinds ?? []));
  if (needed.size === 0) return "builtin";
  const covering = Object.entries(packs)
    .filter(([, kinds]) => [...needed].every((k) => kinds.includes(k)))
    .sort((a, b) => a[1].length - b[1].length);
  if (covering.length === 0) {
    throw new Error(`no seed pack covers ${unit.join("+")}'s kinds (${[...needed].join(", ")}); known packs: ${Object.keys(packs).join(", ")}`);
  }
  return covering[0][0];
}

/**
 * Pre-hooks that stage something ABOVE the sync dir. The fenced agent container
 * mounts the sync dir and nothing else (`docker-compose.yml`:
 * `${FIELD_WORKDIR}:/work`), so in container mode what these plant is simply not
 * there — the same "the condition cannot exist here" shape as `requiresNoCli`,
 * and it has to be caught the same way: by name, before anything is spent.
 *
 * Learned the expensive way (2026-08-16 sweep): S15 ran fenced, its agent said
 * "No `../company-lib` directory exists anywhere on this filesystem", never
 * pulled, and `verify` reported FAIL. A harness gap that reads as a product
 * defect is worse than a skipped scenario, because it is believed.
 *
 * Declared here, not next to PRE_HOOKS, because the `--isolate` filter below
 * runs at module top level long before that map is initialized.
 */
const OUTSIDE_SYNC_DIR_HOOKS = new Set(["plant-outside-helper"]);

/**
 * `--isolate S7 S10 …`: one FRESH instance + scratch project per scenario (or
 * per `requires` chain), torn down before the next — the maintainer's standing
 * requirement that runs never share state, enforced rather than documented.
 *
 * Implemented by re-exec: this process stages, then spawns `run.mts <manifest>
 * <unit>` as a child and tears the stage down afterwards. Re-exec rather than
 * threading a second manifest through this module keeps every existing code
 * path — verify scoping, archiving, pre-hooks — byte-identical to a hand-driven
 * single run. Each unit archives on its own, so a later failure never costs the
 * earlier units' evidence.
 */
if (argv.includes("--isolate")) {
  let ids = argv.includes("--all") ? allScenarioIds() : positional.length > 0 ? positional : ["S1", "S2", "S3", "S4"];
  // A fenced sweep cannot include the host-only scenarios (fs.watch on a bind
  // mount; the image installs the CLI globally, so the no-CLI condition cannot
  // exist). Drop them by NAME rather than refusing the whole sweep — but never
  // silently: a skipped scenario that reads as "covered" is the failure this
  // harness keeps finding in itself.
  if (argv.includes("--all") && containerMode) {
    // `requiresSeedEnvOff` is host-only too (Plan 78 finding 2): it deletes the
    // `.env` — which is exactly the file container mode rewrites to the
    // in-network host — so the blind agent sees the host-side 127.0.0.1:<port>
    // from the manifest, which does not resolve inside the fence. The stage
    // already warns about it, but only AFTER the unit has been booted and spent.
    const hostOnly = ids.filter((id) => { const s = loadScenario(id); return s.unsandboxedOnly === true || s.requiresNoCli === true || s.requiresNested === true || s.requiresSeedEnvOff === true || (typeof s.preHook === "string" && OUTSIDE_SYNC_DIR_HOOKS.has(s.preHook)); });
    if (hostOnly.length > 0) {
      console.log(`--container: ${hostOnly.join(", ")} are host-only and are NOT part of this sweep — run them separately:\n    node test/field-test/run.mts --isolate ${hostOnly.join(" ")}\n`);
      ids = ids.filter((id) => !hostOnly.includes(id));
    }
  }
  const units = groupScenarios(ids);
  // `--model` must reach the child that actually spawns claude; `--n8n-tag` must
  // reach the STAGE instead (below). A flag that silently fails to cross the
  // re-exec would produce a sweep labelled as varying something it never varied.
  const passthrough = [
    ...argv.filter((a) => a === "--dry-run" || a === "--container"),
    ...(argv.includes("--model") ? ["--model", MODEL] : []),
  ];
  // One `stage.mts --list-packs` for the whole sweep; the packs cannot change
  // mid-run, and a per-unit call would just re-read the same files.
  const packs = JSON.parse((await execFile(process.execPath, [path.join(HERE, "stage.mts"), "--list-packs"], { encoding: "utf8" })).stdout) as Record<string, string[]>;
  const packOf = new Map(units.map((u) => [u.join("+"), SEED_PACK_ARG ?? packFor(u, packs)]));
  console.log(`isolating ${ids.length} scenario(s) into ${units.length} unit(s): ${units.map((u) => `${u.join("+")} [${packOf.get(u.join("+"))}]`).join(", ")}`);
  // Say what this sweep varies, before it runs. A round is only comparable to
  // another if you can tell which world it ran in, and the two knobs that define
  // that world are exactly these.
  console.log(`  model ${MODEL} · n8n ${N8N_TAG_ARG ?? process.env.FIELD_N8N_TAG ?? "n8nio/n8n:2.30.7 (default)"}`);
  // `--isolate --dry-run` prints the PLAN and boots nothing. Passing --dry-run
  // through to the children would still stage an instance per unit — thirteen
  // container boots to answer "what would you run?" (Plan 77).
  if (dryRun) {
    for (const [i, unit] of units.entries()) {
      const scns = unit.map((id) => loadScenario(id));
      const turns = scns.reduce((n, s) => n + s.turns.length, 0);
      const notes = [
        scns.some((s) => s.unsandboxedOnly) ? "host-only" : "",
        scns.some((s) => s.requiresNoCli) ? "needs FIELD_NO_CLI=1" : "",
        scns.some((s) => s.requiresNested) ? "needs FIELD_NESTED=1" : "",
        scns.some((s) => s.requiresSeedEnvOff) ? "needs FIELD_NO_SEED_ENV=1" : "",
        ...scns.flatMap((s) => (s.preHook ? [`preHook ${s.preHook}`] : [])),
      ].filter((n) => n !== "");
      console.log(`  ${String(i + 1).padStart(2)}. ${unit.join("+").padEnd(8)} seeds ${packOf.get(unit.join("+"))!.padEnd(10)} ${turns} turn(s)${notes.length ? `  — ${notes.join(", ")}` : ""}`);
    }
    console.log(`\ndry run: nothing staged, nothing spent. Drop --dry-run to execute.`);
    process.exit(0);
  }
  // Credential pre-flight — ONCE, before the first stage (Plan 78 finding 4).
  //
  // `containerSetup` checks this per unit, after that unit has already booted an
  // n8n. A sweep with no credential therefore boots and tears down one instance
  // per unit to print the same message that many times — nine, the first time
  // this was run. And the repo's own worktree rule steers you straight into it:
  // `.env` is gitignored, so a fresh worktree never has one. Same contract as the
  // scenario-prerequisite gate: unmet means nothing is spent.
  if (containerMode) {
    const cred = readEnvFile(ENV_FILE);
    const has = (n: string) => ((cred[n] ?? process.env[n] ?? "").trim() !== "");
    if (!has("CLAUDE_CODE_OAUTH_TOKEN") && !has("ANTHROPIC_API_KEY")) {
      console.error(
        `--container needs a credential — nothing was spent:\n` +
          `  no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in ${ENV_FILE}\n` +
          `  that file is GITIGNORED, so a fresh worktree never has one — copy it across, or:\n` +
          `    cp test/field-test/.env.example test/field-test/.env   # then set ONE credential`,
      );
      process.exit(2);
    }
  }
  let failed = 0;
  for (const [i, unit] of units.entries()) {
    const pack = packOf.get(unit.join("+"))!;
    // Stage SHAPE is per-unit too (Plan 77). S6 needs FIELD_NO_CLI=1 and S14
    // FIELD_NO_SEED_ENV=1 — as global env vars they would either be missing (the
    // prerequisite gate refuses the scenario) or applied to every other unit,
    // which is worse. `--isolate` stages per unit, so derive them from the
    // scenario's own declaration and set them for that one stage.
    const shape = unit.map((id) => loadScenario(id));
    const stageEnv: NodeJS.ProcessEnv = { ...process.env };
    if (shape.some((s) => s.requiresNoCli)) stageEnv.FIELD_NO_CLI = "1";
    if (shape.some((s) => s.requiresNested)) stageEnv.FIELD_NESTED = "1";
    if (shape.some((s) => s.requiresSeedEnvOff)) stageEnv.FIELD_NO_SEED_ENV = "1";
    const shapeNote = [stageEnv.FIELD_NO_CLI ? "FIELD_NO_CLI=1" : "", stageEnv.FIELD_NO_SEED_ENV ? "FIELD_NO_SEED_ENV=1" : ""].filter((s) => s !== "").join(" ");
    console.log(`\n===== unit ${i + 1}/${units.length}: ${unit.join(" ")} — staging a fresh instance (seeds: ${pack}${shapeNote ? `, ${shapeNote}` : ""}) =====`);
    const stageArgs = ["--seeds", pack, ...(N8N_TAG_ARG ? ["--n8n-tag", N8N_TAG_ARG] : [])];
    const staged = await execFile(process.execPath, [path.join(HERE, "stage.mts"), ...stageArgs], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: stageEnv });
    const mf = (staged.stdout.match(/^MANIFEST=(.+)$/m) ?? [])[1];
    if (mf === undefined) { console.error(`unit ${unit.join("+")}: stage printed no MANIFEST= line`); failed++; continue; }
    console.log(`  stage ${mf}`);
    try {
      const { stdout, stderr } = await execFile(process.execPath, [path.join(HERE, "run.mts"), mf, ...unit, ...passthrough], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      console.log(stdout + stderr);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      console.log((e.stdout ?? "") + (e.stderr ?? ""));
      // One readable line, not a Node stack per unit. A child that dies before its
      // turns prints its own `throw` trace into the captured stdout above; what
      // the operator needs on top of that is which unit and what it said.
      const why = ((e.stderr ?? "").match(/^Error: (.+)$/m) ?? [])[1];
      console.error(`unit ${unit.join("+")} exited non-zero${why ? ` — ${why}` : ""}`);
      failed++;
    } finally {
      // Tear down even when the unit failed: the archive is already written into
      // the repo, and a leaked container would poison the next unit's ports.
      await execFile(process.execPath, [path.join(HERE, "stage.mts"), "--down", mf], { encoding: "utf8" }).catch(() => {});
      console.log(`  torn down ${mf}`);
    }
  }
  console.log(`\n=== isolated run: ${units.length - failed}/${units.length} unit(s) completed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
if (!manifestPath) { console.error("run: pass <manifest.json> or set FIELD_MANIFEST"); process.exit(2); }
const scenarioIds = positional.slice(1).length ? positional.slice(1) : ["S1", "S2", "S3", "S4"];

interface Manifest { createdAt?: string; host: string; container: string | null; mcpToken: string; apiKey: string; ownerCookie?: string; workDir: string; launchDir?: string; nested?: boolean; harnessRoot: string; root: string; allowExtension: string[]; cliTarball: string | null; decanterSpec: string | null; noCli?: boolean; seedEnv?: boolean; seedPack?: string; seeded: Array<{ id: string; name: string; kind: string; availableInMCP: boolean }>; }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const WORKDIR = manifest.workDir;
// Where the blind session STARTS. Equal to the sync dir in every ordinary
// round; one level above it under FIELD_NESTED=1 (Plan 82), which is the whole
// point of that condition — an agent launched here loads neither the sync dir's
// `.mcp.json` (agents merge that from ANCESTORS of the launch dir, never from a
// dir below) nor its `.claude/settings.json` (launch-dir only). Older manifests
// carry no launchDir, so fall back to the sync dir and behave exactly as before.
const LAUNCHDIR = manifest.launchDir ?? manifest.workDir;
const NESTED = manifest.nested === true;
const HARNESS = manifest.harnessRoot;
const GUARD_LOG = path.join(HARNESS, "guard.log");

// container-mode constants
const DOCKER_DIR = path.join(HERE, "docker");
const COMPOSE = path.join(DOCKER_DIR, "docker-compose.yml");
const INTERNAL_NET = "decanter-fieldtest_internal"; // compose project + network
const RUN_BUDGET_MS = Math.max(1, Number(process.env.FIELD_RUN_BUDGET_MIN ?? 60)) * 60_000;
/** FIELD_* vars compose interpolates on EVERY subcommand — set by containerSetup. */
let composeEnv: Record<string, string> = {};
/**
 * Seed the sync dir's node_modules IN THE IMAGE, so nothing ever needs
 * `npm install` inside the fence (the npm registry is unreachable there) and the
 * volume — which Docker initializes from this path — is agent-owned. Round-2 S1
 * hit `EACCES … /work/node_modules/@esbuild` and spent turns fixing OUR bug.
 * A Linux n8n-decanter goes where `npm run <script>` looks first; typescript
 * where the CLI's typecheck resolver looks.
 */
const SEED_NODE_MODULES = [
  "RUN mkdir -p /work/node_modules/.bin \\",
  ' && ln -sf "$(command -v n8n-decanter)" /work/node_modules/.bin/n8n-decanter \\',
  " && ln -sf /usr/local/lib/node_modules/typescript /work/node_modules/typescript \\",
  " && chown -R agent:agent /work",
].join("\n");

// ---------- scenario parsing ----------
interface Scenario { id: string; turns: string[]; verifyWorkflows: string | string[]; preHook?: string; optional?: boolean; unsandboxedOnly?: boolean; persona?: string; requires?: string[]; requiresNoCli?: boolean; requiresNested?: boolean; requiresSeedEnvOff?: boolean; requiresSeedKinds?: string[]; readOnly?: boolean }

/**
 * Which workflow the `remote-drift` preHook edits — kept in one place so the
 * hook and the verifier can't disagree about the target.
 */
function driftTargetId(): string | undefined {
  const t = manifest.seeded.find((s) => s.kind === "s1-skeleton" && s.availableInMCP) ?? manifest.seeded.find((s) => s.availableInMCP);
  return t?.id;
}

/**
 * Resolve a scenario's `verifyWorkflows` to the workflow ids verify should check.
 *
 * This field was declared in every scenario spine and **never read** — run.mts
 * invoked verify with no ids, so every scenario verified every workflow. That is
 * why S4 reported S3's deliberately-injected drift as its own failure.
 *
 * `"all"` keeps the old behaviour (pass nothing → verify discovers everything).
 * An array selects by manifest `kind`, plus the pseudo-kind `"created"` for any
 * workflow the AGENT made (present on the instance, absent from `seeded`) —
 * S2 builds one, and S4 then works on it, so neither can name it up front.
 */
function resolveVerifyScope(scn: Scenario): string[] {
  if (!Array.isArray(scn.verifyWorkflows)) return [];
  const ids: string[] = [];
  for (const sel of scn.verifyWorkflows) {
    if (sel === "created") continue; // resolved below, by exclusion
    for (const s of manifest.seeded) if (s.kind === sel) ids.push(s.id);
  }
  if (scn.verifyWorkflows.includes("created")) {
    const seeded = new Set(manifest.seeded.map((s) => s.id));
    for (const slug of trackedWorkflowIds()) if (!seeded.has(slug)) ids.push(slug);
  }
  return [...new Set(ids)];
}

/** Workflow ids of every folder decanter currently tracks in the scratch dir. */
function trackedWorkflowIds(): string[] {
  const root = path.join(WORKDIR, manifest.root);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const st = JSON.parse(readFileSync(path.join(root, entry.name, ".decanter.json"), "utf8")) as { workflowId?: string };
      if (st.workflowId) out.push(st.workflowId);
    } catch { /* not a tracked folder */ }
  }
  return out;
}
function loadScenario(id: string): Scenario {
  const file = path.join(SCENARIO_DIR, `${id}.md`);
  const md = readFileSync(file, "utf8");
  const m = md.match(/##\s*Orchestration[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${id}.md has no \`\`\`json Orchestration block`);
  return JSON.parse(m[1]) as Scenario;
}

/**
 * Refuse a scenario subset whose prerequisites are missing — BEFORE spending.
 *
 * Some scenarios act on state an earlier one built: S4 opens with "let's tidy
 * *the orders workflow* … the step that tags high value", which is the workflow
 * **S2 creates**. A full S1–S4 round satisfies that implicitly, so the coupling
 * stayed invisible until someone ran a subset.
 *
 * Run `S4` alone and the round is not merely wrong, it is wrong in the most
 * expensive way: the agent hunts for a workflow that does not exist, never
 * pulls, and `verify.mts` reports "no tracked workflow folders" — a FAIL that
 * reads like a product defect but is an operator error. That happened
 * (ftrun-93355, $0.70 burned for zero signal).
 *
 * So: declare the dependency in the scenario spine and check it here. Refusing
 * beats silently auto-including the prerequisite, which would double the spend
 * without asking.
 */
/**
 * A PATH with no AMBIENT `n8n-decanter`: everything else still resolves.
 *
 * Naively dropping each PATH entry that carries the binary is wrong — a global
 * install lives in the same bin dir as `node`/`npm`/`npx` (nvm, brew), so
 * dropping it would leave the blind session with no Node at all. Instead each
 * offending dir is replaced by a shadow dir of symlinks to everything in it
 * *except* `n8n-decanter`, so only the CLI disappears.
 *
 * Why this must exist: a maintainer machine commonly has a global install
 * (`npm link` from this repo). Inherited, it would sit on the session's PATH
 * and silently defeat the entire condition — the round would "measure" an agent
 * that could run the CLI all along.
 *
 * **Every host-mode round needs this, not just the noCli one** (S16 round 1,
 * ftrun-441347). Ordinary rounds used to only PREPEND the staged
 * `node_modules/.bin`, which `npx` does not honour: the agent typed
 * `npx n8n-decanter …`, npx resolved the machine-global install, and the round
 * graded the PUBLISHED CLI instead of the packed build under test — invisibly,
 * because both answer to the same version number. The stage packs our build
 * precisely so a round measures this working copy; the PATH has to agree.
 */
function sanitizedPath(inputPath: string, label = "noCli"): { PATH: string; npmPrefix: string } {
  const shadowRoot = path.join(HARNESS, "nocli-path");
  const out: string[] = [];
  const narrated = new Set<string>();
  let shadowed = 0;
  for (const [i, dir] of inputPath.split(path.delimiter).entries()) {
    if (dir === "" || !existsSync(path.join(dir, "n8n-decanter"))) {
      out.push(dir);
      continue;
    }
    const shadow = path.join(shadowRoot, String(i));
    mkdirSync(shadow, { recursive: true });
    for (const entry of readdirSync(dir)) {
      if (entry === "n8n-decanter") continue;
      const link = path.join(shadow, entry);
      if (!existsSync(link)) {
        try {
          symlinkSync(path.join(dir, entry), link);
        } catch { /* unreadable/duplicate entry — skipping it only narrows PATH */ }
      }
    }
    out.push(shadow);
    shadowed++;
    // A dir can appear in PATH several times (this machine lists its node bin
    // five times); each copy needs its own shadow, but narrating each one turns
    // one fact into five lines.
    if (!narrated.has(dir)) {
      narrated.add(dir);
      console.log(`  [${label}] shadowed ${dir} (every command except n8n-decanter still resolves)`);
    }
  }
  if (shadowed === 0) console.log(`  [${label}] no ambient n8n-decanter on PATH — nothing to shadow`);

  // Shadowing PATH is not enough on its own: `npx` re-resolves its OWN node bin
  // dir (through the symlink) and finds machine-global installs there anyway —
  // verified, `npx --no-install n8n-decanter` still succeeded. Pointing npm at
  // an EMPTY prefix hides them. Its `bin/` goes on PATH so the agent's own
  // `npm i -g` would still work: we remove the pre-existing install, we do not
  // block the recovery paths a real user has.
  const npmPrefix = path.join(HARNESS, "nocli-npm-prefix");
  mkdirSync(path.join(npmPrefix, "bin"), { recursive: true });
  mkdirSync(path.join(npmPrefix, "lib", "node_modules"), { recursive: true });
  return { PATH: `${out.join(path.delimiter)}${path.delimiter}${path.join(npmPrefix, "bin")}`, npmPrefix };
}

/**
 * The CLI environment a host-mode blind session runs with — one definition, so
 * the pre-flight probe cannot drift from what the turns actually get.
 */
let hostCliEnvCache: { PATH: string; extraEnv: Record<string, string> } | undefined;
function hostCliEnv(): { PATH: string; extraEnv: Record<string, string> } {
  // Memoized: it builds shadow dirs and a prefix on disk and narrates what it
  // shadowed, and it is asked for once per turn plus once by the pre-flight
  // probe. Recomputing would repeat the work and, worse, repeat the log lines
  // until the policy they describe reads like a per-turn event.
  if (hostCliEnvCache !== undefined) return hostCliEnvCache;
  const localBin = path.join(WORKDIR, "node_modules", ".bin");
  const inherited = process.env.PATH ?? "";
  const extraEnv: Record<string, string> = {};
  if (manifest.noCli === true || process.env.FIELD_NO_PATH_HELP === "1") {
    const sane = sanitizedPath(inherited);
    extraEnv.npm_config_prefix = sane.npmPrefix;
    hostCliEnvCache = { PATH: sane.PATH, extraEnv };
    return hostCliEnvCache;
  }
  // Make BOTH ways of reaching the CLI land on the staged build. Prepending
  // `node_modules/.bin` only fixes the bare name: `npx` does not consult PATH,
  // so from a dir that does not carry the package it fell through to the
  // machine's global install (see stagedGlobalPrefix). Shadowing removes that
  // ambient copy; the staged prefix then answers npm's own lookup before its
  // cache or the registry can.
  const sane = sanitizedPath(inherited, "staged-cli");
  const stagedPrefix = stagedGlobalPrefix();
  extraEnv.npm_config_prefix = stagedPrefix ?? sane.npmPrefix;
  const PATH = [stagedPrefix ? path.join(stagedPrefix, "bin") : "", localBin, sane.PATH].filter(Boolean).join(path.delimiter);
  hostCliEnvCache = { PATH, extraEnv };
  return hostCliEnvCache;
}

/**
 * A harness-owned npm PREFIX whose "global install" is this round's staged CLI.
 *
 * Shadowing the ambient install is necessary but NOT sufficient: `npx` does not
 * consult PATH the way a shell does. From a directory that does not itself
 * carry the package — the launch dir of a FIELD_NESTED round, say — `npx
 * n8n-decanter …` walks its own resolution instead, and lands on the machine's
 * global install, then on its `_npx` cache, and finally on the REGISTRY. All
 * three are the published CLI, which answers `--version` with the same number
 * as the packed build the stage installed, so nothing in a transcript gives the
 * substitution away. S16 round 1 (ftrun-441347) was graded that way: every
 * `npx n8n-decanter` call in it ran published code, and the round therefore said
 * nothing about the working copy it was supposed to measure.
 *
 * Pointing npm at a prefix that already contains the staged build ends the hunt
 * before the cache or the registry are ever reached — verified against the same
 * stage: with it, `npx n8n-decanter` from the repo root runs the staged build.
 * The prefix is symlinks, not a second install: no packing, no network.
 */
function stagedGlobalPrefix(): string | null {
  const pkg = path.join(WORKDIR, "node_modules", "n8n-decanter");
  const bin = path.join(WORKDIR, "node_modules", ".bin", "n8n-decanter");
  if (!existsSync(pkg) || !existsSync(bin)) return null; // nothing staged (noCli, or a stage that skipped the install)
  const prefix = path.join(HARNESS, "staged-npm-prefix");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  try {
    symlinkSync(pkg, path.join(prefix, "lib", "node_modules", "n8n-decanter"));
    symlinkSync(bin, path.join(prefix, "bin", "n8n-decanter"));
  } catch { return null; }
  return prefix;
}

/**
 * Prove the round will grade the STAGED build — before a single token is spent.
 *
 * The failure this catches is silent by construction (same version number, same
 * command name, different code), so it cannot be left to inspection. The check
 * is a comparison, not a version match: run `help` through the staged bin
 * directly and through `npx` from the launch dir, and require identical output.
 * Two different builds of a CLI whose help text is part of its user surface
 * cannot agree by accident; two invocations of the same file cannot disagree.
 */
function stagedCliMismatch(env: NodeJS.ProcessEnv): string | null {
  const bin = path.join(WORKDIR, "node_modules", ".bin", "n8n-decanter");
  if (!existsSync(bin)) return null;
  const run = (cmd: string, args: string[]): string | null => {
    try {
      return execFileSync(cmd, args, { cwd: LAUNCHDIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { return null; }
  };
  const staged = run(bin, ["help"]);
  const viaNpx = run("npx", ["n8n-decanter", "help"]);
  if (staged === null || viaNpx === null) return null; // cannot tell — do not block the round on a probe failure
  if (staged.trim() === viaNpx.trim()) return null;
  return `\`npx n8n-decanter\` in ${LAUNCHDIR} does not resolve to the staged build — the round would grade a DIFFERENT CLI (published/global/_npx-cached) while reporting on this working copy. Check the ambient install and the npm prefix.`;
}

/**
 * Partition scenarios into the units that may legitimately share one stage.
 *
 * The unit is a scenario **plus its declared `requires` chain** — S4 opens on
 * "the orders workflow", which is the one S2 creates, so those two must see the
 * same instance. Everything else must not: a shared stage lets one scenario
 * shape the world the next one is graded in.
 */
function groupScenarios(ids: string[]): string[][] {
  const groups: string[][] = [];
  for (const id of ids) {
    const needs = new Set(loadScenario(id).requires ?? []);
    const joined = groups.find((g) => g.some((other) => needs.has(other)));
    if (joined) joined.push(id);
    else groups.push([id]);
  }
  return groups;
}

/**
 * Refuse to run independent scenarios against ONE stage (maintainer's call,
 * 2026-08-05) — the harness now enforces isolation instead of documenting it.
 *
 * This is not hypothetical tidiness. Round `ftrun-29773` ran S13 after S11 in the
 * same workDir, and S13's agent opened with "there is no contact cleanup
 * workflow locally; this repo only tracks weekly-digest-roll-up" — S11's pull had
 * shaped what S13 measured, and the resulting FAIL read like a product defect.
 * A round is expensive; a contaminated one is expensive AND misleading.
 */
function assertIsolation(ids: string[]): void {
  const groups = groupScenarios(ids);
  if (groups.length <= 1) return;
  console.error("scenarios must not share a stage — nothing was spent:");
  console.error(`  requested: ${ids.join(", ")} → ${groups.length} independent units: ${groups.map((g) => g.join("+")).join(", ")}`);
  console.error("  a shared instance and workDir let one scenario shape the world the next is graded in");
  console.error("\n  run them isolated (a fresh instance per unit, torn down after):");
  console.error(`    node test/field-test/run.mts --isolate ${SEED_PACK_ARG ? `--seeds ${SEED_PACK_ARG} ` : ""}${ids.join(" ")}`);
  console.error("  …or drive one unit at a time against its own stage.");
  process.exit(2);
}

function assertPrerequisites(ids: string[]): void {
  const problems: string[] = [];
  ids.forEach((id, i) => {
    const earlier = new Set(ids.slice(0, i));
    const sc = loadScenario(id);
    for (const need of sc.requires ?? []) {
      if (!earlier.has(need)) problems.push(`${id} requires ${need} to run first (it acts on state ${need} creates)`);
    }
    // A stage-shape precondition, not an ordering one: S6 measures what an agent
    // does when the CLI is NOT runnable. Against an ordinary stage the CLI is
    // installed, so the scenario would quietly measure nothing — the worst
    // outcome for an expensive round. Refuse instead.
    if (sc.requiresNoCli === true && manifest.noCli !== true) {
      problems.push(`${id} needs a stage created with FIELD_NO_CLI=1 (this manifest has noCli=${JSON.stringify(manifest.noCli)}); against a normal stage it would measure nothing`);
    }
    // Container mode bakes the CLI into the fenced image as a GLOBAL install, so
    // it is on PATH no matter what the workDir looks like — the no-CLI condition
    // cannot exist there. Host mode only.
    if (sc.requiresNoCli === true && containerMode) {
      problems.push(`${id} cannot run in --container mode: the image installs the CLI globally, so it stays on PATH and the no-CLI condition cannot be staged. Run it host-mode (unsandboxed).`);
    }
    // Same shape, other direction: the hook stages ABOVE the sync dir, and the
    // fence mounts only the sync dir. Refuse rather than let the agent report
    // the planted file as nonexistent — which is what it is, in there.
    if (typeof sc.preHook === "string" && OUTSIDE_SYNC_DIR_HOOKS.has(sc.preHook) && containerMode) {
      problems.push(`${id} cannot run in --container mode: its pre-hook "${sc.preHook}" stages a path outside the sync dir, and the fenced container mounts the sync dir only — the condition would be invisible to the agent. Run it host-mode (unsandboxed).`);
    }
    // Same shape again (Plan 82): S16 measures what an agent does when the
    // wiring sits BELOW where it was started. Against a flat stage the sync dir
    // IS the launch dir, the wiring loads, and the scenario measures the world
    // that never had the problem — green, and worthless.
    if (sc.requiresNested === true && manifest.nested !== true) {
      problems.push(`${id} needs a stage created with FIELD_NESTED=1 (this manifest has nested=${JSON.stringify(manifest.nested)}); against a flat stage the sync dir is the launch dir and the condition does not exist`);
    }
    // Host-only for the same reason as requiresNoCli: the container mounts the
    // sync dir at /work and starts there, so there is no dir above it to launch
    // from — the nesting cannot be staged inside the fence.
    if (sc.requiresNested === true && containerMode) {
      problems.push(`${id} cannot run in --container mode: the fence mounts the sync dir and starts there, so no launch dir above it exists. Run it host-mode (unsandboxed).`);
    }
    // Same argument as requiresNoCli: a cold-start scenario against a stage that
    // pre-seeded `.env` measures nothing at all — `init` would just reuse the
    // credentials and the whole condition evaporates (Plan 62 task 2).
    if (sc.requiresSeedEnvOff === true && manifest.seedEnv !== false) {
      problems.push(`${id} needs a stage created with FIELD_NO_SEED_ENV=1 (this manifest has seedEnv=${JSON.stringify(manifest.seedEnv)}); with a pre-seeded .env there is no cold start to measure`);
    }
    // …and check the WORLD, not just the flag. seedEnv=false only records that the
    // pre-seed was skipped; `init` used to write its own .env right afterwards, so
    // a whole S14 round graded a fully configured project while the manifest said
    // the condition was staged. The flag can lie; the file cannot.
    if (sc.requiresSeedEnvOff === true) {
      // Check the sync dir AND, when they differ, the launch dir: a credential
      // sitting where the agent actually stands is a worse leak, not a lesser one.
      for (const dir of new Set([manifest.workDir, LAUNCHDIR])) {
        const leaked = [".env", ".decanter-auth.json"].filter((f) => existsSync(path.join(dir, f)));
        if (leaked.length) problems.push(`${id} needs no credentials in ${dir}, but ${leaked.join(" + ")} exist(s) there; the cold start is not staged`);
      }
    }
    // A scenario may declare a pre-hook before the hook exists (Plan 61 writes
    // the scenario specs ahead of the staging machinery). Refuse rather than
    // run the turns against an environment nothing was done to.
    if (sc.preHook !== undefined && !(sc.preHook in PRE_HOOKS)) {
      problems.push(`${id} declares preHook "${sc.preHook}", which run.mts does not implement (known: ${Object.keys(PRE_HOOKS).join(", ")}); without it the scenario would run against an untouched environment and measure nothing`);
    }
    // Same argument, one layer down: the seeds a scenario acts on. `builtin`
    // stages four workflows; a scenario written for a seed pack that was not
    // staged would hunt for a workflow that does not exist (the ftrun-93355
    // failure mode, generalised from ordering to stage shape).
    for (const kind of sc.requiresSeedKinds ?? []) {
      if (!manifest.seeded.some((s) => s.kind === kind)) {
        problems.push(`${id} needs a seeded workflow of kind "${kind}"; this stage seeded ${manifest.seeded.map((s) => s.kind).join(", ") || "(nothing)"}`);
      }
    }
  });
  // A stage is single-use. `groupScenarios` already keeps two scenarios from
  // sharing one, for the reason spelled out there — one scenario shapes the
  // world the next is graded in — but nothing stopped the same scenario from
  // being re-run against a stage it had already finished. That is worse, not
  // milder: the second agent arrives to find the task DONE (file written,
  // pushed, committed), reads the tidy world, touches nothing, and the round
  // reports a clean verify PASS having measured an agent that had nothing to
  // do. Exactly that happened re-running S16 to re-measure it against fixed
  // code. Re-stage instead; FIELD_REUSE_STAGE=1 is the deliberate override.
  if (!dryRun && process.env.FIELD_REUSE_STAGE !== "1") {
    const used = ids.filter((id) => existsSync(path.join(HARNESS, `verify-${id}.json`)) || existsSync(path.join(HARNESS, "transcripts", id)));
    if (used.length > 0) {
      problems.push(`this stage has already run ${used.join(", ")} — its instance and workDir carry that round's work, so a re-run would grade an agent arriving at finished work. Stage a fresh one (node test/field-test/stage.mts), or set FIELD_REUSE_STAGE=1 if you truly mean to continue on top of it.`);
    }
  }
  // Stage-shape checks answer "is the WORLD right?"; this one answers "is the
  // CODE right?" — whether the CLI the agent will reach is actually the build
  // this working copy staged. It is last because it costs a subprocess, and it
  // is here at all because getting it wrong is invisible: S16 round 1 reported
  // a clean PASS on published code.
  if (!containerMode && manifest.noCli !== true && process.env.FIELD_NO_PATH_HELP !== "1") {
    const { PATH, extraEnv } = hostCliEnv();
    const mismatch = stagedCliMismatch({ ...process.env, PATH, ...extraEnv });
    if (mismatch !== null) problems.push(mismatch);
  }
  if (problems.length === 0) return;
  const suggested = [...new Set(ids.flatMap((id) => [...(loadScenario(id).requires ?? []), id]))];
  // plain message + exit 2, like the other preconditions — a stack trace here
  // would bury the one line that tells the operator what to run instead
  console.error("scenario prerequisites unmet — nothing was spent:");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`try: node test/field-test/run.mts <manifest> ${suggested.join(" ")}`);
  process.exit(2);
}

// Non-secret placeholders — safe to log / dry-run print / store in the turns
// array. The credential placeholders stay UNfilled here so no log path ever
// emits them in clear text.
function fillPublic(text: string): string {
  const oldFlow = manifest.seeded.find((s) => s.kind === "s4-archive-target")?.name ?? "Old contact import";
  return text
    .replaceAll("{{HOST}}", manifest.host)
    // Scheme-LESS host:port. `{{HOST}}` hands over a complete URL, which silently
    // removes the choice the #142 bug was about (init writing https:// for a local
    // http instance) — S14's first valid round claimed to watch for it and could
    // not have seen it. A bare host makes the agent pick the scheme.
    .replaceAll("{{HOST_BARE}}", manifest.host.replace(/^https?:\/\//, ""))
    .replaceAll("{{OLD_FLOW_NAME}}", oldFlow);
}
// Credential placeholders — substituted ONLY at the moment of spawning claude,
// on a string that is never logged or stored (avoids clear-text-logging of the
// MCP token / API key that the S1 prompt carries).
function fillSecrets(text: string): string {
  return text.replaceAll("{{MCP_TOKEN}}", manifest.mcpToken).replaceAll("{{API_KEY}}", manifest.apiKey || "(none — skip it)");
}

// ---------- the one credential that crosses the fence ----------
/** Minimal KEY=VALUE reader for the harness `.env` (no deps; ignores comments). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Choose the single auth credential passed into the fenced container.
 *
 * Two accepted shapes, both plain env vars — which is what keeps the isolation
 * contract intact: no mounted credential store, no browser inside the fence.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude subscription token (`claude
 *     setup-token`). Costs quota from your 5-hour windows instead of dollars.
 *   - `ANTHROPIC_API_KEY` — pay-per-token API billing. Scope it with a LOW
 *     spend cap; that cap is a backstop a subscription token does NOT have,
 *     so with a token `FIELD_RUN_BUDGET_MIN` is the only limit left.
 *
 * Exactly ONE is exported, never both and never an empty one: an empty
 * `ANTHROPIC_API_KEY` in the container is worse than an absent one, because the
 * CLI would try to use it. The token wins when both are present.
 */
function credentialEnv(): { env: Record<string, string>; described: string } {
  const file = readEnvFile(ENV_FILE);
  const pick = (name: string) => (file[name] ?? process.env[name] ?? "").trim();
  const token = pick("CLAUDE_CODE_OAUTH_TOKEN");
  const key = pick("ANTHROPIC_API_KEY");
  if (token) {
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, described: `subscription token${key ? " (ANTHROPIC_API_KEY also set — ignored)" : ""} — billed as quota, no spend cap; FIELD_RUN_BUDGET_MIN is the limit` };
  }
  if (key) return { env: { ANTHROPIC_API_KEY: key }, described: "API key — pay-per-token" };
  throw new Error(`--container needs a credential in ${ENV_FILE}: CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or ANTHROPIC_API_KEY (cp test/field-test/.env.example test/field-test/.env)`);
}

// ---------- container-mode orchestration (Plan 35: fenced, unattended) ----------
/** `docker compose` with the fixed -f/--env-file + the interpolation env. */
async function dockerCompose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile("docker", ["compose", "-f", COMPOSE, "--env-file", ENV_FILE, ...args], { env: { ...process.env, ...composeEnv }, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Build the fenced images, bake the CLI in (build-time — the runtime fence has
 * no npm), bring up proxy+agent, rewrite the workDir `.env` to reach n8n by its
 * in-network name, and join the staged n8n to the internal net. Arms a total
 * wall-clock kill so an unattended round can't run (or bill) forever.
 */
async function containerSetup(): Promise<void> {
  if (!manifest.container) throw new Error("--container needs a Docker-booted n8n (manifest.container is null — external/FIELD_N8N_URL mode is host-only)");
  const cred = credentialEnv(); // throws with the fix-it message when neither is set
  console.log(`container mode: auth = ${cred.described}`);
  if (!manifest.cliTarball && !manifest.decanterSpec) throw new Error("no CLI to bake — manifest.cliTarball and decanterSpec are both null (re-stage)");

  console.log("container mode: building fenced images (unfenced build) …");
  await execFile("docker", ["build", "-t", "decanter-fieldtest-proxy", "-f", path.join(DOCKER_DIR, "Dockerfile.proxy"), DOCKER_DIR]);
  await execFile("docker", ["build", "-t", "decanter-fieldtest-agent", "-f", path.join(DOCKER_DIR, "Dockerfile.agent"), DOCKER_DIR]);
  // bake the decanter CLI into a per-run image FROM the base
  let bakeStep: string;
  if (manifest.cliTarball) {
    copyFileSync(manifest.cliTarball, path.join(DOCKER_DIR, "cli.tgz"));
    bakeStep = `USER root\nCOPY cli.tgz /tmp/cli.tgz\nRUN npm install -g --no-audit --no-fund /tmp/cli.tgz && n8n-decanter --help >/dev/null\n${SEED_NODE_MODULES}\nUSER agent`;
  } else {
    bakeStep = `USER root\nRUN npm install -g --no-audit --no-fund ${manifest.decanterSpec} && n8n-decanter --help >/dev/null\n${SEED_NODE_MODULES}\nUSER agent`;
  }
  const AGENT_IMAGE = "decanter-fieldtest-agent-run";
  writeFileSync(path.join(DOCKER_DIR, "Dockerfile.agent-baked"), `# generated by run.mts — bakes the decanter CLI into the fenced agent image\nFROM decanter-fieldtest-agent\n${bakeStep}\n`);
  await execFile("docker", ["build", "-t", AGENT_IMAGE, "-f", path.join(DOCKER_DIR, "Dockerfile.agent-baked"), DOCKER_DIR]);
  console.log(`  baked CLI into ${AGENT_IMAGE}`);

  composeEnv = {
    FIELD_AGENT_IMAGE: AGENT_IMAGE,
    FIELD_WORKDIR: WORKDIR,
    FIELD_HARNESS: HARNESS,
    // n8n (by container name) + loopback bypass the proxy — they're on the internal net
    FIELD_NO_PROXY: `${manifest.container},localhost,127.0.0.1`,
    // the chosen credential, exported to the compose child so the bare
    // pass-through entries in docker-compose.yml resolve deterministically
    // (rather than depending on --env-file semantics for un-valued names)
    ...cred.env,
  };

  // the agent reaches n8n by its container name on the internal net (the host's
  // published port stays manifest.host for host-side verify.mts)
  const inNet = `http://${manifest.container}:5678`;
  const envPath = path.join(WORKDIR, ".env");
  if (existsSync(envPath)) {
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace(/^N8N_HOST=.*$/m, `N8N_HOST=${inNet}`));
    console.log(`  rewrote .env N8N_HOST -> ${inNet}`);
  } else {
    console.warn(`  no ${envPath} — the agent's init must supply the in-network host (avoid FIELD_NO_SEED_ENV in container mode)`);
  }

  await dockerCompose(["up", "-d"]);
  await execFile("docker", ["network", "connect", INTERNAL_NET, manifest.container]).catch((e: Error) => {
    if (!/already |Error response.*already/i.test(e.message)) throw e; // idempotent re-connect
  });
  console.log(`  up: proxy + agent (fenced); n8n ${manifest.container} joined ${INTERNAL_NET}`);

  const kill = setTimeout(() => {
    console.error(`\n[harness] FIELD_RUN_BUDGET_MIN (${RUN_BUDGET_MS / 60000}m) exceeded — killing the run + tearing down`);
    void containerTeardown().finally(() => process.exit(2));
  }, RUN_BUDGET_MS);
  kill.unref();
}

async function containerTeardown(): Promise<void> {
  if (!containerMode || Object.keys(composeEnv).length === 0) return; // setup didn't run (dry-run / early failure)
  if (manifest.container) await execFile("docker", ["network", "disconnect", INTERNAL_NET, manifest.container]).catch(() => {});
  await dockerCompose(["down", "-v"]).catch(() => {});
  console.log("container mode: torn down (compose down -v)");
}

// ---------- post-init scaffolding tweaks (guard-log capture + allow extension) ----------
function applyPostInit(): void {
  // 1. merge allowExtension into the LOCAL settings layer — the harness's own
  //    (highest precedence). Never the template's settings.json: that is the
  //    project contract whose DENY rules (push --force, .decanter.json, .env)
  //    are under test, and deny wins over allow regardless of layer. Created
  //    when absent, so this holds whichever filename the template ships.
  // Under FIELD_NESTED the harness overrides must land at the LAUNCH dir:
  // `.claude/settings.local.json` is read from the canonical git root (which is
  // the app repo root there), and a copy left in the sync dir would simply not
  // be loaded — the round would then hit a permission prompt and die mid-turn.
  const settingsPath = path.join(LAUNCHDIR, ".claude", "settings.local.json");
  let s: { permissions?: { allow?: string[] } } = {};
  try {
    s = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof s;
  } catch { /* absent or unreadable — start fresh */ }
  s.permissions ??= {};
  s.permissions.allow = Array.from(new Set([...(s.permissions.allow ?? []), ...manifest.allowExtension]));
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  console.log(`  merged allowExtension into ${settingsPath}`);
  // 2. rewrite .mcp.json's n8n-instance command to capture the guard's stderr
  const mcpPath = path.join(WORKDIR, ".mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    const srv = mcp.mcpServers?.["n8n-instance"];
    // command is `npx --no-install n8n-decanter …` (Plan 58) or a bare
    // `n8n-decanter …` — rebuild the full argv either way, don't key on it.
    if (srv && typeof srv.command === "string") {
      // MUST be idempotent: this runs once per SCENARIO, against the same
      // workDir. Re-wrapping an already-wrapped command produced
      // `sh -c 'exec sh -c exec npx … 2>>log 2>>log'`, and `sh -c` takes only
      // its first word as the command — so that form runs the no-op `exec`
      // builtin and exits instantly. The guard then never started, and every
      // scenario after the FIRST ran with no `n8n-instance` tools at all,
      // silently: an empty guard.log reads exactly like "the guard blocked
      // nothing". S2/S3/S4 — whose whole subject is structure/lifecycle work
      // through the guard — were never actually exercising it.
      // So: peel every wrapper layer back to the pristine argv, then wrap once.
      let inner = [srv.command, ...(srv.args ?? [])].join(" ");
      for (let prev = ""; prev !== inner; ) {
        prev = inner;
        inner = inner.replace(/^sh\s+-c\s+/, "").replace(/^exec\s+/, "").replace(/(\s+2>>\S+)+$/, "");
      }
      // container mode redirects to the harnessRoot's bind-mount inside the agent
      // (/harness) so the guard stderr still lands in HARNESS on the host.
      const guardTarget = containerMode ? "/harness/guard.log" : GUARD_LOG;
      mcp.mcpServers["n8n-instance"] = { command: "sh", args: ["-c", `exec ${inner} 2>>${guardTarget}`] };
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
      console.log(`  rewired .mcp.json n8n-instance to capture stderr -> ${guardTarget}`);
    }
  } else {
    console.warn(`  WARN no .mcp.json after init (${mcpPath})`);
  }
  // 3. reproduce the pack's SessionStart routing cue (plain-skills installs have
  //    no SessionStart hook) by appending it to the init-scaffolded AGENTS.md
  const agentsPath = path.join(WORKDIR, "AGENTS.md");
  if (existsSync(agentsPath) && !readFileSync(agentsPath, "utf8").includes("using-n8n-skills-official")) {
    appendFileSync(agentsPath, SESSION_START_NUDGE);
    console.log("  appended the n8n-skills SessionStart cue to AGENTS.md");
  }
}

// ---------- pre-hooks (harness plays a second client) ----------
async function remoteDrift(): Promise<void> {
  // S3: a colleague edits a Code node's jsCode directly over raw MCP (guard-free).
  // Same lookup the verifier uses for --expect-drift, so the two cannot disagree.
  const targetId = driftTargetId();
  const target = manifest.seeded.find((s) => s.id === targetId);
  if (!target) { console.warn("  remote-drift: no available seeded workflow to edit"); return; }
  const { McpClient } = await import(new URL("../../lib/mcp.mts", import.meta.url).href);
  const client = new McpClient({ host: manifest.host, auth: { kind: "bearer", token: manifest.mcpToken }, requestTimeoutMs: 20_000 });
  const details = (await client.callTool("get_workflow_details", { workflowId: target.id })) as { workflow: { nodes: Array<{ name: string; type: string; parameters?: { jsCode?: string } }> } };
  const code = details.workflow.nodes.find((n) => n.type === "n8n-nodes-base.code" && typeof n.parameters?.jsCode === "string");
  if (!code) { console.warn("  remote-drift: target has no Code node"); return; }
  const edited = `// Sam was here\n${code.parameters!.jsCode}`;
  await client.callTool("update_workflow", { workflowId: target.id, operations: [{ type: "updateNodeParameters", nodeName: code.name, parameters: { jsCode: edited } }] });
  console.log(`  remote-drift: colleague edited "${code.name}" in "${target.name}" (${target.id}) over raw MCP`);
}

/**
 * Every pre-hook the harness knows how to play, by the name a scenario declares.
 *
 * The dispatch used to be a bare `if (scn.preHook === "remote-drift")`, which
 * meant any OTHER name — a typo, or a hook a scenario declares before it is
 * built — silently staged nothing. The round would then run the full turn
 * sequence against an intact environment and "measure" it: the most expensive
 * possible way to learn nothing (the same failure mode the prerequisite check
 * above exists to prevent). An unknown name is now refused before any spend.
 */
/** An MCP client with the HARNESS's credentials — deliberately guard-free. */
async function harnessMcp(): Promise<{ callTool: (name: string, args: Record<string, unknown>) => Promise<any> }> {
  const { McpClient } = await import(new URL("../../lib/mcp.mts", import.meta.url).href);
  return new McpClient({ host: manifest.host, auth: { kind: "bearer", token: manifest.mcpToken }, requestTimeoutMs: 60_000 });
}

/** Seeded workflow of a given manifest `kind` — the addressing every hook uses. */
function seedOfKind(kind: string): { id: string; name: string } {
  const s = manifest.seeded.find((x) => x.kind === kind);
  if (!s) throw new Error(`pre-hook needs a seeded workflow of kind "${kind}"; this stage has ${manifest.seeded.map((x) => x.kind).join(", ") || "none"}`);
  return s;
}

/**
 * n8n's INTERNAL /rest surface, with the owner cookie the stage captured.
 *
 * Undocumented and version-fragile (see AGENTS.md) — fine for breaking a
 * throwaway instance on purpose, which is all these hooks do. A stage that
 * never ran owner setup (`FIELD_N8N_URL` mode) has no cookie, so the hooks that
 * need one fail loudly instead of half-staging their condition.
 */
async function ownerRest(method: string, pathname: string, body?: unknown): Promise<Response> {
  const cookie = manifest.ownerCookie;
  if (!cookie) throw new Error(`this pre-hook drives n8n's internal /rest API and needs the stage's owner cookie; the manifest has none (FIELD_N8N_URL mode stages cannot break MCP access)`);
  return fetch(manifest.host + pathname, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function ownerRestOk(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await ownerRest(method, pathname, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

/** Replace one Code node's `jsCode` over raw MCP (guard-free), returning its name. */
async function editCodeOverMcp(workflowId: string, rewrite: (current: string, nodeName: string) => string): Promise<string> {
  const client = await harnessMcp();
  const details = await client.callTool("get_workflow_details", { workflowId }) as { workflow: { nodes: Array<{ name: string; type: string; parameters?: { jsCode?: string } }> } };
  const code = details.workflow.nodes.find((n) => n.type === "n8n-nodes-base.code" && typeof n.parameters?.jsCode === "string");
  if (!code) throw new Error(`workflow ${workflowId} has no Code node to edit`);
  await client.callTool("update_workflow", {
    workflowId,
    operations: [{ type: "updateNodeParameters", nodeName: code.name, parameters: { jsCode: rewrite(code.parameters!.jsCode!, code.name) } }],
  });
  return code.name;
}

/**
 * S8: give the round a capture with REAL provenance.
 *
 * `test_workflow` is the synchronous one (`execute_workflow` returns
 * `{status:"started"}` and has to be polled) and both persist a normal
 * execution with a full `resultData.runData` — verified against n8n 2.30.7. An
 * empty `pinData` is required by the schema and means "run it for real".
 */
async function seedCapture(): Promise<void> {
  const target = seedOfKind("s8-ladder");
  const client = await harnessMcp();
  const out = await client.callTool("test_workflow", { workflowId: target.id, pinData: {} }) as { executionId?: string; status?: string };
  if (!out.executionId) throw new Error(`test_workflow returned no executionId for "${target.name}": ${JSON.stringify(out).slice(0, 200)}`);
  console.log(`  seed-capture: ran "${target.name}" (${target.id}) -> execution ${out.executionId} (${out.status ?? "?"})`);
}

/**
 * S11: take the workflow live, then move the DRAFT off the last-sync hash while
 * the published version keeps running. The asymmetry is the thing under test —
 * a scenario that only drifted the draft of an unpublished workflow would be S3.
 */
async function publishThenDrift(): Promise<void> {
  const target = seedOfKind("realism");
  const client = await harnessMcp();
  const pub = await client.callTool("publish_workflow", { workflowId: target.id }) as { success?: boolean; error?: string; activeVersionId?: string | null };
  if (pub.success !== true) throw new Error(`publish_workflow failed for "${target.name}": ${pub.error ?? JSON.stringify(pub).slice(0, 200)}`);
  const node = await editCodeOverMcp(target.id, (current) => `// Sam was here\n${current}`);
  console.log(`  publish-then-drift: published "${target.name}" (live ${String(pub.activeVersionId).slice(0, 8)}), then edited draft node "${node}" over raw MCP`);
}

/**
 * S11: a published workflow whose DRAFT would go live broken — the condition
 * the Plan 64 guard publish gate (#200) exists to refuse. The break is a
 * dangling `$('…')` reference, which is a compliance violation rather than a
 * syntax error, so it survives being written and only fails at the gate.
 */
async function breakPublishedDraft(): Promise<void> {
  const target = seedOfKind("realism");
  const client = await harnessMcp();
  const pub = await client.callTool("publish_workflow", { workflowId: target.id }) as { success?: boolean; error?: string };
  if (pub.success !== true) throw new Error(`publish_workflow failed for "${target.name}": ${pub.error ?? "unknown"}`);
  const node = await editCodeOverMcp(target.id, (current) => `const upstream = $('Nowhere in this workflow').all();\n${current}`);
  console.log(`  break-published-draft: "${target.name}" is live; draft node "${node}" now carries a dangling reference`);
}

/** S13: take the workflow out of MCP under the session (n8n's per-workflow gate). */
async function revokeMcpAccess(): Promise<void> {
  const target = seedOfKind("s1-skeleton");
  await ownerRestOk("PATCH", "/rest/mcp/workflows/toggle-access", { availableInMCP: false, workflowIds: [target.id] });
  console.log(`  revoke-mcp-access: "${target.name}" (${target.id}) is no longer available over MCP`);
}

/** S13: invalidate the token the session holds — every MCP call now 401s. */
async function rotateMcpToken(): Promise<void> {
  const body = await ownerRestOk("POST", "/rest/mcp/api-key/rotate") as { data?: { apiKey?: string } };
  if (typeof body.data?.apiKey !== "string") throw new Error("rotate returned no apiKey");
  console.log("  rotate-mcp-token: the session's MCP token is now stale (server-side rotate) — expect 401");
}

/**
 * S13: switch the MCP server off instance-wide.
 *
 * Verified on 2.30.7: the endpoint does NOT start 404ing. A valid token gets
 * **403** `{"message":"MCP access is disabled"}`; a missing or stale token still
 * gets 401, exactly as when MCP is enabled — so a session whose token is also
 * stale sees the 401 and chases the wrong problem. The 403 now carries n8n's
 * own reason plus the fix ([Plan 74](../../plans/done/74-mcp-disabled-403.md));
 * whether that routes a blind agent is what this condition grades.
 */
async function disableMcp(): Promise<void> {
  await ownerRestOk("PATCH", "/rest/mcp/settings", { mcpAccessEnabled: false });
  console.log("  disable-mcp: MCP access is off instance-wide — expect 403 \"MCP access is disabled\" (401 if the token is stale too)");
}

/** The local sync-dir folder tracking a given seeded workflow, if it was pulled. */
function trackedDirFor(workflowId: string): string | undefined {
  const root = path.join(WORKDIR, manifest.root);
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const st = JSON.parse(readFileSync(path.join(root, entry.name, ".decanter.json"), "utf8")) as { workflowId?: string };
      if (st.workflowId === workflowId) return path.join(root, entry.name);
    } catch { /* not a tracked folder */ }
  }
  return undefined;
}

/**
 * S13: a LOCAL compliance violation — an orphan file in `code/` that no
 * placeholder points at. Deliberately not a syntax error: the layout guard is
 * the gate `--force` does not bypass, and that refusal is what is being graded.
 *
 * No-op with a note when nothing has been pulled yet: the violation has to live
 * in a real tracked folder, and a scenario that pulls first will still hit it on
 * its own edits.
 */
function injectLayoutViolation(): void {
  const target = seedOfKind("s1-skeleton");
  const dir = trackedDirFor(target.id);
  if (!dir) { console.warn(`  inject-layout-violation: "${target.name}" is not pulled yet — nothing to violate`); return; }
  const orphan = path.join(dir, "code", "leftover-helper.js");
  mkdirSync(path.dirname(orphan), { recursive: true });
  writeFileSync(orphan, "// left over from a refactor nobody finished\nreturn $input.all();\n");
  console.log(`  inject-layout-violation: wrote an orphan ${path.relative(WORKDIR, orphan)} (no placeholder points at it)`);
}

/**
 * S15 (Plan 79 task 7): plant a "company-wide" helper NEXT TO the sync dir —
 * outside it — so the natural implementation of the scenario's task is a
 * relative import that escapes the sync dir and meets the ADVISORY warning.
 * Nothing is broken and nothing blocks; what the round measures is whether a
 * blind agent notices the warning and surfaces or acts on it. The dir is a
 * sibling of the scratch workDir inside the per-run `ops-<pid>` parent, so
 * `ls ..` shows exactly two entries (round ftrun-21850's lesson) and stage
 * teardown removes it with the parent.
 */
function plantOutsideHelper(): void {
  const dir = path.join(WORKDIR, "..", "company-lib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "vat.ts"),
    "// Company-wide VAT helper — finance owns this file; single source of truth, do not copy.\nexport const VAT_RATE = 0.19;\nexport function withVat(net: number): number {\n  return Math.round(net * (1 + VAT_RATE) * 100) / 100;\n}\n",
  );
  console.log(`  plant-outside-helper: wrote ${path.relative(WORKDIR, path.join(dir, "vat.ts"))} (a sibling of the sync dir — outside it)`);
}

/**
 * S13: point the agent's MCP config straight at the instance, so the guard is
 * not in the path at all and NOTHING blocks a `jsCode` write. The one condition
 * that tests the product's core invariant without the guard enforcing it.
 */
function misrouteMcp(): void {
  const file = path.join(WORKDIR, ".mcp.json");
  const config = {
    mcpServers: {
      n8n: {
        type: "http",
        url: `${manifest.host}/mcp-server/http`,
        headers: { Authorization: `Bearer ${manifest.mcpToken}` },
      },
    },
  };
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log("  misroute-mcp: .mcp.json now points straight at n8n — the guard is out of the path");
}

/**
 * Current draft `versionId` per workflow, read over the public API — the
 * baseline a read-only scenario is graded against (Plan 61 task 9). Best effort:
 * a workflow we cannot read is left out rather than failing the round, since the
 * invariant is "nothing moved", not "everything was readable".
 */
async function draftVersions(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    try {
      const res = await fetch(`${manifest.host.replace(/\/+$/, "")}/api/v1/workflows/${encodeURIComponent(id)}`, {
        headers: { "X-N8N-API-KEY": manifest.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const { versionId } = (await res.json()) as { versionId?: string };
      if (typeof versionId === "string") out.set(id, versionId);
    } catch { /* unreadable — skip; the check simply won't be asserted for it */ }
  }
  if (out.size > 0) console.log(`  read-only baseline: ${[...out].map(([id, v]) => `${id}@${v.slice(0, 8)}`).join(", ")}`);
  return out;
}

/**
 * S10: pre-fill the backup store so the round meets `backupLimit` pruning.
 *
 * Writes plausible, *previous* exports straight into `backups/` rather than
 * calling `backup create` N times: the verb refuses to re-backup an unchanged
 * `versionId`, so N calls would produce one file. Shape matches what
 * `lib/backup.mts` writes — `<fsTimestamp>.<short versionId>.json` — because
 * `backup list` and the `<backup>` ref forms parse the filename.
 */
async function fillBackupStore(): Promise<void> {
  const target = seedOfKind("corpus-credentialed");
  const dir = trackedDirFor(target.id);
  if (!dir) { console.warn(`  fill-backup-store: "${target.name}" is not pulled yet — nothing to fill`); return; }
  const backups = path.join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  const base = Date.parse("2026-07-01T09:00:00Z");
  for (let i = 0; i < 22; i++) { // > the default backupLimit of 20, so a create prunes
    const when = new Date(base + i * 86_400_000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const version = `old${String(i).padStart(5, "0")}`;
    writeFileSync(path.join(backups, `${when}.${version}.json`), JSON.stringify({ id: target.id, name: target.name, versionId: version, nodes: [], connections: {} }, null, 2) + "\n");
  }
  console.log(`  fill-backup-store: wrote 22 prior backups for "${target.name}" — the next \`backup create\` must prune to backupLimit`);
}

/**
 * S9's air-gap, actually staged. The scenario's turns *claim* the instance is
 * unreachable; nothing made it so, and its own checklist ("nothing reached the
 * network") was unverifiable against a live stage — the same shape as the two
 * condition flags Plan 62 found believing themselves.
 *
 * Two steps, in the order a real day has them:
 *  1. **Pull while still online.** Offline work needs local files, and a fresh
 *     stage has none. This is the pull the persona ran yesterday.
 *  2. **Cut the wire.** `.env`'s host moves to a closed port, so every CLI call
 *     and the guard itself fail to connect — while the token stays, so the
 *     failure reads "unreachable", not "unconfigured". `verify.mts` reads the
 *     manifest, never the workDir `.env`, so grading is unaffected.
 */
async function goOffline(): Promise<void> {
  const bin = path.join(WORKDIR, "node_modules", ".bin", "n8n-decanter");
  const targets = ["s8-ladder", "loop-preview"].map(seedOfKind);
  for (const t of targets) {
    try {
      await execFile(bin, ["pull", t.id], { cwd: WORKDIR });
      console.log(`  go-offline: pulled "${t.name}" while the instance was still reachable`);
    } catch (err) {
      console.warn(`  go-offline: could not pull "${t.name}" (${(err as Error).message.split("\n")[0]}) — the agent will have nothing local to work on`);
    }
  }
  const envFile = path.join(WORKDIR, ".env");
  const dead = "http://127.0.0.1:1"; // nothing listens: connection refused, no hang
  const before = readFileSync(envFile, "utf8");
  writeFileSync(envFile, before.replace(/^N8N_HOST=.*$/m, `N8N_HOST=${dead}`));
  console.log(`  go-offline: .env host -> ${dead}; credentials left in place, so failures read as unreachable rather than unconfigured`);
}

const PRE_HOOKS: Record<string, () => Promise<void>> = {
  "remote-drift": remoteDrift,
  "go-offline": goOffline,
  "seed-capture": seedCapture,
  "publish-then-drift": publishThenDrift,
  "break-published-draft": breakPublishedDraft,
  "revoke-mcp-access": revokeMcpAccess,
  "rotate-mcp-token": rotateMcpToken,
  "disable-mcp": disableMcp,
  "inject-layout-violation": async () => injectLayoutViolation(),
  "misroute-mcp": async () => misrouteMcp(),
  "fill-backup-store": fillBackupStore,
  "plant-outside-helper": async () => plantOutsideHelper(),
};

/**
 * Hooks that deliberately move the remote off decanter's last-sync hash, so
 * `verify.mts` is told to expect it. Without this the scenario's own correct
 * behaviour scores as a violation — the S3/S4 bug that #171 fixed.
 */
const DRIFTING_HOOKS = new Set(["remote-drift", "publish-then-drift", "break-published-draft"]);

// ---------- one blind claude -p turn ----------
const TURN_TIMEOUT_MS = Number(process.env.FIELD_TURN_TIMEOUT_MS ?? 900_000); // 15 min/turn safety net
async function claudeTurn(msg: string, turnIndex: number, resumeId: string | undefined, transcript: string): Promise<{ sessionId: string | undefined; resultText: string }> {
  const args = ["-p", msg, "--model", MODEL, "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  // Broad "consenting user" grant on EVERY turn (permission-UX is out of scope,
  // Plan 35). The settings.local.json DENY rules still win (push --force,
  // .decanter.json, .env) once init scaffolds them, and the jsCode-over-MCP block
  // is enforced by the mcp connect guard itself, not by permissions.
  args.push("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,TodoWrite,mcp__n8n-instance,mcp__n8n-docs");
  return await new Promise((resolve, reject) => {
    let proc: import("node:child_process").ChildProcessWithoutNullStreams;
    if (containerMode) {
      // each turn is a `docker exec` into the long-lived fenced agent container;
      // it already carries ANTHROPIC_API_KEY / HTTPS_PROXY / NO_PROXY + the baked
      // CLI on PATH, and cwd /work is the bind-mounted sync dir. -T = no TTY (pipe).
      proc = spawn("docker", ["compose", "-f", COMPOSE, "--env-file", ENV_FILE, "exec", "-T", "-w", "/work", "agent", "claude", ...args], { env: { ...process.env, ...composeEnv } });
    } else {
      // PATH policy for the blind session — deliberate, because it decides what
      // the round can honestly measure (Plan 35 finding, 2026-07-26).
      //
      // The workDir install is LOCAL (a packed tarball, no global link), so a
      // bare `n8n-decanter` in the agent's **Bash** does not resolve on its own.
      // Prepending node_modules/.bin simulates the GLOBAL install most users
      // have, and keeps Bash-surface friction out of the measurement.
      //
      // It is NOT needed by the guard any more: the scaffolded `.mcp.json` runs
      // `npx --no-install n8n-decanter mcp connect` (Plan 58 Task 1), which
      // resolves the local bin from cwd by itself. Set FIELD_NO_PATH_HELP=1 to
      // drop the prepend and measure a genuinely unassisted PATH — that is the
      // configuration a real local-install user's agent gets, and the one that
      // would have caught Task 1's silent-fail.
      //
      // Dropping the prepend is NOT enough on its own — a maintainer machine
      // commonly carries a global `n8n-decanter` (an `npm link` from this repo),
      // which sits on the inherited PATH and quietly satisfies a bare command.
      // The first-ever unassisted-PATH round (Plan 62 task 1, 2026-08-05) hit
      // exactly that: the header printed UNASSISTED PATH, the agent typed a bare
      // `n8n-decanter list --remote`, and it WORKED — resolving the maintainer's
      // link, i.e. the main checkout, not the packed tarball the stage installed.
      // So the round measured neither the condition nor the code under test.
      //
      // Both conditions therefore shadow ambient installs: `noCli` (Plan 57 / S6)
      // and `FIELD_NO_PATH_HELP`. They differ in intent, not mechanism — noCli
      // removes the project's install too, while this one keeps it and only
      // makes the agent reach it the way a real local-install user must
      // (`npx`, or `./node_modules/.bin/…`).
      const { PATH, extraEnv } = hostCliEnv();
      proc = spawn("claude", args, { cwd: LAUNCHDIR, env: { ...process.env, PATH, ...extraEnv } });
    }
    let buf = "";
    let sessionId: string | undefined;
    let resultText = "";
    const lines: string[] = [];
    const timer = setTimeout(() => { lines.push(`[harness] turn ${turnIndex} exceeded ${TURN_TIMEOUT_MS}ms — killing`); proc.kill("SIGKILL"); }, TURN_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        lines.push(line);
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) sessionId = ev.session_id;
          if (ev.type === "result" && typeof ev.result === "string") resultText = ev.result;
        } catch { /* non-JSON line — keep raw */ }
      }
    });
    proc.stderr.on("data", (c: Buffer) => lines.push(`[stderr] ${c.toString().trimEnd()}`));
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(transcript, lines.join("\n") + "\n");
      if (code !== 0 && !resultText) reject(new Error(`claude turn ${turnIndex} exited ${code} (see ${transcript})`));
      else resolve({ sessionId, resultText });
    });
  });
}

/**
 * Harness-owned commit of the workflows tree after each turn.
 *
 * Observability must not depend on the system under test: decanter only
 * auto-commits on pull/push, so a change the agent never pushed is invisible in
 * git — round-2 S4's .js→.ts conversion (write .ts, re-point placeholder, rm .js,
 * then `check` instead of `push`) was exactly that. Committing HERE gives
 * per-TURN granularity that is actor-agnostic (agent edits, pull overwrites,
 * live-mirror writes, drift injection all land), while reusing git's
 * baseline+delta format instead of copying the tree once per turn. Scoped to
 * `workflows/` so the scaffold — identical in every run — never bloats the archive.
 */
function commitTurn(scenario: string, turn: number): void {
  if (!existsSync(path.join(WORKDIR, "workflows"))) return; // nothing pulled yet
  try {
    execFileSync("git", ["-C", WORKDIR, "add", "--", "workflows"], { stdio: "ignore" });
    const staged = execFileSync("git", ["-C", WORKDIR, "diff", "--cached", "--name-only", "--", "workflows"], { encoding: "utf8" }).trim();
    if (!staged) return; // nothing changed this turn — no empty commits
    execFileSync("git", ["-C", WORKDIR, "commit", "-q", "-m", `harness: ${scenario} after turn ${turn}`], { stdio: "ignore" });
  } catch (e) {
    console.warn(`  turn commit ${scenario}/turn-${turn} failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

// ---------- run one scenario ----------
async function runScenario(id: string): Promise<{ id: string; verifyExit: number | null; turns: number }> {
  const scn = loadScenario(id);
  const outDir = path.join(HARNESS, "transcripts", id);
  mkdirSync(outDir, { recursive: true });
  const turns = scn.turns.map(fillPublic); // credential placeholders stay unfilled (never logged)
  console.log(`\n########## ${id} — ${scn.persona ?? ""} ##########`);
  if (dryRun) {
    turns.forEach((t, i) => { console.log(`\n--- turn ${i + 1} ---\n${t}`); });
    return { id, verifyExit: null, turns: turns.length };
  }

  if (scn.preHook !== undefined) await PRE_HOOKS[scn.preHook]();

  // A read-only scenario pins the instance state it starts from, so the verifier
  // can prove nothing wrote (Plan 61 task 9). Taken AFTER the pre-hook — the hook
  // is the harness deliberately mutating, and that is not what is under test.
  const baselines = scn.readOnly === true ? await draftVersions(resolveVerifyScope(scn)) : new Map<string, string>();

  // The STAGE now pre-runs `init`, so .claude/ + .mcp.json exist before the agent
  // starts — wire the allow-extension + guard-stderr capture up front (idempotent,
  // so re-running it per scenario is harmless).
  applyPostInit();
  let sessionId: string | undefined;
  commitTurn(id, 0); // baseline commit, so turn 1's effect is diffable
  for (let i = 0; i < turns.length; i++) {
    console.log(`\n[${id}] turn ${i + 1}/${turns.length} ${sessionId ? `(resume ${sessionId.slice(0, 8)})` : "(new session)"}`);
    const transcript = path.join(outDir, `turn-${i + 1}.jsonl`);
    // The prompt is passed as argv, so it appears NOWHERE in the stream-json
    // transcript (its `user` events are tool results). Record it verbatim —
    // public-filled, secrets still placeholders — so a round's prompts are a fact
    // of the round, not something re-derived from scenario files that move on.
    writeFileSync(path.join(outDir, `turn-${i + 1}.prompt.txt`), `${turns[i]}\n`);
    const { sessionId: sid, resultText } = await claudeTurn(fillSecrets(turns[i]), i + 1, sessionId, transcript);
    sessionId ??= sid;
    console.log(`  → ${resultText.slice(0, 200).replace(/\n/g, " ")}${resultText.length > 200 ? "…" : ""}`);
    commitTurn(id, i + 1); // tool-independent, per-turn record of what actually changed
  }

  // scripted invariant verifier
  //
  // `"none"` is a real answer, not a missing one (Plan 61 task 9): a scenario
  // whose whole point is that the environment is broken cannot leave verifiable
  // local state, and running the verifier anyway produced a FAIL that read like
  // a product defect and was an authoring error (S13, round ftrun-29773).
  // Distinct from `[]`, which resolves to "verify every folder".
  if (scn.verifyWorkflows === "none") {
    console.log(`  verify skipped — ${id} declares verifyWorkflows "none" (graded from the transcript)`);
    return { id, verifyExit: null, turns: turns.length };
  }
  const verifyOut = path.join(HARNESS, `verify-${id}.json`);
  let verifyExit: number | null = null;
  try {
    const args = [VERIFY, manifestPath, "--scenario", id, "--out", verifyOut];
    // A scenario that deliberately drifts the instance tells verify so, or its
    // own correct behaviour scores as violations (S3), and every later scenario
    // inherits them (S4).
    if (scn.preHook !== undefined && DRIFTING_HOOKS.has(scn.preHook)) {
      const target = driftTargetId();
      if (target) args.push("--expect-drift", target);
    }
    for (const [id, version] of baselines) args.push("--expect-unchanged", `${id}=${version}`);
    args.push(...resolveVerifyScope(scn));
    const { stdout, stderr } = await execFile(process.execPath, args, { encoding: "utf8" });
    console.log(stdout + stderr);
    verifyExit = 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    console.log((e.stdout ?? "") + (e.stderr ?? ""));
    verifyExit = e.code ?? 1;
  }
  return { id, verifyExit, turns: turns.length };
}

// ---------- archive: render the HTML view + STORE EVERYTHING RAW (survives teardown) ----------
//
// Archives land in `test/field-test/runs/<iso>-<runId>/` and are COMMITTED —
// that, not a path outside the worktree, is what makes them prune-proof: a
// `git worktree remove` can't take a committed run with it, and a round's
// findings stay reviewable in the PR that produced them. `raw.tgz` is the
// source of truth (any view re-renders from it); `report.html` sits next to it
// so the run is readable straight from the repo. Both must be committed before
// the worktree is removed — `run.mts` deliberately does NOT commit for you.
/** Scrub run credentials from a text artifact — the archive is COMMITTED. */
function scrubFile(file: string, secrets: string[]): void {
  try {
    let text = readFileSync(file, "utf8");
    let hit = false;
    for (const s of secrets) if (text.includes(s)) { text = text.split(s).join("‹redacted›"); hit = true; }
    if (hit) writeFileSync(file, text);
  } catch { /* binary or unreadable — nothing to scrub */ }
}
function scrubTree(dir: string, secrets: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scrubTree(p, secrets);
    else scrubFile(p, secrets);
  }
}

async function archiveRun(): Promise<void> {
  // Assemble the RAW payload, then commit it compressed next to the harness.
  //    Only what a view actually needs, and each fact stored ONCE:
  //      transcripts/  — the conversation + every agent edit (per-EDIT record)
  //      work.git      — a BARE clone: the whole workflows/ history as
  //                      baseline+deltas (per-TURN harness commits + decanter's
  //                      own), which is git's job and replaces the old per-turn
  //                      tree copies, the flat .diff dump and the workDir copy
  //      verify-*.json / guard.log / manifest.json
  //    Deliberately NOT archived: the working tree (reconstructable from
  //    work.git) and the vendored skills pack (identical every run; provenance
  //    lives in manifest.skills).
  // harnessRoot is `…/ftrun-<pid>` for a live run, but a re-archived older run
  // may sit a level down (`…/ftrun-<pid>/harness`) — take the id, not the leaf
  const runId = HARNESS.split(path.sep).reverse().find((s) => /^ftrun-\d+$/.test(s)) ?? path.basename(HARNESS);
  // the RUN's time, not the archive's — so a re-archive (--archive) of an old
  // round keeps its original identity instead of minting a second dated dir
  const stamp = (manifest.createdAt ?? new Date().toISOString()).replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  // A second LIVE round against the same stage would otherwise land on the same
  // path and silently overwrite the first — and an agentic round is expensive
  // and irreproducible, so the earlier evidence must never be the thing that
  // gives way. (Re-archiving with `--archive` keeps the original identity on
  // purpose: that is the same round, re-rendered.) Learned the hard way — S16
  // round 2 replaced round 1's committed raw.tgz + report.html.
  let dest = process.env.FIELD_ARCHIVE_DIR ?? path.join(HERE, "runs", `${stamp}-${runId}`);
  if (process.env.FIELD_ARCHIVE_DIR === undefined && !argv.includes("--archive")) {
    for (let n = 2; existsSync(dest); n++) dest = path.join(HERE, "runs", `${stamp}-${runId}-r${n}`);
  }
  const staging = path.join(HARNESS, "__raw");
  // `ownerCookie` belongs here too (Plan 78 finding 5): it is an n8n owner SESSION
  // JWT, and the README promises the archive is scrubbed. It was neither in this
  // list nor overwritten below, so 40 of the archives committed before
  // 2026-08-08 carry one verbatim in a public repo. Practical risk is ~nil (a
  // throwaway container on an ephemeral localhost port, long expired) and the
  // existing ones cannot be removed without rewriting history, which the ruleset
  // blocks — but nothing written from here on should add to them.
  const secrets = [manifest.mcpToken, manifest.apiKey, manifest.ownerCookie].filter((s): s is string => typeof s === "string" && s.length > 8);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    if (existsSync(path.join(HARNESS, "transcripts"))) cpSync(path.join(HARNESS, "transcripts"), path.join(staging, "transcripts"), { recursive: true });
    // the scenario files AS RUN — the report renders each turn's prompt from
    // them, so without a copy an archived round would re-render against whatever
    // the scenarios say today (they get reworked between rounds; that's the point
    // of a round). This is the run's input; the transcripts are its output.
    cpSync(SCENARIO_DIR, path.join(staging, "scenarios"), { recursive: true });
    for (const f of readdirSync(HARNESS)) {
      if (/^verify-.*\.json$/.test(f) || f === "guard.log") copyFileSync(path.join(HARNESS, f), path.join(staging, f));
    }
    // committed-history only — no working tree, no node_modules, no scaffold
    // The repo is the sync dir in a flat round and the app repo root under
    // FIELD_NESTED — clone whichever actually holds `.git`, or the archive
    // silently ships no history at all.
    const repoDir = existsSync(path.join(WORKDIR, ".git")) ? WORKDIR : LAUNCHDIR;
    if (existsSync(path.join(repoDir, ".git"))) {
      execFileSync("git", ["clone", "--quiet", "--bare", repoDir, path.join(staging, "work.git")], { stdio: "ignore" });
    }
    // the manifest travels WITHOUT credentials (this lands in git). `scenariosAsRun`
    // is false when re-archiving an older round: the scenarios/ copy is then
    // today's, not provably the ones that ran, and the report says so.
    // `model` is a RUN property, not a stage one, so the stage-written manifest
    // cannot carry it — but the archive must, or two rounds that differ only by
    // model become indistinguishable in git. (`n8nTag` the stage already records.)
    writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ ...manifest, model: MODEL, mcpToken: "‹redacted›", apiKey: "‹redacted›", ...(manifest.ownerCookie ? { ownerCookie: "‹redacted›" } : {}), scenariosAsRun: !argv.includes("--archive") }, null, 2) + "\n");
    scrubTree(staging, secrets); // transcripts/guard.log may echo a token in tool output

    mkdirSync(dest, { recursive: true });
    const tgz = path.join(dest, "raw.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", staging, "."], { stdio: "ignore" });
    rmSync(staging, { recursive: true, force: true });
    // Render the shipped view FROM the tarball, not from the live run. Two
    // reasons: the committed report is then provably what the raw yields (every
    // round self-tests its own archive), and rendering after packing means a
    // renderer failure can no longer cost us the raw.
    try {
      const { stdout } = await execFile(process.execPath, [REPORT, "--from", tgz, "--out", path.join(dest, "report.html")], { maxBuffer: 64 * 1024 * 1024 });
      if (stdout.trim()) console.log(stdout.trim());
    } catch (e) { console.warn(`report generation failed (${(e as Error).message.split("\n")[0]}) — the raw archive is intact; re-render with --from`); }
    console.log(`\narchived (committed) -> ${dest}`);
    console.log(`  read now:               open ${path.join(dest, "report.html")}`);
    console.log(`  re-render from the raw: node test/field-test/report.mts --from ${path.join(dest, "raw.tgz")}`);
  } catch (e) { console.warn(`archive failed: ${(e as Error).message.split("\n")[0]}`); }
}

// ---------- main ----------
// re-archive an already-finished round without re-running it (recovery path when
// archiving failed, and how the archive mechanics get exercised for $0)
if (argv.includes("--archive")) { await archiveRun(); process.exit(0); }

if (!existsSync(WORKDIR)) { console.error(`workDir missing: ${WORKDIR} — run stage.mts first`); process.exit(2); }

// Gate the subset BEFORE the image build and long before any claude turn — the
// whole value of this check is that it costs nothing when it fires.
/**
 * `--hook=<name>`: play ONE pre-hook against the staged instance and exit.
 *
 * The hooks are the only part of the harness that mutates a real n8n, and until
 * now the only way to exercise one was to spend a scenario. That is backwards
 * for machinery whose whole job is to be correct BEFORE an expensive round
 * (Plan 61). This also lets a maintainer stage a condition by hand and drive it
 * themselves.
 */
const hookName = argv.find((a) => a.startsWith("--hook="))?.slice("--hook=".length);
const diagnosticOnly = argv.includes("--precheck") || argv.includes("--netcheck") || argv.includes("--smoke") || hookName !== undefined;
if (!diagnosticOnly) assertIsolation(scenarioIds);
if (!diagnosticOnly) assertPrerequisites(scenarioIds);

let exitCode = 0;
if (containerMode && !dryRun) await containerSetup();
const deadline = Date.now() + RUN_BUDGET_MS; // budget starts AFTER the build/setup
/** The n8n URL the agent uses — in-network name in container mode, host URL otherwise. */
const agentN8n = containerMode ? `http://${manifest.container}:5678` : manifest.host;
try {
  if (hookName !== undefined) {
    const hook = PRE_HOOKS[hookName];
    if (!hook) {
      console.error(`unknown pre-hook ${JSON.stringify(hookName)} — known: ${Object.keys(PRE_HOOKS).join(", ")}`);
      exitCode = 2;
    } else {
      console.log(`playing pre-hook "${hookName}" against ${manifest.host} …`);
      try { await hook(); console.log(`hook "${hookName}" OK`); }
      catch (err) { console.error(`hook "${hookName}" FAILED: ${(err as Error).message}`); exitCode = 1; }
    }
  } else if (argv.includes("--precheck")) {
    // container-mode plumbing check, NO claude spend: the baked CLI loads and
    // the fenced agent reaches n8n on the internal net.
    if (!containerMode) { console.error("--precheck is container-mode only (add --container)"); exitCode = 2; }
    else {
      const exec = async (label: string, cmd: string): Promise<boolean> => {
        try { const { stdout, stderr } = await dockerCompose(["exec", "-T", "-w", "/work", "agent", "sh", "-c", cmd]); console.log(`  ✓ ${label}: ${(stdout + stderr).trim().split("\n").slice(-1)[0].slice(0, 160)}`); return true; }
        catch (e) { console.error(`  ✗ ${label}: ${(e as Error).message.split("\n").slice(-2).join(" ").slice(0, 200)}`); return false; }
      };
      console.log("precheck: baked CLI + in-network n8n reachability (no claude spend) …");
      const a = await exec("baked CLI loads", "n8n-decanter --help >/dev/null && echo loaded-ok");
      const b = await exec("n8n /healthz reachable", `curl -s -o /dev/null -w '%{http_code}' ${agentN8n}/healthz`);
      exitCode = a && b ? 0 : 1;
      console.log(exitCode === 0 ? "precheck OK — plumbing works; ready for a scenario run" : "precheck FAILED — inspect above");
    }
  } else if (argv.includes("--netcheck")) {
    // prove the blind session can REACH n8n (host mode: sandbox off; container
    // mode: on the internal net). One claude turn that curls n8n's /healthz.
    mkdirSync(path.join(HARNESS, "transcripts"), { recursive: true });
    console.log(`netcheck: asking a claude -p turn to curl ${agentN8n}/healthz …`);
    try {
      const { resultText } = await claudeTurn(`Run exactly this shell command and reply with ONLY its raw output and nothing else: curl -s -o /dev/null -w '%{http_code}' ${agentN8n}/healthz`, 0, undefined, path.join(HARNESS, "netcheck.jsonl"));
      const ok = /200/.test(resultText);
      console.log(`netcheck: n8n /healthz -> ${JSON.stringify(resultText.trim()).slice(0, 120)} — ${ok ? "REACHABLE" : "NOT reachable"}`);
      exitCode = ok ? 0 : 1;
    } catch (err) { console.error(`netcheck FAILED: ${(err as Error).message}`); exitCode = 1; }
  } else if (argv.includes("--smoke")) {
    // cheapest validation that a headless claude -p turn works (auth, --model,
    // stream-json parsing, session_id capture) before spending a full scenario.
    mkdirSync(path.join(HARNESS, "transcripts"), { recursive: true });
    console.log(`smoke: spawning one claude -p turn ${containerMode ? "in the fenced container" : `in ${WORKDIR}`} …`);
    try {
      const { sessionId, resultText } = await claudeTurn("Reply with exactly the word READY and nothing else.", 0, undefined, path.join(HARNESS, "smoke.jsonl"));
      const ok = !!sessionId && /READY/i.test(resultText);
      console.log(`smoke: session=${sessionId ?? "(none)"} result=${JSON.stringify(resultText).slice(0, 160)}`);
      console.log(ok ? "smoke OK — headless claude works; safe to run scenarios" : "smoke INCONCLUSIVE — inspect " + path.join(HARNESS, "smoke.jsonl"));
      exitCode = ok ? 0 : 1;
    } catch (err) { console.error(`smoke FAILED: ${(err as Error).message}`); exitCode = 1; }
  } else {
    // Record the PATH policy in the round's own output: whether the agent got a
    // resolvable bare `n8n-decanter` is a condition of what the round measures,
    // so it must never be an invisible default again (Plan 35 finding).
    const pathPolicy = containerMode
      ? "container: CLI on PATH (global install in the image)"
      : manifest.noCli === true
        ? "host: NO-CLI stage — no prepend AND any ambient n8n-decanter stripped from PATH (Plan 57 discoverability condition)"
        : process.env.FIELD_NO_PATH_HELP === "1"
          ? "host: UNASSISTED PATH (FIELD_NO_PATH_HELP=1) — bare `n8n-decanter` will NOT resolve in Bash"
          : `host: ambient n8n-decanter shadowed, then the SYNC DIR's node_modules/.bin prepended (${path.join(WORKDIR, "node_modules", ".bin")}) — simulates a global install, but of THIS round's build (bare name and npx both hit it)`;
    // Under FIELD_NESTED the agent's cwd is NOT the sync dir, so "node_modules/.bin
    // prepended" alone would read as if the bin sat where the agent stands. Name
    // both dirs, or the round gets graded against the wrong world.
    const launchLine = NESTED ? `\n  launchDir ${LAUNCHDIR}   (blind agent cwd — ABOVE the sync dir; its wiring does not load here)` : "";
    console.log(`orchestrating ${scenarioIds.join(", ")} against ${manifest.host}${containerMode ? " (fenced container)" : ""}\n  workDir ${WORKDIR}${launchLine}\n  guard.log ${GUARD_LOG}\n  PATH policy: ${pathPolicy}`);
    const summary: Array<{ id: string; verifyExit: number | null; turns: number }> = [];
    for (const id of scenarioIds) {
      if (containerMode && !dryRun && Date.now() > deadline) { console.error(`[harness] run budget exhausted — stopping before ${id}`); exitCode = 2; break; }
      summary.push(await runScenario(id));
    }
    console.log("\n=== run summary ===");
    for (const r of summary) console.log(`  ${r.id}: ${r.turns} turns, verify ${r.verifyExit === 0 ? "PASS" : r.verifyExit === null ? "(dry-run)" : "FAIL"}`);
    if (existsSync(GUARD_LOG)) console.log(`\nguard stderr captured -> ${GUARD_LOG}`);
    console.log(`transcripts -> ${path.join(HARNESS, "transcripts")}`);
    console.log("\nNext: grade transcripts (Opus, unblinded) + contamination check, then append the run report to the plan this round serves (plans/open/) — Plan 35 built this harness and is closed: plans/done/35-blind-agent-field-test.md");
    if (!dryRun) await archiveRun(); // auto-render + archive BEFORE any teardown
  }
} finally {
  await containerTeardown();
}
process.exit(exitCode);
