#!/bin/sh
# Composes GBrain's env, then hands over to boot.ts (C69): init + migrations under a crash-safe lock with a status
# /health while they wait, then `gbrain serve --http`. boot.ts is exec'd so it receives every stop signal itself
# (a `sh` parent died on SIGTERM and left upstream's apply-migrations lease behind: qa1, 2026-10-12).
# Model keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY) arrive as env from tb-exec.
set -eu

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

exec node /opt/knowledge/boot.ts
