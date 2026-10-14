/** Saved-fact search requests, stable-target validation and cross-tree source navigation. Instance-owned state and dependencies. */
import { SEARCH_KIND_LABELS } from "../views/search.js";

export function createSearchController(deps) {


  /* ------------------------------ D4-4 找回既有思考 · 搜索（issue #8 工作包 D4-4） ------------------------------ */

  /** 搜索请求世代号（P1 同族纪律）：新搜索/树切换（清空当前树范围结果时）
      递增——迟到的旧响应整包丢弃，绝不覆盖新状态。 */
  let searchEpoch = 0;


  /** 实际生效的检索范围：用户选「当前树」且确有树打开 → tree；否则（含无树
      打开的回落）→ all（charter §5 默认当前树、可切全部树；「当前树」开关在
      无树时如实禁用，范围不悬空）。 */
  function effectiveSearchScope() {
    return deps.state.search.scope === "tree" && deps.state.currentTreeId !== null ? "tree" : "all";
  }


  /**
   * 执行搜索（POST /api/trees/:id/search | /api/search——已落地的检索端点；
   * kinds 按用户筛选透传服务端过滤）。空查询/空筛选在客户端按服务端同一规
   * 则拦下（服务端 parseSearchQuery 会 400）——如实提示，不发注定失败的请
   * 求；响应按世代丢弃（新搜索/树切换取代）。零命中如实空列表（服务端不
   * 编造，本面同样绝不编造）；hits 缺失视为坏响应（fail-closed，不伪装空）。
   */
  async function runSearch() {
    const input = deps.$("search-input");
    const text = input.value;
    deps.state.search.note = null;
    if (text.trim() === "") {
      deps.state.search.note = "type something to search — blank queries are rejected (they would match nothing)";
      deps.renderSearchSection();
      return;
    }
    const kinds = [...deps.state.search.kinds];
    if (kinds.length === 0) {
      deps.state.search.note = "select at least one source type (材料 / 批注 / Return / 对话) — an empty filter would match nothing";
      deps.renderSearchSection();
      return;
    }
    const scopeTreeId = effectiveSearchScope() === "tree" ? deps.state.currentTreeId : null;
    const epoch = ++searchEpoch;
    deps.state.search.phase = "loading";
    deps.state.search.error = null;
    deps.state.search.resultQuery = text;
    deps.state.search.resultScope = scopeTreeId === null ? "all" : "tree";
    deps.state.search.resultTreeId = scopeTreeId;
    deps.renderSearchSection();
    try {
      const path =
        scopeTreeId === null ? "/api/search" : `/api/trees/${encodeURIComponent(scopeTreeId)}/search`;
      const payload = await deps.api(path, "POST", { text, kinds });
      if (epoch !== searchEpoch) return; /* 迟到丢弃：已被更新的搜索/树切换取代 */
      if (payload === null || !Array.isArray(payload.hits)) {
        throw new Error("malformed search response (no hits array)");
      }
      deps.state.search.phase = "loaded";
      deps.state.search.hits = payload.hits;
    } catch (err) {
      if (epoch !== searchEpoch) return;
      deps.state.search.phase = "failed";
      deps.state.search.error = String(err && err.message ? err.message : err);
    }
    deps.renderSearchSection();
  }


  /* ---------------- 命中 → 事实的客户端定位（稳定 target 身份） ---------------- */

  /** 对话/Return 命中 → 已加载树态中的 turn（由服务端 target 精确指向）。 */
  function locateTurnHit(hit) {
    const st = deps.state.treeState;
    const target = hit.target;
    if (
      st === null ||
      hit.treeId !== deps.state.currentTreeId ||
      target === null ||
      typeof target !== "object" ||
      (target.kind !== "turn" && target.kind !== "return") ||
      target.treeId !== hit.treeId
    ) {
      return null;
    }
    const located = findTurnById(target.turnId);
    if (located === null || located.view.branch.id !== target.branchId) return null;
    if (target.kind === "return" && located.turn.role !== "return") return null;
    if (target.kind === "turn" && located.turn.role === "return") return null;
    return located;
  }


  /** 批注命中 → 已保存术语批注（由服务端 target 精确指向）。 */
  function locateAnnotationHit(hit) {
    const terminology = deps.state.terminology;
    const target = hit.target;
    if (
      deps.state.treeState === null ||
      hit.treeId !== deps.state.currentTreeId ||
      terminology === null ||
      !terminology.ok ||
      target === null ||
      typeof target !== "object" ||
      target.kind !== "annotation" ||
      target.treeId !== hit.treeId
    ) {
      return null;
    }
    const annotation = terminology.annotations.find(
      (candidate) => candidate.id === target.annotationId,
    );
    return annotation === undefined ? null : { annotation };
  }


  /** 树态中按 id 找 turn（含其分支视图）。 */
  function findTurnById(turnId) {
    const st = deps.state.treeState;
    if (st === null) return null;
    for (const view of st.branches) {
      const turn = view.turns.find((candidate) => candidate.id === turnId);
      if (turn !== undefined) return { view, turn };
    }
    return null;
  }


  /* ---------------- 命中跳转（charter §5「结果跳转后可继续原探索」） ---------------- */

  /**
   * 点击命中 → 打开其来源的既有视图。跨树命中（全部树范围检索）先开命中树
   * （既有 openTree 语义：树态/材料/术语读模型随之就绪），再在树内定位。
   * 搜索/跳转纯只读：不创建 Turn（charter §3.3「浏览/搜索不创建 Turn」），
   * 材料命中不开支线面板、不 POST /switch（阅读与探索互不干扰，D4-2 同
   * 纪律）；对话/批注命中落支线时走既有面板打开语义（switch 对齐游标）。
   */
  async function jumpToSearchHit(hit) {
    deps.state.search.note = null;
    const trigger = { kind: "search-hit", hitKey: deps.searchHitKey(hit) };
    if (hit.treeId !== deps.state.currentTreeId) {
      await deps.openTree(hit.treeId);
    }
    if (hit.kind === "material") {
      const target = hit.target;
      if (
        target === null ||
        typeof target !== "object" ||
        target.kind !== "material" ||
        target.treeId !== hit.treeId ||
        typeof target.materialId !== "string" ||
        target.materialId === ""
      ) {
        deps.state.search.note = "malformed material hit (no stable material target) — cannot jump";
        deps.renderSearchSection();
        return;
      }
      await deps.openMaterial(target.materialId, {
        trigger,
        versionId: target.versionId,
        focusBlockId: target.blockId,
      });
      return;
    }
    if (hit.kind === "annotation") {
      await jumpToAnnotationHit(hit, trigger);
      return;
    }
    await jumpToTurnFactHit(hit, trigger);
  }


  /**
   * 批注命中 → 锚定答案的既有视图 + 已保存批注卡（openSavedAnnotationCard）。
   * 锚定答案缺失/漂移 → 来源抽屉 Terminology 节（保存快照照常可读的既有
   * 视图，状态如实标注——不伪造正文定位）。术语读模型未载时先拉取（跳转
   * 面的事实依据，失败如实落入「无法定位」分支）。
   */
  async function jumpToAnnotationHit(hit, trigger) {
    if (deps.state.terminology === null || !deps.state.terminology.ok) {
      try {
        await deps.refreshTerminology();
      } catch {
        /* 拉取失败：locateAnnotationHit 读不到事实——落入「无法定位」分支 */
      }
    }
    const located = locateAnnotationHit(hit);
    if (located === null) {
      deps.state.search.note =
        "the annotation could not be located in this tree's current facts — it may have changed since the search";
      deps.renderSearchSection();
      return;
    }
    const { annotation } = located;
    const anchored = findTurnById(annotation.anchorTurnId);
    if (anchored === null) {
      await deps.openDrawer({ trigger });
      deps.state.search.note =
        "the annotation's anchored answer is no longer in this tree — its saved snapshot is in Sources → Terminology";
      deps.renderSearchSection();
      return;
    }
    const branchId = anchored.view.branch.id;
    if (branchId !== deps.trunkBranchId()) {
      await deps.openBranchPanel(branchId, { trigger, focus: "anchor" });
    }
    deps.revealAnchorTurn(anchored.turn.id);
    deps.openSavedAnnotationCard(annotation, branchId, anchored.turn);
  }


  /**
   * 对话 / Return 命中 → 该 turn 的既有视图：主线事实直接定位（主阅读面恒
      为 Trunk——Return 卡与主线 turn 都在 #conversation）；支线事实先开
      支线面板（既有 switch 语义）再定位（滚动 + 焦点，W2 §2.6 同款）。
   */
  async function jumpToTurnFactHit(hit, trigger) {
    const located = locateTurnHit(hit);
    if (located === null) {
      deps.state.search.note = `the ${SEARCH_KIND_LABELS[hit.kind]} hit could not be located in this tree's current facts — it may have changed since the search`;
      deps.renderSearchSection();
      return;
    }
    const { view, turn } = located;
    if (view.branch.id !== deps.trunkBranchId()) {
      await deps.openBranchPanel(view.branch.id, { trigger, focus: "anchor" });
    }
    deps.revealAnchorTurn(turn.id);
  }

  return {
    get searchEpoch() { return searchEpoch; },
    set searchEpoch(value) { searchEpoch = value; },
    jumpToSearchHit,
    locateAnnotationHit,
    locateTurnHit,
    runSearch,
  };
}
