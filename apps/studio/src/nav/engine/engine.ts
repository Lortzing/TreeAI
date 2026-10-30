/** engine ownership for nav-engine.ts; compatibility entrypoint remains one level above. */
import {
  decodeCursor,
  encodeCursor,
} from "./cursor.ts";
import {
  NavEngineError,
} from "./errors.ts";
import type {
  NavAncestor,
  NavBranchSearchHit,
  NavBranchSearchPage,
  NavChildrenPage,
  NavEngineOptions,
  NavIndexEntry,
  NavLocation,
  NavNodeView,
  NavOriginView,
  NavSearchMode,
  NavSubtreePage,
  NavTreeOverview,
  NavTreeSearchHit,
  NavTreeSearchPage,
  NavTreesPage,
  NavTreeSummary,
  TreeIndex,
} from "./model.ts";
import {
  NAV_CHILDREN_DEFAULT_LIMIT,
  NAV_CHILDREN_MAX_LIMIT,
  NAV_SEARCH_DEFAULT_LIMIT,
  NAV_SEARCH_MAX_LIMIT,
  NAV_SUBTREE_DEFAULT_LIMIT,
  NAV_SUBTREE_MAX_DEPTH,
  NAV_SUBTREE_MAX_LIMIT,
  NAV_TREES_DEFAULT_LIMIT,
  NAV_TREES_MAX_LIMIT,
} from "./policy.ts";
import {
  assertLimit,
  assertMode,
  fold,
  matchByMode,
} from "./validation.ts";
import type {
  BranchId,
  TreeId,
} from "@treeai/contracts";
import type {
  MaterialRepository,
  TreeRepository,
} from "@treeai/persistence";

export class TreeNavEngine {
  readonly #repository: TreeRepository;
  readonly #materialRepository: MaterialRepository;
  readonly #indexes = new Map<string, TreeIndex>();
  readonly #indexVersions = new Map<string, number>();
  #treeSummaries: { readonly trees: readonly NavTreeSummary[]; readonly version: number } | null = null;
  #treeSummariesVersion = 0;

  constructor(options: NavEngineOptions) {
    this.#repository = options.repository;
    this.#materialRepository = options.materialRepository;
  }

  /* ------------------------------ 索引 ------------------------------ */

  #indexFor(treeId: string): TreeIndex {
    const cached = this.#indexes.get(treeId);
    if (cached !== undefined) return cached;
    const built = this.#buildIndex(treeId);
    this.#indexes.set(treeId, built);
    return built;
  }

  #buildIndex(treeId: string): TreeIndex {
    const tree = this.#repository.findTree(treeId as TreeId);
    if (tree === null) {
      throw new NavEngineError("unknown-tree", `unknown tree '${treeId}'`);
    }
    const branches = this.#repository.listBranches(treeId as TreeId);
    const entries = new Map<string, NavIndexEntry>();
    const pendingChildren = new Map<string, string[]>();
    const order: string[] = [];
    let maxDepth = 0;
    let treeTitle: string | null = null;
    // 第一遍：深度/父路径（listBranches 序 = 创建序，父先于子）。
    for (const branch of branches) {
      let depth: number;
      let parentPath: readonly string[];
      if (branch.parentBranchId === null) {
        depth = 0;
        parentPath = [];
      } else {
        const parent = entries.get(branch.parentBranchId);
        if (parent === undefined) {
          throw new NavEngineError(
            "data-integrity",
            `tree ${treeId}: branch ${branch.id} references parent ${branch.parentBranchId} that precedes it (data integrity)`,
          );
        }
        depth = parent.depth + 1;
        parentPath = [...parent.parentPath, parent.branch.id];
        const siblings = pendingChildren.get(branch.parentBranchId);
        if (siblings === undefined) {
          pendingChildren.set(branch.parentBranchId, [branch.id]);
        } else {
          siblings.push(branch.id);
        }
      }
      const title = this.#firstUserTurnTitle(branch.id);
      if (branch.parentBranchId === null && treeTitle === null) {
        treeTitle = title;
      }
      if (depth > maxDepth) maxDepth = depth;
      entries.set(branch.id, {
        branch,
        depth,
        childIds: [],
        parentPath,
        title,
      });
      order.push(branch.id);
    }
    // 第二遍：挂接子序（保持 listBranches 序）。
    for (const [parentId, childIds] of pendingChildren) {
      const parent = entries.get(parentId);
      if (parent === undefined) continue; // 不可达（子先引用父必已入表）
      parent.childIds = childIds;
    }
    const trunk = branches.find((branch) => branch.parentBranchId === null) ?? null;
    if (trunk === null) {
      throw new NavEngineError("data-integrity", `tree ${treeId} has no trunk branch (data integrity)`);
    }
    const version = (this.#indexVersions.get(treeId) ?? 0) + 1;
    this.#indexVersions.set(treeId, version);
    return {
      treeId,
      trunkBranchId: trunk.id,
      order,
      entries,
      treeTitle,
      maxDepth,
      version,
    };
  }

  /** 该分支首个 user Turn 的文本（标题；无 user Turn → null）。 */
  #firstUserTurnTitle(branchId: string): string | null {
    const turns = this.#repository.listTurns(branchId as BranchId);
    for (const turn of turns) {
      if (turn.role === "user") return turn.text.replace(/^附件：(?:\[[^\]\n]+\]\(\/api\/trees\/[^/()]+\/materials\/[^/()]+\/versions\/[^/()]+\/file\)（[^）]+）)(?:、\[[^\]\n]+\]\(\/api\/trees\/[^/()]+\/materials\/[^/()]+\/versions\/[^/()]+\/file\)（[^）]+）)*\n\n/, "");
    }
    return null;
  }

  /** 显式失效某树的读索引（写入方在改动该树后调用；游标随版本过期）。 */
  invalidate(treeId: string): void {
    if (this.#indexes.delete(treeId)) {
      this.#indexVersions.set(treeId, (this.#indexVersions.get(treeId) ?? 0) + 1);
    }
    if (this.#treeSummaries !== null) {
      this.#treeSummariesVersion += 1;
      this.#treeSummaries = null;
    }
  }

  /* ------------------------------ 节点视图 ------------------------------ */

  #nodeView(index: TreeIndex, entry: NavIndexEntry): NavNodeView {
    return {
      id: entry.branch.id,
      treeId: index.treeId,
      parentBranchId: entry.branch.parentBranchId,
      depth: entry.depth,
      title: entry.title,
      originKind: this.#materialRepository.getBranchOriginKind(entry.branch.id as BranchId),
      childCount: entry.childIds.length,
      createdAt: entry.branch.createdAt,
    };
  }

  #entryFor(index: TreeIndex, branchId: string): NavIndexEntry {
    const entry = index.entries.get(branchId);
    if (entry === undefined) {
      throw new NavEngineError("unknown-branch", `unknown branch '${branchId}' in tree '${index.treeId}'`);
    }
    return entry;
  }

  #cursorOffset(cursor: string | undefined, index: TreeIndex): number {
    if (cursor === undefined) return 0;
    const payload = decodeCursor(cursor);
    if (payload.v !== index.version) {
      throw new NavEngineError(
        "stale-cursor",
        `stale cursor (built for index version ${String(payload.v)}, current ${String(index.version)}); ` +
          "restart pagination from the first page after invalidation",
      );
    }
    return payload.o;
  }

  /* ------------------------------ 子节点分页 ------------------------------ */

  /**
   * 子节点分页列表（按需加载的核心查询）。页序 = (created_at, rowid) = 创建序；
   * 同一索引版本内翻完全部页无重复、无空洞；nextCursor === null 即末页。
   */
  listChildren(
    treeId: string,
    parentBranchId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): NavChildrenPage {
    const limit = assertLimit(options.limit, NAV_CHILDREN_MAX_LIMIT, "children limit", NAV_CHILDREN_DEFAULT_LIMIT);
    const index = this.#indexFor(treeId);
    const entry = this.#entryFor(index, parentBranchId);
    const offset = this.#cursorOffset(options.cursor, index);
    const total = entry.childIds.length;
    if (offset > total) {
      // 过期之外的情形：游标指向的位置已超出当前子序末端——诚实空页。
      return {
        treeId,
        parentBranchId,
        nodes: [],
        nextCursor: null,
        totalChildren: total,
      };
    }
    const slice = entry.childIds.slice(offset, offset + limit);
    const nodes = slice.map((childId) => this.#nodeView(index, index.entries.get(childId)!));
    return {
      treeId,
      parentBranchId,
      nodes,
      nextCursor: offset + limit < total ? encodeCursor(index.version, offset + limit) : null,
      totalChildren: total,
    };
  }

  /* ------------------------------ 子树展开 ------------------------------ */

  /**
   * 深度受限子树展开（BFS，含 root 自身；节点上限 + 游标续页）。
   * maxDepth 是相对 root 的层数（0 = 仅 root 自身）。
   */
  expandSubtree(
    treeId: string,
    rootBranchId: string,
    options: {
      readonly maxDepth?: number;
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): NavSubtreePage {
    const limit = assertLimit(options.limit, NAV_SUBTREE_MAX_LIMIT, "subtree limit", NAV_SUBTREE_DEFAULT_LIMIT);
    const maxDepth = options.maxDepth ?? 2;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > NAV_SUBTREE_MAX_DEPTH) {
      throw new NavEngineError(
        "invalid-argument",
        `subtree maxDepth must be an integer between 0 and ${String(NAV_SUBTREE_MAX_DEPTH)} (got ${String(maxDepth)})`,
      );
    }
    const index = this.#indexFor(treeId);
    const root = this.#entryFor(index, rootBranchId);
    // BFS（显式队列，无递归）：深度受限子树的确定性全序。
    const bfs: NavIndexEntry[] = [];
    const queue: Array<{ entry: NavIndexEntry; relDepth: number }> = [{ entry: root, relDepth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      bfs.push(item.entry);
      if (item.relDepth >= maxDepth) continue;
      for (const childId of item.entry.childIds) {
        queue.push({ entry: index.entries.get(childId)!, relDepth: item.relDepth + 1 });
      }
    }
    const offset = this.#cursorOffset(options.cursor, index);
    const total = bfs.length;
    if (offset > total) {
      return {
        treeId,
        rootBranchId,
        nodes: [],
        maxDepth,
        totalNodes: total,
        truncated: false,
        nextCursor: null,
      };
    }
    const slice = bfs.slice(offset, offset + limit);
    return {
      treeId,
      rootBranchId,
      nodes: slice.map((entry) => this.#nodeView(index, entry)),
      maxDepth,
      totalNodes: total,
      truncated: offset + slice.length < total,
      nextCursor: offset + limit < total ? encodeCursor(index.version, offset + limit) : null,
    };
  }

  /* ------------------------------ 父路径（迭代） ------------------------------ */

  /** 根→父 的祖先链（不含本节点）；迭代上溯，深链不递归。 */
  parentPath(treeId: string, branchId: string): readonly NavAncestor[] {
    const index = this.#indexFor(treeId);
    const entry = this.#entryFor(index, branchId);
    const ancestors: NavAncestor[] = [];
    // 沿 parentPath 直接展开（索引已存祖先 id 链）——O(depth)，无递归。
    for (const ancestorId of entry.parentPath) {
      const ancestor = index.entries.get(ancestorId)!;
      ancestors.push({ id: ancestor.branch.id, title: ancestor.title, depth: ancestor.depth });
    }
    return ancestors;
  }

  /** 根→本节点 的完整路径（含本节点）。 */
  fullPath(treeId: string, branchId: string): readonly NavAncestor[] {
    const index = this.#indexFor(treeId);
    const entry = this.#entryFor(index, branchId);
    return [
      ...this.parentPath(treeId, branchId),
      { id: entry.branch.id, title: entry.title, depth: entry.depth },
    ];
  }

  /* ------------------------------ 定位 ------------------------------ */

  /** 按分支 id 跨树定位（树、祖先链、兄弟位次、来源）。 */
  locateBranch(branchId: string): NavLocation {
    const branch = this.#repository.findBranch(branchId as BranchId);
    if (branch === null) {
      throw new NavEngineError("unknown-branch", `unknown branch '${branchId}'`);
    }
    const index = this.#indexFor(branch.treeId);
    const entry = this.#entryFor(index, branchId);
    const ancestors = this.parentPath(index.treeId, branchId);
    let siblingPosition: { index: number; total: number } | null = null;
    if (branch.parentBranchId !== null) {
      const parent = index.entries.get(branch.parentBranchId)!;
      siblingPosition = {
        index: parent.childIds.indexOf(branchId),
        total: parent.childIds.length,
      };
    }
    return {
      treeId: index.treeId,
      treeTitle: index.treeTitle,
      node: this.#nodeView(index, entry),
      ancestors,
      path: [...ancestors, { id: entry.branch.id, title: entry.title, depth: entry.depth }],
      siblingPosition,
      origin: this.#originView(branchId),
    };
  }

  #originView(branchId: string): NavOriginView | null {
    const ref = this.#materialRepository.getBranchOrigin(branchId as BranchId);
    if (ref === null) return null;
    if (ref.kind === "turn") {
      return {
        kind: "turn",
        sourceBranchId: ref.origin.sourceBranchId,
        anchorTurnId: ref.origin.anchorTurnId,
        anchorEntryId: ref.origin.anchorEntryId,
        selection: {
          start: ref.origin.selection.start,
          end: ref.origin.selection.end,
          text: ref.origin.selection.text,
        },
      };
    }
    return {
      kind: "material",
      materialId: ref.origin.selection.materialId,
      versionId: ref.origin.selection.versionId,
      blockId: ref.origin.selection.blockId,
      start: ref.origin.selection.start,
      end: ref.origin.selection.end,
      excerpt: ref.origin.selection.excerpt,
      sourceHash: ref.origin.selection.sourceHash,
    };
  }

  /* ------------------------------ 树列表 / 树概览 ------------------------------ */

  #treeSummaryList(): readonly NavTreeSummary[] {
    if (this.#treeSummaries !== null) return this.#treeSummaries.trees;
    const forests = this.#repository.listForests();
    const trees: NavTreeSummary[] = [];
    for (const forest of forests) {
      for (const tree of this.#repository.listTrees(forest.id)) {
        const trunk = this.#repository
          .listBranches(tree.id)
          .find((branch) => branch.parentBranchId === null) ?? null;
        trees.push({
          treeId: tree.id,
          forestId: tree.forestId,
          createdAt: tree.createdAt,
          title: trunk === null ? null : this.#firstUserTurnTitle(trunk.id),
          trunkBranchId: trunk === null ? "" : trunk.id,
        });
      }
    }
    this.#treeSummaries = { trees, version: this.#treeSummariesVersion };
    return trees;
  }

  /** Forest/Tree 查找：分页树列表（森林序 → 树序；树标题=trunk 首问）。 */
  listTrees(options: { readonly cursor?: string; readonly limit?: number } = {}): NavTreesPage {
    const limit = assertLimit(options.limit, NAV_TREES_MAX_LIMIT, "trees limit", NAV_TREES_DEFAULT_LIMIT);
    const trees = this.#treeSummaryList();
    let offset = 0;
    if (options.cursor !== undefined) {
      const payload = decodeCursor(options.cursor);
      if (payload.v !== this.#treeSummariesVersion) {
        throw new NavEngineError(
          "stale-cursor",
          `stale cursor (built for summary version ${String(payload.v)}, current ${String(this.#treeSummariesVersion)}); ` +
            "restart pagination from the first page",
        );
      }
      offset = payload.o;
    }
    const total = trees.length;
    if (offset > total) {
      return { trees: [], nextCursor: null, totalTrees: total };
    }
    const slice = trees.slice(offset, offset + limit);
    return {
      trees: slice,
      nextCursor: offset + limit < total ? encodeCursor(this.#treeSummariesVersion, offset + limit) : null,
      totalTrees: total,
    };
  }

  /** 单树概览（节点数/最大深度需构建该树索引）。 */
  getTreeOverview(treeId: string): NavTreeOverview {
    const tree = this.#repository.findTree(treeId as TreeId);
    if (tree === null) {
      throw new NavEngineError("unknown-tree", `unknown tree '${treeId}'`);
    }
    const index = this.#indexFor(treeId);
    return {
      treeId: index.treeId,
      forestId: tree.forestId,
      createdAt: tree.createdAt,
      title: index.treeTitle,
      trunkBranchId: index.trunkBranchId,
      nodeCount: index.order.length,
      maxDepth: index.maxDepth,
    };
  }

  /* ------------------------------ 标题搜索 ------------------------------ */

  /** 按标题/树标识搜索树（树标题 = trunk 首个 user Turn）。 */
  searchTrees(text: string, options: { readonly mode?: NavSearchMode; readonly limit?: number } = {}): readonly NavTreeSearchHit[] {
    const mode = assertMode(options.mode);
    const limit = assertLimit(options.limit, NAV_SEARCH_MAX_LIMIT, "search limit", NAV_SEARCH_DEFAULT_LIMIT);
    const query = typeof text === "string" ? text.trim() : "";
    if (query.length === 0) return [];
    const needle = fold(query);
    const hits: NavTreeSearchHit[] = [];
    for (const tree of this.#treeSummaryList()) {
      const titleMatch = tree.title !== null && matchByMode(fold(tree.title), needle, mode);
      const idMatch = !titleMatch && matchByMode(fold(tree.treeId), needle, mode);
      if (!titleMatch && !idMatch) continue;
      hits.push({
        treeId: tree.treeId,
        forestId: tree.forestId,
        title: tree.title,
        matchedOn: titleMatch ? "title" : "id",
        createdAt: tree.createdAt,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * 按标题/分支标识搜索 Branch。命中携带 treeId + 完整路径（标题+id），
   * 同名节点可被调用方按路径消歧——引擎绝不返回无身份的「最近匹配」。
   * 结果序（确定性全序）：森林序 → 树创建序 → 分支 (created_at, rowid)
   * ——与树/分支的产品追加序一致，同输入恒同输出。
   */
  searchBranches(
    text: string,
    options: {
      readonly mode?: NavSearchMode;
      readonly treeId?: string | null;
      readonly limit?: number;
    } = {},
  ): readonly NavBranchSearchHit[] {
    const mode = assertMode(options.mode);
    const limit = assertLimit(options.limit, NAV_SEARCH_MAX_LIMIT, "search limit", NAV_SEARCH_DEFAULT_LIMIT);
    const query = typeof text === "string" ? text.trim() : "";
    if (query.length === 0) return [];
    const needle = fold(query);
    const scopeTreeIds: readonly string[] =
      options.treeId === undefined || options.treeId === null
        ? this.#treeSummaryList().map((tree) => tree.treeId)
        : [options.treeId];
    if (scopeTreeIds.length === 1) {
      const known = this.#repository.findTree(scopeTreeIds[0] as TreeId);
      if (known === null) throw new NavEngineError("unknown-tree", `unknown tree '${scopeTreeIds[0]}'`);
    }
    const hits: NavBranchSearchHit[] = [];
    for (const treeId of scopeTreeIds) {
      const index = this.#indexFor(treeId);
      for (const branchId of index.order) {
        const entry = index.entries.get(branchId)!;
        const titleMatch = entry.title !== null && matchByMode(fold(entry.title), needle, mode);
        const idMatch = !titleMatch && matchByMode(fold(entry.branch.id), needle, mode);
        if (!titleMatch && !idMatch) continue;
        hits.push({
          branchId: entry.branch.id,
          treeId: index.treeId,
          treeTitle: index.treeTitle,
          title: entry.title,
          matchedOn: titleMatch ? "title" : "id",
          depth: entry.depth,
          path: this.fullPath(index.treeId, entry.branch.id),
          originKind: this.#materialRepository.getBranchOriginKind(entry.branch.id as BranchId),
          createdAt: entry.branch.createdAt,
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /* ------------------------------ 搜索分页（HTTP 接线面） ------------------------------ */

  /** 树搜索页（确定性全序 + 偏移游标；nextCursor === null 即末页）。 */
  searchTreesPage(
    text: string,
    options: { readonly mode?: NavSearchMode; readonly limit?: number; readonly cursor?: string } = {},
  ): NavTreeSearchPage {
    const limit = assertLimit(options.limit, NAV_SEARCH_MAX_LIMIT, "search limit", NAV_SEARCH_DEFAULT_LIMIT);
    const mode = assertMode(options.mode);
    const query = typeof text === "string" ? text.trim() : "";
    if (query.length === 0) return { hits: [], nextCursor: null };
    const needle = fold(query);
    const offset = this.#searchCursorOffset(options.cursor);
    const hits: NavTreeSearchHit[] = [];
    let matched = 0;
    let more = false;
    for (const tree of this.#treeSummaryList()) {
      const titleMatch = tree.title !== null && matchByMode(fold(tree.title), needle, mode);
      const idMatch = !titleMatch && matchByMode(fold(tree.treeId), needle, mode);
      if (!titleMatch && !idMatch) continue;
      if (matched >= offset + limit) {
        more = true;
        break;
      }
      if (matched >= offset) {
        hits.push({
          treeId: tree.treeId,
          forestId: tree.forestId,
          title: tree.title,
          matchedOn: titleMatch ? "title" : "id",
          createdAt: tree.createdAt,
        });
      }
      matched += 1;
    }
    return { hits, nextCursor: more ? encodeCursor(this.#treeSummariesVersion, offset + limit) : null };
  }

  /**
   * Branch 搜索页（确定性全序 + 偏移游标）。命中与 searchBranches 同序
   * （森林序 → 树创建序 → 分支创建序）——同输入恒同输出，翻页无重复无
   * 空洞；游标携带全局摘要版本（任一树 invalidate 即过期，显式报错）。
   */
  searchBranchesPage(
    text: string,
    options: {
      readonly mode?: NavSearchMode;
      readonly treeId?: string | null;
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): NavBranchSearchPage {
    const limit = assertLimit(options.limit, NAV_SEARCH_MAX_LIMIT, "search limit", NAV_SEARCH_DEFAULT_LIMIT);
    const mode = assertMode(options.mode);
    const query = typeof text === "string" ? text.trim() : "";
    if (query.length === 0) return { hits: [], nextCursor: null };
    const needle = fold(query);
    const scopeTreeIds: readonly string[] =
      options.treeId === undefined || options.treeId === null
        ? this.#treeSummaryList().map((tree) => tree.treeId)
        : [options.treeId];
    if (scopeTreeIds.length === 1) {
      const known = this.#repository.findTree(scopeTreeIds[0] as TreeId);
      if (known === null) throw new NavEngineError("unknown-tree", `unknown tree '${scopeTreeIds[0]}'`);
    }
    const offset = this.#searchCursorOffset(options.cursor);
    const hits: NavBranchSearchHit[] = [];
    let matched = 0;
    let more = false;
    for (const treeId of scopeTreeIds) {
      const index = this.#indexFor(treeId);
      for (const branchId of index.order) {
        const entry = index.entries.get(branchId)!;
        const titleMatch = entry.title !== null && matchByMode(fold(entry.title), needle, mode);
        const idMatch = !titleMatch && matchByMode(fold(entry.branch.id), needle, mode);
        if (!titleMatch && !idMatch) continue;
        if (matched >= offset + limit) {
          more = true;
          break;
        }
        if (matched >= offset) {
          hits.push({
            branchId: entry.branch.id,
            treeId: index.treeId,
            treeTitle: index.treeTitle,
            title: entry.title,
            matchedOn: titleMatch ? "title" : "id",
            depth: entry.depth,
            path: this.fullPath(index.treeId, entry.branch.id),
            originKind: this.#materialRepository.getBranchOriginKind(entry.branch.id as BranchId),
            createdAt: entry.branch.createdAt,
          });
        }
        matched += 1;
      }
      if (more) break;
    }
    return { hits, nextCursor: more ? encodeCursor(this.#treeSummariesVersion, offset + limit) : null };
  }

  /**
   * 搜索游标偏移（携带全局摘要版本——任何 invalidate(treeId) 都会使全部
   * 搜索游标过期：宁可让调用方从头再查，也不在变了序的结果里静默跳页）。
   */
  #searchCursorOffset(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const payload = decodeCursor(cursor);
    if (payload.v !== this.#treeSummariesVersion) {
      throw new NavEngineError(
        "stale-cursor",
        `stale search cursor (built for summary version ${String(payload.v)}, current ${String(this.#treeSummariesVersion)}); ` +
          "restart search pagination from the first page",
      );
    }
    return payload.o;
  }
}
