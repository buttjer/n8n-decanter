# Plan 52 — Remove the `watch` browser-reload proxy (rely on n8n-native live reflect)

**Status:** Not started
**Priority:** P2 (deletes a real data-loss risk + ~440 LOC + a concept doc, and
retires two backlog drafts — a net simplification, not a feature)
**Source:** reframes the merged `draft/52` proxy-**hardening** note (#124) into a
**removal** — the research below made hardening moot. Supersedes
[`draft/48`](../draft/48-watch-proxy-trust-model-docs.md) (proxy trust-model docs
— nothing to document once it's gone). Grounded in the source-verified
`n8n-editor-live-reflects-mcp-edits` memory.
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** n8n 2.x **natively** reflects an MCP `update_workflow` draft edit in
the open editor (soft canvas re-render, dirty-safe) — so decanter's injected
live-reload proxy ([Plan 5](../done/5-browser-refresh-after-push.md),
[`lib/proxy.mts`](../../lib/proxy.mts)) is redundant *and inferior*. Delete it;
`watch` becomes: push code to the draft (MCP) + print the editor deep-link.
**Model:** Sonnet (mechanical deletion + docs sweep; the one care point is
leaving `watch`'s remaining flow — startup safety-commit + pull, code push,
deep-link print — intact).

## Why

The proxy's *only* job is to force an editor reload after a push. Verified
against n8n 2.30.7 (source-traced): decanter's `push` → MCP `update_workflow` →
`collaborationService.broadcastWorkflowUpdate` → a `workflowUpdated` push → the
open editor **re-fetches and soft-re-renders the canvas** — no `location.reload()`.
And it's **dirty-safe**: if the viewer's editor has unsaved edits, n8n *skips*
the refresh and warns, preserving them — whereas the proxy's hard reload would
**destroy** them (the exact "biggest real risk" the hardening note named). So the
proxy is not just redundant; on its highest-risk path it's *worse* than doing
nothing. Removing it:

- deletes **~440 LOC** ([`lib/proxy.mts`](../../lib/proxy.mts) 226 +
  [`test/proxy.mts`](../../test/proxy.mts) 214) and a whole concept doc;
- **retires two drafts** — this plan's former hardening self **and**
  [`draft/48`](../draft/48-watch-proxy-trust-model-docs.md);
- sheds the https/Secure-cookie "best-effort" caveats;
- fits the Plan 32 grain — **let n8n own its editor** instead of decanter
  injecting `<script>` into n8n's HTML.

Requires n8n 2.x's collaboration stack (presence + single-writer lock +
`workflowUpdated`) — already implied by decanter's MCP floor (~2.13+).

## Tasks

1. **Delete the proxy.** Remove [`lib/proxy.mts`](../../lib/proxy.mts) and
   [`test/proxy.mts`](../../test/proxy.mts).
2. **`watch`** ([`lib/watch.mts`](../../lib/watch.mts)) — drop the proxy
   start/wiring; **keep** the startup safety-commit + pull, the per-save code
   push, and the editor deep-link print (Plan 11). Add a one-line dim note:
   "keep the n8n editor open — it updates live on each push."
3. **`push`** ([`lib/push.mts`](../../lib/push.mts)) — remove the `notifyPushed`
   call; drop `notifyPushed`/`startProxy`/`ProxyHandle` exports.
4. **Config** — remove `browserReload` + `proxyPort` from
   [`lib/config.mts`](../../lib/config.mts) + [`lib/types.mts`](../../lib/types.mts).
   **Breaking:** those config keys stop being honored (a CHANGELOG **Removed**
   entry; ignore-with-a-note if present, rather than error).
5. **Tests** — drop `browserReload`/proxy references in
   [`test/e2e.mts`](../../test/e2e.mts), [`test/smoke-n8n.mts`](../../test/smoke-n8n.mts),
   `test/unit/config.test.mts`, `test/unit/preflight.test.mts`,
   `test/unit/testrun.test.mts`.
6. **Docs** — delete [`docs/concepts/watch-live-reload.md`](../../docs/concepts/watch-live-reload.md);
   trim `docs/cli/watch.md`, `docs/getting-started/quickstart.md`,
   `docs/concepts/configuration.md`, `docs/faq/troubleshooting.md`, README. Add a
   short "the editor live-updates natively on push (n8n 2.x) — keep the tab open"
   note to `watch.md`.
7. **PLAN.md** — remove the browser-reload proxy section + the
   `browserReload`/`proxyPort` config fields; record n8n-native live-reflect as
   the replacement (and the write-lock caveat → `draft/53`).

## Acceptance / verification

- `lib/proxy.mts`, `test/proxy.mts`, the concept doc, and the two config keys are
  gone; `watch` still safety-commits, pushes code, and prints the editor URL.
- A manual check against a real n8n editor: after a `push`, the open editor
  reflects the change with no proxy.
- `npm test` + `npm run typecheck` green; docs three-surfaces synced; CHANGELOG
  **Removed** entry (Breaking).

## Notes

- **Breaking:** `browserReload` / `proxyPort` removed.
- The removal surfaces a *new* `push` failure mode — n8n's single-writer
  `LockedError` when a human is mid-edit — tracked separately in
  [`draft/53`](../draft/53-push-surface-write-lock-error.md).
- The in-browser "Test workflow" pinData gap (MCP can't persist pinData) is
  [`draft/54`](../draft/54-persist-pindata-for-browser-test.md).

## Non-goals

- Not re-implementing reload on the client side by any other means.
- Not touching the MCP push path or `watch`'s code-sync loop.
