/**
 * Single source of truth for the sidepanel, built on a Zustand vanilla store.
 * Async actions wrap the typed message API (../shared/api) and update state;
 * components subscribe to slices via store.subscribe(selector, ...).
 */
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";

import type { WebsiteMcpServer, McpToolDefinition } from "../../mcpToolStorage.js";
import { clearStoredPairing } from "../../pairingStorage.js";
import * as api from "../shared/api.js";
import type { PairingState } from "../shared/api.js";
import { toast } from "../shared/setup.js";

export type TabId = "servers" | "pairing" | "backup";

export interface HostStatus {
  state: "checking" | "available" | "unavailable" | "error";
  message?: string;
}

/** null = closed · "new" = add form · server = edit form */
export type ServerDialogState = WebsiteMcpServer | "new" | null;

export interface ToolEditorState {
  serverId: string;
  tool?: McpToolDefinition;
}

export interface TestToolState {
  serverId: string;
  tool: McpToolDefinition;
}

export interface ImportPendingState {
  servers: WebsiteMcpServer[];
}

export interface SidepanelState {
  servers: WebsiteMcpServer[];
  loadError: string | null;
  expandedServerIds: Set<string>;
  activeTab: TabId;
  connection: "paired" | "offline";
  hostStatus: HostStatus;
  pairing: PairingState | undefined;

  // UI intents
  serverDialog: ServerDialogState;
  toolEditor: ToolEditorState | null;
  testTool: TestToolState | null;
  importPending: ImportPendingState | null;

  // actions
  setActiveTab(tab: TabId): void;
  toggleExpanded(serverId: string): void;
  loadServers(): Promise<void>;
  pollConnection(): Promise<void>;
  refreshHostStatus(): Promise<void>;
  loadPairing(): Promise<void>;
  clearPairing(): Promise<void>;

  saveServer(server: WebsiteMcpServer): Promise<boolean>;
  deleteServer(serverId: string): Promise<void>;
  setServerEnabled(server: WebsiteMcpServer, enabled: boolean): Promise<void>;

  saveTool(serverId: string, tool: McpToolDefinition): Promise<boolean>;
  deleteTool(serverId: string, toolId: string): Promise<void>;
  setToolEnabled(serverId: string, tool: McpToolDefinition, enabled: boolean): Promise<void>;
  duplicateTool(serverId: string, tool: McpToolDefinition): Promise<void>;

  exportConfig(): Promise<void>;
  importConfig(json: string): Promise<{ imported: number; errors: string[] } | null>;
  exportServer(server: WebsiteMcpServer): void;
  importServerConfig(serverId: string, json: string): Promise<boolean>;

  openServerDialog(value: ServerDialogState): void;
  openToolEditor(serverId: string, tool?: McpToolDefinition): void;
  closeToolEditor(): void;
  openTestTool(serverId: string, tool: McpToolDefinition): void;
  closeTestTool(): void;
  openImportDialog(servers: WebsiteMcpServer[]): void;
  closeImportDialog(): void;
  executeImport(selectedServerIds: Set<string>): Promise<void>;
}

export const store = createStore<SidepanelState>()(
  subscribeWithSelector((set, get) => ({
    servers: [],
    loadError: null,
    expandedServerIds: new Set<string>(),
    activeTab: "servers",
    connection: "offline",
    hostStatus: { state: "checking" },
    pairing: undefined,
    serverDialog: null,
    toolEditor: null,
    testTool: null,
    importPending: null,

    setActiveTab(tab) {
      set({ activeTab: tab });
    },

    toggleExpanded(serverId) {
      const next = new Set(get().expandedServerIds);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      set({ expandedServerIds: next });
    },

    async loadServers() {
      try {
        const servers = await api.listServers();
        set({ servers, loadError: null });
      } catch (error) {
        set({ loadError: messageOf(error) });
      }
    },

    async pollConnection() {
      try {
        const pairingState = await api.getPairingState();
        set({ connection: pairingState ? "paired" : "offline" });
      } catch {
        set({ connection: "offline" });
      }
    },

    async refreshHostStatus() {
      set({ hostStatus: { state: "checking" } });
      try {
        const res = await api.getNativeHostStatus();
        set({
          hostStatus: res.available
            ? { state: "available" }
            : { state: "unavailable", message: res.error },
        });
      } catch (error) {
        set({ hostStatus: { state: "error", message: messageOf(error) } });
      }
    },

    async loadPairing() {
      try {
        set({ pairing: await api.getPairingState() });
      } catch (error) {
        set({ pairing: undefined, loadError: messageOf(error) });
      }
    },

    async clearPairing() {
      await clearStoredPairing();
      await Promise.all([get().loadPairing(), get().pollConnection()]);
      toast("Pairing cleared.", "success");
    },

    async saveServer(server) {
      try {
        await api.saveServer(server);
        await get().loadServers();
        return true;
      } catch (error) {
        toast(`Failed to save server: ${messageOf(error)}`, "danger");
        return false;
      }
    },

    async deleteServer(serverId) {
      try {
        await api.deleteServer(serverId);
        const expanded = new Set(get().expandedServerIds);
        expanded.delete(serverId);
        set({ expandedServerIds: expanded });
        await get().loadServers();
      } catch (error) {
        toast(`Failed to delete server: ${messageOf(error)}`, "danger");
      }
    },

    async setServerEnabled(server, enabled) {
      patchServer(set, get, server.id, (s) => ({ ...s, enabled }));
      try {
        await api.saveServer({ ...server, enabled });
      } catch (error) {
        patchServer(set, get, server.id, (s) => ({ ...s, enabled: !enabled }));
        toast(`Failed to update server: ${messageOf(error)}`, "danger");
      }
    },

    async saveTool(serverId, tool) {
      try {
        await api.saveTool(serverId, tool);
        await get().loadServers();
        const currentEditor = get().toolEditor;
        if (currentEditor && currentEditor.serverId === serverId && (!currentEditor.tool || currentEditor.tool.id === tool.id)) {
          set({ toolEditor: { serverId, tool } });
        }
        return true;
      } catch (error) {
        toast(`Failed to save tool: ${messageOf(error)}`, "danger");
        return false;
      }
    },

    async deleteTool(serverId, toolId) {
      try {
        await api.deleteTool(serverId, toolId);
        await get().loadServers();
      } catch (error) {
        toast(`Failed to delete tool: ${messageOf(error)}`, "danger");
      }
    },

    async setToolEnabled(serverId, tool, enabled) {
      patchTool(set, get, serverId, tool.id, (t) => ({ ...t, enabled }));
      try {
        await api.saveTool(serverId, { ...tool, enabled });
      } catch (error) {
        patchTool(set, get, serverId, tool.id, (t) => ({ ...t, enabled: !enabled }));
        toast(`Failed to update tool: ${messageOf(error)}`, "danger");
      }
    },

    async duplicateTool(serverId, tool) {
      try {
        const now = new Date().toISOString();
        const duplicatedTool: McpToolDefinition = {
          ...tool,
          id: crypto.randomUUID(),
          name: `${tool.name}_copy`,
          createdAt: now,
          updatedAt: now,
        };
        await api.saveTool(serverId, duplicatedTool);
        await get().loadServers();
        toast(`Duplicated tool "${tool.name}" as "${duplicatedTool.name}".`, "success");
      } catch (error) {
        toast(`Failed to duplicate tool: ${messageOf(error)}`, "danger");
      }
    },

    async exportConfig() {
      try {
        const json = await api.exportConfig();
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `mcp-servers-config-${new Date().toISOString().split("T")[0]}.json`;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        toast(`Failed to export config: ${messageOf(error)}`, "danger");
      }
    },

    async importConfig(json) {
      try {
        const res = await api.importConfig(json);
        await get().loadServers();
        return res;
      } catch (error) {
        toast(`Import failed: ${messageOf(error)}`, "danger");
        return null;
      }
    },

    openServerDialog(value) {
      set({ serverDialog: value });
    },

    openToolEditor(serverId, tool) {
      set({ toolEditor: { serverId, tool } });
    },

    closeToolEditor() {
      set({ toolEditor: null });
    },

    openTestTool(serverId, tool) {
      set({ testTool: { serverId, tool } });
    },

    closeTestTool() {
      set({ testTool: null });
    },

    openImportDialog(servers) {
      set({ importPending: { servers } });
    },

    closeImportDialog() {
      set({ importPending: null });
    },

    async executeImport(selectedServerIds) {
      const pending = get().importPending;
      if (!pending) return;

      const toImport = pending.servers.filter((s) => selectedServerIds.has(s.id));
      if (toImport.length === 0) {
        toast("No servers selected for import.", "warning");
        return;
      }

      try {
        const json = JSON.stringify({
          version: "1.0",
          exportedAt: new Date().toISOString(),
          servers: toImport,
        });

        const res = await api.importConfig(json);
        await get().loadServers();
        set({ importPending: null });
        if (res) {
          if (res.errors.length > 0) {
            toast(`Imported ${res.imported} servers with ${res.errors.length} error(s). ${res.errors[0]}`, "warning", 6000);
          } else {
            toast(`Successfully imported ${res.imported} website servers.`, "success");
          }
        }
      } catch (error) {
        toast(`Import failed: ${messageOf(error)}`, "danger");
      }
    },

    exportServer(server) {
      try {
        const json = JSON.stringify(
          {
            version: "1.0",
            exportedAt: new Date().toISOString(),
            servers: [server],
          },
          null,
          2
        );
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${server.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-mcp-server.json`;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast(`Exported configuration for ${server.displayName}.`, "success");
      } catch (error) {
        toast(`Failed to export server: ${messageOf(error)}`, "danger");
      }
    },

    async importServerConfig(serverId, json) {
      try {
        const data = JSON.parse(json);
        let importedServer: any = null;

        if (data && Array.isArray(data.servers) && data.servers.length > 0) {
          importedServer = data.servers[0];
        } else if (data && typeof data === "object" && (data.domain || data.displayName)) {
          importedServer = data;
        }

        if (!importedServer) {
          toast("Invalid server configuration format.", "danger");
          return false;
        }

        const servers = get().servers;
        const serverIndex = servers.findIndex((s) => s.id === serverId);
        if (serverIndex < 0) {
          toast("Target server not found.", "danger");
          return false;
        }

        const targetServer = servers[serverIndex]!;

        // Overwrite target server tools and metadata (preserving original ID)
        const updatedServer = {
          ...targetServer,
          domain: importedServer.domain || targetServer.domain,
          displayName: importedServer.displayName || targetServer.displayName,
          tools: importedServer.tools || [],
          updatedAt: new Date().toISOString(),
        };

        await api.saveServer(updatedServer);
        await get().loadServers();
        toast(`Imported configuration into ${updatedServer.displayName}.`, "success");
        return true;
      } catch (error) {
        toast(`Failed to import server configuration: ${messageOf(error)}`, "danger");
        return false;
      }
    },
  })),
);

// ─── helpers ─────────────────────────────────────────────────────────────────

type SetFn = (partial: Partial<SidepanelState>) => void;
type GetFn = () => SidepanelState;

function patchServer(
  set: SetFn,
  get: GetFn,
  serverId: string,
  patch: (server: WebsiteMcpServer) => WebsiteMcpServer,
): void {
  set({
    servers: get().servers.map((s) => (s.id === serverId ? patch(s) : s)),
  });
}

function patchTool(
  set: SetFn,
  get: GetFn,
  serverId: string,
  toolId: string,
  patch: (tool: McpToolDefinition) => McpToolDefinition,
): void {
  set({
    servers: get().servers.map((s) =>
      s.id === serverId
        ? { ...s, tools: s.tools.map((t) => (t.id === toolId ? patch(t) : t)) }
        : s,
    ),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Store = typeof store;
