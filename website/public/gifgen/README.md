# gifgen — homepage demo-GIF recorder

Vendored tooling to (re)record the two homepage demo GIFs
(`docs/terminal-demo.gif`, `docs/agent-demo.gif`) **in the browser**, straight
from the live animated demo components. No external screen recorder, no build
step — paste a script into the console and the GIFs download.

## Why it lives here

The demo animations are the **source of truth**:

- [`TerminalDemo.astro`](../../src/components/TerminalDemo.astro) — the picker
  demo. Capture target: element id `term-demo-body`.
- [`AgentDemo.astro`](../../src/components/AgentDemo.astro) — the coding-agent
  loop. Capture target: element id `agent-demo-body`.

The GIFs are just recordings of those cards playing. Fix the **component** copy
first (that's the real edit); then re-record here so the GIF matches.

These files sit in `public/` because the recorder loads them by URL at the
deploy base (`/n8n-decanter/gifgen/…`); they ship with the site but are only
ever fetched when you run the recorder by hand.

## How to record

1. Serve the site (the base is `/n8n-decanter` in dev **and** build):
   ```sh
   cd website && ASTRO_TELEMETRY_DISABLED=1 npm run dev
   # open http://localhost:4321/n8n-decanter/
   ```
   (or `npm run build && npm run preview` — same base.)
2. Open DevTools → Console on that homepage.
3. Paste the whole of [`record.js`](./record.js) and press Enter. It loads
   `html2canvas-pro.min.js` + `gif.js`, captures each demo card frame-by-frame
   for one animation cycle, encodes a GIF (per-frame delays = real capture
   timing), and downloads `terminal-demo.gif` + `agent-demo.gif`.
4. Move both into `docs/` (`docs/terminal-demo.gif`, `docs/agent-demo.gif`) and
   commit. Tunables at the top of `record.js`: `SCALE` (2 = retina), `INTERVAL`.

## Keeping `loopMs` in sync with the animations

`record.js` captures for a fixed `loopMs` per demo — it **must equal that
component's animation cycle** (the sum of its frame/step `ms`), or the GIF cuts
off early or double-captures. Current cycles:

| Demo | Component array | Cycle | `loopMs` in `record.js` |
| --- | --- | --- | --- |
| terminal | `frames: [html, ms][]` | **12450 ms** (700 + 12×130 typing + 900 + 2×950 + 820+820+900 + 850 + 2400 + 1600) | 13230 (over by ~780 ms → wraps a hair into the next cycle, fine) |
| agent | `steps: [html, ms][]` | **11400 ms** (1400+1200+1500+1600+1500+1600+2600) | 11400 (exact) |

If you change any frame/step `ms` in a component, recompute its cycle and update
`loopMs`. Adding/removing a **verb** (TerminalDemo `verbs`) or editing step
**text** does not change timing — only the `ms` values do.

## Vendored libraries

Third-party, MIT-licensed, committed verbatim from npm (not built here):

- `html2canvas-pro.min.js` — [html2canvas-pro](https://www.npmjs.com/package/html2canvas-pro) 2.3.1 (global `html2canvas`)
- `gif.js` + `gif.worker.js` — [gif.js](https://www.npmjs.com/package/gif.js) 0.2.0 (global `GIF`)

To refresh: `npm pack html2canvas-pro@<v> gif.js@<v>`, then copy `dist/
html2canvas-pro.min.js`, `dist/gif.js`, and `dist/gif.worker.js` here.
