#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { PairingFileSchema } from "@agentic-browser-mcp/shared";

import { LoopbackBridgeServer } from "./bridgeServer.js";
import { createServerRuntimeConfig } from "./config.js";
import { createMcpBrowserServer } from "./mcpServer.js";
import { writePairingFile } from "./pairing.js";
import { openPairingTab } from "./pairingTab.js";

// ─── Process-level error handlers ─────────────────────────────────────────────
// Prevent the process from silently dying on unhandled errors.
process.on("uncaughtException", (error) => {
  console.error("[agentic-browser-mcp] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[agentic-browser-mcp] unhandled rejection:", reason);
});

function canReachSocket(wsUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const parsedUrl = new URL(wsUrl);
      const port = Number.parseInt(parsedUrl.port || "80", 10);
      const host = parsedUrl.hostname;

      const socket = net.createConnection({ host, port });
      socket.setTimeout(300);

      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function killExistingServer(pairingFilePath: string): Promise<void> {
  try {
    const raw = await readFile(pairingFilePath, "utf8");
    const pairing = PairingFileSchema.parse(JSON.parse(raw) as unknown);

    let isRunning = false;
    try {
      process.kill(pairing.serverPid, 0);
      isRunning = true;
    } catch (e: any) {
      if (e.code === "EPERM") {
        isRunning = true;
      }
    }

    if (isRunning && pairing.serverPid !== process.pid) {
      const isReachable = await canReachSocket(pairing.wsUrl);
      if (isReachable) {
        console.error(
          `[agentic-browser-mcp] Terminating conflicting server process with PID ${pairing.serverPid} to free port...`,
        );
        try {
          process.kill(pairing.serverPid, "SIGTERM");
        } catch {
          // Ignore kill errors
        }

        // Wait up to 2 seconds for the process to exit
        for (let i = 0; i < 20; i++) {
          try {
            process.kill(pairing.serverPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch {
            break;
          }
        }
      }
    }
  } catch {
    // Ignore if file doesn't exist, is invalid, or process is already dead
  }
}

async function main(): Promise<void> {
  const config = createServerRuntimeConfig();
  await killExistingServer(config.pairingFilePath);
  const bridgeServer = new LoopbackBridgeServer(config);
  const wsUrl = await bridgeServer.start();
  const pairingFile = await writePairingFile(config, wsUrl);

  // 1. Create and connect Stdio MCP Server (for local process integrations)
  const stdioServer = createMcpBrowserServer(bridgeServer);
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);

  // 2. Setup Express to host SSE and Streamable HTTP endpoints
  const app = express();
  app.use(express.json());

  // Store active SSE connections concurrently using a Map mapped by sessionId
  const sseSessions = new Map<
    string,
    { transport: SSEServerTransport; server: any }
  >();

  // Store active Streamable HTTP sessions — one transport + server per session.
  // The SDK's StreamableHTTPServerTransport is stateful: sharing a single instance
  // across all requests was a root cause of "Transport Closed" errors.
  const streamableSessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: any }
  >();

  // SSE Channel
  app.get("/sse", async (req, res) => {
    try {
      console.error("[mcpServer] SSE client connected to stream");

      // Create a new MCP server instance specifically for this SSE connection
      const sseServer = createMcpBrowserServer(bridgeServer);
      const sseTransport = new SSEServerTransport("/messages", res);
      await sseServer.connect(sseTransport);

      const sessionId = sseTransport.sessionId;
      sseSessions.set(sessionId, { transport: sseTransport, server: sseServer });
      console.error(`[mcpServer] Registered SSE session: ${sessionId}`);

      req.on("close", () => {
        console.error(`[mcpServer] SSE client disconnected (sessionId: ${sessionId})`);
        sseServer.close().catch(() => {});
        sseSessions.delete(sessionId);
      });
    } catch (error) {
      console.error("[mcpServer] SSE connection error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // POST endpoint for SSE messages
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
      console.error("[mcpServer] POST /messages error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // Streamable HTTP endpoint — per-session transport management.
  // Following the SDK's recommended pattern: each initialization request
  // creates a new transport + server pair, subsequent requests reuse by session ID.
  app.post(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && streamableSessions.has(sessionId)) {
        // Reuse existing transport for this session
        await streamableSessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request — create a fresh transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.error(`[mcpServer] Streamable HTTP session initialized: ${newSessionId}`);
            streamableSessions.set(newSessionId, { transport, server });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && streamableSessions.has(sid)) {
            console.error(`[mcpServer] Streamable HTTP transport closed for session ${sid}`);
            streamableSessions.delete(sid);
          }
        };

        const server = createMcpBrowserServer(bridgeServer);
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
      console.error("[mcpServer] Streamable HTTP POST error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Handle GET requests for Streamable HTTP SSE streams
  app.get(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !streamableSessions.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await streamableSessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("[mcpServer] Streamable HTTP GET error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // Handle DELETE requests for Streamable HTTP session termination
  app.delete(/^\/mcp.*/, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !streamableSessions.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await streamableSessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("[mcpServer] Streamable HTTP DELETE error:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  const httpHost = process.env.AGENTIC_BROWSER_MCP_HOST?.trim() || "0.0.0.0";
  const httpPort = Number(process.env.AGENTIC_BROWSER_MCP_HTTP_PORT) || 13001;
  const httpServer = app.listen(httpPort, httpHost, () => {
    console.error(`[agentic-browser-mcp] HTTP transports running:`);
    console.error(`  - SSE endpoint: http://${httpHost === "0.0.0.0" ? "localhost" : httpHost}:${httpPort}/sse`);
    console.error(`  - Streamable HTTP endpoint: http://${httpHost === "0.0.0.0" ? "localhost" : httpHost}:${httpPort}/mcp`);
  });

  let pairingTabUrl: string | undefined;
  if (config.openPairingTab) {
    try {
      pairingTabUrl = await openPairingTab(pairingFile, {
        preferredBrowser: config.pairingBrowser,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agentic-browser-mcp] failed to open pairing tab: ${message}`);
    }
  }

  console.error(
    `[agentic-browser-mcp] bridge listening on ${wsUrl}; discovery range: ${config.portRange.start}-${config.portRange.end}; auth: ${config.authMode}; pairing file: ${config.pairingFilePath}`,
  );
  if (pairingTabUrl) {
    console.error(`[agentic-browser-mcp] pairing tab opened at ${pairingTabUrl}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[agentic-browser-mcp] shutting down after ${signal}`);
    httpServer.close();

    const closePromises = [
      stdioServer.close(),
      bridgeServer.close()
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
  console.error(`[agentic-browser-mcp] fatal startup error\n${message}`);
  process.exit(1);
});
