# Ideas / Todos

Free-form backlog. `- [ ]` open, `- [x]` done.

- [ ] `bundle: true` for `.ts` node compiles so value imports from `shared/`
      get inlined into the pushed code (today only type-only imports work —
      see the shared-code caveat in PLAN.md).
- [ ] n8n folder hierarchy in the sync layout, if the API exposes folder
      placement (PLAN.md milestone 4 — needs a live instance to verify).
- [ ] Verify against the live instance that PUT preserves tags/pinned data
      on an untouched pull→push round-trip (open question in PLAN.md).
- [x] Git-commit after every successful push of a workflow (committing that
      workflow's folder) to keep versioning. Behind a config flag,
      default: `true`.
