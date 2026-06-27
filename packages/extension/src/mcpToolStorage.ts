/// <reference types="chrome" />

/**
 * MCP Tool Storage — CRUD for website MCP servers and their tools.
 * Stored in chrome.storage.local under the "mcpServers" key.
 */

const MCP_SERVERS_STORAGE_KEY = "mcpServers";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A website that has been turned into an MCP server */
export interface WebsiteMcpServer {
  readonly id: string;
  domain: string;
  displayName: string;
  enabled: boolean;
  tools: McpToolDefinition[];
  readonly createdAt: string;
  updatedAt: string;
}

/** A single tool (endpoint) within a server */
export interface McpToolDefinition {
  readonly id: string;
  readonly serverId: string;
  name: string;
  description: string;

  // Request template — all fields support {{symbol}} syntax
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  urlTemplate: string;
  headerTemplates: Record<string, string>;
  bodyTemplate: string;

  // Declared parameters (agent-provided values)
  parameters: ToolParameter[];

  // Response config
  responseType: "json" | "text" | "html";

  enabled: boolean;
  readonly createdAt: string;
  updatedAt: string;
  inputSchema?: string;
}

/** A parameter that the AI agent fills in when calling the tool */
export interface ToolParameter {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: string;
}

// ─── Server CRUD ──────────────────────────────────────────────────────────────

export async function listServers(): Promise<WebsiteMcpServer[]> {
  const values = await chrome.storage.local.get(MCP_SERVERS_STORAGE_KEY);
  const servers = values[MCP_SERVERS_STORAGE_KEY] as WebsiteMcpServer[] | undefined;
  return servers ?? [];
}

export async function getServer(id: string): Promise<WebsiteMcpServer | undefined> {
  const servers = await listServers();
  return servers.find((s) => s.id === id);
}

export async function getServerByDomain(domain: string): Promise<WebsiteMcpServer | undefined> {
  const servers = await listServers();
  return servers.find((s) => s.domain === domain);
}

export async function saveServer(server: WebsiteMcpServer): Promise<WebsiteMcpServer> {
  const servers = await listServers();
  const existingIndex = servers.findIndex((s) => s.id === server.id);
  const now = new Date().toISOString();

  const updatedServer: WebsiteMcpServer = {
    ...server,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    servers[existingIndex] = updatedServer;
  } else {
    servers.push(updatedServer);
  }

  await writeServers(servers);
  return updatedServer;
}

export async function deleteServer(id: string): Promise<void> {
  const servers = await listServers();
  const filtered = servers.filter((s) => s.id !== id);
  await writeServers(filtered);
}

// ─── Tool CRUD ────────────────────────────────────────────────────────────────

export async function listTools(serverId: string): Promise<McpToolDefinition[]> {
  const server = await getServer(serverId);
  return server?.tools ?? [];
}

export async function getTool(
  serverId: string,
  toolId: string,
): Promise<McpToolDefinition | undefined> {
  const server = await getServer(serverId);
  return server?.tools.find((t) => t.id === toolId);
}

export async function saveTool(
  serverId: string,
  tool: McpToolDefinition,
): Promise<McpToolDefinition> {
  const servers = await listServers();
  const serverIndex = servers.findIndex((s) => s.id === serverId);

  if (serverIndex < 0) {
    throw new Error(`Server "${serverId}" not found.`);
  }

  const server = servers[serverIndex]!;
  const existingToolIndex = server.tools.findIndex((t) => t.id === tool.id);
  const now = new Date().toISOString();

  const updatedTool: McpToolDefinition = {
    ...tool,
    serverId,
    updatedAt: now,
  };

  if (existingToolIndex >= 0) {
    server.tools[existingToolIndex] = updatedTool;
  } else {
    server.tools.push(updatedTool);
  }

  server.updatedAt = now;
  servers[serverIndex] = server;
  await writeServers(servers);
  return updatedTool;
}

export async function deleteTool(serverId: string, toolId: string): Promise<void> {
  const servers = await listServers();
  const serverIndex = servers.findIndex((s) => s.id === serverId);
  if (serverIndex < 0) return;

  const server = servers[serverIndex]!;
  server.tools = server.tools.filter((t) => t.id !== toolId);
  server.updatedAt = new Date().toISOString();
  servers[serverIndex] = server;
  await writeServers(servers);
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/** Get all enabled tools across all enabled servers */
export async function getAllEnabledTools(): Promise<McpToolDefinition[]> {
  const servers = await listServers();
  const tools: McpToolDefinition[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;
    for (const tool of server.tools) {
      if (!tool.enabled) continue;
      tools.push(tool);
    }
  }

  return tools;
}

/** Find an enabled tool by name across all enabled servers */
export async function findEnabledToolByName(name: string): Promise<McpToolDefinition | undefined> {
  const tools = await getAllEnabledTools();
  return tools.find((tool) => tool.name === name);
}

// ─── Import / Export ──────────────────────────────────────────────────────────

export async function exportConfig(): Promise<string> {
  const servers = await listServers();
  return JSON.stringify(
    {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      servers,
    },
    null,
    2,
  );
}

export async function importConfig(json: string): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return { imported: 0, errors: ["Invalid JSON."] };
  }

  if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
    return { imported: 0, errors: ['JSON must contain a "servers" array.'] };
  }

  const data = parsed as { servers: unknown };
  if (!Array.isArray(data.servers)) {
    return { imported: 0, errors: ['"servers" must be an array.'] };
  }

  const existingServers = await listServers();
  let imported = 0;

  for (const rawServer of data.servers) {
    try {
      const server = rawServer as WebsiteMcpServer;
      if (!server.id || !server.domain || !server.displayName) {
        errors.push(`Skipped server: missing id, domain, or displayName.`);
        continue;
      }

      // Avoid duplicate IDs
      const existingIndex = existingServers.findIndex((s) => s.id === server.id);
      if (existingIndex >= 0) {
        existingServers[existingIndex] = server;
      } else {
        existingServers.push(server);
      }

      imported++;
    } catch (error) {
      errors.push(`Failed to import server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await writeServers(existingServers);
  return { imported, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function createServer(
  domain: string,
  displayName: string,
): WebsiteMcpServer {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    domain,
    displayName,
    enabled: true,
    tools: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createTool(
  serverId: string,
  name: string,
  overrides: Partial<Omit<McpToolDefinition, "id" | "serverId" | "createdAt">> = {},
): McpToolDefinition {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    serverId,
    name,
    description: overrides.description ?? "",
    method: overrides.method ?? "GET",
    urlTemplate: overrides.urlTemplate ?? "",
    headerTemplates: overrides.headerTemplates ?? {},
    bodyTemplate: overrides.bodyTemplate ?? "",
    parameters: overrides.parameters ?? [],
    responseType: overrides.responseType ?? "json",
    enabled: overrides.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    inputSchema: overrides.inputSchema,
  };
}

async function writeServers(servers: WebsiteMcpServer[]): Promise<void> {
  await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: servers });
}
