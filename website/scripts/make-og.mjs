// Generates the Open Graph card: a self-contained 1200×630 HTML element
// (public/og.html) that renders to public/og.png via headless Chrome. Run:
//   node scripts/make-og.mjs           # writes og.html
//   node scripts/make-og.mjs --render  # + renders og.png with Chrome
// The card reuses the CLI's block wordmark (same source as Header.astro),
// expanded to crisp SVG pixels so it needs no font.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACCENT = "#e8892b"; // ~oklch(0.7 0.15 60), the site's accent orange
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- block-minifont wordmark → SVG rects (mirrors Header.astro) ---
const LOGO_ROWS = [
  "  ▄▖     ▌        ▗",
  "▛▌▙▌▛▌  ▛▌█▌▛▘▀▌▛▌▜▘█▌▛▘",
  "▌▌▙▌▌▌  ▙▌▙▖▙▖█▌▌▌▐▖▙▖▌",
];
const QUAD = {
  " ": [0, 0, 0, 0],
  "▘": [1, 0, 0, 0], "▝": [0, 1, 0, 0], "▖": [0, 0, 1, 0], "▗": [0, 0, 0, 1],
  "▀": [1, 1, 0, 0], "▄": [0, 0, 1, 1], "▌": [1, 0, 1, 0], "▐": [0, 1, 0, 1],
  "█": [1, 1, 1, 1],
  "▙": [1, 0, 1, 1], "▟": [0, 1, 1, 1], "▛": [1, 1, 1, 0], "▜": [1, 1, 0, 1],
  "▚": [1, 0, 0, 1], "▞": [0, 1, 1, 0],
};
const OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const N8N_COLS = 6;

function logoSvg(height) {
  const accent = [];
  const fg = [];
  let width = 0;
  LOGO_ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      (QUAD[ch] ?? QUAD[" "]).forEach((on, k) => {
        if (!on) return;
        const x = c * 2 + OFFSETS[k][0];
        const y = r * 2 + OFFSETS[k][1];
        width = Math.max(width, x + 1);
        (c < N8N_COLS ? accent : fg).push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      });
    });
  });
  return `<svg viewBox="0 0 ${width} 6" height="${height}" width="${(width / 6) * height}" shape-rendering="crispEdges" fill="none"><g fill="${ACCENT}">${accent.join("")}</g><g fill="#fafafa">${fg.join("")}</g></svg>`;
}

const glyphs = ["⎇", "{ }", "❖", "⊘", "☰", "↯", "⧉", "⌘", "⬡"];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: #09090b;
    background-image: radial-gradient(1100px 620px at 12% -10%, rgba(232,137,43,0.16), transparent 62%);
    color: #fafafa;
    font-family: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-weight: 300;
    padding: 58px 80px;
    display: flex; flex-direction: column; justify-content: space-between;
    position: relative;
  }
  body::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: ${ACCENT}; }
  h1 { font-family: ui-serif, Georgia, "Times New Roman", serif; font-weight: 500; font-size: 64px; line-height: 1.1; letter-spacing: -0.5px; max-width: 920px; }
  h1 .accent { color: ${ACCENT}; }
  .sub { margin-top: 22px; font-size: 24px; line-height: 1.5; color: #a1a1aa; max-width: 900px; }
  .glyphs { display: flex; gap: 12px; margin-top: 4px; }
  .chip {
    display: flex; align-items: center; justify-content: center;
    width: 50px; height: 50px; border-radius: 11px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 22px;
    color: ${ACCENT}; background: rgba(232,137,43,0.10);
    box-shadow: inset 0 0 0 1px rgba(232,137,43,0.28);
  }
  .foot { display: flex; align-items: center; justify-content: space-between; }
  .pill {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 24px;
    color: #e4e4e7; background: #18181b; border: 1px solid #27272a;
    border-radius: 12px; padding: 13px 20px;
  }
  .pill .dim { color: #71717a; }
  .url { font-size: 23px; color: #71717a; }
</style></head>
<body>
  <div>
    ${logoSvg(56)}
    <h1 style="margin-top:30px">Work on n8n like a codebase —<br><span class="accent">built for AI coding agents.</span></h1>
    <p class="sub">Sync n8n Code nodes into a git-friendly, folder-per-workflow layout of <code>.js</code>/<code>.ts</code> files — edit in your IDE or agent, push back through the API.</p>
  </div>
  <div class="glyphs">${glyphs.map((g) => `<div class="chip">${g}</div>`).join("")}</div>
  <div class="foot">
    <div class="pill"><span class="dim">$</span> npm install -g n8n-decanter</div>
    <div class="url">buttjer.github.io/n8n-decanter</div>
  </div>
</body></html>`;

const htmlPath = path.join(publicDir, "og.html");
writeFileSync(htmlPath, html);
console.log("wrote", htmlPath);

if (process.argv.includes("--render")) {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const out = path.join(publicDir, "og.png");
  const userDir = mkdtempSync(path.join(tmpdir(), "chrome-og-"));
  execFileSync(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=1200,630",
    `--user-data-dir=${userDir}`, `--screenshot=${out}`,
    `file://${htmlPath}`,
  ], { stdio: "inherit" });
  console.log("wrote", out);
}
