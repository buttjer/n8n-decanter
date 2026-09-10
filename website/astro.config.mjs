import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// GitHub Pages project site by default; override both for a custom domain.
const site = process.env.SITE_URL ?? "https://buttjer.github.io";
const base = process.env.SITE_BASE ?? "/n8n-decanter";

/**
 * Markdown/MDX authors write root-relative links (`/docs/cli/push/`); this
 * prefixes them with the deploy base so content never hardcodes it.
 *
 * A Sätteri hast plugin rather than a rehype one: Astro 7.3 made Sätteri the
 * default processor and stopped installing the unified pipeline, so
 * `markdown.rehypePlugins` now aborts config validation. The filter is what
 * replaces the hand-rolled tree walk this used to do.
 */
function baseLinks() {
  const prefix = base.replace(/\/$/, "");
  return {
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
  };
}

export default defineConfig({
  site,
  base,
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
  markdown: {
    processor: satteri({ hastPlugins: [baseLinks()] }),
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" },
    },
  },
});
