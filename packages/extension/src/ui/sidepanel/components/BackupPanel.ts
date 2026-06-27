/**
 * Backup tab: export servers/tools to JSON and import them back. Sensitive auth
 * values are excluded by the background exporter.
 */
import { h } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { toast } from "../../shared/setup.js";
import { store } from "../store.js";

export function mountBackupPanel(): HTMLElement {
  const fileInput = h("input", { type: "file", accept: ".json", style: "display:none" }) as HTMLInputElement;

  const exportBtn = h("sl-button", { variant: "primary" }, icon("download", { slot: "prefix" }), "Export Config (JSON)");
  exportBtn.addEventListener("click", () => void store.getState().exportConfig());

  const importBtn = h("sl-button", null, icon("upload", { slot: "prefix" }), "Import Config (JSON)");
  importBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data && Array.isArray(data.servers)) {
        store.getState().openImportDialog(data.servers);
      } else {
        toast("Invalid configuration format: 'servers' array missing.", "danger");
      }
    } catch (error) {
      toast(`Failed to parse file: ${error instanceof Error ? error.message : String(error)}`, "danger");
    } finally {
      fileInput.value = "";
    }
  });

  return h("div", { class: "stack" },
    h("h2", null, "Import / Export Settings"),
    h("p", { class: "muted" }, "Back up your website servers and custom tool templates. Sensitive auth values are NOT exported."),
    h("sl-card", { class: "panel-card" },
      h("div", { class: "card-actions column" }, exportBtn, importBtn, fileInput),
    ),
  );
}
