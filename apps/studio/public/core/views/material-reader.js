/** Material reader chrome, notes, block layout, tail states and entrance/exit presentation. Instance-owned state and dependencies. */

export function createMaterialReaderView(deps) {

  /** 阅读器进出场动画收尾 timer（M1/M2 契约同 panel/drawer）。 */
  let materialReaderAnimTimer = null;

  const MATERIAL_READER_ENTER_MS = 240;
   /* CSS 180ms + 收尾余量 */
  const MATERIAL_READER_EXIT_MS = 170;

  /** 拖拽窗口内被延后的阅读器 chrome 重渲（mouseup 后与整树重渲一起冲刷）。 */
  let materialPendingUpdate = false;


  /**
   * 阅读器 chrome 全量渲染（打开/切版本/状态刷新）。块容器 #mat-blocks 的
      **元素身份跨重渲保留**（先取引用，replaceChildren 后移回——子树不动），
      异步刷新对已载块零触碰；选区捕获条与尾部分别有就地更新函数（武装/
      翻页不整建 chrome）。拖拽窗口内延后（③ 同族：选择期间不重绘）。
   */
  function renderMaterialReader() {
    const reader = deps.state.materialReader;
    const root = deps.$("material-reader");
    if (reader === null) {
      root.replaceChildren();
      root.hidden = true;
      return;
    }
    if (deps.state.selectionDragActive) {
      materialPendingUpdate = true;
      return;
    }
    const preservedBlocks = deps.document.getElementById("mat-blocks");
    /* Chrome 丢弃被 detach 的滚动容器的 scrollTop（实测 5464→0；DOM 桩的
       scrollTop 跨 detach 存活，桩测不出）。重渲染保持滚动位置——位置恢复/
       注记补渲不再把视口拉回顶部。内容合法重置的路径（打开新材料前已清空
       子元素）scrollTop 自然归 0，不受影响。 */
    const preservedScrollTop = preservedBlocks === null ? null : preservedBlocks.scrollTop;
    root.replaceChildren();

    /* 头部：标题 + 关闭（覆盖层打开时盖住侧栏入口，阅读器内需要可见关闭）。 */
    const head = deps.document.createElement("div");
    head.className = "mat-head";
    const title = deps.document.createElement("h2");
    title.className = "mat-title";
    title.textContent = reader.material.title === "" ? reader.materialId : reader.material.title;
    const close = deps.document.createElement("button");
    close.id = "mat-close";
    close.className = "mat-close";
    close.textContent = "关闭";
    close.title = "关闭阅读器（Esc），阅读位置会保留";
    close.addEventListener("click", () => deps.closeMaterialReader());
    head.append(title, close);
    root.append(head);

    /* 元信息行：所渲染版本可辨认（charter §3.1）——版本号/新旧、解析器
       版本、导入时间、规范文本长度。 */
    const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
    const meta = deps.document.createElement("div");
    meta.className = "mat-meta";
    if (version === null) {
      meta.textContent = reader.versions.length === 0 ? "no versions recorded" : "";
    } else {
      const number = materialVersionNumber(reader.versions, version.id);
      const isLatest = reader.versions[reader.versions.length - 1].id === version.id;
      const label = deps.document.createElement("span");
      label.className = `mat-version-label${isLatest ? "" : " old"}`;
      label.textContent = isLatest
        ? `v${String(number)} (current)`
        : `v${String(number)} (older — v${String(reader.versions.length)} is current)`;
      meta.append(label);
      meta.append(
        deps.document.createTextNode(
          ` · ${version.parserKind} · ${version.parserVersion} · imported ${deps.formatProductTime(version.importedAt)}` +
            ` · ${String(version.textUnits)} text units`,
        ),
      );
    }
    root.append(meta);

    /* 版本链：每版一枚小片。ready 版本可点开（旧版本保持可读——切换是显式
       动作，绝不自动迁移任何锚点，charter §3.1）；非 ready 版本如实标注
       状态与原因（不可点——没有可读正文，不伪装）。 */
    if (reader.versions.length > 0) {
      const strip = deps.document.createElement("div");
      strip.className = "mat-versions";
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", "Material versions");
      reader.versions.forEach((candidate, index) => {
        const isCurrent = candidate.id === reader.versionId;
        const latest = index === reader.versions.length - 1;
        const readable = candidate.parseStatus === "ready";
        const chip = deps.document.createElement(readable ? "button" : "span");
        chip.className = "mat-version-chip";
        chip.dataset.versionId = candidate.id;
        let text = `v${String(index + 1)} · ${candidate.parserKind}`;
        if (!latest) text += " · older";
        if (candidate.parseStatus !== "ready") text += ` · ${candidate.parseStatus}`;
        chip.textContent = text;
        if (isCurrent) {
          chip.classList.add("active");
          chip.setAttribute("aria-current", "true");
        }
        if (!readable) {
          chip.classList.add("unreadable", candidate.parseStatus);
          if (typeof candidate.parseError === "string" && candidate.parseError !== "") {
            chip.title = candidate.parseError;
          }
        } else if (!isCurrent) {
          chip.title = `Open v${String(index + 1)} (an older, readable version — saved quotes are never migrated across versions)`;
          chip.addEventListener("click", () => void deps.switchMaterialVersion(candidate.id));
        }
        strip.append(chip);
      });
      root.append(strip);
    }

    /* 诚实状态注记（可叠加）：打开/首页失败 + 重试；无版本；非 ready 状态
       （含原因与刷新入口）；PDF 下一增量；旧版本 + 切最新入口；最新版本
       不可读但当前读的是旧版；位置恢复注记。 */
    for (const note of buildMaterialNotes(reader, version)) root.append(note);

    /* 选区捕获条（常驻——不随正文滚动消失；role=status 朗读状态变化）。 */
    const bar = deps.document.createElement("div");
    bar.id = "mat-selection-bar";
    bar.className = "mat-selection-bar";
    bar.setAttribute("role", "status");
    root.append(bar);

    /* D4-3 建枝流程面（材料范围声明 + 首问 / 恢复二选；无流程时不渲染）。
       置于捕获条与正文之间——提交前的材料范围声明就近可读。 */
    const branchFlow = deps.renderMaterialBranchFlow();
    if (branchFlow !== null) root.append(branchFlow);

    /* 块容器：优先移回既有元素（身份/子树/监听全部保留）。 */
    const blocksEl = preservedBlocks ?? createMaterialBlocksElement();
    root.append(blocksEl);
    if (preservedScrollTop !== null && preservedScrollTop > 0) blocksEl.scrollTop = preservedScrollTop;

    /* 尾部状态。 */
    const tail = deps.document.createElement("div");
    tail.id = "mat-tail";
    tail.className = "mat-tail";
    root.append(tail);

    deps.updateMatSelectionBar();
    updateMatTail();
  }


  /** 状态注记构建（D4-2 诚实状态面的逐项落位）。 */
  function buildMaterialNotes(reader, version) {
    const notes = [];
    const appendNote = (text, opts = {}) => {
      const note = deps.document.createElement("div");
      note.className = `mat-note${opts.danger === true ? " danger" : ""}`;
      note.append(deps.document.createTextNode(text));
      for (const action of opts.actions ?? []) note.append(action);
      notes.push(note);
      return note;
    };
    const actionButton = (text, title, onClick, extraClass = "") => {
      const button = deps.document.createElement("button");
      button.className = `mat-note-action${extraClass === "" ? "" : ` ${extraClass}`}`;
      button.textContent = text;
      button.title = title;
      button.addEventListener("click", onClick);
      return button;
    };
    if (reader.firstPageState === "failed" && reader.versions.length === 0) {
      /* 详情级失败（版本链都未取得）：注记区承载错误 + 重试；分块读取失败
         （版本链已知，正文为空、尾部就在正文下方）由尾部状态面承载，不
         重复两处。 */
      appendNote(
        `opening the material failed — ${reader.firstPageError ?? "unknown error"}`,
        {
          danger: true,
          actions: [
            actionButton("Retry", "Retry opening this material", () =>
              void deps.openMaterial(reader.materialId, { trigger: deps.materialReaderFocusReturn ?? undefined }),
            "mat-retry-open"),
          ],
        },
      );
      return notes;
    }
    if (version === null) {
      appendNote("this material has no versions recorded — nothing to read yet", { danger: true });
      return notes;
    }
    const number = materialVersionNumber(reader.versions, version.id);
    const latest = reader.versions[reader.versions.length - 1];
    if (version.parseStatus !== "ready") {
      /* 非 ready：状态如实 + 原因（failed/unsupported/rejected 的 parseError
         全文可读）；pending/parsing 给刷新入口（解析任务是进程内瞬态——没有
         推送，刷新是显式动作）；绝无“空文档伪装成功”。 */
      const reason =
        typeof version.parseError === "string" && version.parseError !== ""
          ? ` — ${version.parseError}`
          : "";
      if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
        appendNote(
          `v${String(number)} is still being parsed (${version.parseStatus}${reason}) — press Refresh to check again`,
          {
            actions: [
              actionButton("Refresh", "Re-fetch this material's version statuses", () =>
                void deps.refreshMaterialDetail(),
              ),
            ],
          },
        );
      } else {
        appendNote(
          `v${String(number)} is ${version.parseStatus}${reason}. ` +
            "This is not an empty document — the original file is kept as imported; " +
            "an older ready version (if any) stays readable via the version strip above.",
          { danger: true },
        );
      }
    } else if (version.parserKind === "pdf") {
      /* PDF 阅读面（charter §3.2）：原始 PDF 页面由本地 PDF.js display/worker
         绘制，TreeAI 保留 canonical UTF-16 文字层和确定性行几何；原始页面失败时
         使用浏览器本地 PDF fallback，绝不把失败伪装成空文档。 */
      appendNote(
        "PDF reading surface — the original page is rendered locally with PDF.js and a selectable canonical " +
          "text layer; select within one page (cross-page selections are refused, never silently truncated); " +
          "visible pages render first as you scroll",
      );
    }
    if (version.id !== latest.id) {
      /* 旧版本可读 + 非破坏性切最新入口（charter §3.1：切换绝不迁移锚点）。 */
      appendNote(
        `you are reading v${String(number)} (older) — v${String(reader.versions.length)} is the current version. ` +
          "Switching never migrates saved quotes: each stays anchored to its own version.",
        {
          actions: [
            actionButton(
              `Open v${String(reader.versions.length)}`,
              "Switch the reader to the current version (non-destructive — this version stays readable)",
              () => void deps.switchMaterialVersion(latest.id),
            ),
          ],
        },
      );
      if (latest.parseStatus !== "ready") {
        const reason =
          typeof latest.parseError === "string" && latest.parseError !== ""
            ? ` — ${latest.parseError}`
            : "";
        appendNote(
          `the current version v${String(reader.versions.length)} is ${latest.parseStatus}${reason} — this older version remains readable`,
          { danger: latest.parseStatus === "failed" || latest.parseStatus === "unsupported" || latest.parseStatus === "rejected" },
        );
      }
    }
    if (reader.restoredToBlockId !== null) {
      notes.push(deps.mutedLine(`restored to your saved reading position (block ${reader.restoredToBlockId})`));
    }
    /* D4-4 搜索命中跳转注记 / D4-3 材料 Return 的原文跳转注记（两个来源两
       种说法——与位置恢复注记分开，绝不把跳转伪装成位置恢复）。 */
    if (reader.searchJump !== null) {
      if (reader.searchJump.arrival === "return-source") {
        if (reader.searchJump.fellBackToDefaultVersion) {
          notes.push(
            deps.mutedLine(
              "jumped to the material source of a Return — the Return's version is no longer in this material's version " +
                "chain, so the default version selection is shown instead (nothing is faked)",
            ),
          );
        } else if (reader.searchJump.blockId !== null) {
          notes.push(deps.mutedLine(`jumped to the material source of a Return — located at block ${reader.searchJump.blockId}`));
        } else {
          notes.push(deps.mutedLine("jumped to the material source of a Return — the version is opened at the top"));
        }
      } else if (reader.searchJump.fellBackToDefaultVersion) {
        notes.push(
          deps.mutedLine(
            "arrived from Search — the hit's version is no longer in this material's version chain, " +
              "so the default version selection is shown instead (nothing is faked)",
          ),
        );
      } else if (reader.searchJump.blockId !== null) {
        notes.push(deps.mutedLine(`arrived from Search — the hit is located at block ${reader.searchJump.blockId}`));
      } else {
        notes.push(deps.mutedLine("arrived from Search — the hit's version is opened at the top"));
      }
    }
    return notes;
  }


  /** 版本序号（导入序 1-based）。 */
  function materialVersionNumber(versions, versionId) {
    const index = versions.findIndex((candidate) => candidate.id === versionId);
    return index < 0 ? 0 : index + 1;
  }


  /** 创建块容器（每阅读器会话一次；监听随元素存续——重渲只移回不重建）。 */
  function createMaterialBlocksElement() {
    const blocksEl = deps.document.createElement("div");
    blocksEl.id = "mat-blocks";
    blocksEl.className = "mat-blocks";
    blocksEl.setAttribute("aria-label", "Material text (canonical, block by block)");
    /* 键盘可达的滚动区（WCAG 2.1 SC 2.1.1：可滚动内容须键盘可操作）——
       tabindex=0 使 #mat-blocks 成为 Tab 停靠点，聚焦后方向键/PageDown
       滚动正文（此前阅读器内无任何可聚焦子元素，键盘无法滚动阅读——
       B7 beta 可用性探针发现）。 */
    blocksEl.setAttribute("tabindex", "0");
    /* ③ 同族：正文按下开启拖拽窗口——窗口内 chrome 重渲延后（块追加是纯
       增量的，不触碰既有节点，无需延后）。 */
    blocksEl.addEventListener("mousedown", () => {
      deps.state.selectionDragActive = true;
    });
    const armFromEvent = () => {
      if (deps.state.selectionDragActive) {
        deps.state.selectionDragActive = false;
        deps.window.setTimeout(deps.flushPendingRerender, 0);
      }
      deps.armMaterialSelection();
    };
    blocksEl.addEventListener("mouseup", armFromEvent);
    blocksEl.addEventListener("dblclick", armFromEvent);
    blocksEl.addEventListener("scroll", () => {
      const reader = deps.state.materialReader;
      if (reader === null) return;
      deps.scheduleMaterialPositionSave();
      deps.maybeLoadMoreMaterialBlocks(blocksEl);
      /* PDF 懒渲染窗口随滚动重估（可见页先行渲染，窗外页卸回占位）。 */
      deps.updatePdfPageRendering(reader);
    });
    return blocksEl;
  }


  /**
   * 块元素渲染（markdown → 无损字面块；pdf-page → 页框）：markdown 块元素
   * 携带 data-block-id / data-start / data-end（规范文本映射——绝对 UTF-16
   * 区间），内容由 renderMarkdownInto 无损填充；PDF 页块渲染为页框
   * （.pdf-page-frame：页头标识 + 文本层），文本层按懒渲染纪律按需填充
   * （updatePdfPageRendering——可见页先行，远页占位）。
   */
  function renderMaterialBlockElement(entry, reader) {
    if (entry.block.kind === "pdf-page") return deps.createPdfPageFrame(entry);
    const div = deps.document.createElement("div");
    div.className = "material-block";
    div.dataset.blockId = entry.block.blockId;
    div.dataset.start = String(entry.block.start);
    div.dataset.end = String(entry.block.end);
    reader.fenceOpen = deps.renderMarkdownInto(div, entry.text, reader.fenceOpen);
    return div;
  }


  /** 尾部状态就地更新（首页/追加分页态、加载更多按钮、末尾注记、裁剪注记）。 */
  function updateMatTail() {
    const reader = deps.state.materialReader;
    const tail = deps.document.getElementById("mat-tail");
    if (reader === null || tail === null) return;
    tail.replaceChildren();
    const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
    if (version === null || version.parseStatus !== "ready") {
      return; /* 非 ready：状态面在注记区，无正文尾部 */
    }
    const isPdf = deps.materialReaderIsPdf(reader);
    const unitWord = isPdf ? "page(s)" : "block(s)";
    if (reader.firstPageState === "loading") {
      tail.append(deps.document.createTextNode(`loading ${isPdf ? "pages" : "blocks"}…`));
      return;
    }
    if (reader.firstPageState === "failed") {
      tail.append(deps.document.createTextNode(`loading failed — ${reader.firstPageError ?? "unknown error"} `));
      const retry = deps.document.createElement("button");
      retry.className = "drawer-retry mat-retry-open";
      retry.textContent = "Retry";
      retry.title = "Retry opening this material";
      retry.addEventListener("click", () =>
        void deps.openMaterial(reader.materialId, { trigger: deps.materialReaderFocusReturn ?? undefined }),
      );
      tail.append(retry);
      return;
    }
    if (reader.appendState === "failed") {
      const error = deps.document.createElement("span");
      error.className = "mat-tail-error";
      error.textContent = `loading more blocks failed — ${reader.appendError ?? "unknown error"} `;
      tail.append(error);
      const retry = deps.document.createElement("button");
      retry.className = "drawer-retry mat-retry-append";
      retry.textContent = "Retry";
      retry.title = "Retry loading the next page of blocks";
      retry.addEventListener("click", () => void deps.loadMoreMaterialBlocks());
      tail.append(retry);
      return;
    }
    if (reader.appendState === "loading") {
      tail.append(deps.document.createTextNode("loading more blocks…"));
    } else if (reader.nextAfterBlock !== null) {
      /* 键盘可达的显式加载入口（滚贴近底自动预取，按钮是等价显式动作）。 */
      const more = deps.document.createElement("button");
      more.className = "mat-load-more";
      more.textContent = isPdf ? "Load more pages" : "Load more blocks";
      more.title = isPdf
        ? "Load the next page of PDF pages (also loads automatically near the bottom)"
        : "Load the next page of blocks (also loads automatically near the bottom)";
      more.addEventListener("click", () => void deps.loadMoreMaterialBlocks());
      tail.append(more);
    } else {
      tail.append(deps.document.createTextNode(isPdf ? "end of material (last page)" : "end of material"));
    }
    tail.append(
      deps.document.createTextNode(
        ` · ${String(reader.blocks.length)} ${unitWord} in view · ${String(reader.textUnits)} text units total`,
      ),
    );
    if (reader.trimmedBlocks > 0) {
      tail.append(
        deps.document.createTextNode(
          ` · ${String(reader.trimmedBlocks)} earlier ${isPdf ? "page(s)" : "block(s)"} unloaded to keep the view light — ` +
            "close and reopen (or reselect the version) to read from the beginning",
        ),
      );
    }
  }


  /* 阅读器进出场（M1/M2 契约同 panel/drawer：hidden 属性 + .enter/.exit，
     退出播完才 hidden；reduced-motion 下 CSS 即时化）。 */
  function showMaterialReader() {
    const root = deps.$("material-reader");
    if (materialReaderAnimTimer !== null) {
      deps.window.clearTimeout(materialReaderAnimTimer);
      materialReaderAnimTimer = null;
    }
    root.classList.remove("exit");
    if (root.hidden) {
      root.hidden = false;
      void root.offsetHeight; /* reflow：确保 enter 动画从初始态播放 */
      root.classList.add("enter");
      materialReaderAnimTimer = deps.window.setTimeout(() => {
        root.classList.remove("enter");
        materialReaderAnimTimer = null;
      }, MATERIAL_READER_ENTER_MS);
    }
  }


  function hideMaterialReader(opts = {}) {
    const root = deps.$("material-reader");
    if (materialReaderAnimTimer !== null) {
      deps.window.clearTimeout(materialReaderAnimTimer);
      materialReaderAnimTimer = null;
    }
    root.classList.remove("enter");
    if (opts.instant || root.hidden) {
      root.hidden = true;
      root.classList.remove("exit");
      return;
    }
    root.classList.add("exit");
    materialReaderAnimTimer = deps.window.setTimeout(() => {
      root.hidden = true;
      root.classList.remove("exit");
      materialReaderAnimTimer = null;
    }, MATERIAL_READER_EXIT_MS);
  }

  return {
    get materialPendingUpdate() { return materialPendingUpdate; },
    set materialPendingUpdate(value) { materialPendingUpdate = value; },
    renderMaterialReader,
    hideMaterialReader,
    showMaterialReader,
    updateMatTail,
    renderMaterialBlockElement,
  };
}
