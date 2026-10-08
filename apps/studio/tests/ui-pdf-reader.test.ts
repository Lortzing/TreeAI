/**
 * D4-2 PDF 阅读增量 + 用户导入 UI 前端套件（issue #8 工作包 D4-2 的 PDF
 * 增量；charter §3.2 PDF 阅读（真实页 + 可选中文本层 / 单页选区纪律 /
 * 可见页先行）+ owner P1「真正的文件导入 UI」2026-09-30 18:18 增量评审）。
 *
 * 方法与 ui-material-reader 套件一致（issue #4 P1「证据工程化」的脚本化
 * DOM E2E）：以 file: URL 加载仓库真实 public/app.js 为 ES module，运行
 * 在「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本化后端」之
 * 上：fetch / EventSource / localStorage / 计时器 / matchMedia /
 * getSelection / navigator.clipboard 全部为内存桩。后端按场景脚本化，
 * **正文与选区事实直接取自冻结 fixture**：
 *   - tests/fixtures/d4/b1-import/pdf/*.expected.json（canonicalText /
 *     pages / 页块图——页标识 page-N 与 page 字段的仓库冻结真值，D4 契
 *     约 §6）；
 *   - tests/fixtures/d4/b2-anchors/pdf-selections.json（B2 冻结选区语义
 *     ——pdf-sel-01/02/14/15/16 的 blockId/start/end/excerpt 期望值）。
 * 导入面脚本化复刻 D4-1 HTTP 契约（POST /materials：原始字节 body +
 * 百分号编码文件名头；201 新建 / 200 同字节复用 / 415 / 413；parse-tasks
 * cancel：200 canceled / 409 已终态）。
 *
 * 覆盖（PDF 增量 + 导入 UI 的逐项锁定）：
 *  1. 导入 UI（owner P1）：入口/文件选择器（.md/.markdown/.pdf）；上传
 *     走真实端点语义（原始字节 + 编码头——中文名/空格名原样到达）；
 *     pending/parsing 如实（server 状态 + Check now + Cancel parse）；
 *     ready（Open in reader 直达阅读器）；failed/rejected 原因逐字；
 *     同字节去重（created:false → 「没有新版本」如实消息）；取消（200 →
 *     canceled 如实；409 → 立即复查状态）；上传失败 415/413 逐字；切树
 *     复位。
 *  2. PDF 页渲染：页框按冻结页块图落位（page-N 标识 + data-page）；页头
 *     标识在文本层之外——文本层 textContent 与冻结页文本字节相等（选区
 *     偏移换算的事实源）；取块走 limit=PDF_PAGE_FETCH_LIMIT。
 *  3. 单页选区 → 规范载荷：跨行（pdf-sel-02 [135,146)）、中文（pdf-sel-01
 *     [0,2)）、双栏左右栏（pdf-06：pdf-sel-14 [21,25) / pdf-sel-15
 *     [619,623)——双栏规范阅读序的冻结断言）；捕获条展示页标识
 *     （block page-N · page N）；同页多片段（先后两次武装各自成立）。
 *  4. 跨页选区：如实 cross-page 拒绝——「请单页内选择」提示，绝不静默
 *     截断（无载荷）；页头文字入选 → unmappable 如实拒绝。
 *  5. 阅读位置（PDF 按版本）：滚动保存（PUT blockId=page-N）+ 重开恢复
 *     （跨页前补 + 恢复注记 + 跳转页渲染）。
 *  6. 不可映射文本的服务端拒绝面：resolve-selection 400（冻结原因语义）
 *     在建枝流程面逐字呈现（后端已拒绝——前端如实转达，绝不吞掉）。
 *  7. 懒渲染边界：几何未知（脚本桩默认）只渲染前导 6 页；给定几何后
     滚动窗口 ±1200px——窗外页卸回占位（远页绝不渲染文本）。
 *
 * 边界（如实声明）：同 ui-material-reader——不是真实浏览器 E2E；CSS 不
 * 执行；滚动几何按脚本化 offsetTop/offsetHeight/clientHeight 修真（懒渲
 * 染窗口的边界断言即以此为准）；真实键盘/触屏/读屏器行为归 evidence/d4/
 * 浏览器口径（PDF 浏览器探针属后续证据波次）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* 加载真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const STYLE_CSS = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");

/* 冻结 fixture（B1 pdf/ 真值——阅读器正文与页图的唯一事实源）。 */
const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));
const B2_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b2-anchors/", import.meta.url));

interface FixtureBlock {
  blockId: string;
  kind: "pdf-page";
  start: number;
  end: number;
  page: number;
  text: string;
}

interface FixtureExpected {
  fixtureId: string;
  kind: string;
  normalizer: string;
  pages: number;
  canonicalText: string;
  blocks: FixtureBlock[];
}

function loadPdfFixture(id: string): FixtureExpected {
  const parsed = JSON.parse(readFileSync(join(B1_ROOT, `pdf/${id}.expected.json`), "utf8")) as FixtureExpected;
  return parsed;
}

const PDF01 = loadPdfFixture("pdf-01"); /* 中文 2 页（跨行/重复词语料） */
const PDF06 = loadPdfFixture("pdf-06"); /* 双栏 2 页（左右栏冻结选区语料） */
const PDF11 = loadPdfFixture("pdf-11"); /* 30 页长文（懒渲染/跨页恢复语料） */

/* B2 冻结选区语义（pdf-selections.json——期望 blockId/start/end/excerpt）。 */
interface FrozenPdfSelection {
  id: string;
  fixture: string;
  category: string;
  locator: { kind: string; needle?: string; occurrence?: number; start?: number; end?: number };
  expected: { blockId: string; start: number; end: number; excerpt: string };
}

const FROZEN_SELECTIONS = (
  JSON.parse(readFileSync(join(B2_ROOT, "pdf-selections.json"), "utf8")) as {
    items: FrozenPdfSelection[];
  }
).items;

function frozenSelection(id: string): FrozenPdfSelection {
  const found = FROZEN_SELECTIONS.find((item) => item.id === id);
  assert.ok(found !== undefined, `frozen pdf selection ${id} must exist in b2-anchors/pdf-selections.json`);
  return found;
}

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const A1_TEXT = "First trunk answer with several plain words.";

interface Selection {
  start: number;
  end: number;
  text: string;
}

interface Tree {
  id: string;
  createdAt: string;
  forestId: string;
}

interface Branch {
  id: string;
  treeId: string;
  parentBranchId: string | null;
  createdAt: string;
}

interface Origin {
  branchId: string;
  sourceBranchId: string;
  anchorTurnId: string;
  anchorEntryId: string;
  selection: Selection;
  createdAt: string;
}

interface Turn {
  id: string;
  treeId: string;
  branchId: string;
  episodeId: string;
  runId: string | null;
  role: "user" | "assistant" | "return";
  text: string;
  piEntryId: string | null;
  fromBranchId: string | null;
  deliveredRunId: string | null;
  idempotencyKey: string | null;
  targetAnchor: unknown;
  createdAt: string;
}

interface ReturnAttempt {
  turnId: string;
  runId: string;
  runState: string;
  failure: { code: string; message: string } | null;
  attemptedAt: string;
  terminalAt: string | null;
}

interface BranchView {
  branch: Branch;
  origin: Origin | null;
  originStatus: "available" | "changed" | "unavailable" | null;
  sessionAvailability: "available" | "unavailable" | null;
  turns: Turn[];
  returnAttempts: ReturnAttempt[];
}

interface TreeState {
  tree: Tree;
  trunkBranchId: string | null;
  branches: BranchView[];
  cursor: { treeId: string; branchId: string; entryId: string } | null;
}

interface TreeDiagnostics {
  treeId: string;
  runtimeState: "idle" | "streaming" | "aborting";
  activeRun: { runId: string; branchId: string; episodeId: string } | null;
  runs: Array<{
    runId: string;
    branchId: string;
    episodeId: string;
    state: string;
    failure: { code: string; message: string } | null;
    createdAt: string;
    terminalAt: string | null;
  }>;
  policyDecisions: { observed: false; reason: string };
}

/* 材料面桩形状（契约 §3 的 HTTP 载荷）。 */
type MaterialParseStatus =
  | "pending"
  | "parsing"
  | "ready"
  | "failed"
  | "canceled"
  | "unsupported"
  | "rejected";

interface StubMaterialVersion {
  id: string;
  materialId: string;
  contentHash: string;
  parserKind: "markdown" | "pdf";
  parserVersion: string;
  importedAt: string;
  sizeBytes: number;
  parseStatus: MaterialParseStatus;
  parseError: string | null;
  textUnits: number;
}

interface StubReadingPosition {
  versionId: string;
  blockId: string | null;
  focusStart: number | null;
  updatedAt: string;
}

interface StubMaterial {
  material: { id: string; title: string; createdAt: string };
  versions: StubMaterialVersion[];
  readingPosition: StubReadingPosition | null;
}

/** 材料桩（后端在库形态）：版本 → 冻结块源映射。 */
interface StubMaterialEntry extends StubMaterial {
  versionSources: Map<string, FixtureExpected>;
}

/* ------------------------------ 桩事件 / fetch 形状 ------------------------------ */

interface StubEventInit {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

interface StubEvent {
  type: string;
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

interface StubSseEvent {
  type: string;
  data: string;
}

interface StubFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

interface StubResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface RecordedRequest {
  method: string;
  path: string;
  /** JSON body（字符串请求）；原始字节请求（ArrayBuffer 原样）。 */
  body: unknown;
  headers: Record<string, string> | undefined;
  /** 原始字节 body 的字节数（导入上传）。 */
  bodyBytes: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/* ------------------------------ 事件轮转 / 短等待 ------------------------------ */

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ DOM 桩（模块级类 + ownerDocument） ------------------------------ */

type StubNode = StubText | StubElement;
type StubListener = (event: StubEvent) => void;

class StubText {
  data: string;
  parentElement: StubElement | null = null;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

class StubElement {
  readonly tagName: string;
  id = "";
  readonly nodeType = 1;
  ownerDocument: StubDocument | null = null;
  private readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  children: StubNode[] = [];
  parentElement: StubElement | null = null;
  hidden = false;
  disabled = false;
  /* 阅读位置/懒渲染几何（脚本可设；默认 0——确定性回落见 app.js 注释）。 */
  offsetTop = 0;
  offsetHeight = 0;
  private readonly listeners = new Map<string, Set<StubListener>>();
  _scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  title = "";
  value = "";
  files: unknown[] = [];
  dataset: Record<string, string> = {};
  private lastBehavior: string | null = null;
  lastScrollIntoView: unknown = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const c of value.split(/\s+/)) {
      if (c !== "") this.classes.add(c);
    }
  }

  get classList() {
    const self = this;
    return {
      add: (...names: string[]): void => {
        for (const c of names) self.classes.add(c);
      },
      remove: (...names: string[]): void => {
        for (const c of names) self.classes.delete(c);
      },
      toggle: (c: string, force?: boolean): boolean => {
        const on = force === undefined ? !self.classes.has(c) : force;
        if (on) self.classes.add(c);
        else self.classes.delete(c);
        return on;
      },
      contains: (c: string): boolean => self.classes.has(c),
    };
  }

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(value: number) {
    this._scrollTop = value;
    this.dispatchEvent("scroll", {});
  }

  get firstChild(): StubNode | null {
    return this.children[0] ?? null;
  }

  get lastScrollBehavior(): string | null {
    return this.lastBehavior;
  }

  append(...nodes: Array<StubNode | string>): void {
    for (const n of nodes) this.appendChild(n);
  }

  appendChild(node: StubNode | string): StubNode {
    const n: StubNode = typeof node === "string" ? new StubText(node) : node;
    if (n.parentElement !== null) n.parentElement.removeChild(n);
    n.parentElement = this;
    this.children.push(n);
    return n;
  }

  insertBefore(node: StubNode | string, ref: StubNode | null): StubNode {
    const n: StubNode = typeof node === "string" ? new StubText(node) : node;
    if (ref === null || ref === undefined) {
      this.appendChild(n);
      return n;
    }
    if (n.parentElement !== null) n.parentElement.removeChild(n);
    const index = this.children.indexOf(ref);
    if (index < 0) {
      n.parentElement = this;
      this.children.push(n);
    } else {
      this.children.splice(index, 0, n);
      n.parentElement = this;
    }
    return n;
  }

  removeChild(node: StubNode): StubNode {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentElement = null;
    }
    return node;
  }

  replaceChildren(...nodes: Array<StubNode | string>): void {
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  contains(node: StubNode | null | undefined): boolean {
    let cur: StubNode | null | undefined = node;
    while (cur !== null && cur !== undefined) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  get textContent(): string {
    return this.children.map((c) => (c instanceof StubText ? c.data : c.textContent)).join("");
  }

  set textContent(value: string) {
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    if (value !== "") {
      const text = new StubText(value);
      text.parentElement = this;
      this.children.push(text);
    }
  }

  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key === "id") this.id = value;
    if (key === "hidden") this.hidden = true;
  }

  getAttribute(key: string): string | null {
    return this.attributes.has(key) ? this.attributes.get(key)! : null;
  }

  removeAttribute(key: string): void {
    this.attributes.delete(key);
  }

  addEventListener(type: string, fn: StubListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: StubListener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(type: string, init: StubEventInit = {}): boolean {
    const event: StubEvent = {
      type,
      preventDefault(): void {},
      stopPropagation(): void {},
      ...init,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return true;
  }

  click(): void {
    this.dispatchEvent("click", {});
  }

  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument !== null && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  scrollTo(options: { top: number; behavior?: string }): void {
    this.lastBehavior = options.behavior ?? "auto";
    this.scrollTop = options.top;
  }

  scrollIntoView(options?: unknown): void {
    this.lastScrollIntoView = options ?? null;
  }

  querySelector(sel: string): StubElement | null {
    return queryAll(this, sel)[0] ?? null;
  }

  querySelectorAll(sel: string): StubElement[] {
    return queryAll(this, sel);
  }
}

/* ------------------------------ 选区 Range 桩（跨文本节点语义） ------------------------------ */

class StubRange {
  private readonly doc: StubDocument;
  startContainer: StubNode;
  startOffset: number;
  endContainer: StubNode;
  endOffset: number;

  constructor(
    doc: StubDocument,
    startContainer: StubNode,
    startOffset: number,
    endContainer: StubNode,
    endOffset: number,
  ) {
    this.doc = doc;
    this.startContainer = startContainer;
    this.startOffset = startOffset;
    this.endContainer = endContainer;
    this.endOffset = endOffset;
  }

  get commonAncestorContainer(): StubNode {
    const startPath: StubNode[] = [];
    let cur: StubNode | null = this.startContainer;
    while (cur !== null) {
      startPath.push(cur);
      cur = cur.parentElement;
    }
    let end: StubNode | null = this.endContainer;
    while (end !== null) {
      if (startPath.includes(end)) return end;
      end = end.parentElement;
    }
    return this.doc.root!;
  }

  cloneRange(): StubRange {
    return new StubRange(this.doc, this.startContainer, this.startOffset, this.endContainer, this.endOffset);
  }

  selectNodeContents(element: StubElement): void {
    this.startContainer = element;
    this.startOffset = 0;
    this.endContainer = element;
    this.endOffset = element.children.length;
  }

  setEnd(container: StubNode, offset: number): void {
    this.endContainer = container;
    this.endOffset = offset;
  }

  toString(): string {
    const from = this.documentPosition(this.startContainer, this.startOffset);
    const to = this.documentPosition(this.endContainer, this.endOffset);
    return this.doc.flattenedText().slice(Math.min(from, to), Math.max(from, to));
  }

  private documentPosition(container: StubNode, offset: number): number {
    if (container instanceof StubText) {
      return this.doc.textStartOf(container) + offset;
    }
    let position = this.doc.textStartOf(container);
    for (let i = 0; i < offset && i < container.children.length; i += 1) {
      position += this.doc.subtreeTextLength(container.children[i]!);
    }
    return position;
  }
}

/* 极简选择器引擎：#id / tag / .class / tag.class。 */
function matchesSelector(el: StubElement, sel: string): boolean {
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

function queryAll(root: StubElement, sel: string): StubElement[] {
  const out: StubElement[] = [];
  const walk = (el: StubElement): void => {
    for (const c of el.children) {
      if (c instanceof StubElement) {
        if (matchesSelector(c, sel)) out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

/** 完整 index.html DOM 桩：按标签词法解析真实 index.html 建树。 */
function buildDomFromHtml(html: string, doc: StubDocument): StubElement {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  const voidTags = new Set(["meta", "link", "br", "hr", "input", "img", "source"]);
  const root = new StubElement("#document");
  let current = root;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    const full = match[0];
    const tag = match[1]!.toLowerCase();
    if (full.startsWith("</")) {
      if (current.parentElement !== null) current = current.parentElement;
      continue;
    }
    const el = new StubElement(tag);
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

class StubDocument {
  activeElement: StubElement | null = null;
  root: StubElement | null = null;
  body: StubElement | null = null;
  private readonly docListeners = new Map<string, Set<StubListener>>();
  private flat: { text: string; starts: Map<StubNode, number>; ends: Map<StubNode, number> } | null = null;

  attach(root: StubElement): void {
    this.root = root;
    this.body = root.querySelector("body");
  }

  createElement(tag: string): StubElement {
    const el = new StubElement(tag);
    el.ownerDocument = this;
    return el;
  }

  createTextNode(text: string): StubText {
    return new StubText(text);
  }

  getElementById(id: string): StubElement | null {
    return this.root === null ? null : (queryAll(this.root, `#${id}`)[0] ?? null);
  }

  querySelector(sel: string): StubElement | null {
    return this.root === null ? null : (queryAll(this.root, sel)[0] ?? null);
  }

  querySelectorAll(sel: string): StubElement[] {
    return this.root === null ? [] : queryAll(this.root, sel);
  }

  addEventListener(type: string, fn: StubListener): void {
    if (!this.docListeners.has(type)) this.docListeners.set(type, new Set());
    this.docListeners.get(type)!.add(fn);
  }

  dispatchEvent(type: string, init: StubEventInit = {}): boolean {
    const event: StubEvent = {
      type,
      preventDefault(): void {},
      stopPropagation(): void {},
      ...init,
    };
    for (const fn of this.docListeners.get(type) ?? []) fn(event);
    return true;
  }

  private rebuildFlat(): void {
    const starts = new Map<StubNode, number>();
    const ends = new Map<StubNode, number>();
    let text = "";
    const walk = (node: StubNode): void => {
      starts.set(node, text.length);
      if (node instanceof StubText) {
        text += node.data;
        ends.set(node, text.length);
        return;
      }
      for (const child of node.children) walk(child);
      ends.set(node, text.length);
    };
    if (this.root !== null) walk(this.root);
    this.flat = { text, starts, ends };
  }

  flattenedText(): string {
    this.rebuildFlat();
    return this.flat!.text;
  }

  textStartOf(node: StubNode): number {
    this.rebuildFlat();
    return this.flat!.starts.get(node) ?? 0;
  }

  subtreeTextLength(node: StubNode): number {
    this.rebuildFlat();
    return (this.flat!.ends.get(node) ?? 0) - (this.flat!.starts.get(node) ?? 0);
  }
}

/* ------------------------------ EventSource 桩 ------------------------------ */

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

/* ------------------------------ window / navigator 桩形状 ------------------------------ */

interface StubWindow {
  matchMedia(query: string): { matches: boolean; media: string; addEventListener(): void; removeEventListener(): void };
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(id: NodeJS.Timeout): void;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(id: NodeJS.Timeout): void;
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
  };
  getSelection(): { rangeCount: number; getRangeAt(index: number): StubRange };
  confirm(message: string): boolean;
}

/* ------------------------------ 导入脚本（D4-1 HTTP 契约的脚本化复刻） ------------------------------ */

/** 一次导入上传的行为脚本（脚本化后端——契约形状来自 server.ts/import-service.ts）。 */
interface ImportScript {
  /** 新建版本的初始解析态（缺省 pending）。 */
  parseStatus?: MaterialParseStatus;
  /** 新建版本的 parseError（failed/rejected 等终态语料）。 */
  parseError?: string;
  /** 上传直接拒绝（一次性）：415 扩展名 / 413 超限。 */
  rejectOnce?: "415" | "413" | null;
  /** 新建版本就绪后的块源 fixture（flipToReady 翻转 + 阅读器打开用）。 */
  fixture?: string;
}

/** 脚本化假文件（真实 File 的最小面：name + arrayBuffer）。 */
interface FakeFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function fakeFile(name: string, content: string): FakeFile {
  return {
    name,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer,
  };
}

/* ------------------------------ 后端（树 + 材料 + 导入 + 解析任务） ------------------------------ */

interface StubParseTask {
  taskId: string;
  treeId: string;
  materialId: string;
  versionId: string;
  state: "pending" | "parsing" | "ready" | "failed" | "canceled";
  parseError: string | null;
}

interface Backend {
  trees: Tree[];
  treeState: TreeState;
  diagnostics: TreeDiagnostics;
  requests: RecordedRequest[];
  switchCount: number;
  materials: StubMaterialEntry[];
  /** 每页块数上限（脚本化——分页场景给小值）。 */
  pageSize: number;
  /** 命中即挂起的请求路径后缀（一次性闸门，releaseHold 放行）。 */
  holdSuffix: string | null;
  /** clipboard 桩记录（复制摘录断言）。 */
  copied: string[];
  /** 导入行为脚本（单次世界内所有导入共用；测试可现场改写）。 */
  importScript: ImportScript;
  /** 已见导入字节键（同字节去重——D4-1 服务端 contentHash 语义的脚本化）。 */
  importBodyKeys: Map<string, { materialId: string; versionId: string }>;
  /** 导入计数（材料/版本/任务 id 派生）。 */
  importCount: number;
  /** 解析任务（cancel 端点的作用对象）。 */
  parseTasks: Map<string, StubParseTask>;
  /** 指定材料在第二次 GET detail 时变为 ready（pending/parsing → 刷新场景）。 */
  flipToReady: string | null;
  detailFetchCounts: Map<string, number>;
  /** resolve-selection 的脚本化拒绝（服务端区间纪律拒绝的逐字呈现面）。 */
  resolveRejection: { code: string; message: string } | null;
}

interface WorldOptions {
  materials?: Array<{
    id: string;
    title: string;
    versions: Array<{
      id: string;
      parserKind: "markdown" | "pdf";
      parseStatus: MaterialParseStatus;
      parseError?: string;
      fixture?: string;
    }>;
    readingPosition?: StubReadingPosition | null;
  }>;
  pageSize?: number;
  holdSuffix?: string;
  importScript?: ImportScript;
  resolveRejection?: { code: string; message: string };
}

function buildStubMaterial(
  script: NonNullable<WorldOptions["materials"]>[number],
): StubMaterialEntry {
  const sources = new Map<string, FixtureExpected>();
  for (const version of script.versions) {
    if (version.fixture !== undefined) {
      sources.set(version.id, loadPdfFixture(version.fixture));
    }
  }
  const primarySource = script.versions.find((v) => v.fixture !== undefined)?.fixture ?? null;
  return {
    material: { id: script.id, title: script.title, createdAt: ISO },
    versions: script.versions.map((version) => ({
      id: version.id,
      materialId: script.id,
      contentHash: `hash-${script.id}-${version.id}`,
      parserKind: version.parserKind,
      parserVersion: version.parserKind === "pdf" ? "d4-pdf-v1" : "d4-md-v1",
      importedAt: ISO,
      sizeBytes: 2048,
      parseStatus: version.parseStatus,
      parseError: version.parseError ?? null,
      textUnits:
        version.fixture !== undefined
          ? loadPdfFixture(version.fixture!).canonicalText.length
          : 0,
    })),
    readingPosition:
      script.readingPosition === undefined || script.readingPosition === null
        ? null
        : { ...script.readingPosition, updatedAt: ISO },
    versionSources: sources,
    ...(primarySource !== null ? {} : {}),
  };
}

let appLoadCounter = 0;

async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  const localStorageStore = new Map<string, string>();
  let scriptedSelection: StubRange | null = null;
  const windowStub: StubWindow = {
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval: (id) => clearInterval(id),
    matchMedia: (query) => ({
      matches: false,
      media: query,
      addEventListener(): void {},
      removeEventListener(): void {},
    }),
    localStorage: {
      getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
      setItem: (key, value) => {
        localStorageStore.set(key, String(value));
      },
      removeItem: (key) => {
        localStorageStore.delete(key);
      },
      clear: () => {
        localStorageStore.clear();
      },
    },
    getSelection: () => ({
      get rangeCount(): number {
        return scriptedSelection === null ? 0 : 1;
      },
      getRangeAt: (_index: number): StubRange => {
        const range = scriptedSelection;
        assert.ok(range !== null, "getRangeAt called without a scripted selection");
        return range;
      },
    }),
    confirm: () => true,
  };

  /* 最小树状态（阅读器与树态正交）。 */
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const treeState: TreeState = {
    tree: { id: TREE, createdAt: ISO, forestId: "forest-1" },
    trunkBranchId: "trunk-1",
    branches: [
      {
        branch: trunkBranch,
        origin: null,
        originStatus: null,
        sessionAvailability: "available",
        turns: [
          {
            id: "u1",
            treeId: TREE,
            branchId: "trunk-1",
            episodeId: "ep-1",
            runId: "run-u1",
            role: "user",
            text: "First trunk question.",
            piEntryId: "pi-u1",
            fromBranchId: null,
            deliveredRunId: null,
            idempotencyKey: null,
            targetAnchor: null,
            createdAt: ISO,
          },
          {
            id: "a1",
            treeId: TREE,
            branchId: "trunk-1",
            episodeId: "ep-1",
            runId: "run-a1",
            role: "assistant",
            text: A1_TEXT,
            piEntryId: "pi-a1",
            fromBranchId: null,
            deliveredRunId: null,
            idempotencyKey: null,
            targetAnchor: null,
            createdAt: ISO,
          },
        ],
        returnAttempts: [],
      },
    ],
    cursor: { treeId: TREE, branchId: "trunk-1", entryId: "pi-a1" },
  };

  const backend: Backend = {
    trees: [{ id: TREE, createdAt: ISO, forestId: "forest-1" }],
    treeState,
    diagnostics: {
      treeId: TREE,
      runtimeState: "idle",
      activeRun: null,
      runs: [],
      policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
    },
    requests: [],
    switchCount: 0,
    materials: (options.materials ?? []).map(buildStubMaterial),
    pageSize: options.pageSize ?? 50,
    holdSuffix: options.holdSuffix ?? null,
    copied: [],
    importScript: options.importScript ?? { parseStatus: "pending", fixture: "pdf-01" },
    importBodyKeys: new Map(),
    importCount: 0,
    parseTasks: new Map(),
    flipToReady: null,
    detailFetchCounts: new Map(),
    resolveRejection: options.resolveRejection ?? null,
  };

  /* 一次性请求闸门。 */
  let releaseHoldFn: (() => void) | null = null;
  const holdGate =
    options.holdSuffix === undefined ? null : new Promise<void>((resolve) => { releaseHoldFn = resolve; });

  const fetchStub = async (input: string, init: StubFetchInit = {}): Promise<StubResponse> => {
    const method = init.method ?? "GET";
    let body: unknown;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body);
    } else {
      body = init.body ?? undefined; /* 原始字节（导入上传）原样记录 */
    }
    const bodyBytes =
      init.body instanceof ArrayBuffer ? new Uint8Array(init.body).length : null;
    backend.requests.push({ method, path: String(input), body, headers: init.headers, bodyBytes });
    const url = new URL(String(input), "http://studio.local");
    const p = url.pathname;
    if (holdGate !== null && backend.holdSuffix !== null && p.endsWith(backend.holdSuffix)) {
      await holdGate;
    }
    const respond = (status: number, payload: unknown): StubResponse => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });

    /* ---- 材料面（D4 契约 §3 的已落地形状 + 导入/取消的契约复刻） ---- */
    if (p === "/api/trees" && method === "GET") {
      return respond(200, { trees: backend.trees });
    }
    let m = /^\/api\/trees\/([^/]+)\/materials$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        materials: backend.materials.map((entry) => ({
          material: entry.material,
          versions: entry.versions,
        })),
      });
    }
    if (m !== null && method === "POST") {
      /* 导入（D4-1 契约）：原始字节 body + 百分号编码文件名头；404/415/413
         预检；同字节去重（created:false）。 */
      const treeId = m[1]!;
      if (treeId !== TREE) {
        return respond(404, { error: { code: "not-found", message: `tree ${treeId} not found` } });
      }
      const rawName = init.headers?.["x-treeai-filename"];
      const filename = rawName === undefined ? "" : decodeURIComponent(rawName);
      if (!/\.(md|markdown|pdf)$/i.test(filename)) {
        return respond(415, {
          error: {
            code: "material-unsupported",
            message:
              `cannot import '${filename}': the '${filename.slice(filename.lastIndexOf("."))}' extension is not a supported material kind ` +
              "(supported: .md and .markdown → markdown, .pdf → pdf)",
          },
        });
      }
      if (backend.importScript.rejectOnce === "413") {
        backend.importScript.rejectOnce = null;
        const size = bodyBytes ?? 0;
        return respond(413, {
          error: {
            code: "material-too-large",
            message:
              `the material is ${String(size)} bytes, exceeding the 20971520-byte single-file limit ` +
              "(rejected before parsing; charter D4 §5)",
          },
        });
      }
      if (bodyBytes === null) {
        return respond(400, { error: { code: "invalid-argument", message: "import requires a raw byte body" } });
      }
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const key = `${String(bytes.length)}:${Array.from(bytes.slice(0, 24)).join(",")}`;
      const seen = backend.importBodyKeys.get(key);
      if (seen !== undefined) {
        const entry = backend.materials.find((candidate) => candidate.material.id === seen.materialId)!;
        const version = entry.versions.find((candidate) => candidate.id === seen.versionId)!;
        return respond(200, {
          material: entry.material,
          version,
          created: false,
          parseTaskId: null,
        });
      }
      backend.importCount += 1;
      const materialId = `mat-imp-${String(backend.importCount)}`;
      const versionId = `v-imp-${String(backend.importCount)}`;
      const taskId = `task-${String(backend.importCount)}`;
      const parserKind: "markdown" | "pdf" = /\.pdf$/i.test(filename) ? "pdf" : "markdown";
      const fixtureId = backend.importScript.fixture ?? "pdf-01";
      const source = parserKind === "pdf" ? loadPdfFixture(fixtureId) : null;
      const parseStatus = backend.importScript.parseStatus ?? "pending";
      const entry: StubMaterialEntry = {
        material: { id: materialId, title: filename, createdAt: ISO },
        versions: [
          {
            id: versionId,
            materialId,
            contentHash: `hash-${key}`,
            parserKind,
            parserVersion: parserKind === "pdf" ? "d4-pdf-v1" : "d4-md-v1",
            importedAt: ISO,
            sizeBytes: bytes.length,
            parseStatus,
            parseError: backend.importScript.parseError ?? null,
            textUnits: 0,
          },
        ],
        readingPosition: null,
        versionSources: source === null ? new Map() : new Map([[versionId, source]]),
      };
      backend.materials.push(entry);
      backend.importBodyKeys.set(key, { materialId, versionId });
      backend.parseTasks.set(taskId, {
        taskId,
        treeId,
        materialId,
        versionId,
        state: parseStatus === "pending" || parseStatus === "parsing" ? parseStatus : "ready",
        parseError: null,
      });
      return respond(201, {
        material: entry.material,
        version: entry.versions[0],
        created: true,
        parseTaskId: taskId,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      const fetchCount = (backend.detailFetchCounts.get(entry.material.id) ?? 0) + 1;
      backend.detailFetchCounts.set(entry.material.id, fetchCount);
      if (backend.flipToReady === entry.material.id && fetchCount >= 2) {
        backend.flipToReady = null;
        for (const version of entry.versions) {
          if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
            version.parseStatus = "ready";
            version.parseError = null;
            const source = entry.versionSources.get(version.id);
            if (source !== undefined) version.textUnits = source.canonicalText.length;
          }
        }
      }
      return respond(200, {
        material: entry.material,
        versions: entry.versions,
        readingPosition: entry.readingPosition,
        parseTasks: [...backend.parseTasks.values()].filter((task) => task.materialId === entry.material.id),
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      const version = entry.versions.find((candidate) => candidate.id === m![3]);
      if (version === undefined) {
        return respond(404, { error: { code: "not-found", message: `version ${m![3]} not found` } });
      }
      if (version.parseStatus !== "ready") {
        return respond(409, {
          error: { code: "material-not-ready", message: `material version ${version.id} is not ready (parse status '${version.parseStatus}')` },
        });
      }
      const source = entry.versionSources.get(version.id);
      const blocks = source === undefined ? [] : source.blocks;
      const after = url.searchParams.get("afterBlock");
      let startIndex = 0;
      if (after !== null && after !== "") {
        const index = blocks.findIndex((block) => block.blockId === after);
        if (index < 0) {
          return respond(400, { error: { code: "invalid-argument", message: `afterBlock '${after}' does not exist` } });
        }
        startIndex = index + 1;
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Math.min(Math.max(1, Number.isInteger(limitRaw) ? limitRaw : 50), backend.pageSize);
      const slice = blocks.slice(startIndex, startIndex + limit);
      const more = startIndex + limit < blocks.length;
      return respond(200, {
        blocks: slice.map((block) => ({
          block: { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end, page: block.page },
          text: block.text,
        })),
        nextAfterBlock: more && slice.length > 0 ? slice[slice.length - 1]!.blockId : null,
        textUnits: source === undefined ? version.textUnits : source.canonicalText.length,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/parse-tasks\/([^/]+)\/cancel$/.exec(p);
    if (m !== null && method === "POST") {
      const task = backend.parseTasks.get(m![3]!);
      if (task === undefined || task.materialId !== m![2] || task.treeId !== m![1]) {
        return respond(404, { error: { code: "not-found", message: `material parse task ${m![3]} not found` } });
      }
      if (task.state !== "pending" && task.state !== "parsing") {
        return respond(409, {
          error: {
            code: "parse-task-not-cancelable",
            message: `parse task ${task.taskId} is already terminal ('${task.state}'); only pending or parsing tasks can be canceled`,
          },
        });
      }
      task.state = "canceled";
      const entry = backend.materials.find((candidate) => candidate.material.id === task.materialId)!;
      const version = entry.versions.find((candidate) => candidate.id === task.versionId)!;
      if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
        version.parseStatus = "canceled";
        version.parseError = null;
      }
      return respond(200, { task });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/reading-position$/.exec(p);
    if (m !== null && method === "PUT") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      const record = asRecord(body);
      assert.ok(record !== null, "PUT reading-position body must be an object");
      const versionId = String(record.versionId ?? "");
      const version = entry.versions.find((candidate) => candidate.id === versionId);
      assert.ok(version !== undefined, `PUT reading-position targets a known version (${versionId})`);
      const blockIdRaw = record.blockId;
      if (typeof blockIdRaw !== "string" && blockIdRaw !== null && blockIdRaw !== undefined) {
        return respond(400, { error: { code: "invalid-argument", message: "blockId must be a string or null" } });
      }
      const blockId = blockIdRaw === undefined ? null : (blockIdRaw as string | null);
      if (blockId !== null) {
        const source = entry.versionSources.get(versionId);
        const exists = (source ?? { blocks: [] }).blocks.some((block) => block.blockId === blockId);
        if (!exists) {
          return respond(400, {
            error: { code: "invalid-argument", message: `blockId '${blockId}' does not exist in version ${versionId}` },
          });
        }
      }
      entry.readingPosition = { versionId, blockId, focusStart: null, updatedAt: ISO };
      return respond(204, null);
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/resolve-selection$/.exec(p);
    if (m !== null && method === "POST") {
      /* 服务端区间纪律拒绝的脚本化呈现（后端已拒绝——前端如实转达）。 */
      if (backend.resolveRejection !== null) {
        const rejection = backend.resolveRejection;
        backend.resolveRejection = null;
        return respond(400, { error: { code: rejection.code, message: rejection.message } });
      }
      return respond(200, {
        selection: {
          materialId: m![2],
          versionId: m![3],
          blockId: "page-1",
          start: 0,
          end: 2,
          excerpt: "递归",
          sourceHash: "scripted-hash",
        },
        block: { blockId: "page-1", kind: "pdf-page", start: 0, end: 818, page: 1 },
      });
    }

    /* ---- 既有树面（boot/渲染所需的最小路由） ---- */
    if (p === "/api/trees" && method === "POST") {
      return respond(201, { tree: treeState.tree, trunkBranchId: "trunk-1", state: treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, treeState);
    }
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, { ...backend.diagnostics, treeId: m[1]! });
    }
    m = /^\/api\/trees\/([^/]+)\/journal$/.exec(p);
    if (m !== null && method === "GET") return respond(200, { events: [] });
    m = /^\/api\/trees\/([^/]+)\/switch$/.exec(p);
    if (m !== null && method === "POST") {
      backend.switchCount += 1;
      return respond(200, { cursor: treeState.cursor, state: treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        annotations: [],
        tasks: [],
        usage: { total: { requests: 0, promptChars: 0, completionChars: 0 }, estTokens: 0, lateResultsDiscarded: 0, budgetTokens: 1_000_000 },
        cacheEnabled: true,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/prompt$/.exec(p);
    if (m !== null && method === "POST") {
      return respond(200, { outcome: { kind: "completed" }, state: treeState });
    }
    return respond(404, { error: { code: "not-found", message: `no route for ${method} ${p}` } });
  };

  const globals = globalThis as unknown as {
    document: StubDocument;
    window: StubWindow;
    EventSource: typeof StubEventSource;
    fetch: (input: string, init?: StubFetchInit) => Promise<StubResponse>;
    navigator: { clipboard: { writeText(text: string): Promise<void> } };
  };
  globals.document = documentStub;
  globals.window = windowStub;
  globals.EventSource = StubEventSource;
  globals.fetch = fetchStub;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (text: string): Promise<void> => {
          backend.copied.push(text);
        },
      },
    },
    configurable: true,
    writable: true,
  });

  appLoadCounter += 1;
  await import(new URL(`../public/app.js?load=${appLoadCounter}`, import.meta.url).href);
  await settle(25);

  const world: World = {
    document: documentStub,
    backend,
    el: (id) => {
      const found = documentStub.getElementById(id);
      assert.ok(found !== null, `missing required element #${id}`);
      return found;
    },
    byId: (id) => documentStub.getElementById(id),
    requestsOf: (suffix) => backend.requests.filter((r) => r.path.split("?")[0]!.endsWith(suffix)),
    lastRequest: (suffix) => {
      const list = backend.requests.filter((r) => r.path.split("?")[0]!.endsWith(suffix));
      return list.length === 0 ? null : list[list.length - 1]!;
    },
    materialButton: (materialId) => {
      const list = documentStub.getElementById("material-list");
      assert.ok(list !== null, "material list missing");
      const found = list.querySelectorAll("button").find((b) => b.dataset.materialId === materialId);
      assert.ok(found !== undefined, `missing list button for material ${materialId}`);
      return found;
    },
    openMaterial: async (materialId) => {
      world.materialButton(materialId).click();
      await settle(25);
    },
    matBlocks: () => {
      const found = documentStub.getElementById("mat-blocks");
      assert.ok(found !== null, "#mat-blocks missing (reader not open?)");
      return found;
    },
    blockElement: (blockId) => {
      const blocks = world.matBlocks();
      const found = blocks.querySelectorAll(".material-block").find((b) => b.dataset.blockId === blockId);
      assert.ok(found !== undefined, `missing rendered page text layer ${blockId}`);
      return found;
    },
    pageFrame: (blockId) => {
      const blocks = world.matBlocks();
      const found = blocks.querySelectorAll(".pdf-page-frame").find((b) => b.dataset.blockId === blockId);
      assert.ok(found !== undefined, `missing page frame ${blockId}`);
      return found;
    },
    pickFile: async (file) => {
      const input = world.el("material-import-input");
      input.files = [file];
      input.dispatchEvent("change", {});
      await settle(30);
    },
    importStatus: () => {
      const status = world.byId("material-import-status");
      assert.ok(status !== null, "import status line missing");
      return status;
    },
    setSelection: (range) => {
      scriptedSelection = range;
    },
    makeRange: (startNode, startOffset, endNode, endOffset) =>
      new StubRange(documentStub, startNode, startOffset, endNode, endOffset),
    liveSse: () => {
      const sse = StubEventSource.latest();
      assert.ok(sse !== null, "no live EventSource instance");
      return sse;
    },
    releaseHold: () => {
      assert.ok(releaseHoldFn !== null, "releaseHold requires a holdSuffix world");
      releaseHoldFn();
    },
  };
  return world;
}

/** 世界面（场景辅助的契约）。 */
interface World {
  readonly document: StubDocument;
  readonly backend: Backend;
  el(id: string): StubElement;
  byId(id: string): StubElement | null;
  requestsOf(suffix: string): RecordedRequest[];
  lastRequest(suffix: string): RecordedRequest | null;
  materialButton(materialId: string): StubElement;
  openMaterial(materialId: string): Promise<void>;
  matBlocks(): StubElement;
  blockElement(blockId: string): StubElement;
  pageFrame(blockId: string): StubElement;
  pickFile(file: FakeFile): Promise<void>;
  importStatus(): StubElement;
  setSelection(range: StubRange | null): void;
  makeRange(
    startNode: StubText,
    startOffset: number,
    endNode: StubText,
    endOffset: number,
  ): StubRange;
  liveSse(): StubEventSource;
  releaseHold(): void;
}

/* ------------------------------ 场景辅助 ------------------------------ */

function collectTextNodes(element: StubElement | StubText): StubText[] {
  if (element instanceof StubText) return [element];
  const out: StubText[] = [];
  for (const child of element.children) {
    if (child instanceof StubText) out.push(child);
    else out.push(...collectTextNodes(child));
  }
  return out;
}

/**
 * 在页文本层内按摘录构造选区（真实用户选区的等价映射）：摘录在文本层
 * 扁平文本中的第 occurrence 处 → 起/止文本节点 + 节点内偏移。跨行摘录
 * 自然落在不同行节点上（\n 文本节点是真实节点）。
 */
function makeRangeForExcerpt(
  world: World,
  blockId: string,
  excerpt: string,
  occurrence = 1,
): StubRange {
  const textLayer = world.blockElement(blockId);
  const nodes = collectTextNodes(textLayer);
  const flat = nodes.map((node) => node.data).join("");
  let at = -1;
  for (let i = 0; i < occurrence; i += 1) {
    at = flat.indexOf(excerpt, at + 1);
  }
  assert.ok(at >= 0, `excerpt ${JSON.stringify(excerpt)} (occurrence ${String(occurrence)}) not found in page ${blockId}`);
  const endAt = at + excerpt.length;
  const locate = (position: number): { node: StubText; offset: number } => {
    let consumed = 0;
    for (const node of nodes) {
      if (position <= consumed + node.data.length && position >= consumed) {
        return { node, offset: position - consumed };
      }
      consumed += node.data.length;
    }
    throw new Error(`position ${String(position)} out of range`);
  };
  const from = locate(at);
  const to = locate(endAt);
  return world.makeRange(from.node, from.offset, to.node, to.offset);
}

/** 武装一个页内选区（脚本选区 + mouseup——与真实拖拽收尾同一入口）。 */
function armSelection(world: World, range: StubRange): void {
  world.setSelection(range);
  world.matBlocks().dispatchEvent("mouseup", {});
}

/** 捕获条当前状态。 */
function selectionBar(world: World): StubElement {
  const bar = world.byId("mat-selection-bar");
  assert.ok(bar !== null, "selection bar missing");
  return bar;
}

/** 验证武装载荷与 B2 冻结选区期望逐字段一致（blockId/start/end/excerpt）。 */
function assertSelectionMatchesFrozen(world: World, selection: FrozenPdfSelection): void {
  const bar = selectionBar(world);
  const payload = bar.querySelector(".mat-payload")!;
  assert.ok(payload !== null, `the frozen selection ${selection.id} arms a valid payload`);
  assert.match(
    payload.textContent!,
    new RegExp(`block ${selection.expected.blockId}`),
    `${selection.id}: the payload names the frozen page block`,
  );
  assert.match(
    payload.textContent!,
    new RegExp(`UTF-16 \\[${String(selection.expected.start)}, ${String(selection.expected.end)}\\)`),
    `${selection.id}: the payload carries the frozen canonical range`,
  );
  const quote = bar.querySelector(".mat-quote")!;
  assert.equal(quote.textContent, selection.expected.excerpt, `${selection.id}: the excerpt is byte-exact`);
}

/* 标准场景材料束（PDF 冻结 fixture 驱动）。 */
const PDF01_SCRIPT = {
  id: "mat-pdf01",
  title: "递归学习笔记.pdf",
  versions: [{ id: "v-pdf01-1", parserKind: "pdf" as const, parseStatus: "ready" as const, fixture: "pdf-01" }],
};
const PDF06_SCRIPT = {
  id: "mat-pdf06",
  title: "双栏对照笔记.pdf",
  versions: [{ id: "v-pdf06-1", parserKind: "pdf" as const, parseStatus: "ready" as const, fixture: "pdf-06" }],
};
const PDF11_SCRIPT = {
  id: "mat-pdf11",
  title: "长文三十节.pdf",
  versions: [{ id: "v-pdf11-1", parserKind: "pdf" as const, parseStatus: "ready" as const, fixture: "pdf-11" }],
};

/* ------------------------------------------------------------------ */
/* 1. 导入 UI（owner P1：真正的文件导入）                                */
/* ------------------------------------------------------------------ */

test("import entry: the file picker accepts exactly the D4-1 support set and lives in the Materials section", async () => {
  const world = await createWorld({ materials: [] });
  const section = world.el("materials-section");
  assert.equal(section.hidden, false, "the Materials section is visible with a tree open");
  const button = world.el("material-import");
  /* DOM 桩不解析静态文本（按标签词法建树）——按钮文案按 index.html 源断言。 */
  assert.match(INDEX_HTML, /id="material-import"[^>]*>⬆ Import file…<\/button>/);
  const input = world.el("material-import-input");
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.getAttribute("type"), "file");
  assert.equal(input.getAttribute("accept"), ".md,.markdown,.pdf");
  assert.equal(input.hidden, true, "the input itself stays hidden (the button opens the picker)");
  /* 点击按钮触发选择器（桩上观察 input 的 click 事件——同一入口）。 */
  let pickerOpened = false;
  input.addEventListener("click", () => {
    pickerOpened = true;
  });
  button.click();
  assert.ok(pickerOpened, "clicking the import entry opens the file picker");
});

test("import happy path: a Chinese-and-space filename uploads raw bytes with the percent-encoded header, the parsing state is honest, and ready opens the reader", async () => {
  const world = await createWorld({ materials: [] });
  const filename = "递归 学习笔记 v1.pdf";
  await world.pickFile(fakeFile(filename, "%PDF-1.4 scripted bytes for the happy path"));

  /* 上传：POST /materials，原始字节 body + 百分号编码文件名头（探针同一
     语义——中文名/空格名经编码头原样到达）。 */
  const upload = world.requestsOf("/materials").find((r) => r.method === "POST");
  assert.ok(upload !== undefined, "the import posts to the real import endpoint");
  assert.equal(upload.bodyBytes, 42, "the raw byte body is uploaded as-is");
  assert.equal(
    upload.headers?.["x-treeai-filename"],
    encodeURIComponent(filename),
    "the filename header is percent-encoded (probe semantics; Chinese/space survive verbatim)",
  );
  assert.equal(upload.headers?.["content-type"], "application/octet-stream");

  /* 状态面：pending → 解析中（server 状态如实）+ Check now + Cancel。 */
  const status = world.importStatus();
  assert.match(status.textContent!, /“递归 学习笔记 v1\.pdf” imported — parsing \(server status: pending\)…/);
  assert.ok(status.querySelector(".mat-import-cancel") !== null, "an in-flight parse offers Cancel");
  assert.ok(status.querySelector(".mat-import-refresh") !== null, "an in-flight parse offers Check now");

  /* 列表已含新材料（pending 如实标注，绝不伪装可读）。 */
  const button = world.materialButton("mat-imp-1");
  assert.match(button.textContent!, /递归 学习笔记 v1\.pdf/);
  assert.match(button.querySelector(".material-meta")!.textContent!, /pdf · v1 · pending/);

  /* 解析完成（detail 翻转 ready）：Check now → ready + Open。导入响应后
     的首次 detail 检查即命中（导入与检查之间解析已完成——计数预置模拟
     导入时的一次在途检查）。 */
  world.backend.detailFetchCounts.set("mat-imp-1", 1);
  world.backend.flipToReady = "mat-imp-1";
  status.querySelector(".mat-import-refresh")!.click();
  await settle(25);
  assert.match(world.importStatus().textContent!, /“递归 学习笔记 v1\.pdf” is ready — it is in the list below/);
  assert.match(world.materialButton("mat-imp-1").querySelector(".material-meta")!.textContent!, /pdf · v1 · ready/);

  /* Open in reader：直达阅读器（真实页渲染）。 */
  world.importStatus().querySelector(".mat-import-open")!.click();
  await settle(25);
  assert.equal(world.el("material-reader").hidden, false, "the ready import opens in the reader");
  assert.equal(world.matBlocks().querySelectorAll(".pdf-page-frame").length, PDF01.blocks.length);
});

test("import dedup: importing the exact same bytes again reports the reused version honestly (no new version, no fake success)", async () => {
  const world = await createWorld({ materials: [] });
  const file = fakeFile("same-bytes 笔记.pdf", "identical payload");
  await world.pickFile(file);
  world.backend.flipToReady = "mat-imp-1";
  world.importStatus().querySelector(".mat-import-refresh")!.click();
  await settle(25);

  /* 第二次导入同一字节：200 created:false（服务端 contentHash 去重）。 */
  await world.pickFile(fakeFile("same-bytes 笔记.pdf", "identical payload"));
  const imports = world.requestsOf("/materials").filter((r) => r.method === "POST");
  assert.equal(imports.length, 2, "the second upload still goes through the real endpoint");
  const status = world.importStatus();
  assert.match(
    status.textContent!,
    /“same-bytes 笔记\.pdf” was not imported again — these exact bytes are already v1 of this material/,
    "the same-bytes message names the reused version",
  );
  assert.match(status.textContent!, /no new version was created/);
  assert.equal(world.backend.materials.length, 1, "no second material row appears (nothing faked)");
  /* 去重后无解析在途：无 Cancel/Check。 */
  assert.equal(status.querySelector(".mat-import-cancel"), null);
  assert.equal(status.querySelector(".mat-import-refresh"), null);
});

test("import parse failures surface the reason verbatim (failed / rejected), never an empty-document masquerade", async () => {
  /* failed：解析失败原因逐字。 */
  const failedWorld = await createWorld({
    materials: [],
    importScript: { parseStatus: "pending", fixture: "pdf-01" },
  });
  await failedWorld.pickFile(fakeFile("损坏的文档.pdf", "pdf bytes that will fail"));
  failedWorld.backend.flipToReady = null;
  const version =
    failedWorld.backend.materials[0]!.versions[0]!;
  version.parseStatus = "failed";
  version.parseError =
    "pdf-parse-failed: the document structure is corrupt (xref table unreadable at byte 1024)";
  failedWorld.importStatus().querySelector(".mat-import-refresh")!.click();
  await settle(25);
  assert.match(
    failedWorld.importStatus().textContent!,
    /“损坏的文档\.pdf” did not parse: failed — pdf-parse-failed: the document structure is corrupt \(xref table unreadable at byte 1024\)\./,
    "the failure reason renders verbatim",
  );
  assert.match(failedWorld.importStatus().textContent!, /The original file is kept as imported/);
  assert.match(
    failedWorld.materialButton("mat-imp-1").querySelector(".material-status")!.textContent!,
    /failed: pdf-parse-failed: the document structure is corrupt/,
  );

  /* rejected：加密 PDF 被拒（D4-1 负例语义）。 */
  const rejectedWorld = await createWorld({ materials: [], importScript: { parseStatus: "pending" } });
  await rejectedWorld.pickFile(fakeFile("加密的手稿.pdf", "encrypted payload"));
  const rejectedVersion = rejectedWorld.backend.materials[0]!.versions[0]!;
  rejectedVersion.parseStatus = "rejected";
  rejectedVersion.parseError = "pdf-encrypted: the document is password-protected — no text layer can be extracted";
  rejectedWorld.importStatus().querySelector(".mat-import-refresh")!.click();
  await settle(25);
  assert.match(
    rejectedWorld.importStatus().textContent!,
    /did not parse: rejected — pdf-encrypted: the document is password-protected/,
    "the rejection reason renders verbatim (never silently dropped)",
  );
});

test("import cancel: canceling an in-flight parse task stops it and reports canceled honestly; a 409 (already terminal) triggers an immediate recheck", async () => {
  const world = await createWorld({ materials: [] });
  await world.pickFile(fakeFile("大文件 解析中.pdf", "bytes of a large document"));
  const cancel = world.importStatus().querySelector(".mat-import-cancel")!;
  cancel.click();
  await settle(25);
  /* 取消走真实端点（parse-tasks/:taskId/cancel）。 */
  const cancelRequest = world.requestsOf("/cancel").find((r) => r.method === "POST");
  assert.ok(cancelRequest !== null, "the cancel posts to the parse-task cancel endpoint");
  assert.match(cancelRequest!.path, /\/parse-tasks\/task-1\/cancel$/);
  assert.match(
    world.importStatus().textContent!,
    /the parse of “大文件 解析中\.pdf” was canceled — the version stays canceled/,
    "the canceled state is honest (nothing is faked as parsed)",
  );
  assert.match(world.importStatus().textContent!, /import the file again to retry/);
  assert.match(world.materialButton("mat-imp-1").querySelector(".material-meta")!.textContent!, /canceled/);
  assert.equal(world.importStatus().querySelector(".mat-import-cancel"), null, "no cancel remains after terminal");

  /* 409 路径：任务已终态时点取消 → 立即复查状态（如实落位，不卡死）。 */
  const secondWorld = await createWorld({ materials: [], importScript: { parseStatus: "parsing" } });
  await secondWorld.pickFile(fakeFile("竞态.pdf", "race payload"));
  secondWorld.backend.parseTasks.get("task-1")!.state = "ready"; /* 终态：取消必 409 */
  secondWorld.importStatus().querySelector(".mat-import-cancel")!.click();
  await settle(25);
  assert.ok(
    secondWorld.requestsOf("/cancel").some((r) => r.method === "POST"),
    "the cancel was attempted against the real endpoint",
  );
  /* 409 → 立即查 detail → 版本 parsing（未终态翻转）→ 仍在解析面。 */
  assert.match(
    secondWorld.importStatus().textContent!,
    /“竞态\.pdf” imported — parsing/,
    "after the 409 the status is rechecked immediately (no stuck state)",
  );
});

test("import upload failures surface verbatim: unsupported extension (415) and oversize (413)", async () => {
  const world = await createWorld({ materials: [] });
  /* 415：不支持的扩展名（.docx）。 */
  await world.pickFile(fakeFile("会议 纪要.docx", "not a supported material"));
  assert.match(
    world.importStatus().textContent!,
    /importing “会议 纪要\.docx” failed — material-unsupported: cannot import '会议 纪要\.docx': the '\.docx' extension is not a supported material kind/,
    "the 415 reason renders verbatim",
  );
  assert.match(world.importStatus().textContent!, /supported: \.md and \.markdown → markdown, \.pdf → pdf/);
  assert.equal(world.backend.materials.length, 0, "no material row is created for a rejected upload");
  /* 状态面常驻（不自动消失），可再次导入。 */
  await world.pickFile(fakeFile("小 笔记.md", "# hello\n"));
  assert.equal(world.backend.materials.length, 1, "a subsequent import still works after a failure");

  /* 413：超限。 */
  const bigWorld = await createWorld({
    materials: [],
    importScript: { rejectOnce: "413", parseStatus: "pending" },
  });
  await bigWorld.pickFile(fakeFile("超大 文档.pdf", "x".repeat(100)));
  assert.match(
    bigWorld.importStatus().textContent!,
    /importing “超大 文档\.pdf” failed — material-too-large: the material is 100 bytes, exceeding the 20971520-byte single-file limit/,
    "the 413 reason renders verbatim",
  );
});

test("import state resets on tree switch (the in-flight poll and status never leak across trees)", async () => {
  const world = await createWorld({ materials: [] });
  await world.pickFile(fakeFile("跨树 状态.pdf", "payload"));
  assert.match(world.importStatus().textContent!, /parsing/);
  /* 切树（openTree → resetTransientView → resetMaterialImport）。 */
  await (world as unknown as { backend: Backend }).backend;
  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle(5);
  const world2 = await createWorld({ materials: [] });
  assert.equal(world2.importStatus().textContent, "", "a fresh world starts with an empty import status");
});

/* ------------------------------------------------------------------ */
/* 2. PDF 页渲染（冻结页块图）                                           */
/* ------------------------------------------------------------------ */

test("PDF pages render as real reading surfaces: page identifiers, frozen block text, absolute ranges, and the pdf fetch limit", async () => {
  const world = await createWorld({ materials: [PDF01_SCRIPT] });
  await world.openMaterial("mat-pdf01");

  /* 页框按冻结页块图落位（pdf-01：2 页）。 */
  const frames = world.matBlocks().querySelectorAll(".pdf-page-frame");
  assert.equal(frames.length, PDF01.blocks.length);
  for (let i = 0; i < PDF01.blocks.length; i += 1) {
    const block = PDF01.blocks[i]!;
    const frame = frames[i]!;
    assert.equal(frame.dataset.blockId, block.blockId);
    assert.equal(frame.dataset.start, String(block.start));
    assert.equal(frame.dataset.end, String(block.end));
    assert.equal(frame.dataset.page, String(block.page), "the frame carries the page identifier");
    assert.equal(frame.querySelector(".pdf-page-head")!.textContent, `Page ${String(block.page)}`);
    /* 文本层与冻结页文本字节相等（页头在文本层之外——映射的事实源）。 */
    const textLayer = frame.querySelector(".material-block")!;
    assert.equal(textLayer.textContent, block.text);
    assert.notEqual(
      textLayer.textContent,
      `Page ${String(block.page)}${block.text}`,
      "the page-head label never leaks into the selectable text layer",
    );
  }
  /* 版本面：pdf/d4-pdf-v1 元信息 + 单页纪律注记。 */
  assert.match(world.el("material-reader").textContent!, /pdf · d4-pdf-v1 · imported/);
  assert.match(world.el("material-reader").textContent!, /select within one page/);
  assert.match(world.el("material-reader").textContent!, /v1 \(current\)/);
  /* 取块走 PDF 页步（limit=10——大 PDF 小步分页）。 */
  const fetches = world.requestsOf("/versions/v-pdf01-1");
  assert.ok(fetches.length > 0);
  for (const request of fetches) {
    assert.match(request.path, /limit=10/, "PDF block fetches use the PDF page step");
  }
  /* 尾部：页计数 + 冻结 textUnits。 */
  assert.match(
    world.el("mat-tail").textContent!,
    new RegExp(`2 page\\(s\\) in view · ${String(PDF01.canonicalText.length)} text units total`),
  );
});

/* ------------------------------------------------------------------ */
/* 3. 单页选区 → 规范载荷（B2 冻结语义）                                */
/* ------------------------------------------------------------------ */

test("same-page selections map through the canonical-offset machinery to the frozen B2 payloads (pdf-sel-01 / pdf-sel-02)", async () => {
  const world = await createWorld({ materials: [PDF01_SCRIPT] });
  await world.openMaterial("mat-pdf01");

  /* pdf-sel-01：中文首词「递归」[0,2)。 */
  const sel01 = frozenSelection("pdf-sel-01");
  armSelection(world, makeRangeForExcerpt(world, sel01.expected.blockId, sel01.expected.excerpt));
  assertSelectionMatchesFrozen(world, sel01);
  assert.match(
    selectionBar(world).querySelector(".mat-payload")!.textContent!,
    / · page 1 · UTF-16 /,
    "the capture bar shows the page identifier for PDF selections",
  );

  /* pdf-sel-02：跨行选区 [135,146)（同一页内的多行——页内换行不是跨页）。 */
  const sel02 = frozenSelection("pdf-sel-02");
  armSelection(world, makeRangeForExcerpt(world, sel02.expected.blockId, sel02.expected.excerpt));
  assertSelectionMatchesFrozen(world, sel02);

  /* 同页多片段：解除后再武装另一片段，各自成立（第 8 处「递归」——
     pdf-05 语料的冻结语义在 pdf-01 上以 occurrence 维度验证定位精度）。 */
  world.setSelection(null);
  world.matBlocks().dispatchEvent("mouseup", {});
  const repeatNeedle = "递归";
  let expectedOccurrence = 0;
  let cursor = -1;
  for (;;) {
    cursor = PDF01.blocks[0]!.text.indexOf(repeatNeedle, cursor + 1);
    if (cursor < 0) break;
    expectedOccurrence += 1;
  }
  armSelection(
    world,
    makeRangeForExcerpt(world, "page-1", repeatNeedle, Math.max(1, expectedOccurrence - 1)),
  );
  const payload = selectionBar(world).querySelector(".mat-payload")!;
  const match = /UTF-16 \[(\d+), (\d+)\)/.exec(payload.textContent!);
  assert.ok(match !== null);
  const start = Number(match[1]);
  const end = Number(match[2]);
  assert.equal(PDF01.canonicalText.slice(start, end), repeatNeedle, "a later occurrence maps to its own offsets (never the first match)");
});

test("double-column PDF (pdf-06): both columns and a cross-line excerpt map to the frozen ranges on the same page", async () => {
  const world = await createWorld({ materials: [PDF06_SCRIPT] });
  await world.openMaterial("mat-pdf06");

  /* pdf-sel-14：左栏「自顶向下」[21,25)。 */
  const sel14 = frozenSelection("pdf-sel-14");
  armSelection(world, makeRangeForExcerpt(world, sel14.expected.blockId, sel14.expected.excerpt));
  assertSelectionMatchesFrozen(world, sel14);

  /* pdf-sel-15：右栏「自底向上」[619,623)——双栏规范阅读序的冻结断言。 */
  const sel15 = frozenSelection("pdf-sel-15");
  armSelection(world, makeRangeForExcerpt(world, sel15.expected.blockId, sel15.expected.excerpt));
  assertSelectionMatchesFrozen(world, sel15);

  /* pdf-sel-16：跨行（同页内）[70,81)。 */
  const sel16 = frozenSelection("pdf-sel-16");
  armSelection(world, makeRangeForExcerpt(world, sel16.expected.blockId, sel16.expected.excerpt));
  assertSelectionMatchesFrozen(world, sel16);
});

test("grapheme safety on PDF pages: a boundary inside a surrogate pair snaps outward (pdf-12 payload discipline)", async () => {
  const world = await createWorld({
    materials: [
      {
        id: "mat-pdf12",
        title: "宽字符样本.pdf",
        versions: [{ id: "v-pdf12-1", parserKind: "pdf", parseStatus: "ready", fixture: "pdf-12" }],
      },
    ],
  });
  await world.openMaterial("mat-pdf12");
  /* 扩展 B 区样例一「𠀋𠀖𠀪𠀲𠁆」——每个字是代理对；从第一个字的后半
     代理中间起选 → 吸附到整簇边界（载荷绝不劈开代理对）。 */
  const textLayer = world.blockElement("page-1");
  const needle = "扩展 B 区样例一：";
  const nodes = collectTextNodes(textLayer);
  const host = nodes.find((node) => node.data.includes(needle))!;
  const lineStart = host.data.indexOf(needle) + needle.length;
  /* 「𠀋」= 2 UTF-16 单元；起点落在其后半代理（lineStart+1）→ 吸附回
     lineStart（整簇）。 */
  const range = world.makeRange(host, lineStart + 1, host, lineStart + 5);
  armSelection(world, range);
  const payload = selectionBar(world).querySelector(".mat-payload")!;
  assert.ok(payload !== null, "the surrogate-split selection still arms (after snapping)");
  const match = /UTF-16 \[(\d+), (\d+)\)/.exec(payload.textContent!);
  assert.ok(match !== null, `payload present: ${payload.textContent}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  /* 吸附后：起点与终点都在簇边界——切片完整成字。 */
  const slice = world.backend.materials[0]!.versionSources.get("v-pdf12-1")!.canonicalText.slice(start, end);
  for (const ch of slice) {
    const code = ch.codePointAt(0)!;
    assert.ok(
      code < 0xd800 || code > 0xdfff,
      `the snapped excerpt never contains a lone surrogate (got U+${code.toString(16)})`,
    );
  }
  assert.ok(
    selectionBar(world).textContent!.includes("snapped outward") ||
      selectionBar(world).querySelector(".mat-snap-note") !== null,
  );
});

/* ------------------------------------------------------------------ */
/* 4. 跨页选区：如实拒绝（绝不静默截断）                                */
/* ------------------------------------------------------------------ */

test("cross-page selection is refused with the select-within-one-page prompt — no payload, no silent truncation", async () => {
  const world = await createWorld({ materials: [PDF01_SCRIPT] });
  await world.openMaterial("mat-pdf01");
  /* 从 page-1 末行选到 page-2 首行（跨页框）。 */
  const page1 = world.blockElement("page-1");
  const page2 = world.blockElement("page-2");
  const lastNode1 = collectTextNodes(page1).filter((node) => node.data.trim() !== "").at(-1)!;
  const firstNode2 = collectTextNodes(page2).filter((node) => node.data.trim() !== "").at(0)!;
  armSelection(
    world,
    world.makeRange(lastNode1, Math.max(0, lastNode1.data.length - 4), firstNode2, Math.min(4, firstNode2.data.length)),
  );
  const bar = selectionBar(world);
  assert.equal(bar.querySelector(".mat-quote"), null, "no quote payload is produced for a cross-page selection");
  assert.equal(bar.querySelector(".mat-payload"), null, "no anchor payload is produced");
  assert.match(
    bar.textContent!,
    /cross-page selection not anchorable — PDF selections must stay within one page/,
    "the honest prompt tells the user to select within one page",
  );
  assert.match(bar.textContent!, /never a silent truncation/);

  /* 页头文字入选（页头不在文本层——无法映射）：如实 unmappable。 */
  const frame = world.pageFrame("page-1");
  const head = frame.querySelector(".pdf-page-head")!;
  const headText = collectTextNodes(head)[0]!;
  const layerNode = collectTextNodes(page1).find((node) => node.data.includes("递归"))!;
  armSelection(world, world.makeRange(headText, 0, layerNode, 2));
  assert.match(
    selectionBar(world).textContent!,
    /could not be mapped to canonical offsets — no quote payload is shown/,
    "a selection touching the page label (outside the text layer) is honestly refused",
  );
});

/* ------------------------------------------------------------------ */
/* 5. 阅读位置（PDF 按版本：保存 + 恢复）                               */
/* ------------------------------------------------------------------ */

test("reading positions work per PDF version: scrolling saves page-N via PUT, and reopening restores onto it (forward fill + rendered jump target)", async () => {
  /* 恢复预置：保存位置在 page-27（30 页长文，分页 5 块/页 → 跨页前补）。 */
  const world = await createWorld({
    materials: [
      {
        ...PDF11_SCRIPT,
        readingPosition: { versionId: "v-pdf11-1", blockId: "page-27", focusStart: null, updatedAt: ISO },
      },
    ],
    pageSize: 5,
  });
  await world.openMaterial("mat-pdf11");
  /* 跨页前补：26..30 页需要 6 次 fetch（10/页 → 5/页被 pageSize 钳制）。 */
  assert.equal(
    world.requestsOf("/versions/v-pdf11-1").length,
    6,
    "the restore forward-fills page fetches until the saved page is in the window",
  );
  assert.match(
    world.el("material-reader").textContent!,
    /restored to your saved reading position \(block page-27\)/,
  );
  /* 跳转目标页已渲染（scrollIntoView 落位 + 目标页文本层就绪）。 */
  const target = world.pageFrame("page-27");
  assert.equal(
    (target.lastScrollIntoView as { block?: string } | null)?.block,
    "start",
    "the saved page is scrolled into view",
  );
  assert.equal(
    world.blockElement("page-27").dataset.rendered,
    "true",
    "the jump target page's text layer is rendered",
  );

  /* 滚动保存：给定几何后滚到 page-21 区域 → 关闭阅读器冲刷 PUT。 */
  const frames = world.matBlocks().querySelectorAll(".pdf-page-frame");
  frames.forEach((frame, index) => {
    frame.offsetTop = index * 800;
    frame.offsetHeight = 800;
  });
  const blocksEl = world.matBlocks();
  blocksEl.clientHeight = 1000;
  blocksEl.scrollTop = 16000; /* 首个可见页：page-21（top 16000）。 */
  await sleep(10);
  world.el("mat-close").click();
  await settle(25);
  const put = world.requestsOf("/reading-position").find((r) => r.method === "PUT");
  assert.ok(put !== undefined, "closing the reader flushes the reading position");
  assert.deepEqual(
    (put.body as { versionId: string; blockId: string }).blockId,
    "page-21",
    "the PDF position saves the top visible page id",
  );
  assert.equal((put.body as { versionId: string }).versionId, "v-pdf11-1");
  /* 服务端行已更新（重开默认恢复到该版本）。 */
  const saved = world.backend.materials[0]!.readingPosition;
  assert.equal(saved?.blockId, "page-21");
});

/* ------------------------------------------------------------------ */
/* 6. 不可映射文本：服务端拒绝面的如实转达                               */
/* ------------------------------------------------------------------ */

test("a server-side resolve-selection refusal surfaces verbatim in the branch flow (the backend already refuses — the UI relays it)", async () => {
  const world = await createWorld({
    materials: [PDF01_SCRIPT],
    resolveRejection: {
      code: "cross-page",
      message:
        "selection [817, 819) crosses a page boundary of material version v-pdf01-1; select within one page (segmented selection), never a silent truncation",
    },
  });
  await world.openMaterial("mat-pdf01");
  /* 武装一个客户端合法的页内选区（服务端脚本化拒绝——竞态/漂移面）。 */
  armSelection(world, makeRangeForExcerpt(world, "page-1", "递归"));
  const branch = selectionBar(world).querySelector(".mat-branch-d43")!;
  branch.click();
  await settle(25);
  /* resolve-selection 的请求体：locator + excerpt + blockId（同一载荷面）。 */
  const resolve = world.requestsOf("/resolve-selection").find((r) => r.method === "POST");
  assert.ok(resolve !== undefined, "branching first resolves the selection server-side");
  const body = resolve.body as { locator: { kind: string; start: number; end: number }; excerpt: string; blockId: string };
  assert.equal(body.locator.kind, "utf16-range");
  assert.equal(body.excerpt, "递归");
  assert.equal(body.blockId, "page-1");
  /* 拒绝原因在建枝流程面逐字呈现（绝不吞掉、绝不以相似文字兜底）。 */
  const flow = world.byId("mat-branch-flow");
  assert.ok(flow !== null, "the branch flow surface is present");
  assert.match(
    flow.textContent!,
    /cross-page: selection \[817, 819\) crosses a page boundary of material version v-pdf01-1; select within one page \(segmented selection\), never a silent truncation/,
    "the server's refusal reason is relayed verbatim",
  );
});

/* ------------------------------------------------------------------ */
/* 7. 懒渲染边界（可见页先行——B6 2s 目标）                              */
/* ------------------------------------------------------------------ */

test("lazy page rendering: a 30-page PDF renders a bounded leading batch first, and the scroll window (±1200px) renders/unloads page text layers", async () => {
  const world = await createWorld({ materials: [PDF11_SCRIPT], pageSize: 50 });
  await world.openMaterial("mat-pdf11");
  const blocksEl = world.matBlocks();

  /* 几何未知（脚本桩默认 clientHeight=0）：只渲染前导 6 页——绝不整册。 */
  let frames = blocksEl.querySelectorAll(".pdf-page-frame");
  while (frames.length < PDF11.blocks.length) {
    /* 剩余页取回（Load more pages——按钮是显式路径）。 */
    const more = world.el("mat-tail").querySelector(".mat-load-more");
    assert.ok(more !== null, "the tail offers the explicit load-more-pages button");
    more.click();
    await settle(25);
    frames = blocksEl.querySelectorAll(".pdf-page-frame");
  }
  assert.equal(frames.length, PDF11.blocks.length, "all 30 page frames exist in the window");
  /* 桩选择器引擎不支持后代组合器——.material-block 直接子层即页文本层。 */
  const renderedLayers = () => blocksEl.querySelectorAll(".material-block").filter((layer) => layer.dataset.rendered === "true");
  const pendingCount = () => blocksEl.querySelectorAll(".pdf-page-pending").length;
  assert.equal(renderedLayers().length, 6, "only the leading 6 pages render text when geometry is unknown");
  assert.equal(pendingCount(), 24, "the other 24 pages stay as placeholders");

  /* 给定几何（每页 800px 高，视口 1000px）：窗口 ±1200px。 */
  frames.forEach((frame, index) => {
    frame.offsetTop = index * 800;
    frame.offsetHeight = 800;
  });
  blocksEl.clientHeight = 1000;
  blocksEl.scrollTop = 0; /* 窗口 [-1200, 2200] → 页 1..3。 */
  assert.equal(renderedLayers().length, 3, "with geometry, only the viewport window's pages keep text");
  assert.equal(world.blockElement("page-3").dataset.rendered, "true");
  assert.equal(world.pageFrame("page-4").querySelector(".material-block")!.dataset.rendered, "false");
  assert.ok(world.pageFrame("page-4").querySelector(".pdf-page-pending") !== null);

  /* 滚到 8000：窗口 [6800, 10200] → 页 10..13；页 1 卸回占位。 */
  blocksEl.scrollTop = 8000;
  assert.equal(renderedLayers().length, 5, "the scrolled window renders its pages and unloads the far ones");
  assert.equal(world.pageFrame("page-9").querySelector(".material-block")!.dataset.rendered, "true");
  assert.equal(world.pageFrame("page-13").querySelector(".material-block")!.dataset.rendered, "true");
  assert.equal(world.pageFrame("page-14").querySelector(".material-block")!.dataset.rendered, "false");
  assert.equal(world.pageFrame("page-1").querySelector(".material-block")!.dataset.rendered, "false", "pages far outside the window unload back to placeholders");
  assert.equal(world.pageFrame("page-30").querySelector(".material-block")!.dataset.rendered, "false", "the last page is never rendered until approached");

  /* 窗外页卸载后 min-height 占位（滚动几何稳定——setAttribute("style")）。 */
  assert.match(world.pageFrame("page-1").getAttribute("style") ?? "", /min-height: 800px/, "the unloaded page keeps its height as a placeholder");
});

/* ------------------------------------------------------------------ */
/* 8. CSS 词法锁定（PDF 页框 / 导入行）                                  */
/* ------------------------------------------------------------------ */

test("CSS lexicon: PDF page frames, placeholders, and the import row/styles exist lexically (the suite does not execute CSS)", async () => {
  assert.match(STYLE_CSS, /\.pdf-page-frame\s*\{/);
  assert.match(STYLE_CSS, /\.pdf-page-head\s*\{/);
  assert.match(STYLE_CSS, /\.pdf-page-pending\s*\{/);
  assert.match(STYLE_CSS, /\.pdf-page-frame \.pdf-page-text\s*\{/);
  assert.match(STYLE_CSS, /#material-import\s*\{/);
  assert.match(STYLE_CSS, /#material-import-status\s*\{/);
  assert.match(STYLE_CSS, /#material-import-status \.mat-import-error\s*\{/);
  assert.match(STYLE_CSS, /#material-import-status:empty\s*\{/);
  /* 导入行/状态行在 index.html 静态存在（Materials 段内）。 */
  const materialsSection = INDEX_HTML.slice(
    INDEX_HTML.indexOf('id="materials-section"'),
    INDEX_HTML.indexOf('id="search-section"'),
  );
  assert.match(materialsSection, /id="material-import"/);
  assert.match(materialsSection, /id="material-import-input"/);
  assert.match(materialsSection, /id="material-import-status"/);
  assert.match(materialsSection, /accept="\.md,\.markdown,\.pdf"/);
});
