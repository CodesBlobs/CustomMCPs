/// <reference types="chrome" />

/**
 * Symbol Resolver — parses {{symbol}} expressions in templates and resolves
 * them from browser APIs (cookies, localStorage, sessionStorage, chrome.storage)
 * or from agent-provided arguments.
 *
 * Symbol syntax:
 *   {{cookie:domain:name}}          → chrome.cookies.get()
 *   {{cookie:domain:*}}             → chrome.cookies.getAll() → "k=v; k2=v2"
 *   {{localStorage:origin:key}}     → chrome.scripting.executeScript()
 *   {{sessionStorage:origin:key}}   → chrome.scripting.executeScript()
 *   {{storage:key}}                 → chrome.storage.local.get()
 *   {{env:VAR}}                     → placeholder for native host to resolve
 *   {{prompt:label}}                → deferred (not implemented yet — returns empty)
 *   {{paramName}}                   → agent-provided argument
 */

export interface ParsedSymbol {
  /** The full match including braces: "{{cookie:example.com:sid}}" */
  raw: string;
  /** The type prefix, if any: "cookie", "localStorage", etc. */
  type: string | undefined;
  /** The arguments after the type prefix */
  args: string[];
  /** Start index in the original template string */
  start: number;
  /** End index in the original template string */
  end: number;
}

const SYMBOL_REGEX = /\{\{([^}]+)\}\}/g;

const BROWSER_SYMBOL_TYPES = new Set([
  "cookie",
  "localStorage",
  "sessionStorage",
  "storage",
  "env",
  "prompt",
  "jwt",
]);

/**
 * Parse a template string and return all {{...}} symbols found.
 */
export function parseSymbols(template: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let match: RegExpExecArray | null;

  // Reset the regex state for each call
  const regex = new RegExp(SYMBOL_REGEX.source, SYMBOL_REGEX.flags);

  while ((match = regex.exec(template)) !== null) {
    const inner = match[1]!;
    const parts = inner.split(":");
    const firstPart = parts[0]!;

    if (BROWSER_SYMBOL_TYPES.has(firstPart)) {
      symbols.push({
        raw: match[0],
        type: firstPart,
        args: parts.slice(1),
        start: match.index,
        end: match.index + match[0].length,
      });
    } else {
      // No recognized type prefix → agent parameter
      symbols.push({
        raw: match[0],
        type: undefined,
        args: [inner],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return symbols;
}

/**
 * Returns true if the symbol is a browser-resolved symbol (cookie, localStorage, etc.)
 */
export function isBrowserSymbol(symbol: ParsedSymbol): boolean {
  return symbol.type !== undefined;
}

/**
 * Returns true if the symbol is an agent parameter (no type prefix).
 */
export function isAgentParameter(symbol: ParsedSymbol): boolean {
  return symbol.type === undefined;
}

/**
 * Extract all unique agent parameter names from a template string.
 */
export function extractParameterNames(template: string): string[] {
  const symbols = parseSymbols(template);
  const names = new Set<string>();

  for (const symbol of symbols) {
    if (isAgentParameter(symbol)) {
      names.add(symbol.args[0]!);
    }
  }

  return [...names];
}

/**
 * Extract all unique agent parameter names from multiple template strings
 * (URL, headers, body).
 */
export function extractAllParameterNames(
  urlTemplate: string,
  headerTemplates: Record<string, string>,
  bodyTemplate: string,
): string[] {
  const allTemplates = [
    urlTemplate,
    ...Object.values(headerTemplates),
    bodyTemplate,
  ].filter(Boolean);

  const names = new Set<string>();

  for (const template of allTemplates) {
    for (const name of extractParameterNames(template)) {
      names.add(name);
    }
  }

  return [...names];
}

export interface SymbolResolutionContext {
  agentArgs: Record<string, unknown>;
  envVars?: Record<string, string>;
  /** Parsed JSON Schema for the tool's input — used for schema-aware body serialization. */
  inputSchema?: Record<string, unknown>;
}

function stripBoundaryQuotes(value: string): string {
  let normalized = value;

  if (normalized.startsWith('"') || normalized.startsWith("'")) {
    normalized = normalized.slice(1);
  }

  if (normalized.endsWith('"') || normalized.endsWith("'")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Look up the declared type and format for a property in the input schema.
 */
function getSchemaPropertyType(
  inputSchema: Record<string, unknown> | undefined,
  paramName: string,
): { type?: string; format?: string } | undefined {
  if (!inputSchema) return undefined;
  const properties = (inputSchema as Record<string, any>).properties as
    | Record<string, any>
    | undefined;
  if (!properties || !properties[paramName]) return undefined;
  return {
    type: properties[paramName].type,
    format: properties[paramName].format,
  };
}

/**
 * Resolve all symbols in a template string.
 *
 * Browser symbols (cookie, localStorage, etc.) are resolved via Chrome APIs.
 * Agent parameters are filled from the provided args.
 * env symbols are collected into the envVars map for the native host to resolve.
 */
export async function resolveTemplate(
  template: string,
  context: SymbolResolutionContext,
  isUrl: boolean = false,
  isJsonBody: boolean = false,
): Promise<string> {
  const symbols = parseSymbols(template);

  if (symbols.length === 0) {
    return template;
  }

  // Resolve all symbols concurrently
  const resolutions = await Promise.all(
    symbols.map(async (symbol) => {
      let value = await resolveSymbol(symbol, context);

      if (isUrl) {
        // We want to URL-encode the resolved value if it's part of the path or query string.
        let pathStart = -1;
        const protocolEnd = template.indexOf("://");
        if (protocolEnd !== -1) {
          pathStart = template.indexOf("/", protocolEnd + 3);
        } else {
          pathStart = template.indexOf("/");
        }

        const queryStart = template.indexOf("?");

        const isAfterHost = pathStart !== -1 && symbol.start > pathStart;
        const isInQuery = queryStart !== -1 && symbol.start > queryStart;

        if (isAfterHost || isInQuery) {
          value = encodeURIComponent(value);
        }
      }

      return { symbol, value };
    }),
  );

  // When multiple {{cookie:...}} symbols are present, merge and deduplicate them
  // before substitution so we never split on commas inside cookie values.
  const cookieResolutions = resolutions.filter((r) => r.symbol.type === "cookie");
  if (cookieResolutions.length > 1) {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const { value } of cookieResolutions) {
      for (const pair of value.split(/;\s*/)) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const name = trimmed.slice(0, eqIdx).trim();
        if (!seen.has(name)) {
          seen.add(name);
          merged.push(trimmed);
        }
      }
    }
    cookieResolutions[0]!.value = merged.join("; ");
    for (const res of cookieResolutions.slice(1)) {
      // Expand the symbol's start backward to also consume any separator (`, `) before it
      let newStart = res.symbol.start;
      while (newStart > 0 && /[,\s]/.test(template[newStart - 1]!)) newStart--;
      res.symbol.start = newStart;
      res.value = "";
    }
  }

  // Replace symbols in reverse order (to keep indices valid)
  let result = template;
  for (const { symbol, value } of resolutions.reverse()) {
    if (isJsonBody) {
      const isWrappedInQuotes =
        symbol.start > 0 &&
        symbol.end < result.length &&
        result[symbol.start - 1] === '"' &&
        result[symbol.end] === '"';

      let originalVal: unknown = undefined;
      let hasOriginalVal = false;
      let lookupName: string | undefined;

      if (isAgentParameter(symbol)) {
        const paramName = symbol.args[0]!;
        lookupName = paramName;
        if (paramName.startsWith("args:")) {
          lookupName = paramName.slice("args:".length);
        }
        if (context.agentArgs && lookupName in context.agentArgs) {
          originalVal = context.agentArgs[lookupName];
          hasOriginalVal = true;
        }
      }

      if (hasOriginalVal && originalVal !== undefined && originalVal !== null) {
        const normalizedOriginalVal =
          typeof originalVal === "string"
            ? stripBoundaryQuotes(originalVal)
            : originalVal;

        if (isWrappedInQuotes) {
          if (typeof normalizedOriginalVal === "string") {
            // Escape double quotes and backslashes for insertion inside double quotes
            const escaped = JSON.stringify(normalizedOriginalVal).slice(1, -1);
            result = result.slice(0, symbol.start) + escaped + result.slice(symbol.end);
          } else {
            // For numbers, booleans, objects, arrays:
            // Strip the wrapping double quotes and substitute JSON-stringified representation
            const serialized = JSON.stringify(normalizedOriginalVal);
            result = result.slice(0, symbol.start - 1) + serialized + result.slice(symbol.end + 1);
          }
        } else {
          // If not wrapped in quotes, insert JSON-stringified value directly.
          // Schema-aware: if schema declares type="string" but value is object/array,
          // double-stringify to produce an escaped JSON string (e.g. "{\"k\":true}").
          const schemaInfo = lookupName ? getSchemaPropertyType(context.inputSchema, lookupName) : undefined;
          if (schemaInfo?.type === "string" && typeof normalizedOriginalVal !== "string") {
            const serialized = JSON.stringify(JSON.stringify(normalizedOriginalVal));
            result = result.slice(0, symbol.start) + serialized + result.slice(symbol.end);
          } else {
            const serialized = JSON.stringify(normalizedOriginalVal);
            result = result.slice(0, symbol.start) + serialized + result.slice(symbol.end);
          }
        }
        continue;
      } else if (!hasOriginalVal) {
        // Fallback for browser/env symbols which resolve to string value:
        if (isWrappedInQuotes) {
          const escaped = JSON.stringify(value).slice(1, -1);
          result = result.slice(0, symbol.start) + escaped + result.slice(symbol.end);
        } else {
          const serialized = JSON.stringify(value);
          result = result.slice(0, symbol.start) + serialized + result.slice(symbol.end);
        }
        continue;
      }
    }

    result = result.slice(0, symbol.start) + value + result.slice(symbol.end);
  }

  return result;
}

async function resolveSymbol(
  symbol: ParsedSymbol,
  context: SymbolResolutionContext,
): Promise<string> {
  if (isAgentParameter(symbol)) {
    const paramName = symbol.args[0]!;
    let value = context.agentArgs[paramName];
    if (value === undefined && paramName.startsWith("args:")) {
      const shortName = paramName.slice("args:".length);
      value = context.agentArgs[shortName];
    }
    if (value === undefined || value === null) {
      console.warn(`[symbol-resolver] Agent parameter "${paramName}" not provided, using empty string.`);
      return "";
    }
    return stripBoundaryQuotes(String(value));
  }

  switch (symbol.type) {
    case "cookie":
      return stripBoundaryQuotes(await resolveCookieSymbol(symbol.args));
    case "localStorage":
      return stripBoundaryQuotes(await resolveWebStorageSymbol("localStorage", symbol.args));
    case "sessionStorage":
      return stripBoundaryQuotes(await resolveWebStorageSymbol("sessionStorage", symbol.args));
    case "storage":
      return stripBoundaryQuotes(await resolveChromeStorageSymbol(symbol.args));
    case "env":
      return stripBoundaryQuotes(resolveEnvSymbol(symbol.args, context));
    case "prompt":
      console.warn(`[symbol-resolver] {{prompt:...}} not yet implemented, using empty string.`);
      return "";
    case "jwt":
      return stripBoundaryQuotes(await resolveJwtSymbol(symbol.args));
    default:
      console.warn(`[symbol-resolver] Unknown symbol type: ${symbol.type}`);
      return "";
  }
}

// ─── Cookie Resolution ────────────────────────────────────────────────────────

async function resolveCookieSymbol(args: string[]): Promise<string> {
  const [domain, name] = args;

  if (!domain) {
    console.warn("[symbol-resolver] cookie symbol missing domain argument");
    return "";
  }

  if (!name || name === "*") {
    return await resolveAllCookies(domain);
  }

  return await resolveSingleCookie(domain, name);
}

async function resolveSingleCookie(domain: string, name: string): Promise<string> {
  try {
    const url = domain.includes("://") ? domain : `https://${domain}`;
    const cookie = await chrome.cookies.get({ url, name });

    if (cookie) return cookie.value;

    // Partitioned cookies (CHIPS) require partitionKey to be specified
    const partitioned = await chrome.cookies.getAll({ url, name, partitionKey: {} } as chrome.cookies.GetAllDetails);
    if (partitioned.length > 0) return partitioned[0]!.value;

    console.warn(`[symbol-resolver] Cookie "${name}" not found for domain "${domain}"`);
    return "";
  } catch (error) {
    console.warn(`[symbol-resolver] Failed to read cookie "${name}" for "${domain}":`, error);
    return "";
  }
}

async function resolveAllCookies(domain: string): Promise<string> {
  try {
    const url = domain.includes("://") ? domain : `https://${domain}`;

    const [unpartitioned, partitioned] = await Promise.all([
      chrome.cookies.getAll({ url }),
      chrome.cookies.getAll({ url, partitionKey: {} } as chrome.cookies.GetAllDetails),
    ]);

    const unique = [
      ...new Set([...partitioned, ...unpartitioned].map((c) => `${c.name}=${c.value}`)),
    ];

    if (unique.length === 0) {
      console.warn(`[symbol-resolver] No cookies found for domain "${domain}"`);
      return "";
    }

    return unique.join("; ");
  } catch (error) {
    console.warn(`[symbol-resolver] Failed to read cookies for "${domain}":`, error);
    return "";
  }
}

// ─── Web Storage Resolution (localStorage / sessionStorage) ───────────────────

async function resolveWebStorageSymbol(
  storageType: "localStorage" | "sessionStorage",
  args: string[],
): Promise<string> {
  const [originUrl, key] = args;

  if (!originUrl || !key) {
    console.warn(`[symbol-resolver] ${storageType} symbol requires origin URL and key`);
    return "";
  }

  try {
    // Find a tab matching this origin
    const origin = new URL(originUrl.includes("://") ? originUrl : `https://${originUrl}`).origin;
    const tabs = await chrome.tabs.query({});
    const matchingTab = tabs.find((tab) => {
      if (!tab.url || typeof tab.id !== "number") return false;
      try {
        return new URL(tab.url).origin === origin;
      } catch {
        return false;
      }
    });

    if (!matchingTab || typeof matchingTab.id !== "number") {
      console.warn(
        `[symbol-resolver] No open tab found for origin "${origin}". ` +
          `Open a tab to ${origin} and try again.`,
      );
      return "";
    }

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: matchingTab.id },
      func: (type: string, storageKey: string) => {
        const storage = type === "localStorage" ? window.localStorage : window.sessionStorage;
        return storage.getItem(storageKey) ?? "";
      },
      args: [storageType, key],
    });

    return result?.result ?? "";
  } catch (error) {
    console.warn(`[symbol-resolver] Failed to read ${storageType} "${key}":`, error);
    return "";
  }
}

// ─── Chrome Storage Resolution ────────────────────────────────────────────────

async function resolveChromeStorageSymbol(args: string[]): Promise<string> {
  const [key] = args;

  if (!key) {
    console.warn("[symbol-resolver] storage symbol missing key argument");
    return "";
  }

  try {
    const values = await chrome.storage.local.get(key);
    const value = values[key];
    if (value === undefined || value === null) {
      console.warn(`[symbol-resolver] chrome.storage.local key "${key}" not found`);
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (error) {
    console.warn(`[symbol-resolver] Failed to read chrome.storage.local "${key}":`, error);
    return "";
  }
}

// ─── Environment Variable Resolution ─────────────────────────────────────────

function resolveEnvSymbol(args: string[], context: SymbolResolutionContext): string {
  const [varName] = args;

  if (!varName) {
    console.warn("[symbol-resolver] env symbol missing variable name");
    return "";
  }

  // We don't resolve env vars in the extension — we record them for the native host.
  // The native host will substitute them from process.env.
  if (!context.envVars) {
    context.envVars = {};
  }

  // Use a placeholder that the native host knows to replace
  const placeholder = `__ENV_${varName}__`;
  context.envVars[placeholder] = varName;
  return placeholder;
}

async function resolveJwtSymbol(args: string[]): Promise<string> {
  return "";
}
