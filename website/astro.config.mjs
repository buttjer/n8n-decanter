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
 */
function rehypeBaseLinks() {
  const prefix = base.replace(/\/$/, "");
  const walk = (node) => {
    if (node.type === "element" && node.tagName === "a") {
      const href = node.properties?.href;
      if (typeof href === "string" && href.startsWith("/") && !href.startsWith(`${prefix}/`)) {
        node.properties.href = prefix + href;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  return (tree) => {
    walk(tree);
  };
}

export default defineConfig({
  site,
  base,
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
  markdown: {
    rehypePlugins: [rehypeBaseLinks],
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" },
    },
  },
});
