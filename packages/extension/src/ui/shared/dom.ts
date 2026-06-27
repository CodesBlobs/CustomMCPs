/**
 * Tiny hyperscript-style DOM helper. Keeps component code declarative without a
 * framework. Works for plain elements and Shoelace custom elements alike
 * (attribute-driven). Use direct property assignment for the few cases that
 * need it (e.g. setting an <sl-input>.value after creation).
 */
export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  html?: string;
  [key: string]: unknown;
}

export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") {
      el.className = String(value);
    } else if (key === "html") {
      el.innerHTML = String(value);
    } else if (key === "style") {
      if (typeof value === "string") el.setAttribute("style", value);
      else Object.assign(el.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child);
  }
}

/** Replace all children of a node with the given content. */
export function setChildren(parent: Node, ...children: Child[]): void {
  (parent as Element).replaceChildren();
  append(parent, children);
}
