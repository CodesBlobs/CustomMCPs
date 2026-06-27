/**
 * HTTP Executor — resolves tool templates and executes HTTP requests
 * directly via Node.js fetch() in standalone mode.
 */

import type { McpToolDefinition } from "@agentic-browser-mcp/shared";

import {
  resolveTemplate,
  extractAllParameterNames,
  type SymbolResolutionContext,
} from "./templateResolver.js";

const HTTP_TIMEOUT_MS = 30_000;

export interface HttpResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly error?: string;
}

/**
 * Execute a user-defined MCP tool by resolving all symbol templates,
 * assembling the HTTP request, and executing it directly via fetch().
 */
export async function executeHttpTool(
  tool: McpToolDefinition,
  agentArgs: Record<string, unknown>,
): Promise<HttpResult> {
  // Parse inputSchema so resolveTemplate can do schema-aware body serialization
  let parsedInputSchema: Record<string, unknown> | undefined;
  if (tool.inputSchema) {
    try {
      const parsed = JSON.parse(tool.inputSchema);
      if (typeof parsed === "object" && parsed !== null) {
        parsedInputSchema = parsed as Record<string, unknown>;
      }
    } catch { /* ignore malformed inputSchema */ }
  }

  const context: SymbolResolutionContext = {
    agentArgs,
    inputSchema: parsedInputSchema,
  };

  // 1. Resolve URL template
  let url = resolveTemplate(tool.urlTemplate, context, true);

  // 2. Resolve header templates
  const headers: Record<string, string> = {};
  for (const [headerName, headerTemplate] of Object.entries(tool.headerTemplates)) {
    const resolvedName = resolveTemplate(headerName, context);
    const resolvedValue = resolveTemplate(headerTemplate, context);
    if (resolvedName && resolvedValue) {
      headers[resolvedName] = resolvedValue;
    }
  }

  // 3. Resolve body template (always treated as JSON)
  let body: string | undefined;
  if (tool.bodyTemplate && tool.bodyTemplate.trim()) {
    body = resolveTemplate(tool.bodyTemplate, context, false, true);
  }

  // 4. Auto-append unused parameters to query string for GET requests
  if (tool.method === "GET") {
    const referencedNames = new Set(
      extractAllParameterNames(
        tool.urlTemplate || "",
        tool.headerTemplates || {},
        tool.bodyTemplate || "",
      ).map((name) => {
        if (name.startsWith("args:")) {
          return name.slice("args:".length);
        }
        return name;
      }),
    );

    const queryParams: string[] = [];
    for (const [key, value] of Object.entries(agentArgs)) {
      if (!referencedNames.has(key) && value !== undefined && value !== null) {
        queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }

    if (queryParams.length > 0) {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${queryParams.join("&")}`;
    }
  }

  // 5. Execute the HTTP request directly via fetch()
  return await executeRequest(url, tool.method, headers, body);
}

/**
 * Execute an HTTP request using Node.js fetch().
 * Retries once on transient network errors (DNS, connection refused, etc.)
 * but NOT on timeouts (which indicate the server is too slow).
 */
async function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult> {
  const MAX_RETRIES = 1;
  const RETRY_DELAY_MS = 500;

  let lastResult: HttpResult | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          redirect: "follow",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseBody = await response.text();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Timeouts are not retried — the server is too slow, retrying won't help.
        return {
          status: 0,
          statusText: "Timeout",
          headers: {},
          body: "",
          error: `HTTP request timed out after ${HTTP_TIMEOUT_MS}ms`,
        };
      }

      lastResult = {
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: "",
        error: error instanceof Error ? error.message : String(error),
      };
      // Transient network error — retry if attempts remain
    }
  }

  return lastResult!;
}

