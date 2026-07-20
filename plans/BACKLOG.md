# Plan 0 — Backlog

**Status:** Backlog — items graduate into their own plan (or get done directly)
**Theme:** Grab-bag of open items not yet claimed by a numbered plan; absorbed
from the retired `IDEAS.md` (2026-07-17).

## Why

`IDEAS.md` was retired; every entry already fleshed out lives in a numbered
plan's `## Source`. This file holds the remainder so nothing is orphaned.
`- [ ]` open, `- [x]` done — same check-off rules as before (fully done only).

## Items

Grouped by priority, then **Graduated** (open but tracked by a numbered plan)
and **Done** at the bottom. Priority is inferred from scope/value (these
entries carry no priority field) — adjust freely.

### Open — high (small, cheap, high-value)

- [x] **`run`'s `$env` leaks the entire `process.env` by default.**
      `lib/run.mts:150` — `$env: fixture.env ?? { ...process.env }`. A node
      that reads or prints `$env` gets every exported variable of the CLI
      process (which can include `N8N_API_KEY` and other secrets) straight into
      the returned JSON on stdout. n8n's `$env` is scoped; this is not.
      **Recommend:** default `$env` to `{}` (or a documented allowlist) unless
      the fixture supplies `env`, with an explicit `--allow-env` opt-in for the
      full-inherit behavior. Small change in `buildGlobals`. Severity: moderate.
      (done 2026-07-20: `$env` now empty by default; fixture `env` wins;
      `--allow-env` opts into `process.env`. v0.3.0, breaking.)
- [x] **`executions` missing from the interactive menu** (2026-07-20) — the
      picker's per-workflow verb menu (`PICKER_VERBS` in `lib/picker.mts`)
      offers only `status`/`pull`/`push`/`watch`/`check`; `executions` (fetch
      run data) has no entry, so it's CLI-only. Add it to the menu.
      (done 2026-07-20: added to `PICKER_VERBS`. v0.3.0.)

### Open — medium (valuable, more scope/design)

- [ ] **Modification-aware template refresh** — conffile-style: record
      copy-time hashes of template files in a manifest at init; on re-init
      update pristine files (after confirm), never touch user-modified ones,
      and report drift. Replaces the blunt `init --force` recopy.
- [ ] **`n8n-globals.d.ts` sourcing** — today it's a hand-written "pragmatic
      subset" shipped in `template/` as a byte-identical copy of the repo's
      root file → two copies that can drift.
      - [ ] De-dup first: have `init` copy the single root `n8n-globals.d.ts`
            instead of a static template duplicate (one source of truth; the
            e2e "template content matches" assertion needs adjusting).
      - [ ] Optional, opt-in `n8n-decanter types` refresh: regenerate
            `n8n-globals.d.ts` from n8n's editor autocomplete globals (the
            version-tagged bundle in n8n's frontend source on GitHub), keeping
            the hand-written subset as the offline fallback. Caveats that make
            this low-priority: the globals surface (`$`, `$input`, `$json`,
            Luxon `DateTime`, `$jmespath`) is stable across versions; there's no
            clean official drop-in .d.ts; n8n-mcp covers node schemas/params not
            runtime globals; `n8n-workflow` types describe the node-dev API, not
            the Code-node sugar; and the public API v1 doesn't cleanly expose
            the running n8n version to pin against. Adds an online dependency
            to an otherwise-offline tool.
- [ ] **`run` executes node code with full host privileges — document and
      narrow it.** `lib/run.mts` builds an `AsyncFunction` from the node body
      and invokes it in the CLI's own process (`invoke`, line ~174). n8n runs
      Code nodes in a locked-down task-runner sandbox; `run` does **not** —
      free identifiers (`process`, `fetch`, `globalThis`, dynamic `import()`)
      are all reachable, so a node file can touch the filesystem, network, and
      env. This is by design for *your* code, but it's a real footgun for
      agents that `run` generated/untrusted node files. **Recommend:** state
      plainly in README + template `AGENTS.md` that `run` is not a sandbox
      (never `run` a node you wouldn't execute by hand). Severity: moderate.
- [ ] **`run`'s faked n8n context silently diverges from n8n — `$jmespath`
      throws, other globals are absent, and the docs never mark the boundary.**
      `lib/run.mts` `buildGlobals`: `$jmespath` (line ~170) is wired to *throw*
      ("not implemented in `run` — assert on the data directly"), even though it
      is one of the stable Code-node globals the project already treats as core
      (it ships in `n8n-globals.d.ts`; the `.d.ts`-sourcing item above lists it
      among the stable surface). A node that uses `$jmespath` — common in
      data-shaping nodes — cannot be `run` at all, and the failure only surfaces
      mid-run at the call site. Other real globals are simply missing (`$vars`,
      `$secrets`, `$ifEmpty`, `$evaluateExpression`, `$max`/`$min`; `$runIndex`
      is pinned at 0; `$('Node').item` is not the per-item *linked* item in
      `runOnceForEachItem`), so those nodes hit an opaque `ReferenceError`.
      Meanwhile `docs/cli/run.md` sells it as "executes a node's body against a
      faked n8n context (`$input`, `$json`, `$('Node')`, `DateTime`, …)" with no
      list of what is covered vs. absent. **Recommend:** (a) implement
      `$jmespath` — n8n's `$jmespath(obj, expr)` maps straight onto the
      `jmespath` package's `search(obj, expr)`, a small pure-JS dep wired exactly
      like luxon; and (b) document the emulated-vs-unsupported boundary in
      `docs/cli/run.md`, and have unsupported globals fail with a friendly "not
      emulated in `run`" message instead of a bare `ReferenceError`. Relates to
      the `run` host-privileges item above and `run --from-execution` below.
      Severity: moderate.
- [ ] **Add a linter (or remove the stray disable directive).**
      `lib/util.mts:76` carries `// eslint-disable-next-line no-control-regex`,
      but **there is no ESLint (or any linter) config in the repo** — the
      directive references tooling that was never wired up. For a public TS CLI
      with CONTRIBUTING.md, CI, and Dependabot, an automated lint/style gate is
      the conventional missing piece (CI runs only typecheck + test).
      **Recommend:** adopt a single-dep, fast linter — **Biome** fits the
      "minimal deps / no build for dev" ethos better than ESLint's plugin
      stack — wire it into `npm run` + the CI job, then the disable directive
      becomes real (or is dropped). Would also have caught the two cleanups
      below.

### Open — low (large scope or deferred)

- [ ] **LLM semantic validation** — LLM-based *semantic* workflow validation as
      a command. Split out of the validator idea —
      [Plan 2](DONE-2-offline-validation-and-rename.md) covers only the offline
      structural subset and explicitly defers this.
- [ ] **`run --from-execution <execId>`** (deferred 2026-07-19 from
      [Plan 3](DONE-3-local-run-and-diff-fidelity.md) C) — load a captured
      execution (`executions` verb) as a `run` fixture: reconstruct `$input`
      (via the connections graph — a node's own input isn't stored, only
      upstream outputs), the `$('…')` node outputs, and staticData. Deferred
      because agents read the execution JSON directly and hand-craft
      fixtures; the automation carries the risk (executions run the
      *published* version on n8n 2.x, and data can be flawed or stale).
      `run --chain "A" "B"` stays deferred alongside it (real ordering/mode
      semantics — Plan 3's original note).
- [ ] **Document the `watch` live-reload proxy trust model.** `lib/proxy.mts`
      binds `127.0.0.1` only (good) and is opt-in (`browserReload: "proxy"`),
      but it's a transparent auth-passthrough tunnel to the n8n instance and
      serves an unauthenticated `/__decanter/events` SSE endpoint. Localhost +
      opt-in keeps risk low, but the trust model (any local process reaching
      the port rides the browser's forwarded cookies; https/remote upstreams
      are best-effort) deserves one explicit paragraph in PLAN.md/README beyond
      the current "https is best-effort" note. Severity: low.
- [ ] **Dead comment guard in `parseEnvFile`.** `lib/config.mts:11` —
      `m[0].trimStart().startsWith("#")` can never be true: the key regex
      (`[A-Za-z_]…`) already rejects any `#`-leading line, so `m` is `null`
      there. Harmless, but delete the guard or add a real inline-`#` handling
      story so the intent is honest.
- [ ] **Dead luxon-optional branch in `run`.** `lib/run.mts` `buildGlobals`
      (~136-143) wraps the luxon import in `try/catch` and warns "luxon not
      installed — DateTime/$now/$today are unavailable", leaving `$now`/`$today`
      `undefined`. But **luxon is a hard `dependencies` entry** (package.json),
      not optional — a normal install always has it, so the catch branch is
      unreachable and the `undefined` fallback only bites someone with a broken
      `node_modules` (who would then get an opaque `$now.toISO()` TypeError
      anyway). **Recommend:** import luxon normally and drop the try/catch +
      `undefined` fallbacks; or, if "run works without luxon for pure-logic
      nodes" is a wanted property, move luxon to `optionalDependencies` so the
      code reflects reality. Severity: low.
- [ ] **Unused `log` parameter in `loadFixture`.** `lib/run.mts:76` —
      `loadFixture(fixturePath, log)` never uses `log`. Drop it (a linter would
      have caught this — see the linter item above).
- [ ] **Value-flag parser can swallow a following token.** `n8n-decanter.mts`
      (the `--status`/`--limit` peel-off) consumes the next arg unconditionally
      when no `=value` is given, so `n8n-decanter --status pull` reads `pull` as
      the status value and then finds no verb. Documented-as-needs-a-value, but
      a friendlier error ("`--status` needs a value; did you mean `status`?")
      or requiring `=` for these flags would remove the surprise. Severity: low.
- [ ] **Remove the `uuid` verb (scope creep) — supersede it with Plan 21's
      `add`.** `n8n-decanter uuid [count]` (`n8n-decanter.mts` handler ~179-184)
      is a general lowercase-v4 UUID generator justified only for hand-authoring
      new node ids in `workflow.json` — scope-distant from "sync workflows to
      git" (user decision 2026-07-20: plan to remove). Don't just drop it: the
      agent offline-loop docs (`docs/agents/offline-loop.md`,
      `docs/agents/overview.md`) actively steer agents to `uuid` for minting node
      ids, so removal must land **together with (or after)
      [Plan 21](OPEN-21-repo-authored-workflows.md)'s `add` verb**, which
      scaffolds a Code node *including its id* and makes standalone `uuid`
      redundant. Removal touches: the `VERBS`/`__complete` sets + `usage()` +
      handler in `n8n-decanter.mts`, `docs/cli/uuid.md` (delete),
      `docs/cli/overview.md` (command surface + offline-verbs table row),
      `docs/agents/*`, `docs/concepts/configuration.md`, `README.md`, `PLAN.md`,
      and the `test/e2e.mts` step. Breaking change → **Breaking:** CHANGELOG
      entry. Severity: low (deferred until `add` ships).
- [ ] **Optional OSS repo hygiene.** No `CODEOWNERS`, PR template, or issue
      templates. Low priority for a solo project, but cheap and conventional if
      contributions are wanted (CONTRIBUTING.md already invites them).
- [ ] **Cross-PR docs-drift guardrail in CI** (2026-07-20). The `/docs` pages
      can fall behind the CLI when a behavior change and its docs live in
      *separate* PRs: v0.3.0 (#29 — `--allow-env` + `executions` in the picker)
      merged before the `/docs` pages existed, so those pages landed a step
      behind and git flagged nothing (different files → clean merge). The
      `CLAUDE.md`/`AGENTS.md` docs-maintenance rule only catches drift *within* a
      behavior-changing PR. A CI check — diff the CLI verb/flag surface (or the
      CHANGELOG's user-facing entries) against the matching `/docs` pages, or a
      release-checklist step — would catch the cross-PR case. Real enforcement
      rides the public-repo CI ruleset
      ([Plan 13](OPEN-13-open-source-release.md)). Severity: low.

- [ ] **Re-evaluate the TypeScript 7.x (native) major on each stable release**
      (2026-07-20). Dependabot #5 tried to bump `typescript` 5.9.3 → 7.0.2; the
      7.x line is Microsoft's **native (Go) compiler rewrite**, shipped as
      per-platform binaries (`@typescript/typescript-<os>-<cpu>`). It was
      declined (`@dependabot ignore this major version`) because the native
      preview does **not** expose the programmatic compiler API this repo builds
      on: `scripts/typecheck.mts`'s custom `CompilerHost`
      (`findConfigFile`/`sys`/`getParsedCommandLineOfConfigFile`/`createCompilerHost`/`createProgram`/`getPreEmitDiagnostics`/`DiagnosticCategory`)
      and the TS language-service plugin exercised by
      `test/unit/ts-plugin.test.mts`
      (`createLanguageService`/`LanguageService`/`LanguageServiceHost`/`ScriptSnapshot`/`ScriptTarget`/`ModuleKind`).
      **Only adopt once a *stable* (non-preview/non-RC) TS release exposes those
      APIs** — re-check whenever a new stable major lands, never on a preview.
      Until then 5.x (and any transitional 6.x that keeps the JS API) is the
      supported line; 5.x patch/minor bumps still flow. Severity: low.

### Graduated (tracked by a numbered plan; not yet done)

- [x] **`publish` / `unpublish` verbs** (2026-07-19) — `POST
      /api/v1/workflows/:id/activate` (and deactivate) close the draft→live
      loop from the CLI. Semantics to respect (PLAN.md, smoke-verified):
      this only matters for **unpublished** workflows — a push to an
      already-published workflow auto-publishes (`publishIfActive: true`
      server-side), there is no draft-only push to a live workflow. So
      `publish` = "take this draft live"; `unpublish` = back to draft-only.
      (graduated to [Plan 20](DONE-20-cli-publish-lifecycle.md))
- [x] **Version-aware `status`** (2026-07-19) — the 2.x GET exposes
      `versionId` (draft) and `activeVersionId` (published): `status` can say
      "published version is older than the draft" instead of the binary
      published/unpublished line. Cheap; pairs with the `publish` verb.
      (graduated to [Plan 20](DONE-20-cli-publish-lifecycle.md))
- [x] **Stale-fixture warning for executions** (2026-07-19) — executions
      record the `workflowVersionId` they ran (published version); when
      [Plan 3](DONE-3-local-run-and-diff-fidelity.md) C captures
      fixtures, warn if that version is older than the current draft — the
      recorded data may not match the code being tested.
      (graduated to [Plan 20](DONE-20-cli-publish-lifecycle.md))
- [ ] **`add` verb** — scaffold a Code node (uuid → node object → `//@file:`
      placeholder → source file) in one step. Lower priority than `rename`;
      node creation is rarer than renaming.
      (graduated to [Plan 21](OPEN-21-repo-authored-workflows.md))
- [ ] **Folder hierarchy in sync layout** — mirror n8n's folder hierarchy, if
      the API exposes folder placement (PLAN.md milestone 4 — needs a live
      instance to verify). (graduated to
      [Plan 8](BLOCKED-8-folder-hierarchy-in-sync-layout.md) — API research done:
      placement is write-only, so the plan inverts to push-driven placement)
- [ ] **Create workflows from the repo** (2026-07-19; n8n 2.x-only scope) —
      the 2.x public API has `POST /api/v1/workflows` (verified by the
      Plan 15 smoke suite; 1.x had no create, hence PLAN.md's "workflows are
      born in n8n" rule). A `push --create` (or workflow-level `add`) would
      let a workflow folder authored in the repo become the source of truth
      end to end: scaffold folder → push creates it remotely → id lands in
      `.decanter.json`/config. Touches the id-first data model (folders
      currently exist only *after* a pull assigns the remote id) and the
      "born in n8n" guidance in PLAN.md + template AGENTS.md.
      (2026-07-20 status: split — blank CLI-native create →
      [Plan 20](DONE-20-cli-publish-lifecycle.md) `create`; clone an existing
      workflow → [Plan 21](OPEN-21-repo-authored-workflows.md) `duplicate`;
      both preserve pull-first. The data-model-inverting `push --create`
      variant was dropped by user decision.)
- [ ] **Engine-true simulation suite** — real e2e test or simulation suite: is
      there a way to really execute the workflow with the n8n engine using
      executions data as a mock/dry run? Also making sure nothing is really
      written through APIs or similar. Keep in mind executions data can be
      flawed or change in the future. (graduated to
      [Plan 7](OPEN-7-engine-true-simulation-suite.md))

### Done

- [x] **Recommend scoped API keys** (2026-07-19; done 2026-07-20) — `.env.example`,
      README, and PLAN.md now recommend a minimal-scope key over a full-access
      one, naming the exact scopes the CLI uses (`workflow:read`/`list`/`update`,
      `execution:read`/`list`; canonical strings from n8n's
      `public-api-permissions.ee.ts`). Docs-only, no code.
- [x] **Kebab-case code layout** — js node files to kebab-case, moved into a
      `workflows/*/code/` subdir.
- [x] **Id-first argument order** — accept `n8n-decanter.mts [id...] <verb>`
      instead of / in addition to `<verb> [id...]`.
- [x] **Bundle shared code into TS pushes** — `bundle: true` for `.ts` node
      compiles so value imports from `shared/` get inlined into the pushed code
      (today only type-only imports work — see the shared-code caveat in
      PLAN.md). (graduated to
      [Plan 14](DONE-14-bundle-shared-code-into-ts-pushes.md), whose spike
      found the premise wrong — *no* import worked in a `.ts` node, type
      imports included; implemented 2026-07-18 incl. an npm-package
      `bundleDependencies` allowlist, offline-tested)
- [x] **Tags/pinned-data round-trip check** — verify against the live instance
      that PUT preserves tags/pinned data on an untouched pull→push round-trip
      (open question in PLAN.md). (tags half **verified** 2026-07-19 by the
      [Plan 15](DONE-15-docker-n8n-smoke-suite.md) smoke suite against
      n8n 2.30.7; pinData half **verified** 2026-07-19 by the
      [Plan 18](DONE-18-pindata-smoke-seeding.md) smoke step against
      n8n 2.30.7, seeded via the **public API** — the earlier "the public
      API cannot set it" note was a stale 1.x-era claim; on n8n ≥ 2.30.7
      the public API accepts and persists `pinData` on create and update)
      - [x] **pinData seeding routes — collect only, decide later** (resolved
            2026-07-19 by the [Plan 18](DONE-18-pindata-smoke-seeding.md)
            analysis + live run: **public-API seeding, n8n ≥ 2.30.7 only —
            no fallback route**; the research disproved the premise, so none
            of the candidates below was needed) (user,
            2026-07-19: all options plus any new ones to be analysed together
            in a separate session; nothing here is chosen). Candidates so
            far, roughly by invasiveness: **internal REST** — the UI's
            workflow-save route carries `pinData`; same quarantined-fragile
            treatment as the smoke suite's auth bootstrap. **`docker exec` +
            `n8n import:workflow`** inside the container — pinData rides in
            workflow-export JSON, no HTTP surface at all. **Direct sqlite
            write** in the container (last resort, schema-coupled).
            **Documented one-time manual UI check** instead of automation
            (record the verdict + n8n version in PLAN.md). **Wait-and-see** —
            re-check on every version bump whether the public API gained
            pinData write support, and only then automate.
- [x] **Watch: deep-link URL to the workflow** — on `watch` start, print the
      editor URL pointing straight at the watched workflow
      (`<origin>/workflow/<id>`), using the browser-reload proxy origin when
      the proxy is running (today it only prints its root URL) and the
      configured upstream otherwise. Plain URLs are already cmd/ctrl-clickable
      in most terminals (VS Code, iTerm2, Windows Terminal); rendering it as a
      styled OSC 8 hyperlink is a style-layer concern —
      [Plan 11](DONE-11-cli-look-and-feel.md) task 1.
