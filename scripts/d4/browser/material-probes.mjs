/**
 * scripts/d4/browser/material-probes.mjs — D4 材料路径浏览器探针
 * （issue #8 §8 验收入口的 B1/B2 浏览器面；D4-2 前端落地后翻绿）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程（selftest 模式为 echo 驱动——离线确定性，永远不是
 * 真实 Pi 证据）。探针沿 owner 2026-09-30 增量验收要求的用户路径：
 *
 *   导入 → 阅读 → 精确选区（含真实连续拖选）→ 来源揭示 → 复制不变
 *   → 重启续读 → B1 全分母（24 ready + 11 负例）→ B5 导出/恢复/找回
 *
 * 冻结真值（绝不在本文件内复制、运行时直接读取冻结文件）：
 *   - tests/fixtures/d4/b1-import/markdown/md-XX.md + md-XX.expected.json
 *     （canonicalText / blocks / textUnits）；
 *   - tests/fixtures/d4/b1-import/md-registry.json / pdf-registry.json
 *     （全分母登记：24 ready + 8 文件负例；3 个超限负例按 manifest 配方
 *     确定性生成——生成器与 tests/support/verifier/d4-b1-import.ts 同源）；
 *   - tests/fixtures/d4/b2-anchors/markdown-selections.json（选区语义：
 *     blockId / 绝对 UTF-16 区间 / 摘录）。
 *
 * 探针纪律：
 *   - 页面内的操作全部是真实 DOM/输入事件（CDP Input.dispatchMouseEvent
 *     的真实点击、真实鼠标两击选区（click 置 caret → Shift+click 扩展）、
 *     真实连续拖选（mousePressed → mouseMoved×N → mouseReleased）；
 *     DOM Selection + 阅读器自身的
 *     selectionchange/mouseup 武装路径）；绝不在页面里 fetch-shim 应用
 *     自身的行为——导入走真实 HTTP API（D4-1 契约面；导入 UI 属后续
 *     增量），阅读/选区/复制/位置保存全部走 app.js 自己的路径；
 *   - 来源揭示 = 把捕获载荷送回真实后端的 resolve-selection（D4-2 契约
 *     面）复核，selection 必须与冻结真值逐项全等（含 sourceHash ===
 *     SHA-256(冻结 canonicalText)——服务端规范文本与冻结集字节一致的
 *     结构性证明）；
 *   - 截图/JSON sidecar 写入 artifacts 目录（现有约定）；凭据零接触；
 *   - 失败如实：label + 具体 mismatch，绝不吞错。
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 冻结集（运行时读取，绝不内嵌副本）                                     */
/* ------------------------------------------------------------------ */

const B1_MARKDOWN_DIR = ["tests", "fixtures", "d4", "b1-import", "markdown"];
const B1_ROOT = ["tests", "fixtures", "d4", "b1-import"];
const B2_SELECTIONS_FILE = ["tests", "fixtures", "d4", "b2-anchors", "markdown-selections.json"];

/** 本探针使用的 B1 冻结 fixture（确定性挑选，覆盖中文/emoji/长文懒加载）。 */
const FIXTURE_IDS = ["md-01", "md-06", "md-11"];

export function loadB1Fixture(root, fixtureId) {
  const dir = join(root, ...B1_MARKDOWN_DIR);
  const bytes = readFileSync(join(dir, `${fixtureId}.md`));
  const truth = JSON.parse(readFileSync(join(dir, `${fixtureId}.expected.json`), "utf8"));
  if (truth.fixtureId !== fixtureId) {
    throw new Error(`fixture truth id mismatch: file says ${String(truth.fixtureId)}, expected ${fixtureId}`);
  }
  return { fixtureId, filename: `${fixtureId}.md`, bytes, truth };
}

function loadB2Selections(root) {
  const raw = JSON.parse(readFileSync(join(root, ...B2_SELECTIONS_FILE), "utf8"));
  const byId = new Map(raw.items.map((item) => [item.id, item]));
  return byId;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(ctx, expression, { label, timeoutMs = 12_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ctx.evalJs(expression);
    if (value) return value;
    if (Date.now() + intervalMs >= deadline) {
      throw new Error(`timeout (${String(timeoutMs)}ms) waiting for: ${label}`);
    }
    await sleep(intervalMs);
  }
}

/** 真实输入点击（CDP Input 管线：mousePressed + mouseReleased 于元素中心）。
    每次尝试前先把目标滚进视口，且以 elementFromPoint 复核命中——取坐标
    与落点之间可能隔着一次延后重渲（拖选解除的 0ms 冲刷会重建侧栏 DOM，
    实测把 md-11 的点击坐标作废），不命中则等一拍重试（有界）。 */
export async function inputClickAt(ctx, selector) {
  let lastState = null;
  for (let attempt = 0; ; attempt += 1) {
    lastState = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return { missing: true }; ` +
        `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
        `const r = el.getBoundingClientRect(); ` +
        `if (r.width <= 0 || r.height <= 0) return { hidden: true }; ` +
        `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
        `const hit = document.elementFromPoint(x, y); ` +
        `return { x: x, y: y, hit: hit !== null && hit.closest(${JSON.stringify(selector)}) !== null }; })()`,
    );
    if (lastState?.missing === true) throw new Error(`click target not found: ${selector}`);
    if (lastState?.hidden === true) throw new Error(`click target not visible: ${selector}`);
    /* 命中复核与坐标在同一表达式内求值——两步分开会被两次 CDP 往返间的
       重渲拆开（这正是 md-11 点击落空的机制）。 */
    if (lastState?.hit === true) {
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: lastState.x, y: lastState.y, button: "left", buttons: 1, clickCount: 1 });
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: lastState.x, y: lastState.y, button: "left", buttons: 0, clickCount: 1 });
      return;
    }
    if (attempt >= 6) {
      throw new Error(`click target never settled at its coordinates (covered or moving): ${selector}`);
    }
    await sleep(150);
  }
}

export function materialButtonSelector(materialId) {
  return `#material-list button[data-material-id=${JSON.stringify(materialId)}]`;
}

/** 页面内公共前置（找块元素 / 块内偏移 → 文本节点锚点）。 */
const PAGE_HELPERS = `
  const findBlock = (id) => {
    const blocksEl = document.getElementById("mat-blocks");
    if (blocksEl === null) return null;
    for (const child of blocksEl.children) {
      if (child.dataset !== undefined && child.dataset.blockId === id) return child;
    }
    return null;
  };
  const toAnchor = (blockEl, localOffset) => {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let pos = 0;
    for (;;) {
      const node = walker.nextNode();
      if (node === null) return null;
      const len = node.data.length;
      if (localOffset <= pos + len) return { node, offset: localOffset - pos };
      pos += len;
    }
  };
`;

/**
 * 在渲染文本上按规范偏移建立真实 DOM 选区（块元素携带的 blockId/start
 * 区间与 app.js 自身的映射数据同源）。选区经 window.getSelection() 成为
 * 平台活选区，阅读器经其自身的 selectionchange 监听武装捕获条。
 */
export function pageSelectCanonical(blockId, start, end) {
  return `(() => { ${PAGE_HELPERS}
    const blockEl = findBlock(${JSON.stringify(blockId)});
    if (blockEl === null) return { error: "block ${blockId} is not loaded in the reader window" };
    const blockStart = Number(blockEl.dataset.start);
    const localStart = ${Number(start)} - blockStart;
    const localEnd = ${Number(end)} - blockStart;
    if (!(localStart >= 0) || localEnd > blockEl.textContent.length) {
      return { error: "canonical range [${start}, ${end}) is outside block ${blockId}" };
    }
    blockEl.scrollIntoView({ block: "center" });
    const a = toAnchor(blockEl, localStart);
    const b = toAnchor(blockEl, localEnd);
    if (a === null || b === null) return { error: "offsets did not map onto text nodes of ${blockId}" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/** 跨块选区（B2 纪律：markdown 选区必须含于单块——期望捕获条呈不可锚定）。 */
function pageSelectCrossBlock(blockA, localStartA, blockB, localEndB) {
  return `(() => { ${PAGE_HELPERS}
    const elA = findBlock(${JSON.stringify(blockA)});
    const elB = findBlock(${JSON.stringify(blockB)});
    if (elA === null || elB === null) return { error: "block not loaded" };
    elA.scrollIntoView({ block: "center" });
    const a = toAnchor(elA, ${Number(localStartA)});
    const b = toAnchor(elB, ${Number(localEndB)});
    if (a === null || b === null) return { error: "offsets did not map onto text nodes" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/** 真实鼠标两击选区（click 置caret + Shift+click 扩展）的落点：目标区段
    首字符盒左内缘（caret 落在 from 边界）与末字符盒右内缘（扩展到 to
    边界）。两次命中判定都发生在各自 mousedown 时刻——捕获条随后长高
    造成的布局位移不影响已定选区（连续 press/release 间的布局位移会把
    拖选释放点带偏，实测如此；两击手势天然免疫）。 */
function pageClickPoints(blockId, start, end) {
  return `(() => { ${PAGE_HELPERS}
    const blockEl = findBlock(${JSON.stringify(blockId)});
    if (blockEl === null) return { error: "block ${blockId} is not loaded" };
    const blockStart = Number(blockEl.dataset.start);
    blockEl.scrollIntoView({ block: "center" });
    const pointFor = (localFrom, localTo, fromLeft) => {
      const a = toAnchor(blockEl, localFrom);
      const b = toAnchor(blockEl, localTo);
      if (a === null || b === null) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      const inset = Math.min(1, rect.width / 2);
      return { x: fromLeft ? rect.left + inset : rect.right - inset, y: rect.top + rect.height / 2 };
    };
    const from = pointFor(${Number(start)} - blockStart, ${Number(start)} - blockStart + 1, true);
    const to = pointFor(${Number(end)} - blockStart - 1, ${Number(end)} - blockStart, false);
    if (from === null || to === null) return { error: "click anchors not mappable" };
    return { from, to };
  })()`;
}

/** 阅读器就位表达式（块数 + 尾部状态）。tail: "end" | "more" | null。 */
export function pageReaderLoadedExpr(expectedBlocks, tail) {
  const tailCheck =
    tail === "end"
      ? `if (!text.includes("end of material")) return false;`
      : tail === "more"
        ? `if (tail.querySelector(".mat-load-more") === null) return false;`
        : "";
  return `(() => {
    const reader = document.getElementById("material-reader");
    if (reader === null || reader.hidden) return false;
    const blocks = document.querySelectorAll("#mat-blocks .material-block").length;
    if (blocks !== ${Number(expectedBlocks)}) return false;
    const tail = document.getElementById("mat-tail");
    if (tail === null) return false;
    const text = tail.textContent;
    if (!text.includes(${JSON.stringify(`${String(expectedBlocks)} block(s) in view`)})) return false;
    ${tailCheck}
    return { blocks: blocks, tail: text };
  })()`;
}

/** 顶部对齐目标块（真实 scrollTop 写入——scroll 事件驱动应用自身的路径）。 */
function pageTopAlignBlock(blockId) {
  return `(() => { ${PAGE_HELPERS}
    const blocksEl = document.getElementById("mat-blocks");
    const target = findBlock(${JSON.stringify(blockId)});
    if (blocksEl === null || target === null) return { error: "block ${blockId} not loaded" };
    const top = target.offsetTop - blocksEl.offsetTop;
    blocksEl.scrollTop = top;
    return { target: top, scrollTop: blocksEl.scrollTop, diff: blocksEl.scrollTop - top };
  })()`;
}

/** 恢复断言表达式：恢复注记在场 + 目标块已载（向前补页）+ 视觉滚动对齐
    （≤2px 容差）。对齐曾只记录不判定——真浏览器中平滑滚动被重渲 detach
    取消（scrollTop 0/183 vs 7208；DOM 桩察觉不到）；app.js 已改即时落位
    + 渲染保位后，这里转为硬断言锁定该修复。 */
function pageReaderRestoredExpr(blockId, expectedBlocks) {
  return `(() => { ${PAGE_HELPERS}
    const reader = document.getElementById("material-reader");
    if (reader === null || reader.hidden) return false;
    if (!reader.textContent.includes(${JSON.stringify(`restored to your saved reading position (block ${blockId})`)})) return false;
    const blocksEl = document.getElementById("mat-blocks");
    const blocks = document.querySelectorAll("#mat-blocks .material-block").length;
    const target = findBlock(${JSON.stringify(blockId)});
    if (blocksEl === null || target === null || blocks !== ${Number(expectedBlocks)}) return false;
    const blockTop = target.offsetTop - blocksEl.offsetTop;
    return { blocks: blocks, scrollTop: blocksEl.scrollTop, blockTop: blockTop, diff: Math.abs(blocksEl.scrollTop - blockTop) };
  })()`;
}

/** 捕获条读取（就地状态面——app.js 的武装/解除产物）。 */
export async function readCaptureBar(ctx) {
  return ctx.evalJs(`(() => {
    const bar = document.getElementById("mat-selection-bar");
    if (bar === null) return { error: "no #mat-selection-bar" };
    const grab = (sel) => { const el = bar.querySelector(sel); return el === null ? null : el.textContent; };
    const copyBtn = bar.querySelector(".mat-copy");
    const branchBtn = bar.querySelector(".mat-branch-d43");
    return {
      quote: grab(".mat-quote"),
      payload: grab(".mat-payload"),
      snapNote: grab(".mat-snap-note"),
      invalidNote: grab(".mat-invalid-note"),
      hint: grab(".muted"),
      copyLabel: copyBtn === null ? null : copyBtn.textContent,
      branchDisabled: branchBtn === null ? null : branchBtn.disabled === true,
    };
  })()`);
}

export async function waitForArmedBar(ctx, caseId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bar = await readCaptureBar(ctx);
    if (bar.error !== undefined) throw new Error(`${caseId}: ${bar.error}`);
    if (bar.payload !== null || bar.invalidNote !== null) return bar;
    if (Date.now() >= deadline) {
      throw new Error(`${caseId}: the reader's capture bar never armed (selectionchange path; bar=${JSON.stringify(bar)})`);
    }
    await sleep(120);
  }
}

/** 页面 console/Log 错误纪律（**逐检查窗口**）：断言后清空缓冲——已断言/
    已排除的错误不流入后续检查（每检查只对自身窗口负责；被注入的传输层
    故障与旧端口重连在各探针的 exclude 中如实声明）。 */
export function assertNoPageErrors(ctx, { exclude = () => false, label } = {}) {
  const errors = ctx.pageErrors();
  const unexpected = errors.filter((entry) => !exclude(entry));
  const reported = errors.length;
  ctx.clearPageErrors();
  if (unexpected.length > 0) {
    throw new Error(`page console/log errors (${label ?? "material probes"}): ${unexpected.map((e) => e.text).join(" | ")}`);
  }
  return reported;
}

/* ------------------------------------------------------------------ */
/* 逐选区断言（捕获载荷 === 冻结真值；服务端 resolve-selection 复核）      */
/* ------------------------------------------------------------------ */

function assertBarPayload(bar, { materialId, versionId, expected, caseId, expectSnap = false }) {
  const expectedPayload =
    `material ${materialId} · version ${versionId} · block ${expected.blockId}` +
    ` · UTF-16 [${String(expected.start)}, ${String(expected.end)}) · ${String(expected.excerpt.length)} units`;
  const problems = [];
  if (bar.quote !== expected.excerpt) problems.push(`quote mismatch (got ${JSON.stringify(bar.quote)}, want ${JSON.stringify(expected.excerpt)})`);
  if (bar.payload !== expectedPayload) problems.push(`payload mismatch (got ${JSON.stringify(bar.payload)}, want ${JSON.stringify(expectedPayload)})`);
  if (bar.invalidNote !== null) problems.push(`unexpected invalid note: ${JSON.stringify(bar.invalidNote)}`);
  if ((bar.snapNote !== null) !== expectSnap) {
    problems.push(`snap note ${expectSnap ? "expected (boundary inside a grapheme cluster should snap outward)" : "unexpected"}: ${JSON.stringify(bar.snapNote)}`);
  }
  if (bar.copyLabel === null) problems.push("copy-quote button not present on the armed bar");
  /* D4-3 落地（材料建枝前端，ui-material-branching.test.ts）：武装捕获条给出
     可点击的建枝入口——D4-2 时代的「按钮禁用（诚实占位）」期望随之翻绿为
     「在场且可用」。 */
  if (bar.branchDisabled === null) problems.push("branch-from-material button missing from the armed bar (D4-3 entry)");
  else if (bar.branchDisabled === true) problems.push("branch-from-material button disabled (D4-3 landed — the entry must be offered)");
  if (problems.length > 0) throw new Error(`${caseId}: capture bar mismatch — ${problems.join("; ")}`);
}

/** 来源揭示：真实后端 resolve-selection 复核捕获载荷（含 sourceHash 绑定）。 */
async function resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText, caseId }) {
  const res = await ctx.api(
    "POST",
    `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(material.materialId)}` +
      `/versions/${encodeURIComponent(material.versionId)}/resolve-selection`,
    {
      locator: { kind: "utf16-range", start: expected.start, end: expected.end },
      excerpt: expected.excerpt,
      blockId: expected.blockId,
    },
  );
  if (res.status !== 200) {
    throw new Error(`${caseId}: resolve-selection HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  }
  const selection = res.body?.selection ?? null;
  if (selection === null) throw new Error(`${caseId}: resolve-selection returned no selection: ${JSON.stringify(res.body)}`);
  const problems = [];
  if (selection.blockId !== expected.blockId) problems.push(`blockId ${JSON.stringify(selection.blockId)} ≠ ${JSON.stringify(expected.blockId)}`);
  if (selection.start !== expected.start || selection.end !== expected.end) {
    problems.push(`range [${String(selection.start)}, ${String(selection.end)}) ≠ [${String(expected.start)}, ${String(expected.end)})`);
  }
  if (selection.excerpt !== expected.excerpt) problems.push("excerpt mismatch");
  if (selection.materialId !== material.materialId || selection.versionId !== material.versionId) problems.push("material/version id mismatch");
  const expectedSourceHash = sha256Text(canonicalText);
  if (selection.sourceHash !== expectedSourceHash) {
    problems.push("sourceHash mismatch — the server canonicalText is not byte-equal to the frozen truth");
  }
  const block = res.body?.block ?? null;
  if (block === null || block.blockId !== expected.blockId) problems.push("resolved block mismatch");
  if (problems.length > 0) throw new Error(`${caseId}: resolve-selection mismatch — ${problems.join("; ")}`);
  return true;
}

/** 规范偏移 → 真实 DOM 选区 → 阅读器自身武装 → 捕获载荷 === 冻结真值。 */
async function captureFrozenSelection(ctx, { treeId, material, item, truth }) {
  const expected = item.expected;
  if (item.fixture !== material.fixtureId) {
    throw new Error(`${item.id}: frozen selection targets fixture ${item.fixture}, but the open material is ${material.fixtureId}`);
  }
  const placed = await ctx.evalJs(pageSelectCanonical(expected.blockId, expected.start, expected.end));
  if (placed === null || placed.error !== undefined) {
    throw new Error(`${item.id}: canonical selection could not be placed — ${JSON.stringify(placed)}`);
  }
  if (placed.selectedText !== expected.excerpt) {
    throw new Error(
      `${item.id}: the DOM selection does not reproduce the frozen excerpt ` +
        `(got ${JSON.stringify(placed.selectedText)}, want ${JSON.stringify(expected.excerpt)})`,
    );
  }
  const bar = await waitForArmedBar(ctx, item.id);
  assertBarPayload(bar, { materialId: material.materialId, versionId: material.versionId, expected, caseId: item.id });
  await resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText: truth.canonicalText, caseId: item.id });
  return { id: item.id, category: item.category, blockId: expected.blockId, start: expected.start, end: expected.end };
}

/** 真实鼠标两击选区（CDP Input：click 置 caret → Shift+click 扩展到 to
    边界）。选区在两次 mousedown 的命中判定中即告完成——阅读器经其自身
    的 selectionchange/mouseup 路径武装捕获条。 */
async function mouseSelectFrozenSelection(ctx, { treeId, material, item, truth }) {
  const expected = item.expected;
  const points = await ctx.evalJs(pageClickPoints(expected.blockId, expected.start, expected.end));
  if (points === null || points.error !== undefined) {
    throw new Error(`${item.id}: mouse-selection anchors not resolvable — ${JSON.stringify(points)}`);
  }
  await sleep(60);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: points.from.x, y: points.from.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: points.from.x, y: points.from.y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
  await sleep(150);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: points.to.x, y: points.to.y, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: points.to.x, y: points.to.y, button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
  await sleep(300);
  const bar = await readCaptureBar(ctx);
  if (bar.error !== undefined) throw new Error(`${item.id}: ${bar.error}`);
  assertBarPayload(bar, { materialId: material.materialId, versionId: material.versionId, expected, caseId: `${item.id} (real mouse click + shift-click)` });
  await resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText: truth.canonicalText, caseId: item.id });
  return { id: item.id, category: `${item.category}+real-mouse-shift-click`, blockId: expected.blockId, start: expected.start, end: expected.end };
}

/* ------------------------------------------------------------------ */
/* 真实连续拖选（owner 2026-09-30 P1 #3：探针不得只有 click+Shift+click）  */
/* ------------------------------------------------------------------ */

/**
 * 真实连续鼠标拖选（CDP Input 管线：mousePressed 置锚 → mouseMoved×N 跨
 * 文本推进 → mouseReleased 落点收选）。app.js 的拖拽窗口冻结（mousedown→
 * mouseup 内捕获条不重渲、整树重渲延后——main bb4180f 修复）使拖选期间的
 * 布局稳定，释放点不再被捕获条长高带偏。选区由阅读器自身的 mouseup 路径
 * 武装（armFromEvent → armMaterialSelection），捕获载荷与冻结真值逐项全等。
 * mouseMoved 携带 button:"left"（按压中的拖动语义，Puppeteer 同款管线）。
 */
async function mouseDragFrozenSelection(ctx, { treeId, material, item, truth }) {
  const expected = item.expected;
  const points = await ctx.evalJs(pageClickPoints(expected.blockId, expected.start, expected.end));
  if (points === null || points.error !== undefined) {
    throw new Error(`${item.id}: drag-selection anchors not resolvable — ${JSON.stringify(points)}`);
  }
  await sleep(80);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: points.from.x, y: points.from.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const x = points.from.x + ((points.to.x - points.from.x) * i) / steps;
    const y = points.from.y + ((points.to.y - points.from.y) * i) / steps;
    await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, modifiers: 0 });
    await sleep(30);
  }
  /* 拖拽窗口内先核原生选区（真实手势确实跨文本扩展到了冻结区间）。 */
  const duringDrag = await ctx.evalJs(`(() => { const s = window.getSelection(); return s === null ? null : s.toString(); })()`);
  if (duringDrag !== expected.excerpt) {
    throw new Error(
      `${item.id} (real drag): the native selection during the drag does not reproduce the frozen excerpt ` +
        `(got ${JSON.stringify(duringDrag)}, want ${JSON.stringify(expected.excerpt)})`,
    );
  }
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: points.to.x, y: points.to.y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
  await sleep(300);
  /* 释放后原生选区必须仍在（owner 2026-09-30 P1 #3）：mouseup 冲刷曾以
     renderMaterialReader 的 detach 清掉 Chrome 选区高亮（实测，无
     selectionchange）；修复后捕获条的延后更新走就地 updateMatSelectionBar，
     不再摘挂 #mat-blocks——高亮与捕获条载荷同时在场。 */
  const afterRelease = await ctx.evalJs(`(() => { const s = window.getSelection(); return s === null ? null : s.toString(); })()`);
  if (afterRelease !== expected.excerpt) {
    throw new Error(
      `${item.id} (real drag): the native selection was destroyed by the post-release flush ` +
        `(got ${JSON.stringify(afterRelease)}, want the frozen excerpt — the highlight must survive the mouseup)`,
    );
  }
  const bar = await waitForArmedBar(ctx, `${item.id} (real drag)`, 4000);
  assertBarPayload(bar, { materialId: material.materialId, versionId: material.versionId, expected, caseId: `${item.id} (real continuous mouse drag)` });
  await resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText: truth.canonicalText, caseId: item.id });
  return { id: item.id, category: `${item.category}+real-mouse-drag`, blockId: expected.blockId, start: expected.start, end: expected.end };
}

/* ------------------------------------------------------------------ */
/* B1 全分母/负例共享工具                                                */
/* ------------------------------------------------------------------ */

/** 分册登记读取（md-registry.json / pdf-registry.json；运行时读取，不内嵌）。 */
export function loadB1Registries(root) {
  const out = [];
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const registry = JSON.parse(readFileSync(join(root, ...B1_ROOT, name), "utf8"));
    out.push({ name, kind: registry.kind, fixtures: registry.fixtures, negativeFixtures: registry.negativeFixtures });
  }
  return out;
}

function b1FixtureBasename(file) {
  return file.split("/").pop() ?? file;
}

/** 登记项 → 冻结 fixture（原始字节 + 真值；真值字段与登记 id 对账）。 */
export function loadB1RegistryFixture(root, entry, registryName) {
  const bytes = readFileSync(join(root, ...B1_ROOT, entry.file));
  const truth = JSON.parse(readFileSync(join(root, ...B1_ROOT, entry.expected), "utf8"));
  if (truth.fixtureId !== entry.fixtureId) {
    throw new Error(`${registryName}: truth id ${String(truth.fixtureId)} ≠ registry id ${String(entry.fixtureId)}`);
  }
  if (typeof truth.canonicalText !== "string" || !Array.isArray(truth.blocks)) {
    throw new Error(`${registryName}: ${String(entry.fixtureId)} truth missing canonicalText/blocks`);
  }
  const expectedUnits = typeof truth.textUnits === "number" ? truth.textUnits : truth.canonicalText.length;
  if (expectedUnits !== truth.canonicalText.length) {
    throw new Error(`${registryName}: ${String(entry.fixtureId)} truth textUnits ${String(truth.textUnits)} ≠ canonicalText.length ${String(truth.canonicalText.length)} (fixture inconsistency)`);
  }
  return { fixtureId: entry.fixtureId, filename: b1FixtureBasename(entry.file), bytes, truth, expectedUnits };
}

const TERMINAL_PARSE_STATUSES = new Set(["ready", "failed", "canceled", "unsupported", "rejected"]);

/** 版本到达指定终态（ready / failed）；其他终态或超时如实失败。 */
async function waitForVersionStatus(ctx, treeId, materialId, versionId, fixtureId, wantStatus, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}`);
    const version = (res.body?.versions ?? []).find((candidate) => candidate.id === versionId) ?? null;
    if (res.status === 200 && version !== null && version.parseStatus === wantStatus) return version;
    if (res.status === 200 && version !== null && TERMINAL_PARSE_STATUSES.has(version.parseStatus)) {
      throw new Error(`${fixtureId}: parse ended as ${version.parseStatus} (wanted ${wantStatus}) — ${String(version.parseError)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${fixtureId}: parse did not reach ${wantStatus} in ${String(timeoutMs)}ms (last status: ${JSON.stringify(version?.parseStatus ?? res.status)})`);
    }
    await sleep(150);
  }
}

/** 分页读尽版本块图（浏览器同款读取面 GET …/versions/:versionId）。 */
async function readAllBlocksViaApi(ctx, treeId, materialId, versionId, fixtureId) {
  const out = [];
  let afterBlock = null;
  for (;;) {
    const query = afterBlock === null ? "" : `?afterBlock=${encodeURIComponent(afterBlock)}`;
    const res = await ctx.api(
      "GET",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}${query}`,
    );
    if (res.status !== 200) {
      throw new Error(`${fixtureId}: blocks page HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    }
    for (const entry of res.body?.blocks ?? []) {
      out.push({
        blockId: entry.block.blockId,
        kind: entry.block.kind,
        start: entry.block.start,
        end: entry.block.end,
        ...(entry.block.page !== undefined ? { page: entry.block.page } : {}),
        text: entry.text,
      });
    }
    const next = res.body?.nextAfterBlock ?? null;
    if (next === null) return out;
    afterBlock = next;
  }
}

async function countMaterialsViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials`);
  if (res.status !== 200) throw new Error(`materials list HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return (res.body?.materials ?? []).length;
}

/* ---- 确定性超限探针生成器（与 tests/support/verifier/d4-b1-import.ts 同源； */
/* ---- manifest.json sets.b1-import.generatedOversize 的执行配方）。        */

function utf8BytesOf(text) {
  return new TextEncoder().encode(text);
}

function latin1BytesOf(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** >20 MiB 的确定性 markdown 探针（文件字节上限；读体/解析前拒绝）。 */
function buildOversizeFileBytes() {
  const line = "oversize probe: charter D4 section 5 single-file 20 MiB limit (deterministic verify-time generation)\n";
  const target = 20 * 1024 * 1024 + 1;
  const repeats = Math.ceil(target / line.length);
  return utf8BytesOf(line.repeat(repeats).slice(0, target));
}

/** >1,000,000 UTF-16 单元、≤20 MiB 的确定性 markdown 探针（解析后、落库前拒绝）。 */
function buildOversizeTextUnitsBytes() {
  return utf8BytesOf("字".repeat(1_000_001));
}

/** >200 页的确定性单字体 PDF 探针（页树装载后、内容解释前拒绝）。 */
function buildOversizePagesPdf(pageCount = 201) {
  const content = "BT /F1 12 Tf 72 700 Td (oversize pages probe) Tj ET";
  const bodies = [];
  bodies.push("<< /Type /Catalog /Pages 2 0 R >>");
  bodies.push("");
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageRefs = [];
  for (let i = 0; i < pageCount; i += 1) {
    const contentNum = bodies.push(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`);
    const pageNum = bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentNum)} 0 R >>`,
    );
    pageRefs.push(`${String(pageNum)} 0 R`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${String(pageRefs.length)} >>`;
  const parts = ["%PDF-1.5\n%\xE2\xE3\xCF\xD3\n"];
  const offsets = [];
  let pos = parts[0].length;
  bodies.forEach((body, i) => {
    offsets.push(pos);
    const chunk = `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    pos += chunk.length;
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  parts.push(xref);
  parts.push(`trailer\n<< /Size ${String(bodies.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`);
  return latin1BytesOf(parts.join(""));
}

/* ---- 侧栏树切换（真实输入点击树列表行）。 ---- */

function activeTreeIdInUiExpr() {
  return `(() => { const row = document.querySelector("#tree-list button.active"); ` +
    `if (row === null) return null; const name = row.querySelector("span"); ` +
    `return name === null ? null : name.textContent; })()`;
}

export async function switchTreeInUi(ctx, treeId) {
  const active = await ctx.evalJs(activeTreeIdInUiExpr());
  if (active === treeId) return;
  const index = await ctx.evalJs(
    `(() => { const rows = [...document.querySelectorAll("#tree-list button")]; ` +
      `return rows.findIndex((b) => (b.querySelector("span") === null ? "" : b.querySelector("span").textContent) === ${JSON.stringify(treeId)}); })()`,
  );
  if (index === null || index < 0) throw new Error(`tree ${treeId} not present in the sidebar tree list`);
  await inputClickAt(ctx, `#tree-list li:nth-child(${String(index + 1)}) button`);
  await waitFor(
    ctx,
    `(() => { const row = document.querySelector("#tree-list button.active"); ` +
      `return row !== null && (row.querySelector("span") === null ? "" : row.querySelector("span").textContent) === ${JSON.stringify(treeId)}; })()`,
    { label: `tree ${treeId} active in the sidebar` },
  );
}

/* ------------------------------------------------------------------ */
/* 阅读器就位 / 无损渲染断言                                              */
/* ------------------------------------------------------------------ */

export async function openMaterialInReader(ctx, material, { blocks, tail, timeoutMs = 20_000 }) {
  await inputClickAt(ctx, materialButtonSelector(material.materialId));
  return waitFor(ctx, pageReaderLoadedExpr(blocks, tail), { label: `material reader for ${material.title} (${String(blocks)} blocks)`, timeoutMs });
}

export async function readDomBlocks(ctx) {
  return ctx.evalJs(`(() => {
    const blocksEl = document.getElementById("mat-blocks");
    if (blocksEl === null) return [];
    const out = [];
    for (const child of blocksEl.children) {
      if (child.classList !== undefined && child.classList.contains("material-block")) {
        out.push({ blockId: child.dataset.blockId, start: Number(child.dataset.start), end: Number(child.dataset.end), text: child.textContent });
      }
    }
    return out;
  })()`);
}

/** 逐字无损：在场每个块 textContent/dataset 与冻结真值字节相等。 */
async function assertBlocksLossless(ctx, truth, { expectedCount, label }) {
  const domBlocks = await readDomBlocks(ctx);
  if (domBlocks.length !== expectedCount) {
    throw new Error(`${label}: ${String(domBlocks.length)} blocks in view, expected ${String(expectedCount)}`);
  }
  const byId = new Map(truth.blocks.map((block) => [block.blockId, block]));
  for (const dom of domBlocks) {
    const frozen = byId.get(dom.blockId);
    if (frozen === undefined) {
      throw new Error(`${label}: block ${dom.blockId} is not in the frozen truth`);
    }
    if (dom.text !== frozen.text || dom.start !== frozen.start || dom.end !== frozen.end) {
      throw new Error(
        `${label}: block ${dom.blockId} is not byte-equal to the frozen truth ` +
          `(text equal: ${String(dom.text === frozen.text)}, range [${String(dom.start)}, ${String(dom.end)}) vs [${String(frozen.start)}, ${String(frozen.end)}))`,
      );
    }
  }
  return domBlocks.length;
}

/** 阅读器 chrome：版本标签 / 解析器种类与版本 / 版本链。 */
async function assertReaderChrome(ctx, material, truth) {
  const info = await ctx.evalJs(`(() => {
    const reader = document.getElementById("material-reader");
    const label = reader === null ? null : reader.querySelector(".mat-version-label");
    const meta = reader === null ? null : reader.querySelector(".mat-meta");
    const chips = reader === null ? [] : Array.from(reader.querySelectorAll(".mat-version-chip"));
    return {
      label: label === null ? null : label.textContent,
      meta: meta === null ? null : meta.textContent,
      chips: chips.map((chip) => ({ text: chip.textContent, active: chip.classList.contains("active") })),
    };
  })()`);
  const problems = [];
  if (info.label !== "v1 (current)") problems.push(`version label ${JSON.stringify(info.label)} ≠ "v1 (current)"`);
  if (info.meta === null || !info.meta.includes(`markdown · ${truth.normalizer}`)) {
    problems.push(`meta does not state parser kind/version: ${JSON.stringify(info.meta)}`);
  }
  if (!info.meta.includes(`${String(truth.textUnits)} text units`)) {
    problems.push(`meta textUnits mismatch: ${JSON.stringify(info.meta)}`);
  }
  if (info.chips.length !== 1 || info.chips[0].text !== "v1 · markdown" || info.chips[0].active !== true) {
    problems.push(`version strip mismatch: ${JSON.stringify(info.chips)}`);
  }
  if (problems.length > 0) {
    throw new Error(`reader chrome for ${material.title} — ${problems.join("; ")}`);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 探针 1：d4-import-material                                            */
/* ------------------------------------------------------------------ */

export async function importMaterialViaHttp(ctx, treeId, filename, bytes, timeoutMs = 15_000) {
  const port = ctx.studioPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/trees/${encodeURIComponent(treeId)}/materials`, {
      method: "POST",
      headers: { "x-treeai-filename": encodeURIComponent(filename), "content-type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForVersionReady(ctx, treeId, materialId, versionId, fixtureId) {
  return waitForVersionStatus(ctx, treeId, materialId, versionId, fixtureId, "ready");
}

export async function probeImportMaterial(ctx) {
  const fixtures = FIXTURE_IDS.map((id) => loadB1Fixture(ctx.ROOT, id));
  ctx.noteFixturesUsed(FIXTURE_IDS);

  /* 1) 建树：真实 UI 路径（空态主操作按钮）。若页面已有打开的树（复跑/
        指定 --data），如实沿用而不重复建树。 */
  const emptyStateVisible = await ctx.evalJs(
    `(() => { const el = document.getElementById("empty-state"); return el !== null && !el.hidden && document.getElementById("empty-new-tree") !== null; })()`,
  );
  if (emptyStateVisible === true) {
    await inputClickAt(ctx, "#empty-new-tree");
  }
  await waitFor(
    ctx,
    `(() => {
      const section = document.getElementById("materials-section");
      const list = document.getElementById("material-list");
      if (section === null || section.hidden || list === null || list.children.length === 0) return false;
      return { firstItem: list.children[0].textContent };
    })()`,
    { label: "tree opened and the sidebar Materials section rendered" },
  );
  const trees = await ctx.api("GET", "/api/trees");
  if (trees.status !== 200 || (trees.body?.trees ?? []).length !== 1) {
    throw new Error(
      `expected exactly one tree in the fresh data dir (got ${String(trees.body?.trees?.length ?? "?")}); ` +
        "re-running the material probes against a reused --data dir is not supported — use a fresh data dir",
    );
  }
  const treeId = trees.body.trees[0].id;
  ctx.scenario.treeId = treeId;

  /* 2) 导入：真实 HTTP API（D4-1 契约面；导入 UI 属后续增量——浏览器
        侧未来将调用同一端点）。冻结 fixture 原始字节 + 文件名头。 */
  const imported = {};
  for (const { fixtureId, filename, bytes, truth } of fixtures) {
    const res = await importMaterialViaHttp(ctx, treeId, filename, bytes);
    if (res.status !== 201 || res.body?.created !== true) {
      throw new Error(`${fixtureId}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
    }
    const material = res.body.material;
    const version = res.body.version;
    if (version.parserKind !== "markdown") {
      throw new Error(`${fixtureId}: parserKind ${String(version.parserKind)} ≠ markdown`);
    }
    const ready = await waitForVersionReady(ctx, treeId, material.id, version.id, fixtureId);
    if (ready.textUnits !== truth.textUnits) {
      throw new Error(`${fixtureId}: server textUnits ${String(ready.textUnits)} ≠ frozen ${String(truth.textUnits)}`);
    }
    if (typeof material.title !== "string" || !material.title.includes(fixtureId)) {
      throw new Error(`${fixtureId}: material title does not identify the fixture: ${JSON.stringify(material.title)}`);
    }
    imported[fixtureId] = { fixtureId, materialId: material.id, versionId: version.id, title: material.title, textUnits: ready.textUnits };
  }
  ctx.scenario.materials = imported;

  /* 3) 刷新页面（真实导航）：应用重启动 → 自动开树 → 拉材料列表。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(FIXTURE_IDS.length)} ? true : false; })()`,
    { label: `sidebar materials list with ${String(FIXTURE_IDS.length)} entries after reload` },
  );

  /* 4) 逐条断言：ready 状态 + 种类/版本标签（真实 DOM）。 */
  for (const fixtureId of FIXTURE_IDS) {
    const entry = imported[fixtureId];
    const info = await ctx.evalJs(
      `(() => { const btn = document.querySelector(${JSON.stringify(materialButtonSelector(entry.materialId))}); ` +
        `if (btn === null) return null; ` +
        `const name = btn.querySelector("span"); const meta = btn.querySelector(".material-meta"); ` +
        `const status = btn.querySelector(".material-status"); ` +
        `return { name: name === null ? null : name.textContent, meta: meta === null ? null : meta.textContent, ` +
        `status: status === null ? null : status.textContent, statusClass: status === null ? null : status.className }; })()`,
    );
    if (info === null) throw new Error(`${fixtureId}: no sidebar button for material ${entry.materialId}`);
    const problems = [];
    if (info.name !== entry.title) problems.push(`title ${JSON.stringify(info.name)} ≠ ${JSON.stringify(entry.title)}`);
    if (info.meta !== "markdown · v1 · ready") problems.push(`meta ${JSON.stringify(info.meta)} ≠ "markdown · v1 · ready"`);
    if (info.status !== "ready") problems.push(`status ${JSON.stringify(info.status)} ≠ "ready"`);
    if (info.statusClass !== "material-status ready") problems.push(`status class ${JSON.stringify(info.statusClass)} ≠ "material-status ready"`);
    if (problems.length > 0) throw new Error(`${fixtureId}: sidebar entry mismatch — ${problems.join("; ")}`);
  }

  await ctx.screenshot("materials-list");
  const pageErrors = assertNoPageErrors(ctx, { label: "d4-import-material" });
  await ctx.sidecar("import-materials", {
    check: "d4-import-material",
    treeId,
    fixtures: Object.fromEntries(
      Object.entries(imported).map(([fixtureId, entry]) => [
        fixtureId,
        { materialId: entry.materialId, versionId: entry.versionId, title: entry.title, textUnits: entry.textUnits, parseStatus: "ready" },
      ]),
    ),
    sidebarAssertion: "markdown · v1 · ready for each entry",
    pageErrors,
  });
  return {
    detail:
      `${String(FIXTURE_IDS.length)} frozen B1 fixtures imported via the real HTTP API (echo studio) and listed ready ` +
      `in the real sidebar (markdown · v1 · ready); server textUnits match the frozen truth`,
  };
}

/* ------------------------------------------------------------------ */
/* 探针 2：d4-read-and-select                                            */
/* ------------------------------------------------------------------ */

export async function probeReadAndSelect(ctx) {
  const materials = ctx.scenario.materials;
  if (materials === null || FIXTURE_IDS.some((id) => materials[id] === undefined)) {
    throw new ctx.NotRunError("材料未全部导入就位（见 d4-import-material 的结果）——阅读/选区探针级联跳过");
  }
  const treeId = ctx.scenario.treeId;
  const selections = loadB2Selections(ctx.ROOT);
  const fixtureOf = (id) => loadB1Fixture(ctx.ROOT, id);
  const pick = (id, fixtureId) => {
    const item = selections.get(id);
    if (item === undefined) throw new Error(`frozen selection ${id} missing from markdown-selections.json`);
    if (item.fixture !== fixtureId) throw new Error(`frozen selection ${id} targets fixture ${item.fixture}, expected ${fixtureId}`);
    return item;
  };
  const cases = [];

  /* ---- md-06（emoji/字素簇家族；16 块单页） ---- */
  const md06 = fixtureOf("md-06");
  await openMaterialInReader(ctx, materials["md-06"], { blocks: md06.truth.blocks.length, tail: "end" });
  await assertReaderChrome(ctx, materials["md-06"], md06.truth);
  await assertBlocksLossless(ctx, md06.truth, { expectedCount: md06.truth.blocks.length, label: "md-06" });
  await ctx.screenshot("reader-md06");

  for (const id of ["md-sel-29", "md-sel-30", "md-sel-31", "md-sel-32", "md-sel-33"]) {
    cases.push(await captureFrozenSelection(ctx, { treeId, material: materials["md-06"], item: pick(id, "md-06"), truth: md06.truth }));
  }

  /* 字素安全吸附（浏览器面专属，B2 inv 类别的前端镜像）：故意把选区边界
     放进 👨‍💻 字素簇内部（代理对之间起、簇内止）——捕获条必须向外吸附到
     整簇 [833, 838)，与冻结真值 md-sel-30 全等并携带吸附注记。 */
  {
    const item = pick("md-sel-30", "md-06");
    const placed = await ctx.evalJs(pageSelectCanonical(item.expected.blockId, item.expected.start + 1, item.expected.end - 1));
    if (placed === null || placed.error !== undefined) {
      throw new Error(`grapheme-split case could not be placed — ${JSON.stringify(placed)}`);
    }
    const bar = await waitForArmedBar(ctx, "grapheme-split (md-sel-30 truth)");
    assertBarPayload(bar, {
      materialId: materials["md-06"].materialId,
      versionId: materials["md-06"].versionId,
      expected: item.expected,
      caseId: "grapheme-split (md-sel-30 truth)",
      expectSnap: true,
    });
    cases.push({ id: "grapheme-split→md-sel-30", category: "emoji-split-snap", blockId: item.expected.blockId, start: item.expected.start, end: item.expected.end });
  }
  await ctx.screenshot("selection-md06-emoji");

  /* ---- md-01（真实鼠标两击选区 + 真实连续拖选 + 重复词第 5 次出现 + 跨行；14 块单页） ---- */
  const md01 = fixtureOf("md-01");
  await openMaterialInReader(ctx, materials["md-01"], { blocks: md01.truth.blocks.length, tail: "end" });
  await assertBlocksLossless(ctx, md01.truth, { expectedCount: md01.truth.blocks.length, label: "md-01" });
  cases.push(await mouseSelectFrozenSelection(ctx, { treeId, material: materials["md-01"], item: pick("md-sel-01", "md-01"), truth: md01.truth }));
  /* 真实连续拖选（owner P1 #3）：mousedown 置锚「分」左缘 → mouseMoved×8
     跨文本推进 → mouseup 落「术」右缘——拖拽窗口内捕获条冻结（main 修复），
     释放点不被布局位移带偏；md-sel-02 为此前未覆盖的冻结选区（新增覆盖）。 */
  cases.push(await mouseDragFrozenSelection(ctx, { treeId, material: materials["md-01"], item: pick("md-sel-02", "md-01"), truth: md01.truth }));
  cases.push(await captureFrozenSelection(ctx, { treeId, material: materials["md-01"], item: pick("md-sel-19", "md-01"), truth: md01.truth }));
  cases.push(await captureFrozenSelection(ctx, { treeId, material: materials["md-01"], item: pick("md-sel-22", "md-01"), truth: md01.truth }));
  await ctx.screenshot("selection-md01-crossline");

  /* 跨块纪律（B2：markdown 选区必须含于单块）：blk-1 尾部 → blk-2 开头
     的真实 DOM 选区 → 捕获条如实呈不可锚定，绝不给出载荷。 */
  {
    const placed = await ctx.evalJs(pageSelectCrossBlock("blk-1", 140, "blk-2", 5));
    if (placed === null || placed.error !== undefined) {
      throw new Error(`cross-block case could not be placed — ${JSON.stringify(placed)}`);
    }
    const bar = await waitForArmedBar(ctx, "cross-block discipline");
    if (bar.invalidNote === null || !bar.invalidNote.includes("cross-block")) {
      throw new Error(`cross-block selection was not refused: ${JSON.stringify(bar)}`);
    }
    if (bar.payload !== null || bar.quote !== null) {
      throw new Error(`cross-block selection produced a payload (must not): ${JSON.stringify(bar)}`);
    }
    cases.push({ id: "cross-block-refused", category: "cross-block", blockId: null, start: null, end: null });
  }

  /* ---- md-11（59 块 > 50/页：懒加载第二页 + 长尾 + 重复词第 4 次出现） ---- */
  const md11 = fixtureOf("md-11");
  await openMaterialInReader(ctx, materials["md-11"], { blocks: 50, tail: "more" });
  await assertBlocksLossless(ctx, md11.truth, { expectedCount: 50, label: "md-11 page 1" });
  /* 真实滚动到底 → 应用自身的滚动监听触发第二页预取。 */
  await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
  await waitFor(ctx, pageReaderLoadedExpr(md11.truth.blocks.length, "end"), { label: "md-11 lazy-loaded second page (59 blocks)", timeoutMs: 15_000 });
  await assertBlocksLossless(ctx, md11.truth, { expectedCount: md11.truth.blocks.length, label: "md-11 all blocks" });
  await ctx.screenshot("reader-md11-lazyloaded");

  for (const id of ["md-sel-21", "md-sel-41", "md-sel-40"]) {
    cases.push(await captureFrozenSelection(ctx, { treeId, material: materials["md-11"], item: pick(id, "md-11"), truth: md11.truth }));
  }

  /* 复制不变（charter §3.2「复制摘录」）：点击阅读器自身的复制按钮 →
     剪贴板内容 === canonicalText 切片（冻结摘录）。 */
  let copyMode;
  {
    const item = pick("md-sel-40", "md-11");
    const expected = item.expected;
    /* DOM click 事件（应用自身的 click 监听路径）。不用 CDP 输入点击的原因：
       输入点击的 press/release 分两次 CDP 命令送达，press 引发的浏览器
       选区清除会让应用 0ms 延迟解除的捕获条重渲抢在 release 之前（真实
       用户点击不经 CDP 分段——应用的焦点守卫按连续输入保证成立）。 */
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    await waitFor(
      ctx,
      `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); return btn !== null && btn.textContent === "Copied ✓"; })()`,
      { label: "copy-quote confirmation (Copied ✓)", timeoutMs: 4000 },
    );
    try {
      await ctx.cdpSend("Browser.grantPermissions", { origin: ctx.studioOrigin(), permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    } catch {
      /* 授权不可用 → 下方降级路径如实报告 */
    }
    const read = await ctx.evalJs(
      `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
        `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
    );
    if (read.ok === true) {
      if (read.text !== expected.excerpt) {
        throw new Error(
          `copy quote: clipboard content differs from the canonical excerpt ` +
            `(${String(read.text.length)} vs ${String(expected.excerpt.length)} UTF-16 units)`,
        );
      }
      copyMode = "clipboard read-back byte-equal";
    } else {
      /* 诚实降级：复制确认态（Copied ✓）已验证 + 摘录与冻结 canonicalText
         切片字节相等（复制的就是该切片）。 */
      if (md11.truth.canonicalText.slice(expected.start, expected.end) !== expected.excerpt) {
        throw new Error("frozen excerpt is not the canonicalText slice (fixture inconsistency)");
      }
      copyMode = `copy-confirmed (clipboard read-back unavailable: ${String(read.error)})`;
    }
  }

  cases.push(await captureFrozenSelection(ctx, { treeId, material: materials["md-11"], item: pick("md-sel-42", "md-11"), truth: md11.truth }));
  await ctx.screenshot("selection-md11-longtail");

  const pageErrors = assertNoPageErrors(ctx, { label: "d4-read-and-select" });
  await ctx.sidecar("read-select-cases", {
    check: "d4-read-and-select",
    cases,
    frozenSelectionsExact: cases.filter((entry) => entry.id.startsWith("md-sel")).length,
    snapCase: "grapheme-split snapped outward to md-sel-30 truth",
    crossBlock: "refused (no payload)",
    copyQuote: copyMode,
    pageErrors,
  });
  const frozenCount = cases.filter((entry) => entry.id.startsWith("md-sel")).length;
  return {
    detail:
      `${String(frozenCount)}/${String(frozenCount)} frozen B2 selections captured exactly in the real reader ` +
      `(emoji/ZWJ/flags/keycaps, repeat-word 2nd/4th/5th occurrence, cross-line, long-tail past lazy-load; ` +
      `2 via real mouse gestures: click + Shift+click, and a continuous press→move×8→release drag — the bar ` +
      `stays frozen during the drag window); grapheme-split snapped outward; cross-block refused; ` +
      `resolve-selection agrees on all (incl. sourceHash = SHA-256 of the frozen canonicalText); copy quote: ${copyMode}`,
  };
}

/* ------------------------------------------------------------------ */
/* 探针 3：d4-restart-continue                                           */
/* ------------------------------------------------------------------ */

async function waitForReadingPosition(ctx, treeId, material, blockId) {
  const deadline = Date.now() + 6000;
  for (;;) {
    const res = await ctx.api(
      "GET",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(material.materialId)}/reading-position`,
    );
    const pos = res.body?.readingPosition ?? null;
    if (res.status === 200 && pos !== null && pos.blockId === blockId) {
      if (pos.versionId !== material.versionId) {
        throw new Error(`saved reading position versionId ${String(pos.versionId)} ≠ ${String(material.versionId)}`);
      }
      if (pos.focusStart !== null) {
        throw new Error(`saved reading position focusStart ${String(pos.focusStart)} ≠ null`);
      }
      return pos;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the reader's reading-position save did not land on ${blockId} (last seen: ${JSON.stringify(pos)})`);
    }
    await sleep(150);
  }
}

export async function probeRestartContinue(ctx) {
  const materials = ctx.scenario.materials;
  if (materials === null || materials["md-11"] === undefined || ctx.scenario.treeId === null) {
    throw new ctx.NotRunError("md-11 未导入就位（见 d4-import-material 的结果）——重启续读探针级联跳过");
  }
  const treeId = ctx.scenario.treeId;
  const md11 = loadB1Fixture(ctx.ROOT, "md-11");
  const entry = materials["md-11"];
  const totalBlocks = md11.truth.blocks.length; // 59
  const RESTORE_BLOCK = "blk-52";

  /* 1) 阅读器就位于 md-11 且第二页已载（幂等：已在读则聚焦不重载）。 */
  const state = await ctx.evalJs(
    `(() => { const reader = document.getElementById("material-reader"); ` +
      `const blocks = document.querySelectorAll("#mat-blocks .material-block").length; ` +
      `return { open: reader !== null && !reader.hidden, blocks: blocks }; })()`,
  );
  if (!(state !== null && state.open === true && state.blocks === totalBlocks)) {
    await inputClickAt(ctx, materialButtonSelector(entry.materialId));
    await waitFor(ctx, pageReaderLoadedExpr(50, "more"), { label: "md-11 reader first page", timeoutMs: 20_000 });
    await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
    await waitFor(ctx, pageReaderLoadedExpr(totalBlocks, "end"), { label: "md-11 second page", timeoutMs: 15_000 });
  }

  /* 2) 真实滚动：blk-52 顶部对齐（scroll 事件驱动应用自身路径）。 */
  const scrolled = await ctx.evalJs(pageTopAlignBlock(RESTORE_BLOCK));
  if (scrolled === null || scrolled.error !== undefined) {
    throw new Error(`could not top-align ${RESTORE_BLOCK} — ${JSON.stringify(scrolled)}`);
  }
  if (Math.abs(scrolled.diff) > 2) {
    throw new Error(`scroll to ${RESTORE_BLOCK} did not align (Δ${String(scrolled.diff)}px)`);
  }
  await sleep(250);

  /* 3) 阅读器自身的关闭按钮（真实输入点击）→ 立即冲刷阅读位置保存。 */
  await inputClickAt(ctx, "#mat-close");
  await waitFor(
    ctx,
    `(() => { const reader = document.getElementById("material-reader"); return reader !== null && reader.hidden; })()`,
    { label: "material reader closed" },
  );

  /* 4) 应用自己的保存路径已 PUT——经真实后端读回验证。 */
  const saved = await waitForReadingPosition(ctx, treeId, entry, RESTORE_BLOCK);

  /* 5) 停止 studio 进程（SIGTERM 优雅退出；超时 SIGKILL 兜底）。 */
  const oldPort = ctx.studioPort();
  await ctx.stopStudio();
  await ctx.navigate("about:blank"); /* 立即切断页面到旧进程的 SSE */

  /* 6) 同数据目录启动全新 studio 进程（新端口）。 */
  const newUrl = await ctx.restartStudio();
  await ctx.navigate(newUrl);
  /* 材料数按 API 实况（后续探针可在场景树追加材料——B3 探针的 pdf-01）。 */
  const expectedMaterials = await countMaterialsViaApi(ctx, treeId);
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(expectedMaterials)} ? true : false; })()`,
    { label: "materials list after restart" },
  );

  /* 7) 重开 md-11（真实 UI）：向前补页到保存块、恢复注记落位。 */
  await inputClickAt(ctx, materialButtonSelector(entry.materialId));
  const restored = await waitFor(ctx, pageReaderRestoredExpr(RESTORE_BLOCK, totalBlocks), {
    label: `reading position restored to ${RESTORE_BLOCK}`,
    timeoutMs: 25_000,
  });
  /* 视觉对齐硬断言（≤2px 容差——亚像素取整）：app.js 即时落位 + 渲染保位
     修复的回归锁。 */
  if (restored.diff > 2) {
    throw new Error(
      `restore scroll misaligned: #mat-blocks scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)} (diff ${String(restored.diff)}px)`,
    );
  }
  /* 持久化行的跨进程复核（新进程读回保存行——重启续读的服务端事实）。 */
  const persisted = await waitForReadingPosition(ctx, treeId, entry, RESTORE_BLOCK);
  await ctx.screenshot("restart-restored");

  /* 8) console 纪律：旧端口的连接拒绝（杀进程窗口内页面的 SSE 重连）是
        本探针主动注入的预期现象；其余错误一概失败。 */
  const excludedCount = assertNoPageErrors(ctx, {
    exclude: (e) => e.text.includes(`http://127.0.0.1:${String(oldPort)}`),
    label: "d4-restart-continue",
  });
  await ctx.sidecar("restart-continue", {
    check: "d4-restart-continue",
    treeId,
    material: entry.title,
    savedPosition: { versionId: saved.versionId, blockId: saved.blockId, focusStart: saved.focusStart, updatedAt: saved.updatedAt },
    persistedAcrossRestart: { versionId: persisted.versionId, blockId: persisted.blockId },
    restart: { oldPort, newPort: ctx.studioPort(), dataDirKept: true },
    restored: { blockId: RESTORE_BLOCK, blocks: restored.blocks, note: true, scroll: { scrollTop: restored.scrollTop, blockTop: restored.blockTop, diffPx: restored.diff } },
    pageErrorsExcluded: excludedCount,
  });
  return {
    detail:
      `reading position saved at ${RESTORE_BLOCK} via the reader's own save path (close-button flush) → ` +
      `studio SIGTERM → new process on the same data dir → reopened with the restore note and ${RESTORE_BLOCK} ` +
      `loaded (${String(restored.blocks)} blocks after forward paging; persisted row verified on the new process; ` +
      `visual scroll alignment asserted ≤2px: scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)})`,
  };
}

/* ------------------------------------------------------------------ */
/* 探针 5：d4-search-recover（B4 浏览器面：真实 UI 搜索 → 结果 → 来源跳转）*/
/* ------------------------------------------------------------------ */

/* 语料标记：探针自有事实经真实 API 落库（材料/首问对话/批注/Return），随后
 * 在真实 UI 里检索并逐类跳转断言。冻结 B4 集（55 正向/12 无结果）的引擎面
 * 由离线 b4-cross-material-find 执行；本探针补的是浏览器面：结果行逐字段、
 * 旧版本标注、无结果不编造、当前树/全部树范围、命中→来源。 */
const SEARCH_PROBE_MARKERS = {
  question: "TreeAI-搜索探针-QUESTION-7f3a",
  annotation: "TreeAI-搜索探针-批注-c41d",
  ret: "TreeAI-搜索探针-RETURN-90b2",
};
const SEARCH_PROBE_V1_ONLY = "偏移量分页";

/** md-01 首块内构造代理对安全的 UTF-16 半开区间（excerpt 必须与 canonical
 *  切片逐码元一致——边界落在代理对中间会被区间层拒绝，那是 B2 纪律）。 */
function searchProbeSafeBlockRange(truth) {
  const block = truth.blocks[0];
  const text = block.text;
  let local = Math.min(16, text.length);
  while (local > 0 && (text.charCodeAt(local - 1) & 0xfc00) === 0xd800) local -= 1;
  if (local === 0) throw new Error("md-01 first block has no surrogate-safe prefix");
  return { blockId: block.blockId, start: block.start, end: block.start + local, excerpt: text.slice(0, local) };
}

async function searchProbeApi(ctx, method, path, body, what) {
  const res = await ctx.api(method, path, body, 30_000);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${what}: HTTP ${String(res.status)} — ${JSON.stringify(res.body)}`);
  }
  return res;
}

/** 建库：树（沿用导入探针的树或自建）+ md-01 + 版本对 v1→v2 + 第二棵树
 *  的 md-06 + 材料 Branch/首问/批注/Return 五类真实事实。全部幂等（重复
 *  调用按既有事实对账，不重复造事实）。 */
async function ensureSearchCorpus(ctx) {
  let treeId = ctx.scenario.treeId ?? null;
  if (treeId === null) {
    const trees = await ctx.api("GET", "/api/trees");
    treeId = (trees.body?.trees ?? [])[0]?.id ?? null;
  }
  if (treeId === null) {
    await ctx.navigate(ctx.studioUrl());
    await inputClickAt(ctx, "#empty-new-tree");
    await waitFor(ctx, `(() => { const s = document.getElementById("materials-section"); return s !== null && !s.hidden; })()`, { label: "tree opened" });
    const trees = await ctx.api("GET", "/api/trees");
    treeId = (trees.body?.trees ?? [])[0]?.id ?? null;
    if (treeId === null) throw new Error("could not establish a tree for the search probe");
  }
  ctx.scenario.treeId = treeId;
  const materials = ctx.scenario.materials ?? {};

  /* md-01（材料命中与建枝基座）。 */
  if (materials["md-01"] === undefined) {
    const fixture = loadB1Fixture(ctx.ROOT, "md-01");
    const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes);
    if (res.status !== 201) throw new Error(`md-01 import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    await waitForVersionReady(ctx, treeId, res.body.material.id, res.body.version.id, "md-01");
    materials["md-01"] = { materialId: res.body.material.id, versionId: res.body.version.id, truth: fixture.truth };
  }
  ctx.scenario.materials = materials;
  const md01 = materials["md-01"];
  if (md01.truth === undefined) {
    /* 导入探针登记的条目不带真值——补挂冻结 truth（只读）。 */
    md01.truth = loadB1Fixture(ctx.ROOT, "md-01").truth;
  }

  if (ctx.scenario.searchCorpus !== true) {
    /* 版本对：v1（偏移量分页）→ v2（游标分页），v1 成为旧版本命中语料。 */
    const pairDir = join(ctx.ROOT, ...B1_MARKDOWN_DIR.slice(0, -1), "version-pairs");
    const v1Bytes = readFileSync(join(pairDir, "md-vpair-v1.md"));
    const v2Bytes = readFileSync(join(pairDir, "md-vpair-v2.md"));
    let vpairMaterialId = null;
    const listed = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials`);
    for (const material of listed.body?.materials ?? []) {
      if (typeof material.title === "string" && material.title.includes("md-vpair")) vpairMaterialId = material.id;
    }
    if (vpairMaterialId === null) {
      const res = await importMaterialViaHttp(ctx, treeId, "md-vpair-v1.md", v1Bytes);
      if (res.status !== 201) throw new Error(`md-vpair v1 import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
      vpairMaterialId = res.body.material.id;
      await waitForVersionReady(ctx, treeId, vpairMaterialId, res.body.version.id, "md-vpair-v1");
      /* 版本端点与导入端点同头语义（原始字节 + x-treeai-filename）；ctx.api
       *  只会 JSON，这里直接走字节头。 */
      const v2Raw = await fetch(`http://127.0.0.1:${String(ctx.studioPort())}/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(vpairMaterialId)}/versions`, {
        method: "POST",
        headers: { "x-treeai-filename": encodeURIComponent("md-vpair-v2.md"), "content-type": "application/octet-stream" },
        body: v2Bytes,
      });
      const v2Body = await v2Raw.json().catch(() => null);
      if (v2Raw.status !== 201) throw new Error(`md-vpair v2 HTTP ${String(v2Raw.status)}: ${JSON.stringify(v2Body)}`);
      await waitForVersionReady(ctx, treeId, vpairMaterialId, v2Body.version.id, "md-vpair-v2");
    }
    ctx.scenario.searchVpairMaterialId = vpairMaterialId;

    /* 材料 Branch + 幂等首问 + 批注 + Return（全部真实 D4-3 API）。 */
    const range = searchProbeSafeBlockRange(md01.truth);
    const resolved = await searchProbeApi(
      ctx, "POST",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(md01.materialId)}/versions/${encodeURIComponent(md01.versionId)}/resolve-selection`,
      { locator: { kind: "utf16-range", start: range.start, end: range.end }, excerpt: range.excerpt, blockId: range.blockId },
      "resolve-selection (md-01 first block)",
    );
    const selection = resolved.body?.selection ?? null;
    if (selection === null) throw new Error(`resolve-selection returned no canonical selection: ${JSON.stringify(resolved.body)}`);

    const intentKey = "browser-search-probe-md01";
    const branchRes = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
      { selection, intentKey, mode: "resume-or-create" }, 30_000);
    if (branchRes.status !== 200 && branchRes.status !== 201) {
      throw new Error(`from-material HTTP ${String(branchRes.status)}: ${JSON.stringify(branchRes.body)}`);
    }
    const branchId = branchRes.body?.branch?.id ?? null;
    if (branchId === null) throw new Error(`from-material returned no branch: ${JSON.stringify(branchRes.body)}`);

    const question = `这段材料最关键的论点是什么？请结合选区解释。（${SEARCH_PROBE_MARKERS.question}）`;
    const fq = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
      { intentKey, firstQuestion: question }, 60_000);
    if (fq.status !== 200 || fq.body?.dispatch !== "succeeded") {
      throw new Error(`material-first-question HTTP ${String(fq.status)} dispatch ${String(fq.body?.dispatch)}: ${JSON.stringify(fq.body?.error ?? null)}`);
    }
    const anchorTurnId = fq.body?.landed?.assistantTurnId ?? null;
    if (anchorTurnId === null) throw new Error(`first question landed no assistant turn: ${JSON.stringify(fq.body)}`);
    const answerText = fq.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof answerText !== "string" || answerText.length === 0) {
      throw new Error(`first question outcome carries no assistant text: ${JSON.stringify(fq.body?.outcome === null ? null : "outcome-present")}`);
    }

    /* 批注（术语面真实 API）：锚定首问回答（assistant turn），选区必须与
     *  回答文本的给定偏移切片逐字一致（锚定完整性），正文携带探针标记。 */
    let annoEnd = Math.min(12, answerText.length);
    while (annoEnd > 0 && (answerText.charCodeAt(annoEnd - 1) & 0xfc00) === 0xd800) annoEnd -= 1;
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/terminology/annotations`, {
      branchId, anchorTurnId,
      selection: { start: 0, end: annoEnd, text: answerText.slice(0, annoEnd) },
      mode: "range",
      term: "搜索探针术语",
      explanation: `这是搜索探针创建的批注解释（${SEARCH_PROBE_MARKERS.annotation}），用于浏览器面跳转验证。`,
    }, "annotation save");

    /* Return（材料 Branch 的收获回主线，真实 submitReturn 底层）。 */
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/material-return`, {
      fromBranchId: branchId,
      text: `材料探索的收获：这一段讲了核心论点（${SEARCH_PROBE_MARKERS.ret}）。`,
      idempotencyKey: "browser-search-probe-return-1",
    }, "material-return");

    /* 第二棵树 + md-02（跨树范围语料——导入探针的 md-01/06/11 都在第一棵树，
     *  不能用来区分范围；md-02 只进第二棵树）。 */
    let tree2Id = ctx.scenario.searchTree2Id ?? null;
    if (tree2Id === null) {
      const created = await searchProbeApi(ctx, "POST", "/api/trees", undefined, "create tree 2");
      tree2Id = created.body?.tree?.id ?? null;
      if (tree2Id === null) throw new Error("tree 2 creation returned no id");
      const md02 = loadB1Fixture(ctx.ROOT, "md-02");
      const res = await importMaterialViaHttp(ctx, tree2Id, md02.filename, md02.bytes);
      if (res.status !== 201) throw new Error(`md-02 import into tree 2 HTTP ${String(res.status)}`);
      await waitForVersionReady(ctx, tree2Id, res.body.material.id, res.body.version.id, "md-02(tree2)");
      ctx.scenario.searchTree2Id = tree2Id;
      ctx.scenario.searchTree2Phrase = md02.truth.canonicalText.slice(0, 12);
    }
    ctx.scenario.searchCorpus = true;
  }
  return {
    treeId,
    tree2Id: ctx.scenario.searchTree2Id ?? null,
    md06Excerpt: ctx.scenario.searchMd06Excerpt ?? null,
  };
}

/** 真实 UI 搜索：点击范围开关 → 清空并注入查询（CDP insertText）→ 点击
 *  Search → 等待状态行落定 → 返回命中行（真实 DOM 读出）。 */
async function runUiSearch(ctx, query, scope) {
  const scopeButton = scope === "tree" ? "#search-scope-tree" : "#search-scope-all";
  await inputClickAt(ctx, scopeButton);
  await ctx.evalJs(`(() => { document.getElementById("search-input").value = ""; })()`);
  await inputClickAt(ctx, "#search-input");
  await ctx.cdpSend("Input.insertText", { text: query });
  await inputClickAt(ctx, "#search-run");
  await waitFor(
    ctx,
    `(() => { const s = document.getElementById("search-status"); if (s === null) return false; ` +
      `const t = s.textContent ?? ""; return t.includes("hit(s) for") || t.includes("0 hits for"); })()`,
    { label: `search settled for ${JSON.stringify(query)}`, timeoutMs: 20_000 },
  );
  return ctx.evalJs(
    `(() => { const rows = [...document.querySelectorAll("#search-results button.search-hit")]; ` +
      `return { status: document.getElementById("search-status").textContent, ` +
        `rows: rows.map((row) => ({ kind: row.querySelector(".search-hit-kind")?.textContent ?? "", ` +
          `title: row.querySelector(".search-hit-title")?.textContent ?? "", ` +
          `meta: row.querySelector(".search-hit-meta")?.textContent ?? "", ` +
          `excerpt: row.querySelector(".search-hit-excerpt")?.textContent ?? "" })) }; })()`,
  );
}

export async function probeSearchRecover(ctx) {
  const { treeId, tree2Id } = await ensureSearchCorpus(ctx);
  ctx.noteFixturesUsed(["md-01", "md-02", "md-vpair-v1", "md-vpair-v2"]);
  const md01 = ctx.scenario.materials["md-01"];
  const problems = [];

  /* 前置：页面停在本树（后续跳转断言以本树为当前树）。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(ctx, `(() => { const s = document.getElementById("materials-section"); return s !== null && !s.hidden; })()`, { label: "workbench with the corpus tree open" });

  /* 1) 材料·旧版本命中：v1 独有短语 → 命中行标注「旧版本」→ 点击 → 打开
   *    命中版本（v1）的只读阅读面。 */
  const oldVersion = await runUiSearch(ctx, SEARCH_PROBE_V1_ONLY, "tree");
  const oldHit = oldVersion.rows.find((row) => row.kind === "材料" && row.meta.includes("旧版本")) ?? null;
  if (oldHit === null) {
    problems.push(`旧版本材料命中未出现（status=${JSON.stringify(oldVersion.status)}，rows=${JSON.stringify(oldVersion.rows.slice(0, 3))}）`);
  } else {
    const hitIndex = oldVersion.rows.indexOf(oldHit);
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")][${String(hitIndex)}].click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => { const root = document.getElementById("material-reader"); ` +
        `return root !== null && !root.hidden && (root.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_V1_ONLY)}); })()`,
      { label: "old-version hit jump opens the reader at the hit version" },
    );
    await ctx.screenshot("search-oldversion-jump");
  }

  /* 2) 批注命中 → 锚定视图 + 批注卡（正文含标记）。 */
  const anno = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.annotation, "tree");
  const annoHit = anno.rows.find((row) => row.kind === "批注") ?? null;
  if (annoHit === null) {
    problems.push(`批注命中未出现（status=${JSON.stringify(anno.status)}，rows=${JSON.stringify(anno.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "批注").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.annotation)}))()`,
      { label: "annotation hit jump reveals the saved annotation" },
    );
    await ctx.screenshot("search-annotation-jump");
  }

  /* 3) Return 命中 → 主线 Return 卡。 */
  const ret = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.ret, "tree");
  const retHit = ret.rows.find((row) => row.kind === "Return") ?? null;
  if (retHit === null) {
    problems.push(`Return 命中未出现（status=${JSON.stringify(ret.status)}，rows=${JSON.stringify(ret.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "Return").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.ret)}))()`,
      { label: "return hit jump reveals the saved return" },
    );
    await ctx.screenshot("search-return-jump");
  }

  /* 4) 对话命中（首问 turn）→ 点击跳转，正文标记可见。 */
  const turn = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.question, "tree");
  const turnHit = turn.rows.find((row) => row.kind === "对话") ?? null;
  if (turnHit === null) {
    problems.push(`对话命中未出现（status=${JSON.stringify(turn.status)}，rows=${JSON.stringify(turn.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "对话").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.question)}))()`,
      { label: "turn hit jump reveals the first-question turn" },
    );
    await ctx.screenshot("search-turn-jump");
  }

  /* 5) 无结果不编造。 */
  const none = await runUiSearch(ctx, "zzq-不存在于任何已保存事实的词-qxz", "tree");
  if (none.rows.length !== 0 || !(none.status ?? "").includes("0 hits")) {
    problems.push(`无结果查询不诚实（rows=${String(none.rows.length)}，status=${JSON.stringify(none.status)}）`);
  }

  /* 6) 当前树/全部树范围：md-02 只在第二棵树——当前树零命中、全部树命中。 */
  if (tree2Id !== null) {
    const md02Phrase = ctx.scenario.searchTree2Phrase;
    const inTree = await runUiSearch(ctx, md02Phrase, "tree");
    if (inTree.rows.length !== 0) {
      problems.push(`当前树范围泄漏跨树命中（md-02 语料只在第二棵树：rows=${JSON.stringify(inTree.rows.slice(0, 3))}）`);
    }
    const inAll = await runUiSearch(ctx, md02Phrase, "all");
    if (inAll.rows.length === 0) {
      problems.push(`全部树范围未命中第二棵树的 md-02（query=${JSON.stringify(md02Phrase)}，status=${JSON.stringify(inAll.status)}）`);
    }
  }

  assertNoPageErrors(ctx, { label: "d4-search-recover" });
  await ctx.sidecar("search-recover", {
    check: "d4-search-recover",
    treeId, tree2Id,
    markers: SEARCH_PROBE_MARKERS,
    problems,
    corpus: { md01: { materialId: md01.materialId, versionId: md01.versionId }, vpairMaterialId: ctx.scenario.searchVpairMaterialId ?? null },
  });
  if (problems.length > 0) {
    throw new Error(`d4-search-recover browser-face problems — ${problems.join("; ")}`);
  }
  return { detail: `5 类命中（材料·旧版本/批注/Return/对话）+ 无结果诚实 + 当前树/全部树范围，语料 md-01 + md-vpair + tree-2 md-02` };
}

/* ------------------------------------------------------------------ */
/* 探针 6：d4-import-denominator（B1 全分母浏览器面）                      */
/* ------------------------------------------------------------------ */

/**
 * B1 全分母（owner 2026-09-30 增量验收：浏览器面的导入分母必须铺满冻结集）：
 * 在专用树（真实 UI「＋ New Tree」建）里经真实导入 API 铺满 12 markdown +
 * 12 text-layer PDF 全部 ready fixture——每个版本到达 ready、textUnits 与
 * 冻结真值一致、经分页块读取面与冻结 canonicalText + 块图逐字节全等；
 * 8 个文件负例 + 3 个超限负例（manifest 配方确定性生成）如实拒绝：导入门
 * 拒绝（400/413，零持久化）或终态 failed（parseError 携冻结原因码、
 * textUnits 0、分块读取 409 material-not-ready——绝不伪装空成功文档）。
 * 全部经真实侧栏 Materials 列表呈现断言（ready/failed 状态逐条对账）。
 */
export async function probeImportDenominator(ctx) {
  if (ctx.scenario.treeId === null || ctx.scenario.materials === null) {
    throw new ctx.NotRunError("场景树/材料未就位（见 d4-import-material 的结果）——B1 全分母探针级联跳过");
  }
  const scenarioTreeId = ctx.scenario.treeId;
  const registries = loadB1Registries(ctx.ROOT);
  const readyTotal = registries.reduce((sum, r) => sum + r.fixtures.length, 0);
  const fileNegativesTotal = registries.reduce((sum, r) => sum + r.negativeFixtures.length, 0);
  ctx.noteFixturesUsed([
    ...registries.flatMap((r) => r.fixtures.map((f) => f.fixtureId)),
    ...registries.flatMap((r) => r.negativeFixtures.map((f) => f.fixtureId)),
  ]);

  /* 级联卫生：探针无论成败都把 UI 切回场景树（后续探针的当前树语义
     不因本探针的中途失败而被污染）。 */
  let denominatorTreeId = null;
  try {
  /* 1) 真实 UI 建专用树（第二棵树；不污染场景树的下游探针语义）。 */
  const treesBefore = await ctx.evalJs(`(() => document.querySelectorAll("#tree-list button").length)()`);
  await inputClickAt(ctx, "#new-tree");
  await waitFor(
    ctx,
    `(() => document.querySelectorAll("#tree-list button").length === ${String(Number(treesBefore) + 1)})()`,
    { label: "denominator tree row appears in the sidebar" },
  );
  const treeId = await ctx.evalJs(activeTreeIdInUiExpr());
  denominatorTreeId = treeId;
  if (typeof treeId !== "string" || treeId === scenarioTreeId) {
    throw new Error(`the new denominator tree did not become active (active=${JSON.stringify(treeId)})`);
  }
  const treesApi = await ctx.api("GET", "/api/trees");
  if ((treesApi.body?.trees ?? []).length !== Number(treesBefore) + 1) {
    throw new Error(`expected ${String(Number(treesBefore) + 1)} trees after the UI New Tree click (got ${String(treesApi.body?.trees?.length ?? "?")})`);
  }

  /* 2) 全分母导入：每个 ready fixture → 201 → ready → textUnits 真值 →
        分页块读取与冻结 canonicalText/块图逐字节全等。 */
  const imported = [];
  for (const { name, kind, fixtures } of registries) {
    for (const entry of fixtures) {
      const fixture = loadB1RegistryFixture(ctx.ROOT, entry, name);
      if (entry.outcome !== "ready") {
        throw new Error(`${name}: fixture ${String(entry.fixtureId)} has non-ready outcome '${String(entry.outcome)}'`);
      }
      const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes, 60_000);
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`${String(entry.fixtureId)}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
      }
      const material = res.body.material;
      const version = res.body.version;
      if (version.parserKind !== kind) {
        throw new Error(`${String(entry.fixtureId)}: parserKind ${String(version.parserKind)} ≠ ${kind}`);
      }
      if (typeof material.title !== "string" || !material.title.includes(String(entry.fixtureId))) {
        throw new Error(`${String(entry.fixtureId)}: material title does not identify the fixture: ${JSON.stringify(material.title)}`);
      }
      const ready = await waitForVersionStatus(ctx, treeId, material.id, version.id, String(entry.fixtureId), "ready", 60_000);
      if (ready.parserVersion !== fixture.truth.normalizer) {
        throw new Error(`${String(entry.fixtureId)}: parserVersion ${String(ready.parserVersion)} ≠ frozen ${String(fixture.truth.normalizer)}`);
      }
      if (ready.textUnits !== fixture.expectedUnits) {
        throw new Error(`${String(entry.fixtureId)}: server textUnits ${String(ready.textUnits)} ≠ frozen ${String(fixture.expectedUnits)}`);
      }
      const blocks = await readAllBlocksViaApi(ctx, treeId, material.id, version.id, String(entry.fixtureId));
      const gotText = blocks.map((block) => block.text).join("");
      if (gotText !== fixture.truth.canonicalText) {
        throw new Error(
          `${String(entry.fixtureId)}: canonical text via the blocks API diverges from the frozen truth ` +
            `(${String(gotText.length)} vs ${String(fixture.truth.canonicalText.length)} UTF-16 units)`,
        );
      }
      const gotMap = blocks.map(({ text, ...rest }) => rest);
      const wantMap = fixture.truth.blocks.map((block) => ({
        blockId: block.blockId,
        kind: block.kind,
        start: block.start,
        end: block.end,
        ...(block.page !== undefined ? { page: block.page } : {}),
      }));
      if (JSON.stringify(gotMap) !== JSON.stringify(wantMap)) {
        throw new Error(`${String(entry.fixtureId)}: block map via the blocks API diverges from the frozen truth`);
      }
      imported.push({
        fixtureId: String(entry.fixtureId),
        kind,
        materialId: material.id,
        versionId: version.id,
        title: material.title,
        textUnits: ready.textUnits,
        blocks: blocks.length,
      });
    }
  }
  if (imported.length !== readyTotal) {
    throw new Error(`imported ${String(imported.length)} ready fixtures, registry total is ${String(readyTotal)}`);
  }

  /* 3) 文件负例（negative/ + 登记册）：导入门拒绝（零持久化）或终态
        failed（冻结原因码 + textUnits 0 + 读取面 409 material-not-ready）。 */
  const negatives = [];
  for (const { name, kind, negativeFixtures } of registries) {
    for (const entry of negativeFixtures) {
      const fixtureId = String(entry.fixtureId);
      const reason = String(entry.reason);
      const bytes = readFileSync(join(ctx.ROOT, ...B1_ROOT, entry.file));
      const before = await countMaterialsViaApi(ctx, treeId);
      const res = await importMaterialViaHttp(ctx, treeId, b1FixtureBasename(entry.file), bytes, 60_000);
      if (fixtureId === "neg-md-empty") {
        if (res.status !== 400 || res.body?.error?.code !== "invalid-argument") {
          throw new Error(`${fixtureId}: expected HTTP 400 invalid-argument at the import gate (got ${String(res.status)} ${JSON.stringify(res.body?.error ?? res.body)})`);
        }
        const after = await countMaterialsViaApi(ctx, treeId);
        if (after !== before) {
          throw new Error(`${fixtureId}: gate rejection persisted rows anyway (${String(before)} → ${String(after)})`);
        }
        negatives.push({ fixtureId, verdict: "gate-rejected", http: 400, code: "invalid-argument", reason, persisted: false });
        continue;
      }
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`${fixtureId}: negative import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
      }
      const version = await waitForVersionStatus(ctx, treeId, res.body.material.id, res.body.version.id, fixtureId, "failed", 60_000);
      const parseError = typeof version.parseError === "string" ? version.parseError : "";
      if (!parseError.startsWith(`${reason}:`)) {
        throw new Error(`${fixtureId}: parseError '${parseError}' does not carry the frozen reason '${reason}'`);
      }
      if (version.textUnits !== 0) {
        throw new Error(`${fixtureId}: rejected document stored ${String(version.textUnits)} text units`);
      }
      const readRes = await ctx.api(
        "GET",
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(res.body.material.id)}/versions/${encodeURIComponent(res.body.version.id)}`,
      );
      if (readRes.status !== 409 || readRes.body?.error?.code !== "material-not-ready") {
        throw new Error(
          `${fixtureId}: reads of the rejected version must be refused 409 material-not-ready (got ${String(readRes.status)} ${JSON.stringify(readRes.body?.error?.code ?? null)})`,
        );
      }
      negatives.push({ fixtureId, verdict: "failed-version", reason, parseError: parseError.slice(0, 140), materialId: res.body.material.id, versionId: res.body.version.id, textUnits: 0 });
    }
  }
  if (negatives.length !== fileNegativesTotal) {
    throw new Error(`executed ${String(negatives.length)} file negatives, registry total is ${String(fileNegativesTotal)}`);
  }

  /* 4) 超限负例（manifest sets.b1-import.generatedOversize 配方；生成器与
        tests/support/verifier/d4-b1-import.ts 同源——确定性、不入仓）。 */
  {
    const before = await countMaterialsViaApi(ctx, treeId);
    const oversizeFile = await importMaterialViaHttp(ctx, treeId, "oversize-file-bytes.md", buildOversizeFileBytes(), 120_000);
    if (oversizeFile.status !== 413 || oversizeFile.body?.error?.code !== "material-too-large") {
      throw new Error(
        `oversize >20MiB: expected HTTP 413 material-too-large before parsing (got ${String(oversizeFile.status)} ${JSON.stringify(oversizeFile.body?.error ?? null)})`,
      );
    }
    if (await countMaterialsViaApi(ctx, treeId) !== before) {
      throw new Error("oversize >20MiB: the 413 gate rejection persisted rows anyway");
    }

    const pages = await importMaterialViaHttp(ctx, treeId, "oversize-pages.pdf", buildOversizePagesPdf(), 120_000);
    if (pages.status !== 201 || pages.body?.created !== true) {
      throw new Error(`oversize >200 pages: import did not 201 (HTTP ${String(pages.status)}): ${JSON.stringify(pages.body)}`);
    }
    const pagesVersion = await waitForVersionStatus(ctx, treeId, pages.body.material.id, pages.body.version.id, "oversize >200 pages", "failed", 90_000);
    if (!(typeof pagesVersion.parseError === "string" && pagesVersion.parseError.startsWith("pages-exceeded:"))) {
      throw new Error(`oversize >200 pages: parseError '${String(pagesVersion.parseError)}' does not carry 'pages-exceeded'`);
    }
    if (pagesVersion.textUnits !== 0) throw new Error("oversize >200 pages: rejected document stored text units");

    const units = await importMaterialViaHttp(ctx, treeId, "oversize-text-units.md", buildOversizeTextUnitsBytes(), 120_000);
    if (units.status !== 201 || units.body?.created !== true) {
      throw new Error(`oversize >1M units: import did not 201 (HTTP ${String(units.status)}): ${JSON.stringify(units.body)}`);
    }
    const unitsVersion = await waitForVersionStatus(ctx, treeId, units.body.material.id, units.body.version.id, "oversize >1M units", "failed", 90_000);
    if (!(typeof unitsVersion.parseError === "string" && unitsVersion.parseError.startsWith("text-units-exceeded:"))) {
      throw new Error(`oversize >1M units: parseError '${String(unitsVersion.parseError)}' does not carry 'text-units-exceeded'`);
    }
    if (unitsVersion.textUnits !== 0) throw new Error("oversize >1M units: rejected document stored text units");
    negatives.push(
      { fixtureId: "oversize-md-20mib", verdict: "gate-rejected", http: 413, code: "material-too-large", reason: "material-too-large", persisted: false },
      { fixtureId: "oversize-pdf-200pages", verdict: "failed-version", reason: "pages-exceeded", parseError: String(pagesVersion.parseError).slice(0, 140), materialId: pages.body.material.id, versionId: pages.body.version.id, textUnits: 0 },
      { fixtureId: "oversize-md-1m-units", verdict: "failed-version", reason: "text-units-exceeded", parseError: String(unitsVersion.parseError).slice(0, 140), materialId: units.body.material.id, versionId: units.body.version.id, textUnits: 0 },
    );
  }

  /* 5) 真实侧栏呈现：页面真实导航刷新（材料经 API 落库后的冷启动读取）→
        切到专用树（真实输入点击树列表行）→ 全部分母逐条对账。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(ctx, `(() => document.querySelectorAll("#tree-list button").length === ${String(Number(treesBefore) + 1)})()`, { label: "tree list after reload" });
  await switchTreeInUi(ctx, treeId);
  const expectedTotal = imported.length + negatives.filter((n) => n.persisted !== false).length;
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(expectedTotal)}; })()`,
    { label: `denominator sidebar with ${String(expectedTotal)} material entries`, timeoutMs: 20_000 },
  );
  const sidebar = await ctx.evalJs(
    `(() => [...document.querySelectorAll("#material-list button[data-material-id]")].map((btn) => ({ ` +
      `id: btn.dataset.materialId, name: btn.querySelector("span") === null ? null : btn.querySelector("span").textContent, ` +
      `meta: btn.querySelector(".material-meta") === null ? null : btn.querySelector(".material-meta").textContent, ` +
      `statusText: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").textContent, ` +
      `statusClass: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").className, ` +
      `statusTitle: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").title })))()`,
  );
  if (sidebar.length !== expectedTotal) {
    throw new Error(`sidebar shows ${String(sidebar.length)} materials, expected ${String(expectedTotal)}`);
  }
  const byId = new Map(sidebar.map((row) => [row.id, row]));
  const problems = [];
  for (const item of imported) {
    const row = byId.get(item.materialId);
    if (row === undefined) {
      problems.push(`${item.fixtureId}: no sidebar entry for material ${item.materialId}`);
      continue;
    }
    if (row.name !== item.title) problems.push(`${item.fixtureId}: title ${JSON.stringify(row.name)} ≠ ${JSON.stringify(item.title)}`);
    if (row.meta !== `${item.kind} · v1 · ready`) problems.push(`${item.fixtureId}: meta ${JSON.stringify(row.meta)} ≠ "${item.kind} · v1 · ready"`);
    if (row.statusText !== "ready") problems.push(`${item.fixtureId}: status ${JSON.stringify(row.statusText)} ≠ "ready"`);
    if (row.statusClass !== "material-status ready") problems.push(`${item.fixtureId}: status class ${JSON.stringify(row.statusClass)} ≠ "material-status ready"`);
  }
  for (const item of negatives) {
    if (item.persisted === false) {
      if (byId.has(item.materialId)) problems.push(`${item.fixtureId}: gate-rejected negative must not appear in the sidebar`);
      continue;
    }
    const row = byId.get(item.materialId);
    if (row === undefined) {
      problems.push(`${item.fixtureId}: no sidebar entry for the failed material`);
      continue;
    }
    if (row.statusClass !== "material-status failed") problems.push(`${item.fixtureId}: status class ${JSON.stringify(row.statusClass)} ≠ "material-status failed"`);
    if (!(typeof row.statusText === "string" && row.statusText.startsWith(`failed: ${item.reason}:`))) {
      problems.push(`${item.fixtureId}: status ${JSON.stringify(row.statusText)} does not start with "failed: ${item.reason}:"`);
    }
    if (!(typeof row.statusTitle === "string" && row.statusTitle.startsWith(`${item.reason}:`))) {
      problems.push(`${item.fixtureId}: status title (full parseError) ${JSON.stringify(row.statusTitle)} does not start with "${item.reason}:"`);
    }
  }
  const readyCount = sidebar.filter((row) => row.statusText === "ready").length;
  const failedCount = sidebar.filter((row) => row.statusClass === "material-status failed").length;
  if (readyCount !== imported.length) problems.push(`sidebar ready count ${String(readyCount)} ≠ ${String(imported.length)}`);
  if (failedCount !== negatives.filter((n) => n.persisted !== false).length) {
    problems.push(`sidebar failed count ${String(failedCount)} ≠ ${String(negatives.filter((n) => n.persisted !== false).length)}`);
  }
  if (problems.length > 0) throw new Error(`denominator sidebar mismatch — ${problems.join("; ")}`);
  await ctx.screenshot("denominator-sidebar");

  /* 6) 收尾：切回场景树（后续探针的当前树语义保持原样）。 */
  await switchTreeInUi(ctx, scenarioTreeId);
  const backCount = await countMaterialsViaApi(ctx, scenarioTreeId);
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(backCount)}; })()`,
    { label: `scenario tree materials restored in the sidebar (${String(backCount)})` },
  );

  const pageErrors = assertNoPageErrors(ctx, { label: "d4-import-denominator" });
  await ctx.sidecar("import-denominator", {
    check: "d4-import-denominator",
    treeId,
    readyFixtures: imported.map(({ fixtureId, kind, materialId, versionId, textUnits, blocks }) => ({ fixtureId, kind, materialId, versionId, textUnits, blocks })),
    negatives,
    counts: {
      ready: imported.length,
      fileNegatives: fileNegativesTotal,
      oversizeGenerated: 3,
      sidebarTotal: expectedTotal,
      sidebarReady: readyCount,
      sidebarFailed: failedCount,
    },
    truthAssertion: "every ready version byte-equal to the frozen canonicalText + block map via the paginated blocks API; every rejection carries the frozen reason code",
    pageErrors,
  });
  return {
    detail:
      `${String(imported.length)} ready fixtures (12 markdown + 12 text-layer PDF) imported via the real HTTP API into a UI-created tree, ` +
      `each byte-equal to the frozen canonicalText + block map via the paginated blocks API; ` +
      `${String(negatives.length)} negatives honestly rejected (2 at the import gate with zero persistence: empty→400, >20MiB→413; ` +
      `9 terminal failed versions carrying the frozen reason: invalid-utf8/nul-byte/whitespace-only/encrypted/corrupt/no-text-layer×2/pages-exceeded/text-units-exceeded, ` +
      `reads refused 409 material-not-ready); the real sidebar lists all ${String(expectedTotal)} entries with honest ready/failed status`,
  };
  } finally {
    if (denominatorTreeId !== null && denominatorTreeId !== scenarioTreeId) {
      try {
        await switchTreeInUi(ctx, scenarioTreeId);
      } catch {
        /* 尽力而为：切换失败时如实留给后续探针的级联报告，不吞本探针的原错误。 */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 探针 7：d4-export-restore-recover（B5 数据可携带浏览器面）              */
/* ------------------------------------------------------------------ */

/**
 * B5 恢复组合路径（D4-5 CLI + 真实浏览器）：
 *   事实建立（材料 + 材料 Branch + echo 首问 + 批注 + Return + 主线
 *   turn，全部真实 API）→ studio 进程优雅停止 → `apps/studio export
 *   --out`（charter §5 缺省不含 session）→ `--import-package` 恢复到
 *   全新空数据目录 → 在恢复目录上启动全新 studio 进程 → 真实浏览器里：
 *   重开材料阅读（与冻结真值逐字无损 + resolve-selection sourceHash
 *   复核）、侧栏 Search 找回复原事实（主线 turn / Return / 材料三类
 *   命中 → 来源跳转；支线命中行如实携带 session-unavailable 注记 +
 *   显式换轨入口）、session 未随包存活分支经 D4-3 恢复流打开面板
 *   （alignCursor:false——不重放注定失败的 /switch；续聊发送
 *   fail-closed + 常驻恢复注记）→ 显式「Start new exploration」换轨
 *   （confirm 二次确认经 CDP 接受）→ 新探索首问落地、session 恢复
 *   可用、旧历史保持可读。
 *
 * 注入的故障（如实入证，见 sidecar injectedFaults）：导出后将原数据目录
 * 的 sessions/ 移开——同机上模拟「包未携带 session（charter §5 缺省）→
 * 换机后 session 文件不存在」；恢复进程对引用路径的实时存在性探针由此
 * 如实报告 unavailable。探针结束时移回（原目录保持原样）。
 */
const B5_MARKERS = {
  question: "TreeAI-B5-恢复探针-首问-3e77",
  annotation: "TreeAI-B5-恢复探针-批注-8c14",
  ret: "TreeAI-B5-恢复探针-RETURN-52a9",
  trunkTurn: "TreeAI-B5-恢复探针-主线-e5a1",
  newExploration: "TreeAI-B5-恢复探针-新探索-d40f",
};

/** 侧栏命中行点击（真实 DOM click 事件——与既有搜索探针同一管线）。 */
async function clickSearchHitRow(ctx, kindLabel) {
  const clicked = await ctx.evalJs(
    `(() => { const hit = [...document.querySelectorAll("#search-results button.search-hit")]` +
      `.find((b) => b.querySelector(".search-hit-kind") !== null && b.querySelector(".search-hit-kind").textContent === ${JSON.stringify(kindLabel)}); ` +
      `if (hit === undefined) return false; hit.click(); return true; })()`,
  );
  if (clicked !== true) throw new Error(`no ${kindLabel} search-hit row found to click`);
  return true;
}

export async function probeExportRestoreRecover(ctx) {
  const treeId = ctx.scenario.treeId;
  const materials = ctx.scenario.materials;
  if (treeId === null || materials === null || materials["md-01"] === undefined) {
    throw new ctx.NotRunError("md-01 未导入就位（见 d4-import-material 的结果）——导出/恢复探针级联跳过");
  }
  const md01 = loadB1Fixture(ctx.ROOT, "md-01");
  const entry = materials["md-01"];
  if (entry.truth === undefined) entry.truth = md01.truth;
  const b5Range = searchProbeSafeBlockRange(md01.truth);

  /* 1) 事实建立（幂等：scenario.b5BranchId 在即对账复用）。 */
  let branchId = ctx.scenario.b5BranchId ?? null;
  if (branchId === null) {
    const resolved = await searchProbeApi(
      ctx, "POST",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(entry.materialId)}/versions/${encodeURIComponent(entry.versionId)}/resolve-selection`,
      { locator: { kind: "utf16-range", start: b5Range.start, end: b5Range.end }, excerpt: b5Range.excerpt, blockId: b5Range.blockId },
      "B5 resolve-selection (md-01 first block)",
    );
    const selection = resolved.body?.selection ?? null;
    if (selection === null) throw new Error(`B5 resolve-selection returned no canonical selection: ${JSON.stringify(resolved.body)}`);
    const intentKey = "browser-b5-restore-probe";
    /* mode "new"（显式另开）：同一 md-01 首块选区上已有搜索探针的探索
       （resume-or-create 会恢复它而不绑定本探针的 intentKey——首问对账
       会 400）；B5 需要自己的分支与提交键。 */
    const branchRes = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`, { selection, intentKey, mode: "new" }, 30_000);
    if (branchRes.status !== 200 && branchRes.status !== 201) {
      throw new Error(`B5 from-material HTTP ${String(branchRes.status)}: ${JSON.stringify(branchRes.body)}`);
    }
    if (branchRes.body?.mode !== "created" || branchRes.body?.created !== true) {
      throw new Error(`B5 from-material did not create a dedicated branch (mode=${JSON.stringify(branchRes.body?.mode)}): ${JSON.stringify(branchRes.body)}`);
    }
    branchId = branchRes.body?.branch?.id ?? null;
    if (branchId === null) throw new Error(`B5 from-material returned no branch: ${JSON.stringify(branchRes.body)}`);

    const fq = await ctx.api(
      "POST",
      `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
      { intentKey, firstQuestion: `请基于这段选区说明它在该材料结构中的作用。（${B5_MARKERS.question}）` },
      60_000,
    );
    if (fq.status !== 200 || fq.body?.dispatch !== "succeeded") {
      throw new Error(`B5 material-first-question HTTP ${String(fq.status)} dispatch ${String(fq.body?.dispatch)}: ${JSON.stringify(fq.body?.error ?? null)}`);
    }
    const anchorTurnId = fq.body?.landed?.assistantTurnId ?? null;
    if (anchorTurnId === null) throw new Error(`B5 first question landed no assistant turn: ${JSON.stringify(fq.body)}`);
    const answerText = fq.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof answerText !== "string" || answerText.length === 0) {
      throw new Error("B5 first question outcome carries no assistant text");
    }
    let annoEnd = Math.min(12, answerText.length);
    while (annoEnd > 0 && (answerText.charCodeAt(annoEnd - 1) & 0xfc00) === 0xd800) annoEnd -= 1;
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/terminology/annotations`, {
      branchId, anchorTurnId,
      selection: { start: 0, end: annoEnd, text: answerText.slice(0, annoEnd) },
      mode: "range",
      term: "B5恢复探针术语",
      explanation: `B5 恢复探针创建的批注解释（${B5_MARKERS.annotation}），用于恢复后找回验证。`,
    }, "B5 annotation save");
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/material-return`, {
      fromBranchId: branchId,
      text: `B5 恢复探针的 Return：材料探索的收获记录（${B5_MARKERS.ret}）。`,
      idempotencyKey: "browser-b5-restore-return-1",
    }, "B5 material-return");
    ctx.scenario.b5BranchId = branchId;
  }

  const stateOf = async () => {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    if (res.status !== 200) throw new Error(`B5 /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const branchViewIn = (state, id) => (state?.branches ?? []).find((view) => view?.branch?.id === id) ?? null;

  /* 主线事实（真实 prompt API——恢复后「来源跳转不受 session 影响」的主线
     命中语料；主线命中不开支线面板，跳转纯只读定位）。 */
  if (ctx.scenario.b5TrunkTurn !== true) {
    const state0 = await stateOf();
    const trunkBranchId = state0?.trunkBranchId ?? null;
    if (typeof trunkBranchId !== "string") throw new Error("B5: no trunk branch in the scenario tree state");
    const promptRes = await ctx.api(
      "POST",
      `/api/trees/${encodeURIComponent(treeId)}/prompt`,
      { branchId: trunkBranchId, text: `主线记录：材料阅读的阶段性结论（${B5_MARKERS.trunkTurn}）。` },
      60_000,
    );
    if (promptRes.status !== 200) {
      throw new Error(`B5 trunk prompt HTTP ${String(promptRes.status)}: ${JSON.stringify(promptRes.body)}`);
    }
    const assistantText = promptRes.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof assistantText !== "string" || assistantText.length === 0) {
      throw new Error("B5 trunk prompt outcome carries no assistant text (echo driver must answer)");
    }
    ctx.scenario.b5TrunkTurn = true;
    ctx.scenario.b5TrunkBranchId = trunkBranchId;
  }

  /* 2) 导出前事实核验：该分支 session 在原进程上可用（后续不可用是恢复语义，不是本来就坏）。 */
  const before = branchViewIn(await stateOf(), branchId);
  if (before === null || before.sessionAvailability !== "available") {
    throw new Error(`B5 branch must have an available session before export (got ${JSON.stringify(before?.sessionAvailability ?? null)})`);
  }
  const turnsBefore = before.turns.length;

  /* 3) 停 studio（优雅）→ CLI 导出 → CLI 恢复到全新空数据目录。 */
  const oldPort = ctx.studioPort();
  await ctx.stopStudio();
  await ctx.navigate("about:blank");
  const pkgDir = mkdtempSync(join(tmpdir(), "treeai-d4-b5-pkg-"));
  const restoredDir = mkdtempSync(join(tmpdir(), "treeai-d4-b5-restored-"));
  const dataDir = ctx.studioDataDir();
  const sessionsDir = join(dataDir, "sessions");
  const sessionsAside = join(dataDir, "sessions.aside-b5");
  let sessionsMoved = false;
  try {
    const exportRun = await ctx.runStudioCli(["export", "--out", pkgDir, "--data", dataDir], 180_000);
    if (exportRun.code !== 0 || !exportRun.stdout.includes("package written to")) {
      throw new Error(`B5 export CLI failed (exit ${String(exportRun.code)}): ${exportRun.stdout}\n${exportRun.stderr}`);
    }
    if (!exportRun.stdout.includes("sessions excluded by default")) {
      throw new Error(`B5 export CLI did not state the sessions-excluded default: ${exportRun.stdout}`);
    }
    const restoreRun = await ctx.runStudioCli(["--import-package", pkgDir, "--data", restoredDir], 180_000);
    if (restoreRun.code !== 0 || !restoreRun.stdout.includes("restored into")) {
      throw new Error(`B5 restore CLI failed (exit ${String(restoreRun.code)}): ${restoreRun.stdout}\n${restoreRun.stderr}`);
    }
    if (!restoreRun.stdout.includes("no Pi sessions in the package")) {
      throw new Error(`B5 restore CLI did not state the no-sessions honesty line: ${restoreRun.stdout}`);
    }

    /* 4) 注入的故障：原数据目录 sessions/ 移开（同机模拟换机后文件缺失；
          包缺省不含 session 是产品事实，这里只消除同机的残留路径）。 */
    renameSync(sessionsDir, sessionsAside);
    sessionsMoved = true;

    /* 5) 恢复目录上启动全新 studio 进程。 */
    const newUrl = await ctx.bootStudioOn(restoredDir);
    await ctx.navigate(newUrl);
    await waitFor(ctx, `(() => document.querySelectorAll("#tree-list button").length > 0)()`, { label: "restored workbench tree list" });
    await switchTreeInUi(ctx, treeId);

    /* 6) 服务端事实：恢复进程上该分支 session 不可用 + 旧 turns 完整可读。 */
    const stateAfter = await stateOf();
    const after = branchViewIn(stateAfter, branchId);
    if (after === null) throw new Error("B5 branch missing from the restored process state");
    if (after.sessionAvailability !== "unavailable") {
      throw new Error(`B5 branch session must be unavailable on the restored process (got ${JSON.stringify(after.sessionAvailability)})`);
    }
    if (after.turns.length !== turnsBefore) {
      throw new Error(`B5 restored branch turns ${String(after.turns.length)} ≠ saved ${String(turnsBefore)} (saved history must stay readable)`);
    }
    if (!after.turns.some((turn) => typeof turn?.text === "string" && turn.text.includes(B5_MARKERS.question))) {
      throw new Error("B5 restored branch turns do not carry the saved first-question marker");
    }

    /* 7) 恢复材料阅读：真实侧栏点击 → 逐字无损 + resolve-selection sourceHash。 */
    await inputClickAt(ctx, materialButtonSelector(entry.materialId));
    await waitFor(ctx, pageReaderLoadedExpr(md01.truth.blocks.length, "end"), { label: "restored md-01 reader (14 blocks)", timeoutMs: 25_000 });
    await assertBlocksLossless(ctx, md01.truth, { expectedCount: md01.truth.blocks.length, label: "restored md-01" });
    await resolveSelectionAndAssert(ctx, {
      treeId, material: entry,
      expected: { blockId: b5Range.blockId, start: b5Range.start, end: b5Range.end, excerpt: b5Range.excerpt },
      canonicalText: md01.truth.canonicalText,
      caseId: "b5-restored-resolve-selection",
    });
    await ctx.screenshot("restore-reader");

    /* 8) 侧栏 Search 找回复原事实（真实 UI）。
       主线 turn / Return / 材料 三类命中的来源跳转（主线与 Return 命中不
       开支线面板——纯只读定位，不受 session 影响）；支线 turn 命中行如实
       携带 session-unavailable 注记 + 显式换轨入口（点击该类命中开面板的
       路径当前被 /switch 对缺失 session 的 502 拦截——本波报告的产品缺
       陷，见证据记录；面板打开走 9) 的 D4-3 恢复流）。 */
    const trunkHits = await runUiSearch(ctx, B5_MARKERS.trunkTurn, "tree");
    if (trunkHits.rows.find((row) => row.kind === "对话") === null) {
      throw new Error(`B5 restored trunk turn not found via the sidebar Search (status=${JSON.stringify(trunkHits.status)}, rows=${JSON.stringify(trunkHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "对话");
    await waitFor(
      ctx,
      `(() => { const conv = document.getElementById("conversation"); ` +
        `return conv !== null && (conv.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.trunkTurn)}); })()`,
      { label: "trunk turn hit jump reveals the restored turn in the main conversation", timeoutMs: 20_000 },
    );

    const retHits = await runUiSearch(ctx, B5_MARKERS.ret, "tree");
    if (retHits.rows.find((row) => row.kind === "Return") === null) {
      throw new Error(`B5 restored return not found via the sidebar Search (rows=${JSON.stringify(retHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "Return");
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.ret)}))()`,
      { label: "return hit jump reveals the restored return card", timeoutMs: 20_000 },
    );

    const turnHits = await runUiSearch(ctx, B5_MARKERS.question, "tree");
    const turnRowIndex = turnHits.rows.findIndex((row) => row.kind === "对话");
    if (turnRowIndex < 0) {
      throw new Error(`B5 restored side-branch turn not found via the sidebar Search (rows=${JSON.stringify(turnHits.rows.slice(0, 3))})`);
    }
    const sessionNote = await ctx.evalJs(
      `(() => { const rows = [...document.querySelectorAll("#search-results li")]; ` +
        `const row = rows[${String(turnRowIndex)}]; if (row === undefined) return null; ` +
        `const note = row.querySelector(".search-hit-session"); const explore = row.querySelector(".search-hit-explore"); ` +
        `return { note: note === null ? null : note.textContent, explore: explore === null ? null : explore.textContent }; })()`,
    );
    if (sessionNote?.note === null || !(sessionNote.note ?? "").includes("session unavailable on this branch")) {
      throw new Error(`B5 side-branch turn hit must carry the session-unavailable note (got ${JSON.stringify(sessionNote)})`);
    }
    if (sessionNote?.explore === null || !(sessionNote.explore ?? "").includes("新探索")) {
      throw new Error(`B5 side-branch turn hit must carry the explicit new-exploration entry (got ${JSON.stringify(sessionNote)})`);
    }

    const annoHits = await runUiSearch(ctx, B5_MARKERS.annotation, "tree");
    if (annoHits.rows.find((row) => row.kind === "批注") === null) {
      throw new Error(`B5 restored annotation not found via the sidebar Search (rows=${JSON.stringify(annoHits.rows.slice(0, 3))})`);
    }

    const materialHits = await runUiSearch(ctx, b5Range.excerpt, "tree");
    if (materialHits.rows.find((row) => row.kind === "材料") === null) {
      throw new Error(`B5 restored material not found via the sidebar Search for its canonical first-block phrase (rows=${JSON.stringify(materialHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "材料");
    await waitFor(
      ctx,
      `(() => { const reader = document.getElementById("material-reader"); ` +
        `return reader !== null && !reader.hidden && (reader.textContent ?? "").includes(${JSON.stringify(b5Range.excerpt)}); })()`,
      { label: "material hit jump opens the restored reader at the hit", timeoutMs: 20_000 },
    );
    await ctx.screenshot("restore-facts-recovered");

    /* 9) session 未存活分支的面板打开（D4-3 材料建枝/恢复流——真实 UI 且
          对齐失败如实分离的路径）：阅读器内重建同一选区 → 捕获条 →
          「⑃ Branch from material」→ 恢复二选（既有探索 + session 不可用
          注记）→「↩ Open the existing exploration」→ 面板以
          alignCursor:false 打开（不重放注定失败的 /switch）。 */
    const placed = await ctx.evalJs(pageSelectCanonical(b5Range.blockId, b5Range.start, b5Range.end));
    if (placed === null || placed.error !== undefined) {
      throw new Error(`B5 branching-flow selection could not be placed — ${JSON.stringify(placed)}`);
    }
    const armedBar = await waitForArmedBar(ctx, "B5 branching-flow selection", 4000);
    if (armedBar.payload === null) throw new Error(`B5 branching-flow bar did not arm with a payload: ${JSON.stringify(armedBar)}`);
    /* DOM click（与复制按钮同款管线——CDP 输入点击的 press/release 分段会
       让 0ms 解除路径抢在 release 之前，见既有注释）。 */
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#mat-selection-bar .mat-branch-d43"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    const choice = await waitFor(
      ctx,
      `(() => { const flow = document.getElementById("mat-branch-flow"); ` +
        `if (flow === null) return false; const text = flow.textContent ?? ""; ` +
        `return text.includes("Open the existing exploration") ? { text } : false; })()`,
      { label: "branching flow reaches the restore-vs-new choice (existing exploration found)", timeoutMs: 15_000 },
    );
    if (!(choice.text ?? "").includes("the session at this branch's continuation point is unavailable")) {
      throw new Error(`B5 choice card must state the session-unavailable honesty note (got ${JSON.stringify(choice.text)})`);
    }
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#mat-branch-flow .mat-branch-resume"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    /* 阅读器是支线列的覆盖层（z-index 高于面板）且退出有 170ms 动画——
       必须等它完全 hidden 后才能与面板交互（真实用户节奏；否则输入点击
       落在仍可见的阅读器上）。 */
    await waitFor(
      ctx,
      `(() => { const r = document.getElementById("material-reader"); return r !== null && r.hidden === true; })()`,
      { label: "material reader exit animation settled (overlay gone)", timeoutMs: 5_000 },
    );
    await waitFor(
      ctx,
      `(() => { const panel = document.getElementById("branch-panel"); ` +
        `return panel !== null && !panel.hidden && (panel.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.question)}); })()`,
      { label: "resume opens the restored branch panel with the saved turn (no /switch replay)", timeoutMs: 15_000 },
    );
    /* session-unavailable 如实呈现：常驻降级注记 + 显式换轨入口可见可用 +
       续聊发送 fail-closed。 */
    const unavailableUi = await waitFor(
      ctx,
      `(() => { const note = document.getElementById("panel-session-note"); const btn = document.getElementById("panel-new-exploration"); ` +
        `const send = document.getElementById("panel-send"); ` +
        `if (note === null || btn === null || note.hidden || btn.hidden || btn.disabled) return false; ` +
        `return { note: note.textContent, btn: btn.textContent, sendDisabled: send === null ? null : send.disabled === true }; })()`,
      { label: "session-unavailable note + explicit new-exploration entry + fail-closed send", timeoutMs: 10_000 },
    );
    if (!(unavailableUi.note ?? "").includes("Session missing on this branch")) {
      throw new Error(`B5 session-unavailable note text mismatch: ${JSON.stringify(unavailableUi.note)}`);
    }
    if (unavailableUi.sendDisabled !== true) {
      throw new Error("B5 panel send must stay fail-closed while the session is unavailable");
    }
    await ctx.screenshot("restore-session-unavailable");

    /* 10) 显式新探索（面板 composer 的换轨入口，confirm 经 CDP 接受）。 */
    let dialogsSeen = 0;
    ctx.cdpOn("Page.javascriptDialogOpening", () => {
      dialogsSeen += 1;
      void ctx.cdpSend("Page.handleJavaScriptDialog", { accept: true }).catch(() => { /* 尽力而为 */ });
    });
    await inputClickAt(ctx, "#panel-prompt-input");
    await ctx.cdpSend("Input.insertText", { text: `新探索的第一问：请重新概括这段选区的内容要点。（${B5_MARKERS.newExploration}）` });
    const typed = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
    if (typeof typed !== "string" || !typed.includes(B5_MARKERS.newExploration)) {
      throw new Error(`B5 panel composer did not receive the typed first question (got ${JSON.stringify(typed)})`);
    }
    await inputClickAt(ctx, "#panel-new-exploration");
    /* 落地轮询（失败时快照 UI 状态入错——不吞真因）。 */
    const markerLandedExpr = `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.newExploration)}))()`;
    {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if ((await ctx.evalJs(markerLandedExpr)) === true) break;
        if (Date.now() >= deadline) {
          const snap = await ctx.evalJs(
            `(() => ({ inputValue: document.getElementById("panel-prompt-input").value, ` +
              `btnHidden: document.getElementById("panel-new-exploration").hidden, ` +
              `btnDisabled: document.getElementById("panel-new-exploration").disabled, ` +
              `noteHidden: document.getElementById("panel-session-note").hidden, ` +
              `panelError: (document.getElementById("panel-error-banner") === null ? null : document.getElementById("panel-error-banner").textContent ?? "").slice(0, 300), ` +
              `mainError: (document.getElementById("error-banner") === null ? null : document.getElementById("error-banner").textContent ?? "").slice(0, 300) }))()`,
          );
          throw new Error(
            `B5 new-exploration first question did not land in 30s (confirm dialogs seen: ${String(dialogsSeen)}); UI snapshot: ${JSON.stringify(snap)}`,
          );
        }
        await sleep(200);
      }
    }
    /* 收尾态：输入清空、session 注记/换轨入口随新 session 下线、旧历史仍可读。 */
    await waitFor(
      ctx,
      `(() => { const input = document.getElementById("panel-prompt-input"); ` +
        `return input !== null && input.value === ""; })()`,
      { label: "panel composer cleared after the new exploration", timeoutMs: 10_000 },
    );
    await waitFor(
      ctx,
      `(() => { const note = document.getElementById("panel-session-note"); const btn = document.getElementById("panel-new-exploration"); ` +
        `return note !== null && note.hidden === true && btn !== null && btn.hidden === true; })()`,
      { label: "session recovered after the explicit new exploration", timeoutMs: 10_000 },
    );
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.question)}))()`,
      { label: "the old saved history stays readable after the new exploration", timeoutMs: 10_000 },
    );
    const afterExplore = branchViewIn(await stateOf(), branchId);
    if (afterExplore.sessionAvailability !== "available") {
      throw new Error(`B5 branch session must be available after the explicit new exploration (got ${JSON.stringify(afterExplore.sessionAvailability)})`);
    }
    const assistantTurns = afterExplore.turns.filter((turn) => turn?.role === "assistant");
    if (assistantTurns.length === 0 || typeof assistantTurns[assistantTurns.length - 1].text !== "string" || assistantTurns[assistantTurns.length - 1].text.length === 0) {
      throw new Error("B5 new exploration landed no assistant answer (echo driver must answer)");
    }
    await ctx.screenshot("restore-new-exploration");

    /* 11) console 纪律：旧端口的连接拒绝（停进程窗口内页面 SSE 重连）是本探针
           主动注入的预期现象；其余错误一概失败。 */
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (e) => e.text.includes(`http://127.0.0.1:${String(oldPort)}`),
      label: "d4-export-restore-recover",
    });
    await ctx.sidecar("export-restore-recover", {
      check: "d4-export-restore-recover",
      treeId,
      branchId,
      markers: B5_MARKERS,
      facts: {
        material: entry.title,
        savedBranchTurns: turnsBefore,
        restoredBranchTurns: after.turns.length,
        turnsAfterNewExploration: afterExplore.turns.length,
      },
      export: { cli: "apps/studio export --out", packageDir: "<tmp>", sessionsExcluded: true },
      restore: { cli: "--import-package", dataDir: "<tmp>" },
      restart: { oldPort, newPort: ctx.studioPort(), restoredDataDir: "<tmp>" },
      injectedFaults: [
        "original data dir sessions/ renamed aside after export (same-machine stand-in for the charter §5 default: the package carries no sessions, so on any other machine the referenced file does not exist); renamed back at probe end",
      ],
      searchRecovery: {
        jumpsExercised: ["trunk turn → main conversation", "return → trunk Return card", "material → restored reader at the hit"],
        sideBranchHitRows: "carry the session-unavailable note + explicit new-exploration entry (rows not clicked: the search-hit panel-open path replays POST /switch, which the real server rejects 502 session-corrupt for a missing session file — reported to the owner, not fixed in this wave)",
      },
      sessionPath: { before: "available", afterRestore: "unavailable", afterNewExploration: "available" },
      pageErrorsExcluded: excludedCount,
    });
    return {
      detail:
        `facts (material + material branch + echo first-question + annotation + return + trunk turn) exported via the D4-5 CLI ` +
        `(sessions excluded by default) → restored into an empty data dir → new studio process → real browser: ` +
        `restored md-01 byte-equal to the frozen truth (resolve-selection sourceHash re-verified), sidebar Search recovered ` +
        `trunk-turn/return/material facts with source jumps and showed the session-unavailable note + explicit entry on the ` +
        `side-branch hit rows; the D4-3 resume flow opened the session-less branch panel (alignCursor:false, no /switch replay) with ` +
        `the fail-closed composer and recovery note, and the explicit new exploration landed a fresh session ` +
        `(${String(turnsBefore)} old turns + new pair readable, composer cleared)`,
    };
  } finally {
    if (sessionsMoved) {
      try { renameSync(sessionsAside, sessionsDir); } catch { /* 尽力而为 */ }
    }
  }
}
