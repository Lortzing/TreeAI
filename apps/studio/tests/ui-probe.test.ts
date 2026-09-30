/**
 * Studio 前端脚本化 DOM E2E 套件（issue #4 P1「证据工程化」+ issue #5 P1 补全）。
 *
 * 方法：以 data: URL 加载仓库真实 public/app.js 为 ES module（URL fragment
 * 随机化绕过 ES 模块缓存——fragment 不进入模块源码，每个场景得到一份全新
 * 实例），运行在「按真实 public/index.html 词法解析出的完整 DOM 桩 + 脚本
 * 化 echo 后端」之上：fetch / EventSource / localStorage / 计时器 / matchMedia
 * / getSelection 全部为内存桩，后端按场景脚本化（journal 可脚本为 500 / 空 /
 * 有事件；/return 可脚本为成功 / 失败 / 响应丢失；/prompt 按echo-port 语义
 * 追加确定性回答回合；/branches/:id/source 可脚本化锚点状态；matchMedia 可
 * 脚本化 prefers-reduced-motion 命中；getSelection 可脚本化为文本节点上的
 * 选区或无选区）。public/style.css 以 @media 块词法解析（窄窗与
 * reduced-motion 规则的存在与形状断言——套件不执行 CSS）。无网络、无磁盘
 * 写入、无长等待（仅面板/抽屉退场动画所需的短 sleep），确定性可复现。
 *
 * 覆盖（issue #3 P1 修复的回归面 + issue #4 的视觉基线要求 + issue #5 P1
 * 的补全面）：
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
 *  7. A1 双支线交叉切换（issue #5）：两支线自 Trunk 不同锚点分出、各两轮
 *     续聊，面板交替切换——支线谱系/上下文互不渗透（echo 答案只含本支线
 *     user 文本）、面板内容与阅读位置按分支隔离、主线阅读全程不动。
 *  8. A2 选区→锚点流（issue #5）：mouseUp 武装选区入口（含跨 turn 守卫与
 *     无选区整条回退）、绝对偏移精确提交（W1 §1.1）、局部面板锚点卡
 *     （摘录 + originStatus）、View source 揭示（高亮 + 焦点 + 滚动定位）
 *     与降级如实（不伪造高亮）。
 *  9. 窄窗 <720px（issue #5 / W2 §5）：style.css 媒查规则词法断言（侧栏
 *     抽屉化 + 开关、状态条压缩、消息全宽、面板/抽屉全宽）+ 侧栏抽屉 JS
 *     行为（开关 + aria-expanded、选树自动收起、Esc 分层关闭）。
 * 10. prefers-reduced-motion（issue #5 / W2 §3）：CSS 全局即时化块的词法
 *     断言 + JS 滚动定位（流式跟随 / 锚点揭示）在 reduce 下直接 auto。
 * 11. reduced-motion 贴底 stick 渲染：已记忆阅读位置的贴底重渲在 reduce 下
 *     即时定位（smooth 对照世界先行，证明断言点经过 matchMedia 分支）。
 * 12. 贴底阈值边界：距底 47px（阈值 48px 内）跟随、49px 不动。
 * 13. 键盘提交：Cmd/Ctrl+Enter（主线 / 面板双 composer）提交；普通 Enter
 *     留给换行，不提交。
 * 14. §2.1 列表加载失败重试（issue #6 P1）：侧栏常驻重试面（错误 + Retry）
 *     + 在途禁用态 + 持久失败保持可用 + 恢复后补齐启动语义（无树打开时
 *     自动打开首棵树，不整页刷新）。
 * 15. §2.1 初始焦点（issue #6 P1）：启动后焦点在“新建”按钮；SSE 终态
 *     重渲不夺焦点（boot-only 语义）。
 * 16. §2.4/§2.5 结构面（issue #6 P1）：错误横幅 role="alert" + tabindex
 *     （可 Tab 触达并朗读）与揭示降级说明区（面板锚点上下文 tabindex=-1）
 *     的属性断言；降级揭示焦点移到说明区的行为断言（§2.6）。
 * 17. A2 选区锚点三场景（issue #6 P1 / W2 §4）：数千字符多段长答案的
 *     后段选区、重复词的**第二处**、跨换行选区——精确 {start,end,text}
 *     提交与揭示切片落位（非整条回退、非首处字符串匹配顶替）。
 * 18. §2.7 抽屉关闭按钮（issue #6 附-4 / option B 方向）：覆盖层打开时
 *     头部渲染可见关闭按钮（#drawer-close 真按钮、「× Close」文案、抽屉
 *     内首个可交互元素），点击复用 closeDrawer()（隐藏 + 开关
 *     aria-expanded/文案就地对齐 + 焦点还原）；Esc 关闭路径不回归。
 * 19. 顶栏位置路径（改版后新增，renderTopbarPath）：诚实状态机——无树
 *     → 空字符串（绝不渲染硬编码面包屑占位），树打开 → `<treeId> / Trunk`，
 *     支线面板打开 → 追加支线标签，收起面板 → 回到 `<treeId> / Trunk`。
 * 20. 空态 New Tree 按钮（改版后新增）：空态主操作直达——#empty-new-tree
 *     与侧栏「新建」同一动作（guard(createTree)）：POST /api/trees 可观测、
 *     树打开（空态隐藏 / 树面可见 / 分支 tab 渲染）、顶栏路径随之渲染。
 * 21. 来源抽屉入口的诚实隐藏（改版后新增）：无树 → #source-drawer-toggle
 *     hidden（无源可溯，优于必然为空的空态）；树打开 → renderAll 恢复可见。
 * 22. 改版 CSS 词法锁定：≥1180px 并置支线概念列（源设计 §二：列常驻
 *     width:min(440px,34vw)、#branch-panel width:100% 恰好覆盖、
 *     :has(#branch-panel:not([hidden])) 遮蔽列空态）+ 基础层布局链
 *     （#branch-column display:contents / #workspace min-height:0 有界
 *     高度 / #branch-bar 58px）+ 恢复规则在场（#list-load-error /
 *     .session-recovery-button / #drawer-close / .turn.return.insert +
 *     @keyframes return-insert / .turn .meta .delivery 徽标 + badge-change /
 *     :root 动效变量）+ 移除项锁定缺席（假面包屑 #topbar-path::before、
 *     #branch-panel/#source-drawer 的 .open 可见性门控、闪烁 caret）。
 *
 * 边界（如实声明）：本套件不是真实浏览器 E2E——像素级视觉基线、布局合成、
 * 真实滚动物理、键盘/读屏器实机行为不在覆盖范围；CSS 不执行，媒体查询按
 * 词法锁定规则存在与形状（实机窄窗 / reduced-motion 行为归 evidence/d3/
 * real-pi/ 与 trials/ 口径，evidence/d3/README.md）；引入 Playwright /
 * Puppeteer 属 owner 依赖决策（本仓库零新依赖约束下不可行）。另见下方
 * globals 注入处：全局桩是与无类型前端脚本的唯一动态接面。
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

/** 服务端 hashSourceText 同口径（src/terminology.ts）——保存桩按锚点
 *  turn 的当前文本即时计算 sourceHash（P0 联合校验下的真实桩）。 */
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------ 测试数据模型（对齐 app.js 头部 JSDoc） ------------------------------ */

const TREE = "tree-1";
const ISO = "2026-09-29T00:00:00.000Z";
const A1_TEXT = "First trunk answer.";
const A2_TEXT = "Second trunk answer — the latest one.";
const BA1_TEXT = "Branch one answer.";
/* A1（issue #5 P1）两支线场景的续聊文本：echo 答案 = 该支线上全部 user
 * 文本的确定性回声（对齐 src/echo-port.ts 的 echoAnswer），谱系隔离可断言。 */
const B1_R1_TEXT = "Branch one, round one.";
const B2_R1_TEXT = "Branch two, round one.";
const B1_R2_TEXT = "Branch one, round two.";
const B2_R2_TEXT = "Branch two, round two.";

/* A2 选区锚点三场景（issue #6 P1 / W2 §4）的 trunk 答案文本：
 * - LONG_A2：数千字符多段长答案（换行分段），选区落在后段；
 * - DUP_A2：“alpha” 恰好出现两次，选**第二处**（绝不允许首处顶替）；
 * - CROSS_A2：三行文本，选区横跨一个换行符。 */
const LONG_A2_PARAGRAPH =
  "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const LONG_A2 = [
  "A long trunk answer follows, composed of many paragraphs separated by newlines.",
  ...Array.from({ length: 36 }, (_, i) => `Paragraph ${i + 1}: ${LONG_A2_PARAGRAPH.repeat(3)}`),
  "The closing paragraph carries the late anchor target phrase.",
].join("\n");
const DUP_A2 = "alpha opens the list, beta follows, alpha closes the list.";
const CROSS_A2 = "first line\nsecond line\nthird line";

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

/** 树状态内按 turn id 反查正文（保存桩计算锚点全文指纹用）。 */
function findTurnText(state: TreeState, turnId: string): string {
  for (const view of state.branches) {
    const found = view.turns.find((t) => t.id === turnId);
    if (found !== undefined) return found.text;
  }
  return "";
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

function freshBackendState(
  initialTrunkReturn: boolean,
  a2Text: string = A2_TEXT,
  trunkReturnAttempts: ReturnAttempt[] = [],
): TreeState {
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const b1Branch: Branch = { id: "branch-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
  const trunkTurns: Turn[] = [
    makeTurn("u1", "trunk-1", "user", "First trunk question."),
    makeTurn("a1", "trunk-1", "assistant", "First trunk answer."),
    makeTurn("u2", "trunk-1", "user", "Second trunk question."),
    makeTurn("a2", "trunk-1", "assistant", a2Text),
  ];
  if (initialTrunkReturn) {
    /* 预置一张已保存（待采用）的锚点 Return 卡：渲染定位断言用。 */
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
      makeBranchView(trunkBranch, null, "available", trunkTurns, trunkReturnAttempts),
      makeBranchView(b1Branch, b1Origin, "available", [
        makeTurn("bu1", "branch-1", "user", "Branch one question."),
        makeTurn("ba1", "branch-1", "assistant", BA1_TEXT),
      ]),
    ],
    cursor: { treeId: TREE, branchId: "trunk-1", entryId: "pi-a2" },
  };
}

/**
 * A1（issue #5 P1）双支线初始态：两条支线自 Trunk 不同锚点分出（branch-1
 * 锚定 a1 的 “First”、branch-2 锚定 a2 的 “Second”），各预置一轮续聊
 * （echo 语义：答案 = 本支线 user 文本的回声）；第二轮由测试经面板
 * composer 实际驱动（POST /prompt，后端按 echo 语义追加回合）。
 */
function freshTwoBranchBackendState(): TreeState {
  const trunkBranch: Branch = { id: "trunk-1", treeId: TREE, parentBranchId: null, createdAt: ISO };
  const b1Branch: Branch = { id: "branch-1", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
  const b2Branch: Branch = { id: "branch-2", treeId: TREE, parentBranchId: "trunk-1", createdAt: ISO };
  const b1Origin: Origin = {
    branchId: "branch-1",
    sourceBranchId: "trunk-1",
    anchorTurnId: "a1",
    anchorEntryId: "pi-a1",
    selection: { start: 0, end: 5, text: "First" },
    createdAt: ISO,
  };
  const b2Origin: Origin = {
    branchId: "branch-2",
    sourceBranchId: "trunk-1",
    anchorTurnId: "a2",
    anchorEntryId: "pi-a2",
    selection: { start: 0, end: 6, text: "Second" },
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
        makeTurn("b1u1", "branch-1", "user", B1_R1_TEXT),
        makeTurn("b1a1", "branch-1", "assistant", `echo:[${B1_R1_TEXT}]`),
      ]),
      makeBranchView(b2Branch, b2Origin, "available", [
        makeTurn("b2u1", "branch-2", "user", B2_R1_TEXT),
        makeTurn("b2a1", "branch-2", "assistant", `echo:[${B2_R1_TEXT}]`),
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
  /** GET /api/trees 的脚本化失败（列表加载失败重试场景；运行中可翻回 ok）。 */
  treesMode: "ok" | "fail";
  treeState: TreeState;
  diagnostics: TreeDiagnostics;
  journalMode: "fail" | "ok-events" | "ok-empty";
  journalEvents: JournalEvent[];
  requests: RecordedRequest[];
  switchCount: number;
  returnMode: "ok" | "lose-response" | "fail";
  /** /return 保存后的回程导航结果脚本（signed v3 §3.5：保存与导航分离）。 */
  returnNavigation: "ok" | "fail";
  returnDelay: boolean;
  branchCounter: number;
  /** 锚点揭示（POST /branches/:id/source）的状态脚本（revealBranchOrigin 契约）。 */
  sourceMode: "available" | "changed" | "unavailable";
  /** POST /prompt 追加的 echo 回合计数（turn id 分配用）。 */
  promptCounter: number;
  /** 已保存术语批注（/terminology/* 路由的服务端状态）。 */
  termAnnotations: StubTermAnnotation[];
}

/** 术语批注的服务端桩形状（fetch 桩内部使用）。 */
interface StubTermAnnotation {
  id: string;
  treeId: string;
  branchId: string;
  anchorTurnId: string;
  selection: { start: number; end: number; text: string };
  sourceHash: string;
  term: string;
  explanation: string;
  mode: string;
  promotedBranchId: string | null;
  promotionKey: string | null;
  createdAt: string;
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

/** 揭示定位断言辅助（A2 场景）：揭示后的锚点 turn 渲染为
 *  [前缀文本, mark 高亮, 后缀文本, …]——前后缀与高亮必须恰为 turn 文本按
 *  绝对偏移的三段切片（偏移定位的 UI 级证明，非字符串搜索近似）。 */
function assertRevealSlices(turn: StubElement, text: string, start: number, end: number): void {
  const mark = turn.querySelector(".source-highlight");
  assert.ok(mark !== null, "the revealed turn carries the highlight mark");
  assert.equal(mark.textContent, text.slice(start, end), "the highlight is exactly the anchored selection text");
  const prefix = turn.children[0];
  assert.ok(prefix instanceof StubText, "the node before the mark is the prefix text node");
  assert.equal(prefix.data, text.slice(0, start), "the prefix ends exactly at the anchor start offset");
  const suffix = turn.children[2];
  assert.ok(suffix instanceof StubText, "the node after the mark is the suffix text node");
  assert.equal(suffix.data, text.slice(end), "the suffix resumes exactly at the anchor end offset");
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
    if (value !== "") {
      const text = new StubText(value);
      text.parentElement = this; /* 与真实 DOM 一致：textContent 的文本节点是子节点 */
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

/**
 * 单文本节点上的选区 mini-model：app.js 的 selectionOffsetsWithin 所需的
 * 全部 Range 形状——toString = 选中文本；cloneRange 后 selectNodeContents
 * (element) + setEnd(startContainer, startOffset) 的组合给出「元素起点 →
 * 选区起点」的文本长度（即绝对偏移 start）。场景内 turn 的首子节点即其
 * 全文文本节点，故该 model 与真实 DOM 语义一致（容器只支持该文本节点）。
 */
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
    void element; /* 覆盖元素全部内容 = 整个文本节点（场景内即真实用法） */
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

/**
 * style.css 的 @media 块词法抽取（窄窗 / reduced-motion 规则断言用）：
 * 注释剥除后按大括号配平扫描出每个 @media 的 query 与块内平铺规则
 * （选择器 → 声明串，空白归一）。与 index.html 同纪律：读仓库真实文件，
 * 绝不硬编码副本；套件不执行 CSS——断言的是规则的存在与形状。
 */
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

/** 块内声明断言辅助：命中选择器则返回归一化声明串，否则 null。 */
function declarationsOf(block: CssMediaBlock, selector: string): string | null {
  const rule = block.rules.find((r) => r.selector === selector);
  return rule === undefined ? null : rule.declarations;
}

/** 去除注释与全部 @media 块后的基础层（基础规则的词法断言用——媒体块内
 *  的同名规则变体不与基态契约混淆，如 reduced-motion 块内的
 *  `.streaming-caret { animation: none }` 是降级、不是基态动画）。 */
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
  getSelection(): { rangeCount: number; getRangeAt(index: number): StubTextRange };
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
  /** 脚本化选区（null = 清除；mouseUp 与建支点击读取同一选区）。 */
  setSelection(range: StubTextRange | null): void;
  /** 指定容器内按 turnId 取 .turn 元素（断言存在）。 */
  turnElement(containerId: string, turnId: string): StubElement;
  /** window.confirm 脚本化返回值（v3 §4.4 新探索二次确认；默认 true）。 */
  setConfirmResult(value: boolean): void;
  /** window.confirm 收到的消息序列（断言确认文案如实告知换轨后果）。 */
  readonly confirmCalls: readonly string[];
}

interface WorldOptions {
  journalMode?: Backend["journalMode"];
  returnMode?: Backend["returnMode"];
  /** /return 响应的 navigation 字段脚本（保存后导航失败场景）。 */
  returnNavigation?: Backend["returnNavigation"];
  /** GET /api/trees 脚本化失败（§2.1 列表加载失败重试场景）。 */
  treesMode?: Backend["treesMode"];
  /** 空 Forest 启动（改版后空态 / 顶栏诚实路径场景）：GET /api/trees 返回
   *  空列表——引导不自动打开树，主区呈空态。 */
  noTrees?: boolean;
  /** 覆盖 trunk 第二条答案（a2）的文本（A2 长答案 / 重复词 / 跨行场景）。 */
  a2Text?: string;
  /** 预置一张锚定于 a1 的已保存 Return 卡（渲染定位断言用）。 */
  initialTrunkReturn?: boolean;
  /** 预置 Return 卡（r0）上的采用尝试记录（attempted 徽标场景）。 */
  trunkReturnAttempts?: ReturnAttempt[];
  /** A1 双支线初始态（Trunk + branch-1/branch-2，各锚定不同 trunk 答案）。 */
  twoBranches?: boolean;
  /** prefers-reduced-motion: reduce 命中（app.js 的 scrollBehavior → auto）。 */
  reducedMotion?: boolean;
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
  /* 脚本化选区（null = 无选区 → app.js 的 selectionOffsetsWithin 回退整条
     答案语义；StubTextRange = 文本节点上的选区 → 绝对偏移语义）。 */
  let scriptedSelection: StubTextRange | null = null;
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
      /* reduce 场景命中（app.js 的 prefersReducedMotion 每次调用现读
         matches——无需 change 事件）。 */
      matches: options.reducedMotion === true && query.includes("prefers-reduced-motion"),
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
    confirm: (message) => {
      confirmCalls.push(message);
      return confirmResult;
    },
  };

  /* ---------------- 脚本化 echo 后端 ---------------- */

  const backend: Backend = {
    trees: options.noTrees === true ? [] : [{ id: TREE, createdAt: ISO, forestId: "forest-1" }],
    treesMode: options.treesMode ?? "ok",
    treeState:
      options.twoBranches === true
        ? freshTwoBranchBackendState()
        : freshBackendState(
            options.initialTrunkReturn === true,
            options.a2Text ?? A2_TEXT,
            options.trunkReturnAttempts ?? [],
          ),
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
    returnNavigation: options.returnNavigation ?? "ok",
    returnDelay: false,
    branchCounter: 0,
    sourceMode: "available",
    promptCounter: 0,
    termAnnotations: [],
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

    if (p === "/api/trees" && method === "GET") {
      if (backend.treesMode === "fail") {
        return respond(500, { error: { code: "internal", message: "trees backend boom" } });
      }
      return respond(200, { trees: backend.trees });
    }
    if (p === "/api/trees" && method === "POST") {
      /* 服务端语义：创建的树进入列表（createTree 的 refreshTrees 立即可见）。 */
      if (!backend.trees.some((t) => t.id === backend.treeState.tree.id)) {
        backend.trees.push(backend.treeState.tree);
      }
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
      const target = typeof branchId === "string" ? branchId : "";
      /* 服务端语义（switchBranch → #setCursor）：游标对齐目标分支续聊点
         ——最新 turn 的条目（无 turn 分支为 origin 锚点条目）。 */
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
        /* 服务端语义（signed v3 §3.5）：保存成功后导航回 Trunk；导航结果
           分离返回（failed 不是 HTTP 错误）。导航失败时服务端不动游标。 */
        const navigation =
          backend.returnNavigation === "fail"
            ? {
                status: "failed",
                code: "session-corrupt",
                message: "simulated navigation failure — the session store is damaged",
              }
            : { status: "navigated" };
        if (backend.returnNavigation === "ok") {
          backend.treeState.cursor = { treeId: TREE, branchId: "trunk-1", entryId: "pi-a2" };
        }
        return respond(201, { returnTurn, navigation, state: backend.treeState });
      }
      return respond(500, { error: { code: "internal", message: "return rejected (scripted failure)" } });
    }
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(p);
    if (m !== null && method === "POST") {
      /* 锚点揭示（service.revealBranchOrigin 契约）：{source, state}；
         source.status 按场景脚本（backend.sourceMode）。 */
      const branchId = decodeURIComponent(m[2]!);
      const view = viewByBranch(branchId);
      assert.ok(view !== undefined, `POST /source must target a known branch (got ${branchId})`);
      const origin = view.origin;
      assert.ok(origin !== null, "POST /source must target a branch with an anchor origin");
      return respond(200, {
        source: {
          sourceBranchId: origin.sourceBranchId,
          anchorTurnId: origin.anchorTurnId,
          status: backend.sourceMode,
          selection: origin.selection,
        },
        state: backend.treeState,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/new-exploration$/.exec(p);
    if (m !== null && method === "POST") {
      /* 服务端语义（v3 §4.4）：仅在目标分支 session 不可用时换轨——新
         session 首问，用户 turn 携带新探索标记 + 原文，分支恢复可用。 */
      const record = asRecord(body);
      assert.ok(record !== null, "POST /new-exploration body must be an object");
      const branchId = decodeURIComponent(m[2]!);
      const text = record.text;
      assert.ok(typeof text === "string" && text.trim() !== "", "POST /new-exploration must carry a non-empty text");
      const view = viewByBranch(branchId);
      assert.ok(view !== undefined, `POST /new-exploration must target a known branch (got ${branchId})`);
      if (view.sessionAvailability === "available") {
        return respond(409, {
          error: { code: "new-exploration-conflict", message: "branch still has an available session" },
        });
      }
      backend.promptCounter += 1;
      const runId = `run-ne${backend.promptCounter}`;
      view.turns.push(
        makeTurn(
          `ne${backend.promptCounter}u`,
          branchId,
          "user",
          `[new exploration from saved content — the previous session was not restored]\n\n${text}`,
          { runId, piEntryId: `pi-ne${backend.promptCounter}u` },
        ),
      );
      const assistantTurn = makeTurn(
        `ne${backend.promptCounter}a`,
        branchId,
        "assistant",
        `echo:[exploration ${text}]`,
        { runId, piEntryId: `pi-ne${backend.promptCounter}a` },
      );
      view.turns.push(assistantTurn);
      view.sessionAvailability = "available";
      backend.treeState.cursor = { treeId: TREE, branchId, entryId: assistantTurn.piEntryId! };
      return respond(200, { outcome: { kind: "completed" }, state: backend.treeState });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology$/.exec(p);
    if (m !== null && method === "GET") {
      return respond(200, {
        annotations: backend.termAnnotations,
        tasks: [],
        usage: {
          total: { requests: 1, promptChars: 10, completionChars: 10 },
          estTokens: 5,
          lateResultsDiscarded: 0,
          budgetTokens: 1_000_000,
        },
        cacheEnabled: true,
      });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology\/explain$/.exec(p);
    if (m !== null && method === "POST") {
      const record = asRecord(body);
      assert.ok(record !== null, "POST /terminology/explain body must be an object");
      const branchId = typeof record.branchId === "string" ? record.branchId : "";
      const anchorTurnId = typeof record.anchorTurnId === "string" ? record.anchorTurnId : "";
      const selection = asRecord(record.selection);
      assert.ok(selection !== null, "POST /terminology/explain must carry a selection");
      const sel = {
        start: Number(selection.start),
        end: Number(selection.end),
        text: String(selection.text ?? ""),
      };
      /* 服务端语义：既有同选区批注 → 直接返回（零模型调用）；否则瞬态任务
         成功（脚本化解释文本）。 */
      const existing = backend.termAnnotations.find(
        (a) => a.anchorTurnId === anchorTurnId && a.selection.start === sel.start && a.selection.end === sel.end,
      );
      if (existing !== undefined) {
        return respond(200, { annotation: existing, task: null });
      }
      return respond(200, {
        annotation: null,
        task: {
          id: "term-task-1",
          kind: "explain",
          mode: typeof record.mode === "string" ? record.mode : "term",
          treeId: TREE,
          term: sel.text,
          selection: sel,
          createdAt: ISO,
          state: { kind: "succeeded", explanation: `Scripted explanation of “${sel.text}”.`, candidates: null, cached: false, usage: { requests: 1, promptChars: 10, completionChars: 10 } },
        },
      });
    }
    m = /^\/api\/trees\/([^/]+)\/terminology\/annotations$/.exec(p);
    if (m !== null && method === "POST") {
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
      const annotation = {
        id: `term-ann-${String(backend.termAnnotations.length + 1)}`,
        treeId: TREE,
        branchId: typeof record.branchId === "string" ? record.branchId : "trunk-1",
        anchorTurnId,
        selection: sel,
        /* 服务端语义（src/terminology.ts saveAnnotation）：sourceHash 取
           保存时刻锚点答案全文指纹。 */
        sourceHash: sha256Of(findTurnText(backend.treeState, anchorTurnId)),
        term: sel.text,
        explanation: typeof record.explanation === "string" ? record.explanation : "",
        mode: typeof record.mode === "string" ? record.mode : "term",
        promotedBranchId: null,
        promotionKey: null,
        createdAt: ISO,
      };
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
        if (annotation.promotedBranchId === null) {
          annotation.promotedBranchId = `branch-term-${String(backend.branchCounter + 10)}`;
          annotation.promotionKey = key;
          backend.branchCounter += 1;
          const branch = {
            id: annotation.promotedBranchId,
            treeId: TREE,
            parentBranchId: annotation.branchId,
            createdAt: ISO,
          };
          backend.treeState.branches.push(makeBranchView(branch, null, "available", []));
        }
        return respond(201, {
          branch: backend.treeState.branches.find((v) => v.branch.id === annotation.promotedBranchId)?.branch ?? null,
          outcome: { kind: "completed" },
          firstQuestionError: null,
          created: true,
          state: backend.treeState,
        });
      }
    }
    m = /^\/api\/trees\/([^/]+)\/prompt$/.exec(p);
    if (m !== null && method === "POST") {
      /* echo 驱动语义（src/echo-port.ts 的 echoAnswer）：答案 = 该分支上
         全部 user 文本的确定性回声——分支谱系隔离的可断言证明。 */
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
        makeTurn(`p${backend.promptCounter}u`, branchId, "user", text, {
          runId,
          piEntryId: `pi-p${backend.promptCounter}u`,
        }),
      );
      const userTexts = [...view.turns.filter((t) => t.role === "user").map((t) => t.text)];
      const assistantTurn = makeTurn(`p${backend.promptCounter}a`, branchId, "assistant", `echo:[${userTexts.join("|")}]`, {
        runId,
        piEntryId: `pi-p${backend.promptCounter}a`,
      });
      view.turns.push(assistantTurn);
      backend.treeState.cursor = { treeId: TREE, branchId, entryId: assistantTurn.piEntryId! };
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
    setConfirmResult: (value) => {
      confirmResult = value;
    },
    confirmCalls,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 视觉基线（DOM 结构基线）：真实 index.html 骨架 + 引导后渲染结构    */
/* ------------------------------------------------------------------ */

test("visual baseline: real index.html skeleton and boot-rendered structure", async () => {
  const world = await createWorld({ initialTrunkReturn: true });

  /* 静态骨架：必需 id 恰好出现一次（解析自真实 index.html，非硬编码副本）。
   * 改版后骨架：#workspace 有界高度分栏、顶栏路径 #topbar-path(-wrap)、
   * 空态直达 #empty-new-tree、右侧支线概念列 #branch-column/#branch-empty。 */
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
    "list-load-error",
    "list-retry",
    "workspace",
    "topbar-path",
    "topbar-path-wrap",
    "empty-new-tree",
    "branch-column",
    "branch-empty",
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

  /* §2.4 冲突/失败提示可 Tab 触达并朗读（issue #6 P1）：两横幅 role=alert
     （隐式 aria-live）+ tabindex=0；§2.6 降级说明区（面板锚点上下文）可
     程序聚焦（tabindex=-1，不入 Tab 序）。 */
  for (const bannerId of ["error-banner", "panel-error-banner"]) {
    assert.equal(world.el(bannerId).getAttribute("role"), "alert", `#${bannerId} carries role=alert (implicit aria-live)`);
    assert.equal(world.el(bannerId).getAttribute("tabindex"), "0", `#${bannerId} is Tab-reachable`);
  }
  assert.equal(world.el("panel-anchor-context").getAttribute("tabindex"), "-1", "the anchor context is programmatically focusable");

  /* §2.1 列表加载失败重试面常驻侧栏（默认隐藏，失败时经 JS 呈现）。 */
  assert.equal(world.el("list-load-error").hidden, true, "the list retry affordance is hidden while the list loads fine");

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
    returnCard.textContent.includes("saved — pending adoption on the next Trunk discussion"),
    "an undelivered Return with no attempts shows the saved/pending badge (signed v3 §3.2 vocabulary)",
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
  assert.equal(world.el("source-drawer-toggle").getAttribute("aria-expanded"), "true", "toggle announces expanded while open");

  /* Esc 关抽屉：焦点还原到触发元素。 */
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.equal(world.document.activeElement, world.el("source-drawer-toggle"), "Esc restores focus to the toggle");
  await sleep(220);
  assert.equal(drawer.hidden, true, "drawer closed after Esc");
  /* Esc 关闭不经过 renderAll——开关 aria-expanded/文案必须就地对齐，
     读屏器不得持续播报已展开（浏览器面跑批器发现的陈旧态缺陷）。 */
  assert.equal(world.el("source-drawer-toggle").getAttribute("aria-expanded"), "false",
    "Esc close flips the toggle aria-expanded immediately (no stale expanded announcement)");
  assert.equal(world.el("source-drawer-toggle").textContent, "⑂ Sources", "toggle label restored on close");

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
/* 2b. 抽屉关闭按钮（附-4 / option B）：覆盖层打开时的可见关闭路径       */
/* ------------------------------------------------------------------ */

test("sources drawer close button: visible while the overlay covers Send and the toggle, click closes, Esc path unchanged", async () => {
  const world = await createWorld();
  const drawer = world.el("source-drawer");

  /* 打开 → 头部渲染可见关闭按钮（附-4：抽屉盖住主线 Send 与 Sources 开关
     自身——鼠标用户此前唯一关闭路径是 Esc）。 */
  world.el("source-drawer-toggle").click();
  assert.equal(drawer.hidden, false, "drawer opens");
  const close = drawer.querySelector("#drawer-close");
  assert.ok(close !== null, "the drawer header renders #drawer-close");
  assert.equal(close.tagName, "BUTTON", "#drawer-close is a real button element");
  assert.ok(close.textContent.startsWith("× Close"), "the close button text starts with '× Close'");
  /* 抽屉内的可交互元素只有按钮（关闭 + journal 失败重试）——逐标签确认
     #drawer-close 是文档序首个可交互元素。 */
  for (const tag of ["a", "input", "textarea", "select"]) {
    assert.equal(drawer.querySelector(tag), null, `the drawer carries no <${tag}> interactive elements`);
  }
  assert.equal(close, drawer.querySelector("button"),
    "#drawer-close is the first interactive element inside the drawer");

  /* 点击关闭：复用 closeDrawer()——隐藏 + 开关 aria-expanded/文案就地对
     齐 + 焦点还原到触发元素（与 Esc 同一语义，不另开关闭路径）。 */
  close.click();
  assert.equal(world.document.activeElement, world.el("source-drawer-toggle"),
    "closing via the button restores focus to the toggle");
  await sleep(220);
  assert.equal(drawer.hidden, true, "clicking #drawer-close hides the drawer");
  assert.equal(world.el("source-drawer-toggle").getAttribute("aria-expanded"), "false",
    "toggle aria-expanded flips to false on button close");
  assert.equal(world.el("source-drawer-toggle").textContent, "⑂ Sources",
    "toggle label restored on button close");

  /* Esc 路径不回归（附-4 只增不改）：再开后 Esc 仍关闭并还原焦点。 */
  world.el("source-drawer-toggle").click();
  assert.equal(drawer.hidden, false, "drawer reopens");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.equal(world.document.activeElement, world.el("source-drawer-toggle"),
    "Esc still restores focus to the toggle");
  await sleep(220);
  assert.equal(drawer.hidden, true, "Esc still closes the drawer");
  assert.equal(world.el("source-drawer-toggle").getAttribute("aria-expanded"), "false",
    "Esc close still flips the toggle aria-expanded");
  assert.equal(world.el("source-drawer-toggle").textContent, "⑂ Sources",
    "Esc close still restores the toggle label");
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
  assert.equal(world.el("panel-prompt-input").disabled, false, "v3 §4.4: the input stays typed-in (the new exploration's first question)");
  assert.equal(world.el("panel-new-exploration").hidden, false, "v3 §4.4: the explicit new-exploration entry appears");
  assert.equal(world.el("panel-new-exploration").disabled, false, "the new-exploration entry is actionable");

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
/* 5b. 采用尝试徽标（signed v3 §3.2）：saved ≠ attempted ≠ delivered    */
/* ------------------------------------------------------------------ */

test("adoption attempts: a saved return with a failed run attempt renders attempted-but-pending on the card and in the sources drawer", async () => {
  const world = await createWorld({
    initialTrunkReturn: true,
    trunkReturnAttempts: [
      {
        turnId: "r0",
        runId: "run-attempt-1",
        runState: "failed",
        failure: { code: "upstream", message: "model request failed" },
        attemptedAt: ISO,
        terminalAt: ISO,
      },
    ],
  });

  /* 卡片：deliveredRunId === null 但已有尝试 → 「尝试过、仍待采用」，
     不伪装成已送达，也不回退成无尝试的 saved。 */
  const conversation = world.el("conversation");
  const returnCard = conversation.querySelectorAll(".turn")[2]!;
  assert.ok(returnCard.classList.contains("return"));
  assert.ok(
    returnCard.textContent.includes("adoption attempted (1) — still pending, retried on the next Trunk discussion"),
    "the card distinguishes attempted-but-pending from saved and delivered",
  );
  assert.ok(!returnCard.textContent.includes("successfully adopted"), "no delivered badge without a successful adoption");

  /* 来源抽屉：尝试明细列出 run 与结局（安全投影——runId/状态/失败码）。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");
  assert.ok(drawer.textContent.includes("adoption attempted, still pending (1)"), "the drawer lists the return as attempted-but-pending");
  assert.ok(
    drawer.textContent.includes("attempt: run run-attempt-… · failed · failure upstream"),
    "the drawer lists the failed attempt with its run and failure code",
  );
});

/* ------------------------------------------------------------------ */
/* 5c. 保存成功 + 服务端导航失败（signed v3 §3.5）：分离呈现              */
/* ------------------------------------------------------------------ */

test("a saved return whose server-side navigation failed shows the saved fact and the navigation failure separately", async () => {
  const world = await createWorld({ returnNavigation: "fail" });
  const draftKey = "treeai-return-draft:tree-1:branch-1";
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();
  const returnInput = world.el("return-input");
  returnInput.value = "Saved despite the broken session.";
  returnInput.dispatchEvent("input", {});
  const switchCountBefore = world.backend.switchCount;

  world.el("submit-return").click();
  await settle();
  await sleep(220);

  /* 保存成功（201 + navigation.failed）：单次 POST /return、草稿清除、
     面板收起、卡渲染为 saved/pending——导航失败不把保存伪装成失败。 */
  assert.equal(world.requestsOf("/return").length, 1, "exactly one POST /return");
  assert.ok(world.localStorageStore.get(draftKey) === undefined, "the save succeeded — the draft is cleared");
  assert.equal(world.el("branch-panel").hidden, true, "the panel closes");
  const conversation = world.el("conversation");
  assert.ok(conversation.textContent.includes("Saved despite the broken session."), "the Return card renders");
  assert.ok(conversation.textContent.includes("saved — pending adoption on the next Trunk discussion"), "the card shows the saved/pending badge");

  /* 导航失败分离呈现于主线横幅；closePanel 不重放 /switch（面板打开时的
     /switch 在提交之前——提交之后不再有任何 /switch）。 */
  assert.equal(world.backend.switchCount, switchCountBefore, "no /switch is replayed (the server already attempted navigation)");
  const returnRequestIndex = world.backend.requests.findIndex(
    (r) => r.method === "POST" && r.path.split("?")[0]!.endsWith("/return"),
  );
  assert.ok(returnRequestIndex >= 0, "the submit POST /return is recorded");
  const switchesAfterSubmit = world.backend.requests.filter(
    (r, index) => index > returnRequestIndex && r.method === "POST" && r.path.split("?")[0]!.endsWith("/switch"),
  );
  assert.equal(switchesAfterSubmit.length, 0, "closePanel skips the switch after the reported navigation failure");
  const mainError = world.el("error-banner");
  assert.equal(mainError.hidden, false, "the navigation failure surfaces in the main banner");
  assert.ok(mainError.textContent.includes("Return saved"), "the banner states the return IS saved");
  assert.ok(mainError.textContent.includes("returning to the Trunk failed"), "the banner states the navigation failed");
  assert.ok(mainError.textContent.includes("session-corrupt"), "the banner carries the navigation failure code");
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
    "no session currently available — start a new exploration from saved content (composer below), or start a new Tree / restore the session file",
    "the disabled state explains the reason",
  );
  assert.ok(banner.querySelector(".session-banner-dismiss") !== null, "banner keeps its Dismiss control");
  assert.equal(world.el("send").disabled, true, "fail-closed: trunk composer disabled while the trunk session is missing");
  assert.equal(world.el("prompt-input").disabled, false, "v3 §4.4: the trunk input stays typed-in (the new exploration's first question)");
  assert.equal(world.el("new-exploration").hidden, false, "v3 §4.4: the explicit new-exploration entry appears");
  assert.equal(world.el("new-exploration").disabled, false, "the new-exploration entry is actionable even with no recovery candidate");

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

/* ------------------------------------------------------------------ */
/* 9. A1 双支线交叉切换：谱系 / 上下文 / 阅读位置按分支隔离（issue #5）   */
/* ------------------------------------------------------------------ */

test("two-branch cross-switching: alternating panels keep lineage, context, and reading state per branch", async () => {
  const world = await createWorld({ twoBranches: true });

  /* 引导：三个 tab（Trunk + 两支线）；主线 tab 恒 active，面板未开。 */
  const tabs = world.el("branch-tabs").querySelectorAll("button");
  assert.equal(tabs.length, 3, "one tab per branch (Trunk + Branch 1 + Branch 2)");
  assert.deepEqual(
    tabs.map((t) => t.dataset.branchId),
    ["trunk-1", "branch-1", "branch-2"],
  );
  assert.ok(world.tabButton("trunk-1")!.classList.contains("active"), "the trunk tab stays the active main-line tab");
  assert.ok(!world.tabButton("branch-1")!.classList.contains("panel-open"), "no panel is open at boot");

  const conversation = world.el("conversation");
  const mainTurnIds = () => conversation.querySelectorAll(".turn").map((t) => t.dataset.turnId);
  assert.deepEqual(mainTurnIds(), ["u1", "a1", "u2", "a2"]);

  /* 打开 branch-1 面板：游标对齐 + 面板只呈该支线自己的谱系（第一轮已预置）。 */
  const panelConversation = world.el("panel-conversation");
  panelConversation.scrollHeight = 1500;
  panelConversation.clientHeight = 400;
  world.tabButton("branch-1")!.click();
  await settle();
  assert.equal(world.el("branch-panel").hidden, false, "branch-1 panel opens via tab");
  assert.equal(world.el("panel-title").textContent, "Branch 1");
  const anchorContext1 = world.el("panel-anchor-context").textContent;
  assert.ok(anchorContext1.includes("Branched from Trunk"), "the anchor card names the source branch");
  assert.ok(anchorContext1.includes("“First”"), "branch-1 anchors on the a1 selection excerpt");
  assert.ok(anchorContext1.includes("source available"), "originStatus renders");
  assert.deepEqual(
    panelConversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["b1u1", "b1a1"],
    "the panel shows branch-1's own lineage (seeded round one)",
  );
  assert.ok(panelConversation.textContent.includes(`echo:[${B1_R1_TEXT}]`), "the seeded echo answer renders");
  assert.ok(!panelConversation.textContent.includes(B2_R1_TEXT), "no branch-2 text bleeds into branch-1's panel");
  const switchAfterB1 = world.lastRequest("/switch");
  assert.ok(switchAfterB1 !== null && switchAfterB1.method === "POST", "tab open aligns the cursor via POST /switch");
  assert.equal(asRecord(switchAfterB1.body)?.branchId, "branch-1", "the switch targets branch-1");
  assert.ok(world.el("cursor-note").textContent.includes("session @ Branch 1"), "the cursor note names branch-1");
  assert.equal(world.document.activeElement, world.el("panel-prompt-input"), "panel open focuses the branch input");
  assert.equal(world.el("panel-prompt-input").disabled, false, "available branch: composer enabled");
  assert.equal(world.el("panel-session-note").hidden, true, "available branch: no degraded note");
  assert.equal(panelConversation.scrollTop, 1500, "first open of branch-1 lands at the bottom");
  assert.equal(panelConversation.lastScrollBehavior, "auto", "first open lands instantly (no saved position)");
  assert.ok(world.tabButton("branch-1")!.classList.contains("panel-open"), "the open branch tab is marked panel-open");

  /* 主线向上阅读（面板开合期间主线位置不动的断言基线）+ branch-1 向上阅读。 */
  conversation.scrollHeight = 4000;
  conversation.clientHeight = 600;
  conversation.scrollTop = 900;
  panelConversation.scrollTop = 300;

  /* 切到 branch-2：面板整体换谱系；主线不动。 */
  world.tabButton("branch-2")!.click();
  await settle();
  assert.equal(world.el("panel-title").textContent, "Branch 2");
  const anchorContext2 = world.el("panel-anchor-context").textContent;
  assert.ok(anchorContext2.includes("“Second”"), "branch-2 anchors on the a2 selection excerpt");
  assert.ok(!anchorContext2.includes("“First”"), "no branch-1 anchor bleed into branch-2's card");
  assert.deepEqual(
    panelConversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["b2u1", "b2a1"],
    "the panel swaps to branch-2's own lineage",
  );
  assert.ok(panelConversation.textContent.includes(`echo:[${B2_R1_TEXT}]`));
  assert.ok(!panelConversation.textContent.includes(B1_R1_TEXT), "no branch-1 text bleed into branch-2's panel");
  assert.deepEqual(mainTurnIds(), ["u1", "a1", "u2", "a2"], "the main line is untouched by panel switching");
  assert.equal(conversation.scrollTop, 900, "the main-line reading position does not move while panels switch");
  const switchAfterB2 = world.lastRequest("/switch");
  assert.equal(asRecord(switchAfterB2?.body ?? null)?.branchId, "branch-2", "the switch targets branch-2");
  assert.ok(world.el("cursor-note").textContent.includes("session @ Branch 2"), "the cursor note follows the switch");
  assert.ok(!world.tabButton("branch-1")!.classList.contains("panel-open"), "branch-1's tab loses panel-open");
  assert.ok(world.tabButton("branch-2")!.classList.contains("panel-open"), "branch-2's tab gains panel-open");
  assert.equal(world.document.activeElement, world.el("panel-prompt-input"), "focus moves into the swapped panel");
  assert.equal(panelConversation.scrollTop, 1500, "first open of branch-2 lands at the bottom (its own memory is empty)");

  /* branch-2 向上阅读到另一位置。 */
  panelConversation.scrollTop = 800;

  /* 回 branch-1：恢复它自己的阅读位置（不串到 branch-2 的 800）。 */
  world.tabButton("branch-1")!.click();
  await settle();
  assert.equal(world.el("panel-title").textContent, "Branch 1");
  assert.deepEqual(
    panelConversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["b1u1", "b1a1"],
  );
  assert.equal(panelConversation.scrollTop, 300, "branch-1's remembered reading position is restored");

  /* 交替中的续聊（branch-1 第二轮）：面板 composer → POST /prompt 定位
     branch-1；echo 只含 branch-1 的 user 文本（谱系隔离）；向上阅读不被拉底。 */
  const panelInput = world.el("panel-prompt-input");
  panelInput.value = B1_R2_TEXT;
  world.el("panel-send").click();
  await settle();
  const promptPosts = world.requestsOf("/prompt");
  assert.equal(promptPosts.length, 1, "one POST /prompt for branch-1's round two");
  const b1PromptBody = asRecord(promptPosts[0]!.body);
  assert.ok(b1PromptBody !== null);
  assert.equal(b1PromptBody.branchId, "branch-1", "the panel composer targets the open branch");
  assert.equal(b1PromptBody.text, B1_R2_TEXT);
  assert.deepEqual(
    panelConversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["b1u1", "b1a1", "p1u", "p1a"],
    "the follow-up round lands on branch-1",
  );
  assert.ok(
    panelConversation.textContent.includes(`echo:[${B1_R1_TEXT}|${B1_R2_TEXT}]`),
    "the echo answer embeds only branch-1's user texts (lineage isolation)",
  );
  assert.ok(!panelConversation.textContent.includes(B2_R1_TEXT), "no branch-2 context bleeds into the answer");
  assert.equal(panelInput.value, "", "the submitted panel input clears");
  assert.equal(panelConversation.scrollTop, 300, "a scrolled-up reader is not yanked to the bottom by the new round");
  assert.deepEqual(mainTurnIds(), ["u1", "a1", "u2", "a2"], "trunk turns are untouched by branch prompts");
  assert.equal(conversation.scrollTop, 900, "the main-line reading position survives branch prompts");
  const b2View = world.backend.treeState.branches.find((v) => v.branch.id === "branch-2");
  assert.ok(b2View !== undefined);
  assert.equal(b2View.turns.length, 2, "branch-2's backend lineage is untouched by branch-1's prompt");

  /* 交替回 branch-2：恢复其阅读位置并驱动其第二轮——隔离断言对侧成立。 */
  world.tabButton("branch-2")!.click();
  await settle();
  assert.equal(panelConversation.scrollTop, 800, "branch-2's own reading position is restored");
  panelInput.value = B2_R2_TEXT;
  world.el("panel-send").click();
  await settle();
  const b2PromptBody = asRecord(world.requestsOf("/prompt")[1]?.body ?? null);
  assert.ok(b2PromptBody !== null);
  assert.equal(b2PromptBody.branchId, "branch-2", "the second prompt targets branch-2");
  assert.ok(
    panelConversation.textContent.includes(`echo:[${B2_R1_TEXT}|${B2_R2_TEXT}]`),
    "branch-2's echo embeds only branch-2's user texts",
  );
  assert.ok(!panelConversation.textContent.includes(B1_R1_TEXT), "no branch-1 context bleeds into branch-2's answer");
  assert.equal(panelConversation.scrollTop, 800, "branch-2's scrolled-up reader is not yanked either");

  /* 终态：每支线恰好两轮、谱系完整互不渗透；每次面板切换都对了游标。 */
  world.tabButton("branch-1")!.click();
  await settle();
  assert.deepEqual(
    panelConversation.querySelectorAll(".turn").map((t) => t.dataset.turnId),
    ["b1u1", "b1a1", "p1u", "p1a"],
    "the final switch back to branch-1 shows its full two-round lineage",
  );
  assert.equal(panelConversation.scrollTop, 300, "branch-1's reading position survives the whole alternation");
  assert.deepEqual(mainTurnIds(), ["u1", "a1", "u2", "a2"]);
  assert.equal(world.requestsOf("/switch").length, 5, "each panel branch switch aligned the cursor (5 switches)");
  assert.equal(world.requestsOf("/prompt").length, 2, "prompts never switch (prompt-driven navigation)");
});

/* ------------------------------------------------------------------ */
/* 10. A2 选区→锚点流：选区武装、绝对偏移、锚点卡与揭示（issue #5）       */
/* ------------------------------------------------------------------ */

test("selection to anchor: selection arms the branch affordance, exact offsets are submitted, the anchor card renders, and View source reveals or degrades honestly", async () => {
  const world = await createWorld();

  /* 助手答案携带建支入口；无选区 = 整条答案（W1 §1.1 回退语义）。 */
  const a1 = world.turnElement("conversation", "a1");
  const a1Button = a1.querySelector(".branch-here");
  assert.ok(a1Button !== null, "assistant turns carry the branch affordance");
  assert.equal(a1Button.textContent, "⑃ Branch from here");
  a1.dispatchEvent("mouseup", {});
  assert.ok(!a1.classList.contains("has-selection"), "no selection: the whole-answer affordance stays");
  assert.equal(a1Button.textContent, "⑃ Branch from here");

  /* 选区属于另一条 turn → 不武装本 turn 的入口（真实 contains 守卫）。 */
  const a2Early = world.turnElement("conversation", "a2");
  const a1TextNode = a1.firstChild;
  assert.ok(a1TextNode instanceof StubText, "the assistant turn's leading child is its text node");
  world.setSelection(new StubTextRange(a1TextNode, 0, 5)); /* “First” */
  a2Early.dispatchEvent("mouseup", {});
  assert.ok(!a2Early.classList.contains("has-selection"), "a selection inside another turn does not arm this turn");

  /* 无选区点击 a1 入口：整条答案建支线。 */
  world.setSelection(null);
  a1.dispatchEvent("mouseup", {});
  a1Button.click();
  await settle();
  const wholePost = world.lastRequest("/branches");
  assert.ok(wholePost !== null && wholePost.method === "POST", "branching issues POST /branches");
  const wholeBody = asRecord(wholePost.body);
  assert.ok(wholeBody !== null);
  assert.equal(wholeBody.sourceBranchId, "trunk-1");
  assert.equal(wholeBody.anchorTurnId, "a1");
  const wholeSelection = asRecord(wholeBody.selection);
  assert.ok(wholeSelection !== null);
  assert.equal(wholeSelection.start, 0);
  assert.equal(wholeSelection.end, A1_TEXT.length, "no selection falls back to the whole answer");
  assert.equal(wholeSelection.text, A1_TEXT);
  assert.equal(world.el("branch-panel").hidden, false, "the new branch opens as a local panel");
  assert.equal(world.el("panel-title").textContent, "Branch 2");
  assert.ok(
    world.el("panel-anchor-context").textContent.includes(`“${A1_TEXT}”`),
    "the anchor card carries the whole-answer excerpt",
  );
  assert.ok(
    world.el("panel-conversation").textContent.includes("Empty branch — continue it with a prompt."),
    "the fresh branch shows the honest empty state",
  );
  assert.equal(world.requestsOf("/switch").length, 0, "branching does not align the cursor (prompt-driven navigation)");

  /* 收起面板，回主线（下一段选区流程从干净面板状态开始）。 */
  world.el("panel-close").click();
  await settle();
  await sleep(220);
  assert.equal(world.el("branch-panel").hidden, true, "panel-close returns to the main line");

  /* 选区 → “Branch from selection”：绝对偏移精确提交（W1 §1.1）。 */
  const a2 = world.turnElement("conversation", "a2"); /* 重渲后取最新 DOM */
  const selStart = A2_TEXT.indexOf("latest");
  assert.ok(selStart > 0, "the a2 answer contains the scripted selection");
  const selEnd = selStart + "latest".length;
  const a2TextNode = a2.firstChild;
  assert.ok(a2TextNode instanceof StubText);
  world.setSelection(new StubTextRange(a2TextNode, selStart, selEnd));
  a2.dispatchEvent("mouseup", {});
  assert.ok(a2.classList.contains("has-selection"), "mouseup arms the selection state");
  const a2Button = a2.querySelector(".branch-here");
  assert.ok(a2Button !== null);
  assert.equal(a2Button.textContent, "⑃ Branch from selection", "the affordance switches to the selection form");
  a2Button.click();
  await settle();
  const selPost = world.lastRequest("/branches");
  assert.ok(selPost !== null);
  const selBody = asRecord(selPost.body);
  assert.ok(selBody !== null);
  assert.equal(selBody.sourceBranchId, "trunk-1");
  assert.equal(selBody.anchorTurnId, "a2");
  const selSelection = asRecord(selBody.selection);
  assert.ok(selSelection !== null);
  assert.equal(selSelection.start, selStart, "the selection start is the absolute offset within the answer");
  assert.equal(selSelection.end, selEnd);
  assert.equal(selSelection.text, "latest");
  assert.equal(world.el("panel-title").textContent, "Branch 3");
  const anchorCard = world.el("panel-anchor-context").textContent;
  assert.ok(anchorCard.includes("Branched from Trunk"));
  assert.ok(anchorCard.includes("“latest”"), "the anchor card carries the selection excerpt");
  assert.ok(anchorCard.includes("source available"));
  /* 新支线 tab：锚点圆点 + 出处 tooltip。 */
  const newTab = world.tabButton("branch-recovered-2");
  assert.ok(newTab !== null, "the new branch gets its own tab");
  assert.equal(newTab.title, "branched from Trunk · “latest” · source available");
  assert.ok(newTab.textContent.includes("°"), "an anchored branch tab carries the anchor dot");

  /* View source（available）：主线内揭示——高亮 + 焦点 + 滚动定位（W2 §2.6）。 */
  world.el("panel-view-source").click();
  await settle();
  const sourcePost = world.lastRequest("/source");
  assert.ok(sourcePost !== null && sourcePost.method === "POST", "View source issues POST /branches/:id/source");
  assert.ok(
    sourcePost.path.endsWith("/branches/branch-recovered-2/source"),
    "the reveal targets the open branch",
  );
  const revealedA2 = world.turnElement("conversation", "a2"); /* 揭示重渲后取最新 DOM */
  const mark = revealedA2.querySelector(".source-highlight");
  assert.ok(mark !== null, "the anchor answer renders the highlighted selection");
  assert.equal(mark.textContent, "latest");
  assert.ok(mark.className.includes("pulse"), "the first reveal pulses once (M6)");
  assert.ok(revealedA2.classList.contains("anchor-focus"), "the anchor turn takes the focus styling");
  assert.equal(revealedA2.getAttribute("tabindex"), "-1");
  assert.equal(world.document.activeElement, revealedA2, "focus moves to the anchor turn");
  assert.deepEqual(
    revealedA2.lastScrollIntoView,
    { block: "center", behavior: "smooth" },
    "the reveal scrolls the anchor into view (smooth in the default world)",
  );
  assert.equal(world.el("branch-panel").hidden, false, "the panel stays open while the anchor reveals in the main pane");

  /* 揭示降级（unavailable）：如实报告，不伪造高亮，摘录仍在锚点卡可读。 */
  world.backend.sourceMode = "unavailable";
  world.el("panel-view-source").click();
  await settle();
  const banner = world.el("panel-error-banner");
  assert.equal(banner.hidden, false, "a degraded reveal surfaces in the panel banner");
  assert.ok(banner.textContent.includes("Source reference unavailable"), "the banner names the honest status");
  assert.ok(banner.textContent.includes("saved excerpt remains available"));
  assert.equal(
    world.turnElement("conversation", "a2").querySelector(".source-highlight"),
    null,
    "no fabricated highlight on the degraded path",
  );
  assert.ok(
    world.el("panel-anchor-context").textContent.includes("“latest”"),
    "the saved excerpt stays readable in the anchor card",
  );
  /* §2.6 降级焦点（issue #6 P1）：焦点移到说明区——面板头部锚点上下文
     （常驻；取舍：横幅 8 秒自动隐藏会丢焦点，见 W2 §2.6 行内注记）。 */
  assert.equal(
    world.document.activeElement,
    world.el("panel-anchor-context"),
    "the degraded reveal moves focus to the explanation area (panel anchor context)",
  );
});

/* ------------------------------------------------------------------ */
/* 11. 窄窗 <720px：style.css 媒查规则词法断言 + 侧栏抽屉 JS 行为         */
/* ------------------------------------------------------------------ */

test("narrow window: <720px rules exist in style.css and the sidebar-drawer JS behaviors hold (toggle, auto-close, Esc layering)", async () => {
  /* 词法断言（真实 style.css 的 @media 块；套件不执行 CSS——规则存在与
     形状按词法锁定，同 index.html 骨架的纪律）。 */
  const narrow = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(max-width: 719px)");
  assert.ok(narrow !== undefined, "style.css carries the <720px narrow-window media query");
  const narrowDecl = (selector: string): string => {
    const decl = declarationsOf(narrow!, selector);
    assert.ok(decl !== null, `the narrow block must style ${selector}`);
    return decl;
  };
  assert.ok(narrowDecl("#sidebar-toggle").includes("display: block"), "the sidebar toggle becomes visible");
  const sidebarDecl = narrowDecl("#sidebar");
  assert.ok(sidebarDecl.includes("position: fixed"), "the sidebar becomes an off-canvas drawer");
  assert.ok(sidebarDecl.includes("transform: translateX(-100%)"), "hidden off-canvas by default");
  assert.ok(
    narrowDecl("body.sidebar-open #sidebar").includes("transform: translateX(0)"),
    "body.sidebar-open slides the drawer in",
  );
  assert.ok(narrowDecl("#new-tree").includes("width: 100%"), "the primary New Tree button goes full width (§2.1)");
  assert.ok(narrowDecl("#branch-bar").includes("padding-left"), "the branch bar clears the fixed toggle");
  assert.ok(
    narrowDecl("#diagnostics-bar #run-detail, #diagnostics-bar #policy-note").includes("display: none"),
    "the diagnostics bar compresses (detail and policy note collapse)",
  );
  assert.ok(narrowDecl(".turn").includes("max-width: 100%"), "messages go full width");
  const overlaysDecl = narrowDecl("#branch-panel, #source-drawer");
  assert.ok(
    overlaysDecl.includes("width: 100%") && overlaysDecl.includes("max-width: 100%"),
    "the branch panel and source drawer go full width",
  );

  /* §2.7 窄窗抽屉自底向上（issue #6 P1）：窄窗块内 enter/exit 改用自底
     向上的 drawer-up keyframes（translateY）；宽窗右侧滑入规则
     （panel-in/out）保持不变；整幅上滑的 keyframes 按词法锁定。 */
  const drawerEnterDecl = narrowDecl("#source-drawer.enter");
  assert.ok(drawerEnterDecl.includes("drawer-up-in"), "the narrow drawer enters bottom-up (drawer-up-in)");
  assert.ok(drawerEnterDecl.includes("var(--motion-panel)"), "the bottom-up enter keeps the panel motion timing");
  const drawerExitDecl = narrowDecl("#source-drawer.exit");
  assert.ok(drawerExitDecl.includes("drawer-up-out"), "the narrow drawer exits downward (drawer-up-out)");
  assert.ok(drawerExitDecl.includes("forwards"), "the exit keeps the forwards fill (hidden lands after the animation)");
  assert.ok(
    /@keyframes drawer-up-in\s*\{\s*from\s*\{[^}]*transform:\s*translateY\(100%\)[^}]*\}/.test(STYLE_CSS),
    "drawer-up-in slides in from beyond the bottom edge (translateY(100%))",
  );
  assert.ok(
    /@keyframes drawer-up-out\s*\{\s*from\s*\{[^}]*\}\s*to\s*\{[^}]*transform:\s*translateY\(100%\)[^}]*\}/.test(
      STYLE_CSS,
    ),
    "drawer-up-out slides back below the bottom edge",
  );
  assert.ok(
    /#source-drawer\.enter\s*\{[^}]*animation:\s*panel-in/.test(STYLE_CSS),
    "the wide-viewport drawer keeps the right-side panel-in entrance (unchanged)",
  );
  assert.ok(
    /#source-drawer\.exit\s*\{[^}]*animation:\s*panel-out/.test(STYLE_CSS),
    "the wide-viewport drawer keeps the panel-out exit (unchanged)",
  );

  /* JS 行为（scripted DOM）：开关状态 + aria、选树自动收起、Esc 分层。 */
  const world = await createWorld();
  const body = world.document.body;
  assert.ok(body !== null, "the document body exists");
  const toggle = world.el("sidebar-toggle");
  assert.equal(toggle.getAttribute("aria-controls"), "sidebar", "the toggle names its drawer (aria-controls)");

  toggle.click();
  assert.ok(body.classList.contains("sidebar-open"), "the toggle opens the sidebar drawer");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  assert.ok(!body.classList.contains("sidebar-open"), "the toggle closes it again");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  /* 选树自动收起（窄窗交互：抽屉选完即走）。 */
  toggle.click();
  const treeButton = world.el("tree-list").querySelectorAll("button")[0];
  assert.ok(treeButton !== undefined);
  treeButton.click();
  await settle();
  assert.ok(!body.classList.contains("sidebar-open"), "selecting a tree auto-closes the sidebar drawer");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  /* Esc 分层（W2 逐屏键盘焦点行）：来源抽屉 → 支线面板 → 侧栏抽屉。 */
  toggle.click();
  world.tabButton("branch-1")!.click();
  await settle();
  world.el("source-drawer-toggle").click();
  await settle();
  assert.ok(
    body.classList.contains("sidebar-open") &&
      world.el("branch-panel").hidden === false &&
      world.el("source-drawer").hidden === false,
    "all three layers are open",
  );
  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle();
  await sleep(220);
  assert.equal(world.el("source-drawer").hidden, true, "the first Esc closes the source drawer");
  assert.equal(world.el("branch-panel").hidden, false, "the branch panel is still open");
  assert.ok(body.classList.contains("sidebar-open"), "the sidebar drawer is still open");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  await settle();
  await sleep(220);
  assert.equal(world.el("branch-panel").hidden, true, "the second Esc closes the branch panel");
  assert.ok(body.classList.contains("sidebar-open"), "the sidebar drawer is still open");
  world.document.dispatchEvent("keydown", { key: "Escape" });
  assert.ok(!body.classList.contains("sidebar-open"), "the third Esc closes the sidebar drawer");
});

/* ------------------------------------------------------------------ */
/* 12. prefers-reduced-motion：CSS 全局降级 + JS 滚动定位即时化           */
/* ------------------------------------------------------------------ */

test("prefers-reduced-motion: the global CSS downgrade exists and JS scroll positioning jumps instantly under reduce", async () => {
  /* 词法断言：@media (prefers-reduced-motion: reduce) 的全局即时化块。 */
  const reduced = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(prefers-reduced-motion: reduce)");
  assert.ok(reduced !== undefined, "style.css carries the prefers-reduced-motion media query");
  const globalDecl = declarationsOf(reduced, "*, *::before, *::after");
  assert.ok(globalDecl !== null, "the reduced-motion block applies globally");
  assert.ok(globalDecl.includes("animation-duration: 0.01ms !important"), "animations are instant");
  assert.ok(globalDecl.includes("animation-iteration-count: 1 !important"), "no iteration loops");
  assert.ok(globalDecl.includes("transition-duration: 0.01ms !important"), "transitions are instant");
  assert.ok(globalDecl.includes("scroll-behavior: auto !important"), "CSS-side scrolling jumps");
  assert.ok(declarationsOf(reduced, "#sidebar")!.includes("transition: none"), "the sidebar drawer transition is removed");

  /* JS 侧（app.js prefersReducedMotion / scrollBehavior）：同一流式跟随
     流程，常规世界 smooth、reduce 世界 auto。 */
  const driveStreamingFollow = async (world: World): Promise<void> => {
    const conversation = world.el("conversation");
    conversation.scrollHeight = 4000;
    conversation.clientHeight = 600;
    conversation.scrollTop = 3400; /* 贴底阅读（48px 阈值内） */
    world.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
    world.liveSse().emit("message-delta", { runId: "run-s", delta: "Alpha " });
    assert.ok(world.el("streaming-turn").textContent.includes("Alpha"), "the delta renders into the placeholder");
    assert.equal(conversation.scrollTop, 4000, "an at-bottom reader follows the delta");
  };
  const normalWorld = await createWorld();
  await driveStreamingFollow(normalWorld);
  assert.equal(normalWorld.el("conversation").lastScrollBehavior, "smooth", "the default world follows smoothly");

  const reducedWorld = await createWorld({ reducedMotion: true });
  await driveStreamingFollow(reducedWorld);
  assert.equal(reducedWorld.el("conversation").lastScrollBehavior, "auto", "the reduced-motion world jumps instantly");

  /* 揭示定位同样即时化：reduce 世界 View source 的锚点滚动 behavior=auto。 */
  const tab = reducedWorld.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();
  reducedWorld.el("panel-view-source").click();
  await settle();
  const anchorTurn = reducedWorld.turnElement("conversation", "a1");
  assert.deepEqual(
    anchorTurn.lastScrollIntoView,
    { block: "center", behavior: "auto" },
    "the anchor reveal scrolls instantly under reduced motion",
  );
  assert.equal(reducedWorld.document.activeElement, anchorTurn, "focus still moves to the anchor turn");
});

/* ------------------------------------------------------------------ */
/* 13. reduced-motion 贴底 stick 渲染：已记忆阅读位置下即时定位           */
/* ------------------------------------------------------------------ */

test("reduced motion: at-bottom stick and delta follows land instantly instead of animating", async () => {
  /* 对照（未声明 reduce）：同一路径走 smooth——证明断言点确实经过
     matchMedia 分支（saved ≠ undefined，非首次渲染的 auto 路径）。
     顺序约束：全局桩按 world 覆盖，创建第二个 world 后第一个不再可
     驱动，故对照组的全部断言先于 reduce 组完成。 */
  const plain = await createWorld();
  const plainConversation = plain.el("conversation");
  plainConversation.scrollHeight = 4000;
  plainConversation.clientHeight = 600;
  plainConversation.scrollTop = 3400; /* 已记忆阅读位置（saved）+ 贴底（≥3352） */
  plain.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
  assert.equal(
    plainConversation.lastScrollBehavior,
    "smooth",
    "control: with motion allowed the stick-follow scroll is smooth",
  );
  plain.liveSse().emit("message-delta", { runId: "run-s", delta: "Alpha " });
  assert.equal(
    plainConversation.lastScrollBehavior,
    "smooth",
    "control: with motion allowed the delta-follow scroll is smooth",
  );

  /* prefers-reduced-motion: reduce → 贴底跟随直接定位（auto）。 */
  const world = await createWorld({ reducedMotion: true });
  const conversation = world.el("conversation");
  conversation.scrollHeight = 4000;
  conversation.clientHeight = 600;
  conversation.scrollTop = 3400; /* scroll 记忆 → saved = 3400（非首次渲染） */
  world.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
  assert.ok(world.byId("streaming-turn") !== null, "run-started renders the streaming placeholder");
  assert.equal(
    conversation.lastScrollBehavior,
    "auto",
    "reduced motion: the stick render with a saved reading position lands instantly",
  );
  assert.equal(conversation.scrollTop, 4000, "the reader still follows to the bottom");
  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Alpha" });
  assert.equal(
    conversation.lastScrollBehavior,
    "auto",
    "reduced motion: an at-bottom message-delta follow lands instantly",
  );
  assert.ok(world.el("streaming-turn").textContent.includes("Alpha"), "the delta text still renders");
});

/* ------------------------------------------------------------------ */
/* 14. 贴底阈值边界：47px 跟随 / 49px 不动（AT_BOTTOM_PX = 48）          */
/* ------------------------------------------------------------------ */

test("scroll follow threshold: a delta within 47px of the bottom follows; at 49px it does not move", async () => {
  const world = await createWorld();
  const conversation = world.el("conversation");
  conversation.scrollHeight = 4000;
  conversation.clientHeight = 600;

  world.liveSse().emit("run-started", { runId: "run-s", branchId: "trunk-1", episodeId: "ep-1" });
  assert.equal(conversation.scrollTop, 0, "control: a scrolled-up reader is not yanked by the stick render");

  /* 距底 47px（阈值 48px 内）：message-delta 跟随到底。 */
  conversation.scrollTop = 4000 - 600 - 47;
  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Alpha " });
  assert.equal(conversation.scrollTop, 4000, "47px from the bottom still counts as at-bottom and follows");

  /* 距底 49px（阈值外）：正在阅读，不移动。 */
  conversation.scrollTop = 4000 - 600 - 49;
  world.liveSse().emit("message-delta", { runId: "run-s", delta: "Beta" });
  assert.equal(conversation.scrollTop, 4000 - 600 - 49, "49px from the bottom is reading, not following — no scroll");
  assert.ok(
    world.el("streaming-turn").textContent.includes("Alpha Beta"),
    "both deltas still render into the placeholder",
  );
});

/* ------------------------------------------------------------------ */
/* 15. 键盘提交：Cmd/Ctrl+Enter（主线 / 面板）；普通 Enter 不提交        */
/* ------------------------------------------------------------------ */

test("keyboard submit: Cmd+Enter and Ctrl+Enter submit from the main and panel composers; plain Enter does not", async () => {
  const world = await createWorld();

  /* 普通 Enter：多行输入留给换行，不提交。 */
  const promptInput = world.el("prompt-input");
  promptInput.value = "Trunk question via keyboard.";
  promptInput.dispatchEvent("keydown", { key: "Enter" });
  await settle();
  assert.equal(world.requestsOf("/prompt").length, 0, "plain Enter does not submit");

  /* Cmd+Enter（主线）：恰好一次 POST /prompt，载荷携带分支与文本。 */
  promptInput.dispatchEvent("keydown", { key: "Enter", metaKey: true });
  await settle();
  const prompts = world.requestsOf("/prompt");
  assert.equal(prompts.length, 1, "Cmd+Enter fires exactly one POST /prompt");
  const mainBody = asRecord(prompts[0]!.body);
  assert.ok(mainBody !== null);
  assert.equal(mainBody.branchId, "trunk-1");
  assert.equal(mainBody.text, "Trunk question via keyboard.");
  assert.equal(promptInput.value, "", "a successful submit clears the main composer");

  /* Ctrl+Enter（面板）：同一端点，分支随面板。 */
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();
  const panelInput = world.el("panel-prompt-input");
  panelInput.value = "Branch question via keyboard.";
  panelInput.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
  await settle();
  const allPrompts = world.requestsOf("/prompt");
  assert.equal(allPrompts.length, 2, "Ctrl+Enter on the panel composer fires exactly one more POST /prompt");
  const panelBody = asRecord(allPrompts[1]!.body);
  assert.ok(panelBody !== null);
  assert.equal(panelBody.branchId, "branch-1");
  assert.equal(panelBody.text, "Branch question via keyboard.");
  assert.equal(panelInput.value, "", "a successful submit clears the panel composer");
});

/* ------------------------------------------------------------------ */
/* 16. §2.1 列表加载失败重试（issue #6 P1）：常驻重试面 + 在途态 + 恢复   */
/* ------------------------------------------------------------------ */

test("tree list load failure: persistent sidebar retry with an honest pending state and boot-completing recovery (no page reload)", async () => {
  const world = await createWorld({ treesMode: "fail" });
  const box = world.el("list-load-error");
  const retry = world.el("list-retry");
  const message = world.el("list-load-message");

  /* 启动即失败：侧栏常驻重试面（错误事实 + 可用重试），非只有 8 秒横幅。 */
  assert.equal(box.hidden, false, "a boot-time list failure shows the persistent sidebar affordance");
  assert.ok(message.textContent.includes("Failed to load the tree list"), "the message names the list failure");
  assert.ok(message.textContent.includes("trees backend boom"), "the message carries the backend error verbatim");
  assert.equal(retry.disabled, false, "retry is available immediately after the failure");
  assert.equal(retry.textContent, "Retry");
  assert.equal(world.el("error-banner").hidden, false, "the transient banner still reports the boot error (existing path)");
  assert.equal(
    world.document.activeElement,
    world.el("new-tree"),
    "boot focus lands on New Tree even on the list-failure path (§2.1)",
  );

  /* 重试在途：禁用 + Retrying…（诚实待态）；持久失败 → 回到失败态，重试仍可用。 */
  retry.click();
  assert.equal(retry.disabled, true, "the in-flight retry is disabled (pending state)");
  assert.equal(retry.textContent, "Retrying…");
  assert.ok(message.textContent.includes("Retrying the tree list"), "the pending state is stated in the message area");
  assert.equal(box.hidden, false, "the affordance stays visible while retrying");
  await settle();
  assert.equal(box.hidden, false, "a persistent failure keeps the affordance visible");
  assert.ok(message.textContent.includes("trees backend boom"), "the failure message returns after the failed retry");
  assert.equal(retry.disabled, false, "retry is available again after a persistent failure");
  assert.equal(retry.textContent, "Retry");
  assert.equal(world.requestsOf("/api/trees").length, 2, "boot fetch + one retry fetch (no page reload)");

  /* 后端恢复 → 重试成功：重试面消失、列表渲染、补齐启动语义（自动打开首棵树）。 */
  world.backend.treesMode = "ok";
  retry.click();
  await settle();
  assert.equal(box.hidden, true, "a successful retry clears the affordance");
  assert.equal(world.el("tree-list").querySelectorAll("button").length, 1, "the tree list renders");
  assert.equal(world.el("tree-view").hidden, false, "boot semantics complete after recovery: the first tree auto-opens");
  assert.equal(world.el("branch-tabs").querySelectorAll("button").length, 2, "tabs render for the auto-opened tree");
  assert.equal(
    world.requestsOf("/api/trees").length,
    4,
    "the recovery retry re-fetched the list twice (retry itself + the auto-open's list refresh)",
  );
});

/* ------------------------------------------------------------------ */
/* 17. §2.1 初始焦点（issue #6 P1）：启动设定一次，重渲不夺              */
/* ------------------------------------------------------------------ */

test("boot focus: initial focus lands on the New Tree button and re-renders never steal it", async () => {
  const world = await createWorld();
  assert.equal(
    world.document.activeElement,
    world.el("new-tree"),
    "boot programmatically sets initial focus to New Tree (§2.1 键盘焦点顺序)",
  );

  /* boot-only 语义：SSE 终态刷新走 renderAll，焦点不动（不夺焦）。 */
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  assert.equal(
    world.document.activeElement,
    world.el("new-tree"),
    "a run-terminal re-render does not move focus away from New Tree",
  );

  /* 显式交互照常移动焦点（面板打开 → 面板输入框）——这不属于夺焦。 */
  world.tabButton("branch-1")!.click();
  await settle();
  assert.equal(
    world.document.activeElement,
    world.el("panel-prompt-input"),
    "explicit interactions still move focus as before (panel open focuses the panel input)",
  );
});

/* ------------------------------------------------------------------ */
/* 18. A2 长答案（issue #6 P1 / W2 §4）：后段选区的精确偏移与揭示切片     */
/* ------------------------------------------------------------------ */

test("A2 long answer: a late selection inside a multi-thousand-character answer anchors at exact offsets and reveals by slice (no whole-answer fallback)", async () => {
  const world = await createWorld({ a2Text: LONG_A2 });
  assert.ok(LONG_A2.length > 5000, "the scripted answer is multi-thousand-character");

  /* 后段选区（最后一段内的目标短语，距末尾 <10%）。 */
  const phrase = "late anchor target phrase";
  const start = LONG_A2.lastIndexOf(phrase);
  assert.ok(start > LONG_A2.length * 0.9, "the selection sits in the late tail of the answer");
  const end = start + phrase.length;

  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText, "the assistant turn's leading child is its full-text node");
  world.setSelection(new StubTextRange(textNode, start, end));
  a2.dispatchEvent("mouseup", {});
  assert.ok(a2.classList.contains("has-selection"), "mouseup arms the selection affordance");
  a2.querySelector(".branch-here")!.click();
  await settle();

  /* 精确 {start,end,text} 提交——非整条答案回退。 */
  const post = world.lastRequest("/branches");
  assert.ok(post !== null && post.method === "POST", "branching issues POST /branches");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  assert.equal(body.anchorTurnId, "a2");
  const selection = asRecord(body.selection);
  assert.ok(selection !== null);
  assert.equal(selection.start, start, "the anchor start is the exact late offset");
  assert.equal(selection.end, end);
  assert.equal(selection.text, phrase);
  assert.ok(Number(selection.end) - Number(selection.start) < LONG_A2.length, "not the whole-answer fallback");
  assert.ok(world.el("panel-anchor-context").textContent.includes(phrase), "the anchor card carries the exact excerpt");

  /* 揭示：高亮按服务端偏移切片落位（前缀/后缀恰好切在偏移两侧）。 */
  world.el("panel-view-source").click();
  await settle();
  const revealed = world.turnElement("conversation", "a2");
  assertRevealSlices(revealed, LONG_A2, start, end);
  assert.equal(world.document.activeElement, revealed, "focus moves to the anchor turn");
});

/* ------------------------------------------------------------------ */
/* 19. A2 重复词（issue #6 P1 / W2 §4）：第二处偏移，绝不允许首处顶替     */
/* ------------------------------------------------------------------ */

test("A2 duplicate phrase: anchoring the SECOND occurrence submits and reveals the second occurrence (never the first string match)", async () => {
  const world = await createWorld({ a2Text: DUP_A2 });
  const first = DUP_A2.indexOf("alpha");
  const second = DUP_A2.indexOf("alpha", first + 1);
  assert.ok(first === 0 && second > first, "“alpha” occurs at least twice in the scripted answer");

  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);
  world.setSelection(new StubTextRange(textNode, second, second + "alpha".length));
  a2.dispatchEvent("mouseup", {});
  a2.querySelector(".branch-here")!.click();
  await settle();

  /* 偏移瞄准第二处：start = 第二次出现的位置（绝不允许首处字符串匹配顶替）。 */
  const post = world.lastRequest("/branches");
  assert.ok(post !== null && post.method === "POST", "branching issues POST /branches");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  const selection = asRecord(body.selection);
  assert.ok(selection !== null);
  assert.equal(selection.start, second, "the anchor offset targets the SECOND occurrence");
  assert.equal(selection.end, second + "alpha".length);
  assert.equal(selection.text, "alpha");

  /* 揭示必须高亮第二处：前缀文本恰好切到第二处之前（若顶替为首处，前缀
     会短得多——前缀内容即位置证明）。 */
  world.el("panel-view-source").click();
  await settle();
  const revealed = world.turnElement("conversation", "a2");
  assertRevealSlices(revealed, DUP_A2, second, second + "alpha".length);
  const prefix = revealed.children[0];
  assert.ok(prefix instanceof StubText);
  assert.notEqual(prefix.data, "", "the highlight is not standing in for the FIRST occurrence (whose prefix is empty)");
  assert.ok(prefix.data.endsWith("beta follows, "), "the highlighted occurrence follows beta — the second one");
});

/* ------------------------------------------------------------------ */
/* 20. A2 跨行选区（issue #6 P1 / W2 §4）：偏移与文本含换行不截断         */
/* ------------------------------------------------------------------ */

test("A2 cross-line selection: offsets and the revealed text span the line break intact", async () => {
  const world = await createWorld({ a2Text: CROSS_A2 });
  const start = CROSS_A2.indexOf("second");
  const end = CROSS_A2.indexOf("third") + "third".length;
  const selected = CROSS_A2.slice(start, end);
  assert.ok(selected.includes("\n"), "the scripted selection spans a line break");

  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);
  world.setSelection(new StubTextRange(textNode, start, end));
  a2.dispatchEvent("mouseup", {});
  a2.querySelector(".branch-here")!.click();
  await settle();

  const post = world.lastRequest("/branches");
  assert.ok(post !== null && post.method === "POST", "branching issues POST /branches");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  const selection = asRecord(body.selection);
  assert.ok(selection !== null);
  assert.equal(selection.start, start, "the start offset is measured across the preceding newline");
  assert.equal(selection.end, end);
  assert.equal(selection.text, selected, "the anchored text keeps the newline intact (not truncated at the line break)");
  assert.ok(world.el("panel-anchor-context").textContent.includes("second line"), "the anchor card excerpt spans the break");

  /* 揭示：跨行高亮完整（前缀 = 第一行 + 换行；后缀 = 第三行余文）。 */
  world.el("panel-view-source").click();
  await settle();
  const revealed = world.turnElement("conversation", "a2");
  assertRevealSlices(revealed, CROSS_A2, start, end);
  const mark = revealed.querySelector(".source-highlight");
  assert.ok(mark !== null);
  assert.ok(mark.textContent.includes("\n"), "the highlighted mark text carries the newline");
});

/* ------------------------------------------------------------------ */
/* 21. 顶栏位置路径（改版后新增）：renderTopbarPath 的诚实状态机          */
/* ------------------------------------------------------------------ */

test("topbar position path: empty with no tree, treeId / Trunk once open, the branch label appended while the panel is open", async () => {
  /* 无树启动：路径 = 空字符串——诚实状态（renderTopbarPath 无树分支），
     绝不用硬编码面包屑（如 “Forest”）占位；空态可见。 */
  const world = await createWorld({ noTrees: true });
  const path = world.el("topbar-path");
  assert.equal(path.textContent, "", "no tree open: the topbar path is the empty string");
  assert.ok(!path.textContent.includes("Forest"), "no hardcoded breadcrumb stands in for missing tree state");
  assert.equal(world.el("empty-state").hidden, false, "the empty state is visible with no tree open");

  /* 建树（侧栏「新建」）→ 树打开：路径 = `<treeId> / Trunk`。 */
  world.el("new-tree").click();
  await settle();
  assert.equal(path.textContent, `${TREE} / Trunk`, "tree open: the path names the tree id and Trunk");

  /* 支线面板打开（tab 点击——最轻的既有模式）→ 路径追加支线标签。 */
  const tab = world.tabButton("branch-1");
  assert.ok(tab !== null);
  tab.click();
  await settle();
  assert.equal(
    path.textContent,
    `${TREE} / Trunk / Branch 1`,
    "panel open: the path ends with the open branch's label",
  );

  /* 收起面板（↩ Back to Trunk）→ 路径回到 `<treeId> / Trunk`（renderAll
     先于 170ms 退场动效收尾刷新路径；收尾后路径不再变化）。 */
  world.el("panel-close").click();
  await settle();
  assert.equal(path.textContent, `${TREE} / Trunk`, "panel closed: the path drops the branch label");
  await sleep(220);
  assert.equal(world.el("branch-panel").hidden, true, "the panel finished its exit animation");
  assert.equal(path.textContent, `${TREE} / Trunk`, "the path stays on the Trunk after the exit animation settles");
});

/* ------------------------------------------------------------------ */
/* 22. 空态 New Tree 按钮（改版后新增）：主操作直达 = 同一 createTree      */
/* ------------------------------------------------------------------ */

test("empty-state New Tree: the button creates a tree via POST /api/trees and opens it", async () => {
  const world = await createWorld({ noTrees: true });

  /* 启动（空 Forest）：空态可见、树面隐藏（断言基线）。 */
  assert.equal(world.el("empty-state").hidden, false, "boot with an empty forest shows the empty state");
  assert.equal(world.el("tree-view").hidden, true, "no tree view renders with no tree");

  /* 点击空态主操作 → POST /api/trees（与侧栏「新建」同一 guard(createTree)；
     载荷为空对象（服务端分配 tree id）。 */
  world.el("empty-new-tree").click();
  await settle();
  const createPost = world.requestsOf("/api/trees").find((r) => r.method === "POST");
  assert.ok(createPost !== undefined, "clicking the empty-state button issues POST /api/trees");
  assert.deepEqual(createPost.body, {}, "the create posts an empty body (the server assigns the tree id)");

  /* 树打开：空态隐藏、树面可见、创建的树入列、分支 tab 渲染、顶栏路径
     随之渲染（同 §2.1 恢复后补齐启动语义的断言面）。 */
  assert.equal(world.el("empty-state").hidden, true, "the empty state hides once the tree opens");
  assert.equal(world.el("tree-view").hidden, false, "the tree view becomes visible");
  assert.equal(world.el("tree-list").querySelectorAll("button").length, 1, "the created tree renders in the sidebar list");
  assert.equal(
    world.el("branch-tabs").querySelectorAll("button").length,
    2,
    "branch tabs render for the created tree (Trunk + Branch 1)",
  );
  assert.equal(world.el("topbar-path").textContent, `${TREE} / Trunk`, "the topbar path renders for the created tree");
});

/* ------------------------------------------------------------------ */
/* 23. 来源抽屉入口的诚实隐藏（改版后新增）：无源可溯 → hidden            */
/* ------------------------------------------------------------------ */

test("sources drawer toggle: hidden while no tree is open, revealed once a tree opens", async () => {
  const world = await createWorld({ noTrees: true });
  assert.equal(
    world.el("source-drawer-toggle").hidden,
    true,
    "no tree open: nothing to source — the toggle is hidden (better than a guaranteed-empty drawer)",
  );
  world.el("empty-new-tree").click();
  await settle();
  assert.equal(
    world.el("source-drawer-toggle").hidden,
    false,
    "a tree opens: the sources entry returns (renderAll owns its visibility)",
  );
});

/* ------------------------------------------------------------------ */
/* 24. 改版 CSS 词法锁定（一）：≥1180px 并置支线列 + 基础层布局链         */
/* ------------------------------------------------------------------ */

test("post-rework layout CSS: the >=1180px juxtaposed branch column and the bounded-height chain are locked lexically", () => {
  /* ≥1180px 并置支线概念列（源设计 §二 / W2 §2.2–§2.3）：列常驻（自带
     宽度，主干阅读宽度不随面板开合变化）、面板打开恰好覆盖列、列空态以
     :has(#branch-panel:not([hidden])) 遮蔽（enter 渐入期间亦然）——受控
     空态面而非透出。 */
  const wide = extractMediaBlocks(STYLE_CSS).find((b) => b.query === "(min-width: 1180px)");
  assert.ok(wide !== undefined, "style.css carries the (min-width: 1180px) juxtaposed-column media query");
  const columnDecl = declarationsOf(wide, "#branch-column");
  assert.ok(columnDecl !== null, "the wide block styles #branch-column");
  assert.ok(columnDecl.includes("position: relative"), "the column is the panel's positioning basis (position: relative)");
  assert.ok(columnDecl.includes("width: min(440px, 34vw)"), "the resident column keeps its own width (min(440px, 34vw))");
  const panelDecl = declarationsOf(wide, "#branch-panel");
  assert.ok(panelDecl !== null, "the wide block styles #branch-panel inside the column");
  assert.ok(panelDecl.includes("width: 100%"), "the open panel spans the column exactly");
  const coverDecl = declarationsOf(wide, "#branch-column:has(#branch-panel:not([hidden])) #branch-empty");
  assert.ok(coverDecl !== null, "the covering rule targets the column's empty state via :has(:not([hidden]))");
  assert.ok(coverDecl.includes("visibility: hidden"), "an open panel hides the column's empty state (visibility, not display)");
  assert.ok(declarationsOf(wide, "#branch-empty") !== null, "the wide block styles the resident empty state (#branch-empty)");

  /* 基础层（媒体块之外）：<1180px 列不生成盒（display: contents——面板的
     定位基准退回 #reading-area，行为与改版前一致）；#workspace min-height:0
     接通有界高度链（#app 100dvh → … → #conversation 内部滚动）；#branch-bar
     为 58px 顶栏（窄窗块只调 padding，不再改高度）。 */
  const base = baseCssLayer(STYLE_CSS);
  assert.ok(
    /#branch-column\s*\{[^{}]*display:\s*contents/.test(base),
    "the base layer keeps #branch-column boxless (display: contents) below 1180px",
  );
  assert.ok(
    /#workspace\s*\{[^{}]*min-height:\s*0/.test(base),
    "#workspace carries min-height: 0 (the bounded-height chain reaches the internal scroller)",
  );
  assert.ok(
    /#branch-bar\s*\{[^{}]*height:\s*58px/.test(base),
    "#branch-bar is the 58px top bar",
  );
});

/* ------------------------------------------------------------------ */
/* 25. 改版 CSS 词法锁定（二）：恢复规则在场 + 移除项锁定缺席             */
/* ------------------------------------------------------------------ */

test("post-rework CSS: restored rules are present and the removed anti-patterns stay absent", () => {
  /* 缺席断言跑在去注释全文上（注释里的字样不算规则）；基础层断言走
     baseCssLayer（媒体块内的变体不与基态契约混淆）。 */
  const flat = STYLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const base = baseCssLayer(STYLE_CSS);

  /* 恢复规则（改版中曾被删、现已找回的回归面）：§2.1 列表失败面（常驻
     错误 + 重试）；issue #3 P1 可执行恢复按钮；issue #6 附-4 抽屉关闭
     按钮；M3 Return 卡插入动效；M4 confirmed→delivered 徽标切换；
     :root 动效分镜变量。 */
  assert.ok(/#list-load-error\s*\{/.test(flat), "#list-load-error rules are present (§2.1 persistent retry face)");
  assert.ok(/\.session-recovery-button\s*\{/.test(flat), ".session-recovery-button is present (executable recovery)");
  assert.ok(/#drawer-close\s*\{/.test(flat), "#drawer-close is present (附-4 visible close path)");
  assert.ok(
    /\.turn\.return\.insert\s*\{[^{}]*animation:\s*return-insert/.test(flat),
    ".turn.return.insert plays return-insert (M3 Return card insertion)",
  );
  assert.ok(/@keyframes return-insert\s*\{/.test(flat), "@keyframes return-insert is present");
  assert.ok(/\.turn\s+\.meta\s+\.delivery\s*\{/.test(flat), ".turn .meta .delivery carries the delivery badge styling");
  assert.ok(
    /\.turn\s+\.meta\s+\.delivery\.badge-change\s*\{[^{}]*animation:\s*badge-change/.test(flat),
    ".turn .meta .delivery.badge-change plays badge-change (M4 badge flip)",
  );
  assert.ok(/@keyframes badge-change\s*\{/.test(flat), "@keyframes badge-change is present");
  assert.ok(/:root\s*\{[^{}]*--motion-state:/.test(flat), ":root declares --motion-state");
  assert.ok(/:root\s*\{[^{}]*--motion-panel:/.test(flat), ":root declares --motion-panel");
  assert.ok(/:root\s*\{[^{}]*--motion-card:/.test(flat), ":root declares --motion-card");

  /* 移除项锁定缺席（改版裁决）：
   * - #topbar-path::before：位置路径必须是 renderTopbarPath 的诚实渲染
   *   （无树 = 空），不允许 CSS 假面包屑占位；
   * - #branch-panel/#source-drawer 的 .open：可见性契约 = hidden 属性 +
   *   .enter/.exit 动效（app.js 驱动），类名门控不得残留；
   * - 闪烁 caret：基础层 .streaming-caret 只有颜色、无 animation（M5
   *   静态指示）；blink 关键帧不存在（reduced-motion 块内的
   *   animation: none 是降级、不是闪烁——故该断言只针对基础层）。 */
  assert.ok(!/#topbar-path::before/.test(flat), "no #topbar-path::before anywhere — the path is honest rendered state");
  assert.ok(
    !/#branch-panel\.open/.test(flat),
    "no .open visibility gating on #branch-panel (hidden attribute + .enter/.exit only)",
  );
  assert.ok(
    !/#source-drawer\.open/.test(flat),
    "no .open visibility gating on #source-drawer (hidden attribute + .enter/.exit only)",
  );
  assert.ok(
    !/\.streaming-caret\s*\{[^{}]*animation:/.test(base),
    "the base .streaming-caret rule animates nothing (static caret, M5)",
  );
  assert.ok(
    /\.streaming-caret\s*\{[^{}]*color:\s*var\(--muted\)/.test(base),
    "the static caret is only muted color",
  );
  assert.ok(!/@keyframes blink/.test(flat), "no blink keyframes anywhere");
});

/* ------------------------------------------------------------------ */
/* 26. 新探索入口（v3 §4.4，issue #7 P0-2）：确认流 + 精确载荷 + 收尾    */
/* ------------------------------------------------------------------ */

test("new exploration entry (v3 §4.4): empty-text guard, cancelled confirm posts nothing, confirmed flow posts the exact body and clears the degradation", async () => {
  const world = await createWorld();
  const input = world.el("prompt-input");
  const banner = world.el("session-banner");

  /* trunk session 丢失：横幅 + 发送禁用 + 输入保持可输入 + 换轨入口出现。 */
  world.setAvailability("trunk-1", "unavailable");
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  assert.equal(banner.hidden, false, "trunk unavailable: the session banner shows");
  assert.equal(world.el("send").disabled, true, "fail-closed: the normal send stays disabled");
  assert.equal(input.disabled, false, "v3 §4.4: the input stays typed-in for the first question");
  assert.equal(world.el("new-exploration").hidden, false, "the new-exploration entry appears");
  assert.equal(world.el("new-exploration").disabled, false, "the entry is actionable");

  /* 空文本守卫：无 POST、无 confirm，错误提示输入首问。 */
  input.value = "   ";
  world.el("new-exploration").click();
  await settle();
  assert.equal(world.requestsOf("/new-exploration").length, 0, "empty text posts nothing");
  assert.equal(world.confirmCalls.length, 0, "empty text never reaches the confirmation");
  assert.equal(world.el("error-banner").hidden, false, "the empty-text guard explains what to type");
  assert.ok(world.el("error-banner").textContent.includes("first question"), "the guard names the first question");

  /* 取消确认：confirm 如实呈现换轨后果，取消则零 POST、状态不动。 */
  input.value = "First question of the new exploration.";
  world.setConfirmResult(false);
  world.el("new-exploration").click();
  await settle();
  assert.equal(world.requestsOf("/new-exploration").length, 0, "a cancelled confirmation posts nothing");
  assert.equal(world.confirmCalls.length, 1, "the confirmation dialog was shown");
  assert.ok(world.confirmCalls[0]!.includes("NOT restored"), "the dialog states honestly that the old context is not restored");
  assert.ok(world.confirmCalls[0]!.includes("new session"), "the dialog states that a new session is created");
  assert.equal(banner.hidden, false, "the banner stays (nothing happened)");

  /* 确认换轨：POST /branches/:id/new-exploration 携带精确载荷；成功后
     横幅下线、发送恢复、输入清空、换轨入口隐藏、标记回合渲染。 */
  world.setConfirmResult(true);
  world.el("new-exploration").click();
  await settle();
  const post = world.lastRequest("/new-exploration");
  assert.ok(post !== null && post.method === "POST", "the confirmed flow posts to the new-exploration route");
  assert.ok(post.path.endsWith("/branches/trunk-1/new-exploration"), "the route targets the trunk branch");
  const body = asRecord(post.body);
  assert.ok(body !== null);
  assert.equal(body.text, "First question of the new exploration.");
  assert.equal(banner.hidden, true, "the banner clears once the new session is live");
  assert.equal(world.el("send").disabled, false, "the normal composer unlocks on the new session");
  assert.equal(world.el("new-exploration").hidden, true, "the new-exploration entry hides once available");
  assert.equal(input.value, "", "the input clears after the successful exploration");
  const conversation = world.el("conversation");
  assert.ok(conversation.textContent.includes("[new exploration from saved content"), "the marker turn renders honestly");
  assert.ok(conversation.textContent.includes("First question of the new exploration."), "the typed question renders after the marker");
  assert.equal(world.document.activeElement, input, "focus returns to the composer input");
});

/* ------------------------------------------------------------------ */
/* 27. 降级 Return 卡（issue #7 P1）：快照区分来源去向 + 摘录 + 确认时间  */
/* ------------------------------------------------------------------ */

test("return card fallback placement (issue #7 P1): the targetAnchor snapshot distinguishes source-on-another-branch / changed / missing; the excerpt and saved time stay on the card; long excerpts collapse; delivered cards carry the adoption time", async () => {
  const world = await createWorld();
  const longExcerpt = "L".repeat(200);
  const trunk = world.backend.treeState.branches.find((v) => v.branch.id === "trunk-1");
  assert.ok(trunk !== undefined);
  /* branch-1 上的长答案（r-long 的锚点：切片逐字匹配 → 来源位于其他分支）。 */
  const branchOne = world.backend.treeState.branches.find((v) => v.branch.id === "branch-1");
  assert.ok(branchOne !== undefined);
  branchOne.turns.push(makeTurn("ba2", "branch-1", "assistant", longExcerpt));
  /* 四张回退放置的 Return（锚点均不在主干视图）：来源位于其他分支 /
     已变化（切片失配）/ 缺失（turn 不存在）/ 长摘录折叠。 */
  trunk.turns.push(
    makeTurn("r-else", "trunk-1", "return", "Conclusion from a nested branch.", {
      runId: null,
      piEntryId: null,
      fromBranchId: "branch-1",
      idempotencyKey: "idem-else",
      targetAnchor: {
        sourceBranchId: "branch-1",
        anchorTurnId: "ba1",
        anchorEntryId: "pi-ba1",
        selection: { start: 0, end: 5, text: BA1_TEXT.slice(0, 5) },
      },
    }),
    makeTurn("r-changed", "trunk-1", "return", "Conclusion whose anchor drifted.", {
      runId: null,
      piEntryId: null,
      fromBranchId: "branch-1",
      idempotencyKey: "idem-changed",
      targetAnchor: {
        sourceBranchId: "branch-1",
        anchorTurnId: "ba1",
        anchorEntryId: "pi-ba1",
        selection: { start: 0, end: 5, text: "XXXXX" },
      },
    }),
    makeTurn("r-missing", "trunk-1", "return", "Conclusion whose anchor is gone.", {
      runId: null,
      piEntryId: null,
      fromBranchId: "branch-1",
      idempotencyKey: "idem-missing",
      targetAnchor: {
        sourceBranchId: "branch-1",
        anchorTurnId: "turn-gone",
        anchorEntryId: "",
        selection: { start: 0, end: 5, text: "YYYYY" },
      },
    }),
    makeTurn("r-long", "trunk-1", "return", "Conclusion with a long excerpt.", {
      runId: null,
      piEntryId: null,
      fromBranchId: "branch-1",
      idempotencyKey: "idem-long",
      targetAnchor: {
        sourceBranchId: "branch-1",
        anchorTurnId: "ba2",
        anchorEntryId: "pi-ba2",
        selection: { start: 0, end: longExcerpt.length, text: longExcerpt },
      },
    }),
  );
  /* 已送达卡（锚定放置）：deliveredRunId + 采用尝试记录 → 卡面反查首次
     成功采用的时间。 */
  trunk.turns.push(
    makeTurn("r-delivered", "trunk-1", "return", "Delivered conclusion.", {
      runId: null,
      piEntryId: null,
      fromBranchId: "branch-1",
      idempotencyKey: "idem-delivered",
      deliveredRunId: "run-delivered-1",
      targetAnchor: {
        sourceBranchId: "trunk-1",
        anchorTurnId: "a1",
        anchorEntryId: "pi-a1",
        selection: { start: 0, end: 5, text: "First" },
      },
    }),
  );
  trunk.returnAttempts.push({
    turnId: "r-delivered",
    runId: "run-delivered-1",
    runState: "succeeded",
    failure: null,
    attemptedAt: ISO,
    terminalAt: ISO,
  });

  /* 重新打开树刷新读模型并重渲。 */
  const treeButton = world.el("tree-list").querySelectorAll("button")[0];
  assert.ok(treeButton !== undefined);
  treeButton.click();
  await settle();

  const conversation = world.el("conversation");
  const cardOf = (turnId: string): StubElement => {
    const found = conversation.querySelectorAll(".turn").find((t) => t.dataset.turnId === turnId);
    assert.ok(found !== undefined, `card ${turnId} renders in the trunk view`);
    return found;
  };

  /* 确认时间在卡面（产品 createdAt）；来源位于其他分支如实命名。 */
  const elsewhere = cardOf("r-else");
  assert.ok(elsewhere.textContent.includes("· saved "), "the card carries the saved time (product createdAt)");
  assert.ok(
    elsewhere.textContent.includes(`source on Branch 1 (anchored on “${BA1_TEXT.slice(0, 5)}”)`),
    "the fallback names the other branch and keeps the excerpt readable",
  );

  /* 已变化 / 缺失：区分注记 + 摘录仍在卡面。 */
  const changed = cardOf("r-changed");
  assert.ok(changed.textContent.includes("source changed (anchored on “XXXXX”)"), "a drifted anchor reports changed, not missing");
  const missing = cardOf("r-missing");
  assert.ok(missing.textContent.includes("source missing (anchored on “YYYYY”)"), "a gone anchor reports missing");

  /* 长摘录：折叠（details + summary 前缀切片 + 全文在卡内）。 */
  const long = cardOf("r-long");
  const details = long.querySelector("details");
  assert.ok(details !== null, "a long excerpt collapses into a details element");
  assert.ok(long.textContent.includes("source on Branch 1"), "the note still names the source");
  assert.ok(
    long.textContent.includes(`“${"L".repeat(100)}…”`),
    "the summary carries a prefix slice of the excerpt",
  );
  const full = details.querySelector(".return-excerpt-full");
  assert.ok(full !== null && full.textContent === `“${longExcerpt}”`, "the full excerpt stays in the card, expandable");

  /* 已送达卡：首次成功采用的时间从采用尝试记录反查。 */
  const delivered = cardOf("r-delivered");
  assert.ok(delivered.textContent.includes("successfully adopted into Trunk context"), "the delivered badge renders");
  assert.ok(delivered.textContent.includes(", adopted "), "the card carries the adoption time from the attempt record");
});

/* ------------------------------------------------------------------ */
/* 28. 术语三部分最小面（issue #7 C ③）：解释 → 保存 → 幂等推广           */
/* ------------------------------------------------------------------ */

test("terminology minimal UI: selection arms Explain, the card shows the isolated task result, save persists, and promotion opens the follow-up branch", async () => {
  const world = await createWorld();
  const a2 = world.turnElement("conversation", "a2");
  const textNode = a2.firstChild;
  assert.ok(textNode instanceof StubText);
  world.setSelection(new StubTextRange(textNode, 0, 5));
  a2.dispatchEvent("mouseup", {});

  /* 选区武装：解释按钮可用；无选区禁用。 */
  const explainButton = a2.querySelector(".term-explain");
  assert.ok(explainButton !== null, "assistant answers carry the Explain affordance");
  assert.equal(explainButton.disabled, false, "a selection arms the explain button");
  world.setSelection(null);
  a2.dispatchEvent("mouseup", {});
  assert.equal(a2.querySelector(".term-explain")!.disabled, true, "no selection disarms it");
  world.setSelection(new StubTextRange(textNode, 0, 5));
  a2.dispatchEvent("mouseup", {});

  /* 解释：瞬态任务结果呈卡（隔离执行器语义——不渲染为 turn）。 */
  explainButton.click();
  await settle();
  const explainPost = world.lastRequest("/terminology/explain");
  assert.ok(explainPost !== null && explainPost.method === "POST", "the explain button posts to the terminology route");
  const body = asRecord(explainPost.body);
  assert.ok(body !== null);
  assert.equal(body.branchId, "trunk-1");
  assert.equal(body.anchorTurnId, "a2");
  assert.equal(body.mode, "term", "a single-word selection is term mode");
  const card = world.el("conversation").querySelector(".term-explain-card");
  assert.ok(card !== null, "the explain card renders after the answer");
  assert.ok(card.textContent.includes("Scripted explanation of"), "the card shows the task result");
  assert.ok(card.querySelector(".term-save") !== null, "the card offers the explicit save action");
  assert.equal(
    world.el("conversation").querySelectorAll(".turn").length,
    4,
    "the transient explain result never renders as a product turn",
  );

  /* 保存 → 批注成为事实；卡面切换到推广动作（首问输入 + Promote）。 */
  card.querySelector(".term-save")!.click();
  await settle();
  const savePost = world.lastRequest("/terminology/annotations");
  assert.ok(savePost !== null && savePost.method === "POST");
  const saveBody = asRecord(savePost.body);
  assert.ok(saveBody !== null);
  assert.equal(saveBody.term, "Secon", "the annotation term is the selection text");
  const savedCard = world.el("conversation").querySelector(".term-explain-card");
  assert.ok(savedCard !== null);
  assert.ok(savedCard.textContent.includes("saved — promote to a follow-up branch"), "the saved card offers promotion");
  const input = savedCard.querySelector("#term-first-question");
  assert.ok(input !== null, "the promotion first-question input renders");

  /* 首问草稿跨重渲保持（输入落 state，renderAll 不丢）。 */
  input.value = "Why does this term matter here?";
  input.dispatchEvent("input", {});
  world.liveSse().emit("run-terminal", { runId: "run-x" });
  await settle();
  const inputAfterRerender = world.byId("term-first-question");
  assert.ok(inputAfterRerender !== null, "the promotion input survives the re-render");
  assert.equal(inputAfterRerender.value, "Why does this term matter here?", "the first-question draft survives re-renders");

  /* 推广：POST promote（幂等键 + 首问）→ 新支线面板打开。 */
  inputAfterRerender.parentElement!.querySelector(".term-promote")!.click();
  await settle();
  const promotePost = world.lastRequest("/promote");
  assert.ok(promotePost !== null && promotePost.method === "POST", "promotion posts to the promote route");
  const promoteBody = asRecord(promotePost.body);
  assert.ok(promoteBody !== null);
  assert.ok(typeof promoteBody.idempotencyKey === "string" && promoteBody.idempotencyKey !== "");
  assert.equal(promoteBody.firstQuestion, "Why does this term matter here?");
  assert.equal(world.el("branch-panel").hidden, false, "the promoted branch opens in the panel");
  assert.equal(
    world.el("conversation").querySelector(".term-explain-card"),
    null,
    "the card closes after promotion",
  );

  /* 抽屉：Terminology 节列出已保存批注与用量（诚实估算口径）。 */
  world.el("source-drawer-toggle").click();
  await settle();
  const drawer = world.el("source-drawer");
  assert.ok(drawer.textContent.includes("Terminology"), "the drawer has a Terminology section");
  assert.ok(drawer.textContent.includes("“Secon” (term) from Trunk"), "the annotation lists with its term and source branch");
  assert.ok(drawer.textContent.includes("promoted to"), "the promotion destination is listed");
  assert.ok(drawer.textContent.includes("chars/4 estimate"), "the usage note labels its estimate honestly");
});
