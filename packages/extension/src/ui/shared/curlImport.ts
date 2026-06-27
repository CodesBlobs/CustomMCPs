import type { McpToolDefinition } from "../../mcpToolStorage.js";

type Method = McpToolDefinition["method"];
type ResponseType = McpToolDefinition["responseType"];

export interface ParsedCurlCommand {
  urlTemplate: string;
  method: Method;
  headerTemplates: Record<string, string>;
  bodyTemplate: string;
  responseType: ResponseType;
  suggestedName: string;
  suggestedDescription: string;
  notes: string[];
}

const DATA_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
]);

const NO_VALUE_FLAGS = new Set([
  "--compressed",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-f",
  "--fail",
  "--fail-with-body",
  "-L",
  "--location",
  "--globoff",
  "-g",
  "-k",
  "--insecure",
  "-i",
  "--include",
  "-v",
  "--verbose",
]);

export function parseCurlCommand(source: string): ParsedCurlCommand {
  const tokens = tokenizeCurl(source);
  if (tokens.length === 0) {
    throw new Error("Paste a cURL command to import.");
  }

  let cursor = 0;
  if (tokens[0] === "curl") {
    cursor = 1;
  }

  let explicitMethod: Method | null = null;
  let urlTemplate = "";
  let forceGet = false;

  const headerTemplates: Record<string, string> = {};
  const bodyParts: string[] = [];
  const getQueryParts: string[] = [];
  const notes: string[] = [];

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;

    if (NO_VALUE_FLAGS.has(token)) {
      cursor += 1;
      continue;
    }

    if (token === "-G" || token === "--get") {
      forceGet = true;
      cursor += 1;
      continue;
    }

    if (token === "-I" || token === "--head") {
      explicitMethod = "GET";
      notes.push("Converted HEAD request to GET because custom tools only support GET/POST/PUT/DELETE/PATCH.");
      cursor += 1;
      continue;
    }

    if (matchesOption(token, "-X", "--request")) {
      const next = readOptionValue(tokens, cursor, "-X", "--request");
      explicitMethod = normalizeMethod(next.value, notes);
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, "-H", "--header")) {
      const next = readOptionValue(tokens, cursor, "-H", "--header");
      applyHeader(next.value, headerTemplates, notes);
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, "-b", "--cookie")) {
      const next = readOptionValue(tokens, cursor, "-b", "--cookie");
      appendHeader(headerTemplates, "Cookie", next.value, "; ");
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, "-A", "--user-agent")) {
      const next = readOptionValue(tokens, cursor, "-A", "--user-agent");
      appendHeader(headerTemplates, "User-Agent", next.value);
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, "-e", "--referer")) {
      const next = readOptionValue(tokens, cursor, "-e", "--referer");
      appendHeader(headerTemplates, "Referer", next.value);
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, "-u", "--user")) {
      const next = readOptionValue(tokens, cursor, "-u", "--user");
      appendHeader(headerTemplates, "Authorization", encodeBasicAuth(next.value, notes));
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, undefined, "--url")) {
      const next = readOptionValue(tokens, cursor, undefined, "--url");
      urlTemplate = next.value;
      cursor = next.nextIndex;
      continue;
    }

    if (matchesOption(token, undefined, "--json")) {
      const next = readOptionValue(tokens, cursor, undefined, "--json");
      appendHeader(headerTemplates, "Content-Type", "application/json");
      appendHeader(headerTemplates, "Accept", "application/json");
      bodyParts.push(next.value);
      cursor = next.nextIndex;
      continue;
    }

    if (DATA_FLAGS.has(token) || matchesDataFlag(token)) {
      const next = readDataValue(tokens, cursor);
      if (forceGet) getQueryParts.push(next.value);
      else bodyParts.push(next.value);
      cursor = next.nextIndex;
      continue;
    }

    if (token === "-F" || token === "--form" || token.startsWith("--form=")) {
      const next = readOptionValue(tokens, cursor, "-F", "--form");
      bodyParts.push(next.value);
      notes.push("Imported multipart form data as plain text. Review the request body before saving.");
      cursor = next.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      notes.push(`Ignored unsupported cURL flag "${token}".`);
      cursor += 1;
      continue;
    }

    if (!urlTemplate) {
      urlTemplate = token;
    } else {
      notes.push(`Ignored extra positional argument "${token}".`);
    }
    cursor += 1;
  }

  if (!urlTemplate) {
    throw new Error("Could not find a request URL in the cURL command.");
  }

  if (getQueryParts.length > 0) {
    urlTemplate = appendQueryParts(urlTemplate, getQueryParts);
  }

  const method = explicitMethod ?? inferMethod(forceGet, bodyParts.length > 0);
  const bodyTemplate = bodyParts.join(bodyParts.length > 1 ? "&" : "");

  return {
    urlTemplate,
    method,
    headerTemplates,
    bodyTemplate,
    responseType: inferResponseType(headerTemplates, urlTemplate),
    suggestedName: suggestToolName(urlTemplate, method),
    suggestedDescription: suggestDescription(urlTemplate, method),
    notes,
  };
}

function tokenizeCurl(source: string): string[] {
  const normalized = source.replace(/\\\r?\n/g, " ").trim();
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === "\"") {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("The cURL command contains an unterminated quoted string.");
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function matchesOption(token: string, shortFlag?: string, longFlag?: string): boolean {
  if (shortFlag && (token === shortFlag || token.startsWith(shortFlag))) {
    return token === shortFlag || token.length > shortFlag.length;
  }
  if (longFlag && (token === longFlag || token.startsWith(`${longFlag}=`))) {
    return true;
  }
  return false;
}

function readOptionValue(
  tokens: string[],
  index: number,
  shortFlag?: string,
  longFlag?: string,
): { value: string; nextIndex: number } {
  const token = tokens[index]!;

  if (shortFlag && token.startsWith(shortFlag) && token !== shortFlag) {
    return { value: token.slice(shortFlag.length), nextIndex: index + 1 };
  }

  if (longFlag && token.startsWith(`${longFlag}=`)) {
    return { value: token.slice(longFlag.length + 1), nextIndex: index + 1 };
  }

  const value = tokens[index + 1];
  if (value === undefined) {
    throw new Error(`Expected a value after "${token}".`);
  }

  return { value, nextIndex: index + 2 };
}

function matchesDataFlag(token: string): boolean {
  return Array.from(DATA_FLAGS).some((flag) => token.startsWith(`${flag}=`));
}

function readDataValue(tokens: string[], index: number): { value: string; nextIndex: number } {
  const token = tokens[index]!;
  for (const flag of DATA_FLAGS) {
    if (token.startsWith(`${flag}=`)) {
      return { value: token.slice(flag.length + 1), nextIndex: index + 1 };
    }
  }
  const next = tokens[index + 1];
  if (next === undefined) {
    throw new Error(`Expected data after "${token}".`);
  }
  return { value: next, nextIndex: index + 2 };
}

function normalizeMethod(value: string, notes: string[]): Method {
  const upper = value.trim().toUpperCase();
  switch (upper) {
    case "GET":
    case "POST":
    case "PUT":
    case "DELETE":
    case "PATCH":
      return upper;
    case "HEAD":
      notes.push("Converted HEAD request to GET because custom tools do not support HEAD.");
      return "GET";
    default:
      notes.push(`Converted unsupported method "${upper}" to POST.`);
      return "POST";
  }
}

function inferMethod(forceGet: boolean, hasBody: boolean): Method {
  if (forceGet) return "GET";
  return hasBody ? "POST" : "GET";
}

function applyHeader(rawHeader: string, headers: Record<string, string>, notes: string[]): void {
  const colonIndex = rawHeader.indexOf(":");
  if (colonIndex < 0) {
    notes.push(`Ignored malformed header "${rawHeader}".`);
    return;
  }

  const key = rawHeader.slice(0, colonIndex).trim();
  const value = rawHeader.slice(colonIndex + 1).trim();
  if (!key) {
    notes.push(`Ignored malformed header "${rawHeader}".`);
    return;
  }

  appendHeader(headers, key, value, key.toLowerCase() === "cookie" ? "; " : ", ");
}

function appendHeader(
  headers: Record<string, string>,
  rawName: string,
  value: string,
  mergeSeparator?: string,
): void {
  const name = normalizeHeaderName(rawName);
  if (!headers[name]) {
    headers[name] = value;
    return;
  }

  headers[name] = mergeSeparator ? `${headers[name]}${mergeSeparator}${value}` : value;
}

function normalizeHeaderName(rawName: string): string {
  return rawName
    .trim()
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function encodeBasicAuth(userValue: string, notes: string[]): string {
  try {
    return `Basic ${btoa(userValue)}`;
  } catch {
    notes.push("Could not encode -u/--user credentials. Review the Authorization header manually.");
    return userValue;
  }
}

function appendQueryParts(urlTemplate: string, parts: string[]): string {
  const hashIndex = urlTemplate.indexOf("#");
  const hash = hashIndex >= 0 ? urlTemplate.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? urlTemplate.slice(0, hashIndex) : urlTemplate;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${parts.join("&")}${hash}`;
}

function inferResponseType(headers: Record<string, string>, urlTemplate: string): ResponseType {
  const accept = headers.Accept?.toLowerCase();
  if (accept?.includes("text/html")) return "html";
  if (accept?.includes("text/plain")) return "text";
  if (/\.(html?)($|\?)/i.test(urlTemplate)) return "html";
  return "json";
}

function suggestToolName(urlTemplate: string, method: Method): string {
  const fallback = `${method.toLowerCase()}_request`;

  try {
    const url = new URL(urlTemplate);
    const pathParts = url.pathname
      .split("/")
      .map((part) => normalizeNamePart(part))
      .filter(Boolean)
      .slice(-3);

    const hostParts = url.hostname
      .split(".")
      .map((part) => normalizeNamePart(part))
      .filter(Boolean);

    const joined = [...pathParts, hostParts.at(-2) ?? hostParts.at(-1) ?? ""]
      .filter(Boolean)
      .join("_");

    return normalizeToolName(joined || fallback);
  } catch {
    return normalizeToolName(urlTemplate || fallback);
  }
}

function suggestDescription(urlTemplate: string, method: Method): string {
  try {
    const url = new URL(urlTemplate);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `Calls ${method} ${url.origin}${path}`;
  } catch {
    return `Calls ${method} ${urlTemplate}`;
  }
}

function normalizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeToolName(value: string): string {
  const normalized = normalizeNamePart(value);
  return normalized || "new_tool";
}
