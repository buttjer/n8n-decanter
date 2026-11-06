// Plan 31 Task 7: the scaffolded agent permissions pre-approve
// `n8n-decanter node:*`, which would silently pre-approve `node run --unsafe`
// too. Both templates must route any command carrying `--unsafe` to an ASK.
//
// This checks the config's SHAPE against our own small glob matcher (`*` = any
// run of characters, anchored) — it never runs Claude Code or opencode. The
// real Claude Code matcher (2.1.316) was probed by hand on 2026-11-03: the
// `ask` rules beat the `node:*` allow wherever the flag sits and as
// `"--unsafe"`, while shell-quoted forms (`--un''safe`, `--un\safe`,
// `"--un"safe`) slip past — the residual risk the template AGENTS.md names.
// opencode's matcher was not probed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(PROJECT, rel), "utf8"));

/** Glob → anchored regex: `*` matches any run of characters, everything else is literal. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

const UNSAFE_COMMANDS = [
  "n8n-decanter node run x.js --unsafe",
  "npx n8n-decanter node run --unsafe x.js",
  "n8n-decanter node --unsafe run x.js",
];
const OPENCODE_ONLY = ["npx --no-install n8n-decanter node run x.js --unsafe"];
const SAFE_COMMAND = "n8n-decanter node run x.js";

describe("template/.claude/settings.json.example: --unsafe asks", () => {
  const settings = readJson("template/.claude/settings.json.example");
  const ask: unknown = settings.permissions?.ask;

  const askGlobs = (): string[] => {
    assert.ok(Array.isArray(ask), "permissions.ask must be an array");
    return (ask as unknown[])
      .filter((e): e is string => typeof e === "string")
      .map((e) => /^Bash\((.*)\)$/.exec(e)?.[1])
      .filter((g): g is string => g !== undefined);
  };

  it("keeps the node:* allow rules the ask rules have to beat", () => {
    const allow: string[] = settings.permissions.allow;
    assert.ok(allow.includes("Bash(n8n-decanter node:*)"));
    assert.ok(allow.includes("Bash(npx n8n-decanter node:*)"));
  });

  for (const cmd of UNSAFE_COMMANDS) {
    it(`asks for: ${cmd}`, () => {
      const globs = askGlobs();
      assert.ok(globs.some((g) => globToRegExp(g).test(cmd)), `no Bash(...) ask rule matches ${JSON.stringify(cmd)}: ${JSON.stringify(globs)}`);
    });
  }

  it(`does not ask for: ${SAFE_COMMAND}`, () => {
    const hits = askGlobs().filter((g) => globToRegExp(g).test(SAFE_COMMAND));
    assert.deepEqual(hits, []);
  });
});

describe("template/opencode.json.example: --unsafe asks", () => {
  const config = readJson("template/opencode.json.example");
  const bash: Record<string, unknown> = config.permission.bash;
  const keys = Object.keys(bash);

  // opencode lets a later pattern override an earlier one, so an ask entry
  // only counts when it sits after the catch-all "*": "allow".
  const askGlobs = (): string[] => {
    const star = keys.indexOf("*");
    assert.ok(star >= 0, 'permission.bash must keep its "*" entry');
    assert.equal(bash["*"], "allow");
    return keys.filter((k, i) => i > star && bash[k] === "ask");
  };

  for (const cmd of [...UNSAFE_COMMANDS, ...OPENCODE_ONLY]) {
    it(`asks for: ${cmd}`, () => {
      const globs = askGlobs();
      assert.ok(globs.some((g) => globToRegExp(g).test(cmd)), `no "ask" bash pattern after "*" matches ${JSON.stringify(cmd)}: ${JSON.stringify(globs)}`);
    });
  }

  it(`does not ask for: ${SAFE_COMMAND}`, () => {
    const hits = askGlobs().filter((g) => globToRegExp(g).test(SAFE_COMMAND));
    assert.deepEqual(hits, []);
  });
});
