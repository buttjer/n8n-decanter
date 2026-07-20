// Interactive workflow picker (Plan 19): bare `n8n-decanter` on a TTY in an
// inited project. Two stages — type-to-filter workflow list (pulled green,
// unpulled remote yellow), then a verb menu; unpulled entries pull directly.
// The pure state machine (filter, reducer, window) is exported for unit
// tests; runPicker's terminal IO takes injectable input/output streams
// (Plan 22) so test/interactive.mts can drive it without a real pty. Exists
// only behind a TTY gate at the CLI, so piped output never sees any of this.
import { emitKeypressEvents } from "node:readline";
import { style } from "./style.mts";

export interface PickerEntry {
  id: string;
  name: string;
  pulled: boolean;
}

/** The subset of readline's keypress event the reducer cares about. */
export interface PickerKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/** Verb menu for a pulled workflow, in display order. */
export const PICKER_VERBS = ["status", "pull", "push", "watch", "check", "executions"] as const;

export interface PickerState {
  stage: "workflow" | "verb";
  entries: PickerEntry[];
  query: string;
  /** Cursor into the *filtered* workflow list. */
  cursor: number;
  /** Set while in the verb stage. */
  selected?: PickerEntry;
  verbCursor: number;
  loadingRemote: boolean;
  /** Dim one-liner, e.g. "remote list unavailable (…)". */
  notice?: string;
}

export type PickerResult = { verb: string; id: string; name: string } | "quit" | "interrupted";

export type PickerStep = { done: false; state: PickerState } | { done: true; result: PickerResult };

/** Re-entry point after a verb ran: the picker loop resumes that workflow's menu. */
export interface PickerResume {
  id: string;
  verb: string;
}

export function initialState(
  entries: PickerEntry[],
  loadingRemote: boolean,
  opts: { resume?: PickerResume; notice?: string } = {},
): PickerState {
  const base: PickerState = { stage: "workflow", entries, query: "", cursor: 0, verbCursor: 0, loadingRemote, notice: opts.notice };
  const entry = opts.resume ? entries.find((e) => e.id === opts.resume!.id) : undefined;
  if (!entry) return base;
  // resumed workflow still unpulled (its pull failed): back on the list, cursor on it
  if (!entry.pulled) return { ...base, cursor: entries.indexOf(entry) };
  const verbIndex = PICKER_VERBS.indexOf(opts.resume!.verb as (typeof PICKER_VERBS)[number]);
  return { ...base, stage: "verb", selected: entry, verbCursor: Math.max(0, verbIndex) };
}

/** Case-insensitive substring match on name and id; empty query matches all. */
export function filterEntries(entries: PickerEntry[], query: string): PickerEntry[] {
  const q = query.toLowerCase();
  if (q === "") return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
}

/** Append remote workflows not already present locally, marked unpulled. */
export function mergeRemote(entries: PickerEntry[], remote: Array<{ id: string; name: string }>): PickerEntry[] {
  const known = new Set(entries.map((e) => e.id));
  return [...entries, ...remote.filter((w) => !known.has(w.id)).map((w) => ({ id: w.id, name: w.name, pulled: false }))];
}

/** Scroll window over a list: keeps the cursor visible, clamps to bounds. */
export function visibleWindow(length: number, cursor: number, height: number): { start: number; end: number } {
  if (length <= height) return { start: 0, end: length };
  const start = Math.min(Math.max(0, cursor - Math.floor(height / 2)), length - height);
  return { start, end: start + height };
}

const isPrintable = (key: PickerKey): boolean =>
  key.sequence !== undefined && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f"
  && key.ctrl !== true && key.meta !== true;

export function reduceKey(state: PickerState, key: PickerKey): PickerStep {
  if (key.ctrl && key.name === "c") return { done: true, result: "interrupted" };
  if (state.stage === "workflow") return reduceWorkflowKey(state, key);
  return reduceVerbKey(state, key);
}

function reduceWorkflowKey(state: PickerState, key: PickerKey): PickerStep {
  const filtered = filterEntries(state.entries, state.query);
  switch (key.name) {
    case "escape":
      return { done: true, result: "quit" };
    case "up":
      return { done: false, state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
    case "down":
      return { done: false, state: { ...state, cursor: Math.min(Math.max(0, filtered.length - 1), state.cursor + 1) } };
    case "return":
    case "enter": {
      const entry = filtered[state.cursor];
      if (!entry) return { done: false, state };
      if (!entry.pulled) return { done: true, result: { verb: "pull", id: entry.id, name: entry.name } };
      return { done: false, state: { ...state, stage: "verb", selected: entry, verbCursor: 0 } };
    }
    case "backspace":
      return { done: false, state: { ...state, query: state.query.slice(0, -1), cursor: 0 } };
  }
  if (isPrintable(key)) return { done: false, state: { ...state, query: state.query + key.sequence, cursor: 0 } };
  return { done: false, state };
}

function reduceVerbKey(state: PickerState, key: PickerKey): PickerStep {
  switch (key.name) {
    case "escape":
      return { done: false, state: { ...state, stage: "workflow", selected: undefined } };
    case "up":
      return { done: false, state: { ...state, verbCursor: Math.max(0, state.verbCursor - 1) } };
    case "down":
      return { done: false, state: { ...state, verbCursor: Math.min(PICKER_VERBS.length - 1, state.verbCursor + 1) } };
    case "return":
    case "enter":
      return { done: true, result: { verb: PICKER_VERBS[state.verbCursor], id: state.selected!.id, name: state.selected!.name } };
  }
  // a letter jumps to the next verb starting with it, cycling through
  // matches ("p" alternates pull/push) — no collision-free hotkeys needed
  if (isPrintable(key)) {
    const c = key.sequence!.toLowerCase();
    for (let step = 1; step <= PICKER_VERBS.length; step++) {
      const i = (state.verbCursor + step) % PICKER_VERBS.length;
      if (PICKER_VERBS[i].startsWith(c)) return { done: false, state: { ...state, verbCursor: i } };
    }
  }
  return { done: false, state };
}

// ---------- terminal IO (covered by test/interactive.mts via injected streams) ----------

const LIST_HEIGHT = 10;

// Placeholder rows shown where remote workflows will appear while the list
// loads: light-gray blocks shaped like "name  id", varied widths on purpose.
const SKELETON_WIDTHS: ReadonlyArray<readonly [number, number]> = [[14, 8], [9, 8], [17, 8]];

const truncate = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + "…" : text);

/** Filled = pulled, hollow = not pulled — differs by *shape*, so the state
 * survives NO_COLOR/monochrome without the old trailing `(not pulled)` words. */
const statusGlyph = (pulled: boolean): string => (pulled ? style.green("●") : style.yellow("○"));

/**
 * Pure view: `PickerState` → the lines to paint. Fed the docs-site
 * simulation's polish (Plan 23) — an aligned id column, `●`/`○` shape-based
 * status glyphs, and a per-stage title. Color is decoration only; every
 * distinction is carried by shape or words too, so `NO_COLOR` output stays
 * legible. Exported for the render unit tests (no TTY needed).
 */
export function renderLines(state: PickerState): string[] {
  const d = style.dim;
  const lines: string[] = [];
  if (state.stage === "verb") {
    const wf = state.selected!;
    lines.push(`${style.bold(truncate(wf.name, 48))}  ${d(wf.id)}`);
    PICKER_VERBS.forEach((verb, i) => {
      lines.push(i === state.verbCursor ? `${style.green("❯")} ${style.bold(verb)}` : `  ${verb}`);
    });
    lines.push(d("↑↓ move · enter run · esc back"));
    return lines;
  }
  const filtered = filterEntries(state.entries, state.query);
  lines.push(style.bold("pick a workflow"));
  lines.push(`${d("?")} ${state.query === "" ? d("type to filter") : state.query}`);
  const { start, end } = visibleWindow(filtered.length, state.cursor, LIST_HEIGHT);
  // Pad names to the widest one in the current window so the dim ids line up.
  let nameWidth = 0;
  for (let i = start; i < end; i++) nameWidth = Math.max(nameWidth, truncate(filtered[i].name, 48).length);
  for (let i = start; i < end; i++) {
    const e = filtered[i];
    const pointer = i === state.cursor ? style.green("❯") : " ";
    const display = truncate(e.name, 48);
    const name = (e.pulled ? style.green(display) : style.yellow(display)) + " ".repeat(nameWidth - display.length);
    lines.push(`${pointer} ${statusGlyph(e.pulled)} ${name}  ${d(e.id)}`);
  }
  if (filtered.length === 0 && !state.loadingRemote) lines.push(d(state.entries.length === 0 ? "  nothing pulled yet" : "  no match"));
  if (end < filtered.length) lines.push(d(`  … ${filtered.length - end} more`));
  if (state.loadingRemote) {
    for (const [nameW, idWidth] of SKELETON_WIDTHS) {
      lines.push(`  ${d("░".repeat(nameW))}  ${d("░".repeat(idWidth))}`);
    }
  }
  if (state.notice) lines.push(d(state.notice));
  // Legend states the glyph key once (footer), not on every row.
  if (filtered.length > 0) lines.push(d(`${statusGlyph(true)} pulled · ${statusGlyph(false)} not pulled`));
  const enterHint = filtered[state.cursor]?.pulled === false ? "enter pull" : "enter select";
  lines.push(d(`↑↓ move · ${enterHint} · esc quit`));
  return lines;
}

/** The subset of a TTY input stream runPicker needs — real `process.stdin`,
 * or an injected `PassThrough` in tests (no `isRaw`/`setRawMode`, no real TTY). */
export type PickerInputStream = NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => void };
/** The subset of a TTY output stream runPicker needs. */
export type PickerOutputStream = Pick<NodeJS.WritableStream, "write">;

/**
 * Run the picker on the current TTY. `remote` (when credentials exist) is
 * already in flight; its workflows are appended as they arrive. `resume`
 * re-opens a workflow's verb menu (the picker loop passes the last run).
 * Resolves with the chosen verb+id+name, or "quit" (Esc) / "interrupted"
 * (Ctrl-C). `input`/`output` default to the real TTY streams — tests inject
 * a `PassThrough` pair instead of needing a real pty (no new dependency).
 */
export async function runPicker(
  local: PickerEntry[],
  remote: Promise<Array<{ id: string; name: string }>> | undefined,
  opts: { resume?: PickerResume; notice?: string; input?: PickerInputStream; output?: PickerOutputStream } = {},
): Promise<PickerResult> {
  const input: PickerInputStream = opts.input ?? process.stdin;
  const output: PickerOutputStream = opts.output ?? process.stdout;
  let state = initialState(local, remote !== undefined, opts);
  let prevLines = 0;
  const repaint = (): void => {
    const lines = renderLines(state);
    const up = prevLines > 0 ? `\x1b[${prevLines}A` : "";
    output.write(`${up}\r\x1b[J${lines.join("\n")}\n`);
    prevLines = lines.length;
  };
  const erase = (): void => {
    if (prevLines > 0) output.write(`\x1b[${prevLines}A\r\x1b[J`);
    prevLines = 0;
  };

  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  const restore = (): void => {
    if (!wasRaw) input.setRawMode?.(false);
    output.write("\x1b[?25h");
  };
  input.setRawMode?.(true);
  input.resume();
  output.write("\x1b[?25l");
  process.once("exit", restore); // belt and braces: never leave the terminal raw
  let finished = false;
  let onKeypress: ((str: string | undefined, key: PickerKey | undefined) => void) | undefined;
  let onEnd: (() => void) | undefined;
  try {
    return await new Promise<PickerResult>((resolve) => {
      // stdin EOF can't happen on a real keyboard, but a closed input (pty
      // teardown, misuse) must quit instead of wedging the process forever
      onEnd = () => {
        finished = true;
        resolve("quit");
      };
      input.once("end", onEnd);
      onKeypress = (_str, key) => {
        const step = reduceKey(state, key ?? {});
        if (step.done) {
          finished = true;
          resolve(step.result);
          return;
        }
        state = step.state;
        repaint();
      };
      // handlers attach synchronously so a fast rejection is never unhandled
      remote
        ?.then((workflows) => {
          if (finished) return;
          state = { ...state, entries: mergeRemote(state.entries, workflows), loadingRemote: false };
          repaint();
        })
        .catch((err: Error) => {
          if (finished) return;
          state = { ...state, loadingRemote: false, notice: `remote list unavailable (${err.message.split("\n")[0]})` };
          repaint();
        });
      input.on("keypress", onKeypress);
      repaint();
    });
  } finally {
    finished = true;
    if (onKeypress) input.removeListener("keypress", onKeypress);
    if (onEnd) input.removeListener("end", onEnd);
    erase();
    restore();
    process.removeListener("exit", restore);
    input.pause();
  }
}
