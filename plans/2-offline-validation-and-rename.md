# Plan 2 — Offline validation + rename

**Priority:** P1 (validator) / P2 (rename)
**Status:** Not started
**Theme:** convert the repo's most fragile manual invariants into machine-checked
ones, then make renames atomic.

## Why

The AGENTS.md rename checklist is a 4-step manual dance, and half-updated
workflows (dangling connections, orphaned files, stale `$('…')` references) are
exactly the breakage that checklist exists to prevent. `validateWorkflowDir`
already covers placeholder integrity and marker hygiene; extending it hardens
`check`, the push compliance gate, and `watch` **all at once** because they share
that code path. Once dangling-`$('…')` is machine-checked, an atomic `rename`
verb closes the loop and removes the failure class entirely.

## Source

- IDEAS: "Ad a workflow validator and offering it the project using llm as
  command similar to others" (P1 for the offline structural subset)
- IDEAS (new): `rename` verb (P2)

## Design decision

Do **not** add a separate `validate` verb. Extend `validateWorkflowDir` in
`lib/validate.mjs` — it is already shared by `check`, the push gate, and `watch`,
so the push guard hardens for free and we avoid a confusing `check`-vs-`validate`
split. (The LLM-based *semantic* validation from the original idea stays a
separate, later P2 command.)

## Tasks

### A. Structural checks in `validateWorkflowDir`

Extend the existing function (which already checks: no inline `jsCode`, every
placeholder resolves, no `@ts-n8n` marker in `.js`, `.remote.js` hygiene) with:

1. **Connection integrity.** Every key in `wf.connections` and every `node` in
   each connection target resolves to a real `wf.nodes[].name`. Dangling source
   or target → error.
2. **Uniqueness.** Node `name` collisions and node `id` collisions → error (both
   corrupt the id→file map and `$('…')` resolution).
3. **Orphan code files.** A `.js`/`.ts` in the workflow dir (excluding
   `*.remote.js` and `*.d.ts`) that no `//@file:` placeholder references → error
   (today only stray `*.remote.js` warns).
4. **Dangling `$('Name')` references.** Scan each referenced code file for
   `$('…')` / `$("…")` literals and assert the name exists in `wf.nodes`.
   - Literal miss → error. Non-literal (`$(var)`) → skip (can't resolve
     statically); optionally a warning. Keep the scan a simple regex over source
     — no full parse — and document the heuristic limits inline.

### B. `rename` verb

CLI: `n8n-decanter rename <workflow-id> "<old node>" "<new node>"` (node rename),
and `n8n-decanter rename <workflow-id> --workflow "<new name>"` (workflow rename).

Node rename performs the 4-step dance atomically:
1. `node.name` in `workflow.json`.
2. `wf.connections` — both the object keys and every `{ node: … }` target that
   references the old name.
3. `$('old')` / `$("old")` → new name in **every** code file in the folder.
4. The source filename + its `//@file:` placeholder, and the `nodes[nodeId].file`
   entry in `.decanter.json` if the filename changes.

Workflow rename just sets `wf.name`; the folder is cosmetic (the id inside
`workflow.json` is authoritative), so a rename-on-next-pull is fine.

Guardrails: refuse if the new node name already exists (would violate the new
uniqueness check); run `validateWorkflowDir` after the rewrite and fail loudly if
anything is left dangling.

## Acceptance / verification

- e2e: a workflow with a deliberately broken connection / orphan file / dangling
  `$('…')` now fails `check` (and `push`) with a clear message; a clean workflow
  still passes.
- e2e: `rename` a node that is referenced in a connection and in another node's
  `$('…')`, then `check` is green and the code still runs via `run`.
- `npm test` + `npm run typecheck` pass.

## Notes

- CHANGELOG: the new validator errors are guard rules and `rename` is a new CLI
  command — both user-facing, add entries under `[Unreleased]`.
- The new checks may surface pre-existing issues in already-pulled workflows;
  that's the point, but call it out in the CHANGELOG as a **Changed** guard.
