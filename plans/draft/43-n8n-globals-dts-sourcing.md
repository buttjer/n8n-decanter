# Plan 43 — `n8n-globals.d.ts` sourcing

**Status:** Draft
**Priority:** P3
**Source:** backlog item

Today it's a hand-written "pragmatic subset" shipped in `template/` as a
byte-identical copy of the repo's root file → two copies that can drift.

- **De-dup first:** have `init` copy the single root `n8n-globals.d.ts` instead
  of a static template duplicate (one source of truth; the e2e "template content
  matches" assertion needs adjusting).
- **Optional, opt-in `n8n-decanter types` refresh:** regenerate
  `n8n-globals.d.ts` from n8n's editor autocomplete globals (the version-tagged
  bundle in n8n's frontend source on GitHub), keeping the hand-written subset as
  the offline fallback. Low-priority caveats: the globals surface (`$`, `$input`,
  `$json`, Luxon `DateTime`, `$jmespath`) is stable across versions; there's no
  clean official drop-in `.d.ts`; n8n-mcp covers node schemas/params not runtime
  globals; `n8n-workflow` types describe the node-dev API, not the Code-node
  sugar; the public API v1 doesn't cleanly expose the running n8n version to pin
  against; and it adds an online dependency to an otherwise-offline tool.
