/**
 * D4-8 大规模树导航前端套件（issue #8 工作包 D4-8「大规模树导航」；charter
 * §5 大规模树导航 / §6 B9 的 DOM 面锁定）。
 *
 * 方法与 ui-material-reader / ui-search 套件一致（issue #4 P1「证据工程化」
 * 的脚本化 DOM E2E）：以 file: URL 加载仓库真实 public/app.js 为 ES module
 * （URL query 随机化绕过 ES 模块缓存——每个场景一份全新实例），运行在
 * 「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本化后端」之上。
 * 后端按场景脚本化实现 /api/nav/* 的全部端点（形状对齐
 * apps/studio/src/nav/nav-engine.ts 的公共视图类型与 nav-api.test.ts 的
 * HTTP 契约：children/path/locate/search/expand-state + 分页游标 +
 * stale-cursor 409 + 503 nav-not-wired），树态/材料面服务工作台路径。
 * 无网络、无磁盘写入、无长等待，确定性可复现。本文件自包含（不依赖其他
 * UI 套件）。
 *
 * 大树语料（脚本确定性生成，对齐 b9 语义的结构面）：nav-big 236 节点
 * （220 宽子枝 + 12 层中链 + 3 个同名「方案A」节点分布在不同父枝），
 * nav-deep 61 节点（60 层深链），nav-empty 仅主干（标题 null），nav-other
 * 工作台树（turn 来源枝 + material 来源枝），凑数树 41 棵（fill-01..fill-36
 * + fill-40..fill-44）凑 45 棵（森林列表 20/页 → 3 页；fill-40..44 提供
 * id 子串 "fill-4" 的 5 命中面）。
 *
 * 覆盖（D4-8 前端增量的逐项锁定）：
 *  1. 森林/树查找：分页森林列表（More 翻页按游标）+ 标题/标识搜索 +
 *     零命中如实空态 + 空查询回列表 + 列表失败 + 重试；
 *  2. 层级按需加载 + 虚拟化：展开只取首页（50/220）；DOM 只渲染滚动窗口
 *     （窗口外 spacer 占位；未载节点绝不出现）；滚动重划窗口；More 行
 *     窗口内自动续页 + 失败 + Retry；状态行如实披露窗口口径；
 *  3. 展开状态持久化：PUT 整组载荷（expandedBranchIds 全集 +
 *     selectedBranchId）；Close 后重开按 GET 恢复（展开集合 + 深层选中
 *     经祖先链续页揭示到可见）；无用户动作不回写；
 *  4. 键盘：↑/↓ 逐行移动（跨窗口滚动跟随——焦点行必在 DOM，焦点不因虚
 *     拟化消失）；→ 展开/入首子；← 收起/回父（收起子树 DOM-free）；
 *     Enter 选中；Home 首行；
 *  5. 同名消歧 + 深链：行携带 id 徽标 + title 全文（长标题截断由 CSS 承
 *     担）；分支搜索命中各携带完整路径；揭示后完整父路径行在场（长链
 *     可收拢、show full path 展开后完整）；
 *  6. 诚实状态面：stale-cursor 409 从首页重拉（请求序列锁定）；子节点
 *     加载失败行 + Retry；503 nav-not-wired 如实说明 + 重试不伪装；
 *     展开状态读失败如实注记（浏览继续）；空树指引；
 *  7. 定位与来源：locate 跨树定位工作台当前分支（异树切换 + 祖先链揭示 +
 *     选中）；跳回来源——turn 走既有 /source 揭示、material 走既有阅读器
 *     按版本+块定位、无来源如实说明（绝不伪造近似位置）；
 *  8. CSS 词法锁定：有界滚动容器 / 固定行高（虚拟化常数）/ 键盘焦点行
 *     可见态 / 长标题截断 / 窄窗触点规则（窄窗不改行高）。
 *
 * 边界（如实声明）：不是真实浏览器 E2E；CSS 不执行（媒体查询按词法锁
 * 定）；虚拟化的滚动几何按脚本化 scrollTop/clientHeight 驱动（真实视口
 * 几何与 p95 归 evidence/d4 浏览器口径）。
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

/* ------------------------------ 基础常量 ------------------------------ */

const ISO = "2026-10-01T00:00:00.000Z";
const FOREST_ID = "forest-1";
const FILLER_TREES = 41; /* 森林列表 20/页 → 3 页（20/20/5）+ 4 棵语料树 = 45 */

/* ------------------------------ 桩事件 / fetch 形状 ------------------------------ */

interface StubEventInit {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  target?: unknown;
}

interface StubEvent {
  type: string;
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  target?: unknown;
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

const settle = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

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
  tabIndex = -1;
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

  scrollIntoView(options?: unknown): void {
    void options;
  }

  /* 与 ui-regressions 的桩一致：app.js 的 renderTurnsInto 用选项对象形式
     （{top, behavior}）滚动对话容器——跳回来源跨树走 openTree → renderAll
     时必经。 */
  scrollTo(options: { top: number; behavior?: string }): void {
    this.scrollTop = options.top;
  }

  querySelector(sel: string): StubElement | null {
    return queryAll(this, sel)[0] ?? null;
  }

  querySelectorAll(sel: string): StubElement[] {
    return queryAll(this, sel);
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
  confirm(message: string): boolean;
}

/* ------------------------------ 导航语料（确定性脚本数据集） ------------------------------ */

interface TurnOriginScript {
  kind: "turn";
  sourceBranchId: string;
  anchorTurnId: string;
  anchorEntryId: string;
  selection: { start: number; end: number; text: string };
}

interface MaterialOriginScript {
  kind: "material";
  materialId: string;
  versionId: string;
  blockId: string;
  start: number;
  end: number;
  excerpt: string;
  sourceHash: string;
}

type OriginScript = TurnOriginScript | MaterialOriginScript;

interface NavNodeScript {
  id: string;
  parent: string | null;
  title: string | null;
  originKind: "none" | "turn" | "material";
  origin: OriginScript | null;
}

interface NavTreeScript {
  treeId: string;
  title: string | null;
  trunkBranchId: string;
  nodes: NavNodeScript[];
}

const WIDE_CHILDREN = 220;
const MID_CHAIN = 12;
const DEEP_CHAIN = 60;
const SAME_NAME_TITLE = "方案A";
const LONG_TITLE = `这是一段刻意超长的标题用于锁定长标题截断纪律——虚拟化行内只保留可视截断而 title 属性携带全文，`.repeat(4);

function node(id: string, parent: string | null, title: string | null, origin: OriginScript | null = null): NavNodeScript {
  return {
    id,
    parent,
    title,
    originKind: origin === null ? "none" : origin.kind,
    origin,
  };
}

function buildDataset(): NavTreeScript[] {
  /* nav-other：工作台树（boot 即打开；cursor 在 other-b1——locate 的目标）。
     other-b1 = turn 来源（揭示走 /source）；other-b2 = material 来源（揭示
     走阅读器）。 */
  const other: NavTreeScript = {
    treeId: "nav-other",
    title: "Workbench tree",
    trunkBranchId: "other-trunk",
    nodes: [
      node("other-trunk", null, "Workbench tree"),
      node("other-b1", "other-trunk", "Branched from the trunk answer", {
        kind: "turn",
        sourceBranchId: "other-trunk",
        anchorTurnId: "other-a1",
        anchorEntryId: "other-e1",
        selection: { start: 0, end: 9, text: "The trunk" },
      }),
      node("other-b2", "other-trunk", "Branched from a material selection", {
        kind: "material",
        materialId: "mat-src",
        versionId: "v-src-1",
        blockId: "blk-2",
        start: 40,
        end: 58,
        excerpt: "material origin excerpt",
        sourceHash: "hash-mat-src",
      }),
    ],
  };

  /* nav-big：236 节点——220 宽子枝（w-000 带 turn 来源：跨树来源跳转用）+
     12 层中链（m-001..m-012，挂在 w-000 下）+ 3 个同名「方案A」（不同父枝
     ——同名消歧语料）。w-003 超长标题（截断纪律）。 */
  const bigNodes: NavNodeScript[] = [node("big-trunk", null, "Big navigation tree")];
  for (let i = 0; i < WIDE_CHILDREN; i += 1) {
    const id = `w-${String(i).padStart(3, "0")}`;
    const title = i === 3 ? LONG_TITLE : `Wide branch ${String(i).padStart(3, "0")}`;
    bigNodes.push(
      node(
        id,
        "big-trunk",
        title,
        i === 0
          ? {
              kind: "turn",
              sourceBranchId: "big-trunk",
              anchorTurnId: "big-a1",
              anchorEntryId: "big-e1",
              selection: { start: 0, end: 9, text: "Big answ" },
            }
          : null,
      ),
    );
  }
  for (let i = 1; i <= MID_CHAIN; i += 1) {
    bigNodes.push(node(`m-${String(i).padStart(3, "0")}`, i === 1 ? "w-000" : `m-${String(i - 1).padStart(3, "0")}`, `Mid step ${String(i)}`));
  }
  bigNodes.push(node("s-001", "w-001", SAME_NAME_TITLE));
  bigNodes.push(node("s-002", "w-002", SAME_NAME_TITLE));
  bigNodes.push(node("s-003", "m-003", SAME_NAME_TITLE));
  const big: NavTreeScript = { treeId: "nav-big", title: "Big navigation tree", trunkBranchId: "big-trunk", nodes: bigNodes };

  /* nav-deep：60 层深链（完整祖先路径语料）。 */
  const deepNodes: NavNodeScript[] = [node("deep-trunk", null, "Deep chain tree")];
  for (let i = 1; i <= DEEP_CHAIN; i += 1) {
    deepNodes.push(
      node(`d-${String(i).padStart(3, "0")}`, i === 1 ? "deep-trunk" : `d-${String(i - 1).padStart(3, "0")}`, `Chain step ${String(i)}`),
    );
  }
  const deep: NavTreeScript = { treeId: "nav-deep", title: "Deep chain tree", trunkBranchId: "deep-trunk", nodes: deepNodes };

  /* nav-empty：仅主干、无标题（诚实空态语料）。 */
  const empty: NavTreeScript = { treeId: "nav-empty", title: null, trunkBranchId: "empty-trunk", nodes: [node("empty-trunk", null, null)] };

  /* 凑数树（森林列表分页语料）。最后 5 棵编号 40..44：id 含子串 "fill-4"，
     供「按 id 搜 fill-4 → fill-40..fill-44」的标识命中面语料（标题不含该子串）。 */
  const fillers: NavTreeScript[] = [];
  for (let i = 1; i <= FILLER_TREES; i += 1) {
    const n = i <= FILLER_TREES - 5 ? String(i).padStart(2, "0") : String(i + 3);
    fillers.push({ treeId: `fill-${n}`, title: `Filler tree ${n}`, trunkBranchId: `fill-trunk-${n}`, nodes: [node(`fill-trunk-${n}`, null, `Filler tree ${n}`)] });
  }
  return [other, big, deep, empty, ...fillers];
}

const DATASET = buildDataset();
const BIG = DATASET.find((tree) => tree.treeId === "nav-big")!;
const DEEP = DATASET.find((tree) => tree.treeId === "nav-deep")!;
const OTHER = DATASET.find((tree) => tree.treeId === "nav-other")!;
const EMPTY = DATASET.find((tree) => tree.treeId === "nav-empty")!;

/* ------------------------------ 工作台树态（/api/trees/:id/state） ------------------------------ */

interface TreeState {
  tree: { id: string; createdAt: string; forestId: string };
  trunkBranchId: string;
  branches: Array<{
    branch: { id: string; treeId: string; parentBranchId: string | null; createdAt: string };
    origin: {
      branchId: string;
      sourceBranchId: string;
      anchorTurnId: string;
      anchorEntryId: string;
      selection: { start: number; end: number; text: string };
      createdAt: string;
    } | null;
    originStatus: "available" | "changed" | "unavailable" | null;
    sessionAvailability: "available" | "unavailable" | null;
    turns: Array<Record<string, unknown>>;
    returnAttempts: Array<Record<string, unknown>>;
  }>;
  cursor: { treeId: string; branchId: string; entryId: string } | null;
}

function turn(id: string, treeId: string, branchId: string, role: "user" | "assistant", text: string): Record<string, unknown> {
  return {
    id,
    treeId,
    branchId,
    episodeId: `ep-${branchId}`,
    runId: `run-${id}`,
    role,
    text,
    piEntryId: `pi-${id}`,
    fromBranchId: null,
    deliveredRunId: null,
    idempotencyKey: null,
    targetAnchor: null,
    createdAt: ISO,
  };
}

function workbenchState(tree: NavTreeScript, cursorBranchId: string | null): TreeState {
  const treeId = tree.treeId;
  const trunkTurns =
    treeId === "nav-other"
      ? [turn("other-u1", treeId, tree.trunkBranchId, "user", "First trunk question."), turn("other-a1", treeId, tree.trunkBranchId, "assistant", "The trunk answer with several plain words for anchoring.")]
      : treeId === "nav-big"
        ? [turn("big-u1", treeId, tree.trunkBranchId, "user", "Big first question."), turn("big-a1", treeId, tree.trunkBranchId, "assistant", "Big answer with several plain words for anchoring.")]
        : [];
  return {
    tree: { id: treeId, createdAt: ISO, forestId: FOREST_ID },
    trunkBranchId: tree.trunkBranchId,
    branches: tree.nodes.map((n) => ({
      branch: { id: n.id, treeId, parentBranchId: n.parent, createdAt: ISO },
      origin:
        n.origin !== null && n.origin.kind === "turn"
          ? {
              branchId: n.id,
              sourceBranchId: n.origin.sourceBranchId,
              anchorTurnId: n.origin.anchorTurnId,
              anchorEntryId: n.origin.anchorEntryId,
              selection: n.origin.selection,
              createdAt: ISO,
            }
          : null,
      originStatus: null,
      sessionAvailability: "available",
      turns: n.parent === null ? trunkTurns : [],
      returnAttempts: [],
    })),
    cursor: cursorBranchId === null ? null : { treeId, branchId: cursorBranchId, entryId: "pi-cursor" },
  };
}

/* ------------------------------ 后端（导航 + 工作台 + 材料） ------------------------------ */

interface ExpandStateValue {
  expandedBranchIds: string[];
  selectedBranchId: string | null;
}

interface Backend {
  trees: Array<{ id: string; createdAt: string; forestId: string }>;
  requests: RecordedRequest[];
  navExpandStates: Map<string, ExpandStateValue>;
  navUnwired: boolean;
  listingFailOnce: boolean;
  /** 第 nth 次（1 基）对该父级的 children 请求失败一次。 */
  childrenFail: { treeId: string; parentId: string; nth: number } | null;
  /** 该父级第一个带游标的 children 请求 409 stale-cursor 一次。 */
  staleCursorOnce: { treeId: string; parentId: string } | null;
  expandGetFailOnce: boolean;
}

interface WorldOptions {
  navUnwired?: boolean;
  listingFailOnce?: boolean;
  childrenFail?: { treeId: string; parentId: string; nth: number };
  staleCursorOnce?: { treeId: string; parentId: string };
  expandGetFailOnce?: boolean;
}

let appLoadCounter = 0;

function depthOf(tree: NavTreeScript, nodeScript: NavNodeScript): number {
  let depth = 0;
  let cur: NavNodeScript | undefined = nodeScript;
  while (cur !== undefined && cur.parent !== null) {
    depth += 1;
    cur = tree.nodes.find((candidate) => candidate.id === cur!.parent);
  }
  return depth;
}

function pathStepsOf(tree: NavTreeScript, nodeScript: NavNodeScript): Array<{ id: string; title: string | null; depth: number }> {
  const steps: Array<{ id: string; title: string | null; depth: number }> = [];
  let cur: NavNodeScript | undefined = nodeScript;
  while (cur !== undefined) {
    steps.unshift({ id: cur.id, title: cur.title, depth: depthOf(tree, cur) });
    cur = cur.parent === null ? undefined : tree.nodes.find((candidate) => candidate.id === cur!.parent);
  }
  return steps;
}

function nodeView(tree: NavTreeScript, nodeScript: NavNodeScript): Record<string, unknown> {
  return {
    id: nodeScript.id,
    treeId: tree.treeId,
    parentBranchId: nodeScript.parent,
    depth: depthOf(tree, nodeScript),
    title: nodeScript.title,
    originKind: nodeScript.originKind,
    childCount: tree.nodes.filter((candidate) => candidate.parent === nodeScript.id).length,
    createdAt: ISO,
  };
}

async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  const localStorageStore = new Map<string, string>();
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
    confirm: () => true,
  };

  const backend: Backend = {
    trees: DATASET.map((tree) => ({ id: tree.treeId, createdAt: ISO, forestId: FOREST_ID })),
    requests: [],
    navExpandStates: new Map(),
    navUnwired: options.navUnwired === true,
    listingFailOnce: options.listingFailOnce === true,
    childrenFail: options.childrenFail ?? null,
    staleCursorOnce: options.staleCursorOnce ?? null,
    expandGetFailOnce: options.expandGetFailOnce === true,
  };

  /** 每父级 children 请求计数（childrenFail 的 nth 判定）。 */
  const childrenFetchCounts = new Map<string, number>();
  const childrenKey = (treeId: string, parentId: string): string => `${treeId}:${parentId}`;

  const findTree = (treeId: string): NavTreeScript | undefined => DATASET.find((tree) => tree.treeId === treeId);
  const findNode = (branchId: string): { tree: NavTreeScript; node: NavNodeScript } | null => {
    for (const tree of DATASET) {
      const found = tree.nodes.find((candidate) => candidate.id === branchId);
      if (found !== undefined) return { tree, node: found };
    }
    return null;
  };

  class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const parseCursor = (raw: string | null): number => {
    if (raw === null) return 0;
    const match = /^off-(\d+)$/.exec(raw);
    if (match === null) throw new HttpError(400, "invalid-cursor", `cursor '${raw}' is not a valid page cursor`);
    return Number(match[1]!);
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
    const fail = (status: number, code: string, message: string): StubResponse =>
      respond(status, { error: { code, message } });

    /* ---- D4-8 导航面（/api/nav/*——nav-api 契约的脚本化镜像） ---- */
    if (p === "/api/nav" || p.startsWith("/api/nav/")) {
      if (backend.navUnwired) {
        return fail(503, "nav-not-wired", "the tree navigation service is not wired in this process");
      }
      if (p === "/api/nav/trees" && method === "GET") {
        if (backend.listingFailOnce) {
          backend.listingFailOnce = false;
          return fail(500, "internal", "scripted forest listing failure");
        }
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const offset = parseCursor(url.searchParams.get("cursor"));
        const trees = DATASET.slice(offset, offset + limit).map((tree) => ({
          treeId: tree.treeId,
          forestId: FOREST_ID,
          createdAt: ISO,
          title: tree.title,
          trunkBranchId: tree.trunkBranchId,
        }));
        const nextCursor = offset + trees.length < DATASET.length ? `off-${offset + trees.length}` : null;
        return respond(200, { trees, nextCursor, totalTrees: DATASET.length });
      }
      let m = /^\/api\/nav\/trees\/([^/]+)\/branches\/([^/]+)\/children$/.exec(p);
      if (m !== null && method === "GET") {
        const tree = findTree(decodeURIComponent(m[1]!));
        if (tree === undefined) return fail(404, "unknown-tree", `unknown tree '${m[1]!}'`);
        /* 提升到 const 再进 find 回调：let m 的非空收窄不跨闭包（TS18047）。 */
        const wantedBranchId = decodeURIComponent(m[2]!);
        const parent = tree.nodes.find((candidate) => candidate.id === wantedBranchId);
        if (parent === undefined) return fail(404, "unknown-branch", `unknown branch '${m[2]!}'`);
        const key = childrenKey(tree.treeId, parent.id);
        const nth = (childrenFetchCounts.get(key) ?? 0) + 1;
        childrenFetchCounts.set(key, nth);
        if (backend.childrenFail !== null && backend.childrenFail.treeId === tree.treeId && backend.childrenFail.parentId === parent.id && backend.childrenFail.nth === nth) {
          return fail(500, "internal", "scripted children failure");
        }
        const cursorRaw = url.searchParams.get("cursor");
        if (
          cursorRaw !== null &&
          backend.staleCursorOnce !== null &&
          backend.staleCursorOnce.treeId === tree.treeId &&
          backend.staleCursorOnce.parentId === parent.id
        ) {
          backend.staleCursorOnce = null;
          return fail(409, "stale-cursor", "the tree index changed after this cursor was issued — restart from the first page");
        }
        const limitRaw = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) {
          return fail(400, "invalid-argument", `limit must be an integer between 1 and 500`);
        }
        const offset = parseCursor(cursorRaw);
        const kids = tree.nodes.filter((candidate) => candidate.parent === parent.id);
        const slice = kids.slice(offset, offset + limitRaw);
        const nextCursor = offset + slice.length < kids.length ? `off-${offset + slice.length}` : null;
        return respond(200, {
          treeId: tree.treeId,
          parentBranchId: parent.id,
          nodes: slice.map((kid) => nodeView(tree, kid)),
          nextCursor,
          totalChildren: kids.length,
        });
      }
      m = /^\/api\/nav\/trees\/([^/]+)\/branches\/([^/]+)\/path$/.exec(p);
      if (m !== null && method === "GET") {
        const located = findNode(decodeURIComponent(m[2]!));
        if (located === null || located.tree.treeId !== decodeURIComponent(m[1]!)) {
          return fail(404, "unknown-branch", `unknown branch '${m[2]!}'`);
        }
        return respond(200, {
          treeId: located.tree.treeId,
          branchId: located.node.id,
          path: pathStepsOf(located.tree, located.node),
        });
      }
      m = /^\/api\/nav\/branches\/([^/]+)\/locate$/.exec(p);
      if (m !== null && method === "GET") {
        const located = findNode(decodeURIComponent(m[1]!));
        if (located === null) return fail(404, "unknown-branch", `unknown branch '${m[1]!}'`);
        const { tree, node: n } = located;
        const steps = pathStepsOf(tree, n);
        const siblings = n.parent === null ? [] : tree.nodes.filter((candidate) => candidate.parent === n.parent);
        const index = siblings.findIndex((candidate) => candidate.id === n.id);
        return respond(200, {
          treeId: tree.treeId,
          treeTitle: tree.title,
          node: nodeView(tree, n),
          ancestors: steps.slice(0, -1),
          path: steps,
          siblingPosition: n.parent === null ? null : { index, total: siblings.length },
          origin: n.origin,
        });
      }
      m = /^\/api\/nav\/trees\/([^/]+)\/expand-state$/.exec(p);
      if (m !== null) {
        const tree = findTree(decodeURIComponent(m[1]!));
        if (tree === undefined) return fail(404, "unknown-tree", `unknown tree '${m[1]!}'`);
        if (method === "GET") {
          if (backend.expandGetFailOnce) {
            backend.expandGetFailOnce = false;
            return fail(500, "internal", "scripted expand-state read failure");
          }
          return respond(200, { expandState: backend.navExpandStates.get(tree.treeId) ?? null });
        }
        if (method === "PUT") {
          const record = asRecord(body);
          if (record === null || !Array.isArray(record.expandedBranchIds)) {
            return fail(400, "invalid-argument", "expandedBranchIds must be an array (explicit full-set semantics)");
          }
          for (const id of record.expandedBranchIds as unknown[]) {
            const located = findNode(String(id));
            if (located === null) return fail(404, "unknown-branch", `unknown branch '${String(id)}'`);
            if (located.tree.treeId !== tree.treeId) {
              return fail(400, "invalid-argument", `branch '${String(id)}' does not belong to tree '${tree.treeId}'`);
            }
          }
          if (record.selectedBranchId !== undefined && record.selectedBranchId !== null) {
            const located = findNode(String(record.selectedBranchId));
            if (located === null || located.tree.treeId !== tree.treeId) {
              return fail(400, "invalid-argument", `selectedBranchId '${String(record.selectedBranchId)}' does not belong to tree '${tree.treeId}'`);
            }
          }
          backend.navExpandStates.set(tree.treeId, {
            expandedBranchIds: [...(record.expandedBranchIds as string[])],
            selectedBranchId: record.selectedBranchId === undefined || record.selectedBranchId === null ? null : String(record.selectedBranchId),
          });
          return respond(204, null);
        }
        return fail(405, "method-not-allowed", `${method} ${p}`);
      }
      m = /^\/api\/nav\/trees\/([^/]+)$/.exec(p);
      if (m !== null && method === "GET") {
        const tree = findTree(decodeURIComponent(m[1]!));
        if (tree === undefined) return fail(404, "unknown-tree", `unknown tree '${m[1]!}'`);
        return respond(200, {
          treeId: tree.treeId,
          forestId: FOREST_ID,
          createdAt: ISO,
          title: tree.title,
          trunkBranchId: tree.trunkBranchId,
          nodeCount: tree.nodes.length,
          maxDepth: tree.nodes.reduce((max, n) => Math.max(max, depthOf(tree, n)), 0),
        });
      }
      const fold = (text: string): string => text.toLowerCase();
      const matches = (haystack: string | null, needle: string): boolean =>
        haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());
      if (p === "/api/nav/search/trees" && method === "GET") {
        const text = url.searchParams.get("text") ?? "";
        if (text.trim().length === 0) return fail(400, "invalid-argument", "query parameter 'text' must be a non-empty (not blank) string");
        const mode = url.searchParams.get("mode") ?? "substring";
        if (mode !== "exact" && mode !== "prefix" && mode !== "substring") {
          return fail(400, "invalid-argument", `query parameter 'mode' must be 'exact' | 'prefix' | 'substring'`);
        }
        const hits: Array<Record<string, unknown>> = [];
        for (const tree of DATASET) {
          const titleMatch = mode === "substring" ? matches(tree.title, text) : mode === "prefix" ? tree.title !== null && fold(tree.title).startsWith(fold(text)) : tree.title === text;
          const idMatch = !titleMatch && (mode === "substring" ? tree.treeId.toLowerCase().includes(text.toLowerCase()) : false);
          if (!titleMatch && !idMatch) continue;
          hits.push({
            treeId: tree.treeId,
            forestId: FOREST_ID,
            title: tree.title,
            matchedOn: titleMatch ? "title" : "id",
            createdAt: ISO,
          });
        }
        const offset = parseCursor(url.searchParams.get("cursor"));
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const page = hits.slice(offset, offset + limit);
        const nextCursor = offset + page.length < hits.length ? `off-${offset + page.length}` : null;
        return respond(200, { hits: page, nextCursor });
      }
      if (p === "/api/nav/search/branches" && method === "GET") {
        const text = url.searchParams.get("text") ?? "";
        if (text.trim().length === 0) return fail(400, "invalid-argument", "query parameter 'text' must be a non-empty (not blank) string");
        const scopeRaw = url.searchParams.get("treeId");
        const scopeTrees: NavTreeScript[] = scopeRaw === null ? DATASET : [findTree(decodeURIComponent(scopeRaw))!];
        if (scopeTrees[0] === undefined) return fail(404, "unknown-tree", `unknown tree '${scopeRaw}'`);
        const hits: Array<Record<string, unknown>> = [];
        for (const tree of scopeTrees) {
          for (const n of tree.nodes) {
            const titleMatch = matches(n.title, text);
            const idMatch = !titleMatch && n.id.toLowerCase().includes(text.toLowerCase());
            if (!titleMatch && !idMatch) continue;
            hits.push({
              branchId: n.id,
              treeId: tree.treeId,
              treeTitle: tree.title,
              title: n.title,
              matchedOn: titleMatch ? "title" : "id",
              depth: depthOf(tree, n),
              path: pathStepsOf(tree, n),
              originKind: n.originKind,
              createdAt: ISO,
            });
          }
        }
        const offset = parseCursor(url.searchParams.get("cursor"));
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const page = hits.slice(offset, offset + limit);
        const nextCursor = offset + page.length < hits.length ? `off-${offset + page.length}` : null;
        return respond(200, { hits: page, nextCursor });
      }
      return fail(404, "not-found", `no nav route for ${method} ${p}`);
    }

    /* ---- 工作台树面（boot/开树/揭示所需的最小路由） ---- */
    if (p === "/api/trees" && method === "GET") {
      return respond(200, { trees: backend.trees });
    }
    let m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") {
      const tree = findTree(decodeURIComponent(m[1]!));
      if (tree === undefined) return fail(404, "not-found", `no route for ${method} ${p}`);
      return respond(200, workbenchState(tree, tree.treeId === "nav-other" ? "other-b1" : null));
    }
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(p);
    if (m !== null && method === "POST") {
      const located = findNode(decodeURIComponent(m[2]!));
      if (located === null || located.tree.treeId !== decodeURIComponent(m[1]!)) {
        return fail(404, "not-found", `no route for ${method} ${p}`);
      }
      if (located.node.origin === null || located.node.origin.kind !== "turn") {
        return fail(404, "not-found", `branch '${m[2]!}' has no turn origin`);
      }
      const origin = located.node.origin;
      return respond(200, {
        state: workbenchState(located.tree, null),
        source: {
          status: "available",
          sourceBranchId: origin.sourceBranchId,
          anchorTurnId: origin.anchorTurnId,
          anchorEntryId: origin.anchorEntryId,
          selection: origin.selection,
          navigation: { status: "navigated" },
        },
      });
    }
    m = /^\/api\/trees\/([^/]+)\/diagnostics$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        treeId: m[1]!,
        runtimeState: "idle",
        activeRun: null,
        runs: [],
        policyDecisions: { observed: false, reason: "offline echo driver has no tool executor" },
      });
    }
    m = /^\/api\/trees\/([^/]+)\/journal$/.exec(p);
    if (m !== null && method === "GET") return respond(200, { events: [] });
    m = /^\/api\/trees\/([^/]+)\/switch$/.exec(p);
    if (m !== null && method === "POST") {
      return respond(200, { cursor: null, state: workbenchState(findTree(decodeURIComponent(m[1]!))!, null) });
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
      return respond(200, { outcome: { kind: "completed" }, state: workbenchState(findTree(decodeURIComponent(m[1]!))!, null) });
    }

    /* ---- 材料面（material 来源揭示：mat-src / v-src-1 / blk-0..blk-4） ---- */
    m = /^\/api\/trees\/([^/]+)\/materials$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        materials: [
          {
            material: { id: "mat-src", title: "Source material.md", createdAt: ISO },
            versions: [
              {
                id: "v-src-1",
                materialId: "mat-src",
                contentHash: "hash-mat-src",
                parserKind: "markdown",
                parserVersion: "d4-md-v1",
                importedAt: ISO,
                sizeBytes: 512,
                parseStatus: "ready",
                parseError: null,
                textUnits: 500,
              },
            ],
          },
        ],
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        material: { id: "mat-src", title: "Source material.md", createdAt: ISO },
        versions: [
          {
            id: "v-src-1",
            materialId: "mat-src",
            contentHash: "hash-mat-src",
            parserKind: "markdown",
            parserVersion: "d4-md-v1",
            importedAt: ISO,
            sizeBytes: 512,
            parseStatus: "ready",
            parseError: null,
            textUnits: 500,
          },
        ],
        readingPosition: null,
        parseTasks: [],
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const texts = ["# Source material\n\n", "First block with plain words.\n\n", "Second block holds the origin excerpt.\n\n", "Third block.\n\n", "Fourth block.\n\n"];
      let offset = 0;
      const blocks = texts.map((text, index) => {
        const block = {
          block: { blockId: `blk-${String(index)}`, kind: "markdown-block", start: offset, end: offset + text.length },
          text,
        };
        offset += text.length;
        return block;
      });
      return respond(200, { blocks, nextAfterBlock: null, textUnits: offset });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/reading-position$/.exec(p);
    if (m !== null && method === "PUT") return respond(204, null);

    return fail(404, "not-found", `no route for ${method} ${p}`);
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
    value: { clipboard: { writeText: async () => {} } },
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
    navTree: () => documentStub.getElementById("nav-tree")!,
    navRows: () => {
      const tree = documentStub.getElementById("nav-tree");
      assert.ok(tree !== null, "#nav-tree missing");
      return tree.querySelectorAll(".nav-item");
    },
    navRow: (branchId) => {
      const tree = documentStub.getElementById("nav-tree");
      if (tree === null) return null;
      return tree.querySelectorAll(".nav-item").find((row) => row.dataset.branchId === branchId) ?? null;
    },
    navRowRequired: (branchId) => {
      const row = world.navRow(branchId);
      assert.ok(row !== null, `nav row for ${branchId} missing from the rendered window`);
      return row;
    },
    navLabel: (branchId) => {
      const row = world.navRowRequired(branchId);
      const label = row.querySelector(".nav-label");
      assert.ok(label !== null, `nav label for ${branchId} missing`);
      return label;
    },
    navToggle: (branchId) => {
      const row = world.navRowRequired(branchId);
      const toggle = row.querySelector(".nav-toggle");
      assert.ok(toggle !== null, `nav toggle for ${branchId} missing`);
      return toggle;
    },
    navKey: (key) => {
      world.el("nav-tree-scroll").dispatchEvent("keydown", { key });
    },
    findTrees: async (text) => {
      world.el("nav-tree-search").value = text;
      world.el("nav-tree-find").click();
      await settle(25);
    },
    openNavTreeViaFinder: async (treeId) => {
      await world.findTrees(treeId);
      const results = world.el("nav-tree-results");
      const button = results.querySelectorAll("button").find((candidate) => candidate.dataset.treeId === treeId);
      assert.ok(button !== undefined, `finder result for ${treeId} missing`);
      button.click();
      await settle(40);
    },
    expandToggle: async (branchId) => {
      world.navToggle(branchId).click();
      await settle(25);
    },
    selectRow: async (branchId) => {
      world.navLabel(branchId).click();
      await settle(25);
    },
    childrenRequests: (treeId, parentId) =>
      backend.requests.filter(
        (r) => r.path.split("?")[0] === `/api/nav/trees/${treeId}/branches/${parentId}/children`,
      ),
    expandPuts: () => backend.requests.filter((r) => r.method === "PUT" && r.path.split("?")[0]!.endsWith("/expand-state")),
  };
  return world;
}

/** 世界面（场景辅助的契约；对齐 ui-material-reader 的 World 形状）。 */
interface World {
  readonly document: StubDocument;
  readonly backend: Backend;
  el(id: string): StubElement;
  byId(id: string): StubElement | null;
  requestsOf(suffix: string): RecordedRequest[];
  lastRequest(suffix: string): RecordedRequest | null;
  navTree(): StubElement;
  navRows(): StubElement[];
  navRow(branchId: string): StubElement | null;
  navRowRequired(branchId: string): StubElement;
  navLabel(branchId: string): StubElement;
  navToggle(branchId: string): StubElement;
  navKey(key: string): void;
  findTrees(text: string): Promise<void>;
  openNavTreeViaFinder(treeId: string): Promise<void>;
  expandToggle(branchId: string): Promise<void>;
  selectRow(branchId: string): Promise<void>;
  childrenRequests(treeId: string, parentId: string): RecordedRequest[];
  expandPuts(): RecordedRequest[];
}

/* ------------------------------------------------------------------ */
/* 1. 森林/树查找：分页列表 + 搜索 + 空态 + 失败重试                      */
/* ------------------------------------------------------------------ */

test("forest finder: the boot listing paginates via More (cursors), tree search matches title/id, zero-hit and blank-input are honest, and a listing failure retries", async () => {
  const world = await createWorld();

  /* 启动：森林列表首页（20/45）。 */
  const results = world.el("nav-tree-results");
  let buttons = results.querySelectorAll("button");
  assert.equal(buttons.length, 21, "20 tree rows + the More button");
  assert.match(world.el("nav-tree-find-note").textContent!, /20 of 45 tree\(s\) listed/);
  const firstListing = world.lastRequest("/api/nav/trees")!;
  assert.match(firstListing.path, /limit=20/);
  assert.ok(!firstListing.path.includes("cursor="), "the first page starts without a cursor");

  /* More：第二页带游标续页（20/20 → 40 shown）。 */
  const more = buttons.find((button) => button.classList.contains("nav-more"))!;
  assert.match(more.textContent!, /More trees \(20 of 45\)/);
  more.click();
  await settle(25);
  buttons = results.querySelectorAll("button");
  assert.equal(buttons.length, 41, "40 tree rows + the More button");
  const secondListing = world.lastRequest("/api/nav/trees")!;
  assert.match(secondListing.path, /cursor=off-20/, "the second page uses the listing cursor");
  buttons.find((button) => button.classList.contains("nav-more"))!.click();
  await settle(25);
  buttons = results.querySelectorAll("button");
  assert.equal(buttons.length, 45, "all 45 trees listed");
  assert.equal(buttons.find((button) => button.classList.contains("nav-more")), undefined, "no More button past the end");
  const ids = buttons.map((button) => button.dataset.treeId);
  assert.equal(new Set(ids).size, 45, "no duplicates across listing pages");

  /* 标题搜索：命中携带 matchedOn=id 的如实标注（按 id 搜 fill-4 → fill-40..44）。 */
  await world.findTrees("nav-big");
  let hits = results.querySelectorAll("button").filter((button) => button.dataset.treeId !== undefined);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.dataset.treeId, "nav-big");
  assert.match(world.el("nav-tree-find-note").textContent!, /1 tree hit\(s\) for “nav-big”/);
  assert.match(world.lastRequest("/api/nav/search/trees")!.path, /text=nav-big&mode=substring&limit=20/);

  await world.findTrees("fill-4");
  hits = results.querySelectorAll("button").filter((button) => button.dataset.treeId !== undefined);
  assert.equal(hits.length, 5, "id-substring search matches fill-40..fill-44");
  assert.ok(hits.every((button) => /matched on id/.test(button.textContent!)), "id matches are labeled as such");

  /* 零命中：如实空态（不编造、不给近似匹配）。 */
  await world.findTrees("zzz-no-such-tree");
  assert.match(
    results.textContent!,
    /no tree matches “zzz-no-such-tree” by title or id — nothing is fabricated/,
  );

  /* 空查询 + Find：回森林列表（刷新首页，不发空文本搜索）。 */
  await world.findTrees("");
  assert.equal(results.querySelectorAll("button").length, 21, "blank input returns to the listing first page");
  assert.equal(world.requestsOf("/api/nav/search/trees").length, 3, "the blank query never issues a search");

  /* 列表失败 + 重试（常驻，不折叠成空列表）。 */
  const failWorld = await createWorld({ listingFailOnce: true });
  const failResults = failWorld.el("nav-tree-results");
  assert.match(
    failResults.textContent!,
    /trees failed to load — internal: scripted forest listing failure/,
  );
  const retry = failResults.querySelector("button.drawer-retry");
  assert.ok(retry !== null, "the listing failure offers a retry");
  retry.click();
  await settle(25);
  assert.equal(failWorld.el("nav-tree-results").querySelectorAll("button").length, 21, "the retry loads the listing");
});

/* ------------------------------------------------------------------ */
/* 2. 层级按需加载 + 虚拟化窗口                                          */
/* ------------------------------------------------------------------ */

test("hierarchical on-demand loading: expanding loads only the first children page, the DOM renders only the scroll window (spacers carry the rest), scrolling re-windows, and the in-window More row auto-pages", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-big");

  /* 概览（236 节点 / 最大深度 13）与主干子节点首页（50/220）已取。 */
  assert.match(world.el("nav-tree-title").textContent!, /Big navigation tree \(nav-big\)/);
  assert.match(world.el("nav-tree-meta").textContent!, /236 nodes · max depth 13/);
  assert.equal(world.childrenRequests("nav-big", "big-trunk").length, 1, "opening loads exactly the first children page");
  assert.match(world.childrenRequests("nav-big", "big-trunk")[0]!.path, /limit=50/);

  /* 未展开：只有主干行。 */
  assert.equal(world.navRows().length, 1, "a collapsed tree renders only the trunk row");
  assert.equal(world.navRow("big-trunk")!.getAttribute("aria-expanded"), "false");

  /* 展开主干：52 可见行（主干 + 50 + More），但 DOM 只渲染窗口（10 行）。 */
  await world.expandToggle("big-trunk");
  const rows = world.navRows();
  assert.equal(rows.length, 10, "the virtualized window renders 10 rows (trunk + 9 children), not 52");
  assert.deepEqual(
    rows.map((row) => row.dataset.branchId),
    ["big-trunk", "w-000", "w-001", "w-002", "w-003", "w-004", "w-005", "w-006", "w-007", "w-008"],
    "the window starts at the top of the visible order",
  );
  assert.equal(world.navRow("w-009"), null, "rows outside the window are not in the DOM");
  assert.equal(world.navRow("w-050"), null, "unloaded children (page 2+) never render");
  /* spacer 占位：窗口外高度 = (52-10) × 34px。 */
  assert.equal(world.el("nav-tree-spacer-top").getAttribute("style"), "height: 0px");
  assert.equal(world.el("nav-tree-spacer-bottom").getAttribute("style"), "height: 1428px");
  /* 状态行如实披露窗口口径（B9 虚拟化的可核查口径）。 */
  assert.match(
    world.el("nav-tree-status").textContent!,
    /rendering 10\/52 visible rows \(virtualized window\) · 236 nodes · max depth 13/,
  );
  /* More 行在场（第 51 行——窗口外，DOM 无）。 */
  assert.equal(world.navTree().querySelectorAll(".nav-more-row").length, 0, "the More row is outside the initial window");
  /* 未再取页：More 行不在窗口 → 不自动续页。 */
  assert.equal(world.childrenRequests("nav-big", "big-trunk").length, 1);

  /* 滚动：窗口重划（不同片段在场，DOM 恒有界，未载节点绝不出现）。 */
  world.el("nav-tree-scroll").scrollTop = 600; /* 窗口 [7, 28) */
  await settle(10);
  let windowed = world.navRows();
  assert.equal(windowed.length, 21, "the window grows with the (scripted) viewport geometry, not the tree");
  assert.equal(world.navRow("w-006") !== null && world.navRow("w-026") !== null, true, "the window slides over the loaded page");
  assert.equal(world.navRow("w-027"), null);
  assert.equal(world.navRow("w-050"), null, "still no unloaded node renders after scrolling");
  assert.equal(world.childrenRequests("nav-big", "big-trunk").length, 1, "no page request while the More row is outside the window");

  /* 滚到已载内容底部：More 行进入窗口 → 自动续页（游标 off-50）。 */
  world.el("nav-tree-scroll").scrollTop = 51 * 34; /* 窗口 [41, 61) → 含 More 行 */
  await settle(30);
  const children = world.childrenRequests("nav-big", "big-trunk");
  assert.equal(children.length, 2, "the in-window More row auto-loads the next page");
  assert.match(children[1]!.path, /cursor=off-50/, "the auto-load uses the page cursor");
  windowed = world.navRows();
  assert.ok(windowed.length <= 20, "the DOM stays bounded after the page arrives");
  assert.equal(world.navRow("w-050") !== null, true, "page-2 children render once loaded");
  assert.equal(world.navRow("w-060"), null, "only the loaded pages render — never the whole tree");
});

test("children page failures are honest: a first-page failure shows the error with a Retry row, and an auto-paged More failure keeps the loaded page and retries the next page", async () => {
  /* 首页失败（展开 w-000 的第一次 children 请求 500）→ failed 行 + Retry。 */
  const world = await createWorld({ childrenFail: { treeId: "nav-big", parentId: "w-000", nth: 1 } });
  await world.openNavTreeViaFinder("nav-big");
  await world.expandToggle("big-trunk");
  await world.expandToggle("w-000");
  const failedRow = world.navTree().querySelectorAll(".nav-status-row").find((row) => row.classList.contains("failed"));
  assert.ok(failedRow !== undefined, "the failed children load shows a failed status row");
  assert.match(
    failedRow!.textContent!,
    /branches failed to load — internal: scripted children failure/,
    "the failure reason is shown verbatim",
  );
  const retry = failedRow!.querySelector("button.drawer-retry")!;
  assert.ok(retry !== null, "the failed row offers a retry");
  retry.click();
  await settle(25);
  assert.equal(world.navRow("m-001") !== null, true, "the retried load renders the children");

  /* 续页失败：已载页保持，失败页可重试（More 行的失败态）。 */
  const moreWorld = await createWorld({ childrenFail: { treeId: "nav-big", parentId: "big-trunk", nth: 2 } });
  await moreWorld.openNavTreeViaFinder("nav-big");
  await moreWorld.expandToggle("big-trunk");
  moreWorld.el("nav-tree-scroll").scrollTop = 51 * 34; /* 自动续页 → 第 2 次请求失败 */
  await settle(30);
  assert.match(
    moreWorld.el("nav-tree-status").textContent!,
    /rendering /,
    "the window still renders after the page failure",
  );
  const failedMore = moreWorld.navTree().querySelectorAll(".nav-more-row").find((row) => row.textContent!.includes("failed"));
  assert.ok(failedMore !== undefined, "the More row shows the page-scoped failure");
  assert.equal(moreWorld.navRow("w-049") !== null, true, "the already-loaded page stays (the failure is page-scoped)");
  assert.equal(moreWorld.navRow("w-050"), null, "the failed page's nodes do not render");
  const retryMore = failedMore!.querySelector("button.drawer-retry")!;
  retryMore.click();
  await settle(30);
  assert.equal(moreWorld.navRow("w-050") !== null, true, "the retried page loads");
});

/* ------------------------------------------------------------------ */
/* 3. 展开状态持久化：PUT 载荷 + 重开恢复                                */
/* ------------------------------------------------------------------ */

test("expand-state persistence: every expansion/selection PUTs the full set, and reopening restores the saved expansion and the deep selection via ancestor paging", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-deep");

  /* 展开主干 → PUT {expandedBranchIds:[trunk], selectedBranchId:null}。 */
  await world.expandToggle("deep-trunk");
  let puts = world.expandPuts();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0]!.body, { expandedBranchIds: ["deep-trunk"], selectedBranchId: null });

  /* 选中 d-001 → PUT 全集（展开不变 + 选中）。 */
  await world.selectRow("d-001");
  puts = world.expandPuts();
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[puts.length - 1]!.body, {
    expandedBranchIds: ["deep-trunk"],
    selectedBranchId: "d-001",
  });
  assert.match(world.el("nav-path-heading").textContent!, /full path · 2 level\(s\), root → selected/);

  /* 再展开 d-001、选中 d-002（深层选中——祖先链在展开集合内）。 */
  await world.expandToggle("d-001");
  await world.selectRow("d-002");
  puts = world.expandPuts();
  assert.deepEqual(puts[puts.length - 1]!.body, {
    expandedBranchIds: ["deep-trunk", "d-001"],
    selectedBranchId: "d-002",
  });
  /* 服务端收到的就是最后一次整组快照（last-write-wins 口径核对）。 */
  assert.deepEqual(world.backend.navExpandStates.get("nav-deep"), {
    expandedBranchIds: ["deep-trunk", "d-001"],
    selectedBranchId: "d-002",
  });

  /* Close → 重开：GET 恢复展开集合与深层选中（无用户动作不回写）。 */
  world.el("nav-close-tree").click();
  await settle(10);
  assert.equal(world.el("nav-surface").hidden, true, "Close hides the tree surface");
  await world.openNavTreeViaFinder("nav-deep");
  const putCountAfterReopen = world.expandPuts().length;
  /* 上面共 4 个用户动作（展开主干 / 选中 d-001 / 展开 d-001 / 选中 d-002），
     每个动作整组 PUT 一次——与本用例前两步「动作后 length 1/2」的逐动作
     断言同口径（原作者按 3 计数是算术笔误）。重开读回恢复零回写：计数
     与关闭前一致即为本断言的实质。 */
  assert.equal(putCountAfterReopen, 4, "reopening restores without writing state back");
  const d002 = world.navRowRequired("d-002");
  assert.equal(d002.classList.contains("active"), true, "the saved selection is restored");
  assert.equal(d002.classList.contains("focused"), true, "the saved selection takes the roving focus");
  assert.equal(world.navRow("d-001")!.getAttribute("aria-expanded"), "true", "the saved expansion is restored");
  assert.match(world.el("nav-path-heading").textContent!, /full path · 3 level\(s\), root → selected/);
  assert.deepEqual(
    world.navRows().map((row) => row.dataset.branchId),
    ["deep-trunk", "d-001", "d-002"],
    "the restored expansion renders the saved visible chain",
  );
});

/* ------------------------------------------------------------------ */
/* 4. 键盘：逐层移动与展开；焦点不因虚拟化消失                            */
/* ------------------------------------------------------------------ */

test("keyboard traversal: arrows move row-by-row across the windowed order, → expands / enters the first child, ← collapses / returns to the parent, Enter selects, and the focused row never leaves the DOM", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-big");

  /* 进入树（无焦点行时 ↓ 落到首行 = 主干）。 */
  world.navKey("ArrowDown");
  assert.equal(world.document.activeElement, world.navRow("big-trunk"), "ArrowDown lands on the trunk row");

  /* → 展开主干（按需加载首页）。 */
  world.navKey("ArrowRight");
  await settle(25);
  assert.equal(world.navRow("big-trunk")!.getAttribute("aria-expanded"), "true");
  assert.equal(world.childrenRequests("nav-big", "big-trunk").length >= 1, true, "ArrowRight expansion loads children on demand");

  /* ↓ × 16：越过初始窗口（10 行）——滚动跟随，焦点行始终在 DOM。 */
  for (let i = 0; i < 16; i += 1) {
    world.navKey("ArrowDown");
    await settle(2);
  }
  const focused = world.document.activeElement;
  assert.ok(focused !== null, "the keyboard focus never vanishes");
  assert.equal((focused as StubElement).dataset.branchId, "w-015", "16 ArrowDowns reach w-015");
  assert.equal(world.navTree().contains(focused as StubElement), true, "the focused row is inside the rendered tree DOM");
  assert.equal((focused as StubElement).tabIndex, 0, "the focused row carries the roving tabindex");
  assert.ok(world.navRows().length <= 21, "the DOM stays window-bounded during keyboard traversal");

  /* 回到 w-000：→ 展开其子链（m-001），再 → 入首子。 */
  for (let i = 0; i < 15; i += 1) {
    world.navKey("ArrowUp");
    await settle(2);
  }
  assert.equal((world.document.activeElement as StubElement).dataset.branchId, "w-000");
  world.navKey("ArrowRight"); /* 展开 w-000 */
  await settle(25);
  assert.equal(world.navRow("w-000")!.getAttribute("aria-expanded"), "true");
  assert.equal(world.navRow("m-001") !== null, true, "w-000's children render after the keyboard expansion");
  world.navKey("ArrowRight"); /* 已展开 → 入首子 */
  await settle(5);
  assert.equal((world.document.activeElement as StubElement).dataset.branchId, "m-001", "ArrowRight on an expanded row enters its first child");

  /* ← 收起语义：m-001 已收起 → 回父；w-000 已展开 → 收起（子树 DOM-free）。 */
  world.navKey("ArrowLeft");
  await settle(5);
  assert.equal((world.document.activeElement as StubElement).dataset.branchId, "w-000", "ArrowLeft on a collapsed row returns to the parent");
  world.navKey("ArrowLeft"); /* w-000 展开 → 收起 */
  await settle(5);
  assert.equal(world.navRow("w-000")!.getAttribute("aria-expanded"), "false");
  assert.equal(world.navRow("m-001"), null, "a collapsed subtree is DOM-free");
  assert.equal((world.document.activeElement as StubElement).dataset.branchId, "w-000", "focus stays on the collapsed row");

  /* Enter 选中：路径行 + PUT。 */
  world.navKey("ArrowDown");
  world.navKey("Enter");
  await settle(25);
  const selected = world.navRowRequired("w-001");
  assert.equal(selected.classList.contains("active"), true, "Enter selects the focused row");
  assert.match(world.el("nav-path-heading").textContent!, /full path · 2 level\(s\), root → selected/);
  const lastPut = world.expandPuts().pop()!;
  assert.equal((lastPut.body as Record<string, unknown>).selectedBranchId, "w-001");

  /* Home 回首行。 */
  world.navKey("Home");
  await settle(5);
  assert.equal((world.document.activeElement as StubElement).dataset.branchId, "big-trunk", "Home returns to the first visible row");
});

/* ------------------------------------------------------------------ */
/* 5. 同名消歧 + 完整父路径（深链可收拢但完整）                          */
/* ------------------------------------------------------------------ */

test("same-name disambiguation: branch search hits carry distinct full paths, rows carry id chips, and the selected node's full parent path is complete (long chains collapse but expand to every level)", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-big");

  /* 分支搜索「方案A」：3 命中，路径各异（同名不同枝的消歧载荷）。 */
  world.el("nav-node-search").value = SAME_NAME_TITLE;
  world.el("nav-node-find").click();
  await settle(25);
  const hits = world.el("nav-node-results").querySelectorAll("button").filter((button) => button.dataset.branchId !== undefined);
  assert.equal(hits.length, 3, "the three same-name branches all hit");
  const hitMeta = hits.map((hit) => hit.textContent!);
  assert.ok(hitMeta.every((text) => text.includes(SAME_NAME_TITLE)), "each hit shows the title");
  assert.ok(hits.some((hit) => hit.textContent!.includes("s-001") && hit.textContent!.includes("Wide branch 001")), "s-001's hit carries its path through w-001");
  assert.ok(hits.some((hit) => hit.textContent!.includes("s-002") && hit.textContent!.includes("Wide branch 002")), "s-002's hit carries its path through w-002");
  assert.ok(hits.some((hit) => hit.textContent!.includes("s-003") && hit.textContent!.includes("Mid step 3")), "s-003's hit carries its path through m-003");
  /* title 属性带完整路径（长链显示收拢、悬停完整）。 */
  const s003Hit = hits.find((hit) => hit.dataset.branchId === "s-003")!;
  assert.ok(s003Hit.title!.includes("Big navigation tree / Wide branch 000 / Mid step 1 / Mid step 2 / Mid step 3 / 方案A"));

  /* 点击命中 s-002：揭示（展开 trunk + w-002，翻页至 s-002 出现）并选中。 */
  s003Hit.click(); /* 先点 s-003（深层——揭示需展开 w-000→m-003 链） */
  await settle(60);
  assert.equal(world.navRowRequired("s-003").classList.contains("active"), true, "the deep same-name hit is revealed and selected");
  assert.equal(world.navRow("m-003")!.getAttribute("aria-expanded"), "true", "the reveal expanded the ancestor chain");
  assert.match(world.el("nav-path").textContent!, /Mid step 3/);
  assert.match(world.el("nav-path").textContent!, /方案A/);

  /* 同名行同屏可区分：展开 w-001（s-001 的父），与已选 s-003 同标题。 */
  await world.expandToggle("w-001");
  const s001 = world.navRowRequired("s-001");
  assert.equal(s001.querySelector(".nav-title")!.textContent, SAME_NAME_TITLE);
  assert.equal(s001.querySelector(".nav-id")!.textContent, "s-001", "the id chip distinguishes the same-name row");
  assert.equal(world.navRowRequired("s-003").querySelector(".nav-id")!.textContent, "s-003");
  /* 长标题：title 属性携带全文（w-003 的 200+ 字标题）。 */
  const longLabel = world.navLabel("w-003");
  assert.equal(longLabel.title!.startsWith(LONG_TITLE.slice(0, 40)), true, "the title attribute carries the full long title");
  assert.ok(longLabel.title!.includes("w-003"), "the title attribute carries the id identity");

  /* 深链完整路径：nav-deep 的 d-060（61 层）——默认收拢，展开后 61 步全在。 */
  await world.openNavTreeViaFinder("nav-deep");
  world.el("nav-node-search").value = "Chain step 60";
  world.el("nav-node-find").click();
  await settle(25);
  const deepHit = world.el("nav-node-results").querySelectorAll("button").find((button) => button.dataset.branchId === "d-060")!;
  assert.ok(deepHit !== undefined);
  deepHit.click();
  await settle(600); /* 60 层揭示：每层一页（1 子节点/页）的顺序续页 */
  assert.equal(world.navRowRequired("d-060").classList.contains("active"), true, "the 60-level node is revealed and selected");
  assert.match(world.el("nav-path-heading").textContent!, /full path · 61 level\(s\), root → selected/);
  /* 收拢显示（首两步 + 末两步 + 「show full path」）。 */
  let steps = world.el("nav-path").querySelectorAll(".nav-path-step");
  assert.equal(steps.length, 4, "the long path renders collapsed (first two + last two)");
  assert.match(world.el("nav-path").textContent!, /… 57 more level\(s\) — show full path/);
  world.el("nav-path").querySelector(".nav-path-more")!.click();
  await settle(5);
  steps = world.el("nav-path").querySelectorAll(".nav-path-step");
  assert.equal(steps.length, 61, "show full path renders every level — collapsible but complete");
  /* 路径步可点击：向上选中该祖先。 */
  const step30 = steps.find((step) => step.textContent === "Chain step 30")!;
  step30.click();
  await settle(25);
  assert.equal(world.navRowRequired("d-030").classList.contains("active"), true, "clicking a path step selects that ancestor");
  assert.match(world.el("nav-path-heading").textContent!, /full path · 31 level\(s\), root → selected/);
});

/* ------------------------------------------------------------------ */
/* 6. 诚实状态面：stale-cursor 409 / 503 nav-not-wired / 展开读失败      */
/* ------------------------------------------------------------------ */

test("stale-cursor 409 recovery: a cursor page after index invalidation restarts from the first page (request sequence locked, no duplicate rows)", async () => {
  const world = await createWorld({ staleCursorOnce: { treeId: "nav-big", parentId: "big-trunk" } });
  await world.openNavTreeViaFinder("nav-big");
  await world.expandToggle("big-trunk");

  /* 滚到底：自动续页带游标 → 409 stale-cursor → 从首页重拉。 */
  world.el("nav-tree-scroll").scrollTop = 51 * 34;
  await settle(40);
  const children = world.childrenRequests("nav-big", "big-trunk");
  assert.ok(children.length >= 3, "the recovery sequence has at least three requests");
  assert.ok(!children[0]!.path.includes("cursor="), "request 1: the first page (open)");
  assert.match(children[1]!.path, /cursor=off-50/, "request 2: the stale cursor page");
  assert.ok(!children[2]!.path.includes("cursor="), "request 3: the 409 recovery restarts from the first page");
  /* 恢复后重载的首页与续页最终一致：第二页在场（当前窗口 [41,61) 内的
     w-050 可见）；渲染窗口内无重复行；滚回顶部复查重载首页——w-000 恰好
     一行。（w-000 是第 2 行，scrollTop=51*34 的窗口 [41,61) 不含它——
     虚拟化行数与窗口几何由测试 2 锁定，故分窗口先后核对，断言强度不减。） */
  assert.equal(world.navRow("w-050") !== null, true, "paging continues after the recovery");
  const windowIds = world.navTree().querySelectorAll(".nav-item").map((row) => row.dataset.branchId!);
  assert.equal(new Set(windowIds).size, windowIds.length, "no duplicate rows in the rendered window after the recovery");
  world.el("nav-tree-scroll").scrollTop = 0;
  await settle(10);
  assert.equal(world.navTree().querySelectorAll(".nav-item").filter((row) => row.dataset.branchId === "w-000").length, 1, "no duplicate rows after the recovery (window back at the reloaded first page)");
});

test("nav-not-wired 503: the honest unavailable state with a retry (no fabricated trees), and an expand-state read failure degrades to a note while browsing continues", async () => {
  /* 503：整个 /api/nav/* 未装配——如实说明 + 重试，绝不伪装成空森林。 */
  const unwired = await createWorld({ navUnwired: true });
  assert.match(
    unwired.el("nav-tree-results").textContent!,
    /trees failed to load — nav-not-wired: the tree navigation service is not wired in this process/,
    "the 503 surfaces the honest nav-not-wired reason",
  );
  const retry = unwired.el("nav-tree-results").querySelector("button.drawer-retry")!;
  retry.click();
  await settle(25);
  assert.match(
    unwired.el("nav-tree-results").textContent!,
    /nav-not-wired/,
    "the retry reports the same honest state (still unwired)",
  );

  /* 展开状态读失败：注记如实（浏览继续，不伪造默认展开）。 */
  const world = await createWorld({ expandGetFailOnce: true });
  await world.openNavTreeViaFinder("nav-deep");
  assert.match(
    world.el("nav-tree-status").textContent!,
    /saved navigation state could not be read — internal: scripted expand-state read failure/,
  );
  await world.expandToggle("deep-trunk");
  assert.equal(world.navRow("d-001") !== null, true, "browsing continues after the state-read failure");
});

/* ------------------------------------------------------------------ */
/* 7. 定位当前分支（跨树）+ 跳回来源（turn / material / 无来源）         */
/* ------------------------------------------------------------------ */

test("locate current branch: cross-tree locate switches the nav tree and reveals the workbench's current branch through its ancestor chain", async () => {
  const world = await createWorld();
  /* 工作台树 = nav-other（boot 打开），cursor 在 other-b1。导航面在 nav-deep。 */
  await world.openNavTreeViaFinder("nav-deep");
  assert.equal(world.el("nav-locate-current").disabled, false, "the workbench branch makes Locate available");
  world.el("nav-locate-current").click();
  await settle(60);
  const locateRequests = world.requestsOf("/api/nav/branches/other-b1/locate");
  assert.equal(locateRequests.length, 1, "Locate hits the cross-tree locate endpoint");
  assert.match(world.el("nav-tree-title").textContent!, /Workbench tree \(nav-other\)/, "the nav session switched to the located tree");
  const row = world.navRowRequired("other-b1");
  assert.equal(row.classList.contains("active"), true, "the located branch is selected");
  assert.equal(row.classList.contains("focused"), true, "the located branch takes focus");
  assert.match(world.el("nav-path-heading").textContent!, /full path · 2 level\(s\), root → selected/);
  assert.match(world.el("nav-path").textContent!, /Branched from the trunk answer/);
});

test("jump to source: a turn origin goes through the existing /source reveal, a material origin opens the reader at the anchored version+block, and a trunk honestly reports no origin", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-other");
  /* 树以收起打开（仅主干行——测试 2/3 锁定的行为）：先展开主干，
     other-b1/other-b2 才进入渲染窗口（跨树用例同一步骤）。 */
  await world.expandToggle("other-trunk");
  await world.selectRow("other-b1");

  /* turn 来源：既有 revealOrigin 约定（POST /source）。 */
  world.el("nav-source-selected").click();
  await settle(40);
  const sourceRequests = world.requestsOf("/api/trees/nav-other/branches/other-b1/source");
  assert.equal(sourceRequests.length, 1, "a turn origin reveals via the existing /source endpoint");
  assert.equal(sourceRequests[0]!.method, "POST");

  /* material 来源：既有阅读器跳转（版本 + 块定位）。 */
  await world.selectRow("other-b2");
  world.el("nav-source-selected").click();
  await settle(40);
  assert.equal(world.el("material-reader").hidden, false, "the material reader opens for a material origin");
  assert.equal(world.requestsOf("/api/trees/nav-other/materials/mat-src").length >= 1, true, "the material detail is fetched");
  const versionRequest = world.requestsOf("/versions/v-src-1").find((r) => r.path.includes("mat-src"))!;
  assert.ok(versionRequest !== undefined, "the anchored version is fetched");
  assert.match(world.el("material-reader").textContent!, /Source material\.md/, "the reader shows the origin material");

  /* trunk：无来源——如实说明，绝不伪造近似位置。 */
  await world.selectRow("other-trunk");
  const sourceCallsBefore = world.requestsOf("/source").length;
  world.el("nav-source-selected").click();
  await settle(40);
  assert.equal(world.requestsOf("/source").length, sourceCallsBefore, "no source reveal is attempted for the trunk");
  assert.match(
    world.el("nav-tree-status").textContent!,
    /other-trunk has no saved origin to reveal \(the trunk, or a branch created without one\) — nothing is faked/,
  );
});

test("jump to source across trees: the workbench first opens the origin's tree (existing openTree behavior), then the existing reveal runs", async () => {
  const world = await createWorld();
  /* 工作台在 nav-other（boot）；导航面在 nav-big；w-000 带 turn 来源。 */
  await world.openNavTreeViaFinder("nav-big");
  await world.expandToggle("big-trunk");
  await world.selectRow("w-000");
  world.el("nav-source-selected").click();
  await settle(60);
  assert.equal(
    world.requestsOf("/api/trees/nav-big/state").length >= 1,
    true,
    "the workbench opens the origin's tree before revealing (existing openTree path)",
  );
  const sourceRequests = world.requestsOf("/api/trees/nav-big/branches/w-000/source");
  assert.equal(sourceRequests.length, 1, "the reveal runs through the existing /source endpoint on the origin tree");
});

/* ------------------------------------------------------------------ */
/* 8. 空树指引                                                          */
/* ------------------------------------------------------------------ */

test("an empty tree stays honestly usable: single trunk, null title, explicit growth guidance, no fabricated rows", async () => {
  const world = await createWorld();
  await world.openNavTreeViaFinder("nav-empty");
  assert.match(world.el("nav-tree-title").textContent!, /nav-empty — untitled \(no first question on the trunk\)/);
  assert.match(
    world.el("nav-tree-meta").textContent!,
    /1 nodes · max depth 0 · this tree has no branches yet — branch from any answer to grow it/,
  );
  const trunkRow = world.navRowRequired("empty-trunk");
  assert.equal(trunkRow.querySelector(".nav-toggle")!.classList.contains("leaf"), true, "the trunk of an empty tree is an honest leaf");
  assert.equal(trunkRow.querySelector(".nav-title")!.textContent, "Trunk", "an untitled trunk renders as Trunk");
  assert.equal(world.childrenRequests("nav-empty", "empty-trunk").length, 1, "the trunk children (zero) are fetched once");
  assert.equal(world.navTree().querySelectorAll(".nav-more-row").length, 0, "no More row is fabricated for zero children");
  assert.match(world.el("nav-tree-status").textContent!, /rendering 1\/1 visible rows/);
});

/* ------------------------------------------------------------------ */
/* 9. CSS 词法锁定                                                      */
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

test("CSS lexicon: the nav surface's bounded scroll container, fixed row height, keyboard-focus rule, title truncation, and narrow-window touch rules are locked lexically", () => {
  const base = baseCssLayer(STYLE_CSS);
  /* 有界滚动容器（虚拟化窗口的事实源）。 */
  assert.ok(/#nav-tree-scroll\s*\{[^{}]*overflow-y:\s*auto/.test(base), "the tree scroll container is the bounded overflow container");
  assert.ok(/#nav-tree-scroll\s*\{[^{}]*max-height:\s*34vh/.test(base), "the scroll container is height-bounded (max-height cap — sidebar sections are natural-height since the five-section flex model change)");
  /* 固定行高（虚拟化常数——与 app.js NAV_ROW_HEIGHT_PX 同值）。 */
  assert.ok(/\.nav-item\s*\{[^{}]*height:\s*34px/.test(base), "rows have the fixed 34px height (the virtualization constant)");
  /* 键盘焦点行的可见态（roving tabindex 的焦点不消失的可见保证）。 */
  assert.ok(
    /\.nav-item\.focused\s*\{[^{}]*outline:\s*2px solid var\(--green\)/.test(base),
    "the focused row carries a visible keyboard-focus outline",
  );
  /* 长标题截断：显示层截断 + title 属性全文（JS 侧已锁定）。 */
  assert.ok(
    /\.nav-title\s*\{[^{}]*text-overflow:\s*ellipsis/.test(base) && /\.nav-title\s*\{[^{}]*white-space:\s*nowrap/.test(base),
    "long titles truncate with ellipsis in the row",
  );
  assert.ok(/\.nav-id\s*\{[^{}]*text-overflow:\s*ellipsis/.test(base), "id chips truncate gracefully too");

  /* 窄窗（<720px）：触点加大；行高不变（窗口数学与媒体查询无关）。 */
  const narrow = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(max-width: 719px)");
  assert.ok(narrow !== undefined, "style.css carries the <720px narrow-window media query");
  const narrowFind = declarationsOf(narrow!, ".nav-find-row button");
  assert.ok(narrowFind !== null && narrowFind.includes("padding: 8px 14px"), "the Find buttons get enlarged touch targets under 720px");
  const narrowResults = declarationsOf(narrow!, "#nav-tree-results, #nav-node-results");
  assert.ok(narrowResults !== null && narrowResults.includes("max-height: 216px"), "result lists allow more height on narrow windows");
  assert.equal(
    narrow!.rules.find((rule) => rule.selector === ".nav-item"),
    undefined,
    "the narrow block never changes the row height (the virtualization constant is media-independent)",
  );
});
