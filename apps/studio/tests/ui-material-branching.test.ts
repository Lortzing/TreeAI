/**
 * D4-3 材料建枝闭环前端套件（issue #8 工作包 D4-3「原文探索闭环」的
 * 前端增量；charter §3.3 / ADR-004；消费已落地的四个 HTTP 端点——
 * branches/from-material、material-first-question、material-return、
 * branches/:branchId/material-new-exploration，服务
 * apps/studio/src/materials/branching.ts）。
 *
 * 方法与 ui-material-reader / ui-search 套件一致（issue #4 P1「证据工程
 * 化」的脚本化 DOM E2E）：以 file: URL 加载仓库真实 public/app.js 为
 * ES module（URL query 随机化绕过 ES 模块缓存——每个场景一份全新实
 * 例），运行在「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本
 * 化后端」之上：fetch / EventSource / localStorage / 计时器 / matchMedia /
 * getSelection / confirm / navigator.clipboard 全部为内存桩。正文事实取自
 * 冻结 fixture tests/fixtures/d4/b1-import/markdown/md-01.expected.json
 * （canonicalText / blocks 的仓库冻结真值——D4 契约 §6）。后端按场景脚本
 * 化，其行为镜像 apps/studio/tests/materials-branching.test.ts 锁定的服务
 * 端语义（幂等建枝/同键异选区 409、首问对账四态、恢复/另开、Return 幂等
 * 与来源卡、缺 session 前置条件）。无网络、无磁盘写入、无长等待，确定性
 * 可复现。本文件自包含（不依赖其他 UI 套件）。
 *
 * 覆盖（D4-3 前端交付面的逐项锁定）：
 *  1. 建枝入口（charter §3.3 规则一）：武装选区的捕获条给出可点击的
 *     「⑃ Branch from material」；点击先经 resolve-selection 把捕获载荷
 *     换成规范 MaterialSelection（服务端复核 + sourceHash 签发——阅读器
 *     窗口可能被裁剪，客户端绝不自行伪造 sourceHash），再 POST
 *     from-material {selection, intentKey, mode:"resume-or-create"}；
 *     建枝零 Run/Turn（无 POST /prompt、无 POST /switch——阅读与探索互
 *     不干扰），提交前材料范围声明完整呈现。
 *  2. 材料范围声明（规则三「UI 在提交前说明本次使用的材料范围」）：
 *     选区摘录 + 有界邻近块窗口（区间 + 覆盖块）+ 材料标题/版本 + 组合
 *     尺寸（N / 24,000 UTF-16 units）+ 组合文本全文（<details> 核对——与
 *     派发时逐字节相同）；截断场景显式 TRUNCATED 标记（truncationNote
 *     原文）；未截断如实「covers the whole material」。声明先于任何
 *     material-first-question 请求（首问是独立显式提交）。
 *  3. 幂等首问（规则四/五）：提交 → POST material-first-question
 *     {intentKey, firstQuestion}（同键）→ 面板打开新枝；双击不重发
 *     （在途锁——恰好一次请求）；同键重放（服务端 outcome null）如实注
 *     记不重复派发；dispatch failed 如实呈现 + 同键重试（显式新尝试）；
 *     dispatch unknown（在途对账不决）如实呈现且**不盲发**（无自动重试）；
 *     409 material-first-question-conflict（首问不可变）如实呈现并给出
 *     「改问走普通续聊」去向（面板打开 + composer 预填，发送是显式动作）。
 *  4. 恢复 vs 另开（规则五/六）：resume-or-create 命中恢复 → 明确二选
 *     （打开既有分支——不新建；显式另开——新键新枝）；挂起 intentKey 的
 *     刷新续走（恢复响应 + 已存键 + 零 turn → 直达声明面）；恢复的导航/
 *     会话可用性结果分离携带（failed/unavailable 如实注明）。
 *  5. 材料 Return（规则七）：材料分支的面板 Return 走 material-return
 *     （幂等键纪律与 Turn 来源共用）；主线 Return 卡渲染材料来源卡字段
 *     （材料标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump 原文跳
 *     转——targetAnchor null 是诚实事实，按确认时间放置）；原文跳转打开
 *     阅读器按版本+块定位（与搜索跳转同机制、不同的到达注记）；同键重放
 *     不重复；来源卡缓存缺失时如实注明（Return 完好，绝不伪造来源细节）。
 *  6. 缺 session 显式新探索（规则八）：材料分支的「⑃ Start new
 *     exploration」走 material-new-exploration（材料上下文随行；可见性/
 *     确认流与 Turn 来源分支一致）；session 可用时 409 如实呈现。
 *  7. 建枝意图冲突（同键不同选区 → 409 material-branch-conflict）：如实
 *     失败面 + 重试。
 *  8. CSS 词法锁定：建枝流程面/材料范围声明卡/截断标记/材料 Return 来源
 *     卡的基础层规则。
 *
 * 边界（如实声明）：同 ui-material-reader——不是真实浏览器 E2E；CSS 不执
 * 行，按词法锁定；HTTP 契约面（真实 node:http 服务）由
 * materials-branching.test.ts 覆盖，B3 真实 Pi 浏览器证据归 run:d4-browser
 * --mode real-pi（最终候选 SHA 回归）；本套件锁的是前端消费行为（请求形
 * 状/呈现/跳转/状态诚实/不重发纪律）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStudioCss } from "./support/styles.ts";

/* 加载真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const STYLE_CSS = readStudioCss(PUBLIC_DIR);

/* 冻结 fixture（B1 真值——正文与选区断言的唯一事实源）。 */
const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));

interface FixtureBlock {
  blockId: string;
  kind: "markdown-block";
  start: number;
  end: number;
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

const MD01 = loadFixture("md-01"); /* 递归与分治：14 块，1179 units */

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const ISO_LATER = "2026-09-29T01:00:00.000Z";

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
  origin: Record<string, unknown> | null;
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

type MaterialParseStatus = "pending" | "parsing" | "ready" | "failed" | "canceled" | "unsupported" | "rejected";

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

/** 阅读器/面板退场动画（170ms）收尾所需的短等待。 */
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

/* ------------------------------ 材料桩（fixture 驱动） ------------------------------ */

interface MaterialScript {
  id: string;
  title: string;
  versions: Array<{
    id: string;
    parserKind: "markdown" | "pdf";
    parseStatus: MaterialParseStatus;
    parseError?: string;
    fixture?: string;
  }>;
}

function buildStubMaterial(script: MaterialScript): StubMaterial & { fixtureId: string } {
  const versions: StubMaterialVersion[] = script.versions.map((version) => ({
    id: version.id,
    materialId: script.id,
    contentHash: `hash-${script.id}-${version.id}`,
    parserKind: version.parserKind,
    parserVersion: version.parserKind === "pdf" ? "d4-pdf-v1" : "d4-md-v1",
    importedAt: ISO,
    sizeBytes: 1024,
    parseStatus: version.parseStatus,
    parseError: version.parseError ?? null,
    textUnits: version.fixture !== undefined ? (loadFixture(version.fixture) as FixtureExpected).textUnits : 0,
  }));
  return {
    material: { id: script.id, title: script.title, createdAt: ISO },
    versions,
    readingPosition: null,
    fixtureId: script.versions.find((v) => v.fixture !== undefined)?.fixture ?? "",
  };
}

/* ------------------------------ D4-3 脚本后端模型 ------------------------------ */

/** 规范选区（from-material 请求体的 selection 形状）。 */
interface CanonicalSelection {
  materialId: string;
  versionId: string;
  blockId: string;
  start: number;
  end: number;
  excerpt: string;
  sourceHash: string;
}

function selectionIdentity(selection: CanonicalSelection): string {
  return `${selection.materialId}:${selection.versionId}:${selection.blockId}:${String(selection.start)}-${String(selection.end)}`;
}

/** 脚本世界的材料 Branch 记录（后端在库形态的镜像）。 */
interface MaterialBranchRecord {
  branchId: string;
  intentKey: string;
  selection: CanonicalSelection;
  materialTitle: string;
  createdAt: string;
  sessionAvailability: "available" | "unavailable";
  /** 首问派发结局脚本（按请求序消费；耗尽后默认 succeeded）。 */
  fqScript: Array<FqScriptKind>;
  /** 首问派发请求计数（不重发纪律的断言面）。 */
  fqRequests: number;
}

/**
 * 首问派发脚本结局：succeeded / failed / unknown（在途不决——不盲发）/
 * unknown-lands（在途不决**且**在途 run 事后完成——进程退出 mid-dispatch
 * 后 run 收敛成功、turn 已落库；客户端改问重试即触发 409 异问冲突）。
 */
type FqScriptKind = "succeeded" | "failed" | "unknown" | "unknown-lands";

/** 预置既有探索（恢复/另开场景）：初始树态 + 后端注册表各一份。 */
interface SeededExploration {
  materialId: string;
  versionId: string;
  blockId: string;
  start: number;
  end: number;
  excerpt: string;
  branchId: string;
  intentKey: string;
  hasTurns: boolean;
  sessionAvailability?: "available" | "unavailable";
  /** 恢复响应的导航脚本（默认 navigated）。 */
  restoreNavigation?: { status: "navigated" } | { status: "failed"; code: string; message: string };
  fqScript?: Array<FqScriptKind>;
}

/** 预置主线材料 Return turn（来源卡缓存缺失/在场的两态场景）。 */
interface SeededReturn {
  turnId: string;
  fromBranchId: string;
  text: string;
  idempotencyKey: string;
}

interface WorldOptions {
  materials?: MaterialScript[];
  explorations?: SeededExploration[];
  /** 预置主线材料 Return（初始树态即在场）。 */
  seededReturns?: SeededReturn[];
  /** 预置 localStorage（挂起 intent 键 / 来源卡缓存等）。 */
  seededStorage?: Record<string, string>;
  /** from-material 建枝的首问脚本（新建的分支）。 */
  fqScript?: Array<FqScriptKind>;
  /** 组合上下文的截断脚本（true → 有界窗 + 截断标记——上限命中的真值）。 */
  truncatedContext?: boolean;
  /** material-return 的回程导航脚本（默认 navigated）。 */
  returnNavigation?: "navigated" | "no-session";
}

let appLoadCounter = 0;

async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  const localStorageStore = new Map<string, string>(Object.entries(options.seededStorage ?? {}));
  let scriptedSelection: StubRange | null = null;
  let confirmResult = true;
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
    confirm: () => confirmResult,
  };

  /* ---- 初始树态：Trunk（一对问答）+ 预置材料分支（既有探索）。 ---- */
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const branches: BranchView[] = [
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
          text: "First trunk answer with several plain words.",
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
  ];
  const treeState: TreeState = {
    tree: { id: TREE, createdAt: ISO, forestId: "forest-1" },
    trunkBranchId: "trunk-1",
    branches,
    cursor: { treeId: TREE, branchId: "trunk-1", entryId: "pi-a1" },
  };

  const materials = (options.materials ?? []).map(buildStubMaterial);
  const records: MaterialBranchRecord[] = [];
  const intentBindings = new Map<string, { branchId: string; identity: string }>();
  const returnSubmissions = new Map<string, { turnId: string; fromBranchId: string; text: string }>();
  let branchSeq = 0;
  let turnSeq = 0;
  let returnSeq = 0;

  const fixtureOf = (materialId: string, versionId: string): FixtureExpected | null => {
    const entry = materials.find((m) => m.material.id === materialId);
    const version = entry?.versions.find((v) => v.id === versionId);
    /* 本套件语料统一钉在 md-01 冻结真值上（materials 脚本只引用 md-01）。 */
    return version === undefined ? null : MD01;
  };

  const branchViewOf = (branchId: string): BranchView | null =>
    branches.find((view) => view.branch.id === branchId) ?? null;

  const nextTurnId = (prefix: string): string => {
    turnSeq += 1;
    return `turn-${prefix}-${String(turnSeq)}`;
  };

  /** 组合上下文视图（脚本确定性——窗口默认整份材料；truncated 场景给有界窗）。 */
  const buildContext = (
    selection: CanonicalSelection,
    materialTitle: string,
    truncated: boolean,
  ): Record<string, unknown> => {
    const fixture = fixtureOf(selection.materialId, selection.versionId) ?? MD01;
    const window = truncated
      ? { start: 0, end: Math.min(400, fixture.canonicalText.length) }
      : { start: 0, end: fixture.canonicalText.length };
    const windowText = fixture.canonicalText.slice(window.start, window.end);
    const truncationNote = truncated
      ? `[Context truncated: the surrounding-material window shows units ${String(window.start)}–${String(window.end)} ` +
        `of ${String(fixture.canonicalText.length)}; the composed context is capped at 24000 UTF-16 units]`
      : null;
    const composed =
      `[Exploration context from material "${materialTitle}" — version ${selection.versionId} (markdown d4-md-v1)]\n` +
      `[Selected excerpt]: "${selection.excerpt}" (block ${selection.blockId}, units ${String(selection.start)}–` +
      `${String(selection.end)} of the version canonical text)\n[Surrounding material]:\n"${windowText}"` +
      (truncated ? `\n${String(truncationNote)}` : "") +
      "\n";
    const contextBlocks = fixture.blocks
      .filter((block) => block.start >= window.start && block.end <= window.end)
      .map((block) => ({ blockId: block.blockId, start: block.start, end: block.end }));
    return {
      materialId: selection.materialId,
      materialTitle,
      versionId: selection.versionId,
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      selection,
      window,
      contextBlocks,
      limitUnits: 24_000,
      composedUnits: composed.length,
      truncated,
      truncationNote,
      composed,
    };
  };

  /** 把材料 Branch 落进脚本树态（origin null——与真实服务同形状）。 */
  const registerBranchView = (record: MaterialBranchRecord, seededTurns: Turn[]): void => {
    branches.push({
      branch: {
        id: record.branchId,
        treeId: TREE,
        parentBranchId: "trunk-1",
        createdAt: record.createdAt,
      },
      origin: null,
      originStatus: null,
      sessionAvailability: record.sessionAvailability,
      turns: seededTurns,
      returnAttempts: [],
    });
  };

  /* 预置既有探索：注册表 + 树态（零 turn 或首问已落库两态）。 */
  for (const seeded of options.explorations ?? []) {    const selection: CanonicalSelection = {
      materialId: seeded.materialId,
      versionId: seeded.versionId,
      blockId: seeded.blockId,
      start: seeded.start,
      end: seeded.end,
      excerpt: seeded.excerpt,
      sourceHash: `sha256-${seeded.materialId}-${seeded.versionId}`,
    };
    const materialTitle =
      materials.find((m) => m.material.id === seeded.materialId)?.material.title ?? "材料";
    const record: MaterialBranchRecord = {
      branchId: seeded.branchId,
      intentKey: seeded.intentKey,
      selection,
      materialTitle,
      createdAt: ISO_LATER,
      sessionAvailability: seeded.sessionAvailability ?? "available",
      fqScript: [...(seeded.fqScript ?? [])],
      fqRequests: 0,
    };
    records.push(record);
    intentBindings.set(seeded.intentKey, { branchId: seeded.branchId, identity: selectionIdentity(selection) });
    const seededTurns: Turn[] = seeded.hasTurns
      ? [
          {
            id: `${seeded.branchId}-u1`,
            treeId: TREE,
            branchId: seeded.branchId,
            episodeId: `ep-${seeded.branchId}`,
            runId: `run-${seeded.branchId}-1`,
            role: "user",
            text: `[exploration from material ${seeded.versionId}]\n\n既有探索的首问`,
            piEntryId: `pi-${seeded.branchId}-u1`,
            fromBranchId: null,
            deliveredRunId: null,
            idempotencyKey: null,
            targetAnchor: null,
            createdAt: ISO_LATER,
          },
          {
            id: `${seeded.branchId}-a1`,
            treeId: TREE,
            branchId: seeded.branchId,
            episodeId: `ep-${seeded.branchId}`,
            runId: `run-${seeded.branchId}-1`,
            role: "assistant",
            text: "既有探索的首个回答。",
            piEntryId: `pi-${seeded.branchId}-a1`,
            fromBranchId: null,
            deliveredRunId: null,
            idempotencyKey: null,
            targetAnchor: null,
            createdAt: ISO_LATER,
          },
        ]
      : [];
    registerBranchView(record, seededTurns);
  }

  /* 预置主线材料 Return turn（初始树态即在场——来源卡缓存在场/缺失两态的
     主线渲染场景）。 */
  for (const seededReturn of options.seededReturns ?? []) {
    branches[0]!.turns.push({
      id: seededReturn.turnId,
      treeId: TREE,
      branchId: "trunk-1",
      episodeId: `ep-${seededReturn.turnId}`,
      runId: null,
      role: "return",
      text: seededReturn.text,
      piEntryId: null,
      fromBranchId: seededReturn.fromBranchId,
      deliveredRunId: null,
      idempotencyKey: seededReturn.idempotencyKey,
      targetAnchor: null,
      createdAt: ISO_LATER,
    });
    returnSubmissions.set(seededReturn.idempotencyKey, {
      turnId: seededReturn.turnId,
      fromBranchId: seededReturn.fromBranchId,
      text: seededReturn.text,
    });
  }

  const diagnostics: TreeDiagnostics = {
    treeId: TREE,
    runtimeState: "idle",
    activeRun: null,
    runs: [],
    policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
  };

  const backend = {
    treeState,
    diagnostics,
    requests: [] as RecordedRequest[],
    switchCount: 0,
    materials,
    records,
    restoreNavigationFor: new Map<string, NonNullable<SeededExploration["restoreNavigation"]>>(
      (options.explorations ?? [])
        .filter((e) => e.restoreNavigation !== undefined)
        .map((e) => [e.branchId, e.restoreNavigation!]),
    ),
    returnNavigation: options.returnNavigation ?? "navigated",
  };

  const fetchStub = async (input: string, init: StubFetchInit = {}): Promise<StubResponse> => {
    const method = init.method ?? "GET";
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    backend.requests.push({ method, path: String(input), body });
    const url = new URL(String(input), "http://studio.local");
    const p = url.pathname;
    const respond = (status: number, payload: unknown): StubResponse => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });

    /* ---- 材料面（D4 契约 §3 已落地形状 + D4-3 四端点的脚本镜像） ---- */
    if (p === "/api/trees" && method === "GET") {
      return respond(200, { trees: [{ id: TREE, createdAt: ISO, forestId: "forest-1" }] });
    }
    let m = /^\/api\/trees\/([^/]+)\/materials$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        materials: materials.map((entry) => ({ material: entry.material, versions: entry.versions })),
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const entry = materials.find((candidate) => candidate.material.id === m![2]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
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
      const entry = materials.find((candidate) => candidate.material.id === m![2]);
      const version = entry?.versions.find((candidate) => candidate.id === m![3]);
      if (entry === undefined || version === undefined) {
        return respond(404, { error: { code: "not-found", message: "unknown material/version" } });
      }
      if (version.parseStatus !== "ready") {
        return respond(409, {
          error: { code: "material-not-ready", message: `material version ${version.id} is not ready` },
        });
      }
      const source = fixtureOf(entry.material.id, version.id) ?? MD01;
      const slice = source.blocks.map((block) => ({
        block: { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end },
        text: block.text,
      }));
      return respond(200, { blocks: slice, nextAfterBlock: null, textUnits: source.textUnits });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/reading-position$/.exec(p);
    if (m !== null && method === "PUT") {
      return respond(204, null);
    }

    /* resolve-selection：服务端复核 + sourceHash 签发（D4-2 契约形状）。 */
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/resolve-selection$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "resolve-selection body must be an object");
      const locator = asRecord(record["locator"]);
      if (locator === null || locator["kind"] !== "utf16-range") {
        return respond(400, { error: { code: "invalid-locator", message: "locator must be utf16-range" } });
      }
      const start = locator["start"];
      const end = locator["end"];
      if (typeof start !== "number" || typeof end !== "number") {
        return respond(400, { error: { code: "invalid-locator", message: "start/end must be numbers" } });
      }
      const entry = materials.find((candidate) => candidate.material.id === m![2]);
      const version = entry?.versions.find((candidate) => candidate.id === m![3]);
      if (entry === undefined || version === undefined) {
        return respond(404, { error: { code: "not-found", message: "unknown material/version" } });
      }
      if (version.parseStatus !== "ready") {
        return respond(409, {
          error: { code: "material-not-ready", message: `material version ${version.id} is not ready` },
        });
      }
      const fixture = fixtureOf(entry.material.id, version.id) ?? MD01;
      const blockId = record["blockId"];
      const block =
        typeof blockId === "string" ? fixture.blocks.find((candidate) => candidate.blockId === blockId) : undefined;
      if (block === undefined) {
        return respond(400, { error: { code: "block-mismatch", message: "the blockId does not exist" } });
      }
      if (start < block.start || end > block.end || start >= end) {
        return respond(400, { error: { code: "out-of-bounds", message: "the range is outside the block" } });
      }
      const excerpt = record["excerpt"];
      if (excerpt !== fixture.canonicalText.slice(start, end)) {
        return respond(400, {
          error: { code: "excerpt-mismatch", message: "the excerpt does not equal the canonicalText slice" },
        });
      }
      const selection: CanonicalSelection = {
        materialId: entry.material.id,
        versionId: version.id,
        blockId: block.blockId,
        start,
        end,
        excerpt: String(excerpt),
        sourceHash: `sha256-${entry.material.id}-${version.id}`,
      };
      return respond(200, {
        selection,
        block: { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end },
      });
    }

    /* ---- D4-3 材料建枝区段（脚本镜像 materials-branching.test.ts 的语义） ---- */
    m = /^\/api\/trees\/([^/]+)\/branches\/from-material$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "from-material body must be an object");
      const selectionRecord = asRecord(record["selection"]);
      assert.ok(selectionRecord !== null, "from-material selection must be an object");
      const selection: CanonicalSelection = {
        materialId: String(selectionRecord["materialId"]),
        versionId: String(selectionRecord["versionId"]),
        blockId: String(selectionRecord["blockId"]),
        start: Number(selectionRecord["start"]),
        end: Number(selectionRecord["end"]),
        excerpt: String(selectionRecord["excerpt"]),
        sourceHash: String(selectionRecord["sourceHash"] ?? ""),
      };
      const intentKey = String(record["intentKey"] ?? "");
      const mode = record["mode"] === undefined ? "resume-or-create" : String(record["mode"]);
      const materialTitle =
        materials.find((candidate) => candidate.material.id === selection.materialId)?.material.title ?? "材料";
      const originOf = (branchId: string): Record<string, unknown> => ({
        branchId,
        treeId: m![1],
        selection,
        createdAt: ISO_LATER,
      });
      const contextOf = (): Record<string, unknown> => buildContext(selection, materialTitle, options.truncatedContext === true);
      /* 建枝意图绑定校验（服务端 createMaterialBranch 同纪律）：同键不同
         选区 → 409（一次逻辑提交不得静默换源）。 */
      const bound = intentBindings.get(intentKey);
      if (bound !== undefined && bound.identity !== selectionIdentity(selection)) {
        return respond(409, {
          error: {
            code: "material-branch-conflict",
            message:
              `material branching intent key '${intentKey}' is already bound to a branch from a different selection; ` +
              "an intent key identifies exactly one material branching submission — use a new key for a new selection",
          },
        });
      }
      if (mode === "new") {
        if (bound !== undefined) {
          const existing = records.find((candidate) => candidate.branchId === bound.branchId)!;
          return respond(200, {
            mode: "created",
            branch: branchViewOf(existing.branchId)!.branch,
            origin: originOf(existing.branchId),
            context: contextOf(),
            created: false,
            navigation: null,
            sessionAvailability: null,
            state: treeState,
          });
        }
        branchSeq += 1;
        const recordNew: MaterialBranchRecord = {
          branchId: `branch-mat-${String(branchSeq)}`,
          intentKey,
          selection,
          materialTitle,
          createdAt: ISO_LATER,
          sessionAvailability: "available",
          fqScript: [...(options.fqScript ?? [])],
          fqRequests: 0,
        };
        records.push(recordNew);
        intentBindings.set(intentKey, { branchId: recordNew.branchId, identity: selectionIdentity(selection) });
        registerBranchView(recordNew, []);
        return respond(201, {
          mode: "created",
          branch: branchViewOf(recordNew.branchId)!.branch,
          origin: originOf(recordNew.branchId),
          context: contextOf(),
          created: true,
          navigation: null,
          sessionAvailability: null,
          state: treeState,
        });
      }
      /* resume-or-create：同来源已有探索 → 恢复；无 → 按 intentKey 新建。 */
      const identity = selectionIdentity(selection);
      const existing = [...records].reverse().find((candidate) => selectionIdentity(candidate.selection) === identity);
      if (existing !== undefined) {
        const navigation = backend.restoreNavigationFor.get(existing.branchId) ?? { status: "navigated" };
        return respond(200, {
          mode: "restored",
          branch: branchViewOf(existing.branchId)!.branch,
          origin: originOf(existing.branchId),
          context: contextOf(),
          created: false,
          navigation,
          sessionAvailability: branchViewOf(existing.branchId)!.sessionAvailability,
          state: treeState,
        });
      }
      branchSeq += 1;
      const recordNew: MaterialBranchRecord = {
        branchId: `branch-mat-${String(branchSeq)}`,
        intentKey,
        selection,
        materialTitle,
        createdAt: ISO_LATER,
        sessionAvailability: "available",
        fqScript: [...(options.fqScript ?? [])],
        fqRequests: 0,
      };
      records.push(recordNew);
      intentBindings.set(intentKey, { branchId: recordNew.branchId, identity: selectionIdentity(selection) });
      registerBranchView(recordNew, []);
      return respond(201, {
        mode: "created",
        branch: branchViewOf(recordNew.branchId)!.branch,
        origin: originOf(recordNew.branchId),
        context: contextOf(),
        created: true,
        navigation: null,
        sessionAvailability: null,
        state: treeState,
      });
    }

    /* material-first-question：先对账后行动（幂等重放 / 异问 409 / unknown /
       failed / 派发——脚本按 fqScript 序消费）。 */
    m = /^\/api\/trees\/([^/]+)\/material-first-question$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "material-first-question body must be an object");
      const intentKey = String(record["intentKey"] ?? "");
      const firstQuestion = String(record["firstQuestion"] ?? "");
      const bound = intentBindings.get(intentKey);
      if (bound === undefined) {
        return respond(400, {
          error: {
            code: "invalid-argument",
            message: `material first-question intent key '${intentKey}' is not registered; create the branch first`,
          },
        });
      }
      const branchRecord = records.find((candidate) => candidate.branchId === bound.branchId)!;
      const view = branchViewOf(branchRecord.branchId)!;
      branchRecord.fqRequests += 1;
      const prefix = `[exploration from material ${branchRecord.selection.versionId}]`;
      const expectedTurnText = `${prefix}\n\n${firstQuestion}`;
      const landed = view.turns.find((turn) => turn.role === "user" && turn.text.startsWith(prefix));
      if (landed !== undefined && landed.text !== expectedTurnText) {
        return respond(409, {
          error: {
            code: "material-first-question-conflict",
            message:
              `the first question on material branch ${branchRecord.branchId} was already dispatched with different content; ` +
              "the first question is immutable for this branch — ask the changed question as a normal continuation instead",
          },
        });
      }
      if (landed !== undefined) {
        return respond(200, {
          branch: view.branch,
          dispatch: "succeeded",
          outcome: null,
          error: null,
          landed: { runId: landed.runId, userTurnId: landed.id, assistantTurnId: null },
          state: treeState,
        });
      }
      const outcomeKind = branchRecord.fqScript.length > 0 ? branchRecord.fqScript.shift()! : "succeeded";
      if (outcomeKind === "unknown" || outcomeKind === "unknown-lands") {
        if (outcomeKind === "unknown-lands") {
          /* 在途 run 事后完成：turn 已落库（客户端不可见）——改问重试将触发
             409 异问冲突（服务端对账证据一优先）。 */
          const runId = `run-${branchRecord.branchId}-landed`;
          view.turns.push(
            {
              id: nextTurnId("mfq-u"),
              treeId: TREE,
              branchId: branchRecord.branchId,
              episodeId: `ep-${branchRecord.branchId}`,
              runId,
              role: "user",
              text: expectedTurnText,
              piEntryId: `pi-${runId}-u`,
              fromBranchId: null,
              deliveredRunId: null,
              idempotencyKey: null,
              targetAnchor: null,
              createdAt: ISO_LATER,
            },
            {
              id: nextTurnId("mfq-a"),
              treeId: TREE,
              branchId: branchRecord.branchId,
              episodeId: `ep-${branchRecord.branchId}`,
              runId,
              role: "assistant",
              text: `（echo 回答）事后完成的在途派发。`,
              piEntryId: `pi-${runId}-a`,
              fromBranchId: null,
              deliveredRunId: null,
              idempotencyKey: null,
              targetAnchor: null,
              createdAt: ISO_LATER,
            },
          );
        }
        return respond(200, {
          branch: view.branch,
          dispatch: "unknown",
          outcome: null,
          error: {
            code: "dispatch-unknown",
            message:
              `the first question for material branch ${branchRecord.branchId} was dispatched but never reached a ` +
              "terminal state; it was NOT re-sent — reconcile the branch's runs, then retry",
          },
          landed: null,
          state: treeState,
        });
      }
      if (outcomeKind === "failed") {
        return respond(200, {
          branch: view.branch,
          dispatch: "failed",
          outcome: null,
          error: { code: "upstream", message: "the echo upstream refused the scripted dispatch" },
          landed: null,
          state: treeState,
        });
      }
      const runId = `run-${branchRecord.branchId}-${String(view.turns.length + 1)}`;
      const userTurn: Turn = {
        id: nextTurnId("mfq-u"),
        treeId: TREE,
        branchId: branchRecord.branchId,
        episodeId: `ep-${branchRecord.branchId}`,
        runId,
        role: "user",
        text: expectedTurnText,
        piEntryId: `pi-${runId}-u`,
        fromBranchId: null,
        deliveredRunId: null,
        idempotencyKey: null,
        targetAnchor: null,
        createdAt: ISO_LATER,
      };
      const assistantTurn: Turn = {
        id: nextTurnId("mfq-a"),
        treeId: TREE,
        branchId: branchRecord.branchId,
        episodeId: `ep-${branchRecord.branchId}`,
        runId,
        role: "assistant",
        text: `（echo 回答）关于「${firstQuestion}」：结合选区材料作答。`,
        piEntryId: `pi-${runId}-a`,
        fromBranchId: null,
        deliveredRunId: null,
        idempotencyKey: null,
        targetAnchor: null,
        createdAt: ISO_LATER,
      };
      view.turns.push(userTurn, assistantTurn);
      return respond(200, {
        branch: view.branch,
        dispatch: "succeeded",
        outcome: { run: { id: runId, state: "succeeded" }, userTurn, assistantTurn },
        error: null,
        landed: { runId, userTurnId: userTurn.id, assistantTurnId: assistantTurn.id },
        state: treeState,
      });
    }

    /* material-return：幂等（同键同容 200 重放 / 同键异容 409）+ 来源卡。 */
    m = /^\/api\/trees\/([^/]+)\/material-return$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "material-return body must be an object");
      const fromBranchId = String(record["fromBranchId"] ?? "");
      const text = String(record["text"] ?? "");
      const idempotencyKey = String(record["idempotencyKey"] ?? "");
      const branchRecord = records.find((candidate) => candidate.branchId === fromBranchId);
      if (branchRecord === undefined) {
        return respond(400, {
          error: {
            code: "invalid-argument",
            message: `branch ${fromBranchId} is not a material branch; use the standard return endpoint`,
          },
        });
      }
      const replay = returnSubmissions.get(idempotencyKey);
      if (replay !== undefined) {
        if (replay.text !== text || replay.fromBranchId !== fromBranchId) {
          return respond(409, {
            error: {
              code: "return-conflict",
              message:
                "Return conflict: this draft's idempotency key is already bound to a different Return; " +
                "edit the text to submit it as a new Return",
            },
          });
        }
        const replayTurn = branchViewOf("trunk-1")!.turns.find((turn) => turn.id === replay.turnId)!;
        return respond(200, {
          returnTurn: replayTurn,
          created: false,
          navigation: { status: backend.returnNavigation },
          card: materialCardOf(replayTurn, branchRecord),
          state: treeState,
        });
      }
      returnSeq += 1;
      const returnTurn: Turn = {
        id: `turn-ret-${String(returnSeq)}`,
        treeId: TREE,
        branchId: "trunk-1",
        episodeId: `ep-ret-${String(returnSeq)}`,
        runId: null,
        role: "return",
        text,
        piEntryId: null,
        fromBranchId,
        deliveredRunId: null,
        idempotencyKey,
        targetAnchor: null,
        createdAt: ISO_LATER,
      };
      branchViewOf("trunk-1")!.turns.push(returnTurn);
      returnSubmissions.set(idempotencyKey, { turnId: returnTurn.id, fromBranchId, text });
      return respond(201, {
        returnTurn,
        created: true,
        navigation: { status: backend.returnNavigation },
        card: materialCardOf(returnTurn, branchRecord),
        state: treeState,
      });
    }

    /** 来源卡（材料标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump）。 */
    function materialCardOf(
      turn: Turn,
      branchRecord: MaterialBranchRecord,
    ): Record<string, unknown> {
      return {
        materialId: branchRecord.selection.materialId,
        materialTitle: branchRecord.materialTitle,
        versionId: branchRecord.selection.versionId,
        parserKind: "markdown",
        parserVersion: "d4-md-v1",
        blockId: branchRecord.selection.blockId,
        page: null,
        excerpt: branchRecord.selection.excerpt,
        sourceJump: { ...branchRecord.selection },
        confirmTime: turn.createdAt,
        adoption: { attempts: 0, deliveredRunId: null, status: "saved" },
      };
    }

    /* material-new-exploration：前置条件（session 不可用才成立）+ 材料上下文随行。 */
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/material-new-exploration$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "material-new-exploration body must be an object");
      const branchId = decodeURIComponent(m![2]!);
      const branchRecord = records.find((candidate) => candidate.branchId === branchId);
      if (branchRecord === undefined) {
        return respond(400, {
          error: { code: "invalid-argument", message: `branch ${branchId} is not a material branch` },
        });
      }
      const view = branchViewOf(branchId)!;
      if (view.sessionAvailability === "available") {
        return respond(409, {
          error: {
            code: "new-exploration-conflict",
            message:
              "the session at this branch's continuation point is still available — continue normally instead " +
              "(a new exploration is only offered when the session cannot continue)",
          },
        });
      }
      const runId = `run-${branchId}-new-${String(view.turns.length + 1)}`;
      const userTurn: Turn = {
        id: nextTurnId("mne-u"),
        treeId: TREE,
        branchId,
        episodeId: `ep-${branchId}`,
        runId,
        role: "user",
        text: `[new exploration from saved content]\n\n${String(record["text"] ?? "")}`,
        piEntryId: `pi-${runId}-u`,
        fromBranchId: null,
        deliveredRunId: null,
        idempotencyKey: null,
        targetAnchor: null,
        createdAt: ISO_LATER,
      };
      const assistantTurn: Turn = {
        id: nextTurnId("mne-a"),
        treeId: TREE,
        branchId,
        episodeId: `ep-${branchId}`,
        runId,
        role: "assistant",
        text: "（echo 回答）新探索会话中基于保存内容与材料上下文的回答。",
        piEntryId: `pi-${runId}-a`,
        fromBranchId: null,
        deliveredRunId: null,
        idempotencyKey: null,
        targetAnchor: null,
        createdAt: ISO_LATER,
      };
      view.turns.push(userTurn, assistantTurn);
      view.sessionAvailability = "available";
      return respond(200, {
        outcome: { run: { id: runId, state: "succeeded" }, userTurn, assistantTurn },
        state: treeState,
      });
    }

    /* ---- 既有树面（boot/渲染/Return 收尾所需的最小路由） ---- */
    if (p === "/api/trees" && method === "POST") {
      return respond(201, { tree: treeState.tree, trunkBranchId: "trunk-1", state: treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, treeState);
    }
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, { ...diagnostics, treeId: m[1]! });
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
    m = /^\/api\/trees\/([^/]+)\/return$/.exec(p);
    if (m !== null && method === "POST") {
      return respond(400, {
        error: { code: "invalid-argument", message: "this stub expects material branches to use /material-return" },
      });
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
    value: { clipboard: { writeText: async (): Promise<void> => {} } },
    configurable: true,
    writable: true,
  });

  appLoadCounter += 1;
  await import(new URL(`../public/app.js?load=${appLoadCounter}`, import.meta.url).href);
  await settle(25);

  const world: World = {
    document: documentStub,
    backend,
    localStorageStore,
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
    setConfirm: (value) => {
      confirmResult = value;
    },
    branchFlow: () => {
      const flow = documentStub.getElementById("mat-branch-flow");
      assert.ok(flow !== null, "#mat-branch-flow missing (branching flow not rendered?)");
      return flow;
    },
    branchTab: (branchId) => {
      const tab = documentStub
        .getElementById("branch-tabs")
        ?.querySelectorAll("button")
        .find((b) => b.dataset.branchId === branchId);
      assert.ok(tab !== undefined, `missing branch tab for ${branchId}`);
      return tab;
    },
  };
  return world;
}

/** 世界面（场景辅助的契约）。 */
interface World {
  readonly document: StubDocument;
  readonly backend: {
    treeState: TreeState;
    diagnostics: TreeDiagnostics;
    requests: RecordedRequest[];
    switchCount: number;
    materials: Array<ReturnType<typeof buildStubMaterial>>;
    records: MaterialBranchRecord[];
    restoreNavigationFor: Map<string, { status: "navigated" } | { status: "failed"; code: string; message: string }>;
    returnNavigation: "navigated" | "no-session";
  };
  readonly localStorageStore: Map<string, string>;
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
  setConfirm(value: boolean): void;
  branchFlow(): StubElement;
  branchTab(branchId: string): StubElement;
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

function firstLineNode(block: StubElement): StubText {
  const nodes = collectTextNodes(block);
  assert.ok(nodes.length > 0, `block ${String(block.dataset.blockId)} has no text nodes`);
  return nodes[0]!;
}

/** 武装 blk-1 的「递归」第一处选区（canonical [13, 15)——md-01 冻结真值）。 */
async function armRecursionSelection(world: World): Promise<{ materialId: string; versionId: string; blockId: string; start: number; end: number; excerpt: string }> {
  await world.openMaterial("mat-md01");
  const block = world.blockElement("blk-1");
  const line = firstLineNode(block);
  world.setSelection(world.makeRange(line, 0, line, 2));
  world.matBlocks().dispatchEvent("mouseup", {});
  return { materialId: "mat-md01", versionId: "v-md01-1", blockId: "blk-1", start: 13, end: 15, excerpt: "递归" };
}

/** 捕获条。 */
function selectionBar(world: World): StubElement {
  const bar = world.byId("mat-selection-bar");
  assert.ok(bar !== null, "selection bar missing");
  return bar;
}

/** 点击捕获条的建枝按钮并等流程面落定。 */
async function clickBranchButton(world: World): Promise<void> {
  const bar = selectionBar(world);
  const branch = bar.querySelector(".mat-branch-d43");
  assert.ok(branch !== null, "branch button missing on the armed bar");
  branch.click();
  await settle(25);
}

/** 在首问输入框键入问题（值 + input 事件——draft 状态同步走真实路径）。 */
function typeFirstQuestion(world: World, text: string): void {
  const input = world.byId("mat-branch-first-question");
  assert.ok(input !== null, "first-question input missing (declared phase not rendered?)");
  input.value = text;
  input.dispatchEvent("input", {});
}

/** 点击首问提交按钮。 */
function clickSubmitFirstQuestion(world: World): void {
  const flow = world.branchFlow();
  const submit = flow.querySelector(".mat-branch-submit");
  assert.ok(submit !== null, "submit-first-question button missing");
  submit.click();
}

const MD01_SCRIPT: MaterialScript = {
  id: "mat-md01",
  title: "递归与分治学习笔记.md",
  versions: [{ id: "v-md01-1", parserKind: "markdown", parseStatus: "ready", fixture: "md-01" }],
};

/** 既有探索（恢复场景的预置材料分支）。 */
function seededExploration(overrides: Partial<SeededExploration> = {}): SeededExploration {
  return {
    materialId: "mat-md01",
    versionId: "v-md01-1",
    blockId: "blk-1",
    start: 13,
    end: 15,
    excerpt: "递归",
    branchId: "branch-seed-1",
    intentKey: "seed-intent-1",
    hasTurns: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 建枝入口：捕获条 → resolve-selection → from-material（零 Run/Turn） */
/* ------------------------------------------------------------------ */

test("branch entry: the armed capture bar offers branching; the click resolves the canonical selection (server-signed sourceHash) then posts from-material — zero runs/turns, no cursor switch", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  const selection = await armRecursionSelection(world);

  /* 捕获条：可点击的建枝入口（不再是「随 D4-3 落地」的占位）。 */
  const bar = selectionBar(world);
  const branchButton = bar.querySelector(".mat-branch-d43")!;
  assert.equal(branchButton.disabled, false, "the branch entry is offered (enabled) on the armed bar");
  assert.match(branchButton.textContent!, /Branch from material/);

  await clickBranchButton(world);

  /* 步骤一：resolve-selection 携带捕获载荷（utf16-range + excerpt + blockId）——
     客户端不自行伪造 sourceHash。 */
  const resolve = world.lastRequest("/resolve-selection")!;
  assert.ok(resolve !== null, "the click resolves the selection first");
  assert.deepEqual(resolve.body, {
    locator: { kind: "utf16-range", start: selection.start, end: selection.end },
    excerpt: selection.excerpt,
    blockId: selection.blockId,
  });

  /* 步骤二：from-material 携带规范选区（含服务端签发的 sourceHash）+ 新
     intentKey + mode resume-or-create。 */
  const fromMaterial = world.lastRequest("/branches/from-material")!;
  assert.ok(fromMaterial !== null, "the click posts from-material");
  const body = fromMaterial.body as Record<string, unknown>;
  assert.deepEqual(body["selection"], {
    ...selection,
    sourceHash: `sha256-mat-md01-v-md01-1`,
  });
  assert.equal(body["mode"], "resume-or-create");
  const intentKey = String(body["intentKey"]);
  assert.match(intentKey, /.+/, "the intent key is a fresh submission identity");
  assert.notEqual(intentKey, "");

  /* 建枝零 Run/Turn：无 prompt、无 /switch（阅读与探索互不干扰）；本源
     首次建枝 → 201 created 已被流程面消费（声明面在测试 2 锁定）。 */
  assert.equal(world.requestsOf("/prompt").length, 0, "branching dispatches nothing");
  assert.equal(world.requestsOf("/switch").length, 0, "branching never aligns the conversation cursor");
  assert.equal(world.requestsOf("/material-first-question").length, 0, "the first question is a separate explicit submit");
  assert.equal(world.requestsOf("/material-return").length, 0, "no return is submitted");
  const flow = world.branchFlow();
  assert.match(flow.textContent!, /Material scope for this exploration/, "the declared phase renders the scope card");
  assert.match(
    flow.textContent!,
    /zero runs\/turns/,
    "the zero-dispatch discipline is stated before the first question",
  );
});

/* ------------------------------------------------------------------ */
/* 2. 材料范围声明（提交前）：窗口/块/上限/截断标记/组合文本核对          */
/* ------------------------------------------------------------------ */

test("context declaration: the scope card shows the exact selection, the bounded window, covered blocks, and the composed size — before any first-question request; the whole-material case states nothing is omitted", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  const selection = await armRecursionSelection(world);
  await clickBranchButton(world);

  const flow = world.branchFlow();
  const card = flow.querySelector(".mat-branch-context")!;
  const text = card.textContent!;

  /* 标题/版本/选区摘录（完整引用）。 */
  assert.match(text, /递归与分治学习笔记\.md/);
  assert.match(text, new RegExp(`version ${selection.versionId} \\(markdown d4-md-v1\\)`));
  assert.match(text, new RegExp(`selected excerpt: block ${selection.blockId}, UTF-16 \\[13, 15\\)`));
  const quote = card.querySelector(".mat-branch-excerpt")!;
  assert.equal(quote.textContent, "递归", "the excerpt is quoted in full");

  /* 窗口 + 覆盖块 + 组合尺寸（脚本语境料 = 整份材料 → 未截断）。 */
  assert.match(text, new RegExp(`window: UTF-16 \\[0, ${String(MD01.canonicalText.length)}\\)`));
  assert.match(text, /blocks fully covered: blk-0, blk-1/);
  assert.match(text, /composed context: \d+ \/ 24000 UTF-16 units/);
  assert.match(text, /the window covers the whole material — nothing is omitted/);

  /* 组合文本全文可核对（<details>——与派发时逐字节相同）。 */
  const details = card.querySelector(".mat-branch-composed")!;
  const composed = details.querySelector("pre")!.textContent!;
  assert.ok(composed.includes("[Exploration context from material \"递归与分治学习笔记.md\""));
  assert.ok(composed.includes("[Selected excerpt]: \"递归\""));
  assert.ok(composed.includes(MD01.blocks[0]!.text.slice(0, 20)), "the window text enters the composed context");

  /* 声明先于首问提交（零 material-first-question 请求）。 */
  assert.equal(world.requestsOf("/material-first-question").length, 0);
});

test("context declaration: a truncated window carries the explicit TRUNCATED marker with the truncation note verbatim — the 24,000-unit cap is never silent (charter §3.3 rule 3)", async () => {
  /* 截断真值：脚本 from-material 的 context 以有界窗构造（truncated:true +
   * truncationNote——上限命中的服务端事实；窗口/标记/组合文本同一份）。 */
  const world = await createWorld({ materials: [MD01_SCRIPT], truncatedContext: true });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  const flow = world.branchFlow();
  const card = flow.querySelector(".mat-branch-context")!;
  const marker = card.querySelector(".mat-branch-truncated")!;
  assert.ok(marker !== null, "an explicit truncation marker is rendered");
  assert.match(marker.textContent!, /^TRUNCATED — \[Context truncated: /);
  assert.match(
    marker.textContent!,
    /the composed context is capped at 24000 UTF-16 units\]$/,
    "the truncation note is shown verbatim (the same text enters the model input)",
  );
  /* 有界窗：窗口区间显式呈现在范围行（非整份材料）。 */
  const scopeText = card.textContent!;
  assert.match(scopeText, new RegExp(`window: UTF-16 \\[0, 400\\) of the version canonical text`));
  assert.ok(!scopeText.includes("nothing is omitted"), "the whole-material note is not fabricated for a truncated window");
  /* 组合文本预览携带同一段截断标记（UI 预览与模型输入两处同一份）。 */
  const composed = card.querySelector(".mat-branch-composed")!.querySelector("pre")!.textContent!;
  assert.ok(composed.includes("[Context truncated:"), "the marker is part of the composed text");
  /* 截断不吞选区：摘录完整在场。 */
  assert.equal(card.querySelector(".mat-branch-excerpt")!.textContent, "递归");
});

/* ------------------------------------------------------------------ */
/* 3. 首问：提交 → 面板打开；双击不重发；unknown 不盲发；failed 可重试     */
/* ------------------------------------------------------------------ */

test("first question: submitting posts material-first-question with the same intent key, lands the turns, closes the reader, and opens the branch panel", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  typeFirstQuestion(world, "这段材料里的递归终止条件是什么？");
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200); /* 阅读器退场动画（170ms）收尾后才置 hidden */

  /* 请求形状：同键 + 问题原文。 */
  const fq = world.lastRequest("/material-first-question")!;
  const fromMaterial = world.requestsOf("/branches/from-material")[0]!;
  assert.deepEqual(fq.body, {
    intentKey: (fromMaterial.body as Record<string, unknown>)["intentKey"],
    firstQuestion: "这段材料里的递归终止条件是什么？",
  });

  /* 面板打开新枝：面板可见、标题为该分支、面板会话含首问 turn（可审计
     前缀 + 问题原文）与回答；焦点进面板 composer。 */
  assert.equal(world.el("material-reader").hidden, true, "the reader closed after the first question landed");
  const panel = world.el("branch-panel");
  assert.equal(panel.hidden, false, "the branch panel opened at the new branch");
  const conversation = world.el("panel-conversation").textContent!;
  assert.match(conversation, /\[exploration from material v-md01-1\]/, "the audited turn prefix is rendered");
  assert.match(conversation, /这段材料里的递归终止条件是什么？/);
  assert.match(conversation, /（echo 回答）/);
  assert.equal(world.el("panel-title").textContent, "Branch 1");

  /* 面板头部：材料来源上下文（缓存自建枝响应）。 */
  const anchor = world.el("panel-anchor-context").textContent!;
  assert.match(anchor, /From material “递归与分治学习笔记\.md”/);
  assert.match(anchor, /“递归”/);
  assert.match(anchor, /material source/);

  /* 挂起 intent 已清除（逻辑提交完成）；建枝零派发面在关闭前已呈现。 */
  const pendingKeys = [...world.localStorageStore.keys()].filter((key) => key.startsWith("treeai-material-intent:"));
  assert.deepEqual(pendingKeys, [], "the pending intent key is cleared once the first question lands");
});

test("no-duplicate discipline: a double-click submits exactly once (in-flight lock); a replay (same key, same content) reconciles without re-sending", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  typeFirstQuestion(world, "幂等首问");
  /* 双击（同一同步块内两次 click——第二次撞上 guard 的 busy 锁）。 */
  clickSubmitFirstQuestion(world);
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200);

  const requests = world.requestsOf("/material-first-question");
  assert.equal(requests.length, 1, "exactly one material-first-question request fires for a double-click");
  assert.deepEqual(
    requests[0]!.body,
    { intentKey: (world.requestsOf("/branches/from-material")[0]!.body as Record<string, unknown>)["intentKey"], firstQuestion: "幂等首问" },
  );
  assert.equal(world.el("branch-panel").hidden, false, "the panel opened once");

  /* 面板 composer 上的普通续聊不触碰首问端点（改问走 prompt——由 409 测
     试锁定路径；此处锁定首问端点不被再次调用）。 */
  assert.equal(world.requestsOf("/material-first-question").length, 1);
});

test("dispatch outcomes: 'failed' is shown honestly and a same-key retry is an explicit new attempt; 'unknown' is never auto-retried and is disclosed as not re-sent", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    fqScript: ["failed", "unknown", "succeeded"],
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  /* 第一次提交：明确失败（服务端 200 dispatch:"failed"——数据不是传输错
     误）。流程面保留 + 诚实呈现。 */
  typeFirstQuestion(world, "第一次提交");
  clickSubmitFirstQuestion(world);
  await settle(25);
  let flow = world.branchFlow();
  assert.match(flow.textContent!, /dispatch failed — upstream: /, "the failed dispatch is disclosed");
  assert.match(flow.textContent!, /retry with the same key is an explicit new attempt/);
  assert.equal(world.el("material-reader").hidden, false, "the flow stays in the reader after a failure");

  /* 重试（同键显式新尝试）→ 脚本给 unknown：如实呈现「未重发」。 */
  clickSubmitFirstQuestion(world);
  await settle(25);
  flow = world.branchFlow();
  assert.match(flow.textContent!, /never reached a terminal state/, "the unknown outcome is disclosed");
  assert.match(flow.textContent!, /was NOT re-sent/, "the no-blind-send discipline is stated");
  const afterUnknown = world.requestsOf("/material-first-question").length;
  await settle(15);
  assert.equal(
    world.requestsOf("/material-first-question").length,
    afterUnknown,
    "the unknown outcome is never auto-retried",
  );

  /* 第三次显式提交 → succeeded：流程收面、面板打开。 */
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, false, "the retry succeeded and the panel opened");
  assert.equal(world.requestsOf("/material-first-question").length, 3);
});

/* ------------------------------------------------------------------ */
/* 4. 恢复 vs 另开（charter 规则五/六）                                   */
/* ------------------------------------------------------------------ */

test("resume-or-create hits an existing exploration: the honest choice — open the existing branch (nothing new is created) or explicitly start a new one (fresh key, new branch)", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: true })],
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  /* 恢复响应 → 二选面（既有分支信息 + 两个明确去向）。 */
  let flow = world.branchFlow();
  assert.match(flow.textContent!, /already has an exploration in this tree/);
  const resume = flow.querySelector(".mat-branch-resume")!;
  const fresh = flow.querySelector(".mat-branch-new")!;
  assert.ok(resume !== null && fresh !== null, "both explicit choices are offered");

  /* 路径 A（独立世界验证避免顺序耦合）：打开既有探索——不新建、面板对准
     既有分支。此处直接点击 resume。 */
  resume.click();
  await settle(25);
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, false);
  assert.equal(world.el("panel-title").textContent, "Branch 1");
  const conversation = world.el("panel-conversation").textContent!;
  assert.match(conversation, /既有探索的首问/, "the existing branch's saved history is readable in the panel");
  assert.match(conversation, /既有探索的首个回答/);
  /* 恢复路径不新建（from-material 只有一次——resume-or-create 恢复）。 */
  assert.equal(world.requestsOf("/branches/from-material").length, 1, "resuming creates nothing");
});

test("explicit new exploration: from the choice, a fresh intent key posts mode 'new' and the full first-question flow follows on the new branch", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: true })],
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  const flow = world.branchFlow();
  flow.querySelector(".mat-branch-new")!.click();
  await settle(25);

  /* mode:"new" + 新键 → 新枝声明面。 */
  const newRequest = world.requestsOf("/branches/from-material").at(-1)!;
  assert.equal((newRequest.body as Record<string, unknown>)["mode"], "new");
  const firstKey = (world.requestsOf("/branches/from-material")[0]!.body as Record<string, unknown>)["intentKey"];
  assert.notEqual((newRequest.body as Record<string, unknown>)["intentKey"], firstKey);
  const declared = world.branchFlow();
  assert.match(declared.textContent!, /Material scope for this exploration/);

  /* 首问落在**新**分支（树态的第二个材料分支）。 */
  typeFirstQuestion(world, "另开后的首问");
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, false);
  const conversation = world.el("panel-conversation").textContent!;
  assert.match(conversation, /另开后的首问/);
  assert.ok(!conversation.includes("既有探索的首问"), "the panel shows the new branch, not the restored one");
  assert.equal(world.backend.treeState.branches.length, 3, "trunk + existing exploration + the new branch");
});

test("pending intent resume: a branch created but never asked resumes straight to the declared scope with the SAME key after a refresh (idempotent continuation — localStorage carries the submission identity)", async () => {
  /* 场景：建枝后未提交首问（页面刷新/重启）——挂起 intentKey 留在
     localStorage；重进同一选区 → resume-or-create 恢复（零 turn）+ 已存键
     → 直达声明面（同键幂等续走），且如实注明这是既有分支的续走。 */
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: false })],
    seededStorage: {
      "treeai-material-intent:tree-1:mat-md01:v-md01-1:blk-1:13-15": JSON.stringify({
        intentKey: "seed-intent-1",
        firstQuestion: "刷新前键入的问题",
      }),
    },
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  const flow = world.branchFlow();
  assert.match(flow.textContent!, /Material scope for this exploration/);
  assert.match(flow.textContent!, /reopened the branch this pending intent key created/, "the resumed path is disclosed honestly");
  /* 键入文本跨「刷新」保留（草稿随挂起意图持久化）。 */
  const input = world.byId("mat-branch-first-question")!;
  assert.equal(input.value, "刷新前键入的问题", "the pending draft travels with the intent key");

  /* 提交沿用同一键（seed-intent-1——预置绑定即该键）。 */
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200);
  const fq = world.lastRequest("/material-first-question")!;
  assert.deepEqual(fq.body, { intentKey: "seed-intent-1", firstQuestion: "刷新前键入的问题" });
  assert.equal(world.el("branch-panel").hidden, false, "the panel opens at the resumed branch");
  /* 挂起键已清（逻辑提交完成）。 */
  assert.deepEqual(
    [...world.localStorageStore.keys()].filter((key) => key.startsWith("treeai-material-intent:")),
    [],
  );
});

test("restored branch navigation/session facts ride along honestly (failed navigation and unavailable session are disclosed, never masked)", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [
      seededExploration({
        hasTurns: true,
        sessionAvailability: "unavailable",
        restoreNavigation: { status: "failed", code: "session-corrupt", message: "the scripted restore refused" },
      }),
    ],
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  const flow = world.branchFlow();
  assert.match(flow.textContent!, /aligning the live session failed \(session-corrupt: the scripted restore refused\)/);
  assert.match(flow.textContent!, /the session at this branch's continuation point is unavailable/);
  /* 来源跳转的恢复本身不被掩盖（既有分支与二选仍呈现）。 */
  assert.match(flow.textContent!, /already has an exploration in this tree/);
});

/* ------------------------------------------------------------------ */
/* 5. 409 冲突路径                                                        */
/* ------------------------------------------------------------------ */

test("first-question conflict (409): after an in-flight dispatch lands unseen, a changed question is refused — the immutability is disclosed and the changed question is offered as a normal continuation (panel opens prefilled; sending stays an explicit action)", async () => {
  /* 场景（响应丢失/进程退出 mid-dispatch 的真实形态）：首问派发后响应为
     unknown（在途不决）——但在途 run 事后完成、turn 已落库（客户端不可
     见）。用户改问重试 → 服务端对账证据一（落库 turn）优先 → 409 异问冲
     突；改问是普通续聊，不是首问重试。 */
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    fqScript: ["unknown-lands"],
  });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  /* 第一次提交：unknown（不盲发）——流程面如实呈现。 */
  typeFirstQuestion(world, "最初的问题");
  clickSubmitFirstQuestion(world);
  await settle(25);
  let flow = world.branchFlow();
  assert.match(flow.textContent!, /never reached a terminal state/);
  assert.match(flow.textContent!, /was NOT re-sent/);

  /* 改问重试 → 409 material-first-question-conflict。 */
  typeFirstQuestion(world, "改后的新问题");
  clickSubmitFirstQuestion(world);
  await settle(25);
  flow = world.branchFlow();
  assert.match(flow.textContent!, /first-question conflict — /, "the conflict is disclosed in the flow");
  assert.match(flow.textContent!, /immutable for this branch/);
  assert.match(flow.textContent!, /a changed question is a normal continuation/);
  const cont = flow.querySelector(".mat-branch-continue")!;
  assert.ok(cont !== null, "the normal-continuation path is offered");

  /* 去向：面板打开该分支 + composer 预填改后问题（发送是显式动作——此
     刻零 prompt 请求）。 */
  cont.click();
  await settle(25);
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, false, "the panel opens at the branch for the continuation");
  const panelComposer = world.el("panel-prompt-input");
  assert.equal(panelComposer.value, "改后的新问题", "the changed question is prefilled for review");
  assert.equal(
    world.requestsOf("/material-first-question").length,
    2,
    "the flow posted the first question exactly twice (initial + the changed retry that hit the 409)",
  );
  assert.equal(world.requestsOf("/prompt").length, 0, "nothing is sent without the user's explicit submit");
  /* 分支上已落库的首问（事后完成的在途派发）照常可读。 */
  assert.match(world.el("panel-conversation").textContent!, /最初的问题/);
});

test("branch-intent conflict (409 material-branch-conflict, same key bound to a different selection): the flow fails honestly and offers a retry", async () => {
  /* 预置：后端键 K 已绑定 blk-1 [13,15)；localStorage 挂起键 K 指向**另一
     选区身份**（blk-2 的 [x,y)）——该选区点击建枝时复用挂起键 K → 后端
     409（一次逻辑提交不得静默换源）。 */
  const block2 = MD01.blocks[2]!;
  const excerpt2 = block2.text.slice(0, 4);
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: false, blockId: "blk-1" })],
    seededStorage: {
      [`treeai-material-intent:tree-1:mat-md01:v-md01-1:blk-2:${String(block2.start)}-${String(block2.start + 4)}`]:
        JSON.stringify({ intentKey: "seed-intent-1", firstQuestion: "" }),
    },
  });

  /* 武装 blk-2 的选区（身份 ≠ 预置键绑定的 blk-1 选区）。 */
  await world.openMaterial("mat-md01");
  const blockEl = world.blockElement("blk-2");
  const line = firstLineNode(blockEl);
  world.setSelection(world.makeRange(line, 0, line, 4));
  world.matBlocks().dispatchEvent("mouseup", {});
  const bar = selectionBar(world);
  assert.equal(bar.querySelector(".mat-quote")!.textContent, excerpt2);
  bar.querySelector(".mat-branch-d43")!.click();
  await settle(25);

  const flow = world.branchFlow();
  assert.match(flow.textContent!, /the flow failed/);
  assert.match(flow.textContent!, /material-branch-conflict: .*different selection/);
  const retry = flow.querySelector(".mat-branch-retry")!;
  assert.ok(retry !== null, "the failed flow offers a retry");
  /* 冲突期间零派发（无首问/Return 请求）。 */
  assert.equal(world.requestsOf("/material-first-question").length, 0);
});

/* ------------------------------------------------------------------ */
/* 6. 材料 Return：material-return + 主线来源卡 + 原文跳转               */
/* ------------------------------------------------------------------ */

test("material return: the panel return posts material-return with the draft idempotency key; the mainline card renders the material source fields, adoption state, and the source jump opens the reader at the anchored version and block", async () => {
  const world = await createWorld({ materials: [MD01_SCRIPT] });
  await armRecursionSelection(world);
  await clickBranchButton(world);

  typeFirstQuestion(world, "首问（Return 场景）");
  clickSubmitFirstQuestion(world);
  await settle(30);
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, false);

  /* Return 草稿预填（分支最近回答）+ 显式改写 → 提交。 */
  const returnInput = world.el("return-input");
  assert.match(returnInput.value, /（echo 回答）/, "the draft prefills from the branch's last answer");
  returnInput.value = "收获：递归必须有终止条件。";
  returnInput.dispatchEvent("input", {});
  const submitReturn = world.el("submit-return");
  assert.equal(submitReturn.disabled, false);
  submitReturn.click();
  await settle(30);

  /* 请求形状：材料分支走 material-return（携带幂等键）。 */
  const ret = world.lastRequest("/material-return")!;
  assert.ok(ret !== null, "the material branch's return posts to material-return");
  const retBody = ret.body as Record<string, unknown>;
  assert.equal(retBody["fromBranchId"], world.backend.records[0]!.branchId);
  assert.equal(retBody["text"], "收获：递归必须有终止条件。");
  assert.match(String(retBody["idempotencyKey"]), /.+/);
  assert.equal(
    world.requestsOf("/return").length,
    0,
    "the material branch never posts to the turn-source return endpoint",
  );

  /* 面板收起（退出动效 170ms 播完后 hidden 置位）、主线卡落位。 */
  await sleep(200);
  assert.equal(world.el("branch-panel").hidden, true, "the panel closes after the return is saved");

  /* 主线材料 Return 卡：来源卡字段（标题/版本/块/摘录/确认时间）+ 采用记
     录（saved — pending adoption）+ 原文跳转。 */
  const conversation = world.el("conversation").textContent!;
  assert.match(conversation, /Return from Branch 1 \(material exploration\)/);
  assert.match(conversation, /material “递归与分治学习笔记\.md” · version v-md01-1 \(markdown d4-md-v1\) · block blk-1/);
  assert.match(conversation, /confirmed /);
  assert.match(conversation, /saved — pending adoption on the next Trunk discussion/);
  assert.match(conversation, /收获：递归必须有终止条件。/);
  const card = world.el("conversation").querySelector(".material-return")!;
  const quote = card.querySelector(".mat-return-excerpt")!;
  assert.equal(quote.textContent, "递归", "the original excerpt is quoted on the card");
  const jump = card.querySelector(".mat-return-jump")!;
  assert.ok(jump !== null, "the source jump is offered");

  /* 原文跳转：阅读器打开锚定版本并定位到选区块（与搜索跳转同机制、不同
     的到达注记）。 */
  jump.click();
  await settle(30);
  assert.equal(world.el("material-reader").hidden, false, "the reader opens for the source jump");
  const readerText = world.el("material-reader").textContent!;
  assert.match(readerText, /jumped to the material source of a Return — located at block blk-1/);
  const versionRequest = world.requestsOf("/versions/v-md01-1");
  assert.ok(versionRequest.length > 0, "the anchored version's blocks are fetched");
  const blk1 = world.blockElement("blk-1");
  assert.equal((blk1.lastScrollIntoView as { block?: string } | null)?.block, "start", "the reader scrolls to the anchored block");
  /* 跳转不触碰对话游标（阅读与探索互不干扰）。 */
  assert.equal(
    world.requestsOf("/switch").filter((r) => r.method === "POST").length,
    1,
    "the only switch is the return's own close-panel alignment (the jump adds none)",
  );
});

test("material return card: a cached source card renders on the mainline at boot; a missing cache degrades honestly (the Return itself is intact, no source details are fabricated)", async () => {
  /* 预置：既有材料探索（有 turn）+ 其 Return 已落主线（targetAnchor null）；
     来源卡缓存**在场**（localStorage 预置——提交响应的 card 缓存路径在
     上一测试锁定，此处锁定主线渲染的缓存读取面）。 */
  const cachedCard = {
    materialId: "mat-md01",
    materialTitle: "递归与分治学习笔记.md",
    versionId: "v-md01-1",
    parserKind: "markdown",
    parserVersion: "d4-md-v1",
    blockId: "blk-1",
    page: null,
    excerpt: "递归",
    sourceJump: {
      materialId: "mat-md01",
      versionId: "v-md01-1",
      blockId: "blk-1",
      start: 13,
      end: 15,
      sourceHash: "sha256-mat-md01-v-md01-1",
    },
    confirmTime: ISO_LATER,
    adoption: { attempts: 0, deliveredRunId: null, status: "saved" },
  };
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: true })],
    seededReturns: [{ turnId: "turn-ret-seeded", fromBranchId: "branch-seed-1", text: "预置的材料 Return。", idempotencyKey: "seeded-ret-key" }],
    seededStorage: {
      "treeai-material-return-card:tree-1:turn-ret-seeded": JSON.stringify(cachedCard),
    },
  });

  /* 主线卡：来源字段 + 采用记录 + 原文跳转（boot 渲染即在场）。 */
  const conversation = world.el("conversation");
  const card = conversation.querySelector(".material-return")!;
  assert.ok(card !== null, "the material return card renders on the mainline");
  const text = card.textContent!;
  assert.match(text, /Return from Branch 1 \(material exploration\)/);
  assert.match(text, /material “递归与分治学习笔记\.md” · version v-md01-1 \(markdown d4-md-v1\) · block blk-1/);
  assert.match(text, /saved — pending adoption on the next Trunk discussion/);
  assert.match(text, /预置的材料 Return。/);
  assert.equal(card.querySelector(".mat-return-excerpt")!.textContent, "递归");
  assert.ok(card.querySelector(".mat-return-jump") !== null, "the source jump is offered from the cached card");

  /* 缓存缺失（另一世界：同一预置 Return、无缓存）：如实注明，绝不伪造。 */
  const bare = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: true })],
    seededReturns: [{ turnId: "turn-ret-seeded", fromBranchId: "branch-seed-1", text: "预置的材料 Return。", idempotencyKey: "seeded-ret-key" }],
  });
  const bareCard = bare.el("conversation").querySelector(".material-return")!;
  assert.ok(bareCard !== null);
  assert.match(
    bareCard.textContent!,
    /the material source details for this Return are not cached in this browser/,
    "a missing card cache degrades honestly",
  );
  assert.match(bareCard.textContent!, /预置的材料 Return。/);
  assert.equal(
    bareCard.querySelector(".mat-return-jump"),
    null,
    "no source jump is fabricated without the card",
  );

  /* 幂等边界（客户端面）：面板重开后的**新**提交是新的逻辑提交（新键——
     同键重放只发生在响应丢失对账路径，由服务端测试锁定）。 */
  const replayWorld = await createWorld({ materials: [MD01_SCRIPT] });
  await armRecursionSelection(replayWorld);
  await clickBranchButton(replayWorld);
  typeFirstQuestion(replayWorld, "幂等 Return 场景的首问");
  clickSubmitFirstQuestion(replayWorld);
  await settle(30);
  await sleep(200);

  const input = replayWorld.el("return-input");
  input.value = "第一次 Return。";
  input.dispatchEvent("input", {});
  replayWorld.el("submit-return").click();
  await settle(30);
  const firstKey = String(
    (replayWorld.requestsOf("/material-return")[0]!.body as Record<string, unknown>)["idempotencyKey"],
  );
  assert.equal(
    replayWorld.backend.treeState.branches[0]!.turns.filter((t) => t.role === "return").length,
    1,
    "exactly one return turn lands on the mainline",
  );

  /* 重开面板提交同一文本：草稿已清 → 新草稿新键（新逻辑提交，非重放）。 */
  replayWorld.branchTab(replayWorld.backend.records[0]!.branchId).click();
  await settle(25);
  const input2 = replayWorld.el("return-input");
  input2.value = "第一次 Return。";
  input2.dispatchEvent("input", {});
  replayWorld.el("submit-return").click();
  await settle(30);
  const secondKey = String(
    (replayWorld.requestsOf("/material-return").at(-1)!.body as Record<string, unknown>)["idempotencyKey"],
  );
  assert.notEqual(secondKey, firstKey, "a fresh panel submission carries a fresh idempotency key");
  assert.equal(
    replayWorld.backend.treeState.branches[0]!.turns.filter((t) => t.role === "return").length,
    2,
    "two logical submissions land two returns (nothing is silently deduplicated client-side)",
  );
});

/* ------------------------------------------------------------------ */
/* 7. 缺 session 显式新探索（材料面走 material-new-exploration）           */
/* ------------------------------------------------------------------ */

test("session-unavailable material branch: the explicit new exploration posts material-new-exploration (material context rides along); an available session is refused with the honest 409", async () => {
  const world = await createWorld({
    materials: [MD01_SCRIPT],
    explorations: [seededExploration({ hasTurns: true, sessionAvailability: "unavailable" })],
  });

  /* 打开该材料分支的面板（tab 点击——既有 switch 语义）。 */
  world.branchTab("branch-seed-1").click();
  await settle(25);
  assert.equal(world.el("branch-panel").hidden, false);
  /* 降级提示 + 换轨入口在场（v3 §4.4 既有呈现）。 */
  assert.match(world.el("panel-session-note").textContent!, /Session missing on this branch/);
  const exploreButton = world.el("panel-new-exploration");
  assert.equal(exploreButton.hidden, false, "the explicit new-exploration entry is offered");

  /* 键入首问 → 显式换轨（confirm 桩通过）。 */
  world.setConfirm(true);
  const composer = world.el("panel-prompt-input");
  composer.value = "换轨后的新首问";
  composer.dispatchEvent("input", {});
  exploreButton.click();
  await settle(30);

  /* 请求形状：材料分支走 material-new-exploration（不走 /new-exploration）。 */
  const newExploration = world.requestsOf("/branches/branch-seed-1/material-new-exploration");
  assert.equal(newExploration.length, 1);
  assert.deepEqual(newExploration[0]!.body, { text: "换轨后的新首问" });
  assert.equal(
    world.requestsOf("/branches/branch-seed-1/new-exploration").length,
    0,
    "the material branch never posts to the turn-source new-exploration endpoint",
  );

  /* 收尾：状态落地（新 turn 在面板、session 恢复可用——降级提示下线）。 */
  assert.match(world.el("panel-conversation").textContent!, /\[new exploration from saved content\]/);
  assert.match(world.el("panel-conversation").textContent!, /换轨后的新首问/);
  assert.equal(world.el("panel-session-note").hidden, true, "the recovery note clears once the new exploration lands");

  /* 前置条件（session 可用 → 409 如实）：主干面板对可用分支重试换轨。 */
  const trunkTab = world.branchTab("trunk-1");
  trunkTab.click();
  await settle(25);
  /* 主线 session 可用——主线 composer 的换轨入口不出现（可见性纪律）；以
     脚本确认：材料分支（现已 available）再次显式换轨 → 409 如实呈现。 */
  world.branchTab("branch-seed-1").click();
  await settle(25);
  assert.equal(world.el("panel-new-exploration").hidden, true, "the entry disappears once the session is available");
});

/* ------------------------------------------------------------------ */
/* 8. CSS 词法锁定                                                        */
/* ------------------------------------------------------------------ */

test("css lexical locks: the branching flow, the scope card, the truncation marker, and the material return source card have base-layer rules", async () => {
  const src = STYLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const hasRule = (selector: string): boolean =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`).test(src);
  assert.ok(hasRule(".mat-branch-flow"), "the branching flow surface has a base rule");
  assert.ok(hasRule(".mat-branch-context"), "the scope card has a base rule");
  assert.ok(hasRule(".mat-branch-context .mat-branch-truncated"), "the truncation marker has an explicit rule");
  assert.ok(hasRule(".mat-branch-context .mat-branch-composed pre"), "the composed-text preview has a rule");
  assert.ok(hasRule(".turn.return .mat-return-source"), "the material return source card has a rule");
  assert.ok(hasRule(".turn.return .mat-return-source .mat-return-jump"), "the source-jump button has a rule");
  assert.ok(hasRule("#branch-tabs .material-badge"), "the material branch tab badge has a rule");
});
