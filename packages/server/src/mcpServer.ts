import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const LOG_FILE_PATH =
  process.env.AGENTIC_BROWSER_MCP_NATIVE_HOST_LOG?.trim() ||
  path.join(homedir(), ".agentic-browser-mcp", "native-host.log");

let logDirectoryReady: Promise<void> | undefined;

async function logToFile(msg: string): Promise<void> {
  try {
    logDirectoryReady ??= mkdir(path.dirname(LOG_FILE_PATH), { recursive: true, mode: 0o700 }).then(
      () => undefined,
    );
    await logDirectoryReady;
    const timestamp = new Date().toISOString();
    await appendFile(LOG_FILE_PATH, `[${timestamp}] [McpServer] ${msg}\n`, "utf8");
  } catch {
    // Ignore logging errors
  }
}

import {
  PROTOCOL_VERSION,
  toBridgeError,
  type DynamicToolParameter,
} from "@agentic-browser-mcp/shared";

import { LoopbackBridgeServer } from "./bridgeServer.js";
import { bridgeErrorToMcpResult, toMcpToolResult } from "./toolResult.js";

const BRIDGE_CONNECT_WAIT_MS = 3_000;
const TOOL_LIST_POPULATE_WAIT_MS = 1_000;

const serverListenersKey = Symbol("serverListeners");

/** Minimal structural view of the SDK's RegisteredTool, which is not exported cleanly. */
interface RegisteredDynamicTool {
  remove(): void;
  update(updates: object): void;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return true;
  return new Promise<boolean>((resolve) => {
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(condition());
    }, timeoutMs);
  });
}


// The MCP SDK keeps registered tools and request handlers private, so the
// tools/list interception below has to reach into internal state. These two
// accessors are the only places allowed to do that.
function getRegisteredToolCount(server: McpServer): number {
  const registeredTools = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  return registeredTools ? Object.keys(registeredTools).length : 0;
}

function getRequestHandlers(server: McpServer): Map<string, (request: unknown, extra: unknown) => Promise<unknown>> {
  return (server.server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })
    ._requestHandlers;
}

function buildZodSchema(parameters: DynamicToolParameter[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of parameters) {
    let s: z.ZodTypeAny;
    if (param.type === "number") {
      s = z.number();
    } else if (param.type === "boolean") {
      s = z.boolean();
    } else {
      s = z.string();
    }
    if (param.description) {
      s = s.describe(param.description);
    }
    if (!param.required) {
      s = s.optional();
    }
    shape[param.name] = s;
  }
  return z.object(shape).strict();
}

function buildZodSchemaFromJsonSchema(schema: any): z.ZodTypeAny {
  if (typeof schema === "string") {
    schema = JSON.parse(schema);
  }

  if (typeof schema !== "object" || schema === null) {
    return z.object({}).strict();
  }

  const type = schema.type;
  if (type === "string") {
    // If the format indicates JSON content, accept string or object/array
    // so the AI agent can pass either a serialized JSON string or a raw object.
    if (schema.format && /json/i.test(schema.format)) {
      let s: z.ZodTypeAny = z.any();
      if (schema.description) {
        s = s.describe(schema.description);
      }
      return s;
    }
    let s = z.string();
    if (schema.description) {
      s = s.describe(schema.description) as any;
    }
    return s;
  }
  if (type === "number" || type === "integer") {
    let s = z.number();
    if (schema.description) {
      s = s.describe(schema.description) as any;
    }
    return s;
  }
  if (type === "boolean") {
    let s = z.boolean();
    if (schema.description) {
      s = s.describe(schema.description) as any;
    }
    return s;
  }
  if (type === "array") {
    let s = z.array(schema.items ? buildZodSchemaFromJsonSchema(schema.items) : z.any());
    if (schema.description) {
      s = s.describe(schema.description) as any;
    }
    return s;
  }

  // If no type is specified and there are no properties defined,
  // this schema accepts any value (e.g. "Config": { "description": "..." }).
  const properties = schema.properties || {};
  if (!type && Object.keys(properties).length === 0) {
    let s: z.ZodTypeAny = z.any();
    if (schema.description) {
      s = s.describe(schema.description);
    }
    return s;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let s = buildZodSchemaFromJsonSchema(propSchema);
    if (!required.includes(key)) {
      s = s.optional();
    }
    shape[key] = s;
  }

  let obj = z.object(shape).strict();
  if (schema.description) {
    obj = obj.describe(schema.description) as any;
  }
  return obj;
}

/**
 * Extracts the raw Zod shape (Record<string, ZodTypeAny>) from a ZodObject schema.
 *
 * The SDK's RegisteredTool.update() expects `paramsSchema` to be a raw shape,
 * NOT a ZodObject instance. Passing a ZodObject directly causes objectFromShape()
 * to treat all its methods/properties as validators, corrupting the schema and
 * producing `keyValidator._parse is not a function` at validation time.
 */
function getZodObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  // Zod v4 (classic): shape lives at schema._zod.def.shape (may be a getter)
  const v4Shape = (schema as any)?._zod?.def?.shape;
  if (v4Shape) {
    return typeof v4Shape === "function" ? v4Shape() : v4Shape;
  }
  // Zod v3 fallback: shape lives directly at schema.shape
  const v3Shape = (schema as any)?.shape;
  if (v3Shape) {
    return typeof v3Shape === "function" ? v3Shape() : v3Shape;
  }
  // Last resort: return empty shape
  return {};
}

export function createMcpBrowserServer(bridgeServer: LoopbackBridgeServer): McpServer {
  const server = new McpServer(
    {
      name: "agentic-browser-mcp-server",
      version: PROTOCOL_VERSION,
    },
    {
      instructions:
        "Use custom API endpoints defined by the user in the paired Chrome extension side panel. " +
        "If the connection is down, make sure the extension is active and has paired with the server.",
    },
  );
  const originalInputSchemas = new Map<string, any>();

  // Force register tool request handlers on startup so tools/list is available even if empty
  try {
    (server as unknown as { setToolRequestHandlers: () => void }).setToolRequestHandlers();
  } catch (error) {
    console.warn("[mcpServer] Failed to force-initialize tool request handlers:", error);
  }

  // Intercept tools/list: tools only exist once the extension bridge connects and
  // reports them, so give a freshly spawned server a moment before answering.
  const requestHandlers = getRequestHandlers(server);
  const originalToolsListHandler = requestHandlers.get("tools/list");
  if (originalToolsListHandler) {
    requestHandlers.set("tools/list", async (request, extra) => {
      console.error("[mcpServer] Intercepted tools/list request. Checking if bridge is connected...");

      const bridgeConnected = await waitUntil(
        () => bridgeServer.getStatus().connected,
        BRIDGE_CONNECT_WAIT_MS,
      );

      if (bridgeConnected) {
        console.error("[mcpServer] Bridge is connected. Waiting for dynamic tools list to populate...");
        await waitUntil(() => getRegisteredToolCount(server) > 0, TOOL_LIST_POPULATE_WAIT_MS);
        console.error(`[mcpServer] Returning tools list with ${getRegisteredToolCount(server)} tool(s).`);
      } else {
        console.error("[mcpServer] Bridge connection timed out. Returning empty tools list.");
      }

      const response = (await originalToolsListHandler(request, extra)) as any;
      if (response && Array.isArray(response.tools)) {
        for (const tool of response.tools) {
          const originalSchema = originalInputSchemas.get(tool.name);
          if (originalSchema) {
            tool.inputSchema = originalSchema;
          }
        }
      }
      void logToFile(`Responding tools/list: ${JSON.stringify(response)}`);
      return response;
    });
  }

  // 1. Guard sendToolListChanged to only run after initialization
  let initialized = false;
  const originalSendToolListChanged = server.sendToolListChanged.bind(server);
  (server as any).sendToolListChanged = () => {
    if (initialized) {
      originalSendToolListChanged();
    }
  };

  server.server.oninitialized = () => {
    initialized = true;
    console.error("[mcpServer] Server initialized");
    originalSendToolListChanged();
  };

  // 2. Set up the dynamic tools registration and listener
  const dynamicTools = new Map<string, RegisteredDynamicTool>();


  const listener = {
    updateTools: (tools: any[]) => {
      console.error(`[mcpServer] Updating ${tools.length} dynamic tool(s):`, tools.map((t) => t.name));
      // 1. Remove tools that are no longer in the list
      const toolNames = new Set(tools.map((t) => t.name));
      for (const [name, registeredTool] of dynamicTools.entries()) {
        if (!toolNames.has(name)) {
          try {
            registeredTool.remove();
          } catch (error) {
            console.error(`[mcpServer] Failed to remove dynamic tool ${name}:`, error);
          }
          dynamicTools.delete(name);
          originalInputSchemas.delete(name);
        }
      }

      // 2. Add or update tools
      for (const tool of tools) {
        let schema: z.ZodTypeAny;
        if (tool.inputSchema) {
          try {
            const parsed = typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema;
            originalInputSchemas.set(tool.name, parsed);
          } catch (error) {
            console.error(`[mcpServer] Failed to parse inputSchema for tool ${tool.name}:`, error);
          }

          try {
            schema = buildZodSchemaFromJsonSchema(tool.inputSchema);
          } catch (error) {
            console.error(`[mcpServer] Failed to build Zod schema from inputSchema for tool ${tool.name}:`, error);
            schema = buildZodSchema(tool.parameters);
          }
        } else {
          schema = buildZodSchema(tool.parameters);
          originalInputSchemas.delete(tool.name);
        }

        const handler = async (argumentsValue: unknown) => {
          try {
            const result = await bridgeServer.callTool(
              tool.name,
              argumentsValue as Record<string, unknown>,
            );
            const mcpResult = toMcpToolResult(result);
            void logToFile(`Responding tool ${tool.name} with result: ${JSON.stringify(mcpResult)}`);
            return mcpResult;
          } catch (error) {
            const mcpResult = bridgeErrorToMcpResult(toBridgeError(error));
            void logToFile(`Responding tool ${tool.name} with error: ${JSON.stringify(mcpResult)}`);
            return mcpResult;
          }
        };

        try {
          if (dynamicTools.has(tool.name)) {
            const registered = dynamicTools.get(tool.name)!;
            registered.update({
              description: tool.description,
              paramsSchema: getZodObjectShape(schema),
              callback: handler,
            });
          } else {
            const registered = server.registerTool(
              tool.name,
              {
                description: tool.description,
                inputSchema: schema,
              },
              handler,
            );
            dynamicTools.set(tool.name, registered);
          }
        } catch (error) {
          console.error(`[mcpServer] Failed to register/update dynamic tool ${tool.name}:`, error);
        }
      }

      // Notify connected client
      try {
        server.sendToolListChanged();
      } catch {
        // Ignore if not connected
      }
    }
  };

  // Register listener on the bridge server
  let listeners = (bridgeServer as any)[serverListenersKey];
  if (!listeners) {
    listeners = new Set();
    (bridgeServer as any)[serverListenersKey] = listeners;
    bridgeServer.onToolsChanged = (tools) => {
      for (const l of listeners) {
        try {
          l.updateTools(tools);
        } catch (error) {
          console.error("[mcpServer] Error updating tools for listener:", error);
        }
      }
    };
  }
  listeners.add(listener);

  // Clean up listener when server is closed to prevent memory leaks
  const originalClose = server.close.bind(server);
  server.close = async () => {
    listeners.delete(listener);
    await originalClose();
  };

  // Proactively request the tool list on startup (in case the extension is already connected)
  try {
    bridgeServer.requestToolsList();
  } catch (error) {
    console.warn("[mcpServer] Failed to request dynamic tools list on startup:", error);
  }

  return server;
}
