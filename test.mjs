/**
 * End-to-end test suite for the agentic-browser-mcp server.
 *
 * Tests the full WebSocket bridge ↔ MCP HTTP stack without a real Chrome
 * extension — we simulate the extension side over WebSocket.
 *
 * Run: node test.mjs
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";

// ── helpers ──────────────────────────────────────────────────────────────────

const MCP_URL = "http://localhost:13001/mcp";
const WS_URL = "ws://127.0.0.1:45320";
const PROTO = "phase1-mvp";

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail = "") {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

function assert(condition, label, detail = "") {
  condition ? ok(label) : fail(label, detail);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST to MCP endpoint; returns parsed SSE data payload. */
async function mcpPost(sessionId, body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  // Strip "event: message\ndata: " prefix
  const jsonStr = text.replace(/^(event:[^\n]*\n)?data:\s*/, "").trim();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body: jsonStr ? JSON.parse(jsonStr) : null };
}

/** Open a fresh MCP session; returns sessionId. */
async function openSession() {
  const r = await mcpPost(null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const sessionId = r.sessionId;
  await mcpPost(sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return sessionId;
}

/** Connect a simulated extension. Returns { ws, waitForRequest }. */
function connectExtension(tools = []) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    ws.on("error", reject);

    const send = (msg) => ws.send(JSON.stringify(msg));

    ws.on("open", () => {
      send({ type: "client_hello", protocolVersion: PROTO, clientName: "agentic-browser-mcp-extension", clientVersion: "0.1.0" });
    });

    const pendingToolRequests = new Map(); // correlationId → resolve fn

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "server_hello") {
        if (!msg.accepted) { reject(new Error("server rejected client_hello")); return; }
        return;
      }

      if (msg.type === "dynamic_tool_list_request") {
        send({
          type: "dynamic_tool_list_response",
          correlationId: msg.correlationId,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            serverId: t.serverId ?? "test-server-001",
            serverName: t.serverName ?? "Test Server",
            parameters: t.parameters ?? [],
            inputSchema: t.inputSchema ? JSON.stringify(t.inputSchema) : undefined,
          })),
        });
        // After first tool registration, signal ready
        resolve({ ws, send, pendingToolRequests });
        return;
      }

      if (msg.type === "tool_request") {
        const resolver = pendingToolRequests.get(msg.correlationId);
        if (resolver) {
          pendingToolRequests.delete(msg.correlationId);
          resolver(msg);
        }
        return;
      }
    });

    setTimeout(() => reject(new Error("timeout waiting for dynamic_tool_list_request")), 5_000);
  });
}

/** Register a handler: when a tool_request arrives, call handler(msg) and return the result. */
function handleToolCall(ext, handler) {
  ext.ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "tool_request") return;
    try {
      const result = await handler(msg);
      ext.send({ type: "tool_result", correlationId: msg.correlationId, toolName: msg.toolName, result });
    } catch (err) {
      ext.send({
        type: "tool_error",
        correlationId: msg.correlationId,
        toolName: msg.toolName,
        error: { code: "TOOL_EXECUTION_FAILED", message: err.message, retryable: false },
      });
    }
  });
}

// ── test runner ───────────────────────────────────────────────────────────────

async function run(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (err) {
    fail("unexpected exception", err.message);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

await run("MCP initialize handshake", async () => {
  const r = await mcpPost(null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert(r.status === 200, "HTTP 200");
  assert(!!r.sessionId, "session ID returned");
  assert(r.body?.result?.protocolVersion === "2024-11-05", "protocol version echoed");
  assert(r.body?.result?.capabilities?.tools?.listChanged === true, "tools.listChanged capability");
  assert(r.body?.result?.serverInfo?.name === "agentic-browser-mcp-server", "server name");
});

await run("tools/list with no extension connected returns empty", async () => {
  const sessionId = await openSession();
  const r = await mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert(Array.isArray(r.body?.result?.tools), "tools array present");
  assert(r.body?.result?.tools?.length === 0, "empty when no extension");
});

await run("WebSocket handshake — valid client_hello accepted", async () => {
  const ext = await connectExtension([]);
  assert(ext.ws.readyState === WebSocket.OPEN, "WS still open after handshake");
  ext.ws.close();
  await sleep(100);
});

await run("WebSocket handshake — wrong protocol version rejected", async () => {
  await sleep(200);
  const ws = new WebSocket(WS_URL);
  let gotRejected = false;
  await new Promise((resolve) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "client_hello", protocolVersion: "wrong-version", clientName: "ext", clientVersion: "1.0" }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "server_hello" && msg.accepted === false) gotRejected = true;
      ws.close();
      resolve();
    });
    ws.on("close", resolve);
    setTimeout(resolve, 3000);
  });
  assert(gotRejected, "server rejected bad protocol version");
});

await run("WebSocket handshake — missing clientName rejected", async () => {
  await sleep(200);
  const ws = new WebSocket(WS_URL);
  let gotRejected = false;
  await new Promise((resolve) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "client_hello", protocolVersion: PROTO })); // missing clientName/clientVersion
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "server_hello" && msg.accepted === false) gotRejected = true;
      ws.close();
      resolve();
    });
    ws.on("close", resolve);
    setTimeout(resolve, 3000);
  });
  assert(gotRejected, "server rejected missing required fields");
});

await run("Extension registers multiple tools — all appear in tools/list", async () => {
  await sleep(200);
  const tools = [
    { name: "tool_alpha", description: "Alpha tool", parameters: [{ name: "x", type: "string", required: true }] },
    { name: "tool_beta", description: "Beta tool", parameters: [] },
    { name: "tool_gamma", description: "Gamma tool", parameters: [{ name: "n", type: "number", required: false }] },
  ];
  const ext = await connectExtension(tools);
  await sleep(400);
  const sessionId = await openSession();
  const r = await mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = r.body?.result?.tools?.map((t) => t.name) ?? [];
  assert(names.includes("tool_alpha"), "tool_alpha registered");
  assert(names.includes("tool_beta"), "tool_beta registered");
  assert(names.includes("tool_gamma"), "tool_gamma registered");
  ext.ws.close();
  await sleep(300);
});

await run("Tool call — full round trip (happy path)", async () => {
  await sleep(200);
  const tools = [{
    name: "echo",
    description: "Echoes back its input",
    parameters: [{ name: "text", description: "Text to echo", type: "string", required: true }],
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }];
  const ext = await connectExtension(tools);
  await sleep(300);

  // Set up handler: respond to any tool_request for 'echo'
  handleToolCall(ext, (req) => ({
    ok: true,
    content: [{ type: "text", text: `echo: ${req.arguments.text}` }],
  }));

  const sessionId = await openSession();
  const r = await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "echo", arguments: { text: "hello world" } },
  });

  assert(r.body?.result?.content?.[0]?.text === "echo: hello world", "tool result returned correctly");
  assert(!r.body?.result?.isError, "result is not an error");
  ext.ws.close();
  await sleep(300);
});

await run("Tool call — extension returns error", async () => {
  await sleep(200);
  const tools = [{
    name: "always_fails",
    description: "This tool always errors",
    parameters: [],
  }];
  const ext = await connectExtension(tools);
  await sleep(300);

  handleToolCall(ext, () => { throw new Error("something went wrong inside the extension"); });

  const sessionId = await openSession();
  const r = await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "always_fails", arguments: {} },
  });

  assert(r.body?.result?.isError === true, "MCP result flagged as error");
  const errText = r.body?.result?.content?.[0]?.text ?? "";
  assert(errText.includes("something went wrong"), "error message propagated", errText);
  ext.ws.close();
  await sleep(300);
});

await run("Tool call — arguments passed through correctly", async () => {
  await sleep(200);
  const tools = [{
    name: "add",
    description: "Adds two numbers",
    parameters: [
      { name: "a", type: "number", required: true },
      { name: "b", type: "number", required: true },
    ],
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  }];
  const ext = await connectExtension(tools);
  await sleep(300);

  let receivedArgs = null;
  handleToolCall(ext, (req) => {
    receivedArgs = req.arguments;
    return { ok: true, content: [{ type: "text", text: String(req.arguments.a + req.arguments.b) }] };
  });

  const sessionId = await openSession();
  await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "add", arguments: { a: 7, b: 13 } },
  });

  assert(receivedArgs?.a === 7 && receivedArgs?.b === 13, "arguments forwarded to extension intact");
  ext.ws.close();
  await sleep(300);
});

await run("Extension disconnect — tools disappear from tools/list", async () => {
  await sleep(200);
  const tools = [{ name: "ephemeral_tool", description: "gone soon", parameters: [] }];
  const ext = await connectExtension(tools);
  await sleep(300);

  const sessionId = await openSession();
  const before = await mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const hadTool = before.body?.result?.tools?.some((t) => t.name === "ephemeral_tool");
  assert(hadTool, "ephemeral_tool visible before disconnect");

  ext.ws.close();
  await sleep(600); // give server time to detect close and clear tools

  const after = await mcpPost(sessionId, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const stillThere = after.body?.result?.tools?.some((t) => t.name === "ephemeral_tool");
  assert(!stillThere, "ephemeral_tool gone after disconnect");
});

await run("Extension reconnect — tools reappear", async () => {
  await sleep(200);
  const tools = [{ name: "reconnect_tool", description: "survives reconnect", parameters: [] }];

  // First connection
  const ext1 = await connectExtension(tools);
  await sleep(300);
  ext1.ws.close();
  await sleep(600);

  // Second connection (simulates extension reloading)
  const ext2 = await connectExtension(tools);
  await sleep(300);

  const sessionId = await openSession();
  const r = await mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const found = r.body?.result?.tools?.some((t) => t.name === "reconnect_tool");
  assert(found, "reconnect_tool visible after reconnect");
  ext2.ws.close();
  await sleep(300);
});

await run("Calling an unknown tool returns MCP error", async () => {
  await sleep(200);
  const sessionId = await openSession();
  const r = await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "does_not_exist", arguments: {} },
  });
  // Should be a JSON-RPC error or an isError result
  const isErr = r.body?.error != null || r.body?.result?.isError === true;
  assert(isErr, "unknown tool call returns an error response");
});

await run("SSE transport — endpoint emits session URL", async () => {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3000);
  let gotEndpoint = false;
  try {
    const res = await fetch(`${MCP_URL.replace("/mcp", "/sse")}`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    gotEndpoint = text.includes("event: endpoint") && text.includes("sessionId=");
    reader.cancel();
  } catch {
    // aborted or connection closed — still check what we got
  } finally {
    clearTimeout(timeout);
  }
  assert(gotEndpoint, "SSE /sse emits endpoint event with sessionId");
});

await run("Concurrent tool calls — both resolve correctly", async () => {
  await sleep(200);
  const tools = [{
    name: "slow_echo",
    description: "Echoes with a delay",
    parameters: [{ name: "text", type: "string", required: true }],
  }];
  const ext = await connectExtension(tools);
  await sleep(300);

  // Handler with slight delay to test concurrency
  const ws = ext.ws;
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "tool_request") return;
    await sleep(100);
    ext.send({ type: "tool_result", correlationId: msg.correlationId, toolName: msg.toolName,
      result: { ok: true, content: [{ type: "text", text: `echo:${msg.arguments.text}` }] } });
  });

  const sessionId = await openSession();
  const [r1, r2] = await Promise.all([
    mcpPost(sessionId, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "slow_echo", arguments: { text: "A" } } }),
    mcpPost(sessionId, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "slow_echo", arguments: { text: "B" } } }),
  ]);

  const t1 = r1.body?.result?.content?.[0]?.text;
  const t2 = r2.body?.result?.content?.[0]?.text;
  assert(t1 === "echo:A", `call 1 got correct result (${t1})`);
  assert(t2 === "echo:B", `call 2 got correct result (${t2})`);
  ext.ws.close();
  await sleep(300);
});

// ── summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}`);
process.exit(failed > 0 ? 1 : 0);
