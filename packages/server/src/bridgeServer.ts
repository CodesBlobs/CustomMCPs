import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { homedir } from "node:os";

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
    await appendFile(LOG_FILE_PATH, `[${timestamp}] [BridgeServer] ${msg}\n`, "utf8");
  } catch {
    // Ignore logging errors
  }
}

import {
  ClientHelloMessageSchema,
  PAIRING_CAPTURE_PATH,
  PROTOCOL_VERSION,
  ServerHelloMessageSchema,
  ToolErrorMessageSchema,
  ToolRequestMessageSchema,
  ToolResultMessageSchema,
  buildLoopbackWsUrl,
  createBridgeError,
  createOfflineBridgeError,
  parseBridgeMessage,
  serializeBridgeMessage,
  type BridgeError,
  type ToolResultPayload,
  type DynamicToolInfo,
  DynamicToolListResponseSchema,
} from "@agentic-browser-mcp/shared";
import WebSocket, { WebSocketServer } from "ws";

import type { ServerRuntimeConfig } from "./config.js";

// Read-only tools that are safe to retry after a timeout.
const RETRYABLE_ON_TIMEOUT = new Set(["list_tabs", "get_page_text"]);

interface PendingToolRequest {
  readonly toolName: string;
  readonly resolve: (value: ToolResultPayload) => void;
  readonly reject: (error: BridgeError) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ActiveBridgeClient {
  readonly socket: WebSocket;
  readonly clientName: string;
  readonly clientVersion: string;
  lastHeartbeatAt: number;
}

export interface BridgeStatus {
  readonly connected: boolean;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly lastHeartbeatAt?: string;
}

export class LoopbackBridgeServer {
  private readonly pendingRequests = new Map<string, PendingToolRequest>();
  private readonly httpServer = createServer((request, response) => {
    this.handleHttpRequest(request, response);
  });
  private readonly websocketServer: WebSocketServer;
  private activeClient?: ActiveBridgeClient;
  private started = false;
  public onToolsChanged?: (tools: DynamicToolInfo[]) => void;

  public constructor(private readonly config: ServerRuntimeConfig) {
    this.websocketServer = new WebSocketServer({
      server: this.httpServer,
      host: config.host,
    });

    this.websocketServer.on("error", () => {
      // The underlying HTTP server already surfaces listen failures to start().
      // Swallow duplicate websocket server errors so port-range fallback can continue.
    });

    this.websocketServer.on("connection", (socket) => {
      this.handleSocketConnection(socket);
    });
  }

  public async start(): Promise<string> {
    if (this.started) {
      throw new Error("Loopback bridge server already started.");
    }

    const candidatePorts =
      typeof this.config.port === "number"
        ? [this.config.port]
        : this.enumerateCandidatePorts(this.config.portRange.start, this.config.portRange.end);

    let listenError: Error | undefined;

    for (const port of candidatePorts) {
      try {
        await this.listenOnPort(port);
        listenError = undefined;
        break;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const errorCode =
          "code" in normalizedError ? (normalizedError as NodeJS.ErrnoException).code : undefined;
        if (errorCode === "EADDRINUSE" || errorCode === "EACCES") {
          listenError = normalizedError;
          continue;
        }

        throw normalizedError;
      }
    }

    if (listenError) {
      throw new Error(
        `Failed to bind the loopback bridge on ${this.config.host} within ${candidatePorts[0]}-${candidatePorts.at(-1)}: ${listenError.message}`,
      );
    }

    this.started = true;

    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback bridge server did not expose a TCP address.");
    }

    return buildLoopbackWsUrl(address.port, this.config.host);
  }

  public getStatus(): BridgeStatus {
    if (!this.activeClient) {
      return { connected: false };
    }

    return {
      connected: true,
      clientName: this.activeClient.clientName,
      clientVersion: this.activeClient.clientVersion,
      lastHeartbeatAt: new Date(this.activeClient.lastHeartbeatAt).toISOString(),
    };
  }

  public async callTool(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<ToolResultPayload> {
    if (!this.activeClient || this.activeClient.socket.readyState !== WebSocket.OPEN) {
      throw createOfflineBridgeError();
    }

    const correlationId = randomUUID();
    const request = ToolRequestMessageSchema.parse({
      type: "tool_request",
      correlationId,
      toolName,
      arguments: argumentsValue,
    });

    return await new Promise<ToolResultPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(
          createBridgeError("TOOL_TIMEOUT", `Timed out waiting for ${toolName}.`, {
            correlationId,
            retryable: RETRYABLE_ON_TIMEOUT.has(toolName),
            details: {
              toolName,
              timeoutMs: this.config.toolTimeoutMs,
            },
          }),
        );
      }, this.config.toolTimeoutMs);

      this.pendingRequests.set(correlationId, {
        toolName,
        resolve,
        reject,
        timeout,
      });

      try {
        this.activeClient?.socket.send(serializeBridgeMessage(request));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(correlationId);
        reject(
          createBridgeError(
            "EXTENSION_OFFLINE",
            "The extension disconnected before the tool request could be sent.",
            {
              correlationId,
              retryable: true,
              details: {
                reason: error instanceof Error ? error.message : String(error),
              },
            },
          ),
        );
      }
    });
  }

  public requestToolsList(): void {
    if (this.activeClient && this.activeClient.socket.readyState === WebSocket.OPEN) {
      console.error(`[bridgeServer] requestToolsList: Sending dynamic_tool_list_request to extension...`);
      try {
        this.activeClient.socket.send(
          serializeBridgeMessage({
            type: "dynamic_tool_list_request",
            correlationId: randomUUID(),
          })
        );
      } catch (error) {
        console.warn("[bridgeServer] Failed to request dynamic tools:", error);
      }
    } else {
      console.error(`[bridgeServer] requestToolsList: Cannot request tools list, no active client is connected.`);
    }
  }

  public async close(): Promise<void> {
    this.rejectPendingRequests(createOfflineBridgeError());

    if (this.activeClient) {
      this.activeClient.socket.terminate();
      this.activeClient = undefined;
    }

    await new Promise<void>((resolve, reject) => {
      this.websocketServer.close((websocketError) => {
        if (websocketError) {
          reject(websocketError);
          return;
        }

        this.httpServer.close((httpError) => {
          if (httpError) {
            reject(httpError);
            return;
          }

          resolve();
        });
      });
    });
  }

  private handleSocketConnection(socket: WebSocket): void {
    let handshakeComplete = false;

    const handshakeTimer = setTimeout(() => {
      if (!handshakeComplete) {
        socket.close(1008, "Handshake timeout");
      }
    }, this.config.handshakeTimeoutMs);

    socket.once("message", (rawMessage) => {
      const messageText = this.normalizeIncomingMessage(rawMessage);

      try {
        const parsed = ClientHelloMessageSchema.parse(parseBridgeMessage(messageText));
        const hello = this.verifyClientHello(parsed);
        handshakeComplete = hello.accepted;
        socket.send(serializeBridgeMessage(hello));

        if (!hello.accepted) {
          clearTimeout(handshakeTimer);
          socket.close(1008, "Handshake rejected");
          return;
        }

        clearTimeout(handshakeTimer);
        this.attachActiveClient(socket, parsed.clientName, parsed.clientVersion);
      } catch {
        const rejection = this.createRejectedServerHello();
        socket.send(serializeBridgeMessage(rejection));
        clearTimeout(handshakeTimer);
        socket.close(1008, "Invalid handshake");
      }
    });
  }

  private attachActiveClient(
    socket: WebSocket,
    clientName: string,
    clientVersion: string,
  ): void {
    if (this.activeClient && this.activeClient.socket !== socket) {
      this.activeClient.socket.close(1012, "Superseded by newer bridge client");
    }

    this.activeClient = {
      socket,
      clientName,
      clientVersion,
      lastHeartbeatAt: Date.now(),
    };

    console.error(`[agentic-browser-mcp] Bridge connected to ${clientName} v${clientVersion}`);

    // Set up WebSocket-level ping/pong to detect dead connections.
    // If the extension process is killed or the network drops, the TCP socket
    // may stay open for minutes without this.
    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        console.error("[bridgeServer] No pong received from extension, terminating stale connection");
        clearInterval(pingInterval);
        socket.terminate();
        return;
      }
      pongReceived = false;
      try {
        socket.ping();
      } catch {
        // Socket already closing
      }
    }, this.config.heartbeatIntervalMs);

    socket.on("pong", () => {
      pongReceived = true;
    });

    // Request dynamic tools on connection
    try {
      socket.send(
        serializeBridgeMessage({
          type: "dynamic_tool_list_request",
          correlationId: randomUUID(),
        })
      );
    } catch (error) {
      console.warn("[bridgeServer] Failed to request dynamic tools on connect:", error);
    }

    socket.on("message", (rawMessage) => {
      this.handleEstablishedMessage(socket, this.normalizeIncomingMessage(rawMessage));
    });

    socket.on("close", () => {
      clearInterval(pingInterval);
      if (this.activeClient?.socket === socket) {
        this.activeClient = undefined;
        this.rejectPendingRequests(createOfflineBridgeError());
      }
    });

    socket.on("error", (error) => {
      console.error("[bridgeServer] WebSocket error:", error);
      if (this.activeClient?.socket === socket) {
        // Use terminate() instead of close() to avoid triggering the close
        // handler twice — the 'close' event fires automatically after terminate.
        socket.terminate();
      }
    });
  }

  private handleEstablishedMessage(socket: WebSocket, rawMessage: string): void {
    if (this.activeClient?.socket !== socket) {
      return;
    }

    try {
      const message = parseBridgeMessage(rawMessage);

      if (message.type === "heartbeat") {
        this.activeClient.lastHeartbeatAt = Date.now();
        return;
      }

      if (message.type === "tool_result") {
        const payload = ToolResultMessageSchema.parse(message);
        void logToFile(`Received tool result: ${JSON.stringify(payload)}`);
        this.resolvePendingRequest(payload.correlationId, payload.result);
        return;
      }

      if (message.type === "tool_error") {
        const payload = ToolErrorMessageSchema.parse(message);
        void logToFile(`Received tool error: ${JSON.stringify(payload)}`);
        this.rejectPendingRequest(payload.correlationId, payload.error);
        return;
      }

      if (message.type === "dynamic_tool_list_response") {
        const payload = DynamicToolListResponseSchema.parse(message);
        console.error(`[bridgeServer] Received dynamic_tool_list_response from extension with ${payload.tools?.length || 0} tools.`);
        if (this.onToolsChanged) {
          this.onToolsChanged(payload.tools);
        }
        return;
      }
    } catch (error) {
      // Don't close the socket for a single malformed message — log and continue.
      // Only a sustained stream of parse failures or a security violation should
      // terminate the connection.
      console.error("[bridgeServer] Failed to parse bridge message, ignoring:", error);
    }
  }

  private verifyClientHello(message: ReturnType<typeof ClientHelloMessageSchema.parse>) {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return this.createRejectedServerHello();
    }

    if (this.config.authMode === "token" && message.token !== this.config.token) {
      return this.createRejectedServerHello();
    }

    return ServerHelloMessageSchema.parse({
      type: "server_hello",
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId: this.config.serverInstanceId,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      accepted: true,
    });
  }

  private createRejectedServerHello() {
    return ServerHelloMessageSchema.parse({
      type: "server_hello",
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId: this.config.serverInstanceId,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      accepted: false,
    });
  }

  private resolvePendingRequest(correlationId: string, result: ToolResultPayload): void {
    const pendingRequest = this.pendingRequests.get(correlationId);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(correlationId);
    pendingRequest.resolve(result);
  }

  private rejectPendingRequest(correlationId: string, error: BridgeError): void {
    const pendingRequest = this.pendingRequests.get(correlationId);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(correlationId);
    pendingRequest.reject(error);
  }

  private rejectPendingRequests(error: BridgeError): void {
    // Atomically snapshot and clear the map to prevent double-rejection if
    // both 'error' and 'close' events fire in quick succession.
    const entries = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();
    for (const [correlationId, pendingRequest] of entries) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject({
        ...error,
        correlationId,
      });
    }
  }

  private normalizeIncomingMessage(rawMessage: WebSocket.RawData): string {
    return typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
  }

  private handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? "/", `http://${this.config.host}`);
    if (request.method === "GET" && requestUrl.pathname === PAIRING_CAPTURE_PATH) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(this.renderPairingPage());
      return;
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("Not found.");
  }

  private renderPairingPage(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agentic Browser MCP Pairing</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f172a;
        color: #e2e8f0;
      }
      main {
        max-width: 40rem;
        padding: 2rem;
        line-height: 1.5;
      }
      code {
        background: rgba(148, 163, 184, 0.2);
        padding: 0.1rem 0.35rem;
        border-radius: 0.25rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Pairing in progress</h1>
      <p>The extension can capture this tab URL and store the local MCP pairing automatically.</p>
      <p>If the tab does not close on its own, make sure the extension is loaded and keep this page open for a moment.</p>
      <p>You can also import the pairing file from <code>${this.config.pairingFilePath}</code>.</p>
    </main>
  </body>
</html>`;
  }

  private enumerateCandidatePorts(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  private async listenOnPort(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.httpServer.off("error", onError);
        resolve();
      };

      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(port, this.config.host);
    });
  }
}
