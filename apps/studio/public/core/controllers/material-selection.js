/** Canonical Markdown/PDF selection, capture-bar freezing and explicit quote/branch actions. Instance-owned state and dependencies. */
import { createDisclosure, isElementNode } from "../dom.js";
import { clampToGraphemeBoundaries } from "../../shared/source/grapheme.js";

export function createMaterialSelectionController(deps) {

  /* 捕获条专属的延后更新（拖拽窗口冻结置位）：冲刷走就地 updateMatSelectionBar
   * ——不整建 chrome（renderMaterialReader 的 detach 会丢 Chrome 的原生选区
   * 高亮，连续拖选后高亮消失的实测根因；DOM 桩的选区跨 detach 存活，测不出）。 */
  let materialBarPendingUpdate = false;


  /* ------------------------------ D4-2 选区捕获 ------------------------------ */

  /* Grapheme-safe selection snapping lives in shared/source/grapheme.js. */

  /** 选区起/止所在的块元素（沿 parentElement 上溯；不在阅读器正文内 →
      null——两个 null 或单 null 都意味着“这不是阅读器选区”）。 */
  function materialBlockOf(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (isElementNode(current) && current.classList.contains("material-block")) return current;
      current = current.parentElement;
    }
    return null;
  }


  /** 块内前缀长度（selectionOffsetsWithin 的块内版：clone → 全块内容 →
      setEnd 到选区起点 → toString 长度即块内偏移；跨文本节点成立）。 */
  function materialBlockLocalStart(blockEl, range) {
    const before = range.cloneRange();
    before.selectNodeContents(blockEl);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }


  /**
   * 阅读器选区 → 捕获载荷（D4-3 建枝的锚点载荷）。事实源：块元素区间 +
   * 前缀长度换算 + 块文本切片校验（excerpt === 块文本切片——即
   * canonicalText.slice(start,end)，绝对偏移由 block.start 平移）。跨块 →
   * 如实 {invalid, cross-block}（B2 纪律：markdown 选区必须含于单块，不悄悄
   * 截断）；PDF 跨页 → {invalid, cross-page}（charter §3.2：选区必须含于
   * 单页——提示分段选择，绝不静默截断）；切片校验失败（理论不可达的渲染
   * 漂移）→ {invalid, unmappable}。返回 null = 无选区/选区不在阅读器正文
   * 内（不武装）。invalid 载荷同样携带 materialId/versionId（捕获条的归属
   * 判定对两态一致）。PDF 页块的有效载荷额外携带 page（页标识）。
   */
  function materialSelectionFromRange(reader) {
    const selection = deps.window.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const startBlock = materialBlockOf(range.startContainer);
    const endBlock = materialBlockOf(range.endContainer);
    if (startBlock === null && endBlock === null) return null;
    const isPdf = deps.materialReaderIsPdf(reader);
    const invalid = (reason) => ({
      kind: "invalid",
      materialId: reader.materialId,
      versionId: reader.versionId,
      reason,
    });
    if (startBlock === null || endBlock === null) return invalid("unmappable");
    if (startBlock !== endBlock) return invalid(isPdf ? "cross-page" : "cross-block");
    const blockId = startBlock.dataset.blockId;
    const entry = reader.blocks.find((candidate) => candidate.block.blockId === blockId);
    if (blockId === undefined || entry === undefined) return invalid("unmappable");
    const selected = range.toString();
    if (selected.length === 0) return null;
    const localStart = materialBlockLocalStart(startBlock, range);
    const localEnd = localStart + selected.length;
    if (localStart < 0 || localEnd > entry.text.length) return invalid("unmappable");
    if (entry.text.slice(localStart, localEnd) !== selected) {
      return invalid("unmappable");
    }
    const clamped = clampToGraphemeBoundaries(entry.text, localStart, localEnd);
    if (clamped === null) return invalid("unmappable");
    const valid = {
      kind: "valid",
      materialId: reader.materialId,
      versionId: reader.versionId,
      blockId,
      start: entry.block.start + clamped.start,
      end: entry.block.start + clamped.end,
      excerpt: entry.text.slice(clamped.start, clamped.end),
      snapped: clamped.snapped,
    };
    if (typeof entry.block.page === "number") valid.page = entry.block.page;
    return valid;
  }


  /** 武装阅读器选区（mouseup/双击/触屏 selectionchange 共用；解除语义与
      armTurnSelection 同族：无选区/选区移出阅读器正文即解除）。武装阅读器
      选区时同步解除正文层的武装选区——同一时刻只有一个捕获面。 */
  function armMaterialSelection() {
    const reader = deps.state.materialReader;
    if (reader === null) return;
    const payload = materialSelectionFromRange(reader);
    deps.state.materialSelection = payload;
    if (payload !== null && deps.state.armedSelection !== null) deps.disarmArmedSelection();
    updateMatSelectionBar();
  }


  /** 解除阅读器武装（就地刷新捕获条，不触碰块容器）。 */
  function disarmMaterialSelection() {
    if (deps.state.materialSelection === null) return;
    deps.state.materialSelection = null;
    updateMatSelectionBar();
  }


  /** 触屏/全局：当前选区是否落在阅读器正文内（selectionchange 武装判定）。 */
  function findLiveMaterialSelection() {
    const reader = deps.state.materialReader;
    if (reader === null) return false;
    return materialSelectionFromRange(reader) !== null;
  }


  /** 捕获条就地更新（武装/解除/翻提示——不整建 chrome，不触碰块）。 */
  function updateMatSelectionBar() {
    const bar = deps.document.getElementById("mat-selection-bar");
    if (bar === null) return;
    if (deps.state.selectionDragActive) {
      /* 拖拽窗口内捕获条内容冻结：全局 selectionchange 在拖选中持续触发，
         条从 ~54px 长到 ~169px 会把正文整体推下 ~115px（真实 Chrome 实测，
         DOM 桩测不出），连续拖选的释放点随位移带偏。与 renderMaterialReader
         的「选择期间不重绘」同族——mouseup 冲刷就地重放本函数（触屏
         selectionchange 无拖拽窗口，不受影响）。 */
      materialBarPendingUpdate = true;
      return;
    }
    bar.replaceChildren();
    bar.hidden = false;
    const reader = deps.state.materialReader;
    if (reader === null) return;
    const selection = deps.state.materialSelection;
    if (selection === null || selection.materialId !== reader.materialId || selection.versionId !== reader.versionId) {
      bar.hidden = true;
      const hint = deps.document.createElement("span");
      hint.className = "muted";
      hint.textContent =
        "选中文字，复制摘录或展开支线。";
      bar.append(hint);
      return;
    }
    if (selection.kind === "invalid") {
      const note = deps.document.createElement("span");
      note.className = "mat-invalid-note";
      note.textContent =
        selection.reason === "cross-block"
          ? "cross-block selection not anchorable — markdown selections must stay within a single block " +
            "(B2 anchoring discipline); no quote payload is produced, nothing is truncated silently"
          : selection.reason === "cross-page"
            ? "cross-page selection not anchorable — PDF selections must stay within one page " +
              "(select within a page; segmented selection across pages is the discipline — never a silent truncation); " +
              "no quote payload is produced"
            : "the selection could not be mapped to canonical offsets — no quote payload is shown";
      const guidance = deps.document.createElement("span");
      guidance.textContent = selection.reason === "cross-block" ? "请在同一段落内选择文字。" : selection.reason === "cross-page" ? "请在同一页内选择文字。" : "无法定位这段选文，请重新选择。";
      bar.append(guidance, createDisclosure(deps.document, "选区详情", note));
      return;
    }
    const quote = deps.document.createElement("span");
    quote.className = "mat-quote";
    quote.textContent = selection.excerpt;
    const payload = deps.document.createElement("span");
    payload.className = "mat-payload";
    const pagePart =
      typeof selection.page === "number" ? ` · page ${String(selection.page)}` : "";
    payload.textContent =
      `material ${selection.materialId} · version ${selection.versionId} · block ${selection.blockId}${pagePart}` +
      ` · UTF-16 [${String(selection.start)}, ${String(selection.end)}) · ${String(selection.excerpt.length)} units`;
    bar.append(quote);
    const location = createDisclosure(deps.document, "引用位置", payload);
    if (selection.snapped) {
      const snap = deps.document.createElement("span");
      snap.className = "mat-snap-note";
      snap.textContent =
        "(a selection boundary fell inside a grapheme cluster — it was snapped outward so the quote never " +
          "splits a surrogate pair, combining sequence, or emoji)";
      location.append(snap);
    }
    const actions = deps.document.createElement("span");
    actions.className = "mat-selection-actions";
    const copy = deps.document.createElement("button");
    copy.className = "mat-copy";
    copy.textContent = "复制摘录";
    copy.title = "复制选中的原文";
    copy.addEventListener("click", () => void copyMaterialQuote(copy, selection));
    const branch = deps.document.createElement("button");
    branch.className = "mat-branch-d43";
    branch.textContent = "选文提问";
    branch.title =
      "围绕这段文字提问，发送前可以确认引用范围";
    branch.addEventListener("click", () => {
      void deps.guard(() => deps.startMaterialBranchFlow(selection), "main");
    });
    actions.append(copy, branch);
    bar.append(actions, location);
    const range = deps.window.getSelection()?.rangeCount ? deps.window.getSelection().getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect?.();
    const root = deps.document.getElementById("material-reader");
    if (rect && root?.getBoundingClientRect) {
      const bounds = root.getBoundingClientRect();
      bar.style.top = `${Math.max(56, Math.min(rect.bottom - bounds.top + 10, bounds.height - 170))}px`;
    }
    if (bar.dataset.preservesSelection !== "true") {
      bar.addEventListener("mousedown", event => event.preventDefault());
      bar.dataset.preservesSelection = "true";
    }
  }


  /** 复制摘录：按 canonicalText 切片复制（excerpt 已过切片校验；正文渲染
      无覆盖改写，textContent 即原文）。Clipboard API 缺席/失败时诚实降级：
      摘录留在捕获条内可选（手动复制），绝不谎报已复制。 */
  async function copyMaterialQuote(button, selection) {
    const clipboard =
      typeof deps.navigator !== "undefined" &&
      deps.navigator !== null &&
      typeof deps.navigator.clipboard === "object" &&
      deps.navigator.clipboard !== null &&
      typeof deps.navigator.clipboard.writeText === "function"
        ? deps.navigator.clipboard
        : null;
    if (clipboard === null) {
      button.textContent = "无法自动复制";
      button.title = "Clipboard API unavailable — select the quote above and copy it manually";
      return;
    }
    try {
      await clipboard.writeText(selection.excerpt);
      button.textContent = "已复制 ✓";
      deps.window.setTimeout(() => {
        button.textContent = "复制摘录";
      }, 1500);
    } catch (err) {
      deps.showError(
        `copying the quote failed — ${String(err && err.message ? err.message : err)}; ` +
          "the quote above stays selectable for a manual copy",
      );
    }
  }

  return {
    get materialBarPendingUpdate() { return materialBarPendingUpdate; },
    set materialBarPendingUpdate(value) { materialBarPendingUpdate = value; },
    updateMatSelectionBar,
    armMaterialSelection,
    findLiveMaterialSelection,
    disarmMaterialSelection,
  };
}
