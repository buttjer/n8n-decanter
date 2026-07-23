// Unit tests for the live-mirror orchestrator (lib/mirror.mts, Plan 51 Part A):
// debounce coalescing, the per-workflow overlap guard, and the tracked / no-git
// skip rails — all driven through injected seams (fake clock, stub refresh,
// stub git probe) so no ports, real git, or MCP are needed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createMirror, type MirrorClock } from "../../lib/mirror.mts";
import type { Log } from "../../lib/types.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-mirror-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A pulled workflow folder under `root` so findWorkflowDir(root, id) resolves. */
function pulledRoot(id: string): string {
  const root = mkdtempSync(path.join(TMP, "root-"));
  const dir = path.join(root, "wf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: id, nodes: {} }));
  return root;
}

/** A controllable clock: timers fire only when `fireAll()` is called. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const clock: MirrorClock = {
    setTimer: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h) => {
      if (h !== undefined) timers.delete(h as number);
    },
  };
  return { clock, fireAll: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); }, pending: () => timers.size };
}

function recordingLog(): { log: Log; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return { warns, infos, log: { info: (m) => infos.push(m), ok: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {} } };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe("createMirror", () => {
  it("debounces a burst of schedules into a single refresh", async () => {
    const root = pulledRoot("wf-a");
    const calls: string[] = [];
    const { clock } = fakeClock();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: [], commitOnPull: false, liveMirror: true,
      log: recordingLog().log, clock, refresh: async (id) => void calls.push(id), isGitRepo: async () => true,
    });
    mirror.schedule("wf-a");
    mirror.schedule("wf-a");
    mirror.schedule("wf-a");
    await mirror.drain();
    assert.deepEqual(calls, ["wf-a"], "three schedules collapse to one refresh");
  });

  it("liveMirror:false makes schedule a no-op", async () => {
    const root = pulledRoot("wf-a");
    const calls: string[] = [];
    const { clock, pending } = fakeClock();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: ["wf-a"], commitOnPull: false, liveMirror: false,
      log: recordingLog().log, clock, refresh: async (id) => void calls.push(id), isGitRepo: async () => true,
    });
    mirror.schedule("wf-a");
    assert.equal(pending(), 0, "no timer armed when disabled");
    await mirror.drain();
    assert.deepEqual(calls, []);
  });

  it("skips an untracked id and warns exactly once", async () => {
    const root = pulledRoot("wf-a");
    const calls: string[] = [];
    const { clock, pending } = fakeClock();
    const rec = recordingLog();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: ["wf-a"], commitOnPull: false, liveMirror: true,
      log: rec.log, clock, refresh: async (id) => void calls.push(id), isGitRepo: async () => true,
    });
    mirror.schedule("wf-unknown");
    mirror.schedule("wf-unknown");
    assert.equal(pending(), 0, "no timer for an untracked id");
    await mirror.drain();
    assert.deepEqual(calls, []);
    assert.equal(rec.warns.filter((w) => w.includes("wf-unknown")).length, 1, "one hint, not per-op");
    assert.match(rec.warns[0], /pull wf-unknown/);
  });

  it("tracks via config.workflows AND via a locally-pulled folder", async () => {
    const root = pulledRoot("dir-id"); // pulled folder, NOT in config.workflows
    const calls: string[] = [];
    const { clock } = fakeClock();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: ["cfg-id"], commitOnPull: false, liveMirror: true,
      log: recordingLog().log, clock, refresh: async (id) => void calls.push(id), isGitRepo: async () => true,
    });
    mirror.schedule("cfg-id"); // tracked by config
    mirror.schedule("dir-id"); // tracked by local folder
    await mirror.drain();
    assert.deepEqual(calls.sort(), ["cfg-id", "dir-id"]);
  });

  it("skips the pull with no git and warns exactly once (git is the safety net)", async () => {
    const root = pulledRoot("wf-a");
    const calls: string[] = [];
    const { clock } = fakeClock();
    const rec = recordingLog();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: ["wf-a"], commitOnPull: false, liveMirror: true,
      log: rec.log, clock, refresh: async (id) => void calls.push(id), isGitRepo: async () => false,
    });
    mirror.schedule("wf-a");
    await mirror.drain();
    mirror.schedule("wf-a");
    await mirror.drain();
    assert.deepEqual(calls, [], "no refresh without git");
    assert.equal(rec.warns.filter((w) => w.includes("no git")).length, 1, "warned once");
  });

  it("never runs two refreshes for one workflow at once — a mid-pull burst re-runs once", async () => {
    const root = pulledRoot("wf-a");
    const started: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const gates = [deferred(), deferred()];
    const { clock, fireAll } = fakeClock();
    const mirror = createMirror({
      mcp: {} as never, root, workflows: ["wf-a"], commitOnPull: false, liveMirror: true,
      log: recordingLog().log, clock, isGitRepo: async () => true,
      refresh: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        started.push("wf-a");
        await gates[started.length - 1].promise;
        concurrent--;
      },
    });

    mirror.schedule("wf-a");
    fireAll();
    await flush();
    assert.equal(started.length, 1, "first refresh in flight");

    // a burst arrives while the first pull is still running
    mirror.schedule("wf-a");
    fireAll();
    await flush();
    assert.equal(started.length, 1, "no second refresh started concurrently (queued)");

    gates[0].resolve(); // first pull finishes → queued re-run fires
    await flush();
    assert.equal(started.length, 2, "the queued burst re-ran exactly once");
    gates[1].resolve();
    await mirror.drain();
    assert.equal(maxConcurrent, 1, "the two refreshes never overlapped");
  });
});
