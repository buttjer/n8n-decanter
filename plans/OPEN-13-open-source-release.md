# Plan 13 — Open-source release (GitHub + npm)

**Priority:** P1
**Status:** In progress
**Theme:** Everything between "the code is done" and "v0.1.0 is public on
GitHub and npm": identity rewrite, repo hygiene, publish pipeline,
post-publish verification.

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
- [ ] **Re-run the tarball smoke incl. `init` before publishing** — the
      first pass only exercised `uuid` and missed that `init` resolved
      `template/` relative to `dist/lib/`, which the tarball doesn't contain
      (found + fixed 2026-07-18, `packageRootFrom` in `lib/init.mts`,
      unit-tested for both layouts). Verify: pack → install into a clean
      prefix → `n8n-decanter init <tmp>` copies the template.

## Manual steps left (user)

1. **Create the GitHub repo** `buttjer/n8n-decanter` (empty — no README/
   license/gitignore from GitHub's wizard), then:

   ```sh
   git push -u origin main
   git push origin v0.1.0
   ```

   Description + topics (web UI, or):

   ```sh
   gh repo edit buttjer/n8n-decanter \
     --description "Keep n8n workflows in git: pull Code nodes into per-workflow folders, push them back." \
     --add-topic n8n --add-topic workflow --add-topic git --add-topic sync \
     --add-topic cli --add-topic typescript --add-topic agentic
   ```

2. **GitHub security settings** (Settings → Advanced Security / Code
   security): secret scanning **+ push protection**, Dependabot alerts
   (the config file is already committed), CodeQL default setup (JS/TS).
   Optional later: OpenSSF Scorecard action + badge.
3. **Branch protection on `main`:** create the `protect-main` ruleset.
   Attempted 2026-07-19: the API 403s on a Free-plan *private* repo
   ("Upgrade to GitHub Pro or make this repository public") — creation
   isn't even possible before the flip, so run this right after going
   public. Check names are ci.yml's job display names (`Node 22`/`Node 24`);
   approvals stay 0 (solo — GitHub blocks approving your own PR); bypass
   list stays empty. Also set repo merge settings: squash-only,
   auto-delete head branches.

   ```sh
   gh api repos/buttjer/n8n-decanter/rulesets -X POST --input - <<'EOF'
   {
     "name": "protect-main",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "required_linear_history" },
       { "type": "pull_request",
         "parameters": {
           "required_approving_review_count": 0,
           "dismiss_stale_reviews_on_push": false,
           "require_code_owner_review": false,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false
         } },
       { "type": "required_status_checks",
         "parameters": {
           "strict_required_status_checks_policy": false,
           "required_status_checks": [
             { "context": "Node 22" },
             { "context": "Node 24" }
           ]
         } }
     ]
   }
   EOF
   ```

   Optional in the same step: a tag ruleset for `v*` (block deletion +
   updates) so release tags are immutable.
4. **npm account:** enable 2FA. Prefer **trusted publishing** (OIDC from
   GitHub Actions, configured on npmjs.com under the package's settings) or
   `npm publish --provenance` — verified-build badge. The `repository` field
   already matches `buttjer/n8n-decanter`.
5. **Wait for CI green** on the pushed repo, then create the GitHub Release
   from tag `v0.1.0` with the CHANGELOG 0.1.0 section as notes. *(Done
   2026-07-19 — Releases exist for v0.1.0 and v0.2.0; the procedure is now a
   standard release step per CLAUDE.md.)*
6. **Publish:** `npm publish` (from CI with provenance preferred; locally,
   `npm publish` after `npm login` works too). Post-publish check:
   `npx n8n-decanter uuid` from a machine with Node >= 22.18.
7. When all of the above is done: flip this plan to `DONE-13-…`.

## Acceptance / verification

- [x] `git log --all --format='%ae%n%ce' | sort -u` shows only
      `sudo@buttjer.net`.
- [x] `npm pack --dry-run` lists no `plans/`, `PLAN.md`, `CLAUDE.md`,
      `test/`, `.claude/`, or `decanter.config.json`.
- [ ] CI green on the public repo before announcing it anywhere.
- [ ] `npx n8n-decanter uuid` works from the registry on Node 22.

## Notes

- Pre-public hygiene/trust items (linguist stats → 100% TypeScript,
  SECURITY.md, stale README fix, branch cleanup) and the history/secrets
  audit verdicts live in
  [Plan 17](DONE-17-public-trust-pass.md) (2026-07-19).
- No CHANGELOG entry for this plan's repo/packaging work — it's
  infrastructure, not CLI behavior (per CLAUDE.md changelog rules).
- The npm version badge in the README 404s until the first publish — expected.
- Version stays **0.1.0**: README still lists open questions needing a live
  n8n instance; pre-1.0 signals that honestly. While <1.0, breaking
  data-model changes (`.decanter.json`, markers) bump the minor.
- MIT keeps the copyright line in every fork's LICENSE (that satisfies the
  attribution requirement discussed); it does not require product-credits
  mention — accepted 2026-07-18.
- **PLAN.md question (open):** "no build step" in PLAN.md/CLAUDE.md now
  means "no build step *for dev*" — the npm tarball is compiled. Ask the
  user whether PLAN.md should record the publish-build design (forced by
  Node's node_modules type-stripping refusal, not a style choice).
- Known gap (pre-existing, unchanged by the build step): the typecheck
  subprocess imports `typescript` — resolvable from a sync dir that has the
  scaffolded devDep next to it, but a *globally* installed CLI relies on the
  sync dir's `node_modules/typescript` being reachable from the global
  install location, which it isn't. Verify against a real global install;
  candidate fix: resolve `typescript` from the target tsconfig dir via
  `createRequire`.
