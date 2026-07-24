#!/bin/sh
# Agent-container entrypoint (Plan 35 container mode). Installs the decanter CLI
# Linux-native from the stage's packed tarball (mounted read-only at /opt/cli.tgz),
# then hands off to CMD (`tail -f /dev/null`) to stay alive for per-turn
# `docker exec`. The host's node_modules are shadowed by a container volume, so
# nothing macOS-native ever runs here.
set -e

# The CLI is normally BAKED into the per-run image (build-time, unfenced) — see
# the container-mode design. This runtime install is only a fallback for an
# unfenced dev run where the tarball is mounted instead of baked; it needs the
# npm registry, so it does nothing (and cannot) inside the egress-fenced round.
if command -v n8n-decanter >/dev/null 2>&1; then
  echo "entrypoint: n8n-decanter (baked) -> $(command -v n8n-decanter)" >&2
elif [ -f /opt/cli.tgz ]; then
  echo "entrypoint: installing decanter CLI from /opt/cli.tgz (unfenced fallback)" >&2
  npm install -g --no-audit --no-fund /opt/cli.tgz >/tmp/cli-install.log 2>&1 \
    || { echo "entrypoint: CLI install FAILED — see /tmp/cli-install.log" >&2; tail -20 /tmp/cli-install.log >&2 || true; }
else
  echo "entrypoint: WARN n8n-decanter not baked and no /opt/cli.tgz — CLI missing" >&2
fi

exec "$@"
