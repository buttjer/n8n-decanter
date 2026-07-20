// Drives the picker's terminal IO loop (lib/picker.mts runPicker) through
// injected PassThrough streams — no real pty, no new dependency (Plan 22
// task 2). The pure state machine already has full unit coverage
// (test/unit/picker.test.mts); this file exercises the part that was
// previously "TTY only, untested by CI": keypress wiring, raw-mode/cursor
// lifecycle, the remote-promise repaint, resume, and EOF/interrupt exits.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runPicker, type PickerEntry } from "../lib/picker.mts";
import { createStepRunner } from "./harness.mts";

const { step, passedCount } = createStepRunner();

const ENTRIES: PickerEntry[] = [
  { id: "aaa111", name: "Billing Sync", pulled: true },
  { id: "bbb222", name: "Mail Digest", pulled: true },
  { id: "ccc333", name: "Backup", pulled: false },
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
  await sendKey(io, "\x1b[B"); // down: status -> pull
  await sendKey(io, "\r"); // enter runs the highlighted verb
  assert.deepEqual(await result, { verb: "pull", id: "bbb222", name: "Mail Digest" });
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
  assert.match(io.text(), /\x1b\[\?25l/, "cursor hidden on start");
  await sendEscape(io); // quit
  assert.equal(await result, "quit");
  assert.deepEqual(rawModeCalls, [true, false], "raw mode restored on exit");
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

console.log(`\n${passedCount()} interactive checks passed`);
