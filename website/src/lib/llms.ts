import { getCollection } from "astro:content";
import { docsNav, flatDocs } from "./nav";

/** One-line project summary used as the `>` blockquote in both files. */
const SUMMARY =
  "Standalone CLI that syncs an n8n instance into a git-friendly, folder-per-workflow layout — every Code node's source becomes its own .js/.ts file, editable in your IDE or by an AI coding agent, and pushed back through the n8n public API.";

/** Absolutize a base-prefixed path against the deploy origin, when known. */
function abs(site: URL | undefined, path: string): string {
  return site ? new URL(path, site).href : path;
}

/**
 * `llms.txt` — the index form: project header plus a curated link list,
 * grouped exactly like the sidebar. https://llmstxt.org/
 */
export async function buildIndex(site?: URL): Promise<string> {
  const nav = await docsNav();
  const lines = ["# n8n-decanter", "", `> ${SUMMARY}`, ""];
  for (const group of nav) {
    lines.push(`## ${group.label}`, "");
    for (const item of group.items) {
      lines.push(`- [${item.title}](${abs(site, item.href)})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * `llms-full.txt` — every doc's full Markdown body inlined, in sidebar order,
 * each prefixed with its title heading and canonical source URL.
 */
export async function buildFull(site?: URL): Promise<string> {
  const flat = await flatDocs();
  const byId = new Map((await getCollection("docs")).map((e) => [e.id, e]));
  const lines = ["# n8n-decanter", "", `> ${SUMMARY}`, ""];
  for (const item of flat) {
    const entry = byId.get(item.id);
    if (!entry) continue;
    lines.push(
      "---",
      "",
      `# ${entry.data.title}`,
      "",
      `Source: ${abs(site, item.href)}`,
      "",
      (entry.body ?? "").trim(),
      "",
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}
