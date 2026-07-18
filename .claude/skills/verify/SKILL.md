# Verify n8n-decanter changes at the CLI surface

Drive the real CLI (`node n8n-decanter.mts <verb>`) as a subprocess against a
throwaway mock n8n API — do not import lib/ modules directly.

## Recipe

- **Mock API**: ~40-line `node:http` server on 127.0.0.1:<port> serving
  `GET/PUT /api/v1/workflows/:id` from a mutable in-memory workflow; log
  requests; add a control route (e.g. `PUT /__remote`) to simulate n8n-UI
  edits mid-session. See the reference driver below for a working fixture
  (connections must reference real node names or the compliance guard blocks
  pushes).
- **Sync dir**: temp dir with `.env` (`N8N_HOST=http://127.0.0.1:<port>`,
  `N8N_API_KEY=test`) + `decanter.config.json`
  (`{"root":"./workflows","workflows":["wf1"],"browserReload":"off"}`), then
  `git init` + local user.name/email — pull/push/watch auto-commit and watch
  refuses its startup pull without git.
- **Bootstrap**: run `node n8n-decanter.mts pull` (cwd = sync dir) to create
  the layout; then drive the verb under test.
- **watch**: spawn it, poll its captured stdout for marker lines
  ("watching workflow", "pushed", conflict text); 200 ms debounce — allow
  ~500 ms after a file write before asserting. Piped stdin = non-TTY paths.
  For TTY-only paths (conflict prompt) wrap in `expect` — macOS
  `script -q /dev/null` does NOT work with piped stdin
  ("tcgetattr … not supported on socket"). Coordinate expect `send`s with
  driver-side file edits via marker files.

## Gotchas

- **`fs.watch` dies under the Bash sandbox** (`EMFILE, watch` from FSEvents)
  and takes the watch process down — run watch-related drives with the
  sandbox disabled; it is an environment artifact, not a code failure.
- The e2e suite's mock (test/e2e.mts) is in-process and not importable;
  building a fresh mock is faster than extracting it.
- CLI output contains ANSI codes even when piped (known, Plan 11) — match
  with regexes, not exact strings.

A known-good full driver (watch structural sync, conflict prompt via expect)
from 2026-07-18 exists in the session scratchpad as `drive.mjs`; recreate
from this recipe if gone.
