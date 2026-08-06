# Plan 75 — `init`'s non-interactive path is present but not discoverable

**Status:** Draft
**Priority:** P2
**Source:** [Plan 62](../done/62-field-test-unrun-conditions.md) task 2, blind
rounds `ftrun-71346` + `ftrun-75467` (2026-08-06) — the first rounds ever staged
with no credentials.
**Snapshot:** 2026-08-06T04:52Z @ 0e39a04
**Model:** Sonnet — the change is wording plus one error path.

`init --host/--token/--api-key` (#144) exists, works, and normalizes a
scheme-less local host to `http://` (#142 — both verified blind). What the rounds
showed is that **nothing points an agent at those flags at the moment it needs
them.**

## What the rounds actually saw

- **Turn 1, cold project.** One command (`list --remote`) produced the correct
  diagnosis — `N8N_HOST must be set (via .env next to decanter.config.json or the
  environment)`. Good message; the agent got there immediately.
- **Then it handed the job back to the human**, recommending bare
  `npx n8n-decanter init` and describing the **interactive** path ("this will
  prompt for your n8n instance's host"). That is the round-1 shape #144 was added
  to eliminate — an agent cannot answer a prompt in a headless session.
- The flags surfaced only in the *next* turn, once the agent held the values, and
  it still needed `init --help` plus two probes (`--token FAKE`, `--mcp-token
  FAKE`) to settle the flag's name.

So the failure is not capability, it is **signposting**: the one message an agent
reliably reads in this situation — the missing-`N8N_HOST` error — says what is
wrong and not how to fix it without a human at a prompt.

## Direction (not yet a task list)

- The `N8N_HOST must be set …` error should name the non-interactive form
  outright, e.g. `n8n-decanter init . --host <host> --token <mcp-token>`. It is
  the highest-leverage single line: every cold agent reads it.
- Consider the same line in `init`'s own "no MCP credentials yet" warning, which
  already fires on a host-only init and today says only "re-run init or set
  `N8N_MCP_TOKEN`".
- `--token` vs `--mcp-token`: two rounds guessed. Either accept both or make
  `--help` unambiguous about which credential each flag carries.

## Non-goals

- Not a change to the interactive flow — it works for humans and is the right
  default on a TTY.
- Not an auto-configuration path. The agent **correctly** refused to write `.env`
  itself; that boundary stays.

## Verification

Re-run S14 (`FIELD_NO_SEED_ENV=1 node test/field-test/run.mts --isolate S14`).
The measurement is turn 1: does the agent reach the non-interactive form while
still deciding what to tell the user, instead of delegating an interactive
prompt to a human?
