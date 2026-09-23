#!/bin/sh
# Starts as root only to make the data directory writable (Docker creates missing bind-mount
# folders as root), then drops to the unprivileged `node` user before running the app.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" ! -user node -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
