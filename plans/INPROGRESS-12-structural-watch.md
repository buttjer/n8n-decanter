# Plan 12 — Structural watch: push workflow.json edits

**Priority:** P2
**Status:** In progress (implemented + offline-tested; live-instance verification pending)
**Theme:** Watch reacts to `workflow.json` saves and pushes structural edits, guarded by a 3-way conflict check with interactive merge/local/remote resolution — the IDE becomes a peer editor of the n8n UI.

## Why

Watch was a code-only fast path: structure flowed one-way UI → pull → git,
and a `workflow.json` edit needed a manual full `push`. Editing structure in
the IDE (or letting an agent edit it) and having it sync live is the natural
next step — but it breaks the "browser owns structure" invariant, so honest
conflict detection has to replace ownership. Safeguards are load-bearing:
watch must never silently clobber concurrent n8n-UI edits, and no local state
may be lost.

## Source

- User request (conversation, 2026-07-18): push `workflow.json` changes from
  watch; on conflict offer merge / reject remote / reject local; start every
  watch session with a pull + commit so nothing is lost.
- Closes the `PLAN.md` watch-section statement that watch never touches
  `workflow.json` (section rewritten with this plan).

## Design decision

- **Session baseline**: the 3-way check (local vs remote vs last-synced
  structure hash) uses an **in-memory** baseline, not
  `.decanter.json`'s `lastPulledWorkflowHash` — single-node pushes re-baseline
  the latter from their PUT responses, silently absorbing UI structural
  edits; the in-memory copy keeps them detectable across the session.
- **Merge is manual**: conflict resolution `[m]` writes a diff-friendly
  `workflow.remote.json` (placeholders substituted only where remote code
  still matches the last sync); no automatic 3-way JSON merge.
- **Warn only**: watch never rewrites local `workflow.json` mid-session —
  only the startup pull or the `[r]emote` choice does.
- **Startup = snapshot commit, then pull** (commit first — pull overwrites
  plain `.js` files and `workflow.json` unconditionally). The snapshot runs
  regardless of `commitOnPush`/`commitOnPull`; if it fails (no git), the
  startup pull is skipped rather than pulling over an unsnapshotted tree.

## Tasks

1. [x] `lib/prompt.mts` — `createPrompt` extracted from `lib/init.mts`
   (piped-stdin-safe readline helper), shared by init and watch.
2. [x] `lib/git.mts` — `commitWorkflowDir` returns
   `"committed" | "clean" | "failed"` (tri-state; not-a-repo → `"failed"`)
   so watch can gate the startup pull on it.
3. [x] `lib/watch.mts` — startup snapshot + pull + startup-conflict warning;
   second `fs.watch` on the workflow dir filtered to `workflow.json`;
   exported pure `structureAction(localHash, remoteHash, baseline)`
   (`skip | push | conflict`); conflict prompt (m/l/r/Enter, non-TTY skips,
   `--force` = keep-local); UI-edit early warning after node pushes; a
   pending structural push subsumes queued node pushes; re-arms watchers
   when a pull renames the folder; code-less workflows watchable.
4. [x] `lib/validate.mts` — warn while `workflow.remote.json` exists.
5. [x] Tests — `test/unit/watch.test.mts` (decision helper branches),
   `test/unit/validate.test.mts` (new warning).
6. [x] Docs — `PLAN.md` Watch-mode section + observations, `CHANGELOG.md`.
7. [x] **Mock-API end-to-end drive** (2026-07-18, real CLI subprocess + pty
   via `expect`): startup snapshot commit + pull with a dirty tree,
   structural push, anti-loop, formatting-only skip, node push + UI-edit
   warning, non-TTY conflict skip, prompt with `[m]` (merge-file content:
   remote-only node present, in-sync code as placeholder) and `[l]`
   (force push + stale-file cleanup), `check` warning. 27/27 checks.
8. [ ] **Live-instance verification** (needs a real n8n + browser): the
   `[r]emote` prompt choice (not driven above), PUT-response structure
   normalization (phantom re-push risk), browser reload on structural push.

## Acceptance / verification

- `npm test` + `npm run typecheck` green (82 unit / 41 e2e / 9 proxy ✓).
- Manual live script: start watch with a dirty tree → snapshot commit + pull
  land; rewire a connection in `workflow.json`, save → push + browser
  reload; make a UI structural edit, save `workflow.json` → prompt; verify
  each of m/l/r; confirm the pull rewrite does not re-trigger a push
  (anti-loop); outside git, watch warns and skips the startup pull.

## Notes

- Accepted footguns (documented in PLAN.md): `git checkout` rewriting
  `workflow.json` triggers a structural push/prompt; only PUT-whitelisted
  fields propagate (`active`, tags don't).
- Phantom re-push risk if the server's PUT response normalizes structure
  (baseline = response hash ≠ local file hash): accepted for v1; verify
  against a live instance, fix would be a post-push local rewrite
  (rejected for now — "warn only" decision).
- Deeper watch-loop e2e (spawned subprocess, kill after PUT) stays with
  Plan 10's "watch testability".
