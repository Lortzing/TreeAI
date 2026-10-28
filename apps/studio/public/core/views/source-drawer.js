/** Saved source lineage, diagnostics/journal and terminology preference/read-model presentation. Instance-owned state and dependencies. */

export function createSourceDrawerView(deps) {


  const drawerRunItems = new Map();


  /**
   * 来源抽屉：per-run 出处（分支/定位/状态/失败码/时间戳；条目带
   * data-run-id 供 delivered 卡反查定位）、Return 出处（from-branch/锚点
   * 摘录/送达 run）、journal 尾部（保守摘要）与工具活动（离线如实空态——
   * Studio 以空工具 allowlist 运行，无工具事件）。
   */
  function renderDrawer() {
    const drawer = deps.$("source-drawer");
    const toggle = deps.$("source-drawer-toggle");
    // Preserve the shared SVG icon across drawer refreshes.
    const label = deps.state.drawerOpen ? "关闭来源记录" : "来源记录";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.setAttribute("aria-expanded", deps.state.drawerOpen ? "true" : "false");
    if (!deps.state.drawerOpen) return;

    drawer.replaceChildren();
    drawerRunItems.clear();
    /* 抽屉头部（附-4，option B 方向）：抽屉为覆盖层，打开时同时盖住主线
       composer 的 Send 与 Sources 开关自身——鼠标用户此前唯一关闭路径是
       Esc。头部加可见关闭按钮，点击复用 closeDrawer()（开关 aria 对齐 +
       焦点还原与 Esc 同一语义，不另开关闭路径）。 */
    const head = deps.document.createElement("div");
    head.className = "drawer-head";
    const title = deps.document.createElement("h2");
    title.textContent = "Sources";
    const close = deps.document.createElement("button");
    close.id = "drawer-close";
    close.textContent = "× Close";
    close.addEventListener("click", () => deps.closeDrawer());
    head.append(title, close);
    drawer.append(head);

    /* per-run 出处（诊断面安全投影）。 */
    const runsTitle = deps.document.createElement("h3");
    runsTitle.textContent = "Runs";
    drawer.append(runsTitle);
    const diag = deps.state.diagnostics;
    if (diag === null || diag.runs.length === 0) {
      drawer.append(deps.mutedLine("no runs recorded for this tree yet"));
    } else {
      const list = deps.document.createElement("ul");
      list.className = "drawer-list";
      for (const run of diag.runs) {
        const li = deps.document.createElement("li");
        li.dataset.runId = run.runId;
        const failureNote = run.failure === null ? "" : ` · failure ${run.failure.code}`;
        const time =
          run.terminalAt === null
            ? `started ${new Date(run.createdAt).toLocaleTimeString()}`
            : `${new Date(run.createdAt).toLocaleTimeString()} → ${new Date(run.terminalAt).toLocaleTimeString()}`;
        li.textContent =
          `${deps.branchLabel(run.branchId)} · run ${run.runId.slice(0, 12)}… · ${run.state}${failureNote} · ${time}`;
        drawerRunItems.set(run.runId, li);
        list.append(li);
      }
      drawer.append(list);
    }

    /* Return 出处（signed v3 §3.2：区分已保存 / 采用尝试过 / 首次成功采用；
       尝试明细含 run 与结局——runId/状态/失败码是安全投影字段，无路径与
       session 引用）。 */
    const returnsTitle = deps.document.createElement("h3");
    returnsTitle.textContent = "Returns";
    drawer.append(returnsTitle);
    const st = deps.state.treeState;
    const returns =
      st === null
        ? []
        : st.branches.flatMap((view) =>
            view.turns.filter((t) => t.role === "return").map((t) => ({ view, turn: t })),
          );
    if (returns.length === 0) {
      drawer.append(deps.mutedLine("no returns submitted for this tree yet"));
    } else {
      const list = deps.document.createElement("ul");
      list.className = "drawer-list";
      for (const { view, turn } of returns) {
        const li = deps.document.createElement("li");
        const anchor = turn.targetAnchor;
        const anchorNote =
          anchor === null
            ? "original anchor unavailable"
            : `anchored on “${anchor.selection.text}” from ${deps.branchLabel(anchor.sourceBranchId)}`;
        const attempts = deps.returnAttemptsFor(view, turn.id);
        if (turn.deliveredRunId !== null) {
          li.textContent =
            `from ${deps.branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ` +
            `successfully adopted into run ${turn.deliveredRunId.slice(0, 12)}… (first success)`;
        } else if (attempts.length > 0) {
          li.textContent =
            `from ${deps.branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ` +
            `adoption attempted, still pending (${String(attempts.length)})`;
        } else {
          li.textContent = `from ${deps.branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · saved, pending adoption`;
        }
        list.append(li);
        for (const attempt of attempts) {
          const item = deps.document.createElement("li");
          item.className = "attempt";
          const failureNote = attempt.failure === null ? "" : ` · failure ${attempt.failure.code}`;
          item.textContent =
            `attempt: run ${attempt.runId.slice(0, 12)}… · ${attempt.runState}${failureNote}`;
          list.append(item);
        }
      }
      drawer.append(list);
    }

    /* 术语批注与执行器面（issue #7 C ③ 完整）：已保存批注的出处（术语/摘
       录/来源分支/推广去向）+ 近期任务（三模式 term/range/auto 的任务态如
       实呈现——瞬态任务面，不是产品事实）+ 执行器用量（requests 为精确计
       数，est tokens 为 chars/4 诚实估算；服务端迟到丢弃与客户端迟到丢弃
       分开计数）+ 缓存偏好（PUT preferences，可切换；在途/失败态如实）。
       三态呈现与 journal 同纪律：加载中 / 已载（可为空）/ 失败 + 重试。 */
    const termsTitle = deps.document.createElement("h3");
    termsTitle.textContent = "Terminology";
    drawer.append(termsTitle);
    const terminology = deps.state.terminology;
    if (terminology === null) {
      drawer.append(deps.mutedLine("loading terminology…"));
    } else if (!terminology.ok) {
      const line = deps.document.createElement("p");
      line.className = "muted";
      line.append(deps.document.createTextNode("terminology failed to load — "));
      const retryTerms = deps.document.createElement("button");
      retryTerms.className = "drawer-retry";
      retryTerms.textContent = "Retry";
      retryTerms.title = "Fetch the terminology read model again";
      retryTerms.addEventListener("click", () =>
        void deps.refreshTerminology().then(() => {
          renderDrawer();
          deps.renderAll(); /* 读模型恢复即补齐批注覆盖（正文区间层） */
        }),
      );
      line.append(retryTerms);
      drawer.append(line);
    } else {
      if (terminology.annotations.length === 0) {
        drawer.append(deps.mutedLine("no saved term annotations yet — select a term in an answer and “Explain selection”"));
      } else {
        const list = deps.document.createElement("ul");
        list.className = "drawer-list";
        for (const annotation of terminology.annotations) {
          const li = deps.document.createElement("li");
          const promotedNote =
            annotation.promotedBranchId === null
              ? "not promoted"
              : `promoted to ${deps.branchLabel(annotation.promotedBranchId)}`;
          /* P0 降级显示（W1 降级 Return 卡同款纪律）：锚定失效（原文漂移/锚
             点缺失）的批注——保存快照（摘录/术语/解释）照常在列表可读，但明
             确标注来源状态，绝不冒充仍可在正文上定位（活覆盖不渲染）。 */
          const anchorStatus = deps.terminologyAnchorStatus(annotation);
          const anchorNote =
            anchorStatus === "valid"
              ? ""
              : anchorStatus === "changed"
                ? " · source changed — the answer text drifted since saving (snapshot only, no live underline)"
                : " · source missing — the anchored answer is not in this tree (snapshot only)";
          li.textContent =
            `“${annotation.term}” (${annotation.mode}) from ${deps.branchLabel(annotation.branchId)} · ` +
            `anchored on “${annotation.selection.text}” · ${promotedNote}${anchorNote}`;
          list.append(li);
        }
        drawer.append(list);
      }
      /* 近期任务（瞬态——模式与任务态如实；进程重启即空，如实呈现）。 */
      if (terminology.tasks.length === 0) {
        drawer.append(deps.mutedLine("no terminology tasks in this process yet"));
      } else {
        const taskList = deps.document.createElement("ul");
        taskList.className = "drawer-list term-task-list";
        for (const task of terminology.tasks.slice(-8)) {
          const li = deps.document.createElement("li");
          let taskState = task.state.kind;
          if (task.state.kind === "succeeded") {
            taskState = task.state.cached === true ? "succeeded (from cache)" : "succeeded";
          } else if (task.state.kind === "failed") {
            taskState = `failed (${task.state.code})`;
          } else if (task.state.kind === "cancelled") {
            taskState =
              task.state.lateResultDiscarded === true
                ? "cancelled (late result discarded)"
                : "cancelled";
          }
          li.textContent = `${task.kind} · ${task.mode} · ${taskState}`;
          taskList.append(li);
        }
        drawer.append(taskList);
      }
      const usageNote = deps.document.createElement("p");
      usageNote.className = "muted";
      const usage = terminology.usage;
      usageNote.textContent =
        `terminology executor: ${String(usage.total.requests)} request(s), ` +
        `est. ${String(usage.estTokens)}/${String(usage.budgetTokens)} tokens (chars/4 estimate), ` +
        `${String(usage.lateResultsDiscarded)} late result(s) discarded by the executor, ` +
        `${String(deps.state.termDiscardedLate)} late response(s) discarded client-side, cache ${terminology.cacheEnabled ? "on" : "off"}`;
      drawer.append(usageNote);
      /* 缓存偏好（③：同 (mode, 选区, sourceHash) 解释复用缓存——可开关）。 */
      const cacheLine = deps.document.createElement("p");
      cacheLine.className = "muted term-cache-line";
      const cacheToggle = deps.document.createElement("button");
      cacheToggle.className = "term-cache-toggle";
      if (deps.terminologyController.termPrefsPending) {
        cacheToggle.textContent = "updating cache preference…";
        cacheToggle.disabled = true;
      } else {
        cacheToggle.textContent = terminology.cacheEnabled
          ? "cache preference: on — click to disable"
          : "cache preference: off — click to enable";
        cacheToggle.addEventListener("click", () =>
          void deps.guard(() => deps.setTerminologyCachePreference(!terminology.cacheEnabled)),
        );
      }
      cacheLine.append(cacheToggle);
      drawer.append(cacheLine);
      if (deps.terminologyController.termPrefsError !== null) {
        const prefsError = deps.document.createElement("p");
        prefsError.className = "muted";
        prefsError.textContent = `cache preference failed — ${deps.terminologyController.termPrefsError}`;
        drawer.append(prefsError);
      }
      /* 阅读模式三选一（①阅读模式）：manual-only（默认）/ minimal-hints /
         assisted-reading。模式可保存可切换；gate 未过（或仅手动）时旁注如实
         说明自动建议未生效——绝不伪装启用。切换 = PUT settings/reading-mode
         （在途禁用明示；失败如实 + 重试）。 */
      const modeRow = deps.document.createElement("div");
      modeRow.className = "term-mode-row";
      modeRow.setAttribute("role", "group");
      modeRow.setAttribute("aria-label", "Terminology reading mode");
      const currentMode = terminology.readingMode ?? "manual-only";
      const MODE_LABELS = {
        "manual-only": "Manual only",
        "minimal-hints": "Minimal hints",
        "assisted-reading": "Assisted reading",
      };
      for (const mode of ["manual-only", "minimal-hints", "assisted-reading"]) {
        const modeButton = deps.document.createElement("button");
        modeButton.className = "term-mode-toggle";
        modeButton.textContent = MODE_LABELS[mode];
        modeButton.title =
          mode === "manual-only"
            ? "No automatic suggestions — you explain selections yourself (default)"
            : mode === "minimal-hints"
              ? "A few suggested terms per completed answer (density-capped, display-only)"
              : "More suggested terms per completed answer (density-capped, display-only)";
        modeButton.setAttribute("aria-pressed", String(currentMode === mode));
        modeButton.disabled = deps.terminologyController.termModePending;
        modeButton.addEventListener("click", () => void deps.guard(() => deps.setTerminologyReadingMode(mode)));
        modeRow.append(modeButton);
      }
      drawer.append(modeRow);
      if (deps.terminologyController.termModePending) {
        drawer.append(deps.mutedLine("saving reading mode…"));
      }
      const autoState = terminology.autoSuggestions ?? null;
      if (autoState !== null && autoState.enabled !== true) {
        drawer.append(
          deps.mutedLine(
            autoState.reason === "manual-only"
              ? "reading mode is manual-only — suggestions appear only when you explain a selection yourself"
              : "the auto-annotation quality gate has not passed — automatic suggestions stay OFF; only manual explaining is in effect",
          ),
        );
      }
      if (deps.terminologyController.termModeError !== null) {
        const modeError = deps.document.createElement("p");
        modeError.className = "muted";
        modeError.textContent = `reading mode failed — ${deps.terminologyController.termModeError}`;
        drawer.append(modeError);
      }
    }

    /* journal 尾部（保守摘要；最新在后）。三态（W2 §2.7 / issue #3 P1）：
       加载中 / 已载（可为空——如实空态）/ 加载失败（失败 + 重试，绝不
       伪装成无事件）。 */
    const journalTitle = deps.document.createElement("h3");
    journalTitle.textContent = "Journal (latest 20)";
    drawer.append(journalTitle);
    if (deps.state.journalEvents === null) {
      drawer.append(deps.mutedLine("loading journal…"));
    } else if (!deps.state.journalEvents.ok) {
      const line = deps.document.createElement("p");
      line.className = "muted";
      line.append(deps.document.createTextNode("journal failed to load — "));
      const retry = deps.document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.title = "Fetch the journal tail again";
      retry.addEventListener("click", () => void deps.loadJournal());
      line.append(retry);
      drawer.append(line);
    } else if (deps.state.journalEvents.events.length === 0) {
      drawer.append(deps.mutedLine("no journal events recorded for this tree yet"));
    } else {
      const list = deps.document.createElement("ul");
      list.className = "drawer-list journal-list";
      for (const event of deps.state.journalEvents.events) {
        const li = deps.document.createElement("li");
        const time = deps.document.createElement("span");
        time.className = "muted";
        time.textContent = `${new Date(event.occurredAt).toLocaleTimeString()} `;
        li.append(time, deps.document.createTextNode(`${event.type} — ${event.summary}`));
        list.append(li);
      }
      drawer.append(list);
    }

    /* 工具活动（诚实边界：离线驱动无工具事件）。 */
    const toolTitle = deps.document.createElement("h3");
    toolTitle.textContent = "Tool activity";
    drawer.append(toolTitle);
    if (deps.state.toolActivity.length === 0) {
      drawer.append(deps.mutedLine("no tool activity observed — Studio runs with an empty tool allowlist"));
    } else {
      const list = deps.document.createElement("ul");
      list.className = "drawer-list";
      for (const activity of deps.state.toolActivity) {
        const li = deps.document.createElement("li");
        /* phase "denied" 携带策略 provenance（outcome/固定模板 reason/规则
           来源）；其余阶段只有工具名 + 阶段（参数/路径/命令绝不出境）。 */
        let text = `run ${activity.runId.slice(0, 12)}… · ${activity.tool ?? "unknown tool"} ${activity.phase}`;
        if (activity.phase === "denied" && activity.decision) {
          text += ` — ${activity.decision.reason} [${activity.decision.ruleId ?? "no rule"}]`;
        }
        li.textContent = text;
        list.append(li);
      }
      drawer.append(list);
    }

    /* delivered 卡反查定位：滚动到该 run 的出处条目。 */
    const focusRunId = deps.state.drawerFocusRunId;
    if (focusRunId !== null) {
      const li = drawerRunItems.get(focusRunId);
      if (li !== undefined && typeof li.scrollIntoView === "function") {
        li.scrollIntoView({ block: "start", behavior: deps.scrollBehavior() });
      }
    }
  }

  return {
    renderDrawer,
  };
}
