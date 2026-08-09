# Plan 79 — Shared code lives anywhere in the sync dir (draft: verify the findings first)

**Status:** Draft — **findings unverified by the maintainer; reproduce before graduating**
**Priority:** P1 if the findings hold (small, offline, clearly-right)
**Source:** User question 2026-08-09 — *"Ist es möglich den Pfad zum shared
Ordner zu verändern oder sogar mehrere zu haben?"* — plus the follow-up *"wie
verhält sich das bei 2 gleichnamigen Dateien aus 2 Ordnern?"*
**Snapshot:** 2026-08-09T12:10Z @ 59079bb
**Theme:** Renaming `shared/` and having several shared roots appears to **work
already** — nothing in the CLI hardcodes the name. This draft writes the claim
down as individually checkable findings, with a one-command reproduction, so it
can be believed (or refuted) before any code is touched.
**Model:** Opus to adjudicate the findings; Sonnet for the docs breadth once
they hold

`shared/` looks like a *scaffolding convention*, not a data-model element: the
only rule `push` appears to enforce is that a relative import resolves **inside
the sync dir**. If that holds, any folder name, any number of folders, and
per-workflow helper dirs all work today — undocumented, and with `preflight`'s
typecheck blind to every one of them (including `shared/` itself). This file is
**evidence first, scope second**: the findings and their reproduction come
before the task list, and the task list is contingent on them.

> **Why this is longer than a draft should be.** The bulk is *evidence*, not
> scope — it exists so the claims can be checked rather than trusted. Once the
> findings are confirmed, the evidence collapses into a `## Why` and the file
> graduates to `open/`.

## Reproduction — one command

Offline, no n8n instance, no Docker, nothing installed. Creates a throwaway sync
dir and prints each check next to what it should print. Save it anywhere and run
it with the repo path as its only argument:

```sh
bash /tmp/repro79.sh ~/Projects/n8n-decanter
```

Deliberately kept inline rather than committed as a script — it verifies a
draft, and `plans/` holds status dirs only.

```bash
#!/usr/bin/env bash
# Plan 79 reproduction — verifies every finding from scratch, offline, no n8n.
set -u
REPO="${1:?usage: repro79.sh <path-to-n8n-decanter-repo>}"
CLI="node $REPO/n8n-decanter.mts"
W="$(mktemp -d "${TMPDIR:-/tmp}/repro79.XXXXXX")" || exit 1
[ -n "$W" ] && cd "$W" || { echo "could not create a scratch dir"; exit 1; }
echo "# scratch sync dir: $W"

mkdir -p helpers domain/money workflows/wf1/code workflows/wf1/local
cp "$REPO/n8n-globals.d.ts" .
printf '{\n  "root": "./workflows",\n  "workflows": ["wf1"]\n}\n' > decanter.config.json

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "preserve", "moduleResolution": "bundler",
    "lib": ["ES2022"], "allowJs": true, "checkJs": true, "noEmit": true,
    "strict": true, "noImplicitAny": false, "useUnknownInCatchVariables": false,
    "skipLibCheck": true, "moduleDetection": "force", "esModuleInterop": true
  },
  "include": ["n8n-globals.d.ts", "shared/**/*.ts", "shared/**/*.js", "workflows/**/*.ts", "workflows/**/*.js"],
  "exclude": ["node_modules", "**/*.remote.js"]
}
JSON

cat > workflows/wf1/workflow.json <<'JSON'
{
  "id": "wf1", "name": "Probe",
  "nodes": [
    { "id": "n1", "name": "Manual Trigger", "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1, "position": [0,0], "parameters": {} },
    { "id": "n2", "name": "Compute", "type": "n8n-nodes-base.code",
      "typeVersion": 2, "position": [200,0],
      "parameters": { "mode": "runOnceForAllItems", "language": "javaScript",
                      "jsCode": "//@file:code/compute.ts" } }
  ],
  "connections": { "Manual Trigger": { "main": [[{ "node": "Compute", "type": "main", "index": 0 }]] } },
  "settings": {}
}
JSON
cat > workflows/wf1/.decanter.json <<'JSON'
{ "workflowId": "wf1", "name": "Probe", "nodes": { "n2": { "file": "code/compute.ts", "name": "Compute" } } }
JSON
printf '{ "input": [ { "json": { "qty": 2, "price": 3 } }, { "json": { "qty": 1, "price": 4.5 } } ] }\n' > fixture.json

printf 'export function shout(s: string): string { return s.toUpperCase() + "!"; }\n' > helpers/strings.ts
printf 'export interface Line { qty: number; price: number }\nexport function total(l: Line[]): number { return l.reduce((s, x) => s + x.qty * x.price, 0); }\n' > domain/money/total.ts
printf 'export const TAG = "wf1-local";\n' > workflows/wf1/local/tag.ts

hdr() { printf '\n=== %s\n' "$1"; }

hdr "F0  three differently-named roots at once (renamed / nested / per-workflow)"
cat > workflows/wf1/code/compute.ts <<'TS'
import { shout } from "../../../helpers/strings";
import { total, type Line } from "../../../domain/money/total";
import { TAG } from "../local/tag";
const lines: Line[] = $input.all().map((i) => ({ qty: Number(i.json.qty), price: Number(i.json.price) }));
return [{ json: { total: total(lines), label: shout("sum"), tag: TAG } }];
TS
$CLI node run workflows/wf1/code/compute.ts fixture.json | tail -8
echo "--> expect: total 10.5, label SUM!, tag wf1-local"
$CLI preflight wf1 --offline --no-typecheck 2>&1 | sed -n '2p'
echo "--> expect: layout compliant (the per-workflow local/ dir does not trip the orphan scan)"

hdr "F0b escaping the sync dir is still a hard error"
mkdir -p ../outside-probe && printf 'export const X = 1;\n' > ../outside-probe/x.ts
printf 'import { X } from "../../../../outside-probe/x";\nreturn [{ json: { X } }];\n' > workflows/wf1/code/compute.ts
$CLI preflight wf1 --offline --no-typecheck 2>&1 | sed -n '2p'
echo "--> expect: layout violation, 'resolves outside the sync dir'"

hdr "F1  preflight's types tier is blind to shared code (push is not)"
mkdir -p shared
printf 'export function shout(s: string): string {\n  const broken: number = "not a number";\n  return s.toUpperCase() + broken;\n}\n' > shared/strings.ts
printf 'import { shout } from "../../../shared/strings";\nreturn [{ json: { s: shout("x") } }];\n' > workflows/wf1/code/compute.ts
echo "-- unscoped (what push runs):"
(cd "$W" && node "$REPO/scripts/typecheck.mts" 2>&1 | head -3)
echo "-- scoped to the workflow dir (what preflight runs):"
$CLI preflight wf1 --offline 2>&1 | sed -n '3p'
echo "--> expect: unscoped REPORTS shared/strings.ts TS2322, preflight says 'node files typecheck clean'"

hdr "F2  the documented import depth does not resolve"
printf 'export const total = (l: any[]) => l.length;\n' > shared/money.ts
printf 'import { total } from "../../shared/money";\nreturn [{ json: { n: total($input.all()) } }];\n' > workflows/wf1/code/compute.ts
$CLI node run workflows/wf1/code/compute.ts 2>&1 | tail -2
echo "--> expect: Could not resolve \"../../shared/money\"  (docs say ../../ ; correct is ../../../)"

hdr "F4  two same-named files, SAME binding name, unaliased -> silently last-wins"
printf 'export interface Line { qty: number; price: number }\nexport function total(l: Line[]): number { return l.reduce((s, x) => s + x.qty * x.price, 0); }\n' > shared/money.ts
printf 'export function total(l: any[]): number { return l.length; }\n' > domain/money.ts
cat > workflows/wf1/code/compute.ts <<'TS'
import { total } from "../../../shared/money";
import { total } from "../../../domain/money";
return [{ json: { a: total($input.all() as any), b: total($input.all() as any) } }];
TS
$CLI node run workflows/wf1/code/compute.ts fixture.json 2>&1 | tail -6
echo "--> expect: a=2 AND b=2 — the SECOND import silently won (shared would give 10.5)"
$CLI preflight wf1 --offline 2>&1 | sed -n '3p'
echo "--> expect: types FAILS with TS2300 Duplicate identifier — the typecheck is the only thing that catches it"

hdr "F5  two same-named files, aliased -> both bundle side by side"
cat > workflows/wf1/code/compute.ts <<'TS'
import { total as orderTotal, type Line } from "../../../shared/money";
import { total as countTotal } from "../../../domain/money";
const lines: Line[] = $input.all().map((i) => ({ qty: Number(i.json.qty), price: Number(i.json.price) }));
return [{ json: { sum: orderTotal(lines), count: countTotal(lines) } }];
TS
$CLI node run workflows/wf1/code/compute.ts fixture.json 2>&1 | tail -7
echo "--> expect: sum 10.5 AND count 2 — distinct modules, esbuild renames the clash to total/total2"
$CLI preflight wf1 --offline 2>&1 | sed -n '2,3p'
echo "--> expect: layout compliant + types clean"

printf '\n# scratch dir left in place for inspection: %s\n' "$W"
```

## Findings — each one separately checkable

Every row was produced by the script above against the CLI at `59079bb`.
"Derived" means read out of the code, not separately reproduced.

| # | Claim | Status |
| --- | --- | --- |
| F0 | A renamed root, a second nested root, and a per-workflow helper dir all bundle — in one node, at once | reproduced |
| F0b | An import escaping the sync dir is still a hard layout error | reproduced |
| F1 | `preflight`'s `types` tier drops every diagnostic in shared code; `push` (unscoped) catches it | reproduced |
| F2 | The `../../shared/money` snippet in the docs does not resolve | reproduced |
| F3 | The tsconfig `include` globs `shared/**` only | derived (read) |
| F4 | Two same-named helpers imported under the **same** binding: esbuild silently lets the last one win | reproduced |
| F5 | Aliased, they bundle side by side; esbuild renames the clash `total` → `total2` | reproduced |
| F6 | "sync dir" — the term the one enforced rule is stated in — is used 16× in `/docs` and never defined | reproduced (grep) |
| F7 | The boundary is a *proxy* for "versioned at a stable relative path", too strict in a monorepo — and npm is an already-sanctioned way around it | reproduced |

### F0 — nothing hardcodes `shared/`

The single constraint lives in `checkNodeImports`
([lib/compile.mts:146-152](../../lib/compile.mts#L146-L152)): a `./`/`../`
specifier must resolve at or under `ctx.syncRoot` (the dir holding
`decanter.config.json`). Everything else about the folder is convention. One
node file importing from three differently-named roots:

| Shape | Import from `workflows/wf1/code/compute.ts` | Result |
| --- | --- | --- |
| Renamed root | `../../../helpers/strings` | ✅ bundles, `node run` executes |
| Second, nested root | `../../../domain/money/total` | ✅ bundles |
| Per-workflow helper dir | `../local/tag` | ✅ bundles; `preflight` → `layout compliant` |
| Escape the sync dir (F0b) | `../../../../outside-probe/x` | ✗ hard layout error, as designed |

The per-workflow case passes the compliance guard because the orphan/stray scan
only reads the folder root and `code/`
([lib/validate.mts:291-300](../../lib/validate.mts#L291-L300)) — sibling subdirs
are explicitly reserved for artifacts, so a helper dir next to `code/` never
trips it.

`shared/` therefore appears in exactly four places, none load-bearing:
`template/shared/example-helpers.ts` (what `init` scaffolds), the tsconfig
`include` globs, the `Edit(shared/**)` agent allowlist entry
([template/.claude/settings.json.example:6](../../template/.claude/settings.json.example)),
and prose.

### F1 — `preflight` grades green on code `push` will reject

`preflight` calls `runTypecheckResult(configDir, [ctx.dir])`
([lib/preflight.mts:308](../../lib/preflight.mts#L308)) and
`scripts/typecheck.mts` filters reported diagnostics to those scope dirs
([scripts/typecheck.mts:52-57](../../scripts/typecheck.mts#L52-L57)). A shared
helper lives outside every workflow dir, so its errors are compiled and then
thrown away:

```
$ node scripts/typecheck.mts                       # unscoped
shared/strings.ts(2,9): error TS2322: Type 'string' is not assignable to type 'number'.
1 error(s)

$ n8n-decanter preflight wf1 --offline             # scoped to the workflow dir
  ✓ types     node files typecheck clean
```

`push` calls `runTypecheck(config.configDir, log)` **unscoped**
([n8n-decanter.mts:589](../../n8n-decanter.mts#L589)), so it *does* catch it.
**The gate passes and the action then fails** — `preflight` exists precisely so
that doesn't happen. Reproduced with the folder literally named `shared/`, so
this is **not** a consequence of renaming.

`runTypecheckPerDir` ([lib/validate.mts:378-402](../../lib/validate.mts#L378-L402))
has the same hole from the other side: it buckets file-less diagnostics as
"shared" and attributes them to every workflow, but a diagnostic **with** a path
that matches no workflow dir lands in neither `mine` nor `shared` and is
dropped.

### F2 — the documented import path is one level short

Both [docs/concepts/typescript-nodes.md:56](../../docs/concepts/typescript-nodes.md)
and [template/AGENTS.md.example:357](../../template/AGENTS.md.example) show:

```ts
import { total, type OrderLine } from "../../shared/money";
```

From `workflows/<slug>/code/<node>.ts` that resolves to `workflows/shared/money`
— copy-paste it and push fails with `Could not resolve "../../shared/money"`.
The correct depth is `../../../shared/money`; the two-level form is a leftover
from the pre-`code/` flat layout retired in
[Plan 27](../done/27-verb-first-grammar.md). `test/e2e.mts:1750` and
`test/smoke-n8n.mts:347` already use the three-level form, which is why the
suites proved bundling works while the documented snippet stayed broken.

### F3 — the tsconfig `include` is `shared/**`-only *(derived)*

A helper folder under any other name is still typechecked *if some node file
imports it* (imports pull it into the program), but an **unreferenced** file in
it is never checked, and the editor's tsserver doesn't own it. Same glob in
[tsconfig.json](../../tsconfig.json) and
[template/tsconfig.json.example](../../template/tsconfig.json.example).

### F6 — the rule is stated in an undefined word

The one enforced rule is *"a relative import must resolve inside the **sync
dir**"*. That term appears **16 times across `/docs`** — `init`, `quickstart`,
`installation`, `preflight`, `type-checking`, `typescript-nodes`, the agents
pages — and is **defined nowhere**. There is no glossary. The Quickstart's first
heading is literally "Bootstrap a sync dir" with no statement of what one is.

Worse, [docs/concepts/sync-layout.md](../../docs/concepts/sync-layout.md) — the
page whose whole job this is — does not use the term at all: its tree starts at
`workflows/`, one level *below* the thing being defined, so the sync dir is
invisible exactly where a reader would look it up.

```sh
$ grep -rn "sync dir" docs/ | wc -l
16
$ grep -rn "sync dir" docs/concepts/sync-layout.md
(no matches)
```

The definition is unambiguous in the code — the dir holding
`decanter.config.json`, found by an upward search from cwd
([lib/config.mts:58-64](../../lib/config.mts#L58-L64)) and, for bundling, from
the node file ([lib/compile.mts:108-128](../../lib/compile.mts#L108-L128)) — it
simply never made it into prose. **This is plausibly the root of the confusion
the whole draft describes**: not that `shared/` looks mandatory, but that the
boundary it is measured against was never named.

### F7 — why the boundary exists, and the door already standing open next to it

*"Why must shared files sit under the sync dir at all — why not somewhere
else entirely?"* Three reasons, and they all ask the same question:

1. **Git is the product promise.** The sync dir *is* the repo. Code outside it
   is in no commit, so a pushed node would carry source the history does not
   know — you could no longer reconstruct what ran on the instance from the
   repo. That is the claim the whole tool rests on.
2. **Fresh clone and CI.** `push` from a fresh clone must produce the same
   bytes. A path pointing outside simply is not there.
3. **Hash determinism.** Module labels are sync-root-relative and live *inside*
   the compiled bytes, hence inside the `@ts-n8n sha256:` marker. Anything
   outside gets a `../`-prefixed label whose value depends on where the checkout
   sits.

**All three are proxies for one property: is this code versioned, at a relative
position that is the same on every machine?** The sync dir is a good stand-in
for that in the common case (sync dir = repo) and **too strict in a monorepo**,
where `../../packages/money` would be versioned and stable and is still refused.

**And the door is already open — via npm.** `checkNodeImports` runs the
sync-root test only on `./`/`../` specifiers; the bare-specifier branch checks
`bundleDependencies` membership and nothing else
([lib/compile.mts:146-156](../../lib/compile.mts#L146-L156)). A package resolved
through a `file:` dependency or a symlink pointing out of the sync dir bundles
without complaint — reproduced, `node run` returned the outside helper's value.

Which makes reason 3 visible rather than theoretical:

| Resolution | Module label in the compiled bytes | Hash |
| --- | --- | --- |
| Real package in `node_modules/` | `// node_modules/acme-lib/index.js` | stable |
| `file:` dep / symlink pointing outside | `// ../acme-lib/index.js` | **escapes the root** → machine-dependent |

Inside a monorepo the relative position is identical across clones, so that
second row is fine. Outside any shared repo it means a teammate compiles
different bytes and sees permanent "push pending" with nobody having changed
anything.

**Open question for the maintainer** (do not act on it in this plan): is the
monorepo case worth supporting for *relative* imports too — e.g. widen the
boundary from "the sync dir" to "the enclosing git work tree" — or is
`npm i file:../packages/x` + a `bundleDependencies` entry the answer, documented
as such? The second is free and already works; the first is a real design change
to a guard that currently has one crisp rule. **Recommendation: document the npm
route**, and revisit only if someone actually hits it. Either way the docs
should say *why* the boundary exists, because "shared code must live inside it"
reads arbitrary without reasons 1-3.

## Two same-named files from two folders (the follow-up question)

Resolution is by **absolute path**, so `shared/money.ts` and `domain/money.ts`
are two unrelated modules — the shared basename means nothing to the bundler.
What *can* collide is the **binding name** you import them under, and that
splits into two very different outcomes.

### F4 — same binding name, unaliased: silent last-wins

```ts
import { total } from "../../../shared/money";   // reduce(qty * price) -> 10.5
import { total } from "../../../domain/money";   // length              -> 2
return [{ json: { a: total($input.all()), b: total($input.all()) } }];
```

```
$ n8n-decanter node run …          →  { "a": 2, "b": 2 }
```

**Both calls hit the second import.** esbuild does not reject the duplicate
declaration — it lets the later binding shadow the earlier one and emits a
working bundle. There is no warning, and the *first* helper silently vanishes
from the artifact.

The only thing that catches it is the **typecheck**:

```
$ n8n-decanter preflight wf1 --offline
  ✗ types     typecheck failed: workflows/wf1/code/compute.ts(1,10): error TS2300: Duplicate identifier 'total'.
```

So the safety net is real but narrow: `push` runs the typecheck unscoped before
writing, and the diagnostic lands **on the node file** (inside the scope), so
`push` and `preflight` both refuse. But `node run`, `preflight --no-typecheck`,
and any path with `typescript` unresolvable will happily run the wrong code.
Worth a named guard — see Task 7.

### F5 — aliased: both modules bundle side by side

```ts
import { total as orderTotal, type Line } from "../../../shared/money";
import { total as countTotal } from "../../../domain/money";
```

```
$ n8n-decanter node run …          →  { "sum": 10.5, "count": 2 }
```

The compiled artifact (`compileTs`, verbatim):

```js
var __n8n_node = {};
(() => {
  // shared/money.ts
  function total(lines) {
    return lines.reduce((s, l) => s + l.qty * l.price, 0);
  }

  // domain/money.ts
  function total2(lines) {
    return lines.length;
  }

  // workflows/wf1/code/node.ts
  __n8n_node.default = async () => {
    const lines = $input.all().map((i) => ({ qty: Number(i.json.qty), price: Number(i.json.price) }));
    return [{ json: { sum: total(lines), count: total2(lines) } }];
  };
})();
return __n8n_node.default();
```

Three things to read out of that output:

- **Module labels are sync-root-relative paths**, so two same-named files are
  always distinguishable in the artifact (`// shared/money.ts` vs
  `// domain/money.ts`) — a diff of the pushed code stays readable. This is
  `absWorkingDir: workingDir` (the sync root) in
  [lib/compile.mts:217](../../lib/compile.mts#L217), and it is what makes the
  bytes machine-independent.
- **esbuild renames the clashing top-level identifier** (`total` → `total2`).
  Deterministic and order-stable, so the `@ts-n8n sha256:` marker is stable
  too — but note the suffix is assigned by *bundle order*: reordering the two
  import lines swaps which module keeps the bare name and rewrites the artifact
  (hash churn, one push to re-baseline). Cosmetic, not a correctness issue.
- **The entry is always labelled `node.ts`**, never the node's real filename —
  deliberate, so a remote rename doesn't change the artifact
  ([lib/compile.mts:16-24](../../lib/compile.mts#L16-L24)).

*Derived, not reproduced:* because the entry label is
`<dir-relative-to-sync-root>/node.ts`, two byte-identical node files in two
different workflow folders compile to **different** bytes (different label) and
therefore different hashes. Harmless — hashes are per node — but worth knowing
before someone assumes identical sources produce identical artifacts. Only
import-having nodes are affected; a no-import `.ts` node takes the `transform`
fast path, which emits no path comments at all.

### Two asymmetries that are correct but undocumented

- **Auto-commit is pathspec-scoped to the workflow folder**
  ([lib/git.mts:44](../../lib/git.mts#L44)) — a top-level shared edit is *not*
  auto-committed by pull/push, while a per-workflow helper dir *is* (it's inside
  the pathspec). Both behaviors are right; the user has to be told.
- **`watch` observes only the workflow dir and its `code/`**
  ([lib/watch.mts:116-126](../../lib/watch.mts#L116-L126)) — editing a shared
  helper does not re-push its importers. Plan 14's stated non-goal, still true,
  written down nowhere a user reads.

## Design decision (proposed) — convention, not configuration

**No new `decanter.config.json` key** (no `sharedDirs`, no `sharedRoot`).

esbuild resolves *anything* inside the sync root whether or not a config key
names it, so such a key could never be authoritative — it would be a second
source of truth that silently disagrees with what `push` actually bundles, and
the only way to make it authoritative would be to add a **new restriction**
(reject imports outside the listed roots) that nobody asked for and that would
break the per-workflow shape that works today.

Config keys are for choices the CLI must make. "Where do my helpers live" is not
one: the import specifier already says it, per file. The deliverable is that the
rule is **stated** ("inside the sync dir") instead of implied ("`shared/`").

The one place a set of roots would genuinely buy something is a future `watch`
that re-pushes importers on a helper edit — and even there the roots should be
*derived* from the import graph (`scanNodeImports` already yields the
specifiers), not configured. Out of scope here.

## Tasks *(contingent on the findings above being confirmed)*

1. **Fix the `types` blind spot (F1 — the only real bug).**
   - `scripts/typecheck.mts` — in `inScope`, a file that is **not** a node file
     (`isNodeFile()` is already defined at line 73, keyed on the
     `.decanter.json` sibling) and lives inside the tsconfig project dir is
     **always in scope**. Scoping exists to stop one workflow inheriting
     another workflow's *node* errors; shared code is common infrastructure and
     belongs to everyone. This mirrors the existing "file-less diagnostics are
     reported unconditionally" rule right above it.
   - `lib/validate.mts` `runTypecheckPerDir` — a path-prefixed line whose
     resolved path matches **no** entry in `dirs` joins the `shared` bucket
     (attributed to every workflow) instead of being dropped.
   - Sanity-check the `--require=`/`--fail-on=` and `--json` shapes when the
     same shared diagnostic appears under several workflows.

2. **Fix the broken import depth (F2).** `../../shared/money` →
   `../../../shared/money` in
   [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md)
   and [template/AGENTS.md.example](../../template/AGENTS.md.example). Grep the
   corpus for other pre-`code/` two-level examples
   (`grep -rn '\.\./\.\./shared' docs template README.md`), and consider
   extending `npm run check:docs` with a relative-import depth assertion for
   fenced node-file examples — same class of copy-paste-broken snippet it
   already catches for verb-last commands.

3. **Widen the tsconfig `include` (F3).** In
   [tsconfig.json](../../tsconfig.json) and
   [template/tsconfig.json.example](../../template/tsconfig.json.example),
   replace the `shared/**` + `workflows/**` pair with a project-wide
   `**/*.ts` / `**/*.js` include. Extend `exclude` to cover what the wider glob
   sweeps in: `node_modules`, `decanter-ts-plugin`, `**/*.remote.js`, `dist`,
   plus the per-workflow artifact dirs (`**/backups/**`, `**/executions/**`).
   `scripts/typecheck.mts`'s node-file wrapper keys on `.decanter.json`, so a
   widened include is safe by construction. Existing sync dirs keep their
   scaffolded tsconfig — call that out in the changelog with the one-line fix.

4. **Document the actual rule (the core deliverable).** The organising idea is a
   distinction the docs never draw: **what is a rule versus what is a default.**
   `code/` is a *rule* — a node file outside it is a hard error
   ([lib/validate.mts:32](../../lib/validate.mts#L32)). `shared/` has no such
   counterpart: it is a *default with tooling attached* (the `init` scaffold, the
   tsconfig glob, the agent allowlist), which is why deviating costs three lines
   rather than none. Every surface below should read as an instance of that
   distinction, not as separate advice.
   - **First, define the sync dir (F6) — everything else depends on it.**
     [docs/concepts/sync-layout.md](../../docs/concepts/sync-layout.md) opens one
     level too low: raise its tree to start at the sync dir, and state the
     definition plainly — *the directory holding `decanter.config.json`; every
     verb finds it by searching upward, and it is the boundary imports may not
     cross*. Then audit the other 15 uses of the term for a first-mention link
     to it. Consider whether `/docs` wants a short glossary at all, or whether
     one well-linked definition suffices (the latter, probably — one page that
     owns the term beats a page nobody opens).
   - [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md),
     "Shared code and npm packages": lead with the real boundary — *shared code
     may live in **any folder inside the sync dir**, in any number of folders;
     `shared/` is simply what `init` scaffolds*. Show the three working shapes
     and the one hard error (with its exact message), plus the two asymmetries
     (auto-commit pathspec, `watch`) and the same-name rule from F4/F5:
     **different folders never collide; identical binding names do.**
     State **why** the boundary exists (F7's three reasons — git, fresh clone,
     hash determinism), and document the npm route
     (`npm i file:../packages/x` + a `bundleDependencies` entry) as the
     sanctioned way to reach code outside it, with the caveat that the target
     should live in the same repo or the labels stop being machine-independent.
   - [docs/concepts/sync-layout.md](../../docs/concepts/sync-layout.md): add the
     sync-dir-level view with `shared/` marked *convention, rename or multiply
     freely*, pointing at the section above.
   - [README.md](../../README.md): the "Shared code and small libraries" bullet
     and the comparison-table row both say `shared/` — widen to "shared code
     anywhere in the sync dir (`shared/` by default)".
   - [docs/cli/push.md](../../docs/cli/push.md) and
     [docs/cli/diff.md](../../docs/cli/diff.md): same wording widening.
   - `CHANGELOG.md` `[Unreleased]`: **Fixed** — `preflight`'s `types` check now
     reports type errors in shared helper files instead of passing green while
     `push` fails on them; **Fixed** — the documented shared-import path was one
     level short for the `code/` layout; **Changed** — the scaffolded
     `tsconfig.json` covers the whole sync dir.

5. **Template & agent surfaces.**
   [template/AGENTS.md.example](../../template/AGENTS.md.example), the
   "Shared code (`shared/`)" block: state the rule, keep `shared/` as the
   default, add the line an agent needs — *a helper folder under another name
   works; extend your editor/agent allowlist
   ([template/.claude/settings.json.example](../../template/.claude/settings.json.example)
   ships `Edit(shared/**)`) if you use one*. Per the root `AGENTS.md`
   agent-tooling rule the substance goes in `AGENTS.md.example`, with
   `CLAUDE.md.example` / the cursor rule staying pointers.

6. **Tests.**
   - Unit: `runTypecheckPerDir` attributes a diagnostic in a non-workflow file
     to **every** workflow in the run, and still attributes a node-file
     diagnostic to its own dir only.
   - e2e (extending the existing `bundle: shared/ value import …` step): a node
     importing from a **non-`shared`** folder pushes a bundled body; a type
     error in that helper makes `preflight --offline` report `types` **failed**
     (the F1 regression); two same-named helpers under aliased bindings bundle
     side by side with distinct module labels; the sync-dir escape still errors.
   - `npm run check:docs` green (plus the new depth assertion if Task 2 adopts
     it).

7. **Decide what to do about F4 (open question — needs the maintainer).** The
   silent last-wins shadowing is caught *today* only by the typecheck. Options,
   cheapest first: (a) leave it — `push` always typechecks, so nothing wrong
   ever reaches n8n, and document the aliasing rule; (b) make
   `checkNodeImports` (which already walks the specifier list) also flag
   duplicate *binding names* across the import block, turning it into a layout
   violation `--force` cannot bypass — costs a real binding parser, since
   `scanNodeImports` currently records specifiers only; (c) surface it as a
   `node run` warning only. **(a) is the recommendation** unless a field-test
   round shows an agent hitting it; the typecheck already blocks the push, and
   (b) buys a parser for a case TypeScript names precisely.

## Acceptance / verification

- `preflight` fails the `types` check on a type error in a shared helper —
  under `shared/` and under any other folder name — naming the real file and
  line. No workflow is graded `ready` on code `push` will reject.
- A node importing from two differently-named helper roots **and** a
  per-workflow helper dir pushes one self-contained body; `node run` executes
  it offline.
- Two same-named helpers under aliased bindings appear as two distinctly
  labelled modules in the pushed artifact.
- An import escaping the sync dir still fails with the existing
  `resolves outside the sync dir` layout error.
- The import snippets in `/docs` and `template/AGENTS.md.example` resolve when
  copy-pasted into a freshly `init`ed sync dir.
- A reader who lands on any page using the term "sync dir" can reach a
  definition of it in one click, and `docs/concepts/sync-layout.md` states it.
- A freshly scaffolded sync dir typechecks a helper folder named something other
  than `shared/` without editing `tsconfig.json`.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Non-goals

- **No config key** — see the design decision above.
- **No new restriction.** The sync-dir boundary is the whole rule and stays the
  whole rule; nothing gains an allowlist of permitted helper roots.
- **No `watch` on shared roots.** Unchanged from
  [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)'s non-goal — a
  helper edit still syncs on the next save/push of an importing node.
- **No rename of the scaffolded folder.** `init` keeps scaffolding `shared/`;
  this makes it a *default*, not a *requirement*.
- **No change to bundling semantics** — each importing node still carries its
  own copy, byte-for-byte as today.

## Notes

- **`PLAN.md` implication:** the data-model section's bundling note scopes
  shared imports to "`shared/*` helpers". Reword to the sync-dir rule so the
  design document stops implying a fixed folder. No data-model change — this
  documents and repairs existing behavior.
- **[Plan 24](../open/24-shared-code-in-js-nodes.md) inherits all of it.**
  Bundled `.js` nodes will use the same `checkNodeImports` path, so every fix
  here applies unchanged; Plan 24's Task 6 (`status` reflects a shared edit) and
  its `shared/`-worded docs tasks should pick up this wording. Its "No
  `watch`ing of `shared/`" non-goal is the same deferral restated above.
- **Follow-up idea (not filed):** `watch` re-pushes importers on a helper edit,
  with the watched set **derived from the import graph** (`scanNodeImports` +
  the resolved relative targets), not configured.
