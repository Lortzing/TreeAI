/** Shared scripted browser protocol stubs. Every suite gets an independent SSE registry. */

export interface StubEventInit {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export interface StubEvent {
  type: string;
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export interface StubSseEvent {
  type: string;
  data: string;
}

export interface StubFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface StubResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function createStubEventSource() {
  class StubEventSource {
    private static readonly registry: StubEventSource[] = [];
  
    static resetRegistry(): void {
      StubEventSource.registry.length = 0;
    }
  
    static latest(): StubEventSource | null {
      return StubEventSource.registry[StubEventSource.registry.length - 1] ?? null;
    }
  
    readonly url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly sseListeners = new Map<string, Set<(event: StubSseEvent) => void>>();
  
    constructor(url: string) {
      this.url = url;
      StubEventSource.registry.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
  
    addEventListener(type: string, fn: (event: StubSseEvent) => void): void {
      if (!this.sseListeners.has(type)) this.sseListeners.set(type, new Set());
      this.sseListeners.get(type)!.add(fn);
    }
  
    close(): void {
      this.readyState = 2;
    }
  
    emit(type: string, data: unknown): void {
      const event: StubSseEvent = { type, data: JSON.stringify(data) };
      for (const fn of this.sseListeners.get(type) ?? []) fn(event);
    }
  }
  return StubEventSource;
}

interface SelectorElement {
  id: string;
  tagName: string;
  classList: { contains(name: string): boolean };
  children: unknown[];
}

export function matchesSelector(el: SelectorElement, sel: string): boolean {
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  let tag: string | null = null;
  let cls: string | null = null;
  let rest = sel;
  const dot = rest.indexOf(".");
  if (dot >= 0) {
    cls = rest.slice(dot + 1);
    rest = rest.slice(0, dot);
  }
  if (rest !== "") tag = rest.toLowerCase();
  if (tag !== null && el.tagName.toLowerCase() !== tag) return false;
  if (cls !== null && !el.classList.contains(cls)) return false;
  return true;
}

/** Capture the suite's own element constructor so instance checks keep their original meaning. */
export function createQueryAll<T extends SelectorElement>(Element: new (tag: string) => T) {
  return function queryAll(root: T, sel: string): T[] {
    const out: T[] = [];
    const walk = (el: T): void => {
      for (const c of el.children) {
        if (c instanceof Element) {
          if (matchesSelector(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(root);
    return out;
  };
}

export function stubResponse(status: number, payload: unknown): StubResponse {
  return { ok: status < 400, status, json: async () => payload };
}

export function createMemoryStorage(store: Map<string, string>) {
  return {
    getItem: (key: string): string | null => store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string): void => { store.set(key, String(value)); },
    removeItem: (key: string): void => { store.delete(key); },
    clear: (): void => { store.clear(); },
  };
}
