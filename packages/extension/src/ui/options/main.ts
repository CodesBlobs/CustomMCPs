/**
 * Options page: manage the stored manual pairing JSON. Rebuilt with Shoelace.
 * Talks to pairingStorage directly (chrome.storage), same as before.
 */
import "./options.css";
import type { PairingFile } from "@agentic-browser-mcp/shared";

import {
  clearStoredPairing,
  readStoredPairingState,
  writeStoredPairingJson,
} from "../../pairingStorage.js";
import { h, setChildren } from "../shared/dom.js";
import { icon } from "../shared/icons.js";
import { setupShoelace, toast } from "../shared/setup.js";

setupShoelace();

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element.");

const connectionStatus = h("p", { class: "muted" }, "Loading…");
const pairingDetails = h("dl", { class: "detail-list" });

const textarea = h("sl-textarea", { id: "pairing-json", rows: "12", class: "code", placeholder: "Paste pairing JSON here…", resize: "vertical" }) as HTMLElement & { value: string; disabled: boolean };
const fileInput = h("input", { type: "file", accept: ".json", style: "display:none" }) as HTMLInputElement;

const chooseBtn = h("sl-button", null, icon("upload", { slot: "prefix" }), "Choose File…");
const importBtn = h("sl-button", { variant: "primary" }, "Import Pairing JSON");
const clearBtn = h("sl-button", { variant: "danger" }, icon("trash", { slot: "prefix" }), "Clear Stored Pairing");

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  textarea.value = await file.text();
  toast(`Loaded ${file.name}. Review it and click Import.`, "neutral");
  fileInput.value = "";
});

importBtn.addEventListener("click", async () => {
  setBusy(true);
  try {
    const storedState = await writeStoredPairingJson(textarea.value);
    textarea.value = JSON.stringify(storedState.pairingFile, null, 2);
    await refreshView();
    toast(`Manual pairing saved for ${storedState.pairingFile.wsUrl}.`, "success");
  } catch (error) {
    toast(`Failed to save pairing JSON: ${messageOf(error)}`, "danger", 6000);
  } finally {
    setBusy(false);
  }
});

clearBtn.addEventListener("click", async () => {
  setBusy(true);
  try {
    await clearStoredPairing();
    await refreshView({ clearTextarea: false });
    toast("Stored manual pairing cleared. Auto-discovery remains active.", "success");
  } catch (error) {
    toast(`Failed to clear pairing: ${messageOf(error)}`, "danger");
  } finally {
    setBusy(false);
  }
});

const DOMAIN_MAP = [
  { name: "ROW", domainId: "ttp-row" },
  { name: "EU", domainId: "ttp-eu" },
  { name: "US", domainId: "ttp-us-limited" },
];

async function fetchJwt(domainId: string): Promise<string> {
  return "";
}

function createJwtRow(name: string, domainId: string): HTMLElement {
  const tokenInput = h("sl-input", {
    readonly: true,
    class: "jwt-input",
    placeholder: "Click 'Fetch' to retrieve token...",
    value: ""
  }) as HTMLInputElement;

  const fetchBtn = h("sl-button", { variant: "primary", size: "small" }, "Fetch");
  const copyBtn = h("sl-button", { variant: "neutral", size: "small", disabled: true }, "Copy");

  fetchBtn.addEventListener("click", async () => {
    fetchBtn.setAttribute("disabled", "");
    copyBtn.setAttribute("disabled", "");
    tokenInput.value = "Fetching...";
    try {
      const jwt = await fetchJwt(domainId);
      if (jwt) {
        tokenInput.value = jwt;
        copyBtn.removeAttribute("disabled");
        toast(`Successfully fetched JWT token for ${name}.`, "success");
      } else {
        tokenInput.value = "";
        toast(`No JWT token found for ${name}. Are you logged in?`, "warning");
      }
    } catch (err) {
      tokenInput.value = `Error: ${messageOf(err)}`;
      toast(`Failed to fetch JWT token for ${name}: ${messageOf(err)}`, "danger");
    } finally {
      fetchBtn.removeAttribute("disabled");
    }
  });

  copyBtn.addEventListener("click", () => {
    if (tokenInput.value && tokenInput.value !== "Fetching..." && !tokenInput.value.startsWith("Error:")) {
      navigator.clipboard.writeText(tokenInput.value)
        .then(() => toast(`JWT token for ${name} copied to clipboard.`, "success"))
        .catch((err) => toast(`Failed to copy: ${messageOf(err)}`, "danger"));
    }
  });

  return h("div", { class: "jwt-row" },
    h("div", { class: "jwt-header" },
      h("span", { class: "jwt-label" }, `${name} (${domainId})`)
    ),
    h("div", { class: "jwt-controls" },
      tokenInput,
      fetchBtn,
      copyBtn
    )
  );
}

const jwtRows = DOMAIN_MAP.map((domain) => createJwtRow(domain.name, domain.domainId));
const jwtCard = h("sl-card", { class: "panel-card" },
  h("h2", null, "JWT Tokens"),
  h("p", { class: "muted" }, "Fetch and copy JWT authentication tokens for ROW, EU, and US domains."),
  h("div", { class: "jwt-section" }, ...jwtRows)
);

root.append(
  h("main", { class: "options-main" },
    h("h1", null, "Agentic Browser MCP — Pairing"),
    h("p", { class: "muted" }, "Manually store a pairing JSON file to connect the extension to your local bridge server. Auto-discovery scans the default loopback port range when no manual pairing is stored."),
    h("sl-card", { class: "panel-card" },
      h("h2", null, "Connection"),
      connectionStatus,
      pairingDetails,
    ),
    h("sl-card", { class: "panel-card" },
      h("h2", null, "Manual Pairing JSON"),
      h("div", { class: "form-row" }, chooseBtn, fileInput),
      textarea,
      h("div", { class: "form-actions" }, importBtn, clearBtn),
    ),
    jwtCard,
  ),
);

void refreshView();

async function refreshView(options: { clearTextarea?: boolean } = {}): Promise<void> {
  const storedState = await readStoredPairingState();
  if (!storedState) {
    connectionStatus.textContent = "No manual pairing JSON stored. The extension will auto-scan the default loopback port range.";
    setChildren(pairingDetails);
    clearBtn.style.display = "none";
    if (options.clearTextarea ?? true) textarea.value = "";
    return;
  }
  connectionStatus.textContent = `Stored manual pairing prefers ${storedState.pairingFile.wsUrl}.`;
  renderDetails(storedState.pairingFile, storedState.importedAt);
  clearBtn.style.display = "inline-flex";
  textarea.value = JSON.stringify(storedState.pairingFile, null, 2);
}

function renderDetails(pairingFile: PairingFile, importedAt: string): void {
  const rows: Array<[string, string]> = [
    ["Server instance", pairingFile.serverInstanceId],
    ["WebSocket URL", pairingFile.wsUrl],
    ["Auth mode", pairingFile.authMode],
    ["Port range", `${pairingFile.portRange.start}-${pairingFile.portRange.end}`],
    ["Issued at", formatDate(pairingFile.issuedAt)],
    ["Expires at", formatDate(pairingFile.expiresAt)],
    ["Imported at", formatDate(importedAt)],
  ];
  setChildren(pairingDetails, ...rows.map(([label, value]) =>
    h("div", { class: "detail-row" }, h("dt", null, label), h("dd", null, value)),
  ));
}

function setBusy(busy: boolean): void {
  for (const el of [importBtn, clearBtn, chooseBtn]) (el as HTMLElement & { disabled: boolean }).disabled = busy;
  textarea.disabled = busy;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
