#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NativeHostEnsureServerRequestSchema,
  NativeHostHttpRequestSchema,
  NativeHostParseRequestSchema,
  PairingFileSchema,
  type NativeHostHttpRequest,
  type NativeHostHttpResponse,
  type NativeHostParseRequest,
  type NativeHostParseResponse,
  type NativeHostReadyResponse,
  type PairingFile,
} from "@agentic-browser-mcp/shared";

import { createServerRuntimeConfig } from "./config.js";

const BRIDGE_STARTUP_TIMEOUT_MS = 10_000;
const NATIVE_MESSAGE_HEADER_BYTES = 4;
const PAIRING_RETRY_DELAY_MS = 200;
const SOCKET_PROBE_TIMEOUT_MS = 1500;
const PARSE_SCRIPT_TIMEOUT_MS = 30_000;

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

      // Handle "run local parser script" requests
      const parseRequest = NativeHostParseRequestSchema.safeParse(message);
      if (parseRequest.success) {
        await logToFile(`[native-host/parse-request] scriptPath=${parseRequest.data.scriptPath}`);
        const response = await executeParseRequest(parseRequest.data);
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

const NATIVE_MESSAGE_MAX_BYTES = 1_000_000; // Chrome/Edge hard limit is 1,048,576; stay well under

function writeNativeMessage(message: unknown): void {
  let serialized = JSON.stringify(message);

  // If the serialized message is too large, truncate the body field to fit.
  if (Buffer.byteLength(serialized, "utf8") > NATIVE_MESSAGE_MAX_BYTES) {
    if (typeof message === "object" && message !== null && "body" in message) {
      const msg = message as Record<string, unknown>;
      const overhead = Buffer.byteLength(JSON.stringify({ ...msg, body: "" }), "utf8");
      const allowedBodyBytes = NATIVE_MESSAGE_MAX_BYTES - overhead - 20; // small safety margin
      const fullBody = String(msg.body ?? "");
      // Truncate by bytes, not chars, to avoid splitting multi-byte sequences
      const truncated = Buffer.from(fullBody, "utf8").subarray(0, allowedBodyBytes).toString("utf8");
      serialized = JSON.stringify({ ...msg, body: truncated });
    }
  }

  const body = Buffer.from(serialized, "utf8");
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

// Resolved once and cached per type.
let resolvedPythonBin: string | null | undefined = undefined;
let resolvedCurlBin: string | null | undefined = undefined;

async function findPythonBin(): Promise<string | null> {
  if (resolvedPythonBin !== undefined) return resolvedPythonBin;

  const helperScript = path.join(homedir(), ".agentic-browser-mcp", "curl_request.py");
  const candidates = [
    path.join(homedir(), ".agentic-browser-mcp", "venv", "bin", "python3"),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python",
  ];

  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["-c", "import curl_cffi"], { stdio: "ignore" });
      const tid = setTimeout(() => { child.kill(); resolve(false); }, 3000);
      child.once("close", (code) => { clearTimeout(tid); resolve(code === 0); });
      child.once("error", () => { clearTimeout(tid); resolve(false); });
    });
    if (ok) {
      await logToFile(`Using Python + curl_cffi: ${bin} ${helperScript}`);
      resolvedPythonBin = bin;
      return bin;
    }
  }

  resolvedPythonBin = null;
  return null;
}

async function findCurlBin(): Promise<string | null> {
  if (resolvedCurlBin !== undefined) return resolvedCurlBin;

  const candidates = [
    "/usr/bin/curl",
    "/opt/homebrew/bin/curl",
    "curl",
  ];

  for (const bin of candidates) {
    const found = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore" });
      const tid = setTimeout(() => { child.kill(); resolve(false); }, 3000);
      child.once("close", (code) => { clearTimeout(tid); resolve(code === 0); });
      child.once("error", () => { clearTimeout(tid); resolve(false); });
    });
    if (found) {
      await logToFile(`Using curl binary: ${bin}`);
      resolvedCurlBin = bin;
      return bin;
    }
  }

  resolvedCurlBin = null;
  return null;
}

async function executeHttpRequest(
  request: NativeHostHttpRequest,
): Promise<NativeHostHttpResponse> {
  try {
    const url = resolveEnvPlaceholders(request.url, request.envResolve);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[resolveEnvPlaceholders(key, request.envResolve)] =
        resolveEnvPlaceholders(value, request.envResolve);
    }
    const body = request.body
      ? resolveEnvPlaceholders(request.body, request.envResolve)
      : undefined;

    await logToFile(`Executing HTTP Request: method=${request.method} url=${url}`);

    // 1. Try Python + curl_cffi (Chrome TLS impersonation, ARM-native)
    const pythonBin = await findPythonBin();
    if (pythonBin) {
      return await executeHttpRequestViaPython(pythonBin, request.requestId, url, request.method, headers, body);
    }

    // 2. Try system curl (better TLS than Node.js but not Chrome-identical)
    const curlBin = await findCurlBin();
    if (curlBin) {
      return await executeHttpRequestViaCurl(curlBin, request.requestId, url, request.method, headers, body);
    }

    // 3. Fallback: Node.js fetch
    return await executeHttpRequestViaFetch(request.requestId, url, request.method, headers, body);
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

async function executeHttpRequestViaPython(
  pythonBin: string,
  requestId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<NativeHostHttpResponse> {
  const helperScript = path.join(homedir(), ".agentic-browser-mcp", "curl_request.py");
  const payload = JSON.stringify({ url, method, headers, body: body ?? null });

  const rawOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin, [helperScript], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.stdin.write(payload);
    child.stdin.end();

    child.once("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8");
      if (!out && code !== 0) {
        reject(new Error(`Python helper exited ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}`));
      } else {
        resolve(out);
      }
    });
    child.once("error", reject);
  });

  try {
    const parsed = JSON.parse(rawOutput) as { status: number; statusText: string; headers: Record<string, string>; body: string; error: string | null };
    if (parsed.error) {
      return { kind: "native-host/http-response", requestId, status: 0, statusText: "Request Error", headers: {}, body: "", error: parsed.error };
    }
    return { kind: "native-host/http-response", requestId, status: parsed.status, statusText: parsed.statusText, headers: parsed.headers, body: parsed.body };
  } catch {
    return { kind: "native-host/http-response", requestId, status: 0, statusText: "Parse Error", headers: {}, body: "", error: `Bad JSON from Python helper: ${rawOutput.slice(0, 200)}` };
  }
}

async function executeHttpRequestViaCurl(
  curlBin: string,
  requestId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<NativeHostHttpResponse> {
  const args: string[] = [
    "-s",           // silent
    "-i",           // include response headers in output
    "--location",   // follow redirects
    "--compressed", // accept gzip/deflate/br, decompress automatically
    "-X", method,
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }

  if (body !== undefined && body !== "") {
    args.push("--data-raw", body);
  }

  args.push("--", url);

  const rawOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(curlBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.once("close", (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`curl exited with code ${code}: ${errText}`));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    child.once("error", reject);
  });

  return parseCurlOutput(requestId, rawOutput);
}

function parseCurlOutput(requestId: string, raw: string): NativeHostHttpResponse {
  // curl -i may output multiple HTTP response blocks when following redirects.
  // Split on blank lines and find the last block that starts with HTTP/.
  const sections = raw.split(/\r?\n\r?\n/);

  let lastHeaderIdx = -1;
  for (let i = 0; i < sections.length; i++) {
    if (/^HTTP\/[\d.]+\s/i.test(sections[i]!.trimStart())) {
      lastHeaderIdx = i;
    }
  }

  if (lastHeaderIdx === -1) {
    return { kind: "native-host/http-response", requestId, status: 0, statusText: "Parse Error", headers: {}, body: raw, error: "Could not parse curl response headers" };
  }

  const headerBlock = sections[lastHeaderIdx]!;
  const bodyParts = sections.slice(lastHeaderIdx + 1);
  const responseBody = bodyParts.join("\r\n\r\n");

  const lines = headerBlock.split(/\r?\n/);
  const statusLine = lines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)(?:\s+(.*))?/);
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;
  const statusText = statusMatch ? (statusMatch[2]?.trim() ?? "") : "";

  const responseHeaders: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      responseHeaders[name] = value;
    }
  }

  return {
    kind: "native-host/http-response",
    requestId,
    status,
    statusText,
    headers: responseHeaders,
    body: responseBody,
  };
}

async function executeHttpRequestViaFetch(
  requestId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<NativeHostHttpResponse> {
  const response = await fetch(url, {
    method,
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
    requestId,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
  };
}

// ─── Parser Script Handler ─────────────────────────────────────────────────────

// Resolved once and cached: a plain python3/python interpreter, no curl_cffi requirement.
let resolvedGenericPythonBin: string | null | undefined = undefined;

async function findGenericPythonBin(): Promise<string | null> {
  if (resolvedGenericPythonBin !== undefined) return resolvedGenericPythonBin;

  const candidates = [
    path.join(homedir(), ".agentic-browser-mcp", "venv", "bin", "python3"),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python",
  ];

  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore" });
      const tid = setTimeout(() => { child.kill(); resolve(false); }, 3000);
      child.once("close", (code) => { clearTimeout(tid); resolve(code === 0); });
      child.once("error", () => { clearTimeout(tid); resolve(false); });
    });
    if (ok) {
      resolvedGenericPythonBin = bin;
      return bin;
    }
  }

  resolvedGenericPythonBin = null;
  return null;
}

async function executeParseRequest(request: NativeHostParseRequest): Promise<NativeHostParseResponse> {
  const { requestId, scriptPath, input } = request;

  try {
    await access(scriptPath, fsConstants.R_OK);
  } catch {
    return { kind: "native-host/parse-response", requestId, output: "", error: `Parser script not found or not readable: ${scriptPath}` };
  }

  const pythonBin = await findGenericPythonBin();
  if (!pythonBin) {
    return { kind: "native-host/parse-response", requestId, output: "", error: "No Python interpreter found on this machine." };
  }

  await logToFile(`Running parser script: ${pythonBin} ${scriptPath}`);

  try {
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const tid = setTimeout(() => {
        child.kill();
        reject(new Error(`Parser script timed out after ${PARSE_SCRIPT_TIMEOUT_MS}ms`));
      }, PARSE_SCRIPT_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
      child.stdin.write(input);
      child.stdin.end();

      child.once("close", (code) => {
        clearTimeout(tid);
        resolve({
          stdout: Buffer.concat(outChunks).toString("utf8"),
          stderr: Buffer.concat(errChunks).toString("utf8"),
          exitCode: code,
        });
      });
      child.once("error", (err) => {
        clearTimeout(tid);
        reject(err);
      });
    });

    if (exitCode !== 0) {
      return { kind: "native-host/parse-response", requestId, output: stdout, error: stderr.trim() || `Parser script exited with code ${exitCode}` };
    }

    return { kind: "native-host/parse-response", requestId, output: stdout };
  } catch (error) {
    return { kind: "native-host/parse-response", requestId, output: "", error: getErrorMessage(error) };
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
