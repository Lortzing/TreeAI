/**
 * Studio 前端回归套件 —— W1 contract v2.0 审计缺陷修复的回归面。
 *
 * 方法与 ui-probe 套件一致（issue #4 P1「证据工程化」的脚本化 DOM E2E）：
 * 以 file: URL 加载仓库真实 public/app.js 为 ES module（URL query 随机化
 * 绕过模块缓存——每个场景一份全新实例），运行在「按真实 public/index.html
 * 词法解析出的完整 DOM 桩 + 脚本化后端」之上：fetch / EventSource /
 * localStorage / 计时器 / matchMedia / getSelection 全部为内存桩。无网络、
 * 无磁盘写入、无长等待（仅面板退场动画所需的短 sleep），确定性可复现。
 * 本文件自包含（不依赖未跟踪的 ui-probe.test.ts——两套件可独立运行）。
 *
 * 覆盖（本次审计缺陷的回归锁定）：
 *  1. prompt 失败终局渲染是硬保证（含 session-corrupt、SSE 零事件）：
 *     恢复横幅 / 面板降级提示出现、流式占位清除、原始错误可见、输入文本
 *     保留、失败 run 进入诊断面——全部在错误上抛之前落位（缺陷 1）。
 *  2. session 横幅 dismiss 为页面级持久状态：重渲（终态刷新 / 面板开合）
 *     不复活；仅主干恢复可用、或用户执行恢复动作时清除（缺陷 2）。
 *  3. Return 同键异容 409（W1 §2.3 冲突语义的客户端面）：草稿 / 面板 /
 *     已编辑文本保留、显式冲突提示、编辑换新键后重提成功；对账谓词的
 *     分支维度（同键同文不同分支同为冲突）（缺陷 3）。
 *  4. 响应丢失对账按（幂等键 + fromBranchId + 文本）全同命中 → 按成功
 *     处理，不重复提交（缺陷 3 的正向面）。
 *  5. 面板打开时的持久草稿对账：已落库的草稿被丢弃（localStorage 一并
 *     清除），树面呈现 confirmed/delivered 卡；显式新提交使用新键（缺陷 6）。
 *  6. 降级 revealOrigin 先落地服务端返回的 payload.state：徽标 / 降级提示
 *     与降级错误一致，绝不「错误说降级、徽标仍 available」（缺陷 4）。
 *  7. submitReturn 收尾（closePanel / 游标对齐）失败呈现在主线可见横幅，
 *     不落进已收起面板的隐藏横幅、也不吞错（缺陷 5）。
 *  8. issue #6 P1 补齐面的回归锁定：错误横幅朗读语义（role="alert" +
 *     tabindex="0"，可见时可 Tab 触达并朗读——§2.4）；揭示降级焦点移到
 *     说明区（面板锚点上下文，常驻——§2.6）。
 *
 * 边界（如实声明）：同 ui-probe——不是真实浏览器 E2E；全局桩是与无类型
 * 前端脚本的唯一动态接面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* 加载真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const A2_TEXT = "Second trunk answer — the latest one.";
const BA1_TEXT = "Branch one answer.";
const B2_TEXT = "Branch two answer.";

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

interface RunDiagnostics {
  runId: string;
  branchId: string;
  episodeId: string;
  state: string;
  failure: { code: string; message: string } | null;
  createdAt: string;
  terminalAt: string | null;
}

interface TreeDiagnostics {
  treeId: string;
  runtimeState: "idle" | "streaming" | "aborting";
  activeRun: { runId: string; branchId: string; episodeId: string } | null;
  runs: RunDiagnostics[];
  policyDecisions: { observed: boolean; reason: string };
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
  returnAttempts: ReturnAttempt[] = [],
): BranchView {
  return { branch, origin, originStatus: origin === null ? null : "available", sessionAvailability, turns, returnAttempts };
}

/** 预置到 trunk 的已落库 Return（冲突 / 对账命中场景的服务端种子）。 */
interface SeedReturn {
  key: string;
  fromBranchId: string;
  text: string;
  deliveredRunId?: string;
}

function freshBackendState(seedReturns: SeedReturn[]): TreeState {
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const b1Branch: Branch = { id: "branch-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
  const trunkTurns: Turn[] = [
    makeTurn("u1", "trunk-1", "user", "First trunk question."),
    makeTurn("a1", "trunk-1", "assistant", "First trunk answer."),
    makeTurn("u2", "trunk-1", "user", "Second trunk question."),
    makeTurn("a2", "trunk-1", "assistant", A2_TEXT),
  ];
  for (const [index, seed] of seedReturns.entries()) {
    trunkTurns.push(
      makeTurn(`r-seed-${index + 1}`, "trunk-1", "return", seed.text, {
        runId: null,
        piEntryId: null,
        fromBranchId: seed.fromBranchId,
        deliveredRunId: seed.deliveredRunId ?? null,
        idempotencyKey: seed.key,
        targetAnchor: {
          sourceBranchId: seed.fromBranchId,
          anchorTurnId: "a2",
          anchorEntryId: "pi-a2",
          selection: { start: 0, end: 5, text: "Secon" },
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

/** POST /prompt 的脚本化失败（null = 成功）。emitRunStarted = 返回失败响应前
 *  先推一条 SSE run-started（模拟「占位已出现、prompt 才失败」）。 */
interface PromptFailure {
  code: string;
  message: string;
  emitRunStarted: boolean;
}

interface Backend {
  trees: Tree[];
  treeState: TreeState;
  diagnostics: TreeDiagnostics;
  journalEvents: JournalEvent[];
  requests: RecordedRequest[];
  switchCount: number;
  switchMode: "ok" | "fail";
  returnMode: "ok" | "lose-response" | "fail";
  /** /return 保存后的回程导航结果脚本（signed v3 §3.5：保存与导航分离）。 */
  returnNavigation: "ok" | "fail";
  promptFailure: PromptFailure | null;
  sourceMode: "ok" | "degraded";
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

/** 服务端同键探查（对齐 service.ts findReturnByIdempotencyKey 的客户端侧镜像）。 */
function findSeededReturn(treeState: TreeState, idempotencyKey: string | null): Turn | null {
  if (idempotencyKey === null) return null;
  for (const view of treeState.branches) {
    for (const turn of view.turns) {
      if (turn.role === "return" && turn.idempotencyKey === idempotencyKey) return turn;
    }
  }
  return null;
}

/* ------------------------------ 事件轮转 / 短等待 ------------------------------ */

/** 每轮走一次 timers 阶段：app.js 的 busy 延迟聚焦等 setTimeout(0) 回调需要
 *  真实计时器轮转，纯 microtask 轮转会漏掉它们。 */
const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 面板退场动画（PANEL_EXIT_MS = 170ms）收尾所需的短等待。 */
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

  /** insertBefore（真实 DOM 语义：ref 为 null/undefined 时等价 appendChild；
      已挂载节点重挂即移动到指定位）。issue #7 C ③ 正文/操作分层的按位调和
      （reconcileTopLevel）使用——仅为桩面能力补齐，不改变任何既有断言。 */
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
    this.scrollTop = options.top;
  }

  scrollIntoView(options?: unknown): void {
    /* no-op：真实浏览器滚动定位不在桩覆盖范围（视觉边界，见文件头）。 */
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
  /** 新探索二次确认（v3 §4.4）：脚本化返回值，调用消息被记录。 */
  confirm(message: string): boolean;
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
  /** POST /prompt 的脚本化失败（缺省成功）。 */
  promptFailure?: PromptFailure;
  /** POST /return 的场景模式（缺省 ok）。 */
  returnMode?: Backend["returnMode"];
  /** /return 响应的 navigation 字段脚本（保存后导航失败场景）。 */
  returnNavigation?: Backend["returnNavigation"];
  /** POST /branches/:id/source 的场景（缺省 ok = available）。 */
  sourceMode?: Backend["sourceMode"];
  /** 预置到 trunk 的已落库 Return 种子（服务端幂等语义按键 + 内容裁决）。 */
  seedReturns?: SeedReturn[];
}

let appLoadCounter = 0;

/**
 * 构建一套全新场景环境：真实 index.html 解析出的 DOM 桩 + 脚本化后端 +
 * 全局桩注入 + 全新 app.js 模块实例（query 随机化绕过模块缓存），
 * 等待引导（自动打开第一棵树）完成。场景之间完全隔离（DOM、后端、
 * localStorage、SSE 注册表、模块级前端状态各自独立）。
 */
async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  /* ---------------- window / localStorage 桩 ---------------- */

  const localStorageStore = new Map<string, string>();
  /* window.confirm 脚本（v3 §4.4 新探索二次确认）：默认确认。 */
  const confirmCalls: string[] = [];
  let confirmResult = true;
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
    getSelection: () => ({ rangeCount: 0 }),
    confirm: (message) => {
      confirmCalls.push(message);
      return confirmResult;
    },
  };

  /* ---------------- 脚本化后端 ---------------- */

  const backend: Backend = {
    trees: [{ id: TREE, createdAt: ISO, forestId: "forest-1" }],
    treeState: freshBackendState(options.seedReturns ?? []),
    diagnostics: {
      treeId: TREE,
      runtimeState: "idle",
      activeRun: null,
      runs: [],
      policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
    },
    journalEvents: JOURNAL_EVENTS,
    requests: [],
    switchCount: 0,
    switchMode: "ok",
    returnMode: options.returnMode ?? "ok",
    returnNavigation: options.returnNavigation ?? "ok",
    promptFailure: options.promptFailure ?? null,
    sourceMode: options.sourceMode ?? "ok",
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
    let m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") return respond(200, backend.treeState);
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") return respond(200, backend.diagnostics);
    m = /^\/api\/trees\/([^/]+)\/journal$/.exec(p);
    if (m !== null && method === "GET") return respond(200, { events: backend.journalEvents });
    m = /^\/api\/trees\/([^/]+)\/switch$/.exec(p);
    if (m !== null && method === "POST") {
      if (backend.switchMode === "fail") {
        return respond(500, { error: { code: "internal", message: "switch rejected (scripted failure)" } });
      }
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
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(p);
    if (m !== null && method === "POST") {
      if (backend.sourceMode === "degraded") {
        /* 服务端语义（W1 §3.4）：锚点 session 缺失 → 揭示降级，读模型如实
           标记受影响分支 session 不可用（state 随响应返回）。 */
        const view = viewByBranch(decodeURIComponent(m[2]!));
        if (view !== undefined) view.sessionAvailability = "unavailable";
        return respond(200, {
          source: {
            sourceBranchId: "trunk-1",
            anchorTurnId: "a1",
            status: "changed",
            selection: { start: 0, end: 5, text: "First" },
          },
          state: backend.treeState,
        });
      }
      return respond(200, {
        source: {
          sourceBranchId: "trunk-1",
          anchorTurnId: "a1",
          status: "available",
          selection: { start: 0, end: 5, text: "First" },
        },
        state: backend.treeState,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/return$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /return body must be an object");
      const fromBranchId = String(record.fromBranchId ?? "");
      const text = String(record.text ?? "");
      const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey : null;
      /* 服务端幂等语义（W1 §2.3）：同键同（fromBranchId + text）→ 200 重放
         （零新写入）；同键异容 → 409 return-conflict（零写入）。两种成功
         均携带 navigation（signed v3 §3.5：保存后导航结果分离返回）。 */
      const navigation =
        backend.returnNavigation === "fail"
          ? {
              status: "failed",
              code: "session-corrupt",
              message: "simulated navigation failure — the session store is damaged",
            }
          : { status: "navigated" };
      const existing = findSeededReturn(backend.treeState, idempotencyKey);
      if (existing !== null) {
        if (existing.fromBranchId === fromBranchId && existing.text === text) {
          return respond(200, { returnTurn: existing, navigation, state: backend.treeState });
        }
        return respond(409, {
          error: {
            code: "return-conflict",
            message: `return idempotency key '${idempotencyKey}' is already bound to return ${existing.id} with different content; use a new idempotency key for a new submission`,
          },
        });
      }
      if (backend.returnMode !== "fail") {
        /* 服务端先落库（lose-response 模式同样如此：响应丢失但记录已成功）。 */
        const returnCount = backend.requests.filter((r) => r.path.split("?")[0]!.endsWith("/return")).length;
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
        return respond(201, { returnTurn, navigation, state: backend.treeState });
      }
      return respond(500, { error: { code: "internal", message: "return rejected (scripted failure)" } });
    }
    m = /^\/api\/trees\/([^/]+)\/prompt$/.exec(p);
    if (m !== null && method === "POST") {
      const branchId = typeof asRecord(body)?.branchId === "string" ? String(asRecord(body)?.branchId) : "trunk-1";
      if (backend.promptFailure !== null) {
        /* 失败前可先推 run-started（模拟「占位已出现、prompt 才失败」）。 */
        if (backend.promptFailure.emitRunStarted) {
          StubEventSource.latest()?.emit("run-started", { runId: "run-f1", branchId, episodeId: "ep-1" });
        }
        /* 服务端语义（W1 §3.4）：session 缺失的 prompt fail-closed；读模型
           如实标记该分支 session 不可用；run 收敛为 failed（诊断面可见）。 */
        const view = viewByBranch(branchId);
        if (view !== undefined) view.sessionAvailability = "unavailable";
        backend.diagnostics = {
          treeId: TREE,
          runtimeState: "idle",
          activeRun: null,
          runs: [
            ...backend.diagnostics.runs,
            {
              runId: "run-f1",
              branchId,
              episodeId: "ep-1",
              state: "failed",
              failure: { code: backend.promptFailure.code, message: backend.promptFailure.message },
              createdAt: ISO,
              terminalAt: ISO,
            },
          ],
          policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
        };
        return respond(502, { error: { code: backend.promptFailure.code, message: backend.promptFailure.message } });
      }
      return respond(200, { outcome: { kind: "completed" }, state: backend.treeState });
    }
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

  /* file: URL 的 fragment 不进入模块源码（只区分模块身份），据此绕过 ES
     模块缓存：每个场景加载一份全新 app.js 实例，模块级状态互不渗透。 */
  appLoadCounter += 1;
  await import(new URL(`../public/app.js?load=${appLoadCounter}`, import.meta.url).href);
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

/** 打开 branch-1 面板（tab 点击 → POST /switch → 面板打开）。 */
async function openBranchOnePanel(world: World): Promise<void> {
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null, "branch-1 tab exists");
  tab.click();
  await settle();
}

/* ------------------------------------------------------------------ */
/* 1. prompt 失败终局渲染（缺陷 1）：占位清除 + 恢复横幅 + 错误可见      */
/* ------------------------------------------------------------------ */

test("trunk prompt failure: streaming placeholder cleared, recovery banner rendered, error visible — all before the error is rethrown", async () => {
  const world = await createWorld({
    promptFailure: { code: "session-corrupt", message: "the session file for this branch is missing", emitRunStarted: true },
  });
  const input = world.el("prompt-input");
  input.value = "Please continue.";

  world.el("send").click();
  /* run-started 在 fetch 桩内同步推送：click 返回时占位已出现。 */
  assert.ok(world.byId("streaming-turn") !== null, "run-started (emitted inside the scripted prompt failure) appends the streaming placeholder");
  await settle();

  /* 失败终局：占位清除——不依赖任何 run-terminal 事件收尾。 */
  assert.ok(world.byId("streaming-turn") === null, "failed prompt clears the streaming placeholder without a run-terminal event");

  /* session-corrupt → 可执行恢复横幅（不只有瞬时错误横幅）。 */
  const banner = world.el("session-banner");
  assert.equal(banner.hidden, false, "session-corrupt failure renders the recovery banner");
  assert.ok(banner.textContent.includes("Session missing on this branch"), "banner explains the fail-closed state");
  const recovery = banner.querySelector(".session-recovery-button");
  assert.ok(recovery !== null, "banner carries the executable recovery action");
  assert.equal(recovery.disabled, false, "recovery is executable (branch-1 still available)");
  assert.ok(recovery.title.includes("Branch 1"), "recovery title names the available source branch");

  /* 主线错误横幅可见（原始错误不被吞、不被降级刷新掩盖）。 */
  const error = world.el("error-banner");
  assert.equal(error.hidden, false, "the original session-corrupt error is visible");
  assert.ok(error.textContent.includes("session-corrupt"), "the visible error carries the failure code");
  assert.ok(error.textContent.includes("session file for this branch is missing"), "the visible error carries the failure message");
  assert.equal(error.getAttribute("role"), "alert", "§2.4: the visible main banner carries role=alert (announced)");
  assert.equal(error.getAttribute("tabindex"), "0", "§2.4: the visible main banner is Tab-reachable");

  /* 输入文本保留（改写重发）；fail-closed：session 不可用后发送禁用，输入
     保持可输入（v3 §4.4：新探索首问的输入面）。 */
  assert.equal(input.value, "Please continue.", "the unsent prompt text is retained for editing");
  assert.equal(world.el("send").disabled, true, "fail-closed: trunk composer disabled after session-corrupt");
  assert.equal(world.el("prompt-input").disabled, false, "v3 §4.4: the input stays typed-in for the new exploration");
  assert.equal(world.el("new-exploration").hidden, false, "v3 §4.4: the new-exploration entry appears after session-corrupt");

  /* 诊断面终局：失败 run 呈现（不停留在 streaming 中间态）。 */
  assert.equal(world.el("run-status").textContent, "idle", "runtime state returns to idle");
  assert.ok(
    world.el("failure-panel").textContent.includes("session-corrupt"),
    "the failed run is rendered in the failure panel",
  );
});

/* ------------------------------------------------------------------ */
/* 1b. 面板分支 prompt 失败、SSE 零事件：降级提示 + 错误可见、无残留占位  */
/* ------------------------------------------------------------------ */

test("panel prompt failure with zero SSE events: degraded note with executable recovery, visible error, no stale placeholder", async () => {
  const world = await createWorld({
    promptFailure: { code: "session-corrupt", message: "the session file for this branch is missing", emitRunStarted: false },
  });
  await openBranchOnePanel(world);
  const input = world.el("panel-prompt-input");
  input.value = "Continue here.";

  world.el("panel-send").click();
  await settle();

  assert.ok(world.byId("streaming-turn") === null, "no stale streaming placeholder (SSE emitted nothing)");
  const note = world.el("panel-session-note");
  assert.equal(note.hidden, false, "session-corrupt panel failure renders the degraded note");
  const recovery = note.querySelector(".session-recovery-button");
  assert.ok(recovery !== null, "the note carries the executable recovery action");
  assert.equal(recovery.disabled, false, "recovery is executable (trunk still available)");
  const error = world.el("panel-error-banner");
  assert.equal(error.hidden, false, "the original error is visible in the panel banner");
  assert.ok(error.textContent.includes("session-corrupt"), "the visible error carries the failure code");
  assert.equal(error.getAttribute("role"), "alert", "§2.4: the visible panel banner carries role=alert (announced)");
  assert.equal(error.getAttribute("tabindex"), "0", "§2.4: the visible panel banner is Tab-reachable");
  assert.equal(input.value, "Continue here.", "the unsent prompt text is retained for editing");
  assert.equal(world.el("panel-send").disabled, true, "fail-closed: panel composer disabled after session-corrupt");
});

/* ------------------------------------------------------------------ */
/* 2. session 横幅 dismiss 持久性（缺陷 2）                              */
/* ------------------------------------------------------------------ */

test("session banner dismissal is durable across re-renders; cleared only by availability recovery or the recovery action", async () => {
  const world = await createWorld();
  const banner = world.el("session-banner");
  const rerender = async (): Promise<void> => {
    world.liveSse().emit("run-terminal", { runId: "run-x" });
    await settle();
  };

  /* trunk 不可用 → 横幅出现 → dismiss。 */
  world.setAvailability("trunk-1", "unavailable");
  await rerender();
  assert.equal(banner.hidden, false, "trunk unavailable: banner shows");
  const dismiss = banner.querySelector(".session-banner-dismiss");
  assert.ok(dismiss !== null);
  dismiss.click();
  assert.equal(banner.hidden, true, "dismiss hides the banner");

  /* 重渲不复活：终态 /state 刷新、面板开合都走 renderAll。 */
  await rerender();
  assert.equal(banner.hidden, true, "dismiss survives a run-terminal /state refresh re-render");
  await openBranchOnePanel(world);
  assert.equal(banner.hidden, true, "dismiss survives panel open (renderAll)");
  world.el("panel-close").click();
  await settle();
  await sleep(220);
  assert.equal(banner.hidden, true, "dismiss survives panel close (renderAll)");
  assert.equal(world.el("send").disabled, true, "fail-closed stays in force while the banner is dismissed");

  /* 主干恢复可用 → dismiss 记录清除：再次不可用时横幅重新出现（新事件）。 */
  world.setAvailability("trunk-1", "available");
  await rerender();
  world.setAvailability("trunk-1", "unavailable");
  await rerender();
  assert.equal(banner.hidden, false, "banner re-appears for a NEW unavailability episode after the trunk recovered");

  /* 恢复动作清除 dismiss 记录：dismiss 后经面板恢复按钮建支线 → 横幅按
     当前事实重新出现（trunk 仍不可用，如实显示）。 */
  banner.querySelector(".session-banner-dismiss")!.click();
  assert.equal(banner.hidden, true, "dismissed again");
  world.setAvailability("branch-1", "unavailable");
  /* 恢复候选：预置 branch-2（可用，含 assistant 答案）。 */
  world.backend.treeState.branches.push(
    makeBranchView(
      { id: "branch-2", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO },
      null,
      "available",
      [makeTurn("b2u1", "branch-2", "user", "Branch two question."), makeTurn("b2a1", "branch-2", "assistant", B2_TEXT)],
    ),
  );
  await rerender();
  assert.equal(banner.hidden, true, "dismiss still suppresses the banner (condition unchanged)");

  await openBranchOnePanel(world);
  const note = world.el("panel-session-note");
  assert.equal(note.hidden, false, "unavailable panel branch shows the degraded note");
  const recovery = note.querySelector(".session-recovery-button");
  assert.ok(recovery !== null);
  assert.equal(recovery.disabled, false, "recovery enabled — branch-2 is available");
  recovery.click();
  await settle();

  const branchPost = world.lastRequest("/branches");
  assert.ok(branchPost !== null && branchPost.method === "POST", "recovery issues POST /branches");
  const body = asRecord(branchPost.body);
  assert.ok(body !== null);
  assert.equal(body.anchorTurnId, "b2a1", "recovery branches from branch-2's latest answer");
  assert.equal(banner.hidden, false, "choosing the recovery action clears the dismissal — the banner reflects current facts again");
  assert.equal(world.el("panel-title").textContent, "Branch 3", "the recovered branch's panel is open");
});

/* ------------------------------------------------------------------ */
/* 3. Return 同键异容 409（缺陷 3）：草稿/面板/文本保留 + 显式冲突        */
/* ------------------------------------------------------------------ */

test("same-key different-text 409: draft and panel kept, explicit conflict message, rekey on edit, resubmit succeeds", async () => {
  const world = await createWorld({
    seedReturns: [{ key: "idem-stale", fromBranchId: "branch-1", text: "Old conclusion." }],
  });
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  world.localStorageStore.set(draftKey, JSON.stringify({ idempotencyKey: "idem-stale", text: "Edited conclusion.", failed: false }));
  await openBranchOnePanel(world);
  const returnInput = world.el("return-input");
  assert.equal(returnInput.value, "Edited conclusion.", "the persisted draft is restored on panel open");

  world.el("submit-return").click();
  await settle();

  /* 409 冲突：面板保持打开、草稿与输入文本保留、显式冲突提示。 */
  assert.equal(world.requestsOf("/return").length, 1, "exactly one (rejected) POST /return");
  assert.equal(world.el("branch-panel").hidden, false, "conflict keeps the panel open");
  assert.equal(returnInput.value, "Edited conclusion.", "conflict never clears the user's edited text");
  const banner = world.el("panel-error-banner");
  assert.equal(banner.hidden, false, "conflict surfaces an explicit message in the panel banner");
  assert.ok(banner.textContent.includes("Return conflict"), "the message names the conflict");
  assert.ok(banner.textContent.includes("text differs"), "the message names what differs");
  assert.ok(banner.textContent.includes("draft is kept"), "the message states the draft is kept and how to proceed");
  /* 服务端零写入：旧 Return 保持唯一，不被伪装成本次提交。 */
  assert.ok(!world.el("conversation").textContent.includes("Edited conclusion."), "the old Return is not presented as the new submission");
  assert.ok(world.el("conversation").textContent.includes("Old conclusion."), "the previously recorded Return stays rendered");
  /* 草稿保留 + failed 标记（编辑即换新键）。 */
  const stored = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(stored !== null, "the persisted draft is kept after the conflict");
  assert.equal(stored.text, "Edited conclusion.");
  assert.equal(stored.failed, true, "the kept draft is marked failed (edit mints a new key)");

  /* 编辑 → 新键；重提成功（新键 = 新的逻辑提交）。 */
  returnInput.value = "Edited conclusion, second attempt.";
  returnInput.dispatchEvent("input", {});
  const rekeyed = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(rekeyed !== null);
  assert.notEqual(rekeyed.idempotencyKey, "idem-stale", "editing after a conflict mints a new idempotency key");
  world.el("submit-return").click();
  await settle();
  await sleep(220);

  const posts = world.requestsOf("/return");
  assert.equal(posts.length, 2, "one rejected + one accepted POST");
  const retryBody = asRecord(posts[1]!.body);
  assert.ok(retryBody !== null);
  assert.equal(retryBody.idempotencyKey, rekeyed.idempotencyKey, "the resubmit carries the regenerated key");
  assert.equal(world.el("branch-panel").hidden, true, "the successful resubmit closes the panel");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "success clears the persisted draft");
  assert.ok(world.el("conversation").textContent.includes("Edited conclusion, second attempt."), "the new Return renders in the trunk");
});

/* ------------------------------------------------------------------ */
/* 3b. 对账谓词的分支维度：同键同文、不同 fromBranchId 同为冲突          */
/* ------------------------------------------------------------------ */

test("same-key same-text different-branch is also a conflict: the predicate matches idempotencyKey AND fromBranchId AND text", async () => {
  const world = await createWorld({
    seedReturns: [{ key: "idem-branch", fromBranchId: "branch-2", text: "Same text." }],
  });
  world.localStorageStore.set(
    "treeai-return-draft:tree-1:branch-1",
    JSON.stringify({ idempotencyKey: "idem-branch", text: "Same text.", failed: false }),
  );
  await openBranchOnePanel(world);
  assert.equal(world.el("return-input").value, "Same text.", "the persisted draft is restored (no reconciliation hit — branch differs)");

  world.el("submit-return").click();
  await settle();

  assert.equal(world.el("branch-panel").hidden, false, "branch mismatch keeps the panel open");
  const banner = world.el("panel-error-banner");
  assert.equal(banner.hidden, false, "branch mismatch surfaces the conflict");
  assert.ok(banner.textContent.includes("Return conflict"), "the message names the conflict");
  assert.ok(
    banner.textContent.includes("fromBranchId branch-1 does not match branch-2"),
    "the message names the branch mismatch",
  );
  assert.equal(world.el("return-input").value, "Same text.", "the draft text is retained");
});

/* ------------------------------------------------------------------ */
/* 4. 响应丢失对账（缺陷 3 正向面）：键 + 分支 + 文本全同命中 → 按成功    */
/* ------------------------------------------------------------------ */

test("response-loss reconciliation requires key AND branch AND text to match before treating the return as submitted", async () => {
  const world = await createWorld({ returnMode: "lose-response" });
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  await openBranchOnePanel(world);
  const returnInput = world.el("return-input");
  returnInput.value = "Lost-response conclusion.";
  returnInput.dispatchEvent("input", {});
  const draft = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(draft !== null, "the draft is persisted before submit");

  world.el("submit-return").click();
  await settle();
  await sleep(220);

  /* 服务端已落库（同键 + 同分支 + 同文本）→ 对账命中：按成功处理。 */
  const posts = world.requestsOf("/return").filter((r) => {
    const b = asRecord(r.body);
    return b !== null && b.idempotencyKey === draft.idempotencyKey;
  });
  assert.equal(posts.length, 1, "reconciliation hit does not duplicate the submission");
  assert.equal(world.el("branch-panel").hidden, true, "panel closes after a reconciliation hit");
  assert.equal(world.el("panel-error-banner").hidden, true, "reconciliation success shows no error");
  assert.equal(world.el("error-banner").hidden, true, "reconciliation success shows no main error either");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "reconciliation hit clears the draft");
  assert.ok(world.el("conversation").textContent.includes("Lost-response conclusion."), "the server-recorded return renders in the trunk");
});

/* ------------------------------------------------------------------ */
/* 5. 面板打开时的持久草稿对账（缺陷 6）                                 */
/* ------------------------------------------------------------------ */

test("panel open reconciles persisted drafts: an already-recorded return drops the draft and renders delivered state; a new explicit submission uses a new key", async () => {
  const world = await createWorld({
    seedReturns: [{ key: "idem-done", fromBranchId: "branch-1", text: "Already submitted.", deliveredRunId: "run-delivered-1" }],
  });
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  world.localStorageStore.set(draftKey, JSON.stringify({ idempotencyKey: "idem-done", text: "Already submitted.", failed: false }));

  await openBranchOnePanel(world);
  const returnInput = world.el("return-input");
  assert.equal(returnInput.value, BA1_TEXT, "the stale draft is dropped; the input falls back to the prefill convention");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "the stale persisted draft is removed from localStorage");

  /* 已提交的 Return 呈 delivered 卡（非草稿复活）。 */
  const conversation = world.el("conversation");
  assert.ok(conversation.textContent.includes("Already submitted."), "the recorded Return renders in the trunk");
  assert.ok(
    conversation.textContent.includes("successfully adopted into Trunk context"),
    "the delivered state renders (deliveredRunId cross-reference)",
  );

  /* 显式新提交使用新键（陈旧键不复活 → 无重复提交）。 */
  returnInput.value = "A genuinely new conclusion.";
  returnInput.dispatchEvent("input", {});
  world.el("submit-return").click();
  await settle();
  await sleep(220);

  const post = world.lastRequest("/return");
  assert.ok(post !== null && post.method === "POST", "the explicit new submission posts");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  assert.equal(typeof body.idempotencyKey, "string");
  assert.notEqual(body.idempotencyKey, "idem-done", "a new explicit submission uses a new key — no duplicate of the recorded Return");
  assert.equal(world.el("branch-panel").hidden, true, "the new submission completes normally");
});

/* ------------------------------------------------------------------ */
/* 6. 降级 revealOrigin（缺陷 4）：payload.state 先落地                  */
/* ------------------------------------------------------------------ */

test("degraded revealOrigin applies the server-returned state: badges and degraded note never contradict the degraded error", async () => {
  const world = await createWorld({ sourceMode: "degraded" });
  await openBranchOnePanel(world);
  assert.equal(world.el("panel-session-note").hidden, true, "before reveal: branch-1 reports available (no note)");
  assert.ok(!world.tabButton("branch-1")!.textContent.includes("session missing"), "before reveal: no degraded badge");

  world.el("panel-view-source").click();
  await settle();

  const error = world.el("panel-error-banner");
  assert.equal(error.hidden, false, "degraded reveal reports the changed status");
  assert.ok(error.textContent.includes("Source reference changed"), "the error names the degraded status");
  /* §2.6 降级焦点（issue #6 P1）：焦点移到说明区——面板锚点上下文
     （常驻；横幅 8 秒自动隐藏会丢焦点，取舍见 W2 §2.6 行内注记）。 */
  assert.equal(
    world.document.activeElement,
    world.el("panel-anchor-context"),
    "the degraded reveal moves focus to the persistent explanation area (panel anchor context)",
  );
  /* 服务端返回的 state 已落地：徽标 / 降级提示与错误一致。 */
  assert.equal(world.el("panel-session-note").hidden, false, "the server-returned degraded availability renders the panel note");
  assert.ok(world.tabButton("branch-1")!.textContent.includes("session missing"), "the branch tab badge reflects the server-returned degraded state");
  assert.equal(world.el("panel-send").disabled, true, "fail-closed composer follows the applied degraded state");
  assert.equal(world.el("panel-prompt-input").disabled, false, "v3 §4.4: the panel input stays typed-in for the new exploration");
  assert.equal(world.el("panel-new-exploration").hidden, false, "v3 §4.4: the panel new-exploration entry follows the degraded state");
});

/* ------------------------------------------------------------------ */
/* 7. submitReturn 收尾失败（缺陷 5）：呈现在主线可见横幅                */
/* ------------------------------------------------------------------ */

test("closePanel navigation failure after a successful return surfaces in the visible main error banner, not the hidden panel", async () => {
  const world = await createWorld();
  await openBranchOnePanel(world);
  const returnInput = world.el("return-input");
  returnInput.value = "The conclusion to return.";
  returnInput.dispatchEvent("input", {});

  /* 提交成功（服务端导航也成功），但回主干的客户端游标对齐
     （POST /switch）失败。 */
  world.backend.switchMode = "fail";
  world.el("submit-return").click();
  await settle();
  await sleep(220);

  assert.equal(world.el("branch-panel").hidden, true, "the panel closed after the successful return");
  const mainError = world.el("error-banner");
  assert.equal(mainError.hidden, false, "the closePanel/navigation failure surfaces in the visible MAIN error banner");
  assert.ok(mainError.textContent.includes("Return saved"), "the banner names the successful save (save and navigation are separate facts)");
  assert.ok(mainError.textContent.includes("switch rejected"), "the main banner carries the navigation failure message");
  assert.equal(world.el("panel-error-banner").hidden, true, "no error is buried in the now-hidden panel banner");
  /* Return 本身已成功：草稿清除、卡渲染、焦点回主线。 */
  assert.ok(world.localStorageStore.get("treeai-return-draft:tree-1:branch-1") === undefined, "the return itself succeeded — the draft is cleared");
  assert.ok(world.el("conversation").textContent.includes("The conclusion to return."), "the Return card renders in the trunk");
  assert.equal(world.document.activeElement, world.el("prompt-input"), "focus returned to the main input");
});

/* ------------------------------------------------------------------ */
/* 8. 保存成功 + 服务端导航失败（signed v3 §3.5）：分离呈现，不重放导航   */
/* ------------------------------------------------------------------ */

test("a saved return whose server-side navigation failed renders the saved fact and the navigation failure separately, without replaying /switch", async () => {
  const world = await createWorld({ returnNavigation: "fail" });
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  await openBranchOnePanel(world);
  const returnInput = world.el("return-input");
  returnInput.value = "Saved but not navigated.";
  returnInput.dispatchEvent("input", {});
  const draft = readPersistedDraft(world.localStorageStore.get(draftKey));
  assert.ok(draft !== null);

  const switchCountBefore = world.backend.switchCount;
  world.el("submit-return").click();
  await settle();
  await sleep(220);

  /* 保存成功：201 处理为成功（单次 POST /return、草稿清除、面板收起、
     卡渲染）——导航失败绝不把已保存的 Return 伪装成提交失败。 */
  const posts = world.requestsOf("/return");
  assert.equal(posts.length, 1, "exactly one POST /return");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "the save succeeded — the draft is cleared");
  assert.equal(world.el("branch-panel").hidden, true, "the panel closes (staying open would invite duplicate submissions)");
  assert.ok(world.el("conversation").textContent.includes("Saved but not navigated."), "the saved Return card renders in the trunk");
  assert.ok(
    world.el("conversation").textContent.includes("saved — pending adoption on the next Trunk discussion"),
    "the card shows the saved/pending badge (no adoption has happened yet)",
  );

  /* 导航失败分离呈现：主线横幅如实呈「已保存 + 返回主线失败」；且不
     重放 /switch（服务端已尝试并失败——重导航留给 Trunk tab，不在提交
     收尾里再撞一次；面板打开时的 /switch 在提交之前，不计入）。 */
  assert.equal(world.backend.switchCount, switchCountBefore, "no /switch is replayed after the failed server-side navigation");
  const returnRequestIndex = world.backend.requests.findIndex(
    (r) => r.method === "POST" && r.path.split("?")[0]!.endsWith("/return"),
  );
  assert.ok(returnRequestIndex >= 0, "the submit POST /return is recorded");
  const switchesAfterSubmit = world.backend.requests.filter(
    (r, index) => index > returnRequestIndex && r.method === "POST" && r.path.split("?")[0]!.endsWith("/switch"),
  );
  assert.equal(switchesAfterSubmit.length, 0, "closePanel skips the switch when the server already reported navigation failure");
  const mainError = world.el("error-banner");
  assert.equal(mainError.hidden, false, "the navigation failure surfaces in the visible main banner");
  assert.ok(mainError.textContent.includes("Return saved"), "the banner states the return IS saved");
  assert.ok(mainError.textContent.includes("returning to the Trunk failed"), "the banner states the navigation failed");
  assert.ok(mainError.textContent.includes("session-corrupt"), "the banner carries the navigation failure code");
  assert.equal(world.el("panel-error-banner").hidden, true, "no error is buried in the now-hidden panel banner");
});
