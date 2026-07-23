// Demo-GIF recorder — paste this whole file into the browser DevTools console
// while viewing the homepage of the *served* site (dev or build; the site's
// base is /n8n-decanter, so `npm run dev` at http://localhost:4321/n8n-decanter/
// works too). It captures the two homepage demo cards frame-by-frame with
// html2canvas-pro and encodes GIFs with gif.js, then downloads them.
//
// Output: terminal-demo.gif + agent-demo.gif in your Downloads folder — move
// them to docs/ as docs/terminal-demo.gif and docs/agent-demo.gif.
//
// The demo animations are the source of truth (website/src/components/
// TerminalDemo.astro + AgentDemo.astro); this only records them. `loopMs` must
// equal each component's animation cycle — see README.md in this folder for the
// current values and how to recompute them if you edit the frame/step timings.

// Tweak if needed, then re-paste:
const SCALE = 2;      // 2 = crisp/retina (bigger file); 1 = smaller/softer
const INTERVAL = 0;   // ms between captures (0 = back-to-back)
(async () => {
  const BASE = "/n8n-decanter/gifgen";
  const load = (src) =>
    new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  await load(`${BASE}/html2canvas-pro.min.js`);
  await load(`${BASE}/gif.js`);
  const pageBg = getComputedStyle(document.body).backgroundColor;

  async function recordGif(bodyId, { loopMs, filename }) {
    const card = document.getElementById(bodyId)?.parentElement;
    if (!card) return console.error("not found:", bodyId);
    const rect = card.getBoundingClientRect();
    const width = Math.round(rect.width * SCALE);
    const height = Math.round(rect.height * SCALE);
    const frames = [], stamps = [];
    const start = performance.now();
    while (performance.now() - start < loopMs) {
      const t = performance.now();
      const canvas = await html2canvas(card, { backgroundColor: pageBg, scale: SCALE, logging: false });
      frames.push(canvas); stamps.push(t);
      if (INTERVAL) await new Promise((r) => setTimeout(r, INTERVAL));
    }
    console.log(`${bodyId}: captured ${frames.length} frames over ${Math.round(performance.now() - start)}ms, encoding…`);
    const gif = new GIF({ workers: 2, quality: 10, width, height, workerScript: `${BASE}/gif.worker.js` });
    frames.forEach((c, i) => {
      const delay = i + 1 < stamps.length ? stamps[i + 1] - stamps[i] : 200;
      gif.addFrame(c, { delay: Math.max(20, Math.round(delay)) });
    });
    return new Promise((resolve) => {
      gif.on("progress", (p) => console.log(`${bodyId}: encoding ${Math.round(p * 100)}%`));
      gif.on("finished", (blob) => {
        const mb = (blob.size / 1048576).toFixed(2);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = filename; a.click();
        console.log(`${bodyId}: done → ${filename} (${mb} MB)`);
        resolve();
      });
      gif.render();
    });
  }
  await recordGif("term-demo-body", { loopMs: 13230, filename: "terminal-demo.gif" });
  await recordGif("agent-demo-body", { loopMs: 12100, filename: "agent-demo.gif" });
  console.log("✅ All done — check your Downloads folder.");
})();
