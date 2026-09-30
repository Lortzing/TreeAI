/**
 * D4-4 找回既有思考 —— 搜索前端套件（issue #8 工作包 D4-4；charter §5
 * 「搜索」+ §6 B4 的浏览器面；消费已落地的 POST /api/trees/:id/search 与
 * POST /api/search，D4-contracts §3 的 SearchHit 裁剪形状）。
 *
 * 方法与 ui-material-reader / ui-probe / ui-terminology 套件一致（issue #4
 * P1「证据工程化」的脚本化 DOM E2E）：以 data: URL 加载仓库真实
 * public/app.js 为 ES module（URL fragment 随机化绕过 ES 模块缓存——每个
 * 场景一份全新实例），运行在「按真实 public/index.html 词法解析出的完整
 * DOM 桩 + 脚本化后端」之上：fetch / EventSource / localStorage / 计时器 /
 * matchMedia / getSelection 全部为内存桩。无网络、无磁盘写入、无长等待，
 * 确定性可复现。本文件自包含（不依赖其他 UI 套件）。
 *
 * 搜索响应的**真值纪律**：脚本后端的 /search 路由不手写命中——它把脚本
 * 世界的产品事实装配成 SearchSnapshot（材料版本钉在 B1 冻结真值
 * canonicalText/blocks 上，tests/fixtures/d4/b1-import/markdown），经
 * **产品装配路径** buildSearchDocuments + LocalSearchEngine（与 HTTP 端点
 * 同一代码路径，非测试副本）检索，再经 toContractSearchHit 裁剪成契约
 * 形状——UI 消费的命中就是引擎对语料的确定性输出（排序/摘录/旧版本标注/
 * kinds 过滤全部真值，期望值按同一引擎在测试内推导，不手算）。
 *
 * 覆盖（D4-4 前端交付面的逐项锁定）：
 *  1. 范围（charter §5「默认在当前 Tree，用户可切到全部 Tree」）：默认
 *     当前树（请求打到 /api/trees/:id/search，kinds 全集）；全部树
 *     （/api/search）；单树检索不泄漏他树事实；空库启动时检索面不消失
 *     （「当前树」开关如实禁用、范围回落全部树，零命中如实）。
 *  2. 来源类型筛选：材料/批注/Return/对话按契约 kinds 透传服务端（引擎
 *     过滤的真值）；结果按服务端返回序确定性呈现（引擎全序：批注 →
 *     Return → 对话 → 材料），客户端不重排。
 *  3. 版本诚实（charter §5「命中旧版本应标注旧版本」）：旧版本命中行显式
 *     标注「旧版本」；点击打开**命中版本**的只读阅读面（v1 older 注记 +
 *     never-migrate 说明——D4-2 纪律复用），并定位到命中块。
 *  4. 命中 → 既有视图跳转：材料命中 → D4-2 阅读器按版本+块定位（当前版本
 *     与旧版本两路；跨页前补到目标块；阅读不 POST /switch——charter §3.2
 *     阅读与探索互不干扰）；批注命中 → 锚定答案定位 + 已保存批注卡；
 *     Return 命中 → 主线 Return 卡定位；对话命中 → 主线/支线面板内 turn
 *     定位（支线走既有 switch 语义）。
 *  5. session 不可用（charter §3.2 来源定位与 Pi 续聊分别判断）：命中行
 *     并排「⑃ 新探索」显式换轨入口（打开支线面板 + 聚焦输入框——面板
 *     composer 的既有 v3 §4.4 换轨面）；来源跳转永不因此受阻（跳转只呈现
 *     已保存事实，send fail-closed 但正文可读）。
 *  6. 诚实状态面：零命中如实空态（不编造）；空查询/空筛选按服务端同一规
 *     则客户端拦下（不发注定失败的请求）；在途状态如实「searching…」；
 *     失败如实呈现 + 可重试；idle 态恒声明「只搜已保存产品事实——未提交
 *     草稿永不入索引」（charter §5，UI 绝不暗示草稿可搜）。
 *  7. 搜索纯只读（charter §3.3「浏览/搜索不创建 Turn」）：整套搜索 + 跳转
 *     流程后，世界请求面无 POST /prompt、无 POST /api/trees、无建支线、
 *     无 new-exploration；「当前树」范围的旧结果随树切换诚实清空（全部树
 *     范围的结果是库级事实，跨树保持）。
 *  8. CSS 词法锁定：搜索表单/命中行/旧版本标注/session 注记的基础层规则。
 *
 * 边界（如实声明）：同 ui-material-reader——不是真实浏览器 E2E；CSS 不执
 * 行，按词法锁定；HTTP 契约面（真实 node:http 服务）由 search-api.test.ts
 * 覆盖，B4 冻结集检索语义由 verify:d4 的 b4-cross-material-find 覆盖；本
 * 套件锁的是前端消费行为（请求形状/呈现/跳转/状态诚实）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* 真实前端产物（绝不硬编码副本——桩面对的必须是仓库当前 UI）。 */
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const APP_JS = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const STYLE_CSS = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");

/* 产品检索路径（HTTP 端点的同一代码路径——脚本后端的 /search 真值源）。 */
import { LocalSearchEngine, type SearchDocumentKind } from "../src/search/search-engine.ts";
import {
  buildSearchDocuments,
  toContractSearchHit,
  SEARCH_DOCUMENT_KINDS,
  type SearchSnapshot,
  type SearchSnapshotMaterialVersion,
} from "../src/search/search-service.ts";
import { hashSourceText } from "../src/terminology.ts";

/* B1 冻结真值（材料版本语料的 canonicalText/blocks 唯一事实源）。 */
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

const MD01 = loadFixture("md-01"); /* 递归与分治：14 块（当前版本语料） */
const MD05 = loadFixture("md-05"); /* 闭包/counter：17 块（v1 旧版本语料） */

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE_ONE = "tree-1";
const TREE_TWO = "tree-2";
const ISO = "2026-09-29T00:00:00.000Z";

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

interface StubTermAnnotation {
  id: string;
  treeId: string;
  branchId: string;
  anchorTurnId: string;
  selection: Selection;
  sourceHash: string;
  term: string;
  explanation: string;
  mode: "term" | "range";
  promotedBranchId: string | null;
  promotionKey: string | null;
  createdAt: string;
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

interface StubMaterialEntry {
  material: { id: string; title: string; createdAt: string };
  versions: StubMaterialVersion[];
  readingPosition: StubReadingPosition | null;
  versionSources: Map<string, FixtureExpected>;
  treeId: string;
}

/* ------------------------------ 脚本世界语料（正文即检索语料——单一事实源） ------------------------------ */

/* 树一（启动即开）：
 *  - 主干：u1 提问 / a1 回答（含「递归」）；r1 Return（含「递归」，锚 a1）；
 *  - branch-1（session 可用）：a2 回答（含「分治」「双指针」）；
 *  - branch-2（session 不可用）：a3 回答（独有短语「旧探索会话已丢失」）；
 *  - 批注（锚主干 a1）：term 词法作用域，解释含「递归」与独有短语
 *    「跨材料找回时按批注正文检索」；
 *  - 材料 mat-versions：v1 = md-05（旧版本，独有「counter 的四种写法」），
 *    v2 = md-01（当前版本，「基线条件」×6、「递归」×23）。
 * 树二：主干 a2t2 回答（独有短语「双指针去重模板」）。 */
const T1_TRUNK = "trunk-1";
const T1_BRANCH_AVAILABLE = "branch-1";
const T1_BRANCH_UNAVAILABLE = "branch-2";
const T2_TRUNK = "trunk-2";

const U1_TEXT = "递归怎么写才不会栈溢出？";
const A1_TEXT = "词法作用域在定义点绑定环境，分治与递归的可靠性来自归纳。";
const A2_TEXT = "分治把问题分成两半再合并，双指针合并有序段。";
const A3_TEXT = "旧探索会话已丢失，但这段已保存回答仍可检索。";
const RETURN_TEXT = "递归与写屏障的结论：分代回收依赖写屏障记录跨代引用。";
const T2_ANSWER = "双指针去重模板只在树二出现，供跨树检索验证。";
const ANNO_TERM = "词法作用域";
const ANNO_EXPLANATION = "词法作用域的解释：捕获定义点处的环境快照，跨材料找回时按批注正文检索，递归亦同。";

function makeTurn(
  id: string,
  treeId: string,
  branchId: string,
  role: Turn["role"],
  text: string,
  createdAt: string,
  extra: Partial<Turn> = {},
): Turn {
  return {
    id,
    treeId,
    branchId,
    episodeId: `ep-${id}`,
    runId: `run-${id}`,
    role,
    text,
    piEntryId: `pi-${id}`,
    fromBranchId: null,
    deliveredRunId: null,
    idempotencyKey: null,
    targetAnchor: null,
    createdAt,
    ...extra,
  };
}

/** 树一的完整树态（两套件场景共用；时间戳两树互异——定位匹配的消歧面）。 */
function treeOneState(): TreeState {
  const trunkBranch: Branch = { id: T1_TRUNK, treeId: TREE_ONE, parentBranchId: null, createdAt: ISO };
  const origin = (branchId: string): Origin => ({
    branchId,
    sourceBranchId: T1_TRUNK,
    anchorTurnId: "a1",
    anchorEntryId: "pi-a1",
    selection: { start: 0, end: 4, text: A1_TEXT.slice(0, 4) },
    createdAt: ISO,
  });
  return {
    tree: { id: TREE_ONE, createdAt: ISO, forestId: "forest-1" },
    trunkBranchId: T1_TRUNK,
    branches: [
      {
        branch: trunkBranch,
        origin: null,
        originStatus: null,
        sessionAvailability: "available",
        turns: [
          makeTurn("u1", TREE_ONE, T1_TRUNK, "user", U1_TEXT, "2026-09-29T01:00:00.000Z"),
          makeTurn("a1", TREE_ONE, T1_TRUNK, "assistant", A1_TEXT, "2026-09-29T02:00:00.000Z"),
          makeTurn(
            "r1",
            TREE_ONE,
            T1_TRUNK,
            "return",
            RETURN_TEXT,
            "2026-09-29T03:00:00.000Z",
            {
              fromBranchId: T1_BRANCH_AVAILABLE,
              idempotencyKey: "idem-r1",
              targetAnchor: {
                sourceBranchId: T1_TRUNK,
                anchorTurnId: "a1",
                anchorEntryId: "pi-a1",
                selection: { start: 0, end: 4, text: A1_TEXT.slice(0, 4) },
              },
            },
          ),
        ],
        returnAttempts: [],
      },
      {
        branch: { id: T1_BRANCH_AVAILABLE, treeId: TREE_ONE, parentBranchId: T1_TRUNK, createdAt: ISO },
        origin: origin(T1_BRANCH_AVAILABLE),
        originStatus: "available",
        sessionAvailability: "available",
        turns: [makeTurn("a2", TREE_ONE, T1_BRANCH_AVAILABLE, "assistant", A2_TEXT, "2026-09-29T04:00:00.000Z")],
        returnAttempts: [],
      },
      {
        branch: { id: T1_BRANCH_UNAVAILABLE, treeId: TREE_ONE, parentBranchId: T1_TRUNK, createdAt: ISO },
        origin: origin(T1_BRANCH_UNAVAILABLE),
        originStatus: "available",
        sessionAvailability: "unavailable",
        turns: [makeTurn("a3", TREE_ONE, T1_BRANCH_UNAVAILABLE, "assistant", A3_TEXT, "2026-09-29T05:00:00.000Z")],
        returnAttempts: [],
      },
    ],
    cursor: { treeId: TREE_ONE, branchId: T1_TRUNK, entryId: "pi-a1" },
  };
}

function treeTwoState(): TreeState {
  return {
    tree: { id: TREE_TWO, createdAt: ISO, forestId: "forest-1" },
    trunkBranchId: T2_TRUNK,
    branches: [
      {
        branch: { id: T2_TRUNK, treeId: TREE_TWO, parentBranchId: null, createdAt: ISO },
        origin: null,
        originStatus: null,
        sessionAvailability: "available",
        turns: [
          makeTurn("u2", TREE_TWO, T2_TRUNK, "user", "树二的第一个问题。", "2026-09-29T06:00:00.000Z"),
          makeTurn("a2t2", TREE_TWO, T2_TRUNK, "assistant", T2_ANSWER, "2026-09-29T07:00:00.000Z"),
        ],
        returnAttempts: [],
      },
    ],
    cursor: { treeId: TREE_TWO, branchId: T2_TRUNK, entryId: "pi-a2t2" },
  };
}

const ANNOTATION_ONE: StubTermAnnotation = {
  id: "term-ann-1",
  treeId: TREE_ONE,
  branchId: T1_TRUNK,
  anchorTurnId: "a1",
  selection: { start: 0, end: 5, text: A1_TEXT.slice(0, 5) },
  sourceHash: hashSourceText(A1_TEXT),
  term: ANNO_TERM,
  explanation: ANNO_EXPLANATION,
  mode: "term",
  promotedBranchId: null,
  promotionKey: null,
  createdAt: "2026-09-29T08:00:00.000Z",
};

/** 服务端 headOf 镜像（search-service.ts 的展示标题算法——期望值推导用）。 */
function headOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/** 脚本世界的检索快照（镜像 SearchService.readSnapshot 的产品推导：材料按
    版本入索引、oldVersion 由版本链推导、批注正文 = explanation+term、
    Return/对话按 turn 角色）。 */
function snapshotForTree(treeIds: string[], materials: StubMaterialEntry[]): SearchSnapshot {
  const trees = treeIds.map((treeId) => ({ treeId, title: treeId }));
  const materialVersions: SearchSnapshotMaterialVersion[] = [];
  const annotations: Array<{
    id: string;
    treeId: string;
    title: string;
    term: string;
    explanation: string;
    note?: string | null;
    createdAt: string;
  }> = [];
  const returns: Array<{ id: string; treeId: string; title: string; text: string; createdAt: string }> = [];
  const turns: Array<{ id: string; treeId: string; title: string; text: string; createdAt: string }> = [];

  const allStates = new Map<string, TreeState>([
    [TREE_ONE, treeOneState()],
    [TREE_TWO, treeTwoState()],
  ]);
  for (const treeId of treeIds) {
    const state = allStates.get(treeId);
    assert.ok(state !== undefined, `snapshot: unknown scripted tree ${treeId}`);
    for (const entry of materials.filter((candidate) => candidate.treeId === treeId)) {
      const versions = entry.versions;
      const currentVersionId = versions.length > 0 ? versions[versions.length - 1]!.id : null;
      versions.forEach((version, index) => {
        if (version.parseStatus !== "ready") return;
        const source = entry.versionSources.get(version.id);
        if (source === undefined) return;
        materialVersions.push({
          treeId,
          materialId: entry.material.id,
          materialTitle: entry.material.title,
          versionId: version.id,
          versionLabel: `v${String(index + 1)}`,
          oldVersion: version.id !== currentVersionId,
          canonicalText: source.canonicalText,
          blocks: source.blocks.map((block) => ({ blockId: block.blockId, start: block.start, end: block.end })),
          title: entry.material.title,
          importedAt: version.importedAt,
        });
      });
    }
    if (treeId === TREE_ONE) {
      annotations.push({
        id: ANNOTATION_ONE.id,
        treeId,
        title: `批注：${ANNOTATION_ONE.term}`,
        term: ANNOTATION_ONE.term,
        explanation: ANNOTATION_ONE.explanation,
        note: null,
        createdAt: ANNOTATION_ONE.createdAt,
      });
    }
    for (const view of state.branches) {
      for (const turn of view.turns) {
        if (turn.role === "return") {
          returns.push({
            id: turn.id,
            treeId,
            title: `Return：${headOf(turn.text)}`,
            text: turn.text,
            createdAt: turn.createdAt,
          });
        } else {
          turns.push({
            id: turn.id,
            treeId,
            title: `${turn.role === "user" ? "提问" : "回答"}：${headOf(turn.text)}`,
            text: turn.text,
            createdAt: turn.createdAt,
          });
        }
      }
    }
  }
  return { trees, materialVersions, annotations, returns, turns };
}

/* ------------------------------ DOM 桩（同 ui-material-reader 套件） ------------------------------ */

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
  /* 输入面反射属性（placeholder 是反射 IDL 属性——真实浏览器读写属性即
     同步 attribute；桩以属性承载，属性读写即真相）。 */
  placeholder = "";
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

/* ------------------------------ 事件 / fetch 形状 ------------------------------ */

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

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ------------------------------ 脚本世界 ------------------------------ */

interface WorldOptions {
  /** 首个 GET /api/trees 返回空（无树启动场景）。 */
  noTrees?: boolean;
  /** 首个 /search 请求失败一次（500 脚本错误）。 */
  searchFailOnce?: boolean;
  /** /search 未装配（503 search-not-wired——如实说明，绝不伪装成功）。 */
  searchUnwired?: boolean;
  /** 命中即挂起的请求路径后缀（一次性闸门，releaseHold 放行）。 */
  holdSuffix?: string;
  /** 分块读取页大小（脚本化）。 */
  pageSize?: number;
}

interface Backend {
  requests: RecordedRequest[];
  switchCount: number;
  materials: StubMaterialEntry[];
  pageSize: number;
  searchFailOnce: boolean;
  searchUnwired: boolean;
  holdSuffix: string | null;
  noTrees: boolean;
}

interface World {
  readonly document: StubDocument;
  readonly backend: Backend;
  el(id: string): StubElement;
  byId(id: string): StubElement | null;
  requestsOf(suffix: string): RecordedRequest[];
  lastRequest(suffix: string): RecordedRequest | null;
  searchRequests(): RecordedRequest[];
  hitRows(): StubElement[];
  runSearch(query: string): Promise<void>;
  releaseHold(): void;
  treeButton(treeId: string): StubElement;
  turnElementById(containerId: string, turnId: string): StubElement;
}

let appLoadCounter = 0;

/** 标准材料：v1 = md-05（旧版本），v2 = md-01（当前版本）。 */
function makeVersionedMaterial(): StubMaterialEntry {
  const versions: StubMaterialVersion[] = [
    {
      id: "v-old",
      materialId: "mat-versions",
      contentHash: "hash-v-old",
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      importedAt: "2026-09-28T00:00:00.000Z",
      sizeBytes: 1024,
      parseStatus: "ready",
      parseError: null,
      textUnits: MD05.textUnits,
    },
    {
      id: "v-new",
      materialId: "mat-versions",
      contentHash: "hash-v-new",
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      importedAt: "2026-09-29T00:00:00.000Z",
      sizeBytes: 1024,
      parseStatus: "ready",
      parseError: null,
      textUnits: MD01.textUnits,
    },
  ];
  return {
    material: { id: "mat-versions", title: "学习笔记（改版）.md", createdAt: ISO },
    versions,
    readingPosition: null,
    versionSources: new Map([
      ["v-old", MD05],
      ["v-new", MD01],
    ]),
    treeId: TREE_ONE,
  };
}

async function createWorld(options: WorldOptions = {}): Promise<World> {
  const documentStub = new StubDocument();
  documentStub.attach(buildDomFromHtml(INDEX_HTML, documentStub));
  StubEventSource.resetRegistry();

  const localStorageStore = new Map<string, string>();
  const windowStub = {
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      addEventListener(): void {},
      removeEventListener(): void {},
    }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(),
    clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
    localStorage: {
      getItem: (key: string) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
      setItem: (key: string, value: string) => {
        localStorageStore.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageStore.delete(key);
      },
      clear: () => {
        localStorageStore.clear();
      },
    },
    getSelection: () => ({
      get rangeCount(): number {
        return 0;
      },
      getRangeAt(): never {
        throw new Error("no scripted selection in the search suite");
      },
    }),
    confirm: () => true,
  };

  const materials = [makeVersionedMaterial()];
  const treeStates = new Map<string, TreeState>([
    [TREE_ONE, treeOneState()],
    [TREE_TWO, treeTwoState()],
  ]);

  const backend: Backend = {
    requests: [],
    switchCount: 0,
    materials,
    pageSize: options.pageSize ?? 50,
    searchFailOnce: options.searchFailOnce === true,
    searchUnwired: options.searchUnwired === true,
    holdSuffix: options.holdSuffix ?? null,
    noTrees: options.noTrees === true,
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

    /* ---- 树面（boot/渲染所需的最小路由） ---- */
    if (p === "/api/trees" && method === "GET") {
      if (backend.noTrees) return respond(200, { trees: [] });
      return respond(200, {
        trees: [
          { id: TREE_ONE, createdAt: ISO, forestId: "forest-1" },
          { id: TREE_TWO, createdAt: ISO, forestId: "forest-1" },
        ],
      });
    }
    let m = /^\/api\/trees\/([^/]+)\/state$/.exec(p);
    if (m !== null && method === "GET") {
      const state = treeStates.get(m[1]!);
      if (state === undefined) return respond(404, { error: { code: "not-found", message: `tree ${m[1]}` } });
      return respond(200, state);
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
      const state = treeStates.get(m[1]!);
      if (state === undefined) return respond(404, { error: { code: "not-found", message: `tree ${m[1]}` } });
      backend.switchCount += 1;
      return respond(200, { cursor: state.cursor, state });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology$/.exec(p);
    if (m !== null && method === "GET") {
      const annotations = m[1] === TREE_ONE ? [ANNOTATION_ONE] : [];
      return respond(200, {
        annotations,
        tasks: [],
        usage: { total: { requests: 0, promptChars: 0, completionChars: 0 }, estTokens: 0, lateResultsDiscarded: 0, budgetTokens: 1_000_000 },
        cacheEnabled: true,
      });
    }

    /* ---- 材料面（D4-2 已落地的分块读取路由；语料 = B1 冻结真值） ---- */
    m = /^\/api\/trees\/([^/]+)\/materials$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        materials: backend.materials
          .filter((entry) => entry.treeId === m![1])
          .map((entry) => ({ material: entry.material, versions: entry.versions })),
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(p);
    if (m !== null && method === "GET") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2] && candidate.treeId === m![1]);
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
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2] && candidate.treeId === m![1]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      const version = entry.versions.find((candidate) => candidate.id === m![3]);
      if (version === undefined) {
        return respond(404, { error: { code: "not-found", message: `version ${m![3]} not found` } });
      }
      if (version.parseStatus !== "ready") {
        return respond(409, {
          error: { code: "material-not-ready", message: `material version ${version.id} is not ready` },
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
          block: { blockId: block.blockId, kind: block.kind, start: block.start, end: block.end },
          text: block.text,
        })),
        nextAfterBlock: more && slice.length > 0 ? slice[slice.length - 1]!.blockId : null,
        textUnits: source === undefined ? version.textUnits : source.textUnits,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/reading-position$/.exec(p);
    if (m !== null && method === "PUT") {
      const entry = backend.materials.find((candidate) => candidate.material.id === m![2] && candidate.treeId === m![1]);
      if (entry === undefined) {
        return respond(404, { error: { code: "not-found", message: `material ${m![2]} not in tree` } });
      }
      const record = asRecord(body);
      assert.ok(record !== null, "PUT reading-position body must be an object");
      entry.readingPosition = {
        versionId: String(record.versionId ?? ""),
        blockId: typeof record.blockId === "string" ? record.blockId : null,
        focusStart: null,
        updatedAt: ISO,
      };
      return respond(204, null);
    }

    /* ---- 搜索面（D4-4 契约路由；命中 = 产品装配路径对脚本世界语料的
            确定性输出——buildSearchDocuments + LocalSearchEngine +
            toContractSearchHit，与 HTTP 端点同一代码路径，非手写副本） ---- */
    const treeSearchMatch = /^\/api\/trees\/([^/]+)\/search$/.exec(p);
    if (treeSearchMatch !== null || p === "/api/search") {
      if (backend.searchUnwired) {
        return respond(503, {
          error: { code: "search-not-wired", message: "the search service is not wired in this process" },
        });
      }
      if (method !== "POST") {
        return respond(405, { error: { code: "method-not-allowed", message: `${method} ${p}` } });
      }
      if (backend.searchFailOnce) {
        backend.searchFailOnce = false;
        return respond(500, { error: { code: "internal", message: "scripted search failure" } });
      }
      const record = asRecord(body);
      const text = record === null ? undefined : record.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        return respond(400, {
          error: { code: "invalid-argument", message: "request field 'text' must be a non-empty (not blank) string" },
        });
      }
      const rawKinds = record === null ? undefined : record.kinds;
      let kinds: SearchDocumentKind[] | undefined;
      if (rawKinds !== undefined) {
        if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
          return respond(400, {
            error: { code: "invalid-argument", message: "request field 'kinds' must be a non-empty array" },
          });
        }
        kinds = [];
        for (const entry of rawKinds) {
          if (typeof entry !== "string" || !SEARCH_DOCUMENT_KINDS.has(entry)) {
            return respond(400, {
              error: { code: "invalid-argument", message: `request field 'kinds' got ${String(entry)}` },
            });
          }
          if (!kinds.includes(entry as SearchDocumentKind)) kinds.push(entry as SearchDocumentKind);
        }
      }
      let scopeTreeIds: string[] | null;
      if (treeSearchMatch === null) {
        scopeTreeIds = backend.noTrees ? [] : [TREE_ONE, TREE_TWO];
      } else {
        scopeTreeIds = treeStates.has(treeSearchMatch[1]!) ? [treeSearchMatch[1]!] : null;
      }
      if (scopeTreeIds === null) {
        return respond(404, { error: { code: "not-found", message: `tree ${treeSearchMatch?.[1] ?? "?"}` } });
      }
      const snapshot = snapshotForTree(scopeTreeIds, backend.materials);
      const documents = buildSearchDocuments(snapshot);
      const hits = LocalSearchEngine.build(documents).search(text, kinds === undefined ? {} : { kinds });
      return respond(200, { hits: hits.map(toContractSearchHit) });
    }

    return respond(404, { error: { code: "not-found", message: `no route for ${method} ${p}` } });
  };

  const globals = globalThis as unknown as {
    document: StubDocument;
    window: typeof windowStub;
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
        writeText: async (): Promise<void> => {},
      },
    },
    configurable: true,
    writable: true,
  });

  appLoadCounter += 1;
  await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(APP_JS)}#load=${appLoadCounter}`);
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
    searchRequests: () =>
      backend.requests.filter((r) => {
        const path = r.path.split("?")[0]!;
        return path === "/api/search" || path.endsWith("/search");
      }),
    hitRows: () => documentStub.getElementById("search-results")!.querySelectorAll("button").filter((button) => button.classList.contains("search-hit")),
    runSearch: async (query) => {
      world.el("search-input").value = query;
      world.el("search-run").click();
      await settle(25);
    },
    releaseHold: () => {
      assert.ok(releaseHoldFn !== null, "releaseHold requires a holdSuffix world");
      releaseHoldFn();
    },
    treeButton: (treeId) => {
      const found = documentStub.getElementById("tree-list")!.querySelectorAll("button").find((b) => b.textContent!.startsWith(treeId));
      assert.ok(found !== undefined, `the sidebar lists ${treeId}`);
      return found;
    },
    turnElementById: (containerId, turnId) => {
      const container = documentStub.getElementById(containerId);
      assert.ok(container !== null, `#${containerId} missing`);
      const found = container.children.find(
        (child) => child instanceof StubElement && child.dataset.turnId === turnId,
      );
      assert.ok(found instanceof StubElement, `#${containerId} carries the turn ${turnId}`);
      return found;
    },
  };
  return world;
}

/* ------------------------------ 期望值推导（同一引擎，不手算） ------------------------------ */

/** 标准世界语料上跑产品检索路径，推导期望命中（顺序/字段全真值）。 */
function expectedHits(query: string, opts: { treeIds?: string[]; kinds?: string[] } = {}) {
  const treeIds = opts.treeIds ?? [TREE_ONE, TREE_TWO];
  const snapshot = snapshotForTree(treeIds, [makeVersionedMaterial()]);
  const documents = buildSearchDocuments(snapshot);
  return LocalSearchEngine.build(documents).search(
    query,
    opts.kinds === undefined ? {} : { kinds: opts.kinds as Array<"material" | "annotation" | "return" | "turn"> },
  );
}

/** 期望命中行徽标序（服务端返回序 = 引擎全序；客户端按此原样呈现）。 */
function expectedKindLabels(hits: ReadonlyArray<{ kind: string }>): string[] {
  const labels: Record<string, string> = { material: "材料", annotation: "批注", return: "Return", turn: "对话" };
  return hits.map((hit) => labels[hit.kind]!);
}

/* ------------------------------------------------------------------ */
/* 1. 范围：默认当前树 / 显式全部树 / 不泄漏 / 请求形状                    */
/* ------------------------------------------------------------------ */

test("scope: default is the current tree (scoped endpoint, full kinds), an explicit toggle spans all trees, and a scoped search never leaks another tree's facts", async () => {
  const world = await createWorld();

  /* 启动态：当前树开关激活、全部树未激活；idle 状态行声明索引口径
     （charter §5——未提交草稿永不入索引，UI 不暗示草稿可搜）。 */
  assert.ok(world.el("search-scope-tree").classList.contains("active"), "the default scope is the current tree");
  assert.equal(world.el("search-scope-tree").getAttribute("aria-pressed"), "true");
  assert.ok(!world.el("search-scope-all").classList.contains("active"));
  assert.match(
    world.el("search-status").textContent!,
    /unsubmitted drafts and explain caches are never indexed/,
    "the idle state discloses the indexing discipline honestly",
  );

  /* 树二独有语料：当前树（树一）范围内如实零命中——不泄漏他树事实。 */
  await world.runSearch("双指针去重模板");
  const scopedRequest = world.lastRequest("/search")!;
  assert.ok(scopedRequest.path.endsWith(`/api/trees/${TREE_ONE}/search`), "the default scope hits the tree-scoped endpoint");
  assert.deepEqual(scopedRequest.body, {
    text: "双指针去重模板",
    kinds: ["material", "annotation", "return", "turn"],
  });
  assert.match(world.el("search-status").textContent!, /0 hits for/);
  assert.match(world.el("search-status").textContent!, /in this tree/);
  assert.match(
    world.el("search-results").textContent!,
    /no results — nothing in the searched facts matches/,
    "the empty state is honest (no fabricated matches)",
  );

  /* 显式切全部树：/api/search；树二的命中可见并携带树名（跨树上下文）。 */
  world.el("search-scope-all").click();
  await settle(5);
  assert.ok(world.el("search-scope-all").classList.contains("active"));
  assert.ok(!world.el("search-scope-tree").classList.contains("active"));
  assert.equal(world.el("search-scope-all").getAttribute("aria-pressed"), "true");

  await world.runSearch("双指针去重模板");
  const allRequest = world.lastRequest("/search")!;
  assert.equal(allRequest.path.split("?")[0], "/api/search", "the all-trees scope hits the global endpoint");
  const expected = expectedHits("双指针去重模板");
  assert.equal(world.hitRows().length, expected.length);
  assert.ok(world.hitRows().length >= 1, "the tree-two fact is visible in the all-trees scope");
  const row = world.hitRows()[0]!;
  assert.match(row.querySelector(".search-hit-meta")!.textContent!, /tree-2/, "a cross-tree hit carries its tree name");
  assert.match(world.el("search-status").textContent!, /across all trees/);
  /* 命中行如实呈现引擎输出（期望 = 同一引擎对同一语料的确定性输出）。 */
  assert.equal(row.querySelector(".search-hit-title")!.textContent, expected[0]!.title);
  assert.equal(row.querySelector(".search-hit-excerpt")!.textContent, expected[0]!.excerpt);

  /* 切回当前树：开关态随之回到默认。 */
  world.el("search-scope-tree").click();
  await settle(5);
  assert.ok(world.el("search-scope-tree").classList.contains("active"));
  assert.ok(!world.el("search-scope-all").classList.contains("active"));
});

/* ------------------------------------------------------------------ */
/* 2. 类型筛选 + 确定性顺序                                              */
/* ------------------------------------------------------------------ */

test("type filter: kinds pass through to the engine, and results render in the order returned (annotation → Return → turn → material)", async () => {
  const world = await createWorld();

  /* 「递归」命中语料四类各至少一条：顺序 = 引擎全序（类型优先级：批注 <
     Return < 对话 < 材料），客户端不重排。 */
  const expected = expectedHits("递归", { treeIds: [TREE_ONE] });
  assert.ok(expected.length >= 5, "the scripted corpus yields hits of every kind for 递归");
  assert.deepEqual(
    expected.map((hit) => hit.kind),
    ["annotation", "return", "turn", "turn", "material"],
    "engine truth: annotation, return, two turns, material (fixture-verified)",
  );

  await world.runSearch("递归");
  const rows = world.hitRows();
  assert.deepEqual(
    rows.map((row) => row.querySelector(".search-hit-kind")!.textContent),
    expectedKindLabels(expected),
    "rows render in the exact order the server returned (deterministic, client never re-sorts)",
  );
  /* 行内容 = 契约字段：徽标、标题、摘录。 */
  assert.equal(rows[0]!.querySelector(".search-hit-title")!.textContent, `批注：${ANNO_TERM}`);
  assert.match(rows[1]!.querySelector(".search-hit-title")!.textContent!, /^Return：/);
  assert.match(rows[4]!.querySelector(".search-hit-excerpt")!.textContent!, /递归/);

  /* 关掉 材料 + 对话：kinds 透传（引擎过滤），行内只剩 批注 + Return。 */
  world.el("search-kind-material").click();
  await settle(5);
  world.el("search-kind-turn").click();
  await settle(5);
  assert.equal(world.el("search-kind-material").getAttribute("aria-pressed"), "false");
  assert.ok(!world.el("search-kind-material").classList.contains("active"));

  await world.runSearch("递归");
  const filteredRequest = world.lastRequest("/search")!;
  assert.deepEqual(filteredRequest.body, { text: "递归", kinds: ["annotation", "return"] });
  const filteredExpected = expectedHits("递归", { treeIds: [TREE_ONE], kinds: ["annotation", "return"] });
  assert.deepEqual(
    world.hitRows().map((row) => row.querySelector(".search-hit-kind")!.textContent),
    expectedKindLabels(filteredExpected),
    "the kinds filter is enforced by the engine (server-side truth), and the rows reflect exactly that",
  );
});

/* ------------------------------------------------------------------ */
/* 3. 旧版本命中：显式「旧版本」标注 + 打开旧版本只读面并定位命中块        */
/* ------------------------------------------------------------------ */

test("old-version hits are explicitly marked 旧版本 and open the older version's read-only reader at the hit block", async () => {
  const world = await createWorld();

  /* 「counter 的四种写法」只在 v1（md-05）——旧版本命中。 */
  const expected = expectedHits("counter 的四种写法", { treeIds: [TREE_ONE] });
  assert.equal(expected.length, 1);
  assert.equal(expected[0]!.kind, "material");
  assert.equal(expected[0]!.oldVersion, true);
  assert.equal(expected[0]!.versionLabel, "v1");

  await world.runSearch("counter 的四种写法");
  const row = world.hitRows()[0]!;
  const meta = row.querySelector(".search-hit-meta")!;
  assert.match(meta.textContent!, /v1/, "the version label is shown");
  const oldMark = row.querySelector(".search-old-version")!;
  assert.equal(oldMark.textContent, "旧版本", "an old-version hit is explicitly marked 旧版本");

  /* 期望命中块按冻结真值推导（不手算偏移）。 */
  const hitIndex = MD05.canonicalText.indexOf("counter 的四种写法");
  const hitBlock = MD05.blocks.find((block) => hitIndex >= block.start && hitIndex < block.end)!;
  assert.equal(expected[0]!.blockId, hitBlock.blockId, "engine truth: the hit reports its block");

  /* 点击 → 阅读器打开**命中版本**（v1 older 的 D4-2 诚实面原样复用），
     并滚动定位到命中块。 */
  row.click();
  await settle(25);
  const reader = world.el("material-reader");
  assert.equal(reader.hidden, false, "the material reader opens");
  assert.match(reader.querySelector(".mat-meta")!.textContent!, /v1 \(older — v2 is current\)/);
  assert.match(reader.textContent!, /you are reading v1 \(older\)/, "the D4-2 never-migrates honesty note is reused");
  assert.match(
    reader.textContent!,
    new RegExp(`arrived from Search — the hit is located at block ${hitBlock.blockId}`),
    "the search jump note names the located block",
  );
  const blocks = world.byId("mat-blocks")!;
  const target = blocks.querySelectorAll(".material-block").find((b) => b.dataset.blockId === hitBlock.blockId)!;
  assert.equal(
    (target.lastScrollIntoView as { block?: string } | null)?.block,
    "start",
    "the hit block is scrolled into view",
  );
  assert.equal(
    target.textContent,
    MD05.blocks.find((block) => block.blockId === hitBlock.blockId)!.text,
    "the older version renders its own (md-05) content",
  );

  /* 阅读不触碰对话游标（charter §3.2：阅读与探索互不干扰——无 POST /switch）。 */
  assert.equal(world.requestsOf("/switch").length, 0, "a material hit jump never aligns the conversation cursor");
});

/* ------------------------------------------------------------------ */
/* 4. 材料命中（当前版本）：阅读器按版本+块定位                            */
/* ------------------------------------------------------------------ */

test("a current-version material hit opens the reader on that version and scrolls to the hit block", async () => {
  const world = await createWorld();

  /* 「基线条件」只在 v2（md-01）——当前版本命中。 */
  const expected = expectedHits("基线条件", { treeIds: [TREE_ONE] });
  assert.equal(expected.length, 1);
  assert.equal(expected[0]!.oldVersion, false);

  await world.runSearch("基线条件");
  const row = world.hitRows()[0]!;
  assert.equal(row.querySelector(".search-old-version"), null, "the current version is not marked older");
  assert.match(row.querySelector(".search-hit-meta")!.textContent!, /v2/);

  const hitIndex = MD01.canonicalText.indexOf("基线条件");
  const hitBlock = MD01.blocks.find((block) => hitIndex >= block.start && hitIndex < block.end)!;

  row.click();
  await settle(25);
  const reader = world.el("material-reader");
  assert.equal(reader.hidden, false);
  assert.match(reader.querySelector(".mat-meta")!.textContent!, /v2 \(current\)/);
  assert.match(reader.textContent!, new RegExp(`arrived from Search — the hit is located at block ${hitBlock.blockId}`));
  const target = world.byId("mat-blocks")!.querySelectorAll(".material-block").find((b) => b.dataset.blockId === hitBlock.blockId)!;
  assert.equal((target.lastScrollIntoView as { block?: string } | null)?.block, "start");
  assert.equal(world.requestsOf("/switch").length, 0, "reading from search never aligns the conversation cursor");
});

/* ------------------------------------------------------------------ */
/* 5. session 不可用：并排「⑃ 新探索」入口；来源跳转永不受阻              */
/* ------------------------------------------------------------------ */

test("session-unavailable hits show the explicit new-exploration entry alongside the source jump, and the jump still views the source", async () => {
  const world = await createWorld();

  await world.runSearch("旧探索会话已丢失");
  const expected = expectedHits("旧探索会话已丢失", { treeIds: [TREE_ONE] });
  assert.equal(expected.length, 1);
  assert.equal(expected[0]!.kind, "turn");

  const row = world.hitRows()[0]!;
  /* 行内 session 注记 + 显式「⑃ 新探索」入口（charter §5）。 */
  const session = row.parentElement!.querySelector(".search-hit-session");
  assert.ok(session !== null, "the row carries the session-unavailable note");
  assert.match(session.textContent!, /session unavailable/);
  const explore = session.querySelector(".search-hit-explore")!;
  assert.equal(explore.textContent, "⑃ 新探索");

  /* 来源跳转（charter §3.2：来源定位与 Pi 续聊分别判断——不因 session
     缺失受阻）：支线面板打开（既有 switch 语义）、已保存正文可读。 */
  row.click();
  await settle(25);
  assert.equal(world.el("branch-panel").hidden, false, "the branch panel opens for the hit's branch");
  const switchRequest = world.lastRequest("/switch")!;
  assert.deepEqual(switchRequest.body, { branchId: T1_BRANCH_UNAVAILABLE });
  const turnEl = world.turnElementById("panel-conversation", "a3");
  assert.ok(
    turnEl.textContent!.startsWith(A3_TEXT),
    "the saved text stays fully readable (source viewing is never blocked)",
  );
  assert.equal(
    (turnEl.lastScrollIntoView as { block?: string } | null)?.block,
    "center",
    "the hit turn is revealed (scroll + focus, W2 §2.6 discipline)",
  );
  /* 「⑃ 新探索」：打开该支线并聚焦输入框——面板 composer 的既有 v3 §4.4
     换轨面（发送 fail-closed 禁用、换轨入口可见、占位引导首问）。 */
  explore.click();
  await settle(25);
  assert.equal(world.el("branch-panel").hidden, false);
  assert.ok(
    world.document.activeElement === world.el("panel-prompt-input"),
    "the composer takes focus for the first question",
  );
  assert.equal(world.el("panel-send").disabled, true, "continuing the dead session stays fail-closed");
  assert.equal(world.el("panel-new-exploration").hidden, false, "the explicit new-exploration entry is visible");
  assert.match(
    world.el("panel-prompt-input").placeholder,
    /type the first question of a new exploration/,
  );
});

/* ------------------------------------------------------------------ */
/* 6. 批注命中 → 锚定答案 + 已保存批注卡                                  */
/* ------------------------------------------------------------------ */

test("an annotation hit reveals the anchored answer and opens the saved annotation card", async () => {
  const world = await createWorld();

  const expected = expectedHits("跨材料找回时按批注正文检索", { treeIds: [TREE_ONE] });
  assert.equal(expected.length, 1);
  assert.equal(expected[0]!.kind, "annotation");

  await world.runSearch("跨材料找回时按批注正文检索");
  const row = world.hitRows()[0]!;
  assert.equal(row.querySelector(".search-hit-kind")!.textContent, "批注");
  assert.equal(row.querySelector(".search-hit-title")!.textContent, `批注：${ANNO_TERM}`);
  assert.match(row.querySelector(".search-hit-excerpt")!.textContent!, /跨材料找回时按批注正文检索/);

  /* 批注锚定在主干答案上：点击 → 主线内定位该答案 + 打开已保存批注卡
     （既有视图），无支线面板、无 switch。 */
  row.click();
  await settle(25);
  const anchored = world.turnElementById("conversation", "a1");
  assert.equal(
    (anchored.lastScrollIntoView as { block?: string } | null)?.block,
    "center",
    "the anchored answer is revealed in the trunk conversation",
  );
  const card = world.byId("term-explain-card")!;
  assert.ok(card !== null, "the saved annotation card opens (the existing view for an annotation fact)");
  assert.match(card.textContent!, new RegExp(ANNO_TERM));
  assert.match(card.textContent!, /跨材料找回时按批注正文检索/);
  assert.equal(world.el("branch-panel").hidden, true, "a trunk-anchored annotation opens no branch panel");
  assert.equal(world.requestsOf("/switch").length, 0);
});

/* ------------------------------------------------------------------ */
/* 7. Return 命中 → 主线 Return 卡定位                                    */
/* ------------------------------------------------------------------ */

test("a Return hit reveals the Return card on the trunk", async () => {
  const world = await createWorld();

  /* 「写屏障的结论」是 RETURN_TEXT 的连续子串（语料里唯一出现处）。 */
  assert.ok(RETURN_TEXT.includes("写屏障的结论"));
  const expected = expectedHits("写屏障的结论", { treeIds: [TREE_ONE] });
  assert.equal(expected.length, 1);
  assert.equal(expected[0]!.kind, "return");

  await world.runSearch("写屏障的结论");
  const row = world.hitRows()[0]!;
  assert.equal(row.querySelector(".search-hit-kind")!.textContent, "Return");
  assert.equal(row.querySelector(".search-hit-title")!.textContent, `Return：${headOf(RETURN_TEXT)}`);

  row.click();
  await settle(25);
  /* Return 卡渲染在主干（既有视图）；定位 = 滚动 + 焦点。 */
  const card = world.turnElementById("conversation", "r1");
  assert.match(card.textContent!, /Return from Branch 1/);
  assert.match(card.textContent!, /saved — pending adoption/);
  assert.equal(
    (card.lastScrollIntoView as { block?: string } | null)?.block,
    "center",
    "the Return card is scrolled into view",
  );
  assert.equal(world.requestsOf("/switch").length, 0, "a trunk Return card needs no cursor alignment");
});

/* ------------------------------------------------------------------ */
/* 8. 诚实状态面：空查询/空筛选/零命中/索引口径声明                        */
/* ------------------------------------------------------------------ */

test("honest gates: blank queries and empty filters are stopped client-side (the server's own rule), and zero hits stay an honest empty state", async () => {
  const world = await createWorld();

  /* 空查询：不发注定失败的请求（服务端对同一输入 400——客户端按同一规则
     拦下并说明，不伪装成已搜索）。 */
  await world.runSearch("");
  assert.equal(world.searchRequests().length, 0, "a blank query fires no search request");
  assert.match(world.el("search-status").textContent!, /type something to search/);

  /* 全部类型关闭：同样拦下。 */
  for (const kind of ["material", "annotation", "return", "turn"]) {
    world.el(`search-kind-${kind}`).click();
    await settle(3);
  }
  world.el("search-input").value = "递归";
  world.el("search-run").click();
  await settle(10);
  assert.equal(world.searchRequests().length, 0, "an empty type filter fires no search request");
  assert.match(world.el("search-status").textContent!, /select at least one source type/);

  /* 恢复一个类型后真查询：语料中不存在 → 如实零命中（不编造）。 */
  world.el("search-kind-material").click();
  await settle(3);
  await world.runSearch("马卡龙烘焙温度");
  assert.equal(world.searchRequests().length, 1);
  const request = world.searchRequests()[0]!;
  assert.deepEqual(request.body, { text: "马卡龙烘焙温度", kinds: ["material"] });
  assert.match(world.el("search-status").textContent!, /0 hits for/);
  assert.match(world.el("search-status").textContent!, /nothing in the saved facts matches; no results are fabricated/);
  assert.match(world.el("search-results").textContent!, /no results — nothing in the searched facts matches/);
  assert.equal(world.hitRows().length, 0);
});

/* ------------------------------------------------------------------ */
/* 9. 在途/失败状态 + 503 未装配                                          */
/* ------------------------------------------------------------------ */

test("in-flight is honest, a failed search surfaces its error and is retryable, and unwired search reports 503 verbatim", async () => {
  /* 在途：闸门挂起时呈 searching…（不伪装成空结果）。 */
  const heldWorld = await createWorld({ holdSuffix: "/search" });
  heldWorld.el("search-input").value = "递归";
  heldWorld.el("search-run").click();
  await settle(10);
  assert.match(heldWorld.el("search-status").textContent!, /searching this tree…/);
  assert.match(heldWorld.el("search-results").textContent!, /searching…/);
  heldWorld.releaseHold();
  await settle(25);
  assert.ok(heldWorld.hitRows().length >= 1, "results land after the response arrives");

  /* 失败 + 重试（常驻 Search 按钮）。 */
  const failWorld = await createWorld({ searchFailOnce: true });
  await failWorld.runSearch("递归");
  assert.match(
    failWorld.el("search-status").textContent!,
    /search failed — internal: scripted search failure \(press Search to retry\)/,
  );
  assert.equal(failWorld.hitRows().length, 0);
  await failWorld.runSearch("递归");
  assert.ok(failWorld.hitRows().length >= 1, "retrying after the failure loads the real results");

  /* 未装配（search 服务不注入）：503 如实呈现（绝不伪装成功）。 */
  const unwiredWorld = await createWorld({ searchUnwired: true });
  await unwiredWorld.runSearch("递归");
  assert.match(unwiredWorld.el("search-status").textContent!, /search-not-wired/);
  assert.match(unwiredWorld.el("search-status").textContent!, /press Search to retry/);
});

/* ------------------------------------------------------------------ */
/* 10. 跨树命中（全部树范围）+ 纯只读 + 树切换后的范围诚实                 */
/* ------------------------------------------------------------------ */

test("cross-tree hits open the hit's tree first; searching creates no turns; tree-scoped results clear honestly on tree switch while all-trees results persist", async () => {
  const world = await createWorld();

  /* 全部树范围 → 树二的命中；点击先开树二（既有 openTree 语义）再定位。 */
  world.el("search-scope-all").click();
  await settle(5);
  await world.runSearch("双指针去重模板");
  assert.ok(world.hitRows().length >= 1);
  world.hitRows()[0]!.click();
  await settle(25);
  assert.ok(
    world.requestsOf(`/api/trees/${TREE_TWO}/state`).length >= 1,
    "the cross-tree jump opens the hit's tree (full openTree semantics)",
  );
  const revealed = world.turnElementById("conversation", "a2t2");
  assert.equal(
    (revealed.lastScrollIntoView as { block?: string } | null)?.block,
    "center",
    "after the tree opens, the hit turn is revealed in that tree's trunk",
  );
  assert.ok(world.hitRows().length >= 1, "all-trees results persist across the tree switch (library-level facts)");

  /* 当前树（=树二）范围搜索：命中留在树二；切回树一后旧结果诚实清空
     （「当前树」结果不再描述当前工作台）。 */
  world.el("search-scope-tree").click();
  await settle(5);
  await world.runSearch("双指针去重模板");
  assert.ok(world.hitRows().length >= 1);
  assert.match(world.el("search-status").textContent!, /in this tree/);

  world.treeButton(TREE_ONE).click();
  await settle(25);
  assert.match(
    world.el("search-status").textContent!,
    /search saved facts — 材料 \/ 批注 \/ Return \/ 对话/,
    "tree-scoped results clear on tree switch (back to the idle disclosure)",
  );
  assert.equal(world.hitRows().length, 0);
  assert.equal(world.searchRequests().length, 2, "exactly the two searches above were executed");

  /* 搜索 + 跳转纯只读（charter §3.3「浏览/搜索不创建 Turn」）：无 prompt、
     无建树、无建支线、无换轨。 */
  const mutating = world.backend.requests.filter(
    (request) =>
      request.method === "POST" &&
      (request.path.endsWith("/prompt") ||
        request.path === "/api/trees" ||
        request.path.endsWith("/branches") ||
        request.path.endsWith("/new-exploration")),
  );
  assert.deepEqual(mutating, [], "searching and jumping never create product facts");
});

/* ------------------------------------------------------------------ */
/* 11. 空库启动：检索面不消失（范围回落全部树），零命中如实               */
/* ------------------------------------------------------------------ */

test("with an empty library the search face stays available, this-tree is honestly disabled, and the honest zero-hit state renders", async () => {
  const world = await createWorld({ noTrees: true });

  assert.equal(world.el("empty-state").hidden, false, "the workbench boots to the empty state");
  /* 检索面不因无树而消失：范围开关如实——「当前树」禁用（title 说明），
     全部树为生效范围。 */
  assert.equal(world.el("search-scope-tree").disabled, true, "this-tree is disabled without an open tree");
  assert.ok(world.el("search-scope-all").classList.contains("active"), "the effective scope falls back to all trees");
  assert.equal(world.el("search-scope-all").getAttribute("aria-pressed"), "true");
  assert.match(world.el("search-scope-tree").title, /no tree is open/);

  /* 范围回落全部树：请求走 /api/search（不悬空、不伪装当前树）。空库的
     语料为空——零命中如实（不编造）。 */
  await world.runSearch("递归");
  const request = world.lastRequest("/search")!;
  assert.equal(request.path.split("?")[0], "/api/search");
  assert.match(world.el("search-status").textContent!, /0 hits for/);
  assert.match(world.el("search-status").textContent!, /across all trees/);
  assert.equal(world.hitRows().length, 0);
  assert.match(world.el("search-results").textContent!, /no results — nothing in the searched facts matches/);
});

/* ------------------------------------------------------------------ */
/* 12. CSS 词法锁定（基础层）                                            */
/* ------------------------------------------------------------------ */

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

test("CSS lexicon: the search form, hit rows, old-version mark, and session note rules are locked in the base layer", () => {
  const base = baseCssLayer(STYLE_CSS);
  assert.ok(
    /#search-input\s*\{[^{}]*border-radius:\s*var\(--radius\)/.test(base),
    "the search input uses the shared radius input skin",
  );
  assert.ok(
    /#search-results\s+button\.search-hit\s*\{[^{}]*width:\s*100%/.test(base),
    "hit rows are full-width left-aligned buttons (material-list form)",
  );
  assert.ok(
    /\.search-hit-kind\.k-material\s*\{[^{}]*background:\s*var\(--green-wash\)/.test(base) &&
      /\.search-hit-kind\.k-return\s*\{[^{}]*background:\s*var\(--gold\)/.test(base),
    "kind badges carry per-kind color coding (material=green wash, Return=gold)",
  );
  assert.ok(
    /\.search-hit-meta\s+\.search-old-version\s*\{[^{}]*color:\s*var\(--gold-deep\)/.test(base),
    "the 旧版本 mark is visually distinct (gold-deep)",
  );
  assert.ok(
    /\.search-hit-session\s*\{[^{}]*border:\s*1px\s+solid\s+var\(--gold-line\)/.test(base),
    "the session-unavailable note is a bordered gold note",
  );
  assert.ok(
    /\.search-hit-explore\s*\{[^{}]*background:\s*var\(--gold\)/.test(base),
    "the new-exploration entry is a gold action button (the Return-family action color)",
  );
  assert.ok(
    /\.search-hit-excerpt\s*\{[^{}]*white-space:\s*pre-wrap/.test(base),
    "excerpts render verbatim whitespace (no silent truncation of newlines)",
  );
});
