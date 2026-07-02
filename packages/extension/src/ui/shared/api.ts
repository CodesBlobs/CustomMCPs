/**
 * Typed wrappers over the background `chrome.runtime.sendMessage({ kind })`
 * protocol. The message surface is unchanged from the previous UI — this module
 * only gives it a typed, promise-returning shape for the new front-end.
 */
import type { WebsiteMcpServer, McpToolDefinition } from "../../mcpToolStorage.js";
import type { HttpProxyResult } from "../../httpProxy.js";
import type { PairingFile } from "@agentic-browser-mcp/shared";

export interface PairingState {
  pairingFile: PairingFile;
  importedAt: string;
}

interface NativeHostStatus {
  available: boolean;
  error?: string;
}

async function send<TResponse>(message: Record<string, unknown>): Promise<TResponse> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) {
    throw new Error("No response from extension background.");
  }
  if (response.ok === false) {
    throw new Error(response.error ?? "Operation failed.");
  }
  return response as TResponse;
}

// ─── MCP servers & tools ────────────────────────────────────────────────────

export async function listServers(): Promise<WebsiteMcpServer[]> {
  const res = await send<{ servers: WebsiteMcpServer[] }>({ kind: "mcp/list-servers" });
  return res.servers;
}

export async function saveServer(server: WebsiteMcpServer): Promise<void> {
  await send({ kind: "mcp/save-server", server });
}

export async function deleteServer(serverId: string): Promise<void> {
  await send({ kind: "mcp/delete-server", serverId });
}

export async function saveTool(serverId: string, tool: McpToolDefinition): Promise<void> {
  await send({ kind: "mcp/save-tool", serverId, tool });
}

export async function deleteTool(serverId: string, toolId: string): Promise<void> {
  await send({ kind: "mcp/delete-tool", serverId, toolId });
}

export async function testTool(
  serverId: string,
  toolId: string,
  args: Record<string, unknown>,
): Promise<HttpProxyResult> {
  const res = await send<{ result: HttpProxyResult }>({
    kind: "mcp/test-tool",
    serverId,
    toolId,
    args,
  });
  return res.result;
}

export async function exportConfig(): Promise<string> {
  const res = await send<{ json: string }>({ kind: "mcp/export-config" });
  return res.json;
}

export async function importConfig(json: string): Promise<{ imported: number; errors: string[] }> {
  return await send<{ imported: number; errors: string[] }>({ kind: "mcp/import-config", json });
}

export async function getNativeHostStatus(): Promise<NativeHostStatus> {
  return await send<NativeHostStatus>({ kind: "mcp/get-native-host-status" });
}

export async function parseToolOutput(
  serverId: string,
  toolId: string,
  input: string,
): Promise<{ output: string; error?: string }> {
  const res = await send<{ output: string; error?: string }>({
    kind: "mcp/parse-tool-output",
    serverId,
    toolId,
    input,
  });
  return { output: res.output, error: res.error };
}

// ─── Bridge / pairing ───────────────────────────────────────────────────────

export async function getPairingState(): Promise<PairingState | undefined> {
  const res = await chrome.runtime.sendMessage({ kind: "bridge/get-pairing-state" });
  return res?.pairingState as PairingState | undefined;
}

export function ensureConnection(): void {
  chrome.runtime.sendMessage({ kind: "bridge/ensure-connection" }).catch(() => {});
}
