import { createInterface } from "node:readline/promises";

/**
 * Prompt helper that also works with piped stdin: plain readline/promises
 * drops lines arriving before question() is called and hangs forever on EOF.
 */
export function createPrompt(): { question(prompt: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffered: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter("");
  });
  return {
    async question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      if (buffered.length > 0) return buffered.shift()!;
      if (closed) return "";
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}
