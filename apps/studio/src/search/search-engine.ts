/**
 * D4-4 找回既有思考 —— 本地确定性全文检索引擎（纯内核，零依赖、零 IO）。
 *
 * 定位（docs/d4/D4-contracts.md §4 / D4 项目书 §5「搜索」边界）：
 *  - 首版本地确定性检索：同一文档集合 + 同一查询 ⇒ 永远同一结果（排序
 *    不含时间戳、随机数或遍历顺序残余——末位以 refId 全序兜底）；
 *  - 中文按**子串/词语**命中（查询串在正文中出现即命中，不依赖分词）；
 *    英文按**整词**命中（词边界匹配：查 "tree" 不得命中 "street"）；
 *  - 范围：treeId 限定单树（「当前 Tree」默认由 API 层决定，本引擎只
 *    接受显式范围）；缺省 = 全部树；
 *  - 只索引调用方（接线层）从已保存产品事实构造的文档——材料版本
 *    canonicalText、批注、Return、Turn；未提交草稿、临时解释缓存、
 *    凭据不入索引（charter §5——本引擎不负责甄别，输入纪律归接线层）；
 *  - 无结果不编造：零命中返回空数组，绝无近似/猜测匹配；
 *  - 索引不是事实源：本引擎可从文档集合随时确定性重建（build），序列化
 *    形式（serialize/restore）只是文档快照 + 版本号，倒排结构进程内重建。
 *
 * 匹配语义（两档，命中即入结果，档位参与排序）：
 *  - phrase（整串精确）：查询文本（首尾空白裁剪后）在文档正文中按
 *    子串出现；英文/数字词符（[A-Za-z0-9_]）落在查询**两端**时施加词
 *    边界约束（匹配起点前、终点后的字符不得是词符），中文端不设边界
 *    ——中文子串语义与英文整词语义由此统一在一条规则里；大小写按
 *    String.prototype.toLowerCase() 折算（确定性、无区域依赖）。
 *  - segments（分段全命中）：查询切分为中文连续段（按码点：汉字/假名/
 *    谚文及扩展区）与拉丁词（lowercase 后的 [a-z0-9_]+ 极长串）；文档
 *    正文包含**全部**段（中文段按子串、拉丁词按整词）即命中，不要求
 *    连续相邻。例：查「高代理 D840」可命中「高代理……D840 分开出现」
 *    的文档，但排序永远低于整串命中的文档。仅含标点/空白的查询无任何
 *    段 ⇒ 零命中（诚实空结果）。
 *  - 注意：不引入跨形态变体召回——全角/半角、组合/预组合、单复数、
 *    词形变化一律按原码位精确比较（B1/B4 fixture 的「无任何 Unicode
 *    归一化」纪律同源）；英文 "tree" 也不命中 "trees"（整词边界）。
 *
 * 排序（全序比较，依次）：
 *  1. 档位：phrase < segments（整串精确优先）；
 *  2. 来源类型：annotation < return < turn < material——已保存的提炼
 *     思考（批注/Return）信息密度最高，其次对话，最后长篇原材料（其
 *     命中常为大量顺带出现）；
 *  3. 命中次数：同档同类型下，查询（phrase 档=整串；segments 档=各段
 *    次数之和）在正文出现次数多者优先——多次出现说明文档更以该词为主题；
 *  4. createdAt 降序（近者优先；ISO-8601 UTC 字符串序即时间序）；
 *  5. refId 升序——终极稳定锚，保证与文档输入顺序无关的确定性。
 *  该序在 B4 冻结集（55 正向查询）上的实测：全部目标进入前 3（验收
 *  线为前 5、≥95%，见 apps/studio/tests/search-engine.test.ts）。
 *
 * 倒排索引（效率）：
 *  - 键 = 中文一元 gram + 中文相邻二元 gram（按码点，含星面扩展区代
 *    理对）+ 拉丁整词（lowercase）；
 *  - 查询先按同一规则取键，倒排表求交得到候选文档，再在候选正文上做
 *    上述两档精确验证——索引只收窄，验证才裁决（索引永不漏真命中：
 *    子串存在 ⇒ 其全部二元 gram 已入索引；整词存在 ⇒ 该词键已入索引）；
 *  - 最坏情况（单高频字查询）候选退化为近全量，验证为语料线性扫描，
 *    仍确定性；B6 规模（100 万 UTF-16 单元、万级事实）属本地进程可
 *    接受的设计预期，实测归 D4-6 性能波次。
 *
 * 与 SearchHit 契约（D4-contracts §3）的关系：命中结果携带契约的全部
 * 字段；契约的可选字段（materialId? 等）在本引擎以显式 null 表达，附
 * 加 refId/matchType/matchCount 供接线层与测试使用，HTTP 层按契约裁剪。
 * 材料命中的 start/end 是版本 canonicalText 内 UTF-16 半开区间（可精确
 * 跳转），blockId 为匹配起点所在块；非材料命中的 start/end 是索引正文
 * （接线层拼接的产品字段序列）内偏移，仅辅助展示。oldVersion 只对材料
 * 文档有意义（非当前版本命中标注 true），非材料文档恒为 false。
 */

/** 搜索文档类型（对齐契约 §3 的 kinds 词汇；facts.json 的 material-fragment 归入 material）。 */
export type SearchDocumentKind = "material" | "annotation" | "return" | "turn";

/** Stable product-fact identity carried across the HTTP boundary. */
export type SearchTarget =
  | {
      readonly kind: "material";
      readonly treeId: string;
      readonly materialId: string;
      readonly versionId: string;
      readonly blockId: string | null;
    }
  | {
      readonly kind: "annotation";
      readonly treeId: string;
      readonly annotationId: string;
    }
  | {
      readonly kind: "return";
      readonly treeId: string;
      readonly branchId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "turn";
      readonly treeId: string;
      readonly branchId: string;
      readonly turnId: string;
    };

/** 材料块引用：把命中位置映射回版本块（blockId 与 MaterialBlock 同源）。 */
export interface SearchDocumentBlock {
  readonly blockId: string;
  /** 版本 canonicalText 内 UTF-16 半开区间（含）。 */
  readonly start: number;
  /** 版本 canonicalText 内 UTF-16 半开区间（不含）。 */
  readonly end: number;
}

interface SearchDocumentBase {
  /** 被索引产品事实的稳定标识（建议 `${treeId}:${kind}:${事实行 id}` 或材料版本 id）；批内唯一。 */
  readonly refId: string;
  /** Product identity for HTTP consumers; test-only documents may omit it. */
  readonly target?: SearchTarget;
  readonly kind: SearchDocumentKind;
  readonly treeId: string;
  readonly treeTitle: string;
  /** 展示标题（不参与匹配——见文件头「匹配语义」）。 */
  readonly title: string;
  /** 可检索正文：材料=版本 canonicalText；批注/Return/Turn=接线层拼接的产品字段文本。 */
  readonly body: string;
  /** ISO-8601 UTC 时间戳（字符串序参与排序，必须同格式）。 */
  readonly createdAt: string;
}

/** 材料文档：一个材料版本的可检索快照（canonicalText + 版本元信息）。 */
export interface MaterialSearchDocument extends SearchDocumentBase {
  readonly kind: "material";
  readonly materialId: string;
  readonly materialTitle: string;
  readonly versionId: string;
  readonly versionLabel: string;
  /** 命中非当前版本时为 true（契约 §4「命中旧版本应标注」）。 */
  readonly oldVersion: boolean;
  /** 块覆盖（可选）：提供时材料命中报告 blockId。 */
  readonly blocks?: ReadonlyArray<SearchDocumentBlock>;
}

/** 非材料文档：批注 / Return / Turn。 */
export interface FactSearchDocument extends SearchDocumentBase {
  readonly kind: "annotation" | "return" | "turn";
}

/** 索引输入文档（接线层从产品事实构造；本引擎不读库、不落盘）。 */
export type SearchDocument = MaterialSearchDocument | FactSearchDocument;

/** 查询范围与过滤（「当前 Tree 默认」由 API 层决定后显式传入）。 */
export interface SearchQueryOptions {
  /** 限定单树；null/undefined = 全部树。 */
  readonly treeId?: string | null;
  /** 来源类型过滤；undefined = 全部类型；空数组 = 编程错误（fail-fast）。 */
  readonly kinds?: ReadonlyArray<SearchDocumentKind>;
  /** 结果条数上限（仅截断，不改变排序）；undefined = 返回全部命中。 */
  readonly limit?: number;
}

/** 命中档位：整串精确 / 分段全命中。 */
export type SearchMatchType = "phrase" | "segments";

/** 检索命中（契约 §3 SearchHit 字段全数携带 + 引擎附加元信息）。 */
export interface SearchHit {
  readonly kind: SearchDocumentKind;
  readonly refId: string;
  readonly target: SearchTarget | null;
  readonly treeId: string;
  readonly treeTitle: string;
  readonly materialId: string | null;
  readonly materialTitle: string | null;
  readonly versionId: string | null;
  readonly versionLabel: string | null;
  readonly oldVersion: boolean;
  /** 材料命中 = 匹配起点所在块；非材料命中 = null。 */
  readonly blockId: string | null;
  /** 命中区间的 UTF-16 半开起点（材料=canonicalText 内；非材料=索引正文内）。 */
  readonly start: number;
  /** 命中区间的 UTF-16 半开终点。 */
  readonly end: number;
  /** 命中上下文摘录（匹配区前后各至多 24 码元，截断处加「…」）。 */
  readonly excerpt: string;
  readonly title: string;
  readonly createdAt: string;
  readonly matchType: SearchMatchType;
  /** phrase=整串出现次数；segments=各段出现次数之和。 */
  readonly matchCount: number;
}

/** 序列化索引 = 文档快照 + 格式版本。倒排结构不入序列化面（restore 时确定性重建）。 */
export interface SerializedSearchIndex {
  readonly version: 1;
  readonly documents: ReadonlyArray<SearchDocument>;
}

/** 引擎错误：非法输入（文档/查询选项）时 fail-fast 抛出。 */
export class SearchEngineError extends Error {
  constructor(message: string) {
    super(`search-engine: ${message}`);
    this.name = "SearchEngineError";
  }
}

// --- 字符分类（确定性；无区域依赖） --------------------------------------

const WORD_CHAR = /[A-Za-z0-9_]/;
const LATIN_WORD_RUN = /[a-z0-9_]+/g;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** 中文连续段成员（按码点）：假名/谚文/汉字 URO·扩展 A·兼容·扩展 B 起（含代理对星区）。 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名/片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 汉字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 汉字 URO
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 汉字兼容
    (cp >= 0x20000 && cp <= 0x2ebef) || // 汉字扩展 B 起 / 兼容补充
    (cp >= 0x30000 && cp <= 0x3134a) // 汉字扩展 G 起
  );
}

/** 查询切分单元：中文连续段（原文）或拉丁整词（lowercase）。 */
interface QueryUnit {
  readonly cjk: boolean;
  readonly text: string;
}

/** 把文本切成中文段与拉丁词（标点/空白不产生单元）。 */
function splitUnits(text: string): QueryUnit[] {
  const units: QueryUnit[] = [];
  let cjkRun = "";
  let latinRun = "";
  const flushLatin = (): void => {
    if (latinRun.length === 0) return;
    // 拉丁侧统一按 lowercase 折算后取整词（与倒排键同一口径）。
    for (const word of latinRun.toLowerCase().matchAll(LATIN_WORD_RUN)) {
      units.push({ cjk: false, text: word[0] });
    }
    latinRun = "";
  };
  const flushCjk = (): void => {
    if (cjkRun.length > 0) {
      units.push({ cjk: true, text: cjkRun });
      cjkRun = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (isCjkCodePoint(cp)) {
      flushLatin();
      cjkRun += ch;
    } else {
      flushCjk();
      latinRun += ch;
    }
    i += ch.length;
  }
  flushCjk();
  flushLatin();
  return units;
}

// --- 匹配（验证层：索引只收窄，这里才裁决） --------------------------------

interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

interface MatchResult {
  readonly count: number;
  /** 首个命中区间；count > 0 时非空。 */
  readonly first: MatchSpan | null;
}

/**
 * 整串/中文段子串匹配：lowered 内按子串查找 needle；needle 两端为拉丁
 * 词符时施加词边界（首端：start===0 或前一码元非词符；尾端同理）。
 */
function findSubstring(lowered: string, needle: string): MatchResult {
  if (needle.length === 0) return { count: 0, first: null };
  const leadBoundary = isWordChar(needle.charAt(0));
  const tailBoundary = isWordChar(needle.charAt(needle.length - 1));
  let count = 0;
  let first: MatchSpan | null = null;
  let from = 0;
  for (;;) {
    const at = lowered.indexOf(needle, from);
    if (at === -1) break;
    const end = at + needle.length;
    const leadOk = !leadBoundary || at === 0 || !isWordChar(lowered.charAt(at - 1));
    const tailOk = !tailBoundary || end === lowered.length || !isWordChar(lowered.charAt(end));
    if (leadOk && tailOk) {
      count += 1;
      if (first === null) first = { start: at, end };
    }
    from = at + needle.length; // 非重叠计数
  }
  return { count, first };
}

/** 拉丁整词匹配与整串匹配同一条规则：词两端即词符 ⇒ 两端词边界 + 子串。 */

// --- 倒排索引 -----------------------------------------------------------

interface IndexedDocument {
  readonly doc: SearchDocument;
  readonly lowered: string;
}

interface BuiltIndex {
  readonly documents: ReadonlyArray<IndexedDocument>;
  readonly postings: ReadonlyMap<string, ReadonlySet<number>>;
}

/** 单元 ⇒ 倒排键：中文段=相邻二元 gram（长度 1 用一元）；拉丁词=词本身。 */
function unitKeys(unit: QueryUnit): string[] {
  if (!unit.cjk) return [unit.text];
  const chars: string[] = [];
  let i = 0;
  while (i < unit.text.length) {
    const cp = unit.text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    chars.push(ch);
    i += ch.length;
  }
  if (chars.length === 1) return [chars[0]!];
  const keys: string[] = [];
  for (let k = 0; k + 1 < chars.length; k += 1) {
    keys.push(chars[k]! + chars[k + 1]!);
  }
  return keys;
}

/** 正文 ⇒ 倒排键（中文一元+相邻二元 gram、拉丁整词），逐键回调。 */
function indexBody(body: string, lowered: string, emit: (key: string) => void): void {
  let run: string[] = [];
  const flushCjkRun = (): void => {
    if (run.length === 0) return;
    for (const ch of run) emit(ch);
    for (let k = 0; k + 1 < run.length; k += 1) emit(run[k]! + run[k + 1]!);
    run = [];
  };
  let i = 0;
  while (i < body.length) {
    const cp = body.codePointAt(i) ?? 0;
    if (isCjkCodePoint(cp)) {
      const ch = String.fromCodePoint(cp);
      run.push(ch);
      i += ch.length;
    } else {
      flushCjkRun();
      i += 1;
    }
  }
  flushCjkRun();
  for (const word of lowered.matchAll(LATIN_WORD_RUN)) emit(word[0]);
}

// --- 文档校验（fail-fast，一次性报全所有问题） -----------------------------

function validateDocuments(documents: ReadonlyArray<SearchDocument>): string[] {
  const problems: string[] = [];
  const seenRefIds = new Set<string>();
  const kinds: ReadonlySet<string> = new Set([
    "material",
    "annotation",
    "return",
    "turn",
  ]);
  documents.forEach((doc, at): void => {
    const tag = `documents[${String(at)}]`;
    if (typeof doc !== "object" || doc === null) {
      problems.push(`${tag}: not an object`);
      return;
    }
    for (const field of ["refId", "treeId", "treeTitle", "title", "body", "createdAt"] as const) {
      const value = doc[field];
      if (typeof value !== "string" || value.length === 0) {
        problems.push(`${tag} (${String(doc.refId)}): ${field} must be a non-empty string`);
      }
    }
    if (doc.kind === undefined || !kinds.has(doc.kind)) {
      problems.push(`${tag} (${String(doc.refId)}): unknown kind ${String(doc.kind)}`);
      return;
    }
    if (seenRefIds.has(doc.refId)) {
      problems.push(`${tag}: duplicate refId ${doc.refId}`);
    }
    seenRefIds.add(doc.refId);
    if (doc.kind === "material") {
      for (const field of ["materialId", "materialTitle", "versionId", "versionLabel"] as const) {
        const value = doc[field];
        if (typeof value !== "string" || value.length === 0) {
          problems.push(`${tag} (${doc.refId}): material document requires non-empty ${field}`);
        }
      }
      if (doc.oldVersion !== true && doc.oldVersion !== false) {
        problems.push(`${tag} (${doc.refId}): material document requires boolean oldVersion`);
      }
      const blocks = doc.blocks ?? [];
      for (const block of blocks) {
        if (
          typeof block?.blockId !== "string" || block.blockId.length === 0 ||
          typeof block.start !== "number" || typeof block.end !== "number" ||
          !(block.start >= 0) || !(block.end > block.start) ||
          block.end > doc.body.length
        ) {
          problems.push(
            `${tag} (${doc.refId}): block ${String(block?.blockId)} out of body bounds or malformed`,
          );
        }
      }
    }
  });
  return problems;
}

// --- 排序 -----------------------------------------------------------------

const KIND_RANK: Readonly<Record<SearchDocumentKind, number>> = {
  annotation: 0,
  return: 1,
  turn: 2,
  material: 3,
};

const VALID_KINDS: ReadonlySet<string> = new Set<string>([
  "material",
  "annotation",
  "return",
  "turn",
]);

const EXCERPT_PAD = 24;

interface ScoredHit {
  readonly doc: SearchDocument;
  readonly matchType: SearchMatchType;
  readonly matchCount: number;
  readonly span: MatchSpan;
}

function compareScored(a: ScoredHit, b: ScoredHit): number {
  if (a.matchType !== b.matchType) {
    return a.matchType === "phrase" ? -1 : 1;
  }
  const kindDelta = KIND_RANK[a.doc.kind] - KIND_RANK[b.doc.kind];
  if (kindDelta !== 0) return kindDelta;
  if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
  if (a.doc.createdAt !== b.doc.createdAt) {
    return a.doc.createdAt < b.doc.createdAt ? 1 : -1;
  }
  if (a.doc.refId !== b.doc.refId) return a.doc.refId < b.doc.refId ? -1 : 1;
  return 0;
}

function makeExcerpt(body: string, span: MatchSpan): string {
  const from = Math.max(0, span.start - EXCERPT_PAD);
  const to = Math.min(body.length, span.end + EXCERPT_PAD);
  return (
    (from > 0 ? "…" : "") + body.slice(from, to) + (to < body.length ? "…" : "")
  );
}

// --- 引擎 -----------------------------------------------------------------

/**
 * 本地确定性全文检索引擎。
 *
 * 构造入口：
 *  - `LocalSearchEngine.build(documents)`——从产品事实文档重建（主路径；
 *    charter：索引可从产品数据重建，不是事实源）；
 *  - `LocalSearchEngine.restore(serialized)`——从序列化快照恢复（内部
 *    等价于 build；倒排结构进程内重建，序列化面不存派生数据）。
 */
export class LocalSearchEngine {
  private readonly built: BuiltIndex;

  private constructor(built: BuiltIndex) {
    this.built = built;
  }

  /** 从文档集合确定性建索引（文档输入顺序不影响检索结果序——排序末位以 refId 全序兜底）。 */
  static build(documents: ReadonlyArray<SearchDocument>): LocalSearchEngine {
    const problems = validateDocuments(documents);
    if (problems.length > 0) {
      throw new SearchEngineError(`invalid documents (${String(problems.length)} problems): ${problems.join("; ")}`);
    }
    const indexed: IndexedDocument[] = documents.map((doc) => ({
      doc,
      lowered: doc.body.toLowerCase(),
    }));
    const postings = new Map<string, Set<number>>();
    const emit = (key: string, docIndex: number): void => {
      let set = postings.get(key);
      if (set === undefined) {
        set = new Set<number>();
        postings.set(key, set);
      }
      set.add(docIndex);
    };
    indexed.forEach((entry, docIndex): void => {
      // Postings contain document IDs, not occurrence counts. Repeated
      // grams need only one global insertion per document. This local set
      // is rebuilt for every request; it never caches product facts.
      const uniqueKeys = new Set<string>();
      indexBody(entry.doc.body, entry.lowered, (key) => {
        uniqueKeys.add(key);
      });
      for (const key of uniqueKeys) emit(key, docIndex);
    });
    return new LocalSearchEngine({
      documents: indexed,
      postings,
    });
  }

  /** 从序列化快照恢复（版本校验 + 重新走 build 的全部校验与索引构建）。 */
  static restore(serialized: SerializedSearchIndex): LocalSearchEngine {
    if (
      typeof serialized !== "object" || serialized === null ||
      serialized.version !== 1 || !Array.isArray(serialized.documents)
    ) {
      throw new SearchEngineError("serialized index must be { version: 1, documents: [...] }");
    }
    return LocalSearchEngine.build(serialized.documents as ReadonlyArray<SearchDocument>);
  }

  /** 序列化 = 文档快照 + 版本号（确定性：同一引擎反复序列化结果恒等）。 */
  serialize(): SerializedSearchIndex {
    return {
      version: 1,
      documents: this.built.documents.map((entry) => entry.doc),
    };
  }

  get documentCount(): number {
    return this.built.documents.length;
  }

  /** 检索：零命中返回空数组（不编造）；结果已按文件头声明的全序排序。 */
  search(text: string, options: SearchQueryOptions = {}): ReadonlyArray<SearchHit> {
    if (typeof text !== "string") {
      throw new SearchEngineError("query text must be a string");
    }
    const query = text.trim();
    if (query.length === 0) return [];
    const units = splitUnits(query);
    if (units.length === 0) return [];

    const kinds =
      options.kinds === undefined ? null : new Set<SearchDocumentKind>(options.kinds);
    if (kinds !== null) {
      if (kinds.size === 0) {
        throw new SearchEngineError("kinds filter must be non-empty when provided");
      }
      for (const kind of kinds) {
        if (!VALID_KINDS.has(kind)) {
          throw new SearchEngineError(`unknown kind in kinds filter: ${String(kind)}`);
        }
      }
    }
    const treeId = options.treeId === undefined ? null : options.treeId;
    const limit = options.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new SearchEngineError("limit must be a non-negative integer when provided");
    }

    // 候选：全部单元键的倒排表求交（任一键在语料中不存在 ⇒ 必零命中）。
    let candidates: Set<number> | null = null;
    for (const unit of units) {
      for (const key of unitKeys(unit)) {
        const posting = this.built.postings.get(key);
        if (posting === undefined) return [];
        if (candidates === null) {
          candidates = new Set<number>(posting);
        } else {
          for (const docIndex of candidates) {
            if (!posting.has(docIndex)) candidates.delete(docIndex);
          }
        }
        if (candidates.size === 0) return [];
      }
    }
    if (candidates === null) return [];

    // 验证 + 计分（范围/类型过滤在验证前裁掉，不进结果）。
    const loweredQuery = query.toLowerCase();
    const scored: ScoredHit[] = [];
    for (const docIndex of candidates) {
      const entry = this.built.documents[docIndex]!;
      if (treeId !== null && entry.doc.treeId !== treeId) continue;
      if (kinds !== null && !kinds.has(entry.doc.kind)) continue;
      const phrase = findSubstring(entry.lowered, loweredQuery);
      if (phrase.count > 0) {
        scored.push({
          doc: entry.doc,
          matchType: "phrase",
          matchCount: phrase.count,
          span: phrase.first!,
        });
        continue;
      }
      // 分段验证：中文段按子串（CJK 不受大小写折算影响）、拉丁词按整词
      //（splitUnits 已折算为 lowercase，与倒排键同口径）——同一条规则。
      let total = 0;
      let span: MatchSpan | null = null;
      let allPresent = true;
      for (const unit of units) {
        const result = findSubstring(entry.lowered, unit.text);
        if (result.count === 0) {
          allPresent = false;
          break;
        }
        total += result.count;
        if (span === null || result.first!.start < span.start) span = result.first!;
      }
      if (allPresent && span !== null) {
        scored.push({
          doc: entry.doc,
          matchType: "segments",
          matchCount: total,
          span,
        });
      }
    }

    scored.sort(compareScored);
    const hits = scored.map((entry) => LocalSearchEngine.toHit(entry));
    return limit === undefined ? hits : hits.slice(0, limit);
  }

  private static toHit(entry: ScoredHit): SearchHit {
    const { doc, span } = entry;
    const isMaterial = doc.kind === "material";
    let blockId: string | null = null;
    if (isMaterial) {
      for (const block of doc.blocks ?? []) {
        if (span.start >= block.start && span.start < block.end) {
          blockId = block.blockId;
          break;
        }
      }
    }
    const target = doc.target;
    const targetWithBlock =
      target === undefined
        ? null
        : target.kind === "material"
          ? { ...target, blockId }
          : target;
    return {
      kind: doc.kind,
      refId: doc.refId,
      target: targetWithBlock,
      treeId: doc.treeId,
      treeTitle: doc.treeTitle,
      materialId: isMaterial ? doc.materialId : null,
      materialTitle: isMaterial ? doc.materialTitle : null,
      versionId: isMaterial ? doc.versionId : null,
      versionLabel: isMaterial ? doc.versionLabel : null,
      oldVersion: isMaterial ? doc.oldVersion : false,
      blockId,
      start: span.start,
      end: span.end,
      excerpt: makeExcerpt(doc.body, span),
      title: doc.title,
      createdAt: doc.createdAt,
      matchType: entry.matchType,
      matchCount: entry.matchCount,
    };
  }
}
