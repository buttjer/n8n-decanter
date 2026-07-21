// Unit tests for the offline bits of lib/datatables.mts (slug + clean).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanDataTables, DATA_TABLES_DIR, dataTableSlug } from "../../lib/datatables.mts";
import type { Log } from "../../lib/types.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-datatables-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

describe("dataTableSlug", () => {
  it("kebabs the name and appends the id for uniqueness", () => {
    assert.equal(dataTableSlug(42, "Orders"), "orders-42");
    assert.equal(dataTableSlug("7", "Customer Emails"), "customer-emails-7");
  });

  it("disambiguates same-named tables by their differing ids", () => {
    assert.notEqual(dataTableSlug(1, "Orders"), dataTableSlug(2, "Orders"));
  });

  it("strips non-alphanumerics from the id and survives an empty name", () => {
    assert.equal(dataTableSlug("ab-cd_12", "Table"), "table-abcd12");
    assert.match(dataTableSlug("", ""), /^unnamed-id$/);
  });
});

describe("cleanDataTables", () => {
  it("removes the data-tables/ dir and reports it", () => {
    const dir = path.join(TMP, "with-dir");
    const dt = path.join(dir, DATA_TABLES_DIR, "orders-1");
    mkdirSync(dt, { recursive: true });
    writeFileSync(path.join(dt, "rows.json"), "[]\n");
    const { log, lines } = capturingLog();
    cleanDataTables(dir, log);
    assert.ok(!existsSync(path.join(dir, DATA_TABLES_DIR)));
    assert.ok(lines.some((l) => l.startsWith("ok ") && l.includes("removed")));
  });

  it("is a friendly no-op when nothing was fetched", () => {
    const dir = path.join(TMP, "empty");
    mkdirSync(dir, { recursive: true });
    const { log, lines } = capturingLog();
    cleanDataTables(dir, log);
    assert.deepEqual(lines, ["info no data-tables/ dir to clean"]);
  });
});
