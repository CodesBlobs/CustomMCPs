/**
 * Test-a-tool dialog (sl-dialog). Renders inputs derived from the tool's schema
 * / parameters / template symbols, runs the proxy request via the background,
 * and shows the HTTP result. Driven by store.testTool.
 */
import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";

import type { McpToolDefinition } from "../../../mcpToolStorage.js";
import { h, setChildren } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import * as api from "../../shared/api.js";
import { getToolParameters, type DisplayParam } from "../../shared/toolParams.js";
import { store } from "../store.js";

export function mountTestToolDialog(): HTMLElement {
  const argsContainer = h("div", { class: "test-args" });
  const resultContainer = h("div", { class: "test-result" });

  const runBtn = h("sl-button", { slot: "footer", variant: "primary" }, icon("play", { slot: "prefix" }), "Run Tool");
  const closeBtn = h("sl-button", { slot: "footer" }, "Close");

  const testLayout = h("div", { class: "test-layout" },
    h("div", { class: "test-left" },
      h("p", { class: "muted", style: "margin-bottom: 12px;" }, "Predefined symbols are resolved in the context of the active tab."),
      argsContainer,
    ),
    resultContainer,
  );

  const dialog = h("sl-dialog", { label: "Test Custom Tool", class: "test-dialog", style: "--width: 1190px;" },
    testLayout,
    closeBtn,
    runBtn,
  ) as HTMLElement as SlDialog;

  let context: { serverId: string; tool: McpToolDefinition } | null = null;

  closeBtn.addEventListener("click", () => store.getState().closeTestTool());
  dialog.addEventListener("sl-after-hide", (e) => {
    if (e.target === dialog) store.getState().closeTestTool();
  });

  runBtn.addEventListener("click", () => context && void run(context, argsContainer, resultContainer, runBtn));

  store.subscribe((s) => s.testTool, (state) => {
    context = state;
    if (!state) {
      if (dialog.open) void dialog.hide();
      return;
    }
    dialog.label = `Test: ${state.tool.name}`;
    setChildren(resultContainer);
    renderArgs(argsContainer, getToolParameters(state.tool));
    (runBtn as HTMLButtonElement).disabled = false;
    void dialog.show();
  });

  return dialog;
}

function getDefaultValue(name: string): string | undefined {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm === "namespace") return "nss";
  if (norm === "servicetype") return "pull";
  if (norm === "userid") return "xiaowei.wang";
  if (norm === "vhost") return "wxwio.com";
  if (norm === "domain") return "pull.wxwio.com";
  if (norm === "accountid") return "1000000006";
  return undefined;
}

function renderArgs(container: HTMLElement, params: DisplayParam[]): void {
  if (params.length === 0) {
    setChildren(container, h("p", { class: "muted" }, "This tool does not require any parameters."));
    return;
  }
  setChildren(container, ...params.map((p) => {
    let input: HTMLElement;
    const def = getDefaultValue(p.name);
    if (p.type === "boolean") {
      input = h("sl-select", { class: "arg", "data-name": p.name, "data-type": "boolean", value: def ?? "false" },
        h("sl-option", { value: "false" }, "false"),
        h("sl-option", { value: "true" }, "true"),
      );
    } else if (p.type === "number") {
      input = h("sl-input", { class: "arg", "data-name": p.name, "data-type": "number", type: "number", placeholder: "Numeric value", value: def ?? "" });
    } else if (p.type === "array") {
      input = h("sl-textarea", { class: "arg", "data-name": p.name, "data-type": "array", rows: "2", placeholder: 'e.g. ["a", "b"] or a, b', value: def ?? "" });
    } else if (p.type === "object" || (p.format && /json/i.test(p.format))) {
      input = h("sl-textarea", { class: "arg", "data-name": p.name, "data-type": "json-string", rows: "3", placeholder: "JSON value", value: def ?? "" });
    } else {
      input = h("sl-input", { class: "arg", "data-name": p.name, "data-type": "string", placeholder: "String value", value: def ?? "" });
    }
    const label = `${p.name}${p.required ? " *" : ""} (${p.type})`;
    const labelEl = h("label", null, label);
    const hintEl = p.description ? h("span", { class: "hint" }, p.description) : null;
    if (hintEl) {
      labelEl.addEventListener("click", () => hintEl.classList.toggle("visible"));
    }
    return h("div", { class: "form-group" },
      labelEl,
      input,
      hintEl,
    );
  }));
}

async function run(
  context: { serverId: string; tool: McpToolDefinition },
  argsContainer: HTMLElement,
  resultContainer: HTMLElement,
  runBtn: HTMLElement,
): Promise<void> {
  (runBtn as HTMLButtonElement).disabled = true;
  setChildren(resultContainer, h("div", { class: "status-banner" }, h("sl-spinner"), " Executing proxy request…"));

  const args: Record<string, unknown> = {};
  argsContainer.querySelectorAll<HTMLElement>(".arg").forEach((input) => {
    const name = input.getAttribute("data-name")!;
    const type = input.getAttribute("data-type")!;
    let value: unknown = (input as unknown as { value: string }).value;
    if (type === "number") {
      const n = Number(value);
      value = Number.isNaN(n) ? 0 : n;
    } else if (type === "boolean") {
      value = value === "true";
    } else if (type === "array") {
      const trimmed = (value as string).trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            value = parsed;
          } else {
            value = [parsed];
          }
        } catch {
          value = trimmed ? trimmed.split(",").map((s) => s.trim()) : [];
        }
      } else {
        value = trimmed ? trimmed.split(",").map((s) => s.trim()) : [];
      }
    } else if (type === "json-string") {
      try {
        const parsed = JSON.parse(value as string);
        if (typeof parsed === "object" && parsed !== null) value = parsed;
      } catch {
        // keep as plain string
      }
    }
    args[name] = value;
  });

  try {
    const r = await api.testTool(context.serverId, context.tool.id, args);
    const banner = r.error
      ? h("div", { class: "status-banner danger" }, `Failed: ${r.error}`)
      : h("div", { class: `status-banner ${r.status >= 200 && r.status < 300 ? "success" : "danger"}` },
          `HTTP ${r.status} ${r.statusText}`);
    let reqInfo = "";
    if (r.requestUrl) {
      reqInfo = `REQUEST:\n${r.requestMethod} ${r.requestUrl}\n`;
      if (r.requestHeaders && Object.keys(r.requestHeaders).length > 0) {
        reqInfo += `Headers:\n${JSON.stringify(r.requestHeaders, null, 2)}\n`;
      }
      if (r.requestBody) {
        reqInfo += `Body:\n${r.requestBody}\n`;
      }
      reqInfo += `\n────────────────────────────────────────────────────────────────\n\n`;
    }

    setChildren(resultContainer,
      banner,
      h("pre", { class: "result-pre" }, `${reqInfo}RESPONSE:\nHeaders:\n${JSON.stringify(r.headers, null, 2)}\n\nBody:\n${r.body}`),
    );
  } catch (error) {
    setChildren(resultContainer, h("div", { class: "status-banner danger" }, `Error: ${messageOf(error)}`));
  } finally {
    (runBtn as HTMLButtonElement).disabled = false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
