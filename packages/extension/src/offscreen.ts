/// <reference types="chrome" />

window.onerror = function (message, source, lineno, colno, error) {
  if (error != null) {
    console.error("HTML GLOBAL ERROR", error);
  }
  chrome.runtime.sendMessage({
    kind: "offscreen/log",
    message: `HTML GLOBAL ERROR: ${message} at ${source}:${lineno}:${colno}${error ? `\n${error.stack || error}` : ''}`
  }).catch(() => {});
};
window.addEventListener('unhandledrejection', function (event) {
  chrome.runtime.sendMessage({
    kind: "offscreen/log",
    message: `HTML UNHANDLED REJECTION: ${event.reason}`
  }).catch(() => {});
});

import {
  ClientHelloMessageSchema,
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  PROTOCOL_VERSION,
  ServerHelloMessageSchema,
  ToolRequestMessageSchema,
  buildLoopbackWsUrl,
  createBridgeError,
  parseBridgeMessage,
  serializeBridgeMessage,
  toBridgeError,
  type PairingFile,
  type ServerHelloMessage,
  type ToolErrorMessage,
  type ToolResultMessage,
} from "@agentic-browser-mcp/shared";

import {
  DEFAULT_DISCOVERY_RANGE,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DISCOVERY_HOST,
  EXTENSION_CLIENT_NAME,
  MAX_RECONNECT_DELAY_MS,
  type BridgeEnsureConnectionResponse,
  type BridgeLifecycleMessage,
  type GetPairingStateMessage,
  type PairingStateResponse,
  type ToolRouterErrorResponse,
  type ToolRouterRequestMessage,
  type ToolRouterResponse,
  type ToolRouterSuccessResponse,
} from "./internal.js";

const DISCOVERY_CONNECT_TIMEOUT_MS = 1_500;

interface ConnectionCandidate {
  readonly wsUrl: string;
  readonly protocolVersion: string;
  readonly token?: string;
}

let socket: WebSocket | undefined;
let reconnectAttempts = 0;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let activePairing: PairingFile | undefined;
let heartbeatIntervalMs = DEFAULT_BRIDGE_HEARTBEAT_MS;
let connectionEpoch = 0;

function logToNativeHost(message: string): void {
  chrome.runtime.sendMessage({
    kind: "offscreen/log",
    message,
  }).catch(() => { });
}

void bootstrap();

chrome.runtime.onMessage.addListener((message: any) => {
  logToNativeHost(`Received runtime message: ${message.kind}`);
  if (message.kind === "bridge/ensure-connection" || message.kind === "bridge/pairing-updated") {
    void reconnectNow();
  }

  if (message.kind === "bridge/tools-updated") {
    if (socket && socket.readyState === WebSocket.OPEN) {
      getDynamicToolsResponse(crypto.randomUUID())
        .then((toolsResponse) => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(serializeBridgeMessage(toolsResponse));
          }
        })
        .catch(() => { });
    }
  }

  return false;
});

async function bootstrap(): Promise<void> {
  logToNativeHost("Offscreen bootstrap started");
  await ensureServiceWorkerReady();
  await reconnectNow();
}

async function reconnectNow(): Promise<void> {
  const epoch = ++connectionEpoch;
  logToNativeHost(`reconnectNow called, epoch: ${epoch}`);

  clearReconnectTimer();
  stopHeartbeat();
  closeSocket();

  const pairing = await readStoredPairing();
  logToNativeHost(`Read stored pairing: ${JSON.stringify(pairing)}`);
  if (epoch !== connectionEpoch) {
    return;
  }

  activePairing = pairing;
  await connectFirstAvailable(epoch);
}

async function connectFirstAvailable(epoch: number): Promise<void> {
  const candidates = buildConnectionCandidates(activePairing);
  logToNativeHost(`Building connection candidates: ${JSON.stringify(candidates)}`);
  for (const candidate of candidates) {
    if (epoch !== connectionEpoch) {
      return;
    }

    logToNativeHost(`Trying candidate: ${candidate.wsUrl}`);
    if (await connectCandidate(candidate, epoch)) {
      logToNativeHost(`Successfully connected to candidate: ${candidate.wsUrl}`);
      return;
    }
    logToNativeHost(`Failed to connect to candidate: ${candidate.wsUrl}`);
  }

  if (epoch === connectionEpoch) {
    logToNativeHost("No candidates succeeded, scheduling reconnect.");
    chrome.runtime.sendMessage({ kind: "bridge/check-pairing" }).catch(() => { });
    scheduleReconnect();
  }
}

async function connectCandidate(candidate: ConnectionCandidate, epoch: number): Promise<boolean> {
  let nextSocket: WebSocket;
  try {
    nextSocket = new WebSocket(candidate.wsUrl);
  } catch (err) {
    logToNativeHost(`Error creating WebSocket for ${candidate.wsUrl}: ${err}`);
    return false;
  }
  let settled = false;
  let handshakeComplete = false;

  return await new Promise<boolean>((resolve) => {
    const finish = (connected: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);

      if (!connected) {
        if (nextSocket.readyState === WebSocket.OPEN || nextSocket.readyState === WebSocket.CONNECTING) {
          nextSocket.close();
        }
      }

      resolve(connected);
    };

    const timeoutId = window.setTimeout(() => {
      finish(false);
    }, DISCOVERY_CONNECT_TIMEOUT_MS);

    nextSocket.addEventListener("open", () => {
      if (epoch !== connectionEpoch) {
        finish(false);
        return;
      }

      try {
        const hello = ClientHelloMessageSchema.parse({
          type: "client_hello",
          protocolVersion: candidate.protocolVersion,
          token: candidate.token,
          clientName: EXTENSION_CLIENT_NAME,
          clientVersion: getClientVersion(),
        });

        nextSocket.send(serializeBridgeMessage(hello));
      } catch {
        finish(false);
      }
    });

    nextSocket.addEventListener("message", (event) => {
      if (epoch !== connectionEpoch) {
        finish(false);
        return;
      }

      const rawMessage = String(event.data);

      if (!handshakeComplete) {
        try {
          const hello = ServerHelloMessageSchema.parse(parseBridgeMessage(rawMessage));
          if (!hello.accepted) {
            finish(false);
            return;
          }

          handshakeComplete = true;
          handleServerHello(nextSocket, hello);
          finish(true);
          return;
        } catch {
          finish(false);
          return;
        }
      }

      void handleEstablishedMessage(nextSocket, rawMessage);
    });

    nextSocket.addEventListener("close", () => {
      if (!settled) {
        finish(false);
        return;
      }

      if (socket === nextSocket) {
        stopHeartbeat();
        socket = undefined;
        chrome.runtime.sendMessage({ kind: "bridge/check-pairing" }).catch(() => { });
        scheduleReconnect();
      }
    });

    nextSocket.addEventListener("error", () => {
      if (!settled || socket === nextSocket) {
        nextSocket.close();
      }
    });
  });
}

async function handleEstablishedMessage(currentSocket: WebSocket, rawMessage: string): Promise<void> {
  if (socket !== currentSocket) {
    return;
  }

  try {
    const parsed = parseBridgeMessage(rawMessage);

    if (parsed.type === "heartbeat") {
      return;
    }

    if (parsed.type === "dynamic_tool_list_request") {
      const toolsResponse = await getDynamicToolsResponse(parsed.correlationId);
      logToNativeHost(`Sending dynamic tool list response: ${JSON.stringify(toolsResponse)}`);
      currentSocket.send(serializeBridgeMessage(toolsResponse));
      return;
    }

    const request = ToolRequestMessageSchema.parse(parsed);
    const response = await chrome.runtime.sendMessage<
      ToolRouterRequestMessage,
      ToolRouterResponse
    >({
      kind: "bridge/tool-request",
      request,
    });

    if (!response) {
      throw createBridgeError(
        "TOOL_EXECUTION_FAILED",
        `No response received from the extension service worker for ${request.toolName}.`,
        {
          correlationId: request.correlationId,
          retryable: true,
        },
      );
    }

    if (isToolRouterSuccessResponse(response)) {
      const result: ToolResultMessage = {
        type: "tool_result",
        correlationId: request.correlationId,
        toolName: request.toolName,
        result: response.result,
      };
      currentSocket.send(serializeBridgeMessage(result));
      return;
    }

    if (!isToolRouterErrorResponse(response)) {
      throw createBridgeError(
        "TOOL_EXECUTION_FAILED",
        `Unexpected runtime response received for ${request.toolName}.`,
        {
          correlationId: request.correlationId,
        },
      );
    }

    const error: ToolErrorMessage = {
      type: "tool_error",
      correlationId: request.correlationId,
      toolName: request.toolName,
      error: response.error,
    };
    currentSocket.send(serializeBridgeMessage(error));
  } catch (error) {
    const bridgeError = toBridgeError(error);

    try {
      const parsed = parseBridgeMessage(rawMessage);
      if (parsed.type === "tool_request") {
        const errorMessage: ToolErrorMessage = {
          type: "tool_error",
          correlationId: parsed.correlationId,
          toolName: parsed.toolName,
          error: {
            ...bridgeError,
            correlationId: parsed.correlationId,
          },
        };
        currentSocket.send(serializeBridgeMessage(errorMessage));
        return;
      }
    } catch {
      currentSocket.close();
      return;
    }

    currentSocket.close();
  }
}

function buildConnectionCandidates(pairing: PairingFile | undefined): ConnectionCandidate[] {
  const candidates: ConnectionCandidate[] = [];
  const seenUrls = new Set<string>();
  const protocolVersion = pairing?.protocolVersion ?? PROTOCOL_VERSION;
  const token = pairing?.token;
  const portRange = pairing?.portRange ?? DEFAULT_DISCOVERY_RANGE;

  const addCandidate = (wsUrl: string): void => {
    if (seenUrls.has(wsUrl)) {
      return;
    }

    seenUrls.add(wsUrl);
    candidates.push({
      wsUrl,
      protocolVersion,
      token,
    });
  };

  if (pairing?.wsUrl) {
    addCandidate(pairing.wsUrl);
  }

  for (let port = portRange.start; port <= portRange.end; port += 1) {
    addCandidate(buildLoopbackWsUrl(port, DISCOVERY_HOST));
  }

  return candidates;
}

function handleServerHello(currentSocket: WebSocket, hello: ServerHelloMessage): void {
  socket = currentSocket;
  reconnectAttempts = 0;
  heartbeatIntervalMs = hello.heartbeatIntervalMs;
  startHeartbeat(currentSocket);
}

function startHeartbeat(currentSocket: WebSocket): void {
  stopHeartbeat();

  heartbeatTimer = window.setInterval(() => {
    if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    currentSocket.send(
      serializeBridgeMessage({
        type: "heartbeat",
        timestamp: new Date().toISOString(),
      }),
    );
  }, heartbeatIntervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) {
    return;
  }

  const delayMs = Math.min(
    DEFAULT_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempts += 1;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void reconnectNow();
  }, delayMs);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function closeSocket(): void {
  if (!socket) {
    return;
  }

  const currentSocket = socket;
  socket = undefined;
  currentSocket.close();
}

async function ensureServiceWorkerReady(): Promise<void> {
  const response = await chrome.runtime.sendMessage<
    BridgeLifecycleMessage,
    BridgeEnsureConnectionResponse
  >({
    kind: "bridge/ensure-connection",
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to initialize the extension service worker bridge.");
  }
}

async function readStoredPairing(): Promise<PairingFile | undefined> {
  const response = await chrome.runtime.sendMessage<GetPairingStateMessage, PairingStateResponse>({
    kind: "bridge/get-pairing-state",
  });

  return response?.pairingState?.pairingFile;
}

function isToolRouterSuccessResponse(response: ToolRouterResponse): response is ToolRouterSuccessResponse {
  return response.ok && "result" in response;
}

function isToolRouterErrorResponse(response: ToolRouterResponse): response is ToolRouterErrorResponse {
  return !response.ok && "error" in response;
}

function getClientVersion(): string {
  const runtime = chrome.runtime as typeof chrome.runtime & {
    getManifest?: () => chrome.runtime.Manifest;
  };

  if (typeof runtime.getManifest === "function") {
    return runtime.getManifest().version;
  }

  // Some offscreen runtimes expose messaging APIs but not getManifest().
  return "0.1.0";
}

async function getDynamicToolsResponse(correlationId: string) {
  try {
    const res = await chrome.runtime.sendMessage({ kind: "mcp/get-dynamic-tools" });
    return {
      type: "dynamic_tool_list_response" as const,
      correlationId,
      tools: res?.tools ?? [],
    };
  } catch {
    return {
      type: "dynamic_tool_list_response" as const,
      correlationId,
      tools: [],
    };
  }
}
