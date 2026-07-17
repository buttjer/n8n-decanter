# Ideas / Todos

Free-form backlog. `- [ ]` open, `- [x]` done.

**Priority:** `[P1]` do first (small, clearly-right, high-value, offline) ·
`[P2]` valuable but more scope/design · `[P3]` deferred (large, speculative, or
needs a live n8n instance). Tags added 2026-07-17.

**Recommended first three batches** are planned out in [`plans/`](plans/) — pull
the P1s forward:

1. [Trustworthy edit loop](plans/1-trustworthy-edit-loop.md) — green-by-default,
   workflow-scoped hook/typecheck feedback.
2. [Offline validation + rename](plans/2-offline-validation-and-rename.md) —
   structural checks in `validateWorkflowDir`, then an atomic `rename` verb.
3. [Local run/diff fidelity](plans/3-local-run-and-diff-fidelity.md) — seed
   staticData in `run`, `status --diff`, execution-dataset fixtures.

---

- [ ] **[P3]** Transform to TypeScript Project (→ [plans/6](plans/6-typescript-migration.md); implemented + documented on branch `typescript-migration`, editor spot-check pending)
- [ ] **[P2]** js node files to kebab-case and moving them into the sub dir workflows/*/code/
- [ ] **[P1]** currently js files throw IDE errors like "A 'return' statement can only be used within a function body.ts(1108)" or say that variables can't be redeclared, even if they are not. I think this is a scope issue. How to solve this? (redeclare half → [plans/1](plans/1-trustworthy-edit-loop.md); TS1108 editor squiggle → [plans/4](plans/4-editor-node-diagnostics.md))
      - Note: the redeclare half is addressed by `moduleDetection: "force"`
        (currently uncommitted in `template/tsconfig.json.example` and root
        `tsconfig.json`). The TS1108 function-body half only affects the
        editor's own tsserver; the CLI typecheck already wraps node files
        (`scripts/typecheck.mts`).
- [ ] **[P1]** the typecheck hook, just to the workflow it is currently worked on. Not global. (→ [plans/1](plans/1-trustworthy-edit-loop.md))
      - Mechanics: the id filter on `check` only scopes the *layout* checks;
        `runTypecheck` always runs project-wide. Two parts: (1) teach
        `scripts/typecheck.mts` an optional path filter — still compile the whole
        project (cross-file types need it) but only report/count diagnostics
        under the given dir; (2) have `template/.claude/hooks/verify.mjs.example`
        read `workflowId` from the sibling `.decanter.json` and pass it (note
        `findWorkflowDir` matches on the state id, not the folder name).
- [ ] **[P1]** Ad a workflow validator and offering it the project using llm as command similar to others (→ [plans/2](plans/2-offline-validation-and-rename.md))
      - **[P1]** offline structural checks — fold into `validateWorkflowDir` (no
        new verb; shares the code path with `check`, the push gate, and `watch`):
        every connection key/target resolves to a real node name; node name and
        id uniqueness; orphan code files (a `.js`/`.ts` with no owning
        placeholder); dangling `$('Name')` references in code files.
      - **[P2]** LLM-based semantic validation as a command (the original idea).
- [ ] **[P2]** pull latest execution datasets and put them into workflows/*/exectuions/%id% do that on pull and also as seperate command for the llm working on workflows. (→ [plans/3](plans/3-local-run-and-diff-fidelity.md))
      - Pairs with a `run --from-execution <id>` flag (capture a real fixture).
- [ ] **[P3]** Real e2e test or simulation suite: Is there a way to really execute the workflow with the n8n engine using executions data as a mock/dry run? Also making sure nothing is really written though api's or similar. But also keep in mind, executions data can be flawed or changed in the future.
- [ ] **[P2]** `bundle: true` for `.ts` node compiles so value imports from `shared/`
      get inlined into the pushed code (today only type-only imports work —
      see the shared-code caveat in PLAN.md).
- [ ] **[P3]** n8n folder hierarchy in the sync layout, if the API exposes folder
      placement (PLAN.md milestone 4 — needs a live instance to verify).
- [ ] **[P3]** Verify against the live instance that PUT preserves tags/pinned data
      on an untouched pull→push round-trip (open question in PLAN.md).
- [x] Git-commit after every successful push of a workflow (committing that
      workflow's folder) to keep versioning. Behind a config flag,
      default: `true`.
- [ ] **[P2]** Modification-aware template refresh (conffile-style): record copy-time
      hashes of template files in a manifest at init; on re-init update
      pristine files (after confirm), never touch user-modified ones, and
      report drift. Replaces the blunt `init --force` recopy.
- [ ] **[P3]** `n8n-globals.d.ts` sourcing. Today it's a hand-written "pragmatic subset"
      shipped in `template/` as a byte-identical copy of the repo's root file →
      two copies that can drift.
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
            the Code-node sugar; and the public API v1 doesn't cleanly expose the
            running n8n version to pin against. Adds an online dependency to an
            otherwise-offline tool.

## New (from CLI-usage feedback, 2026-07-17)

- [ ] **[P1]** `n8n-globals.d.ts` stub is missing `Duration` and `Interval`
      (Luxon). `template/AGENTS.md.example` advertises them and `lib/run.mts`
      already provides them via luxon — only the `.d.ts` lacks the two
      `declare class` stubs (in both the root and template copies). One-minute
      fix; closes the three-surface inconsistency. (→ [plans/1](plans/1-trustworthy-edit-loop.md))
- [ ] **[P2]** `run` staticData seeding: `run` doesn't expose
      `$getWorkflowStaticData` at all, so a node that uses it dies with a
      ReferenceError — even though `lib/run.mts` already parses the
      `workflow.json` whose `staticData` it would seed from. ~10 lines.
      (→ [plans/3](plans/3-local-run-and-diff-fidelity.md))
- [ ] **[P2]** `rename` verb — atomic node/workflow rename that performs the
      4-step dance AGENTS.md documents as a manual checklist (name → connection
      keys+targets → `$('…')` in every code file → filename + placeholder). Node
      renames only; workflow renames are cosmetic (id-authoritative). Pairs with
      the dangling-`$('…')` validator. (→ [plans/2](plans/2-offline-validation-and-rename.md))
- [ ] **[P2]** `status --diff` — render a content diff of local vs live
      (respecting placeholder / compiled-marker rules). Detection already exists:
      `lib/status.mts` does four-way per-node classification incl. compiled-TS
      hashing; only the diff rendering is missing. (→ [plans/3](plans/3-local-run-and-diff-fidelity.md))
- [ ] **[P3]** `add` verb — scaffold a Code node (uuid → node object → `//@file:`
      placeholder → source file) in one step. Lower priority than `rename`;
      node creation is rarer than renaming.
