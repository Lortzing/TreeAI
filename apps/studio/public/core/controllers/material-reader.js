/** Version-scoped material sessions, bounded block paging, reading-position saving and close/restore. Instance-owned state and dependencies. */
import { isElementNode } from "../dom.js";

export function createMaterialReaderController(deps) {


  /* ------------------------------ D4-2 材料阅读（issue #8 工作包 D4-2） ------------------------------ */

  /** 分块读取页大小（块数；与服务端缺省 DEFAULT_BLOCK_PAGE_LIMIT=50 同值，
      显式携带以保确定性）。 */
  const MATERIAL_PAGE_LIMIT = 50;

  /** 已载块窗口上限（有界 DOM：超过即从顶部裁掉最旧块——阅读是前进式活动；
      裁剪计数如实呈现，重开材料/重选版本即从头可读）。 */
  const MATERIAL_MAX_LOADED_BLOCKS = 300;

  /** 懒加载提前量（px）：视口底边距内容底部不足该值即预取下一页。 */
  const MATERIAL_LOAD_THRESHOLD_PX = 400;

  /** 阅读位置保存节流（ms）：滚动停止后落一次 PUT；关闭/切版本/切树时立即
      冲刷（charter §3.2「原文阅读与分支探索各自保留位置」——阅读位置走
      服务端 reading-position 行，与对话的 scrollPositions 互不覆盖）。 */
  const MATERIAL_POSITION_SAVE_DEBOUNCE_MS = 1500;

  /** PDF 分块读取页大小（页数——pdf 的块即页；小于 markdown 页：大 PDF 首屏
      只取少量页，B6 的 2s 首屏目标依赖小步分页）。 */
  const PDF_PAGE_FETCH_LIMIT = 10;


  /** 阅读器世代号（打开/切版本/刷新 detail 各递增）：迟到的 detail/分页
      响应（已切材料/切版本/切树/已关闭）按世代丢弃。 */
  let materialReaderEpoch = 0;

  /** 阅读位置节流 timer（关闭/切版本时冲刷）。 */
  let materialPositionTimer = null;


  /** 阅读器关闭时的焦点还原引用。 @type {FocusReturnRefT|null} */
  let materialReaderFocusReturn = null;

  /** 打开材料阅读器。幂等：同一材料已在读（且非失败态）只聚焦；换材料先把
      当前阅读位置落库（旧材料的事实不因切换丢失）。打开是异步的——先立
      loading 壳，detail 到达后选版本并拉首页；全程按世代丢弃迟到响应。
      D4-4 搜索命中跳转：opts.versionId 显式指定命中版本（旧版本命中即打开
      旧版本——版本诚实同 D4-2，绝不静默落到最新）；opts.focusBlockId 定位
      到命中块（与阅读位置恢复同一跨页前补循环）。命中版本已不在版本链
      （版本行不可变，正常不可能）时如实回落默认选择并注记，不伪装。 */
  async function openMaterial(materialId, opts = {}) {
    if (deps.state.currentTreeId === null) return;
    deps.$("materials-section").open = false;
    deps.$("reading-materials").setAttribute("aria-expanded", "false");
    if (
      deps.state.materialReader !== null &&
      deps.state.materialReader.materialId === materialId &&
      deps.state.materialReader.firstPageState !== "failed" &&
      opts.versionId === undefined
    ) {
      deps.$("material-reader").focus();
      return;
    }
    if (deps.state.materialReader !== null) {
      /* 换材料：先把当前阅读位置落库（旧材料的事实不因切换丢失），并清空
         既有块容器——blockId 序列（blk-N）跨材料重名，绝不能移用上一份的
         块元素。 */
      saveMaterialReadingPositionNow();
      const previousBlocks = deps.document.getElementById("mat-blocks");
      if (previousBlocks !== null) previousBlocks.replaceChildren();
    }
    const treeId = deps.state.currentTreeId;
    const epoch = ++materialReaderEpoch;
    deps.state.materialSelection = null;
    deps.state.materialReader = {
      materialId,
      treeId,
      material: { id: materialId, title: "", createdAt: "" },
      versions: [],
      versionId: "",
      readingPosition: null,
      blocks: [],
      nextAfterBlock: null,
      textUnits: 0,
      firstPageState: "loading",
      firstPageError: null,
      pdfDocument: null,
      pdfLoading: null,
      pdfError: null,
      pdfRenderTasks: new Map(),
      appendState: "idle",
      appendError: null,
      fenceOpen: false,
      trimmedBlocks: 0,
      restoredToBlockId: null,
      lastSavedBlockId: null,
      searchJump:
        opts.versionId !== undefined
          ? {
              blockId: opts.focusBlockId ?? null,
              versionId: opts.versionId,
              fellBackToDefaultVersion: false,
              arrival: opts.arrival === "return-source" ? "return-source" : "search",
            }
          : null,
    };
    materialReaderFocusReturn = opts.trigger ?? { kind: "material-button", materialId };
    deps.renderMaterialReader();
    deps.showMaterialReader();
    deps.$("material-reader").focus();
    try {
      const detail = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}`,
      );
      if (
        epoch !== materialReaderEpoch ||
        deps.state.materialReader === null ||
        deps.state.materialReader.materialId !== materialId ||
        deps.state.currentTreeId !== treeId
      ) {
        return; /* 迟到丢弃：已切材料/切树/关闭 */
      }
      const reader = deps.state.materialReader;
      reader.material = detail.material;
      reader.versions = detail.versions;
      reader.readingPosition = detail.readingPosition ?? null;
      let version = null;
      if (reader.searchJump !== null) {
        /* 搜索命中跳转：命中版本优先（旧版本命中打开旧版本）；版本已不在
           链上（不可变版本行，正常不可能）→ 如实回落 + 注记（绝不伪装）。 */
        version = detail.versions.find((candidate) => candidate.id === reader.searchJump.versionId) ?? null;
        if (version === null) reader.searchJump.fellBackToDefaultVersion = true;
      }
      if (version === null) version = chooseMaterialVersion(detail);
      reader.versionId = version === null ? "" : version.id;
      await loadMaterialFirstPage(reader, { epoch, treeId });
    } catch (err) {
      if (
        epoch !== materialReaderEpoch ||
        deps.state.materialReader === null ||
        deps.state.materialReader.materialId !== materialId ||
        deps.state.currentTreeId !== treeId
      ) {
        return;
      }
      deps.state.materialReader.firstPageState = "failed";
      deps.state.materialReader.firstPageError = String(err && err.message ? err.message : err);
      deps.renderMaterialReader();
    }
  }


  /**
   * 首版选择（charter §1「隔天回来能找到原文」）：保存过阅读位置且该版本
   * 仍可读（ready——markdown 与 PDF 都支持位置恢复）→ 恢复到该版本；否则
   * 最新版本（其状态——含失败——在阅读器内如实呈现，不因失败静默回落
   * 旧版：列表与版本链都标明旧 ready 版本可读，切换是显式动作）。
   */
  function chooseMaterialVersion(detail) {
    const versions = detail.versions;
    if (versions.length === 0) return null;
    const position = detail.readingPosition;
    if (position !== null) {
      const saved = versions.find((version) => version.id === position.versionId) ?? null;
      if (saved !== null && saved.parseStatus === "ready") {
        return saved;
      }
    }
    return versions[versions.length - 1];
  }


  /** 阅读器当前版本对象（版本链内按 versionId 查找；不在链 → null）。 */
  function materialReaderVersion(reader) {
    return reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
  }


  /** 当前阅读版本是否 PDF（页块渲染/懒分页/单页选区纪律的判定源）。 */
  function materialReaderIsPdf(reader) {
    const version = materialReaderVersion(reader);
    return version !== null && version.parserKind === "pdf";
  }


  /** 首页加载（含位置恢复的跨页前补）：非 ready 版本不取块——状态面如实
      呈现（409 material-not-ready 的竞态也经 catch 落入同一失败面）；ready
      的 markdown 与 PDF 版本都取块（PDF 的块即页——页框按懒渲染纪律落位）。 */
  async function loadMaterialFirstPage(reader, opts) {
    const { epoch, treeId } = opts;
    const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
    const isStale = () =>
      epoch !== materialReaderEpoch || deps.state.materialReader !== reader || deps.state.currentTreeId !== treeId;
    if (version === null || version.parseStatus !== "ready") {
      reader.firstPageState = "loaded";
      deps.renderMaterialReader();
      return;
    }
    reader.firstPageState = "loading";
    reader.firstPageError = null;
    deps.renderMaterialReader();
    /* 恢复/定位目标：D4-4 搜索命中跳转优先（用户刚点击的意图）；无跳转时
       按保存的阅读位置恢复。目标块不在首页则按 nextAfterBlock 向前补页
       （API 只有正向分页——循环以块总数为上界，长材料上是诚实代价；目标
       块出现即停）。 */
    const position = reader.readingPosition;
    const restoreBlockId =
      position !== null && position.versionId === reader.versionId && position.blockId !== null
        ? position.blockId
        : null;
    const jumpBlockId =
      reader.searchJump !== null && reader.searchJump.blockId !== null ? reader.searchJump.blockId : null;
    const targetBlockId = jumpBlockId ?? restoreBlockId;
    let afterBlock = null;
    for (;;) {
      let page;
      try {
        page = await fetchMaterialPage(reader, treeId, afterBlock);
      } catch (err) {
        if (isStale()) return;
        reader.firstPageState = "failed";
        reader.firstPageError = String(err && err.message ? err.message : err);
        deps.renderMaterialReader();
        return;
      }
      if (isStale()) return;
      applyMaterialPage(reader, page);
      if (targetBlockId === null || page.nextAfterBlock === null) break;
      if (reader.blocks.some((entry) => entry.block.blockId === targetBlockId)) break;
      afterBlock = page.nextAfterBlock;
    }
    reader.firstPageState = "loaded";
    /* 先定注记再单次渲染，滚动放最后：原顺序（渲染→滚动→为注记再渲染）
       会在平滑滚动进行中 detach 块容器——Chrome 取消滚动并把 scrollTop 归
       0（实测 0 vs 7208），重渲染的保位恢复也救不回已取消的动画。 */
    if (jumpBlockId !== null) {
      /* 搜索命中定位注记（chrome 渲染时读取 searchJump——已由调用方设定，
         不与位置恢复注记混写）。 */
    } else {
      reader.restoredToBlockId = restoreBlockId;
    }
    deps.renderMaterialReader();
    if (targetBlockId !== null) {
      const target = materialBlockElement(targetBlockId);
      if (target !== null && typeof target.scrollIntoView === "function") {
        /* 恢复/命中跳转用即时滚动：平滑滚动是异步动画，其后任何重渲的
           detach 都会取消动画并丢 scrollTop（真实 Chrome 实测 183/7208）；
           即时落位同步生效，配合渲染保位跨重渲稳定。 */
        target.scrollIntoView({ block: "start", behavior: "auto" });
        /* PDF：先按当前几何重估懒渲染窗口，再显式渲染跳转目标页（目标即
           已可见；真实浏览器 scrollIntoView 后的 scroll 事件会自然重估，
           脚本桩无事件——顺序保证目标页绝不被重估卸回占位）。 */
        deps.updatePdfPageRendering(reader);
        deps.renderPdfPageTextIn(target);
      }
    }
  }


  /** 分块读取请求（显式 limit=页大小；afterBlock 为下一页游标）。PDF 用
      更小的页步（PDF_PAGE_FETCH_LIMIT——大 PDF 首屏只取少量页）。 */
  async function fetchMaterialPage(reader, treeId, afterBlock) {
    const limit = materialReaderIsPdf(reader) ? PDF_PAGE_FETCH_LIMIT : MATERIAL_PAGE_LIMIT;
    let path =
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}` +
      `/versions/${encodeURIComponent(reader.versionId)}?limit=${String(limit)}`;
    if (afterBlock !== null) {
      path += `&afterBlock=${encodeURIComponent(afterBlock)}`;
    }
    return deps.api(path);
  }


  /** 一页数据落地：窗口数据（reader.blocks）+ DOM 追加 + 顶部裁剪 + 尾部态
      + PDF 懒渲染窗口重估（可见页先行渲染）。 */
  function applyMaterialPage(reader, page) {
    for (const entry of page.blocks) reader.blocks.push(entry);
    reader.nextAfterBlock = page.nextAfterBlock;
    reader.textUnits = page.textUnits;
    appendMaterialBlockElements(reader);
    trimMaterialWindow(reader);
    deps.updatePdfPageRendering(reader);
    deps.updateMatTail();
  }


  /** 追加缺失块元素（页序即 DOM 序；复用既有元素——懒加载/重渲不换走已读
      块，选区期间的元素身份稳定）。markdown 块与 PDF 页框都是 #mat-blocks
      的直接子元素，以 data-block-id 判存在。 */
  function appendMaterialBlockElements(reader) {
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl === null) return;
    const present = new Set();
    for (const child of blocksEl.children) {
      if (isElementNode(child) && child.dataset.blockId !== undefined) {
        present.add(child.dataset.blockId);
      }
    }
    for (const entry of reader.blocks) {
      if (present.has(entry.block.blockId)) continue;
      blocksEl.append(deps.renderMaterialBlockElement(entry, reader));
    }
  }


  /** 有界窗口：已载块超上限时从顶部同步裁掉最旧块（数据 + DOM 一起——
      reader.blocks 即当前窗口，偏移换算/位置保存都以在场块为事实）。裁剪
      调整 scrollTop 保持视觉位置（真实浏览器按被裁元素实高；脚本桩高度为
      0 → 调整量为 0，确定性）。 */
  function trimMaterialWindow(reader) {
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl === null) return;
    const over = reader.blocks.length - MATERIAL_MAX_LOADED_BLOCKS;
    if (over <= 0) return;
    let removedHeight = 0;
    let removed = 0;
    while (removed < over && reader.blocks.length > 0) {
      const [entry] = reader.blocks;
      const element = materialBlockElement(entry.block.blockId);
      if (element !== null) {
        removedHeight += typeof element.offsetHeight === "number" ? element.offsetHeight : 0;
        blocksEl.removeChild(element);
      }
      reader.blocks.shift();
      reader.trimmedBlocks += 1;
      removed += 1;
    }
    if (removedHeight > 0 && blocksEl.scrollTop > 0) {
      blocksEl.scrollTop = Math.max(0, blocksEl.scrollTop - removedHeight);
    }
  }


  /** 块元素按 blockId 查找（stub 查询引擎只支持 id/class/tag——不用属性
      选择器，遍历即兼容）。 */
  function materialBlockElement(blockId) {
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl === null) return null;
    for (const child of blocksEl.children) {
      if (isElementNode(child) && child.dataset.blockId === blockId) return child;
    }
    return null;
  }


  /** 懒加载：贴底（提前量内）且有下一页 → 预取。滚动触发与尾部按钮共用。 */
  function maybeLoadMoreMaterialBlocks(blocksEl) {
    const reader = deps.state.materialReader;
    if (reader === null) return;
    if (reader.nextAfterBlock === null) return;
    if (reader.appendState === "loading" || reader.firstPageState !== "loaded") return;
    const threshold =
      blocksEl.scrollHeight - blocksEl.clientHeight - MATERIAL_LOAD_THRESHOLD_PX;
    if (blocksEl.scrollTop < threshold) return;
    void loadMoreMaterialBlocks();
  }


  /** 追加下一页（世代守卫：迟到响应绝不写进已切换的阅读器）。 */
  async function loadMoreMaterialBlocks() {
    const reader = deps.state.materialReader;
    const treeId = deps.state.currentTreeId;
    if (reader === null || treeId === null) return;
    if (reader.nextAfterBlock === null || reader.appendState === "loading" || reader.firstPageState !== "loaded") {
      return;
    }
    const epoch = materialReaderEpoch;
    const afterBlock = reader.nextAfterBlock;
    reader.appendState = "loading";
    reader.appendError = null;
    deps.updateMatTail();
    try {
      const page = await fetchMaterialPage(reader, treeId, afterBlock);
      if (epoch !== materialReaderEpoch || deps.state.materialReader !== reader || deps.state.currentTreeId !== treeId) {
        return;
      }
      applyMaterialPage(reader, page);
      reader.appendState = "idle";
    } catch (err) {
      if (epoch !== materialReaderEpoch || deps.state.materialReader !== reader || deps.state.currentTreeId !== treeId) {
        return;
      }
      reader.appendState = "failed";
      reader.appendError = String(err && err.message ? err.message : err);
    }
    deps.updateMatTail();
  }


  /* ------------------------------ D4-2 阅读位置 ------------------------------ */

  /** 滚动停止后节流保存（一次滚动只落一次 PUT）。 */
  function scheduleMaterialPositionSave() {
    if (materialPositionTimer !== null) deps.window.clearTimeout(materialPositionTimer);
    materialPositionTimer = deps.window.setTimeout(() => {
      materialPositionTimer = null;
      saveMaterialReadingPositionNow();
    }, MATERIAL_POSITION_SAVE_DEBOUNCE_MS);
  }


  /**
   * 保存阅读位置（立即版：关闭/切版本/切树前冲刷）。块级定位——顶部可见
   * 块的 blockId；focusStart 区间留给 D4-3 的跳转场景。同块不重复写；块
   * 尚未载入（blockId null）时**跳过**——UPSERT 整体替换语义下写 null 会
   * 抹掉既有位置。保存失败不阻断阅读（后台尽力事实，下次节流/关闭再试）。
   */
  function saveMaterialReadingPositionNow() {
    const reader = deps.state.materialReader;
    if (reader === null || deps.state.currentTreeId === null) return;
    if (materialPositionTimer !== null) {
      deps.window.clearTimeout(materialPositionTimer);
      materialPositionTimer = null;
    }
    const blockId = currentMaterialTopBlockId();
    if (blockId === null) return;
    if (reader.lastSavedBlockId === blockId) return;
    reader.lastSavedBlockId = blockId;
    const treeId = deps.state.currentTreeId;
    void deps.api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}/reading-position`,
      "PUT",
      { versionId: reader.versionId, blockId, focusStart: null },
    ).catch(() => {
      /* 位置保存是后台尽力事实：失败不打断阅读（下次节流/关闭重试） */
    });
  }


  /** 顶部可见块（几何法：首个底边越过滚动顶端的块；脚本桩高度为 0 → 回落
      首个在场块，确定性）。markdown 块与 PDF 页框都是直接子元素（均携带
      data-block-id——阅读位置对两种块型一致按块/页定位）。 */
  function currentMaterialTopBlockId() {
    const reader = deps.state.materialReader;
    if (reader === null) return null;
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl === null) return reader.blocks.length > 0 ? reader.blocks[0].block.blockId : null;
    const base = typeof blocksEl.offsetTop === "number" ? blocksEl.offsetTop : 0;
    const scrollTop = blocksEl.scrollTop;
    let first = null;
    for (const child of blocksEl.children) {
      if (!isElementNode(child) || child.dataset.blockId === undefined) continue;
      const blockId = child.dataset.blockId;
      if (first === null) first = blockId;
      const top = (typeof child.offsetTop === "number" ? child.offsetTop : 0) - base;
      const height = typeof child.offsetHeight === "number" ? child.offsetHeight : 0;
      if (top + height > scrollTop + 1) return blockId ?? first;
    }
    return first;
  }


  /* ------------------------------ D4-2 版本切换 / 刷新 / 关闭 ------------------------------ */

  /**
   * 显式切换版本（非破坏性：旧版本经版本链随时可切回、保持可读；切换只是
   * 阅读面换版本——本分支无锚点可迁移，D4-3 的锚点解析由服务端按各自
      versionId 判定 stale，前端绝不“迁移”到相似文字，charter §3.1）。切换
      前先把旧版本当前位置落库（服务端行随当前阅读状态整体替换）。
   */
  async function switchMaterialVersion(versionId) {
    const reader = deps.state.materialReader;
    if (reader === null || versionId === reader.versionId) return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    saveMaterialReadingPositionNow();
    const epoch = ++materialReaderEpoch;
    deps.state.materialSelection = null;
    reader.versionId = versionId;
    reader.blocks = [];
    reader.nextAfterBlock = null;
    reader.textUnits = 0;
    reader.firstPageState = "loading";
    reader.firstPageError = null;
    reader.appendState = "idle";
    reader.appendError = null;
    reader.fenceOpen = false;
    reader.trimmedBlocks = 0;
    reader.restoredToBlockId = null;
    reader.lastSavedBlockId = null;
    reader.searchJump = null; /* D4-4：显式切版本即离开搜索跳转目标——跳转注记随之失效（不跨版本移用） */
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl !== null) blocksEl.replaceChildren(); /* 版本内容整体换（元素容器保留） */
    deps.renderMaterialReader();
    await loadMaterialFirstPage(reader, { epoch, treeId });
  }


  /** 刷新材料详情（pending/parsing 状态的显式刷新入口）。 */
  async function refreshMaterialDetail() {
    const reader = deps.state.materialReader;
    const treeId = deps.state.currentTreeId;
    if (reader === null || treeId === null) return;
    const epoch = ++materialReaderEpoch;
    try {
      const detail = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}`,
      );
      if (
        epoch !== materialReaderEpoch ||
        deps.state.materialReader === null ||
        deps.state.materialReader.materialId !== reader.materialId ||
        deps.state.currentTreeId !== treeId
      ) {
        return;
      }
      const current = deps.state.materialReader;
      current.material = detail.material;
      current.versions = detail.versions;
      current.readingPosition = detail.readingPosition ?? null;
      if (!detail.versions.some((candidate) => candidate.id === current.versionId)) {
        /* 当前版本已不在版本链（极端）：按选择规则重选并整体重载。 */
        const chosen = chooseMaterialVersion(detail);
        current.versionId = chosen === null ? "" : chosen.id;
        current.blocks = [];
        current.fenceOpen = false;
        current.trimmedBlocks = 0;
        const blocksEl = deps.document.getElementById("mat-blocks");
        if (blocksEl !== null) blocksEl.replaceChildren();
        deps.renderMaterialReader();
        await loadMaterialFirstPage(current, { epoch, treeId });
        return;
      }
      deps.renderMaterialReader();
      /* 刷新后当前版本变为 ready（解析完成）：补载正文（markdown 块 / PDF
         页框——两种 ready 块型都取块）。 */
      const version = current.versions.find((candidate) => candidate.id === current.versionId) ?? null;
      if (
        version !== null &&
        version.parseStatus === "ready" &&
        current.blocks.length === 0 &&
        current.firstPageState === "loaded"
      ) {
        await loadMaterialFirstPage(current, { epoch, treeId });
      }
    } catch (err) {
      deps.showError(`refreshing the material failed — ${String(err && err.message ? err.message : err)}`);
    }
  }


  /** 关闭阅读器：位置落库（尽力）→ 状态清空 → 退出动效 → 焦点还原（W2
      键盘焦点纪律：还原到材料列表里的触发按钮）。退出动画窗口内块容器
      必须清空——退出中再次打开另一份材料时，绝不能移用上一份的块元素。 */
  function closeMaterialReader() {
    if (deps.state.materialReader === null) return;
    const closingReader = deps.state.materialReader;
    for (const task of closingReader.pdfRenderTasks.values()) task.cancel?.();
    closingReader.pdfRenderTasks.clear();
    void closingReader.pdfDocument?.destroy?.();
    saveMaterialReadingPositionNow();
    deps.state.materialReader = null;
    deps.state.materialSelection = null;
    materialReaderEpoch += 1; /* 作废在途 detail/分页响应 */
    deps.materialReaderView.materialPendingUpdate = false;
    deps.materialSelectionController.materialBarPendingUpdate = false;
    if (materialPositionTimer !== null) {
      deps.window.clearTimeout(materialPositionTimer);
      materialPositionTimer = null;
    }
    deps.hideMaterialReader();
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl !== null) blocksEl.replaceChildren();
    deps.renderMaterialsSection(); /* 列表 active 态回落（注册表先重建，再还原焦点） */
    const ref = materialReaderFocusReturn;
    materialReaderFocusReturn = null;
    deps.restoreFocusRef(ref);
  }

  return {
    get materialReaderEpoch() { return materialReaderEpoch; },
    set materialReaderEpoch(value) { materialReaderEpoch = value; },
    get materialPositionTimer() { return materialPositionTimer; },
    set materialPositionTimer(value) { materialPositionTimer = value; },
    get materialReaderFocusReturn() { return materialReaderFocusReturn; },
    set materialReaderFocusReturn(value) { materialReaderFocusReturn = value; },
    saveMaterialReadingPositionNow,
    materialReaderIsPdf,
    openMaterial,
    closeMaterialReader,
    switchMaterialVersion,
    refreshMaterialDetail,
    scheduleMaterialPositionSave,
    maybeLoadMoreMaterialBlocks,
    loadMoreMaterialBlocks,
  };
}
