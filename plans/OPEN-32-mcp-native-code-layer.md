# Plan 32 — MCP-native strategy: decanter as the Code-node code layer

**Priority:** P2 (strategy shift, spike-gated)
**Status:** Not started (spike pending)
**Theme:** Stop owning canonical workflow sync via the public REST API; narrow decanter's
scope to the **Code-node source layer** (js/ts files, shared code, TS features, diagnostics,
local run) and delegate workflow **structure + lifecycle** to n8n's own **MCP server + skills**,
used as n8n intends.
**Model:** Opus (novel design / product-identity decision).

## Why

Today decanter *owns the canonical workflow*: `GET /api/v1/workflows/:id` → strip each Code
node's `jsCode` to `code/<node>.js|.ts` → `PUT` the exact object back, with structural hashing
+ a drift guard. That machinery exists to keep `workflow.json` a lossless, git-diffable mirror.

n8n now ships a **first-party MCP server** (built-in, ~v2.13+; token env v2.20+) plus an
official **skills** pack — the intended agent-facing surface for *building and operating*
workflows, with a real capability the public API lacks: **draft-first edits + deliberate
`publish_workflow`**. See [[n8n-agent-grounding-landscape]] (Plan 30 grounding research).

The pivot: decanter stops trying to be the canonical sync tool (arguably table-stakes
"n8n-as-code" many tools do) and becomes **the Code-node craftsmanship layer** — the
distinctive thing (shared TS, type-check, local run/sim). Structure + lifecycle become
n8n/MCP/skills' job.

**Why the earlier "MCP can't do it" objection dissolves.** MCP's `update_workflow` is
*partial batched ops* (`setNodeParameter`, `updateNodeParameters`, `addNode`…) with **no
full-JSON-replace tool** — fatal if decanter keeps owning the whole object, but *exactly the
right shape* when the scope is a single node's `jsCode` param. The limitation becomes a fit.

## Design decision — the invariant and what flexes

Decided with the user (this session):

- **Invariant (non-negotiable): Code-node source (`.js`/`.ts`) stays in git.** This is *the*
  key feature. It lives in decanter's **file layer**, not the sync backend — so it survives a
  full API→MCP switch untouched. This is what makes the pivot safe.
- **Workflow structure in git → nice-to-have, read-only.** A read-only structure *snapshot*
  (for review/diff) if MCP can produce one cleanly; **missing some versions is acceptable**.
  Not a blocker, not canonical.
- **Node identity across structure edits → acceptable to handle.** Skills/MCP may
  `renameNode`/re-add nodes; the `code/<file>` ↔ node mapping (`.decanter.json`, keyed on node
  id) must survive that. Manageable, needs design.
- **Resolved by spike (2026-07-22): the API can be dropped for the code path.** MCP
  `get_workflow_details` returns **byte-exact `jsCode`** and `update_workflow`/
  `updateNodeParameters` writes it back **byte-exact to the draft** — so pure-MCP is viable
  for read *and* write of Code-node source. See Notes → Spike findings.

## Source

- [[n8n-agent-grounding-landscape]] — Plan 30 Theme C grounding research (official MCP is
  instance-aware but instance-mutating; off-by-default; token is UI/env-only; skills pack).
- This session's strategy discussion (2026-07-22).
- Related: Plan 20 ([DONE-20](DONE-20-cli-publish-lifecycle.md)) publish lifecycle is
  API-based (`activate`/`deactivate`, `versionId`/`activeVersionId`) — would re-base onto
  MCP `publish_workflow`/`unpublish_workflow`. Plan 25 (data-tables) also API-based.

## Tasks

1. **Spike (gate) — DONE 2026-07-22 (findings in Notes; all questions green).** Against local
   Docker n8n `n8nio/n8n:2.30.7` (reuse the smoke boot in `test/smoke-n8n.mts`). The
   load-bearing questions it answered:
   1. **Enable + probe:** `GET /mcp-server/http` non-404 with MCP env on.
   2. **Headless token mint:** owner setup → session cookie → find the internal `/rest/*`
      endpoint that mints the **MCP Access Token** (smoke already mints an API key via
      `/rest/api-keys` at `test/smoke-n8n.mts:207` — likely a sibling). Decides the
      onboarding-floor cost.
   3. **Read fidelity (decides API-drop):** does `get_workflow_details` return a Code node's
      **exact `jsCode`** (credentials-stripped ≠ params-stripped)? Diff vs. the public API GET.
   4. **Write + identity round-trip:** `setNodeParameter(jsCode)` → draft → `publish_workflow`
      round-trips cleanly, and the node mapping survives a `renameNode`.
   Record findings back into this plan's Notes.
2. **Ownership boundary + sync redesign** (spike-informed): decanter writes **only** the
   `jsCode` param of Code nodes, never structure. Redefine pull (read jsCode → files) and push
   (files → `setNodeParameter` → optional publish). Drop whole-workflow structural hashing,
   the PUT-canonical drift guard, `.remote.js` conflict flow, flat-layout rename migration —
   all tied to owning structure. Keep per-node content hashing.
3. **Node-identity mapping** across MCP structure edits (`renameNode`/add/remove) — keep
   `code/<file>` ↔ node stable in `.decanter.json`.
4. **Lifecycle re-base:** `publish`/`unpublish`/`create`/`delete` onto MCP tools
   (`publish_workflow`, `unpublish_workflow`, …) or keep on API — per spike.
5. **`init` onboarding + MCP auth — OAuth-first (user steer 2026-07-22, spike-confirmed).**
   **OAuth2 is the primary method; consent happens in `init`.** `init` is the interactive/TTY
   moment (user present, browser available), so n8n's authorization-code flow fits there:
   one-time browser consent → decanter stores the **refresh token** → headless runtime
   (`push`/`watch`/CI) refreshes access tokens **silently, no browser**. The earlier "OAuth
   can't do headless" worry conflated headless *runtime* (fine — refresh token) with headless
   *init* (the only place a browser is needed). No long-lived static secret, revocable.
   **CONFIRMED by spike (2026-07-22):** full flow works and issues a **`refresh_token`** —
   discovery `GET /.well-known/oauth-authorization-server` (`grant_types_supported` includes
   `refresh_token`, PKCE S256, `token_endpoint_auth_method: none`); `POST /mcp-oauth/register`
   (RFC 7591 dynamic client) → `GET /mcp-oauth/authorize` (302 → browser consent) →
   `POST /mcp-oauth/token` returns `access_token`+`refresh_token` (`expires_in: 3600`); the
   `refresh_token` grant then mints fresh access tokens with no browser. The **rotatable Bearer
   token** (`POST /rest/mcp/api-key/rotate`, owner cookie — Q2) drops to a **narrow fallback**
   for non-interactive provisioning (CI, no browser at init).
   - **The app needs only the standard `/mcp-oauth/*` + `/mcp-server/http` endpoints — NOT the
     internal `/rest/*`.** The `/rest/*` calls in the spike (`/rest/consent/approve`,
     `/rest/mcp/settings`, `/rest/mcp/workflows/toggle-access`) were headless-drive
     conveniences. In the real app: **consent is a browser click** in n8n's own UI (decanter
     opens the authorize URL, catches the code at a localhost callback); **enabling MCP + the
     per-workflow `availableInMCP` opt-in are guided UI steps** for the user (those internal
     endpoints are undocumented/version-fragile — automate only as optional, cookie-gated
     polish, never a hard dependency). Version floor still applies (~2.13/2.20).
   - **Read scope (spike-confirmed): OAuth grants no broader access than the token.** An OAuth
     access token hits the *same* per-workflow gate — `search_workflows` lists all workflows,
     but `get_workflow_details`/edit only work on `availableInMCP`-flagged ones. Auth method is
     orthogonal to workflow visibility.
6. **Read-only structure snapshot** (nice-to-have, last): if MCP yields clean structure JSON,
   write it to git read-only for review; else skip.
7. **Docs/changelog/PLAN.md** overhaul — the sync model changes fundamentally (Breaking).
8. **Picker: third state for MCP-unavailable workflows + pull guidance.** MCP's
   `search_workflows` lists **all** workflows, but only `availableInMCP` ones are readable
   (Q3 gate), so the picker can now show workflows it cannot yet pull. Extend the picker
   (Plan 19/[DONE-23](DONE-23-picker-visual-refinements.md)) beyond today's two states —
   pulled (green `●`), unpulled-but-available remote (yellow `○`) — with a **third: MCP-
   unavailable remote workflows in red**, sorted **third** (below green + yellow). Selecting a
   red one doesn't error: surface **guidance** — "this workflow isn't available in MCP; enable
   it from the workflow card or workflow settings," and offer to **toggle `availableInMCP` +
   pull** (via UI guidance by default; optional cookie-gated automation via
   `PATCH /rest/mcp/workflows/toggle-access` where creds allow — the fragile-internal-endpoint
   caveat from Task 5 applies). Non-TTY/piped invocations print the same guidance line-oriented.
   The availability signal comes from `search_workflows` / the `availableInMCP` flag, not a
   failed detail read.

## Acceptance / verification

- Spike answers Q1–Q4 with recorded evidence before any code lands.
- **Code-node source in git round-trips byte-exact** through the new MCP path (the invariant).
- A Code node edit lands on the **draft** and only goes live on explicit publish.
- Node mapping survives a structure-side rename.
- Smoke suite extended to drive the MCP path on the pinned container.

## Non-goals

- Full canonical workflow-in-git (downgraded to read-only nice-to-have).
- Byte-exact structure round-trip / version-complete history.
- Supporting instances below the MCP floor on the MCP path (they'd need the API path if kept).

## Notes

- **Breaking + strategy shift** — changes decanter's identity and the sync data model;
  PLAN.md must be rewritten, not patched, and this needs explicit user sign-off before Task 2.
- **Adoption-floor risk** is the main cost: MCP off-by-default + token mint + version floor
  become hard requirements on the MCP path (vs. today's "any n8n + API key").
- **Hybrid remains the fallback** if the spike shows `get_workflow_details` isn't jsCode-exact:
  read via API GET, write via MCP `setNodeParameter` to the draft — keeps the draft-first win
  without a pure-MCP dependency for reads.
- MCP tool surface is young/evolving — coupling the whole tool to it trades REST v1 stability
  for that churn; weigh in the go/no-go after the spike.
- **Spike findings (2026-07-22, n8n `2.30.7` in Docker — full recipe in AGENTS.md
  "Driving a real n8n in Docker"):** the pivot is **technically green**.
  - **Q1 MCP live:** `POST /mcp-server/http` → 401 without token (404 when off). ✓
  - **Q2 headless enable + mint (the adoption-floor cost):** *both* doable via the owner
    session cookie — `PATCH /rest/mcp/settings {mcpAccessEnabled:true}` enables (the
    `N8N_MCP_ACCESS_ENABLED` env did **not** flip it on 2.30.7); `POST /rest/mcp/api-key/rotate`
    returns a fresh raw MCP token. So `init` can enable + mint headlessly given a login —
    the floor is lower than feared. The **public API key is NOT a valid MCP bearer** (401).
  - **Q3 read fidelity:** `get_workflow_details` returns Code-node `jsCode` **byte-exact**
    (credentials-stripped ≠ params-stripped — my doc-derived worry was wrong), plus full
    structure + `versionId`/`activeVersionId`. Pure-MCP read is viable; a read-only structure
    snapshot to git is also feasible from this payload.
  - **Q4 write + draft:** `update_workflow`/`updateNodeParameters` writes `jsCode` **byte-exact
    to the draft only** (`versionId` bumps, `activeVersionId` stays null); `publish_workflow`
    activates. Confirms the API-inaccessible draft-first edit.
  - **New gate found:** workflows are invisible to MCP until per-workflow **`availableInMCP`**
    is set (`PATCH /rest/mcp/workflows/toggle-access {availableInMCP:true, workflowIds:[…]}`) —
    another onboarding step decanter must automate.
  - **Identity nuance confirmed:** `update_workflow` ops **address nodes by name**, not id
    (rename op is `{renameNode, oldName, newName}`); n8n keeps node ids across renames, so
    decanter's id-keyed `.decanter.json` map is the stable anchor — needs a name↔id
    reconciliation layer (Task 3).
  - **Full tool set (33):** incl. `get_workflow_details`, `update_workflow`,
    `create_workflow_from_code`, `publish_workflow`/`unpublish_workflow`,
    `get_workflow_version`/`restore_workflow_version`, `validate_workflow`, `test_workflow`,
    `execute_workflow`, `get_sdk_reference`, data-table + node-search tools.
  - **Residual costs (unchanged by spike):** version floor (~2.13/2.20), young/evolving tool
    surface, and the two per-instance/per-workflow opt-ins above.
