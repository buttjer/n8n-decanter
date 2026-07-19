# Decisions needed — open questions for Malte

Items an agent cannot settle alone: they need your preference, your
infrastructure, or your go-ahead. Each entry says what's proposed, what the
options cost, and what happens if you do nothing. Delete entries once
decided (move the outcome into the relevant plan).

## Drop or keep `completion zsh|bash` once the picker lands (Plan 19)

- **Proposed:** [Plan 19](OPEN-19-interactive-workflow-picker.md) makes bare
  `n8n-decanter` an interactive picker — the primary discovery surface. Open
  question: remove the `completion` verb (your instinct) or keep it demoted.
- **Cost of keeping:** ~40 lines + one usage line, zero runtime cost; still
  serves mid-command tab completion of verbs/flags/names for shell users.
- **Cost of removing:** **Breaking:** — anyone with `eval "$(n8n-decanter
  completion zsh)"` in their rc file gets an error on every new shell;
  0.x semver → minor bump.
- **If you do nothing:** completion stays, demoted below the picker in
  README/usage.

*Resolved so far: Docker smoke suite → approved
dev-only, graduated to [Plan 15](DONE-15-docker-n8n-smoke-suite.md);
bundle compression/minification → dropped (recorded in
[Plan 14](DONE-14-bundle-shared-code-into-ts-pushes.md) Notes);
dist/template release blocker → fixed, acknowledged (re-verify step in
[Plan 13](OPEN-13-open-source-release.md)).*
