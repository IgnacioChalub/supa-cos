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
    webSearch,
  }: { 
    messages: UIMessage[]; 
    model: string; 
    webSearch: boolean;
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

  const tools = webSearch
    ? undefined
    : {
        supabaseSchema: supabaseSchemaTool,
        supabaseSql: supabaseSqlTool,
      };

  const result = streamText({
    model: webSearch ? 'perplexity/sonar' : model,
    messages: convertToModelMessages(messages),
    tools,
    system: [
      'You are a helpful assistant that can answer questions and help with tasks.',
      'When users need information about the Supabase database, call supabaseSchema to inspect tables/columns and supabaseSql to execute read-only SQL queries instead of guessing.',
      'Only summarize results if explicitly requested; otherwise return the tool output as-is.',
    ].join(' '),
  });
  // send sources and reasoning back to the client
  return result.toUIMessageStreamResponse({
    sendSources: true,
    sendReasoning: true,
  });
}
