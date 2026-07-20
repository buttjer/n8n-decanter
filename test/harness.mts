// Shared step runner for the scenario suites (e2e, proxy, smoke): sequential
// steps building one shared, stateful scenario — ok/skip/FAIL lines, overall
// exit via process.exitCode (never process.exit() mid-run — that would skip
// pending `finally` cleanup in the caller).
//
// Two debugging aids (Plan 22 task 1):
// - `STEP=<substring>` (env or `--step=<substring>` argv) runs only steps
//   whose name contains it (case-insensitive); everything else is skipped
//   without executing its body. Lets one step/scenario run in isolation, but
//   this is filtering, not a dependency solver — an isolated step whose setup
//   got filtered out can still fail on missing state.
// - Once a step fails, every step after it is skipped with a
//   `prerequisite "<name>" failed` reason instead of being attempted and
//   cascading into an unrelated, confusing assert — the single shared mock
//   means later steps generally can't succeed once an earlier one didn't.
function readStepFilter(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--step="));
  return process.env.STEP ?? (arg ? arg.slice("--step=".length) : undefined);
}

export function createStepRunner({ onFail }: { onFail?: (err: Error) => void } = {}) {
  const filter = readStepFilter()?.toLowerCase();
  let passed = 0;
  let failedStep: string | undefined;
  async function step(name: string, fn: () => unknown): Promise<void> {
    if (filter !== undefined && !name.toLowerCase().includes(filter)) {
      console.log(`skip ${name} (excluded by STEP=${filter})`);
      return;
    }
    if (failedStep !== undefined) {
      console.log(`skip ${name} (prerequisite "${failedStep}" failed)`);
      return;
    }
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}\n${(err as Error).stack}`);
      failedStep = name;
      process.exitCode = 1;
      onFail?.(err as Error);
    }
  }
  return { step, passedCount: () => passed, hasFailed: () => failedStep !== undefined };
}
