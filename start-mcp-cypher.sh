#!/bin/bash
# Honor inherited KUZU_DB_PATH so eval runner can point at tier-specific DBs.
export KUZU_DB_PATH="${KUZU_DB_PATH:-/Users/anagnole/Projects/ThesisBrainifai/.brainifai/data/kuzu}"
cd /Users/anagnole/Projects/ThesisBrainifai
exec npx tsx src/mcp-cypher/index.ts
