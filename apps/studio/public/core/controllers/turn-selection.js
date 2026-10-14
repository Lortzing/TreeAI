/** Turn selection arming, drag-safe rerender deferral and terminology focus restoration. Instance-owned state and dependencies. */
import { createSelectionOffsetsWithin } from "../../shared/source/selection.js";
import { isElementNode } from "../dom.js";

export function createTurnSelectionController(deps) {

  /**
   * ③ 正文/操作分层注册表：assistant turn 的 {element, turn, branchId}——
   * selectionchange（触屏）的选区定位与武装态的就地动作层刷新都按最新 DOM
   * 取元素（turn 元素经按元素复用跨重渲保持身份，注册表随 renderAll 重建）。
   */
  const assistantTurns = new Map();


  const selectionOffsetsWithin = createSelectionOffsetsWithin(deps.window);


  /**
   * 武装/解除选区（mouseup、双击与触屏 selectionchange 共用）：读到本 turn
   * 正文内的选区即武装（模式按选区文本判定：含空白 = range，否则 term）；
   * 无选区（或选区在别处）即解除。换武装目标时旧 turn 的动作层按最新状态
   * 重建（工具条随武装走）。selectionOffsetsWithin 的 contains 守卫保证跨
   * turn 选区不误武装。
   */
  function armTurnSelection(element, turn, branchId) {
    const selection = selectionOffsetsWithin(element, turn.text);
    const armed =
      selection === null
        ? null
        : {
            branchId,
            turnId: turn.id,
            start: selection.start,
            end: selection.end,
            text: selection.text,
            mode: selection.text.trim().includes(" ") ? "range" : "term",
          };
    const previous = deps.state.armedSelection;
    if (
      armed !== null &&
      previous !== null &&
      previous.branchId === armed.branchId &&
      previous.turnId === armed.turnId &&
      previous.start === armed.start &&
      previous.end === armed.end
    ) {
      deps.state.armedSelection = previous; /* 同一选区重复武装：保持对象身份 */
    } else {
      deps.state.armedSelection = armed;
    }
    const armedHere =
      deps.state.armedSelection !== null &&
      deps.state.armedSelection.branchId === branchId &&
      deps.state.armedSelection.turnId === turn.id;
    element.classList.toggle("has-selection", armedHere);
    deps.syncTurnActionsArmedState(element, turn, branchId);
    if (
      previous !== null &&
      (armed === null || previous.turnId !== armed.turnId || previous.branchId !== armed.branchId)
    ) {
      const entry = assistantTurns.get(previous.turnId);
      if (entry !== undefined) deps.renderTurnActions(entry.element, entry.turn, entry.branchId);
    }
  }


  /** turn 元素创建时挂接选区事件（复用元素的身份跨重渲保持，监听只挂一次）。 */
  function attachTurnSelectionListeners(element, turn, branchId) {
    /* ③ 选择期间不重绘：正文层上的按下开启拖拽窗口——窗口内整树重渲延后
       （renderAll 见 selectionDragActive），mouseup 收尾冲刷。按钮/工具条上
       的按下不是选区拖拽（event.target 非空且在 .turn-actions 内时跳过；
       脚本桩事件无 target，按正文按下处理）。 */
    element.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (
        target !== undefined &&
        target !== null &&
        typeof target.closest === "function" &&
        target.closest(".turn-actions") !== null
      ) {
        return;
      }
      deps.state.selectionDragActive = true;
    });
    const armFromEvent = () => {
      if (deps.state.selectionDragActive) {
        deps.state.selectionDragActive = false;
        /* 冲刷延后一拍：mouseup 与 click 之间不重建按钮（click 仍落在原按钮
           上），0ms 后再补被延后的重渲。 */
        deps.window.setTimeout(flushPendingRerender, 0);
      }
      armTurnSelection(element, turn, branchId);
    };
    element.addEventListener("mouseup", armFromEvent);
    /* 点词（issue #7 ②③）：双击选词与任意划线同一路径武装。 */
    element.addEventListener("dblclick", armFromEvent);
  }


  /** 触屏/全局选区定位：当前选区落在哪个已渲染 assistant turn 的正文内。 */
  function findLiveSelectionTurn() {
    for (const entry of assistantTurns.values()) {
      const selection = selectionOffsetsWithin(entry.element, entry.turn.text);
      if (selection !== null) {
        return { ...entry, selection };
      }
    }
    return null;
  }


  /** 焦点是否在选区交互面（工具条/解释卡/D4-2 材料捕获条）内——选区解除
      延迟判定用。 */
  function withinTerminologySurface(element) {
    let current = element;
    while (current !== null && isElementNode(current)) {
      if (
        current.classList.contains("selection-toolbar") ||
        current.classList.contains("term-explain-card") ||
        current.classList.contains("mat-selection-bar")
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }


  /** 解除武装（触屏空选区的延迟解除路径）：就地刷新动作层。 */
  function disarmArmedSelection() {
    const armed = deps.state.armedSelection;
    if (armed === null) return;
    deps.state.armedSelection = null;
    const entry = assistantTurns.get(armed.turnId);
    if (entry !== undefined) {
      entry.element.classList.remove("has-selection");
      deps.syncTurnActionsArmedState(entry.element, entry.turn, entry.branchId);
    }
  }


  /** 冲刷拖拽窗口内被延后的整树重渲与阅读器 chrome 重渲（③ 选择期间不重
      绘的收尾；阅读器块追加是纯增量的，不经此路径）。 */
  function flushPendingRerender() {
    if (!deps.state.pendingRerender && !deps.materialReaderView.materialPendingUpdate && !deps.materialSelectionController.materialBarPendingUpdate) return;
    const rerenderAll = deps.state.pendingRerender;
    const rerenderMaterial = deps.materialReaderView.materialPendingUpdate;
    const rerenderBar = deps.materialSelectionController.materialBarPendingUpdate;
    deps.state.pendingRerender = false;
    deps.materialReaderView.materialPendingUpdate = false;
    deps.materialSelectionController.materialBarPendingUpdate = false;
    if (rerenderAll) deps.renderAll();
    if (rerenderMaterial && deps.state.materialReader !== null) deps.renderMaterialReader();
    else if (rerenderBar && deps.state.materialReader !== null) deps.updateMatSelectionBar();
  }


  /** 解释卡聚焦目标的读取（③ 草稿/焦点纪律）：必须在调和移除旧卡**之前**
      读取——真实浏览器里聚焦控件随祖先移除即失焦（activeElement 回落
      body），移除后读取永不命中（DOM 桩无「移除即失焦」语义，原实现只在
      桩内成立；术语真实浏览器探针发现并修复）。 */
  function termCardFocusTargetId() {
    const active = deps.document.activeElement;
    if (active === null || !isElementNode(active)) return null;
    if (active.id !== "term-explain-card" && active.id !== "term-first-question") return null;
    return active.id;
  }


  /** 解释卡重建后的焦点保持（③ 草稿/焦点纪律）：旧卡内聚焦的控件（首问
      输入 / 卡本身）在同 id 新卡上恢复焦点——重渲不丢打字焦点。 */
  function preserveTermCardFocus(targetId) {
    if (targetId === null) return;
    const fresh = deps.document.getElementById(targetId);
    if (fresh !== null && deps.document.activeElement !== fresh) fresh.focus();
  }

  return {
    disarmArmedSelection,
    assistantTurns,
    attachTurnSelectionListeners,
    termCardFocusTargetId,
    preserveTermCardFocus,
    selectionOffsetsWithin,
    flushPendingRerender,
    withinTerminologySurface,
    findLiveSelectionTurn,
    armTurnSelection,
  };
}
