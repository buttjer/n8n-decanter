# Plan 16 — Documentation website

**Priority:** P2
**Status:** In progress
**Theme:** A static documentation website (Tailwind-styled) for n8n-decanter:
landing page + real docs pages carved out of the README, deployed alongside
the open-source release.

## Why

The README is release-quality but is becoming one long page: pitch, setup,
per-verb behavior, data model, TS compilation, guards, agent integration all
in one scroll. A docs site gives each topic its own page and URL (linkable
from issues, npm, agent configs), gives the project a landing page for the
public launch ([Plan 13](OPEN-13-open-source-release.md)), and creates room
for content that doesn't fit a README (guides, FAQ, screenshots/casts).

## Source

Direct user request (2026-07-19). No Plan 0 entry.

## Design decision

- **Content lives at the repo root in `/docs` as plain `.md`** (not `.mdx`,
  not inside `website/`), so the corpus is generator-agnostic and outlives
  the site tooling: Astro is replaceable, the Markdown is forever. The site
  reads it via Astro 5's Content Layer `glob()` loader with `base: "../docs"`
  ([content.config.ts](../website/src/content.config.ts)) — `entry.id` still
  yields `<group>/<page>`, so nav grouping (by top dir) is unchanged. The
  README screenshot (`docs/screenshot.webp`) is co-located there and reused
  in docs pages. Plain Markdown is a deliberate portability constraint: no
  bespoke MDX components — reach for one only as a conscious exception (the
  `@astrojs/mdx` integration stays wired for that case).
- **Stack: Astro + Tailwind**, static output, in a `website/` dir with
  its own `package.json` (a separate npm workspace-free subproject — the CLI
  keeps its no-build-for-dev property; the site is the one thing that
  builds, and only in its own dir).
  - Astro over Starlight/VitePress/Docusaurus: those ship their own theme
    systems and fight custom Tailwind styling; the whole point here is that
    **the user supplies the Tailwind settings** (see Notes), so we want a
    thin custom layout where Tailwind is the design system, not a skin.
  - Astro over Next.js: static-first, zero client JS by default, built-in
    Shiki code highlighting and content collections — a docs site needs
    nothing more.
  - **Tailwind v4** (CSS-first `@theme`) via `@tailwindcss/vite` by default;
    if the user's settings arrive as a v3 `tailwind.config.js`, use v4's
    `@config` compatibility layer or pin v3 — decide when the settings land.
- **Hosting: GitHub Pages** via Actions (free, no new accounts, fits the
  Plan 13 repo). Cloudflare Pages is the fallback if Pages limits chafe or
  a custom domain/redirects story is wanted — flag before switching.
- **README stays the npm/GitHub front door** but slims down after the site
  is live: pitch, quickstart, screenshot, link to the site. Deep per-verb
  and data-model detail moves to the site to stop the two drifting.
  PLAN.md remains the internal design source of truth — the site documents
  *usage*, never replaces PLAN.md.

## Tasks

1. **Scaffold `website/`** — Astro project (`npm create astro` minimal), MDX
   integration, Tailwind v4 via `@tailwindcss/vite`, TypeScript strict.
   Own `package.json`/lockfile; `website/dist/` gitignored; not in the npm
   `files` whitelist (verify with `npm pack --dry-run`). Existing `docs/`
   (README screenshot) stays as-is.
2. **Theme slot for the user's Tailwind settings** — single
   `website/src/styles/theme.css` holding the `@theme` tokens (colors, fonts,
   radii) with a **neutral placeholder palette**, so layout/content work is
   not blocked. **Blocked on user input:** swap in the real settings when
   provided; nothing else should hardcode colors/fonts outside this file.
3. **Docs shell** — layouts + components, all Tailwind:
   - sidebar nav (grouped: Getting started / CLI reference / Concepts /
     Agents), mobile drawer, prev/next links
   - prose styling (`@tailwindcss/typography` or hand-rolled to match the
     theme), Shiki code blocks matching light/dark
   - dark mode (class strategy, respects `prefers-color-scheme`, toggle)
   - landing page: pitch (reuse README bullets), screenshot, install
     one-liner, links to GitHub/npm
4. **Content** — MDX pages carved from README + template `AGENTS.md`
   (usage-level only; PLAN.md internals stay out):
   - Getting started: install, Node >= 22.18 + the `SyntaxError` engine-floor
     warning, `init`, first pull
   - CLI reference: one page per verb (`init`, `pull`, `push`, `status`,
     `check`, `watch`, `run`, `list`, `rename`, `uuid`) — flags, exit codes,
     offline/online
   - Concepts: sync layout & data model (`workflow.json` placeholders,
     `.decanter.json`, markers), TS nodes & `shared/` bundling, the two push
     gates (compliance vs drift, what `--force` does and doesn't bypass),
     watch & browser reload, auto-commits
   - Agents: what `init` scaffolds (AGENTS.md, hooks, editor configs), the
     offline `check`/`run` feedback loop
   - FAQ/troubleshooting
5. **Deploy** — `.github/workflows/docs.yml`: build on pushes to `main`
   touching `website/`, deploy via `actions/deploy-pages`; PR builds as
   check only. **Gated on the repo being public** (Plan 13) — Pages on Free
   private repos isn't available.
6. **Polish** — sitemap, canonical/OG meta, favicon, 404 page, and a
   link-check (e.g. `astro build` + a checker) wired into the docs CI job.
7. **README slim-down** (after the site is live) — trim deep detail, link to
   the site; PR that also adds the site URL to `package.json` `homepage`
   and the GitHub repo's website field.
8. *(Optional)* **Search** — Pagefind post-build step; cheap with Astro,
   fully static. Skip if the nav suffices at this page count.

## Done in the initial pass (2026-07-19)

- [x] **Task 1 — scaffold:** `website/` with astro 5.18 / tailwind 4.3 /
      mdx 4.3 + sitemap, own lockfile, `dist/`+`.astro/` gitignored.
      `ASTRO_TELEMETRY_DISABLED=1` needed in sandboxes/CI (telemetry writes
      to `~/Library/Preferences`).
- [x] **Task 2 — theme slot:** `src/styles/theme.css` (`@theme` tokens,
      placeholder amber accent + system font stacks). Still awaiting the
      user's real Tailwind settings — swap happens only in this file.
- [x] **Task 3 — docs shell:** header, grouped sidebar (active state,
      mobile `<details>` drawer), prev/next, class-based dark mode with
      pre-paint script + toggle, Shiki dual themes, typography prose.
- [x] **Task 4 — content:** 23 plain-`.md` pages (2 getting-started, 12 CLI
      incl. overview/completion, 6 concepts, 2 agents, 1 FAQ) living at the
      repo root in `/docs`, sourced from README + template `AGENTS.md`.
      Root-relative links get the deploy base via a rehype plugin in
      `astro.config.mjs` — content never hardcodes `/n8n-decanter`.
- [x] **Task 5 — deploy workflow written:** `.github/workflows/docs.yml`
      (PR = build + link check; main = deploy to Pages). **Activation
      gated** on the repo being public + Pages enabled (Settings → Pages →
      Source: GitHub Actions).
- [x] **Task 6 — polish:** sitemap, canonical/OG meta, favicon, 404,
      `scripts/check-links.mjs` wired into CI (`npm run check:links`).

Remaining: task 7 (README slim-down + `homepage`, after the site is live)
and optional task 8 (Pagefind).

## Landing-page + theme pass (2026-07-20)

- **Fonts now user-specified** (partial unblock of task 2): serif headlines at
  weight 500 (`ui-serif`), light sans body at 300 (`ui-sans-serif`), mono code
  (`ui-monospace`) — set as `@theme` tokens in `theme.css` and applied via an
  `@layer base` block in `global.css`. Landing headings get ~1.5× base sizes;
  **docs prose headings and sidebar group headings are sized 1.75×** the
  typography-plugin defaults so the light serif reads at the right scale.
  **The accent palette is still the placeholder amber** — swap when provided.
- **Header wordmark** is the CLI's block-minifont ASCII logo (from
  `lib/init.mts`), but rendered as **crisp inline SVG** — each glyph's 2×2
  quadrants expand to unit `<rect>`s at build time, so it tiles perfectly in
  any font (text rendering left visible gaps). "n8n" uses the accent color
  (`--color-accent-500`, the orange from the CLI logo); "decanter" uses
  `currentColor`.
- **Landing page** gained: 9 feature cards with **monochrome Unicode glyphs**
  in accent-tinted badges (no emoji), a "How it compares" table condensed from
  the README, and **two looping demo animations** — an interactive-picker
  simulation (`TerminalDemo.astro`) and a coding-agent-at-work simulation
  (`AgentDemo.astro`, fixed-height and **scrolling**, not resizing).
- **Client-JS exception:** the two demos add a little vanilla client JS beyond
  the dark-mode toggle (see Non-goals). Both are framework-free, self-contained
  in their component `<script>`, and disabled under `prefers-reduced-motion`.

## Acceptance / verification

- [x] `npm run dev` / `npm run build` in `website/` work locally; build is
      green in CI on PRs. (local build + link check green 2026-07-19; CI
      run pends the push)
- [ ] Site live on GitHub Pages; every CLI verb has a page; landing page
      renders the theme (placeholder until user settings, real after).
      (all verbs have pages; "live" gated on Plan 13)
- [x] Link check passes (internal links + README ↔ site cross-links).
      (25 pages, 0 broken; README cross-link lands with task 7)
- [x] `npm pack --dry-run` of the CLI package lists nothing from `website/`.
- [ ] README links to the site; no content exists only in a stale copy on
      both sides (each topic has one home). (task 7, after go-live)

## Non-goals

- Docs versioning (single version while 0.x), i18n, blog, comments.
- Any runtime/client framework beyond what Astro islands need (target: near
  zero client JS — the dark-mode toggle, optional search, and the two
  framework-free landing-page demo animations are the only client scripts).
- Documenting PLAN.md internals — the site is user docs.

## Notes

- **Blocked input:** the user provides the Tailwind settings later — task 2
  isolates them to one file so everything else can proceed with placeholders.
- Ordering: tasks 1–4 + 6 are fully local and can start now; task 5+7 land
  with/after [Plan 13](OPEN-13-open-source-release.md)'s public flip.
- No CHANGELOG entry — the website is project infrastructure, not CLI
  behavior (same reasoning as Plan 13's repo/packaging work). The README
  slim-down (task 7) is also changelog-exempt as docs.
- Domain: default is `buttjer.github.io/n8n-decanter`; a custom domain is a
  user decision — record it here if/when chosen.
