import { mkdir, writeFile } from "node:fs/promises";

import { PairingFileSchema, PROTOCOL_VERSION, type PairingFile } from "@agentic-browser-mcp/shared";

import type { ServerRuntimeConfig } from "./config.js";

export async function writePairingFile(
  config: ServerRuntimeConfig,
  wsUrl: string,
): Promise<PairingFile> {
  const pairingFile = PairingFileSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    serverInstanceId: config.serverInstanceId,
    serverPid: process.pid,
    wsUrl,
    token: config.token,
    authMode: config.authMode,
    portRange: config.portRange,
    issuedAt: new Date().toISOString(),
    expiresAt: config.pairingExpiresAt,
  });

  await mkdir(config.pairingDirectory, { recursive: true, mode: 0o700 });
  await writeFile(config.pairingFilePath, JSON.stringify(pairingFile, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return pairingFile;
}
