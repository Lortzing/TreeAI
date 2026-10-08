/**
 * D4-4 找回既有思考 —— 搜索文档装配服务（issue #8 D4-4 接线面，契约 §3/§4）。
 *
 * 分三层：
 *  1. LocalSearchEngine（./search-engine.ts）：纯检索内核（零 IO、零依赖）；
 *  2. buildSearchDocuments(snapshot)（本文件）：把「已保存产品事实」的规范
 *     快照装配成 SearchDocument[] —— **纯函数**，HTTP 端点与 verify:d4 的
 *     b4-cross-material-find 检查共用同一代码路径（B4 冻结集裁决的因此是
 *     产品装配语义本身，不是测试专用副本）；
 *  3. SearchService（本文件）：仓储读取面 —— 从 TreeRepository +
 *     MaterialRepository 枚举快照（材料版本 × tree_material_links、术语
 *     批注、Return、Turn），每请求重建索引后检索。
 *
 * 只索引已保存产品事实（charter §5、契约 §4）——快照来源纪律：
 *  - 材料版本：每个 (树链接, ready 版本) 一个文档。材料按**版本**入索引
 *    （同材料多版本 = 多文档）；oldVersion 由版本链推导：链尾（最新导入）
 *    即当前版本，非链尾为 true（链尾非 ready 时亦然——最新导入才是材料
 *    的当前版本，无论解析成败；非 ready 版本无 canonicalText，诚实不入
 *    索引）。
 *  - 批注：正文 = explanation+term+note 冻结真值拼接序（d4-probes §7）；
 *    产品批注无 note 字段（缺省空串）。
 *  - Return：已落库的 role="return" Turn（saved / adoption attempted /
 *    successfully adopted 全部入索引——都是已保存产品事实；draft 只存在
 *    于客户端本地，结构性不在库，永不出现在快照）。正文 = Return 文本。
 *  - Turn：user / assistant Turn（role="return" 的 Turn 归 return 文档，
 *    不重复入索引）。正文 = turn 文本。
 *  - 未提交草稿、临时解释缓存、凭据：结构性不在产品库，永不出现在快照。
 *
 * 产品字段 → 文档字段的推导（产品事实没有的字段，从链/角色推导）：
 *  - treeTitle：产品 Tree 无显示名字段——取 tree.id（UI 树名同源，app.js
 *    以 tree.id 呈现树列表）；
 *  - versionLabel：版本链位（"v1" "v2" …，1 起按导入序；与 B1 版本对
 *    v1/v2 命名及 B4 冻结集 "v1" 标签同口径）；
 *  - title（展示用，不参与匹配）：材料 = 材料显示名；批注 = 「批注：term」；
 *    Return = 「Return：文本头」；Turn = 「提问：/回答：文本头」（冻结集
 *    的标题约定同款）。
 *
 * 性能取舍（刻意）：每次请求读快照 + 进程内确定性重建索引，零缓存——
 * 正确性优先（快照即当前产品事实，永不陈旧）；性能优化（缓存/增量/持久
 * 化索引表）归 D4-6。charter §4「索引可从产品数据重建、不是事实源」由此
 * 结构性成立：索引只是派生结构，无持久化索引（迁移 0010 因此不需要，按
 * 弃用记录处理；引擎的 serialize/restore 缝保留未来持久化路径）。B5 的
 * 「删除索引重建后结果逐字一致」退化为结构性恒真：不存在磁盘索引，每个
 * 请求都是从产品数据的全新重建。
 */

import type { TreeId } from "@treeai/contracts";
import type { MaterialRepository, TreeRepository } from "@treeai/persistence";
import { LocalSearchEngine } from "./search-engine.ts";
import type { SearchDocument, SearchDocumentKind, SearchHit, SearchTarget } from "./search-engine.ts";

/* ------------------------------------------------------------------ */
/* 快照形状（buildSearchDocuments 的纯输入；HTTP 层与 verify:d4 共用）    */
/* ------------------------------------------------------------------ */

export interface SearchSnapshotTree {
  readonly treeId: string;
  /** 展示树名（产品 = tree.id；B4 冻结集自带 title）。 */
  readonly title: string;
}

/** 材料块覆盖：把命中位置映射回版本块（blockId 与 MaterialBlock 同源）。 */
export interface SearchSnapshotBlock {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
}

/** 材料版本事实：每个 (树链接, ready 版本) 一条（旧版本独立成条）。 */
export interface SearchSnapshotMaterialVersion {
  readonly treeId: string;
  readonly materialId: string;
  readonly materialTitle: string;
  readonly versionId: string;
  /** 版本链位标签（"v1"…，1 起按导入序）。 */
  readonly versionLabel: string;
  /** 非版本链尾（当前版本）即 true。 */
  readonly oldVersion: boolean;
  /** 版本规范文本全文（ready 版本；命中 start/end 即其 UTF-16 偏移）。 */
  readonly canonicalText: string;
  readonly blocks: ReadonlyArray<SearchSnapshotBlock>;
  /** 展示标题（产品 = 材料显示名）。 */
  readonly title: string;
  /** 版本导入时刻（文档 createdAt）。 */
  readonly importedAt: string;
}

/** 术语批注事实（正文 = explanation+term+note 拼接序）。 */
export interface SearchSnapshotAnnotation {
  readonly id: string;
  readonly treeId: string;
  readonly branchId: string;
  readonly title: string;
  readonly term: string;
  readonly explanation: string;
  /** B4 冻结集批注附带的备注文本；产品批注无此字段（null/缺省 = 空串）。 */
  readonly note?: string | null;
  readonly createdAt: string;
}

/** Return 事实（已落库的 role="return" Turn）。 */
export interface SearchSnapshotReturn {
  readonly id: string;
  readonly treeId: string;
  readonly branchId: string;
  readonly title: string;
  readonly text: string;
  readonly createdAt: string;
}

/** Turn 事实（user / assistant；return turn 归 return 文档）。 */
export interface SearchSnapshotTurn {
  readonly id: string;
  readonly treeId: string;
  readonly branchId: string;
  readonly title: string;
  readonly text: string;
  readonly createdAt: string;
}

/** 已保存产品事实快照（纯数据）。 */
export interface SearchSnapshot {
  readonly trees: ReadonlyArray<SearchSnapshotTree>;
  readonly materialVersions: ReadonlyArray<SearchSnapshotMaterialVersion>;
  readonly annotations: ReadonlyArray<SearchSnapshotAnnotation>;
  readonly returns: ReadonlyArray<SearchSnapshotReturn>;
  readonly turns: ReadonlyArray<SearchSnapshotTurn>;
}

/* ------------------------------------------------------------------ */
/* 装配（纯函数：HTTP 层与 verify:d4 b4 检查的同一代码路径）              */
/* ------------------------------------------------------------------ */

/** 文档稳定标识：`${treeId}:${kind}:${事实行 id}`（材料取 versionId；批内唯一）。 */
export function searchDocumentRefId(
  treeId: string,
  kind: SearchDocumentKind,
  factId: string,
): string {
  return `${treeId}:${kind}:${factId}`;
}

/**
 * 快照 → 检索文档（纯函数；正文构造/来源类型/oldVersion 语义在此集中，
 * 供 HTTP 端点与 B4 冻结集检查共用）。
 *
 * 纪律：
 *  - 事实引用快照外的树 → 立即抛错（调用方编程错误，fail-fast）；
 *  - 空正文事实（如空文件的 ready 版本）无可检索内容——诚实缺席，跳过
 *    而非抛错（「找不到」是该事实的真答案，不是装配失败）。
 */
export function buildSearchDocuments(snapshot: SearchSnapshot): SearchDocument[] {
  const treeTitleById = new Map(snapshot.trees.map((tree) => [tree.treeId, tree.title] as const));
  const treeTitleOf = (treeId: string): string => {
    const title = treeTitleById.get(treeId);
    if (title === undefined || title.length === 0) {
      throw new Error(`search snapshot: fact references unknown or untitled tree '${treeId}'`);
    }
    return title;
  };

  const documents: SearchDocument[] = [];

  for (const version of snapshot.materialVersions) {
    if (version.canonicalText.length === 0) continue;
    documents.push({
      refId: searchDocumentRefId(version.treeId, "material", version.versionId),
      target: {
        kind: "material",
        treeId: version.treeId,
        materialId: version.materialId,
        versionId: version.versionId,
        blockId: null,
      },
      kind: "material",
      treeId: version.treeId,
      treeTitle: treeTitleOf(version.treeId),
      title: version.title,
      body: version.canonicalText,
      createdAt: version.importedAt,
      materialId: version.materialId,
      materialTitle: version.materialTitle,
      versionId: version.versionId,
      versionLabel: version.versionLabel,
      oldVersion: version.oldVersion,
      blocks: version.blocks.map((block) => ({
        blockId: block.blockId,
        start: block.start,
        end: block.end,
      })),
    });
  }

  for (const annotation of snapshot.annotations) {
    // 批注正文 = 冻结真值拼接序 explanation+term+note（产品无 note ⇒ 空串）。
    const body = `${annotation.explanation}${annotation.term}${annotation.note ?? ""}`;
    if (body.length === 0) continue;
    documents.push({
      refId: searchDocumentRefId(annotation.treeId, "annotation", annotation.id),
      target: {
        kind: "annotation",
        treeId: annotation.treeId,
        annotationId: annotation.id,
      },
      kind: "annotation",
      treeId: annotation.treeId,
      treeTitle: treeTitleOf(annotation.treeId),
      title: annotation.title,
      body,
      createdAt: annotation.createdAt,
    });
  }

  for (const item of snapshot.returns) {
    if (item.text.length === 0) continue;
    documents.push({
      refId: searchDocumentRefId(item.treeId, "return", item.id),
      target: {
        kind: "return",
        treeId: item.treeId,
        branchId: item.branchId,
        turnId: item.id,
      },
      kind: "return",
      treeId: item.treeId,
      treeTitle: treeTitleOf(item.treeId),
      title: item.title,
      body: item.text,
      createdAt: item.createdAt,
    });
  }

  for (const turn of snapshot.turns) {
    if (turn.text.length === 0) continue;
    documents.push({
      refId: searchDocumentRefId(turn.treeId, "turn", turn.id),
      target: {
        kind: "turn",
        treeId: turn.treeId,
        branchId: turn.branchId,
        turnId: turn.id,
      },
      kind: "turn",
      treeId: turn.treeId,
      treeTitle: treeTitleOf(turn.treeId),
      title: turn.title,
      body: turn.text,
      createdAt: turn.createdAt,
    });
  }

  return documents;
}

/* ------------------------------------------------------------------ */
/* 服务（仓储读取面；每请求重建索引——性能优化归 D4-6）                    */
/* ------------------------------------------------------------------ */

export interface SearchServiceOptions {
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
}

/** 检索范围（HTTP 入参 → 引擎选项的中间形状）。 */
export interface SearchQueryScope {
  /** 限定单树（未知树 → EntityNotFoundError，HTTP 404）；null/缺省 = 全部树。 */
  readonly treeId?: TreeId | null;
  readonly kinds?: ReadonlyArray<SearchDocumentKind>;
  readonly limit?: number;
}

export class SearchService {
  readonly #trees: TreeRepository;
  readonly #materials: MaterialRepository;

  constructor(options: SearchServiceOptions) {
    this.#trees = options.treeRepository;
    this.#materials = options.materialRepository;
  }

  /**
   * 已保存产品事实快照。scopeTreeId === null 枚举全部树（库级真值枚举：
   * 所有 forest 的全部树——产品是单 forest 工作室，不重造 studio 的
   * ensureForest 约定）；给出时校验树存在（EntityNotFoundError → 404）
   * 并只读该树。读取纯只读：不创建任何产品事实（项目书 §4「浏览/搜索
   * 不创建 Turn」）。
   */
  readSnapshot(scopeTreeId: TreeId | null): SearchSnapshot {
    const trees =
      scopeTreeId === null
        ? this.#trees.listForests().flatMap((forest) => this.#trees.listTrees(forest.id))
        : [this.#trees.getTree(scopeTreeId)];

    const materialVersions: SearchSnapshotMaterialVersion[] = [];
    const annotations: SearchSnapshotAnnotation[] = [];
    const returns: SearchSnapshotReturn[] = [];
    const turns: SearchSnapshotTurn[] = [];

    for (const tree of trees) {
      // 材料版本 × 树链接：每 (树, ready 版本) 一文档；oldVersion/链位标签
      // 由版本链推导（链尾 = 当前版本）。
      for (const material of this.#materials.listTreeMaterials(tree.id)) {
        const versions = this.#materials.listVersions(material.id);
        const currentVersionId = versions.length > 0 ? versions[versions.length - 1]!.id : null;
        for (let index = 0; index < versions.length; index += 1) {
          const version = versions[index]!;
          // 非 ready 版本无 canonicalText（规范文本只随 ready 落库）——
          // 诚实不入索引（找不到是该版本的真状态，不是错误）。
          if (version.parseStatus !== "ready") continue;
          const content = this.#materials.getVersionContent(version.id);
          materialVersions.push({
            treeId: tree.id,
            materialId: material.id,
            materialTitle: material.title,
            versionId: version.id,
            versionLabel: `v${String(index + 1)}`,
            oldVersion: version.id !== currentVersionId,
            canonicalText: content.canonicalText,
            blocks: content.blocks.map((block) => ({
              blockId: block.blockId,
              start: block.start,
              end: block.end,
            })),
            title: material.title,
            importedAt: version.importedAt,
          });
        }
      }

      for (const annotation of this.#trees.listTerminologyAnnotations(tree.id)) {
        annotations.push({
          id: annotation.id,
          treeId: tree.id,
          branchId: annotation.branchId,
          title: `批注：${annotation.term}`,
          term: annotation.term,
          explanation: annotation.explanation,
          note: null,
          createdAt: annotation.createdAt,
        });
      }

      // Turn / Return：按分支枚举（returns-per-tree 无独立读路径；Return
      // 即已落库的 role="return" Turn——saved/attempted/adopted 全部）。
      for (const branch of this.#trees.listBranches(tree.id)) {
        for (const turn of this.#trees.listTurns(branch.id)) {
          if (turn.role === "return") {
            returns.push({
              id: turn.id,
              treeId: tree.id,
              branchId: branch.id,
              title: `Return：${headOf(turn.text)}`,
              text: turn.text,
              createdAt: turn.createdAt,
            });
          } else {
            turns.push({
              id: turn.id,
              treeId: tree.id,
              branchId: branch.id,
              title: `${turn.role === "user" ? "提问" : "回答"}：${headOf(turn.text)}`,
              text: turn.text,
              createdAt: turn.createdAt,
            });
          }
        }
      }
    }

    return {
      // 产品 Tree 无显示名字段——树名取 tree.id（UI 树列表同源）。
      trees: trees.map((tree) => ({ treeId: tree.id, title: tree.id })),
      materialVersions,
      annotations,
      returns,
      turns,
    };
  }

  /**
   * 检索（每请求读快照 + 确定性重建索引——零缓存，正确性优先；性能优化
   * 归 D4-6）。treeId 给出时树必须存在（EntityNotFoundError → HTTP 404），
   * 快照只含该树（范围在读侧收紧；引擎的 treeId 选项同语义，由 B4 冻结
   * 集与引擎测试行使）。零命中如实空数组（不编造）。
   */
  search(text: string, scope: SearchQueryScope = {}): ReadonlyArray<SearchHit> {
    const treeId = scope.treeId === undefined ? null : scope.treeId;
    const documents = buildSearchDocuments(this.readSnapshot(treeId));
    return LocalSearchEngine.build(documents).search(text, {
      ...(scope.kinds === undefined ? {} : { kinds: scope.kinds }),
      ...(scope.limit === undefined ? {} : { limit: scope.limit }),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 契约 §3 SearchHit（HTTP 裁剪面）                                      */
/* ------------------------------------------------------------------ */

/**
 * 契约 §3 的 SearchHit：可空字段以**缺省**表达（HTTP 层裁剪 null），引擎
 * 附加的 refId/matchType/matchCount 剥离（不进契约响应）。
 * start/end 恒在：材料 = canonicalText 内 UTF-16 半开区间；非材料 = 索引
 * 正文（拼接的产品字段序列）内偏移（仅辅助展示）。
 */
export interface ContractSearchHit {
  readonly kind: SearchDocumentKind;
  readonly target: SearchTarget;
  readonly treeId: string;
  readonly treeTitle: string;
  readonly materialId?: string;
  readonly materialTitle?: string;
  readonly versionId?: string;
  readonly versionLabel?: string;
  readonly oldVersion: boolean;
  readonly blockId?: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly title: string;
  readonly createdAt: string;
}

/** 引擎命中 → 契约 SearchHit（null 字段省略 + 附加字段剥离）。 */
export function toContractSearchHit(hit: SearchHit): ContractSearchHit {
  if (hit.target === null) {
    throw new Error(`search hit ${hit.refId} has no stable product target`);
  }
  return {
    kind: hit.kind,
    target: hit.target,
    treeId: hit.treeId,
    treeTitle: hit.treeTitle,
    ...(hit.materialId === null ? {} : { materialId: hit.materialId }),
    ...(hit.materialTitle === null ? {} : { materialTitle: hit.materialTitle }),
    ...(hit.versionId === null ? {} : { versionId: hit.versionId }),
    ...(hit.versionLabel === null ? {} : { versionLabel: hit.versionLabel }),
    oldVersion: hit.oldVersion,
    ...(hit.blockId === null ? {} : { blockId: hit.blockId }),
    start: hit.start,
    end: hit.end,
    excerpt: hit.excerpt,
    title: hit.title,
    createdAt: hit.createdAt,
  };
}

/** kinds 过滤词汇表（HTTP 校验用；与 SearchDocumentKind 同集）。 */
export const SEARCH_DOCUMENT_KINDS: ReadonlySet<string> = new Set<string>([
  "material",
  "annotation",
  "return",
  "turn",
]);

/** 展示标题的文本头（仅展示用，不参与匹配；超长截断加省略号）。 */
function headOf(text: string): string {
  const HEAD_UNITS = 24;
  const trimmed = text.trim();
  return trimmed.length > HEAD_UNITS ? `${trimmed.slice(0, HEAD_UNITS)}…` : trimmed;
}
