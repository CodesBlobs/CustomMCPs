# Agentic Browser MCP MVP

This repository contains a local MCP server plus a Chrome Manifest V3 extension that connects to it over a loopback WebSocket bridge.

The extension can also use Chrome Native Messaging to quietly launch a local bridge daemon and import its pairing data without opening a pairing tab.

## Workspace layout

- `packages/server`: local MCP bridge server and pairing file writer
- `packages/extension`: Chrome extension that reconnects to the bridge and executes browser tools
- `packages/shared`: shared protocol types and schemas

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Google Chrome 116 or newer

## Install dependencies

```bash
npm install
```

## Build the project

```bash
npm run build
```

This produces:

- `packages/server/dist`
- `packages/extension/dist`

## Run the local MCP bridge server

Build and start the server:

```bash
npm run server:dev
```

By default the server now listens on the first free loopback port inside the shared discovery range `45320-45339`, and the extension auto-scans that same range. Manual pairing is no longer required for the default setup.

When token auth is enabled, the server also opens a dedicated local pairing tab and the extension can capture the pairing information directly from that tab URL.

On startup the server still writes a pairing file to:

```text
~/.agentic-browser-mcp/agentic-browser-mcp.pairing.json
```

It also logs the resolved path to stderr when the bridge starts.

## Optional port and auth configuration

You can customize discovery and authentication with environment variables:

```bash
AGENTIC_BROWSER_MCP_PORT=45325
AGENTIC_BROWSER_MCP_PORT_RANGE=45320-45339
AGENTIC_BROWSER_MCP_AUTH_MODE=loopback
AGENTIC_BROWSER_MCP_AUTH_TOKEN=your-stable-token-with-at-least-32-characters
AGENTIC_BROWSER_MCP_OPEN_PAIRING_TAB=always
AGENTIC_BROWSER_MCP_PAIRING_BROWSER=\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\"
```

Notes:

- `AGENTIC_BROWSER_MCP_PORT` pins the server to one exact port.
- `AGENTIC_BROWSER_MCP_PORT_RANGE` makes the server try each port in order until one is free.
- `AGENTIC_BROWSER_MCP_AUTH_MODE=loopback` enables zero-config auto-discovery.
- `AGENTIC_BROWSER_MCP_AUTH_MODE=token` enables stricter auth while still allowing automatic pairing through the startup tab.
- `AGENTIC_BROWSER_MCP_AUTH_TOKEN` keeps the token stable across restarts when token auth is enabled.
- `AGENTIC_BROWSER_MCP_OPEN_PAIRING_TAB=always|never` overrides the smart default. If unset, the tab opens automatically in `token` mode and stays off in `loopback` mode.
- `AGENTIC_BROWSER_MCP_PAIRING_BROWSER` lets you override how the startup pairing tab is launched. By default the server prefers Chrome and then falls back to the system browser.

## URL Template Resolution

When configuring custom tools, you can use **URL Templates** to dynamically inject values from the current browser session or tool arguments when the tool executes. The following placeholder patterns are supported:

- **`{{args:name}}`**: Resolves to the value of the custom tool argument `name` provided by the agent.
- **`{{cookie:name}}`**: Resolves to the value of the cookie named `name` matching the active tab's URL.
- **`{{localStorage:key}}`**: Resolves to the value of `localStorage.getItem('key')` evaluated in the active tab context.
- **`{{sessionStorage:key}}`**: Resolves to the value of `sessionStorage.getItem('key')` evaluated in the active tab context.

### Example

If you define a custom tool with a URL template like:
```text
https://api.example.com/user/{{args:userId}}/profile?token={{localStorage:authToken}}&session={{cookie:session_id}}
```
When invoked with the argument `userId: "123"`, the template will automatically resolve the active page's local storage and cookies to build the final request URL.

## MCP Transports & Client Setup

The MCP server runs three transports concurrently in the same process:

1. **Stdio** (Standard Input/Output)
2. **SSE** (Server-Sent Events over HTTP)
3. **Streamable HTTP** (MCP standard Streamable HTTP over HTTP)

By default, HTTP transports listen on port `13001`. You can configure the port by setting the `AGENTIC_BROWSER_MCP_HTTP_PORT` environment variable.

### Instructions to Connect an AI Agent / Client

#### 1. Stdio (Claude Desktop / Cursor Configuration)
To run the server as a local subprocess, use the command entry point:

```json
{
  "mcpServers": {
    "agentic-browser-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/28_mcpsrv_in_extension/packages/server/dist/index.js"]
    }
  }
}
```

#### 2. SSE (Server-Sent Events)
For clients that support SSE (e.g. standard remote/web clients), connect to the following endpoints:
* **SSE stream endpoint**: `http://localhost:13001/sse`
* **Message POST endpoint**: `http://localhost:13001/messages`

#### 3. Streamable HTTP
For standard Streamable HTTP clients, point to:
* **Endpoint**: `http://localhost:13001/mcp`

---

## Load the extension in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select `packages/extension/dist`.

The extension now declares the `nativeMessaging` permission. Once a native host manifest for `com.agentic_browser_mcp.host` is registered for the extension ID, the service worker will try to launch the local bridge daemon automatically on startup and on reconnect. A manifest template is included at `packages/server/native-host/com.agentic_browser_mcp.host.template.json`.

## Manual pairing override

The extension can work without importing anything. In token mode, the startup pairing tab is usually enough. If you still want to force a specific endpoint or token manually, you can import the server-generated pairing JSON:

1. Open the extension options page.
2. Either:
   - click the extension toolbar icon, which opens the options page, or
   - open the extension details page and choose `Extension options`.
3. Load `~/.agentic-browser-mcp/agentic-browser-mcp.pairing.json` with the file picker, or paste its contents into the textarea.
4. Click `Import Pairing JSON`.

The extension stores the validated pairing data in `chrome.storage.local`, prefers that endpoint first, and then falls back to range scanning if needed.

## Useful scripts

```bash
npm run build
npm run extension:build
npm run server:dev
npm run server:start
npm run clean
```

## Notes

- The extension requires the `storage`, `offscreen`, `tabs`, `scripting`, and `nativeMessaging` permissions declared in the manifest.
- With the default loopback auth mode, users do not need to pair the server and extension manually.
- The native host entrypoint is exposed as `agentic-browser-mcp-native-host` and launches `bridgeDaemon.js` with `AGENTIC_BROWSER_MCP_OPEN_PAIRING_TAB=never` so users are not disturbed by a startup tab.
- In token mode, the extension can auto-capture pairing information from the dedicated startup tab.
- If you use token auth, disable the startup tab, and let the server generate a fresh random token on each restart, re-import the new pairing JSON through the options page.
