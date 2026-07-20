#!/usr/bin/env node
// Internal link check over the built site: every href/src in dist/ that
// points into the site must resolve to a built file. Run after `astro build`.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const base = (process.env.SITE_BASE ?? "/n8n-decanter").replace(/\/$/, "");

if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first");
  process.exit(1);
}

const htmlFiles = [];
const collect = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) collect(file);
    else if (file.endsWith(".html")) htmlFiles.push(file);
  }
};
collect(dist);

const targetExists = (target) => {
  if (existsSync(target) && statSync(target).isDirectory()) {
    return existsSync(path.join(target, "index.html"));
  }
  return existsSync(target);
};

let broken = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
    const clean = url.replace(/[#?].*$/, "");
    if (clean === "") continue;
    let target;
    if (clean.startsWith("/")) {
      if (!clean.startsWith(`${base}/`) && clean !== base) {
        console.error(`${path.relative(dist, file)}: absolute link missing base: ${url}`);
        broken++;
        continue;
      }
      target = path.join(dist, clean.slice(base.length));
    } else {
      target = path.resolve(path.dirname(file), clean);
    }
    if (!targetExists(target)) {
      console.error(`${path.relative(dist, file)}: broken link: ${url}`);
      broken++;
    }
  }
}

if (broken > 0) {
  console.error(`\n${broken} broken link(s) across ${htmlFiles.length} pages`);
  process.exit(1);
}
console.log(`links OK (${htmlFiles.length} pages)`);
