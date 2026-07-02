import {
  DEFAULT_DISCOVERY_HOST,
  MVP_TOOL_NAMES,
  NATIVE_HOST_NAME,
  NativeHostErrorResponseSchema,
  NativeHostReadyResponseSchema,
  PAIRING_CAPTURE_PATH,
  ToolArgumentSchemas,
  createBridgeError,
  getErrorMessage,
  parsePairingCaptureUrl,
  toBridgeError,
  type MvpToolName,
  type PairingFile,
  type ToolRequestMessage,
  type ToolResultPayload,
  type DynamicToolInfo,
} from "@agentic-browser-mcp/shared";

import {
  PAIRING_STORAGE_KEY,
  type ExtensionRuntimeMessage,
  type McpDeleteServerMessage,
  type McpDeleteToolMessage,
  type McpImportConfigMessage,
  type McpListToolsMessage,
  type McpSaveServerMessage,
  type McpSaveToolMessage,
  type McpTestToolMessage,
  type McpParseToolOutputMessage,
  type OffscreenLogMessage,
  type PairingUpdatedMessage,
  type ToolRouterRequestMessage,
} from "./internal.js";
import { readStoredPairingState, writeStoredPairingFile } from "./pairingStorage.js";
import {
  listServers,
  saveServer,
  deleteServer,
  listTools,
  getTool,
  saveTool,
  deleteTool,
  exportConfig,
  importConfig,
  findEnabledToolByName,
} from "./mcpToolStorage.js";
import { executeHttpTool, runParserScript } from "./httpProxy.js";
import { extractAllParameterNames } from "./symbolResolver.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const NAVIGATION_TIMEOUT_MS = 15_000;
const NATIVE_HOST_STARTUP_TIMEOUT_MS = 10_000;
const SCREENSHOT_ACTIVATION_DELAY_MS = 150;

let creatingOffscreenDocument: Promise<void> | undefined;
let ensuringNativeHostServer: Promise<void> | undefined;
let hasLoggedNativeHostError = false;

ensureOffscreenDocument().catch(() => {});
ensureNativeHostServerReady().catch(() => {});
void capturePairingFromOpenTabs();

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
  ensureNativeHostServerReady().catch(() => {});
  void capturePairingFromOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
  ensureNativeHostServerReady().catch(() => {});
  void capturePairingFromOpenTabs();
});

// Open the panel UI as a normal tab when the toolbar icon is clicked. If it is
// already open, focus that tab instead of opening a duplicate.
chrome.action.onClicked.addListener(() => {
  const pageUrl = chrome.runtime.getURL("sidepanel.html");
  chrome.tabs.query({ url: pageUrl }, (tabs) => {
    const existing = tabs[0];
    if (existing?.id !== undefined) {
      chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        chrome.windows.update(existing.windowId, { focused: true });
      }
    } else {
      chrome.tabs.create({ url: pageUrl });
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (PAIRING_STORAGE_KEY in changes) {
    const message: PairingUpdatedMessage = {
      kind: "bridge/pairing-updated",
    };
    void chrome.runtime.sendMessage(message).catch(() => {
      // Ignore if the offscreen document is not active yet.
    });
  }

  if ("mcpServers" in changes) {
    void chrome.runtime.sendMessage({
      kind: "bridge/tools-updated",
    }).catch(() => {
      // Ignore if the offscreen document is not active yet.
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.url;
  if (!url) {
    return;
  }

  void capturePairingFromTab(tabId, url);
});

// Each handler resolves with the full response payload. Thrown errors become
// { ok: false, error: string } via the dispatcher below, so handlers only
// catch when they need a different failure shape.
const messageHandlers: Partial<Record<ExtensionRuntimeMessage["kind"], (message: never) => Promise<unknown>>> = {
  "offscreen/log": async (message: OffscreenLogMessage) => {
    console.log(`[Offscreen] ${message.message}`);
    return { ok: true };
  },
  "bridge/ensure-connection": async () => {
    const storedPairingState = await readStoredPairingState().catch(() => undefined);
    const [offscreenResult, nativeHostResult] = await Promise.allSettled([
      ensureOffscreenDocument(),
      ensureNativeHostServerReady(),
    ]);
    const offscreenReady = offscreenResult.status === "fulfilled";
    const nativeHostReady = nativeHostResult.status === "fulfilled";

    if (offscreenResult.status === "rejected") {
      return {
        ok: false,
        offscreenReady,
        nativeHostReady,
        error: `offscreen: ${getErrorMessage(offscreenResult.reason)}`,
      };
    }

    if (nativeHostReady || storedPairingState?.pairingFile) {
      if (nativeHostResult.status === "rejected") {
        console.warn(
          `[agentic-browser-mcp] bridge using stored pairing after native host startup failed: ${getErrorMessage(nativeHostResult.reason)}`,
        );
      }
      return { ok: true, offscreenReady, nativeHostReady };
    }

    return {
      ok: false,
      offscreenReady,
      nativeHostReady,
      error: `native host: ${getErrorMessage((nativeHostResult as PromiseRejectedResult).reason)}`,
    };
  },
  "bridge/get-pairing-state": async () => ({
    ok: true,
    pairingState: await readStoredPairingState().catch(() => undefined),
  }),
  "bridge/check-pairing": async () => {
    try {
      await ensureNativeHostServerReady();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
  "bridge/tool-request": async (message: ToolRouterRequestMessage) => {
    try {
      return { ok: true, result: await routeToolRequest(message.request) };
    } catch (error) {
      return {
        ok: false,
        error: toBridgeError(error, {
          correlationId: message.request.correlationId,
          details: { toolName: message.request.toolName },
        }),
      };
    }
  },
  "mcp/list-servers": async () => ({ ok: true, servers: await listServers() }),
  "mcp/save-server": async (message: McpSaveServerMessage) => ({
    ok: true,
    server: await saveServer(message.server),
  }),
  "mcp/delete-server": async (message: McpDeleteServerMessage) => {
    await deleteServer(message.serverId);
    return { ok: true };
  },
  "mcp/list-tools": async (message: McpListToolsMessage) => ({
    ok: true,
    tools: await listTools(message.serverId),
  }),
  "mcp/save-tool": async (message: McpSaveToolMessage) => ({
    ok: true,
    tool: await saveTool(message.serverId, message.tool),
  }),
  "mcp/delete-tool": async (message: McpDeleteToolMessage) => {
    await deleteTool(message.serverId, message.toolId);
    return { ok: true };
  },
  "mcp/test-tool": async (message: McpTestToolMessage) => {
    const tool = await getTool(message.serverId, message.toolId);
    if (!tool) {
      return { ok: false, error: "Tool not found" };
    }
    return { ok: true, result: await executeHttpTool(tool, message.args) };
  },
  "mcp/export-config": async () => ({ ok: true, json: await exportConfig() }),
  "mcp/import-config": async (message: McpImportConfigMessage) => {
    const res = await importConfig(message.json);
    return { ok: true, imported: res.imported, errors: res.errors };
  },
  "mcp/get-native-host-status": async () => {
    try {
      await connectToNativeHost();
      return { ok: true, available: true };
    } catch (error) {
      return { ok: true, available: false, error: getErrorMessage(error) };
    }
  },
  "mcp/get-dynamic-tools": async () => await handleGetDynamicTools(),
  "mcp/parse-tool-output": async (message: McpParseToolOutputMessage) => {
    const tool = await getTool(message.serverId, message.toolId);
    if (!tool) {
      return { ok: false, error: "Tool not found" };
    }
    if (!tool.parserScriptPath) {
      return { ok: false, error: "This tool has no parser script configured." };
    }
    const result = await runParserScript(tool.parserScriptPath, message.input);
    return { ok: true, output: result.output, error: result.error };
  },
};

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionRuntimeMessage,
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    const handler = messageHandlers[message.kind] as
      | ((message: ExtensionRuntimeMessage) => Promise<unknown>)
      | undefined;
    if (!handler) {
      return false;
    }

    console.log("[agentic-browser-mcp] Received runtime message", message);
    void handler(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: getErrorMessage(error) });
      });

    return true;
  },
);

function logToNativeHost(message: string): void {
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.postMessage({
      kind: "native-host/log",
      message,
    });
    setTimeout(() => {
      try { port.disconnect(); } catch {}
    }, 50);
  } catch {}
}

async function ensureOffscreenDocument(): Promise<void> {
  logToNativeHost("ensureOffscreenDocument called");
  if (creatingOffscreenDocument) {
    return await creatingOffscreenDocument;
  }

  creatingOffscreenDocument = createOffscreenDocumentIfNeeded().finally(() => {
    creatingOffscreenDocument = undefined;
  });

  return await creatingOffscreenDocument;
}

async function ensureNativeHostServerReady(): Promise<void> {
  if (ensuringNativeHostServer) {
    return await ensuringNativeHostServer;
  }

  ensuringNativeHostServer = connectToNativeHost()
    .then(async (response) => {
      hasLoggedNativeHostError = false;
      logToNativeHost("connectToNativeHost succeeded, sync pairing file next.");
      await syncPairingFile(response.pairingFile);
    })
    .catch((error) => {
      if (!hasLoggedNativeHostError) {
        console.warn(
          `[agentic-browser-mcp] native host startup unavailable: ${getErrorMessage(error)}`,
        );
        hasLoggedNativeHostError = true;
      }
      throw error;
    })
    .finally(() => {
      ensuringNativeHostServer = undefined;
    });

  return await ensuringNativeHostServer;
}

async function connectToNativeHost(): Promise<{ readonly pairingFile: PairingFile }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let port: chrome.runtime.Port | undefined;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      if (port) {
        port.onMessage.removeListener(handleMessage);
        port.onDisconnect.removeListener(handleDisconnect);

        try {
          port.disconnect();
        } catch {
          // Ignore disconnect errors if Chrome has already closed the port.
        }
      }

      callback();
    };

    const handleMessage = (message: unknown): void => {
      const readyResponse = NativeHostReadyResponseSchema.safeParse(message);
      if (readyResponse.success) {
        finish(() => {
          resolve(readyResponse.data);
        });
        return;
      }

      const errorResponse = NativeHostErrorResponseSchema.safeParse(message);
      if (errorResponse.success) {
        finish(() => {
          reject(new Error(errorResponse.data.message));
        });
        return;
      }

      finish(() => {
        reject(new Error("Received an unexpected response from the native host."));
      });
    };

    const handleDisconnect = (): void => {
      const message = chrome.runtime.lastError?.message ?? "The native host disconnected.";
      finish(() => {
        reject(new Error(message));
      });
    };

    const timeoutId = setTimeout(() => {
      finish(() => {
        reject(new Error("Timed out waiting for the native host to start the local bridge."));
      });
    }, NATIVE_HOST_STARTUP_TIMEOUT_MS);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      finish(() => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    port.postMessage({
      kind: "native-host/ensure-server",
    });
  });
}

async function createOffscreenDocumentIfNeeded(): Promise<void> {
  const offscreenDocumentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenDocumentUrl],
    });

    if (contexts.length > 0) {
      logToNativeHost("offscreen document contexts already exist");
      return;
    }
  }

  try {
    logToNativeHost(`creating offscreen document at url: ${offscreenDocumentUrl}`);
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Maintain the reconnecting browser bridge outside the MV3 service worker lifecycle.",
    });
    logToNativeHost("offscreen document created successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logToNativeHost(`offscreen creation error: ${message}`);
    if (!message.includes("Only a single offscreen")) {
      throw error;
    }
  }
}

async function capturePairingFromOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number" && typeof tab.url === "string")
      .map((tab) => capturePairingFromTab(tab.id!, tab.url!)),
  );
}

async function capturePairingFromTab(tabId: number, url: string): Promise<void> {
  const pairingFile = parseCapturedPairing(url);
  if (!pairingFile) {
    return;
  }

  await syncPairingFile(pairingFile);

  await chrome.tabs.remove(tabId).catch(() => undefined);
}

function parseCapturedPairing(url: string) {
  const pairingFile = parsePairingCaptureUrl(url);
  if (!pairingFile) {
    return undefined;
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== DEFAULT_DISCOVERY_HOST || parsedUrl.pathname !== PAIRING_CAPTURE_PATH) {
    return undefined;
  }

  const pairingUrl = new URL(pairingFile.wsUrl);
  if (pairingUrl.hostname !== DEFAULT_DISCOVERY_HOST) {
    return undefined;
  }

  if (pairingUrl.protocol !== "ws:") {
    return undefined;
  }

  const pagePort = parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");
  const pairingPort = pairingUrl.port || "80";
  if (pagePort !== pairingPort) {
    return undefined;
  }

  return pairingFile;
}

async function syncPairingFile(pairingFile: PairingFile): Promise<void> {
  const storedState = await readStoredPairingState().catch(() => undefined);
  const currentPairingKey = storedState
    ? JSON.stringify({
        serverInstanceId: storedState.pairingFile.serverInstanceId,
        wsUrl: storedState.pairingFile.wsUrl,
        token: storedState.pairingFile.token,
      })
    : undefined;
  const nextPairingKey = JSON.stringify({
    serverInstanceId: pairingFile.serverInstanceId,
    wsUrl: pairingFile.wsUrl,
    token: pairingFile.token,
  });

  if (currentPairingKey !== nextPairingKey) {
    await writeStoredPairingFile(pairingFile);
  }
}

const mvpToolHandlers: Record<MvpToolName, (request: ToolRequestMessage) => Promise<ToolResultPayload>> = {
  list_tabs: () => handleListTabs(),
  get_page_text: handleGetPageText,
  take_screenshot: handleTakeScreenshot,
  navigate: handleNavigate,
  open_tab: handleOpenTab,
  close_tab: handleCloseTab,
};

function isMvpToolName(toolName: string): toolName is MvpToolName {
  return (MVP_TOOL_NAMES as readonly string[]).includes(toolName);
}

async function routeToolRequest(request: ToolRequestMessage): Promise<ToolResultPayload> {
  if (isMvpToolName(request.toolName)) {
    return await mvpToolHandlers[request.toolName](request);
  }

  // User-defined tool
  const tool = await findEnabledToolByName(request.toolName);
  if (!tool) {
    throw createBridgeError("INVALID_MESSAGE", `Unsupported tool: ${String(request.toolName)}`, {
      correlationId: request.correlationId,
    });
  }

  try {
    const proxyResult = await executeHttpTool(tool, request.arguments);
    if (proxyResult.error) {
      throw new Error(proxyResult.error);
    }

    let parsedContent: unknown = proxyResult.body;
    if (tool.responseType === "json") {
      try {
        parsedContent = JSON.parse(proxyResult.body);
      } catch {
        // Fallback to text if JSON parsing fails
      }
    }

    return {
      ok: true,
      content: [
        {
          type: "text",
          text: typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent, null, 2),
        },
      ],
      data: {
        status: proxyResult.status,
        statusText: proxyResult.statusText,
        headers: proxyResult.headers,
        body: proxyResult.body,
      },
    };
  } catch (error) {
    throw createBridgeError("TOOL_EXECUTION_FAILED", `HTTP tool execution failed: ${getErrorMessage(error)}`, {
      correlationId: request.correlationId,
      details: {
        toolName: request.toolName,
      },
    });
  }
}

async function handleGetDynamicTools(): Promise<{ ok: true; tools: DynamicToolInfo[] }> {
  const servers = await listServers();
  const enabledServers = servers.filter((s) => s.enabled);
  const tools: DynamicToolInfo[] = [];
  for (const server of enabledServers) {
    for (const tool of server.tools) {
      if (tool.enabled) {
        // Collect existing params
        const params = [...(tool.parameters || [])];
        const existingNames = new Set(params.map((p) => p.name));

        // Auto-extract from templates
        const templateNames = extractAllParameterNames(
          tool.urlTemplate || "",
          tool.headerTemplates || {},
          tool.bodyTemplate || ""
        );

        for (const rawName of templateNames) {
          let cleanName = rawName;
          if (rawName.startsWith("args:")) {
            cleanName = rawName.slice("args:".length);
          }
          if (!existingNames.has(cleanName)) {
            params.push({
              name: cleanName,
              description: `Template parameter (${rawName})`,
              type: "string",
              required: false,
            });
            existingNames.add(cleanName);
          }
        }

        tools.push({
          name: tool.name,
          description: tool.description,
          serverId: server.id,
          serverName: server.displayName,
          parameters: params.map((p) => ({
            name: p.name,
            description: p.description,
            type: p.type,
            required: p.required,
          })),
          inputSchema: tool.inputSchema,
        });
      }
    }
  }
  return { ok: true, tools };
}

async function handleListTabs(): Promise<ToolResultPayload> {
  const tabs = await chrome.tabs.query({});
  const items = tabs
    .filter((tab) => typeof tab.id === "number")
    .map((tab) => ({
      id: tab.id!,
      windowId: tab.windowId,
      active: tab.active,
      audible: tab.audible,
      discarded: tab.discarded,
      favIconUrl: tab.favIconUrl,
      incognito: tab.incognito,
      index: tab.index,
      pinned: tab.pinned,
      status: tab.status,
      title: tab.title,
      url: tab.url,
    }));

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Found ${items.length} tab(s).`,
      },
    ],
    data: {
      tabs: items,
    },
  };
}

async function handleGetPageText(request: ToolRequestMessage): Promise<ToolResultPayload> {
  const argumentsValue = ToolArgumentSchemas.get_page_text.parse(request.arguments);
  const tab = await resolveTab(argumentsValue.tabId);
  const tabId = assertTabId(tab, "get_page_text");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text =
        document.body?.innerText?.trim() || document.documentElement?.innerText?.trim() || "";

      return {
        title: document.title,
        url: window.location.href,
        text,
      };
    },
  });

  const page = result?.result;
  if (!page) {
    throw createBridgeError("TOOL_EXECUTION_FAILED", "Failed to read page text.", {
      correlationId: request.correlationId,
      details: { tabId },
    });
  }

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: page.text,
      },
    ],
    data: {
      tab: toTabSummary(tab),
      page,
    },
  };
}

async function handleTakeScreenshot(request: ToolRequestMessage): Promise<ToolResultPayload> {
  const argumentsValue = ToolArgumentSchemas.take_screenshot.parse(request.arguments);
  const tab = await resolveTab(argumentsValue.tabId);
  const tabId = assertTabId(tab, "take_screenshot");

  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  await sleep(SCREENSHOT_ACTIVATION_DELAY_MS);

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: argumentsValue.format,
  });

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Captured a ${argumentsValue.format.toUpperCase()} screenshot for tab ${tabId}.`,
      },
    ],
    data: {
      tab: toTabSummary(tab),
      format: argumentsValue.format,
      dataUrl,
    },
  };
}

async function handleNavigate(request: ToolRequestMessage): Promise<ToolResultPayload> {
  const argumentsValue = ToolArgumentSchemas.navigate.parse(request.arguments);
  const tabId = argumentsValue.tabId;

  await chrome.tabs.update(tabId, { url: argumentsValue.url });
  const updatedTab = await waitForTabToComplete(tabId);

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Navigated tab ${tabId} to ${argumentsValue.url}.`,
      },
    ],
    data: {
      tab: toTabSummary(updatedTab),
    },
  };
}

async function handleOpenTab(request: ToolRequestMessage): Promise<ToolResultPayload> {
  const argumentsValue = ToolArgumentSchemas.open_tab.parse(request.arguments);
  const createdTab = await chrome.tabs.create({
    url: argumentsValue.url,
    active: argumentsValue.active ?? true,
  });

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Opened tab ${createdTab.id ?? "unknown"} at ${argumentsValue.url}.`,
      },
    ],
    data: {
      tab: toTabSummary(createdTab),
    },
  };
}

async function handleCloseTab(request: ToolRequestMessage): Promise<ToolResultPayload> {
  const argumentsValue = ToolArgumentSchemas.close_tab.parse(request.arguments);
  const tab = await chrome.tabs.get(argumentsValue.tabId);

  await chrome.tabs.remove(argumentsValue.tabId);

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Closed tab ${argumentsValue.tabId}.`,
      },
    ],
    data: {
      tab: toTabSummary(tab),
      closed: true,
    },
  };
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === "number") {
    return await chrome.tabs.get(tabId);
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (!activeTab) {
    throw createBridgeError("TOOL_EXECUTION_FAILED", "No active tab is available.", {
      retryable: true,
    });
  }

  return activeTab;
}

function assertTabId(tab: chrome.tabs.Tab, toolName: MvpToolName): number {
  if (typeof tab.id === "number") {
    return tab.id;
  }

  throw createBridgeError("TOOL_EXECUTION_FAILED", `Could not resolve a tab id for ${toolName}.`);
}

function toTabSummary(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    active: tab.active,
    index: tab.index,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
  };
}

async function waitForTabToComplete(tabId: number): Promise<chrome.tabs.Tab> {
  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab.status === "complete") {
    return currentTab;
  }

  return await new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(
        createBridgeError("TOOL_TIMEOUT", `Timed out waiting for tab ${tabId} to finish navigating.`, {
          correlationId: String(tabId),
          retryable: true,
        }),
      );
    }, NAVIGATION_TIMEOUT_MS);

    const handleUpdated = (updatedTabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab);
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
