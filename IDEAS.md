# Ideas / Todos

Free-form backlog. `- [ ]` open, `- [x]` done.

- [ ] Transform to TypeScript Project
- [ ] js node files to kebab-case and moving them into the sub dir workflows/*/code/
- [ ] currently js files throw IDE errors like "A 'return' statement can only be used within a function body.ts(1108)" or say that variables can't be redeclared, even if they are not. I think this is a scope issue. How to solve this?
- [ ] the typecheck hook, just to the workflow it is currently worked on. Not global.
- [ ] Ad a workflow validator and offering it the project using llm as command similar to others
- [ ] pull latest execution datasets and put them into workflows/*/exectuions/%id% do that on pull and also as seperate command for the llm working on workflows.
- [ ] Real e2e test or simulation suite: Is there a way to really execute the workflow with the n8n engine using executions data as a mock/dry run? Also making sure nothing is really written though api's or similar. But also keep in mind, executions data can be flawed or changed in the future.
- [ ] `bundle: true` for `.ts` node compiles so value imports from `shared/`
      get inlined into the pushed code (today only type-only imports work —
      see the shared-code caveat in PLAN.md).
- [ ] n8n folder hierarchy in the sync layout, if the API exposes folder
      placement (PLAN.md milestone 4 — needs a live instance to verify).
- [ ] Verify against the live instance that PUT preserves tags/pinned data
      on an untouched pull→push round-trip (open question in PLAN.md).
- [x] Git-commit after every successful push of a workflow (committing that
      workflow's folder) to keep versioning. Behind a config flag,
      default: `true`.
- [ ] Modification-aware template refresh (conffile-style): record copy-time
      hashes of template files in a manifest at init; on re-init update
      pristine files (after confirm), never touch user-modified ones, and
      report drift. Replaces the blunt `init --force` recopy.
- [ ] `n8n-globals.d.ts` sourcing. Today it's a hand-written "pragmatic subset"
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
