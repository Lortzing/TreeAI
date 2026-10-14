/** selection ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  sha256Text,
} from "./fixtures.mjs";
import {
  sleep,
  waitFor,
} from "./input.mjs";

/** 页面内公共前置（找块元素 / 块内偏移 → 文本节点锚点）。 */
export const PAGE_HELPERS = `
  const findBlock = (id) => {
    const blocksEl = document.getElementById("mat-blocks");
    if (blocksEl === null) return null;
    for (const child of blocksEl.children) {
      if (child.dataset !== undefined && child.dataset.blockId === id) {
        /* PDF 页框（.pdf-page-frame 携带同款 data-block-id/start/end，但页头
           「Page N」不在文本层内——frame.textContent 混入页头文字，偏移换算
           会整体平移）：定位元素取页框内的文本层 .pdf-page-text（其
           textContent 与页块文本字节相等，dataset 同源）。markdown 块不受
           影响（直接子元素即文本层本身）。 */
        if (child.classList !== undefined && child.classList.contains("pdf-page-frame")) {
          for (const inner of child.children) {
            if (inner.classList !== undefined && inner.classList.contains("pdf-page-text")) return inner;
          }
        }
        return child;
      }
    }
    return null;
  };
  const toAnchor = (blockEl, localOffset, preferNextOnBoundary = false) => {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let last = null;
    for (;;) {
      const node = walker.nextNode();
      if (node === null) return last && localOffset === pos ? last : null;
      const len = node.data.length;
      /* Adjacent DOM positions can represent the same canonical UTF-16 offset.
         Prefer the *next* rendered text node for selection starts: in the PDF
         geometry layer, an exact line boundary may otherwise anchor in the
         preceding direct newline node, which Chrome treats as unselectable.
         Never adjust offsets/excerpts or manufacture a selection. */
      if (localOffset < pos + len ||
          (localOffset === pos + len && !preferNextOnBoundary)) {
        return { node, offset: localOffset - pos };
      }
      pos += len;
      last = { node, offset: len };
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
    const a = toAnchor(blockEl, localStart, true);
    const b = toAnchor(blockEl, localEnd, false);
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
export function pageSelectCrossBlock(blockA, localStartA, blockB, localEndB) {
  return `(() => { ${PAGE_HELPERS}
    const elA = findBlock(${JSON.stringify(blockA)});
    const elB = findBlock(${JSON.stringify(blockB)});
    if (elA === null || elB === null) return { error: "block not loaded" };
    elA.scrollIntoView({ block: "center" });
    const a = toAnchor(elA, ${Number(localStartA)}, true);
    const b = toAnchor(elB, ${Number(localEndB)}, false);
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
    拖选释放点带偏，实测如此；两击手势天然免疫）。
    目标行先滚进 #mat-blocks 可见带再量落点：块级 scrollIntoView(center)
    对高于滚动视口的块会把目标行滚进裁剪区（getClientRects 不受裁剪——
    落点会命中阅读器 chrome；PDF 页文本层实测 1180px vs 435px 视口），
    故按目标行矩形对齐视口中心后重量。 */
export function pageClickPoints(blockId, start, end) {
  return `(() => { ${PAGE_HELPERS}
    const blockEl = findBlock(${JSON.stringify(blockId)});
    if (blockEl === null) return { error: "block ${blockId} is not loaded" };
    const blockStart = Number(blockEl.dataset.start);
    const blocksEl = document.getElementById("mat-blocks");
    const rectOf = (localFrom, localTo) => {
      const a = toAnchor(blockEl, localFrom, true);
      const b = toAnchor(blockEl, localTo, false);
      if (a === null || b === null) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = range.getClientRects();
      return rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    };
    if (blocksEl !== null) {
      const lead = rectOf(${Number(start)} - blockStart, ${Number(start)} - blockStart + 1);
      if (lead !== null) {
        const band = blocksEl.getBoundingClientRect();
        blocksEl.scrollTop = blocksEl.scrollTop + (lead.top + lead.height / 2 - (band.top + blocksEl.clientHeight / 2));
      }
    }
    const pointFor = (localFrom, localTo, fromLeft) => {
      const rect = rectOf(localFrom, localTo);
      if (rect === null) return null;
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
export function pageTopAlignBlock(blockId) {
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
export function pageReaderRestoredExpr(blockId, expectedBlocks) {
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

export function assertBarPayload(bar, { materialId, versionId, expected, caseId, expectSnap = false, page }) {
  /* PDF 有效载荷额外携带页标识（app.js updateMatSelectionBar 的 pagePart）。 */
  const pagePart = typeof page === "number" ? ` · page ${String(page)}` : "";
  const expectedPayload =
    `material ${materialId} · version ${versionId} · block ${expected.blockId}${pagePart}` +
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
export async function resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText, caseId }) {
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

/** 规范偏移 → 真实 DOM 选区 → 阅读器自身武装 → 捕获载荷 === 冻结真值。
    （PDF：page 传入时载荷断言含页标识——页文本层携带同款区间属性，
    findBlock 已解析到文本层，本函数对 md/pdf 同构。） */
export async function captureFrozenSelection(ctx, { treeId, material, item, truth, page }) {
  const expected = item.expected;
  if (item.fixture !== material.fixtureId) {
    throw new Error(`${item.id}: frozen selection targets fixture ${item.fixture}, but the open material is ${material.fixtureId}`);
  }
  const placed = await ctx.evalJs(pageSelectCanonical(expected.blockId, expected.start, expected.end));
  if (placed === null || placed.error !== undefined) {
    throw new Error(`${item.id}: canonical selection could not be placed — ${JSON.stringify(placed)}`);
  }
  if (placed.selectedText !== expected.excerpt) {
    // Failure-only native browser evidence. No test denominator or expected
    // source is changed, and this never repairs a mismatched selection.
    const diagnostic = await ctx.evalJs(`(() => {
      const s = window.getSelection();
      const range = s && s.rangeCount ? s.getRangeAt(0) : null;
      const layer = [...document.querySelectorAll("#mat-blocks .pdf-page-text, #mat-blocks .material-block")]
        .find((el) => el.dataset?.blockId === ${JSON.stringify(expected.blockId)});
      const style = layer ? getComputedStyle(layer) : null;
      return {
        rangeText: range ? range.toString() : null,
        selectionText: s ? s.toString() : null,
        collapsed: range ? range.collapsed : null,
        anchorNode: range?.startContainer?.parentElement?.className ?? null,
        focusNode: range?.endContainer?.parentElement?.className ?? null,
        layerLength: layer ? layer.textContent.length : null,
        lineCount: layer ? layer.querySelectorAll(".pdf-line").length : null,
        rendered: layer?.dataset?.rendered ?? null,
        userSelect: style?.userSelect ?? null,
        visibility: style?.visibility ?? null
      };
    })()`);
    throw new Error(
      `${item.id}: the DOM selection does not reproduce the frozen excerpt ` +
        `(got ${JSON.stringify(placed.selectedText)}, want ${JSON.stringify(expected.excerpt)}; ` +
        `native diagnostics: ${JSON.stringify(diagnostic)})`,
    );
  }
  const bar = await waitForArmedBar(ctx, item.id);
  assertBarPayload(bar, { materialId: material.materialId, versionId: material.versionId, expected, caseId: item.id, page });
  await resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText: truth.canonicalText, caseId: item.id });
  return { id: item.id, category: item.category, blockId: expected.blockId, start: expected.start, end: expected.end, ...(typeof page === "number" ? { page } : {}) };
}

/** 阅读器进场动画落定（panel-in：translateX(24px)→0，180ms）。手势落点
    以 getClientRects 度量——动画进行中的 transform 会把度量坐标整体平移
    （实测 md-sel-01 首开即量，caret 落后一字）。动画是产品的真实行为；
    探针等它播完再量（有界等待）。 */
export async function waitForReaderEnterSettled(ctx) {
  await waitFor(
    ctx,
    `(() => { const reader = document.getElementById("material-reader"); ` +
      `return reader === null || !reader.classList.contains("enter"); })()`,
    { label: "material reader enter animation settled", timeoutMs: 3000 },
  );
}

/** 真实鼠标两击选区（CDP Input：click 置 caret → Shift+click 扩展到 to
    边界）。选区在两次 mousedown 的命中判定中即告完成——阅读器经其自身
    的 selectionchange/mouseup 路径武装捕获条。 */
export async function mouseSelectFrozenSelection(ctx, { treeId, material, item, truth }) {
  const expected = item.expected;
  await waitForReaderEnterSettled(ctx);
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
export async function mouseDragFrozenSelection(ctx, { treeId, material, item, truth, page }) {
  const expected = item.expected;
  await waitForReaderEnterSettled(ctx);
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
    /* 诚实诊断：落点命中了什么（定位布局位移/滚出视口类缺陷）。 */
    const hit = await ctx
      .evalJs(
        `(() => { const probe = (x, y) => { const el = document.elementFromPoint(x, y); ` +
          `return el === null ? null : { tag: el.tagName, cls: el.className, text: (el.textContent ?? "").slice(0, 40) }; }; ` +
          `return { from: probe(${String(points.from.x)}, ${String(points.from.y)}), to: probe(${String(points.to.x)}, ${String(points.to.y)}) }; })()`,
      )
      .catch(() => null);
    throw new Error(
      `${item.id} (real drag): the native selection during the drag does not reproduce the frozen excerpt ` +
        `(got ${JSON.stringify(duringDrag)}, want ${JSON.stringify(expected.excerpt)}); ` +
        `points=${JSON.stringify(points)}; hit=${JSON.stringify(hit)}`,
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
  assertBarPayload(bar, { materialId: material.materialId, versionId: material.versionId, expected, caseId: `${item.id} (real continuous mouse drag)`, page });
  await resolveSelectionAndAssert(ctx, { treeId, material, expected, canonicalText: truth.canonicalText, caseId: item.id });
  return { id: item.id, category: `${item.category}+real-mouse-drag`, blockId: expected.blockId, start: expected.start, end: expected.end, ...(typeof page === "number" ? { page } : {}) };
}
