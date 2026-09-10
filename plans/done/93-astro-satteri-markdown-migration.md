# Plan 93 — move the docs site onto Astro's Sätteri Markdown processor

**Status:** Done
**Priority:** P2 (blocks the astro 7.3 bump; small in lines, but it replaces the
one custom plugin the site depends on, so it needs a real verification pass)
**Source:** housekeeping pass 2026-09-10 — Dependabot [#306](https://github.com/buttjer/n8n-decanter/pull/306)
(astro 7.1.1 → 7.3.2) fails `Build site`. Maintainer chose migration over
re-installing the legacy processor.
**Snapshot:** 2026-09-10T12:23Z @ 8b019cc
**Model:** Sonnet (well-specified; the API shapes below are read off the Astro
source, not guessed)

Astro 7.3 makes **Sätteri** the default Markdown processor and stops installing
`@astrojs/markdown-remark`, so `website/astro.config.mjs`'s `markdown.rehypePlugins`
entry now aborts the build. Port the site's one custom plugin — `rehypeBaseLinks`,
which prefixes root-relative links with the deploy base — to a Sätteri hast plugin
and drop the deprecated option, so the site builds on 7.3 without pulling the old
unified pipeline back in.

## Why

The docs site ships every `/docs` link as root-relative (`/docs/cli/push/`) and
lets one rehype plugin add the GitHub Pages base (`/n8n-decanter`) at build time,
so no page has to hardcode the deploy path. That plugin is the site's only
Markdown customisation, and it is exactly what 7.3 breaks.

Astro's own error offers the cheap way out — `npm install @astrojs/markdown-remark`,
which was **measured to work** during the housekeeping pass (31 pages built, all 12
base-prefixed links on `docs/cli/overview` intact). That path was rejected on
purpose: it re-adds a dependency Astro is moving off, and parks the site on a
deprecated option that will break again.

## What the migration actually looks like

Read off `withastro/astro@main` on 2026-09-10:

- `markdown.processor` is the new option; it defaults to `satteri()` from
  `@astrojs/markdown-satteri` (`packages/astro/src/core/config/schemas/base.ts:376`).
  `remarkPlugins` / `rehypePlugins` / `remarkRehype` are the deprecated legacy
  path and are what trip `coerceLegacyMarkdownPlugins`.
- `satteri()` takes `{ mdastPlugins, hastPlugins, features }`
  (`packages/markdown/satteri/src/processor.ts:21`).
- A hast plugin is a **named-visitor object**, not a unified transformer — it
  filters by tag name instead of walking the tree by hand
  (`packages/markdown/satteri/src/satteri-processor.ts:118`, the `heading-ids`
  plugin, is the model to copy):

  ```js
  {
    name: "base-links",
    element: {
      filter: ["a"],
      visit(node, ctx) {
        const href = node.properties?.href;
        if (typeof href === "string" && href.startsWith("/") && !href.startsWith(`${prefix}/`)) {
          ctx.setProperty(node, "href", prefix + href);
        }
      },
    },
  }
  ```

  That is the whole of `rehypeBaseLinks`, minus its hand-rolled `walk()` — the
  filter does the traversal.

## Tasks

1. **Port the plugin.** Rewrite `rehypeBaseLinks` in `website/astro.config.mjs`
   as a Sätteri hast plugin per the shape above, and pass it as
   `markdown: { processor: satteri({ hastPlugins: [...] }) }`. Drop
   `markdown.rehypePlugins`.
2. **Settle the import.** `@astrojs/markdown-satteri` arrives as an astro
   dependency; decide whether to rely on that or add it to `website/package.json`
   explicitly. Prefer explicit — the config imports it directly, so it is a real
   dependency of the site, not a transitive one.
3. **Confirm `shikiConfig` survives.** Sätteri drives highlighting through its own
   `createHighlightPlugin` (`satteri-processor.ts:189`). Check that the site's
   `themes: { light: "github-light", dark: "github-dark" }` still applies under
   `markdown.processor`, and move it if the option relocated.
4. **Check MDX.** The site loads `@astrojs/mdx`; Sätteri has its own `mdx` path
   (`packages/markdown/satteri/src/mdx/`). Content is plain Markdown by policy
   (root `AGENTS.md`, "Documentation site"), so this should be a no-op — verify
   rather than assume.
5. **Take the bump.** Rebase or re-open Dependabot #306 and watch `Build site` to
   green.

## Acceptance / verification

**The link-count criterion this plan shipped with was wrong, and the execution
pass replaced it.** It asked for "**12** `href="/n8n-decanter/…`" on one page,
counted with `grep -c` — which counts matching *lines*, not links. The two
processors wrap their HTML differently, so that number moved from 12 to 13 on a
build whose links were in fact byte-identical. A criterion that fires on
formatting is worse than none: it sends you hunting a regression that isn't
there. What replaced it:

- `npm run build` in `website/` exits 0 and reports **31 pages built**.
- **The full link set matches, across every page.** Extract every `href="…"`
  from all 32 built HTML files, sort, count occurrences, and diff that against
  the same extraction from a build of current `main`. This must come out empty.
  A page whose links silently lost the base prefix builds fine and is broken on
  GitHub Pages, so the build exit code does not cover it.
- **The rendered pages match too**, once entity-escaping style, whitespace and
  the hashed asset filenames are normalised away (`/tmp/compare-dist.mts` in the
  execution session; the normaliser is four `replace` calls). This is the check
  that catches a lost heading id or a dropped attribute, which a link diff does
  not.
- No `@astrojs/markdown-remark` in `website/package.json`, its lockfile, or
  `node_modules`.
- `npm run check:links` passes.
- PR #306's `Build site` check passes.

**Result:** link sets identical. Rendered output identical on 31 of 32 pages —
the one difference is Sätteri **fixing** a legacy SmartyPants bug, rendering the
opening quote of `## "n8n refused the MCP request (403 …)"` as `“` where the old
processor emitted a closing `”` at both ends.

## Notes

- **No CHANGELOG entry**: the docs site's build tooling is not a user-facing
  surface of the CLI.
- **No `/docs`, README or `overview.md` change** — the command surface is
  untouched, so the three-surface rule does not apply here.
- **`@astrojs/mdx` needed a major bump the plan did not anticipate.** 7.0.3
  declares `peerOptional @astrojs/markdown-satteri@^0.3.1`, but astro 7.3.2
  ships 0.4.1 — so adding the explicit dependency Task 2 asks for fails
  `ERESOLVE`. `@astrojs/mdx@8.0.1` peers on `astro@^7.2.6` and
  `@astrojs/markdown-satteri@^0.4.0`, and keeps `@astrojs/markdown-remark`
  optional, so it resolves cleanly and pulls no legacy processor back in. The
  site has **no `.mdx` content files** (29 plain `.md` under `docs/`), so the
  major carries no content risk here.
- **The explicit dependency is not optional.** astro nests
  `@astrojs/markdown-satteri` under its own `node_modules`, and `astro/markdown`
  does not re-export `satteri`, so `astro.config.mjs` cannot import it without a
  direct entry in `website/package.json`.
- **Two docs sources were fixed on the way**, because they were the only content
  difference between the two builds: `docs/faq/troubleshooting.md:82` and
  `docs/concepts/configuration.md:125` wrote `[list --remote](…)` as plain link
  text, so smart punctuation ate the `--` (an em dash under the old processor,
  an en dash under Sätteri). They are now backticked, matching how every other
  flag-bearing link in `/docs` is already written — and a reader can copy the
  flag again.
- The legacy `@astrojs/markdown-remark` route stays available as a fallback if
  the port hits something the source read above did not predict. Say so and stop
  rather than half-migrating.
