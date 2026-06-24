#!/bin/bash
# Honor inherited PG_DSN so eval runner can point at tier-specific DBs.
export PG_DSN="${PG_DSN:-postgresql://user@localhost:5432/ehrdb}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx src/mcp-sql/index.ts
