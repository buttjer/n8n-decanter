// Shared step runner for the scenario suites (e2e, proxy): sequential steps,
// ok/FAIL lines, exit 1 on the first failure after the suite's cleanup hook.
export function createStepRunner({ onFail }: { onFail?: (err: Error) => void } = {}) {
  let passed = 0;
  async function step(name: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}\n${(err as Error).stack}`);
      onFail?.(err as Error);
      process.exit(1);
    }
  }
  return { step, passedCount: () => passed };
}
