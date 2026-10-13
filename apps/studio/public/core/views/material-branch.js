/** Declared material context, existing-intent choices, dispatch/retry notes and material Return cards. Instance-owned state and dependencies. */

export function createMaterialBranchView(deps) {


  /**
   * 建枝面（阅读器内、捕获条之下）：creating / declared（材料范围声明 + 首
   * 问输入）/ choice（恢复 vs 另开二选）/ failed（诚实错误 + 重试）四态。
   * 输入值经 state.materialBranching.firstQuestion 跨重渲保持（同术语首问
   * 输入的惯例）。
   */
  function renderMaterialBranchFlow() {
    const flow = deps.state.materialBranching;
    const reader = deps.state.materialReader;
    if (flow === null || reader === null) return null;
    if (flow.selection.materialId !== reader.materialId) return null; /* 流程属于另一份材料：不在此渲染 */
    const div = deps.document.createElement("div");
    div.id = "mat-branch-flow";
    div.className = "mat-branch-flow";
    div.setAttribute("tabindex", "-1");
    div.setAttribute("role", "region");
    div.setAttribute("aria-label", "Branch from material flow");

    if (flow.phase === "creating") {
      const head = deps.document.createElement("p");
      head.className = "mat-branch-head";
      head.textContent = "⑃ Branch from material — resolving the selection…";
      div.append(head);
      div.append(
        deps.mutedLine(
          "creating the branch records zero runs/turns (browsing and searching create none) — the first question is a separate explicit submit",
        ),
      );
      div.append(materialBranchCancelButton());
      return div;
    }

    if (flow.phase === "failed") {
      const head = deps.document.createElement("p");
      head.className = "mat-branch-head danger";
      head.textContent = "⑃ Branch from material — the flow failed";
      div.append(head);
      div.append(deps.mutedLine(`error — ${String(flow.error)}`));
      const actions = deps.document.createElement("div");
      actions.className = "mat-branch-actions";
      const retry = deps.document.createElement("button");
      retry.className = "mat-branch-retry";
      retry.textContent = "Retry";
      retry.title = "Resolve the selection and open the branching flow again";
      retry.addEventListener("click", () => void deps.guard(() => deps.startMaterialBranchFlow(flow.selection), "main"));
      actions.append(retry, materialBranchCancelButton());
      div.append(actions);
      return div;
    }

    if (flow.phase === "choice") {
      const restore = flow.restore;
      div.append(materialBranchChoiceCard(flow));
      const actions = deps.document.createElement("div");
      actions.className = "mat-branch-actions";
      const resume = deps.document.createElement("button");
      resume.className = "mat-branch-resume";
      resume.textContent = "↩ Open the existing exploration";
      resume.title = "Resume the exploration anchored on this exact selection (its session continues where it left off)";
      resume.addEventListener("click", () => void deps.guard(() => deps.materialBranchResumeExisting(), "main"));
      const fresh = deps.document.createElement("button");
      fresh.className = "mat-branch-new";
      fresh.textContent = "⑃ Start a new exploration from this selection";
      fresh.title = "Explicitly open a second exploration from the same source — a new branch and a new session (a new submission)";
      fresh.addEventListener("click", () => void deps.guard(() => deps.materialBranchStartNew(), "main"));
      actions.append(resume, fresh, materialBranchCancelButton());
      div.append(actions);
      if (restore !== null && restore.navigation !== null && restore.navigation.status === "failed") {
        div.append(
          deps.mutedLine(
            `aligning the live session failed (${String(restore.navigation.code)}: ${String(restore.navigation.message)}) — ` +
              "the branch stays fully readable; opening it shows the saved history, prompts navigate on their own",
          ),
        );
      }
      if (restore !== null && restore.sessionAvailability === "unavailable") {
        div.append(
          deps.mutedLine(
            "the session at this branch's continuation point is unavailable — opening it shows the recovery entries " +
              "(including starting a new exploration from saved content)",
          ),
        );
      }
      if (restore !== null && !restore.hasTurns) {
        div.append(
          deps.mutedLine(
            "the existing branch has no first question yet — continuing it there sends a normal prompt without the composed " +
              "material context; starting a new exploration below gives the full first-question flow",
          ),
        );
      }
      return div;
    }

    /* declared：材料范围声明（提交前）+ 首问输入。 */
    div.append(materialBranchContextCard(flow));
    const form = deps.document.createElement("div");
    form.className = "mat-branch-question";
    const label = deps.document.createElement("span");
    label.className = "muted";
    label.textContent = "first question for the new exploration:";
    const input = deps.document.createElement("input");
    input.id = "mat-branch-first-question";
    input.type = "text";
    input.value = flow.firstQuestion;
    input.placeholder = "Ask the first question — it enters the new session together with the declared material scope…";
    input.disabled = flow.submitting;
    input.addEventListener("input", () => {
      const current = deps.state.materialBranching;
      if (current !== null) {
        current.firstQuestion = input.value;
        /* 草稿随挂起意图持久化（同 Return 草稿纪律——刷新/重启后续走不丢输入）。 */
        if (deps.state.currentTreeId !== null) {
          deps.persistPendingMaterialIntent(
            deps.state.currentTreeId,
            deps.materialSelectionIdentity(current.selection),
            current.intentKey,
            input.value,
          );
        }
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void deps.guard(deps.submitMaterialFirstQuestion, "main");
      }
    });
    const submit = deps.document.createElement("button");
    submit.className = "primary mat-branch-submit";
    submit.textContent = flow.submitting ? "Dispatching…" : "Submit first question";
    submit.disabled = flow.submitting;
    submit.title =
      "Dispatch the first question with the declared material scope into a new, independent session (idempotent by intent key)";
    submit.addEventListener("click", () => void deps.guard(deps.submitMaterialFirstQuestion, "main"));
    form.append(label, input, submit);
    div.append(form);
    if (flow.mode === "restored") {
      div.append(
        deps.mutedLine(
          "this branch was created earlier from the same selection and has no first question yet — submitting resumes it with the pending intent key",
        ),
      );
    } else if (flow.created === false) {
      div.append(
        deps.mutedLine("this intent key already has its branch — the existing one is reopened (no duplicate is created)"),
      );
    }
    if (flow.submitting) {
      div.append(deps.mutedLine("dispatching the first question… (it is not re-sent while a dispatch is pending)"));
    }
    if (flow.dispatchNote !== null) {
      const note = deps.document.createElement("p");
      note.className = `mat-branch-dispatch${flow.dispatchNote.startsWith("dispatch failed") || flow.dispatchNote.startsWith("the first question for this branch") ? " danger" : ""}`;
      note.textContent = flow.dispatchNote;
      div.append(note);
      if (flow.dispatchNote.startsWith("dispatch failed")) {
        div.append(
          deps.mutedLine(
            "a retry with the same key is an explicit new attempt (the backend reconciles first — a landed question is never re-sent)",
          ),
        );
      }
    }
    if (flow.conflict !== null) {
      const conflict = deps.document.createElement("p");
      conflict.className = "mat-branch-conflict";
      conflict.textContent = `first-question conflict — ${flow.conflict}`;
      div.append(conflict);
      div.append(
        deps.mutedLine("the first question is immutable for this branch — a changed question is a normal continuation, not a first-question retry"),
      );
      const actions = deps.document.createElement("div");
      actions.className = "mat-branch-actions";
      const cont = deps.document.createElement("button");
      cont.className = "accent mat-branch-continue";
      cont.textContent = "Continue on the branch with this question";
      cont.title = "Open the branch panel with the changed question in its composer — sending it there is a normal continuation";
      cont.addEventListener("click", () => void deps.guard(() => deps.materialBranchContinueWithQuestion(), "main"));
      actions.append(cont, materialBranchCancelButton());
      div.append(actions);
      return div;
    }
    div.append(materialBranchCancelButton());
    return div;
  }


  /** 取消按钮（各阶段共用：收起流程面，回到纯阅读）。 */
  function materialBranchCancelButton() {
    const cancel = deps.document.createElement("button");
    cancel.className = "mat-branch-cancel";
    cancel.textContent = "Cancel";
    cancel.title = "Close this flow and keep reading — nothing is dispatched without your explicit first question";
    cancel.addEventListener("click", deps.closeMaterialBranchFlow);
    return cancel;
  }


  /**
   * 材料范围声明卡（charter §3.3 规则三「UI 在提交前说明本次使用的材料范
   * 围」）：from-material 响应的组合上下文视图——与首问派发时逐字节相同
   * （全部成分由不可变数据决定）。截断（24,000 单元上限）显式标注；组合
   * 文本全文经 <details> 可核对。
   */
  function materialBranchContextCard(flow) {
    const context = flow.context;
    const card = deps.document.createElement("div");
    card.className = "mat-branch-context";
    const head = deps.document.createElement("p");
    head.className = "mat-branch-context-head";
    head.textContent = "Material scope for this exploration — declared before your first question";
    card.append(head);
    if (context === null) {
      card.append(deps.mutedLine("the scope view is unavailable — do not submit until it is shown"));
      return card;
    }
    const lines = [];
    lines.push(
      `material “${context.materialTitle}” · version ${context.versionId} (${context.parserKind} ${context.parserVersion})`,
    );
    lines.push(
      `selected excerpt: block ${context.selection.blockId}, UTF-16 [${String(context.selection.start)}, ${String(context.selection.end)}) — quoted in full below`,
    );
    lines.push(
      `surrounding-material window: UTF-16 [${String(context.window.start)}, ${String(context.window.end)}) of the version canonical text` +
        ` (blocks fully covered: ${
          context.contextBlocks.length > 0 ? context.contextBlocks.map((block) => block.blockId).join(", ") : "none"
        })`,
    );
    lines.push(`composed context: ${String(context.composedUnits)} / ${String(context.limitUnits)} UTF-16 units`);
    for (const text of lines) {
      const line = deps.document.createElement("p");
      line.className = "mat-branch-scope-line";
      line.textContent = text;
      card.append(line);
    }
    const quote = deps.document.createElement("blockquote");
    quote.className = "mat-branch-excerpt";
    quote.textContent = context.selection.excerpt;
    card.append(quote);
    if (context.truncated) {
      const marker = deps.document.createElement("p");
      marker.className = "mat-branch-truncated";
      marker.textContent = `TRUNCATED — ${String(context.truncationNote)}`;
      card.append(marker);
    } else {
      card.append(deps.mutedLine("the window covers the whole material — nothing is omitted"));
    }
    const details = deps.document.createElement("details");
    details.className = "mat-branch-composed collapsible";
    const summary = deps.document.createElement("summary");
    summary.textContent = "the exact composed context that will enter the model input";
    const pre = deps.document.createElement("pre");
    pre.textContent = context.composed;
    details.append(summary, pre);
    card.append(details);
    card.append(
      deps.mutedLine(
        "creating the branch recorded zero runs/turns; submitting the first question dispatches it with exactly this scope into a new, independent session (the same bytes — the scope is deterministic)",
      ),
    );
    return card;
  }


  /** 恢复 vs 另开二选卡（charter §3.3 规则五/六：同来源可恢复，也可显式另开）。 */
  function materialBranchChoiceCard(flow) {
    const card = deps.document.createElement("div");
    card.className = "mat-branch-context";
    const head = deps.document.createElement("p");
    head.className = "mat-branch-context-head";
    head.textContent = "This exact material source already has an exploration in this tree";
    card.append(head);
    const line = deps.document.createElement("p");
    line.className = "mat-branch-scope-line";
    line.textContent =
      `source: material “${String(flow.context?.materialTitle ?? "")}” · version ${String(flow.selection.versionId)} · ` +
      `block ${flow.selection.blockId} · UTF-16 [${String(flow.selection.start)}, ${String(flow.selection.end)}) — ` +
      `selection identity is exact (material × version × block × range); look-alike excerpts elsewhere are never reused`;
    card.append(line);
    card.append(
      deps.mutedLine(
        "you can resume the existing exploration, or explicitly start a new one from this same selection — both are honest continuations, nothing is silently reused",
      ),
    );
    return card;
  }


  /**
   * 材料 Return 卡（主线；charter §3.3 规则七 / ADR-004 §8）：材料来源没有
   * 主线对话锚点（targetAnchor 恒 null——绝不伪造），主线按确认时间放置。
   * 来源卡字段（材料标题/版本/解析器/块·页/摘录/sourceJump）从提交响应的
   * card 缓存读取；确认时间/文本/采用记录取树态实时事实（与 returnCard 同
   * 词汇：saved → attempted → delivered）。缓存缺失时如实注明（Return 完好，
   * 绝不伪造来源细节）。
   */
  function materialReturnCard(turn, attempts) {
    const treeKey = `${deps.state.currentTreeId}:${turn.id}`;
    const nowMs = Date.now();
    const div = deps.document.createElement("div");
    div.className = "turn return material-return";
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;
    deps.turnElements.set(turn.id, div); /* 提交后滚动定位 / 反查焦点还原 */
    if (!deps.state.knownReturnIds.has(treeKey)) {
      deps.state.knownReturnIds.add(treeKey);
      deps.returnInsertedAt.set(treeKey, nowMs);
    }
    const insertedAt = deps.returnInsertedAt.get(treeKey);
    if (insertedAt !== undefined && nowMs - insertedAt < deps.MOTION_EPOCH_MS) {
      div.classList.add("insert");
    }
    const meta = deps.document.createElement("span");
    meta.className = "meta";
    meta.append(
      deps.document.createTextNode(
        `↩ Return from ${deps.branchLabel(turn.fromBranchId ?? "")} (material exploration) · saved ${deps.formatProductTime(turn.createdAt)}`,
      ),
    );
    const delivered = turn.deliveredRunId !== null;
    const delivery = deps.document.createElement(delivered ? "button" : "span");
    if (delivered) {
      const deliveredAttempt = attempts.find((attempt) => attempt.runId === turn.deliveredRunId);
      const adoptedNote =
        deliveredAttempt !== undefined && deliveredAttempt.terminalAt !== null
          ? `, adopted ${deps.formatProductTime(deliveredAttempt.terminalAt)}`
          : "";
      delivery.className = "delivery delivered delivery-link";
      delivery.textContent = `successfully adopted into Trunk context (run ${turn.deliveredRunId.slice(0, 12)}…${adoptedNote})`;
      delivery.title = `first successfully adopted into Trunk run ${turn.deliveredRunId} — open sources`;
      div.dataset.deliveredRunId = turn.deliveredRunId;
      delivery.addEventListener("click", () =>
        void deps.openDrawer({
          focusRunId: turn.deliveredRunId,
          trigger: { kind: "return-card", turnId: turn.id },
        }),
      );
    } else if (attempts.length > 0) {
      delivery.className = "delivery attempted";
      delivery.textContent = `adoption attempted (${String(attempts.length)}) — still pending, retried on the next Trunk discussion`;
      delivery.title = attempts
        .map((a) => `run ${a.runId.slice(0, 12)}… ${a.runState}${a.failure !== null ? ` (${a.failure.code})` : ""}`)
        .join("\n");
    } else {
      delivery.className = "delivery";
      delivery.textContent = "saved — pending adoption on the next Trunk discussion";
    }
    deps.state.seenDeliveredRunIds.set(treeKey, turn.deliveredRunId);
    meta.append(delivery);
    div.append(meta);
    const card = deps.recallMaterialReturnCard(deps.state.currentTreeId, turn.id);
    if (card !== null) {
      const source = deps.document.createElement("div");
      source.className = "mat-return-source";
      const fields = deps.document.createElement("p");
      fields.className = "mat-return-source-fields";
      const pageNote = card.page !== null ? ` · page ${String(card.page)}` : "";
      fields.textContent =
        `material “${String(card.materialTitle)}” · version ${String(card.versionId)}` +
        ` (${String(card.parserKind)} ${String(card.parserVersion)}) · block ${String(card.blockId)}${pageNote}` +
        ` · confirmed ${deps.formatProductTime(card.confirmTime)}`;
      source.append(fields);
      const quote = deps.document.createElement("blockquote");
      quote.className = "mat-return-excerpt";
      quote.textContent = String(card.excerpt);
      source.append(quote);
      const jump = deps.document.createElement("button");
      jump.className = "mat-return-jump";
      jump.textContent = "⌖ View material source";
      jump.title = "Open the material at the anchored version and block — the source jump never fakes a mainline position";
      jump.addEventListener("click", () =>
        void deps.guard(
          () =>
            deps.openMaterial(card.sourceJump.materialId, {
              trigger: { kind: "return-card", turnId: turn.id },
              versionId: card.sourceJump.versionId,
              focusBlockId: card.sourceJump.blockId,
              arrival: "return-source",
            }),
          "main",
        ),
      );
      source.append(jump);
      div.append(source);
    } else {
      div.append(
        deps.mutedLine(
          "the material source details for this Return are not cached in this browser — the Return itself is intact and pending adoption",
        ),
      );
    }
    div.append(deps.document.createTextNode(turn.text));
    return div;
  }

  return {
    materialReturnCard,
    renderMaterialBranchFlow,
  };
}
