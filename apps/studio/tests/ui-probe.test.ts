/**
 * Studio 前端脚本化 DOM E2E 套件（issue #4 P1「证据工程化」）。
 *
 * 方法：以 data: URL 加载仓库真实 public/app.js 为 ES module（URL fragment
 * 随机化绕过 ES 模块缓存——fragment 不进入模块源码，每个场景得到一份全新
 * 实例），运行在「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本
 * 化 echo 后端」之上：fetch / EventSource / localStorage / 计时器 / matchMedia
 * / getSelection 全部为内存桩，后端按场景脚本化（journal 可脚本为 500 / 空 /
 * 有事件；/return 可脚本为成功 / 失败 / 响应丢失）。无网络、无磁盘写入、
 * 无长等待（仅面板/抽屉退场动画所需的短 sleep），确定性可复现。
 *
 * 覆盖（issue #3 P1 修复的回归面 + issue #4 的视觉基线要求）：
 *  1. 视觉基线（DOM 结构基线，诚实近似）：真实 index.html 骨架（必需 id
 *     恰好一次、aria-label、placeholder）+ 引导后的渲染结构（每分支一个
 *     tab、turn 角色、Return 卡锚点定位、流式占位形态）。
 *  2. journal 三态：加载失败 + 重试 + 如实空态（失败绝不伪装成「无事件」）。
 *  3. 面板 / 主线横幅 session 降级：恢复按钮为可执行动作（精确 POST
 *     /branches 载荷：整条最新 assistant 答案），fail-closed 禁用不放松。
 *  4. Return：草稿持久化（localStorage + 幂等键）、双击防抖、失败保留
 *     草稿 + 改写换键 + 同键重试、响应丢失对账（/state 同键命中即按成功）。
 *  5. 流式滚动纪律：向上阅读绝不强制滚底；贴底跟随；终态权威刷新贴底保持。
 *  6. Esc 焦点还原（抽屉 / 面板 → 触发元素）。
 *
 * 边界（如实声明）：本套件不是真实浏览器 E2E——像素级视觉基线、布局合成、
 * 真实滚动物理、键盘/读屏器实机行为不在覆盖范围；引入 Playwright /
 * Puppeteer 属 owner 依赖决策（本仓库零新依赖约束下不可行），真实浏览器
 * 证据归 evidence/d3/real-pi/ 与 trials/ 口径（evidence/d3/README.md）。
 * 另见下方 globals 注入处：全局桩是与无类型前端脚本的唯一动态接面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* 加载真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const APP_JS = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const A2_TEXT = "Second trunk answer — the latest one.";
const BA1_TEXT = "Branch one answer.";

interface Selection {
  start: number;
  end: number;
  text: string;
}

interface ReturnTargetAnchor {
  sourceBranchId: string;
  anchorTurnId: string;
  anchorEntryId: string;
  selection: Selection;
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
  targetAnchor: ReturnTargetAnchor | null;
  createdAt: string;
}

interface BranchView {
  branch: Branch;
  origin: Origin | null;
  originStatus: "available" | "changed" | "unavailable" | null;
  sessionAvailability: "available" | "unavailable" | null;
  turns: Turn[];
}

interface TreeState {
  tree: Tree;
  trunkBranchId: string | null;
  branches: BranchView[];
  cursor: { treeId: string; branchId: string; entryId: string } | null;
}

interface RunDiagnostics {
  runId: string;
  branchId: string;
  episodeId: string;
  state: string;
  failure: { code: string; message: string } | null;
  createdAt: string;
  terminalAt: string | null;
}

interface PolicyDecisionView {
  tool: string | null;
  outcome: "allow" | "deny" | "require-approval";
  category: string;
  risk: string;
  reason: string;
  ruleId: string | null;
  occurredAt: string;
}

interface TreeDiagnostics {
  treeId: string;
  runtimeState: "idle" | "streaming" | "aborting";
  activeRun: { runId: string; branchId: string; episodeId: string } | null;
  runs: RunDiagnostics[];
  policyDecisions:
    | { observed: false; reason: string }
    | { observed: true; decisions: PolicyDecisionView[] };
}

interface JournalEvent {
  eventId: string;
  runId: string;
  seq: number;
  occurredAt: string;
  type: string;
  summary: string;
}

const JOURNAL_EVENTS: JournalEvent[] = [
  { eventId: "evt-1", runId: "run-a1", seq: 1, occurredAt: ISO, type: "run-started", summary: "run started on Trunk" },
  { eventId: "evt-2", runId: "run-a1", seq: 2, occurredAt: ISO, type: "run-terminal", summary: "run succeeded on Trunk" },
];

interface TurnExtra {
  runId?: string | null;
  piEntryId?: string | null;
  fromBranchId?: string | null;
  deliveredRunId?: string | null;
  idempotencyKey?: string | null;
  targetAnchor?: ReturnTargetAnchor | null;
}

function makeTurn(id: string, branchId: string, role: Turn["role"], text: string, extra: TurnExtra = {}): Turn {
  return {
    id,
    treeId: TREE,
    branchId,
    episodeId: "ep-1",
    runId: extra.runId !== undefined ? extra.runId : `run-${id}`,
    role,
    text,
    piEntryId: extra.piEntryId !== undefined ? extra.piEntryId : `pi-${id}`,
    fromBranchId: extra.fromBranchId ?? null,
    deliveredRunId: extra.deliveredRunId ?? null,
    idempotencyKey: extra.idempotencyKey ?? null,
    targetAnchor: extra.targetAnchor ?? null,
    createdAt: ISO,
  };
}

function makeBranchView(
  branch: Branch,
  origin: Origin | null,
  sessionAvailability: "available" | "unavailable" | null,
  turns: Turn[],
): BranchView {
  return { branch, origin, originStatus: origin === null ? null : "available", sessionAvailability, turns };
}

function freshBackendState(initialTrunkReturn: boolean): TreeState {
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const b1Branch: Branch = { id: "branch-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
  const trunkTurns: Turn[] = [
    makeTurn("u1", "trunk-1", "user", "First trunk question."),
    makeTurn("a1", "trunk-1", "assistant", "First trunk answer."),
    makeTurn("u2", "trunk-1", "user", "Second trunk question."),
    makeTurn("a2", "trunk-1", "assistant", A2_TEXT),
  ];
  if (initialTrunkReturn) {
    /* 预置一张已确认（未送达）的锚点 Return 卡：渲染定位断言用。 */
    trunkTurns.push(
      makeTurn("r0", "trunk-1", "return", "Earlier returned conclusion.", {
        runId: null,
        piEntryId: null,
        fromBranchId: "branch-1",
        idempotencyKey: "idem-r0",
        targetAnchor: {
          sourceBranchId: "branch-1",
          anchorTurnId: "a1",
          anchorEntryId: "pi-a1",
          selection: { start: 0, end: 5, text: "First" },
        },
      }),
    );
  }
  const b1Origin: Origin = {
    branchId: "branch-1",
    sourceBranchId: "trunk-1",
    anchorTurnId: "a1",
    anchorEntryId: "pi-a1",
    selection: { start: 0, end: 5, text: "First" },
    createdAt: ISO,
  };
  return {
    tree: { id: TREE, createdAt: ISO, forestId: "forest-1" },
    trunkBranchId: "trunk-1",
    branches: [
      makeBranchView(trunkBranch, null, "available", trunkTurns),
      makeBranchView(b1Branch, b1Origin, "available", [
        makeTurn("bu1", "branch-1", "user", "Branch one question."),
        makeTurn("ba1", "branch-1", "assistant", BA1_TEXT),
      ]),
    ],
    cursor: { treeId: TREE, branchId: "trunk-1", entryId: "pi-a2" },
  };
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

interface Backend {
  trees: Tree[];
  treeState: TreeState;
  diagnostics: TreeDiagnostics;
  journalMode: "fail" | "ok-events" | "ok-empty";
  journalEvents: JournalEvent[];
  requests: RecordedRequest[];
  switchCount: number;
  returnMode: "ok" | "lose-response" | "fail";
  returnDelay: boolean;
  branchCounter: number;
}

/* ------------------------------ unknown 收窄辅助（不使用 any） ------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

interface PersistedDraft {
  idempotencyKey: string;
  text: string;
  failed: boolean;
}

function readPersistedDraft(raw: string | null | undefined): PersistedDraft | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  if (typeof record.idempotencyKey !== "string" || typeof record.text !== "string") return null;
  return { idempotencyKey: record.idempotencyKey, text: record.text, failed: record.failed === true };
}

/* ------------------------------ 事件轮转 / 短等待 ------------------------------ */

/** 每轮走一次 timers 阶段：app.js 的 busy 延迟聚焦等 setTimeout(0) 回调需要
 * 真实计时器轮转，纯 microtask 轮转会漏掉它们。 */
const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 面板 / 抽屉退场动画（PANEL_EXIT_MS = 170ms）收尾所需的短等待。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ DOM 桩（模块级类 + 每元素 ownerDocument 指针） ------------------------------ */

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
  /** 焦点落位目标（createElement / buildDomFromHtml 注入；场景间隔离）。 */
  ownerDocument: StubDocument | null = null;
  private readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  children: StubNode[] = [];
  parentElement: StubElement | null = null;
  hidden = false;
  disabled = false;
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

  get offsetHeight(): number {
    return 0;
  }

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(value: number) {
    /* 与真实 DOM 一致：程序化设置 scrollTop 也触发 scroll 事件
       （app.js 的滚动位置记忆监听 scroll）。 */
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
    if (value !== "") this.children.push(new StubText(value));
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

/* 极简选择器引擎：#id / tag / .class / tag.class（app.js 与本套件所用
   的全部形态）。 */
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

/** 完整 index.html DOM 桩：按标签词法解析真实 index.html 建树（含全部
 *  id/class/aria 属性与嵌套），使桩 DOM 与仓库静态页结构一致。 */
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
    const full = match[0]!;
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
}

/* ------------------------------ EventSource 桩 ------------------------------ */

/** 实例注册表按 world 重置（liveSse = 当前场景最新连接；旧场景连接不再可见）。 */
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

  /** 测试侧注入事件（data 自动 JSON 序列化——对齐真实 SSE 的字符串 data）。 */
  emit(type: string, data: unknown): void {
    const event: StubSseEvent = { type, data: JSON.stringify(data) };
    for (const fn of this.sseListeners.get(type) ?? []) fn(event);
  }
}

/* ------------------------------ window 桩形状 ------------------------------ */

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
  getSelection(): { rangeCount: number };
}

/* ------------------------------ world 工厂 ------------------------------ */

interface World {
  readonly document: StubDocument;
  readonly backend: Backend;
  readonly localStorageStore: Map<string, string>;
  /** 断言存在并返回（必需元素）。 */
  el(id: string): StubElement;
  byId(id: string): StubElement | null;
  requestsOf(suffix: string): RecordedRequest[];
  lastRequest(suffix: string): RecordedRequest | null;
  tabButton(branchId: string): StubElement | null;
  liveSse(): StubEventSource;
  setAvailability(branchId: string, value: "available" | "unavailable" | null): void;
}

interface WorldOptions {
  journalMode?: Backend["journalMode"];
  returnMode?: Backend["returnMode"];
  /** 预置一张锚定于 a1 的已确认 Return 卡（渲染定位断言用）。 */
  initialTrunkReturn?: boolean;
}

let appLoadCounter = 0;

/**
 * 构建一套全新场景环境：真实 index.html 解析出的 DOM 桩 + 脚本化后端 +
 * 全局桩注入 + 全新 app.js 模块实例（fragment 随机化绕过模块缓存），
 * 等待引导（自动打开第一棵树）完成。场景之间完全隔离（DOM、后端、
 * localStorage、SSE 注册表、模块级前端状态各自独立）。
 */
async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  /* ---------------- window / localStorage 桩 ---------------- */

  const localStorageStore = new Map<string, string>();
  const windowStub: StubWindow = {
    /* 桩计时器一律 unref：测试结束后残留的动效/横幅计时器不得拖住进程。 */
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
    /* 无选区 → app.js 的 selectionOffsetsWithin 回退整条答案语义。 */
    getSelection: () => ({ rangeCount: 0 }),
  };

  /* ---------------- 脚本化 echo 后端 ---------------- */

  const backend: Backend = {
    trees: [{ id: TREE, createdAt: ISO, forestId: "forest-1" }],
    treeState: freshBackendState(options.initialTrunkReturn === true),
    diagnostics: {
      treeId: TREE,
      runtimeState: "idle",
      activeRun: null,
      runs: [],
      policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
    },
    journalMode: options.journalMode ?? "ok-events",
    journalEvents: JOURNAL_EVENTS,
    requests: [],
    switchCount: 0,
    returnMode: options.returnMode ?? "ok",
    returnDelay: false,
    branchCounter: 0,
  };

  const viewByBranch = (branchId: string): BranchView | undefined =>
    backend.treeState.branches.find((view) => view.branch.id === branchId);

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

    if (p === "/api/trees" && method === "GET") return respond(200, { trees: backend.trees });
    if (p === "/api/trees" && method === "POST") {
      return respond(201, { tree: backend.treeState.tree, trunkBranchId: "trunk-1", state: backend.treeState });
    }
    let m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") return respond(200, backend.treeState);
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") return respond(200, backend.diagnostics);
    m = /^\/api\/trees\/([^/]+)\/journal$/.exec(p);
    if (m !== null && method === "GET") {
      if (backend.journalMode === "fail") {
        return respond(500, { error: { code: "internal", message: "journal backend boom" } });
      }
      return respond(200, { events: backend.journalMode === "ok-empty" ? [] : backend.journalEvents });
    }
    m = /^\/api\/trees\/([^/]+)\/switch$/.exec(p);
    if (m !== null && method === "POST") {
      backend.switchCount += 1;
      const branchId = asRecord(body)?.branchId;
      return respond(200, {
        cursor: { treeId: TREE, branchId: typeof branchId === "string" ? branchId : "", entryId: "pi-a2" },
        state: backend.treeState,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/branches$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /branches body must be an object");
      const selectionRecord = asRecord(record.selection);
      assert.ok(selectionRecord !== null, "POST /branches body must carry a selection");
      const selection: Selection = {
        start: Number(selectionRecord.start),
        end: Number(selectionRecord.end),
        text: String(selectionRecord.text ?? ""),
      };
      backend.branchCounter += 1;
      const branchId = `branch-recovered-${backend.branchCounter}`;
      const sourceBranchId = typeof record.sourceBranchId === "string" ? record.sourceBranchId : null;
      const anchorTurnId = String(record.anchorTurnId ?? "");
      /* 服务端语义：新分支无 run → 续聊点 = origin 锚点 run 的 session 引用
         （可用分支的锚点按构造可用）。 */
      const branch: Branch = { id: branchId, treeId: TREE, parentBranchId: sourceBranchId, createdAt: ISO };
      const origin: Origin = {
        branchId,
        sourceBranchId: sourceBranchId ?? "",
        anchorTurnId,
        anchorEntryId: `pi-${anchorTurnId}`,
        selection,
        createdAt: ISO,
      };
      backend.treeState.branches.push(makeBranchView(branch, origin, "available", []));
      return respond(201, { branch, origin, state: backend.treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/return$/.exec(p);
    if (m !== null && method === "POST") {
      if (backend.returnDelay) await new Promise<void>((resolve) => setImmediate(resolve));
      const record = asRecord(body);
      assert.ok(record !== null, "POST /return body must be an object");
      const fromBranchId = String(record.fromBranchId ?? "");
      const text = String(record.text ?? "");
      const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey : null;
      const returnCount = backend.requests.filter((r) => r.path.split("?")[0]!.endsWith("/return")).length;
      if (backend.returnMode !== "fail") {
        /* 服务端先落库（lose-response 模式同样如此：响应丢失但记录已成功）。 */
        const returnTurn = makeTurn(`r-${returnCount}`, "trunk-1", "return", text, {
          runId: null,
          piEntryId: null,
          fromBranchId,
          idempotencyKey,
          targetAnchor: {
            sourceBranchId: fromBranchId,
            anchorTurnId: "a2",
            anchorEntryId: "pi-a2",
            selection: { start: 0, end: 5, text: "Secon" },
          },
        });
        const trunk = viewByBranch("trunk-1");
        assert.ok(trunk !== undefined);
        trunk.turns.push(returnTurn);
        if (backend.returnMode === "lose-response") {
          return respond(500, {
            error: { code: "internal", message: "simulated response loss — the server recorded the return" },
          });
        }
        return respond(201, { returnTurn, state: backend.treeState });
      }
      return respond(500, { error: { code: "internal", message: "return rejected (scripted failure)" } });
    }
    m = /^\/api\/trees\/([^/]+)\/prompt$/.exec(p);
    if (m !== null && method === "POST") return respond(200, { outcome: { kind: "completed" }, state: backend.treeState });
    return respond(404, { error: { code: "not-found", message: `no route for ${method} ${p}` } });
  };

  /* ---------------- 全局桩注入 + 全新 app.js 实例 ---------------- */

  /* app.js 是无类型前端脚本：此处全局桩注入是本套件与其动态行为的唯一
     接面（等价 any-boundary，但收窄为四个精确形状的插槽，不做宽泛 any）。 */
  const globals = globalThis as unknown as {
    document: StubDocument;
    window: StubWindow;
    EventSource: typeof StubEventSource;
    fetch: (input: string, init?: StubFetchInit) => Promise<StubResponse>;
  };
  globals.document = documentStub;
  globals.window = windowStub;
  globals.EventSource = StubEventSource;
  globals.fetch = fetchStub;

  /* data: URL 的 fragment 不进入模块源码（只区分模块身份），据此绕过 ES
     模块缓存：每个场景加载一份全新 app.js 实例，模块级状态互不渗透。 */
  appLoadCounter += 1;
  await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(APP_JS)}#load=${appLoadCounter}`);
  await settle(25);

  return {
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
    tabButton: (branchId) => {
      const tabs = documentStub.getElementById("branch-tabs") ?? documentStub.root;
      assert.ok(tabs !== null, "branch tabs container missing");
      return tabs.querySelectorAll("button").find((b) => b.dataset.branchId === branchId) ?? null;
    },
    liveSse: () => {
      const sse = StubEventSource.latest();
      assert.ok(sse !== null, "no live EventSource instance");
      return sse;
    },
    setAvailability: (branchId, value) => {
      const view = viewByBranch(branchId);
      assert.ok(view !== undefined, `unknown branch ${branchId}`);
      view.sessionAvailability = value;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. 视觉基线（DOM 结构基线）：真实 index.html 骨架 + 引导后渲染结构    */
/* ------------------------------------------------------------------ */

test("visual baseline: real index.html skeleton and boot-rendered structure", async () => {
  const world = await createWorld({ initialTrunkReturn: true });

  /* 静态骨架：必需 id 恰好出现一次（解析自真实 index.html，非硬编码副本）。 */
  const requiredIds = [
    "sidebar",
    "branch-tabs",
    "reading-area",
    "main-pane",
    "conversation",
    "composer",
    "branch-panel",
    "panel-header",
    "panel-fixed-actions",
    "panel-conversation",
    "return-panel",
    "source-drawer",
    "diagnostics-bar",
    "failure-panel",
    "session-banner",
  ];
  for (const id of requiredIds) {
    assert.equal(world.document.querySelectorAll(`#${id}`).length, 1, `#${id} must appear exactly once`);
  }

  /* aria 契约：侧栏 / 面板 / 抽屉 / 会话容器均具名（读屏器可达性基线）。 */
  const ariaContracts: Array<[string, string]> = [
    ["sidebar", "Trees"],
    ["branch-panel", "Branch side panel"],
    ["source-drawer", "Sources"],
    ["conversation", "Trunk conversation"],
    ["panel-conversation", "Branch conversation"],
    ["branch-tabs", "Branches"],
    ["tree-list", "Trees"],
  ];
  for (const [id, label] of ariaContracts) {
    assert.equal(world.el(id).getAttribute("aria-label"), label, `#${id} aria-label`);
  }

  /* 输入面契约：placeholder / aria-label。 */
  assert.equal(world.el("prompt-input").getAttribute("placeholder"), "Ask on the Trunk…");
  assert.equal(world.el("panel-prompt-input").getAttribute("placeholder"), "Continue this branch…");
  assert.equal(world.el("return-input").getAttribute("aria-label"), "Return draft");

  /* 引导：自动打开第一棵树 → 主视图可见、每分支恰好一个 tab。 */
  assert.equal(world.el("tree-view").hidden, false, "tree view visible after auto-open");
  const tabs = world.el("branch-tabs").querySelectorAll("button");
  assert.equal(tabs.length, 2, "one tab per branch (Trunk + Branch 1)");
  assert.equal(tabs[0]!.dataset.branchId, "trunk-1");
  assert.ok(tabs[0]!.textContent.includes("Trunk"));
  assert.equal(tabs[1]!.dataset.branchId, "branch-1");
  assert.ok(tabs[1]!.textContent.includes("Branch 1"));

  /* turn 角色与 Return 卡锚点定位：u/a 交替，锚定 Return 紧随锚点答案。 */
  const turns = world.el("conversation").querySelectorAll(".turn");
  assert.deepEqual(
    turns.map((t) => t.dataset.turnId),
    ["u1", "a1", "r0", "u2", "a2"],
  );
  assert.ok(turns[0]!.classList.contains("user"), "turn roles render (user)");
  assert.ok(turns[1]!.classList.contains("assistant"), "turn roles render (assistant)");
  const returnCard = turns[2]!;
  assert.ok(returnCard.classList.contains("return"), "anchored Return renders immediately after its anchor turn");
  assert.ok(returnCard.textContent.includes("↩ Return from Branch 1"));
  assert.ok(returnCard.textContent.includes("anchored on “First” from Branch 1"), "meta carries the anchor excerpt");
  assert.ok(
    returnCard.textContent.includes("confirmed — delivered on the next Trunk prompt"),
    "undelivered Return shows the confirmed badge",
  );

  /* 流式占位形态：run-started 后 streaming turn + 静态 caret（不闪烁）。 */
  world.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
  const placeholder = world.byId("streaming-turn");
  assert.ok(placeholder !== null, "run-started appends the streaming placeholder");
  assert.equal(placeholder.className, "turn assistant streaming-turn");
  const caret = placeholder.querySelector(".streaming-caret");
  assert.ok(caret !== null, "streaming placeholder carries the caret indicator");
  assert.equal(caret.textContent, " ▍ streaming…");
});

/* ------------------------------------------------------------------ */
/* 2. journal 三态：失败 + 重试 + 如实空态；Esc 焦点还原                 */
/* ------------------------------------------------------------------ */

test("journal drawer: failure with retry, honest empty state, Esc focus restore", async () => {
  const world = await createWorld({ journalMode: "fail" });
  const drawer = world.el("source-drawer");

  /* 打开 → 先呈现加载中，失败落失败态（绝不伪装成「无事件」）。 */
  world.el("source-drawer-toggle").click();
  assert.equal(drawer.hidden, false, "drawer opens");
  assert.ok(drawer.textContent.includes("loading journal…"), "loading state shows while fetching");
  await settle();
  assert.ok(drawer.textContent.includes("journal failed to load"), "failed fetch renders the failure state");
  assert.ok(!drawer.textContent.includes("no journal events"), "failure is not masqueraded as 'no events'");
  const retryButton = drawer.querySelector(".drawer-retry");
  assert.ok(retryButton !== null, "failure state renders a Retry button");
  assert.equal(retryButton.textContent, "Retry");
  assert.equal(world.document.activeElement, drawer, "drawer open moves focus into the drawer");

  /* Esc 关抽屉：焦点还原到触发元素。 */
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.equal(world.document.activeElement, world.el("source-drawer-toggle"), "Esc restores focus to the toggle");
  await sleep(220);
  assert.equal(drawer.hidden, true, "drawer closed after Esc");

  /* 重试路径：再开仍失败 → 后端恢复 → Retry 回到加载中 → 列表渲染。 */
  world.el("source-drawer-toggle").click();
  await settle();
  assert.ok(drawer.textContent.includes("journal failed to load"), "second open fails again (scripted)");
  world.backend.journalMode = "ok-events";
  const retryAgain = drawer.querySelector(".drawer-retry");
  assert.ok(retryAgain !== null);
  retryAgain.click();
  assert.ok(drawer.textContent.includes("loading journal…"), "retry returns to the loading state first");
  await settle();
  assert.ok(drawer.textContent.includes("run-started — run started on Trunk"), "successful retry renders the journal list");
  assert.ok(!drawer.textContent.includes("journal failed to load"), "failure message gone after the successful retry");
  assert.equal(world.requestsOf("/journal").length, 3, "journal fetched on open + reopen + retry (3 calls)");

  /* 如实空态：成功且无事件 ≠ 失败。 */
  world.el("source-drawer-toggle").click(); /* toggle 关闭 */
  await settle();
  world.backend.journalMode = "ok-empty";
  world.el("source-drawer-toggle").click();
  await settle();
  assert.ok(
    drawer.textContent.includes("no journal events recorded for this tree yet"),
    "loaded-empty shows the honest empty message",
  );
  assert.ok(!drawer.textContent.includes("journal failed to load"), "loaded-empty is not a failure state");
  world.el("source-drawer-toggle").click();
  await settle();
});

/* ------------------------------------------------------------------ */
/* 3. 面板降级：恢复按钮（精确 POST /branches 载荷）+ fail-closed 保持    */
/* ------------------------------------------------------------------ */

test("branch panel degradation: recovery action posts an exact whole-answer /branches body, composer stays fail-closed", async () => {
  const world = await createWorld();

  /* 真实路径：tab 点击 → POST /switch → 面板打开。 */
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  const switchBefore = world.backend.switchCount;
  tab.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "branch-1 panel opens via tab");
  assert.equal(world.el("panel-title").textContent, "Branch 1");
  assert.equal(world.el("panel-session-note").hidden, true, "available branch shows no degraded note");
  assert.equal(world.backend.switchCount, switchBefore + 1, "tab open aligns the cursor via POST /switch");
  assert.equal(world.document.activeElement, world.el("panel-prompt-input"), "panel open focuses the panel input");

  /* session 消失（run-terminal → /state 刷新）：降级提示常驻 + 恢复按钮。 */
  world.setAvailability("branch-1", "unavailable");
  world.liveSse().emit("run-terminal", { runId: "run-m0" });
  await settle();
  const note = world.el("panel-session-note");
  assert.equal(note.hidden, false, "unavailable branch: degraded note is persistent (not hidden)");
  const recovery = note.querySelector(".session-recovery-button");
  assert.ok(recovery !== null, "note contains the recovery action button");
  assert.ok(recovery.textContent.includes("Branch from latest available answer"));
  assert.equal(recovery.disabled, false, "recovery enabled while the trunk session is still available");
  assert.ok(recovery.title.includes("Trunk"), "button title names the recovery source branch");
  assert.equal(world.el("panel-send").disabled, true, "fail-closed: unavailable branch composer stays disabled");
  assert.equal(world.el("panel-prompt-input").disabled, true, "fail-closed: unavailable branch input stays disabled");

  /* 恢复：面板容器度量预设（首渲染贴底断言用）→ 从 trunk 最新 assistant
     答案（a2）整条建支线。 */
  const panelConversation = world.el("panel-conversation");
  panelConversation.scrollHeight = 1500;
  panelConversation.clientHeight = 400;
  const switchBeforeRecovery = world.backend.switchCount;
  recovery.click();
  await settle();

  const branchPost = world.lastRequest("/branches");
  assert.ok(branchPost !== null && branchPost.method === "POST", "recovery issues POST /branches");
  const body = asRecord(branchPost.body);
  assert.ok(body !== null);
  const selection = asRecord(body.selection);
  assert.ok(selection !== null);
  assert.equal(body.sourceBranchId, "trunk-1");
  assert.equal(body.anchorTurnId, "a2");
  assert.equal(selection.start, 0);
  assert.equal(selection.end, A2_TEXT.length);
  assert.equal(selection.text, A2_TEXT);
  assert.equal(
    world.backend.switchCount,
    switchBeforeRecovery,
    "recovery does NOT POST /switch (alignCursor:false, prompt-driven navigation)",
  );
  assert.equal(world.el("panel-title").textContent, "Branch 2", "recovery opens the new branch's panel");
  assert.equal(
    world.el("panel-session-note").hidden,
    true,
    "new branch has no degraded note (continuation point available by construction)",
  );
  assert.equal(world.el("panel-send").disabled, false, "new branch composer enabled — the continuation point is usable");
  assert.equal(world.el("panel-prompt-input").disabled, false, "new branch input enabled");
  assert.equal(panelConversation.scrollTop, 1500, "first render of the new view lands at the bottom");
  assert.equal(panelConversation.lastScrollBehavior, "auto", "first render lands instantly (no smooth yank)");
  assert.equal(world.document.activeElement, world.el("panel-prompt-input"), "focus moves into the recovered branch's composer");
  assert.equal(world.el("send").disabled, false, "trunk composer unaffected (trunk session available)");
});

/* ------------------------------------------------------------------ */
/* 4. Return：草稿持久化 + 双击防抖 + 提交收尾                          */
/* ------------------------------------------------------------------ */

test("return flow: draft persistence with idempotency key, double-submit guard, submit finalization", async () => {
  const world = await createWorld();
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();

  const returnInput = world.el("return-input");
  returnInput.value = "Returned: the branch conclusion.";
  returnInput.dispatchEvent("input", {});
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  const stored = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(stored !== null, "return draft persisted to localStorage (treeai-return-draft:<tree>:<branch>)");
  assert.ok(stored.text.includes("Returned: the branch conclusion."));
  assert.ok(stored.idempotencyKey.length > 0, "persisted draft carries the idempotency key");

  world.backend.returnDelay = true;
  world.el("submit-return").click();
  world.el("submit-return").click(); /* 双击：第二次应被 busy 防抖拦下 */
  await settle();
  await sleep(220);

  const returnPosts = world.requestsOf("/return");
  assert.equal(returnPosts.length, 1, "double-submit guard: exactly one POST /return");
  const body = asRecord(returnPosts[0]!.body);
  assert.ok(body !== null);
  assert.equal(body.fromBranchId, "branch-1");
  assert.equal(body.text, "Returned: the branch conclusion.");
  assert.equal(typeof body.idempotencyKey, "string");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "successful submit clears the persisted draft");
  assert.equal(world.el("branch-panel").hidden, true, "panel closes after Return submission");
  assert.equal(world.document.activeElement, world.el("prompt-input"), "focus returns to the main input after Return");
  const conversation = world.el("conversation");
  assert.ok(conversation.textContent.includes("Return from Branch 1"), "Return card renders in the trunk near its anchor");
  assert.ok(conversation.textContent.includes("Returned: the branch conclusion."), "Return card carries the submitted text");
  /* 锚点定位：Return 卡紧随锚点答案（a2）之后渲染。 */
  assert.deepEqual(
    conversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["u1", "a1", "u2", "a2", "r-1"],
  );
});

/* ------------------------------------------------------------------ */
/* 5. Return 失败语义：响应丢失对账 / 失败保留草稿 / 改写换键 / 重试     */
/* ------------------------------------------------------------------ */

test("return failure semantics: response-loss reconciliation, draft kept on failure, rekey on edit", async () => {
  const world = await createWorld();
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  const openPanel = async (): Promise<void> => {
    const tab = world.tabButton("branch-1");
    assert.ok(tab !== null);
    tab.click();
    await settle();
  };
  const returnInput = world.el("return-input");
  await openPanel();

  /* 响应丢失对账（先做——保证错误横幅无历史残留）：服务端已落库、响应
     失败 → /state 同键命中即按成功处理，不重复提交、不报错。 */
  returnInput.value = "Lost-response conclusion.";
  returnInput.dispatchEvent("input", {});
  const lostDraft = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(lostDraft !== null);
  world.backend.returnMode = "lose-response";
  world.el("submit-return").click();
  await settle();
  await sleep(220);
  const lostPosts = world.requestsOf("/return").filter((r) => {
    const b = asRecord(r.body);
    return b !== null && b.idempotencyKey === lostDraft.idempotencyKey;
  });
  assert.equal(lostPosts.length, 1, "response loss does not duplicate the submission");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "reconciliation hit clears the draft (treated as success)");
  assert.equal(world.el("branch-panel").hidden, true, "panel closes after reconciliation");
  assert.equal(world.el("panel-error-banner").hidden, true, "reconciliation success shows no error");
  assert.ok(world.el("conversation").textContent.includes("Lost-response conclusion."), "the server-recorded return renders in the trunk");

  /* 失败：草稿与键保留（localStorage），错误呈现在面板横幅。 */
  await openPanel();
  returnInput.value = "My conclusion.";
  returnInput.dispatchEvent("input", {});
  world.backend.returnMode = "fail";
  world.el("submit-return").click();
  await settle();
  assert.equal(world.requestsOf("/return").length, 2, "the failed submit is one POST");
  const failedDraft = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(failedDraft !== null, "failed submit keeps the persisted draft");
  assert.equal(failedDraft.text, "My conclusion.");
  const banner = world.el("panel-error-banner");
  assert.equal(banner.hidden, false, "failure surfaces in the panel error banner");
  assert.ok(banner.textContent.includes("return rejected"), "banner carries the backend failure message");

  /* 失败后编辑 = 新的逻辑提交：换新键（旧键可能已被服务端绑定到旧文本）。 */
  returnInput.value = "Edited conclusion.";
  returnInput.dispatchEvent("input", {});
  const rekeyedDraft = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(rekeyedDraft !== null);
  assert.equal(rekeyedDraft.text, "Edited conclusion.");
  assert.notEqual(rekeyedDraft.idempotencyKey, failedDraft.idempotencyKey, "editing a failed draft regenerates the idempotency key");

  /* 重试（改写后的键）：成功即清草稿、收面板、焦点回主线。 */
  world.backend.returnMode = "ok";
  world.el("submit-return").click();
  await settle();
  await sleep(220);
  const posts = world.requestsOf("/return");
  assert.equal(posts.length, 3);
  const retryBody = asRecord(posts[2]!.body);
  assert.ok(retryBody !== null);
  assert.equal(retryBody.idempotencyKey, rekeyedDraft.idempotencyKey, "the retried submit carries the regenerated key");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "success clears the persisted draft");
  assert.equal(world.el("branch-panel").hidden, true, "panel closes after the successful retry");
  assert.equal(world.document.activeElement, world.el("prompt-input"), "focus returns to the main input");
});

/* ------------------------------------------------------------------ */
/* 6. Esc 焦点还原（面板 → 触发 tab）                                    */
/* ------------------------------------------------------------------ */

test("Esc on the branch panel closes it and restores focus to the triggering tab", async () => {
  const world = await createWorld();
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "branch panel opens via tab");

  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle();
  const active = world.document.activeElement;
  assert.ok(
    active !== null && active.tagName === "BUTTON" && active.dataset.branchId === "branch-1",
    "focus is restored to the triggering branch tab",
  );
  await sleep(220);
  assert.equal(world.el("branch-panel").hidden, true, "panel is hidden after the exit animation");
});

/* ------------------------------------------------------------------ */
/* 7. 流式滚动纪律：向上阅读绝不强制滚底                                 */
/* ------------------------------------------------------------------ */

test("streaming scroll discipline: a scrolled-up reader is never yanked to the bottom", async () => {
  const world = await createWorld();
  const conversation = world.el("conversation");
  conversation.scrollHeight = 4000;
  conversation.clientHeight = 600;
  conversation.scrollTop = 50; /* 用户向上阅读（saved = 50） */

  world.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
  assert.ok(world.byId("streaming-turn") !== null, "run-started appends the streaming placeholder");
  assert.equal(conversation.scrollTop, 50, "run-started (stick render) does NOT yank a scrolled-up reader");

  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Alpha " });
  assert.equal(conversation.scrollTop, 50, "message-delta does NOT change scrollTop while scrolled up");
  assert.ok(world.el("streaming-turn").textContent.includes("Alpha"), "delta text renders into the placeholder");
  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Beta " });
  assert.equal(conversation.scrollTop, 50, "a second delta still does not move a scrolled-up reader");

  conversation.scrollTop = 3400; /* 3400 + 600 = 4000，位于 48px 贴底阈值内 */
  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Gamma" });
  assert.equal(conversation.scrollTop, 4000, "an at-bottom reader follows the delta to the bottom");

  const trunk = world.backend.treeState.branches.find((v) => v.branch.id === "trunk-1");
  assert.ok(trunk !== undefined);
  trunk.turns.push(makeTurn("a3", "trunk-1", "assistant", "Streamed final answer."));
  world.liveSse().emit("run-terminal", { runId: "run-s" });
  await settle();
  assert.equal(conversation.scrollTop, 4000, "an at-bottom reader stays pinned across the terminal /state refresh");
  assert.ok(conversation.textContent.includes("Streamed final answer."), "terminal refresh renders the authoritative turn");
  assert.ok(world.byId("streaming-turn") === null, "the streaming placeholder is replaced by the authoritative render");

  conversation.scrollTop = 1200; /* 再次向上阅读 */
  world.liveSse().emit("run-started", { runId: "run-t", branchId: "trunk-1", episodeId: "ep-1" });
  assert.equal(conversation.scrollTop, 1200, "a new stick render preserves the scrolled-up position (no yank)");
  world.liveSse().emit("run-terminal", { runId: "run-t" });
  await settle();
  assert.equal(conversation.scrollTop, 1200, "the terminal refresh also preserves the scrolled-up position");
});

/* ------------------------------------------------------------------ */
/* 8. 主线横幅：无候选禁用 + 原因；跨分支恢复（精确载荷，fail-closed 不放松） */
/* ------------------------------------------------------------------ */

test("trunk session banner: disabled with reason when nothing is available; cross-branch recovery posts an exact body", async () => {
  const world = await createWorld();
  const banner = world.el("session-banner");

  /* 全分支不可用：横幅 + 禁用按钮 + 原因 + Dismiss + fail-closed 主线输入。 */
  for (const view of world.backend.treeState.branches) view.sessionAvailability = "unavailable";
  const treeButton = world.el("tree-list").querySelectorAll("button")[0];
  assert.ok(treeButton !== undefined);
  treeButton.click(); /* 重新 openTree → 刷新读模型 */
  await settle();

  assert.equal(banner.hidden, false, "trunk unavailable: session banner shows");
  const bannerButton = banner.querySelector(".session-recovery-button");
  assert.ok(bannerButton !== null);
  assert.equal(bannerButton.disabled, true, "no available branch anywhere: recovery button disabled");
  const reason = banner.querySelector(".session-recovery-reason");
  assert.ok(reason !== null);
  assert.equal(
    reason.textContent,
    "no session currently available — start a new Tree or restore the session file",
    "the disabled state explains the reason",
  );
  assert.ok(banner.querySelector(".session-banner-dismiss") !== null, "banner keeps its Dismiss control");
  assert.equal(world.el("send").disabled, true, "fail-closed: trunk composer disabled while the trunk session is missing");
  assert.equal(world.el("prompt-input").disabled, true, "fail-closed: trunk input disabled while the trunk session is missing");

  /* Trunk 不可用、branch-1 可用：候选 = branch-1 的最新 assistant 答案（ba1）。 */
  world.setAvailability("branch-1", "available");
  treeButton.click();
  await settle();
  const bannerButton2 = banner.querySelector(".session-recovery-button");
  assert.ok(bannerButton2 !== null);
  assert.equal(bannerButton2.disabled, false, "branch-1 available again: recovery button enabled");
  assert.ok(bannerButton2.title.includes("Branch 1"), "button title names branch-1 as the recovery source");

  const switchBefore = world.backend.switchCount;
  bannerButton2.click();
  await settle();
  const branchPost = world.lastRequest("/branches");
  assert.ok(branchPost !== null);
  const body = asRecord(branchPost.body);
  assert.ok(body !== null);
  const selection = asRecord(body.selection);
  assert.ok(selection !== null);
  assert.equal(body.sourceBranchId, "branch-1");
  assert.equal(body.anchorTurnId, "ba1");
  assert.equal(selection.start, 0);
  assert.equal(selection.end, BA1_TEXT.length);
  assert.equal(selection.text, BA1_TEXT);
  assert.equal(world.backend.switchCount, switchBefore, "banner recovery also skips POST /switch (alignCursor:false)");
  assert.equal(world.el("branch-panel").hidden, false, "banner recovery opens the new branch's panel");
  assert.equal(world.el("panel-title").textContent, "Branch 2", "panel shows the newly created branch");
  assert.equal(world.el("panel-send").disabled, false, "recovered branch composer enabled");
  assert.equal(world.document.activeElement, world.el("panel-prompt-input"), "focus moves into the recovered branch's composer");
  assert.equal(world.el("send").disabled, true, "recovery does NOT unlock the fail-closed trunk composer");
  assert.equal(world.el("session-banner").hidden, false, "banner persists (trunk still unavailable) until the trunk recovers");
});
