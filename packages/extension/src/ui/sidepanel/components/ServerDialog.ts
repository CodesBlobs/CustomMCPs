/**
 * Add/Edit website server dialog (sl-dialog). Driven by store.serverDialog
 * (null = closed, "new" = add, server = edit).
 */
import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";

import type { WebsiteMcpServer } from "../../../mcpToolStorage.js";
import { h } from "../../shared/dom.js";
import { toast } from "../../shared/setup.js";
import { store } from "../store.js";

export function mountServerDialog(): HTMLElement {
  const nameInput = h("sl-input", { id: "sd-name", label: "Display Name", placeholder: "e.g. Jira MCP Server", required: true });
  const domainInput = h("sl-input", { id: "sd-domain", label: "Domain (wildcard or specific)", placeholder: "e.g. company.atlassian.net", required: true });

  const cancelBtn = h("sl-button", { slot: "footer" }, "Cancel");
  const saveBtn = h("sl-button", { slot: "footer", variant: "primary" }, "Save Server");

  const dialog = h("sl-dialog", { label: "Add Server" },
    h("div", { class: "dialog-body" }, nameInput, domainInput),
    cancelBtn,
    saveBtn,
  ) as HTMLElement as SlDialog;

  let current: WebsiteMcpServer | "new" | null = null;

  cancelBtn.addEventListener("click", () => store.getState().openServerDialog(null));
  dialog.addEventListener("sl-after-hide", (e) => {
    if (e.target === dialog) store.getState().openServerDialog(null);
  });

  saveBtn.addEventListener("click", async () => {
    const displayName = value(nameInput).trim();
    const domain = value(domainInput).trim();
    if (!displayName || !domain) {
      toast("Display name and domain are required.", "warning");
      return;
    }

    const now = new Date().toISOString();
    const server: WebsiteMcpServer =
      current && current !== "new"
        ? { ...current, displayName, domain }
        : { id: crypto.randomUUID(), displayName, domain, enabled: true, tools: [], createdAt: now, updatedAt: now };

    const ok = await store.getState().saveServer(server);
    if (ok) {
      store.getState().openServerDialog(null);
      toast("Server saved.", "success");
    }
  });

  store.subscribe((s) => s.serverDialog, (state) => {
    current = state;
    if (!state) {
      if (dialog.open) void dialog.hide();
      return;
    }
    const editing = state !== "new";
    dialog.label = editing ? "Edit Website Server" : "Add Website Server";
    (nameInput as HTMLInputElement).value = editing ? state.displayName : "";
    (domainInput as HTMLInputElement).value = editing ? state.domain : "";
    void dialog.show();
    setTimeout(() => (nameInput as HTMLElement & { focus: () => void }).focus(), 0);
  });

  return dialog;
}

function value(el: HTMLElement): string {
  return (el as unknown as { value?: string }).value ?? "";
}
