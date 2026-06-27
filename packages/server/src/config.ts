import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_DISCOVERY_HOST,
  DEFAULT_DISCOVERY_PORT_RANGE_END,
  DEFAULT_DISCOVERY_PORT_RANGE_START,
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  PAIRING_FILE_NAME,
  PortRangeSchema,
  type PairingAuthMode,
  type PortRange,
} from "@agentic-browser-mcp/shared";

const DEFAULT_PAIRING_SUBDIRECTORY = ".agentic-browser-mcp";
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ServerRuntimeConfig {
  readonly serverInstanceId: string;
  readonly host: string;
  readonly port?: number;
  readonly portRange: PortRange;
  readonly authMode: PairingAuthMode;
  readonly openPairingTab: boolean;
  readonly pairingBrowser?: string;
  readonly token?: string;
  readonly heartbeatIntervalMs: number;
  readonly toolTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly pairingDirectory: string;
  readonly pairingFilePath: string;
  readonly pairingExpiresAt: string;
}

export function createServerRuntimeConfig(): ServerRuntimeConfig {
  const pairingDirectory =
    process.env.AGENTIC_BROWSER_MCP_PAIRING_DIR?.trim() ||
    path.join(homedir(), DEFAULT_PAIRING_SUBDIRECTORY);
  const pairingFilePath = path.join(pairingDirectory, PAIRING_FILE_NAME);
  const pairingTtlMs = readPositiveInteger(
    process.env.AGENTIC_BROWSER_MCP_TOKEN_TTL_MS,
    DEFAULT_TOKEN_TTL_MS,
  );
  const port = readOptionalNonNegativeInteger(process.env.AGENTIC_BROWSER_MCP_PORT);
  const portRange = resolvePortRange(process.env.AGENTIC_BROWSER_MCP_PORT_RANGE);
  const authMode = readAuthMode(process.env.AGENTIC_BROWSER_MCP_AUTH_MODE);
  const openPairingTab = readOpenPairingTab(process.env.AGENTIC_BROWSER_MCP_OPEN_PAIRING_TAB, authMode);
  const pairingBrowser = readOptionalString(process.env.AGENTIC_BROWSER_MCP_PAIRING_BROWSER);
  const tokenFromEnvironment = process.env.AGENTIC_BROWSER_MCP_AUTH_TOKEN?.trim();

  return {
    serverInstanceId: randomUUID(),
    host: process.env.AGENTIC_BROWSER_MCP_HOST?.trim() || DEFAULT_DISCOVERY_HOST,
    port,
    portRange,
    authMode,
    openPairingTab,
    pairingBrowser,
    token:
      authMode === "token"
        ? tokenFromEnvironment && tokenFromEnvironment.length >= 32
          ? tokenFromEnvironment
          : randomBytes(32).toString("hex")
        : undefined,
    heartbeatIntervalMs: readPositiveInteger(
      process.env.AGENTIC_BROWSER_MCP_HEARTBEAT_MS,
      DEFAULT_BRIDGE_HEARTBEAT_MS,
    ),
    toolTimeoutMs: readPositiveInteger(
      process.env.AGENTIC_BROWSER_MCP_TOOL_TIMEOUT_MS,
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    handshakeTimeoutMs: readPositiveInteger(
      process.env.AGENTIC_BROWSER_MCP_HANDSHAKE_TIMEOUT_MS,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ),
    pairingDirectory,
    pairingFilePath,
    pairingExpiresAt: new Date(Date.now() + pairingTtlMs).toISOString(),
  };
}

function readPositiveInteger(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const value = Number.parseInt(input, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readOptionalNonNegativeInteger(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }

  const value = Number.parseInt(input, 10);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readAuthMode(input: string | undefined): PairingAuthMode {
  return input === "token" ? "token" : "loopback";
}

function resolvePortRange(input: string | undefined): PortRange {
  const defaultPortRange = PortRangeSchema.parse({
    start: DEFAULT_DISCOVERY_PORT_RANGE_START,
    end: DEFAULT_DISCOVERY_PORT_RANGE_END,
  });

  if (!input) {
    return defaultPortRange;
  }

  const trimmed = input.trim();
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (!match) {
    return defaultPortRange;
  }

  const [, startText = "", endText = ""] = match;
  const start = Number.parseInt(startText, 10);
  const end = Number.parseInt(endText, 10);

  try {
    return PortRangeSchema.parse({ start, end });
  } catch {
    return defaultPortRange;
  }
}

function readOpenPairingTab(input: string | undefined, authMode: PairingAuthMode): boolean {
  const normalized = input?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "always") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "never") {
    return false;
  }

  return authMode === "token";
}

function readOptionalString(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed ? trimmed : undefined;
}
