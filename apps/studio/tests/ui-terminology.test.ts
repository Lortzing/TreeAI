/**
 * 术语③配套前端套件（issue #7 C ③「完整前端」——正文/操作分层、统一
 * 标注/来源区间、选择期间不重绘、模式/工具条/解释卡/批注/已有探索及完整
 * 失败状态、响应式/键盘/触屏/reduced-motion/回程草稿焦点）。
 *
 * 方法与 ui-probe / ui-regressions 套件一致（issue #4 P1「证据工程化」的
 * 脚本化 DOM E2E）：以 data: URL 加载仓库真实 public/app.js 为 ES module
 * （URL fragment 随机化绕过 ES 模块缓存——每个场景一份全新实例），运行
 * 在「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本化后端」之
 * 上：fetch / EventSource / localStorage / 计时器 / matchMedia /
 * getSelection 全部为内存桩。后端按场景脚本化（/terminology/* 的 explain
 * 结果、保存幂等、推广成功/冲突/响应丢失、缓存偏好失败、读模型失败）。
 * public/style.css 以 @media 块词法解析（窄窗与 reduced-motion 规则的存
 * 在与形状断言——套件不执行 CSS）。无网络、无磁盘写入、无长等待，确定
 * 性可复现。本文件自包含（不依赖 ui-probe.test.ts——两套件可独立运行）。
 *
 * 覆盖（③ 交付面的逐项锁定）：
 *  1. 正文/操作分层：assistant turn 的正文是自己的层（前导文本节点区），
 *     动作在尾部 .turn-actions 层；正文层 textContent 与 turn 原文字节全
 *     等（含区间覆盖在场时），复制源不受污染；异步刷新（SSE 终态重渲）
 *     对未变化结构零 DOM 变更——turn 元素与正文文本节点身份原样保留。
 *  2. 选择期间不重绘：武装选区存活于异步刷新（工具条/武装态不丢）；正文
 *     上 mousedown→mouseup 的拖拽窗口内，会改变区间覆盖的重渲被延后
 *     （揭示高亮不落位），mouseup 后冲刷落位——正文层绝不被换走。
 *  3. 模式/工具条 + 键盘：点词（双击）与划线（mouseup）武装同一工具条；
     单词 = term 模式、跨词 = range 模式（POST 载荷的 mode 字段）；Esc
     分层关闭解释卡并还原焦点到该答案的解释入口；面板内卡先于面板关闭。
 *  4. 解释卡完整状态：in-flight（可 Dismiss）/ 成功（含缓存命中注记）/
     失败（诚实错误 + 重试可用）/ 取消（含迟到丢弃注记）/ 保存幂等命中
     （显示既有批注，不伪装新建）/ 推广成功 / 推广冲突（409 如实上卡 +
     同键重试保留）/ 响应丢失（服务端已记录 → 刷新后呈「恢复既有探索」）/
     迟到响应客户端丢弃（不复活已关的卡，抽屉用量行计数）。
 *  5. 统一标注/来源区间：术语批注与来源揭示高亮共用同一覆盖机制——绝对
     UTF-16 偏移切片（前缀/标记/后缀恰切），textContent 字节不变，重渲
     后按存储偏移复现；两种覆盖可在同一视图并存。
 *  6. 已有探索（resume-or-create）：同锚点已推广的批注呈「打开既有支线」
     的明确去向 + 另开的如实指引，绝不出现第二个推广表单、绝不跨语境静默
     复用（issue #7 ②③）。
 *  7. 响应式/触屏/reduced-motion：<720px 工具条/解释卡规则词法锁定；
     selectionchange（触屏）武装与空选区解除；reduce 块显式即时化解释卡
     进场动效。
 *  8. 回程草稿焦点非回归：Return 提交后焦点回主线输入框；解释卡首问草
     稿跨重渲保值且焦点不丢（W1/W2 既有纪律在分层渲染器下不回归）。
 *  9. 抽屉执行器面：近期任务（三模式任务态如实）、用量（chars/4 诚实估
     算 + 服务端/客户端迟到丢弃分开计数）、缓存偏好切换（成功/在途/失败
     + 重试）、读模型失败态 + 重试。
 * 10. P0/P1 整改回归（issue #7 增量验收 2026-09-30「H前端函数探针」）：
     批注活覆盖的联合校验（界内区间 + 摘录切片 + 全文指纹 sourceHash 任
     一失配不渲染——等长替换/同词移位/删除越界/代理对错位/区间外漂移五
     类漂移；失效降级为抽屉快照 + source changed/missing 说明，完好批注
     照常渲染）；A 树读模型响应在切到 B 树后迟到到达绝不写入共享状态
     （探针复现口径：currentTreeId=B、annotations=[A]——多树桩 + 请求闸
     门的确定性编排）；解释卡保存期间被关闭 → 迟到响应不复活卡、批注照
     常落读模型。
 *
 * 边界（如实声明）：同 ui-probe——不是真实浏览器 E2E；CSS 不执行，媒体
 * 查询按词法锁定规则存在与形状；桩 Range 只支持单文本节点语义（覆盖在场
 * 时选区只在首个内容节点内可武装修真——测试偏移按此设计）；真实触屏/
 * 键盘/读屏器行为归 evidence/d3/real-pi/ 与 trials/ 口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/* 加载真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const APP_JS = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const STYLE_CSS = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");

/** 服务端 hashSourceText 同口径（src/terminology.ts）：锚点答案全文的
 *  SHA-256（hex）。P0 联合校验后，批注桩必须携带真实指纹——保存路径的
 *  桩按锚点 turn 的当前文本即时计算（与服务端行为一致）。 */
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const A1_TEXT = "First trunk answer with several plain words.";
/* A2 带 ③ 场景形状：首词即术语（批注落在 [0,5)——桩 Range 的单文本节点
 * 语义下，首节点内武装的绝对偏移可修真），"lasso" 出现两次（重复词纪律）。 */
const A2_TEXT = "Lasso regularization shrinks coefficients; the lasso path crosses zero twice.";
const A2_TERM = "Lasso"; /* A2_TEXT.slice(0, 5) */
const A2_SECOND_TERM_START = A2_TEXT.indexOf("lasso", 1);
const BA1_TEXT = "Branch one answer mentioning lasso as well.";

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
  policyDecisions: { observed: false; reason: string };
}

/** 术语批注的服务端桩形状（读模型 / annotations / promote 路由共用）。 */
interface StubTermAnnotation {
  id: string;
  treeId: string;
  branchId: string;
  anchorTurnId: string;
  selection: Selection;
  sourceHash: string;
  term: string;
  explanation: string;
  mode: string;
  promotedBranchId: string | null;
  promotionKey: string | null;
  createdAt: string;
}

/** 读模型 tasks 桩形状（瞬态任务面：kind/mode/state）。 */
interface StubTermTask {
  id: string;
  kind: string;
  mode: string;
  treeId: string;
  term: string | null;
  selection: Selection | null;
  createdAt: string;
  state: { kind: string } & Record<string, unknown>;
}

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

function freshBackendState(): TreeState {
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const b1Branch: Branch = { id: "branch-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
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
      makeBranchView(trunkBranch, null, "available", [
        makeTurn("u1", "trunk-1", "user", "First trunk question."),
        makeTurn("a1", "trunk-1", "assistant", A1_TEXT),
        makeTurn("u2", "trunk-1", "user", "Second trunk question."),
        makeTurn("a2", "trunk-1", "assistant", A2_TEXT),
      ]),
      makeBranchView(b1Branch, b1Origin, "available", [
        makeTurn("bu1", "branch-1", "user", "Branch one question."),
        makeTurn("ba1", "branch-1", "assistant", BA1_TEXT),
      ]),
    ],
    cursor: { treeId: TREE, branchId: "trunk-1", entryId: "pi-a2" },
  };
}

function termAnnotation(overrides: Partial<StubTermAnnotation> = {}): StubTermAnnotation {
  return {
    id: "term-ann-1",
    treeId: TREE,
    branchId: "trunk-1",
    anchorTurnId: "a2",
    selection: { start: 0, end: A2_TERM.length, text: A2_TERM },
    /* 默认锚点是 a2（A2_TEXT 全文指纹——P0 联合校验下的真实桩）。 */
    sourceHash: sha256Of(A2_TEXT),
    term: A2_TERM,
    explanation: "Seeded explanation of the seeded term.",
    mode: "term",
    promotedBranchId: null,
    promotionKey: null,
    createdAt: ISO,
    ...overrides,
  };
}

/** 树状态内按 turn id 反查（保存桩计算锚点全文指纹用）。 */
function findTurnInState(state: TreeState, turnId: string): Turn | null {
  for (const view of state.branches) {
    const found = view.turns.find((t) => t.id === turnId);
    if (found !== undefined) return found;
  }
  return null;
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

type ExplainScript = "ok" | "cached" | "fail" | "cancelled" | "cancelled-late" | "error";
type PromoteScript = "ok" | "lose-response" | "replay" | "conflict" | "fail";

/** 多树场景束（P1 竞态回归）：/api/trees 列表与 /state、GET /terminology
 *  按 treeId 分派到各束（读模型与批注按树隔离——服务端语义）。 */
interface TreeBundle {
  tree: Tree;
  state: TreeState;
  annotations?: StubTermAnnotation[];
}

interface Backend {
  trees: Tree[];
  treeState: TreeState;
  /** 多树分派束（空 = 单树缺省路径，树状态/批注不按 URL 区分）。 */
  treeBundles: TreeBundle[];
  /** 请求闸门（P1 迟到响应编排）：路径后缀命中的请求挂起至 releaseHold。 */
  holdSuffix: string | null;
  diagnostics: TreeDiagnostics;
  requests: RecordedRequest[];
  switchCount: number;
  branchCounter: number;
  promptCounter: number;
  /** /terminology/explain 的结果脚本（duplicate 由 termAnnotations 命中自动决定）。 */
  explainScript: ExplainScript;
  /** /terminology/explain 响应延迟一拍（迟到响应/客户端丢弃场景）。 */
  explainDelay: boolean;
  /** POST /terminology/annotations 的脚本化失败。 */
  annotationsFail: boolean;
  /** POST .../promote 的脚本（ok / 响应丢失（已记录+500）/ 同键重放 200 / 409 冲突 / 500）。 */
  promoteScript: PromoteScript;
  /** PUT /terminology/preferences 的脚本化失败。 */
  prefsFail: boolean;
  /** GET /terminology 的脚本化失败（读模型三态）。 */
  terminologyGetFail: boolean;
  termAnnotations: StubTermAnnotation[];
  termTasks: StubTermTask[];
  cacheEnabled: boolean;
}

/* ------------------------------ unknown 收窄辅助（不使用 any） ------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 正文层文本（turn 前导内容区——.turn-actions 之前的全部子节点的拼接）。 */
function contentRegionText(turn: StubElement): string {
  const parts: string[] = [];
  for (const child of turn.children) {
    if (child instanceof StubElement && child.classList.contains("turn-actions")) break;
    parts.push(child instanceof StubText ? child.data : child.textContent);
  }
  return parts.join("");
}

/* ------------------------------ 事件轮转 / 短等待 ------------------------------ */

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

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

  /** insertBefore（真实 DOM 语义：ref 为 null/undefined 时等价 appendChild；
      已挂载节点重挂即移动到指定位）——app.js ③ 按位调和使用。 */
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

/* ------------------------------ 选区 Range 桩（W1 §1.1 绝对偏移语义） ------------------------------ */

/** 单文本节点上的选区 mini-model（同 ui-probe：场景内 turn 的首个内容文本
 *  节点即其全文——覆盖在场时偏移只在该节点范围内修真，测试偏移按此设计）。 */
class StubTextRange {
  private start: number;
  private end: number;
  private readonly textNode: StubText;

  constructor(textNode: StubText, start: number, end: number) {
    this.textNode = textNode;
    this.start = start;
    this.end = end;
  }

  get commonAncestorContainer(): StubText {
    return this.textNode;
  }

  get startContainer(): StubText {
    return this.textNode;
  }

  get startOffset(): number {
    return this.start;
  }

  selectNodeContents(element: StubElement): void {
    void element;
    this.start = 0;
    this.end = this.textNode.data.length;
  }

  setEnd(container: StubNode, offset: number): void {
    if (container !== this.textNode) {
      throw new Error("StubTextRange.setEnd: container must be the range's own text node");
    }
    this.end = offset;
  }

  toString(): string {
    const from = Math.min(this.start, this.end);
    const to = Math.max(this.start, this.end);
    return this.textNode.data.slice(from, to);
  }

  cloneRange(): StubTextRange {
    return new StubTextRange(this.textNode, this.start, this.end);
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

/* ------------------------------ style.css 词法抽取（@media 断言用） ------------------------------ */

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

/** 去除注释与全部 @media 块后的基础层。 */
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
  getSelection(): { rangeCount: number; getRangeAt(index: number): StubTextRange };
  confirm(message: string): boolean;
}

/* ------------------------------ world 工厂 ------------------------------ */

interface World {
  readonly document: StubDocument;
  readonly backend: Backend;
  el(id: string): StubElement;
  byId(id: string): StubElement | null;
  requestsOf(suffix: string): RecordedRequest[];
  lastRequest(suffix: string): RecordedRequest | null;
  tabButton(branchId: string): StubElement | null;
  liveSse(): StubEventSource;
  setSelection(range: StubTextRange | null): void;
  turnElement(containerId: string, turnId: string): StubElement;
  /** 放行被 holdSuffix 挂起的请求（一次性闸门：此后同后缀请求直通）。 */
  releaseHold(): void;
}

interface WorldOptions {
  /** 开树前预置的术语批注（boot 的 GET /terminology 即返回——批注覆盖随
   *  开树渲染）。 */
  termAnnotations?: StubTermAnnotation[];
  /** 读模型 tasks（抽屉近期任务面的数据）。 */
  termTasks?: StubTermTask[];
  explainScript?: ExplainScript;
  explainDelay?: boolean;
  annotationsFail?: boolean;
  promoteScript?: PromoteScript;
  prefsFail?: boolean;
  terminologyGetFail?: boolean;
  /** 预置已推广批注的支线分支视图（resume-or-create 场景）。 */
  promotedBranchView?: Branch;
  /** 覆写 a2 的正文（emoji/增补平面 astral 码位等锚定场景——turn id 与结构不变）。 */
  a2Text?: string;
  /** 多树场景束（P1 竞态回归；空 = 缺省单树）。 */
  treeBundles?: TreeBundle[];
  /** 命中即挂起的请求路径后缀（一次性闸门，releaseHold 放行）——迟到
   *  响应竞态的确定性编排。 */
  holdSuffix?: string;
}

let appLoadCounter = 0;

async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  const localStorageStore = new Map<string, string>();
  let scriptedSelection: StubTextRange | null = null;
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
      getRangeAt: (_index: number): StubTextRange => {
        const range = scriptedSelection;
        assert.ok(range !== null, "getRangeAt called without a scripted selection");
        return range;
      },
    }),
    confirm: () => true,
  };

  const backend: Backend = {
    trees: [{ id: TREE, createdAt: ISO, forestId: "forest-1" }],
    treeState: freshBackendState(),
    treeBundles: options.treeBundles === undefined ? [] : [...options.treeBundles],
    holdSuffix: options.holdSuffix ?? null,
    diagnostics: {
      treeId: TREE,
      runtimeState: "idle",
      activeRun: null,
      runs: [],
      policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
    },
    requests: [],
    switchCount: 0,
    branchCounter: 0,
    promptCounter: 0,
    explainScript: options.explainScript ?? "ok",
    explainDelay: options.explainDelay === true,
    annotationsFail: options.annotationsFail === true,
    promoteScript: options.promoteScript ?? "ok",
    prefsFail: options.prefsFail === true,
    terminologyGetFail: options.terminologyGetFail === true,
    termAnnotations: options.termAnnotations === undefined ? [] : [...options.termAnnotations],
    termTasks: options.termTasks ?? [],
    cacheEnabled: true,
  };
  if (options.promotedBranchView !== undefined) {
    backend.treeState.branches.push(makeBranchView(options.promotedBranchView, null, "available", []));
  }
  if (options.a2Text !== undefined) {
    const trunkView = backend.treeState.branches.find((view) => view.branch.id === "trunk-1");
    const a2 = trunkView?.turns.find((t) => t.id === "a2");
    assert.ok(a2 !== undefined, "a2Text override requires the default a2 turn");
    a2.text = options.a2Text;
  }

  /* 一次性请求闸门（holdSuffix 命中 → 挂起至 releaseHold；此后直通）。 */
  let releaseHoldFn: (() => void) | null = null;
  const holdGate =
    options.holdSuffix === undefined ? null : new Promise<void>((resolve) => { releaseHoldFn = resolve; });

  /** 多树分派：URL treeId 命中的束（null = 无束，走单树缺省）。 */
  const bundleFor = (treeId: string): TreeBundle | null =>
    backend.treeBundles.find((b) => b.tree.id === treeId) ?? null;

  const viewByBranch = (branchId: string): BranchView | undefined =>
    backend.treeState.branches.find((view) => view.branch.id === branchId);

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

    if (p === "/api/trees" && method === "GET") {
      return respond(200, { trees: backend.treeBundles.length > 0 ? backend.treeBundles.map((b) => b.tree) : backend.trees });
    }
    if (p === "/api/trees" && method === "POST") {
      if (!backend.trees.some((t) => t.id === backend.treeState.tree.id)) {
        backend.trees.push(backend.treeState.tree);
      }
      return respond(201, { tree: backend.treeState.tree, trunkBranchId: "trunk-1", state: backend.treeState });
    }
    let m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") {
      const bundle = bundleFor(decodeURIComponent(m[1]!));
      return respond(200, bundle === null ? backend.treeState : bundle.state);
    }
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, { ...backend.diagnostics, treeId: decodeURIComponent(m[1]!) });
    }
    m = /^\/api\/trees\/([^/]+)\/journal$/.exec(p);
    if (m !== null && method === "GET") return respond(200, { events: [] });
    m = /^\/api\/trees\/([^/]+)\/switch$/.exec(p);
    if (m !== null && method === "POST") {
      backend.switchCount += 1;
      const branchId = asRecord(body)?.branchId;
      const target = typeof branchId === "string" ? branchId : "";
      const view = viewByBranch(target);
      const lastTurn = view === undefined ? undefined : view.turns[view.turns.length - 1];
      const entryId =
        (lastTurn !== undefined && lastTurn.piEntryId !== null ? lastTurn.piEntryId : null) ??
        view?.origin?.anchorEntryId ??
        "pi-a2";
      const cursor = { treeId: TREE, branchId: target, entryId };
      backend.treeState.cursor = cursor;
      return respond(200, { cursor, state: backend.treeState });
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
    m = /^\/api\/trees\/([^/]+)\/return$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /return body must be an object");
      const fromBranchId = String(record.fromBranchId ?? "");
      const text = String(record.text ?? "");
      const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey : null;
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
          selection: { start: 0, end: 5, text: A2_TERM },
        },
      });
      const trunk = viewByBranch("trunk-1");
      assert.ok(trunk !== undefined);
      trunk.turns.push(returnTurn);
      backend.treeState.cursor = { treeId: TREE, branchId: "trunk-1", entryId: "pi-a2" };
      return respond(201, { returnTurn, navigation: { status: "navigated" }, state: backend.treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(p);
    if (m !== null && method === "POST") {
      const branchId = decodeURIComponent(m[2]!);
      const view = viewByBranch(branchId);
      assert.ok(view !== undefined, `POST /source must target a known branch (got ${branchId})`);
      const origin = view.origin;
      assert.ok(origin !== null, "POST /source must target a branch with an anchor origin");
      return respond(200, {
        source: {
          sourceBranchId: origin.sourceBranchId,
          anchorTurnId: origin.anchorTurnId,
          status: "available",
          selection: origin.selection,
          navigation: { status: "navigated" },
        },
        state: backend.treeState,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology$/.exec(p);
    if (m !== null && method === "GET") {
      if (backend.terminologyGetFail) {
        return respond(500, { error: { code: "internal", message: "terminology read model boom" } });
      }
      /* 多树分派（服务端语义：读模型按 treeId 隔离）；单树缺省不分派。 */
      const bundle = bundleFor(decodeURIComponent(m[1]!));
      return respond(200, {
        annotations: bundle === null ? backend.termAnnotations : (bundle.annotations ?? []),
        tasks: backend.termTasks,
        usage: {
          total: { requests: 3, promptChars: 120, completionChars: 80 },
          estTokens: 50,
          lateResultsDiscarded: 1,
          budgetTokens: 1_000_000,
        },
        cacheEnabled: backend.cacheEnabled,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology\/explain$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /terminology/explain body must be an object");
      const anchorTurnId = typeof record.anchorTurnId === "string" ? record.anchorTurnId : "";
      const selection = asRecord(record.selection);
      assert.ok(selection !== null, "POST /terminology/explain must carry a selection");
      const sel = {
        start: Number(selection.start),
        end: Number(selection.end),
        text: String(selection.text ?? ""),
      };
      const mode = typeof record.mode === "string" ? record.mode : "term";
      if (backend.explainDelay) await new Promise<void>((resolve) => setImmediate(resolve));
      /* 服务端语义（②）：同选区既有批注 → 零模型调用直接返回。 */
      const existing = backend.termAnnotations.find(
        (a) => a.anchorTurnId === anchorTurnId && a.selection.start === sel.start && a.selection.end === sel.end,
      );
      if (existing !== undefined) {
        return respond(200, { annotation: existing, task: null });
      }
      const taskOf = (state: StubTermTask["state"]): { task: StubTermTask } => ({
        task: {
          id: "term-task-1",
          kind: "explain",
          mode,
          treeId: TREE,
          term: sel.text,
          selection: sel,
          createdAt: ISO,
          state,
        },
      });
      if (backend.explainScript === "ok") {
        return respond(200, {
          annotation: null,
          task: {
            ...taskOf({ kind: "succeeded", explanation: `Scripted explanation of “${sel.text}”.`, candidates: null, cached: false, usage: { requests: 1, promptChars: 10, completionChars: 10 } }).task,
          },
        });
      }
      if (backend.explainScript === "cached") {
        return respond(200, {
          annotation: null,
          task: {
            ...taskOf({ kind: "succeeded", explanation: `Cached explanation of “${sel.text}”.`, candidates: null, cached: true, usage: { requests: 0, promptChars: 0, completionChars: 0 } }).task,
          },
        });
      }
      if (backend.explainScript === "fail") {
        return respond(200, { annotation: null, ...taskOf({ kind: "failed", code: "upstream-error", message: "scripted upstream failure" }) });
      }
      if (backend.explainScript === "cancelled") {
        return respond(200, { annotation: null, ...taskOf({ kind: "cancelled", lateResultDiscarded: false }) });
      }
      if (backend.explainScript === "cancelled-late") {
        return respond(200, { annotation: null, ...taskOf({ kind: "cancelled", lateResultDiscarded: true }) });
      }
      return respond(500, { error: { code: "internal", message: "scripted explain transport failure" } });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology\/annotations$/.exec(p);
    if (m !== null && method === "POST") {
      if (backend.annotationsFail) {
        return respond(500, { error: { code: "internal", message: "scripted annotation save failure" } });
      }
      const record = asRecord(body);
      assert.ok(record !== null, "POST /terminology/annotations body must be an object");
      const anchorTurnId = typeof record.anchorTurnId === "string" ? record.anchorTurnId : "";
      const selection = asRecord(record.selection);
      assert.ok(selection !== null, "POST /terminology/annotations must carry a selection");
      const sel = {
        start: Number(selection.start),
        end: Number(selection.end),
        text: String(selection.text ?? ""),
      };
      const existing = backend.termAnnotations.find(
        (a) => a.anchorTurnId === anchorTurnId && a.selection.start === sel.start && a.selection.end === sel.end,
      );
      if (existing !== undefined) {
        return respond(200, { annotation: existing, created: false });
      }
      const annotation = termAnnotation({
        id: `term-ann-${String(backend.termAnnotations.length + 1)}`,
        branchId: typeof record.branchId === "string" ? record.branchId : "trunk-1",
        anchorTurnId,
        selection: sel,
        /* 服务端语义（src/terminology.ts saveAnnotation）：sourceHash 取
           保存时刻锚点答案全文指纹。 */
        sourceHash: sha256Of(findTurnInState(backend.treeState, anchorTurnId)?.text ?? ""),
        term: sel.text,
        explanation: typeof record.explanation === "string" ? record.explanation : "",
        mode: typeof record.mode === "string" ? record.mode : "term",
      });
      backend.termAnnotations.push(annotation);
      return respond(201, { annotation, created: true });
    }
    {
      const promoteMatch = /^\/api\/trees\/([^/]+)\/terminology\/annotations\/([^/]+)\/promote$/.exec(p);
      if (promoteMatch !== null && method === "POST") {
        const record = asRecord(body);
        assert.ok(record !== null, "POST promote body must be an object");
        const annotationId = decodeURIComponent(promoteMatch[2]!);
        const annotation = backend.termAnnotations.find((a) => a.id === annotationId);
        assert.ok(annotation !== undefined, `promote must target a known annotation (got ${annotationId})`);
        const key = typeof record.idempotencyKey === "string" ? record.idempotencyKey : "";
        assert.ok(key !== "", "promote must carry an idempotencyKey");
        const firstQuestion = String(record.firstQuestion ?? "");
        assert.ok(firstQuestion.trim() !== "", "promote must carry a first question");
        if (backend.promoteScript === "conflict") {
          return respond(409, {
            error: {
              code: "terminology-promotion-conflict",
              message: `annotation ${annotationId} is already promoted; a new follow-up needs a new annotation`,
            },
          });
        }
        if (backend.promoteScript === "fail") {
          return respond(500, { error: { code: "internal", message: "scripted promote failure" } });
        }
        if (annotation.promotedBranchId === null) {
          if (backend.promoteScript === "replay") {
            /* 直接呈同键重放形态（分支已存在，不重建）。 */
            const branchId = "branch-term-1";
            annotation.promotedBranchId = branchId;
            annotation.promotionKey = key;
            return respond(200, {
              branch: { id: branchId, treeId: TREE, parentBranchId: annotation.branchId, createdAt: ISO },
              outcome: null,
              firstQuestionError: null,
              created: false,
              state: backend.treeState,
            });
          }
          /* 服务端语义（②）：建枝 + 绑定 + 首问派发；lose-response 模式下
             记录已落库但响应 500（响应丢失——同键重放返回同一分支）。 */
          const branchId = `branch-term-${String(backend.branchCounter + 10)}`;
          annotation.promotedBranchId = branchId;
          annotation.promotionKey = key;
          backend.branchCounter += 1;
          const branch = { id: branchId, treeId: TREE, parentBranchId: annotation.branchId, createdAt: ISO };
          backend.treeState.branches.push(makeBranchView(branch, null, "available", []));
          if (backend.promoteScript === "lose-response") {
            return respond(500, {
              error: { code: "internal", message: "simulated response loss — the promotion was recorded" },
            });
          }
          return respond(201, { branch, outcome: { kind: "completed" }, firstQuestionError: null, created: true, state: backend.treeState });
        }
        /* 已推广：同键重放（不重建枝、不重复派发）。 */
        if (annotation.promotionKey !== key) {
          return respond(409, {
            error: {
              code: "terminology-promotion-conflict",
              message: `annotation ${annotationId} is already promoted (branch ${annotation.promotedBranchId}); a new follow-up needs a new annotation`,
            },
          });
        }
        return respond(200, {
          branch: { id: annotation.promotedBranchId, treeId: TREE, parentBranchId: annotation.branchId, createdAt: ISO },
          outcome: null,
          firstQuestionError: null,
          created: false,
          state: backend.treeState,
        });
      }
    }
    {
      const prefsMatch = /^\/api\/trees\/([^/]+)\/terminology\/preferences$/.exec(p);
      if (prefsMatch !== null && method === "PUT") {
        if (backend.prefsFail) {
          return respond(500, { error: { code: "internal", message: "scripted preferences failure" } });
        }
        const record = asRecord(body);
        const enabled = record?.cacheEnabled === true;
        backend.cacheEnabled = enabled;
        return respond(200, { cacheEnabled: enabled });
      }
    }
    m = /^\/api\/trees\/([^/]+)\/prompt$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /prompt body must be an object");
      const branchId = record.branchId;
      const text = record.text;
      assert.ok(typeof branchId === "string" && branchId !== "", "POST /prompt must carry a branchId");
      assert.ok(typeof text === "string" && text.trim() !== "", "POST /prompt must carry a non-empty text");
      const view = viewByBranch(branchId);
      assert.ok(view !== undefined, `POST /prompt must target a known branch (got ${branchId})`);
      backend.promptCounter += 1;
      const runId = `run-p${backend.promptCounter}`;
      view.turns.push(
        makeTurn(`p${backend.promptCounter}u`, branchId, "user", text, { runId, piEntryId: `pi-p${backend.promptCounter}u` }),
      );
      const assistantTurn = makeTurn(`p${backend.promptCounter}a`, branchId, "assistant", `echo:[${text}]`, {
        runId,
        piEntryId: `pi-p${backend.promptCounter}a`,
      });
      view.turns.push(assistantTurn);
      backend.treeState.cursor = { treeId: TREE, branchId, entryId: assistantTurn.piEntryId! };
      return respond(200, { outcome: { kind: "completed" }, state: backend.treeState });
    }
    return respond(404, { error: { code: "not-found", message: `no route for ${method} ${p}` } });
  };

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

  appLoadCounter += 1;
  await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(APP_JS)}#load=${appLoadCounter}`);
  await settle(25);

  return {
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
    setSelection: (range) => {
      scriptedSelection = range;
    },
    turnElement: (containerId, turnId) => {
      const container = documentStub.getElementById(containerId);
      assert.ok(container !== null, `missing container #${containerId}`);
      const found = container.querySelectorAll(".turn").find((t) => t.dataset.turnId === turnId);
      assert.ok(found !== undefined, `missing .turn[data-turn-id=${turnId}] in #${containerId}`);
      return found;
    },
    releaseHold: () => {
      assert.ok(releaseHoldFn !== null, "releaseHold requires a holdSuffix world");
      releaseHoldFn();
    },
  };
}

/* ------------------------------ 场景辅助 ------------------------------ */

/** 正文层首个非空文本节点（覆盖在场时可能被包裹/前置空前缀节点——取首
 *  个内容子节点或其内文本节点；桩 Range 的单文本节点语义下该节点的起点
 *  即 turn 正文偏移 0）。 */
function firstContentTextNode(turn: StubElement): StubText {
  for (const child of turn.children) {
    if (child instanceof StubElement && child.classList.contains("turn-actions")) break;
    if (child instanceof StubText && child.data.length > 0) return child;
    if (child instanceof StubElement) {
      const inner = child.firstChild;
      if (inner instanceof StubText && inner.data.length > 0) return inner;
    }
  }
  throw new Error("no text node found in the turn's content region");
}

/** 武装 a2 首词（A2_TERM）的选区（覆盖在场时同样可武装——首节点内偏移
 *  修真：该节点起点即正文偏移 0）。 */
async function armA2Term(world: World): Promise<StubElement> {
  const a2 = world.turnElement("conversation", "a2");
  const textNode = firstContentTextNode(a2);
  world.setSelection(new StubTextRange(textNode, 0, A2_TERM.length));
  a2.dispatchEvent("mouseup", {});
  assert.ok(a2.classList.contains("has-selection"), "the selection is armed");
  return a2;
}

/** 点开解释卡（武装 → 工具条解释 → 等待任务结果）。 */
async function explainA2Term(world: World): Promise<StubElement> {
  const a2 = await armA2Term(world);
  const toolbar = a2.querySelector(".selection-toolbar");
  assert.ok(toolbar !== null, "the armed toolbar renders");
  toolbar.querySelector(".toolbar-explain")!.click();
  await settle();
  const card = world.byId("term-explain-card");
  assert.ok(card !== null, "the explain card renders");
  return card;
}

/* ------------------------------------------------------------------ */
/* 1. 正文/操作分层 + textContent 字节等 + 异步刷新零变更                  */
/* ------------------------------------------------------------------ */

test("layered turn structure: prose is its own layer, textContent stays byte-identical, and an async refresh never replaces the content layer", async () => {
  const world = await createWorld();
  const conversation = world.el("conversation");

  const a2 = world.turnElement("conversation", "a2");
  const a2TextNode = a2.firstChild;
  assert.ok(a2TextNode instanceof StubText, "the prose layer is the turn's leading text node");
  assert.equal(a2TextNode.data, A2_TEXT, "without overlays the content layer is exactly the turn text");
  const actions = a2.querySelector(".turn-actions");
  assert.ok(actions !== null, "actions live in a dedicated .turn-actions layer");
  assert.ok(
    a2.children[a2.children.length - 1] === actions,
    "the actions layer is the trailing child — nothing action-like leaks into the content region",
  );
  assert.equal(
    contentRegionText(a2),
    A2_TEXT,
    "the content region's textContent is byte-identical to the turn text (copy source unchanged)",
  );
  assert.equal(a2.querySelector(".branch-here") !== null && a2.querySelector(".term-explain") !== null, true,
    "the persistent affordances render inside the actions layer");
  const turns = conversation.querySelectorAll(".turn");
  assert.deepEqual(
    turns.map((t) => t.dataset.turnId),
    ["u1", "a1", "u2", "a2"],
    "turn order is the product order",
  );

  /* 武装选区 + 异步刷新（SSE 终态 → /state → renderAll）：零 DOM 变更——
     turn 元素与正文文本节点的身份原样保留（③「选择期间不重绘」）。 */
  await armA2Term(world);
  assert.ok(a2.querySelector(".selection-toolbar") !== null, "an armed selection renders the toolbar");
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  const a2After = world.turnElement("conversation", "a2");
  assert.equal(a2After, a2, "the content layer element keeps its identity across the async refresh");
  assert.equal(a2After.firstChild, a2TextNode, "the prose text node itself is never replaced mid-selection");
  assert.equal(a2After.classList.contains("has-selection"), true, "the armed state survives the refresh");
  assert.ok(a2After.querySelector(".selection-toolbar") !== null, "the armed toolbar survives the refresh");
  assert.equal(contentRegionText(a2After), A2_TEXT, "textContent is still byte-identical after the refresh");

  /* 结构未变的刷新对整个容器零变更：子节点序列逐位同一。 */
  const childrenBefore = [...conversation.children];
  world.liveSse().emit("run-terminal", { runId: "run-y" });
  await settle();
  const childrenAfter = [...world.el("conversation").children];
  assert.equal(
    childrenBefore.length === childrenAfter.length && childrenBefore.every((n, i) => n === childrenAfter[i]),
    true,
    "a no-op refresh performs zero DOM mutations on the conversation container",
  );

  /* 新 turn 到达（prompt）：既有 turn 元素不被换走，新元素追加。 */
  world.el("prompt-input").value = "A third trunk question.";
  world.el("send").click();
  await settle();
  const a2AfterPrompt = world.turnElement("conversation", "a2");
  assert.equal(a2AfterPrompt, a2, "existing turn elements survive the arrival of new turns");
  assert.equal(a2AfterPrompt.firstChild, a2TextNode, "and so do their prose text nodes");
  world.turnElement("conversation", "p1a");
  assert.equal(contentRegionText(a2AfterPrompt), A2_TEXT, "textContent is byte-identical after the new turn");
});

/* ------------------------------------------------------------------ */
/* 2. 选择期间不重绘：拖拽窗口内延后会改变区间覆盖的重渲                  */
/* ------------------------------------------------------------------ */

test("selection drag window: an overlay-changing re-render is deferred until mouseup — the content layer is never swapped under the cursor", async () => {
  const world = await createWorld();
  const a2 = world.turnElement("conversation", "a2");
  const a2TextNode = a2.firstChild;
  assert.ok(a2TextNode instanceof StubText);

  /* 打开支线面板（View source 的入口在面板头部）。 */
  world.tabButton("branch-1")!.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "the branch panel opens");

  /* mousedown 开启拖拽窗口（正文层上的按下）。 */
  a2.dispatchEvent("mousedown", {});
  /* 窗口内触发揭示（会改变 a1 的区间覆盖——高亮本应立即落位）。 */
  world.el("panel-view-source").click();
  await settle();
  const a1DuringDrag = world.turnElement("conversation", "a1");
  assert.equal(
    a1DuringDrag.querySelector(".source-highlight"),
    null,
    "the reveal highlight is deferred while the selection drag window is open",
  );
  const a2DuringDrag = world.turnElement("conversation", "a2");
  assert.equal(a2DuringDrag, a2, "the dragged turn element is untouched during the window");
  assert.equal(a2DuringDrag.firstChild, a2TextNode, "its prose text node is untouched during the window");

  /* mouseup 收尾：冲刷被延后的重渲——高亮按存储偏移落位。 */
  world.setSelection(null);
  a2.dispatchEvent("mouseup", {});
  await settle();
  const a1After = world.turnElement("conversation", "a1");
  const mark = a1After.querySelector(".source-highlight");
  assert.ok(mark !== null, "the deferred reveal renders after the drag concludes");
  assert.equal(mark.textContent, "First", "the highlight is the anchored slice");
  const a2After = world.turnElement("conversation", "a2");
  assert.equal(a2After, a2, "the turn element identity still holds after the flush");
  assert.equal(contentRegionText(a1After), A1_TEXT, "the overlaid turn's textContent stays byte-identical");
});

/* ------------------------------------------------------------------ */
/* 3. 模式/工具条 + 键盘（点词/划线/触屏武装、Esc 分层、焦点还原）        */
/* ------------------------------------------------------------------ */

test("toolbar modes: single-word selections arm term mode, spans arm range mode (exact POST payloads), dblclick arms like mouseup, and Esc closes the card with focus return", async () => {
  const world = await createWorld();
  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);

  /* 单词选区 → term 模式（工具条按钮文案 + POST mode）。 */
  world.setSelection(new StubTextRange(textNode, 0, A2_TERM.length));
  a2.dispatchEvent("mouseup", {});
  const toolbar = a2.querySelector(".selection-toolbar");
  assert.ok(toolbar !== null, "the toolbar renders inside the actions layer when armed");
  assert.equal(toolbar.getAttribute("role"), "toolbar", "the toolbar carries its landmark role");
  const explainTerm = toolbar.querySelector(".toolbar-explain")!;
  assert.equal(explainTerm.textContent, "⌖ Explain term", "a single-word selection arms term mode");
  assert.ok(toolbar.querySelector(".toolbar-branch") !== null, "the toolbar offers the generic branch entry");
  explainTerm.click();
  await settle();
  let post = world.lastRequest("/terminology/explain");
  assert.ok(post !== null && post.method === "POST");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  assert.equal(body.mode, "term", "term mode is posted to the service");
  assert.equal(body.anchorTurnId, "a2");
  const sel = asRecord(body.selection);
  assert.ok(sel !== null);
  assert.deepEqual(
    { start: sel.start, end: sel.end, text: sel.text },
    { start: 0, end: A2_TERM.length, text: A2_TERM },
    "the exact armed offsets are submitted",
  );

  /* Esc 关卡：主线解释卡关闭 + 焦点还原到该答案的解释入口。 */
  const card = world.byId("term-explain-card");
  assert.ok(card !== null, "the explain card is open");
  assert.equal(world.document.activeElement, card, "the card takes focus when it opens");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.equal(world.byId("term-explain-card"), null, "Esc closes the card");
  const explainEntry = world.turnElement("conversation", "a2").querySelector(".term-explain");
  assert.ok(explainEntry !== null);
  assert.equal(world.document.activeElement, explainEntry, "Esc returns focus to that answer's explain entry");

  /* 跨词选区 → range 模式。 */
  const spanStart = A2_TEXT.indexOf("regularization shrinks");
  const spanEnd = spanStart + "regularization shrinks".length;
  world.setSelection(new StubTextRange(textNode, spanStart, spanEnd));
  a2.dispatchEvent("mouseup", {});
  const toolbar2 = world.turnElement("conversation", "a2").querySelector(".selection-toolbar");
  assert.ok(toolbar2 !== null);
  assert.equal(toolbar2.querySelector(".toolbar-explain")!.textContent, "⌖ Explain span",
    "a multi-word selection arms range mode");
  toolbar2.querySelector(".toolbar-explain")!.click();
  await settle();
  post = world.lastRequest("/terminology/explain");
  assert.equal(asRecord(post!.body)!.mode, "range", "range mode is posted to the service");

  /* 点词（双击）与划线同一路径武装。 */
  world.document.dispatchEvent("keydown", { key: "Escape" });
  world.setSelection(new StubTextRange(textNode, 0, A2_TERM.length));
  world.turnElement("conversation", "a2").dispatchEvent("dblclick", {});
  const a2Dbl = world.turnElement("conversation", "a2");
  assert.ok(a2Dbl.classList.contains("has-selection"), "a double-click arms the selection like mouseup");
  assert.ok(a2Dbl.querySelector(".selection-toolbar") !== null, "the toolbar arms from dblclick");
  assert.equal(a2Dbl.querySelector(".term-explain")!.disabled, false, "the explain entry is armed by dblclick");
});

test("Esc layering with the term card: a card inside the open panel closes before the panel; the panel branch keeps its semantics", async () => {
  const world = await createWorld();
  world.tabButton("branch-1")!.click();
  await settle();
  const ba1 = world.turnElement("panel-conversation", "ba1");
  const textNode = ba1.firstChild;
  assert.ok(textNode instanceof StubText);
  const lassoStart = BA1_TEXT.indexOf("lasso");
  world.setSelection(new StubTextRange(textNode, lassoStart, lassoStart + "lasso".length));
  ba1.dispatchEvent("mouseup", {});
  const toolbar = ba1.querySelector(".selection-toolbar");
  assert.ok(toolbar !== null, "the toolbar arms inside the panel view");
  toolbar.querySelector(".toolbar-explain")!.click();
  await settle();
  assert.ok(world.byId("term-explain-card") !== null, "the card opens in the panel view");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.equal(world.byId("term-explain-card"), null, "Esc closes the panel-view card first");
  assert.equal(world.el("branch-panel").hidden, false, "the panel itself stays open");
  const ba1Entry = world.turnElement("panel-conversation", "ba1").querySelector(".term-explain");
  assert.ok(ba1Entry !== null);
  assert.equal(world.document.activeElement, ba1Entry, "focus returns to the panel answer's explain entry");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(world.el("branch-panel").hidden, true, "the next Esc closes the panel");
});

/* ------------------------------------------------------------------ */
/* 4. 解释卡完整状态（缓存/失败+重试/取消+迟到丢弃/幂等保存/迟到响应丢弃） */
/* ------------------------------------------------------------------ */

test("explain card states: cached success note, honest failure with a working retry, cancelled with the late-discard note, and idempotent save showing the existing annotation", async () => {
  /* 缓存命中注记。 */
  {
    const world = await createWorld({ explainScript: "cached" });
    const card = await explainA2Term(world);
    assert.ok(card.textContent.includes("Cached explanation of"), "the card shows the task result");
    assert.ok(card.textContent.includes("served from the executor cache — no new request"),
      "cache hits are labeled honestly");
    assert.ok(card.querySelector(".term-save") !== null, "a cache hit still offers the explicit save");
  }

  /* 失败：诚实错误 + 重试可用。 */
  {
    const world = await createWorld({ explainScript: "fail" });
    const card = await explainA2Term(world);
    assert.ok(card.textContent.includes("explanation failed — upstream-error: scripted upstream failure"),
      "the card shows the honest error");
    const retry = card.querySelector(".term-explain-retry");
    assert.ok(retry !== null, "the failed card offers a retry");
    world.backend.explainScript = "ok";
    retry.click();
    await settle();
    const retried = world.byId("term-explain-card");
    assert.ok(retried !== null && retried.textContent.includes("Scripted explanation of"),
      "the retry succeeds and renders the explanation");
  }

  /* 取消 + 迟到丢弃注记（诚实成本口径）。 */
  {
    const world = await createWorld({ explainScript: "cancelled-late" });
    const card = await explainA2Term(world);
    assert.ok(
      card.textContent.includes("cancelled — a late result arrived after the cancellation and was discarded"),
      "the cancelled state names the discarded late result honestly",
    );
    assert.ok(card.textContent.includes("the request cost is still recorded"), "the honest cost note is shown");
    assert.ok(card.querySelector(".term-explain-retry") !== null, "a cancelled card is retryable");
  }
  {
    const world = await createWorld({ explainScript: "cancelled" });
    const card = await explainA2Term(world);
    assert.ok(
      card.textContent.includes("cancelled — the explanation task was cancelled before completing"),
      "the plain cancelled state renders distinctly",
    );
  }

  /* 保存幂等：再次解释同选区 → 服务端去重命中 → 显示既有批注。 */
  {
    const world = await createWorld({});
    const card = await explainA2Term(world);
    card.querySelector(".term-save")!.click();
    await settle();
    const saved = world.byId("term-explain-card");
    assert.ok(saved !== null && saved.textContent.includes("saved — promote to a follow-up branch"),
      "the first save renders the promotion form");
    assert.ok(world.lastRequest("/terminology/annotations") !== null, "the save posts");
    /* 再次解释同一选区（服务端 ② 去重：零模型调用返回既有批注）。 */
    const card2 = await explainA2Term(world);
    assert.ok(card2.textContent.includes("already saved — showing the existing annotation for this exact selection"),
      "the dedup hit shows the existing annotation instead of pretending a new save");
    assert.equal(
      world.requestsOf("/terminology/explain").length,
      2,
      "the second explain posts once (the service dedups to the existing annotation)",
    );
    const dedupPost = world.lastRequest("/terminology/explain")!;
    assert.equal(asRecord(dedupPost.body)!.mode, "term");
  }
});

test("late explain responses are discarded honestly when the target leaves: no resurrection of a closed card, counted in the drawer usage", async () => {
  const world = await createWorld({ explainDelay: true });
  const a2 = await armA2Term(world);
  a2.querySelector(".selection-toolbar")!.querySelector(".toolbar-explain")!.click();
  const loadingCard = world.byId("term-explain-card");
  assert.ok(loadingCard !== null, "the loading card renders immediately");
  assert.ok(loadingCard.textContent.includes("explaining (isolated terminology task)…"), "the in-flight state is shown");
  /* 用户在响应到达前关闭卡（Dismiss 不经 guard——在途可关）。 */
  loadingCard.querySelector(".term-explain-close")!.click();
  assert.equal(world.byId("term-explain-card"), null, "the card is dismissed while the request is in flight");
  await settle();
  assert.equal(
    world.byId("term-explain-card"),
    null,
    "the late response never resurrects the dismissed card",
  );
  /* 抽屉用量行如实计数客户端迟到丢弃。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");
  assert.ok(drawer.textContent.includes("Terminology"), "the drawer has the Terminology section");
  assert.ok(
    drawer.textContent.includes("1 late response(s) discarded client-side"),
    "the client-side late discard is counted in the usage line",
  );
  assert.ok(
    drawer.textContent.includes("1 late result(s) discarded by the executor"),
    "the server-side late discard count stays separate",
  );
});

/* ------------------------------------------------------------------ */
/* 5. 统一标注/来源区间：同一切片机制、重渲复现、并存、textContent 不变    */
/* ------------------------------------------------------------------ */

test("unified range overlays: annotation marks and the source highlight share one slice-exact mechanism, survive re-renders, and never alter the text", async () => {
  const world = await createWorld({
    termAnnotations: [
      termAnnotation({ id: "term-ann-a", selection: { start: 0, end: A2_TERM.length, text: A2_TERM }, term: A2_TERM }),
      termAnnotation({
        id: "term-ann-b",
        selection: { start: A2_SECOND_TERM_START, end: A2_SECOND_TERM_START + 5, text: "lasso" },
        term: "lasso",
        mode: "range",
        explanation: "Second seeded annotation.",
      }),
    ],
  });
  const a2 = world.turnElement("conversation", "a2");
  /* 开树拉取读模型后：两条批注覆盖按存储偏移渲染（重复词两处各自命中）。 */
  const marks = a2.querySelectorAll(".term-annotation-mark");
  assert.equal(marks.length, 2, "both saved annotations render as range overlays");
  assert.equal(marks[0]!.textContent, A2_TERM, "the first mark is the first annotation's slice");
  assert.equal(marks[1]!.textContent, "lasso", "the second occurrence of the same word is its own annotation");
  assert.equal(
    marks[0]!.parentElement === a2 && marks[1]!.parentElement === a2,
    true,
    "overlay spans wrap text inside the content region",
  );
  assert.equal(contentRegionText(a2), A2_TEXT, "textContent is byte-identical with overlays applied (copy-safe)");
  /* 既有 DOM 形状保持：前缀/标记/后缀三段恰切（空前缀也是文本节点）。 */
  const emptyPrefix = a2.children[0];
  assert.ok(emptyPrefix instanceof StubText && emptyPrefix.data === "", "the empty prefix renders as a text node (original shape)");
  assert.equal(a2.children[1], marks[0], "the first mark follows the (empty) prefix node");
  const midText = a2.children[2];
  assert.ok(midText instanceof StubText && midText.data === A2_TEXT.slice(5, A2_SECOND_TERM_START),
    "the text between the two marks is the exact mid slice");
  assert.equal(a2.children[3], marks[1], "the second mark follows the mid slice");

  /* 重渲（SSE 终态）后按存储偏移复现（不依赖 DOM 残留）。 */
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  const a2After = world.turnElement("conversation", "a2");
  const marksAfter = a2After.querySelectorAll(".term-annotation-mark");
  assert.equal(marksAfter.length, 2, "annotation overlays survive the re-render");
  assert.equal(marksAfter[0]!.textContent, A2_TERM);
  assert.equal(marksAfter[1]!.textContent, "lasso");
  assert.equal(contentRegionText(a2After), A2_TEXT, "textContent stays byte-identical after the re-render");

  /* 来源揭示（a1）与批注覆盖（a2）在同一视图并存——统一机制。 */
  world.tabButton("branch-1")!.click();
  await settle();
  world.el("panel-view-source").click();
  await settle();
  const a1 = world.turnElement("conversation", "a1");
  const sourceMark = a1.querySelector(".source-highlight");
  assert.ok(sourceMark !== null, "the source reveal renders its highlight");
  assert.equal(sourceMark.textContent, "First", "the source highlight is the anchored slice");
  const prefix = a1.children[0];
  assert.ok(prefix instanceof StubText, "the node before the source mark is the prefix text node");
  assert.equal(prefix.data, "", "the a1 anchor starts at offset 0");
  const suffix = a1.children[2];
  assert.ok(suffix instanceof StubText, "the node after the source mark is the suffix text node");
  assert.equal(suffix.data, A1_TEXT.slice(5), "the suffix resumes exactly at the anchor end offset");
  assert.equal(contentRegionText(a1), A1_TEXT, "the revealed turn's textContent stays byte-identical");
  assert.equal(
    world.turnElement("conversation", "a2").querySelectorAll(".term-annotation-mark").length,
    2,
    "annotation overlays and the source highlight coexist in the same view",
  );

  /* 点击批注覆盖重开该批注的卡（读模型数据面，零请求）。 */
  const explainRequestsBefore = world.requestsOf("/terminology/explain").length;
  world.turnElement("conversation", "a2").querySelector(".term-annotation-mark")!.click();
  await settle();
  const card = world.byId("term-explain-card");
  assert.ok(card !== null, "clicking an annotation overlay reopens its card");
  assert.ok(card.textContent.includes("Seeded explanation of the seeded term."), "the card shows the saved explanation");
  assert.equal(
    world.requestsOf("/terminology/explain").length,
    explainRequestsBefore,
    "reopening a saved annotation issues no new explain request",
  );
});

/* ------------------------------------------------------------------ */
/* 6. 已有探索：resume-or-create 明确二选（绝不静默复用/第二推广表单）      */
/* ------------------------------------------------------------------ */

test("resume-or-create: an already-promoted annotation surfaces the existing follow-up explicitly — no second promotion form, no silent reuse", async () => {
  const world = await createWorld({
    termAnnotations: [
      termAnnotation({
        promotedBranchId: "branch-term-1",
        promotionKey: "promo-seeded",
      }),
    ],
    promotedBranchView: { id: "branch-term-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO },
  });
  const a2 = world.turnElement("conversation", "a2");
  /* 批注覆盖在场：武装同选区（首节点内偏移修真）。 */
  const mark = a2.querySelector(".term-annotation-mark");
  assert.ok(mark !== null, "the promoted annotation renders its overlay");
  const markText = mark.firstChild;
  assert.ok(markText instanceof StubText, "the overlay wraps a text node");
  world.setSelection(new StubTextRange(markText, 0, A2_TERM.length));
  a2.dispatchEvent("mouseup", {});
  const toolbar = a2.querySelector(".selection-toolbar");
  assert.ok(toolbar !== null, "the toolbar arms over the overlaid selection");
  assert.equal(toolbar.querySelector(".toolbar-annotation")!.textContent, "✓ Follow-up exists",
    "the toolbar names the existing follow-up");
  assert.equal(toolbar.querySelector(".toolbar-promote"), null,
    "no promote shortcut for an already-promoted annotation");

  /* 打开已存批注卡：resume-or-create 二选。 */
  toolbar.querySelector(".toolbar-annotation")!.click();
  await settle();
  const card = world.byId("term-explain-card");
  assert.ok(card !== null, "the saved-annotation card opens without a request");
  assert.ok(card.textContent.includes("saved — already promoted to Branch 2"),
    "the card names the existing follow-up branch");
  assert.equal(card.querySelector("#term-first-question"), null, "no second promotion form is offered");
  assert.equal(card.querySelector(".term-promote"), null, "no promote button for the promoted annotation");
  assert.ok(card.textContent.includes("to start a different one, select a different span"),
    "the explicit different-follow-up guidance is shown");
  const resume = card.querySelector(".term-resume")!;
  assert.equal(resume.textContent, "Open the follow-up branch");

  /* 恢复既有探索：点击打开该支线面板（明确去向，不静默复用）。 */
  resume.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "the promoted branch opens in the panel");
  assert.equal(world.el("panel-title").textContent, "Branch 2", "the panel opens the promoted branch");
  assert.equal(world.byId("term-explain-card"), null, "the card closes when resuming");
});

/* ------------------------------------------------------------------ */
/* 7. 推广：成功 / 同键重放注记 / 409 冲突上卡 / 响应丢失→恢复既有探索     */
/* ------------------------------------------------------------------ */

test("promotion outcomes: success opens the branch, a same-key replay is named honestly, and a 409 conflict lands on the card with the same-key retry kept", async () => {
  /* 成功（created）。 */
  {
    const world = await createWorld({});
    const card = await explainA2Term(world);
    card.querySelector(".term-save")!.click();
    await settle();
    const saved = world.byId("term-explain-card")!;
    const input = saved.querySelector("#term-first-question")!;
    input.value = "Why does this term matter here?";
    input.dispatchEvent("input", {});
    saved.querySelector(".term-promote")!.click();
    await settle();
    const post = world.lastRequest("/promote");
    assert.ok(post !== null && post.method === "POST");
    const body = asRecord(post.body)!;
    assert.equal(body.firstQuestion, "Why does this term matter here?");
    assert.ok(typeof body.idempotencyKey === "string" && body.idempotencyKey !== "", "the promotion carries an idempotency key");
    assert.equal(world.el("branch-panel").hidden, false, "the follow-up branch opens in the panel");
    assert.equal(world.byId("term-explain-card"), null, "the card closes after a successful promotion");
  }

  /* 同键重放（created:false）——「打开的是既有推广」如实注记。 */
  {
    const world = await createWorld({ promoteScript: "replay" });
    const card = await explainA2Term(world);
    card.querySelector(".term-save")!.click();
    await settle();
    const saved = world.byId("term-explain-card")!;
    const input = saved.querySelector("#term-first-question")!;
    input.value = "First question for the replayed branch.";
    input.dispatchEvent("input", {});
    saved.querySelector(".term-promote")!.click();
    await settle();
    assert.equal(world.el("branch-panel").hidden, false, "the existing branch opens");
    assert.equal(
      world.el("panel-error-banner").textContent.includes("Opened the existing follow-up branch (same promotion key — no duplicate dispatch)"),
      true,
      "the replay outcome is named honestly",
    );
  }

  /* 409 冲突：如实上卡 + 同键重试保留（草稿不丢）。 */
  {
    const world = await createWorld({ promoteScript: "conflict" });
    const card = await explainA2Term(world);
    card.querySelector(".term-save")!.click();
    await settle();
    const saved = world.byId("term-explain-card")!;
    const input = saved.querySelector("#term-first-question")!;
    input.value = "A question that will conflict.";
    input.dispatchEvent("input", {});
    saved.querySelector(".term-promote")!.click();
    await settle();
    const conflicted = world.byId("term-explain-card");
    assert.ok(conflicted !== null, "the card stays open on conflict");
    assert.ok(
      conflicted.textContent.includes("promotion conflict — terminology-promotion-conflict:"),
      "the conflict lands on the card with its honest error",
    );
    const retryInput = conflicted.querySelector("#term-first-question");
    assert.ok(retryInput !== null, "the same-key retry path stays available");
    assert.equal(retryInput.value, "A question that will conflict.", "the first-question draft survives the conflict");
    assert.ok(conflicted.textContent.includes("the idempotency key stays for a same-key retry"),
      "the same-key retry guidance is shown");
    assert.equal(world.el("branch-panel").hidden, true, "no branch was created by the conflicted attempt");
  }
});

test("promotion response loss resolves to the recorded promotion: the card refreshes to the resume affordance instead of pretending nothing happened", async () => {
  const world = await createWorld({ promoteScript: "lose-response" });
  const card = await explainA2Term(world);
  card.querySelector(".term-save")!.click();
  await settle();
  const saved = world.byId("term-explain-card")!;
  const input = saved.querySelector("#term-first-question")!;
  input.value = "First question whose response will be lost.";
  input.dispatchEvent("input", {});
  saved.querySelector(".term-promote")!.click();
  await settle();
  const afterLoss = world.byId("term-explain-card");
  assert.ok(afterLoss !== null, "the card stays open after the response loss");
  assert.ok(afterLoss.textContent.includes("promotion conflict —"), "the failure is surfaced on the card");
  assert.ok(afterLoss.textContent.includes("saved — already promoted to"), "the refreshed annotation reveals the recorded promotion");
  assert.ok(afterLoss.querySelector(".term-resume") !== null, "the resume affordance is offered");
  afterLoss.querySelector(".term-resume")!.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "resuming opens the promoted branch");
  assert.equal(world.el("panel-title").textContent, "Branch 2");
  /* 服务端事实：至多一条推广分支（响应丢失不重复建枝）。 */
  const promotedBranches = world.backend.termAnnotations.filter((a) => a.promotedBranchId !== null);
  assert.equal(promotedBranches.length, 1);
});

/* ------------------------------------------------------------------ */
/* 8. 响应式/触屏/reduced-motion：CSS 词法 + selectionchange 武装         */
/* ------------------------------------------------------------------ */

test("narrow window and reduced motion: the ③ CSS rules are locked lexically (toolbar/card full width under 720px; card entrance animation neutralized under reduce)", () => {
  const narrow = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(max-width: 719px)");
  assert.ok(narrow !== undefined, "style.css carries the <720px narrow-window media query");
  const toolbarDecl = declarationsOf(narrow, ".selection-toolbar");
  assert.ok(toolbarDecl !== null, "the narrow block styles the selection toolbar");
  assert.ok(toolbarDecl.includes("width: 100%"), "the toolbar goes full width under 720px");
  const toolbarButtonsDecl = declarationsOf(narrow, ".selection-toolbar button");
  assert.ok(toolbarButtonsDecl !== null, "the narrow block styles the toolbar buttons");
  assert.ok(toolbarButtonsDecl.includes("padding: 8px 12px"), "toolbar buttons enlarge their touch targets");
  const cardActionsDecl = declarationsOf(narrow, ".term-explain-card .term-explain-actions");
  assert.ok(cardActionsDecl !== null, "the narrow block restacks the card actions");
  assert.ok(cardActionsDecl.includes("flex-direction: column"), "card actions stack vertically under 720px");

  const reduced = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(prefers-reduced-motion: reduce)");
  assert.ok(reduced !== undefined, "style.css carries the prefers-reduced-motion media query");
  assert.ok(
    declarationsOf(reduced, ".term-explain-card.enter")!.includes("animation: none"),
    "the card entrance animation is explicitly neutralized under reduce",
  );

  /* 基础层：工具条/标注下划线/解释卡进场动效在场（媒体块之外）。 */
  const base = baseCssLayer(STYLE_CSS);
  assert.ok(
    /\.selection-toolbar\s*\{[^{}]*display:\s*inline-flex/.test(base),
    "the base layer styles the selection toolbar",
  );
  assert.ok(
    /\.turn\s+\.term-annotation-mark\s*\{[^{}]*text-decoration:\s*underline/.test(base),
    "saved annotations render as underlines in the base layer",
  );
  assert.ok(
    /\.term-explain-card\.enter\s*\{[^{}]*animation:\s*term-card-in/.test(base),
    "the card entrance animation exists in the base layer",
  );
  assert.ok(/@keyframes term-card-in\s*\{/.test(base), "term-card-in keyframes are present");
});

test("touch selection: selectionchange arms the toolbar without mouseup, and an emptied selection disarms it after the deferred check", async () => {
  const world = await createWorld();
  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);

  /* 触屏长按/拖把手：selectionchange 武装（无需 mouseup）。 */
  world.setSelection(new StubTextRange(textNode, 0, A2_TERM.length));
  world.document.dispatchEvent("selectionchange", {});
  const a2Armed = world.turnElement("conversation", "a2");
  assert.ok(a2Armed.classList.contains("has-selection"), "selectionchange arms the selection state");
  assert.ok(a2Armed.querySelector(".selection-toolbar") !== null, "the toolbar arms from selectionchange");
  assert.equal(a2Armed.querySelector(".term-explain")!.disabled, false, "the explain entry arms too");

  /* 空选区：延迟判定后解除（工具条退场、入口回禁用）。 */
  world.setSelection(null);
  world.document.dispatchEvent("selectionchange", {});
  await settle();
  const a2Disarmed = world.turnElement("conversation", "a2");
  assert.ok(!a2Disarmed.classList.contains("has-selection"), "an emptied touch selection disarms");
  assert.equal(a2Disarmed.querySelector(".selection-toolbar"), null, "the toolbar leaves with the disarm");
  assert.equal(a2Disarmed.querySelector(".term-explain")!.disabled, true, "the explain entry disarms");
});

/* ------------------------------------------------------------------ */
/* 9. 回程草稿焦点非回归 + 解释卡首问草稿跨重渲                          */
/* ------------------------------------------------------------------ */

test("return draft/focus discipline holds under the layered renderer: submit closes the panel to the main input; the term-card first-question draft keeps its value and focus across re-renders", async () => {
  const world = await createWorld();
  world.tabButton("branch-1")!.click();
  await settle();

  /* Return 草稿：输入 → 提交 → 面板收起、焦点回主线输入框。 */
  const returnInput = world.el("return-input");
  returnInput.value = "The branch conclusion worth returning.";
  returnInput.dispatchEvent("input", {});
  world.el("submit-return").click();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 220)); /* 面板退场动效（PANEL_EXIT_MS=170ms）收尾 */
  assert.equal(world.el("branch-panel").hidden, true, "submitting the return closes the panel");
  assert.equal(world.document.activeElement, world.el("prompt-input"), "focus returns to the main composer");
  const trunkTurns = world.el("conversation").querySelectorAll(".turn").map((t) => t.dataset.turnId);
  assert.ok(trunkTurns.includes("r-1"), "the return card renders on the Trunk");

  /* 解释卡首问草稿：值入 state、重渲保值、焦点经 preserve 恢复。 */
  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);
  world.setSelection(new StubTextRange(textNode, 0, A2_TERM.length));
  a2.dispatchEvent("mouseup", {});
  a2.querySelector(".selection-toolbar")!.querySelector(".toolbar-explain")!.click();
  await settle();
  const card = world.byId("term-explain-card")!;
  card.querySelector(".term-save")!.click();
  await settle();
  const saved = world.byId("term-explain-card")!;
  const input = saved.querySelector("#term-first-question")!;
  input.value = "Keep this draft across re-renders.";
  input.dispatchEvent("input", {});
  input.focus();
  assert.equal(world.document.activeElement, input, "the first-question input holds focus while typing");
  world.liveSse().emit("run-terminal", { runId: "run-z" });
  await settle();
  const inputAfter = world.byId("term-first-question");
  assert.ok(inputAfter !== null, "the promotion input survives the re-render");
  assert.notEqual(inputAfter, input, "the card layer is rebuilt (a fresh node)");
  assert.equal(inputAfter.value, "Keep this draft across re-renders.", "the draft value survives via state");
  assert.equal(world.document.activeElement, inputAfter, "focus is restored onto the fresh input");
});

/* ------------------------------------------------------------------ */
/* 10. 抽屉执行器面：任务/模式、用量、缓存偏好（成功/失败/重试）、读模型失败 */
/* ------------------------------------------------------------------ */

test("drawer terminology surface: tasks with modes, honest usage counts, cache preference toggle with a retryable failure, and the read-model failure state", async () => {
  const world = await createWorld({
    termAnnotations: [termAnnotation()],
    termTasks: [
      {
        id: "t1",
        kind: "explain",
        mode: "term",
        treeId: TREE,
        term: "Lasso",
        selection: { start: 0, end: 5, text: "Lasso" },
        createdAt: ISO,
        state: { kind: "succeeded", explanation: "ok", candidates: null, cached: true, usage: { requests: 0 } },
      },
      {
        id: "t2",
        kind: "extract",
        mode: "auto",
        treeId: TREE,
        term: null,
        selection: null,
        createdAt: ISO,
        state: { kind: "failed", code: "budget-exceeded", message: "budget exhausted" },
      },
      {
        id: "t3",
        kind: "explain",
        mode: "range",
        treeId: TREE,
        term: "some span",
        selection: { start: 6, end: 12, text: "some span" },
        createdAt: ISO,
        state: { kind: "cancelled", lateResultDiscarded: true },
      },
    ],
  });
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");

  /* 批注出处（既有形状保持）。 */
  assert.ok(drawer.textContent.includes("“Lasso” (term) from Trunk"), "annotations list with term and source branch");
  assert.ok(drawer.textContent.includes("not promoted"), "the promotion state is listed");

  /* 近期任务：三模式任务态如实。 */
  assert.ok(drawer.textContent.includes("explain · term · succeeded (from cache)"), "term-mode cache hit is listed");
  assert.ok(drawer.textContent.includes("extract · auto · failed (budget-exceeded)"), "auto extract failure is listed");
  assert.ok(drawer.textContent.includes("explain · range · cancelled (late result discarded)"), "range-mode late discard is listed");

  /* 用量（诚实估算 + 双侧迟到丢弃计数）。 */
  assert.ok(drawer.textContent.includes("est. 50/1000000 tokens (chars/4 estimate)"), "the budget usage line is honest about its estimate");
  assert.ok(drawer.textContent.includes("0 late response(s) discarded client-side"), "client-side discards count from zero");

  /* 缓存偏好：切换（PUT 载荷精确）→ 行内状态更新。 */
  const toggle = drawer.querySelector(".term-cache-toggle")!;
  assert.ok(toggle.textContent.includes("cache preference: on"), "the current preference is shown");
  toggle.click();
  await settle();
  const put = world.lastRequest("/terminology/preferences");
  assert.ok(put !== null && put.method === "PUT", "the toggle PUTs the preference");
  assert.deepEqual(asRecord(put!.body), { cacheEnabled: false }, "the PUT body is exact");
  const toggleAfter = world.el("source-drawer").querySelector(".term-cache-toggle")!;
  assert.ok(toggleAfter.textContent.includes("cache preference: off"), "the preference line updates in place");
  assert.ok(world.el("source-drawer").textContent.includes("cache off"), "the usage line reflects the preference");

  /* 失败态：如实 + 可重试。 */
  world.backend.prefsFail = true;
  world.el("source-drawer").querySelector(".term-cache-toggle")!.click();
  await settle();
  const drawerFailed = world.el("source-drawer");
  assert.ok(drawerFailed.textContent.includes("cache preference failed — internal: scripted preferences failure"),
    "the preference failure is honest");
  const retryToggle = drawerFailed.querySelector(".term-cache-toggle");
  assert.ok(retryToggle !== null && !retryToggle.disabled, "the toggle stays retryable after a failure");

  /* 读模型失败态 + 重试（重试成功即补齐批注覆盖——正文区间层随读模型）。 */
  {
    const failWorld = await createWorld({ terminologyGetFail: true, termAnnotations: [termAnnotation()] });
    assert.equal(
      failWorld.turnElement("conversation", "a2").querySelector(".term-annotation-mark"),
      null,
      "no annotation overlays render while the read model is unavailable (honest absence, no fabrication)",
    );
    failWorld.el("source-drawer-toggle").click();
    await settle();
    const failDrawer = failWorld.el("source-drawer");
    assert.ok(failDrawer.textContent.includes("terminology failed to load"), "the read-model failure is shown");
    const retry = failDrawer.querySelector(".drawer-retry");
    assert.ok(retry !== null, "the failure state offers a retry");
    failWorld.backend.terminologyGetFail = false;
    retry.click();
    await settle();
    assert.ok(failWorld.el("source-drawer").textContent.includes("terminology executor:"),
      "a successful retry renders the executor surface");
    assert.ok(
      failWorld.turnElement("conversation", "a2").querySelector(".term-annotation-mark") !== null,
      "the retry's renderAll applies the annotation overlay from the recovered read model",
    );
  }
});

/* ------------------------------------------------------------------ */
/* 11. P0/P1 整改回归（issue #7 增量验收 2026-09-30「H前端函数探针」）     */
/* ------------------------------------------------------------------ */

/** 抽屉批注条目按术语定位（P0 降级说明的逐条断言用）。 */
function drawerAnnotationLi(drawer: StubElement, term: string): StubElement {
  const li = drawer.querySelectorAll("li").find((el) => el.textContent.includes(`“${term}”`));
  assert.ok(li !== undefined, `the drawer lists the annotation “${term}”`);
  return li;
}

test("P0 joint anchor validation: equal-length replacement, a moved word, an out-of-bounds deletion, and an off-range drift never attach an annotation to the wrong text — the intact one still renders", async () => {
  /* 五类漂移 + 一个完好对照（同一答案 a2 上并存的种子批注）：
   *  - 等长替换（验收探针的原样场景）：旧文 "old…" 与现文 "Las…" 等长，存
   *    储区间 [0,3) 界内成立、内容已换；
   *  - 同词移位：旧文 [8,13) 是 "lasso"，现文该处是 "gular"（lasso 在现文
   *    的另一处存在——绝不字符串搜索顶替）；
   *  - 删除越界：现文变短，存储区间末端越出界；
   *  - 区间外漂移（摘录完好、全文指纹失配）：sourceHash 半边的独立证明；
   *  - 锚点缺失：锚点 turn 不在树中（source missing）；
   *  - 完好对照：三重校验全过，活覆盖照常渲染。 */
  const equalLengthOldText = `old${A2_TEXT.slice(3)}`;
  const movedOldText = `${A2_TEXT.slice(0, 8)}lasso${A2_TEXT.slice(13)}`;
  const offRangeOldText = `${A2_TEXT} Amended tail.`;
  const deletedOldText = `${A2_TEXT} tail.`;
  const world = await createWorld({
    termAnnotations: [
      termAnnotation({
        id: "term-ann-valid",
        selection: { start: 0, end: A2_TERM.length, text: A2_TERM },
        term: "Lasso",
        explanation: "Intact seeded annotation.",
      }),
      termAnnotation({
        id: "term-ann-equal-length",
        selection: { start: 0, end: 3, text: "old" },
        sourceHash: sha256Of(equalLengthOldText),
        term: "oldish",
        explanation: "Saved against the pre-edit text.",
      }),
      termAnnotation({
        id: "term-ann-moved",
        selection: { start: 8, end: 13, text: "lasso" },
        sourceHash: sha256Of(movedOldText),
        term: "moved-lasso",
        explanation: "Saved where the word used to sit.",
      }),
      termAnnotation({
        id: "term-ann-off-range",
        selection: { start: A2_SECOND_TERM_START, end: A2_SECOND_TERM_START + 5, text: "lasso" },
        sourceHash: sha256Of(offRangeOldText),
        term: "hash-stale-lasso",
        mode: "range",
        explanation: "The excerpt is intact but the answer was edited elsewhere.",
      }),
      termAnnotation({
        id: "term-ann-deleted",
        selection: {
          start: A2_TEXT.length - 3,
          end: A2_TEXT.length + 6,
          text: `${A2_TEXT.slice(A2_TEXT.length - 3)} tail.`,
        },
        sourceHash: sha256Of(deletedOldText),
        term: "deleted-tail",
        explanation: "Saved against a longer text; the range is now out of bounds.",
      }),
      termAnnotation({
        id: "term-ann-missing",
        anchorTurnId: "no-such-turn",
        term: "ghost-anchor",
        explanation: "The anchored answer is gone.",
      }),
    ],
  });

  /* 活覆盖：只有三重校验全过的对照批注渲染（等长替换/移位/越界/指纹失配
     全部拦截——移位词也绝不顶替到现文的另一处）。 */
  const a2 = world.turnElement("conversation", "a2");
  const marks = a2.querySelectorAll(".term-annotation-mark");
  assert.equal(marks.length, 1, "only the intact annotation renders a live overlay");
  assert.equal(marks[0]!.textContent, A2_TERM, "the intact annotation underlines exactly its own slice");
  assert.equal(contentRegionText(a2), A2_TEXT, "the answer text stays byte-identical (no fabrication)");

  /* 降级呈现（W1 降级 Return 卡同款纪律）：保存快照照常可读 + 状态说明。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");
  for (const term of ["oldish", "moved-lasso", "hash-stale-lasso", "deleted-tail"]) {
    const li = drawerAnnotationLi(drawer, term);
    assert.ok(
      li.textContent.includes("source changed — the answer text drifted since saving (snapshot only, no live underline)"),
      `“${term}” is degraded with the explicit source-changed note`,
    );
  }
  const ghost = drawerAnnotationLi(drawer, "ghost-anchor");
  assert.ok(
    ghost.textContent.includes("source missing — the anchored answer is not in this tree (snapshot only)"),
    "the missing anchor is named explicitly",
  );
  const valid = drawerAnnotationLi(drawer, "Lasso");
  assert.ok(!valid.textContent.includes("source changed"), "the intact annotation carries no drift note");
  assert.ok(!valid.textContent.includes("source missing"), "the intact annotation carries no missing note");
  /* 快照可读性：失效批注的落库摘录仍在列表可读（不是隐藏或伪造）。 */
  assert.ok(drawerAnnotationLi(drawer, "oldish").textContent.includes("“old”"), "the saved excerpt stays readable");
});

test("P0 degraded card: a hash-stale annotation with an intact excerpt opens as the saved snapshot with an explicit drift note (toolbar shortcut and server dedup paths)", async () => {
  const world = await createWorld({
    termAnnotations: [
      termAnnotation({
        id: "term-ann-hash-stale",
        selection: { start: A2_SECOND_TERM_START, end: A2_SECOND_TERM_START + 5, text: "lasso" },
        sourceHash: sha256Of(`${A2_TEXT} Amended tail.`),
        term: "lasso",
        mode: "range",
        explanation: "Stale-hash snapshot explanation.",
      }),
    ],
  });
  const a2 = world.turnElement("conversation", "a2");
  assert.equal(a2.querySelectorAll(".term-annotation-mark").length, 0,
    "no live overlay: the full-text fingerprint no longer matches the answer (drift outside the excerpt is still drift)");
  assert.equal(contentRegionText(a2), A2_TEXT, "the answer text stays untouched");

  /* 判定在渲染路径上：重渲（SSE 终态）后同样不渲染。 */
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  assert.equal(
    world.turnElement("conversation", "a2").querySelectorAll(".term-annotation-mark").length,
    0,
    "the drift gate holds across re-renders",
  );

  /* 摘录完好的陈旧批注：武装同一选区（选区文本与摘录全等）→ 工具条捷径
     打开保存快照卡（零请求），卡面带 source changed 降级说明。 */
  const a2Again = world.turnElement("conversation", "a2");
  const textNode = firstContentTextNode(a2Again);
  world.setSelection(new StubTextRange(textNode, A2_SECOND_TERM_START, A2_SECOND_TERM_START + 5));
  a2Again.dispatchEvent("mouseup", {});
  const toolbar = a2Again.querySelector(".selection-toolbar");
  assert.ok(toolbar !== null, "arming the exact stored range still works");
  assert.equal(
    toolbar.querySelector(".toolbar-annotation")!.textContent,
    "✓ Saved annotation",
    "the toolbar offers the shortcut for the identical selection text (the excerpt itself is intact)",
  );
  toolbar.querySelector(".toolbar-annotation")!.click();
  await settle();
  const card = world.byId("term-explain-card");
  assert.ok(card !== null, "the saved-annotation card opens without a new request");
  assert.ok(card.textContent.includes("Stale-hash snapshot explanation."),
    "the card shows the saved snapshot explanation");
  assert.ok(
    card.textContent.includes("the anchored answer text has changed since this annotation was saved"),
    "the card names the drift explicitly (snapshot only, no live underline)",
  );

  /* 服务端同选区去重路径（按区间命中返回既有批注）同样落到降级卡面。 */
  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle();
  const a2Third = world.turnElement("conversation", "a2");
  world.setSelection(new StubTextRange(textNode, A2_SECOND_TERM_START, A2_SECOND_TERM_START + 5));
  a2Third.dispatchEvent("mouseup", {});
  a2Third.querySelector(".selection-toolbar")!.querySelector(".toolbar-explain")!.click();
  await settle();
  const dedupCard = world.byId("term-explain-card");
  assert.ok(dedupCard !== null, "the explain request lands (the server dedups to the existing annotation by range)");
  assert.ok(
    dedupCard.textContent.includes("already saved — showing the existing annotation for this exact selection"),
    "the dedup hit shows the existing annotation",
  );
  assert.ok(
    dedupCard.textContent.includes("the anchored answer text has changed since this annotation was saved"),
    "the dedup card carries the same explicit drift note",
  );
});

test("P0 astral content: a valid emoji-anchored annotation renders its exact surrogate-pair slice, and a surrogate-shifted stale range never attaches", async () => {
  const emojiText = "Gravity \u{1F600} waves bend spacetime; a second \u{1F600} marks the curvature.";
  const firstEmoji = emojiText.indexOf("\u{1F600}");
  const secondEmoji = emojiText.indexOf("\u{1F600}", firstEmoji + 2);
  /* 旧文在首 emoji 前多一个字符（保存时 emoji 位于 [firstEmoji+1, firstEmoji+3)）；
     现文删去该字符后，该存储区间横跨低代理 + 后续空格——切片必不相等。 */
  const shiftedOldText = `${emojiText.slice(0, firstEmoji)}X${emojiText.slice(firstEmoji)}`;
  const world = await createWorld({
    a2Text: emojiText,
    termAnnotations: [
      termAnnotation({
        id: "term-ann-astral-valid",
        selection: { start: secondEmoji, end: secondEmoji + 2, text: "\u{1F600}" },
        sourceHash: sha256Of(emojiText),
        term: "second-emoji",
        explanation: "Astral slice intact.",
      }),
      termAnnotation({
        id: "term-ann-astral-shifted",
        selection: { start: firstEmoji + 1, end: firstEmoji + 3, text: "\u{1F600}" },
        sourceHash: sha256Of(shiftedOldText),
        term: "shifted-emoji",
        explanation: "Saved before a one-char edit shifted the surrogate pair.",
      }),
    ],
  });
  const a2 = world.turnElement("conversation", "a2");
  const marks = a2.querySelectorAll(".term-annotation-mark");
  assert.equal(marks.length, 1, "only the intact astral annotation renders");
  assert.equal(marks[0]!.textContent, "\u{1F600}", "the overlay is exactly the astral slice");
  assert.equal(marks[0]!.textContent.length, 2, "the astral slice is two UTF-16 code units (no surrogate splitting)");
  assert.equal(contentRegionText(a2), emojiText, "textContent stays byte-identical with an astral overlay applied");
});

test("P1 stale read-model race: tree A's late terminology response never lands while tree B is open — the shared read model never holds another tree's annotations", async () => {
  const TREE_A = "tree-a";
  const TREE_B = "tree-b";
  /* 两树共享 branch/turn id 与正文（使污染在 DOM 上可观测：A 的批注若写入
   * 共享读模型，会在 B 的同 id turn 上通过全部校验并渲染出来）。 */
  const sharedText = "Shared prose keeps a marked term inside.";
  const sharedState = (treeId: string): TreeState => {
    const trunk: Branch = { id: "trunk-1", treeId, parentBranchId: null, createdAt: ISO };
    return {
      tree: { id: treeId, createdAt: ISO, forestId: "forest-1" },
      trunkBranchId: "trunk-1",
      branches: [
        makeBranchView(trunk, null, "available", [
          makeTurn("u1", "trunk-1", "user", "Question."),
          makeTurn("a1", "trunk-1", "assistant", sharedText),
        ]),
      ],
      cursor: { treeId, branchId: "trunk-1", entryId: "pi-a1" },
    };
  };
  const annotationA = termAnnotation({
    id: "term-ann-tree-a",
    treeId: TREE_A,
    anchorTurnId: "a1",
    selection: { start: 0, end: 6, text: "Shared" },
    sourceHash: sha256Of(sharedText),
    term: "Shared",
    explanation: "Annotation saved on tree A.",
  });
  const world = await createWorld({
    treeBundles: [
      { tree: { id: TREE_A, createdAt: ISO, forestId: "forest-1" }, state: sharedState(TREE_A), annotations: [annotationA] },
      { tree: { id: TREE_B, createdAt: ISO, forestId: "forest-1" }, state: sharedState(TREE_B), annotations: [] },
    ],
    /* A 的读模型 GET 挂起（A 请求在途的确定性编排）。 */
    holdSuffix: `/api/trees/${TREE_A}/terminology`,
  });

  /* 开树 A 完成，但其读模型响应在途（诚实无覆盖，不伪造）。 */
  assert.equal(
    world.turnElement("conversation", "a1").querySelectorAll(".term-annotation-mark").length,
    0,
    "while tree A's read model is in flight, no overlay renders yet",
  );

  /* A 的读模型在途时切到树 B（B 自身读模型为空）。 */
  const treeButton = (treeId: string): StubElement => {
    const found = world.el("tree-list").querySelectorAll("button").find((b) => b.textContent.startsWith(treeId));
    assert.ok(found !== undefined, `the sidebar lists ${treeId}`);
    return found;
  };
  treeButton(TREE_B).click();
  await settle();
  assert.equal(
    world.turnElement("conversation", "a1").querySelectorAll(".term-annotation-mark").length,
    0,
    "tree B opens with its own empty read model (no annotations)",
  );

  /* A 的迟到响应到达（currentTreeId=B）：写点守卫丢弃——共享读模型从未
     持有 A 的批注（探针口径：currentTreeId=B、annotations=[A] 绝不出现）。
     观测面：迟到写入后的下一次重渲（B 的 SSE 终态刷新）绝不把 A 的批注画
     到 B 的同 id turn 上（若写入发生，此刻就会浮现）。 */
  world.releaseHold();
  await settle();
  world.liveSse().emit("run-terminal", { runId: "run-b" });
  await settle();
  assert.equal(
    world.turnElement("conversation", "a1").querySelectorAll(".term-annotation-mark").length,
    0,
    "tree A's late response is discarded before the state write — no cross-tree overlay on tree B, even after a fresh re-render",
  );

  /* 抽屉（B 打开时）如实为空。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");
  assert.ok(
    drawer.textContent.includes("no saved term annotations yet"),
    "the drawer on tree B never lists tree A's annotation",
  );
  assert.ok(
    !drawer.textContent.includes("Annotation saved on tree A."),
    "tree A's explanation never reaches tree B's terminology surface",
  );
  world.el("drawer-close").click();
  await settle();

  /* 切回 A：重新拉取（闸门已开）后批注覆盖正常落位——对照证明拦截不是
     桩数据损坏。 */
  treeButton(TREE_A).click();
  await settle();
  const marksOnA = world.turnElement("conversation", "a1").querySelectorAll(".term-annotation-mark");
  assert.equal(marksOnA.length, 1, "switching back to tree A renders its own annotation (positive control)");
  assert.equal(marksOnA[0]!.textContent, "Shared", "the overlay is tree A's excerpt");
});

test("P1 save-path guard: an annotation saved while its card was closed lands in the read model without resurrecting the card", async () => {
  const world = await createWorld({ holdSuffix: "/terminology/annotations" });
  const card = await explainA2Term(world);
  card.querySelector(".term-save")!.click();
  assert.ok(world.byId("term-explain-card") !== null, "the card is open while the save request is in flight");
  /* 保存响应在途时用户关卡（Esc 不经 guard——在途可关）。 */
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.ok(world.byId("term-explain-card") === null, "the user closes the card before the save response arrives");
  world.releaseHold();
  await settle();
  assert.ok(
    world.byId("term-explain-card") === null,
    "the late save response never resurrects the closed card (token-guarded card write)",
  );
  assert.ok(
    world.turnElement("conversation", "a2").querySelector(".term-annotation-mark") !== null,
    "the saved annotation still lands: the read-model refresh renders its overlay on the answer",
  );
  /* 抽屉如实列出已保存批注（无降级注记——三重校验全过）。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const validLi = drawerAnnotationLi(world.el("source-drawer"), A2_TERM);
  assert.ok(!validLi.textContent.includes("source changed"), "the freshly saved annotation is intact");
});
