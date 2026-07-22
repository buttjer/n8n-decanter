# Plans

This folder is the whole backlog (the former `IDEAS.md` was absorbed here,
2026-07-17). A numbered plan is an item (or batch of related items) fleshed out
enough to start; [Plan 0](BACKLOG.md) is the grab-bag of open
items not yet claimed by one. Recommended order:

1. [Trustworthy edit loop](DONE-1-trustworthy-edit-loop.md) — make the hook/typecheck
   feedback green-by-default and scoped to the workflow being edited. Everything
   else the reviewer asked for only pays off once green is the default state, so
   this goes first.
2. [Offline validation + rename](DONE-2-offline-validation-and-rename.md) — turn the
   most fragile manual invariants (renames, connection integrity, orphan files,
   `$('…')` references) into machine-checked ones, then add an atomic `rename`.
3. [Local run/diff fidelity](DONE-3-local-run-and-diff-fidelity.md) — make offline
   iteration trustworthy: seed staticData in `run`, add `status --diff`, and
   fetch real execution datasets (`executions` verb, gitignored temp data for
   agent-built fixtures). Done — `run --from-execution` deferred to
   [Plan 0](BACKLOG.md).
4. [Editor node diagnostics](DONE-4-editor-node-diagnostics.md) — a TS
   language-service plugin that suppresses the editor-only TS1108/1375/1378 false
   positives on node files. Related to Plan 1's edit-loop work but larger
   (needs a load-path spike), so it trails the first three. Done — plugin
   ships in `template/decanter-ts-plugin/` (released in 0.2.0); manual editor
   verification passed once the one-time *Use Workspace Version* consent
   was clicked.
5. [Browser refresh after push](DONE-5-browser-refresh-after-push.md) — auto-refresh
   the n8n editor tab after a successful push, via a transparent dev proxy that
   injects an SSE live-reload client during `watch` (opt-in `browserReload`).
6. [TypeScript migration](DONE-6-typescript-migration.md) — convert the CLI's own
   source to strict `.mts` run natively via Node type stripping (no build
   step).
7. [Engine-true simulation suite](DONE-7-engine-true-simulation-suite.md) —
   replay a whole workflow through the real n8n engine offline: network nodes
   pinned from captured executions, pure nodes run for real, enforced
   no-side-effects. **Done 2026-07-21** (Docker backend): the `simulate` verb
   with a per-node diff, `--pin`, picker entry, and a browsable viewer; gap
   handling via the `mock` namespace (committed, hand-fillable `mocks/` scenarios
   + offline `mock check` — no LLM API); and tier-1/tier-2 loop handling. The
   dependency-free **npx backend was split to [Plan 26](OPEN-26-npx-engine-backend.md)**.
8. [Folder hierarchy in sync layout](BLOCKED-8-folder-hierarchy-in-sync-layout.md) —
   local dirs above a workflow folder become its n8n folder path, pushed
   one-way via the folders public API (the API can write placement but not
   read it); pull mirroring ships feature-detected so it self-activates once
   upstream exposes reads. Gated on a live-instance spike, so it trails the
   offline work.
9. [Test & stability quick wins](DONE-9-tests-stability-refactoring.md) —
   the no-brainer hardening half: fast `node:test` unit tests for the pure
   core, the corrupt-`.decanter.json` crash fix (one broken state file
   currently breaks every command), small e2e/proxy coverage gaps, and
   mechanical dedupes. Fully offline, no decisions needed — can interleave
   with any other plan.
10. [Hardening: bigger refactors & decision-gated work](DONE-10-hardening-bigger-refactors.md) —
    the rest of the hardening split: behavior changes (timeouts, `status`
    exit codes, debug switch), the deliberately-diverged dedupes
    (kebab-rename machinery, `code/`-parent lookup), watch testability, and
    CI. Each task needs a decision or checking first; lands after Plan 9's
    tests exist as the safety net.
11. [CLI look & feel](DONE-11-cli-look-and-feel.md) — color, progress, and a
    logo strictly TTY-gated; workflow-name arguments, shell completion, and a
    `list` verb. Piped output stays plain and line-oriented (LLM/script safe —
    and fixes today's ANSI leak into pipes).
12. [Structural watch](DONE-12-structural-watch.md) — watch also pushes
    `workflow.json` saves, gated by a 3-way conflict check (session baseline)
    with interactive merge / keep-local / keep-remote resolution; every watch
    session starts with a safety commit + pull. Done — live verification
    via the Plan 15 smoke suite, a scripted pty `[r]` drive, and a
    user-confirmed browser reload.
13. [Open-source release](DONE-13-open-source-release.md) — everything between
    "the code is done" and public on GitHub + npm: identity rewrite, repo
    hygiene, publish build, CI, tarball verification, security settings,
    branch protection. Done — repo is public with a live ruleset, and
    `npm publish` reached the registry (v0.3.2, matching `main`).
14. [Bundle `shared/` code into TS pushes](DONE-14-bundle-shared-code-into-ts-pushes.md) —
    make imports from `shared/` work in `.ts` nodes (types *and* values) via
    hoist→wrap→bundle at push time; no-import nodes keep byte-identical
    output. The spike found today's docs wrong: no import compiles at all in
    a `.ts` node — the plan corrects PLAN.md's caveat alongside.
15. [Docker n8n smoke suite](DONE-15-docker-n8n-smoke-suite.md) — dev-only,
    opt-in integration suite (`npm run test:smoke`) against a pinned n8n
    container: proves bundled nodes execute in the real sandbox and
    re-verifies the recorded API semantics (publish model, tags/pinned
    round-trip) on every version bump. Nothing user-facing.
16. [Documentation website](DONE-16-docs-website.md) — static docs site
    (Astro + Tailwind, `website/` subproject) carved out of the README:
    landing page, per-verb CLI reference, concepts, agent docs; deployed to
    GitHub Pages once the repo is public (Plan 13). Theme tokens slot in
    user-provided Tailwind settings.
17. [Public trust pass](DONE-17-public-trust-pass.md) — pre-release
    hygiene on top of Plan 13: 100%-TypeScript language stats via
    `.gitattributes`, SECURITY.md, stale-docs fix, remote branch cleanup;
    records the history/secrets audit verdicts (history kept, no rewrite).
18. [pinData smoke seeding](DONE-18-pindata-smoke-seeding.md) — closes the
    pinData half of the tags/pinned-data round-trip check: the public API
    *can* write `pinData` on n8n ≥ 2.30.7 (the recorded "cannot" was a
    stale 1.x-era claim), so the smoke suite seeds it via the API and
    asserts it survives an untouched pull→push round-trip. Scoped to
    n8n ≥ 2.30.7 only — no fallback seeding route.
19. [Interactive workflow picker](DONE-19-interactive-workflow-picker.md) —
    bare `n8n-decanter` in an inited project becomes a TTY-only
    type-to-filter picker (pulled workflows green, unpulled remote ones
    yellow) with a follow-up verb menu; piped invocations keep printing
    usage. `completion` stays alongside it (decided 2026-07-19).
20. [CLI publish lifecycle](DONE-20-cli-publish-lifecycle.md) — close the
    n8n 2.x workflow lifecycle from the CLI: `publish`/`unpublish` plus
    `create` (blank server-born draft, pulled immediately) and `delete`
    (confirmation-gated, local folder untouched), a version-aware `status`
    line, and a stale-fixture warning for `executions`. Groups three backlog
    items off PLAN.md's publish-semantics research + a user extension
    (2026-07-20); endpoint/field shapes gated on live smoke verification. Owns
    the `createWorkflow` method Plan 21's `duplicate` reuses. Done 2026-07-20 —
    all four endpoints live-verified against 2.30.7 and asserted by the smoke
    suite. Picker menu wiring (state-aware publish/unpublish toggle) left to
    Plan 19's surface as a follow-up.
21. [Local authoring helpers](DONE-21-repo-authored-workflows.md) — `add` verb
    (scaffold a Code node in one step, offline) and `duplicate` verb (clone an
    existing workflow into a new remote one via 2.x `POST /workflows`, landed
    through a fresh pull). Both preserve the pull-first model — the earlier
    `push --create` idea, which would have inverted it, was dropped
    (2026-07-20). Done 2026-07-20 — both verbs land with e2e + unit coverage;
    the smoke suite exercises the real `POST /workflows` (create/duplicate
    share it). Picker menu wiring deferred to Plan 19.
22. [Test suite depth](DONE-22-test-suite-depth.md) — cover the interactive
    surfaces no test drives today (picker terminal IO, watch conflict prompts,
    watch↔proxy wiring) via injected streams (no pty dep), decouple the
    monolithic e2e for isolation/legibility, and extend the Docker smoke suite
    to a 2.x version matrix + polling instead of fixed sleeps. Done —
    landed 2026-07-20 (see the plan's "Outcome" section).
23. [Picker visual refinements](DONE-23-picker-visual-refinements.md) — feed
    the Plan 16 docs-site picker *simulation*'s styling back into the real
    `lib/picker.mts`: aligned id column, `●`/`○` shape-based status glyphs
    (retiring the `(not pulled)` words), a per-stage title, and the first pure
    `renderLines` tests. Presentation only — the state machine is untouched
    (`executions` in the verb menu already shipped in v0.3.0). Proposed
    2026-07-20.
24. [Shared-code imports in `.js` nodes](OPEN-24-shared-code-in-js-nodes.md) —
    let a `.js` node `import` from `shared/` (and opted-in npm packages) the
    way `.ts` nodes already can (Plan 14), bundled into the pushed node.
    Changes the `.js` sync contract, so a real design pass. Proposed 2026-07-21.
25. [Read data tables (dev/debug)](DONE-25-data-tables-read.md) — a read-only
    `data-tables` verb that pulls n8n data-table schemas + rows into local
    gitignored files so you can develop/debug against real table contents;
    config-gated, with the read scopes added to the recommended key. Done
    2026-07-21 — endpoints + `dataTable:*` scopes live-verified on n8n 2.30.7
    and 2.31.4; unit + e2e + smoke green.
26. [npx engine backend for `simulate`](OPEN-26-npx-engine-backend.md) — a
    dependency-free `npx n8n@<ver>` engine backend so `simulate` runs without
    Docker (the accessibility default Plan 7 intended). The headless diff run
    is npx's home; the browsable viewer stays Docker-preferred. Split from
    Plan 7 2026-07-21.
27. [Verb-first CLI grammar, node namespace, kebab folders](DONE-27-verb-first-cli-grammar.md) —
    a breaking grammar pass: the verb comes first (`n8n-decanter <verb>
    <workflow>`), node ops move under a `node` subcommand namespace
    (`node create`/`node rename`/`node run`), a ref-taking verb with no ref
    opens the picker on a terminal, new workflow folders are kebab-case with the
    display name cached in `.decanter.json`, and the help/docs get one
    placeholder vocabulary + terse grouped descriptions. Proposed 2026-07-21.
28. [Python Code nodes](OPEN-28-python-code-nodes.md) — extract n8n **Python**
    Code nodes (`language: "python"`, source in `pythonCode`) into `code/<node>.py`
    files with full round-trip parity (pull/push/status/watch/check +
    `add --python`), mirroring the JS/TS flow. Python is verbatim like `.js` — no
    compile, marker, bundling, or `.remote` flow — so it funnels through one new
    source-field abstraction in `lib/util.mts`. Offline `run` stays JS-only.
    Proposed 2026-07-21.
30. [Agent/LLM working ergonomics in a sync dir](OPEN-30-agent-llm-working-ergonomics.md) —
    optimize how a coding agent works in a synced dir: codify session-start
    orientation (read-only `status` is the "pull-first" check; recommend a pull
    only when it shows drift, keeping pull user-gated), promote the grounding
    tools beyond n8n-mcp (`executions`/`data-tables`/`simulate` + version-matched
    docs) into an explicit research ladder, and add a canonical loop picture +
    allowlist audit. Docs-first (P1) with small decision-gated tooling (P2).
    Distinctive-features group (agent-native tooling). Proposed 2026-07-21.
29. [Picker polish + brand-orange CLI logo](OPEN-29-picker-recency-sort-and-force-retry.md) —
    three CLI polish wins: list picker workflows **newest-synced first** (recency
    from `.decanter.json` mtime — no schema change); offer a special
    **retry-with-`--force`** confirm (default No) when a picker-run verb fails the
    drift guard; and render the banner logo in the **website's brand orange**
    (truecolor `#E18428`, graceful 256/16-color fallback) instead of red.
    Proposed 2026-07-21.
31. [Sandbox `run` for untrusted node code](OPEN-31-run-sandbox-boundary.md) —
    give `node run` an actual execution boundary so agent-generated code is
    **safe by default** (no host `process`/`fetch`/`import()`), with `--unsafe`
    to opt back into today's full-host-access behavior. Supersedes the
    doc-only "narrow `run`" backlog item with enforcement. Mechanism decided:
    `worker_threads` scrubbed context (option A), no A/B config toggle. Breaking
    (default execution semantics change). Proposed 2026-07-22.
32. [MCP-native code layer](OPEN-32-mcp-native-code-layer.md) — strategy shift:
    stop owning canonical workflow sync via the public API; narrow decanter to the
    **Code-node source layer** (js/ts, shared code, TS, local run) and delegate
    workflow structure + lifecycle to n8n's built-in **MCP server + skills**. The
    invariant is Code-node source staying in git (lives in the file layer, survives
    the switch); structure-in-git drops to a read-only nice-to-have. Spike done
    (2026-07-22, n8n 2.30.7): byte-exact jsCode read/write, draft-first edits, and
    OAuth-first auth with refresh tokens all confirmed — the API can be dropped for
    the code path. Breaking; awaiting go/no-go. Proposed 2026-07-22.
34. [Post-pivot identity & messaging](BLOCKED-34-post-pivot-identity-and-messaging.md) —
    retell the outward story for the Code-node-layer scope once Plan 32 has
    executed (hard gate; command copy follows Plan 33's verb renames): README
    hero/bullets/caveats/compare reframe, website landing, docs framing sweep,
    npm/GitHub metadata, demo-GIF currency. Records the name verdict: the
    challenge (2026-07-22) concluded **`n8n-decanter` stays** — the pivot
    sharpens the decanting metaphor (the code is the pour; structure stays in
    the bottle), and a rename would stack breaking churn on the pivot for zero
    capability. Proposed 2026-07-22.

## Conventions

Every plan in this folder follows the same shape so they stay scannable and
mergeable:

- **Filename:** `STATUS-NN-kebab-title.md`, where `STATUS` is `OPEN` /
  `INPROGRESS` / `BLOCKED` / `DONE` (`BLOCKED` = designed but can't proceed
  until an external dependency clears, e.g. Plan 8 needs a licensed instance;
  mirrors the `**Status:**` header field; the backlog is
  the unprefixed `BACKLOG.md`). `NN` is the plan's stable id and rough
  running order (how it's referenced, e.g. "Plan 3"). It is *not* the priority —
  priority lives in the header field below, so a low-numbered plan can be P2 and
  vice versa. Numbers don't get reused once assigned.
- **Header block** (before the first `##`, one bold field per line):
  - `# Plan N — Title`
  - `**Priority:**` `P1` (do first: small, clearly-right, high-value, offline) /
    `P2` (valuable, more scope/design) / `P3` (deferred). A plan may split
    priorities per task (e.g. "P1 (validator) / P2 (rename)").
  - `**Status:**` `Not started` / `In progress` / `Done`.
  - `**Theme:**` one-line what-and-why.
  - `**Model:**` *(optional, advisory)* the Claude model best suited to
    *implement* the plan — Opus for high-reasoning / safety-critical / novel
    design, Sonnet for well-specified broad implementation, Haiku for
    mechanical low-risk work; may split per task. A hint, not a rule.
- **Sections**, in order:
  - `## Why` — the motivation/context.
  - `## Source` — the backlog entries ([Plan 0](BACKLOG.md), or
    the retired `IDEAS.md` in older plans) and any `PLAN.md` refs this plan
    closes, so nothing is orphaned when an item leaves the backlog.
  - `## Tasks` — numbered, each grounded in the real files it touches.
  - `## Acceptance / verification` — how you know it's done.
  - `## Notes` — CHANGELOG/PLAN.md implications, decisions, deferrals.
  - Optional as needed: `## Design decision`, `## Non-goals`, `## Rollout`.
- **Cross-link** related plans by relative path (e.g. Plan 1 ↔ Plan 4 share the
  TS1108 story).

When a plan is fully implemented, tested, and documented, flip its `**Status:**`
to `Done`, rename the file's prefix to `DONE-` (update inbound links), and check
off any matching [Plan 0](BACKLOG.md) box (per `CLAUDE.md`).

These are scoped work plans, not design changes — anything that alters the data
model or flows in `PLAN.md` must be raised with the user first (see `CLAUDE.md`).
