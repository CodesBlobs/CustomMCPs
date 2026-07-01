/// <reference types="chrome" />

/**
 * HTTP Proxy — resolves tool templates, injects auth, sends requests
 * to the native host for execution, and returns the response.
 */

import {
  NATIVE_HOST_NAME,
  NativeHostHttpResponseSchema,
  type NativeHostHttpRequest,
  type NativeHostHttpResponse,
} from "@agentic-browser-mcp/shared";

import type { McpToolDefinition } from "./mcpToolStorage.js";
import { resolveTemplate, extractAllParameterNames, type SymbolResolutionContext } from "./symbolResolver.js";

const HTTP_PROXY_TIMEOUT_MS = 30_000;

export interface HttpProxyResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly error?: string;
  readonly requestUrl?: string;
  readonly requestMethod?: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestBody?: string;
}

/**
 * Execute a user-defined MCP tool by resolving all symbol templates,
 * assembling the HTTP request, and proxying it through the native host.
 */
export async function executeHttpTool(
  tool: McpToolDefinition,
  agentArgs: Record<string, unknown>,
): Promise<HttpProxyResult> {
  // Parse inputSchema so resolveTemplate can do schema-aware body serialization
  let parsedInputSchema: Record<string, unknown> | undefined;
  if (tool.inputSchema) {
    try {
      const parsed = JSON.parse(tool.inputSchema);
      if (typeof parsed === "object" && parsed !== null) {
        parsedInputSchema = parsed as Record<string, unknown>;
      }
    } catch { /* ignore malformed inputSchema */ }
  }

  const context: SymbolResolutionContext = {
    agentArgs,
    envVars: {},
    inputSchema: parsedInputSchema,
  };

  // 1. Resolve URL template
  let url = await resolveTemplate(tool.urlTemplate, context, true);

  // 2. Resolve header templates
  const headers: Record<string, string> = {};
  for (const [headerName, headerTemplate] of Object.entries(tool.headerTemplates)) {
    const resolvedName = await resolveTemplate(headerName, context);
    const resolvedValue = await resolveTemplate(headerTemplate, context);
    if (resolvedName && resolvedValue) {
      headers[resolvedName] = resolvedValue;
    }
  }

  // 3. Resolve body template (always treated as JSON)
  let body: string | undefined;
  if (tool.bodyTemplate && tool.bodyTemplate.trim()) {
    body = await resolveTemplate(tool.bodyTemplate, context, false, true);
  }

  // 4. Auto-append unused parameters to query string for GET requests
  if (tool.method === "GET") {
    // Find all parameter names referenced in URL/headers/body templates
    const referencedNames = new Set(
      extractAllParameterNames(
        tool.urlTemplate || "",
        tool.headerTemplates || {},
        tool.bodyTemplate || ""
      ).map((name) => {
        if (name.startsWith("args:")) {
          return name.slice("args:".length);
        }
        return name;
      })
    );

    // Any key in agentArgs that is NOT referenced in the templates should be appended to the URL query string
    const queryParams: string[] = [];
    for (const [key, value] of Object.entries(agentArgs)) {
      if (!referencedNames.has(key) && value !== undefined && value !== null) {
        queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }

    if (queryParams.length > 0) {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${queryParams.join("&")}`;
    }
  }

  // 5. Route to browser-tab fetch, browser navigation, or native host
  const proxyResult = tool.executionMode === "browser-navigation"
    ? await sendViaBrowserNavigation(url)
    : tool.executionMode === "native-host"
    ? await sendToNativeHost({
        kind: "native-host/http-request",
        requestId: crypto.randomUUID(),
        url,
        method: tool.method,
        headers,
        body,
        envResolve: Object.keys(context.envVars ?? {}).length > 0 ? context.envVars : undefined,
      })
    : await sendToBrowserTab(url, tool.method, headers, body);

  return {
    ...proxyResult,
    requestUrl: url,
    requestMethod: tool.method,
    requestHeaders: headers,
    requestBody: body,
  };
}

/**
 * Execute an HTTP request inside a browser tab via chrome.scripting.executeScript.
 * The fetch runs with the tab's origin and Chrome's TLS stack, bypassing bot detection.
 */
async function sendToBrowserTab(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<HttpProxyResult> {
  // Find a tab on the target domain, falling back to the active tab
  let targetTab: chrome.tabs.Tab | undefined;
  try {
    const targetOrigin = new URL(url).origin;
    const tabs = await chrome.tabs.query({});
    targetTab = tabs.find((tab) => {
      if (!tab.url || typeof tab.id !== "number") return false;
      try { return new URL(tab.url).origin === targetOrigin; } catch { return false; }
    });
  } catch { /* invalid URL — fall through to active tab */ }

  if (!targetTab) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTab = activeTab;
  }

  if (!targetTab || typeof targetTab.id !== "number") {
    return { status: 0, statusText: "No Tab", headers: {}, body: "", error: "No browser tab available for browser-fetch execution." };
  }

  // Strip Cookie header — the browser supplies cookies automatically via credentials: "include"
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "cookie") safeHeaders[k] = v;
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: async (
        reqUrl: string,
        reqMethod: string,
        reqHeaders: Record<string, string>,
        reqBody: string | null,
      ): Promise<{ ok: true; status: number; statusText: string; headers: Record<string, string>; body: string } | { ok: false; error: string }> => {
        try {
          const init: RequestInit = { method: reqMethod, headers: reqHeaders, credentials: "include" };
          if (reqBody !== null && reqBody !== "") init.body = reqBody;
          const response = await fetch(reqUrl, init);
          const responseBody = await response.text();
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value: string, name: string) => { responseHeaders[name] = value; });
          return { ok: true, status: response.status, statusText: response.statusText, headers: responseHeaders, body: responseBody };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      args: [url, method, safeHeaders, body ?? null],
    });

    const scriptResult = result?.result;
    if (!scriptResult) return { status: 0, statusText: "Script Error", headers: {}, body: "", error: "Browser fetch script returned no result." };
    if (!scriptResult.ok) return { status: 0, statusText: "Fetch Error", headers: {}, body: "", error: scriptResult.error };
    return { status: scriptResult.status, statusText: scriptResult.statusText, headers: scriptResult.headers, body: scriptResult.body };
  } catch (error) {
    return { status: 0, statusText: "Script Error", headers: {}, body: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Navigate a hidden background tab to the URL and extract the final HTML.
 * The browser performs a real navigation so Cloudflare managed challenges run
 * and resolve transparently (including setting cf_clearance), and Sec-Fetch-*
 * headers are set correctly by the browser.
 */
async function sendViaBrowserNavigation(url: string): Promise<HttpProxyResult> {
  let tabId: number | undefined;

  try {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    tabId = tab.id!;

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`Navigation timed out after ${HTTP_PROXY_TIMEOUT_MS}ms`));
      }, HTTP_PROXY_TIMEOUT_MS);

      const listener = (
        updatedTabId: number,
        info: { status?: string },
        updatedTab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId !== tabId) return;
        // Wait until fully loaded and the URL has changed away from about:blank
        if (info.status === "complete" && updatedTab.url && updatedTab.url !== "about:blank") {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId!, { url }).catch((err) => {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(err);
      });
    });

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabId! },
      func: () => ({
        html: document.documentElement.outerHTML,
        finalUrl: location.href,
        title: document.title,
      }),
    });

    if (!result?.result) {
      return { status: 0, statusText: "Script Error", headers: {}, body: "", error: "Failed to extract page content after navigation." };
    }

    return {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: result.result.html,
    };
  } catch (error) {
    return {
      status: 0,
      statusText: "Navigation Error",
      headers: {},
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tabId !== undefined) {
      try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
    }
  }
}

/**
 * Open a native messaging port, send the HTTP request, and wait for the response.
 */
async function sendToNativeHost(request: NativeHostHttpRequest): Promise<HttpProxyResult> {
  return await new Promise<HttpProxyResult>((resolve, reject) => {
    let settled = false;
    let port: chrome.runtime.Port | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      if (port) {
        port.onMessage.removeListener(handleMessage);
        port.onDisconnect.removeListener(handleDisconnect);
        try {
          port.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }

      callback();
    };

    const handleMessage = (message: unknown): void => {
      const parsed = NativeHostHttpResponseSchema.safeParse(message);
      if (parsed.success && parsed.data.requestId === request.requestId) {
        finish(() => {
          resolve({
            status: parsed.data.status,
            statusText: parsed.data.statusText,
            headers: parsed.data.headers,
            body: parsed.data.body,
            error: parsed.data.error,
          });
        });
        return;
      }

      // Check if it's an error response from the native host
      if (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        (message as { kind: string }).kind === "native-host/error"
      ) {
        const errorMessage =
          "message" in message ? String((message as { message: unknown }).message) : "Native host error";
        finish(() => {
          resolve({
            status: 0,
            statusText: "Native Host Error",
            headers: {},
            body: "",
            error: errorMessage,
          });
        });
        return;
      }
    };

    const handleDisconnect = (): void => {
      const message = chrome.runtime.lastError?.message ?? "Native host disconnected.";
      finish(() => {
        resolve({
          status: 0,
          statusText: "Disconnected",
          headers: {},
          body: "",
          error: message,
        });
      });
    };

    const timeoutId = setTimeout(() => {
      finish(() => {
        resolve({
          status: 0,
          statusText: "Timeout",
          headers: {},
          body: "",
          error: `HTTP proxy timed out after ${HTTP_PROXY_TIMEOUT_MS}ms`,
        });
      });
    }, HTTP_PROXY_TIMEOUT_MS);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      finish(() => {
        resolve({
          status: 0,
          statusText: "Connection Failed",
          headers: {},
          body: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    port.postMessage(request);
  });
}
