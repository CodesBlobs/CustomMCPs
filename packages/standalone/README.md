# @agentic-browser-mcp/standalone

Run MCP (Model Context Protocol) servers from exported browser tool configurations — **no Chrome extension required**.

This package takes a JSON configuration file exported from the `Agentic Browser MCP Chrome` extension and runs a standalone MCP server that AI agents can connect to.

## Installation

### Run directly with npx (no install required)

```bash
npx @agentic-browser-mcp/standalone --config ./exported-config.json
```

### Install globally

To install from the custom registry:

```bash
npm install -g @agentic-browser-mcp/standalone --registry https://bnpm.byted.org
agentic-browser-mcp-standalone --config ./exported-config.json
```

Or run the all-in-one install script from the repository root to install the server and download all skills automatically:

```bash
./install.sh
```


### Install in a project

```bash
npm install @agentic-browser-mcp/standalone
```

## Usage

### Basic Usage

```bash
agentic-browser-mcp-standalone --config ./my-tools.json
```

### Custom Port

```bash
agentic-browser-mcp-standalone --config ./my-tools.json --port 8080
```

### All Options

```
Usage: agentic-browser-mcp-standalone --config <path> [options]

Required:
  --config <path>    Path to the exported JSON configuration file

Options:
  --port <number>    HTTP port for SSE/Streamable HTTP transports (default: 13001)
  --host <string>    HTTP host to bind to (default: 0.0.0.0)
  --help             Show this help message
```

## MCP Client Configuration

### Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-api-tools": {
      "command": "npx",
      "args": [
        "@agentic-browser-mcp/standalone",
        "--config",
        "/absolute/path/to/exported-config.json"
      ]
    }
  }
}
```

### Cursor / Other MCP Clients

Use the same pattern — point the MCP client to the `npx` command with the `--config` flag.

## Transports

The standalone server exposes three MCP transports simultaneously:

| Transport | Endpoint | Description |
|-----------|----------|-------------|
| **Stdio** | (automatic) | Used by MCP clients that launch the server as a subprocess |
| **SSE** | `http://localhost:13001/sse` | Server-Sent Events for browser-based clients |
| **Streamable HTTP** | `http://localhost:13001/mcp` | Modern HTTP-based MCP transport |

## Configuration File Format

The configuration file is the JSON exported by the Chrome extension's "Export Config" feature. It follows this structure:

```json
{
  "version": "1.0",
  "exportedAt": "2025-01-01T00:00:00.000Z",
  "servers": [
    {
      "id": "unique-id",
      "domain": "api.example.com",
      "displayName": "My API",
      "enabled": true,
      "tools": [
        {
          "id": "tool-id",
          "serverId": "unique-id",
          "name": "get_users",
          "description": "Fetch users from the API",
          "method": "GET",
          "urlTemplate": "https://api.example.com/users/{{userId}}",
          "headerTemplates": {
            "Authorization": "Bearer {{env:API_TOKEN}}"
          },
          "bodyTemplate": "",
          "parameters": [
            {
              "name": "userId",
              "description": "The user ID to fetch",
              "type": "string",
              "required": true
            }
          ],
          "responseType": "json",
          "enabled": true
        }
      ]
    }
  ]
}
```

## Template Symbols

Templates in URLs, headers, and request bodies support the following symbols:

| Symbol | Description | Example |
|--------|-------------|---------|
| `{{paramName}}` | Agent-provided argument | `{{userId}}` |
| `{{args:paramName}}` | Explicit agent argument | `{{args:userId}}` |
| `{{env:VAR_NAME}}` | Environment variable | `{{env:API_TOKEN}}` |

### Browser-Only Symbols (Not Supported)

The following symbols are available in the Chrome extension but **not in standalone mode**. They will resolve to an empty string with a warning:

- `{{cookie:domain:name}}` — Browser cookies
- `{{localStorage:origin:key}}` — Browser localStorage
- `{{sessionStorage:origin:key}}` — Browser sessionStorage
- `{{storage:key}}` — Chrome extension storage

If your tools rely on browser cookies or storage for authentication, consider using `{{env:VAR}}` symbols instead and setting the values via environment variables.

## Publishing to npm

This package depends on `@agentic-browser-mcp/shared`, which must also be published. Follow these steps to publish both packages.

### Prerequisites

1. **npm account**: Create one at [npmjs.com](https://www.npmjs.com/signup) if you don't have one.

2. **npm login**: Authenticate in your terminal:

   ```bash
   npm login
   ```

3. **Scoped package access**: Since these are scoped packages (`@agentic-browser-mcp/*`), you need an npm organization named `agentic-browser-mcp`. Create one at [npmjs.com/org/create](https://www.npmjs.com/org/create), or publish to a different scope by updating the `name` field in both `package.json` files.

### Step 1 — Build Everything

From the monorepo root:

```bash
npm run build
```

### Step 2 — Publish the Shared Package

The standalone package depends on `@agentic-browser-mcp/shared`, so it must be published first:

```bash
cd packages/shared
npm publish --access public
```

### Step 3 — Publish the Standalone Package

```bash
cd packages/standalone
npm publish --access public
```

### Step 4 — Verify

```bash
# Test that it installs and runs from npm
npx @agentic-browser-mcp/standalone --help
```

### Publishing Updates

When releasing a new version:

1. **Bump versions** in both packages (keep them in sync):

   ```bash
   # Update version in packages/shared/package.json
   # Update version in packages/standalone/package.json
   # Update the shared dependency version in packages/standalone/package.json
   ```

2. **Rebuild and publish** in order:

   ```bash
   npm run build
   cd packages/shared && npm publish --access public --registry https://bnpm.byted.org/
   cd ../standalone && npm publish --access public --registry https://bnpm.byted.org/
   ```

### Publishing Checklist

- [ ] `npm run build` succeeds with no errors
- [ ] Versions in `packages/shared/package.json` and `packages/standalone/package.json` are updated
- [ ] The `@agentic-browser-mcp/shared` dependency version in `packages/standalone/package.json` matches the shared package version
- [ ] `npm pack --dry-run` in `packages/standalone` shows only `dist/`, `README.md`, and `package.json`
- [ ] `npm publish --access public` succeeds for shared first, then standalone
- [ ] `npx @agentic-browser-mcp/standalone --help` works from a clean environment

## Requirements

- Node.js >= 20.0.0 (for native `fetch()` support)

## License

MIT

