/**
 * Left pane: the list of website MCP servers (Shoelace sl-details accordions),
 * each with its tools. Subscribes to `servers`/`loadError`; expansion state is
 * read from the store so it survives list rebuilds.
 *
 * Tool selection highlight is handled by a **separate** lightweight subscription
 * that toggles a CSS class on existing DOM nodes, avoiding a full list rebuild
 * (which would reset scroll position due to async Shoelace accordion expansion).
 */
import type { WebsiteMcpServer, McpToolDefinition } from "../../../mcpToolStorage.js";
import { h, setChildren } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { confirmDialog } from "../../shared/setup.js";
import { store } from "../store.js";

export function mountServerList(): HTMLElement {
  const list = h("div", { class: "server-list" });

  const addBtn = h("sl-button", { variant: "primary", size: "small" }, icon("plus", { slot: "prefix" }), "Add Server");
  addBtn.addEventListener("click", () => store.getState().openServerDialog("new"));

  const header = h("div", { class: "pane-header" }, h("h2", null, "MCP Servers"), addBtn);
  const body = h("div", { class: "server-list-body" });

  const root = h("div", { class: "server-pane" }, header, body);
  list.append(root);

  // ── Main render: rebuilds DOM only when servers or loadError change ──
  const render = () => {
    const { servers, loadError, expandedServerIds } = store.getState();
    if (loadError) {
      setChildren(body, h("div", { class: "empty-state error" }, `Failed to load servers: ${loadError}`));
      return;
    }
    if (servers.length === 0) {
      setChildren(
        body,
        h("div", { class: "empty-state" }, 'No website servers yet. Click "Add Server" to turn a website into an MCP server.'),
      );
      return;
    }
    setChildren(body, ...servers.map((server) => renderServer(server, expandedServerIds.has(server.id))));
    // Apply current selection highlight to the freshly built DOM
    updateToolSelection(body, store.getState().toolEditor);
  };

  store.subscribe((s) => [s.servers, s.loadError] as const, render, {
    equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1],
    fireImmediately: true,
  });

  // ── Lightweight highlight: toggles .selected class without DOM rebuild ──
  store.subscribe(
    (s) => s.toolEditor,
    (toolEditor) => updateToolSelection(body, toolEditor),
  );

  return list;
}

/** Toggle `.selected` on `.tool-item` cards by matching data attributes. */
function updateToolSelection(container: HTMLElement, toolEditor: { serverId: string; tool?: McpToolDefinition } | null): void {
  const cards = container.querySelectorAll<HTMLElement>(".tool-item");
  for (const card of cards) {
    const match =
      toolEditor != null &&
      card.dataset.serverId === toolEditor.serverId &&
      card.dataset.toolId === toolEditor.tool?.id;
    card.classList.toggle("selected", !!match);
  }
}

function renderServer(server: WebsiteMcpServer, expanded: boolean): HTMLElement {
  const actions = store.getState();

  const enableSwitch = h("sl-switch", { size: "small", title: "Enable server", ...(server.enabled ? { checked: true } : {}) });
  enableSwitch.addEventListener("sl-change", (e) =>
    actions.setServerEnabled(server, (e.target as HTMLInputElement).checked),
  );

  const editBtn = h("sl-button", { title: "Edit server", class: "icon-button" }, icon("pencil"));
  editBtn.addEventListener("click", () => actions.openServerDialog(server));

  const importBtn = h("sl-button", { title: "Import server configuration", class: "icon-button" }, icon("upload"));
  importBtn.addEventListener("click", () => {
    const fileInput = h("input", { type: "file", accept: ".json", style: "display:none" }) as HTMLInputElement;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        await actions.importServerConfig(server.id, await file.text());
      } finally {
        fileInput.remove();
      }
    });
    document.body.append(fileInput);
    fileInput.click();
  });

  const exportBtn = h("sl-button", { title: "Export server configuration", class: "icon-button" }, icon("download"));
  exportBtn.addEventListener("click", () => actions.exportServer(server));

  const deleteBtn = h("sl-button", { title: "Delete server", class: "icon-button danger" }, icon("trash"));
  deleteBtn.addEventListener("click", async () => {
    if (await confirmDialog({
      title: "Delete server",
      message: `Delete "${server.displayName}" and all of its tools?`,
      confirmLabel: "Delete",
      danger: true,
    })) {
      void actions.deleteServer(server.id);
    }
  });

  const controls = h("div", { class: "server-controls" }, enableSwitch, editBtn, importBtn, exportBtn, deleteBtn);
  // Don't let control clicks toggle the accordion.
  controls.addEventListener("click", (e) => e.stopPropagation());

  const summary = h(
    "div",
    { slot: "summary", class: "server-summary" },
    h("div", { class: "server-meta" },
      h("span", { class: "server-name" }, server.displayName),
    ),
    controls,
  );

  const addToolBtn = h("sl-button", { variant: "default", size: "small" }, icon("plus", { slot: "prefix" }), "Add Tool");
  addToolBtn.addEventListener("click", () => actions.openToolEditor(server.id));

  const toolsHeader = h("div", { class: "tools-header" },
    h("span", { class: "tools-title" }, "Tools Configured"),
    addToolBtn,
  );

  const toolsBody = server.tools.length === 0
    ? h("div", { class: "empty-state small" }, "No tools defined yet.")
    : h("div", { class: "tools-list" }, ...server.tools.map((tool) => renderTool(server.id, tool)));

  const details = h("sl-details", { class: "server-details", ...(expanded ? { open: true } : {}) },
    summary,
    h("div", { class: "server-tools" }, toolsHeader, toolsBody),
  );

  details.addEventListener("sl-show", () => {
    if (!store.getState().expandedServerIds.has(server.id)) store.getState().toggleExpanded(server.id);
  });
  details.addEventListener("sl-hide", (e) => {
    // sl-hide also fires for nested components; ignore bubbled events.
    if (e.target !== details) return;
    if (store.getState().expandedServerIds.has(server.id)) store.getState().toggleExpanded(server.id);
  });

  return details;
}

function renderTool(serverId: string, tool: McpToolDefinition): HTMLElement {
  const actions = store.getState();

  const toggle = h("sl-switch", { size: "small", title: "Enable tool", ...(tool.enabled ? { checked: true } : {}) });
  toggle.addEventListener("sl-change", (e) =>
    actions.setToolEnabled(serverId, tool, (e.target as HTMLInputElement).checked),
  );

  const testBtn = h("sl-button", { title: "Test tool", class: "icon-button" }, icon("test"));
  testBtn.addEventListener("click", () => actions.openTestTool(serverId, tool));

  const editBtn = h("sl-button", { title: "Edit tool", class: "icon-button" }, icon("pencil"));
  editBtn.addEventListener("click", () => actions.openToolEditor(serverId, tool));

  const duplicateBtn = h("sl-button", { title: "Duplicate tool", class: "icon-button" }, icon("copy"));
  duplicateBtn.addEventListener("click", () => actions.duplicateTool(serverId, tool));

  const deleteBtn = h("sl-button", { title: "Delete tool", class: "icon-button danger" }, icon("trash"));
  deleteBtn.addEventListener("click", async () => {
    if (await confirmDialog({
      title: "Delete tool",
      message: `Delete tool "${tool.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    })) {
      void actions.deleteTool(serverId, tool.id);
    }
  });

  const footerRow = h("div", { class: "tool-footer-row" },
    toggle,
    h("div", { class: "tool-actions" }, testBtn, editBtn, duplicateBtn, deleteBtn),
  );
  // Don't let control clicks bubble up to the card-level handler.
  footerRow.addEventListener("click", (e) => e.stopPropagation());

  const card = h("div", { class: "tool-item", "data-server-id": serverId, "data-tool-id": tool.id },
    h("div", { class: "tool-header-row" },
      h("span", { class: "tool-title", title: tool.name }, tool.name),
      h("sl-badge", { variant: methodVariant(tool.method), pill: true }, tool.method),
    ),
    h("div", { class: "tool-description" }, tool.description || "No description provided."),
    footerRow,
  );
  card.addEventListener("click", () => actions.openToolEditor(serverId, tool));

  return card;
}

function methodVariant(method: string): string {
  switch (method) {
    case "GET": return "primary";
    case "POST": return "success";
    case "PUT": return "warning";
    case "DELETE": return "danger";
    default: return "neutral";
  }
}
