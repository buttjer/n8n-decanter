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
  /** OSC 8 hyperlink on a TTY; plain `text url` (or just the url) otherwise. */
  link(text: string, url: string): string;
}

function makeStyle(stream: NodeJS.WriteStream): Style {
  const s = (format: Format, text: string): string => styleText(format, text, { stream });
  return {
    bold: (t) => s("bold", t),
    dim: (t) => s("dim", t),
    green: (t) => s("green", t),
    yellow: (t) => s("yellow", t),
    red: (t) => s("red", t),
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
