import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Sync-dir manifest recording the `sha256:` of each template file *as copied*
 * by `init` (dpkg conffile-style baseline). Comparing this baseline against the
 * file currently on disk and the current template lets re-init tell a file the
 * user edited from a pristine one, so template improvements can be pulled in
 * without clobbering local changes. Git-tracked (shared across a team).
 */
export const MANIFEST_FILE = ".decanter-template.json";

export interface TemplateManifest {
  /** CLI version that last wrote the manifest (informational). */
  version: string;
  /** Materialized rel path (as it lands on disk) → `sha256:` at copy time. */
  files: Record<string, string>;
}

/** Tolerant read: a missing or corrupt manifest is an empty baseline. */
export function readManifest(dir: string): TemplateManifest {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Partial<TemplateManifest>;
    const files = raw.files && typeof raw.files === "object" ? raw.files : {};
    return { version: typeof raw.version === "string" ? raw.version : "0.0.0", files };
  } catch {
    return { version: "0.0.0", files: {} };
  }
}

export function writeManifest(dir: string, manifest: TemplateManifest): void {
  // sorted keys → stable, review-friendly diffs
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ version: manifest.version, files }, null, 2) + "\n");
}

/** True when a sync dir already has a manifest (i.e. this is a re-init). */
export function hasManifest(dir: string): boolean {
  return existsSync(path.join(dir, MANIFEST_FILE));
}

/**
 * What re-init should do with one template file, from three hashes:
 * - `added` — target absent → copy (first init, or a file new to the template).
 * - `uptodate` — pristine and the template is unchanged → nothing.
 * - `update` — pristine but the template changed → offer to refresh (confirm).
 * - `converged` — locally modified, but now byte-identical to the new template
 *   (the user independently matched it) → adopt the new baseline, no action.
 * - `drift-modified` — locally modified, template unchanged → report, never touch.
 * - `drift-conflict` — locally modified *and* the template changed → report,
 *   never touch (a real conflict).
 * - `adopt` — no baseline entry (a sync dir inited before manifests existed) and
 *   the file differs from the template → adopt the on-disk copy as the baseline
 *   silently; we cannot know its provenance, so we never offer to overwrite it.
 */
export type TemplateOutcome =
  | "added"
  | "uptodate"
  | "update"
  | "converged"
  | "drift-modified"
  | "drift-conflict"
  | "adopt";

export function classifyTemplateFile(input: {
  exists: boolean;
  targetHash?: string;
  templateHash: string;
  manifestHash?: string;
}): TemplateOutcome {
  const { exists, targetHash, templateHash, manifestHash } = input;
  if (!exists) return "added";
  if (manifestHash === undefined) return targetHash === templateHash ? "uptodate" : "adopt";
  const pristine = targetHash === manifestHash;
  if (templateHash === manifestHash) return pristine ? "uptodate" : "drift-modified";
  if (pristine) return "update";
  if (targetHash === templateHash) return "converged";
  return "drift-conflict";
}
