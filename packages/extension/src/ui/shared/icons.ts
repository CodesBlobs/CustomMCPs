/**
 * Lucide icon helper. We cherry-pick the icon nodes we use and render them to
 * inline <svg> elements via Lucide's createElement, so icons stay bundled and
 * offline (no CDN, CSP-safe). Icons are typically slotted into Shoelace buttons.
 */
import {
  createElement,
  type IconNode,
  Plus,
  Pencil,
  Trash2,
  Play,
  X,
  Server,
  Wrench,
  Download,
  Upload,
  Plug,
  RefreshCw,
  WandSparkles,
  FlaskConical,
  Code,
  ListTree,
  Copy,
} from "lucide";

const NODES = {
  plus: Plus,
  pencil: Pencil,
  trash: Trash2,
  play: Play,
  x: X,
  server: Server,
  wrench: Wrench,
  download: Download,
  upload: Upload,
  plug: Plug,
  refresh: RefreshCw,
  format: WandSparkles,
  test: FlaskConical,
  code: Code,
  "list-tree": ListTree,
  copy: Copy,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof NODES;

export function icon(name: IconName, options: { size?: number; slot?: string } = {}): SVGElement {
  const size = options.size ?? 16;
  const el = createElement(NODES[name], {
    width: String(size),
    height: String(size),
    "stroke-width": "2",
  });
  el.style.display = "block";
  if (options.slot) {
    el.setAttribute("slot", options.slot);
  }
  return el;
}
