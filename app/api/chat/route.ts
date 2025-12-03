import {
  streamText,
  UIMessage,
  convertToModelMessages,
  tool as createTool,
} from 'ai';
import { z } from 'zod';
import { executeSupabaseSql, getSupabaseSchema } from '@/lib/supabase-mcp';
// Allow streaming responses up to 30 seconds
export const maxDuration = 30;
export async function POST(req: Request) {
  const {
    messages,
    model,
  }: { 
    messages: UIMessage[]; 
    model: string; 
  } = await req.json();

  const supabaseSchemaTool = createTool({
    description:
      'Inspect the Supabase Postgres schema by listing tables and columns via the MCP server. Use this before writing SQL if you need to understand available data.',
    inputSchema: z.object({}).describe('No input required.'),
    execute: async (_input) => {
      const snapshot = await getSupabaseSchema();
      return {
        summary: snapshot.summary,
        rows: snapshot.rows,
      };
    },
  });

  const supabaseSqlTool = createTool({
    description:
      'Run safe, read-only SQL queries on the Supabase Postgres database via the MCP server. Use this for product or analytics questions that require real data.',
    inputSchema: z.object({
      sql: z
        .string()
        .describe('Read-only SQL (SELECT/WITH) to run against Supabase.'),
    }),
    execute: async ({ sql }) => {
      const result = await executeSupabaseSql(sql);

      return {
        sql: result.sql,
        rows: result.rows,
      };
    },
  });

  const tools = {
    supabaseSchema: supabaseSchemaTool,
    supabaseSql: supabaseSqlTool,
  };

  const result = streamText({
    model: model,
    messages: convertToModelMessages(messages),
    tools,
    stopWhen: [], // Allow multiple tool round-trips instead of stopping after the first tool result.
    system: [
      'You are a helpful assistant that can answer questions and help with tasks.',
      'When users need information about the Supabase database, call supabaseSchema to inspect tables/columns and supabaseSql to execute read-only SQL queries instead of guessing.',
      'Whenever the user requests data or metrics, prefer running supabaseSql and returning the raw rows so the UI can display a table; only summarize without a table if the user explicitly asks for it.',
      'Never render Markdown tables in text responses unless the user specifically asks for a textual table—rely on the supabaseSql tool output for tabular data and skip any extra commentary unless requested.',
      'Do not expose internal identifiers (IDs, UUIDs, technical keys) in responses unless a user explicitly asks for them; default to user-friendly fields because the audience is non-technical.',
      'IMPORTANT: After returning supabaseSql results, never restate, serialize, or otherwise repeat the rows in text because the UI already shows that data.',
    ].join(' '),
  });
  // send sources and reasoning back to the client
  return result.toUIMessageStreamResponse({
    sendSources: true,
    sendReasoning: true,
  });
}
