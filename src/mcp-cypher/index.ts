/**
 * Minimal Cypher MCP server for the graph-cypher (text-to-Cypher) eval
 * baseline. Exposes a single `run_cypher` tool that executes read-only
 * Cypher queries against the Kuzu KG.
 *
 * Mirrors `src/mcp-sql/index.ts` so the paradigm comparison is honest:
 * single tool, one query at a time, write-blocked, 100-row cap.
 *
 * Reads KUZU_DB_PATH from environment (set by eval runner per tier).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getConnection, withLock } from '../api/kuzu-client.js';

// Read-only enforcement. Kuzu doesn't have a per-connection read-only mode,
// so we block destructive keywords with a regex, identical in spirit to the
// SQL guard. CALL is allowed (FTS lookups), DROP/CREATE/MERGE etc. are not.
const DISALLOWED = /\b(CREATE|MERGE|DELETE|SET|REMOVE|DETACH|DROP|COPY|INSTALL|LOAD|ATTACH|CHECKPOINT|BEGIN|COMMIT|ROLLBACK)\b/i;

// Convert non-string Kuzu values to strings for table rendering. Kuzu can
// return Date objects (we already have a normalizer in tools.ts; do the same
// transform here so the model sees ISO date strings).
function stringify(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows returned)';
  const cols = Object.keys(rows[0]);
  const header = cols.join(' | ');
  const sep = cols.map(() => '---').join(' | ');
  const body = rows.slice(0, 100).map((r) => cols.map((c) => stringify(r[c])).join(' | '));
  const note = rows.length > 100 ? `\n(showing 100 of ${rows.length} rows)` : '';
  return [header, sep, ...body].join('\n') + note;
}

const server = new Server(
  { name: 'thesis-cypher', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_cypher',
      description: 'Execute a read-only Cypher query against the Kuzu EHR knowledge graph and return results.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A Cypher MATCH/RETURN query (read-only). Forbidden: CREATE, MERGE, DELETE, SET, REMOVE, DROP, COPY, etc.' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'run_cypher') {
    return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  }

  const query = String((req.params.arguments as Record<string, unknown>)?.query ?? '').trim();
  if (!query) {
    return { content: [{ type: 'text', text: 'Error: empty query.' }], isError: true };
  }
  if (DISALLOWED.test(query)) {
    return { content: [{ type: 'text', text: 'Error: query contains disallowed keywords. Only read-only Cypher (MATCH/RETURN/WITH/CALL) is allowed.' }], isError: true };
  }

  try {
    const rows = await withLock(async () => {
      const c = await getConnection();
      const result = await c.query(query);
      return (await result.getAll()) as Record<string, unknown>[];
    });
    return { content: [{ type: 'text', text: formatRows(rows) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Query failed: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
