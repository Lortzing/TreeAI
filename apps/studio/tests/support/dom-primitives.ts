/** Shared scripted DOM operations; suite constructors and behavioral variants stay local. */
import type {
  StubEvent,
  StubEventInit,
} from "./browser-stubs.ts";

export function createStubText<E>() {
  class StubText {
    data: string;
    parentElement: E | null = null;
    constructor(data: string) { this.data = data; }
    get textContent(): string { return this.data; }
  }
  return StubText;
}

export function createClassList(classes: Set<string>) {
  return {
    add: (...names: string[]): void => { for (const c of names) classes.add(c); },
    remove: (...names: string[]): void => { for (const c of names) classes.delete(c); },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force === undefined ? !classes.has(c) : force;
      if (on) classes.add(c); else classes.delete(c);
      return on;
    },
    contains: (c: string): boolean => classes.has(c),
  };
}

export function setClassName(classes: Set<string>, value: string): void {
  classes.clear();
  for (const c of value.split(/\s+/)) if (c !== "") classes.add(c);
}

export function appendNode<N extends { parentElement: E | null }, E extends { children: N[]; removeChild(node: N): N }>(
  element: E, node: N | string, createText: (text: string) => N,
): N {
  const n: N = typeof node === "string" ? createText(node) : node;
  if (n.parentElement !== null) n.parentElement.removeChild(n);
  n.parentElement = element;
  element.children.push(n);
  return n;
}

export function insertNode<N extends { parentElement: E | null }, E extends {
  children: N[]; removeChild(node: N): N; appendChild(node: N): N;
}>(element: E, node: N | string, ref: N | null, createText: (text: string) => N): N {
  const n: N = typeof node === "string" ? createText(node) : node;
  if (ref === null || ref === undefined) { element.appendChild(n); return n; }
  if (n.parentElement !== null) n.parentElement.removeChild(n);
  const index = element.children.indexOf(ref);
  if (index < 0) { n.parentElement = element; element.children.push(n); }
  else { element.children.splice(index, 0, n); n.parentElement = element; }
  return n;
}

export function removeNode<N extends { parentElement: E | null }, E extends { children: N[] }>(element: E, node: N): N {
  const index = element.children.indexOf(node);
  if (index >= 0) { element.children.splice(index, 1); node.parentElement = null; }
  return node;
}

export function replaceNodes<N extends { parentElement: E | null }, E extends { children: N[]; append(...nodes: Array<N | string>): void }>(
  element: E, nodes: Array<N | string>,
): void {
  for (const c of element.children) c.parentElement = null;
  element.children = [];
  element.append(...nodes);
}

export function containsNode<N extends { parentElement: E | null }, E extends N>(element: E, node: N | null | undefined): boolean {
  let cur: N | null | undefined = node;
  while (cur !== null && cur !== undefined) { if (cur === element) return true; cur = cur.parentElement; }
  return false;
}

export function replaceText<N extends { parentElement: E | null }, E extends { children: N[] }>(
  element: E, value: string, createText: (text: string) => N,
): void {
  for (const c of element.children) c.parentElement = null;
  element.children = [];
  if (value !== "") { const text = createText(value); text.parentElement = element; element.children.push(text); }
}

export function addListener<E>(listeners: Map<string, Set<(event: E) => void>>, type: string, fn: (event: E) => void): void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
}

export function dispatchStubEvent(listeners: Map<string, Set<(event: StubEvent) => void>>, type: string, init: StubEventInit): boolean {
  const event: StubEvent = { type, preventDefault(): void {}, stopPropagation(): void {}, ...init };
  for (const fn of listeners.get(type) ?? []) fn(event);
  return true;
}

export function buildStubDom<E extends {
  parentElement: E | null; ownerDocument: D | null; setAttribute(key: string, value: string): void; appendChild(node: E): unknown;
}, D>(html: string, doc: D, Element: new (tag: string) => E): E {
  const src = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  const voidTags = new Set(["meta", "link", "br", "hr", "input", "img", "source"]);
  const root = new Element("#document");
  let current = root;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    const full = match[0];
    const tag = match[1]!.toLowerCase();
    if (full.startsWith("</")) { if (current.parentElement !== null) current = current.parentElement; continue; }
    const el = new Element(tag);
    el.ownerDocument = doc;
    const attrRe = /([a-zA-Z-]+)(?:\s*=\s*("[^"]*"|'[^']*'))?/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(match[2] ?? "")) !== null) {
      const value = attrMatch[2] !== undefined ? attrMatch[2]!.slice(1, -1) : "";
      el.setAttribute(attrMatch[1]!, value);
    }
    current.appendChild(el);
    if (!voidTags.has(tag)) current = el;
  }
  return root;
}

/** Fresh flattened document snapshot for every query, matching the original material harness. */
export function flattenNodes<N>(root: N | null, textOf: (node: N) => string | null, childrenOf: (node: N) => N[]) {
  const starts = new Map<N, number>();
  const ends = new Map<N, number>();
  let text = "";
  const walk = (node: N): void => {
    starts.set(node, text.length);
    const data = textOf(node);
    if (data !== null) { text += data; ends.set(node, text.length); return; }
    for (const child of childrenOf(node)) walk(child);
    ends.set(node, text.length);
  };
  if (root !== null) walk(root);
  return { text, starts, ends };
}
