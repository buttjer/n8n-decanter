---
title: Type checking
description: How function-body node files get type-checked, and why editors show a false TS1108.
order: 6
---

n8n Code-node source is a *function body* — top-level `return`/`await` — which
plain `tsc` rejects in `.ts` files (TS1108). The typecheck behind
[check](/docs/cli/check/) and the [push gate](/docs/concepts/push-gates/)
therefore wraps node files in an `async function` **in memory** and maps
diagnostics back to real line numbers. A `.decanter.json` next to a file — or
in the parent of its `code/` dir — is what marks it as a node file.

Files on disk stay verbatim: never "fix" a node file by wrapping it in a
function or stripping its top-level return.

## Editor false positives

The IDE's own tsserver doesn't apply the wrapper, so editors show a spurious
TS1108/TS1375/TS1378 on top-level `return`/`await` in node files. Ignore it —
`n8n-decanter check` is authoritative.

Scaffolded sync dirs ship a TypeScript language-service plugin
(`decanter-ts-plugin/`) that suppresses exactly these three codes on node
files (all other diagnostics stay live). It activates once tsserver runs the
workspace TypeScript: `npm install`, then in VS Code accept *Use Workspace
Version* (offered via `.vscode/settings.json`); JetBrains uses the project
TypeScript by default.

## Two tsconfigs in a sync dir

The scaffolded `tsconfig.json` belongs to the workflow node files (with
`n8n-globals.d.ts` typing `$input`, `$('…')`, `DateTime`, …). Its name is
load-bearing — the typecheck discovers it by name, searching upward. Keep it
where the config is.
