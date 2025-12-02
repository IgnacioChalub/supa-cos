import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";

type McpContent =
  | { type: "text"; text?: string }
  | { type: "json"; json?: unknown }
  | { type: string; [key: string]: unknown };

type SupabaseMcpResult = Record<string, unknown> & {
  sql?: string;
  rows?: unknown;
  data?: unknown;
};

type McpConfig = {
  mcpServers?: Record<string, McpServerDefinition>;
};

type McpServerDefinition = {
  type?: "http";
  url: string;
  headers?: Record<string, string>;
};

type ToolDefinition = {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  [key: string]: unknown;
};

type ToolArgumentContext = {
  prompt: string;
};
 
export type SchemaSnapshot = {
  summary?: string;
  rows?: unknown;
  rawResult?: unknown;
};

export type SupabaseSqlExecutionResult = {
  sql: string;
  rows: unknown;
  raw: unknown;
};

const MCP_CONFIG_PATH = path.join(process.cwd(), "mcp.config.json");
const SUPABASE_SERVER_NAME = "supabase";
const SCHEMA_NAME = "public";

let clientPromise: Promise<Client> | null = null;

const decodeEscapedJson = (text: string): string | null => {
  try {
    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      return text;
    }
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return null;
  }
};

const parseContentPayload = (content?: McpContent[]): SupabaseMcpResult => {
  if (!content || content.length === 0) {
    return {};
  }
  for (const chunk of content) {
    if (chunk.type === "json" && chunk.json) {
      return chunk.json as SupabaseMcpResult;
    }
    if (chunk.type === "text" && typeof chunk.text === "string") {
      const text = chunk.text.trim().replace(/^"+|"+$/g, "");
      const decoded = decodeEscapedJson(text) ?? text;
      const untrustedMatch = decoded.match(
        /<untrusted-data[^>]*>([\s\S]*?)<\/untrusted-data[^>]*>/i
      );
      const candidate = (
        untrustedMatch ? untrustedMatch[1].trim() : decoded
      ).replace(/^"+|"+$/g, "");
      const innerDecoded = decodeEscapedJson(candidate) ?? candidate;
      try {
        return JSON.parse(innerDecoded) as SupabaseMcpResult;
      } catch {
        return { rows: innerDecoded };
      }
    }
  }
  return {};
};

const stripBoundaryArtifacts = (value: string): string => {
  const untrustedMatchWithClose = value.match(
    /<untrusted-data[^>]*>([\s\S]*?)<\/untrusted-data[^>]*>/i
  );
  if (untrustedMatchWithClose) {
    return untrustedMatchWithClose[1].trim().replace(/^"+|"+$/g, "");
  }

  const untrustedMatchNoClose = value.match(
    /<untrusted-data[^>]*>([\s\S]*)$/i
  );
  if (untrustedMatchNoClose) {
    return untrustedMatchNoClose[1].trim().replace(/^"+|"+$/g, "");
  }

  const firstJsonChar = value.search(/[\[{]/);
  if (firstJsonChar >= 0) {
    const lastBracket = Math.max(value.lastIndexOf("]"), value.lastIndexOf("}"));
    if (lastBracket >= firstJsonChar) {
      return value.slice(firstJsonChar, lastBracket + 1).trim();
    }
  }

  return value;
};

const normalizeRowsPayload = (rows: unknown): unknown => {
  if (typeof rows !== "string") {
    return rows;
  }
  const trimmed = rows.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) {
    return [];
  }
  const decoded = stripBoundaryArtifacts(
    decodeEscapedJson(trimmed) ?? trimmed
  );

  try {
    return JSON.parse(decoded);
  } catch {
    return rows;
  }
};

const readMcpConfig = (): McpConfig => {
  try {
    const raw = fs.readFileSync(MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as McpConfig;
  } catch (error) {
    throw new Error(
      `Unable to read MCP configuration at ${MCP_CONFIG_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const applyEnvTemplates = (value: string): string => {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const resolved = process.env[varName];
    if (typeof resolved !== "string") {
      throw new Error(
        `Missing environment variable "${varName}" required by MCP configuration`
      );
    }
    return resolved;
  });
};

const applyEnvTemplatesToRecord = (
  record: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!record) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = applyEnvTemplates(value);
  }
  return resolved;
};

const resolveSupabaseServerConfig = () => {
  const config = readMcpConfig();
  const server = config.mcpServers?.[SUPABASE_SERVER_NAME];
  if (!server) {
    throw new Error(
      `MCP configuration is missing the "${SUPABASE_SERVER_NAME}" server definition`
    );
  }
  if (!server.url) {
    throw new Error(
      `Supabase MCP server "${SUPABASE_SERVER_NAME}" is missing the "url" property for HTTP configuration`
    );
  }
  return {
    url: applyEnvTemplates(server.url),
    headers: applyEnvTemplatesToRecord(server.headers),
  };
};

const createClient = async (): Promise<Client> => {
  const server = resolveSupabaseServerConfig();
  const client = new Client(
    {
      name: "obelis-supa-queries",
      version: process.env.npm_package_version ?? "0.1.0",
    },
    {
      capabilities: {},
    }
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: server.headers ? { headers: server.headers } : undefined,
  });
  client.onclose = () => {
    clientPromise = null;
  };
  client.onerror = (error: any) => {
    console.error("Supabase MCP client error:", error);
  };
  await client.connect(transport);
  return client;
};

const getClient = async (): Promise<Client> => {
  if (!clientPromise) {
    clientPromise = createClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
};


// SUPABASE MCP AVAILABLE TOOLS
// 0  -  search_docs
// 1  -  list_organizations
// 2  -  get_organization
// 3  -  list_projects
// 4  -  get_project
// 5  -  get_cost
// 6  -  confirm_cost
// 7  -  create_project
// 8  -  pause_project
// 9  -  restore_project
// 10  -  list_tables
// 11  -  list_extensions
// 12  -  list_migrations
// 13  -  apply_migration
// 14  -  execute_sql
// 15  -  get_logs
// 16  -  get_advisors
// 17  -  get_project_url
// 18  -  get_publishable_keys
// 19  -  generate_typescript_types
// 20  -  list_edge_functions
// 21  -  get_edge_function
// 22  -  deploy_edge_function
// 23  -  create_branch
// 24  -  list_branches
// 25  -  delete_branch
// 26  -  merge_branch
// 27  -  reset_branch
// 28  -  rebase_branch
const resolveTool = async (
  client: Client,
  toolName = "execute_sql"
): Promise<ToolDefinition> => {
  const list = await client.listTools();
  const tools = (list.tools as ToolDefinition[] | undefined) ?? [];
  if (tools.length === 0) {
    throw new Error("Supabase MCP server did not return any tools.");
  }
  const tool = tools.find((tool) => tool.name === toolName);
  if (!tool) {
    throw new Error(`${toolName} tool not found`);
  }
  return tool;
};

const normalizePropertyName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

const inferArgumentValue = (
  propertyName: string,
  context: ToolArgumentContext
): string | undefined => {
  const normalized = normalizePropertyName(propertyName);
  switch (normalized) {
    case "prompt":
    case "question":
    case "input":
      return context.prompt;
    case "query":
    case "sql":
      return context.prompt;
    default:
      return undefined;
  }
};

const buildArgumentsForTool = (
  tool: ToolDefinition,
  context: ToolArgumentContext,
  explicitArgs?: Record<string, unknown>
): Record<string, unknown> => {
  const properties =
    (tool.inputSchema?.properties as Record<string, unknown> | undefined) ??
    undefined;

  if (!properties) {
    const fallback = {
      prompt: context.prompt,
    };
    return explicitArgs ? { ...fallback, ...explicitArgs } : fallback;
  }

  const args: Record<string, unknown> = {};
  const overrides = explicitArgs ? { ...explicitArgs } : undefined;
  for (const propertyName of Object.keys(properties)) {
    if (
      overrides &&
      Object.prototype.hasOwnProperty.call(overrides, propertyName)
    ) {
      args[propertyName] = overrides[propertyName];
      delete overrides[propertyName];
      continue;
    }
    const value = inferArgumentValue(propertyName, context);
    if (value !== undefined) {
      args[propertyName] = value;
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      args[key] = value;
    }
  }

  const required = tool.inputSchema?.required ?? [];
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Supabase MCP tool "${tool.name}" requires the following arguments: ${missing.join(
        ", "
      )}. Provide the corresponding environment variables or override the tool using SUPABASE_MCP_TOOL.`
    );
  }

  if (Object.keys(args).length === 0) {
    if (explicitArgs) {
      return { ...explicitArgs };
    }
    return { prompt: context.prompt };
  }

  return args;
};

const callSupabaseTool = async (
  client: Client,
  toolName: string,
  context: ToolArgumentContext,
  explicitArgs?: Record<string, unknown>
) => {
  const tool = await resolveTool(client, toolName);
  const args = buildArgumentsForTool(tool, context, explicitArgs);
  console.log("ARGS", args);
  const result = await client.callTool({
    name: tool.name,
    arguments: args,
  });
  if ("isError" in result && result.isError) {
    console.error("Supabase MCP tool error:", result);
    throw new Error(`Supabase MCP tool "${tool.name}" returned an error`);
  }

  return result;
};

const sanitizeReadOnlySql = (candidate: string): string => {
  let text = candidate.trim();
  if (!text) {
    throw new Error("SQL input cannot be empty.");
  }
  if (text.startsWith("```")) {
    text = text.replace(/^```sql\s*/i, "").replace(/```$/g, "").trim();
  }
  if (!/^(select|with)\b/i.test(text)) {
    throw new Error("Only read-only SELECT or WITH statements are allowed.");
  }
  if (
    /\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/i.test(
      text
    )
  ) {
    throw new Error("Only read-only SQL statements are allowed.");
  }
  text = text.replace(/;+\s*$/g, "");
  if (!/limit\s+\d+/i.test(text)) {
    text = `${text} LIMIT 100`;
  }
  return text;
};






const coerceString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
};

const pickFirstField = (
  row: Record<string, unknown>,
  candidates: string[]
): string | undefined => {
  for (const candidate of candidates) {
    const value = row[candidate];
    const coerced = coerceString(value);
    if (coerced) {
      return coerced;
    }
  }
  return undefined;
};

const summarizeSchemaRows = (rows: unknown): string | undefined => {
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const grouped = new Map<string, string[]>();
  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== "object") {
      continue;
    }
    const row = rawRow as Record<string, unknown>;
    const table = pickFirstField(row, ["table_name", "table", "name"]);
    const column = pickFirstField(row, ["column_name", "column"]);
    const type =
      pickFirstField(row, ["data_type", "udt_name", "type"]) ?? undefined;
    if (!table || !column) {
      continue;
    }
    if (!grouped.has(table)) {
      grouped.set(table, []);
    }
    const columns = grouped.get(table)!;
    columns.push(type ? `${column}:${type}` : column);
  }

  const summaryLines: string[] = [];
  for (const [table, columns] of Array.from(grouped.entries())) {
    summaryLines.push(`${table}(${columns.join(", ")})`);
  }
  return summaryLines.join("\n");
};

const buildSchemaIntrospectionSql = (): string => {
  const limit = 400;
  return `
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = '${SCHEMA_NAME}'
    order by table_name, ordinal_position
    limit ${limit};
  `;
};

const unwrapToolResult = (result: unknown) => {
  const contentPayload = Array.isArray(
    (result as { content?: McpContent[] }).content
  )
    ? (result as { content?: McpContent[] }).content
    : undefined;
  const parsed = parseContentPayload(contentPayload);
  const rawRows =
    parsed.rows ??
    parsed.data ??
    (result as { structuredContent?: { rows?: unknown; data?: unknown } })
      .structuredContent?.rows ??
    (result as { structuredContent?: { rows?: unknown; data?: unknown } })
      .structuredContent?.data ??
    (result as { rows?: unknown; data?: unknown }).rows ??
    (result as { rows?: unknown; data?: unknown }).data;
  return {
    parsed,
    rawRows,
    sql: parsed.sql ?? (result as { sql?: string }).sql,
    result,
  };
};

const fetchSchemaSnapshot = async (
  client: Client
): Promise<SchemaSnapshot> => {
  const schemaSql = buildSchemaIntrospectionSql();
  const introspectionContext: ToolArgumentContext = {
    prompt: schemaSql,
  };
  console.log("INTROSPECTION SQL", schemaSql);
  const result = await callSupabaseTool(client, "execute_sql", introspectionContext);
  const { rawRows } = unwrapToolResult(result);
  const normalizedRows = normalizeRowsPayload(rawRows);
  return {
    summary: summarizeSchemaRows(normalizedRows),
    rows: normalizedRows,
    rawResult: result,
  };
};

export const getSupabaseSchema = async (): Promise<SchemaSnapshot> => {
  const client = await getClient();
  return fetchSchemaSnapshot(client);
};

export const executeSupabaseSql = async (
  sql: string
): Promise<SupabaseSqlExecutionResult> => {
  const client = await getClient();
  const sanitizedSql = sanitizeReadOnlySql(sql);
  const executionContext: ToolArgumentContext = {
    prompt: sanitizedSql,
  };

  const result = await callSupabaseTool(client, "execute_sql", executionContext);
  const { rawRows, sql: resolvedSql } = unwrapToolResult(result);
  const normalizedRows = normalizeRowsPayload(rawRows);

  return {
    sql: resolvedSql ?? sanitizedSql,
    rows: normalizedRows,
    raw: result,
  };
};
