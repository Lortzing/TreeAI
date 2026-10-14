/** Browser-local material intent identities and origin/Return snapshot caches; durable facts remain server-owned. Instance-owned state and dependencies. */

export function createMaterialIntentStore(deps) {


  /** 选区身份（与 sameMaterialSelectionIdentity 同维度：材料×版本×块×区间）。 */
  function materialSelectionIdentity(selection) {
    return `${selection.materialId}:${selection.versionId}:${selection.blockId}:${String(selection.start)}-${String(selection.end)}`;
  }


  const MATERIAL_INTENT_PREFIX = "treeai-material-intent:";

  const MATERIAL_BRANCH_ORIGIN_PREFIX = "treeai-material-branch:";

  const MATERIAL_RETURN_CARD_PREFIX = "treeai-material-return-card:";


  /**
   * 挂起的建枝意图（intentKey + 未落库的首问草稿）：一次逻辑提交跨页面刷新
   * /重启稳定（同键重放同枝、同键同问不重发——服务端原子绑定与对账兜底）。
   * 首问落库（dispatch succeeded）即清除；显式另开时以新键覆盖。
   */
  function materialIntentStorageKey(treeId, identity) {
    return `${MATERIAL_INTENT_PREFIX}${treeId}:${identity}`;
  }


  function readPendingMaterialIntent(treeId, identity) {
    try {
      const raw = deps.window.localStorage.getItem(materialIntentStorageKey(treeId, identity));
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || typeof parsed.intentKey !== "string") return null;
      return parsed;
    } catch {
      return null; /* localStorage 不可用：会话内流程照常，刷新后走恢复对账（诚实降级） */
    }
  }


  function persistPendingMaterialIntent(treeId, identity, intentKey, firstQuestion) {
    try {
      deps.window.localStorage.setItem(
        materialIntentStorageKey(treeId, identity),
        JSON.stringify({ intentKey, firstQuestion }),
      );
    } catch {
      /* 同上：持久化尽力而为 */
    }
  }


  function clearPendingMaterialIntent(treeId, identity) {
    try {
      deps.window.localStorage.removeItem(materialIntentStorageKey(treeId, identity));
    } catch {
      /* 同上 */
    }
  }


  /** 材料 Branch 的来源上下文缓存（会话 Map + localStorage 双写）：面板头部
   *  来源呈现与「⌖ View source」原文跳转的数据面（树态不含 turn origin——
   *  材料来源只在 material_branch_origins，HTTP 面无读取端点，客户端从建枝/
   *  恢复响应缓存）。缓存缺失时如实注明，绝不伪造来源细节。 */
  const materialBranchOriginCache = new Map();


  function rememberMaterialBranchOrigin(treeId, branchId, originData) {
    const key = `${treeId}:${branchId}`;
    materialBranchOriginCache.set(key, originData);
    try {
      deps.window.localStorage.setItem(`${MATERIAL_BRANCH_ORIGIN_PREFIX}${key}`, JSON.stringify(originData));
    } catch {
      /* 会话内缓存仍有效 */
    }
  }


  function recallMaterialBranchOrigin(treeId, branchId) {
    const key = `${treeId}:${branchId}`;
    const cached = materialBranchOriginCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const raw = deps.window.localStorage.getItem(`${MATERIAL_BRANCH_ORIGIN_PREFIX}${key}`);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return null;
      materialBranchOriginCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }


  /** 材料 Return 的来源卡缓存（提交响应的 card；主线卡渲染的数据面——树态
   *  实时携带采用记录，材料身份字段从缓存读取，缺失时如实注明）。 */
  const materialReturnCardCache = new Map();


  function rememberMaterialReturnCard(treeId, turnId, card) {
    const key = `${treeId}:${turnId}`;
    materialReturnCardCache.set(key, card);
    try {
      deps.window.localStorage.setItem(`${MATERIAL_RETURN_CARD_PREFIX}${key}`, JSON.stringify(card));
    } catch {
      /* 会话内缓存仍有效 */
    }
  }


  function recallMaterialReturnCard(treeId, turnId) {
    const key = `${treeId}:${turnId}`;
    const cached = materialReturnCardCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const raw = deps.window.localStorage.getItem(`${MATERIAL_RETURN_CARD_PREFIX}${key}`);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return null;
      materialReturnCardCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  return {
    recallMaterialBranchOrigin,
    rememberMaterialReturnCard,
    materialSelectionIdentity,
    readPendingMaterialIntent,
    rememberMaterialBranchOrigin,
    persistPendingMaterialIntent,
    clearPendingMaterialIntent,
    recallMaterialReturnCard,
  };
}
