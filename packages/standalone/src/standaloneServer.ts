/**
 * Standalone MCP Server — registers tools from an exported config file and
 * handles tool calls directly (no bridge or extension required).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  PROTOCOL_VERSION,
  type ExportedConfig,
  type McpToolDefinition,
  type ToolParameter,
} from "@agentic-browser-mcp/shared";

import { executeHttpTool } from "./httpExecutor.js";
import { extractAllParameterNames } from "./templateResolver.js";

// ─── Schema Builders ─────────────────────────────────────────────────────────

function buildZodSchema(parameters: ToolParameter[]) {
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

  const properties = schema.properties || {};
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

// ─── Tool Registration ────────────────────────────────────────────────────────

interface ToolRegistrationResult {
  readonly registered: number;
  readonly skipped: number;
  readonly errors: string[];
}

/**
 * Build a Zod schema for a tool definition, merging the inputSchema with
 * any additional template parameters that aren't declared in the schema.
 */
function buildToolSchema(tool: McpToolDefinition): z.ZodTypeAny {
  // Collect existing params
  const params: ToolParameter[] = [...(tool.parameters || [])];
  const existingNames = new Set(params.map((p) => p.name));

  // Auto-extract from templates
  const templateNames = extractAllParameterNames(
    tool.urlTemplate || "",
    tool.headerTemplates || {},
    tool.bodyTemplate || "",
  );

  for (const rawName of templateNames) {
    let cleanName = rawName;
    if (rawName.startsWith("args:")) {
      cleanName = rawName.slice("args:".length);
    }
    if (!existingNames.has(cleanName)) {
      params.push({
        name: cleanName,
        description: `Template parameter (${rawName})`,
        type: "string",
        required: false,
      });
      existingNames.add(cleanName);
    }
  }

  if (tool.inputSchema) {
    try {
      return buildZodSchemaFromJsonSchema(tool.inputSchema);
    } catch (error) {
      console.error(`[standalone] Failed to build Zod schema from inputSchema for tool ${tool.name}:`, error);
      return buildZodSchema(params);
    }
  }

  return buildZodSchema(params);
}

/**
 * Create an MCP server and register all enabled tools from the exported config.
 */
export function createStandaloneMcpServer(config: ExportedConfig): {
  server: McpServer;
  result: ToolRegistrationResult;
} {
  const server = new McpServer(
    {
      name: "agentic-browser-mcp-standalone",
      version: PROTOCOL_VERSION,
    },
    {
      instructions:
        "Standalone MCP server running custom API endpoints from an exported configuration. " +
        "No Chrome extension is required.",
    },
  );

  const result: ToolRegistrationResult = {
    registered: 0,
    skipped: 0,
    errors: [],
  };
  const mutableResult = result as { registered: number; skipped: number; errors: string[] };

  const registeredNames = new Set<string>();

  for (const serverDef of config.servers) {
    if (!serverDef.enabled) {
      continue;
    }

    for (const tool of serverDef.tools) {
      if (!tool.enabled) {
        mutableResult.skipped++;
        continue;
      }

      // Handle duplicate tool names
      if (registeredNames.has(tool.name)) {
        const msg = `Duplicate tool name "${tool.name}" from server "${serverDef.displayName}" — skipped.`;
        console.warn(`[standalone] ${msg}`);
        mutableResult.errors.push(msg);
        mutableResult.skipped++;
        continue;
      }

      try {
        const schema = buildToolSchema(tool);

        server.registerTool(
          tool.name,
          {
            description: tool.description || `HTTP ${tool.method} tool from ${serverDef.displayName}`,
            inputSchema: schema,
          },
          async (argumentsValue: unknown) => {
            try {
              const proxyResult = await executeHttpTool(
                tool,
                argumentsValue as Record<string, unknown>,
              );

              if (proxyResult.error) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `HTTP error: ${proxyResult.error}`,
                    },
                  ],
                  isError: true,
                };
              }

              let parsedContent: unknown = proxyResult.body;
              if (tool.responseType === "json") {
                try {
                  parsedContent = JSON.parse(proxyResult.body);
                } catch {
                  // Fallback to text if JSON parsing fails
                }
              }

              return {
                content: [
                  {
                    type: "text" as const,
                    text: typeof parsedContent === "string"
                      ? parsedContent
                      : JSON.stringify(parsedContent, null, 2),
                  },
                ],
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Tool execution failed: ${message}`,
                  },
                ],
                isError: true,
              };
            }
          },
        );

        registeredNames.add(tool.name);
        mutableResult.registered++;
      } catch (error) {
        const msg = `Failed to register tool "${tool.name}": ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[standalone] ${msg}`);
        mutableResult.errors.push(msg);
        mutableResult.skipped++;
      }
    }
  }

  return { server, result };
}
