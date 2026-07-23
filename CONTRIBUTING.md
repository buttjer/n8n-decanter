# Contributing

Thanks for your interest in n8n-decanter!

## Dev setup

Requires **Node >= 22.18** — the CLI is TypeScript (`.mts`) run natively via
Node's type stripping; there is no build step.

```sh
npm install
npm test              # unit tests + e2e suite (binds localhost ports)
npm run lint          # Biome linter (biome.json); CI gates on it
npm run typecheck     # CLI sources (tsc) + workflow node files
npm run test:smoke    # OPTIONAL: integration smoke against a real n8n in
                      #   Docker (pinned image; needs a running daemon).
                      #   SMOKE_N8N_TAG=n8nio/n8n:<tag> tests another version,
                      #   SMOKE_KEEP=1 keeps the container after a failure.
```

The smoke suite is the only place that proves behavior against a *real* n8n
(bundled-node execution, PUT normalization, publish semantics); run it when
touching push/pull/compile, and when bumping the pinned n8n tag.

## Ground rules

- **[PLAN.md](PLAN.md) is the design source of truth.** Changes to the data
  model, sync flows, or guard rules start as a discussion there, not as a PR.
- **[CHANGELOG.md](CHANGELOG.md)** follows Keep a Changelog: every
  user-facing change gets an entry under `[Unreleased]` in the same PR.
- Only **erasable TS syntax** (no enums, namespaces, or parameter
  properties); relative imports name the real `.mts` file.
- The e2e suite ([test/e2e.mts](test/e2e.mts)) is one sequential, stateful
  scenario — steps can't run in isolation. Fast unit tests live in
  [test/unit/](test/unit/).

## Pull requests

- Keep them focused; include tests for behavior changes.
- `npm run lint`, `npm run typecheck`, and `npm test` must pass (CI enforces all three).

## Credits

- **Malte Buttjer** ([buttjer.net](https://www.buttjer.net)) — author &
  maintainer
- **David Friedrich** ([@durchnull](https://github.com/durchnull)) — agentic
  advisor · Healsuite
