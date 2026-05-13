#!/bin/bash
export GRAPHSTORE_BACKEND=kuzu
export GRAPHSTORE_ON_DEMAND=true
export GRAPHSTORE_READONLY=true
# Honor inherited KUZU_DB_PATH so the eval runner can point at tier-specific
# DBs (kuzu-200, kuzu-2000, kuzu-20000) without editing this script.
export KUZU_DB_PATH="${KUZU_DB_PATH:-/Users/anagnole/Projects/ThesisBrainifai/.brainifai/data/kuzu}"
export BRAINIFAI_INSTANCE_PATH=/Users/anagnole/Projects/ThesisBrainifai/.brainifai
cd /Users/anagnole/Projects/Brainifai
exec npx tsx src/mcp/index.ts
