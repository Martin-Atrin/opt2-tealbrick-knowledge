#!/bin/sh
# Upstream-only provisioning (init, migrations) through GBrain's own trusted CLI, then `gbrain serve --http`.
# Model keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY) arrive as env from tb-exec.
set -eu
gbrain() { bun run "$GBRAIN_ROOT/src/cli.ts" "$@"; }

: "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:?required}"
: "${GBRAIN_DB_HOST:?required}"
: "${GBRAIN_DB_PASSWORD:?required}"
if [ -n "${GBRAIN_REMOTE_PRIVATE_PAGES:-}" ]; then echo "GBRAIN_REMOTE_PRIVATE_PAGES must not be set" >&2; exit 1; fi
export GBRAIN_DATABASE_URL="postgres://postgres:${GBRAIN_DB_PASSWORD}@${GBRAIN_DB_HOST}:5432/gbrain"

case "${KNOWLEDGE_MODEL_PROVIDER:-openai}" in
  google)    chat="google:gemini-2.5-flash";   emb="google:gemini-embedding-2";        dims=768 ;;
  anthropic) chat="anthropic:claude-sonnet-5"; emb="openai:text-embedding-3-small";    dims=1536 ;;
  *)         chat="openai:gpt-6-luna";         emb="openai:text-embedding-3-small";    dims=1536 ;;
esac
export GBRAIN_CHAT_MODEL="$chat" GBRAIN_MODEL="$chat" GBRAIN_EXPANSION_MODEL="$chat"
export GBRAIN_EMBEDDING_MODEL="$emb" GBRAIN_EMBEDDING_DIMENSIONS="$dims"

if [ ! -f "$GBRAIN_HOME/.gbrain/config.json" ]; then
  gbrain init --non-interactive --embedding-model "$emb" --embedding-dimensions "$dims"
fi
gbrain apply-migrations --yes --no-autopilot-install

exec bun run "$GBRAIN_ROOT/src/cli.ts" serve --http --bind "${GBRAIN_BIND:-::}" --port "${PORT:-3131}" \
  --public-url "http://${RAILWAY_PRIVATE_DOMAIN:-localhost}:${PORT:-3131}" --suppress-bootstrap-token --fail-fast
