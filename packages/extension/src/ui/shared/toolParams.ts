/**
 * Derives the parameter list to show when testing a tool: prefers an explicit
 * inputSchema, falls back to declared parameters, then auto-discovers any
 * {{args:name}} symbols referenced in the templates. Ported from the previous
 * sidepanel implementation; reuses extractAllParameterNames from symbolResolver.
 */
import type { McpToolDefinition } from "../../mcpToolStorage.js";
import { extractAllParameterNames } from "../../symbolResolver.js";

export interface DisplayParam {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  format?: string;
}

export function getToolParameters(tool: McpToolDefinition): DisplayParam[] {
  let params: DisplayParam[] = [];

  if (tool.inputSchema) {
    try {
      const schema = JSON.parse(tool.inputSchema);
      if (schema && typeof schema === "object") {
        const properties = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : [];

        for (const [key, prop] of Object.entries(properties)) {
          if (prop && typeof prop === "object") {
            let type: DisplayParam["type"] = "string";
            const propType = (prop as { type?: string }).type;
            if (propType === "number" || propType === "integer") {
              type = "number";
            } else if (propType === "boolean") {
              type = "boolean";
            } else if (propType === "array") {
              type = "array";
            } else if (propType === "object") {
              type = "object";
            }
            params.push({
              name: key,
              type,
              description: (prop as { description?: string }).description || "",
              required: required.includes(key),
              format: (prop as { format?: string }).format,
            });
          }
        }
      }
    } catch {
      // Ignore malformed schema; fall back below.
    }
  }

  if (params.length === 0) {
    params = [...(tool.parameters || [])];
  }

  const templateNames = extractAllParameterNames(
    tool.urlTemplate || "",
    tool.headerTemplates || {},
    tool.bodyTemplate || "",
  );

  const existingNames = new Set(params.map((p) => p.name));
  for (const rawName of templateNames) {
    const cleanName = rawName.startsWith("args:") ? rawName.slice("args:".length) : rawName;
    if (!existingNames.has(cleanName)) {
      params.push({
        name: cleanName,
        type: "string",
        description: `Template parameter (${rawName})`,
        required: false,
      });
      existingNames.add(cleanName);
    }
  }

  return params;
}
