/**
 * scripts/d4/browser/material-probes.mjs — D4 材料路径浏览器探针
 * （issue #8 §8 验收入口的 B1/B2 浏览器面；D4-2 前端落地后翻绿）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程（selftest 模式为 echo 驱动——离线确定性，永远不是
 * 真实 Pi 证据）。三条探针沿 owner 2026-09-30 增量验收要求的用户路径：
 *
 *   导入 → 阅读 → 精确选区 → 来源揭示 → 复制不变 → 重启续读
 *
 * 冻结真值（绝不在本文件内复制、运行时直接读取冻结文件）：
 *   - tests/fixtures/d4/b1-import/markdown/md-XX.md + md-XX.expected.json
 *     （canonicalText / blocks / textUnits）；
 *   - tests/fixtures/d4/b2-anchors/markdown-selections.json（选区语义：
 *     blockId / 绝对 UTF-16 区间 / 摘录）。
 *
 * 探针纪律：
 *   - 页面内的操作全部是真实 DOM/输入事件（CDP Input.dispatchMouseEvent
 *     的真实点击与真实鼠标两击选区（click 置 caret → Shift+click 扩展）；
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
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 冻结集（运行时读取，绝不内嵌副本）                                     */
/* ------------------------------------------------------------------ */

const B1_MARKDOWN_DIR = ["tests", "fixtures", "d4", "b1-import", "markdown"];
const B2_SELECTIONS_FILE = ["tests", "fixtures", "d4", "b2-anchors", "markdown-selections.json"];

/** 本探针使用的 B1 冻结 fixture（确定性挑选，覆盖中文/emoji/长文懒加载）。 */
const FIXTURE_IDS = ["md-01", "md-06", "md-11"];

function loadB1Fixture(root, fixtureId) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ctx, expression, { label, timeoutMs = 12_000, intervalMs = 150 } = {}) {
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

/** 真实输入点击（CDP Input 管线：mousePressed + mouseReleased 于元素中心）。 */
async function inputClickAt(ctx, selector) {
  const rect = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return null; const r = el.getBoundingClientRect(); ` +
      `if (r.width <= 0 || r.height <= 0) return { hidden: true }; ` +
      `return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (rect === null) throw new Error(`click target not found: ${selector}`);
  if (rect.hidden === true) throw new Error(`click target not visible: ${selector}`);
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
}

function materialButtonSelector(materialId) {
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
function pageSelectCanonical(blockId, start, end) {
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
function pageReaderLoadedExpr(expectedBlocks, tail) {
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
async function readCaptureBar(ctx) {
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

async function waitForArmedBar(ctx, caseId, timeoutMs = 4000) {
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

/** 页面 console/Log 错误纪律（探针自身的窗口）。 */
function assertNoPageErrors(ctx, { exclude = () => false, label } = {}) {
  const errors = ctx.pageErrors();
  const unexpected = errors.filter((entry) => !exclude(entry));
  if (unexpected.length > 0) {
    throw new Error(`page console/log errors (${label ?? "material probes"}): ${unexpected.map((e) => e.text).join(" | ")}`);
  }
  return errors.length;
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
/* 阅读器就位 / 无损渲染断言                                              */
/* ------------------------------------------------------------------ */

async function openMaterialInReader(ctx, material, { blocks, tail, timeoutMs = 20_000 }) {
  await inputClickAt(ctx, materialButtonSelector(material.materialId));
  return waitFor(ctx, pageReaderLoadedExpr(blocks, tail), { label: `material reader for ${material.title} (${String(blocks)} blocks)`, timeoutMs });
}

async function readDomBlocks(ctx) {
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

async function importMaterialViaHttp(ctx, treeId, filename, bytes) {
  const port = ctx.studioPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
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

async function waitForVersionReady(ctx, treeId, materialId, versionId, fixtureId) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}`);
    const version = (res.body?.versions ?? []).find((candidate) => candidate.id === versionId) ?? null;
    if (res.status === 200 && version !== null && version.parseStatus === "ready") return version;
    if (res.status === 200 && version !== null && (version.parseStatus === "failed" || version.parseStatus === "canceled" || version.parseStatus === "unsupported" || version.parseStatus === "rejected")) {
      throw new Error(`${fixtureId}: parse ended as ${version.parseStatus} — ${String(version.parseError)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${fixtureId}: parse did not reach ready in 20s (last status: ${JSON.stringify(version?.parseStatus ?? res.status)})`);
    }
    await sleep(150);
  }
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

  /* ---- md-01（真实鼠标两击选区 + 重复词第 5 次出现 + 跨行；14 块单页） ---- */
  const md01 = fixtureOf("md-01");
  await openMaterialInReader(ctx, materials["md-01"], { blocks: md01.truth.blocks.length, tail: "end" });
  await assertBlocksLossless(ctx, md01.truth, { expectedCount: md01.truth.blocks.length, label: "md-01" });
  cases.push(await mouseSelectFrozenSelection(ctx, { treeId, material: materials["md-01"], item: pick("md-sel-01", "md-01"), truth: md01.truth }));
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
      `1 via a real two-click mouse selection: click + Shift+click); grapheme-split snapped outward; cross-block refused; ` +
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
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(FIXTURE_IDS.length)} ? true : false; })()`,
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
