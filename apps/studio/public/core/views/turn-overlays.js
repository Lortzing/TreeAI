/** Saved annotation/source overlays matched to exact turn identity and offsets. Instance-owned state and dependencies. */

export function createTurnOverlays(deps) {


  /**
   * 已保存批注对「当前渲染中的锚点 turn」的联合校验（P0）：界内区间、摘录
   * 切片全等、全文指纹（sourceHash）三者同时成立才允许渲染活覆盖——只验
   * 边界会把批注挂到漂移后的错误文本上（等长替换/同词移位/代理对错位在
   * 边界判定下全部伪装成立）。sourceHash 是批注保存时刻锚点答案全文的
   * SHA-256（服务端 hashSourceText）；当前文本指纹失配 = 原文在保存后发生
   * 过变化（含被批注区间之外的编辑）——同样降级，绝不冒充仍锚定在原文上。
   * 字段缺失按失配处理（fail-closed：数据残缺不放宽校验）。
   */
  function annotationMatchesTurn(annotation, turn) {
    const start = annotation.selection.start;
    const end = annotation.selection.end;
    if (!(start >= 0 && end > start && end <= turn.text.length)) return false;
    if (turn.text.slice(start, end) !== annotation.selection.text) return false;
    return deps.sha256Hex(turn.text) === annotation.sourceHash;
  }


  /**
   * 批注锚点三态（W1 降级 Return 卡 available/changed/missing 的锚定语义同
   * 款词汇）：以当前树状态里的锚点 turn 为事实源反查——查不到 → missing
   * （锚点答案已不在树中）；查到但联合校验失败 → changed（原文漂移）；全
   * 部成立 → valid。降级路径只展示保存快照（批注自带的摘录与解释）+ 状态
   * 说明（抽屉列表/解释卡），绝不渲染当前文本上的活覆盖。
   */
  function terminologyAnchorStatus(annotation) {
    const st = deps.state.treeState;
    if (st === null) return "missing";
    for (const view of st.branches) {
      const found = view.turns.find(
        (t) => t.id === annotation.anchorTurnId && t.branchId === annotation.branchId,
      );
      if (found !== undefined) {
        return annotationMatchesTurn(annotation, found) ? "valid" : "changed";
      }
    }
    return "missing";
  }


  /**
   * 统一区间覆盖（issue #7 C ③）：术语批注与来源揭示高亮共用同一机制，一律
   * 由绝对 UTF-16 偏移（W1 §1.1——重复词/跨行禁用字符串搜索定位）计算。
   * 来源揭示带 M6 一次性脉冲标记；与批注区间重叠时来源优先（揭示是即时
   * 定位动作），批注区间不重叠地并存。读模型未载/拉取失败时如实无批注
   * 覆盖（不伪造）。
   * 批注覆盖渲染前过 annotationMatchesTurn 联合校验（P0，issue #7 增量验收
   * 2026-09-30）：界内区间只证明「区间存在」，不证明「批注还挂在原文上」
   * ——等长替换/同词移位/半代理对在界内照样成立。任一失配不渲染活覆盖，
   * 降级呈现见抽屉批注列表与解释卡的 source changed/missing 说明。
   */
  function turnOverlaysFor(branchId, turn) {
    const overlays = [];
    const highlight = deps.state.sourceHighlight;
    if (
      highlight !== null &&
      highlight.branchId === branchId &&
      highlight.turnId === turn.id &&
      highlight.start >= 0 &&
      highlight.end > highlight.start &&
      highlight.end <= turn.text.length
    ) {
      /* M6：一次性脉冲（1–2 次）后保持静态高亮；重渲不重复脉冲。 */
      const pulseKey = `${deps.state.currentTreeId}:${highlight.turnId}:${highlight.start}-${highlight.end}`;
      const pulse = deps.state.pulsedHighlightKey !== pulseKey;
      if (pulse) deps.state.pulsedHighlightKey = pulseKey;
      overlays.push({ kind: "source", start: highlight.start, end: highlight.end, pulse, annotation: null });
    }
    const terminology = deps.state.terminology;
    if (terminology !== null && terminology.ok) {
      for (const annotation of terminology.annotations) {
        if (annotation.anchorTurnId !== turn.id || annotation.branchId !== branchId) continue;
        if (!annotationMatchesTurn(annotation, turn)) continue;
        const start = annotation.selection.start;
        const end = annotation.selection.end;
        if (overlays.some((overlay) => start < overlay.end && overlay.start < end)) continue;
        overlays.push({ kind: "term", start, end, pulse: false, annotation });
      }
    }
    overlays.sort((a, b) => a.start - b.start);
    return overlays;
  }


  /**
   * 把区间覆盖应用到 turn 的正文层：重建前导正文区（turn 元素本身按元素复
   * 用保持身份），包裹节点只包住既有字符——textContent 与复制行为字节不变，
   * 选择偏移计算（selectionOffsetsWithin 的前缀长度法）不受影响。来源揭示
   * 覆盖在场时锚点 turn 携带 tabindex/-1 与 anchor-focus（W2 §2.6 键盘焦
   * 点行），覆盖消失时如数移除（复用元素不残留陈旧态）。
   */
  function applyTurnOverlays(element, turn, overlays) {
    element.replaceChildren();
    let cursor = 0;
    for (const overlay of overlays) {
      /* 前缀文本节点恒在场（空切片为空文本节点——与揭示渲染的既有 DOM 形状
         一致：前缀/标记/后缀三段恰切，供按位切片断言）。 */
      element.append(deps.document.createTextNode(turn.text.slice(cursor, overlay.start)));
      if (overlay.kind === "source") {
        const mark = deps.document.createElement("mark");
        mark.className = overlay.pulse ? "source-highlight pulse" : "source-highlight";
        mark.textContent = turn.text.slice(overlay.start, overlay.end);
        element.append(mark);
      } else {
        const span = deps.document.createElement("span");
        span.className = "term-annotation-mark";
        span.title = "saved terminology annotation — select it and use the toolbar to reopen";
        span.textContent = turn.text.slice(overlay.start, overlay.end);
        span.addEventListener("click", () => {
          if (overlay.annotation !== null) {
            deps.openSavedAnnotationCard(overlay.annotation, deps.branchIdOfTurn(turn), turn);
          }
        });
        element.append(span);
      }
      cursor = overlay.end;
    }
    element.append(deps.document.createTextNode(turn.text.slice(cursor)));
    if (overlays.some((overlay) => overlay.kind === "source")) {
      element.setAttribute("tabindex", "-1");
      element.classList.add("anchor-focus");
    } else {
      element.removeAttribute("tabindex");
      element.classList.remove("anchor-focus");
    }
  }

  return {
    turnOverlaysFor,
    applyTurnOverlays,
    terminologyAnchorStatus,
  };
}
