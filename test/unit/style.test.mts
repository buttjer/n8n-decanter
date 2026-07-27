// Unit tests for lib/style.mts's hand-rolled brand color (Plan 29). Everything
// else in that module delegates straight to util.styleText; `brand` is the one
// place we emit an SGR ourselves, so its gating and its depth ladder are the
// parts worth pinning down. A PassThrough with `isTTY`/`hasColors` bolted on
// stands in for a terminal — styleText validates that its `stream` really is a
// stream, so a plain object won't do.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { printBanner } from "../../lib/init.mts";
import { makeStyle } from "../../lib/style.mts";
import type { Log } from "../../lib/types.mts";

/** The website's `--color-accent-500: oklch(0.7 0.15 60)` in sRGB — #E18528. */
const TRUECOLOR = "\x1b[38;2;225;133;40m";
const XTERM256 = "\x1b[38;5;172m";
const RED = "\x1b[31m";

/**
 * A stream that claims to be a terminal of the given color depth in bits, and
 * — like the real `tty.WriteStream` — reports no color at all under `NO_COLOR`.
 * `getColorDepth` is what `styleText` gates on; `hasColors` is what `brand`
 * reads for the depth ladder, so both must come from the same source of truth.
 */
function fakeTty(bits: 24 | 8 | 4): NodeJS.WriteStream {
  const depth = (): number => (process.env.NO_COLOR ? 1 : bits);
  const s = new PassThrough() as unknown as NodeJS.WriteStream & { isTTY: boolean };
  s.isTTY = true;
  (s as unknown as { getColorDepth: () => number }).getColorDepth = depth;
  // declared standalone: contextually typing it off the overloaded
  // `hasColors` widens `count` to `number | object`
  const hasColors = (count: number = 16): boolean => count <= 2 ** depth();
  s.hasColors = hasColors as unknown as NodeJS.WriteStream["hasColors"];
  return s;
}

describe("style.brand (Plan 29)", () => {
  it("emits the exact website orange as 24-bit truecolor when the terminal has it", () => {
    const out = makeStyle(fakeTty(24)).brand("n8n");
    assert.equal(out, `${TRUECOLOR}n8n\x1b[39m`);
  });

  it("degrades to the nearest xterm-256 orange (172, not the overshooting 208)", () => {
    const out = makeStyle(fakeTty(8)).brand("n8n");
    assert.equal(out, `${XTERM256}n8n\x1b[39m`);
    assert.ok(!out.includes("38;5;208"), "208 = rgb(255,135,0) is measurably further from #E18528");
  });

  it("falls back to plain ANSI red on a 16-color terminal — exactly the pre-Plan-29 logo", () => {
    const style = makeStyle(fakeTty(4));
    assert.equal(style.brand("n8n"), style.red("n8n"));
    assert.equal(style.brand("n8n"), `${RED}n8n\x1b[39m`);
  });

  it("adds nothing at all when the stream isn't a color TTY (piped output, the LLM/e2e path)", () => {
    const piped = new PassThrough() as unknown as NodeJS.WriteStream;
    assert.equal(makeStyle(piped).brand("n8n"), "n8n");
  });

  it("honors NO_COLOR on a truecolor terminal — same gate as every other color", () => {
    const style = makeStyle(fakeTty(24));
    const before = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(style.brand("n8n"), "n8n");
      assert.equal(style.red("n8n"), "n8n", "the delegated colors agree — that's why brand asks styleText");
    } finally {
      if (before === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = before;
    }
  });
});

describe("printBanner (Plan 29)", () => {
  it("paints the n8n mark brand orange on a TTY, with no ANSI red left", () => {
    const lines: string[] = [];
    const realLog = console.log;
    const stdout = process.stdout as unknown as { isTTY?: boolean; hasColors?: unknown };
    const [wasTTY, hadHasColors] = [stdout.isTTY, stdout.hasColors];
    const log: Log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };
    try {
      stdout.isTTY = true;
      stdout.hasColors = () => true; // truecolor-capable
      console.log = (m: string) => lines.push(m);
      printBanner(log);
    } finally {
      console.log = realLog;
      stdout.isTTY = wasTTY;
      if (hadHasColors === undefined) delete stdout.hasColors;
      else stdout.hasColors = hadHasColors;
    }
    const banner = lines.join("\n");
    assert.ok(banner.includes(TRUECOLOR), "the wordmark's n8n columns use style.brand");
    assert.ok(!banner.includes(RED), "the old style.red is gone from the logo");
  });

  it("piped: one plain version line, no logo and no escapes", () => {
    const infos: string[] = [];
    const log: Log = { info: (m) => infos.push(m), ok: () => {}, warn: () => {}, error: () => {} };
    printBanner(log);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^n8n-decanter v\d+\.\d+\.\d+/);
    assert.ok(!infos[0].includes("\x1b"));
  });
});
