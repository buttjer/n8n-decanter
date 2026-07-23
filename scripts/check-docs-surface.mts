#!/usr/bin/env node
// Docs-surface drift guardrail (Plan 40). A mechanical, offline CI check that
// proves the CLI's *command surface* is reflected across the three doc
// surfaces — the README `## Commands` table, the `docs/cli/*` pages, and
// `docs/cli/overview.md` — and that no doc/template ships a copy-paste-broken
// verb-last command. It catches the CROSS-PR drift the in-PR AGENTS.md rule
// can't: a behavior lands in one PR and its docs lag in another, and because
// they touch different files git merges both cleanly and flags nothing.
//
// STRUCTURAL, NOT SEMANTIC. This proves every verb has a home on each surface
// and that documented commands are runnable as written. It does NOT judge
// whether a flag's *prose* is current — that stays human/agent review (and the
// periodic audit that produced Plan 39). A green check means "no structural
// drift", never "docs are fully up to date".
//
// Source of truth: the verb sets are parsed straight from `n8n-decanter.mts`
// (regex over the `new Set([...])` literals — no import/execution), so the
// check self-updates when a verb is added or removed; the surfaces then have
// to follow or CI stays red, which is the point. The only thing a verb
// rename/retire must touch here beyond the CLI's own verb set is the small
// maintained map below (NAMESPACE_PAGES / SHARED_PAGES); forget it and the
// check fails loudly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── The maintained map (the only manual touch a verb change needs here) ──────
//
// Internal verbs with no user-facing doc page — skipped by the parity checks.
export const INTERNAL_VERBS = new Set(["help", "__complete"]);

// Namespaced verbs → the `docs/cli/*` page(s) that document them. The sub-verbs
// (`scenario create`/`check`, `backup create`/`restore`/`list`, `node run`,
// `mcp connect`/`serve`) share their parent's page(s).
export const NAMESPACE_PAGES: Record<string, string[]> = {
  node: ["node-run.md"],
  scenario: ["scenario.md"],
  backup: ["backup.md"],
  mcp: ["mcp-connect.md", "mcp-serve.md"],
};

// Verbs documented on another verb's page (no page of their own). The README
// and `docs/cli/publish.md` document "publish / unpublish" together.
export const SHARED_PAGES: Record<string, string> = {
  unpublish: "publish.md",
};

// `docs/cli/*` pages that map to no single verb — exempt from the reverse
// (page → verb) orphan check.
export const NON_VERB_PAGES = new Set(["overview.md"]);

// Known-intentional `n8n-decanter <non-verb> <verb>` occurrences the verb-last
// scan (check 5) must NOT flag. Keep this tiny; comment every entry. Key is
// "<repo-relative-file>::<bareTok1> <bareTok2>" so an exemption can never leak
// across files. A genuinely broken verb-last command anywhere else stays a
// hard failure.
export const VERB_LAST_EXEMPT = new Set([
  // overview.md teaches verb-first grammar by SHOWING the rejected verb-last
  // form (`n8n-decanter wf123 push` errors with *unknown verb*).
  "docs/cli/overview.md::wf123 push",
  // Completion-script header comments — prose ("the zsh/bash completion for
  // n8n-decanter"), not a runnable command.
  "n8n-decanter.mts::zsh completion",
  "n8n-decanter.mts::bash completion",
]);

// ── Verb-set parsing (regex over the CLI's `new Set([...])` literals) ────────

/** Parse a `const <name> = new Set([...])` string-literal set from CLI source. */
export function parseSet(source: string, name: string): string[] {
  const m = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  if (!m) throw new Error(`check-docs-surface: could not parse ${name} from n8n-decanter.mts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * The namespace names the CLI actually declares, derived from the
 * `const <NS>_VERBS = new Set(...)` sub-verb sets (lower-cased). Excludes the
 * top-level `VERBS` (no underscore, so it never matches) and `REF_VERBS` (a
 * behavioural subset of top-level verbs, not a namespace). Deriving this from
 * source — rather than hard-coding it — is what makes a NEW namespace fail the
 * map-consistency check loudly instead of slipping through undocumented.
 */
export function parseNamespaces(source: string): string[] {
  return [...source.matchAll(/const (\w+)_VERBS = new Set\(/g)]
    .map((m) => m[1])
    .filter((n) => n !== "REF")
    .map((n) => n.toLowerCase());
}

export type VerbModel = {
  /** User-facing top-level verbs (VERBS minus INTERNAL_VERBS). */
  userVerbs: string[];
  /** Every top-level verb, incl. internal — the legal leading-token set. */
  allTopVerbs: Set<string>;
  /** Declared namespaces (node/scenario/backup/mcp). */
  namespaces: string[];
};

export function buildVerbModel(cliSource: string): VerbModel {
  const allTop = parseSet(cliSource, "VERBS");
  return {
    userVerbs: allTop.filter((v) => !INTERNAL_VERBS.has(v)),
    allTopVerbs: new Set(allTop),
    namespaces: parseNamespaces(cliSource),
  };
}

/** The `docs/cli/*` page(s) that must document a given user-facing verb. */
export function expectedPagesForVerb(verb: string): string[] {
  if (verb in NAMESPACE_PAGES) return NAMESPACE_PAGES[verb];
  if (verb in SHARED_PAGES) return [SHARED_PAGES[verb]];
  return [`${verb}.md`];
}

// ── The checks (pure over provided content — driven by unit tests) ───────────

export type Violation = { check: string; message: string };

/**
 * Map consistency: every declared namespace must have a page mapping, and no
 * map entry may point at a retired verb. This is the guardrail that makes the
 * maintained map self-policing — add a namespace verb and forget the map, and
 * this fails with the exact fix.
 */
export function checkMapConsistency(model: VerbModel): Violation[] {
  const out: Violation[] = [];
  for (const ns of model.namespaces) {
    if (!(ns in NAMESPACE_PAGES)) {
      out.push({
        check: "map",
        message: `namespace '${ns}' (from ${ns.toUpperCase()}_VERBS) has no NAMESPACE_PAGES entry — add one in scripts/check-docs-surface.mts`,
      });
    }
  }
  for (const verb of [...Object.keys(NAMESPACE_PAGES), ...Object.keys(SHARED_PAGES)]) {
    if (!model.allTopVerbs.has(verb)) {
      out.push({
        check: "map",
        message: `map entry '${verb}' is not a current verb — remove it from scripts/check-docs-surface.mts`,
      });
    }
  }
  return out;
}

/** Check 1 — every user-facing verb has its `docs/cli/*` page(s). */
export function checkVerbToPage(model: VerbModel, actualPages: Set<string>): Violation[] {
  const out: Violation[] = [];
  for (const verb of model.userVerbs) {
    for (const page of expectedPagesForVerb(verb)) {
      if (!actualPages.has(page)) {
        out.push({ check: "verb→page", message: `verb '${verb}' has no docs/cli/${page}` });
      }
    }
  }
  return out;
}

/** Check 2 — every `docs/cli/*.md` page maps back to a live verb (no orphans). */
export function checkPageToVerb(model: VerbModel, actualPages: Set<string>): Violation[] {
  const claimed = new Set<string>(NON_VERB_PAGES);
  for (const verb of model.userVerbs) for (const p of expectedPagesForVerb(verb)) claimed.add(p);
  const out: Violation[] = [];
  for (const page of actualPages) {
    if (!claimed.has(page)) {
      out.push({
        check: "page→verb",
        message: `docs/cli/${page} maps to no live verb — orphan page (retired verb?); remove it`,
      });
    }
  }
  return out;
}

/** All backtick-delimited code spans on a line. */
function codeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** The `## Commands` section of the README (up to the next `## ` heading). */
export function readmeCommandsSection(readme: string): string {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => /^##\s+Commands\b/.test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Check 3 — every user-facing verb has a row in the README `## Commands` table.
 * A verb is present iff some code span in that section leads with it (the span
 * equals the verb or starts with "<verb> ") — matching the first column's
 * `` `push [workflow…]` `` / `` `scenario create` `` / `` `unpublish …` `` cells
 * without false-matching a verb name buried mid-description.
 */
export function checkVerbInReadme(model: VerbModel, readme: string): Violation[] {
  const section = readmeCommandsSection(readme);
  const spans = section.split("\n").flatMap(codeSpans);
  const present = (verb: string) => spans.some((s) => s === verb || s.startsWith(`${verb} `));
  const out: Violation[] = [];
  for (const verb of model.userVerbs) {
    if (!present(verb)) {
      out.push({ check: "verb→README", message: `verb '${verb}' has no row in the README ## Commands table` });
    }
  }
  return out;
}

/** Check 4 — every user-facing verb is listed in `docs/cli/overview.md`. */
export function checkVerbInOverview(model: VerbModel, overview: string): Violation[] {
  const out: Violation[] = [];
  for (const verb of model.userVerbs) {
    const re = new RegExp(`n8n-decanter\\s+${verb.replace(/[-]/g, "\\$&")}(?![\\w-])`);
    if (!re.test(overview)) {
      out.push({ check: "verb→overview", message: `verb '${verb}' is not listed in docs/cli/overview.md` });
    }
  }
  return out;
}

// ── Check 5 — verb-last command scan ─────────────────────────────────────────

/** Strip wrapping punctuation, keeping inner word chars + dashes; lower-case. */
function bareToken(t: string): string {
  return t.replace(/^[^A-Za-z0-9-]+/, "").replace(/[^A-Za-z0-9-]+$/, "").toLowerCase();
}

export type ScanInput = { file: string; text: string };

/**
 * Check 5 — flag copy-paste-broken verb-last commands (the Plan 39 bug class).
 * Scan for `n8n-decanter <tok1> <tok2>` where tok2 is a known top-level verb
 * and tok1 is NOT (a verb, or a `-`/`--`flag). The CLI is strictly verb-first,
 * so `n8n-decanter <workflow> push` / `n8n-decanter wf scenario` fail with
 * *unknown verb* when followed — while the correct `n8n-decanter push <wf>`
 * passes because tok1 (`push`) is a verb, and `n8n-decanter scenario create`
 * passes because tok2 (`create`) is not a top-level verb. Placeholders
 * (`<workflow>`, `"<name>"`, `$VAR`, real slugs) in tok1 are exactly the bug.
 */
export function scanVerbLast(inputs: ScanInput[], model: VerbModel): Violation[] {
  const out: Violation[] = [];
  for (const { file, text } of inputs) {
    const lines = text.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      const tokens = lines[ln].split(/\s+/);
      for (let i = 0; i < tokens.length - 2; i++) {
        if (bareToken(tokens[i]) !== "n8n-decanter") continue;
        // Skip JSON/config string values (`"command": "n8n-decanter", "args":
        // ["mcp", "connect"]`) — a self-quoted program name is never a shell
        // command head; real copy-paste commands live in code fences/inline
        // code, where the program name isn't individually double-quoted.
        if (/"n8n-decanter"/.test(tokens[i])) continue;
        const rawTok1 = tokens[i + 1];
        const tok1 = bareToken(rawTok1);
        const tok2 = bareToken(tokens[i + 2]);
        if (!model.allTopVerbs.has(tok2)) continue; // tok2 must be a real leading verb
        if (rawTok1.startsWith("-")) continue; // a global flag may precede the verb
        if (model.allTopVerbs.has(tok1)) continue; // verb-first — correct, tok2 is just an arg
        if (VERB_LAST_EXEMPT.has(`${file}::${tok1} ${tok2}`)) continue; // intentional / prose
        out.push({
          check: "verb-last",
          message: `${file}:${ln + 1} — 'n8n-decanter ${tok1} ${tok2}' is verb-last (rejected as *unknown verb*); write it verb-first: 'n8n-decanter ${tok2} ${tok1}'`,
        });
      }
    }
  }
  return out;
}

// ── I/O + orchestration (not unit-tested; drives the pure checks above) ───────

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const rel = (p: string) => path.relative(REPO_ROOT, p);
const read = (p: string) => fs.readFileSync(p, "utf8");

/** Text files to feed the verb-last scan: docs/**, template/**, CLI source. */
function scanInputs(): ScanInput[] {
  const files = [
    ...walk(path.join(REPO_ROOT, "docs")).filter((f) => f.endsWith(".md")),
    ...walk(path.join(REPO_ROOT, "template")),
    path.join(REPO_ROOT, "n8n-decanter.mts"),
    ...walk(path.join(REPO_ROOT, "lib")).filter((f) => f.endsWith(".mts")),
  ];
  return files
    .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile())
    .map((f) => ({ file: rel(f), text: read(f) }));
}

function main(): number {
  const cliSource = read(path.join(REPO_ROOT, "n8n-decanter.mts"));
  const model = buildVerbModel(cliSource);
  const actualPages = new Set(
    fs
      .readdirSync(path.join(REPO_ROOT, "docs", "cli"))
      .filter((f) => f.endsWith(".md")),
  );
  const readme = read(path.join(REPO_ROOT, "README.md"));
  const overview = read(path.join(REPO_ROOT, "docs", "cli", "overview.md"));

  const violations: Violation[] = [
    ...checkMapConsistency(model),
    ...checkVerbToPage(model, actualPages),
    ...checkPageToVerb(model, actualPages),
    ...checkVerbInReadme(model, readme),
    ...checkVerbInOverview(model, overview),
    ...scanVerbLast(scanInputs(), model),
  ];

  if (violations.length === 0) {
    console.log(
      `check:docs — clean (${model.userVerbs.length} verbs; structural surface parity + verb-first grammar OK).`,
    );
    return 0;
  }

  const byCheck = new Map<string, Violation[]>();
  for (const v of violations) (byCheck.get(v.check) ?? byCheck.set(v.check, []).get(v.check)!).push(v);
  console.error(`check:docs — ${violations.length} violation(s):\n`);
  for (const [check, vs] of byCheck) {
    console.error(`  [${check}]`);
    for (const v of vs) console.error(`    - ${v.message}`);
    console.error("");
  }
  console.error(
    "This is a STRUCTURAL check (verb surface + grammar); a clean run does not\n" +
      "mean the docs' prose is current. Fix the above, or update the maintained\n" +
      "map in scripts/check-docs-surface.mts if a verb was renamed/retired.",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
