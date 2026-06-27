/**
 * One-time Shoelace setup shared by the sidepanel and options entries:
 * imports the light theme (bundled into <entry>.css by esbuild), points the
 * component asset base path at the locally-copied folder (CSP-safe, offline),
 * and registers the web components we use. Also exposes toast/confirm helpers
 * that replace the old blocking alert()/confirm() calls.
 */
import "@shoelace-style/shoelace/dist/themes/light.css";
import { setBasePath } from "@shoelace-style/shoelace/dist/utilities/base-path.js";

import "@shoelace-style/shoelace/dist/components/alert/alert.js";
import "@shoelace-style/shoelace/dist/components/badge/badge.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/card/card.js";
import "@shoelace-style/shoelace/dist/components/details/details.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/divider/divider.js";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/spinner/spinner.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import "@shoelace-style/shoelace/dist/components/textarea/textarea.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";

import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";

/** Must run before the first component renders so assets resolve locally. */
export function setupShoelace(): void {
  setBasePath(chrome.runtime.getURL("shoelace"));
}

type ToastVariant = "primary" | "success" | "neutral" | "warning" | "danger";

/** Non-blocking toast notification (replaces alert success/info messages). */
export function toast(message: string, variant: ToastVariant = "primary", duration = 3500): void {
  const alert = document.createElement("sl-alert") as HTMLElement & {
    closable: boolean;
    duration: number;
    toast: () => Promise<void>;
  };
  alert.setAttribute("variant", variant);
  alert.closable = true;
  alert.duration = duration;
  alert.textContent = message;
  document.body.append(alert);
  void alert.toast();
}

/**
 * Promise-based confirm dialog (replaces window.confirm). Resolves true when the
 * user confirms, false otherwise.
 */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("sl-dialog") as SlDialog;
    dialog.label = options.title;
    dialog.innerHTML = `
      <div style="font-size: 0.9rem; line-height: 1.5;"></div>
      <sl-button slot="footer" data-action="cancel">Cancel</sl-button>
      <sl-button slot="footer" variant="${options.danger ? "danger" : "primary"}" data-action="confirm">
        ${options.confirmLabel ?? "Confirm"}
      </sl-button>
    `;
    const body = dialog.querySelector("div");
    if (body) body.textContent = options.message;

    let result = false;
    dialog.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement)?.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "confirm") {
        result = true;
        void dialog.hide();
      } else if (action === "cancel") {
        void dialog.hide();
      }
    });
    dialog.addEventListener("sl-after-hide", () => {
      dialog.remove();
      resolve(result);
    });

    document.body.append(dialog);
    void dialog.show();
  });
}
