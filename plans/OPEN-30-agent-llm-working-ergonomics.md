# Plan 30 — Agent/LLM working ergonomics in a sync dir

**Priority:** P2 overall, split per theme — **P1** for the pure-docs "orient
before you edit" + loop-clarity work (small, clearly-right, offline, high-value);
**P2** for the small tooling (instance version in `status`, research recipe, scaffold/allowlist
tuning), which carry design decisions.
**Status:** Not started
**Theme:** Make an LLM coding agent measurably more effective *and* safer the
moment it lands in a synced dir — codify session-start orientation ("check
`status` before you edit; pull-first when it drifted"), sharpen the offline loop,
and give the agent grounded knowledge tooling beyond the scaffolded n8n-mcp.
**Model:** Opus for the policy/flow wording in `template/AGENTS.md.example`
(agent-behavior, safety-critical); Sonnet for the mechanical doc-surface
propagation and any small verb/flag.

## Why

The scaffold already gives agents a strong **edit-time** contract — the
[template/AGENTS.md.example](../template/AGENTS.md.example) hard invariants, the
guard hooks, and the offline `check` / `node run` loop — plus one knowledge
source: the scaffolded **n8n-mcp** server ([.mcp.json.example](../template/.mcp.json.example),
node schemas / params / templates). What's thin is everything *around* the edit:

1. **Session start / orientation is uncodified.** An agent typically starts
   editing whatever is on disk. If the workflow drifted in the n8n UI since the
   last sync, it edits stale state and the eventual `push` either aborts
   (`pull first`) or — worse, if pushed `--force` — clobbers the UI edits. There
   is no "orient yourself first" step in the contract. *(Maintainer's prompt: "a
   pull before starting to work on a workflow is very recommended.")*
2. **Knowledge grounding is single-source.** n8n-mcp covers **static** node
   schemas, but not: the *instance's* n8n version and its behavior, the **real
   payload shapes** flowing through this specific workflow, or the decanter
   contract itself. Absent those, agents fall back to (often stale) training
   data. *(Maintainer's prompt: "Deep research? More tooling than the mcp?")*
3. **The best offline/grounding tools are under-surfaced in the loop.**
   `executions` (real payloads → `node run` fixtures), `data-tables`, and
   `simulate` (whole-workflow offline replay) all exist, but the agent docs
   frame the loop as just `node run` + `check`.

Agent-native tooling is a **stated differentiator** of this project (the
[README](../README.md) comparison table's "Agent-native tooling" row), so it
belongs in the **distinctive-features backlog group**, not parity — this plan
invests in it deliberately.

## Source

- New maintainer brainstorm (2026-07-21): optimize the LLM's dealings with
  n8n-decanter — session-start pull, deep research, tooling beyond the MCP. No
  prior `plans/` entry.
- Extends the agent surfaces: [template/AGENTS.md.example](../template/AGENTS.md.example),
  the per-agent scaffolds (`.claude/`, `.cursor/`, `opencode.json`),
  [docs/agents/overview.md](../docs/agents/overview.md) +
  [docs/agents/offline-loop.md](../docs/agents/offline-loop.md), and the
  `.mcp.json` / `settings.local.json` scaffold (PLAN.md §init).
- Builds on existing tools (no re-implementation): Plan 3 (`executions`;
  `run --from-execution` is deferred in [BACKLOG](BACKLOG.md)), Plan 7 / Plan 26
  (`simulate` + npx backend), Plan 25 (`data-tables`).
- **The docs half changes no PLAN.md flow.** The tooling half is gated on the
  decisions below.

## Design tension to resolve first — "pull before working" vs. "pull is user-gated"

The maintainer's instinct ("pull before starting is recommended") collides with
the settled policy that **`pull` is a live-instance op the agent runs only when
the user asks** (it writes local files and re-baselines drift). The resolution
this plan proposes — and the crux of Theme A — is:

> **The read-only `status` *is* the "pull-first" check.** `status` contacts the
> instance but writes nothing; it reports per-workflow drift / conflict /
> push-pending. So the recommended cold start is **`status` first**; only when it
> shows drift does the agent **recommend a `pull` and ask** — it never auto-pulls.

This keeps the existing safety gate intact while giving the agent the safety of
"knowing the remote state before editing." Keep the "pull only when the user
asks" policy unchanged.

## Tasks

Grouped by theme; each theme is independently shippable (split the PRs by theme).

### A. "Orient before you edit" — session-start hygiene (docs-first, P1)

1. **Add a "Before you start a workflow task" section to
   [template/AGENTS.md.example](../template/AGENTS.md.example)** (near the top,
   before "How this differs…"): the recommended cold-start sequence —
   - Run `n8n-decanter status <workflow>` (or bare `status` for all) **first** —
     read-only, contacts the instance, reports drift / conflict / push-pending.
   - **Drift or a pending `code/<node>.remote.js`?** Surface it and **recommend a
     `pull` before editing** (agent asks; does not auto-pull). Editing on top of
     known drift is the mistake this prevents.
   - **Clean?** Edit freely, verify offline, report ready-to-push.
   - State the framing explicitly: *the read-only `status` is the "pull-first"
     check.*
2. **Mirror it into the docs surfaces** — prepend the orient step to "The default
   loop" in [docs/agents/overview.md](../docs/agents/overview.md) and add a "Start
   of a task" subsection to [docs/agents/offline-loop.md](../docs/agents/offline-loop.md);
   keep the README agent bullet(s) in sync if they enumerate the loop.
3. **RESOLVED (maintainer, 2026-07-22): docs-only.** The orient step is a
   documented recommendation — no enforcement code. *(A guard-hook that warned on
   a stale `.decanter.json` hash was considered and rejected: detecting staleness
   means a network call to the instance on every edit — too costly/flaky for the
   benefit.)* Theme A ships as pure documentation.

### B. Surface the n8n instance version in `status` (small, P2)

**RESOLVED (maintainer, 2026-07-22):** no machine-readable snapshot, **no
`--json`, no new `orient` verb** — the core orient job is already done by plain
`status`. The one useful addition:

4. **Add the n8n *instance software version* to the normal `status` output** (if
   it isn't already shown — it isn't today). `status` currently reports only
   per-workflow *publication* state (draft vs live `versionId`), **not** the
   instance's n8n software version (e.g. `n8n 2.31.0`). Surface it once in the
   `status` header/footer so the agent sees, in the tool it already runs, the
   version it needs for the Task-5 docs-grounding recipe (and that the Task-8
   `init` probe reports).
   - **Source (verified):** the instance version is **not** read anywhere in the
     status path today. The only place decanter reads it is
     [lib/engine.mts:193](../lib/engine.mts) — `GET <host>/rest/settings`, whose
     JSON carries **`versionCli`** (used there only as a readiness check). Reuse
     that: fetch `/rest/settings` and read `versionCli`. **Caveat:** `/rest/settings`
     is n8n's *internal* REST endpoint (what the frontend uses), **not** the public
     `/api/v1` — treat a missing/renamed field as "version unknown" and degrade
     gracefully (don't fail `status`). The same read backs the `init`/F2 version
     messaging, so implement it once as a shared helper.

### C. Knowledge grounding beyond n8n-mcp — "deep research" (P2)

**Verified facts — baked in; do NOT re-research during execution.** The
maintainer's prompt was *"Deep research? More tooling than the mcp?"* This block
is the answer, resolved to hard facts (verified 2026-07-22 against primary
sources) so the executor **implements against these, not a fresh search**. One
framing error in the first draft is **corrected (F4)**.

- **F1 — The scaffolded n8n-mcp
  ([czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp), wired in
  [.mcp.json.example](../template/.mcp.json.example)) is a *bundled static
  snapshot*, not a live view of the instance.** Knowledge tools: `search_nodes`,
  `get_node`, `validate_node`, `validate_workflow`, `search_templates`,
  `get_template`, `tools_documentation`. Its node DB is built against **one n8n
  version at package-build time** (~2.30.x) and does **not** track *this*
  instance's version, installed custom/community nodes, real execution payloads,
  credential schemas, or live node availability. → the snapshot can itself be a
  **different version than the instance** (a grounding gap, not just coverage).
  - **Why keep it as a default despite F5 (the docs MCP) — don't re-litigate:**
    it is the **only** source of *structured, machine-readable node schemas*
    (`get_node`/`search_nodes` — exact props/params/`typeVersion`/operations, the
    thing you write into `workflow.json`), *offline pre-push validation*
    (`validate_node`/`validate_workflow`), and a *template corpus*. The docs MCP
    (F5) returns **prose pages**, not schemas, and n8n ships **no first-party
    structured node-schema MCP** — so czlonkowski fills a gap nothing else does,
    at zero auth and no instance. **Honest caveat:** once the **instance MCP (F2)**
    is wired, *its* validation + node info are version-accurate and partly overlap
    czlonkowski's schema/validation role (leaving it valued mainly for templates +
    zero-setup availability). So it's the **safe default baseline**, strongest
    *before* the instance MCP is connected — not irreplaceable forever.
- **F2 — [new since draft] n8n ships a *first-party, instance-level* MCP server**
  ([docs](https://docs.n8n.io/connect/connect-to-n8n-mcp-server)). Concrete
  wiring facts:
  - **Endpoint:** `<N8N_HOST>/mcp-server/http` (HTTP transport).
  - **Auth:** `Authorization: Bearer <MCP Access Token>` — a *personal MCP Access
    Token* generated in the n8n UI (Connection details → Access Token / OAuth
    tab). **It is NOT the `N8N_API_KEY`** decanter already holds, so decanter
    cannot self-authenticate it — the user pastes the token.
  - **Enable / default:** self-host default is **OFF** — set
    `N8N_MCP_ACCESS_ENABLED=true` (env var from **v2.20.0**; the MCP feature
    itself lands ~v2.13; `N8N_MCP_MANAGED_BY_ENV=true` locks it from the UI;
    `N8N_DISABLED_MODULES=mcp` force-disables). **Cloud has it ON.**
  - **No API path — decanter can only *guide*, never automate.** Enabling MCP
    (owner/admin, Settings → Instance-level MCP → *Enable*, or the env var) **and**
    minting the token (Settings → Instance-level MCP → Connection details →
    *Access Token* tab, auto-generated per user, copy-once) are **UI/env-only**;
    the n8n **public API exposes neither**. So `init` prompts + prints
    instructions and the user pastes the token — it cannot flip the flag or create
    the token itself. (Confirms the maintainer's "no way through API?" — correct.)
  - **Probe (no token needed):** an HTTP request to `<N8N_HOST>/mcp-server/http`
    returns **404 when the module is disabled or the version is too old**, and
    **non-404 (401 / 400 / 405 / 200) when it is live**. Combined with the
    instance-version read (`/rest/settings.versionCli` — Task 4/B; **not** an
    existing status read) this fully disambiguates: version
    `< ~2.13` → *upgrade*; version `≥ 2.20` but 404 → *set
    `N8N_MCP_ACCESS_ENABLED=true` / enable in Settings*; non-404 → *available*.
  - **Nature:** **instance-AWARE** (real version / workflows / data tables — the
    grounding the snapshot lacks) but **instance-MUTATING** — its
    build/edit/publish tools write workflows straight into n8n and **bypass
    decanter's edit-on-disk→`push` contract**. So for decanter it is an opt-in
    **read/ground** resource; **never a build path**.
- **F3 — [new] n8n ships an official agent knowledge pack:
  [n8n-io/skills](https://github.com/n8n-io/skills).** 13 capability skills + a
  routing meta-skill (`using-n8n-skills-official`) + 50+ reference docs; markdown,
  loaded via frontmatter + SessionStart / PreToolUse hooks. Concrete facts:
  - **Install — it is a PLUGIN, not an npm dependency** (so it does *not* belong
    in `package.json.example` devDeps): Claude Code `/plugin marketplace add
    n8n-io/skills` → `/plugin install n8n-skills@n8n-io`; Codex `codex plugin
    marketplace add n8n-io/skills` → `codex plugin add n8n-skills@n8n-io`; others
    `npx skills add n8n-io/skills` (skills.sh, support varies).
  - **Two kinds of skill, and the split is load-bearing for decanter:**
    - *Knowledge (complements decanter):* `n8n-code-nodes-official`,
      `n8n-expressions-official`, `n8n-loops-official`, `n8n-error-handling-official`,
      `n8n-credentials-and-security-official`, `n8n-binary-and-data-official`,
      `n8n-data-tables-official`, `n8n-debugging-official`.
    - *Build / lifecycle (CONFLICTS — drives instance mutation via the n8n MCP):*
      `n8n-workflow-lifecycle-official`, `n8n-node-configuration-official`,
      `n8n-subworkflows-official`, `n8n-agents-official`, `n8n-extending-mcp-official`.
  - The pack is **built to pair with n8n's own MCP/build flow**, is **not**
    instance-version-aware, and **knows nothing of the decanter contract**
    (`//@file:` placeholder, `code/` layout, `.ts` markers, drift guard). The
    plugin installs **all** skills + auto-routing meta-skill — **you cannot cleanly
    cherry-pick the knowledge ones**.
  - **Verified against the skill files (2026-07-22) — the split is real and
    load-bearing:** the **knowledge** skills are *conceptual and standalone*
    (`n8n-code-nodes-official/SKILL.md` is plain guidance + inline JS/TS snippets —
    **no MCP calls, no `addNode`, no inline-`jsCode`-in-JSON**), directly usable by
    a file-editing agent with **no MCP needed**. The **build/lifecycle** skills and
    the pack's **PreToolUse hooks** (`create-workflow`, `update-workflow`,
    `get-node`, …) are *MCP-procedural* — they fire **before n8n MCP tool calls**
    and route into the lifecycle skills. **Key clarification (maintainer's
    concern):** the JSON n8n produces is **structurally compatible** (decanter
    `pull`s exactly that, only swapping `jsCode` → `//@file:`); the problem is the
    **authoring *path*** — a build skill that calls `create_workflow`/`update_workflow`
    via MCP lands the change **on the instance, not in the files**, bypassing
    `push`/the drift guard and needing a `pull` to reconcile. For a file-editing
    agent those hooks fire on MCP tools it never calls, so the build half is
    **largely inert** — its only risk is the meta-skill's routing *nudging* toward
    MCP builds. → **Treat n8n-io/skills as optional, knowledge-only** (decision in
    Task 8); the conceptual skills are the whole value.
- **F4 — CORRECTION: `docs.n8n.io` is *not* versioned per release.** It is
  **single latest-version** docs with **inline** annotations (`Available from n8n
  2.17.0`; `On earlier versions use OLD_VAR`) plus a separate per-version
  **release-notes / changelog** (`/release-notes`, `/changelog/release-notes-2.x`;
  [style guide](https://docs.n8n.io/contribute/style-guide-for-n8n-docs)). There
  is **no "version-matched docs URL" to fetch** — the first draft's "consult
  version-matched docs.n8n.io" was wrong. Recipe: read instance version → read
  latest docs heeding the "available from vX" notes → for version-specific /
  breaking behavior read the release-notes page.
- **F5 — [the cleanest grounding source; supersedes the WebFetch idea] n8n
  publishes first-party, READ-ONLY *docs* MCP servers**
  ([docs](https://docs.n8n.io/connect/connect-to-n8n-docs-mcp-server)). Distinct
  from both the instance MCP (F2) and n8n-io/skills (F3). Two of them, both remote
  HTTP, **neither needs an n8n instance**:
  - **`n8n-docs` (GitBook):** `https://docs.n8n.io/~gitbook/mcp` — **public, no
    auth.** Search + read exact official doc pages. Claude Code:
    `claude mcp add --transport http n8n-docs https://docs.n8n.io/~gitbook/mcp`.
  - **`n8n-kapa` (Kapa.ai):** `https://n8n.mcp.kapa.ai` — **browser sign-in auth.**
    Synthesizes docs + community forum + blog (RAG answers; powers the docs-site
    AI Assistant). Claude Code:
    `claude mcp add --transport http n8n-kapa https://n8n.mcp.kapa.ai`.
  - **The load-bearing property: read-only docs → NO workflow mutation → ZERO
    contract-bypass risk.** Unlike F2/F3 it needs no precedence override and no
    gating. It reads the *live* docs (so it carries F4's inline "available from
    vX" annotations), which also **mitigates F1's snapshot-staleness gap**. → it's
    the one external grounding source safe enough to **scaffold by default** and it
    **replaces the raw `WebFetch docs.n8n.io` allowlist** (which becomes the
    no-MCP fallback).

5. **Instance-version awareness.** n8n behavior is version-dependent. `status`
   will now surface the instance version (Task 4/B — read from
   `/rest/settings.versionCli`; it is **not** read in the status path today).
   Document a recipe: read that version, then consult the docs via the **`n8n-docs`
   MCP (F5)** — or, for agents without it, `WebFetch`/`Read` of `docs.n8n.io` —
   **heeding the inline "Available from n8n X.Y.Z" annotations** (docs are
   single-latest, not forked per release — F4), and for version-specific or
   breaking behavior the **[release-notes / changelog](https://docs.n8n.io/release-notes)**
   page — rather than falling back to (often stale) training data. The version
   shows in plain `status`, so the check is one call away.
6. **Promote the grounding tools to first-class in the agent loop.** Add a
   *"Ground yourself in real data before guessing shapes"* section to
   [docs/agents/offline-loop.md](../docs/agents/offline-loop.md) covering
   `executions` (real payloads → `node run` fixtures), `data-tables`, and
   `simulate` (whole-workflow offline replay). **These are the "more tooling than
   the MCP"** — they ground the agent in *this* instance's reality, which static
   schemas cannot.
   - **Prefer the *newest* executions, and lean on the staleness flag the verb
     already emits.** `executions` fetches **newest-first** (`--limit N`, default
     5) and, better, **warns when a captured execution ran a published workflow
     version different from the local draft** (it compares the execution's
     `workflowVersionId` against `workflow.json`'s `versionId`;
     [docs/cli/executions.md](../docs/cli/executions.md)). Document this as the
     rule of thumb: fresher data is closer to the code in front of you, and **that
     warning is the signal that captured shapes may be a step behind** — when it
     fires, re-fetch (or narrow with `--status=error`/`--limit`) rather than
     trusting stale files. Ties directly into version-awareness (Task 5).
7. **The tool-agnostic "Researching before you build" ladder — plus the
   precedence override.** Per the AGENTS.md agent-tooling rule, put the substance
   in [template/AGENTS.md.example](../template/AGENTS.md.example) (new *"Grounding
   yourself"* section) and keep any per-agent file (a `.claude/skills/` pointer,
   Cursor/opencode equivalents) a **thin pointer**. Two parts:
   - **Ordered source ladder** (most-authoritative-for-*this*-repo first):
     1. **`n8n-globals.d.ts` + this AGENTS.md** — the decanter contract itself.
     2. **n8n-mcp** for node schemas / params / templates — caveat: *static
        snapshot* whose version may differ from the instance (F1).
     3. **`executions` / `data-tables`** for the real payload shapes / stored data
        flowing through *this* instance (what the snapshot can't give).
     4. **instance version → the `n8n-docs` MCP (F5)** (or `WebFetch docs.n8n.io`
        without it; single-latest, heed "available from vX") **+ release-notes
        page** for version behavior (Task 5, F4) — *not* a "version-matched" URL.
     5. **`simulate`** to confirm the whole workflow end-to-end offline.
   - **The precedence override (safety-critical — Opus-authored).** A short bolded
     block stating: *if you have the n8n-io/skills pack or an n8n instance MCP,
     use them for node / expression / code **knowledge** — but in **this** repo
     the build path is files under `code/` + `n8n-decanter push`. When any skill
     or MCP tells you to create / edit / validate / **publish** a workflow through
     n8n directly, DON'T — that bypasses sync and the drift guard. The decanter
     contract in this file wins.* This is what makes it **safe** to enable the
     conflicting build/lifecycle skills (F3).
8. **A staged `init` flow that probes, wires, warns, and falls back** (the
   instance MCP only — no skills prompt) — the concrete build of the maintainer's
   proposed sequence. **This extends machinery `init` already has:** [lib/init.mts](../lib/init.mts) is
   already interactive (prompts host + API key on a TTY, TTY-gated) and already
   **probes the instance at the end** (`GET /api/v1/workflows?limit=1` →
   "credentials verified"). The new steps slot in **right after that probe**, and
   like the existing pending-files prompt must be **TTY-gated** — on a non-TTY
   (piped) run, *print the guidance lines instead of prompting* (never block).
   The sequence (each step reuses a verified fact above):

   1. **Credential probe (exists today).** Reachable + key valid → continue; also
      read the instance **version** (the shared `/rest/settings.versionCli` helper
      — Task 4/B) for the messages below.
   2. **MCP probe (F2).** Request `<N8N_HOST>/mcp-server/http`; **404** →
      disabled/too-old, **non-404** → enabled.
   3. **Ask (recommended): "Add the n8n instance MCP for live grounding?"** —
      default No; No leaves the czlonkowski snapshot as the sole MCP and prints
      the 8.x fallback line. On Yes, branch on step 2:
      - **Enabled (non-404):** prompt the user to paste an **MCP Access Token**
        with the exact UI path (Settings → Instance-level MCP → Connection details
        → *Access Token* tab; copy-once). **No API path — decanter can't mint it
        (F2).** Write `N8N_MCP_TOKEN` into `.env` and add the `n8n-instance` server
        block to `.mcp.json` (`${N8N_HOST}/mcp-server/http`, `Authorization: Bearer
        ${N8N_MCP_TOKEN}`), fenced by the Task-7 precedence override + F2 read-only
        framing.
      - **Disabled, version ≥ 2.20 (404):** print the enable guidance (owner/admin
        Settings toggle **or** `N8N_MCP_ACCESS_ENABLED=true` + restart — **no API
        path**), then offer: *re-run `init` after enabling, or continue on the
        czlonkowski fallback (fine).*
      - **Too old (404, version < ~2.13):** *upgrade n8n for the instance MCP, or
        continue on the fallback.*
   4. **Fallback is always fine (F1).** Whenever the instance MCP isn't wired,
      state plainly: *"the scaffolded n8n-mcp already covers node schemas — the
      instance MCP only adds live grounding."* Never hard-fail.
   5. **Do NOT prompt about skills in `init`.** *(Decided — see F3 skill-file
      finding: only the conceptual skills transfer to file editing, and they need
      no MCP; the build half is MCP-procedural and largely inert here.)* `init`
      says nothing about n8n-io/skills; they are documented as **optional,
      knowledge-only** in AGENTS.md.example (Task 8a) — not an `init` step.

   **Decisions — RESOLVED:** (a) **auto-write the `n8n-instance` block** when the
   user answered Yes + pasted a token (the `.mcp.json`/`.env` writes are the point
   of Yes). **No `--with-instance-mcp` flag** — wiring only happens on the
   interactive Yes+token path; a non-interactive/piped run prints guidance and
   wires nothing (mirrors how `init` already skips prompts and applies nothing off
   a TTY). (b) **skills** — *not recommended by `init`*; documented optional,
   knowledge-only (supersedes the earlier "gate on instance MCP" lean).

   Supporting scaffold changes (same PR):
   - **8a — n8n-io/skills as *optional, knowledge-only* docs (RESOLVED).** A short
     *"Optional: official n8n skills (knowledge only)"* note in
     [template/AGENTS.md.example](../template/AGENTS.md.example): name the useful
     **conceptual** skills (`n8n-code-nodes-official`, `n8n-expressions-official`,
     `n8n-error-handling-official`, `n8n-debugging-official`, `n8n-loops-official`),
     give the F3 install command, and **carry the precedence override** (below).
     State plainly that the **build/lifecycle skills are MCP-procedural and don't
     fit this repo's file+`push` model** (F3). **Not actively recommended, not an
     `init` step, not in `package.json` — no `npx skills add` script** (declining
     to endorse a pack whose build half fights the sync model). Real default
     grounding is czlonkowski + the `n8n-docs` MCP + `n8n-globals.d.ts`.
   - **8b — redundancy trim.** In `AGENTS.md.example` the overlap with the skills
     is **narrow** (the file is already decanter-specific: ownership, `.js`/`.ts`,
     placeholders, verbs). Trim only the **generic Code-node runtime** prose in
     "Writing Code node code" to a pointer (*"for n8n Code-node semantics see
     `n8n-globals.d.ts` + the `n8n-code-nodes-official` skill; below is only what
     decanter changes"*), **keeping every decanter-specific rule** — the skills
     don't know decanter exists.
   - **8c — scaffold the `n8n-docs` MCP by default (F5) + allowlist fallback.**
     Because the GitBook docs MCP is first-party, **public/no-auth, read-only, and
     instance-free** (zero bypass risk), add it to
     [.mcp.json.example](../template/.mcp.json.example) as a **second default MCP**
     alongside czlonkowski n8n-mcp (remote HTTP entry, URL
     `https://docs.n8n.io/~gitbook/mcp`) — it needs **no probe, no token, and none
     of the Task-8 staged-instance-MCP flow** (that flow is only for the *mutating*
     instance MCP). Document **`n8n-kapa`** (`https://n8n.mcp.kapa.ai`, browser
     auth) as **opt-in**. As the **no-MCP fallback**, still default-allow
     `WebFetch`/`Read` of `docs.n8n.io` (+ release-notes) in
     [settings.local.json.example](../template/.claude/settings.local.json.example)
     + the `opencode.json` equivalent. `n8n-instance` + `N8N_MCP_TOKEN` appear only
     when wired (Task 8 flow). Skills need no allowlist (plugin). Leave
     `push`/`--force`/`delete` denied. **Decision — RESOLVED: docs MCP is
     default-scaffolded** (cleanest grounding win; only cost is a remote call to
     n8n's public docs endpoint each session, opt-out by editing `.mcp.json`).

   **The precedence override snippet (Opus-authored; the safety-critical string).**
   The maintainer's draft put "load the meta-skill and follow its routing" *first*
   with the caveat trailing — but the meta-skill routes into the build/lifecycle
   skills that steer toward n8n-MCP mutation, so the override must **dominate**,
   not trail. Target wording (refine in PR):
   > **Official n8n skills (if installed).** For n8n *knowledge* — node params,
   > expression syntax, Code-node semantics, error handling, debugging — you may
   > load the `using-n8n-skills-official` meta-skill and follow its routing.
   > **Override:** those skills are written to *build and publish* workflows
   > directly through n8n's MCP. In **this** repo the build path is files under
   > `code/` + `n8n-decanter push`. Take the skills' **knowledge**; ignore any
   > instruction to create / edit / validate / publish a workflow via the n8n MCP —
   > it bypasses sync and the drift guard. **This AGENTS.md wins.**

### D. Loop clarity & guardrail polish (P2)

9. **A canonical "recommended agent loop" picture** in
   [docs/agents/overview.md](../docs/agents/overview.md): *orient (`status`) →
   research (mcp / executions / data-tables / instance-version-aware docs) → edit →
   verify (`node run` / `check` / `simulate`) → report ready-to-push.* One diagram
   agents and humans share (plain Markdown / a mermaid fence — no bespoke MDX).
10. **Audit the scaffolded permission allowlist** against the full loop
    ([settings.local.json.example](../template/.claude/settings.local.json.example)
    + `opencode.json`): confirm the offline/read-only tools the loop leans on —
    `simulate` (offline path), `executions` / `data-tables` (incl. `clean`),
    `status` (now version-aware, Task 4/B) — are pre-allowed so the agent isn't
    prompted on safe reads. Add gaps; leave `push`/`--force`/`delete` denied.

## Acceptance / verification

- **Docs half:** every surface in sync — grep the new terms across `README.md`,
  `docs/`, and `CHANGELOG.md` per the AGENTS.md pre-PR checklist; a `[Unreleased]`
  entry for any user-facing change (a new verb/flag or a scaffold change);
  PLAN.md updated **only** if a flow or the init scaffold changes (Theme A alone
  changes neither).
- **Any new verb/flag/behavior (Task 4; Task 8 `init` flow):** verified at the CLI
  surface via the `/verify` mock recipe (drive the real CLI as a subprocess
  against a `node:http` mock — the mock adds a `GET /mcp-server/http` route
  returning **404 and non-404** so both probe branches are exercised, and the
  interactive-picker suite's PassThrough-stream pattern drives the TTY prompts;
  a piped run asserts the non-TTY guidance path), plus unit + e2e coverage;
  scaffold changes materialize correctly through `init` (`.example` → real name,
  incl. the conditional `n8n-instance` block + `N8N_MCP_TOKEN`). `npm test` +
  `npm run typecheck` green.
- **Decisions — ALL RESOLVED (maintainer, 2026-07-22):** Task 3 **docs-only** (no
  guard-hook nudge); Task 4 **no `--json`/no `orient` verb — just add the n8n
  instance version to plain `status`** (from `/rest/settings.versionCli`); docs MCP
  **default-scaffolded** (8c); `init` **auto-writes** the `n8n-instance` block on
  Yes+token, **no opt-in flag** (8a); **n8n-io/skills = optional, knowledge-only**,
  not recommended by `init`, not in `package.json` (8a/step 5); **override, not
  fork** the skills (Notes). Log this set in
  [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md) for the record.

## Notes

- **Keep the "pull only when the user asks" policy.** The session-start
  recommendation is *read-only `status` first + ask before pulling* — it does
  **not** loosen the live-instance gate (see "Design tension" above).
- **CHANGELOG/PLAN implications:** Theme A → docs only, no PLAN flow change. Task
  8's staged-`init` probe + conditional `n8n-instance` MCP wiring is a **new
  `init`/`status` behavior + a new `.env` var (`N8N_MCP_TOKEN`) + a `.mcp.json`
  scaffold change** → `[Unreleased]` (Added) + **PLAN.md §init scaffold + command
  surface** in the same PR, and verified via the `/verify` mock recipe. Tasks
  8a/8b/8c are scaffold/doc changes → `[Unreleased]` + the three doc surfaces in
  sync.
- **Fork the official skills, or override them? → Override; do NOT fork.** The
  conflict is narrow and *policy-shaped* — only the 5 build/lifecycle skills'
  "build/publish via the n8n MCP" instruction clashes; the knowledge content is
  correct verbatim. Forking = 60+ files n8n **actively maintains**, frozen and
  hand-re-synced forever (the same drift tax as the tracked `n8n-globals.d.ts`
  template/repo duplication), and it loses the plugin/marketplace + hook wiring.
  decanter already owns the right layer (`AGENTS.md.example` asserts precedence
  over general n8n knowledge), so **one authoritative override (Task 8 snippet)**
  beats owning a fork. **Future option (backlog, not this plan):** a *decanter-native
  skills pack* that rewrites the build/lifecycle skills around file+`push` — real
  value, far heavier, opt-in; log it under the distinctive-features group rather
  than doing it here.
- **Non-goals:** auto-pulling on the agent's behalf; bundling the first-party
  *instance* MCP (F2) or n8n-io/skills (F3) into the scaffold by default (both are
  opt-in with the contract-bypass caveat — Task 8). *(The read-only `n8n-docs` MCP,
  F5, is the exception that **is** default-scaffolded — no bypass risk; Task 8c.)*
  Also non-goals: **forking n8n-io/skills** (override instead, above); **using any
  instance-mutating MCP as a build path** (they fork on-disk state from the
  instance and bypass `push`); touching the settled **edit-time** hard invariants
  (this plan is about the work *around* the edit, not the edit contract).
- **Backlog placement:** distinctive-features group (agent-native tooling), not
  the parity/hardening buckets.
