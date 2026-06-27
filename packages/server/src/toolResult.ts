import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { type BridgeError, type ToolResultPayload } from "@agentic-browser-mcp/shared";

export function toMcpToolResult(payload: ToolResultPayload): CallToolResult {
  return {
    content:
      payload.content.length > 0
        ? payload.content.map((item) => ({
            type: "text" as const,
            text: item.text,
          }))
        : buildFallbackContent(payload.data),
    structuredContent: payload.data !== undefined ? { data: payload.data } : undefined,
    isError: payload.ok ? undefined : true,
  };
}

export function bridgeErrorToMcpResult(error: BridgeError): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: `${error.code}: ${error.message}`,
      },
    ],
    structuredContent: {
      error,
    },
    isError: true,
  };
}

function buildFallbackContent(data: unknown): CallToolResult["content"] {
  return [
    {
      type: "text" as const,
      text: data === undefined ? "Tool completed successfully." : JSON.stringify(data, null, 2),
    },
  ];
}

