// Drives the picker's terminal IO loop (lib/picker.mts runPicker) through
// injected PassThrough streams — no real pty, no new dependency (Plan 22
// task 2). The pure state machine already has full unit coverage
// (test/unit/picker.test.mts); this file exercises the part that was
// previously "TTY only, untested by CI": keypress wiring, raw-mode/cursor
// lifecycle, the remote-promise repaint, resume, and EOF/interrupt exits.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ForceableError } from "../lib/errors.mts";
import { ENABLE_MCP_VERB, confirmForceRetry, mergeRemote, runPicker, runVerbWithForceRetry, sortByRecency, type PickerEntry } from "../lib/picker.mts";
import { createStepRunner } from "./harness.mts";

const { step, passedCount } = createStepRunner();

const ENTRIES: PickerEntry[] = [
  { id: "aaa111", name: "Billing Sync", pulled: true, available: true },
  { id: "bbb222", name: "Mail Digest", pulled: true, available: true },
  { id: "ccc333", name: "Backup", pulled: false, available: true },
];

function makeIo() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return {
    input,
    output,
    text: () => chunks.join(""),
    reset: () => {
      chunks.length = 0;
    },
  };
}
type Io = ReturnType<typeof makeIo>;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Send a complete key sequence (arrows/enter/backspace/printable chars/ctrl-c) — these decode synchronously. */
async function sendKey(io: Io, seq: string): Promise<void> {
  io.input.write(seq);
  await tick();
}
/**
 * A standalone Escape byte is ambiguous with the start of a multi-byte
 * sequence, so Node's keypress decoder holds it for ~500ms before emitting
 * `{ name: "escape" }` — sending anything else right after would instead
 * decode as an Alt+key combo. Only use this for a *lone* Esc press.
 */
async function sendEscape(io: Io): Promise<void> {
  io.input.write("\x1b");
  await new Promise((r) => setTimeout(r, 600));
}

await step("filter narrows the list, arrows move, enter opens the verb menu, enter runs a verb", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  assert.match(io.text(), /type to filter/, "initial render shows the filter prompt");
  io.reset();
  await sendKey(io, "mail"); // narrows to the single "Mail Digest" match
  assert.match(io.text(), /Mail Digest/);
  assert.doesNotMatch(io.text(), /Billing Sync/, "filtered-out entries must not render");
  await sendKey(io, "\r"); // enter on the sole match opens its verb menu
  assert.match(io.text(), /Mail Digest/, "verb stage header names the workflow");
  // Plan 59 reordered the menu — three downs from the top row:
  // preflight -> preflight --simulate -> diff -> pull
  for (let i = 0; i < 3; i++) await sendKey(io, "\x1b[B");
  await sendKey(io, "\r"); // enter runs the highlighted verb
  assert.deepEqual(await result, { verb: "pull", id: "bbb222", name: "Mail Digest" });
});

await step("single-select mode (no-ref → picker): enter resolves straight to the fixed verb, no verb menu", async () => {
  const io = makeIo();
  // selectVerb is how `dispatch` runs a no-ref ref verb: pick one workflow, run
  // that verb on it — the verb menu is skipped entirely.
  const result = runPicker(ENTRIES, undefined, { selectVerb: "push", input: io.input, output: io.output });
  await tick();
  await sendKey(io, "mail"); // narrow to "Mail Digest"
  assert.match(io.text(), /Mail Digest/);
  await sendKey(io, "\r"); // enter resolves immediately with the fixed verb
  assert.deepEqual(await result, { verb: "push", id: "bbb222", name: "Mail Digest" });
});

await step("enter on an unpulled workflow pulls directly, skipping the verb menu", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  await sendKey(io, "\x1b[B"); // down
  await sendKey(io, "\x1b[B"); // down -> cursor on "Backup" (unpulled)
  await sendKey(io, "\r");
  assert.deepEqual(await result, { verb: "pull", id: "ccc333", name: "Backup" });
});

await step("esc backs out of the verb menu to the list; esc again quits", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  await sendKey(io, "\r"); // enter on the first entry -> verb stage
  assert.match(io.text(), /Billing Sync/);
  io.reset();
  await sendEscape(io); // esc -> back to the workflow list (not done)
  assert.match(io.text(), /type to filter/, "esc from the verb stage returns to the workflow list");
  await sendEscape(io); // esc again -> quit
  assert.equal(await result, "quit");
});

await step("ctrl-c interrupts from either stage", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  await sendKey(io, "\x03");
  assert.equal(await result, "interrupted");
  // (the CLI maps "interrupted" -> exit code 130 in n8n-decanter.mts's
  // pickerLoop — out of scope for this lib-level test)
});

await step("stdin EOF resolves quit instead of hanging forever", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  io.input.end();
  assert.equal(await result, "quit");
});

await step("raw mode is entered once and restored on exit; cursor hidden then shown", async () => {
  const io = makeIo();
  const rawModeCalls: boolean[] = [];
  Object.assign(io.input, { isRaw: false, setRawMode: (v: boolean) => rawModeCalls.push(v) });
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  assert.deepEqual(rawModeCalls, [true], "raw mode entered on start");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting on the literal ANSI cursor-hide escape.
  assert.match(io.text(), /\x1b\[\?25l/, "cursor hidden on start");
  await sendEscape(io); // quit
  assert.equal(await result, "quit");
  assert.deepEqual(rawModeCalls, [true, false], "raw mode restored on exit");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting on the literal ANSI cursor-show escape.
  assert.match(io.text(), /\x1b\[\?25h/, "cursor shown again on exit");
});

await step("an already-raw input is left raw on exit", async () => {
  const io = makeIo();
  const rawModeCalls: boolean[] = [];
  Object.assign(io.input, { isRaw: true, setRawMode: (v: boolean) => rawModeCalls.push(v) });
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
  await tick();
  assert.deepEqual(rawModeCalls, [true], "still set raw on entry unconditionally");
  io.input.end();
  assert.equal(await result, "quit");
  assert.deepEqual(rawModeCalls, [true], "wasRaw=true must not call setRawMode(false) on exit");
});

await step("raw mode is restored on every exit path (verb run, ctrl-c, EOF)", async () => {
  for (const exit of [
    async (io: Io) => {
      await sendKey(io, "\r");
      await sendKey(io, "\r");
    }, // verb run
    async (io: Io) => sendKey(io, "\x03"), // interrupt
    async (io: Io) => void io.input.end(), // EOF
  ]) {
    const io = makeIo();
    const rawModeCalls: boolean[] = [];
    Object.assign(io.input, { isRaw: false, setRawMode: (v: boolean) => rawModeCalls.push(v) });
    const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output });
    await tick();
    await exit(io);
    await result;
    assert.deepEqual(rawModeCalls, [true, false], `raw mode must be restored: ${JSON.stringify(rawModeCalls)}`);
  }
});

await step("the remote promise appends unpulled rows once it resolves", async () => {
  const io = makeIo();
  let resolveRemote!: (v: Array<{ id: string; name: string }>) => void;
  const remote = new Promise<Array<{ id: string; name: string }>>((r) => {
    resolveRemote = r;
  });
  const result = runPicker(ENTRIES, remote, { input: io.input, output: io.output });
  await tick();
  assert.match(io.text(), /░+/, "skeleton placeholder rows shown while the remote list loads");
  io.reset();
  resolveRemote([{ id: "ddd444", name: "New Remote" }]);
  await tick();
  assert.match(io.text(), /New Remote/, "resolved remote workflow appended");
  assert.match(io.text(), /not pulled/, "appended remote row marked unpulled");
  await sendEscape(io);
  assert.equal(await result, "quit");
});

await step("a rejected remote promise shows the notice instead of appending rows", async () => {
  const io = makeIo();
  const remote = Promise.reject(new Error("network down"));
  const result = runPicker(ENTRIES, remote, { input: io.input, output: io.output });
  await tick();
  await tick(); // extra hop: the .catch handler runs one microtask after the .then chain rejects
  assert.match(io.text(), /remote list unavailable \(network down\)/);
  await sendEscape(io);
  assert.equal(await result, "quit");
});

await step("resume re-opens a workflow's verb menu directly, enter runs the resumed verb", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, {
    input: io.input,
    output: io.output,
    resume: { id: "bbb222", verb: "push" },
  });
  await tick();
  assert.match(io.text(), /Mail Digest/, "resumed straight into the verb menu");
  await sendKey(io, "\r"); // enter runs the already-selected "push"
  assert.deepEqual(await result, { verb: "push", id: "bbb222", name: "Mail Digest" });
});

await step("notice option renders as a dim one-liner", async () => {
  const io = makeIo();
  const result = runPicker(ENTRIES, undefined, { input: io.input, output: io.output, notice: "remote list unavailable (boom)" });
  await tick();
  assert.match(io.text(), /remote list unavailable \(boom\)/);
  await sendEscape(io);
  await result;
});

await step("no-ref `pull` on a fresh setup: remote workflows are merged in and pullable from the picker", async () => {
  const io = makeIo();
  // Mirrors pickOneWorkflow("pull"): nothing pulled locally, so the remote list
  // is merged in (mergeRemote) and shown with selectVerb "pull". A remote-only
  // workflow is pickable and resolves to a pull of its id — no config entry or
  // id-on-the-command-line needed.
  const local: PickerEntry[] = [];
  const entries = mergeRemote(local, [
    { id: "rem777", name: "Remote Only", available: true },
    { id: "gat888", name: "Gated Flow", available: false },
  ]);
  const result = runPicker(entries, undefined, { selectVerb: "pull", input: io.input, output: io.output });
  await tick();
  await sendKey(io, "remote"); // narrow to the available remote-only workflow
  assert.match(io.text(), /Remote Only/);
  await sendKey(io, "\r");
  assert.deepEqual(await result, { verb: "pull", id: "rem777", name: "Remote Only" }, "picking a remote-only workflow pulls it");
});

await step("MCP-unavailable entry: red ⊘ row sorts last; Enter resolves to the enable-mcp sentinel, no verb menu", async () => {
  const io = makeIo();
  const withGated = mergeRemote(ENTRIES, [{ id: "ddd444", name: "Gated Flow", available: false }]);
  assert.equal(withGated[withGated.length - 1].id, "ddd444", "unavailable rows sort last");
  const result = runPicker(withGated, undefined, { input: io.input, output: io.output });
  await tick();
  assert.match(io.text(), /⊘.*Gated Flow/, "shape-based glyph marks the unavailable row");
  await sendKey(io, "gated"); // narrow to the gated entry
  await sendKey(io, "\r");
  // Enter never opens a verb menu for a gated workflow — it resolves to the
  // sentinel, and the CLI (pickerLoop) prints the enable-MCP guidance
  assert.deepEqual(await result, { verb: ENABLE_MCP_VERB, id: "ddd444", name: "Gated Flow" });
});

// ---------- Plan 29: recency order + the force-retry confirm ----------

await step("pick order follows syncedAt: the newest-synced workflow is under the cursor, remotes stay last", async () => {
  const io = makeIo();
  // deliberately NOT alphabetical order, and not the array's own order either
  const local: PickerEntry[] = [
    { id: "aaa111", name: "Billing Sync", pulled: true, available: true, syncedAt: 1_000 },
    { id: "bbb222", name: "Mail Digest", pulled: true, available: true, syncedAt: 3_000 },
    { id: "ccc333", name: "Audit Trail", pulled: true, available: true, syncedAt: 2_000 },
  ];
  // exactly what the CLI's picker builders do: sort the LOCALS, then merge
  const entries = mergeRemote(sortByRecency(local), [{ id: "ddd444", name: "Aaa Remote", available: true }]);
  const result = runPicker(entries, undefined, { input: io.input, output: io.output });
  await tick();
  const rows = io.text().split("\n").filter((l) => /aaa111|bbb222|ccc333|ddd444/.test(l));
  assert.deepEqual(
    rows.map((l) => l.match(/(aaa111|bbb222|ccc333|ddd444)/)![1]),
    ["bbb222", "ccc333", "aaa111", "ddd444"],
    "newest-synced first, then the unpulled remote — never alphabetical",
  );
  assert.match(rows[0], /❯/, "the cursor starts on the most recently synced workflow");
  await sendKey(io, "\r"); // Enter on row 0 opens ITS verb menu
  assert.match(io.text(), /Mail Digest/, "Enter selects the newest-synced workflow");
  await sendKey(io, "\x1b[B"); // preflight -> preflight --simulate
  await sendKey(io, "\r");
  assert.deepEqual(await result, { verb: "preflight --simulate", id: "bbb222", name: "Mail Digest" });
});

await step("force-retry confirm: 'y' forces, bare Enter declines, EOF declines — and it never asks twice", async () => {
  // Same injected-stream trick as runPicker, so the readline half is really
  // exercised (prompt written, line read, interface closed) with no pty.
  const ask = async (typed: string | null): Promise<{ answered: boolean; prompt: string }> => {
    const io = makeIo();
    const pending = confirmForceRetry({ input: io.input, output: io.output });
    await tick();
    if (typed === null) io.input.end(); // EOF: a closed stdin must decline, not hang
    else io.input.write(typed);
    return { answered: await pending, prompt: io.text() };
  };

  const yes = await ask("y\n");
  assert.equal(yes.answered, true);
  assert.match(yes.prompt, /retry with --force and overwrite the remote draft\? \[y\/N\]/, "the copy says draft, not 'remote changes'");
  assert.equal((await ask("YES\n")).answered, true, "case-insensitive, long form");
  assert.equal((await ask("\n")).answered, false, "bare Enter is No — the default");
  assert.equal((await ask("n\n")).answered, false);
  assert.equal((await ask("maybe\n")).answered, false, "anything ambiguous is No");
  assert.equal((await ask(null)).answered, false, "EOF declines instead of wedging");
});

await step("force-retry drives the verb: a drift failure re-runs with force; a compliance failure never asks", async () => {
  const io = makeIo();
  const lines: string[] = [];
  const log = { info: () => {}, ok: () => {}, warn: () => {}, error: (m: string) => lines.push(m) };
  const forces: boolean[] = [];
  // the real ForceableError from the real push guard, answered over real streams
  const drifted = runVerbWithForceRetry(async (force) => {
    forces.push(force);
    if (!force) throw new ForceableError("remote code changed since last sync — pull first (or repeat with --force to overwrite the draft)");
  }, log, () => confirmForceRetry({ input: io.input, output: io.output }));
  await tick();
  io.input.write("y\n");
  assert.equal(await drifted, true, "the forced retry succeeded");
  assert.deepEqual(forces, [false, true], "the same verb re-ran, this time with force");
  assert.match(io.text(), /overwrite the remote draft/);
  assert.equal(lines.length, 1, "the drift error is reported once, not once per attempt");

  // a layout violation is a plain Error: --force cannot fix it, so no offer
  const io2 = makeIo();
  let asked = false;
  const complianceOk = await runVerbWithForceRetry(async () => {
    throw new Error("workflow does not comply with the decanter layout (1 problem)");
  }, log, async () => {
    asked = true;
    return confirmForceRetry({ input: io2.input, output: io2.output });
  });
  assert.equal(complianceOk, false);
  assert.equal(asked, false, "a compliance failure must never offer --force");
  assert.equal(io2.text(), "", "nothing was even printed to the prompt stream");
});

console.log(`\n${passedCount()} interactive checks passed`);
