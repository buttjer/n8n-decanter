# Plan 13 — Open-source release (GitHub + npm)

| | |
|---|---|
| **Priority** | P1 |
| **Status** | Done |
| **Theme** | Everything between "the code is done" and "the repo is public on GitHub and the package is on npm": identity rewrite, repo hygiene, publish pipeline, post-publish verification. |
| **Model** | **Haiku** (or Sonnet) — what's left for a model is small and mechanical (re-run the tarball `init` smoke, the `createRequire` typescript fix); the substance is a *human* checklist (create the repo, npm publish, security settings) that no model should drive. Low reasoning load. |

## Why

Code, tests (unit + 41 e2e steps + 9 proxy checks), typecheck, README, and
CHANGELOG are release-quality, and the npm name `n8n-decanter` is free. What
remains is packaging/licensing/identity work and the publish mechanics — none
of it in the code itself. Tracked here so nothing is forgotten between
sessions.

## Source

Direct user request (2026-07-18): release-readiness review. No Plan 0 entry.

## Done in the initial pass (2026-07-18)

- [x] `LICENSE` (MIT, Malte Buttjer) + `"license"` field
- [x] `package.json` publish metadata: author, repository/homepage/bugs
      (`github.com/buttjer/n8n-decanter`), keywords (incl. `agentic`), and a
      `files` whitelist (`n8n-decanter.mts`, `lib/`, `scripts/typecheck.mts`,
      `template/`, `CHANGELOG.md` — `template/` and `scripts/typecheck.mts`
      are runtime dependencies of `init` and the push typecheck gate)
- [x] CI workflow `.github/workflows/ci.yml` (Node 22 + 24 matrix:
      `npm ci` → typecheck → test) + `.github/dependabot.yml` (npm +
      github-actions, weekly)
- [x] `CONTRIBUTING.md` incl. credits (David Friedrich / @durchnull)
- [x] README: badges, engine-floor `SyntaxError` warning, bottom
      non-affiliation note ("Not affiliated with or endorsed by n8n GmbH.")
- [x] `.DS_Store` untracked (deletion was already staged) and gitignored

## Done in the second pass (2026-07-18)

- [x] **Git identity:** author/committer email normalized to
      `sudo@buttjer.net` across all history (3 branches) via
      `git filter-branch`; backup refs (`refs/original/`) and stale
      `origin/*` tracking refs deleted; repo-local
      `git config user.email sudo@buttjer.net` set. Local reflog still
      references pre-rewrite commits — harmless, `git push` never sends
      them.
- [x] **Pending work committed:** Plan 12 WIP was committed by the user
      (`1554d04`-era, now rewritten); backlog/Plan 11 notes and the release
      files committed in this pass.
- [x] **Root cleanup:** `decanter.config.json` + `workflows/` untracked and
      gitignored — the files stay on disk for local dev, the public repo no
      longer looks like a sync dir. Revert with `git add -f` if unwanted.
- [x] **CHANGELOG:** `[Unreleased]` → `[0.1.0] - 2026-07-18` ("First public
      release."), fresh empty `[Unreleased]` on top.
- [x] **Publish build step** — the smoke test caught that Node refuses to
      type-strip `.mts` under `node_modules`
      (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so publishing raw
      sources can never work. The tarball now ships compiled JS:
      `tsconfig.build.json` (tsc emit with
      `rewriteRelativeImportExtensions`, shebang preserved) → `dist/`, run
      by `prepack`; `bin` → `dist/n8n-decanter.mjs`; `files` → `dist/` +
      `template/` + `CHANGELOG.md`; `lib/validate.mts` resolves the
      typecheck subprocess extension-aware (`.mts` in dev, `.mjs`
      installed). **Dev stays build-free** — only pack/publish compiles.
      `npm link` from a checkout now needs `npm run build` once (README
      notes this).
- [x] **Tag `v0.1.0`** created locally on the release commit.
- [x] **Tarball smoke test:** `npm pack`, installed into a clean prefix,
      `n8n-decanter uuid` runs from the installed bin (36 files, 43.5 kB,
      no raw `.mts`, no repo-internal files).
- [x] **Re-run the tarball smoke incl. `init`** — done 2026-07-20 (after
      publish, but before this session ended): `npm pack` → installed into
      an isolated temp prefix (`npm install --prefix <tmp> --global
      <tarball>`) → `n8n-decanter init <tmp>` with dummy credentials → full
      template copied correctly (`.claude/`, `.cursor/`, `AGENTS.md`,
      `CLAUDE.md`, `decanter-ts-plugin/`, `decanter.config.json`,
      `tsconfig.json`, etc.), confirming `template/` resolves correctly
      from `dist/lib/` in an installed package. The first attempt this
      session (a single chained script) hit a sandbox permission denial;
      splitting it into individually-approved steps got it through.

## Manual steps left (user)

1. **Create the GitHub repo** `buttjer/n8n-decanter` — done. Pushed, tagged,
   and released through `v0.3.0` (7 GitHub Releases: v0.1.0–v0.2.4, v0.3.0).
   Description + topics are set.
2. **Flip the repo to public** — done 2026-07-20 (user action). Confirmed via
   `gh repo view` (`visibility: PUBLIC`).
3. **GitHub security settings** — done 2026-07-20 (via `gh api` PATCH on
   `security_and_analysis`): secret scanning **enabled**, push protection
   **enabled**, Dependabot security updates **enabled**, Dependabot
   vulnerability alerts **enabled** (`PUT .../vulnerability-alerts`).
   **CodeQL default setup** also configured (`PATCH
   .../code-scanning/default-setup`, languages `actions` +
   `javascript-typescript`) — first scan kicked off automatically
   (run `29735906655`), no need to babysit it. Optional, not done: OpenSSF
   Scorecard action + badge.
4. **Branch protection on `main`:** done 2026-07-20 — `protect-main` ruleset
   created (`gh api repos/buttjer/n8n-decanter/rulesets`, id `19202228`):
   Node 22/Node 24 required status checks, 0 required approvals (solo),
   linear history, no force-push/deletion, empty bypass list. **Merge
   settings set to squash-only** in the same pass (`allow_merge_commit` and
   `allow_rebase_merge` now `false`; `allow_squash_merge` and
   `delete_branch_on_merge` `true`) — verified via `gh api
   repos/buttjer/n8n-decanter --jq '{allow_squash_merge, allow_merge_commit,
   allow_rebase_merge}'`.

   **Tag ruleset also done** 2026-07-20 — `protect-tags` (id `19202659`,
   target `tag`, `refs/tags/v*`, blocks `deletion` + `update`) so release
   tags are immutable.
5. **GitHub Pages for the docs site (Plan 16):** done 2026-07-20 — the
   `Docs` workflow's deploy job had been failing since the PR #10 merge
   (`0cda701`) because Pages wasn't enabled while the repo was private (the
   workflow file already anticipated this). Enabled Pages with source
   "GitHub Actions" (`POST .../pages -f build_type=workflow`), then
   triggered a fresh `workflow_dispatch` run from current `main` (not a
   rerun of the stale failed run, since 3 later PRs updated `/docs` content
   without touching `website/`'s path filter) — build + deploy both
   succeeded, site live at `https://buttjer.github.io/n8n-decanter/`
   (`200`, verified via `curl`). This wasn't an original Plan 13 item but
   was blocked on the same public-repo gate; noting it here since it's the
   same unblock event. Consider linking this from
   [Plan 16](DONE-16-docs-website.md) too.
6. **npm account:** enable 2FA. Prefer **trusted publishing** (OIDC from
   GitHub Actions, configured on npmjs.com under the package's settings) or
   `npm publish --provenance` — verified-build badge. The `repository` field
   already matches `buttjer/n8n-decanter`. The 2026-07-20 publish (see step
   8) went out as a plain local `npm publish` — no `attestations` in the
   registry's `dist` metadata. **Deferred (2026-07-20, user decision):**
   trusted publishing/provenance isn't a priority for a solo project right
   now; revisit as a follow-up, not a Plan 13 blocker. 2FA can't be checked
   remotely — confirm on npmjs.com if not already on.
7. **CI-green-then-Release is now the standing workflow**, not a one-time
   step: per CLAUDE.md, every PR merge with a non-empty `Unreleased` section
   rolls the version, tags, and cuts a GitHub Release. This has been running
   on its own since 2026-07-19, independent of this plan — 7 releases exist
   (v0.1.0 through v0.3.0), and CI is green on `main` (checked 2026-07-20,
   last 5 runs all `success`). Repo is now public too, so this item is fully
   satisfied. Nothing left to do here specifically for Plan 13.
8. **Publish:** done 2026-07-20 — `n8n-decanter@0.3.0` is live on the
   registry (`npm view n8n-decanter version` → `0.3.0`; published as a plain
   local `npm publish`, not `--provenance` — see step 6). Post-publish
   check passed: `npx n8n-decanter@0.3.0 uuid` printed a UUID from the
   registry package. **Superseded 2026-07-20** — the user ran `npm publish`
   for v0.3.2 (the mid-session release, see Notes) themselves once the OTP
   requirement blocked this session; `npm view n8n-decanter version` now
   confirms `0.3.2`, matching `main` exactly. No lag remains.
9. Done 2026-07-20 — flipped to `DONE-13-open-source-release.md`.

## Acceptance / verification

- [x] `git log --all --format='%ae%n%ce' | sort -u` shows only
      `sudo@buttjer.net`.
- [x] `npm pack --dry-run` lists no `plans/`, `PLAN.md`, `CLAUDE.md`,
      `test/`, `.claude/`, or `decanter.config.json`.
- [x] CI green on the public repo before announcing it anywhere. Repo went
      public 2026-07-20; CI has been green on `main` throughout (checked
      2026-07-20, last 5 runs all `success`).
- [x] `npx n8n-decanter uuid` works from the registry on Node 22. Verified
      2026-07-20: `npx n8n-decanter@0.3.0 uuid` printed a UUID (re-verified
      at `0.3.2` after the user's publish).

## Notes

- Pre-public hygiene/trust items (linguist stats → 100% TypeScript,
  SECURITY.md, stale README fix, branch cleanup) and the history/secrets
  audit verdicts live in
  [Plan 17](DONE-17-public-trust-pass.md) (2026-07-19).
- No CHANGELOG entry for this plan's repo/packaging work — it's
  infrastructure, not CLI behavior (per CLAUDE.md changelog rules).
- The npm version badge in the README (`img.shields.io/npm/v/n8n-decanter`)
  404d until the first publish — it's a dynamic shields.io badge reading
  the registry live, so it needs no further action now that `0.3.0` is
  published (2026-07-20).
- **Version no longer frozen at 0.1.0** (superseding the earlier "stays
  0.1.0" call): the normal CLAUDE.md release process — any PR merge with a
  non-empty `Unreleased` bumps the version and cuts a GitHub Release —
  started running on 2026-07-19 independent of this plan's public-launch
  gate. As of 2026-07-20 the repo is **public and published to npm at
  v0.3.0** (7 GitHub Releases, v0.1.0–v0.2.4, v0.3.0 — same version shipped
  to npm). The original pre-1.0 reasoning (README lists open questions
  needing a live n8n instance) still holds — while <1.0, breaking
  data-model changes (`.decanter.json`, markers) bump the minor.
- MIT keeps the copyright line in every fork's LICENSE (that satisfies the
  attribution requirement discussed); it does not require product-credits
  mention — accepted 2026-07-18.
- **PLAN.md question — resolved 2026-07-20:** added a "Publish-build
  pipeline" entry to PLAN.md's "Decisions made" (next to the TypeScript CLI
  entry) documenting `tsconfig.build.json`/`prepack`/`dist/` and the two
  extension-aware runtime spots (`lib/validate.mts` `runTypecheck`,
  `lib/init.mts` `packageRootFrom`).
- **Known gap — fixed and released 2026-07-20 as v0.3.2,
  [PR #40](https://github.com/buttjer/n8n-decanter/pull/40)
  (`fix/global-install-typecheck-resolve`):** the typecheck subprocess
  imported `typescript` via a plain static import (resolved relative to the
  script's own file location), which only worked when the CLI happened to
  be nested inside the sync dir's `node_modules` — a global install never
  is. `scripts/typecheck.mts` now resolves `typescript` from `process.cwd()`
  (the sync dir) via `createRequire`, falling back to the script's own
  location. Regression test `test/unit/typecheck-resolve.test.mts` spawns
  the real script with cwd deliberately far from the script itself,
  mirroring the actual global-install topology.
  - **Mid-flight version collision:** while this PR was in progress, an
    unrelated PR ([#38](https://github.com/buttjer/n8n-decanter/pull/38),
    Plan 20's CLI publish lifecycle) merged to `main` first and took
    `v0.3.1` — a session/process outside this conversation. Rebased onto the
    new `main`, re-bumped to **v0.3.2**, re-ran the full suite (68 e2e + 10
    proxy + 12 interactive steps, all green — Plan 20 added the extra e2e
    and interactive coverage), force-pushed, confirmed CI green again, then
    squash-merged (`b4647d1`), tagged `v0.3.2` (now immutable via
    `protect-tags`), and cut the
    [GitHub Release](https://github.com/buttjer/n8n-decanter/releases/tag/v0.3.2).
  - **npm publish for v0.3.2 not done by this session** — the account has
    2FA enabled (resolving the open question in step 6 above), so
    `npm publish` demanded an OTP only the user can supply; user opted to
    run `npm publish` themselves rather than relay a one-time code.
    Checked the registry directly (`npm view n8n-decanter versions`): it's
    still only `0.3.0` — **the Plan 20 release (v0.3.1) was never published
    to npm either**, so the registry currently lags `main` by *two* patch
    versions (0.3.1 and 0.3.2 both tagged + GitHub-Released but not on
    npm) until the user runs `npm publish`.
  - This was the last item on the tarball/global-install verification
    list.
- **Closed 2026-07-20.** User ran `npm publish` for v0.3.2 themselves
  (registry confirmed at `0.3.2`, matching `main` — no lag). Nothing left
  but the explicitly-deferred, non-blocking npm trusted-publishing item
  (step 6), which doesn't gate closing this plan. Flipped to
  `DONE-13-open-source-release.md`.
