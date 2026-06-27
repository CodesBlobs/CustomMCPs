/**
 * ImportDialog: allows selective import of MCP servers from an imported JSON config.
 * Lists all servers in the pending import file with checkboxes, count of tools,
 * and badges indicating if the server is 'New' or will 'Overwrite' an existing one.
 */
import { h, setChildren } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { store } from "../store.js";
import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";

export function mountImportDialog(): HTMLElement {
  const dialog = h("sl-dialog", {
    label: "Import MCP Servers",
    style: "--width: 500px;",
  }) as SlDialog;

  const description = h(
    "p",
    { class: "muted", style: "margin-bottom: 16px; line-height: 1.4;" },
    "Select the website MCP servers you want to import. Existing servers with matching IDs will be updated."
  );

  const serverListBody = h("div", {
    style: "display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; max-height: 300px; overflow-y: auto; padding: 4px;"
  });

  const selectAllContainer = h("div", {
    style: "display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--app-border); margin-bottom: 10px;"
  });

  const cancelBtn = h("sl-button", { slot: "footer" }, "Cancel");
  const importBtn = h("sl-button", { slot: "footer", variant: "primary" }, "Import Selected");

  dialog.append(description, selectAllContainer, serverListBody, cancelBtn, importBtn);

  // Track checked server IDs
  const checkedIds = new Set<string>();

  cancelBtn.addEventListener("click", () => {
    store.getState().closeImportDialog();
  });

  importBtn.addEventListener("click", () => {
    void store.getState().executeImport(checkedIds);
  });

  store.subscribe(
    (s) => [s.importPending, s.servers] as const,
    ([pending, existingServers]) => {
      if (!pending) {
        void dialog.hide();
        return;
      }

      // Initialize all to checked by default
      checkedIds.clear();
      pending.servers.forEach((s) => checkedIds.add(s.id));

      // Build "Select All" switch/checkbox
      const selectAllSwitch = h("sl-switch", {
        size: "small",
        checked: true
      }, "Select All") as HTMLInputElement;

      selectAllSwitch.addEventListener("sl-change", () => {
        const checked = selectAllSwitch.checked;
        const switches = serverListBody.querySelectorAll("sl-switch");
        switches.forEach((sw: any) => {
          if (sw !== selectAllSwitch) {
            sw.checked = checked;
            const id = sw.dataset.serverId;
            if (checked) checkedIds.add(id);
            else checkedIds.delete(id);
          }
        });
      });

      setChildren(selectAllContainer, selectAllSwitch);

      // Render server rows
      const rows = pending.servers.map((server) => {
        const isOverwrite = existingServers.some((es) => es.id === server.id);
        const badge = isOverwrite
          ? h("sl-badge", { variant: "warning", pill: true, style: "font-size: 0.7rem;" }, "Overwrite")
          : h("sl-badge", { variant: "success", pill: true, style: "font-size: 0.7rem;" }, "New");

        const sw = h("sl-switch", {
          checked: true,
          "data-server-id": server.id,
          size: "small",
          style: "flex: 1;"
        }) as HTMLInputElement;

        // Label layout inside the switch
        const toolsText = `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`;
        const label = h(
          "div",
          { style: "display: inline-flex; align-items: center; justify-content: space-between; width: 100%; margin-left: 8px; vertical-align: middle;" },
          h(
            "div",
            { style: "display: flex; flex-direction: column;" },
            h("span", { style: "font-weight: 600; font-size: 0.85rem;" }, server.displayName),
            h("span", { style: "font-size: 0.75rem; color: var(--app-muted);" }, `${server.domain} • ${toolsText}`)
          ),
          badge
        );
        sw.append(label);

        sw.addEventListener("sl-change", () => {
          if (sw.checked) {
            checkedIds.add(server.id);
          } else {
            checkedIds.delete(server.id);
            selectAllSwitch.checked = false;
          }
        });

        return h("div", {
          style: "display: flex; align-items: center; padding: 8px 12px; border: 1px solid var(--app-border); border-radius: 8px; background: var(--app-bg);"
        }, sw);
      });

      setChildren(serverListBody, ...rows);
      void dialog.show();
    },
    {
      equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1]
    }
  );

  return dialog;
}
