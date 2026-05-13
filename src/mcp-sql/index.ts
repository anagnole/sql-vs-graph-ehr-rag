/**
 * Minimal SQL MCP server for the text-to-SQL eval baseline.
 * Exposes a single `run_sql` tool that executes SELECT queries against PostgreSQL.
 * Reads PG_DSN from environment (set by eval runner per tier).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';

const PG_DSN = process.env.PG_DSN ?? 'postgresql://user@localhost:5432/ehrdb';
const pool = new pg.Pool({ connectionString: PG_DSN });

const DISALLOWED = /\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;

function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows returned)';
  const cols = Object.keys(rows[0]);
  const header = cols.join(' | ');
  const sep = cols.map(() => '---').join(' | ');
  const body = rows.slice(0, 100).map(r => cols.map(c => String(r[c] ?? '')).join(' | '));
  const note = rows.length > 100 ? `\n(showing 100 of ${rows.length} rows)` : '';
  return [header, sep, ...body].join('\n') + note;
}

const server = new Server(
  { name: 'thesis-sql', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_sql',
      description: 'Execute a SELECT query against the EHR PostgreSQL database and return results.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A PostgreSQL SELECT query.' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'run_sql') {
    return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  }

  const query = String((req.params.arguments as Record<string, unknown>)?.query ?? '').trim();

  if (!query.toUpperCase().trimStart().startsWith('SELECT')) {
    return { content: [{ type: 'text', text: 'Error: only SELECT queries are allowed.' }], isError: true };
  }
  if (DISALLOWED.test(query)) {
    return { content: [{ type: 'text', text: 'Error: query contains disallowed keywords.' }], isError: true };
  }

  try {
    const { rows } = await pool.query(query);
    return { content: [{ type: 'text', text: formatRows(rows as Record<string, unknown>[]) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Query failed: ${String(err)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
