#!/bin/bash
# Honor inherited PG_DSN so eval runner can point at tier-specific DBs.
export PG_DSN="${PG_DSN:-postgresql://user@localhost:5432/ehrdb}"
cd /Users/anagnole/Projects/ThesisBrainifai
exec npx tsx src/mcp-sql/index.ts
