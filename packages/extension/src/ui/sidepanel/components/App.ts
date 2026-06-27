/**
 * Top-level sidepanel shell: header + connection status, a Shoelace tab group
 * (Servers / Pairing / Backup), and the resizable servers|tool-editor split.
 * Mounts the persistent server + test-tool dialogs.
 */
import { h } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { store } from "../store.js";
import { mountServerList } from "./ServerList.js";
import { mountToolEditor } from "./ToolEditor.js";
import { mountServerDialog } from "./ServerDialog.js";
import { mountTestToolDialog } from "./TestToolDialog.js";
import { mountImportDialog } from "./ImportDialog.js";
import { mountPairingPanel } from "./PairingPanel.js";
import { mountBackupPanel } from "./BackupPanel.js";

export function mountApp(root: HTMLElement): void {
  const statusPill = h("span", { class: "status-pill" },
    h("span", { class: "indicator" }),
    h("span", { class: "status-text" }, "Connecting…"),
  );

  const header = h("header", { class: "app-header" },
    h("div", { class: "logo-row" }, icon("plug", { size: 20 }), h("h1", { class: "logo-title" }, "Agentic Browser MCP")),
    statusPill,
  );

  const split = buildSplit();

  const tabGroup = h("sl-tab-group", { class: "app-tabs" },
    h("sl-tab", { slot: "nav", panel: "servers" }, "Servers & Tools"),
    h("sl-tab", { slot: "nav", panel: "pairing" }, "Pairing & Host"),
    h("sl-tab", { slot: "nav", panel: "backup" }, "Backup"),
    h("sl-tab-panel", { name: "servers" }, split),
    h("sl-tab-panel", { name: "pairing" }, mountPairingPanel()),
    h("sl-tab-panel", { name: "backup" }, mountBackupPanel()),
  );

  tabGroup.addEventListener("sl-tab-show", (e) => {
    const name = (e as CustomEvent<{ name: string }>).detail.name as "servers" | "pairing" | "backup";
    store.getState().setActiveTab(name);
  });

  root.append(header, tabGroup, mountServerDialog(), mountTestToolDialog(), mountImportDialog());

  store.subscribe((s) => s.connection, (connection) => {
    const paired = connection === "paired";
    statusPill.classList.toggle("connected", paired);
    statusPill.querySelector(".status-text")!.textContent = paired
      ? "Paired with local server"
      : "Unpaired (local server offline)";
  }, { fireImmediately: true });
}

function buildSplit(): HTMLElement {
  const left = mountServerList();
  const right = mountToolEditor();
  const divider = h("div", { class: "split-divider", title: "Drag to resize" });

  const split = h("div", { class: "split-layout" },
    h("div", { class: "split-pane split-left" }, left),
    divider,
    h("div", { class: "split-pane split-right" }, right),
  );

  const MIN_LEFT = 260;
  const MIN_RIGHT = 360;
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.classList.add("dragging");
    divider.setPointerCapture(e.pointerId);
    const onMove = (move: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const max = rect.width - MIN_RIGHT - divider.offsetWidth;
      let leftWidth = move.clientX - rect.left;
      leftWidth = Math.max(MIN_LEFT, Math.min(leftWidth, Math.max(MIN_LEFT, max)));
      split.style.setProperty("--left-width", `${leftWidth}px`);
    };
    const onUp = (up: PointerEvent) => {
      divider.classList.remove("dragging");
      divider.releasePointerCapture(up.pointerId);
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
  });

  return split;
}
