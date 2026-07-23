#!/usr/bin/env node
// Plan 43, Task 5 — n8n-globals drift audit (READ-ONLY, license-clean).
//
// decanter ships its OWN hand-written, MIT-clean `n8n-globals.d.ts` — a
// pragmatic subset of the Code-node global surface. n8n's authoritative surface
// (`WorkflowDataProxy.getDataProxy()` + `getAdditionalKeys` + the Code node's
// sandbox context) is Sustainable-Use-Licensed, so we may NOT extract-and-ship
// its text. This tool only reads that source at a pinned tag to compare the
// *set of global names* and flag ones n8n has that decanter doesn't declare (a
// drift signal to review by hand) — no source text is copied. Names/facts are
// not the thing SUL protects; the .d.ts stays decanter's own paraphrase.
//
// Not part of `npm test` (it hits the network). Run on demand — Housekeeping
// step 7. `--strict` exits non-zero when a NEW (non-known-omitted) global drifts
// in, so it can gate CI if ever wired up.
//
//   node scripts/globals-drift-audit.mts [--tag=n8n@2.30.7] [--strict]

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const TAG = (args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) ?? process.env.N8N_TAG ?? "n8n@2.30.7").trim();

const RAW = (p: string) => `https://raw.githubusercontent.com/n8n-io/n8n/${TAG}/${p}`;

/** Fetch the first candidate path that exists (paths drift across n8n versions). */
async function fetchFirst(candidates: string[]): Promise<string> {
  for (const p of candidates) {
    const res = await fetch(RAW(p));
    if (res.ok) return await res.text();
  }
  throw new Error(`none of these paths resolved at ${TAG}:\n  ${candidates.join("\n  ")}`);
}

/** Names matching `$foo:` object keys inside a source slice (n8n uses tab
 * indent). `\$[\w$]*` captures the bare `$:` node-accessor key too. */
function objectKeyGlobals(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^[ \t]+(\$[\w$]*)\s*:/gm)) names.add(m[1]);
  return names;
}

/** decanter's declared value-globals (same extraction as the parity test). */
function decanterDeclared(): Set<string> {
  const dts = readFileSync(path.join(ROOT, "n8n-globals.d.ts"), "utf8");
  const names = new Set<string>();
  for (const m of dts.matchAll(/^(?:export )?declare (?:const|let|var|function|class) (\$[\w$]*|[A-Za-z_][\w$]*)/gm)) names.add(m[1]);
  return names;
}

// The pragmatic-subset boundary: n8n globals decanter *deliberately* omits
// (rare/legacy/agent-only/instance-internal). Listed so the audit surfaces only
// genuinely NEW globals, not the known omissions. Reviewed 2026-07-23 @ n8n@2.30.7.
const KNOWN_OMITTED = new Set([
  "$data", "$self", "$parameter", "$rawParameter", "$mode", "$position",
  "$thisItem", "$thisItemIndex", "$thisRunIndex", "$fromAI", "$fromai", "$fromAi",
  "$tool", "$agentInfo", "$getPairedItem", "$item", "$evaluation", "$executionId",
  "$resumeWebhookUrl", "$getNodeParameter",
]);

async function main(): Promise<number> {
  let proxySrc: string;
  let addlSrc: string;
  try {
    proxySrc = await fetchFirst(["packages/workflow/src/workflow-data-proxy.ts"]);
    addlSrc = await fetchFirst([
      "packages/core/src/execution-engine/node-execution-context/utils/get-additional-keys.ts",
      "packages/core/src/NodeExecuteFunctions.ts",
    ]);
  } catch (err) {
    console.error(`globals-drift-audit: could not read n8n source (${(err as Error).message})`);
    return 2; // network/path failure — distinct from a real drift finding
  }

  // The base object of getDataProxy(): from `const base = {` to its close.
  const baseStart = proxySrc.indexOf("const base = {");
  const baseSlice = baseStart >= 0 ? proxySrc.slice(baseStart) : proxySrc;
  const authoritative = objectKeyGlobals(baseSlice);
  for (const n of objectKeyGlobals(addlSrc)) authoritative.add(n);
  // Sandbox-injected (Code/Sandbox.ts) + always-present, not in the proxy base:
  authoritative.add("$getWorkflowStaticData");
  authoritative.add("console");

  const declared = decanterDeclared();

  const undeclared = [...authoritative].filter((n) => !declared.has(n)).sort();
  const newlyDrifted = undeclared.filter((n) => !KNOWN_OMITTED.has(n));
  const knownOmitted = undeclared.filter((n) => KNOWN_OMITTED.has(n));
  // decanter declares it but n8n's Code-node surface (as parsed) doesn't mention
  // it — either an over-declaration (like the removed $if/$min/$max) or a name we
  // emulate that isn't a proxy key (Luxon classes, our own aliases).
  const IGNORE_EXTRA = new Set(["DateTime", "Duration", "Interval", "$jmesPath"]);
  const extra = [...declared].filter((n) => !authoritative.has(n) && !IGNORE_EXTRA.has(n)).sort();

  console.log(`n8n-globals drift audit — n8n source @ ${TAG}`);
  console.log(`  authoritative Code-node globals: ${authoritative.size}   decanter declares: ${declared.size}`);
  console.log("");
  if (newlyDrifted.length) {
    console.log("⚠ NEW globals in n8n that decanter does NOT declare (review — declare, emulate, or add to KNOWN_OMITTED):");
    for (const n of newlyDrifted) console.log(`    ${n}`);
  } else {
    console.log("✓ no new/undeclared globals beyond the known-omitted subset");
  }
  if (extra.length) {
    console.log("");
    console.log("⚠ decanter declares these but they are NOT in n8n's parsed Code-node surface (possible over-declaration):");
    for (const n of extra) console.log(`    ${n}`);
  }
  console.log("");
  console.log(`(known-omitted, intentionally not declared: ${knownOmitted.length ? knownOmitted.join(", ") : "none"})`);

  const drift = newlyDrifted.length > 0 || extra.length > 0;
  if (drift && strict) return 1;
  return 0;
}

process.exit(await main());
