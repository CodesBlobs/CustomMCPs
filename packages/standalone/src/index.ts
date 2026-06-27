#!/usr/bin/env node

/**
 * @agentic-browser-mcp/standalone — CLI entry point.
 *
 * Run an MCP server from an exported browser tool configuration file,
 * without requiring the Chrome extension.
 *
 * Usage:
 *   npx @agentic-browser-mcp/standalone --config ./exported-config.json
 *   agentic-browser-mcp-standalone --config ./my-tools.json --port 8080
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import { ExportedConfigSchema } from "@agentic-browser-mcp/shared";
import { createStandaloneMcpServer } from "./standaloneServer.js";

// ─── Process-level error handlers ─────────────────────────────────────────────
// Prevent the process from silently dying on unhandled errors.
process.on("uncaughtException", (error) => {
  console.error("[standalone] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[standalone] unhandled rejection:", reason);
});

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

interface CliArgs {
  configPath: string;
  port: number;
  host: string;
}

function printUsage(): void {
  console.error(`
Usage: agentic-browser-mcp-standalone --config <path> [options]

Run an MCP server from an exported browser tool configuration file.

Required:
  --config <path>    Path to the exported JSON configuration file

Options:
  --port <number>    HTTP port for SSE/Streamable HTTP transports (default: 13001)
  --host <string>    HTTP host to bind to (default: 0.0.0.0)
  --help             Show this help message

Examples:
  npx @agentic-browser-mcp/standalone --config ./exported-config.json
  agentic-browser-mcp-standalone --config ./my-tools.json --port 8080
`);
}

function parseArgs(argv: string[]): CliArgs | undefined {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let configPath: string | undefined;
  let port = 13001;
  let host = "0.0.0.0";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--config":
        if (!next) {
          console.error("Error: --config requires a file path argument.");
          printUsage();
          return undefined;
        }
        configPath = next;
        i++;
        break;
      case "--port":
        if (!next) {
          console.error("Error: --port requires a number argument.");
          printUsage();
          return undefined;
        }
        port = Number.parseInt(next, 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          console.error(`Error: Invalid port number: ${next}`);
          return undefined;
        }
        i++;
        break;
      case "--host":
        if (!next) {
          console.error("Error: --host requires a string argument.");
          printUsage();
          return undefined;
        }
        host = next;
        i++;
        break;
      default:
        console.error(`Error: Unknown argument: ${arg}`);
        printUsage();
        return undefined;
    }
  }

  if (!configPath) {
    console.error("Error: --config is required.");
    printUsage();
    return undefined;
  }

  return { configPath, port, host };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv);
  if (!cliArgs) {
    process.exit(1);
  }

  // 1. Read and validate config file
  let rawJson: string;
  try {
    const configPath = cliArgs.configPath;
    if (configPath.startsWith("http://") || configPath.startsWith("https://")) {
      console.error(`[standalone] Fetching config from HTTP/HTTPS URL: ${configPath}`);
      const response = await fetch(configPath);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
      }
      rawJson = await response.text();
    } else {
      let localPath = configPath;
      if (configPath.startsWith("file://")) {
        console.error(`[standalone] Parsing config from file URL: ${configPath}`);
        localPath = fileURLToPath(configPath);
      }
      const resolvedPath = path.resolve(localPath);
      console.error(`[standalone] Reading config from file: ${resolvedPath}`);
      rawJson = await readFile(resolvedPath, "utf8");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[standalone] Failed to load config: ${msg}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[standalone] Config file is not valid JSON.");
    process.exit(1);
  }

  const configResult = ExportedConfigSchema.safeParse(parsed);
  if (!configResult.success) {
    console.error("[standalone] Config file does not match expected schema:");
    console.error(configResult.error.message);
    process.exit(1);
  }

  const config = configResult.data;
  const enabledServers = config.servers.filter((s) => s.enabled);
  console.error(
    `[standalone] Config loaded: ${config.servers.length} server(s), ${enabledServers.length} enabled`,
  );

  // 2. Create MCP server with tools from config
  const { server: stdioServer, result: registrationResult } = createStandaloneMcpServer(config);

  console.error(
    `[standalone] Tools registered: ${registrationResult.registered}, skipped: ${registrationResult.skipped}`,
  );
  if (registrationResult.errors.length > 0) {
    for (const err of registrationResult.errors) {
      console.error(`[standalone]   ⚠ ${err}`);
    }
  }

  if (registrationResult.registered === 0) {
    console.error("[standalone] Warning: No tools were registered. The MCP server will have no tools available.");
  }

  // 3. Connect stdio transport
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);

  // 4. Setup Express for SSE and Streamable HTTP endpoints
  const app = express();
  app.use(express.json());

  const sseSessions = new Map<
    string,
    { transport: SSEServerTransport; server: any }
  >();

  // Store active Streamable HTTP sessions — one transport + server per session.
  const streamableSessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: any }
  >();

  app.get("/sse", async (req, res) => {
    try {
      console.error("[standalone] SSE client connected");

      const { server: sseServer } = createStandaloneMcpServer(config);
      const sseTransport = new SSEServerTransport("/messages", res);
      await sseServer.connect(sseTransport);

      const sessionId = sseTransport.sessionId;
      sseSessions.set(sessionId, { transport: sseTransport, server: sseServer });

      req.on("close", () => {
        console.error(`[standalone] SSE client disconnected (sessionId: ${sessionId})`);
        sseServer.close().catch(() => {});
        sseSessions.delete(sessionId);
      });
    } catch (error) {
      console.error("[standalone] SSE connection error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.post("/messages", async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        res.status(400).send("Missing sessionId query parameter");
        return;
      }
      const session = sseSessions.get(sessionId);
      if (!session) {
        res.status(404).send("SSE session not found");
        return;
      }
      await session.transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("[standalone] POST /messages error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // Streamable HTTP endpoint — per-session transport management.
  app.post(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && streamableSessions.has(sessionId)) {
        await streamableSessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.error(`[standalone] Streamable HTTP session initialized: ${newSessionId}`);
            streamableSessions.set(newSessionId, { transport, server });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && streamableSessions.has(sid)) {
            console.error(`[standalone] Streamable HTTP transport closed for session ${sid}`);
            streamableSessions.delete(sid);
          }
        };

        const { server } = createStandaloneMcpServer(config);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
      }
    } catch (error) {
      console.error("[standalone] Streamable HTTP POST error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !streamableSessions.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await streamableSessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("[standalone] Streamable HTTP GET error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.delete(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !streamableSessions.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await streamableSessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("[standalone] Streamable HTTP DELETE error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  const httpServer = app.listen(cliArgs.port, cliArgs.host, () => {
    const displayHost = cliArgs.host === "0.0.0.0" ? "localhost" : cliArgs.host;
    console.error(`[standalone] MCP server running:`);
    console.error(`  ✓ Stdio transport: connected`);
    console.error(`  ✓ SSE endpoint: http://${displayHost}:${cliArgs.port}/sse`);
    console.error(`  ✓ Streamable HTTP endpoint: http://${displayHost}:${cliArgs.port}/mcp`);
    console.error(`  ✓ Tools available: ${registrationResult.registered}`);
  });

  // 6. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[standalone] Shutting down after ${signal}`);
    httpServer.close();

    const closePromises = [
      stdioServer.close(),
    ];
    for (const session of sseSessions.values()) {
      closePromises.push(session.server.close());
    }
    for (const session of streamableSessions.values()) {
      closePromises.push(session.server.close());
    }
    await Promise.allSettled(closePromises);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[standalone] Fatal startup error\n${message}`);
  process.exit(1);
});
