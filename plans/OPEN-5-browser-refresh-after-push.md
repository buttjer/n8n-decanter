# Plan 5 — Browser refresh after push

**Priority:** P2 (AppleScript reload) / P3 (livereload channel, upstream spike — needs a live instance)
**Status:** Not started
**Theme:** After a successful push, the n8n editor tab still shows the pre-push
workflow; find a way to refresh it automatically so the browser never lies.

## Why

The edit loop is: edit locally → `push` (or `watch` auto-push) → look at the
result in the n8n editor. Today the last step is a manual ⌘R, and forgetting it
is worse than an inconvenience: an editor holding the stale version invites
in-browser edits on top of outdated code. n8n's own `versionId` conflict check
softens that (saving from a stale editor warns — verify, see Direction F), but
an auto-refresh closes the gap properly and makes `watch` feel like a real
live-reload loop.

## Source

Raised in conversation 2026-07-17. No separate backlog entry — since `IDEAS.md`
was retired into `plans/`, this plan is its own backlog entry.

## Directions (design decision — open)

All directions share the same hook point: after a successful PUT in
`lib/push.mts` / `pushSingleNode` (`lib/watch.mts`), with `config.host` and the
workflow id in hand the editor URL is `${host}/workflow/${id}`. Whatever wins
should live behind one small `lib/reload.mts` + a `decanter.config.json` knob
(e.g. `"browserReload": "applescript" | "cdp" | "livereload" | false`), so the
mechanisms stay swappable.

### A. Baseline: print the URL, lean on n8n's staleness guard

Do nothing active; print `${host}/workflow/${id}` after push and rely on n8n's
`versionId` conflict prompt to stop stale saves. Zero cost, zero risk, and the
fallback path for every other direction. (Plain `open <url>` is *not* a variant
worth keeping: it spawns a new tab per push instead of reloading the existing
one.)

### B. OS-level tab reload via AppleScript (macOS)

`osascript` enumerates tabs of Chromium-family browsers (Chrome/Edge/Arc/Brave
share the AppleScript dialect: `reload tab`) or Safari (`do JavaScript
"location.reload()"`, needs the "Allow JavaScript from Apple Events" developer
setting) and reloads every tab whose URL starts with `${host}/workflow/${id}`.

- **Pros:** no browser install/flag at all; ~50 lines; matches the primary dev
  machine (darwin).
- **Cons:** macOS-only (no-op elsewhere); one-time TCC Automation permission
  prompt; per-browser dialects; a dirty editor tab triggers the native
  beforeunload dialog and blocks until answered (arguably a feature — it
  protects browser-side WIP).

### C. Chrome DevTools Protocol

Browser launched with `--remote-debugging-port`; decanter queries
`http://127.0.0.1:<port>/json`, finds matching targets, sends `Page.reload`
over the target's WebSocket.

- **Pros:** cross-platform, no extension, precise targeting, can bypass or
  honor beforeunload deliberately.
- **Cons:** the user must run their daily browser with a debug flag — real
  friction and a local-security hole (any local process can drive the browser);
  recent Chrome additionally requires a separate `--user-data-dir` for remote
  debugging. Realistic only for dedicated dev-browser setups.

### D. Livereload channel: local WS/SSE server + userscript

The classic livereload pattern. `watch` hosts a tiny WebSocket/SSE server on a
well-known localhost port; one-shot `push` does a fire-and-forget POST to it if
something is listening. A Tampermonkey userscript, shipped in `template/` as
`n8n-reload.user.js.example` (per the `.example` convention), matches the n8n
origin, connects to the local port, and on `{event: "pushed", workflowId}`
reloads iff the current route is that workflow **and** the editor has no
unsaved changes (dirty check → decline + console note instead of clobbering).

- **Pros:** cross-platform and cross-browser; precise; the only direction that
  can *check dirty state before reloading*; fits `watch`'s inner-loop story.
- **Cons:** one-time userscript install; a port to own; verify mixed-content
  behavior (https n8n page → `ws://127.0.0.1` is allowed in Chromium as a
  trustworthy origin, Safari historically stricter).

### E. Pull-based userscript, zero CLI changes

Userscript polls n8n's own session-authenticated REST
(`/rest/workflows/:id`, same origin) every few seconds, compares
`versionId`/`updatedAt`, reloads on change. Catches *any* external change
(decanter, a teammate, another machine), needs no decanter code at all — but
polls constantly and still requires the userscript install. Natural fallback
mode inside D's userscript rather than a standalone direction.

### F. Ride n8n's native push channel (upstream spike)

The editor already holds a push connection (`/rest/push`) for execution and
collaboration events. Spike against a live instance: does a public-API PUT
make current n8n versions show a "workflow updated" banner or refresh? If yes,
document the minimum version and ship nothing. If no, file an upstream feature
request ("notify open editors on external workflow update") — zero-maintenance
long-term, but the timeline isn't ours.

### Rejected

- **Iframe wrapper page** (decanter serves a page embedding the editor,
  reloads the iframe): n8n's `X-Frame-Options`/CSP `frame-ancestors` and
  SameSite auth cookies make this a dead end.

## Tasks

1. **Spike F first** next time a live instance is at hand (pairs with the other
   "needs live API" open questions in PLAN.md): observe what the editor does on
   an external PUT, both idle and mid-edit. Outcome may delete this plan.
2. Add the shared hook: `lib/reload.mts` called after successful push in
   `lib/push.mts` and `pushSingleNode`, plus the `browserReload` config knob
   (default `false`; reload failures are warnings, never push failures).
3. Implement **B** (AppleScript) as the first real mechanism — smallest
   clearly-useful step on the primary platform.
4. If/when the loop matters cross-platform or the dirty-check matters: **D**
   (livereload server in `watch` + templated userscript, with E's polling as
   fallback mode).

## Acceptance / verification

- Push with `browserReload` configured and the workflow open in a browser tab →
  tab shows the new version without manual reload; other tabs untouched.
- Push with a *dirty* editor tab → browser-side edits are not silently lost
  (B: native dialog appears; D: reload declined).
- Push with no browser open / unsupported OS / reload mechanism failing →
  push still succeeds, warning only.
- e2e suite unaffected (mechanisms are all no-ops without config/browser).

## Notes

- **CHANGELOG:** the config knob and any shipped userscript template are
  user-facing → `[Unreleased]` Added entries.
- **PLAN.md:** adopting a direction adds a new flow (post-push notify) and
  possibly a template file — raise with the user before writing it into
  PLAN.md (per `CLAUDE.md`).
- Reloading the browser is downstream-only; it never feeds back into sync
  state — no `.decanter.json` changes in any direction.
