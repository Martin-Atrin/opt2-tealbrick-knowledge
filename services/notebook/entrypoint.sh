#!/bin/sh
# Compose the database URL from the private host, then hand over to the upstream entrypoint unchanged.
set -eu
: "${SURREAL_HOST:?required}"
export SURREAL_URL="ws://${SURREAL_HOST}:8000/rpc"
exec /app/scripts/docker-entrypoint.sh "$@"
