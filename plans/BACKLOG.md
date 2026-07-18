# Plan 0 — Backlog

**Status:** Backlog — items graduate into their own plan (or get done directly)
**Theme:** Grab-bag of open items not yet claimed by a numbered plan; absorbed
from the retired `IDEAS.md` (2026-07-17).

## Why

`IDEAS.md` was retired; every entry already fleshed out lives in a numbered
plan's `## Source`. This file holds the remainder so nothing is orphaned.
`- [ ]` open, `- [x]` done — same check-off rules as before (fully done only).

## Items

- [x] **Kebab-case code layout** — js node files to kebab-case, moved into a
      `workflows/*/code/` subdir.
- [x] **Id-first argument order** — accept `n8n-decanter.mts [id...] <verb>`
      instead of / in addition to `<verb> [id...]`.
- [ ] **LLM semantic validation** — LLM-based *semantic* workflow validation as
      a command. Split out of the validator idea —
      [Plan 2](DONE-2-offline-validation-and-rename.md) covers only the offline
      structural subset and explicitly defers this.
- [x] **Bundle shared code into TS pushes** — `bundle: true` for `.ts` node
      compiles so value imports from `shared/` get inlined into the pushed code
      (today only type-only imports work — see the shared-code caveat in
      PLAN.md). (graduated to
      [Plan 14](INPROGRESS-14-bundle-shared-code-into-ts-pushes.md), whose spike
      found the premise wrong — *no* import worked in a `.ts` node, type
      imports included; implemented 2026-07-18 incl. an npm-package
      `bundleDependencies` allowlist, offline-tested)
- [ ] **Modification-aware template refresh** — conffile-style: record
      copy-time hashes of template files in a manifest at init; on re-init
      update pristine files (after confirm), never touch user-modified ones,
      and report drift. Replaces the blunt `init --force` recopy.
- [ ] **`add` verb** — scaffold a Code node (uuid → node object → `//@file:`
      placeholder → source file) in one step. Lower priority than `rename`;
      node creation is rarer than renaming.
- [ ] **Engine-true simulation suite** — real e2e test or simulation suite: is
      there a way to really execute the workflow with the n8n engine using
      executions data as a mock/dry run? Also making sure nothing is really
      written through APIs or similar. Keep in mind executions data can be
      flawed or change in the future. (graduated to
      [Plan 7](OPEN-7-engine-true-simulation-suite.md))
- [ ] **Folder hierarchy in sync layout** — mirror n8n's folder hierarchy, if
      the API exposes folder placement (PLAN.md milestone 4 — needs a live
      instance to verify). (graduated to
      [Plan 8](OPEN-8-folder-hierarchy-in-sync-layout.md) — API research done:
      placement is write-only, so the plan inverts to push-driven placement)
- [ ] **Tags/pinned-data round-trip check** — verify against the live instance
      that PUT preserves tags/pinned data on an untouched pull→push round-trip
      (open question in PLAN.md).
- [x] **Watch: deep-link URL to the workflow** — on `watch` start, print the
      editor URL pointing straight at the watched workflow
      (`<origin>/workflow/<id>`), using the browser-reload proxy origin when
      the proxy is running (today it only prints its root URL) and the
      configured upstream otherwise. Plain URLs are already cmd/ctrl-clickable
      in most terminals (VS Code, iTerm2, Windows Terminal); rendering it as a
      styled OSC 8 hyperlink is a style-layer concern —
      [Plan 11](DONE-11-cli-look-and-feel.md) task 1.
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
