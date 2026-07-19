// Unit tests for the picker's pure state machine (lib/picker.mts, Plan 19).
// The terminal IO half is TTY-only and verified manually — everything that
// decides *what happens* on a key lives here and is covered.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PICKER_VERBS,
  filterEntries,
  initialState,
  mergeRemote,
  reduceKey,
  visibleWindow,
  type PickerEntry,
  type PickerState,
  type PickerStep,
} from "../../lib/picker.mts";

const entries: PickerEntry[] = [
  { id: "aaa111", name: "Billing Sync", pulled: true },
  { id: "bbb222", name: "Mail Digest", pulled: true },
  { id: "ccc333", name: "Backup", pulled: false },
];

const state = (over: Partial<PickerState> = {}): PickerState => ({ ...initialState(entries, false), ...over });

const next = (step: PickerStep): PickerState => {
  assert.equal(step.done, false);
  return (step as { done: false; state: PickerState }).state;
};

describe("filterEntries", () => {
  it("matches name and id case-insensitively, empty query matches all", () => {
    assert.equal(filterEntries(entries, "").length, 3);
    assert.deepEqual(filterEntries(entries, "mail").map((e) => e.id), ["bbb222"]);
    assert.deepEqual(filterEntries(entries, "BBB2").map((e) => e.id), ["bbb222"]);
    assert.deepEqual(filterEntries(entries, "b").map((e) => e.id), ["aaa111", "bbb222", "ccc333"]);
    assert.equal(filterEntries(entries, "nope").length, 0);
  });
});

describe("mergeRemote", () => {
  it("appends only unknown ids, marked unpulled", () => {
    const merged = mergeRemote(entries, [
      { id: "aaa111", name: "Billing Sync" },
      { id: "ddd444", name: "New Remote" },
    ]);
    assert.equal(merged.length, 4);
    assert.deepEqual(merged[3], { id: "ddd444", name: "New Remote", pulled: false });
  });
});

describe("visibleWindow", () => {
  it("shows everything when it fits", () => {
    assert.deepEqual(visibleWindow(3, 0, 10), { start: 0, end: 3 });
  });
  it("scrolls to keep the cursor visible and clamps at the ends", () => {
    assert.deepEqual(visibleWindow(20, 0, 10), { start: 0, end: 10 });
    assert.deepEqual(visibleWindow(20, 10, 10), { start: 5, end: 15 });
    assert.deepEqual(visibleWindow(20, 19, 10), { start: 10, end: 20 });
  });
});

describe("workflow stage", () => {
  it("typing appends to the query and resets the cursor", () => {
    let s = state({ cursor: 2 });
    s = next(reduceKey(s, { name: "m", sequence: "m" }));
    s = next(reduceKey(s, { name: "a", sequence: "a" }));
    assert.equal(s.query, "ma");
    assert.equal(s.cursor, 0);
  });

  it("backspace shortens the query", () => {
    const s = next(reduceKey(state({ query: "ma" }), { name: "backspace" }));
    assert.equal(s.query, "m");
  });

  it("arrows clamp to the filtered list", () => {
    let s = next(reduceKey(state(), { name: "up" }));
    assert.equal(s.cursor, 0);
    s = next(reduceKey(s, { name: "down" }));
    s = next(reduceKey(s, { name: "down" }));
    s = next(reduceKey(s, { name: "down" }));
    assert.equal(s.cursor, 2);
  });

  it("enter on a pulled workflow opens the verb stage", () => {
    const s = next(reduceKey(state(), { name: "return" }));
    assert.equal(s.stage, "verb");
    assert.equal(s.selected?.id, "aaa111");
    assert.equal(s.verbCursor, 0);
  });

  it("enter on an unpulled workflow pulls directly", () => {
    const step = reduceKey(state({ cursor: 2 }), { name: "return" });
    assert.deepEqual(step, { done: true, result: { verb: "pull", id: "ccc333", name: "Backup" } });
  });

  it("enter selects within the filtered list, not the full one", () => {
    const step = reduceKey(state({ query: "backup" }), { name: "return" });
    assert.deepEqual(step, { done: true, result: { verb: "pull", id: "ccc333", name: "Backup" } });
  });

  it("enter with no match is a no-op", () => {
    const step = reduceKey(state({ query: "nope" }), { name: "return" });
    assert.equal(step.done, false);
  });

  it("esc quits, ctrl-c interrupts", () => {
    assert.deepEqual(reduceKey(state(), { name: "escape" }), { done: true, result: "quit" });
    assert.deepEqual(reduceKey(state(), { name: "c", ctrl: true, sequence: "\x03" }), { done: true, result: "interrupted" });
  });
});

describe("verb stage", () => {
  const verbState = () => next(reduceKey(state(), { name: "return" }));

  it("arrows move within the verb list and clamp", () => {
    let s = next(reduceKey(verbState(), { name: "down" }));
    assert.equal(PICKER_VERBS[s.verbCursor], "pull");
    for (let i = 0; i < 10; i++) s = next(reduceKey(s, { name: "down" }));
    assert.equal(PICKER_VERBS[s.verbCursor], "check");
  });

  it("a letter cycles through verbs starting with it", () => {
    let s = next(reduceKey(verbState(), { name: "p", sequence: "p" }));
    assert.equal(PICKER_VERBS[s.verbCursor], "pull");
    s = next(reduceKey(s, { name: "p", sequence: "p" }));
    assert.equal(PICKER_VERBS[s.verbCursor], "push");
    s = next(reduceKey(s, { name: "p", sequence: "p" }));
    assert.equal(PICKER_VERBS[s.verbCursor], "pull");
  });

  it("enter runs the highlighted verb on the selected workflow", () => {
    const s = next(reduceKey(verbState(), { name: "w", sequence: "w" }));
    assert.deepEqual(reduceKey(s, { name: "return" }), { done: true, result: { verb: "watch", id: "aaa111", name: "Billing Sync" } });
  });

  it("esc returns to the workflow stage", () => {
    const s = next(reduceKey(verbState(), { name: "escape" }));
    assert.equal(s.stage, "workflow");
    assert.equal(s.selected, undefined);
  });

  it("ctrl-c interrupts here too", () => {
    assert.deepEqual(reduceKey(verbState(), { name: "c", ctrl: true, sequence: "\x03" }), { done: true, result: "interrupted" });
  });

  it("enter carries the workflow name for the trace line", () => {
    assert.deepEqual(reduceKey(verbState(), { name: "return" }), {
      done: true,
      result: { verb: "status", id: "aaa111", name: "Billing Sync" },
    });
  });
});

describe("resume (picker loop re-entry)", () => {
  it("re-opens the verb menu of a pulled workflow, cursor on the last verb", () => {
    const s = initialState(entries, false, { resume: { id: "bbb222", verb: "push" } });
    assert.equal(s.stage, "verb");
    assert.equal(s.selected?.id, "bbb222");
    assert.equal(PICKER_VERBS[s.verbCursor], "push");
  });

  it("falls back to the list with the cursor on a still-unpulled workflow", () => {
    const s = initialState(entries, false, { resume: { id: "ccc333", verb: "pull" } });
    assert.equal(s.stage, "workflow");
    assert.equal(s.cursor, 2);
  });

  it("ignores an unknown resume id and an unknown verb", () => {
    const gone = initialState(entries, false, { resume: { id: "zzz999", verb: "status" } });
    assert.equal(gone.stage, "workflow");
    assert.equal(gone.cursor, 0);
    const oddVerb = initialState(entries, false, { resume: { id: "aaa111", verb: "list" } });
    assert.equal(oddVerb.stage, "verb");
    assert.equal(oddVerb.verbCursor, 0);
  });

  it("passes the remote-failure notice through", () => {
    const s = initialState(entries, false, { notice: "remote list unavailable (boom)" });
    assert.equal(s.notice, "remote list unavailable (boom)");
  });
});
