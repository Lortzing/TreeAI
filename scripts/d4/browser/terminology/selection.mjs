/** selection ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  sleep,
  waitFor,
} from "../material-probes.mjs";
import {
  TERM_CANDIDATES,
} from "./policy.mjs";

/* ------------------------------------------------------------------ */
/* 选区挑选（确定性；echo 与真实模型回答共用）                            */
/* ------------------------------------------------------------------ */

/** term 选区：候选词（大小写不敏感）优先，退而取最长 ASCII 词。 */
export function pickTerm(text) {
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
export function pickRange(text, termPick) {
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
  /* 2) term 之前的窗口（止于 term 起点——不重叠）。 */
  let window = trimWindow(Math.max(0, termPick.start - 34), termPick.start);
  if (window !== null) return { ...window, source: "before-term" };
  /* 3) term 之后的任意含空白窗口（起于 term 终点——不重叠；真实模型以中文
     为主的回答可能没有第二个 ≥3 字符的英文词，锚定词路径缺席时的兜底。
     此前兜底取全文首个空白窗口，可能与 term 区间重叠——正文区间覆盖按
     产品语义跳过重叠批注（不双重下划线），探针的「双覆盖并存」断言即
     违反自身不重叠前提（真实 Pi 第三跑实测复现）。 */
  const firstSpaceAfter = text.indexOf(" ", termPick.end);
  if (firstSpaceAfter >= 0) {
    const nextSpaceAfter = text.indexOf(" ", firstSpaceAfter + 1);
    if (nextSpaceAfter >= 0) {
      window = trimWindow(Math.max(termPick.end, firstSpaceAfter - 2), Math.min(text.length, nextSpaceAfter + 6));
      if (window !== null) return { ...window, source: "after-term-space-window" };
    }
  }
  return null;
}

/** 选区文本中的 ASCII 词（解释卡「含原文词」断言用）。 */
export function asciiWordsOf(text) {
  return [...text.matchAll(/[A-Za-z][A-Za-z0-9'-]{2,}/g)].map((match) => match[0]);
}

/* ------------------------------------------------------------------ */
/* 页面内 turn 选区（正文层文本节点树 + 平台 Selection）                  */
/* ------------------------------------------------------------------ */

export const TURN_BODY_WALKER = `
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

export function trunkTurnSelector(turnId) {
  return `#conversation .turn.assistant[data-turn-id=${JSON.stringify(turnId)}]`;
}

/** DOM 选区放置（平台 Selection API → 应用自身 selectionchange/mouseup 武装
 *  路径——触屏同款；b3 armSelectionInReader 同款纪律）。 */
export function turnSelectExpr(turnId, start, end) {
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
export function turnDragPointsExpr(turnId, start, end) {
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
export async function dragSelectOnTurn(ctx, turnId, selection, caseId) {
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
export async function waitForArmedToolbar(ctx, caseId, { expectMode, timeoutMs = 6000 }) {
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
