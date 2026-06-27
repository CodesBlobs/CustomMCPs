import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(currentDirectory, "..");
const outputDirectory = path.join(packageDirectory, "dist");

await mkdir(outputDirectory, { recursive: true });
await cp(path.join(packageDirectory, "manifest.json"), path.join(outputDirectory, "manifest.json"));
await cp(path.join(packageDirectory, "offscreen.html"), path.join(outputDirectory, "offscreen.html"));
await cp(path.join(packageDirectory, "options.html"), path.join(outputDirectory, "options.html"));
await cp(path.join(packageDirectory, "sidepanel.html"), path.join(outputDirectory, "sidepanel.html"));

// Copy Shoelace's static assets (icons used by its built-in components, e.g. the
// sl-dialog close button). setBasePath("shoelace") in src/ui/shared/setup.ts points
// the components at this folder so they never reach for a blocked CDN.
const shoelaceAssets = path.resolve(
  packageDirectory,
  "../../node_modules/@shoelace-style/shoelace/dist/assets",
);
await cp(shoelaceAssets, path.join(outputDirectory, "shoelace", "assets"), { recursive: true });
