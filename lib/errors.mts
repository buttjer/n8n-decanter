/**
 * Typed CLI errors — the ones a *caller* has to branch on, not just print.
 */

/**
 * A gate `--force` really can bypass (Plan 29). Today that is exactly one: the
 * per-node code-drift guard in `push` (`assertNoDrift`). The compliance guard
 * throws a plain `Error` on purpose — `--force` does **not** bypass a layout
 * violation, so offering a force-retry there would be a lie.
 *
 * The interactive picker loop keys on this type to offer "retry with --force?"
 * after a failure. Message-string sniffing was the alternative and is brittle;
 * marking the error is explicit, and any future forceable gate opts in by
 * throwing this instead of `Error`.
 */
export class ForceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForceableError";
  }
}
