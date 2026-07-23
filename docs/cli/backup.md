---
title: backup
description: Git-native, versioned, redeployable disaster-recovery backups of a workflow.
order: 18
---

```sh
n8n-decanter backup create <workflow>                           # instance -> git
n8n-decanter backup restore <workflow> [--version <id> | --at <ts>]   # git -> a NEW workflow
n8n-decanter backup list <workflow>                             # retained backups (offline)
```

A **git-native, redeployable disaster-recovery store** for a workflow. Both
n8n's MCP server and its REST API only expose the current **draft tip**, and
MCP's read is sanitized (no credential refs, no `pinData`/`staticData`/
`description`) — so **git is the only place a redeployable version history can
live**. `backup` captures the workflow's full REST export into a committed
`backups/` folder and can redeploy it onto a rebuilt or fresh n8n. It's a
second version+recovery layer *outside* n8n, one that survives the instance
being lost.

This is **disaster recovery, not sync**: `restore` creates a *new* workflow, it
never reconciles an existing one. Workflow structure stays n8n's to own (the
daily loop is [pull](/docs/cli/pull/) / [push](/docs/cli/push/) over MCP).

Uses the n8n **public API key** (`N8N_API_KEY`) — the full-fidelity workflow
`GET`/`POST` is a surface MCP can't serve. Without a key, `create`/`restore`
fail with guidance (`list` is offline and needs none).

## The store

```txt
workflows/order-sync/
  backups/
    2026-07-23T14-30-00Z.8dd14331.json     # each `backup create` appends one
    2026-07-24T09-15-00Z.2f3335b8.json
```

Each file is the full REST export (`GET /workflows/:id`) with:

- **`jsCode` kept as a `//@file:` placeholder** — the Code-node source is never
  duplicated; `restore` re-inlines it from the folder's `code/` files (`.ts`
  compiled).
- **`pinData` + `staticData` stripped** — runtime state, churny and
  semi-sensitive.
- **credential refs + `description` kept** — the "which credential" rebind hint
  for a restore onto another instance.

The filename is a filesystem-safe timestamp plus the short `versionId`; the full
`versionId` lives inside.

## `backup create`

Reads the current draft over REST and writes a new timestamped file. It

- **skips when `versionId` is unchanged** since the latest backup (no redundant
  identical copies), and
- **rolling-prunes** the working set to `backupLimit` (config, default **20**;
  `0` keeps all — git still holds the full history regardless).

The file is a **full export** — it carries credential refs and any secrets
embedded in node parameters — so it is **not auto-committed**. `create` prints a
warning; review the file and `git add` it deliberately. (The store is *not*
self-gitignored, unlike [`executions/`](/docs/cli/executions/) — committing it
is the whole point.)

## `backup restore`

Selects a backup — the **latest** by default, or `--version <id>` / `--at <ts>`,
or a chooser on a terminal — assembles the full JSON (structure + credential
refs, each Code node's `jsCode` re-inlined from its `code/` file), runs it
through the compliance guard, and REST-`POST`s it as a **new workflow**:

- a **new workflow id**, but **node ids are preserved** (the REST `GET → POST`
  round-trip is lossless), and
- it lands **unpublished** — `restore` prints the credential-rebind hints (the
  refs point at the *source* instance; recreate/rebind them on the target) and
  the editor URL; **publish** is your next step.

| Flag | Meaning |
| --- | --- |
| `--version <id>` | Restore the backup with this `versionId` (full or short) |
| `--at <ts>` | Restore the backup with this timestamp |

## `backup list`

Offline. Prints the retained backups — timestamp · `versionId` · node count.
`--json` emits the same as a machine-readable array.

## Not a backup of everything

`backup` captures one workflow's structure + Code. It does **not** back up
credentials themselves (only the refs), data tables, or execution history —
recreate credentials on the target and rebind them after a restore.
