#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NativeHostEnsureServerRequestSchema,
  NativeHostHttpRequestSchema,
  PairingFileSchema,
  type NativeHostHttpRequest,
  type NativeHostHttpResponse,
  type NativeHostReadyResponse,
  type PairingFile,
} from "@agentic-browser-mcp/shared";

import { createServerRuntimeConfig } from "./config.js";

const BRIDGE_STARTUP_TIMEOUT_MS = 10_000;
const NATIVE_MESSAGE_HEADER_BYTES = 4;
const PAIRING_RETRY_DELAY_MS = 200;
const SOCKET_PROBE_TIMEOUT_MS = 1500;

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
    await appendFile(LOG_FILE_PATH, `[${timestamp}] [NativeHost] ${msg}\n`, "utf8");
  } catch {
    // Ignore logging errors
  }
}

// Headers and bodies can carry injected cookies and tokens, so log only a summary.
function describeMessage(message: unknown): string {
  if (typeof message !== "object" || message === null) {
    return JSON.stringify(message);
  }

  const value = message as Record<string, unknown>;
  if (value.kind === "native-host/http-request") {
    return `http-request ${String(value.requestId)} ${String(value.method)} ${String(value.url)}`;
  }

  if (value.kind === "native-host/http-response") {
    const errorSuffix = value.error ? ` error=${String(value.error)}` : "";
    return `http-response ${String(value.requestId)} status=${String(value.status)}${errorSuffix}`;
  }

  return JSON.stringify(message);
}


async function main(): Promise<void> {
  await logToFile("Native Host process started.");
  for await (const message of readNativeMessages()) {
    try {
      await logToFile(`Received message: ${JSON.stringify(message)}`);
      
      // Handle extension log forwarding
      if (typeof message === "object" && message !== null && (message as any).kind === "native-host/log") {
        await logToFile(`[Extension] ${(message as any).message}`);
        continue;
      }

      // Handle "ensure server" requests
      const ensureRequest = NativeHostEnsureServerRequestSchema.safeParse(message);
      if (ensureRequest.success) {
        const response = await ensureServerReady();
        writeNativeMessage(response);
        continue;
      }

      // Handle HTTP proxy requests
      const httpRequest = NativeHostHttpRequestSchema.safeParse(message);
      if (httpRequest.success) {
        await logToFile(`[native-host/http-request] Payload: ${JSON.stringify(httpRequest.data)}`);
        const response = await executeHttpRequest(httpRequest.data);
        writeNativeMessage(response);
        continue;
      }

      // Unknown message
      await logToFile(`Unknown message: ${JSON.stringify(message)}`);
      writeNativeMessage({
        kind: "native-host/error",
        message: `Unknown message kind: ${JSON.stringify(message)}`,
      });
    } catch (error) {
      const errMsg = getErrorMessage(error);
      await logToFile(`Error in main loop: ${errMsg}`);
      writeNativeMessage({
        kind: "native-host/error",
        message: errMsg,
      });
    }
  }
}

async function ensureServerReady(): Promise<NativeHostReadyResponse> {
  const existingPairing = await readReachablePairingFile();
  if (existingPairing) {
    return {
      kind: "native-host/server-ready",
      pairingFile: existingPairing,
      launched: false,
    };
  }

  launchBridgeDaemon();

  const pairingFile = await waitForReachablePairingFile(BRIDGE_STARTUP_TIMEOUT_MS);
  return {
    kind: "native-host/server-ready",
    pairingFile,
    launched: true,
  };
}

function launchBridgeDaemon(): void {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bridgeDaemonEntryPath = path.join(runtimeDirectory, "bridgeDaemon.js");

  const child = spawn(process.execPath, ["--enable-source-maps", bridgeDaemonEntryPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENTIC_BROWSER_MCP_OPEN_PAIRING_TAB: "never",
    },
  });

  child.unref();
}

async function waitForReachablePairingFile(timeoutMs: number): Promise<PairingFile> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const pairingFile = await readReachablePairingFile();
    if (pairingFile) {
      return pairingFile;
    }

    await sleep(PAIRING_RETRY_DELAY_MS);
  }

  throw new Error("Timed out waiting for the local bridge daemon to become reachable.");
}

async function readReachablePairingFile(): Promise<PairingFile | undefined> {
  const config = createServerRuntimeConfig();

  try {
    const rawPairingFile = await readFile(config.pairingFilePath, "utf8");
    const pairingFile = PairingFileSchema.parse(JSON.parse(rawPairingFile) as unknown);
    if (Date.parse(pairingFile.expiresAt) <= Date.now()) {
      return undefined;
    }

    return (await canReachPairingSocket(pairingFile)) ? pairingFile : undefined;
  } catch {
    return undefined;
  }
}

async function canReachPairingSocket(pairingFile: PairingFile): Promise<boolean> {
  try {
    const socketUrl = new URL(pairingFile.wsUrl);
    const port = Number.parseInt(socketUrl.port || "80", 10);
    if (!Number.isInteger(port) || port <= 0) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({
        host: socketUrl.hostname,
        port,
      });

      const finish = (result: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS);
      socket.once("connect", () => {
        finish(true);
      });
      socket.once("timeout", () => {
        finish(false);
      });
      socket.once("error", () => {
        finish(false);
      });
    });
  } catch {
    return false;
  }
}

async function* readNativeMessages(): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of process.stdin) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, nextChunk]);

    while (buffer.length >= NATIVE_MESSAGE_HEADER_BYTES) {
      const messageLength = buffer.readUInt32LE(0);
      const messageEnd = NATIVE_MESSAGE_HEADER_BYTES + messageLength;
      if (buffer.length < messageEnd) {
        break;
      }

      const serializedMessage = buffer.subarray(NATIVE_MESSAGE_HEADER_BYTES, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      yield JSON.parse(serializedMessage) as unknown;
    }
  }
}

function writeNativeMessage(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(NATIVE_MESSAGE_HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── HTTP Proxy Handler ───────────────────────────────────────────────────────

async function executeHttpRequest(
  request: NativeHostHttpRequest,
): Promise<NativeHostHttpResponse> {
  try {
    // Resolve any __ENV_X__ placeholders in the request
    const url = resolveEnvPlaceholders(request.url, request.envResolve);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[resolveEnvPlaceholders(key, request.envResolve)] =
        resolveEnvPlaceholders(value, request.envResolve);
    }
    const body = request.body
      ? resolveEnvPlaceholders(request.body, request.envResolve)
      : undefined;

    await logToFile(`Executing HTTP Request: method=${request.method} url=${url} headers=${JSON.stringify(headers)} body=${body || ""}`);

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
      redirect: "follow",
    });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      kind: "native-host/http-response",
      requestId: request.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (error) {
    return {
      kind: "native-host/http-response",
      requestId: request.requestId,
      status: 0,
      statusText: "Network Error",
      headers: {},
      body: "",
      error: getErrorMessage(error),
    };
  }
}

/**
 * Replace __ENV_X__ placeholders with their values from process.env.
 */
function resolveEnvPlaceholders(
  value: string,
  envMap?: Record<string, string>,
): string {
  if (!envMap || Object.keys(envMap).length === 0) {
    return value;
  }

  let result = value;
  for (const [placeholder, envVarName] of Object.entries(envMap)) {
    const envValue = process.env[envVarName] ?? "";
    result = result.replaceAll(placeholder, envValue);
  }
  return result;
}

void main().catch((error: unknown) => {
  writeNativeMessage({
    kind: "native-host/error",
    message: getErrorMessage(error),
  });
  process.exit(1);
});
