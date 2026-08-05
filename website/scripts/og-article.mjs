#!/usr/bin/env node
// Renders the article's social card (1200×630 PNG) from an inline SVG —
// the NodeFileHero motif under the title. Run manually when the title or
// motif changes; the PNG is committed, so CI never needs this script:
//
//   node scripts/og-article.mjs
//
// Uses @resvg/resvg-js with system fonts (Menlo), so it renders on a dev
// machine, not in CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const W = 1200;
const H = 630;

const mono = "Menlo, Consolas, monospace";

const tile = (x, y) =>
  `<rect x="${x}" y="${y}" width="96" height="96" rx="18" fill="#27272a" stroke="#52525b" stroke-width="2"/>` +
  `<text x="${x + 48}" y="${y + 60}" text-anchor="middle" font-family="${mono}" font-size="34" fill="#f4f4f5">{ }</text>`;

const chip = (cx, y, w, label) =>
  `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="54" rx="10" fill="#09090b" stroke="#34d399" stroke-opacity="0.5" stroke-width="2"/>` +
  `<text x="${cx}" y="${y + 35}" text-anchor="middle" font-family="${mono}" font-size="26" fill="#f4f4f5">${label}</text>`;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#52525b"/></marker>
    <marker id="grn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#34d399"/></marker>
  </defs>
  <rect width="${W}" height="${H}" fill="#09090b"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#27272a" stroke-width="2"/>

  <text x="80" y="150" font-family="${mono}" font-size="64" font-weight="700" fill="#f4f4f5">Free your Code nodes</text>
  <text x="80" y="215" font-family="${mono}" font-size="28" fill="#a1a1aa">Structure is n8n&#8217;s job. Code is git&#8217;s job.</text>

  <!-- workflow excerpt: clipped neighbours, two Code nodes, wires -->
  ${tile(264, 320)}
  ${tile(680, 320)}
  <rect x="-40" y="320" width="80" height="96" rx="18" fill="#18181b" stroke="#3f3f46" stroke-width="2"/>
  <rect x="1160" y="320" width="80" height="96" rx="18" fill="#18181b" stroke="#3f3f46" stroke-width="2"/>
  <line x1="40" y1="368" x2="256" y2="368" stroke="#52525b" stroke-width="3" marker-end="url(#dim)"/>
  <line x1="360" y1="368" x2="672" y2="368" stroke="#52525b" stroke-width="3" marker-end="url(#dim)"/>
  <line x1="776" y1="368" x2="1152" y2="368" stroke="#52525b" stroke-width="3" marker-end="url(#dim)"/>

  <!-- files, injected upward -->
  <line x1="312" y1="504" x2="312" y2="424" stroke="#34d399" stroke-width="3" marker-end="url(#grn)"/>
  <line x1="728" y1="504" x2="728" y2="424" stroke="#34d399" stroke-width="3" marker-end="url(#grn)"/>
  ${chip(312, 508, 330, "normalize-order.ts")}
  ${chip(728, 508, 250, "score-risk.ts")}

  <text x="80" y="600" font-family="${mono}" font-size="24" fill="#71717a">Malte Buttjer</text>
  <text x="${W - 80}" y="600" text-anchor="end" font-family="${mono}" font-size="24" fill="#71717a">n8n-decanter</text>
</svg>`;

const png = new Resvg(svg, {
  fitTo: { mode: "width", value: W },
  font: { loadSystemFonts: true, defaultFontFamily: "Menlo" },
}).render().asPng();

mkdirSync(new URL("../public/og/", import.meta.url), { recursive: true });
const out = new URL("../public/og/free-your-code-nodes.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${(png.length / 1024).toFixed(0)} KB)`);
