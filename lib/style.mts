// TTY-gated styling (Plan 11). One rule: escape codes exist only when the
// target stream is a color-capable TTY — util.styleText handles that per
// stream and also honors NO_COLOR / FORCE_COLOR. Piped output (LLM harnesses,
// scripts, the e2e suite) gets the same words minus the escapes; color is
// additive decoration and never carries information alone.
import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  /**
   * The brand orange — the banner wordmark, so the CLI and the website agree
   * (Plan 29). Truecolor where the terminal has it, a 256-color orange next,
   * and `red` (what the logo used before) on a 16-color terminal.
   */
  brand(text: string): string;
  /** OSC 8 hyperlink on a TTY; plain `text url` (or just the url) otherwise. */
  link(text: string, url: string): string;
}

/**
 * Brand orange — **the single source of truth for the CLI side of the accent**.
 * The website paints the same wordmark with `--color-accent-500:
 * oklch(0.7 0.15 60)` (`website/src/styles/theme.css`); converted to sRGB
 * (Oklab → linear sRGB → gamma) that is `rgb(224.58, 132.58, 39.89)` →
 * **`#E18528`**. `styleText` has no orange and can't emit 24-bit SGR at all, so
 * this is a raw escape. Re-tuning the site's accent means re-deriving both
 * numbers below.
 */
const BRAND_RGB = "225;133;40"; // #E18528
/**
 * Nearest xterm-256 entry to `#E18528`, by Euclidean RGB distance over the
 * 6×6×6 cube + grays: **172** = `rgb(215,135,0)` (Δ≈41). Notably closer than
 * the obvious "orange" 208 = `rgb(255,135,0)` (Δ≈50), which overshoots red.
 */
const BRAND_XTERM256 = 172;

/**
 * How many colors this stream will really render. `hasColors` exists only on
 * TTY write streams and honors `NO_COLOR`/`FORCE_COLOR`/`TERM` itself; when the
 * stream isn't a TTY, colorization can only have come from `FORCE_COLOR`, whose
 * documented levels are 1 = 16, 2 = 256, 3 = truecolor.
 */
function colorBits(stream: NodeJS.WriteStream): 24 | 8 | 4 {
  if (typeof stream.hasColors === "function") {
    return stream.hasColors(2 ** 24) ? 24 : stream.hasColors(256) ? 8 : 4;
  }
  return process.env.FORCE_COLOR === "3" ? 24 : process.env.FORCE_COLOR === "2" ? 8 : 4;
}

/** Exported for the unit tests, which build a `Style` over a fake stream to
 * exercise the color-depth ladder without needing a real terminal. */
export function makeStyle(stream: NodeJS.WriteStream): Style {
  const s = (format: Format, text: string): string => styleText(format, text, { stream });
  return {
    bold: (t) => s("bold", t),
    dim: (t) => s("dim", t),
    green: (t) => s("green", t),
    yellow: (t) => s("yellow", t),
    red: (t) => s("red", t),
    brand: (t) => {
      // Gating is delegated to styleText itself rather than re-derived: if it
      // adds no escapes for this stream (piped, NO_COLOR, dumb TERM), neither
      // do we — one rule for every color, including the hand-rolled one.
      if (s("red", "x") === "x") return t;
      const bits = colorBits(stream);
      if (bits === 24) return `\x1b[38;2;${BRAND_RGB}m${t}\x1b[39m`;
      if (bits === 8) return `\x1b[38;5;${BRAND_XTERM256}m${t}\x1b[39m`;
      return s("red", t); // ≤16 colors: exactly what the logo looked like pre-Plan-29
    },
    link: (text, url) =>
      stream.isTTY ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text === url ? url : `${text} ${url}`,
  };
}

/** Styling gated on the stream the text actually goes to. */
export const style = makeStyle(process.stdout);
export const styleErr = makeStyle(process.stderr);

/**
 * TTY-only transient status line ("pulling wf123…"): shown in place, erased
 * before the next real log line replaces it. Piped output never sees it.
 */
export function transientLine(): { show(text: string): void; clear(): void } {
  let pending = false;
  return {
    show(text) {
      if (!process.stdout.isTTY) return;
      process.stdout.write(text);
      pending = true;
    },
    clear() {
      if (pending) process.stdout.write("\r\x1b[2K");
      pending = false;
    },
  };
}
