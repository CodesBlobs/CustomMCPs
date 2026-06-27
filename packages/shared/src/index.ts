import { z } from "zod";

export const PROTOCOL_VERSION = "phase1-mvp";
export const DEFAULT_BRIDGE_HEARTBEAT_MS = 15_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 20_000;
export const PAIRING_FILE_NAME = "agentic-browser-mcp.pairing.json";
export const DEFAULT_DISCOVERY_HOST = "127.0.0.1" as const;
export const DEFAULT_DISCOVERY_PORT_RANGE_START = 45_320;
export const DEFAULT_DISCOVERY_PORT_RANGE_END = 45_339;
export const PAIRING_CAPTURE_PATH = "/.well-known/agentic-browser-mcp/pair";
export const PAIRING_CAPTURE_FRAGMENT_KEY = "pairing";
export const NATIVE_HOST_NAME = "com.agentic_browser_mcp.host";

export const MVP_TOOL_NAMES = [
  "list_tabs",
  "get_page_text",
  "take_screenshot",
  "navigate",
  "open_tab",
  "close_tab",
] as const;

export type MvpToolName = (typeof MVP_TOOL_NAMES)[number];

export const ToolArgumentSchemas = {
  list_tabs: z.object({}).strict(),
  get_page_text: z
    .object({
      tabId: z.number().int().positive().optional(),
    })
    .strict(),
  take_screenshot: z
    .object({
      tabId: z.number().int().positive().optional(),
      format: z.enum(["png", "jpeg"]).default("png"),
    })
    .strict(),
  navigate: z
    .object({
      tabId: z.number().int().positive(),
      url: z.url(),
    })
    .strict(),
  open_tab: z
    .object({
      url: z.url(),
      active: z.boolean().optional(),
    })
    .strict(),
  close_tab: z
    .object({
      tabId: z.number().int().positive(),
    })
    .strict(),
} satisfies Record<MvpToolName, z.ZodTypeAny>;

export type ToolArguments = {
  [K in MvpToolName]: z.output<(typeof ToolArgumentSchemas)[K]>;
};

export const BridgeErrorCodeSchema = z.enum([
  "EXTENSION_OFFLINE",
  "AUTH_FAILED",
  "PROTOCOL_MISMATCH",
  "TOOL_TIMEOUT",
  "TOOL_EXECUTION_FAILED",
  "INVALID_MESSAGE",
]);

export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BridgeErrorSchema = z.object({
  code: BridgeErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
  correlationId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export const PortRangeSchema = z
  .object({
    start: z.number().int().min(1).max(65_535),
    end: z.number().int().min(1).max(65_535),
  })
  .refine((value) => value.start <= value.end, {
    message: "Port range start must be less than or equal to end.",
    path: ["end"],
  });

export type PortRange = z.infer<typeof PortRangeSchema>;

export const PairingAuthModeSchema = z.enum(["loopback", "token"]);
export type PairingAuthMode = z.infer<typeof PairingAuthModeSchema>;

const PairingWebSocketUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && url.hostname === DEFAULT_DISCOVERY_HOST;
  } catch {
    return false;
  }
}, "Pairing WebSocket URL must target the local loopback bridge.");

export const PairingFileSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverInstanceId: z.string().min(1),
  serverPid: z.number().int().positive(),
  wsUrl: PairingWebSocketUrlSchema,
  token: z.string().min(32).optional(),
  authMode: PairingAuthModeSchema.default("loopback"),
  portRange: PortRangeSchema.default({
    start: DEFAULT_DISCOVERY_PORT_RANGE_START,
    end: DEFAULT_DISCOVERY_PORT_RANGE_END,
  }),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type PairingFile = z.infer<typeof PairingFileSchema>;

export const NativeHostEnsureServerRequestSchema = z.object({
  kind: z.literal("native-host/ensure-server"),
});

export const NativeHostReadyResponseSchema = z.object({
  kind: z.literal("native-host/server-ready"),
  pairingFile: PairingFileSchema,
  launched: z.boolean().default(false),
});

export const NativeHostErrorResponseSchema = z.object({
  kind: z.literal("native-host/error"),
  message: z.string().min(1),
});

export const NativeHostHttpRequestSchema = z.object({
  kind: z.literal("native-host/http-request"),
  requestId: z.string().min(1),
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
  envResolve: z.record(z.string(), z.string()).optional(),
});

export const NativeHostHttpResponseSchema = z.object({
  kind: z.literal("native-host/http-response"),
  requestId: z.string().min(1),
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  error: z.string().optional(),
});

export const NativeHostMessageSchema = z.union([
  NativeHostEnsureServerRequestSchema,
  NativeHostReadyResponseSchema,
  NativeHostErrorResponseSchema,
  NativeHostHttpRequestSchema,
  NativeHostHttpResponseSchema,
]);

export type NativeHostEnsureServerRequest = z.infer<typeof NativeHostEnsureServerRequestSchema>;
export type NativeHostReadyResponse = z.infer<typeof NativeHostReadyResponseSchema>;
export type NativeHostErrorResponse = z.infer<typeof NativeHostErrorResponseSchema>;
export type NativeHostHttpRequest = z.infer<typeof NativeHostHttpRequestSchema>;
export type NativeHostHttpResponse = z.infer<typeof NativeHostHttpResponseSchema>;
export type NativeHostMessage = z.infer<typeof NativeHostMessageSchema>;

export const ClientHelloMessageSchema = z.object({
  type: z.literal("client_hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  token: z.string().min(32).optional(),
  clientName: z.string().min(1),
  clientVersion: z.string().min(1),
});

export const ServerHelloMessageSchema = z.object({
  type: z.literal("server_hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverInstanceId: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  accepted: z.boolean(),
});

export const HeartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  timestamp: z.string().datetime(),
});

export const ToolRequestMessageSchema = z.object({
  type: z.literal("tool_request"),
  correlationId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export const ToolResultPayloadSchema = z.object({
  ok: z.boolean(),
  content: z.array(z.object({ type: z.string(), text: z.string() })).default([]),
  data: z.unknown().optional(),
});

export const ToolResultMessageSchema = z.object({
  type: z.literal("tool_result"),
  correlationId: z.string().min(1),
  toolName: z.string().min(1),
  result: ToolResultPayloadSchema,
});

export const ToolErrorMessageSchema = z.object({
  type: z.literal("tool_error"),
  correlationId: z.string().min(1),
  toolName: z.string().min(1),
  error: BridgeErrorSchema,
});

export const DynamicToolParameterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(true),
});

export const DynamicToolInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  serverId: z.string().min(1),
  serverName: z.string().default(""),
  parameters: z.array(DynamicToolParameterSchema).default([]),
  inputSchema: z.string().optional(),
});

export const DynamicToolListRequestSchema = z.object({
  type: z.literal("dynamic_tool_list_request"),
  correlationId: z.string().min(1),
});

export const DynamicToolListResponseSchema = z.object({
  type: z.literal("dynamic_tool_list_response"),
  correlationId: z.string().min(1),
  tools: z.array(DynamicToolInfoSchema).default([]),
});

export type DynamicToolParameter = z.infer<typeof DynamicToolParameterSchema>;
export type DynamicToolInfo = z.infer<typeof DynamicToolInfoSchema>;
export type DynamicToolListRequest = z.infer<typeof DynamicToolListRequestSchema>;
export type DynamicToolListResponse = z.infer<typeof DynamicToolListResponseSchema>;

export const BridgeMessageSchema = z.union([
  ClientHelloMessageSchema,
  ServerHelloMessageSchema,
  HeartbeatMessageSchema,
  ToolRequestMessageSchema,
  ToolResultMessageSchema,
  ToolErrorMessageSchema,
  DynamicToolListRequestSchema,
  DynamicToolListResponseSchema,
]);

export type ClientHelloMessage = z.infer<typeof ClientHelloMessageSchema>;
export type ServerHelloMessage = z.infer<typeof ServerHelloMessageSchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type ToolRequestMessage = z.infer<typeof ToolRequestMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type ToolErrorMessage = z.infer<typeof ToolErrorMessageSchema>;
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;

export function createBridgeError(
  code: BridgeErrorCode,
  message: string,
  options: Omit<Partial<BridgeError>, "code" | "message"> = {},
): BridgeError {
  return BridgeErrorSchema.parse({
    code,
    message,
    retryable: options.retryable ?? false,
    correlationId: options.correlationId,
    details: options.details,
  });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isBridgeError(value: unknown): value is BridgeError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export function toBridgeError(
  error: unknown,
  options: { correlationId?: string; details?: Record<string, unknown> } = {},
): BridgeError {
  if (isBridgeError(error)) {
    return {
      ...error,
      retryable: error.retryable ?? false,
      correlationId: error.correlationId ?? options.correlationId,
    };
  }

  return createBridgeError("TOOL_EXECUTION_FAILED", getErrorMessage(error), options);
}

export function createOfflineBridgeError(correlationId?: string): BridgeError {
  return createBridgeError(
    "EXTENSION_OFFLINE",
    "The Chrome extension bridge is offline. Load the MV3 extension and complete pairing before running browser tools.",
    {
      correlationId,
      retryable: true,
    },
  );
}

export function serializeBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message);
}

export function parseBridgeMessage(raw: string): BridgeMessage {
  return BridgeMessageSchema.parse(JSON.parse(raw));
}

export function buildLoopbackWsUrl(port: number, host: string = DEFAULT_DISCOVERY_HOST): string {
  return `ws://${host}:${port}`;
}

export function buildPairingCaptureUrl(pairingFile: PairingFile): string {
  const url = new URL(pairingFile.wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = PAIRING_CAPTURE_PATH;
  url.search = "";
  url.hash = new URLSearchParams([
    [PAIRING_CAPTURE_FRAGMENT_KEY, JSON.stringify(PairingFileSchema.parse(pairingFile))],
  ]).toString();
  return url.toString();
}

export function parsePairingCaptureUrl(urlValue: string): PairingFile | undefined {
  try {
    const url = new URL(urlValue);
    if (url.pathname !== PAIRING_CAPTURE_PATH) {
      return undefined;
    }

    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const serializedPairing = hashParams.get(PAIRING_CAPTURE_FRAGMENT_KEY);
    if (!serializedPairing) {
      return undefined;
    }

    return PairingFileSchema.parse(JSON.parse(serializedPairing) as unknown);
  } catch {
    return undefined;
  }
}

// ─── Exported Config Schemas (for standalone runner) ──────────────────────────

/** A parameter that the AI agent fills in when calling the tool */
export const ToolParameterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(true),
  defaultValue: z.string().optional(),
});

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

/** A single tool (endpoint) within a server */
export const McpToolDefinitionSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),

  // Request template
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
  urlTemplate: z.string().default(""),
  headerTemplates: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.string().default(""),

  // Declared parameters
  parameters: z.array(ToolParameterSchema).default([]),

  // Response config
  responseType: z.enum(["json", "text", "html"]).default("json"),

  enabled: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  inputSchema: z.string().optional(),
});

export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;

/** A website that has been turned into an MCP server */
export const WebsiteMcpServerSchema = z.object({
  id: z.string().min(1),
  domain: z.string().default(""),
  displayName: z.string().default(""),
  enabled: z.boolean().default(true),
  tools: z.array(McpToolDefinitionSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type WebsiteMcpServer = z.infer<typeof WebsiteMcpServerSchema>;

/** The JSON structure exported by the extension's "Export Config" feature */
export const ExportedConfigSchema = z.object({
  version: z.string().default("1.0"),
  exportedAt: z.string().optional(),
  servers: z.array(WebsiteMcpServerSchema).default([]),
});

export type ExportedConfig = z.infer<typeof ExportedConfigSchema>;
