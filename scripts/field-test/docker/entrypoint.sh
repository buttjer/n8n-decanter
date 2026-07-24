#!/bin/sh
# Agent-container entrypoint (Plan 35 container mode). Installs the decanter CLI
# Linux-native from the stage's packed tarball (mounted read-only at /opt/cli.tgz),
# then hands off to CMD (`tail -f /dev/null`) to stay alive for per-turn
# `docker exec`. The host's node_modules are shadowed by a container volume, so
# nothing macOS-native ever runs here.
set -e

if [ -f /opt/cli.tgz ]; then
  echo "entrypoint: installing decanter CLI (Linux-native) from /opt/cli.tgz" >&2
  npm install -g --no-audit --no-fund /opt/cli.tgz >/tmp/cli-install.log 2>&1 \
    || { echo "entrypoint: CLI install FAILED — see /tmp/cli-install.log" >&2; tail -20 /tmp/cli-install.log >&2 || true; exit 1; }
  echo "entrypoint: n8n-decanter -> $(command -v n8n-decanter || echo '(not on PATH!)')" >&2
else
  echo "entrypoint: WARN no /opt/cli.tgz mounted — n8n-decanter will be missing" >&2
fi

exec "$@"
