// Unit tests for the modification-aware template refresh core (lib/template.mts):
// the classification table (the heart of the feature) and manifest I/O.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { classifyTemplateFile, MANIFEST_FILE, readManifest, writeManifest } from "../../lib/template.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-template-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const A = "sha256:aaa"; // baseline / template-at-copy-time
const B = "sha256:bbb"; // a different content
const C = "sha256:ccc"; // a third, distinct content

describe("classifyTemplateFile", () => {
  it("added — target does not exist", () => {
    assert.equal(classifyTemplateFile({ exists: false, templateHash: A }), "added");
    // absent target wins even if a stale manifest entry lingers
    assert.equal(classifyTemplateFile({ exists: false, templateHash: A, manifestHash: A }), "added");
  });

  it("uptodate — pristine and template unchanged", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: A, templateHash: A, manifestHash: A }), "uptodate");
  });

  it("update — pristine but the template changed", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: A, templateHash: B, manifestHash: A }), "update");
  });

  it("converged — locally modified but now identical to the new template", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: B, templateHash: B, manifestHash: A }), "converged");
  });

  it("drift-modified — locally modified, template unchanged", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: B, templateHash: A, manifestHash: A }), "drift-modified");
  });

  it("drift-conflict — locally modified AND template changed (three distinct hashes)", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: B, templateHash: C, manifestHash: A }), "drift-conflict");
  });

  it("no baseline entry: identical to template => uptodate, otherwise adopt", () => {
    assert.equal(classifyTemplateFile({ exists: true, targetHash: A, templateHash: A }), "uptodate");
    assert.equal(classifyTemplateFile({ exists: true, targetHash: B, templateHash: A }), "adopt");
  });
});

describe("manifest I/O", () => {
  it("round-trips and sorts file keys", () => {
    const dir = mkdtempSync(path.join(TMP, "rt-"));
    writeManifest(dir, { version: "1.2.3", files: { "z.txt": B, "a.txt": A } });
    const read = readManifest(dir);
    assert.equal(read.version, "1.2.3");
    assert.deepEqual(read.files, { "a.txt": A, "z.txt": B });
    assert.deepEqual(Object.keys(read.files), ["a.txt", "z.txt"], "keys must be sorted for stable diffs");
  });

  it("missing manifest reads as an empty baseline", () => {
    const dir = mkdtempSync(path.join(TMP, "missing-"));
    assert.deepEqual(readManifest(dir), { version: "0.0.0", files: {} });
  });

  it("corrupt manifest reads as an empty baseline (tolerant, like parseEnvFile)", () => {
    const dir = mkdtempSync(path.join(TMP, "corrupt-"));
    writeFileSync(path.join(dir, MANIFEST_FILE), "{ not json");
    assert.deepEqual(readManifest(dir), { version: "0.0.0", files: {} });
  });

  it("tolerates a manifest missing the files object", () => {
    const dir = mkdtempSync(path.join(TMP, "partial-"));
    writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ version: "9.9.9" }));
    const read = readManifest(dir);
    assert.equal(read.version, "9.9.9");
    assert.deepEqual(read.files, {});
  });
});
