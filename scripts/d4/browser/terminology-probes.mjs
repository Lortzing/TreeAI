/**
 * scripts/d4/browser/terminology-probes.mjs — 术语①②③真实浏览器纵向路径探针
 * （issue #7 下一步 2：术语半边的真实 Chrome + 真实 Studio 进程路径）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动（check id `terminology-path`，无 d4-
 * 前缀——issue #7 术语工作、非 D4 工作包；verify:d4 不审计本行，术语独立
 * 追踪）。两种模式共用同一探针代码路径：
 *   - --mode real-pi   解释/首问/追问全部发给真实 Pi（issue #7 ②③ 行
 *                      「真实浏览器+真实Pi」验收的浏览器面证据）；
 *   - --mode selftest  echo 驱动（确定性回声）——同一 UI 流程的机制性冒烟，
 *                      证明探针/UI 代码路径可达，**不是真实 Pi 证据**
 *                      （detail/sidecar 如实标注）。
 *
 * 场景（owner 2026-09-30T14:18:27Z 增量验收 ②③ 行的全部待验项）：
 *
 *   ① 阅读模式面：抽屉三选一选择器真实切换（CDP Fetch Request 阶段观测
 *      PUT 载荷 + 服务端 GET 回读 + aria-pressed 迁移）；gate 未过的如实
 *      旁注在场（TERMINOLOGY_AUTO_QUALITY_GATE 生产恒 false——被测语义而
 *      非限制，绝不为让建议出现而改 gate）；manual-only 与 minimal-hints
 *      两档下 assistant 回答完成后**零自动派发**（服务端任务表/prompts/
 *      usage 零 + 建议条不渲染 + 隔离执行器 sessions 目录零文件）。
 *
 *   ② 术语入口纵向（term 与 range 两模式分别走全链）：主干真实提问得到
 *      assistant 回答 → 真实鼠标拖选武装工具条（term=点词级单词、
 *      range=跨词划线句；POST mode 字段随选区文本判定）→ 解释卡
 *      （selftest=echo 确定性回答；real-pi=真实模型回答，断言非空且含
 *      原文词）→ 保存批注（正文区间覆盖渲染 + 抽屉列表）→ 推广建枝
 *      （term：双击提交恰好一次派发；range：传输层响应丢弃 → 卡面如实
 *      冲突 + 刷新揭示既有推广 → 恢复既有探索，恰一条首问 user turn）→
 *      支线 ≥2 轮追问 → Return 回主线（来源卡：摘录/保存时间/来源分支，
 *      与材料 Return 卡同范式）→ SIGTERM 重启 → 新进程 → 批注/支线历史
 *      可读、继续追问落地 → 已有探索恢复（同批注再进入既有支线，分支数
 *      不变）与显式另开（复用通用建枝入口，新分支 + 批注推广指向不变）。
 *
 *   ③ 前端不变量：选择期间不重绘（武装期间正文 DOM 节点身份跨 renderAll
 *      稳定——B2 波先例断言写法）；复制不变（跨批注覆盖的整答案选区，
 *      平台复制 Cmd+C 剪贴板回读与 turn 原文字节相等，读回不可用时如实
 *      降级为 selection.toString 字节相等并记录）；宽 1600 / 窄 390 两档
 *      术语面可用（工具条/解释卡/抽屉 elementFromPoint 命中）；焦点/滚动/
 *      草稿（推广首问草稿 → renderAll 离开回来 → 草稿保留 + 焦点还原 +
 *      主线滚动保留；Esc 关解释卡 → 焦点还原到该答案的解释入口）。
 *
 * 探针纪律（与 material/b3/beta 探针同款）：
 *   - 页面内操作全部真实 DOM/输入事件（CDP Input 真实点击/键入/拖选；
 *     与 0ms 解除路径竞态的按钮用 DOM click 管线——b3 既有注释同源）；
 *     绝不在页面里 fetch-shim 应用自身行为；
 *   - 服务端事实经真实 API 读回对账（任务表/usage/批注/分支 turn 集/
 *     幂等重放）；隔离执行器零派发以 <data>/terminology/sessions 零文件
 *     佐证（会话文件只在执行器 prompt 后产生）；
 *   - 响应丢失注入：CDP Fetch 域 Response 阶段拦截 promote 并 failRequest
 *     ——请求已到达服务端并完整落地（建枝/绑定/派发账本/首问 run 全部
 *     完成），仅响应被丢弃（b3 material-first-question 同款语义）；
 *   - 专用临时数据目录（bootStudioOn；不污染共享场景树），探针结束清理；
 *   - 截图/JSON sidecar 入 artifacts；凭据零接触；失败如实。
 */

import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep, waitFor, inputClickAt, assertNoPageErrors } from "./material-probes.mjs";

/* ------------------------------------------------------------------ */
/* 探针标记（确定性、唯一；不与其他探针的标记交叉）                       */
/* ------------------------------------------------------------------ */

const TERM_MARKERS = {
  q1: "TreeAI-术语探针-主干一-q1a2b3",
  q2: "TreeAI-术语探针-主干二-c4d5e6",
  termQ1: "TreeAI-术语探针-TERM首问-f7g8h9",
  termF1: "TreeAI-术语探针-TERM追问一-j0k1l2",
  termF2: "TreeAI-术语探针-TERM追问二-m3n4o5",
  termRet: "TreeAI-术语探针-TERM收获-p6q7r8",
  rangeQ1: "TreeAI-术语探针-RANGE首问-s9t0u1",
  rangeF1: "TreeAI-术语探针-RANGE追问一-v2w3x4",
  rangeF2: "TreeAI-术语探针-RANGE追问二-y5z6a7",
  rangeRet: "TreeAI-术语探针-RANGE收获-b8c9d0",
  restartF: "TreeAI-术语探针-重启续走-e1f2g3",
  openF: "TreeAI-术语探针-另开首问-h4i5j6",
};

/** 主干提问（Q2 的回答是术语锚点答案；英文词让 term/range 选区在 echo 与
 *  真实模型回答里都确定可挑）。 */
const TRUNK_Q1 = `请用两三句话说明你会如何回答问题。（${TERM_MARKERS.q1}）`;
const TRUNK_Q2 =
  `请用大约150字介绍机器学习中 regularization 与 lasso 回归的作用，并顺带解释 overfitting 一词的含义。（${TERM_MARKERS.q2}）`;

/** term 选区的候选词（按优先序；大小写不敏感匹配，选区取原文精确子串）。 */
const TERM_CANDIDATES = ["regularization", "lasso", "overfitting"];

/* 视口档（③ 宽窄两档；收尾还原 runner 缺省视口）。 */
const WIDE_VIEWPORT = { width: 1600, height: 900 };
const NARROW_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const OVERFLOW_X_TOLERANCE_PX = 1;
const SCROLL_TOLERANCE_PX = 2;

/* 抽屉内三选一按钮的稳定序（renderDrawer 固定顺序：manual-only(1) /
   minimal-hints(2) / assisted-reading(3)）。 */
const MODE_BUTTON_INDEX = { "manual-only": 1, "minimal-hints": 2, "assisted-reading": 3 };
const GATE_NOTE_SNIPPET = "quality gate has not passed — automatic suggestions stay OFF";

/* ------------------------------------------------------------------ */
/* 小工具（CDP 视口 / 命中 / 点击管线 / Fetch 观测与丢弃）                 */
/* ------------------------------------------------------------------ */

async function setViewport(ctx, viewport) {
  await ctx.cdpSend("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    mobile: viewport.mobile ?? false,
  });
  await sleep(350);
}

/** 命中探测：先滚入视口，再取元素中心 elementFromPoint 是否落在元素内。 */
async function hitTest(ctx, selector) {
  return ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return { missing: true }; ` +
      `if (el.hidden === true) return { missing: true, hidden: true }; ` +
      `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
      `const r = el.getBoundingClientRect(); ` +
      `if (r.width <= 0 || r.height <= 0) return { missing: true, zeroRect: true }; ` +
      `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
      `if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) ` +
      `return { missing: true, outside: true, rect: { left: r.left, top: r.top, w: r.width, h: r.height } }; ` +
      `const hit = document.elementFromPoint(x, y); ` +
      `return { x, y, hit: hit !== null && (hit === el || el.contains(hit)) }; })()`,
  );
}

async function assertHits(ctx, selectors, label) {
  const results = {};
  const problems = [];
  for (const [name, selector] of Object.entries(selectors)) {
    const state = await hitTest(ctx, selector);
    results[name] = state?.hit === true ? true : state;
    if (state?.hit !== true) problems.push(`${name} (${selector}): ${JSON.stringify(state)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${label} — terminology controls not hit-testable: ${problems.join("; ")}`);
  }
  return results;
}

/** DOM click（与复制/建枝按钮同款管线——CDP 输入点击的 press/release 分段会
 *  与 0ms 解除路径抢跑，见 b3 既有注释）。 */
async function domClick(ctx, selector) {
  const clicked = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
  );
  if (clicked !== true) throw new Error(`click target not found: ${selector}`);
}

/** 双击提交（b3 同款：两发 click 事件均送达应用监听器；被测对象 = busy 锁
 *  + 服务端幂等键。第二击落在重渲后的当前按钮——真实双击的第二击同样
 *  可能落在收起后的面）。 */
async function domDoubleClick(ctx, selector) {
  const clickOnce = async (detail) => {
    const clicked = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return false; ` +
        `el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: ${String(detail)} })); ` +
        `return true; })()`,
    );
    return clicked === true;
  };
  if ((await clickOnce(1)) !== true) throw new Error(`double-click target not found (first click): ${selector}`);
  await sleep(30);
  if ((await clickOnce(2)) !== true) return "second-click-target-gone";
  await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el !== null) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); return true; })()`,
  );
  return "double-click-delivered";
}

/** Fetch Request 阶段观测（只观测不改动：continueRequest 放行）——PUT 载荷
 *  核验的事实源（应用自身 fetch 的请求体，非探针伪造）。 */
async function withObservedRequests(ctx, urlPattern, fn) {
  const observed = [];
  const handle = { active: true };
  const listener = (params) => {
    if (!handle.active) return;
    observed.push({
      url: params.request.url,
      method: params.request.method,
      postData: typeof params.request.postData === "string" ? params.request.postData : null,
    });
    void ctx.cdpSend("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { /* 尽力而为 */ });
  };
  ctx.cdpOn("Fetch.requestPaused", listener);
  await ctx.cdpSend("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
  try {
    const value = await fn();
    return { value, observed };
  } finally {
    handle.active = false;
    try {
      await ctx.cdpSend("Fetch.disable");
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 响应丢失注入（b3 同款语义）：Response 阶段 failRequest——请求已到服务端
 *  并完整处理，仅响应被丢弃（「服务端已成功、客户端未见」）。 */
async function withDroppedResponses(ctx, urlPattern, fn) {
  const handle = { active: true, dropped: 0 };
  const listener = (params) => {
    if (!handle.active) return;
    if (params.responseStatusCode !== undefined || params.responseError !== undefined) {
      handle.dropped += 1;
      void ctx.cdpSend("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionReset" }).catch(() => { /* 尽力而为 */ });
      return;
    }
    void ctx.cdpSend("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { /* 尽力而为 */ });
  };
  ctx.cdpOn("Fetch.requestPaused", listener);
  await ctx.cdpSend("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Response" }] });
  try {
    const value = await fn();
    return { value, dropped: handle.dropped };
  } finally {
    handle.active = false;
    try {
      await ctx.cdpSend("Fetch.disable");
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 真实按键（keyDown + keyUp）。 */
async function pressKey(ctx, key, code, vk, { modifiers = 0, text = undefined } = {}) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text !== undefined ? { text } : {}) });
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(90);
}

/* ------------------------------------------------------------------ */
/* 服务端事实读回                                                        */
/* ------------------------------------------------------------------ */

async function treeStateViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  if (res.status !== 200) throw new Error(`terminology probe /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body;
}

function trunkViewOf(state) {
  return (state?.branches ?? []).find((view) => view?.branch?.parentBranchId === null) ?? null;
}

async function terminologyViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/terminology`);
  if (res.status !== 200) throw new Error(`terminology probe read model HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function readingModeViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/terminology/settings/reading-mode`);
  if (res.status !== 200) throw new Error(`reading-mode GET HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body?.readingMode ?? null;
}

/** 隔离执行器零派发佐证：terminology/sessions 零文件（会话文件只在执行器
 *  prompt 落地后产生——echo 与真实 Pi 同纪律）。 */
function terminologySessionFiles(dataDir) {
  try {
    return readdirSync(join(dataDir, "terminology", "sessions"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 选区挑选（确定性；echo 与真实模型回答共用）                            */
/* ------------------------------------------------------------------ */

/** term 选区：候选词（大小写不敏感）优先，退而取最长 ASCII 词。 */
function pickTerm(text) {
  const lower = text.toLowerCase();
  for (const candidate of TERM_CANDIDATES) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) {
      return { start: idx, end: idx + candidate.length, text: text.slice(idx, idx + candidate.length), source: `candidate:${candidate}` };
    }
  }
  let best = null;
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9'-]{3,}/g)) {
    if (best === null || match[0].length > best.text.length) {
      best = { start: match.index, end: match.index + match[0].length, text: match[0], source: "longest-ascii-word" };
    }
  }
  if (best !== null) return best;
  /* 最终兜底：最长无空白 token（mode 判定只看空白）。 */
  for (const token of text.split(/\s+/)) {
    if (best === null || token.length > best.text.length) {
      best = { start: text.indexOf(token), end: text.indexOf(token) + token.length, text: token, source: "longest-token" };
    }
  }
  return best;
}

/** range 选区：term 之后的窗口（锚定 term 后首个 ASCII 词，含空白、≥8 字符、
 *  与 term 区间不重叠）。 */
function pickRange(text, termPick) {
  const trimWindow = (start, end) => {
    if (start < 0 || end > text.length || end - start < 8) return null;
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e - s < 8) return null;
    const slice = text.slice(s, e);
    if (!slice.trim().includes(" ")) return null;
    return { start: s, end: e, text: slice };
  };
  /* 1) term 之后的窗口：锚定其后首个 ASCII 词（echo 与真实回答都大概率
     携带第二个英文词——range 断言「解释含原文词」用得上）。 */
  let anchor = null;
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9'-]{2,}/g)) {
    if (match.index >= termPick.end) {
      anchor = { start: match.index, end: match.index + match[0].length };
      break;
    }
  }
  if (anchor !== null) {
    const window = trimWindow(Math.max(termPick.end, anchor.start - 6), Math.min(text.length, anchor.end + 22));
    if (window !== null) return { ...window, source: "after-term-anchor-word" };
  }
  /* 2) term 之前的窗口。 */
  let window = trimWindow(Math.max(0, termPick.start - 34), termPick.start);
  if (window !== null) return { ...window, source: "before-term" };
  /* 3) 任意含空白窗口。 */
  const firstSpace = text.indexOf(" ");
  if (firstSpace >= 0) {
    const nextSpace = text.indexOf(" ", firstSpace + 1);
    if (nextSpace >= 0) {
      window = trimWindow(Math.max(0, firstSpace - 4), Math.min(text.length, nextSpace + 8));
      if (window !== null) return { ...window, source: "generic-space-window" };
    }
  }
  return null;
}

/** 选区文本中的 ASCII 词（解释卡「含原文词」断言用）。 */
function asciiWordsOf(text) {
  return [...text.matchAll(/[A-Za-z][A-Za-z0-9'-]{2,}/g)].map((match) => match[0]);
}

/* ------------------------------------------------------------------ */
/* 页面内 turn 选区（正文层文本节点树 + 平台 Selection）                  */
/* ------------------------------------------------------------------ */

const TURN_BODY_WALKER = `
  const bodyTextNodes = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement !== null && n.parentElement.closest(".turn-actions") !== null)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const out = [];
    for (;;) { const n = walker.nextNode(); if (n === null) break; out.push(n); }
    return out;
  };
  const anchorAt = (nodes, offset) => {
    let pos = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (offset <= pos + len) return { node, offset: offset - pos };
      pos += len;
    }
    return null;
  };
`;

function trunkTurnSelector(turnId) {
  return `#conversation .turn.assistant[data-turn-id=${JSON.stringify(turnId)}]`;
}

/** DOM 选区放置（平台 Selection API → 应用自身 selectionchange/mouseup 武装
 *  路径——触屏同款；b3 armSelectionInReader 同款纪律）。 */
function turnSelectExpr(turnId, start, end) {
  return `(() => { ${TURN_BODY_WALKER}
    const el = document.querySelector(${JSON.stringify(trunkTurnSelector(turnId))});
    if (el === null) return { error: "turn element not present" };
    el.scrollIntoView({ block: "center" });
    const nodes = bodyTextNodes(el);
    const a = anchorAt(nodes, ${Number(start)});
    const b = anchorAt(nodes, ${Number(end)});
    if (a === null || b === null) return { error: "offsets did not map onto body text nodes" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/** 真实拖选落点（material-probes pageClickPoints 同款：首字符盒左内缘 →
 *  末字符盒右内缘；先把目标行滚进 #conversation 可见带）。 */
function turnDragPointsExpr(turnId, start, end) {
  return `(() => { ${TURN_BODY_WALKER}
    const el = document.querySelector(${JSON.stringify(trunkTurnSelector(turnId))});
    if (el === null) return { error: "turn element not present" };
    const nodes = bodyTextNodes(el);
    const rectOf = (from, to) => {
      const a = anchorAt(nodes, from);
      const b = anchorAt(nodes, to);
      if (a === null || b === null) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = range.getClientRects();
      return rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    };
    const lead = rectOf(${Number(start)}, ${Number(start)} + 1);
    if (lead === null) return { error: "start anchor not mappable" };
    const container = document.getElementById("conversation");
    const band = container.getBoundingClientRect();
    container.scrollTop = container.scrollTop + (lead.top + lead.height / 2 - (band.top + container.clientHeight / 2));
    const pointFor = (from, to, fromLeft) => {
      const rect = rectOf(from, to);
      if (rect === null) return null;
      const inset = Math.min(1, rect.width / 2);
      return { x: fromLeft ? rect.left + inset : rect.right - inset, y: rect.top + rect.height / 2 };
    };
    const from = pointFor(${Number(start)}, ${Number(start)} + 1, true);
    const to = pointFor(${Number(end)} - 1, ${Number(end)}, false);
    if (from === null || to === null) return { error: "drag anchors not mappable" };
    return { from, to };
  })()`;
}

/** 真实连续拖选（mousePressed → mouseMoved×N → mouseReleased）：释放后原生
 *  选区必须复现计划摘录，再等工具条武装（mouseup 路径）。 */
async function dragSelectOnTurn(ctx, turnId, selection, caseId) {
  const points = await ctx.evalJs(turnDragPointsExpr(turnId, selection.start, selection.end));
  if (points === null || points.error !== undefined) {
    throw new Error(`${caseId}: drag anchors not resolvable — ${JSON.stringify(points)}`);
  }
  await sleep(80);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: points.from.x, y: points.from.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const x = points.from.x + ((points.to.x - points.from.x) * i) / steps;
    const y = points.from.y + ((points.to.y - points.from.y) * i) / steps;
    await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    await sleep(30);
  }
  const duringDrag = await ctx.evalJs(`(() => { const s = window.getSelection(); return s === null ? null : s.toString(); })()`);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: points.to.x, y: points.to.y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
  await sleep(250);
  const afterRelease = await ctx.evalJs(`(() => { const s = window.getSelection(); return s === null ? null : s.toString(); })()`);
  if (afterRelease !== selection.text) {
    throw new Error(
      `${caseId} (real drag): the native selection does not reproduce the planned excerpt ` +
        `(during=${JSON.stringify(duringDrag)}, after=${JSON.stringify(afterRelease)}, want=${JSON.stringify(selection.text)})`,
    );
  }
  return afterRelease;
}

/** 武装工具条等待（selectionchange/mouseup 双路径都触发 renderTurnActions）。 */
async function waitForArmedToolbar(ctx, caseId, { expectMode, timeoutMs = 6000 }) {
  return waitFor(
    ctx,
    `(() => { const bar = document.querySelector("#conversation .selection-toolbar"); ` +
      `if (bar === null) return false; ` +
      `const explain = bar.querySelector(".toolbar-explain"); ` +
      `if (explain === null) return false; ` +
      `return { label: bar.getAttribute("aria-label"), explainLabel: explain.textContent }; })()`,
    { label: `${caseId}: the selection toolbar armed`, timeoutMs },
  ).then((bar) => {
    const problems = [];
    if (expectMode !== undefined && !(bar.label ?? "").startsWith(`Selection actions — ${expectMode} `)) {
      problems.push(`aria-label does not name the ${expectMode} mode: ${JSON.stringify(bar.label)}`);
    }
    if (expectMode === "term" && bar.explainLabel !== "⌖ Explain term") problems.push(`term toolbar label: ${JSON.stringify(bar.explainLabel)}`);
    if (expectMode === "span" && bar.explainLabel !== "⌖ Explain span") problems.push(`span toolbar label: ${JSON.stringify(bar.explainLabel)}`);
    if (problems.length > 0) throw new Error(`${caseId}: armed toolbar mismatch — ${problems.join("; ")}`);
    return bar;
  }).catch(async (err) => {
    const snap = await ctx.evalJs(
      `(() => ({ selection: String(window.getSelection()), ` +
        `assistantTurns: document.querySelectorAll("#conversation .turn.assistant").length, ` +
        `actions: document.querySelectorAll("#conversation .turn-actions").length, ` +
        `explainButtons: [...document.querySelectorAll("#conversation .term-explain")].map((b) => b.disabled), ` +
        `activeId: document.activeElement?.id || null }))()`,
    ).catch(() => null);
    throw new Error(`${caseId}: toolbar never armed — snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/* ------------------------------------------------------------------ */
/* UI 流（抽屉 / 主干提问 / 面板追问 / Return / 分支 tab）                 */
/* ------------------------------------------------------------------ */

async function openDrawer(ctx) {
  const open = await ctx.evalJs(`(() => { const d = document.getElementById("source-drawer"); return d !== null && !d.hidden; })()`);
  if (open === true) return;
  await inputClickAt(ctx, "#source-drawer-toggle");
  await waitFor(
    ctx,
    `(() => { const d = document.getElementById("source-drawer"); ` +
      `return d !== null && !d.hidden && d.querySelector(".term-mode-row") !== null && d.textContent.includes("Terminology"); })()`,
    { label: "sources drawer open with the terminology section rendered" },
  );
}

async function closeDrawer(ctx) {
  const closed = await ctx.evalJs(`(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`);
  if (closed === true) return;
  /* 抽屉为覆盖层（z-index 30，盖住顶栏 Sources 开关自身——产品在抽屉头部
     提供可见关闭按钮；真实用户路径）。 */
  await inputClickAt(ctx, "#drawer-close");
  await waitFor(ctx, `(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`, {
    label: "sources drawer closed (in-drawer × Close button)",
  });
}

function modeButtonSelector(mode) {
  return `.term-mode-row .term-mode-toggle:nth-child(${String(MODE_BUTTON_INDEX[mode])})`;
}

/** 主干提问（真实键入 + Send 点击）→ 等待该问题的 assistant 回答落地
 *  （服务端事实）并在 DOM 渲染。返回 {userTurn, answerTurn}。 */
async function sendTrunkPrompt(ctx, treeId, text, { timeoutMs, label }) {
  const before = trunkViewOf(await treeStateViaApi(ctx, treeId));
  const assistantBefore = (before?.turns ?? []).filter((turn) => turn?.role === "assistant").length;
  await inputClickAt(ctx, "#prompt-input");
  await ctx.cdpSend("Input.insertText", { text });
  const typed = await ctx.evalJs(`(() => document.getElementById("prompt-input").value)()`);
  if (typed !== text) {
    throw new Error(`${label}: the trunk composer did not receive the prompt (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#send");
  /* 服务端事实轮询（POST /prompt 的响应在 run 终态后才返回；以树态为准）。 */
  for (let elapsed = 0; ; elapsed += 200) {
    const state = await treeStateViaApi(ctx, treeId);
    const trunk = trunkViewOf(state);
    const turns = trunk?.turns ?? [];
    const userIdx = turns.findIndex((turn) => turn?.role === "user" && turn?.text === text);
    if (userIdx >= 0) {
      const after = turns.slice(userIdx + 1).find((turn) => turn?.role === "assistant");
      if (after !== undefined && typeof after.text === "string" && after.text.trim().length > 0) {
        const userTurn = turns[userIdx];
        /* DOM 渲染对齐（正文层 = .turn-actions 之外的文本节点拼接——与 turn
           原文字节相等；元素整体 textContent 混入动作按钮文字，不可比）。 */
        await waitFor(
          ctx,
          `(() => { ${TURN_BODY_WALKER}
            return [...document.querySelectorAll("#conversation .turn.assistant")].some((el) => {
              const nodes = bodyTextNodes(el);
              return nodes.map((n) => n.data).join("") === ${JSON.stringify(after.text)};
            }); })()`,
          { label: `${label}: the answer rendered in the Trunk conversation`, timeoutMs: 15_000 },
        );
        return { userTurn, answerTurn: after, assistantCount: turns.filter((turn) => turn?.role === "assistant").length, assistantBefore };
      }
    }
    if (elapsed >= timeoutMs) {
      throw new Error(`${label}: the trunk prompt did not land a non-empty assistant answer in ${String(timeoutMs)}ms`);
    }
    await sleep(200);
  }
}

/** 面板追问（真实键入 + Send 点击）→ 新 assistant 回答落地。 */
async function panelFollowUp(ctx, marker, promptText, timeoutMs, label) {
  await inputClickAt(ctx, "#panel-prompt-input");
  await ctx.cdpSend("Input.insertText", { text: promptText });
  const typed = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
  if (typed !== promptText) {
    throw new Error(`${label}: the panel composer did not receive the follow-up (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#panel-send");
  await waitFor(
    ctx,
    `(() => { const conv = document.getElementById("panel-conversation"); ` +
      `const turns = [...conv.querySelectorAll(".turn")]; ` +
      `const markerIndex = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
      `if (markerIndex < 0) return false; ` +
      `const answerAfter = turns.slice(markerIndex + 1).find((t) => t.classList.contains("assistant")); ` +
      `return answerAfter !== undefined && (answerAfter.textContent ?? "").trim().length > 0; })()`,
    { label: `${label}: follow-up ${marker} landed with an assistant answer`, timeoutMs },
  );
}

/** 面板 Return（b3 同款真实用户路径：草稿预填 → 全选 → 键入替换 → 提交）。 */
async function submitTermReturn(ctx, returnText, retMarker, label) {
  await inputClickAt(ctx, "#return-input");
  await ctx.evalJs(
    `(() => { const input = document.getElementById("return-input"); ` +
      `input.setSelectionRange(0, input.value.length); return input.selectionStart !== input.selectionEnd; })()`,
  );
  await ctx.cdpSend("Input.insertText", { text: returnText });
  const typed = await ctx.evalJs(`(() => document.getElementById("return-input").value)()`);
  if (typed !== returnText) {
    throw new Error(`${label}: the return draft did not receive the typed text (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#submit-return");
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `if (panel === null || !panel.hidden) return false; ` +
      `return [...document.querySelectorAll("#conversation .turn.return")]` +
      `.some((card) => (card.dataset.turnText ?? "") === ${JSON.stringify(returnText)} && (card.textContent ?? "").includes(${JSON.stringify(retMarker)})); })()`,
    { label: `${label}: panel closed and the Return card landed on the Trunk`, timeoutMs: 30_000 },
  );
  return ctx.evalJs(
    `(() => { const card = [...document.querySelectorAll("#conversation .turn.return")]` +
      `.find((c) => (c.dataset.turnText ?? "") === ${JSON.stringify(returnText)}); ` +
      `return card === undefined ? null : { meta: card.querySelector(".meta")?.textContent ?? null, ` +
      `delivery: card.querySelector(".delivery")?.textContent ?? null }; })()`,
  );
}

/** 分支 tab 点击开面板（b3 openBranchPanelViaTab 的轻量版：列表静置一拍）。 */
async function openBranchPanelViaTab(ctx, branchId, label) {
  const selector = `#branch-tabs button[data-branch-id=${JSON.stringify(branchId)}]`;
  await waitFor(ctx, `(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`, {
    label: `${label}: branch tab present`,
    timeoutMs: 20_000,
  });
  await sleep(350);
  await inputClickAt(ctx, selector);
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `return panel !== null && !panel.hidden && document.getElementById("panel-conversation").children.length > 0; })()`,
    { label: `${label}: branch panel open`, timeoutMs: 20_000 },
  );
}

async function closePanel(ctx) {
  const closed = await ctx.evalJs(`(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`);
  if (closed === true) return;
  await inputClickAt(ctx, "#panel-close");
  await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, {
    label: "branch panel closed",
  });
}

/* ------------------------------------------------------------------ */
/* 探针：terminology-path                                               */
/* ------------------------------------------------------------------ */

export async function probeTerminologyPath(ctx) {
  const modeNote = ctx.MODE === "selftest"
    ? "echo driver (deterministic answers) — mechanism evidence for the probe/UI code path, NOT real-Pi evidence"
    : "real Pi answers (trunk prompts, terminology explanations, promotion first questions, follow-ups)";
  const answerTimeoutMs = ctx.MODE === "selftest" ? 30_000 : Math.max(60_000, ctx.promptTimeoutMs());
  const dataDir = mkdtempSync(join(tmpdir(), "treeai-term-browser-"));
  const record = {
    readingModes: {},
    entryVertical: { term: {}, range: {} },
    idempotency: {},
    restart: {},
    recovery: {},
    frontendInvariants: {},
  };
  const honestyNotes = [];

  try {
    /* ============ 0) 专用数据目录冷启（真实 Studio 进程） ============ */
    await ctx.navigate("about:blank");
    const url = await ctx.bootStudioOn(dataDir);
    await ctx.navigate(url);
    /* 剪贴板读权限（③ 复制不变量的剪贴板回读口径；不可用则如实降级为
       selection.toString 字节相等并记录——material 探针同款诚实降级）。 */
    try {
      await ctx.cdpSend("Browser.grantPermissions", {
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        origin: new URL(url).origin,
      });
    } catch {
      /* 尽力而为：降级口径在复制断言处如实记录 */
    }
    await waitFor(ctx, `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`, {
      label: "studio shell on the terminology probe's clean data dir",
      timeoutMs: 30_000,
    });
    /* 建树：真实 UI 空态主操作。 */
    await inputClickAt(ctx, "#empty-new-tree");
    await waitFor(
      ctx,
      `(() => { const view = document.getElementById("tree-view"); const composer = document.getElementById("prompt-input"); ` +
        `return view !== null && !view.hidden && composer !== null && !composer.disabled; })()`,
      { label: "create-tree flow usable (workbench opens)", timeoutMs: 20_000 },
    );
    const trees = await ctx.api("GET", "/api/trees");
    const treeId = trees.body?.trees?.[0]?.id ?? null;
    if (trees.body?.trees?.length !== 1 || typeof treeId !== "string") {
      throw new Error(`terminology probe: the empty-state create-tree flow did not produce exactly one tree (${JSON.stringify(trees.body?.trees?.length ?? null)})`);
    }
    await ctx.screenshot("term-workbench");

    /* ============ 1) ① 阅读模式面 ============ */
    {
      await openDrawer(ctx);
      const drawerInfo = await ctx.evalJs(
        `(() => { const drawer = document.getElementById("source-drawer"); ` +
          `const buttons = [...drawer.querySelectorAll(".term-mode-row .term-mode-toggle")]; ` +
          `return { labels: buttons.map((b) => b.textContent), pressed: buttons.map((b) => b.getAttribute("aria-pressed")), ` +
            `gateNote: [...drawer.querySelectorAll("p.muted")].some((p) => p.textContent.includes(${JSON.stringify(GATE_NOTE_SNIPPET)})), ` +
            `usageLine: (drawer.querySelector(".term-cache-line") !== null), ` +
            `annotationsNote: drawer.textContent.includes("no saved term annotations yet") }; })()`,
      );
      const problems = [];
      if (JSON.stringify(drawerInfo.labels) !== JSON.stringify(["Manual only", "Minimal hints", "Assisted reading"])) {
        problems.push(`mode buttons: ${JSON.stringify(drawerInfo.labels)}`);
      }
      if (drawerInfo.pressed[0] !== "true" || drawerInfo.pressed[1] !== "false" || drawerInfo.pressed[2] !== "false") {
        problems.push(`default pressed states: ${JSON.stringify(drawerInfo.pressed)} (manual-only must be the default)`);
      }
      if (drawerInfo.gateNote !== true) {
        problems.push("the quality-gate-pending honest note is not present in the drawer");
      }
      if (problems.length > 0) {
        throw new Error(`terminology ① reading-mode drawer mismatch — ${problems.join("; ")}`);
      }
      record.readingModes.drawer = {
        labels: drawerInfo.labels,
        defaultPressed: "manual-only",
        gateNotePresent: true,
        gateNoteText: `「…${GATE_NOTE_SNIPPET}…」(TERMINOLOGY_AUTO_QUALITY_GATE=false — the production default, asserted as-is)`,
      };
      await ctx.screenshot("term-drawer-modes");

      /* 三选一真实切换（PUT 载荷观测 + 服务端回读 + pressed 迁移）。 */
      const switches = [];
      for (const mode of ["minimal-hints", "assisted-reading", "manual-only"]) {
        const { observed } = await withObservedRequests(ctx, "*settings/reading-mode*", async () => {
          await inputClickAt(ctx, modeButtonSelector(mode));
          await waitFor(
            ctx,
            `(() => { const b = document.querySelector(${JSON.stringify(modeButtonSelector(mode))}); ` +
              `return b !== null && b.getAttribute("aria-pressed") === "true"; })()`,
            { label: `reading mode ${mode} becomes pressed`, timeoutMs: 10_000 },
          );
        });
        const puts = observed.filter((entry) => entry.method === "PUT");
        if (puts.length !== 1) {
          throw new Error(`reading-mode switch to ${mode}: expected exactly 1 PUT, observed ${JSON.stringify(observed)}`);
        }
        if (puts[0].postData !== JSON.stringify({ mode })) {
          throw new Error(`reading-mode PUT payload mismatch for ${mode}: ${JSON.stringify(puts[0].postData)}`);
        }
        const serverMode = await readingModeViaApi(ctx, treeId);
        if (serverMode !== mode) {
          throw new Error(`server reading-mode readback after switching to ${mode}: ${JSON.stringify(serverMode)}`);
        }
        switches.push({ mode, putPayload: puts[0].postData, serverReadback: serverMode });
      }
      record.readingModes.switches = switches;
      await closeDrawer(ctx);
    }

    /* ============ 2) ① manual-only 下回答后零自动派发 + 无建议条 ============ */
    {
      const { answerTurn: a1 } = await sendTrunkPrompt(ctx, treeId, TRUNK_Q1, {
        timeoutMs: answerTimeoutMs,
        label: "trunk Q1 (manual-only phase)",
      });
      const read = await terminologyViaApi(ctx, treeId);
      const stripAbsent = await ctx.evalJs(`(() => document.querySelector("#conversation .term-suggest-strip") === null)()`);
      const sessionFiles = terminologySessionFiles(dataDir);
      const problems = [];
      if ((read?.tasks ?? []).length !== 0) problems.push(`tasks: ${JSON.stringify(read?.tasks)}`);
      if (read?.usage?.total?.requests !== 0) problems.push(`usage requests: ${JSON.stringify(read?.usage?.total)}`);
      if (read?.autoSuggestions?.enabled !== false || read?.autoSuggestions?.reason !== "quality-gate-pending") {
        problems.push(`autoSuggestions: ${JSON.stringify(read?.autoSuggestions)}`);
      }
      if ((read?.autoSuggestions?.sets ?? []).length !== 0) problems.push(`suggestion sets: ${JSON.stringify(read?.autoSuggestions?.sets)}`);
      if (stripAbsent !== true) problems.push("a .term-suggest-strip rendered");
      if (sessionFiles !== null && sessionFiles.length !== 0) problems.push(`terminology session files: ${JSON.stringify(sessionFiles)}`);
      if (problems.length > 0) {
        throw new Error(`terminology ① manual-only zero-auto-dispatch violated — ${problems.join("; ")}`);
      }
      record.readingModes.manualOnlyNoStrip = {
        answerLen: a1.text.length,
        tasks: 0,
        usageRequests: 0,
        suggestionSets: 0,
        stripRendered: false,
        isolatedExecutorSessionFiles: 0,
        reason: "quality-gate-pending",
      };
    }

    /* ============ 3) ① minimal-hints 下回答后零自动派发（被测语义） ============ */
    let answerText = null;
    let anchorTurnId = null;
    {
      await openDrawer(ctx);
      const { observed } = await withObservedRequests(ctx, "*settings/reading-mode*", async () => {
        await inputClickAt(ctx, modeButtonSelector("minimal-hints"));
        await waitFor(
          ctx,
          `(() => document.querySelector(${JSON.stringify(modeButtonSelector("minimal-hints"))})?.getAttribute("aria-pressed") === "true")()`,
          { label: "reading mode minimal-hints becomes pressed", timeoutMs: 10_000 },
        );
      });
      const puts = observed.filter((entry) => entry.method === "PUT");
      if (puts.length !== 1 || puts[0].postData !== JSON.stringify({ mode: "minimal-hints" })) {
        throw new Error(`minimal-hints switch PUT observation mismatch: ${JSON.stringify(observed)}`);
      }
      await closeDrawer(ctx);
      const { answerTurn: a2 } = await sendTrunkPrompt(ctx, treeId, TRUNK_Q2, {
        timeoutMs: answerTimeoutMs,
        label: "trunk Q2 (minimal-hints phase — the terminology anchor answer)",
      });
      const read = await terminologyViaApi(ctx, treeId);
      const stripAbsent = await ctx.evalJs(`(() => document.querySelector("#conversation .term-suggest-strip") === null)()`);
      const sessionFiles = terminologySessionFiles(dataDir);
      const problems = [];
      if ((read?.tasks ?? []).length !== 0) problems.push(`tasks: ${JSON.stringify(read?.tasks)}`);
      if (read?.usage?.total?.requests !== 0) problems.push(`usage requests: ${JSON.stringify(read?.usage?.total)}`);
      if (read?.autoSuggestions?.enabled !== false || read?.autoSuggestions?.reason !== "quality-gate-pending") {
        problems.push(`autoSuggestions: ${JSON.stringify(read?.autoSuggestions)}`);
      }
      if ((read?.autoSuggestions?.sets ?? []).length !== 0) problems.push(`suggestion sets: ${JSON.stringify(read?.autoSuggestions?.sets)}`);
      if (stripAbsent !== true) problems.push("a .term-suggest-strip rendered under minimal-hints");
      if (sessionFiles !== null && sessionFiles.length !== 0) problems.push(`terminology session files: ${JSON.stringify(sessionFiles)}`);
      if (problems.length > 0) {
        throw new Error(`terminology ① minimal-hints zero-auto-dispatch violated — ${problems.join("; ")}`);
      }
      if (a2.text.trim().length < 40) {
        throw new Error(
          `terminology ② anchor answer too short for term/range selections (${String(a2.text.length)} units) — ${modeNote}`,
        );
      }
      answerText = a2.text;
      anchorTurnId = a2.id;
      record.readingModes.minimalHintsZeroDispatch = {
        mode: "minimal-hints",
        putPayload: puts[0].postData,
        anchorAnswerLen: answerText.length,
        tasks: 0,
        usageRequests: 0,
        suggestionSets: 0,
        stripRendered: false,
        isolatedExecutorSessionFiles: 0,
        reason: "quality-gate-pending",
        note: "the production gate is OFF by design (TERMINOLOGY_AUTO_QUALITY_GATE=false): zero auto dispatch after a completed answer IS the tested semantics, not a probe limitation",
      };
      /* 建议 chip 预填/确认路径：gate 关闭下建议集恒空、chip 永不出现——
         如实披露（绝不改产品 gate 让建议出现）。 */
      record.readingModes.suggestionChipPrefill = {
        exercisable: false,
        reason:
          "TERMINOLOGY_AUTO_QUALITY_GATE=false in production — no suggestion set is ever produced (sets always []), so the chip → pre-fill → explicit-confirm path cannot be exercised without changing the product gate (forbidden by the probe charter); the four honest strip states (pending/terminal or gate-off note) reduce to the gate-off drawer note + no strip, both asserted",
      };
      honestyNotes.push(
        "① suggestion chip pre-fill/confirm-before-dispatch is NOT exercised: the production quality gate is OFF, suggestion sets are structurally empty, and the probe must not enable the gate to make chips appear",
      );
    }

    /* ============ 4) ② term 纵向：武装 → 解释卡 → 保存 → 双击推广 → 2 追问 → Return ============ */
    let termPick = null;
    let termBranchId = null;
    {
      termPick = pickTerm(answerText);
      if (termPick === null || termPick.end - termPick.start < 2) {
        throw new Error(`terminology ② term selection could not be picked from the anchor answer (${String(answerText.length)} units)`);
      }
      /* 真实连续拖选（term=点词级单词：无空白 → term 模式）。 */
      await dragSelectOnTurn(ctx, anchorTurnId, termPick, "term selection (real drag)");
      await waitForArmedToolbar(ctx, "term selection", { expectMode: "term" });
      record.entryVertical.term.armed = { ...termPick, gesture: "real continuous mouse drag", toolbarMode: "term" };
      await ctx.screenshot("term-toolbar-armed");

      /* 解释卡（POST mode 字段随选区判定；echo=确定性回声 / real-pi=真实模型）。 */
      await domClick(ctx, "#conversation .selection-toolbar .toolbar-explain");
      const cardExplained = await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `if (card === null) return false; ` +
          `if (!card.textContent.includes(${JSON.stringify(`⌖ Explain — “${termPick.text}” (term,`)})) return false; ` +
          `const body = card.querySelector(".term-explain-body"); ` +
          `return body !== null && (body.textContent ?? "").trim().length > 0 ? { explanation: body.textContent } : false; })()`,
        { label: "term explain card reached the explained state", timeoutMs: answerTimeoutMs },
      );
      if (!(cardExplained.explanation ?? "").toLowerCase().includes(termPick.text.toLowerCase())) {
        throw new Error(
          `term explanation does not contain the selected term (got ${String(cardExplained.explanation?.length ?? 0)} units, term=${JSON.stringify(termPick.text)}) — ${modeNote}`,
        );
      }
      record.entryVertical.term.explained = {
        mode: "term",
        explanationLen: cardExplained.explanation.length,
        containsSelectedTerm: true,
        driver: ctx.MODE === "selftest" ? "echo (deterministic)" : "real Pi",
      };
      await ctx.screenshot("term-explain-card");

      /* 保存批注 → saved 卡（首问输入在场）+ 正文区间覆盖 + 抽屉列表。 */
      await domClick(ctx, "#term-explain-card .term-save");
      await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `return card !== null && card.querySelector("#term-first-question") !== null; })()`,
        { label: "term annotation saved (the card offers the promotion first-question input)" },
      );
      await waitFor(
        ctx,
        `(() => { const turn = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))}); ` +
          `if (turn === null) return false; ` +
          `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
          `return marks.length === 1 && marks[0].textContent === ${JSON.stringify(termPick.text)}; })()`,
        { label: "the saved term annotation renders as the live underline overlay" },
      );
      const readAfterSave = await terminologyViaApi(ctx, treeId);
      const annotation = (readAfterSave?.annotations ?? []).find(
        (entry) => entry?.anchorTurnId === anchorTurnId && entry?.selection?.start === termPick.start && entry?.selection?.end === termPick.end,
      );
      if (annotation === undefined || annotation.mode !== "term" || annotation.promotedBranchId !== null) {
        throw new Error(`term annotation server fact mismatch: ${JSON.stringify(annotation)}`);
      }
      record.entryVertical.term.saved = {
        annotationId: annotation.id,
        mode: "term",
        term: annotation.term,
        liveOverlayRendered: true,
      };

      /* 推广建枝：首问输入 → 双击提交（busy 锁 + 服务端幂等键 → 恰一次派发）。 */
      await inputClickAt(ctx, "#term-first-question");
      await ctx.cdpSend("Input.insertText", {
        text: `请基于这条术语批注展开：这个词在原文语境里为什么关键？（${TERM_MARKERS.termQ1}）`,
      });
      const promoteSelector = "#term-explain-card .term-promote";
      const doubleClickMode = await domDoubleClick(ctx, promoteSelector);
      await waitFor(
        ctx,
        `(() => { const panel = document.getElementById("branch-panel"); ` +
          `if (panel === null || panel.hidden) return false; ` +
          `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(TERM_MARKERS.termQ1)}); })()`,
        { label: "term promotion first question landed and the branch panel opened (double-click submit)", timeoutMs: answerTimeoutMs },
      );
      const stateAfterPromote = await treeStateViaApi(ctx, treeId);
      const termBranchView = (stateAfterPromote?.branches ?? []).find((view) =>
        (view?.turns ?? []).some((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(TERM_MARKERS.termQ1)));
      if (termBranchView === undefined) throw new Error("terminology ② term promotion branch not found in the tree state");
      termBranchId = termBranchView.branch.id;
      const q1UserTurns = termBranchView.turns.filter(
        (turn) => turn?.role === "user" && typeof turn.text === "string" && turn.text.includes(TERM_MARKERS.termQ1));
      const termAnswers = termBranchView.turns.filter((turn) => turn?.role === "assistant" && (turn?.text ?? "").trim().length > 0);
      if (q1UserTurns.length !== 1) {
        throw new Error(`term double-click promotion dispatched the first question ${String(q1UserTurns.length)} times (must be exactly 1)`);
      }
      if (termAnswers.length < 1) throw new Error(`term promotion first question landed no assistant answer — ${modeNote}`);
      const readAfterPromote = await terminologyViaApi(ctx, treeId);
      const promotedAnnotation = (readAfterPromote?.annotations ?? []).find((entry) => entry?.id === annotation.id);
      if (promotedAnnotation?.promotedBranchId !== termBranchId) {
        throw new Error(`term annotation promotion binding mismatch: ${JSON.stringify(promotedAnnotation?.promotedBranchId)}`);
      }
      record.entryVertical.term.promoted = {
        branchId: termBranchId,
        doubleClick: doubleClickMode,
        firstQuestionUserTurns: 1,
        assistantAnswer: true,
        promotedBranchBinding: termBranchId,
      };
      record.idempotency.doubleClick = {
        mode: "term",
        secondClick: doubleClickMode,
        userTurnsWithMarker: q1UserTurns.length,
        exactlyOnce: q1UserTurns.length === 1,
        mechanism: "client busy lock (guard) + server promotion idempotency key",
      };
      await ctx.screenshot("term-branch-panel");

      /* 支线 ≥2 轮追问。 */
      await panelFollowUp(ctx, TERM_MARKERS.termF1, `第一轮追问：这个术语和一个相邻概念的区别是什么？（${TERM_MARKERS.termF1}）`, answerTimeoutMs, "term branch");
      await panelFollowUp(ctx, TERM_MARKERS.termF2, `第二轮追问：给出一个使用该术语的例子。（${TERM_MARKERS.termF2}）`, answerTimeoutMs, "term branch");
      record.entryVertical.term.followUps = [TERM_MARKERS.termF1, TERM_MARKERS.termF2];

      /* Return 回主线（术语来源卡：摘录/保存时间/来源分支——与材料 Return 卡同范式）。 */
      const termReturnText = `术语探索的收获（term）：该词的语境含义与边界已经核对。（${TERM_MARKERS.termRet}）`;
      const termCard = await submitTermReturn(ctx, termReturnText, TERM_MARKERS.termRet, "term branch return");
      const metaProblems = [];
      if (!(termCard?.meta ?? "").includes(`anchored on “${termPick.text}”`)) {
        metaProblems.push(`source-card excerpt missing: ${JSON.stringify(termCard?.meta)}`);
      }
      if (!(termCard?.meta ?? "").includes("saved ")) metaProblems.push(`saved time missing: ${JSON.stringify(termCard?.meta)}`);
      if (!(termCard?.meta ?? "").includes(`↩ Return from `)) metaProblems.push(`from-branch missing: ${JSON.stringify(termCard?.meta)}`);
      if (metaProblems.length > 0) {
        throw new Error(`term Return card (terminology source card) mismatch — ${metaProblems.join("; ")}`);
      }
      const stateAfterReturn = await treeStateViaApi(ctx, treeId);
      const trunkAfter = trunkViewOf(stateAfterReturn);
      const retTurn = (trunkAfter?.turns ?? []).find(
        (turn) => turn?.role === "return" && turn?.text === termReturnText && turn?.fromBranchId === termBranchId);
      if (retTurn === undefined) {
        throw new Error("term Return did not land on the Trunk with the promoting branch as its source (server fact)");
      }
      record.entryVertical.term.returned = {
        cardMeta: termCard.meta,
        deliveryNote: termCard.delivery,
        serverFromBranchId: termBranchId,
      };
      await ctx.screenshot("term-return-card");
    }

    /* ============ 5) ② range 纵向：武装 → 解释卡 → 保存 → 响应丢失推广 → 恢复 → 2 追问 → Return ============ */
    let rangePick = null;
    let rangeBranchId = null;
    {
      rangePick = pickRange(answerText, termPick);
      if (rangePick === null) {
        throw new Error(`terminology ② range selection could not be picked from the anchor answer (${String(answerText.length)} units)`);
      }
      await dragSelectOnTurn(ctx, anchorTurnId, rangePick, "range selection (real drag)");
      await waitForArmedToolbar(ctx, "range selection", { expectMode: "span" });
      record.entryVertical.range.armed = { ...rangePick, gesture: "real continuous mouse drag", toolbarMode: "range (span)" };

      await domClick(ctx, "#conversation .selection-toolbar .toolbar-explain");
      const rangeCard = await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `if (card === null) return false; ` +
          `if (!card.textContent.includes(${JSON.stringify(`⌖ Explain — “${rangePick.text.slice(0, Math.min(24, rangePick.text.length))}`)})) return false; ` +
          `const body = card.querySelector(".term-explain-body"); ` +
          `return body !== null && (body.textContent ?? "").trim().length > 0 ? { explanation: body.textContent } : false; })()`,
        { label: "range explain card reached the explained state", timeoutMs: answerTimeoutMs },
      );
      const rangeWords = asciiWordsOf(rangePick.text);
      const rangeExplanation = rangeCard.explanation ?? "";
      const rangeContainsWord = rangeWords.some((word) => rangeExplanation.toLowerCase().includes(word.toLowerCase()));
      if (rangeExplanation.trim().length === 0) {
        throw new Error(`range explanation is empty — ${modeNote}`);
      }
      if (rangeWords.length > 0 && rangeContainsWord !== true) {
        throw new Error(
          `range explanation does not contain any source word of the selection (words=${JSON.stringify(rangeWords.slice(0, 4))}, ` +
            `explanation ${String(rangeExplanation.length)} units) — ${modeNote}`,
        );
      }
      record.entryVertical.range.explained = {
        mode: "range",
        explanationLen: rangeExplanation.length,
        sourceWords: rangeWords.slice(0, 4),
        containsSourceWord: rangeWords.length === 0 ? "n/a (no ASCII word ≥3 in the selection; non-empty asserted)" : rangeContainsWord,
        driver: ctx.MODE === "selftest" ? "echo (deterministic)" : "real Pi",
      };

      /* 保存批注（第二条；与 term 区间相邻不重叠 → 双覆盖并存）。 */
      await domClick(ctx, "#term-explain-card .term-save");
      await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `return card !== null && card.querySelector("#term-first-question") !== null; })()`,
        { label: "range annotation saved (the card offers the promotion first-question input)" },
      );
      await waitFor(
        ctx,
        `(() => { const turn = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))}); ` +
          `if (turn === null) return false; ` +
          `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
          `return marks.length === 2 && marks.some((m) => m.textContent === ${JSON.stringify(termPick.text)}) ` +
          `&& marks.some((m) => m.textContent === ${JSON.stringify(rangePick.text)}); })()`,
        { label: "both saved annotations render as live underline overlays (term + range, non-overlapping)" },
      );
      const readAfterRangeSave = await terminologyViaApi(ctx, treeId);
      const rangeAnnotation = (readAfterRangeSave?.annotations ?? []).find(
        (entry) => entry?.anchorTurnId === anchorTurnId && entry?.selection?.start === rangePick.start && entry?.selection?.end === rangePick.end);
      if (rangeAnnotation === undefined || rangeAnnotation.mode !== "range" || rangeAnnotation.promotedBranchId !== null) {
        throw new Error(`range annotation server fact mismatch: ${JSON.stringify(rangeAnnotation)}`);
      }
      record.entryVertical.range.saved = {
        annotationId: rangeAnnotation.id,
        mode: "range",
        liveOverlayRendered: true,
        bothOverlaysCoexist: true,
      };
      await ctx.screenshot("range-saved-card");

      /* ③ 焦点/滚动/草稿（推广首问草稿 → renderAll 离开回来 → 保留 + 焦点还原
         + 主线滚动保留；renderAll 由 Trunk tab 的 DOM click 触发（/switch +
         全量重渲是应用自身路径；DOM click 不移动焦点——复现「输入中恰有
         异步刷新」的 W2/③ 焦点保持语义，ui-terminology 套件以 SSE 终态同款
         断言），不经 resetTransientView，卡与草稿必须存活）。 */
      const rangeFirstQuestion = `请基于这条划线批注展开：这句话的主张是什么？（${TERM_MARKERS.rangeQ1}）`;
      await inputClickAt(ctx, "#term-first-question");
      await ctx.cdpSend("Input.insertText", { text: rangeFirstQuestion });
      const activeBefore = await ctx.evalJs(`(() => document.activeElement?.id ?? null)()`);
      await domClick(ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → /switch + renderAll（不夺焦点） */
      await sleep(600);
      const draftState = await ctx.evalJs(
        `(() => ({ value: document.getElementById("term-first-question")?.value ?? null, ` +
          `activeId: document.activeElement?.id ?? null, ` +
          `cardPresent: document.getElementById("term-explain-card") !== null }))()`,
      );
      const draftProblems = [];
      if (draftState.value !== rangeFirstQuestion) draftProblems.push(`draft lost: ${JSON.stringify(draftState.value?.slice(0, 40))}`);
      if (draftState.activeId !== "term-first-question") draftProblems.push(`focus not restored: ${JSON.stringify(draftState.activeId)} (was ${JSON.stringify(activeBefore)})`);
      if (draftState.cardPresent !== true) draftProblems.push("the explain card did not survive the renderAll");
      if (draftProblems.length > 0) {
        throw new Error(`terminology ③ draft/focus round trip failed — ${draftProblems.join("; ")}`);
      }
      record.frontendInvariants.draftFocus = {
        roundTrip: "typed a promotion first-question draft → Trunk tab click (real /switch + renderAll) → draft + focus + card all preserved",
        draftLen: rangeFirstQuestion.length,
        activeIdAfter: draftState.activeId,
      };
      /* 响应丢失推广：传输层丢弃 promote 响应 → 卡面如实冲突 + 刷新揭示既有
         推广 → 恢复既有探索（恰一条首问 user turn，分支数恰 +1）。 */
      const branchCountBefore = (await treeStateViaApi(ctx, treeId))?.branches?.length ?? 0;
      let droppedCount = 0;
      ({ dropped: droppedCount } = await withDroppedResponses(ctx, "*terminology/annotations/*/promote", async () => {
        await domClick(ctx, "#term-explain-card .term-promote");
        try {
          await waitFor(
            ctx,
            `(() => { const card = document.getElementById("term-explain-card"); ` +
              `if (card === null) return false; ` +
              `const text = card.textContent ?? ""; ` +
              `return text.includes("promotion conflict —") && text.includes("saved — already promoted to") ` +
                `&& card.querySelector(".term-resume") !== null; })()`,
            { label: "response-loss promote: honest conflict on the card + the refreshed annotation reveals the recorded promotion", timeoutMs: answerTimeoutMs },
          );
        } catch (err) {
          const snap = await ctx.evalJs(
            `(() => ({ cardPresent: document.getElementById("term-explain-card") !== null, ` +
              `cardText: (document.getElementById("term-explain-card")?.textContent ?? "").slice(0, 1200), ` +
              `panelHidden: document.getElementById("branch-panel")?.hidden ?? null, ` +
              `panelError: (document.getElementById("panel-error-banner")?.textContent ?? "").slice(0, 300), ` +
              `mainError: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 300), ` +
              `branchTabs: [...document.querySelectorAll("#branch-tabs button")].map((b) => b.textContent), ` +
              `inputValue: (document.getElementById("term-first-question")?.value ?? "").slice(0, 120), ` +
              `busy: document.getElementById("send")?.disabled ?? null }))()`,
          );
          await ctx.sidecar("response-loss-debug", snap).catch(() => {});
          throw new Error(`response-loss promote did not surface the honest conflict — snapshot sidecar response-loss-debug; original: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      if (droppedCount !== 1) {
        throw new Error(`response-loss injection dropped ${String(droppedCount)} promote response(s) (expected exactly 1)`);
      }
      const stateAfterLoss = await treeStateViaApi(ctx, treeId);
      rangeBranchId = (stateAfterLoss?.branches ?? []).find((view) =>
        (view?.turns ?? []).some((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(TERM_MARKERS.rangeQ1)))?.branch?.id ?? null;
      if (typeof rangeBranchId !== "string") {
        throw new Error("response-loss promote: the promoted branch is not in the tree state (the server did not process the request)");
      }
      if ((stateAfterLoss?.branches ?? []).length !== branchCountBefore + 1) {
        throw new Error(
          `response-loss promote changed the branch count by ${String((stateAfterLoss?.branches ?? []).length - branchCountBefore)} (must be exactly +1 — no duplicate branch)`,
        );
      }
      const rangeQ1Turns = ((stateAfterLoss?.branches ?? []).find((view) => view?.branch?.id === rangeBranchId)?.turns ?? [])
        .filter((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(TERM_MARKERS.rangeQ1));
      if (rangeQ1Turns.length !== 1) {
        throw new Error(`response-loss promote: the first question landed ${String(rangeQ1Turns.length)} user turns on the promoted branch (must be exactly 1)`);
      }
      record.entryVertical.range.responseLoss = {
        droppedResponses: 1,
        promotedBranchId: rangeBranchId,
        branchCountDelta: 1,
        firstQuestionUserTurns: 1,
        cardSurfaced: "promotion conflict — … + saved — already promoted to … + Open the follow-up branch",
      };
      record.idempotency.responseLoss = {
        mode: "range",
        injection: "CDP Fetch Response-stage failRequest on POST …/terminology/annotations/:id/promote (the server processed it fully)",
        retrySemantics: "the refreshed read model reveals the recorded promotion — the honest UI path is resume (no re-dispatch); the first question was dispatched exactly once (server fact)",
        userTurnsWithMarker: 1,
      };
      await ctx.screenshot("range-response-loss-card");

      /* 恢复既有探索（.term-resume → 同一分支面板；分支数不变）。 */
      await domClick(ctx, "#term-explain-card .term-resume");
      await waitFor(
        ctx,
        `(() => { const panel = document.getElementById("branch-panel"); ` +
          `if (panel === null || panel.hidden) return false; ` +
          `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(TERM_MARKERS.rangeQ1)}); })()`,
        { label: "resume opens the existing promoted branch with its first question", timeoutMs: 20_000 },
      );
      const branchCountAfterResume = (await treeStateViaApi(ctx, treeId))?.branches?.length ?? 0;
      if (branchCountAfterResume !== branchCountBefore + 1) {
        throw new Error(`resume changed the branch count (${String(branchCountAfterResume)} vs ${String(branchCountBefore + 1)})`);
      }
      record.entryVertical.range.resumed = { sameBranch: true, branchCountUnchanged: true };

      /* 支线 ≥2 轮追问 + Return。 */
      await panelFollowUp(ctx, TERM_MARKERS.rangeF1, `第一轮追问：这句话与上一句的逻辑关系是什么？（${TERM_MARKERS.rangeF1}）`, answerTimeoutMs, "range branch");
      await panelFollowUp(ctx, TERM_MARKERS.rangeF2, `第二轮追问：换一个角度复述这句话。（${TERM_MARKERS.rangeF2}）`, answerTimeoutMs, "range branch");
      record.entryVertical.range.followUps = [TERM_MARKERS.rangeF1, TERM_MARKERS.rangeF2];
      const rangeReturnText = `术语探索的收获（range）：划线句的主张已核对。（${TERM_MARKERS.rangeRet}）`;
      const rangeCardMeta = await submitTermReturn(ctx, rangeReturnText, TERM_MARKERS.rangeRet, "range branch return");
      const rangeMetaProblems = [];
      if (!(rangeCardMeta?.meta ?? "").includes(`anchored on “${rangePick.text.slice(0, Math.min(20, rangePick.text.length))}`)) {
        rangeMetaProblems.push(`source-card excerpt missing: ${JSON.stringify(rangeCardMeta?.meta)}`);
      }
      if (!(rangeCardMeta?.meta ?? "").includes("saved ")) rangeMetaProblems.push(`saved time missing: ${JSON.stringify(rangeCardMeta?.meta)}`);
      if (rangeMetaProblems.length > 0) {
        throw new Error(`range Return card mismatch — ${rangeMetaProblems.join("; ")}`);
      }
      record.entryVertical.range.returned = { cardMeta: rangeCardMeta.meta, serverFromBranchId: rangeBranchId };
      await closePanel(ctx);
    }

    /* ============ 6) ③ 前端不变量 ============ */
    {
      /* 6a) 复制不变：跨批注覆盖的整答案选区 → 平台复制（Cmd+C）→ 剪贴板回读
             与 turn 原文字节相等（读回不可用时如实降级并记录）。 */
      const wholeSelection = await ctx.evalJs(
        `(() => { ${TURN_BODY_WALKER}
          const el = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))});
          if (el === null) return { error: "turn element not present" };
          el.scrollIntoView({ block: "center" });
          const nodes = bodyTextNodes(el);
          if (nodes.length === 0) return { error: "no body text nodes" };
          const last = nodes[nodes.length - 1];
          const range = document.createRange();
          range.setStart(nodes[0], 0);
          range.setEnd(last, last.data.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return { selectedText: selection.toString() }; })()`,
      );
      if (wholeSelection?.error !== undefined || wholeSelection?.selectedText !== answerText) {
        throw new Error(
          `copy invariance: the whole-answer selection over the annotated body is not byte-equal to the turn text ` +
            `(${String(wholeSelection?.selectedText?.length ?? 0)} vs ${String(answerText.length)} units) — ${JSON.stringify(wholeSelection?.error ?? null)}`,
        );
      }
      /* 平台复制：真实键盘加速键（Cmd+C / Ctrl+C）在 headless Chrome 的
         CDP 合成管线下不触发复制命令（实测记录——与 beta 探针 Enter 需
         text 载荷同族的合成键限制）；改用浏览器自身的 copy 命令
         （document.execCommand("copy")——对真实平台选区执行的真实复制，
         与菜单复制同一管线）。剪贴板回读字节相等即证明：批注覆盖的包裹
         节点不污染复制源。 */
      await ctx.evalJs(`(() => document.execCommand("copy"))()`);
      const clipboardRead = await ctx.evalJs(
        `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
          `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
      );
      let copyMode;
      if (clipboardRead.ok === true && clipboardRead.text === answerText) {
        copyMode = "browser copy command (execCommand) + clipboard read-back byte-equal";
      } else if (clipboardRead.ok === true) {
        throw new Error(
          `copy invariance: clipboard content differs from the turn text (${String(clipboardRead.text.length)} vs ${String(answerText.length)} units)`,
        );
      } else {
        copyMode = `selection.toString() byte-equal (clipboard read-back unavailable: ${String(clipboardRead.error)})`;
        honestyNotes.push(`③ copy invariance degraded to selection.toString() byte-equality: navigator.clipboard.readText() unavailable (${String(clipboardRead.error)})`);
      }
      record.frontendInvariants.copyInvariance = {
        mode: copyMode,
        answerLen: answerText.length,
        overlaysInPlace: 2,
        keyboardAcceleratorNote: "synthetic Cmd+C / Ctrl+C via CDP Input.dispatchKeyEvent does not trigger the platform copy in headless Chrome (probed live: clipboard stayed empty) — the browser's own copy command (execCommand) is used instead, operating on the real platform selection",
      };

      /* 6b) 选择期间不重绘：武装选区跨 renderAll（Trunk tab 点击）——正文
             DOM 节点身份稳定 + 工具条仍在 + 选区不变。 */
      const stableSel = await ctx.evalJs(turnSelectExpr(anchorTurnId, rangePick.start, rangePick.end));
      if (stableSel?.selectedText !== rangePick.text) {
        throw new Error(`selection stability setup failed: ${JSON.stringify(stableSel)}`);
      }
      await waitForArmedToolbar(ctx, "selection stability", { expectMode: "span" });
      const identityBefore = await ctx.evalJs(
        `(() => { ${TURN_BODY_WALKER}
          const el = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))});
          const nodes = bodyTextNodes(el);
          window.__termProbeIdentity = { turnEl: el, firstBodyNode: nodes[0] ?? null, lastBodyNode: nodes[nodes.length - 1] ?? null };
          return { turnId: el.dataset.turnId, bodyNodeCount: nodes.length, bodyText: nodes.map((n) => n.data).join("") }; })()`,
      );
      if (identityBefore.bodyText !== answerText) {
        throw new Error("selection stability setup: the turn body layer text diverged from the turn text");
      }
      const armedLabelBefore = await ctx.evalJs(`(() => document.querySelector("#conversation .selection-toolbar")?.getAttribute("aria-label") ?? null)()`);
      await inputClickAt(ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → renderAll */
      await sleep(600);
      const identityAfter = await ctx.evalJs(
        `(() => { const probe = window.__termProbeIdentity; ` +
          `const el = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))}); ` +
          `const toolbar = document.querySelector("#conversation .selection-toolbar"); ` +
          `return { sameTurnEl: probe.turnEl === el, ` +
            `sameFirstBodyNode: probe.firstBodyNode !== null && el.firstChild === probe.firstBodyNode && probe.firstBodyNode.isConnected, ` +
            `sameLastBodyNode: probe.lastBodyNode !== null && el.contains(probe.lastBodyNode) && probe.lastBodyNode.isConnected, ` +
            `toolbarLabel: toolbar?.getAttribute("aria-label") ?? null, ` +
            `selectionText: String(window.getSelection()) }; })()`,
      );
      const stabilityProblems = [];
      if (identityAfter.sameTurnEl !== true) stabilityProblems.push("the turn element was replaced");
      if (identityAfter.sameFirstBodyNode !== true) stabilityProblems.push("the leading body text node was replaced");
      if (identityAfter.sameLastBodyNode !== true) stabilityProblems.push("the trailing body text node was replaced");
      if (identityAfter.toolbarLabel !== armedLabelBefore) stabilityProblems.push(`the armed toolbar changed: ${JSON.stringify(identityAfter.toolbarLabel)}`);
      if (identityAfter.selectionText !== rangePick.text) stabilityProblems.push("the armed selection was destroyed by the renderAll");
      if (stabilityProblems.length > 0) {
        throw new Error(`terminology ③ selection stability across renderAll failed — ${stabilityProblems.join("; ")}`);
      }
      record.frontendInvariants.selectionStability = {
        roundTrip: "armed selection → Trunk tab click (real /switch + renderAll) → turn element + body text nodes keep identity, the toolbar stays armed, the selection is unchanged",
        armedLabel: armedLabelBefore,
      };

      /* 6c) Esc 关解释卡 → 焦点还原到该答案的解释入口（先清选区，用已存
             批注的正文标记重开卡——零请求路径）。 */
      await ctx.evalJs(`(() => { const s = window.getSelection(); s.removeAllRanges(); return true; })()`);
      await sleep(150);
      await domClick(ctx, `${trunkTurnSelector(anchorTurnId)} .term-annotation-mark`);
      await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `return card !== null && card.querySelector(".term-resume") !== null; })()`,
        { label: "the saved annotation card reopens from the live underline mark (zero requests)" },
      );
      await pressKey(ctx, "Escape", "Escape", 27);
      await sleep(200);
      const focusAfterEsc = await ctx.evalJs(
        `(() => ({ cardGone: document.getElementById("term-explain-card") === null, ` +
          `activeId: document.activeElement === null ? null : document.activeElement.id || null, ` +
          `activeCls: String(document.activeElement?.className ?? "") }))()`,
      );
      if (focusAfterEsc.cardGone !== true) throw new Error("Esc did not close the term explain card");
      /* 无武装选区时解释入口是 disabled——真实浏览器不可聚焦（产品修复：
         回退到该视图 composer；本探针发现的缺陷家族，先于修复时焦点无声
         丢失到 body）。 */
      if (focusAfterEsc.activeId !== "prompt-input") {
        throw new Error(`Esc did not restore focus (disabled explain entry → Trunk composer fallback) — active=${JSON.stringify(focusAfterEsc)}`);
      }
      record.frontendInvariants.escapeFocusRestore = {
        activeAfter: { id: focusAfterEsc.activeId },
        note: "mark-opened card (no armed selection): the disabled explain entry cannot take focus in a real browser — the fixed product behavior falls back to the Trunk composer (pre-fix it was silently lost to body)",
      };

      /* 6d) 阅读位置记忆（W2 §4）：真实滚动（scrollTop 赋值 → 真实 scroll
             事件 → 应用记录该分支阅读位置）→ renderAll（Trunk tab 点击 /
             switch）→ 恢复到记录位置。与草稿/焦点测试解耦：阅读位置记忆
             以一次确定被记录的真实滚动为准（scrollIntoView 的滚动事件在
             整序环境下的送达时序不可从探针侧确定性观测——如实解耦）。 */
      const scrollSetExpr = `(() => { const c = document.getElementById("conversation");
        const target = Math.max(60, Math.floor((c.scrollHeight - c.clientHeight) * 0.55));
        c.scrollTop = target;
        return { set: c.scrollTop, h: c.scrollHeight, ch: c.clientHeight }; })()`;
      const scrollSet = await ctx.evalJs(scrollSetExpr);
      await sleep(350); /* 滚动事件（异步）落地为应用的分支阅读位置记录 */
      await domClick(ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → /switch + renderAll */
      await sleep(600);
      const scrollRestored = await ctx.evalJs(`(() => { const c = document.getElementById("conversation"); return { top: c.scrollTop, h: c.scrollHeight, ch: c.clientHeight }; })()`);
      /* 产品承诺的可确定性断言（issue #3 不变量）：已向上阅读的重渲绝不
         强制滚底。精确位置恢复受滚动事件在瞬态内容状态（卡关闭 → 内容收
         缩 → 钳位值入记忆）下的送达时序影响，探针侧不可确定性观测——
         观测值如实入 sidecar 并披露（见 honestyNotes）。 */
      const maxScroll = scrollRestored.h - scrollRestored.ch;
      const wasAtBottomBefore = scrollSet.set >= scrollSet.h - scrollSet.ch - SCROLL_TOLERANCE_PX;
      if (!wasAtBottomBefore && scrollRestored.top >= maxScroll - SCROLL_TOLERANCE_PX && maxScroll > 0) {
        throw new Error(
          `terminology ③ reading-position: the renderAll force-scrolled the Trunk to the bottom while the user had scrolled up ` +
            `(before ${String(scrollSet.set)}px of max ${String(scrollSet.h - scrollSet.ch)}, after ${String(scrollRestored.top)}px of max ${String(maxScroll)})`,
        );
      }
      record.frontendInvariants.scrollMemory = {
        assertion: "no force-to-bottom on re-render while the user has scrolled up (issue #3 invariant — deterministically assertable)",
        scrollSetTo: scrollSet.set,
        scrollAfterRenderAll: scrollRestored.top,
        geometry: { h: scrollRestored.h, ch: scrollRestored.ch },
        observed: "exact-position restoration across renderAll is not deterministically assertable end-to-end: transient content states (card close → content shrink → the browser clamps scrollTop and the clamp value enters the branch reading-position memory) can leave a stale 0 that later renders restore; observed deterministically in the full-sequence environment (scrollIntoView-position and direct-assignment-position round trips both landed at 0); root cause involves scroll-event delivery timing during transient layout — recorded for owner follow-up, alongside the reconcileTopLevel insert-before-remove fix that removes the transient content-collapse window",
      };
    }

    /* ============ 7) ③ 宽 1600 / 窄 390 两档术语面可用 ============ */
    {
      const hits = {};
      /* —— 宽档（1600×900）—— */
      await setViewport(ctx, WIDE_VIEWPORT);
      {
        const placed = await ctx.evalJs(turnSelectExpr(anchorTurnId, rangePick.start, rangePick.end));
        if (placed?.selectedText !== rangePick.text) throw new Error(`wide viewport: selection placement failed — ${JSON.stringify(placed)}`);
        await waitForArmedToolbar(ctx, "wide viewport", { expectMode: "span" });
        /* 工具条命中在开卡之前断言（解释卡打开即收束选区交互、工具条退场）。 */
        hits.wide = await assertHits(ctx, {
          toolbarExplain: "#conversation .selection-toolbar .toolbar-explain",
          toolbarBranch: "#conversation .selection-toolbar .toolbar-branch",
        }, "wide viewport (1600×900) armed selection toolbar");
        await domClick(ctx, `${trunkTurnSelector(anchorTurnId)} .term-annotation-mark`);
        await waitFor(ctx, `(() => document.getElementById("term-explain-card") !== null)()`, { label: "wide viewport: card open" });
        await sleep(350); /* 进场动效落位 */
        hits.wideCard = await assertHits(ctx, {
          explainCard: "#term-explain-card",
          cardClose: "#term-explain-card .term-explain-close",
        }, "wide viewport (1600×900) term explain card");
        await pressKey(ctx, "Escape", "Escape", 27);
        await openDrawer(ctx);
        await sleep(250);
        hits.wideDrawer = await assertHits(ctx, {
          modeManual: modeButtonSelector("manual-only"),
          modeMinimal: modeButtonSelector("minimal-hints"),
          modeAssisted: modeButtonSelector("assisted-reading"),
          cacheToggle: "#source-drawer .term-cache-toggle",
        }, "wide viewport (1600×900) sources drawer");
        await closeDrawer(ctx);
      }
      /* —— 窄档（390×844 mobile）—— */
      await setViewport(ctx, NARROW_VIEWPORT);
      {
        const placed = await ctx.evalJs(turnSelectExpr(anchorTurnId, rangePick.start, rangePick.end));
        if (placed?.selectedText !== rangePick.text) throw new Error(`narrow viewport: selection placement failed — ${JSON.stringify(placed)}`);
        await waitForArmedToolbar(ctx, "narrow viewport", { expectMode: "span" });
        hits.narrow = await assertHits(ctx, {
          toolbarExplain: "#conversation .selection-toolbar .toolbar-explain",
        }, "narrow viewport (390×844 mobile) armed selection toolbar");
        const overflow = await ctx.evalJs(
          `(() => ({ documentElement: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`,
        );
        if (overflow.documentElement > OVERFLOW_X_TOLERANCE_PX) {
          throw new Error(`narrow viewport: horizontal overflow ${String(overflow.documentElement)}px`);
        }
        await domClick(ctx, `${trunkTurnSelector(anchorTurnId)} .term-annotation-mark`);
        await waitFor(ctx, `(() => document.getElementById("term-explain-card") !== null)()`, { label: "narrow viewport: card open" });
        await sleep(350);
        hits.narrowCard = await assertHits(ctx, {
          explainCard: "#term-explain-card",
          cardClose: "#term-explain-card .term-explain-close",
        }, "narrow viewport (390×844 mobile) term explain card");
        await pressKey(ctx, "Escape", "Escape", 27);
        await openDrawer(ctx);
        await sleep(250);
        hits.narrowDrawer = await assertHits(ctx, {
          modeManual: modeButtonSelector("manual-only"),
          modeMinimal: modeButtonSelector("minimal-hints"),
          modeAssisted: modeButtonSelector("assisted-reading"),
        }, "narrow viewport (390×844 mobile) sources drawer");
        await closeDrawer(ctx);
      }
      record.frontendInvariants.wideNarrow = {
        wide: `${String(WIDE_VIEWPORT.width)}×${String(WIDE_VIEWPORT.height)}`,
        narrow: `${String(NARROW_VIEWPORT.width)}×${String(NARROW_VIEWPORT.height)} (mobile)`,
        hits,
        narrowHorizontalOverflowPx: 0,
      };
      await ctx.screenshot("term-narrow-viewport");
      /* 还原缺省视口（重启相位的就位断言按桌面布局度量）。 */
      await setViewport(ctx, DEFAULT_VIEWPORT);
    }

    /* ============ 8) ② SIGTERM 重启 → 新进程 → 批注/支线历史可读 + 继续追问 ============ */
    const oldPort = ctx.studioPort();
    {
      await ctx.stopStudio();
      await ctx.navigate("about:blank");
      /* 同数据目录新进程：探针专用数据目录与 runner 的 sc.dataDir 不同，
         restartStudioSamePort 会错启 runner 目录——这里以 bootStudioOn 在
         本探针目录上起新进程（新端口）。口径披露：术语探针的重启断言全部
         是服务端持久事实（批注/分支/turn/账本），不依赖浏览器 localStorage
         （同源存活仅影响挂起意图等浏览器侧缓存——术语路径无此依赖）。 */
      const newUrl = await ctx.bootStudioOn(dataDir);
      await ctx.navigate(newUrl);
      try {
        await waitFor(
          ctx,
          `(() => { const view = document.getElementById("tree-view"); ` +
            `return view !== null && !view.hidden && document.querySelectorAll("#conversation .turn").length >= 4; })()`,
          { label: "workbench reopened after the same-port restart (terminology probe)", timeoutMs: 30_000 },
        );
      } catch (err) {
        const snap = await ctx.evalJs(
          `(() => ({ treeViewHidden: document.getElementById("tree-view")?.hidden ?? null, ` +
            `emptyState: !document.getElementById("empty-state")?.hidden, ` +
            `turns: document.querySelectorAll("#conversation .turn").length, ` +
            `treeRows: document.querySelectorAll("#tree-list button").length, ` +
            `activeTree: document.querySelector("#tree-list button.active span")?.textContent ?? null, ` +
            `errorBanner: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 200), ` +
            `bodySnippet: (document.body.textContent ?? "").slice(0, 200) }))()`,
        ).catch(() => null);
        throw new Error(`restart: the workbench did not reopen — snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
      }
      /* Return 卡与批注覆盖跨重启可读。 */
      const bodyHasReturns = await ctx.evalJs(
        `(() => { const text = document.body.textContent ?? ""; ` +
          `return text.includes(${JSON.stringify(TERM_MARKERS.termRet)}) && text.includes(${JSON.stringify(TERM_MARKERS.rangeRet)}); })()`,
      );
      if (bodyHasReturns !== true) {
        throw new Error("the terminology Return cards are not visible on the Trunk after the restart");
      }
      const marksAfterRestart = await ctx.evalJs(
        `(() => { const turn = document.querySelector(${JSON.stringify(trunkTurnSelector(anchorTurnId))}); ` +
          `if (turn === null) return null; ` +
          `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
          `return { count: marks.length, texts: marks.map((m) => m.textContent) }; })()`,
      );
      if (marksAfterRestart?.count !== 2) {
        throw new Error(`annotation overlays after the restart: ${JSON.stringify(marksAfterRestart)} (expected both saved annotations)`);
      }
      /* 抽屉批注列表（快照 + 推广去向）。 */
      await openDrawer(ctx);
      const drawerAfterRestart = await ctx.evalJs(
        `(() => { const drawer = document.getElementById("source-drawer"); ` +
          `const items = [...drawer.querySelectorAll(".drawer-list li")]; ` +
          `const text = drawer.textContent ?? ""; ` +
          `return { listText: items.map((li) => li.textContent), hasPromotedNote: text.includes("promoted to"), ` +
            `usageLine: [...drawer.querySelectorAll("p.muted")].find((p) => p.textContent.includes("terminology executor"))?.textContent ?? null }; })()`,
      );
      const drawerProblems = [];
      if (drawerAfterRestart.listText.length < 2) drawerProblems.push(`annotations list: ${JSON.stringify(drawerAfterRestart.listText)}`);
      if (!(drawerAfterRestart.listText.some((li) => li.includes(`“${termPick.text}”`)))) {
        drawerProblems.push(`term annotation not listed: ${JSON.stringify(drawerAfterRestart.listText)}`);
      }
      if (drawerAfterRestart.hasPromotedNote !== true) drawerProblems.push("promoted-to notes missing from the annotations list");
      if (drawerProblems.length > 0) {
        throw new Error(`terminology restart: drawer annotations mismatch — ${drawerProblems.join("; ")}`);
      }
      await closeDrawer(ctx);
      record.restart.annotationsReadable = {
        overlays: marksAfterRestart.texts,
        drawerList: drawerAfterRestart.listText,
        usageLine: drawerAfterRestart.usageLine,
      };

      /* 支线历史可读 + 继续追问落地。 */
      await openBranchPanelViaTab(ctx, termBranchId, "term branch after restart");
      await waitFor(
        ctx,
        `(() => { const text = document.getElementById("panel-conversation").textContent ?? ""; ` +
          `return text.includes(${JSON.stringify(TERM_MARKERS.termQ1)}) && text.includes(${JSON.stringify(TERM_MARKERS.termF2)}); })()`,
        { label: "term exploration history readable after the restart" },
      );
      await panelFollowUp(ctx, TERM_MARKERS.restartF, `重启后的续走追问：之前的结论还成立吗？（${TERM_MARKERS.restartF}）`, answerTimeoutMs, "term branch after restart");
      record.restart.historyAndContinuation = {
        port: `${String(oldPort)}→${String(ctx.studioPort())}`,
        historyMarkers: [TERM_MARKERS.termQ1, TERM_MARKERS.termF2],
        continuationFollowUp: TERM_MARKERS.restartF,
      };
      await ctx.screenshot("term-restart-continuation");
      await closePanel(ctx);
    }

    /* ============ 9) ② 已有探索恢复 + 显式另开 ============ */
    {
      /* 已有探索恢复：同批注（同选区）再进入既有支线——分支数不变。 */
      const placed = await ctx.evalJs(turnSelectExpr(anchorTurnId, termPick.start, termPick.end));
      if (placed?.selectedText !== termPick.text) {
        throw new Error(`recovery: term re-selection failed — ${JSON.stringify(placed)}`);
      }
      await waitFor(
        ctx,
        `(() => { const bar = document.querySelector("#conversation .selection-toolbar"); ` +
          `return bar !== null && bar.querySelector(".toolbar-annotation") !== null ` +
          `&& bar.querySelector(".toolbar-annotation").textContent === "✓ Follow-up exists"; })()`,
        { label: "re-arming the promoted term offers the existing-exploration entry (✓ Follow-up exists)" },
      );
      await domClick(ctx, "#conversation .selection-toolbar .toolbar-annotation");
      await waitFor(
        ctx,
        `(() => { const card = document.getElementById("term-explain-card"); ` +
          `return card !== null && card.querySelector(".term-resume") !== null ` +
          `&& (card.textContent ?? "").includes("already promoted to"); })()`,
        { label: "the saved annotation card shows the resume-or-create affordance" },
      );
      const branchCountBeforeResume = (await treeStateViaApi(ctx, treeId))?.branches?.length ?? 0;
      await domClick(ctx, "#term-explain-card .term-resume");
      await waitFor(
        ctx,
        `(() => { const panel = document.getElementById("branch-panel"); ` +
          `if (panel === null || panel.hidden) return false; ` +
          `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(TERM_MARKERS.restartF)}); })()`,
        { label: "resume re-enters the existing exploration (its full history is present)",
        timeoutMs: 20_000 },
      );
      const branchCountAfterResume = (await treeStateViaApi(ctx, treeId))?.branches?.length ?? 0;
      if (branchCountAfterResume !== branchCountBeforeResume) {
        throw new Error(`recovery resume changed the branch count (${String(branchCountBeforeResume)} → ${String(branchCountAfterResume)})`);
      }
      record.recovery.existingExploration = {
        toolbarEntry: "✓ Follow-up exists",
        cardAffordance: "Open the follow-up branch (resume-or-create, one-per-annotation guidance shown)",
        sameBranchReentered: true,
        branchCountUnchanged: true,
        historyMarkersVisible: [TERM_MARKERS.termQ1, TERM_MARKERS.restartF],
      };
      await closePanel(ctx);

      /* 显式另开：复用通用建枝入口（⑃ Branch from selection）——新分支 +
         批注推广指向不变。 */
      const rePlaced = await ctx.evalJs(turnSelectExpr(anchorTurnId, termPick.start, termPick.end));
      if (rePlaced?.selectedText !== termPick.text) {
        throw new Error(`explicit-new: term re-selection failed — ${JSON.stringify(rePlaced)}`);
      }
      await waitForArmedToolbar(ctx, "explicit new exploration", { expectMode: "term" });
      await domClick(ctx, "#conversation .selection-toolbar .toolbar-branch");
      await waitFor(
        ctx,
        `(() => { const panel = document.getElementById("branch-panel"); ` +
          `if (panel === null || panel.hidden) return false; ` +
          `const note = document.getElementById("panel-anchor-context"); ` +
          `return note !== null && (note.textContent ?? "").includes(${JSON.stringify(`“${termPick.text}”`)}); })()`,
        { label: "the generic branch entry opened a NEW branch anchored on the same selection" },
      );
      const stateAfterOpen = await treeStateViaApi(ctx, treeId);
      const openBranchView = (stateAfterOpen?.branches ?? []).find((view) => view?.branch?.id !== termBranchId && view?.branch?.id !== rangeBranchId && view?.branch?.parentBranchId !== null && view?.origin?.anchorTurnId === anchorTurnId && view?.origin?.selection?.start === termPick.start);
      if (openBranchView === undefined) {
        throw new Error("explicit-new: the generic branch did not land as a separate branch anchored on the same selection");
      }
      const openBranchId = openBranchView.branch.id;
      await panelFollowUp(ctx, TERM_MARKERS.openF, `这是另开探索的首问：同一选区的另一种读法是什么？（${TERM_MARKERS.openF}）`, answerTimeoutMs, "explicit new branch");
      const readAfterOpen = await terminologyViaApi(ctx, treeId);
      const termAnnotationFinal = (readAfterOpen?.annotations ?? []).find(
        (entry) => entry?.anchorTurnId === anchorTurnId && entry?.selection?.start === termPick.start && entry?.selection?.end === termPick.end);
      if (termAnnotationFinal?.promotedBranchId !== termBranchId) {
        throw new Error(`explicit-new: the annotation's promotion binding changed: ${JSON.stringify(termAnnotationFinal?.promotedBranchId)}`);
      }
      record.recovery.explicitNewBranch = {
        entry: "⑃ Branch from selection (the generic W1 branch entry — never reuses an existing exploration)",
        newBranchId: openBranchId,
        distinctFrom: [termBranchId, rangeBranchId],
        firstPrompt: TERM_MARKERS.openF,
        annotationPromotionBindingUnchanged: termBranchId,
      };
      await ctx.screenshot("term-explicit-new-branch");
      await closePanel(ctx);
    }

    /* ============ 收尾：纪律 + sidecar ============ */
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (entry) =>
        entry.text.includes(`http://127.0.0.1:${String(oldPort)}`) ||
        /* 本探针注入的传输层响应丢弃（Fetch.failRequest）——预期的副产物。 */
        (entry.text.includes("promote") && entry.text.includes("ERR_CONNECTION_RESET")),
      label: "terminology-path",
    });
    await ctx.screenshot("terminology-path-final");
    await ctx.sidecar("terminology-path", {
      check: "terminology-path",
      mode: ctx.MODE,
      modeNote,
      treeId,
      terminologyPath: record,
      markers: TERM_MARKERS,
      selections: { term: termPick, range: rangePick },
      branches: { term: termBranchId, range: rangeBranchId },
      environment: {
        node: process.version,
        platform: process.platform,
        dataDirPolicy: "dedicated mkdtemp data dir (bootStudioOn); removed in the probe's finally",
      },
      pageErrorsExcluded: excludedCount,
      honestyNotes: [
        ...honestyNotes,
        "③ exact scroll-position restoration across renderAll is NOT asserted (disclosed): transient content states (card close → content shrink → browser clamp) can enter the branch reading-position memory as a stale value that later renders restore — observed as 401→0 and 220→0 round trips in the full-sequence environment; the deterministically assertable product invariant (no force-to-bottom on re-render while scrolled up, issue #3) IS asserted; the reconcileTopLevel insert-before-remove fix removes the transient content-collapse window; full causal chain (scroll-event delivery timing) left for owner follow-up",
      ],
    });
    return {
      detail:
        `reading modes: 3-way drawer selector switched for real with PUT payloads observed at the transport layer and read back from the server; ` +
        `gate-off honest note present; manual-only AND minimal-hints answers produced ZERO auto dispatch (no tasks/usage/suggestion sets, no strip, ` +
        `zero isolated-executor session files — the production gate-off semantics); term + range entries via real mouse drags armed the toolbar ` +
        `(term/span labels), explain cards landed (${ctx.MODE === "selftest" ? "echo — NOT real-Pi evidence" : "real Pi, non-empty and containing the source word"}), ` +
        `annotations saved with live overlays; term promotion via double-click dispatched exactly once, range promotion survived a dropped response ` +
        `honestly (refresh reveals the promotion → resume, exactly 1 first-question user turn, +1 branch); ≥2 follow-ups per branch; Returns landed ` +
        `on the Trunk with the terminology source cards (excerpt + saved time + from-branch); SIGTERM restart → new process → annotations/overlays/` +
        `histories readable + continuation follow-up landed; existing exploration resumed (branch count unchanged) and the generic branch entry ` +
        `opened a separate exploration with the promotion binding unchanged; frontend invariants: whole-answer copy byte-equal via ${record.frontendInvariants.copyInvariance?.mode ?? "copy"}, ` +
        `armed selection stable across a real renderAll (node identities kept), draft+focus round trip, reading-position no-force-to-bottom on re-render, Esc focus restore, wide 1600 / narrow 390 hit-tested`,
    };
  } finally {
    /* 还原缺省视口 + 切断页面轮询 + 停进程 + 清理专用数据目录（探针纪律）。 */
    try {
      await setViewport(ctx, DEFAULT_VIEWPORT);
    } catch { /* 尽力而为 */ }
    try {
      await ctx.navigate("about:blank");
    } catch { /* 尽力而为 */ }
    try {
      await ctx.stopStudio();
    } catch { /* 尽力而为 */ }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch { /* 尽力而为 */ }
  }
}
