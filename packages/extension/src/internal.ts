import type {
  BridgeError,
  PairingFile,
  PortRange,
  ToolRequestMessage,
  ToolResultPayload,
} from "@agentic-browser-mcp/shared";
import {
  DEFAULT_DISCOVERY_HOST,
  DEFAULT_DISCOVERY_PORT_RANGE_END,
  DEFAULT_DISCOVERY_PORT_RANGE_START,
} from "@agentic-browser-mcp/shared";

import type { McpToolDefinition, WebsiteMcpServer } from "./mcpToolStorage.js";
import type { HttpProxyResult } from "./httpProxy.js";

export const EXTENSION_CLIENT_NAME = "agentic-browser-mcp-extension";
export const PAIRING_STORAGE_KEY = "agenticBrowserMcpPairing";
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const DEFAULT_DISCOVERY_RANGE: PortRange = {
  start: DEFAULT_DISCOVERY_PORT_RANGE_START,
  end: DEFAULT_DISCOVERY_PORT_RANGE_END,
};
export const DISCOVERY_HOST = DEFAULT_DISCOVERY_HOST;

export interface StoredPairingState {
  readonly pairingFile: PairingFile;
  readonly importedAt: string;
}

// ─── Existing message types ───────────────────────────────────────────────────

export interface ToolRouterRequestMessage {
  readonly kind: "bridge/tool-request";
  readonly request: ToolRequestMessage;
}

export interface BridgeLifecycleMessage {
  readonly kind: "bridge/ensure-connection";
}

export interface BridgeEnsureConnectionResponse {
  readonly ok: boolean;
  readonly offscreenReady: boolean;
  readonly nativeHostReady: boolean;
  readonly error?: string;
}

export interface PairingUpdatedMessage {
  readonly kind: "bridge/pairing-updated";
}

export interface GetPairingStateMessage {
  readonly kind: "bridge/get-pairing-state";
}

export interface BridgeCheckPairingMessage {
  readonly kind: "bridge/check-pairing";
}

/** Debug log line forwarded from the offscreen document to the service worker console. */
export interface OffscreenLogMessage {
  readonly kind: "offscreen/log";
  readonly message: string;
}

export interface ToolRouterSuccessResponse {
  readonly ok: true;
  readonly result: ToolResultPayload;
}

export interface ToolRouterErrorResponse {
  readonly ok: false;
  readonly error: BridgeError;
}

export interface PairingStateResponse {
  readonly ok: true;
  readonly pairingState?: StoredPairingState;
}

// ─── MCP Server/Tool management messages ──────────────────────────────────────

export interface McpListServersMessage {
  readonly kind: "mcp/list-servers";
}

export interface McpSaveServerMessage {
  readonly kind: "mcp/save-server";
  readonly server: WebsiteMcpServer;
}

export interface McpDeleteServerMessage {
  readonly kind: "mcp/delete-server";
  readonly serverId: string;
}

export interface McpListToolsMessage {
  readonly kind: "mcp/list-tools";
  readonly serverId: string;
}

export interface McpSaveToolMessage {
  readonly kind: "mcp/save-tool";
  readonly serverId: string;
  readonly tool: McpToolDefinition;
}

export interface McpDeleteToolMessage {
  readonly kind: "mcp/delete-tool";
  readonly serverId: string;
  readonly toolId: string;
}

export interface McpTestToolMessage {
  readonly kind: "mcp/test-tool";
  readonly serverId: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

export interface McpExportConfigMessage {
  readonly kind: "mcp/export-config";
}

export interface McpImportConfigMessage {
  readonly kind: "mcp/import-config";
  readonly json: string;
}

export interface McpGetNativeHostStatusMessage {
  readonly kind: "mcp/get-native-host-status";
}

export interface McpGetDynamicToolsMessage {
  readonly kind: "mcp/get-dynamic-tools";
}

export interface McpParseToolOutputMessage {
  readonly kind: "mcp/parse-tool-output";
  readonly serverId: string;
  readonly toolId: string;
  readonly input: string;
}

// ─── Response types ───────────────────────────────────────────────────────────

export interface McpListServersResponse {
  readonly ok: true;
  readonly servers: WebsiteMcpServer[];
}

export interface McpSaveServerResponse {
  readonly ok: true;
  readonly server: WebsiteMcpServer;
}

export interface McpDeleteServerResponse {
  readonly ok: true;
}

export interface McpListToolsResponse {
  readonly ok: true;
  readonly tools: McpToolDefinition[];
}

export interface McpSaveToolResponse {
  readonly ok: true;
  readonly tool: McpToolDefinition;
}

export interface McpDeleteToolResponse {
  readonly ok: true;
}

export interface McpTestToolResponse {
  readonly ok: true;
  readonly result: HttpProxyResult;
}

export interface McpExportConfigResponse {
  readonly ok: true;
  readonly json: string;
}

export interface McpImportConfigResponse {
  readonly ok: true;
  readonly imported: number;
  readonly errors: string[];
}

export interface McpNativeHostStatusResponse {
  readonly ok: true;
  readonly available: boolean;
  readonly error?: string;
}

export interface McpParseToolOutputResponse {
  readonly ok: true;
  readonly output: string;
  readonly error?: string;
}

export interface McpErrorResponse {
  readonly ok: false;
  readonly error: string;
}

// ─── Union types ──────────────────────────────────────────────────────────────

export type ExtensionRuntimeMessage =
  | ToolRouterRequestMessage
  | BridgeLifecycleMessage
  | PairingUpdatedMessage
  | GetPairingStateMessage
  | BridgeCheckPairingMessage
  | OffscreenLogMessage
  | McpListServersMessage
  | McpSaveServerMessage
  | McpDeleteServerMessage
  | McpListToolsMessage
  | McpSaveToolMessage
  | McpDeleteToolMessage
  | McpTestToolMessage
  | McpExportConfigMessage
  | McpImportConfigMessage
  | McpGetNativeHostStatusMessage
  | McpGetDynamicToolsMessage
  | McpParseToolOutputMessage;

export type ToolRouterResponse =
  | ToolRouterSuccessResponse
  | ToolRouterErrorResponse
  | BridgeEnsureConnectionResponse
  | PairingStateResponse;
