/**
 * Template Resolver — Node.js-native symbol resolution for standalone mode.
 *
 * Parses {{symbol}} expressions in URL, header, and body templates and resolves
 * them from agent-provided arguments or environment variables.
 *
 * Supported symbols:
 *   {{paramName}}                   → agent-provided argument
 *   {{args:paramName}}              → agent-provided argument (explicit prefix)
 *   {{env:VAR}}                     → process.env[VAR]
 *
 * Unsupported (browser-only) symbols that gracefully degrade to empty string:
 *   {{cookie:domain:name}}
 *   {{localStorage:origin:key}}
 *   {{sessionStorage:origin:key}}
 *   {{storage:key}}
 *   {{prompt:label}}
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
]);

/**
 * Parse a template string and return all {{...}} symbols found.
 */
export function parseSymbols(template: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let match: RegExpExecArray | null;

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
  /** Parsed JSON Schema for the tool's input — used for schema-aware body serialization. */
  inputSchema?: Record<string, unknown>;
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
 * Agent parameters are filled from the provided args.
 * env symbols are resolved directly from process.env.
 * Browser symbols (cookie, localStorage, etc.) resolve to empty string with a warning.
 */
export function resolveTemplate(
  template: string,
  context: SymbolResolutionContext,
  isUrl: boolean = false,
  isJsonBody: boolean = false,
): string {
  const symbols = parseSymbols(template);

  if (symbols.length === 0) {
    return template;
  }

  // Resolve all symbols
  const resolutions = symbols.map((symbol) => {
    let value = resolveSymbol(symbol, context);

    if (isUrl) {
      // URL-encode the resolved value if it's part of the path or query string.
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
  });

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
        if (isWrappedInQuotes) {
          if (typeof originalVal === "string") {
            // Escape double quotes and backslashes for insertion inside double quotes
            const escaped = JSON.stringify(originalVal).slice(1, -1);
            result = result.slice(0, symbol.start) + escaped + result.slice(symbol.end);
          } else {
            // For numbers, booleans, objects, arrays:
            // Strip the wrapping double quotes and substitute JSON-stringified representation
            const serialized = JSON.stringify(originalVal);
            result = result.slice(0, symbol.start - 1) + serialized + result.slice(symbol.end + 1);
          }
        } else {
          // If not wrapped in quotes, insert JSON-stringified value directly.
          // Schema-aware: if schema declares type="string" but value is object/array,
          // double-stringify to produce an escaped JSON string (e.g. "{\"k\":true}").
          const schemaInfo = lookupName ? getSchemaPropertyType(context.inputSchema, lookupName) : undefined;
          if (schemaInfo?.type === "string" && typeof originalVal !== "string") {
            const serialized = JSON.stringify(JSON.stringify(originalVal));
            result = result.slice(0, symbol.start) + serialized + result.slice(symbol.end);
          } else {
            const serialized = JSON.stringify(originalVal);
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

function resolveSymbol(
  symbol: ParsedSymbol,
  context: SymbolResolutionContext,
): string {
  if (isAgentParameter(symbol)) {
    const paramName = symbol.args[0]!;
    let value = context.agentArgs[paramName];
    if (value === undefined && paramName.startsWith("args:")) {
      const shortName = paramName.slice("args:".length);
      value = context.agentArgs[shortName];
    }
    if (value === undefined || value === null) {
      console.warn(`[standalone] Agent parameter "${paramName}" not provided, using empty string.`);
      return "";
    }
    return String(value);
  }

  switch (symbol.type) {
    case "env":
      return resolveEnvSymbol(symbol.args);
    case "cookie":
    case "localStorage":
    case "sessionStorage":
    case "storage":
      console.warn(
        `[standalone] Browser symbol {{${symbol.type}:${symbol.args.join(":")}}} is not available in standalone mode. Resolving to empty string.`,
      );
      return "";
    case "prompt":
      console.warn(`[standalone] {{prompt:...}} is not supported in standalone mode. Resolving to empty string.`);
      return "";
    default:
      console.warn(`[standalone] Unknown symbol type: ${symbol.type}`);
      return "";
  }
}

// ─── Environment Variable Resolution ─────────────────────────────────────────

function resolveEnvSymbol(args: string[]): string {
  const [varName] = args;

  if (!varName) {
    console.warn("[standalone] env symbol missing variable name");
    return "";
  }

  const value = process.env[varName];
  if (value === undefined) {
    console.warn(`[standalone] Environment variable "${varName}" is not set, using empty string.`);
    return "";
  }

  return value;
}
