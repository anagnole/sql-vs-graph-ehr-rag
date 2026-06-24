#!/bin/bash
# Honor inherited KUZU_DB_PATH so eval runner can point at tier-specific DBs.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KUZU_DB_PATH="${KUZU_DB_PATH:-$DIR/.brainifai/data/kuzu}"
cd "$DIR"
exec npx tsx src/mcp-cypher/index.ts
