/**
 * Monaco setup for the Request Body Template editor. Bundled via esbuild (ESM)
 * instead of the AMD loader; language-service workers are loaded from
 * same-origin extension URLs (built as classic IIFE workers) because the MV3
 * extension CSP blocks monaco's default Blob/module workers.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// Importing the contribution registers the JSON language (side effect) and
// exposes jsonDefaults directly — it does not attach monaco.languages.json. The
// shipped .d.ts is empty (`export {}`) even though the JS exports jsonDefaults.
// @ts-expect-error -- runtime export exists; typings are missing.
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";

const jsonLanguageDefaults = jsonDefaults as {
  setDiagnosticsOptions(options: { validate?: boolean }): void;
};

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    const file = label === "json" ? "json.worker.js" : "editor.worker.js";
    return new Worker(chrome.runtime.getURL(file));
  },
};

// The body template allows {{...}} placeholder symbols that aren't valid JSON,
// so suppress the JSON language service's error squiggles/markers.
jsonLanguageDefaults.setDiagnosticsOptions({ validate: false });

export type BodyEditor = monaco.editor.IStandaloneCodeEditor;

export function createBodyEditor(container: HTMLElement, value: string, indent: number): BodyEditor {
  return monaco.editor.create(container, {
    value,
    language: "json",
    theme: "vs-light",
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    folding: true,
    wordWrap: "on",
    tabSize: indent,
    insertSpaces: true,
    detectIndentation: false,
  });
}

export type SchemaEditor = monaco.editor.IStandaloneCodeEditor;

/**
 * Create a Monaco editor for the Input Schema field. Unlike the body editor,
 * this one enables full JSON diagnostics since schemas are pure JSON.
 */
export function createSchemaEditor(container: HTMLElement, value: string): SchemaEditor {
  return monaco.editor.create(container, {
    value,
    language: "json",
    theme: "vs-light",
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    folding: true,
    wordWrap: "on",
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
  });
}

/**
 * Pretty-print JSON, tolerating {{...}} template placeholders by swapping them
 * for numeric tokens before parsing and restoring them afterwards. Ported from
 * the previous sidepanel implementation.
 */
export function formatJsonTemplate(text: string, indent: number): string {
  if (!text.trim()) return text;

  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    // Fall through to placeholder-aware formatting.
  }

  const placeholders: string[] = [];
  const tokenPrefix = Math.floor(10000000 + Math.random() * 90000000).toString();

  const processedText = text.replace(/\{\{[^{}]+\}\}/g, (match) => {
    const id = placeholders.length;
    placeholders.push(match);
    return `${tokenPrefix}${id}`;
  });

  const parsed = JSON.parse(processedText);
  let formatted = JSON.stringify(parsed, null, indent);

  placeholders.forEach((originalValue, index) => {
    const token = `${tokenPrefix}${index}`;
    formatted = formatted.replace(new RegExp(token, "g"), originalValue);
  });

  return formatted;
}
