// Point git at the repo's tracked hooks (scripts/hooks) so the main-commit
// guard is self-installing. Runs from the `prepare` npm lifecycle script, i.e.
// on every local `npm install` — including in each worktree (see CLAUDE.md).
//
// Idempotent and best-effort: if we're not inside a git work tree (e.g. an
// install from a tarball, where `prepare` wouldn't run anyway), or git isn't
// available, do nothing rather than fail the install.
import { execFileSync } from 'node:child_process';

const DESIRED = 'scripts/hooks';

function git(args: string[], quiet = false): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : 'pipe',
  }).trim();
}

try {
  if (git(['rev-parse', '--is-inside-work-tree'], true) !== 'true') process.exit(0);
} catch {
  // Not a git repo / git missing — nothing to wire up.
  process.exit(0);
}

let current = '';
try {
  current = git(['config', '--get', 'core.hooksPath']);
} catch {
  // Unset — `git config --get` exits non-zero; leave `current` empty.
}

if (current === DESIRED) process.exit(0);

git(['config', 'core.hooksPath', DESIRED]);
console.log(`[setup-hooks] core.hooksPath -> ${DESIRED} (main-commit guard active)`);
