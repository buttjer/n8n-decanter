# Plan 70 — Document a credential path that works inside an agent sandbox

**Status:** Draft
**Priority:** P2
**Source:** claim 6 of the 2026-07-30 field report ("jeder decanter-Aufruf
brauchte abgeschaltete Sandbox").
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

An agent in a sandboxed harness found itself choosing between "doesn't work" and
"run unsandboxed" for every credentialed verb. A file-free path **already exists
in code** and is documented as a credential *source* — just never as the answer
to a sandbox. The word "sandbox" appears nowhere in `docs/`, `template/` or
`README.md` in the agent-harness sense.

## What's true

- `loadEnv` never overrides an already-set variable
  ([`lib/config.mts:71`](../../lib/config.mts)) and `resolveMcpAuth` reads
  `N8N_MCP_TOKEN` from `process.env` before touching any file
  ([`lib/mcp.mts:118`](../../lib/mcp.mts)) — so harness-injected `N8N_HOST` +
  `N8N_MCP_TOKEN` (+ optional `N8N_API_KEY`) make `.env` unnecessary.
- `.env` is optional; a denied path makes `existsSync` false and degrades
  silently. `init`, `node run`, `completion` dispatch before `loadConfig` and
  never read it. The offline verbs (`preflight --offline`, `list`,
  `scenario check`, `backup list`) work without credentials.
- The failing verbs land on `N8N_HOST must be set (via .env next to
  decanter.config.json or the environment)` — a message that names the workaround
  but doesn't show it.

## The catch, and the open question

**The recommended auth mode has no file-free equivalent.** `init`'s OAuth default
stores credentials in `.decanter-auth.json`, which must be read **and rewritten**
on every use (single-use rotating refresh tokens) — so a fully file-free setup
forces the non-preferred bearer token. Per-verb `--host`/`--token`/`--api-key`
aren't an option either: they're parsed only in the `init` branch.

**Root cause is contested and worth settling before writing the docs:**

- One reading: it's decanter's own scaffold.
  [`template/.claude/settings.json.example:46`](../../template/.claude/settings.json.example)
  denies `Read(.env)` while the same file's allow list pre-approves
  `Bash(n8n-decanter pull)`, `push`, `preflight`, … — the template tells the agent
  to run verbs it forbids reading the config for, and nothing reconciles the two.
  (Claude-Code-only; `opencode.json.example` has no such deny.)
- The other reading: a permission `deny` governs the **Read tool**, not a
  Bash-spawned subprocess, so the actual blocker was network egress to
  `N8N_HOST` — and the template allowlists 30+ commands while saying nothing
  about network.

Both may be true in different harnesses. Either way the deliverable is the same:
a "Running decanter under an agent sandbox" section in
`docs/concepts/configuration.md` (linked from `docs/agents/overview.md` and the
troubleshooting FAQ, keyed on the exact error above), a commented `env` stanza in
the settings example, and the honest note about OAuth needing read+write.

Worth writing down separately: **the guard is already sandbox-immune by
accident.** `mcp connect` reads the same `.env`, but it's spawned by the harness's
MCP client rather than the Bash tool, so a Bash sandbox never applies to it. And
the guard's scope really is narrow by design — it covers n8n's MCP tools, not the
code-sync verbs, which are credentialed CLI calls on purpose. The reporter was
**not** on the wrong surface.

Adjacent but distinct: [Plan 31](../open/31-run-sandbox-boundary.md) is about isolating
`node run`'s own execution, and Plan 30's Task 10 only trims the allow/deny lists.
Neither covers this.
