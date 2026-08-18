# Plan 83 — "restart your agent" is the wrong answer when the sync dir is nested

**Status:** Draft
**Priority:** P2
**Source:** Field-test round `ftrun-468939` (S16, the first valid round under the
nested condition — [Plan 82](../done/82-nested-field-test-condition.md)); the
layout comes from [Plan 81](../done/81-nested-syncdir-agent-wiring.md).
**Snapshot:** 2026-08-18T15:30Z @ 977d84e

When an agent finds the `n8n-instance` MCP tools missing, every surface we own
tells it the same thing: the wiring loads at session **startup**, so restart.
In a nested sync dir that advice is a dead end — no restart will ever produce
those tools, because the wiring sits below where the agent was started. A blind
agent reached exactly that wrong conclusion, quoting our own `AGENTS.md`.

## What happened

Asked afterwards how it got oriented, the round's agent volunteered (unprompted,
from memory):

> the `n8n-instance` MCP server that `.mcp.json` declares … was *not* actually
> present in my toolset … That's a known failure mode AGENTS.md itself calls
> out: those MCP servers … are only wired up at session startup, so if `init`
> had been run in some earlier session rather than this one, this session just
> doesn't have them live.

Reasonable, taught by us — and **wrong for the layout it was standing in**. It
was saved only by not needing the tools: it used the CLI and shipped the change.
An agent that *did* need them would restart, find nothing changed, and have no
next idea. The advice sends it in a circle.

## Why the current wording cannot get this right

The restart explanation was written for the common case ([Plan 75] and the
`init` restart reminder): `init` runs *inside* the session it configures, so that
session is genuinely unconfigured until it restarts. That is true and worth
keeping. It is simply not exhaustive: "tools declared in `.mcp.json` but absent"
has a **second** cause — the agent was started somewhere that never reads that
file — and only the second one is unfixable by restarting.

## Scope

Add the second cause wherever the first is taught, with the discriminator a
reader can actually apply (*is the file you are looking at below the directory
you started in?*) and the two working answers (start the agent in the sync dir;
or wire the root, `--dir` / `N8N_DECANTER_DIR`).

- `template/AGENTS.md.example` — the routing/restart cue an agent reads.
- `template/CLAUDE.md.example` if it repeats the claim.
- [`docs/agents/overview.md`](../../docs/agents/overview.md) — beside the
  load-scope table, which already states the mechanism.
- [`docs/cli/init.md`](../../docs/cli/init.md) and
  [`docs/faq/troubleshooting.md`](../../docs/faq/troubleshooting.md) — the
  "tools are missing" entry.
- `lib/init.mts`'s restart line: it fires when the wiring is newly scaffolded and
  already knows whether the target is nested (Plan 81 added the detection), so it
  can say *which* of the two situations the reader is in instead of defaulting to
  "restart".

## Non-goals

- Changing how any agent discovers `.mcp.json` — the constraint is theirs; we
  document it.
- Re-litigating the restart advice for the flat case, where it is correct.

## Verification

Grep for the restart claim across `template/`, `/docs` and `lib/` and confirm
every occurrence either names the nested possibility or is provably about the
flat case. The cheap live check is the S16 round itself: an agent that hits
missing tools in the nested layout should be able to reach a working route from
what it reads, without a restart that cannot help.
