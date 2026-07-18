# n8n-decanter — agent guide (CLI repo)

Tool-agnostic guidance for coding agents working **on the n8n-decanter CLI
itself** (not on a synced workflow dir — that's the template's `AGENTS.md`).
Codex and opencode read this file natively; Claude Code additionally reads
`CLAUDE.md`, which holds the project rules (response style, PLAN.md contract,
changelog/backlog duties, commands, architecture). Treat `CLAUDE.md` as
authoritative for those rules regardless of which agent you are; this file
carries the shared, tool-agnostic recipes.

## Verifying changes at the CLI surface

Drive the real CLI (`node n8n-decanter.mts <verb>`) as a subprocess against a
throwaway mock n8n API — do not import `lib/` modules directly and call
functions; the CLI process is the surface users touch.

### Recipe

- **Mock API**: ~40-line `node:http` server on `127.0.0.1:<port>` serving
  `GET/PUT /api/v1/workflows/:id` from a mutable in-memory workflow; log
  requests; add a control route (e.g. `PUT /__remote`) to simulate n8n-UI
  edits mid-session. Fixture gotcha: `connections` must reference real node
  names or the compliance guard blocks pushes.
- **Sync dir**: temp dir with `.env` (`N8N_HOST=http://127.0.0.1:<port>`,
  `N8N_API_KEY=test`) + `decanter.config.json`
  (`{"root":"./workflows","workflows":["wf1"],"browserReload":"off"}`), then
  `git init` + local `user.name`/`user.email` — pull/push/watch auto-commit,
  and watch refuses its startup pull without git.
- **Bootstrap**: run `node n8n-decanter.mts pull` (cwd = sync dir) to create
  the layout; then drive the verb under test.
- **watch**: spawn it, poll its captured stdout for marker lines
  ("watching workflow", "pushed", conflict text); 200 ms debounce — allow
  ~500 ms after a file write before asserting. Piped stdin exercises the
  non-TTY paths. For TTY-only paths (the structural-conflict prompt) wrap
  the CLI in `expect` — macOS `script -q /dev/null` does NOT work with piped
  stdin ("tcgetattr … not supported on socket"). Coordinate `expect` sends
  with driver-side file edits via marker files.

### Gotchas

- **`fs.watch` dies under sandboxed shells** (`EMFILE, watch` from FSEvents)
  and takes the watch process down — run watch drives unsandboxed; it is an
  environment artifact, not a code failure.
- The e2e suite's mock (`test/e2e.mts`) is in-process and not importable;
  building a fresh mock is faster than extracting it.
- CLI output contains ANSI codes even when piped (known, Plan 11) — match
  with regexes, not exact strings.
