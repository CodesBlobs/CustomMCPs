/**
 * Right pane: the add/edit custom-tool form. Two independent columns:
 * Left: Name+Method, Headers, URL, Body, Params, Response.
 * Right: Description, Input Schema with text/tree tabs.
 *
 * The Input Schema section uses Monaco for text editing and vanilla-jsoneditor
 * (tree-only mode) for visual tree browsing. A tab bar switches between them.
 */
import { createJSONEditor } from "vanilla-jsoneditor/standalone.js";
import type SlDialog from "@shoelace-style/shoelace/dist/components/dialog/dialog.js";

import type { McpToolDefinition, ToolParameter } from "../../../mcpToolStorage.js";
import { h, setChildren } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { parseCurlCommand } from "../../shared/curlImport.js";
import { toast } from "../../shared/setup.js";
import { createBodyEditor, createSchemaEditor, formatJsonTemplate, type BodyEditor, type SchemaEditor } from "../../shared/monaco.js";
import { store } from "../store.js";

type Method = McpToolDefinition["method"];
const METHODS: Method[] = ["GET", "POST", "PUT", "DELETE", "PATCH"];

export function mountToolEditor(): HTMLElement {
  const root = h("div", { class: "tool-pane" });

  let bodyEditor: BodyEditor | null = null;
  let schemaMonaco: SchemaEditor | null = null;
  let schemaTree: ReturnType<typeof createJSONEditor> | null = null;
  let applyImportedCurl: ((command: string) => void) | null = null;
  /** Which schema tab is active: "text" or "tree" */
  let activeSchemaTab: "text" | "tree" = "text";

  const curlInput = h("sl-textarea", {
    label: "Paste cURL Command",
    placeholder: "curl 'https://example.com/api' -H 'accept: application/json' --data-raw '{\"hello\":\"world\"}'",
    resize: "auto",
    rows: "12",
  });
  const curlCancelBtn = h("sl-button", { slot: "footer" }, "Cancel");
  const curlImportBtn = h("sl-button", { slot: "footer", variant: "primary" }, "Import");
  const curlDialog = h(
    "sl-dialog",
    {
      label: "Import Tool From cURL",
      style: "--width: min(900px, 92vw);",
    },
    h(
      "div",
      { class: "curl-import-dialog" },
      h(
        "p",
        { class: "muted" },
        "Paste a browser or terminal cURL command to populate the request URL, method, headers, cookies, and body."
      ),
      curlInput,
    ),
    curlCancelBtn,
    curlImportBtn,
  ) as SlDialog;

  const disposeEditors = () => {
    bodyEditor?.dispose();
    bodyEditor = null;
    schemaMonaco?.dispose();
    schemaMonaco = null;
    schemaTree?.destroy();
    schemaTree = null;
  };

  const showPlaceholder = () => {
    disposeEditors();
    applyImportedCurl = null;
    setChildren(
      root,
      h("div", { class: "tool-empty" },
        h("p", { class: "empty-state" }, "Select Edit on a tool — or Add Tool on a server — to configure it here."),
      ),
      curlDialog,
    );
  };

  const showForm = (serverId: string, tool?: McpToolDefinition) => {
    disposeEditors();

    const nameInput = h("sl-input", { id: "f-name", placeholder: "e.g. jira_search_issues", value: tool?.name ?? "", required: true });
    const methodSelect = h("sl-select", { id: "f-method", value: tool?.method ?? "GET" }, ...METHODS.map((m) => h("sl-option", { value: m }, m)));
    const descInput = h("sl-textarea", { id: "f-desc", placeholder: "Describe when the agent should call this tool.", value: tool?.description ?? "", resize: "auto" });
    const urlInput = h("sl-input", { id: "f-url", class: "code", placeholder: "https://host/api?q={{args:query}}", value: tool?.urlTemplate ?? "", required: true });
    const responseSelect = h("sl-select", { id: "f-response", value: tool?.responseType ?? "json" },
      h("sl-option", { value: "json" }, "JSON"),
      h("sl-option", { value: "text" }, "Plain Text"),
      h("sl-option", { value: "html" }, "HTML"),
    );
    const executionModeSelect = h("sl-select", { id: "f-exec-mode", value: tool?.executionMode ?? "browser-tab" },
      h("sl-option", { value: "browser-tab" }, "Browser Tab (default)"),
      h("sl-option", { value: "native-host" }, "Native Host"),
      h("sl-option", { value: "browser-navigation" }, "Browser Navigation"),
    );
    const parserScriptInput = h("sl-input", {
      id: "f-parser-script",
      class: "code",
      placeholder: "/path/to/parse_script.py",
      value: tool?.parserScriptPath ?? "",
    });

    // Header rows
    const headerRows = h("div", { class: "kv-rows" });
    const addHeaderRow = (key = "", val = "") => headerRows.append(buildHeaderRow(key, val));
    const addHeaderBtn = h("sl-button", { size: "small" }, icon("plus", { slot: "prefix" }), "Add Header");
    addHeaderBtn.addEventListener("click", () => addHeaderRow());
    Object.entries(tool?.headerTemplates ?? {}).forEach(([k, v]) => addHeaderRow(k, v));

    // Param rows
    const paramRows = h("div", { class: "kv-rows" });
    const addParamRow = (p?: Partial<ToolParameter>) => paramRows.append(buildParamRow(p));
    const addParamBtn = h("sl-button", { size: "small" }, icon("plus", { slot: "prefix" }), "Add Parameter");
    addParamBtn.addEventListener("click", () => addParamRow());
    (tool?.parameters ?? []).forEach((p) => addParamRow(p));

    // Body editor (Monaco) + indent + format
    const indentInput = h("sl-input", { id: "f-indent", type: "number", min: "1", max: "8", step: "1", value: "4", size: "small", class: "indent-input" });
    const formatBtn = h("sl-button", { size: "small" }, icon("format", { slot: "prefix" }), "Format");
    const bodyContainer = h("div", { class: "monaco-container" });

    // Input schema: tabbed text (Monaco) + tree (vanilla-jsoneditor)
    const schemaTextContainer = h("div", { class: "schema-monaco-container" });
    const schemaTreeContainer = h("div", { class: "schema-tree-container" });

    const tabText = h("button", { class: "schema-tab active", "data-tab": "text" }, icon("code"), "text");
    const tabTree = h("button", { class: "schema-tab", "data-tab": "tree" }, icon("list-tree"), "tree");
    const tabBar = h("div", { class: "schema-tabs" }, tabText, tabTree);

    // Start with text visible, tree hidden
    schemaTreeContainer.style.display = "none";

    const switchSchemaTab = (tab: "text" | "tree") => {
      if (tab === activeSchemaTab) return;

      // Sync content from the outgoing tab to the incoming tab
      if (tab === "tree" && schemaMonaco) {
        const text = schemaMonaco.getValue();
        try {
          const json = JSON.parse(text || "{}");
          schemaTree?.set({ json });
        } catch {
          // If invalid JSON, keep current tree content and warn
          toast("Cannot switch to tree: fix JSON syntax first.", "warning");
          return;
        }
      } else if (tab === "text" && schemaTree) {
        const content = schemaTree.get();
        let text: string;
        if ("text" in content && content.text !== undefined) {
          text = content.text;
        } else if ("json" in content) {
          text = JSON.stringify(content.json, null, 2);
        } else {
          text = "{}";
        }
        schemaMonaco?.setValue(text);
      }

      activeSchemaTab = tab;
      tabText.classList.toggle("active", tab === "text");
      tabTree.classList.toggle("active", tab === "tree");
      schemaTextContainer.style.display = tab === "text" ? "" : "none";
      schemaTreeContainer.style.display = tab === "tree" ? "" : "none";

      // Monaco needs a layout kick after becoming visible
      if (tab === "text") {
        requestAnimationFrame(() => schemaMonaco?.layout());
      }
    };

    tabText.addEventListener("click", () => switchSchemaTab("text"));
    tabTree.addEventListener("click", () => switchSchemaTab("tree"));

    const schemaContainer = h("div", { class: "schema-editor-wrapper" },
      tabBar, schemaTextContainer, schemaTreeContainer,
    );

    const getIndent = (): number => {
      const v = parseInt((indentInput as HTMLInputElement).value, 10);
      if (!Number.isFinite(v)) return 4;
      return Math.min(8, Math.max(1, v));
    };

    formatBtn.addEventListener("click", () => {
      if (!bodyEditor) return;
      try {
        bodyEditor.setValue(formatJsonTemplate(bodyEditor.getValue(), getIndent()));
      } catch (err) {
        toast(`Could not format: ensure valid JSON (excluding placeholders). ${messageOf(err)}`, "warning");
      }
    });
    indentInput.addEventListener("sl-change", () => {
      const indent = getIndent();
      (indentInput as HTMLInputElement).value = String(indent);
      bodyEditor?.getModel()?.updateOptions({ tabSize: indent, insertSpaces: true });
    });

    applyImportedCurl = (command: string) => {
      const parsed = parseCurlCommand(command);

      if (!val(nameInput).trim()) {
        setFieldValue(nameInput, parsed.suggestedName);
      }
      if (!val(descInput).trim()) {
        setFieldValue(descInput, parsed.suggestedDescription);
      }

      setFieldValue(methodSelect, parsed.method);
      setFieldValue(urlInput, parsed.urlTemplate);
      setFieldValue(responseSelect, parsed.responseType);
      setChildren(
        headerRows,
        ...Object.entries(parsed.headerTemplates).map(([key, value]) => buildHeaderRow(key, value)),
      );
      bodyEditor?.setValue(parsed.bodyTemplate);

      if (parsed.notes.length > 0) {
        toast(`Imported cURL with notes: ${parsed.notes[0]}`, "warning", 6000);
      } else {
        toast("Imported request details from cURL.", "success");
      }
    };

    // Header: title + Cancel + Save
    const cancelBtn = h("sl-button", { size: "small" }, "Cancel");
    cancelBtn.addEventListener("click", () => store.getState().closeToolEditor());
    const importBtn = h("sl-button", { size: "small" }, icon("upload", { slot: "prefix" }), "Import cURL");
    importBtn.addEventListener("click", () => {
      setFieldValue(curlInput, "");
      void curlDialog.show();
      setTimeout(() => (curlInput as HTMLElement & { focus: () => void }).focus(), 0);
    });
    const saveBtn = h("sl-button", { variant: "primary", size: "small" }, "Save Tool");
    saveBtn.addEventListener("click", () => {
      // Read the editor refs lazily — they're created after the form is mounted.
      void onSave({
        serverId,
        existing: tool,
        nameInput, methodSelect, descInput, urlInput, responseSelect, executionModeSelect, parserScriptInput,
        headerRows, paramRows,
        getBody: () => bodyEditor,
        getSchemaText: () => {
          // Read from whichever editor is active
          if (activeSchemaTab === "tree" && schemaTree) {
            const content = schemaTree.get();
            if ("text" in content && content.text !== undefined) return content.text;
            if ("json" in content) return JSON.stringify(content.json, null, 2);
            return "";
          }
          return schemaMonaco?.getValue() ?? "";
        },
      });
    });

    const header = h("div", { class: "tool-header" },
      h("span", { class: "tool-header-title" }, tool ? "Edit Custom Tool" : "Add Custom Tool"),
      h("div", { class: "tool-header-actions" }, importBtn, cancelBtn, saveBtn),
    );

    const leftCol = h("div", { class: "tool-col tool-col-left" },
      field("tg-name", "Tool Name & Method",
        h("div", { class: "name-method" }, nameInput, methodSelect)),
      field("tg-headers", "Header Templates", headerRows, addHeaderBtn),
      field("tg-url", "URL Template (supports {{cookie:…}}, {{localStorage:…}}, {{args:…}})", urlInput),
      field("tg-body", bodyLabel(indentInput, formatBtn), bodyContainer),
      field("tg-params", "Agent Parameters", paramRows, addParamBtn),
      field("tg-response", "Expected Response Format", responseSelect),
      field("tg-exec-mode", "Request Execution Mode", executionModeSelect,
        h("p", { class: "muted", style: "font-size:0.8em;margin:2px 0 0" },
          "Browser Tab runs fetch() inside the active browser tab — use this for Cloudflare-protected sites.")),
      field("tg-parser-script", "Parser Script Path (optional)", parserScriptInput,
        h("p", { class: "muted", style: "font-size:0.8em;margin:2px 0 0" },
          "Local script (e.g. a Python file) run by the native host from the Test dialog. It receives the tool's raw response body on stdin and should print CSV on stdout.")),
    );

    const rightCol = h("div", { class: "tool-col tool-col-right" },
      field("tg-desc", "Description", descInput),
      field("tg-schema", "Input Schema (JSON Schema; overrides parameters)", schemaContainer),
    );

    const grid = h("div", { class: "tool-grid" }, leftCol, rightCol);

    setChildren(root, h("div", { class: "tool-panel" }, header, grid), curlDialog);

    // Create editors after the form is in the DOM so they get real dimensions.
    bodyEditor = createBodyEditor(bodyContainer, tool?.bodyTemplate ?? "", getIndent());

    // Schema text editor (Monaco with JSON validation enabled)
    const schemaValue = tool?.inputSchema || "{}";
    schemaMonaco = createSchemaEditor(schemaTextContainer, schemaValue);

    // Schema tree viewer (vanilla-jsoneditor, tree mode only)
    let initialJson: unknown;
    try { initialJson = JSON.parse(schemaValue); } catch { initialJson = {}; }
    schemaTree = createJSONEditor({
      target: schemaTreeContainer,
      props: {
        mode: "tree",
        mainMenuBar: false,
        content: { json: initialJson },
        onRenderContextMenu: () => false,
      },
    });
  };

  store.subscribe((s) => s.toolEditor, (toolEditor) => {
    if (!toolEditor) showPlaceholder();
    else showForm(toolEditor.serverId, toolEditor.tool);
  }, { fireImmediately: true });

  curlCancelBtn.addEventListener("click", () => {
    void curlDialog.hide();
  });
  curlImportBtn.addEventListener("click", () => {
    const command = val(curlInput).trim();
    if (!command) {
      toast("Paste a cURL command to import.", "warning");
      return;
    }
    if (!applyImportedCurl) {
      toast("Open a tool editor before importing cURL.", "warning");
      return;
    }

    try {
      applyImportedCurl(command);
      void curlDialog.hide();
    } catch (error) {
      toast(`Could not parse cURL: ${messageOf(error)}`, "danger", 6000);
    }
  });

  return root;
}

// ─── save ────────────────────────────────────────────────────────────────────

interface SaveCtx {
  serverId: string;
  existing?: McpToolDefinition;
  nameInput: HTMLElement;
  methodSelect: HTMLElement;
  descInput: HTMLElement;
  urlInput: HTMLElement;
  responseSelect: HTMLElement;
  executionModeSelect: HTMLElement;
  parserScriptInput: HTMLElement;
  headerRows: HTMLElement;
  paramRows: HTMLElement;
  getBody: () => BodyEditor | null;
  getSchemaText: () => string;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  const name = val(ctx.nameInput).trim();
  const urlTemplate = val(ctx.urlInput).trim();
  if (!name) return void toast("Tool name is required.", "warning");
  if (!/^[a-z0-9_]+$/.test(name)) return void toast("Tool name must be lowercase snake_case.", "warning");
  if (!urlTemplate) return void toast("URL template is required.", "warning");

  const headerTemplates: Record<string, string> = {};
  ctx.headerRows.querySelectorAll<HTMLElement>(".kv-row").forEach((row) => {
    const key = val(row.querySelector(".kv-key")!).trim();
    const value = val(row.querySelector(".kv-val")!).trim();
    if (key && value) headerTemplates[key] = value;
  });

  const parameters: ToolParameter[] = [];
  ctx.paramRows.querySelectorAll<HTMLElement>(".kv-row").forEach((row) => {
    const pName = val(row.querySelector(".p-name")!).trim();
    if (!pName) return;
    parameters.push({
      name: pName,
      type: val(row.querySelector(".p-type")!) as ToolParameter["type"],
      description: val(row.querySelector(".p-desc")!).trim(),
      required: (row.querySelector(".p-req") as HTMLInputElement).checked,
    });
  });

  const bodyEditor = ctx.getBody();
  let inputSchema: string | undefined;
  const schemaText = ctx.getSchemaText().trim();
  if (schemaText && schemaText !== "{}") {
    try {
      JSON.parse(schemaText);
      inputSchema = schemaText;
    } catch {
      return void toast("Input Schema must be valid JSON.", "warning");
    }
  }

  const now = new Date().toISOString();
  const executionMode = val(ctx.executionModeSelect) as McpToolDefinition["executionMode"];
  const tool: McpToolDefinition = {
    id: ctx.existing?.id ?? crypto.randomUUID(),
    serverId: ctx.serverId,
    name,
    description: val(ctx.descInput).trim(),
    method: val(ctx.methodSelect) as Method,
    urlTemplate,
    headerTemplates,
    bodyTemplate: bodyEditor ? bodyEditor.getValue() : "",
    parameters,
    responseType: val(ctx.responseSelect) as McpToolDefinition["responseType"],
    executionMode: executionMode === "native-host" ? "native-host" : executionMode === "browser-navigation" ? "browser-navigation" : "browser-tab",
    enabled: ctx.existing?.enabled ?? true,
    createdAt: ctx.existing?.createdAt ?? now,
    updatedAt: now,
    inputSchema,
    parserScriptPath: val(ctx.parserScriptInput).trim() || undefined,
  };

  const ok = await store.getState().saveTool(ctx.serverId, tool);
  if (ok) {
    toast("Tool saved.", "success");
  }
}

// ─── small builders ────────────────────────────────────────────────────────

function field(cls: string, label: string | HTMLElement, ...content: (HTMLElement | string)[]): HTMLElement {
  const labelEl = typeof label === "string" ? h("label", null, label) : label;
  return h("div", { class: `form-group ${cls}` }, labelEl, ...content);
}

function bodyLabel(indentInput: HTMLElement, formatBtn: HTMLElement): HTMLElement {
  return h("div", { class: "body-label" },
    h("label", null, "Request Body Template (optional)"),
    h("div", { class: "body-label-controls" },
      h("label", { class: "indent-label" }, "Indent"),
      indentInput,
      formatBtn,
    ),
  );
}

function buildHeaderRow(key: string, val: string): HTMLElement {
  const keyInput = h("sl-input", { class: "kv-key", placeholder: "Header Name", value: key, size: "small" });
  const valInput = h("sl-input", { class: "kv-val", placeholder: "Value Template", value: val, size: "small" });
  const removeBtn = h("sl-button", { title: "Remove", class: "icon-button danger" }, icon("x"));
  const row = h("div", { class: "kv-row header-row" }, keyInput, valInput, removeBtn);
  removeBtn.addEventListener("click", () => row.remove());
  return row;
}

function buildParamRow(p?: Partial<ToolParameter>): HTMLElement {
  const nameInput = h("sl-input", { class: "p-name", placeholder: "name", value: p?.name ?? "", size: "small" });
  const typeSelect = h("sl-select", { class: "p-type", value: p?.type ?? "string", size: "small" },
    h("sl-option", { value: "string" }, "string"),
    h("sl-option", { value: "number" }, "number"),
    h("sl-option", { value: "boolean" }, "boolean"),
  );
  const descInput = h("sl-input", { class: "p-desc", placeholder: "description", value: p?.description ?? "", size: "small" });
  const reqSwitch = h("sl-switch", { class: "p-req", size: "small", title: "Required", ...(p?.required ?? true ? { checked: true } : {}) });
  const removeBtn = h("sl-button", { title: "Remove", class: "icon-button danger" }, icon("x"));
  const row = h("div", { class: "kv-row param-row" }, nameInput, typeSelect, descInput, reqSwitch, removeBtn);
  removeBtn.addEventListener("click", () => row.remove());
  return row;
}

// ─── value helpers ─────────────────────────────────────────────────────────

function val(el: Element): string {
  return (el as unknown as { value?: string }).value ?? "";
}

function setFieldValue(el: Element, value: string): void {
  (el as { value?: string }).value = value;
}

// editorText removed — schema text is now read directly via getSchemaText().

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
