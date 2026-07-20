import { getCollection } from "astro:content";
import { href } from "./url";

/** Sidebar groups, keyed by content subdirectory, in display order. */
const GROUPS: Record<string, { label: string; order: number }> = {
  "getting-started": { label: "Getting started", order: 1 },
  cli: { label: "CLI reference", order: 2 },
  concepts: { label: "Concepts", order: 3 },
  agents: { label: "Agents", order: 4 },
  faq: { label: "Help", order: 5 },
};

export interface NavItem {
  id: string;
  title: string;
  href: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** All docs pages in sidebar order, grouped — also the prev/next order. */
export async function docsNav(): Promise<NavGroup[]> {
  const entries = await getCollection("docs");
  const groups = new Map<string, { order: number; label: string; items: { order: number; item: NavItem }[] }>();
  for (const entry of entries) {
    const dir = entry.id.includes("/") ? entry.id.split("/")[0]! : "";
    const meta = GROUPS[dir] ?? { label: "More", order: 99 };
    const group = groups.get(dir) ?? { ...meta, items: [] };
    group.items.push({
      order: entry.data.order,
      item: { id: entry.id, title: entry.data.title, href: href(`/docs/${entry.id}/`) },
    });
    groups.set(dir, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => ({
      label: g.label,
      items: g.items.sort((a, b) => a.order - b.order).map((i) => i.item),
    }));
}

/** Flattened sidebar order, for prev/next links. */
export async function flatDocs(): Promise<NavItem[]> {
  return (await docsNav()).flatMap((g) => g.items);
}
