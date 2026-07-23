# Plans — conventions

The backlog lives here as **one file per item**, sorted into four directories by
status. This file is the only index; `ls plans/*/` is the table of contents.
(The old flat `STATUS-NN-…md` layout plus `README.md`/`BACKLOG.md` was retired
2026-07-23 in favour of these dirs.)

## Directories = status

- **`draft/`** — short notes, backlog-grade: the idea, why, rough scope. A draft
  is the successor to the old `BACKLOG.md` grab-bag entry — keep it terse. It
  graduates into a fuller plan (moved to `open/`, fleshed out) when someone
  picks it up.
- **`open/`** — plans ready to (or in progress being) worked. **In-progress work
  lives here too** — the `**Status:**` header line distinguishes `Not started`
  from `In progress`.
- **`done/`** — fully implemented, tested, and documented.
- **`blocked/`** — designed but can't proceed until an external dependency clears
  (e.g. a licensed instance, an upstream API).

A status change is a **file move** between these dirs — update inbound links
(they're relative paths, e.g. `../done/32-mcp-native-code-layer.md`). Nothing
else changes; the number and slug stay put.

## Filenames & numbers

- **`NN-slug.md`** — `NN` is the plan's stable id and rough running order (how
  it's referenced, "Plan 32"); `slug` is a kebab title. The directory carries
  the status, so there is **no status prefix** in the name.
- `NN` is **not** priority — priority is a header field, so a low-numbered plan
  can be P2 and vice-versa.
- **Numbers are never reused.** A new item takes the **next free number** — one
  past the highest across **every** status dir (a number may live in any of
  `draft/`/`open/`/`done/`/`blocked/`). Check them all before picking, never just
  one dir: `ls plans/{draft,open,done,blocked}/ | grep -oE '^[0-9]+' | sort -n | tail`.
- **Merging:** two plans/drafts may merge **in favour of the lower number**; the
  freed number is simply retired and may stay unused forever. Gaps in the
  sequence are expected and fine.

## Plan shape

- **Header block** (before the first `##`, one bold field per line):
  - `# Plan N — Title`
  - `**Status:**` `Draft` / `Not started` / `In progress` / `Done`.
  - `**Priority:**` `P1` (do first: small, clearly-right, high-value, offline) /
    `P2` (valuable, more scope/design) / `P3` (deferred). May split per task.
  - `**Source:**` the backlog/draft origin and any `PLAN.md` refs this closes,
    so nothing is orphaned.
  - `**Theme:**` *(optional)* one-line what-and-why.
  - `**Model:**` *(optional, advisory)* the Claude model best suited to
    implement it — Opus for high-reasoning/novel design, Sonnet for
    well-specified breadth, Haiku for mechanical work. A hint, not a rule.
  - `**Class:**` *(optional)* — `Distinctive feature` for a capability that
    differentiates decanter from n8n itself and from generic "n8n-as-code"
    git-sync. These are tracked as their own class, kept visible.
- **Sections** (fuller plans; drafts stay short and skip most of these):
  `## Why`, `## Source`, `## Tasks` (numbered, grounded in real files),
  `## Acceptance / verification`, `## Notes` (CHANGELOG/PLAN.md implications,
  decisions, deferrals). Optional: `## Design decision`, `## Non-goals`,
  `## Rollout`.
- **Cross-link** related plans by relative path.

## Not a design channel

These are scoped work plans, not design changes — anything that alters the data
model or flows in `PLAN.md` must be raised with the user first (see the root
`AGENTS.md`). `DECISIONS-NEEDED.md` (here at the plans root) holds open questions
only the maintainer can settle.
