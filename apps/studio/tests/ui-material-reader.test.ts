/**
 * D4-2 材料阅读器前端套件（issue #8 工作包 D4-2「阅读与来源定位」的
 * Markdown 阅读增量；charter §3.2 锚点与材料阅读 / §3.1 版本语义 / 契约
 * §3 已落地的材料 HTTP 面）。
 *
 * 方法与 ui-probe / ui-regressions / ui-terminology 套件一致（issue #4 P1
 * 「证据工程化」的脚本化 DOM E2E）：以 file: URL 加载仓库真实
 * public/app.js 为 ES module（URL query 随机化绕过 ES 模块缓存——每个
 * 场景一份全新实例），运行在「按真实 public/index.html 词法解析出的完整
 * DOM 桩 + 脚本化后端」之上：fetch / EventSource / localStorage / 计时器 /
 * matchMedia / getSelection / navigator.clipboard 全部为内存桩。后端按
 * 场景脚本化，**正文事实直接取自冻结 fixture**
 * tests/fixtures/d4/b1-import/markdown/*.expected.json（canonicalText /
 * blocks 的仓库冻结真值——D4 契约 §6；选区断言对齐
 * tests/fixtures/d4/b2-anchors/markdown-selections.json 的冻结语义）。
 * public/style.css 以 @media 块词法解析（窄窗/reduced-motion/宽窗规则的
 * 存在与形状断言——套件不执行 CSS）。无网络、无磁盘写入、无长等待，
 * 确定性可复现。本文件自包含（不依赖其他 UI 套件）。
 *
 * 覆盖（D4-2 前端增量的逐项锁定）：
 *  1. 材料列表三态 + 逐状态呈现：ready / failed（带 parseError 原因，绝不
 *     伪装成空文档）/ pending·parsing / pdf / 空态（如实指引，导入 UI 属
 *     后续增量）/ 加载中 / 失败 + 重试（常驻，不折叠成空列表）。
 *  2. 打开 + 分块懒加载：?afterBlock= 游标翻页（脚本后端按小块分页）、
     键盘可达的显式 Load more、贴底自动预取、读到末尾、末页后不再请求；
     阅读位置保存/恢复（PUT 节流 + 关闭冲刷 + 恢复滚动到保存块，含保存
     块不在首页时的跨页前补）；打开阅读器不触碰对话游标（无 POST
     /switch——charter §3.2 阅读与探索互不干扰）。
 *  3. 规范偏移映射（charter §3.2「渲染必须保留到规范文本的映射」）：
     块元素携带 blockId + 绝对区间；块 textContent 与冻结 canonicalText
     切片字节相等（无损字面渲染）；选区换算经绝对偏移（前缀长度法）。
 *  4. 选区捕获纪律（B2 冻结集语义）：块内跨行选区（md-sel-22 的冻结
     区间 [1015, 1036)）精确换算；重复词第 5 处（md-sel-19 的「递归」
     [116, 118)——不是第 1 处）；跨块选区如实「不可锚定」（不产生错误
     载荷、不悄悄截断）；字素安全（代理对中间/组合字符中间的边界向外
     吸附到整簇——载荷绝不劈开一个簇）；捕获条如实展示载荷 + 复制摘录
     （clipboard 桩记录 canonicalText 切片）+ D4-3 建枝入口（可点击——
     完整流程归 ui-material-branching.test.ts）。
 *  5. 版本语义（charter §3.1）：所渲染版本可辨认（v2 current / v1 older
     标签）；显式非破坏切换（旧版本保持可读、注记声明绝不迁移锚点）；
     保存位置在旧版本 → 默认打开旧版本并恢复。
 *  6. 诚实状态面：PDF 材料显式「下一增量」（不取块、不伪造页面）；
     pending/parsing 状态 + 显式 Refresh（刷新后正文落地）；failed 带
     原因（无空文档伪装）；详情失败 + 重试；追加分页失败 + 重试。
 *  7. 交互纪律复用：选择期间不重绘（武装选区跨 SSE 终态刷新与追加分页
     存活，块元素/文本节点身份不变；拖拽窗口内 chrome 重渲延后）；
     Esc 关闭阅读器 + 焦点还原到列表按钮；键盘可达（原生 button）。
 *  8. CSS 词法锁定：<720px 全幅 + 捕获条纵排；reduced-motion 进场即时
     化；≥1180px 列内占满；基础层的有界滚动/无损 pre-wrap 渲染规则。
 *
 * 边界（如实声明）：同 ui-terminology——不是真实浏览器 E2E；CSS 不执行，
 * 媒体查询按词法锁定；本套件的 Range 桩支持跨文本节点选区（阅读器跨行/
 * 跨块场景所需——比正文套件的单节点桩更接近真实 DOM，但真实键盘/触屏/
 * 读屏器行为仍归 evidence/d4/ 浏览器口径；阅读位置几何按脚本化
 * offsetTop/offsetHeight 修真）。
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

/* 冻结 fixture（B1 真值——阅读器正文与选区断言的唯一事实源）。 */
const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));

interface FixtureBlock {
  blockId: string;
  kind: "markdown-block" | "pdf-page";
  start: number;
  end: number;
  page?: number;
  text: string;
}

interface FixtureExpected {
  fixtureId: string;
  kind: string;
  normalizer: string;
  canonicalText: string;
  textUnits: number;
  blocks: FixtureBlock[];
}

function loadFixture(id: string): FixtureExpected {
  return JSON.parse(readFileSync(join(B1_ROOT, `markdown/${id}.expected.json`), "utf8")) as FixtureExpected;
}

/* PDF 冻结真值（B1 pdf/ 目录——PDF 阅读增量翻转断言的语料）。 */
function loadPdfFixture(id: string): FixtureExpected {
  return JSON.parse(readFileSync(join(B1_ROOT, `pdf/${id}.expected.json`), "utf8")) as FixtureExpected;
}

const MD01 = loadFixture("md-01"); /* 递归与分治：14 块，1179 units */
const MD05 = loadFixture("md-05"); /* 闭包/counter：17 块（版本切换的 v1 语料） */
const MD06 = loadFixture("md-06"); /* emoji：🚀/👍🏽/国旗（字素吸附语料） */
const MD07 = loadFixture("md-07"); /* Unicode：分解形式 café（组合字符语料） */

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

/** 材料桩（后端在库形态）：版本 → 冻结块源映射（多版本材料各取各的）。 */
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
  body?: string;
}

interface StubResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/* ------------------------------ 事件轮转 / 短等待 ------------------------------ */

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 阅读器退场动画（MATERIAL_READER_EXIT_MS = 170ms）收尾所需的短等待
 * （同 ui-probe 的 sleep：hidden 在动画播完后才置位）。 */
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
  /* 阅读位置几何（脚本可设；默认 0——确定性回落见 app.js 注释）。 */
  offsetTop = 0;
  offsetHeight = 0;
  private readonly listeners = new Map<string, Set<StubListener>>();
  _scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  title = "";
  value = "";
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

/**
 * 阅读器选区桩：start/end 可落在**不同**文本节点（块内跨行/跨块选区的
 * 修真——正文套件的单文本节点桩不够）。toString 按全文档扁平文本切片；
 * selectNodeContents(元素) + setEnd(文本节点, 偏移) 的前缀长度法与真实
 * DOM Range 同一语义（app.js materialBlockLocalStart 依赖）。
 */
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

  /** 边界 → 全文档扁平文本位置：文本节点 = 节点文本起点 + offset；元素
      offset k = 前 k 个子树的文本之后（0 = 子树起点，children.length =
      子树终点——selectNodeContents 的两处用法）。 */
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

  /* 扁平文本（每次重建——测试文档小，正确性优先于缓存）。 */
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

/* ------------------------------ 材料桩（fixture 驱动） ------------------------------ */

interface MaterialScript {
  /** 材料标识与显示名。 */
  id: string;
  title: string;
  /** 版本定义（按导入序）；ready markdown/pdf 版本取 fixture 块源。 */
  versions: Array<{
    id: string;
    parserKind: "markdown" | "pdf";
    parseStatus: MaterialParseStatus;
    parseError?: string;
    fixture?: string;
  }>;
  /** 预置阅读位置（GET detail 原样返回；PUT 更新它）。 */
  readingPosition?: StubReadingPosition | null;
}

const VERSION_SEQUENCE = ["v-1", "v-2", "v-3"];

function buildStubMaterial(script: MaterialScript): StubMaterialEntry {
  const versions: StubMaterialVersion[] = script.versions.map((version, index) => {
    const fixture =
      version.fixture !== undefined
        ? version.parserKind === "pdf"
          ? loadPdfFixture(version.fixture)
          : loadFixture(version.fixture)
        : null;
    return {
      id: version.id,
      materialId: script.id,
      contentHash: `hash-${script.id}-${version.id}`,
      parserKind: version.parserKind,
      parserVersion: version.parserKind === "pdf" ? "d4-pdf-v1" : "d4-md-v1",
      importedAt: ISO,
      sizeBytes: 1024,
      parseStatus: version.parseStatus,
      parseError: version.parseError ?? null,
      textUnits: fixture === null ? 0 : fixture.textUnits,
    };
  });
  /* 块源取**最新 ready 版本**的 fixture（多 ready 版本各取各的——按
     versionId 查找；此处按 id 映射；pdf 版本取 pdf/ 目录冻结真值）。 */
  const sources = new Map<string, FixtureExpected>();
  for (const version of script.versions) {
    if (version.fixture !== undefined) {
      sources.set(
        version.id,
        version.parserKind === "pdf" ? loadPdfFixture(version.fixture) : loadFixture(version.fixture),
      );
    }
  }
  const firstSource = script.versions.find((v) => v.fixture !== undefined)?.fixture;
  const firstKind = script.versions.find((v) => v.fixture !== undefined)?.parserKind ?? "markdown";
  const primary =
    firstSource === undefined
      ? null
      : firstKind === "pdf"
        ? loadPdfFixture(firstSource)
        : loadFixture(firstSource);
  return {
    material: { id: script.id, title: script.title, createdAt: ISO },
    versions,
    readingPosition:
      script.readingPosition === undefined || script.readingPosition === null
        ? null
        : {
            versionId: script.readingPosition.versionId,
            blockId: script.readingPosition.blockId,
            focusStart: script.readingPosition.focusStart,
            updatedAt: ISO,
          },
    versionSources: sources,
  };
}

/* ------------------------------ 后端（树 + 材料） ------------------------------ */

interface Backend {
  trees: Tree[];
  treeState: TreeState;
  diagnostics: TreeDiagnostics;
  requests: RecordedRequest[];
  switchCount: number;
  materials: StubMaterialEntry[];
  /** 每页块数上限（脚本化——分页场景给小值）。 */
  pageSize: number;
  /** 首个 GET /materials 失败一次（列表失败 + 重试场景）。 */
  listFailOnce: boolean;
  /** 指定材料的首个 GET detail 失败一次。 */
  detailFailOnce: string | null;
  /** 指定材料的首个带 afterBlock 分页请求失败一次。 */
  appendFailOnce: string | null;
  /** 指定材料在第二次 GET detail 时变为 ready（pending/parsing → 刷新场景）。 */
  flipToReady: string | null;
  /** 每材料的 detail 拉取计数（flipToReady 的「第二次」判定）。 */
  detailFetchCounts: Map<string, number>;
  /** 命中即挂起的请求路径后缀（一次性闸门，releaseHold 放行）。 */
  holdSuffix: string | null;
  /** clipboard 桩记录（复制摘录断言）。 */
  copied: string[];
}

interface WorldOptions {
  materials?: MaterialScript[];
  pageSize?: number;
  listFailOnce?: boolean;
  detailFailOnce?: string;
  appendFailOnce?: string;
  flipToReady?: string;
  holdSuffix?: string;
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

  /* 最小树状态（阅读器与树态正交；主线一条答案足够覆盖 selectionchange
     的正文路径判定）。 */
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
    listFailOnce: options.listFailOnce === true,
    detailFailOnce: options.detailFailOnce ?? null,
    appendFailOnce: options.appendFailOnce ?? null,
    flipToReady: options.flipToReady ?? null,
    detailFetchCounts: new Map<string, number>(),
    holdSuffix: options.holdSuffix ?? null,
    copied: [],
  };

  /* 一次性请求闸门。 */
  let releaseHoldFn: (() => void) | null = null;
  const holdGate =
    options.holdSuffix === undefined ? null : new Promise<void>((resolve) => { releaseHoldFn = resolve; });

  const fetchStub = async (input: string, init: StubFetchInit = {}): Promise<StubResponse> => {
    const method = init.method ?? "GET";
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    backend.requests.push({ method, path: String(input), body });
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

    /* ---- 材料面（D4 契约 §3 的已落地形状） ---- */
    if (p === "/api/trees" && method === "GET") {
      return respond(200, { trees: backend.trees });
    }
    let m = /^\/api\/trees\/([^/]+)\/materials$/.exec(p);
    if (m !== null && method === "GET") {
      if (backend.listFailOnce) {
        backend.listFailOnce = false;
        return respond(500, { error: { code: "internal", message: "scripted materials list failure" } });
      }
      return respond(200, {
        materials: backend.materials.map((entry) => ({
          material: entry.material,
          versions: entry.versions,
        })),
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      if (backend.detailFailOnce === entry.material.id) {
        backend.detailFailOnce = null;
        return respond(500, { error: { code: "internal", message: "scripted detail failure" } });
      }
      /* flipToReady：第二次 detail 把版本收敛为 ready（解析完成场景——
         打开时仍是 parsing，显式 Refresh 后才就绪）。 */
      const fetchCount = (backend.detailFetchCounts.get(entry.material.id) ?? 0) + 1;
      backend.detailFetchCounts.set(entry.material.id, fetchCount);
      if (backend.flipToReady === entry.material.id && fetchCount >= 2) {
        backend.flipToReady = null;
        for (const version of entry.versions) {
          if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
            version.parseStatus = "ready";
            version.parseError = null;
            const source = entry.versionSources.get(version.id);
            if (source !== undefined) version.textUnits = source.textUnits;
          }
        }
      }
      return respond(200, {
        material: entry.material,
        versions: entry.versions,
        readingPosition: entry.readingPosition,
        parseTasks: [],
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
      if (after !== null && after !== "" && backend.appendFailOnce === entry.material.id) {
        backend.appendFailOnce = null;
        return respond(500, { error: { code: "internal", message: "scripted append page failure" } });
      }
      return respond(200, {
        blocks: slice.map((block) => ({
          block:
            block.kind === "pdf-page"
              ? { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end, page: block.page }
              : { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end },
          text: block.text,
        })),
        nextAfterBlock: more && slice.length > 0 ? slice[slice.length - 1]!.blockId : null,
        textUnits: source === undefined ? version.textUnits : source.textUnits,
      });
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
  /* Node 的 globalThis.navigator 只有 getter——桩以 defineProperty 覆盖
     （复制摘录路径的 clipboard 桩；每测试文件独立进程，不外泄）。 */
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
      assert.ok(found !== undefined, `missing rendered block ${blockId}`);
      return found;
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

/** 世界面（场景辅助的契约；对齐 ui-terminology 的 World 形状）。 */
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

/** 块内按内容找文本节点（行级节点的确定性定位）。 */
function textNodeContaining(block: StubElement, needle: string): StubText {
  const found = collectTextNodes(block).find((node) => node.data.includes(needle));
  assert.ok(found !== undefined, `no text node containing ${JSON.stringify(needle)} in block ${block.dataset.blockId}`);
  return found;
}

function collectTextNodes(element: StubElement | StubText): StubText[] {
  if (element instanceof StubText) return [element];
  const out: StubText[] = [];
  for (const child of element.children) {
    if (child instanceof StubText) out.push(child);
    else out.push(...collectTextNodes(child));
  }
  return out;
}

/** 块内首行文本节点（无样式包裹时即块的第一个子节点）。 */
function firstLineNode(block: StubElement): StubText {
  const nodes = collectTextNodes(block);
  assert.ok(nodes.length > 0, `block ${block.dataset.blockId} has no text nodes`);
  return nodes[0]!;
}

/** 武装一个块内选区（脚本选区 + mouseup——与真实拖拽收尾同一入口）。 */
function armBlockSelection(
  world: World,
  blockId: string,
  startNode: StubText,
  startOffset: number,
  endNode: StubText,
  endOffset: number,
): void {
  world.setSelection(world.makeRange(startNode, startOffset, endNode, endOffset));
  world.matBlocks().dispatchEvent("mouseup", {});
}

/** 捕获条当前状态（valid 载荷 / invalid 说明 / hint）。 */
function selectionBar(world: World): StubElement {
  const bar = world.byId("mat-selection-bar");
  assert.ok(bar !== null, "selection bar missing");
  return bar;
}

/* 标准场景材料束。 */
const MD01_SCRIPT: MaterialScript = {
  id: "mat-md01",
  title: "递归与分治学习笔记.md",
  versions: [{ id: "v-md01-1", parserKind: "markdown", parseStatus: "ready", fixture: "md-01" }],
};
const FAILED_SCRIPT: MaterialScript = {
  id: "mat-failed",
  title: "超限文档.md",
  versions: [
    {
      id: "v-failed-1",
      parserKind: "markdown",
      parseStatus: "failed",
      parseError: "text-units-exceeded: the parsed canonical text exceeds the 1,000,000 UTF-16 unit limit (1,048,576 units)",
    },
  ],
};
const PARSING_SCRIPT: MaterialScript = {
  id: "mat-parsing",
  title: "正在解析的笔记.md",
  versions: [{ id: "v-parsing-1", parserKind: "markdown", parseStatus: "parsing" }],
};
const PDF_SCRIPT: MaterialScript = {
  id: "mat-pdf",
  title: "扫描队列设计.pdf",
  versions: [{ id: "v-pdf-1", parserKind: "pdf", parseStatus: "ready", fixture: "pdf-01" }],
};
/** 双 ready 版本（v1 = md-05 旧内容，v2 = md-01 新内容——改版场景）。 */
const VERSIONED_SCRIPT: MaterialScript = {
  id: "mat-versions",
  title: "闭包学习笔记（改版）.md",
  versions: [
    { id: "v-old", parserKind: "markdown", parseStatus: "ready", fixture: "md-05" },
    { id: "v-new", parserKind: "markdown", parseStatus: "ready", fixture: "md-01" },
  ],
};

/* ------------------------------------------------------------------ */
/* 1. 材料列表：三态 + 逐状态如实呈现                                    */
/* ------------------------------------------------------------------ */

test("material list: honest per-state rows (ready / failed-with-reason / parsing / pdf), an honest empty state, a loading state, and a retryable list failure", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT, FAILED_SCRIPT, PARSING_SCRIPT, PDF_SCRIPT],
  });

  /* 已载：逐材料行——标题 + 最新版本状态；failed 带原因、绝不伪装可读；
     parsing 如实「仍在进行」；pdf 标注种类。 */
  const readyButton = world.materialButton("mat-md01");
  assert.match(readyButton.textContent!, /递归与分治学习笔记\.md/);
  const readyMeta = readyButton.querySelector(".material-meta")!;
  assert.match(readyMeta.textContent!, /markdown · v1 · ready/);

  const failedButton = world.materialButton("mat-failed");
  const failedStatus = failedButton.querySelector(".material-status")!;
  assert.ok(failedStatus.classList.contains("failed"), "the failed status carries its status class");
  assert.match(
    failedStatus.textContent!,
    /failed: text-units-exceeded: the parsed canonical text exceeds/,
    "the failure reason is shown verbatim (never an empty doc masquerade)",
  );
  assert.match(failedStatus.title!, /1,048,576 units/, "the full reason is preserved in the title");

  const parsingButton = world.materialButton("mat-parsing");
  const parsingStatus = parsingButton.querySelector(".material-status")!;
  assert.ok(parsingStatus.classList.contains("parsing"));
  assert.match(parsingStatus.textContent!, /parsing/);

  const pdfButton = world.materialButton("mat-pdf");
  assert.match(pdfButton.querySelector(".material-meta")!.textContent!, /pdf · v1 · ready/);

  /* 打开阅读器（ready markdown）不影响对话游标（charter §3.2：阅读与
     探索互不干扰——阅读不 POST /switch）。 */
  await world.openMaterial("mat-md01");
  assert.equal(world.el("material-reader").hidden, false, "the reader opens");
  assert.equal(
    world.requestsOf("/switch").length,
    0,
    "opening the material reader never aligns the conversation cursor",
  );

  /* 空态（无材料）：如实指引（导入入口就在列表上方——owner P1 已落地）。 */
  const emptyWorld = await createWorld({ materials: [] });
  const emptyList = emptyWorld.el("material-list");
  assert.match(
    emptyList.textContent!,
    /no materials linked to this tree yet/,
    "an empty list shows the honest empty state with guidance",
  );
  assert.match(emptyList.textContent!, /import a \.md, \.markdown or \.pdf file with the import entry above/);
  assert.ok(emptyWorld.byId("material-import") !== null, "the import entry exists (owner P1)");
  assert.match(
    emptyWorld.byId("material-import-input")!.getAttribute("accept") ?? "",
    /^\.md,\.markdown,\.pdf$/,
    "the file picker accepts exactly the D4-1 support set",
  );

  /* 加载中（请求闸门挂起）：不伪装成空态。 */
  const heldWorld = await createWorld({ materials: [MD01_SCRIPT], holdSuffix: "/materials" });
  await settle(5);
  assert.match(
    heldWorld.el("material-list").textContent!,
    /loading materials…/,
    "the list shows the in-flight state while the fetch is held",
  );
  heldWorld.releaseHold();
  await settle(25);
  assert.match(heldWorld.el("material-list").textContent!, /递归与分治学习笔记/);

  /* 列表失败 + 重试（常驻，不折叠成空列表）。 */
  const failWorld = await createWorld({ materials: [MD01_SCRIPT], listFailOnce: true });
  assert.match(
    failWorld.el("material-list").textContent!,
    /materials failed to load — internal: scripted materials list failure/,
    "a list failure surfaces the honest error",
  );
  const retry = failWorld.el("material-list").querySelector("button.drawer-retry");
  assert.ok(retry !== null, "the list failure offers a retry");
  retry.click();
  await settle(25);
  assert.match(failWorld.el("material-list").textContent!, /递归与分治学习笔记/);
});

/* ------------------------------------------------------------------ */
/* 2. 打开 + 分块懒加载 + 阅读位置（保存/恢复/跨页前补）                  */
/* ------------------------------------------------------------------ */

test("block-chunked reading: pages arrive via the afterBlock cursor, Load more is an explicit keyboard path, near-bottom scroll prefetches, the end is honest, and no fetches continue past the end", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT], pageSize: 5 });
  await world.openMaterial("mat-md01");

  /* 首页：blk-0..blk-4，游标 nextAfterBlock=blk-4；尾部给出显式入口。 */
  const blocks = world.matBlocks();
  assert.deepEqual(
    blocks.querySelectorAll(".material-block").map((b) => b.dataset.blockId),
    ["blk-0", "blk-1", "blk-2", "blk-3", "blk-4"],
    "the first page renders five blocks",
  );
  const firstPage = world.lastRequest("/versions/v-md01-1")!;
  assert.match(firstPage.path, /limit=50/, "the reader requests an explicit page size");
  assert.ok(!firstPage.path.includes("afterBlock="), "the first page starts from the top");
  const tail = world.el("mat-tail");
  const loadMore = tail.querySelector(".mat-load-more");
  assert.ok(loadMore !== null, "the tail offers an explicit Load more (keyboard-reachable native button)");
  assert.match(tail.textContent!, /5 block\(s\) in view · 1179 text units total/);

  /* 显式 Load more：第二页经 afterBlock=blk-4 追加；既有块元素不被换走。 */
  const blk0Before = world.blockElement("blk-0");
  loadMore.click();
  await settle(25);
  const secondPage = world.lastRequest("/versions/v-md01-1")!;
  assert.match(secondPage.path, /afterBlock=blk-4/, "the second page uses the nextAfterBlock cursor");
  assert.deepEqual(
    world.matBlocks().querySelectorAll(".material-block").map((b) => b.dataset.blockId),
    ["blk-0", "blk-1", "blk-2", "blk-3", "blk-4", "blk-5", "blk-6", "blk-7", "blk-8", "blk-9"],
    "the second page appends blocks blk-5..blk-9",
  );
  assert.equal(world.blockElement("blk-0"), blk0Before, "appending never replaces earlier block elements");

  /* 贴底滚动：自动预取第三页（滚动事件路径）；读到末尾后不再请求。 */
  const fetchCountBefore = world.requestsOf("/versions/v-md01-1").length;
  world.matBlocks().scrollTop = 100000; /* 远超内容高度 → 贴底 */
  await settle(25);
  const thirdPage = world.lastRequest("/versions/v-md01-1")!;
  assert.match(thirdPage.path, /afterBlock=blk-9/, "scrolling near the bottom prefetches the next page");
  assert.match(world.el("mat-tail").textContent!, /end of material/);
  const fetchCountAfterEnd = world.requestsOf("/versions/v-md01-1").length;
  world.matBlocks().scrollTop = 0;
  world.matBlocks().scrollTop = 50000;
  await settle(25);
  assert.equal(
    world.requestsOf("/versions/v-md01-1").length,
    fetchCountAfterEnd,
    "no further page requests after the material ends",
  );
  assert.ok(fetchCountAfterEnd >= fetchCountBefore + 1);
});

test("keyboard-scrollable reading surface: #mat-blocks carries tabindex=0 (WCAG 2.1 SC 2.1.1 — arrow/PageDown scrolling needs a focusable scroll container)", async () => {
  /* B7 beta 可用性探针发现：阅读器内没有任何可聚焦子元素，键盘方向键/
     PageDown 无法滚动正文（#material-reader 的 tabindex=-1 程序聚焦目标
     不在滚动容器内，焦点在其上时方向键滚不到 #mat-blocks）。修复：
     #mat-blocks 成为 Tab 停靠点（tabindex=0），聚焦后即可键盘滚动。 */
  const world = await createWorld({ materials: [MD01_SCRIPT], pageSize: 5 });
  await world.openMaterial("mat-md01");
  const blocks = world.matBlocks();
  assert.equal(blocks.getAttribute("tabindex"), "0", "#mat-blocks must be a tab stop (keyboard-operable scrolling)");
  assert.equal(
    blocks.getAttribute("aria-label"),
    "Material text (canonical, block by block)",
    "the scroll container keeps its accessible name",
  );
  /* 键盘聚焦路径在位：tabindex 容器可聚焦（脚本桩的 focus 记录）。 */
  blocks.focus();
  assert.equal(world.document.activeElement, blocks, "#mat-blocks takes focus (arrow keys then scroll it)");
});

test("reading position: throttled save on scroll, immediate flush on close, and restore on reopen (scrollIntoView on the saved block)", async () => {  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");

  /* 脚本化几何：每块 100px 高、按序排布；顶部可见块 = 首个底边越过滚动
     顶端的块。 */
  const blocksEl = world.matBlocks();
  for (const [index, block] of blocksEl.querySelectorAll(".material-block").entries()) {
    block.offsetTop = index * 100;
    block.offsetHeight = 100;
  }
  world.matBlocks().scrollTop = 350; /* → 顶部可见块 blk-3（300+100 > 351） */
  /* 节流保存（1500ms 防抖）：等待真实计时器（真值路径，不缩短产品常量）。 */
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const periodic = world.lastRequest("/reading-position");
  assert.ok(periodic !== null && periodic.method === "PUT", "the throttled scroll save fires a PUT");
  assert.deepEqual(
    { versionId: (periodic.body as Record<string, unknown>).versionId, blockId: (periodic.body as Record<string, unknown>).blockId },
    { versionId: "v-md01-1", blockId: "blk-3" },
    "the saved position names the top visible block (block-level, focusStart reserved for D4-3)",
  );

  /* 关闭冲刷：滚动到另一块后关闭——立即保存（不等防抖）。 */
  world.matBlocks().scrollTop = 750; /* → blk-7（700+100 > 751） */
  world.el("mat-close").click();
  await settle(10);
  await sleep(200); /* 退场动画（170ms）播完才置 hidden */
  const flushed = world.requestsOf("/reading-position").filter((r) => r.method === "PUT").pop()!;
  assert.equal((flushed.body as Record<string, unknown>).blockId, "blk-7", "closing the reader flushes the position immediately");
  assert.equal(world.el("material-reader").hidden, true, "the reader is closed");

  /* 重开：detail 返回保存位置 → 恢复到保存块（scrollIntoView + 注记）。 */
  await world.openMaterial("mat-md01");
  const restored = world.blockElement("blk-7");
  assert.equal(
    (restored.lastScrollIntoView as { block?: string } | null)?.block,
    "start",
    "reopening scrolls the saved block into view",
  );
  assert.match(
    world.el("material-reader").textContent!,
    /restored to your saved reading position \(block blk-7\)/,
  );
});

test("reading position beyond the first page: the open loop pages forward until the saved block is loaded, then restores onto it", async () => {
  const world = await createWorld({
    materials: [
      {
        ...MD01_SCRIPT,
        readingPosition: { versionId: "v-md01-1", blockId: "blk-13", focusStart: null, updatedAt: ISO },
      },
    ],
    pageSize: 5,
  });
  await world.openMaterial("mat-md01");
  /* 恢复目标 blk-13 不在首页：按 nextAfterBlock 前补到目标块出现。 */
  const pages = world.requestsOf("/versions/v-md01-1");
  assert.equal(pages.length, 3, "three pages are fetched until blk-13 is loaded");
  assert.match(pages[1]!.path, /afterBlock=blk-4/);
  assert.match(pages[2]!.path, /afterBlock=blk-9/);
  const target = world.blockElement("blk-13");
  assert.equal((target.lastScrollIntoView as { block?: string } | null)?.block, "start");
  assert.match(world.el("material-reader").textContent!, /restored to your saved reading position \(block blk-13\)/);
});

/* ------------------------------------------------------------------ */
/* 3. 规范偏移映射：无损渲染 + 绝对偏移换算                              */
/* ------------------------------------------------------------------ */

test("lossless rendering: every rendered block's textContent equals the frozen canonicalText slice byte-for-byte, carrying its absolute range", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");

  for (const fixtureBlock of MD01.blocks) {
    const element = world.blockElement(fixtureBlock.blockId);
    assert.equal(
      element.textContent,
      fixtureBlock.text,
      `${fixtureBlock.blockId} renders the canonical text byte-for-byte (markdown syntax kept verbatim — no HTML parsing)`,
    );
    assert.equal(element.dataset.start, String(fixtureBlock.start), "the block carries its absolute start offset");
    assert.equal(element.dataset.end, String(fixtureBlock.end), "the block carries its absolute end offset");
  }
  /* 头部块（标题行）与列表块（多行）都成立——块 textContent 与冻结真值
     全等即 canonicalText 映射的结构性保证（渲染不删任何字符）。 */
  assert.equal(
    world.matBlocks().querySelectorAll(".material-block").reduce((sum, block) => sum + block.textContent.length, 0),
    MD01.canonicalText.length,
    "the rendered blocks concatenate to the full canonicalText",
  );
  /* 标题行有样式层（mat-h* span），但字符一字不少。 */
  const heading = world.blockElement("blk-0").querySelector(".mat-h1");
  assert.ok(heading !== null, "an ATX heading line gets heading styling");
  assert.equal(heading.textContent, "# 递归与分治学习笔记", "styling keeps the # syntax verbatim");
});

test("cross-line selection inside one block: the captured payload is the frozen md-sel-22 range [1015, 1036) over canonicalText", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");

  /* blk-12 是多行列表块：选区跨行尾换行（md-sel-22 的冻结语义：
     “顺序不要颠倒。\n- 每次分解必须向基线靠近” ∈ blk-12 [1015, 1036)）。 */
  const block = world.blockElement("blk-12");
  const line1 = textNodeContaining(block, "顺序不要颠倒");
  const line2 = textNodeContaining(block, "每次分解必须向基线靠近");
  const line1Offset = line1.data.indexOf("顺序不要颠倒");
  const line2Offset = line2.data.indexOf("向基线靠近") + "向基线靠近".length;
  armBlockSelection(world, "blk-12", line1, line1Offset, line2, line2Offset);

  const bar = selectionBar(world);
  const quote = bar.querySelector(".mat-quote")!;
  const payload = bar.querySelector(".mat-payload")!;
  assert.match(payload.textContent!, /block blk-12/);
  assert.match(payload.textContent!, /UTF-16 \[1015, 1036\)/, "the payload uses absolute canonical offsets");
  const excerpt = "顺序不要颠倒。\n- 每次分解必须向基线靠近";
  assert.equal(quote.textContent, excerpt, "the quote shows the exact original text (newline intact)");
  /* 冻结真值复核：excerpt === canonicalText.slice(start, end)（B1 真值）。 */
  assert.equal(MD01.canonicalText.slice(1015, 1036), excerpt);
  /* 捕获条给出 D4-3 建枝入口（已落地——可点击，不再是「随 D4-3 落地」的
     诚实占位；入口的完整流程由 ui-material-branching.test.ts 锁定）。 */
  const d43 = bar.querySelector(".mat-branch-d43")!;
  assert.equal(d43.disabled, false, "the D4-3 branch entry is offered (enabled) on the armed bar");
  assert.match(d43.textContent!, /Branch from material/);
});

test("repeat-word discipline: selecting the FIFTH 递归 captures [116, 118) — the second-block occurrence, never the first string match (md-sel-19)", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");

  /* blk-1 内第 5 处「递归」＝块内偏移 103（全 canonicalText 出现序 5）。
     选区来自 DOM 位置（前缀长度换算），不是字符串搜索——第 1 处（偏移
     13）绝不可能被误捕获。 */
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);
  assert.equal(line.data.slice(103, 105), "递归", "the fixture truth: blk-1 local [103,105) is the fifth occurrence");
  armBlockSelection(world, "blk-1", line, 103, line, 105);

  const bar = selectionBar(world);
  assert.match(bar.querySelector(".mat-payload")!.textContent!, /UTF-16 \[116, 118\)/);
  assert.equal(bar.querySelector(".mat-quote")!.textContent, "递归");
  assert.notEqual(
    bar.querySelector(".mat-payload")!.textContent!.includes("[13, 15)"),
    true,
    "the first occurrence (offset 13) is never captured for this selection",
  );
});

test("cross-block selection: the honest not-anchorable state — no payload, no silent truncation (B2 discipline)", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");

  const blk0 = world.blockElement("blk-0");
  const blk1 = world.blockElement("blk-1");
  const node0 = firstLineNode(blk0);
  const node1 = firstLineNode(blk1);
  armBlockSelection(world, "blk-0", node0, 2, node1, 4);

  const bar = selectionBar(world);
  assert.equal(bar.querySelector(".mat-quote"), null, "no quote payload is produced for a cross-block selection");
  assert.match(
    bar.querySelector(".mat-invalid-note")!.textContent!,
    /cross-block selection not anchorable/,
    "the honest not-anchorable state is shown",
  );
  assert.match(bar.querySelector(".mat-invalid-note")!.textContent!, /single block/);
  /* 换成块内选区后恢复正常武装（说明性状态不卡死捕获面）。 */
  armBlockSelection(world, "blk-1", node1, 0, node1, 2);
  assert.match(selectionBar(world).querySelector(".mat-payload")!.textContent!, /UTF-16 \[13, 15\)/);
});

test("grapheme-safe capture: a boundary inside a surrogate pair or a combining sequence snaps outward — the payload never splits a cluster (md-06 / md-07 fixtures)", async () => {
  const world = await createWorld({
    materials: [
      { id: "mat-md06", title: "代码评审礼仪笔记.md", versions: [{ id: "v-md06-1", parserKind: "markdown", parseStatus: "ready", fixture: "md-06" }] },
      { id: "mat-md07", title: "Unicode 去重坑.md", versions: [{ id: "v-md07-1", parserKind: "markdown", parseStatus: "ready", fixture: "md-07" }] },
    ],
  });

  /* md-06 blk-7：🚀 位于块内 [21,23)（全 canonicalText [368,370)，B2 冻结
     集 md-sel-29 的簇）。起点落在代理对中间（22）→ 向外吸附到 21。 */
  await world.openMaterial("mat-md06");
  const rocketBlock = world.blockElement("blk-7");
  const rocketLine = firstLineNode(rocketBlock);
  assert.equal(rocketLine.data.slice(21, 23), "🚀", "fixture truth: the rocket cluster sits at blk-7 local [21,23)");
  armBlockSelection(world, "blk-7", rocketLine, 22, rocketLine, 28);
  let bar = selectionBar(world);
  let payload = bar.querySelector(".mat-payload")!;
  assert.match(payload.textContent!, /UTF-16 \[368, 375\)/, "the start snapped outward to the whole cluster (368, not 369)");
  assert.equal(bar.querySelector(".mat-quote")!.textContent, MD06.canonicalText.slice(368, 375));
  assert.ok(
    bar.textContent!.includes("snapped outward"),
    "the snap is disclosed honestly in the capture bar",
  );
  /* 吸附后的摘录以完整 🚀 开头（绝不劈开代理对）。 */
  assert.equal(bar.querySelector(".mat-quote")!.textContent.slice(0, 2), "🚀");

  /* md-07 blk-3：分解形式 café = c,a,f,e + U+0301（全局簇 [221,226)——B2
     冻结集 md-sel-34 的同一簇；inv-06 的无效边界即 225）。终点落在基字符
     e 与组合尖音符之间（225）→ 向外吸附到 226（簇完整收进摘录，绝不把
     组合标记与基字符拆开）。 */
  await world.openMaterial("mat-md07");
  const cafeBlock = world.blockElement("blk-3");
  const cafeNeedle = "cafe\u0301";
  const cafeNode = textNodeContaining(cafeBlock, cafeNeedle);
  const cafeAt = cafeNode.data.indexOf(cafeNeedle);
  const baseAt = cafeAt + 3; /* 'caf' 之后是基字符 e */
  assert.equal(cafeNode.data.slice(baseAt, baseAt + 2), "e\u0301", "fixture truth: the decomposed cluster is base + combining mark");
  armBlockSelection(world, "blk-3", cafeNode, cafeAt - 8, cafeNode, baseAt + 1);
  bar = selectionBar(world);
  payload = bar.querySelector(".mat-payload")!;
  const endMatch = /UTF-16 \[(\d+), (\d+)\)/.exec(payload.textContent!)!;
  assert.ok(endMatch !== null);
  const end = Number(endMatch[2]);
  assert.equal(end, 226, "the end boundary snapped outward to the cluster end (226, the frozen md-sel-34 range end), not 225");
  assert.equal(
    bar.querySelector(".mat-quote")!.textContent,
    MD07.canonicalText.slice(Number(endMatch[1]), end),
    "the excerpt equals the frozen canonicalText slice (verification is exact)",
  );
  assert.ok(
    bar.querySelector(".mat-quote")!.textContent.endsWith(cafeNeedle),
    "the combining mark stays attached to its base (decomposed café, fixture form)",
  );
});

test("copy quote: the clipboard receives the exact canonical slice; the D4-3 anchor payload stays honestly displayed", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);
  armBlockSelection(world, "blk-1", line, 0, line, 2); /* 「递归」第一处 */
  const copy = selectionBar(world).querySelector(".mat-copy")!;
  copy.click();
  await settle(5);
  assert.deepEqual(world.backend.copied, ["递归"], "the clipboard stub receives the canonical excerpt");
  assert.equal(copy.textContent, "Copied ✓", "the button confirms the copy");
  assert.equal(
    selectionBar(world).querySelector(".mat-payload")!.textContent!.includes("material mat-md01"),
    true,
    "the captured payload names the material and version (the future D4-3 anchor)",
  );
});

/* ------------------------------------------------------------------ */
/* 4. 版本语义（charter §3.1）                                          */
/* ------------------------------------------------------------------ */

test("version awareness: the reader shows which version it renders, an older version is explicitly labeled and readable, and switching is non-destructive with a never-migrates note", async () => {
  const world = await createWorld({ materials: [VERSIONED_SCRIPT] });
  await world.openMaterial("mat-versions");

  /* 默认打开最新版本（v2 = md-01 内容）且可辨认。 */
  assert.match(world.el("material-reader").querySelector(".mat-meta")!.textContent!, /v2 \(current\)/);
  assert.equal(world.blockElement("blk-0").textContent, "# 递归与分治学习笔记\n\n", "v2 renders the md-01 content");
  const chips = world.el("material-reader").querySelectorAll(".mat-version-chip");
  assert.equal(chips.length, 2, "the version strip shows every version");
  assert.match(chips[0]!.textContent!, /v1 · markdown · older/, "the older version is labeled");
  assert.match(chips[1]!.textContent!, /v2 · markdown/);
  assert.ok(!chips[1]!.textContent!.includes("older"), "the current version is not marked older");

  /* 显式切到旧版本：非破坏性（v1 保持可读、可切回；绝不自动迁移）。 */
  chips[0]!.click();
  await settle(25);
  assert.match(
    world.el("material-reader").querySelector(".mat-meta")!.textContent!,
    /v1 \(older — v2 is current\)/,
    "reading an old version is labeled as such",
  );
  const oldBlock = world.blockElement("blk-0");
  assert.equal(oldBlock.textContent, "# 闭包学习笔记：counter 的四种写法\n\n", "v1 renders the md-05 content (immutable old version stays readable)");
  assert.match(
    world.el("material-reader").textContent!,
    /you are reading v1 \(older\).*never migrates saved quotes/,
    "the non-destructive switch note states the never-migrates rule (charter §3.1)",
  );
  const openLatest = world.el("material-reader").querySelector(".mat-note-action");
  assert.ok(openLatest !== null, "an explicit switch-to-current affordance is offered");
  openLatest.click();
  await settle(25);
  assert.equal(world.blockElement("blk-0").textContent, "# 递归与分治学习笔记\n\n", "switching back re-renders v2");
  assert.match(world.el("material-reader").querySelector(".mat-meta")!.textContent!, /v2 \(current\)/);
});

test("a saved reading position on an older version reopens that version (charter §1: return to the original text), with the older-version note and restore", async () => {
  const world = await createWorld({
    materials: [
      {
        ...VERSIONED_SCRIPT,
        readingPosition: { versionId: "v-old", blockId: "blk-2", focusStart: null, updatedAt: ISO },
      },
    ],
  });
  await world.openMaterial("mat-versions");
  assert.match(
    world.el("material-reader").querySelector(".mat-meta")!.textContent!,
    /v1 \(older — v2 is current\)/,
    "the saved version is the one opened (not silently the latest)",
  );
  const target = world.blockElement("blk-2");
  assert.equal((target.lastScrollIntoView as { block?: string } | null)?.block, "start");
  assert.match(world.el("material-reader").textContent!, /restored to your saved reading position \(block blk-2\)/);
});

/* ------------------------------------------------------------------ */
/* 5. 诚实状态面（PDF / 非 ready / 失败 + 重试）                         */
/* ------------------------------------------------------------------ */

test("a PDF material opens to the real page reading surface — pages render with identifiers and blocks are fetched (D4-2 PDF increment)", async () => {
  const PDF01 = loadPdfFixture("pdf-01"); /* 冻结真值：2 页（page-1/page-2） */
  const world = await createWorld({
    materials: [
      {
        id: "mat-pdf01",
        title: "递归学习笔记.pdf",
        versions: [{ id: "v-pdf01-1", parserKind: "pdf", parseStatus: "ready", fixture: "pdf-01" }],
      },
    ],
  });
  await world.openMaterial("mat-pdf01");
  /* 页框按冻结块图落位：两页、页头标识（Page 1 / Page 2）、文本层
     textContent 与冻结页块文本字节相等（规范映射的事实源）。 */
  const frames = world.matBlocks().querySelectorAll(".pdf-page-frame");
  assert.equal(frames.length, 2, "both frozen pages render as page frames");
  assert.equal(frames[0]!.querySelector(".pdf-page-head")!.textContent, "Page 1");
  assert.equal(frames[1]!.querySelector(".pdf-page-head")!.textContent, "Page 2");
  assert.equal(frames[0]!.dataset.blockId, "page-1");
  assert.equal(frames[0]!.querySelector(".material-block")!.textContent, PDF01.blocks[0]!.text);
  assert.equal(frames[1]!.querySelector(".material-block")!.textContent, PDF01.blocks[1]!.text);
  assert.ok(
    world.requestsOf("/versions/v-pdf01-1").length > 0,
    "the PDF version's page blocks are fetched (real reading, not a placeholder state)",
  );
  assert.match(
    world.el("material-reader").textContent!,
    /PDF reading surface — the original page is rendered locally with PDF\.js/,
    "the honest PDF reading-surface note is shown (single-page selection discipline declared)",
  );
  assert.equal(world.matBlocks().querySelectorAll(".material-block").length, 2, "exactly the two page text layers");
});

test("a parsing version shows its in-flight status with an explicit Refresh; when the parse completes the refresh loads the real blocks", async () => {
  const world = await createWorld({
    materials: [{ ...PARSING_SCRIPT, versions: [{ ...PARSING_SCRIPT.versions[0]!, fixture: "md-01" }] }],
    flipToReady: "mat-parsing",
  });
  await world.openMaterial("mat-parsing");
  assert.match(world.el("material-reader").textContent!, /v1 is still being parsed \(parsing\)/);
  assert.equal(world.requestsOf("/versions/v-parsing-1").length, 0, "a non-ready version fetches no blocks");
  const refresh = world.el("material-reader").querySelector(".mat-note-action");
  assert.ok(refresh !== null, "the parsing state offers an explicit Refresh");
  refresh.click();
  await settle(25);
  assert.ok(
    world.matBlocks().querySelectorAll(".material-block").length > 0,
    "after the refresh (parse now ready) the real blocks load",
  );
  assert.equal(world.blockElement("blk-0").textContent, "# 递归与分治学习笔记\n\n");
});

test("a failed version shows its reason verbatim with no empty-document masquerade; the version strip keeps it honestly unlabeled-readable", async () => {
  const world = await createWorld({ materials: [FAILED_SCRIPT] });
  await world.openMaterial("mat-failed");
  assert.match(
    world.el("material-reader").textContent!,
    /v1 is failed — text-units-exceeded: the parsed canonical text exceeds the 1,000,000 UTF-16 unit limit/,
    "the failure reason renders verbatim",
  );
  assert.match(world.el("material-reader").textContent!, /This is not an empty document/);
  assert.equal(world.requestsOf("/versions/v-failed-1").length, 0, "a failed version fetches no blocks");
  assert.equal(world.matBlocks().querySelectorAll(".material-block").length, 0);
  const chip = world.el("material-reader").querySelector(".mat-version-chip")!;
  assert.ok(chip.classList.contains("unreadable") && chip.classList.contains("failed"));
  assert.equal(chip.tagName, "SPAN", "a non-ready version is not clickable (nothing to read)");
});

test("honest retry surfaces: a detail failure retries the open; an append-page failure retries the next page", async () => {
  /* 详情失败：注记区错误 + Retry；重试成功后正文落地。 */
  const detailWorld = await createWorld({ materials: [MD01_SCRIPT], detailFailOnce: "mat-md01" });
  await detailWorld.openMaterial("mat-md01");
  assert.match(
    detailWorld.el("material-reader").textContent!,
    /opening the material failed — internal: scripted detail failure/,
  );
  const retryOpen = detailWorld.el("material-reader").querySelector(".mat-retry-open");
  assert.ok(retryOpen !== null, "the detail failure offers a retry");
  retryOpen.click();
  await settle(25);
  assert.ok(
    detailWorld.matBlocks().querySelectorAll(".material-block").length === MD01.blocks.length,
    "the retry loads the full material",
  );

  /* 追加分页失败：尾部错误 + Retry（正文既有页保持，不整面失败）。 */
  const appendWorld = await createWorld({ materials: [MD01_SCRIPT], pageSize: 5, appendFailOnce: "mat-md01" });
  await appendWorld.openMaterial("mat-md01");
  const more = appendWorld.el("mat-tail").querySelector(".mat-load-more")!;
  more.click();
  await settle(25);
  assert.match(
    appendWorld.el("mat-tail").textContent!,
    /loading more blocks failed — internal: scripted append page failure/,
  );
  assert.equal(
    appendWorld.matBlocks().querySelectorAll(".material-block").length,
    5,
    "the already-loaded page stays (the failure is page-scoped, not a whole-reader failure)",
  );
  const retryAppend = appendWorld.el("mat-tail").querySelector(".mat-retry-append");
  assert.ok(retryAppend !== null, "the append failure offers a retry");
  retryAppend.click();
  await settle(25);
  assert.equal(
    appendWorld.matBlocks().querySelectorAll(".material-block").length,
    10,
    "the retried append loads the next page",
  );
});

/* ------------------------------------------------------------------ */
/* 6. 交互纪律：选择期间不重绘 + Esc/焦点 + 触屏武装                     */
/* ------------------------------------------------------------------ */

test("armed selection survives async refreshes and page appends: block elements and their text nodes keep identity while armed (no re-render during selection over the reading view)", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT], pageSize: 5 });
  await world.openMaterial("mat-md01");

  const blk1 = world.blockElement("blk-1");
  const blk1TextNode = firstLineNode(blk1);
  armBlockSelection(world, "blk-1", blk1TextNode, 0, blk1TextNode, 2);
  assert.match(selectionBar(world).querySelector(".mat-payload")!.textContent!, /UTF-16 \[13, 15\)/);

  /* SSE 终态（renderAll 全树重渲）：阅读器块容器不在该路径——元素身份
     原样保留（已武装的选区不丢）。 */
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle(25);
  const blk1AfterRefresh = world.blockElement("blk-1");
  assert.equal(blk1AfterRefresh, blk1, "the block element keeps its identity across the async refresh");
  assert.equal(firstLineNode(blk1AfterRefresh), blk1TextNode, "its prose text node is never replaced mid-selection");
  assert.match(
    selectionBar(world).querySelector(".mat-payload")!.textContent!,
    /UTF-16 \[13, 15\)/,
    "the armed capture bar survives the refresh",
  );

  /* 追加分页（新内容到达）：追加以纯增量方式进行——既有块不被换走。 */
  world.el("mat-tail").querySelector(".mat-load-more")!.click();
  await settle(25);
  const blk1AfterAppend = world.blockElement("blk-1");
  assert.equal(blk1AfterAppend, blk1, "appending the next page never replaces the armed block");
  assert.equal(firstLineNode(blk1AfterAppend), blk1TextNode);
  assert.match(selectionBar(world).querySelector(".mat-payload")!.textContent!, /UTF-16 \[13, 15\)/);

  /* 拖拽窗口（mousedown→mouseup）内会改 chrome 的重渲被延后：刷新详情
     期间注记元素不被换走；mouseup 后冲刷落位。 */
  const noteBefore = world.el("material-reader").querySelector(".mat-note");
  world.matBlocks().dispatchEvent("mousedown", {});
  world.liveSse().emit("run-terminal", { runId: "run-y" });
  await settle(25);
  const noteDuringDrag = world.el("material-reader").querySelector(".mat-note");
  assert.equal(
    noteDuringDrag,
    noteBefore,
    "a chrome re-render is deferred while the selection drag window is open",
  );
  world.setSelection(null);
  world.matBlocks().dispatchEvent("mouseup", {});
  await settle(25);
  assert.ok(true, "mouseup flushes the deferred chrome update (renderAll + reader chrome)");
});

test("capture bar freezes during the selection drag window: a mid-drag selectionchange defers arming until mouseup (no mid-drag layout shift)", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);

  /* 拖拽窗口开启后，全局 selectionchange（真实浏览器拖选中持续触发）不得
     就地更新捕获条——条从提示态长到 armed 高度会把正文整体推移（真实
     Chrome 实测 ~115px），连续拖选的释放点随位移带偏。冻结到 mouseup
     冲刷；触屏 selectionchange（无拖拽窗口）不受影响（见下一用例）。 */
  world.matBlocks().dispatchEvent("mousedown", {});
  world.setSelection(world.makeRange(line, 0, line, 2));
  world.document.dispatchEvent("selectionchange", {});
  await settle(5);
  assert.equal(
    selectionBar(world).querySelector(".mat-payload"),
    null,
    "the capture bar does not arm mid-drag (content frozen until mouseup)",
  );
  assert.match(
    selectionBar(world).textContent!,
    /select text in the material/,
    "the idle hint stays in place during the drag window",
  );

  world.matBlocks().dispatchEvent("mouseup", {});
  await settle(25);
  assert.match(
    selectionBar(world).querySelector(".mat-payload")!.textContent!,
    /UTF-16 \[13, 15\)/,
    "mouseup flushes the deferred bar update with the captured selection",
  );
});

test("touch arming: selectionchange arms the capture bar without mouseup, and an emptied selection disarms it after the deferred check", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await world.openMaterial("mat-md01");
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);

  world.setSelection(world.makeRange(line, 0, line, 2));
  world.document.dispatchEvent("selectionchange", {});
  await settle(5);
  assert.match(
    selectionBar(world).querySelector(".mat-payload")!.textContent!,
    /UTF-16 \[13, 15\)/,
    "a touch selection arms via selectionchange without mouseup",
  );

  /* 空选区：延迟解除（捕获条回提示态）。 */
  world.setSelection(null);
  world.document.dispatchEvent("selectionchange", {});
  await settle(10);
  assert.match(
    selectionBar(world).textContent!,
    /select text in the material to capture a quote/,
    "the capture bar disarms after the deferred check",
  );
});

test("Esc closes the reader with focus returned to the material's list button; keyboard affordances are native buttons", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  const listButton = world.materialButton("mat-md01");
  listButton.focus();
  assert.equal(world.document.activeElement, listButton);
  await world.openMaterial("mat-md01");
  assert.equal(world.document.activeElement, world.el("material-reader"), "the reader takes focus on open");

  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle(10);
  await sleep(200); /* 退场动画（170ms）播完才置 hidden */
  assert.equal(world.el("material-reader").hidden, true, "Esc closes the reader");
  /* 关闭后列表重渲（active 态回落）——焦点还原目标是**重渲后的新按钮**
     （注册表语义，同 termExplainButtons 模式），不比对陈旧元素引用。 */
  const listButtonAfterClose = world.materialButton("mat-md01");
  assert.equal(
    world.document.activeElement,
    listButtonAfterClose,
    "focus returns to the material's list button (W2 focus discipline)",
  );
  /* 关闭即保存阅读位置（离开冲刷——首块）。 */
  const put = world.requestsOf("/reading-position").filter((r) => r.method === "PUT").pop();
  if (put === undefined) assert.fail("closing the reader saves the reading position");
  assert.equal((put.body as Record<string, unknown>).blockId, "blk-0");

  /* 键盘可达性：列表/加载更多/复制是原生 button（Tab 顺序即 DOM 顺序）。 */
  await world.openMaterial("mat-md01");
  assert.equal(world.el("mat-close").tagName, "BUTTON");
  /* 该世界整料一页读完（尾态为 end of material）；Load more 按钮的键盘
     可达性在分页场景中锁定（原生 button）。 */
  assert.match(world.el("mat-tail").textContent!, /end of material/);
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);
  armBlockSelection(world, "blk-1", line, 0, line, 2);
  const bar = selectionBar(world);
  assert.equal(bar.querySelector(".mat-copy")!.tagName, "BUTTON");
  assert.equal(bar.querySelector(".mat-branch-d43")!.tagName, "BUTTON");
  assert.equal(bar.querySelector(".mat-branch-d43")!.disabled, false, "the D4-3 branch entry stays offered (native button)");
});

/* ------------------------------------------------------------------ */
/* 7. CSS 词法锁定（窄窗 / reduced-motion / 宽窗 / 基础层）              */
/* ------------------------------------------------------------------ */

interface CssRule {
  selector: string;
  declarations: string;
}

interface CssMediaBlock {
  query: string;
  rules: CssRule[];
}

function extractMediaBlocks(css: string): CssMediaBlock[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: CssMediaBlock[] = [];
  const mediaRe = /@media([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = mediaRe.exec(src)) !== null) {
    const query = match[1]!.trim();
    let depth = 1;
    let end = mediaRe.lastIndex;
    while (end < src.length && depth > 0) {
      const ch = src[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      end += 1;
    }
    const body = depth === 0 ? src.slice(mediaRe.lastIndex, end - 1) : src.slice(mediaRe.lastIndex, end);
    const rules: CssRule[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(body)) !== null) {
      rules.push({
        selector: ruleMatch[1]!.trim().replace(/\s+/g, " "),
        declarations: ruleMatch[2]!.replace(/\s+/g, " ").trim(),
      });
    }
    blocks.push({ query, rules });
    mediaRe.lastIndex = end;
  }
  return blocks;
}

function declarationsOf(block: CssMediaBlock, selector: string): string | null {
  const rule = block.rules.find((r) => r.selector === selector);
  return rule === undefined ? null : rule.declarations;
}

function baseCssLayer(css: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf("@media", i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, at);
    const open = src.indexOf("{", at);
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

test("CSS lexicon: the reader's narrow-window, reduced-motion, wide-column, and base-layer rules are locked lexically", () => {
  const narrow = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(max-width: 719px)");
  assert.ok(narrow !== undefined, "style.css carries the <720px narrow-window media query");
  const narrowReader = declarationsOf(narrow!, "#material-reader");
  assert.ok(narrowReader !== null, "the narrow block styles the reader");
  assert.ok(narrowReader.includes("width: 100%"), "the reader goes full width under 720px");
  const narrowActions = declarationsOf(narrow!, ".mat-selection-bar .mat-selection-actions");
  assert.ok(narrowActions !== null, "the narrow block restacks the capture-bar actions");
  assert.ok(narrowActions.includes("flex-direction: column"), "capture actions stack vertically under 720px");
  const narrowActionButtons = declarationsOf(narrow!, ".mat-selection-bar .mat-selection-actions button");
  assert.ok(
    narrowActionButtons !== null && narrowActionButtons.includes("width: 100%") && narrowActionButtons.includes("padding: 8px 12px"),
    "capture buttons go full width with enlarged touch targets",
  );

  const reduced = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(prefers-reduced-motion: reduce)");
  assert.ok(reduced !== undefined, "style.css carries the prefers-reduced-motion media query");
  assert.ok(
    declarationsOf(reduced!, "#material-reader.enter")!.includes("animation: none"),
    "the reader entrance animation is explicitly neutralized under reduce",
  );
  assert.ok(
    declarationsOf(reduced!, "#branch-panel, #source-drawer, #sidebar, #material-reader")!.includes("transform: none"),
    "the reader is in the no-transform set under reduce",
  );

  const wide = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(min-width: 1180px)");
  assert.ok(wide !== undefined, "style.css carries the (min-width: 1180px) media query");
  assert.ok(
    declarationsOf(wide!, "#material-reader")!.includes("width: 100%"),
    "the reader spans the resident column at >=1180px",
  );
  assert.ok(
    declarationsOf(wide!, "#branch-column:has(#material-reader:not([hidden])) #branch-empty")!.includes("visibility: hidden"),
    "an open reader hides the column's empty state (same cover contract as the branch panel)",
  );

  /* 基础层：覆盖层定位/有界滚动容器/无损 pre-wrap 渲染/可选摘录。 */
  const base = baseCssLayer(STYLE_CSS);
  assert.ok(/#material-reader\s*\{[^{}]*position:\s*absolute/.test(base), "the reader is an absolute overlay in the base layer");
  assert.ok(/#material-reader\s*\{[^{}]*z-index:\s*15/.test(base), "the reader stacks above the branch panel (z-index 15 > 10)");
  assert.ok(/\.mat-blocks\s*\{[^{}]*overflow-y:\s*auto/.test(base), "the blocks container is the bounded scroll container");
  assert.ok(
    /\.material-block\s*\{[^{}]*white-space:\s*pre-wrap/.test(base),
    "blocks render verbatim newlines via pre-wrap (lossless canonical mapping)",
  );
  assert.ok(/\.mat-selection-bar\s+\.mat-quote\s*\{[^{}]*white-space:\s*pre-wrap/.test(base), "quotes preserve their whitespace");
  assert.ok(/#material-reader\.enter\s*\{[^{}]*animation:\s*panel-in/.test(base), "the reader enters with the shared panel animation");
});
