#!/usr/bin/env node

import { LoopbackBridgeServer } from "./bridgeServer.js";
import { createServerRuntimeConfig } from "./config.js";
import { writePairingFile } from "./pairing.js";

async function main(): Promise<void> {
  const config = createServerRuntimeConfig();
  const bridgeServer = new LoopbackBridgeServer(config);
  const wsUrl = await bridgeServer.start();
  await writePairingFile(config, wsUrl);

  console.error(
    `[agentic-browser-mcp] native bridge daemon listening on ${wsUrl}; pairing file: ${config.pairingFilePath}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[agentic-browser-mcp] native bridge daemon shutting down after ${signal}`);
    await bridgeServer.close();
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
  console.error(`[agentic-browser-mcp] native bridge daemon fatal startup error\n${message}`);
  process.exit(1);
});
