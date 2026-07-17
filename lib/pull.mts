import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { commitWorkflowDir } from "./git.mts";
import { findWorkflowDir, readState, writeState } from "./state.mts";
import {
  FILE_PLACEHOLDER_PREFIX,
  isJsCodeNode,
  sanitizeFilename,
  sha256,
  splitMarker,
  stableWorkflowJson,
  workflowStructureHash,
} from "./util.mts";

function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  writeFileSync(file, content);
  return true;
}

/** Locate/create the workflow folder, renaming it if the workflow was renamed. */
function ensureWorkflowDir(root, wf, log) {
  const wanted = sanitizeFilename(wf.name);
  const existing = findWorkflowDir(root, wf.id);
  if (!existing) {
    const dir = path.join(root, wanted);
    mkdirSync(dir, { recursive: true });
    return { dir };
  }
  if (path.basename(existing) !== wanted) {
    const target = path.join(path.dirname(existing), wanted);
    if (existsSync(target)) {
      log.warn(`workflow renamed to "${wf.name}" but ${target} already exists — keeping ${existing}`);
      return { dir: existing };
    }
    renameSync(existing, target);
    log.info(`renamed folder ${path.basename(existing)}/ -> ${wanted}/`);
    return { dir: target, previousDir: existing };
  }
  return { dir: existing };
}

/** Pick/refresh the file name for a node, renaming existing files on node rename. */
function resolveNodeFile(dir, nodeState, node, ext, usedNames, log) {
  let base = sanitizeFilename(node.name);
  if (usedNames.has(base.toLowerCase())) base = `${base}-${node.id.slice(0, 8)}`;
  usedNames.add(base.toLowerCase());
  const wanted = base + ext;
  const current = nodeState.file;
  if (current && current !== wanted) {
    // Rename on node rename, but never across extensions (.js -> .ts would
    // silently declare compiled JS to be TS source).
    const renames = [[current.replace(/\.(ts|js)$/, ".remote.js"), base + ".remote.js"]];
    if (path.extname(current) === ext) renames.push([current, wanted]);
    for (const [from, to] of renames) {
      const fromPath = path.join(dir, from);
      const toPath = path.join(dir, to);
      if (from !== to && existsSync(fromPath) && !existsSync(toPath)) {
        renameSync(fromPath, toPath);
        log.info(`renamed ${from} -> ${to}`);
      }
    }
  }
  return { file: wanted, base };
}

export async function pullWorkflow(api, root, id, { commitOnPull = false } = {}, log) {
  const wf = await api.getWorkflow(id);
  const { dir, previousDir } = ensureWorkflowDir(root, wf, log);
  const state = readState(dir) ?? { workflowId: wf.id, nodes: {} };
  state.workflowId = wf.id;
  state.nodes ??= {};
  const usedNames = new Set();
  const placeholders = new Map(); // node id -> file name

  for (const node of wf.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id] ?? {};
    const remote = node.parameters.jsCode;
    const { body: remoteBody, markerHash } = splitMarker(remote);
    const remoteHash = sha256(remoteBody);
    const tsManaged = markerHash !== null;

    const { file, base } = resolveNodeFile(dir, nodeState, node, tsManaged ? ".ts" : ".js", usedNames, log);
    const filePath = path.join(dir, file);
    const remoteJsFile = path.join(dir, base + ".remote.js");

    if (tsManaged) {
      if (!existsSync(filePath)) {
        writeFileSync(remoteJsFile, remoteBody);
        log.warn(`${wf.name} / ${node.name}: TS-managed on remote but no local ${file} — compiled code saved to ${base}.remote.js`);
      } else {
        const compiled = await compileTs(filePath);
        const localHash = sha256(compiled);
        if (localHash === remoteHash) {
          if (existsSync(remoteJsFile)) {
            rmSync(remoteJsFile);
            log.info(`${node.name}: in sync, removed stale ${base}.remote.js`);
          }
        } else if (localHash === nodeState.lastPushedHash) {
          writeFileSync(remoteJsFile, remoteBody);
          log.warn(`${wf.name} / ${node.name}: edited in the n8n UI since last push — remote code saved to ${base}.remote.js; port it into ${file} manually`);
        } else if (remoteHash === nodeState.lastPushedHash) {
          log.info(`${node.name}: local ${file} modified, not yet pushed`);
        } else {
          writeFileSync(remoteJsFile, remoteBody);
          log.warn(`${wf.name} / ${node.name}: CONFLICT — both ${file} and the remote code changed since last sync. Remote saved to ${base}.remote.js; reconcile manually before pushing`);
        }
      }
    } else if (nodeState.file?.endsWith(".ts") || existsSync(path.join(dir, base + ".ts"))) {
      // Local .ts exists but remote carries no marker: never clobber TS source
      // and don't drop a competing .js next to it.
      writeFileSync(remoteJsFile, remoteBody);
      log.warn(`${wf.name} / ${node.name}: local ${base}.ts exists but remote code has no @ts-n8n marker (not pushed from TS yet?) — remote saved to ${base}.remote.js`);
      placeholders.set(node.id, nodeState.file ?? base + ".ts");
      state.nodes[node.id] = { ...nodeState, file: nodeState.file ?? base + ".ts", lastPushedHash: remoteHash };
      continue;
    } else {
      if (writeIfChanged(filePath, remoteBody)) log.info(`wrote ${path.basename(dir)}/${file}`);
    }

    placeholders.set(node.id, file);
    state.nodes[node.id] = { ...nodeState, file, lastPushedHash: remoteHash };
  }

  // Drop state for nodes that no longer exist remotely (files stay; git is the safety net).
  const liveIds = new Set(wf.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(state.nodes)) {
    if (!liveIds.has(nodeId)) {
      log.warn(`node ${nodeId} ("${state.nodes[nodeId].file}") no longer exists remotely — removing from state, delete the file manually if unwanted`);
      delete state.nodes[nodeId];
    }
  }

  const wfOut = structuredClone(wf);
  for (const node of wfOut.nodes) {
    const file = placeholders.get(node.id);
    if (file) node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + file;
  }
  if (writeIfChanged(path.join(dir, "workflow.json"), stableWorkflowJson(wfOut))) {
    log.info(`wrote ${path.basename(dir)}/workflow.json`);
  }

  state.lastPulledWorkflowHash = workflowStructureHash(wf);
  writeState(dir, state);
  if (commitOnPull) {
    const extras = previousDir ? [path.relative(dir, previousDir)] : [];
    await commitWorkflowDir(dir, `decanter: pulled "${wf.name}" (${id})`, log, extras);
  }
  return { dir, name: wf.name };
}
