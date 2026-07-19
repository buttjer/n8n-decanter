# Plan 17 — Public trust pass (pre-release repo hygiene)

**Priority:** P1
**Status:** In progress
**Theme:** Last hygiene/trust items before the repo flips public — 100%
TypeScript language stats, SECURITY.md, stale-docs fix, branch cleanup — plus
the recorded audit verdicts on git history and secrets.

## Why

Direct user request (2026-07-19): a trust/professionalism review before going
public — is the git history presentable, what remains before the flip, and can
the GitHub language bar read 100% TypeScript. The action items are small but
public-facing; recording the audit verdicts keeps them from being re-litigated
later.

## Source

- Direct user request (2026-07-19). No Plan 0 entry.
- Complements [Plan 13](OPEN-13-open-source-release.md) (release mechanics);
  this plan is the hygiene/trust layer on top of it.

## Audit verdicts (recorded, no action)

- **Git history stays as-is** (user decision 2026-07-19). Verified: all
  author/committer emails are `sudo@buttjer.net` (+ GitHub noreply for
  merges/dependabot); **no secrets in any revision** — the once-tracked
  `decanter.config.json` was an empty stub, `workflows/` only ever held
  `.gitkeep`, and every API-key grep hit across `git log -p --all` is a test
  fixture (`test-key`) or localhost. The pre-0.1.0 `wip` commits are honest
  dev history; a rewrite would invalidate tags v0.1.0/v0.2.0, both GitHub
  Releases, and merged-PR refs — worse for trust than the wip messages.
- **`docs/screenshot.webp` is sanitized** — the real n8n host in its terminal
  pane is blanked; the visible workflow id is harmless without host/key.
- **Dependabot PR #5 (TypeScript 5.9 → 7.0.2) stays open** (user decision
  2026-07-19): TS 7 is a real migration (the typecheck pipeline leans on tsc
  internals and the tsserver plugin), decided separately, not blocking the
  flip.
- **The tree already has zero real `.js` files** — every tracked source is
  `.mts`/`.ts`; no pushed tree ever contained real JS. GitHub's "JavaScript
  7.2%" comes from linguist's content classifier guessing at the
  extension-less `template/*.example` files. Converting files would be wrong
  anyway: `decanter-ts-plugin/index.js.example` must stay CommonJS JS
  (tsserver `require()`s it in a build-free sync dir —
  [Plan 4](INPROGRESS-4-editor-node-diagnostics.md) non-goal), and
  `verify.mjs.example` gains nothing once linguist ignores examples.

## Tasks

1. [x] `.gitattributes` (repo root): `*.example -linguist-detectable` —
   excludes the template examples from language stats; syntax highlighting
   and PR diffs stay normal (deliberately not `linguist-vendored`).
2. [x] `SECURITY.md`: latest 0.x supported; report privately via GitHub
   private vulnerability reporting; no bounty.
3. [x] README "Type checking": drop the stale "known limitation" claim —
   0.2.0 ships `decanter-ts-plugin` suppressing TS1108/1375/1378 (Plan 4);
   the false positives only exist until the scaffolded plugin loads
   (workspace TypeScript + `npm install`).
4. [x] Stale remote branch cleanup — turned out already done: every branch
   of a merged PR was gone on GitHub (head-branch auto-delete is evidently
   active); only stale local tracking refs remained, pruned 2026-07-19 via
   `git fetch --prune`. Remote now: `main`,
   `dependabot/npm_and_yarn/typescript-7.0.2` (open PR #5), this PR's
   branch.
5. [x] Cross-links: plans/README.md entry, Plan 13 notes.

## Acceptance / verification

- CI green on the PR; squash-merged (internal-only: no version bump, no
  CHANGELOG entries — repo infra/docs).
- After merge: `gh api repos/buttjer/n8n-decanter/languages` returns only
  TypeScript (stats recompute on push; allow a few minutes).
- Branches page shows only `main` plus the open dependabot branch.
- SECURITY.md renders on the Security tab once private vulnerability
  reporting is enabled (Plan 13 settings step).

## Notes

- No CHANGELOG entries: nothing here is CLI behavior.
- GitHub Releases for v0.1.0/v0.2.0 already exist; npm publish is still
  pending (Plan 13 manual steps).
- Everything else pre-public stays in [Plan 13](OPEN-13-open-source-release.md):
  tarball smoke incl. `init`, the global-install typecheck gap, the PLAN.md
  "no build step (for dev)" wording, the public flip + rulesets + security
  settings + npm publish.
