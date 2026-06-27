import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(currentDirectory, "..");
const outputDirectory = path.join(packageDirectory, "dist");
const monacoEsm = path.resolve(packageDirectory, "../../node_modules/monaco-editor/esm/vs");

await mkdir(outputDirectory, { recursive: true });

// Clear previously emitted bundles (keep copied assets like shoelace/).
for (const fileName of await readdir(outputDirectory)) {
  if (fileName.endsWith(".js") || fileName.endsWith(".js.map") || fileName.endsWith(".css")) {
    await rm(path.join(outputDirectory, fileName), { force: true });
  }
}

const shared = {
  bundle: true,
  outdir: outputDirectory,
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
  // Shoelace ships its theme as a real stylesheet; bundle it into <entry>.css.
  // Lit component styles are CSS-in-JS and travel inside the JS.
  loader: {
    ".css": "css",
    ".woff": "file",
    ".woff2": "file",
    ".svg": "file",
    ".ttf": "file",
  },
};

// Main app + background bundles (ESM modules).
await build({
  ...shared,
  entryPoints: {
    offscreen: path.join(packageDirectory, "src", "offscreen.ts"),
    options: path.join(packageDirectory, "src", "options.ts"),
    serviceWorker: path.join(packageDirectory, "src", "serviceWorker.ts"),
    sidepanel: path.join(packageDirectory, "src", "sidepanel.ts"),
  },
  format: "esm",
});

// Monaco language-service workers as standalone classic (IIFE) workers, loaded
// from same-origin extension URLs by MonacoEnvironment.getWorker — the MV3
// extension CSP blocks monaco's default Blob/module workers.
await build({
  ...shared,
  entryPoints: {
    "editor.worker": path.join(monacoEsm, "editor", "editor.worker.js"),
    "json.worker": path.join(monacoEsm, "language", "json", "json.worker.js"),
  },
  format: "iife",
  sourcemap: false,
});
