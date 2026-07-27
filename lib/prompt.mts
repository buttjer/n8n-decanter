import { createInterface } from "node:readline/promises";

export interface Prompt {
  question(prompt: string): Promise<string>;
  close(): void;
}

/** The streams a prompt reads and writes — the real stdio by default, or an
 * injected pair in tests (the same trick `runPicker` uses since Plan 22: no
 * pty, no new dependency). */
export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Prompt helper that also works with piped stdin: plain readline/promises
 * drops lines arriving before question() is called and hangs forever on EOF.
 */
export function createPrompt({ input = process.stdin, output = process.stdout }: PromptStreams = {}): Prompt {
  const rl = createInterface({ input, output });
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
      output.write(prompt);
      if (buffered.length > 0) return buffered.shift()!;
      if (closed) return "";
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}
