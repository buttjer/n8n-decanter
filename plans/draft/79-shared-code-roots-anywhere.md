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
| F7 | The out-of-root refusal protects nothing measurable: an out-of-root relative import compiles **byte-identically** at two unrelated checkout depths | reproduced |
| F7b | The sync dir has nothing to do with git — `loadConfig` never consults it, and the dir need not be a repo at all | reproduced (read + gitignore probe) |
| F7c | The one genuinely machine-dependent case — a symlink/`file:` package pointing outside the repo — is the case the guard does **not** check | reproduced |

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

### Terminology: which "guard", and what it actually does

Two unrelated things in this project are called *the guard*, and conflating them
made this whole thread harder than it needed to be:

- **The agent guard** (`mcp connect` / `mcp serve`, `lib/mcpserve.mts`) — the
  MCP proxy that refuses agent writes carrying `jsCode`. **Not** what any of
  this is about.
- **The compliance guard** — `push`'s tier-1 gate (`lib/validate.mts`), whose
  import rules live in `checkNodeImports`. That is the one under discussion, and
  the docs should stop using the bare word for both.

`checkNodeImports` contains **no bundling logic at all**. `scanNodeImports`
lexically reads the import block at the head of the file and returns the
specifier strings; `checkNodeImports` loops over that list, applies four rules,
and returns a list of complaints. If the list is non-empty, `compileTs` throws
**before esbuild is ever called** ([lib/compile.mts:184-187](../../lib/compile.mts#L184-L187)).
Being purely lexical is what lets `preflight --offline` report all four without
compiling anything, which is why the function is shared between `validate.mts`
and `compile.mts` in the first place.

#### What a check *before* the bundler is worth

Four distinct things, and they do not apply evenly to the four rules.

1. **It catches what esbuild is silent about.** Measured: a `node:fs` import
   produces no error and no warning — esbuild externalises it and writes a
   `__require("node:fs")` shim into the artifact, which pushes cleanly and then
   fails (or doesn't) at **runtime on the n8n instance**, depending on that
   instance's `NODE_FUNCTION_ALLOW_BUILTIN`. The worst possible place for the
   failure. Same for an installed-but-not-opted-in package: esbuild inlines
   whatever `node_modules` offers, so without the check a package you never
   meant to ship lands in the workflow JSON.
2. **It fails on the author's machine, not the colleague's.** An absolute
   specifier resolves fine for you, so you push a node nobody else can build.
   The check inverts that.
3. **Offline, without compiling, and all at once.** Being lexical is what lets
   `preflight --offline`, the layout tier and `watch` report every violation
   without starting esbuild — and report *all* of them rather than stopping at
   the first resolution error, in our wording rather than esbuild's.
4. **One source, two paths.** `preflight` and `push` call the same function, so
   they cannot disagree — the bug class F1 is an instance of.

| | Rules 1-3 | Rule 4 (out of root) |
| --- | --- | --- |
| Is esbuild silent? | **yes** | no — loud `Could not resolve` |
| Does it fail on the wrong machine? | yes (absolute path) | no — fails where the file is absent |
| Reportable earlier, offline? | yes | yes |

Only the third row survives for rule 4: **earlier, and in our wording.** Enough
to keep it as a warning, not enough to block on.

### F7 — the boundary guards a property it neither implies nor requires

*"Why must shared files sit under the sync dir at all — why not somewhere else
entirely?"* Three reasons get offered. **Under maintainer challenge
(2026-08-09) the first two do not survive, and the third turns out to argue for
a different boundary than the one we have.**

1. ~~**Git is the product promise** — the sync dir *is* the repo, so code
   outside it is in no commit.~~ **Wrong: nothing ties the two together.**
   `loadConfig` searches upward for `decanter.config.json` and consults git not
   at all ([lib/config.mts:58-64](../../lib/config.mts#L58-L64)); the sync dir
   need not be a repo, only auto-commit warns if it isn't. The check is
   therefore *neither necessary nor sufficient* for "versioned":
   - **Not sufficient** — a **gitignored** folder *inside* the sync dir passes.
     Reproduced: `.gitignore` carrying `secret-helpers/`, a node importing
     `../../../secret-helpers/x` → `✓ layout compliant`, bundles, runs.
   - **Not necessary** — in a monorepo `../../packages/money` is versioned and
     is refused anyway.
2. ~~**Fresh clone and CI** — `push` must reproduce the same bytes.~~ True as a
   *consequence*, but it is the user's call to accept, not a safety property to
   enforce. And the enforcement is far too hard for a judgement call: the
   sync-root test is a **tier-1 compliance violation that `--force` explicitly
   does not bypass** (only the tier-2 drift guard is forceable). A warning, or
   something `--force` can override, is the honest strength.
3. ~~**Hash determinism** — an out-of-root import makes the compiled bytes
   machine-dependent.~~ **Measured, and false for relative imports.** See below.

**Reason 3, measured rather than argued.** What gets pushed is not the `.ts`
file but the compiled JS, and "in sync" is decided by a hash over exactly those
bytes. esbuild writes a comment above each bundled module (`// shared/money.ts`)
and that string is part of the bytes, therefore part of the hash. The path is
relative to `absWorkingDir`, which decanter deliberately sets to the project
root ([lib/compile.mts:216-217](../../lib/compile.mts#L216-L217)) so no
`/Users/<name>/…` leaks into the artifact.

The claim was that an out-of-root import yields a `../`-prefixed label whose
value depends on where the checkout sits. **It does not.** The label is
`path.relative(projectRoot, resolve(dirname(nodeFile), specifier))` — computed
entirely from the node file's position *within* the project and the specifier
string, both of which are repo contents. The checkout's absolute location never
enters. Compiled the same project at two unrelated absolute depths
(`…/A/proj` and `…/B/much/deeper/A/proj`), node importing four levels out:

```
// ../outside/vat.ts
diff A vs B:  identical
7832cc0dff6dc0ac27746885003cc63b69c840cd16a5e6117d2351ce029aaa00  out-A.js
7832cc0dff6dc0ac27746885003cc63b69c840cd16a5e6117d2351ce029aaa00  out-B.js
```

Byte-identical, same sha256. So for a **relative** import there is exactly one
failure mode left: the target is absent on the other machine and esbuild says
`Could not resolve` — loud, immediate, offline, before any network call. That is
ordinary broken-import behavior and squarely the user's own duty of care.

#### F7c — the guard blocks the safe case and waves the unsafe one through

The sync-root test runs **only on `./`/`../` specifiers**; a bare specifier is
checked for `bundleDependencies` membership and nothing else
([lib/compile.mts:146-156](../../lib/compile.mts#L146-L156)). That is exactly
backwards, and it is measurable.

Two projects, **byte-identical node source** (same sha256 on the `.ts` file),
each with the library symlinked into `node_modules/` — one directory away in the
first, three levels away in the second:

```
p1:  // ../lib/index.js         →  b7d6d472a52dc2a2768744061d18dd0cde6f0454a863350022e8772b076c7324
p2:  // ../../../lib/index.js   →  d0f7961b7f50275ec61c4b231ecb76aee83538bd6978642b2287f211ea5098ad
```

Same source, different compiled bytes. The mechanism is the whole point:

- **Relative import** — the path *is in the source file*. Repo content, so the
  same string for everyone, wherever the checkout lives.
- **Bare specifier** — the path is **nowhere in the repo**. esbuild finds it
  through `node_modules`, follows the symlink, and takes the **realpath** on
  *that* machine's disk, which differs per developer.

The lived consequence: two people, one repo, different hashes — one sees
permanent "push pending", pushes, and then the other one does. Ping-pong drift
with nobody having touched any code.

Only `npm link` / `file:` pointing **out of the repo** is affected. A
registry-installed package is a real directory inside the project
(`// node_modules/x/index.js`, stable), and `file:../packages/x` within the same
repo is stable too.

| Resolution | Module label | Stable across machines? | Guarded? |
| --- | --- | --- | --- |
| Relative import, inside the root | `// shared/money.ts` | yes | n/a |
| Relative import, out of the root | `// ../outside/vat.ts` | **yes — measured** | **hard error** |
| Package in `node_modules/` | `// node_modules/acme-lib/index.js` | yes | no |
| Symlink / `file:` dep outside the repo | `// ../lib/index.js` | **no — measured** | **no** |

So the guard is **too loose** (gitignored dirs inside; the one genuinely
unstable case passes untouched) and **too strict** (a relative import out of the
root is provably deterministic and merely might not resolve elsewhere) — while
enforcing at tier-1, un-forceable strength.

**Should the new warning point at the symlink case instead?** Plainly: there are
two ways to pull foreign code into a node — **by path** (`from
"../../../shared/x"`) and **by name** (`from "mylib"`). The check only ever
looked at paths. The by-name route is the one that actually breaks, and adding
it means a realpath check on resolved bare specifiers — a **new capability, not
a downgrade**. **Recommendation: don't.** It inflates this plan, and it only
bites `npm link`-style setups, which nobody has reported. If someone does hit
it, that is its own plan.

#### Blast radius: import-free files are untouched

Worth stating because it bounds the whole change — `compileTs` returns on the
`transform` fast path when there are no specifiers
([lib/compile.mts:173-181](../../lib/compile.mts#L173-L181)), so the check is
never even called for them:

| File | Imports? | What happens | Check runs? |
| --- | --- | --- | --- |
| `.js` | none | pushed **verbatim**, esbuild never touches it | no |
| `.js` | yes | **hard error** today — "convert the node to `.ts` or inline the code" ([lib/validate.mts:47](../../lib/validate.mts#L47)); that is [Plan 24](../open/24-shared-code-in-js-nodes.md)'s territory, untouched here | separate rule |
| `.ts` | none | esbuild `transform` only (TS→JS), no bundling, no path comments | no |
| `.ts` | yes | bundled | **yes** |

So the downgrade can only affect files that genuinely import something. Nothing
in the lossless `.js` tier, and nothing in the import-free `.ts` fast path,
changes shape or protection.

#### Proposal (maintainer decision 2026-08-09: git must not be a dependency)

Git is out of it entirely — including the "enclosing work tree" boundary
floated in the previous revision, which would have made git a dependency of the
import rule. Auto-commit is already switchable off (`commitOnPush` /
`commitOnPull`), so decanter cannot treat "is this versioned" as its business.

**Widened by the maintainer (same session): all four import rules become
warnings, none stays a hard error.** The line held throughout — none of the
four protects anyone *else* from you; they protect you from yourself, and that
is the user's call. Rules 1 and 4 keep a distinct value that argues for
*reporting*, never for *blocking*:

| # | What the user wrote | Who else would notice? | Ours to enforce? |
| --- | --- | --- | --- |
| 2 | `from "../../../../elsewhere/x"` — a relative path that lands **outside** the project root | esbuild, loudly, offline | **no** |
| 3 | `from "/Users/me/x.ts"` — an absolute path | esbuild, loudly — but on the colleague's machine, not yours | barely |
| 4 | `from "zod"` where `zod` is **not** in `bundleDependencies` | **nobody** — silently inlined into the workflow JSON | partly |
| 1 | `from "node:fs"` — a Node builtin | **nobody** — a `__require` shim ships and only fails at runtime *on the instance* | partly |

None of the four is deleted. All four keep reporting; they simply stop
blocking.

- **Warnings, not removal** — load-bearing, not caution. Delete a check and
  `preflight --offline --no-typecheck` reports green while `push` dies later:
  precisely the gate-lies shape of F1 this plan exists to fix. Kept as warnings
  in the same place, `preflight` still shows everything and simply stops
  blocking.
- **`--fail-on=warn` already exists** — the strictness knob is built: relaxed by
  default, strict on request (CI). No new flag.
- **The blast radius is small because `push` writes the *draft*.** Even a
  waved-through mistake lands where you inspect it; `publish` is a separate act.
- **Keep rule 1 the loudest warning.** Not because it deserves a block, but
  because it is the only one whose failure is invisible at build time *and*
  breaks the self-contained promise (a bundled node is supposed to run anywhere,
  n8n Cloud included).
- **Nothing else moves.** `absWorkingDir` stays the project root, so no module
  label changes, no artifact churn, no hash re-baseline for anyone.
- **Cost:** one branch in `checkNodeImports` plus the error/warning plumbing in
  `validate.mts`; the pinned negative assertions flip to warning expectations;
  a couple of e2e steps; one doc rule becomes a sentence about duty of care.
- Document the npm route (`npm i file:../packages/x` + a `bundleDependencies`
  entry) as the packaged alternative, with the realpath caveat for
  `npm link`-style targets outside the repo.

**Is this complicated? No — it is a net deletion.** An earlier revision of this
file worried the flat `string[]` would need to carry a severity. It does not:
since *all four* rules become warnings, no distinction is needed and the return
type is unchanged. Two edits, and nothing new is introduced — the `warnings`
array already exists, `log` is already an optional parameter of `compileTs`, and
`log?.warn(…)` is already used two lines further down.

```diff
  // lib/validate.mts:56
-        errors.push(`${label}: ${p}`);
+        warnings.push(`${label}: ${p}`);
```
```diff
  // lib/compile.mts:184-187
-  const problems = checkNodeImports(file, specifiers, ctx);
-  if (problems.length > 0) {
-    throw new Error(`${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
-  }
+  for (const p of checkNodeImports(file, specifiers, ctx)) log?.warn(`${file}: ${p}`);
```

Effort across the whole plan:

| Part | Size | Does the code grow? |
| --- | --- | --- |
| Warnings instead of errors | 2 sites | **shrinks** |
| F1 (typecheck blind spot) | 2 sites, ~10 lines | marginal |
| tsconfig `include` | a few lines of JSON | neutral |
| The rename | 11 identifiers + ~73 prose sites | no — pure find/replace |
| **Docs** | **the actual bulk** | no code |
| Tests | new assertions | yes, deliberately |

#### Naming (F6's other half) — **decided: `decanter project root`**

"sync dir" is the wrong name. The maintainer first proposed *"n8n-decanter
instance root"*; *instance* means **the n8n server** everywhere else in this
codebase and in `/docs` (`availableInMCP`, "instance tier", "the instance's
policy"), so it would collide with the one distinction users most need.
**Settled on `decanter project root`** (short: *project root*) — unclaimed, and
it reads correctly in the warning: *"resolves outside the project root"*.

**Maintainer decision: the rename goes all the way into the code.** Counted
scope:

| Surface | Occurrences |
| --- | --- |
| `syncRoot` identifier | 11, across `lib/compile.mts` and `test/unit/compile.test.mts` |
| "sync dir" in `/docs` | 16 |
| "sync dir" elsewhere (code comments, `PLAN.md`, `README.md`, `AGENTS.md`, `template/`, tests) | ~57 |

The identifier rename is small and mechanical; the prose is the bulk. Do it as
**one pass**, not incrementally, or the two terms coexist and the confusion gets
worse than before.

**Do not rewrite history.** `CHANGELOG.md` carries 14 occurrences and
`plans/done/*` more — both record what was true when written, and retitling a
shipped changelog entry is falsification, not maintenance. Only new entries use
the new term. Same for this file's own quoted output.

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

## Rollout — split the rename off

The rename is low-risk and high-diff: ~84 sites that no reviewer can read by
eye. Landing it together with the behavioural changes would bury them. So:

- **PR 1 — behaviour.** F1's typecheck fix, the four rules downgraded to
  warnings, the tsconfig `include`, tests. Small, reviewable, each hunk
  arguable.
- **PR 2 — the docs.** Define the project root, the rule-vs-default framing, the
  three working shapes, why a boundary exists, the npm route.
- **PR 3 — the rename**, mechanically, in one pass. Nothing else in it, so the
  diff can be skimmed for what it is. `CHANGELOG.md` and `plans/done/*` excluded.

Order matters only in that PR 3 comes last — renaming before the prose is
settled means renaming twice.

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
     cross* — explicitly **not** "your git root", which it need not be (F7b).
     Then audit the other 15 uses of the term for a first-mention link to it,
     and apply whatever name F7's naming section settles on in the same pass —
     one rename, not a drift. Consider whether `/docs` wants a short glossary
     at all, or whether
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
