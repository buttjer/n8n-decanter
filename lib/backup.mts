// Git-native workflow backups (Plan 51 Part B): a versioned, redeployable
// disaster-recovery store per workflow. Both MCP and REST only expose the
// current draft tip, and MCP's read is sanitized (no credential refs, no
// pinData/staticData/description) — so git is the ONLY place a redeployable
// version history can live. `backup create` captures the full-fidelity REST
// export into `backups/<timestamp>.<short-versionId>.json` (jsCode kept as
// `//@file:` placeholders — no code duplication); `backup restore` re-inlines
// the code and REST-POSTs a NEW, unpublished workflow with node ids preserved.
//
// This is disaster recovery, not sync: restore creates a *new* workflow, it
// does not reconcile an existing one — structure ownership stays with n8n
// (Plan 32). The store is committed deliberately by the user (it carries
// credential refs + any secrets embedded in node params) — decanter never
// auto-commits it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { N8nApi } from "./api.mts";
import { assertCompliant, buildNodeCode } from "./push.mts";
import { readState } from "./state.mts";
import { style } from "./style.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { FILE_PLACEHOLDER_PREFIX, isJsCodeNode, placeholderFile } from "./util.mts";
import { validateWorkflowDir } from "./validate.mts";

/** The per-workflow backup store subdir — committed (unlike `executions/`). */
export const BACKUPS_DIR = "backups";

/** Runtime state stripped from the stored export (churny/semi-sensitive). */
const STRIP_FIELDS = ["pinData", "staticData"] as const;

/** One retained backup on disk. */
export interface BackupEntry {
  file: string; // absolute path
  name: string; // file basename
  timestamp: string; // filesystem-safe ISO, from the name
  versionId: string; // short id from the name (full one lives inside)
}

/** `2026-07-23T14-30-00Z` — ISO with `:` and the `.mmm` fraction made path-safe. */
function fsTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** The retained backups, oldest → newest (timestamp prefix sorts chronologically). */
export function listBackups(dir: string): BackupEntry[] {
  const backupsDir = path.join(dir, BACKUPS_DIR);
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      // <fs-timestamp>.<short-versionId>.json
      const stem = name.replace(/\.json$/, "");
      const dot = stem.lastIndexOf(".");
      return {
        file: path.join(backupsDir, name),
        name,
        timestamp: dot > 0 ? stem.slice(0, dot) : stem,
        versionId: dot > 0 ? stem.slice(dot + 1) : "",
      };
    });
}

/** Node count of a stored backup (best-effort — for the list/label lines). */
function nodeCount(entry: BackupEntry): number {
  try {
    return (JSON.parse(readFileSync(entry.file, "utf8")) as Workflow).nodes?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Credential-rebind hints: each node's credential refs (source-instance ids). */
function credentialHints(nodes: WorkflowNode[]): string[] {
  const hints: string[] = [];
  for (const node of nodes) {
    const creds = (node as { credentials?: Record<string, { id?: string; name?: string }> }).credentials;
    if (creds === undefined || typeof creds !== "object") continue;
    for (const [type, ref] of Object.entries(creds)) {
      hints.push(`  node "${node.name}": credential ${type}${ref?.name ? ` "${ref.name}"` : ""}${ref?.id ? ` (source id ${ref.id})` : ""}`);
    }
  }
  return hints;
}

/**
 * `backup create` — instance → git. REST-GET the current draft, dedup on an
 * unchanged `versionId`, strip runtime state, placeholder each Code node's
 * `jsCode`, write a new timestamped file, rolling-prune to `backupLimit`, and
 * PII-warn. NOT auto-committed — the user reviews and `git add`s.
 */
export async function backupCreate(
  api: N8nApi,
  dir: string,
  { limit = 20, now = new Date() }: { limit?: number; now?: Date } = {},
  log: Log,
): Promise<{ file: string | null; skipped: boolean }> {
  const state = readState(dir);
  if (!state) throw new Error(`missing .decanter.json in ${path.basename(dir)} — pull first`);
  const wf = await api.getWorkflow(state.workflowId);

  const backups = listBackups(dir);
  const latest = backups.at(-1);
  const latestVersionId = latest ? (JSON.parse(readFileSync(latest.file, "utf8")) as Workflow).versionId : undefined;
  if (wf.versionId !== undefined && wf.versionId === latestVersionId) {
    log.info(`"${wf.name}": versionId ${wf.versionId.slice(0, 8)} already backed up (${latest?.name}) — nothing to do`);
    return { file: null, skipped: true };
  }

  // Placeholder each tracked Code node's jsCode (no code duplication); an
  // untracked Code node (never pulled) keeps its inline code so restore still
  // works, with a hint to pull first.
  const out = structuredClone(wf) as Workflow;
  for (const field of STRIP_FIELDS) delete (out as Record<string, unknown>)[field];
  for (const node of out.nodes) {
    if (!isJsCodeNode(node)) continue;
    const file = state.nodes[node.id]?.file;
    if (file !== undefined) node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + file;
    else log.warn(`node "${node.name}" isn't tracked locally — its code stays inline in the backup; run \`pull\` to extract it first`);
  }

  const short = wf.versionId?.slice(0, 8) ?? "nover";
  const fileName = `${fsTimestamp(now)}.${short}.json`;
  const backupsDir = path.join(dir, BACKUPS_DIR);
  mkdirSync(backupsDir, { recursive: true });
  const file = path.join(backupsDir, fileName);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  log.ok(`backed up "${wf.name}" -> ${path.join(BACKUPS_DIR, fileName)} (versionId ${short})`);

  // Rolling prune the working set (git keeps the full history regardless).
  if (limit > 0) {
    const all = listBackups(dir); // includes the just-written file
    const excess = all.length - limit;
    for (let i = 0; i < excess; i++) {
      rmSync(all[i].file);
      log.info(`pruned old backup ${all[i].name} (backupLimit ${limit})`);
    }
  }

  log.warn("this backup is a FULL export — it carries credential refs and any secrets embedded in node parameters; it is NOT auto-committed, review it before `git add`");
  return { file, skipped: false };
}

/** Re-inline each placeholdered Code node's jsCode from its `code/` file. */
async function assembleForRestore(dir: string, backup: Workflow, log: Log): Promise<{ body: Record<string, unknown>; nodes: WorkflowNode[] }> {
  // Compliance-guard the folder so a broken layout can't deploy (the code
  // files behind the placeholders must exist and be well-formed).
  assertCompliant(validateWorkflowDir(dir), log, `"${path.basename(dir)}"`);
  const nodes = structuredClone(backup.nodes);
  for (const node of nodes) {
    if (!isJsCodeNode(node)) continue;
    const file = placeholderFile(node);
    if (file === null) continue; // inline code (untracked node) — leave as-is
    try {
      const { jsCode } = await buildNodeCode(dir, file, log);
      node.parameters.jsCode = jsCode;
    } catch {
      throw new Error(`backup references ${file}, which is missing from ${path.basename(dir)}/ — restore from a folder/commit matching the backup, or \`pull\` to recreate it`);
    }
  }
  // Allowlist the create body to what n8n's public POST /workflows accepts —
  // node ids + credential refs ride inside `nodes` (spike-verified preserved).
  // `id`/`versionId`/`active`/timestamps are server-owned; `description`/`tags`
  // aren't in the create schema (surfaced as hints instead), `pinData`/
  // `staticData` were stripped at capture.
  const body: Record<string, unknown> = {
    name: backup.name,
    nodes,
    connections: backup.connections ?? {},
    settings: backup.settings ?? {},
  };
  return { body, nodes };
}

/**
 * `backup restore` — git → instance. Select a backup (latest by default; a
 * positional backup ref, or a TTY chooser), re-inline the Code-node source,
 * compliance-guard the assembly, and REST-POST a NEW, unpublished workflow
 * (new workflow id; node ids preserved). Prints credential-rebind hints + the
 * editor URL; publish is the operator's next step.
 */
export async function backupRestore(
  api: N8nApi,
  dir: string,
  { host, ref, interactive = false }: { host: string; ref?: string; interactive?: boolean },
  log: Log,
): Promise<{ id: string } | null> {
  const backups = listBackups(dir);
  if (backups.length === 0) throw new Error(`no backups in ${path.basename(dir)}/${BACKUPS_DIR}/ — run \`backup create\` first`);

  const selected = await selectBackup(backups, { ref, interactive }, log);
  if (selected === null) return null; // user quit the chooser

  const backup = JSON.parse(readFileSync(selected.file, "utf8")) as Workflow;
  const { body, nodes } = await assembleForRestore(dir, backup, log);

  const created = await api.createWorkflow(body);
  log.ok(`restored "${backup.name}" from ${selected.name} -> new workflow ${created.id} (unpublished)`);

  const hints = credentialHints(nodes);
  if (hints.length > 0) {
    log.info("credential refs point at the SOURCE instance — recreate/rebind them on the target:");
    for (const h of hints) log.info(style.dim(h));
  }
  if (typeof backup.description === "string" && backup.description.trim() !== "") {
    log.info(style.dim(`  description: ${backup.description}`));
  }
  const editorUrl = `${host.replace(/\/+$/, "")}/workflow/${created.id}`;
  log.info(`open it in n8n: ${style.link(editorUrl, editorUrl)}`);
  log.info(style.dim("it landed unpublished — review, rebind credentials, then publish to go live"));
  return { id: created.id };
}

/**
 * A **backup ref** resolves like a workflow ref does — untyped, by shape, over
 * the two keys `backup list` prints. Both are in the filename
 * (`<timestamp>.<shortVersionId>.json`), so one positional covers both without
 * the caller having to say which it meant:
 *
 * - **timestamp** — exact, or any prefix of the filename (a bare date works)
 * - **versionId** — the short one in the filename, the full one the user pastes
 *   from n8n (a prefix of which the short id is the head), or the full one
 *   stored *inside* the backup
 *
 * The two key spaces don't collide in practice (timestamps lead with a date,
 * versionIds are uuids), so first-match-wins needs no tie-break.
 */
function matchesBackupRef(b: BackupEntry, ref: string): boolean {
  if (b.timestamp === ref || b.name.startsWith(ref)) return true;
  if (b.versionId === ref || ref.startsWith(b.versionId)) return true;
  try {
    return (JSON.parse(readFileSync(b.file, "utf8")) as Workflow).versionId === ref;
  } catch {
    return false;
  }
}

/** Pick which backup to restore: an explicit ref, else a TTY chooser, else latest. */
async function selectBackup(
  backups: BackupEntry[],
  { ref, interactive }: { ref?: string; interactive: boolean },
  log: Log,
): Promise<BackupEntry | null> {
  if (ref !== undefined) {
    const hit = backups.find((b) => matchesBackupRef(b, ref));
    if (!hit) throw new Error(`no backup matching "${ref}" in ${BACKUPS_DIR}/ — pass a timestamp or versionId from \`backup list\``);
    return hit;
  }
  const latest = backups.at(-1)!;
  if (!interactive || backups.length === 1) return latest;
  return promptBackup(backups, latest, log);
}

/** Minimal numbered TTY chooser (Enter = latest). */
async function promptBackup(backups: BackupEntry[], latest: BackupEntry, log: Log): Promise<BackupEntry | null> {
  log.info("choose a backup to restore (newest last):");
  backups.forEach((b, i) => {
    const marker = b === latest ? style.dim(" (latest, default)") : "";
    log.info(`  ${style.bold(String(i + 1))}. ${b.timestamp}  ${style.dim(b.versionId)}  ${nodeCount(b)} nodes${marker}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await new Promise<string>((resolve) => rl.question(`number [Enter for ${backups.length}]: `, resolve))).trim();
    if (answer === "") return latest;
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > backups.length) {
      log.warn(`"${answer}" isn't a listed number — aborting`);
      return null;
    }
    return backups[n - 1];
  } finally {
    rl.close();
  }
}

/** `backup list` — the retained backups: timestamp · versionId · node count. */
export function backupList(dir: string, log: Log, { json = false }: { json?: boolean } = {}): void {
  const backups = listBackups(dir);
  if (json) {
    console.log(JSON.stringify(backups.map((b) => ({ file: b.name, timestamp: b.timestamp, versionId: b.versionId, nodes: nodeCount(b) })), null, 2));
    return;
  }
  if (backups.length === 0) {
    log.info(`no backups in ${path.basename(dir)}/${BACKUPS_DIR}/ — run \`backup create\``);
    return;
  }
  for (const b of backups) {
    log.info(`${style.bold(b.timestamp)}  ${style.dim(b.versionId)}  ${nodeCount(b)} nodes  ${style.dim(b.name)}`);
  }
}
