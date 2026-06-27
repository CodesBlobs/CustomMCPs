/**
 * Pairing & Host tab: native-host status, stored pairing details, and import /
 * clear actions. Reads store.hostStatus / store.pairing.
 */
import { writeStoredPairingJson } from "../../../pairingStorage.js";
import { h, setChildren } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { toast, confirmDialog } from "../../shared/setup.js";
import { store } from "../store.js";

export function mountPairingPanel(): HTMLElement {
  const hostStatusEl = h("sl-tag", { size: "small" }, "Checking…");
  const hostError = h("p", { class: "muted error", style: "display:none" });
  const refreshBtn = h("sl-button", { size: "small" }, icon("refresh", { slot: "prefix" }), "Refresh Host Connection");
  refreshBtn.addEventListener("click", () => void store.getState().refreshHostStatus());

  const hostCard = h("sl-card", { class: "panel-card" },
    h("div", { class: "card-row" }, h("strong", null, "Host Status:"), hostStatusEl),
    hostError,
    h("div", { class: "card-actions" }, refreshBtn),
  );

  const pairingDetails = h("div", { class: "pairing-details" });
  const fileInput = h("input", { type: "file", accept: ".json", style: "display:none" }) as HTMLInputElement;
  const importBtn = h("sl-button", { variant: "primary" }, icon("upload", { slot: "prefix" }), "Import Pairing JSON");
  const clearBtn = h("sl-button", { variant: "danger", style: "display:none" }, icon("trash", { slot: "prefix" }), "Clear Stored Pairing");

  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await writeStoredPairingJson(await file.text());
      toast("Pairing file imported.", "success");
      await Promise.all([
        store.getState().loadPairing(),
        store.getState().pollConnection(),
        store.getState().refreshHostStatus(),
      ]);
    } catch (error) {
      toast(`Failed to import pairing: ${messageOf(error)}`, "danger");
    } finally {
      fileInput.value = "";
    }
  });

  clearBtn.addEventListener("click", async () => {
    if (await confirmDialog({
      title: "Clear pairing",
      message: "Clear the stored pairing? The extension will disconnect from the local bridge server.",
      confirmLabel: "Clear",
      danger: true,
    })) {
      await store.getState().clearPairing();
    }
  });

  const pairingCard = h("sl-card", { class: "panel-card" },
    pairingDetails,
    h("div", { class: "card-actions column" }, importBtn, clearBtn, fileInput),
  );

  const root = h("div", { class: "stack" },
    h("h2", null, "Native Messaging Host"),
    hostCard,
    h("h2", null, "Pairing Details"),
    pairingCard,
  );

  store.subscribe((s) => s.hostStatus, (status) => {
    const map: Record<string, { text: string; variant: string }> = {
      checking: { text: "Checking…", variant: "neutral" },
      available: { text: "Running & Available", variant: "success" },
      unavailable: { text: "Unavailable", variant: "warning" },
      error: { text: "Error", variant: "danger" },
    };
    const m = map[status.state]!;
    hostStatusEl.setAttribute("variant", m.variant);
    hostStatusEl.textContent = m.text;
    if (status.message) {
      hostError.textContent = status.message;
      hostError.style.display = "block";
    } else {
      hostError.style.display = "none";
    }
  }, { fireImmediately: true });

  store.subscribe((s) => s.pairing, (pairing) => {
    if (!pairing) {
      setChildren(pairingDetails, h("p", { class: "muted" }, "No active pairing found. Import a JSON pairing file below or set it up from the options page."));
      clearBtn.style.display = "none";
      return;
    }
    const p = pairing.pairingFile;
    setChildren(pairingDetails, h("dl", { class: "detail-list" },
      detailRow("Server PID", String(p.serverPid)),
      detailRow("WebSocket URL", p.wsUrl),
      detailRow("Auth Mode", p.authMode),
      detailRow("Issued At", new Date(p.issuedAt).toLocaleString()),
    ));
    clearBtn.style.display = "inline-flex";
  }, { fireImmediately: true });

  return root;
}

function detailRow(label: string, value: string): HTMLElement {
  return h("div", { class: "detail-row" }, h("dt", null, label), h("dd", null, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
