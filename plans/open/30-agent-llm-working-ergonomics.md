# Plan 30 — Agent/LLM working ergonomics in a sync dir

**Priority:** P2 overall, split per theme — **P1** for the pure-docs "orient
before you edit" + loop-clarity work (small, clearly-right, offline, high-value);
**P2** for the small tooling (instance version in `status`, research recipe, scaffold/allowlist
tuning), which carry design decisions.
**Status:** Partially landed via PR #107/#114 (Task 8a skills docs + install
commands, Task 8c core n8n-docs scaffold, most of Task 10's allow additions);
**Themes A / B / D and Tasks 5–7 remain open.**
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** Make an LLM coding agent measurably more effective *and* safer the
moment it lands in a synced dir — codify session-start orientation ("check
`status` before you edit; pull-first when it drifted"), sharpen the offline loop,
and promote the grounding tools already scaffolded (the guarded instance MCP +
the read-only n8n-docs MCP + the official n8n skills) into an explicit ladder.
**Model:** Opus for the policy/flow wording in `template/AGENTS.md.example`
(agent-behavior, safety-critical); Sonnet for the mechanical doc-surface
propagation and any small verb/flag.

> **Plan 32 RESOLVED (2026-07-22) — executed and merged (PR #97); this
> supersedes the old "hold until go/no-go" coordination.** The instance MCP
> **is** decanter's sync backend now, with OAuth-first `init` landed (Plan 32
> Task 5), so the previously-held parts settle as follows.
> **Execute freely:** Themes A, B (now *more* load-bearing — the instance
> version powers the MCP version-floor messaging), D, Task 8c (docs MCP) and
> the F4 recipe — unchanged. **Superseded — do not execute:** Task 8's
> *instance-MCP* wiring branch (probe → paste-token → agent-facing
> `.mcp.json` block): decanter now authenticates the instance MCP itself
> (`.decanter-auth.json` OAuth + `N8N_MCP_TOKEN` paste fallback, both
> landed), and agent-facing instance-MCP access is redesigned **proxy-first**
> in [Plan 33](../done/33-post-mcp-pivot-wave.md) Task 4 (decanter as sole
> token holder; agents point at a localhost guard-proxy, never the instance
> directly). The Task 7/8 **precedence-override snippet** is likewise owned
> elsewhere: Plan 32 Task 9's template boundary contract landed, and Plan 33
> Task 4c rewrites it proxy-first — drop this plan's version. czlonkowski
> n8n-mcp demotes to no-instance fallback + template corpus (grounding-ladder
> rung 2), per [DONE-32](../done/32-mcp-native-code-layer.md) → "Relation to
> Plan 30".

> **Post-#107 review (2026-07-23) — large chunks landed, and the plan's
> knowledge-source model and stance both need rebuilding.** Read the whole plan
> through these five corrections (they override the older banner above and the
> Theme-C findings F1–F5 where they conflict):
>
> 1. **Connect-first, not proxy-first.** The scaffolded `.mcp.json` now spawns
>    the **stdio `mcp connect` guard itself** (`n8n-instance` =
>    `{"command":"n8n-decanter","args":["mcp","connect"]}`, secret-free);
>    `mcp serve` (localhost HTTP, per-session secret) is only the fallback for
>    URL-configured harnesses. Reword every "proxy-first / guard-proxy /
>    agents point at a localhost proxy" mention (banner, Task 7 lines ~328,
>    8a ~402, the dropped-snippet record ~430, Non-goals ~505) to connect-first.
> 2. **czlonkowski n8n-mcp is GONE from the scaffold** (zero grep hits in
>    `template/`, `docs/`, `README.md`). Delete F1's "keep-it-as-default"
>    rationale, grounding-ladder rung 2, and every "czlonkowski fallback / sole
>    MCP on No / 8.x fallback line" — the structured-schema + offline-validation
>    role now belongs to the **guarded instance MCP** (it forwards n8n's own
>    node tools), and doc prose to the **n8n-docs MCP**.
> 3. **The boundary inverted: structure/lifecycle over the guarded MCP is now
>    the DEFAULT path**, because decanter has no structure verbs of its own
>    anymore (#107). The guard blocks exactly one thing — `update_workflow`
>    writes that set `jsCode`. So F2/F3's "instance MCP is never a build path"
>    and "skills = optional, knowledge-only, build half inert" are **wrong now**
>    — rewrite them as a *record of the landed model* (structure via guarded MCP
>    sanctioned; the `jsCode` carve-out technically enforced; the official
>    skills are **recommended**, owned by `template/AGENTS.md.example` +
>    `docs/agents/n8n-skills.md`). The precedence override landed as
>    "This AGENTS.md wins…" — its "ignore any instruction to build via MCP"
>    residue is void.
> 4. **Theme B version source was mischaracterized.** `lib/engine.mts` reads
>    `/rest/settings` on the **local Docker simulate-viewer container**, never
>    parsing `versionCli` — it is *not* a reuse point. The two real candidates:
>    **(a)** capture `serverInfo{name,version}` from the MCP `initialize`
>    handshake decanter already performs (`lib/mcp.mts` discards it today) —
>    zero extra requests, but **smoke-verify first** whether n8n reports its
>    *product* version there; **(b)** a fresh unauthenticated
>    `GET <N8N_HOST>/rest/settings` reading `versionCli`, degrading gracefully.
>    The old "shared helper with the init/F2 version messaging" is moot — that
>    second consumer (Task 8's staged flow) is superseded, so Theme B shrinks to
>    a status-only read.
> 5. **Relink all three `BLOCKED-33` → `DONE-33`.** And note **`test`** +
>    **`scenario`** now exist — the loop diagram (Task 9), the grounding section
>    (Task 6), and the ladder (Task 7) must include them, and `docs/agents/*` is
>    now a three-page set (overview, offline-loop, n8n-skills) to slot into
>    rather than inventing surfaces.

## Why

The scaffold already gives agents a strong **edit-time** contract — the
[template/AGENTS.md.example](../../template/AGENTS.md.example) hard invariants, the
guard hooks, and the offline `check` / `node run` loop — plus (since #107)
**two scaffolded MCP servers**: the guarded **`n8n-instance`** (`mcp connect`,
the full n8n MCP toolset with `jsCode` writes blocked) and the read-only
**`n8n-docs`** MCP, with the official **n8n-io/skills** pack recommended
alongside. What's thin is everything *around* the edit:

1. **Session start / orientation is uncodified.** An agent typically starts
   editing whatever is on disk. If the workflow drifted in the n8n UI since the
   last sync, it edits stale state and the eventual `push` either aborts
   (`pull first`) or — worse, if pushed `--force` — clobbers the UI edits. There
   is no "orient yourself first" step in the contract. *(Maintainer's prompt: "a
   pull before starting to work on a workflow is very recommended.")*
2. **Knowledge grounding lacks a stated order.** The scaffolded servers cover
   node schemas/validation (guarded instance MCP) and doc prose (n8n-docs MCP),
   but nothing tells the agent *which to reach for when*, nor surfaces the
   **instance's n8n version** (still unshown — Theme B) or the **real payload
   shapes** flowing through this specific workflow. Absent an explicit ladder,
   agents fall back to (often stale) training data. *(Maintainer's prompt:
   "Deep research? More tooling than the mcp?")*
3. **The best offline/grounding tools are under-surfaced in the loop.**
   `executions` (real payloads → `node run` fixtures / `scenario create
   --execution`), `data-tables`, and `simulate`/`test` all exist, but the
   **docs-site** agent pages (`docs/agents/overview.md`, `offline-loop.md`)
   still frame the loop as roughly `node run` + `check` — the depth landed in
   `template/AGENTS.md.example` but not the published pages.

Agent-native tooling is a **stated differentiator** of this project (the
[README](../../README.md) comparison table's "Agent-native tooling" row), so it
belongs in the **distinctive-features backlog group**, not parity — this plan
invests in it deliberately.

## Source

- New maintainer brainstorm (2026-07-21): optimize the LLM's dealings with
  n8n-decanter — session-start pull, deep research, tooling beyond the MCP. No
  prior `plans/` entry.
- Extends the agent surfaces: [template/AGENTS.md.example](../../template/AGENTS.md.example),
  the per-agent scaffolds (`.claude/`, `.cursor/`, `opencode.json`),
  [docs/agents/overview.md](../../docs/agents/overview.md) +
  [docs/agents/offline-loop.md](../../docs/agents/offline-loop.md), and the
  `.mcp.json` / `settings.local.json` scaffold (PLAN.md §init).
- Builds on existing tools (no re-implementation): Plan 3 (`executions`;
  `run --from-execution` is deferred in [BACKLOG](../draft/)), Plan 7 / Plan 26
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
   [template/AGENTS.md.example](../../template/AGENTS.md.example)** (near the top,
   before "How this differs…"): the recommended cold-start sequence —
   - Run `n8n-decanter status <workflow>` (or bare `status` for all) **first** —
     read-only, contacts the instance, reports drift / conflict / push-pending.
   - **Drift or a conflict warning?** (Post-Plan-32 there are no `.remote.js`
     artifacts — drift/CONFLICT surfaces as `status` warnings, plus the
     informational snapshot-stale hint for structure.) Surface it and
     **recommend a `pull` before editing** (agent asks; does not auto-pull).
     Editing on top of known drift is the mistake this prevents.
   - **Clean?** Edit freely, verify offline, report ready-to-push.
   - State the framing explicitly: *the read-only `status` is the "pull-first"
     check.*
2. **Mirror it into the docs surfaces** — prepend the orient step to "The default
   loop" in [docs/agents/overview.md](../../docs/agents/overview.md) and add a "Start
   of a task" subsection to [docs/agents/offline-loop.md](../../docs/agents/offline-loop.md);
   keep the README agent bullet(s) in sync if they enumerate the loop.
3. **RESOLVED (maintainer, 2026-07-22): docs-only.** The orient step is a
   documented recommendation — no enforcement code. *(A guard-hook that warned on
   a stale `.decanter.json` hash was considered and rejected: detecting staleness
   means a network call to the instance on every edit — too costly/flaky for the
   benefit.)* Theme A ships as pure documentation.
4. **✅ DONE — "finish the loop", the closing counterpart to the orient step
   (2026-07-24).** Theme A guarded the *start* of a task; the Plan 35 blind field
   test showed the *end* leaking just as badly: **three separate sessions
   authored code, ran `check`, read its green line as "done", and never pushed**
   — so the repo looked right and n8n was untouched (S2 `ftrun-81310`: a whole
   6-node workflow, `check ✓ OK` twice, remote `0b`). Landed, still docs-first
   but with the one-line signal at the moment of the mistake:
   - `check`'s success line now states its scope —
     `OK (local layout — status compares with n8n)` instead of a bare `OK`.
   - `check` **warns** (never errors) when a node's `//@file:` placeholder has
     moved off what `.decanter.json` records, or the recorded file is gone. It
     must stay a warning: `push` runs the compliance guard *before*
     `reconcileFileMapFromSnapshot`, so erroring would refuse the very command
     that heals the state.
   - `template/AGENTS.md.example`: the `.js`→`.ts` recipe **ended at `check`** —
     literally instructing the behaviour that failed — and now ends at `push`;
     the Verification section states that a green `check` is not a finished task.
   - Consistent with task 3's rejection of a network-calling guard hook: nothing
     added here contacts the instance.

### B. Surface the n8n instance version in `status` (small, P2)

**RESOLVED (maintainer, 2026-07-22):** no machine-readable snapshot, **no
`--json`, no new `orient` verb** — the core orient job is already done by plain
`status`. The one useful addition:

4. **Add the n8n *instance software version* to the normal `status` output** (if
   it isn't already shown — it isn't today). `status` currently reports only
   per-workflow *publication* state (draft vs live `versionId`), **not** the
   instance's n8n software version (e.g. `n8n 2.31.0`). Surface it once in the
   `status` header/footer so the agent sees, in the tool it already runs, the
   version it needs for the Task-5 docs-grounding recipe.
   - **Source — corrected (2026-07-23).** The old pointer to
     `lib/engine.mts`'s `/rest/settings` read is **wrong**: that read polls the
     **local Docker simulate-viewer container** for readiness and never parses
     `versionCli`. No code reads the instance version anywhere. Two real
     candidates, decide when executing:
     - **(a) MCP `initialize` `serverInfo` (preferred if it carries the product
       version).** Decanter already performs the `initialize` handshake in
       `lib/mcp.mts` and **discards the result**; per the MCP spec it carries
       `serverInfo{name, version}` (the e2e mock returns one). **Smoke-verify
       first** whether n8n 2.30.x reports its *product* version there (add a
       one-line assertion to the smoke suite) — if so this is a **zero
       extra-request** source captured from a handshake already made.
     - **(b) Fallback:** a fresh unauthenticated `GET <N8N_HOST>/rest/settings`
       reading `versionCli` — n8n's *internal* endpoint (not public `/api/v1`),
       so treat a missing/renamed field as "version unknown" and never fail
       `status`.
     - The old "shared helper with the `init`/F2 version messaging" is moot —
       that consumer was Task 8's superseded staged flow, so Theme B is a
       status-only read.

### C. Knowledge grounding beyond n8n-mcp — "deep research" (P2)

**Verified facts — baked in; do NOT re-research during execution.** The
maintainer's prompt was *"Deep research? More tooling than the mcp?"* This block
is the answer, resolved to hard facts (verified 2026-07-22 against primary
sources) so the executor **implements against these, not a fresh search**. One
framing error in the first draft is **corrected (F4)**.

- **F1 — The scaffolded n8n-mcp
  ([czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp), wired in
  [.mcp.json.example](../../template/.mcp.json.example)) is a *bundled static
  snapshot*, not a live view of the instance.** Knowledge tools: `search_nodes`,
  `get_node`, `validate_node`, `validate_workflow`, `search_templates`,
  `get_template`, `tools_documentation`. Its node DB is built against **one n8n
  version at package-build time** (~2.30.x) and does **not** track *this*
  instance's version, installed custom/community nodes, real execution payloads,
  credential schemas, or live node availability. → the snapshot can itself be a
  **different version than the instance** (a grounding gap, not just coverage).
  - **OBSOLETE (2026-07-23): czlonkowski n8n-mcp was REMOVED from the scaffold
    in #107** and is referenced nowhere in `template/`, `docs/`, or `README.md`.
    The "keep it as the default baseline" rationale below has no object anymore:
    the structured-schema + `validate_workflow` role now belongs to the **guarded
    `n8n-instance` MCP** (version-accurate, since it forwards this instance's own
    node tools), and F1's snapshot-staleness gap is moot. *(Retained struck-out
    for the record — do not re-scaffold czlonkowski.)* ~~it is the only source of
    structured, machine-readable node schemas … a safe default baseline, strongest
    before the instance MCP is connected.~~
- **F2 — [new since draft; since Plan 32 this is decanter's *own sync
  backend*, OAuth-authenticated by `init` — see the banner] n8n ships a
  *first-party, instance-level* MCP server**
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
   will now surface the instance version (Task 4/B — source corrected: MCP
   `initialize` `serverInfo` if it carries the product version, else a
   `/rest/settings.versionCli` read; **not** `lib/engine.mts`'s viewer poll).
   Document a recipe: read that version, then consult the docs via the **`n8n-docs`
   MCP (F5)** — or, for agents without it, `WebFetch`/`Read` of `docs.n8n.io` —
   **heeding the inline "Available from n8n X.Y.Z" annotations** (docs are
   single-latest, not forked per release — F4), and for version-specific or
   breaking behavior the **[release-notes / changelog](https://docs.n8n.io/release-notes)**
   page — rather than falling back to (often stale) training data. The version
   shows in plain `status`, so the check is one call away.
6. **Promote the grounding tools to first-class in the agent loop.** Add a
   *"Ground yourself in real data before guessing shapes"* section to
   [docs/agents/offline-loop.md](../../docs/agents/offline-loop.md) covering
   `executions` (real payloads → `node run` fixtures), `data-tables`, and
   `simulate` (whole-workflow offline replay). **These are the "more tooling than
   the MCP"** — they ground the agent in *this* instance's reality, which static
   schemas cannot.
   - **Prefer the *newest* executions, and lean on the staleness flag the verb
     already emits.** `executions` fetches **newest-first** (`--limit N`, default
     5) and, better, **warns when a captured execution ran a published workflow
     version different from the local draft** (it compares the execution's
     `workflowVersionId` against `workflow.json`'s `versionId`;
     [docs/cli/executions.md](../../docs/cli/executions.md)). Document this as the
     rule of thumb: fresher data is closer to the code in front of you, and **that
     warning is the signal that captured shapes may be a step behind** — when it
     fires, re-fetch (or narrow with `--status=error`/`--limit`) rather than
     trusting stale files. Ties directly into version-awareness (Task 5).
7. **The tool-agnostic "Researching before you build" ladder — plus the
   precedence override.** Per the AGENTS.md agent-tooling rule, put the substance
   in [template/AGENTS.md.example](../../template/AGENTS.md.example) (new *"Grounding
   yourself"* section) and keep any per-agent file (a `.claude/skills/` pointer,
   Cursor/opencode equivalents) a **thin pointer**. Two parts:
   - **Ordered source ladder (rebuilt 2026-07-23 around the landed two-server
     scaffold; czlonkowski is gone)** — most-authoritative-for-*this*-repo first:
     1. **`n8n-globals.d.ts` + the scaffolded AGENTS.md** — the decanter contract
        itself.
     2. **The guarded `n8n-instance` MCP** for node schemas / params /
        validation — version-accurate because it forwards *this instance's* own
        node tools (the sync backend); `jsCode` writes are blocked, everything
        else (incl. node info + `validate_workflow`) passes. *(This replaces the
        old czlonkowski snapshot rung outright — the "only czlonkowski has
        structured schemas" argument is void.)*
     3. **`executions` / `data-tables`** for the real payload shapes / stored data
        flowing through *this* instance (`scenario create --execution` promotes a
        capture into a committed pin set).
     4. **instance version → the `n8n-docs` MCP (F5, default-scaffolded)** (or
        `WebFetch docs.n8n.io` if not scaffolded; single-latest, heed "available
        from vX") **+ release-notes page** for version behavior (Task 5, F4).
     5. **`preflight`** — the single scored, read-only pre-push gate that runs
        the whole ladder (static → instance reads → a pinned `test`, `--full`
        adds `simulate`); its rungs **`test`** (instance-side pinned run) and
        **`simulate`/`scenario`** stay reachable individually for a focused
        check. *(Plan 36 merged, #117 — `preflight` is the shipped
        consolidation of rungs 1–5 into one verdict.)*
   - **The precedence override — LANDED as "This AGENTS.md wins…" (#107); do not
     re-add.** The template boundary contract shipped and the guard technically
     enforces the one carve-out (`jsCode` writes blocked). Task 7 ships only the
     rebuilt source ladder above, pointing at
     [`docs/agents/n8n-skills.md`](../../docs/agents/n8n-skills.md) +
     `template/AGENTS.md.example` for the boundary rules. *(Structure/lifecycle
     via the guarded MCP is the **sanctioned default** now — not something to
     override.)*
8. **SUPERSEDED (2026-07-22, Plan 32 executed — see the banner; do not
   execute the staged flow below, kept for the record; sub-tasks 8a/8b/8c
   survive, see their annotations).** The flow assumed the instance MCP was
   an opt-in read-only extra reached with a UI-pasted token; it is now the
   sync backend, `init` runs OAuth consent itself (landed), and agent-facing
   instance access goes through the
   [Plan 33](../done/33-post-mcp-pivot-wave.md) Task 4 guard-proxy instead of
   a direct `n8n-instance` `.mcp.json` block.
   *Original task:* **A staged `init` flow that probes, wires, warns, and falls back** (the
   instance MCP only — no skills prompt) — the concrete build of the maintainer's
   proposed sequence. **This extends machinery `init` already has:** [lib/init.mts](../../lib/init.mts) is
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
   - **8a — n8n-io/skills as *optional, knowledge-only* docs (RESOLVED;
     largely LANDED via Plan 32 Task 9 — diff against the template before
     executing).** The template `AGENTS.md.example` now carries skills
     guidance + the boundary contract on the *post-pivot* line (knowledge
     skills recommended; build/lifecycle skills subordinated to "structure
     may go via MCP/skills, Code-node source stays files+`push`" — which
     retires this task's original "build skills don't fit this repo"
     framing). What may remain: naming the useful **conceptual** skills
     (`n8n-code-nodes-official`, `n8n-expressions-official`,
     `n8n-error-handling-official`, `n8n-debugging-official`,
     `n8n-loops-official`) and the F3 install command. Do **not** re-add a
     precedence override — it landed as "This AGENTS.md wins…" (#107). Still:
     not an `init` step, not in `package.json` — no `npx skills add` script.
     Real default grounding is the guarded instance MCP (the sync backend) +
     the `n8n-docs` MCP + `n8n-globals.d.ts` (no czlonkowski fallback — it was
     removed). **LANDED via #107:** the knowledge-skill list and install
     commands shipped in `template/AGENTS.md.example` + `docs/agents/n8n-skills.md`
     (and landed as **recommended**, beyond this task's original "optional"
     framing) — so 8a is essentially done; diff before doing more.
   - **8b — redundancy trim.** In `AGENTS.md.example` the overlap with the skills
     is **narrow** (the file is already decanter-specific: ownership, `.js`/`.ts`,
     placeholders, verbs). Trim only the **generic Code-node runtime** prose in
     "Writing Code node code" to a pointer (*"for n8n Code-node semantics see
     `n8n-globals.d.ts` + the `n8n-code-nodes-official` skill; below is only what
     decanter changes"*), **keeping every decanter-specific rule** — the skills
     don't know decanter exists.
   - **8c — LANDED via #107 (core).** The `n8n-docs` MCP is default-scaffolded
     in `template/.mcp.json.example` (`https://docs.n8n.io/~gitbook/mcp`) and
     `opencode.json.example`, and pre-allowed (`mcp__n8n-docs`) — **alongside
     the `n8n-instance` connect guard, not czlonkowski** (which is gone). Only
     two small optional residues remain: **(1)** a `WebFetch(docs.n8n.io)`
     no-MCP-fallback allow entry — **it does not exist in the scaffold today**
     (grep-empty), add it only if the no-MCP story is still wanted; **(2)** an
     opt-in **`n8n-kapa`** (`https://n8n.mcp.kapa.ai`, browser auth) mention —
     documented nowhere yet.

   **The precedence override snippet — DROPPED (2026-07-22; superseded by
   Plan 32 Task 9's landed template contract + Plan 33 Task 4c's proxy-first
   rewrite; kept for the record).**
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
   [docs/agents/overview.md](../../docs/agents/overview.md): *orient (`status`) →
   research (the guarded `n8n-instance` MCP / `executions` / `data-tables` /
   version-aware `n8n-docs` MCP) → edit → verify offline (`node run` / `check`)
   → **gate (`preflight` — the single scored, read-only pre-push gate: static +
   instance reads + a pinned `test`/`simulate` run)** → report ready-to-push.*
   One diagram agents and humans share (plain Markdown / a mermaid fence — no
   bespoke MDX). **Plan 36 merged (#117):** `preflight` is the shipped
   consolidation of the verify ladder — feature it as the gate step rather than
   listing `check`/`test`/`simulate` loose (they remain the individual rungs it
   orchestrates). **Fix in passing:** `overview.md` still names "the `mcp serve`
   guard-proxy" where `mcp connect` is the scaffolded default, and its loop is a
   single sentence with no orient step.
10. **Audit + trim the scaffolded permission allowlist** — mostly landed
    ([settings.local.json.example](../../template/.claude/settings.local.json.example)
    already pre-allows `check`/`node`/`pull`/`simulate`/`scenario`/`status`/
    `list`/`executions`/`data-tables`/`completion` + `mcp__n8n-docs`). Remaining
    work is a **trim pass**: the `delete` verb is gone (#107) so drop any
    "delete denied" mention; the deny list still carries dead `Edit(**/*.remote.js)`
    entries (both `settings.local.json.example` **and** `opencode.json.example`,
    plus opencode's stale "two file-level invariants … `*.remote.js`" comment) —
    `.remote.js` artifacts were removed in Plan 32, so trim them. Note plain
    `push` is **prompt-gated by omission**, not denied. Add any genuine gap;
    keep `push --force` denied.

## Acceptance / verification

- **Docs half:** every surface in sync — grep the new terms across `README.md`,
  `docs/`, and `CHANGELOG.md` per the AGENTS.md pre-PR checklist; a `[Unreleased]`
  entry for any user-facing change (a new verb/flag or a scaffold change);
  PLAN.md updated **only** if a flow or the init scaffold changes (Theme A alone
  changes neither).
- **Any new verb/flag/behavior (Task 4 — Task 8's `init` flow is superseded,
  see the banner):** verified at the CLI surface via the `/verify` mock recipe
  (drive the real CLI as a subprocess against the Plan 32 dual REST+MCP
  mock), plus unit + e2e coverage; scaffold changes (8c) materialize
  correctly through `init` (`.example` → real name). `npm test` +
  `npm run typecheck` green.
- **Decisions — ALL RESOLVED (maintainer, 2026-07-22):** Task 3 **docs-only** (no
  guard-hook nudge); Task 4 **no `--json`/no `orient` verb — just add the n8n
  instance version to plain `status`** (from `/rest/settings.versionCli`); docs MCP
  **default-scaffolded** (8c); `init` **auto-writes** the `n8n-instance` block on
  Yes+token, **no opt-in flag** (8a); **n8n-io/skills = optional, knowledge-only**,
  not recommended by `init`, not in `package.json` (8a/step 5); **override, not
  fork** the skills (Notes). Log this set in
  [DECISIONS-NEEDED.md](../DECISIONS-NEEDED.md) for the record.

## Notes

- **Keep the "pull only when the user asks" policy.** The session-start
  recommendation is *read-only `status` first + ask before pulling* — it does
  **not** loosen the live-instance gate (see "Design tension" above).
- **CHANGELOG/PLAN implications:** Theme A → docs only, no PLAN flow change.
  Task 8's staged-`init` wiring is superseded (see the banner) — and note
  `N8N_MCP_TOKEN` *does* exist now, landed in Plan 32 as decanter's **own**
  non-TTY bearer fallback, not as an agent-facing `.mcp.json` var. Task 4 is
  a small `status` behavior → `[Unreleased]` (Added). Tasks 8a/8b/8c are
  scaffold/doc changes → `[Unreleased]` + the three doc surfaces in sync.
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
- **Non-goals:** auto-pulling on the agent's behalf; a *direct* agent-facing
  instance-MCP block or bundling n8n-io/skills (F3) into the scaffold by
  default (post-Plan-32, decanter itself always rides the instance MCP as
  the sync backend; the agent-facing path is the Plan 33 guard-proxy).
  *(The read-only `n8n-docs` MCP, F5, is the exception that **is**
  default-scaffolded — no bypass risk; Task 8c.)*
  Also non-goals: **forking n8n-io/skills** (override instead, above); **using any
  instance-mutating MCP as a build path** (they fork on-disk state from the
  instance and bypass `push`); touching the settled **edit-time** hard invariants
  (this plan is about the work *around* the edit, not the edit contract).
- **Backlog placement:** distinctive-features group (agent-native tooling), not
  the parity/hardening buckets.
