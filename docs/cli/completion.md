---
title: completion
description: Shell tab completion for verbs, flags, and workflow names.
order: 16
---

```sh
eval "$(n8n-decanter completion zsh)"    # append to ~/.zshrc (after compinit)
eval "$(n8n-decanter completion bash)"   # append to ~/.bashrc
```

Prints a completion script for your shell. Completion covers verbs, flags,
and the names/ids of pulled workflows; candidates are computed at completion
time, so they stay current without regenerating the script. Offline and
silent when no config is in reach.
