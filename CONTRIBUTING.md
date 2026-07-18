# Contributing

Thanks for your interest in n8n-decanter!

## Dev setup

Requires **Node >= 22.18** — the CLI is TypeScript (`.mts`) run natively via
Node's type stripping; there is no build step.

```sh
npm install
npm test              # unit tests + e2e + proxy suite (binds localhost ports)
npm run typecheck     # CLI sources (tsc) + workflow node files
```

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
- `npm test` and `npm run typecheck` must pass (CI enforces both).

## Credits

- **Malte Buttjer** ([buttjer.net](https://www.buttjer.net)) — author &
  maintainer
- **David Friedrich** ([@durchnull](https://github.com/durchnull)) — agentic
  advisor · Healsuite
