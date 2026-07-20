import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const docs = defineCollection({
  // Content lives at the repo root in /docs — plain Markdown, generator-
  // agnostic and outside this Astro project so it outlives the site tooling.
  loader: glob({ base: "../docs", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // position within the page's group (the group is the directory name)
    order: z.number(),
  }),
});

export const collections = { docs };
