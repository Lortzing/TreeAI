/**
 * MaterialRangeResolver —— D4-2「阅读与来源定位」的统一区间/锚点解析层
 * （issue #8 工作包 D4-2；charter §3.2 锚点语义 / §6 B2 精确锚点）。
 *
 * 职责：给定（materialId、versionId、locator 或 utf16 区间、期望摘录），
 * 对照该版本**冻结的 canonical truth**（material_versions 行：解析器产出的
 * canonicalText + 块图，ADR-003 §3「模型不计算坐标或偏移」）解析出规范选区
 * （blockId, start, end, excerpt, sourceHash），或在**零误定位**纪律下给出
 * 稳定原因码的拒绝。Markdown 与 PDF 同一层（「统一区间层」）；定位语义与
 * 冻结探针 tests/support/verifier/d4-probes.ts 对 B2 选区集的机械复核完全
 * 一致（text-occurrence 的第 N 次出现按 +1 步进允许重叠计数；utf16-range
 * 为 UTF-16 码元半开区间；图素簇边界用 Intl.Segmenter granularity
 * "grapheme" 判定）——但这里是**产品服务**，不是测试助手：B2 验收
 * （scripts/verify-d4.js 的 b2-precise-anchors）经本类 + MaterialRepository
 * 执行，D4-3 建枝与前端阅读器同一入口。
 *
 * 校验顺序（冻结，拒绝原因码即对外契约）：
 *   1. 引用错误（异常，非拒绝值）：版本不存在 → EntityNotFoundError；
 *      versionId 属于其他 material → InvalidArgumentError；
 *   2. material-not-ready —— 非 ready 版本没有可锚定的规范文本（charter
 *      §3.2 不把不支持伪装成成功空文档）；
 *   3. invalid-locator —— locator 形状非法（非整数偏移 / 空 needle /
 *      occurrence < 1 / 未知 kind）；
 *   4. needle-not-found —— text-occurrence 的第 N 次出现不存在；
 *   5. out-of-bounds —— start < 0 或 end > canonicalText 长度；
 *   6. reversed —— end < start；
 *   7. zero-length —— end === start（无可摘录内容）；
 *   8. excerpt-mismatch / stale-version —— 期望摘录与目标版本切片不等：
 *      给出 anchor 溯源（摘录来自同材料的另一版本）且该版本同区间文本
 *      完好、sourceHash（如给出）一致 → stale-version（旧版本保持可读、
 *      锚点不迁移到新版本——charter §3.1/§3.2）；否则 excerpt-mismatch；
 *   9. surrogate-split / combining-split / emoji-split —— UTF-16 边界安全：
 *      区间边界落在代理对中间（surrogate-split）、拆散组合字符与其基字符
 *      （combining-split）或拆开 emoji/ZWJ 字素簇（emoji-split）——与冻结
 *      无效选区集 inv-05/06/07 同一分类法（先判代理邻接，再看所在字素簇
 *      是否含 ZWJ / 扩展象形文字）；
 *  10. cross-page（pdf）/ cross-block（markdown）—— 区间跨越块/页边界，
 *      不含于任何单块（PDF 跨页首版明确提示分段选择，不悄悄截断）；
 *  11. block-mismatch —— 调用方声明的 blockId 与实际包含块不符（或不存在）；
 *  12. 成功 —— 规范 MaterialSelection（excerpt === canonicalText.slice(
 *      start, end)、sourceHash === canonicalText SHA-256，与仓储
 *      getMaterialSelection 同一纪律）+ 包含块。
 *
 * 溯源说明：stale-version 判定是**文本同一性**判定（锚点摘录在锚定版本
 * 同区间完好、在目标版本同区间已变），不要求该区间在锚定版本上是完整
 * 合法选区（B2 冻结集 inv-15 的锚定区间本身跨块，仍须判 stale 而非
 * excerpt-mismatch）。旧版本可读性由版本不可变结构性保证（B1 版本对检查）。
 *
 * 性能边界：图素簇边界集按 canonicalText 内容缓存（版本不可变 ⇒ 内容
 * 寻址安全；LRU 上限 4 个版本，防止 100 万单元级材料常驻内存）。
 * Intl.Segmenter 为运行时内置（Node 24），零新增依赖。
 */

import { createHash } from "node:crypto";
import type {
  MaterialBlock,
  MaterialId,
  MaterialSelection,
  MaterialVersionId,
} from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError, type MaterialRepository } from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 定位器与拒绝词汇表（对外契约：HTTP 400/409 的 error.code）            */
/* ------------------------------------------------------------------ */

/** 选区定位器：文本第 N 次出现（+1 步进、允许重叠）或 UTF-16 半开区间。 */
export type MaterialLocator =
  | { readonly kind: "text-occurrence"; readonly needle: string; readonly occurrence: number }
  | { readonly kind: "utf16-range"; readonly start: number; readonly end: number };

/** 稳定拒绝原因码（B2 冻结无效类别 + 产品面补充的诚实拒绝）。 */
export type MaterialRangeRejectionCode =
  | "invalid-locator"
  | "needle-not-found"
  | "out-of-bounds"
  | "reversed"
  | "zero-length"
  | "surrogate-split"
  | "combining-split"
  | "emoji-split"
  | "excerpt-mismatch"
  | "stale-version"
  | "cross-page"
  | "cross-block"
  | "block-mismatch"
  | "material-not-ready";

export interface MaterialRangeRejection {
  readonly code: MaterialRangeRejectionCode;
  readonly message: string;
}

/**
 * 摘录溯源：期望摘录来自同材料另一版本的既有锚点时给出（stale-version
 * 判定的依据）。sourceHash 可选；给出时必须等于锚定版本 canonicalText 的
 * SHA-256（与 MaterialSelection.sourceHash 同口径）。
 */
export interface AnchorProvenance {
  readonly versionId: MaterialVersionId;
  readonly sourceHash?: string;
}

export interface ResolveSelectionInput {
  /** 目标版本（解析/校验所对照的冻结真值）。 */
  readonly versionId: MaterialVersionId;
  /** 给出时校验版本归属（versionId 必须属于该材料）。 */
  readonly materialId?: MaterialId;
  /** 定位器（text-occurrence 或 utf16-range）。 */
  readonly locator: MaterialLocator;
  /** 期望摘录（锚点纪律：必须等于目标版本切片；缺省不校验摘录）。 */
  readonly excerpt?: string;
  /** 声明块（锚点复核：必须等于实际包含块；缺省不校验块声明）。 */
  readonly blockId?: string;
  /** 摘录溯源（stale-version 判定；缺省不做跨版本判定）。 */
  readonly anchor?: AnchorProvenance;
}

/** 解析成功：规范选区 + 包含块。 */
export interface ResolvedSelection {
  readonly selection: MaterialSelection;
  readonly block: MaterialBlock;
}

export type MaterialRangeResolution =
  | { readonly ok: true; readonly result: ResolvedSelection }
  | { readonly ok: false; readonly rejection: MaterialRangeRejection };

/* ------------------------------------------------------------------ */
/* 图素簇索引（Intl.Segmenter，与冻结探针同一判定）                      */
/* ------------------------------------------------------------------ */

interface GraphemeIndex {
  readonly boundaries: ReadonlySet<number>;
  readonly clusters: readonly { readonly start: number; readonly end: number }[];
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 图素簇索引缓存上限（版本内容不可变；防大材料边界集常驻内存）。 */
const GRAPHEME_CACHE_LIMIT = 4;

function buildGraphemeIndex(text: string): GraphemeIndex {
  const boundaries = new Set<number>([0]);
  const clusters: { start: number; end: number }[] = [];
  let position = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    const length = segment.segment.length;
    clusters.push({ start: position, end: position + length });
    position += length;
    boundaries.add(position);
  }
  return { boundaries, clusters };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * 边界分类（B2 冻结无效类别的同一分类法）：
 * 1. 代理对中间（前码元为高代理、后码元为低代理）→ surrogate-split；
 * 2. 所在字素簇含 ZWJ（U+200D）→ emoji-split（ZWJ 序列被拆开）；
 * 3. 所在字素簇含扩展象形文字 → emoji-split（emoji 修饰/呈现序列）；
 * 4. 其余（基字符 + 组合标记等一般字素延续）→ combining-split。
 */
function classifyClusterSplit(
  text: string,
  offset: number,
  index: GraphemeIndex,
): "surrogate-split" | "combining-split" | "emoji-split" {
  const previousUnit = text.charCodeAt(offset - 1);
  const nextUnit = text.charCodeAt(offset);
  if (isHighSurrogate(previousUnit) && isLowSurrogate(nextUnit)) {
    return "surrogate-split";
  }
  const cluster = index.clusters.find((entry) => entry.start < offset && offset < entry.end);
  if (cluster === undefined) {
    return "combining-split"; // 防御性：非边界却无所在簇——按一般字素拆分拒绝
  }
  const clusterText = text.slice(cluster.start, cluster.end);
  if (clusterText.includes("\u200d")) {
    return "emoji-split";
  }
  for (const character of clusterText) {
    if (EXTENDED_PICTOGRAPHIC.test(character)) {
      return "emoji-split";
    }
  }
  return "combining-split";
}

/* ------------------------------------------------------------------ */
/* 解析器                                                              */
/* ------------------------------------------------------------------ */

export interface MaterialRangeResolverOptions {
  /** 版本真值来源（仓储即产品事实源；注入测试替身亦可）。 */
  readonly repository: MaterialRepository;
}

/** 版本 canonicalText 的 SHA-256（hex；与 material-repository 同口径）。 */
function hashCanonicalText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rejection(code: MaterialRangeRejectionCode, message: string): MaterialRangeRejection {
  return { code, message };
}

export class MaterialRangeResolver {
  readonly repository: MaterialRepository;
  readonly #graphemeCache = new Map<string, GraphemeIndex>();

  constructor(options: MaterialRangeResolverOptions) {
    this.repository = options.repository;
  }

  /** 图素簇索引（按文本内容缓存；版本不可变 ⇒ 内容寻址安全）。 */
  #graphemeIndex(text: string): GraphemeIndex {
    const cached = this.#graphemeCache.get(text);
    if (cached !== undefined) return cached;
    const index = buildGraphemeIndex(text);
    this.#graphemeCache.set(text, index);
    if (this.#graphemeCache.size > GRAPHEME_CACHE_LIMIT) {
      const oldest = this.#graphemeCache.keys().next().value;
      if (oldest !== undefined) this.#graphemeCache.delete(oldest);
    }
    return index;
  }

  /**
   * 解析选区：locator（或 utf16 区间）+ 期望摘录 → 规范选区，或稳定
   * 原因码拒绝。校验顺序见文件头（冻结契约）。引用错误（版本不存在/
   * 归属不符）抛 EntityNotFoundError / InvalidArgumentError；区间纪律
   * 全部以值返回（零误定位：绝不以“最近的相似文字”兜底成功）。
   */
  resolve(input: ResolveSelectionInput): MaterialRangeResolution {
    /* ---- 1. 版本真值加载（引用错误如实抛出） ---- */
    const content = this.repository.getVersionContent(input.versionId);
    if (input.materialId !== undefined && content.version.materialId !== input.materialId) {
      throw new InvalidArgumentError(
        `material version ${input.versionId} belongs to material ${content.version.materialId}, not ${input.materialId}`,
      );
    }
    const text = content.canonicalText;
    const verdict = this.#validate(input, text, content.blocks, content.version);
    if (!verdict.ok) {
      return { ok: false, rejection: verdict.rejection };
    }
    /* ---- 12. 成功：构造规范选区（切片/块/sourceHash 已全通过） ---- */
    const [start, end] = verdict.range;
    const block = this.#containingBlock(content.blocks, start, end)!; // 上方已判定包含
    const selection: MaterialSelection = {
      materialId: content.version.materialId,
      versionId: input.versionId,
      blockId: block.blockId,
      start,
      end,
      excerpt: text.slice(start, end),
      sourceHash: hashCanonicalText(text),
    };
    return { ok: true, result: { selection, block } };
  }

  /* ------------------------------ 内部：校验链 ------------------------------ */

  #validate(
    input: ResolveSelectionInput,
    text: string,
    blocks: readonly MaterialBlock[],
    version: { readonly parseStatus: string; readonly parseError: string | null },
  ): { readonly ok: true; readonly range: readonly [number, number] } | { readonly ok: false; readonly rejection: MaterialRangeRejection } {
    /* ---- 2. 非 ready 版本没有可锚定的规范文本 ---- */
    if (version.parseStatus !== "ready") {
      return {
        ok: false,
        rejection: rejection(
          "material-not-ready",
          `material version ${input.versionId} is not ready for anchoring (parse status '${version.parseStatus}'` +
            `${version.parseError === null ? "" : `: ${version.parseError}`}); unsupported or failed materials never present an empty ready document`,
        ),
      };
    }

    /* ---- 3. locator 形状 ---- */
    const locator = input.locator;
    if (typeof locator !== "object" || locator === null) {
      return { ok: false, rejection: rejection("invalid-locator", "locator must be an object {kind, ...}") };
    }
    if (locator.kind === "text-occurrence") {
      if (typeof locator.needle !== "string" || locator.needle.length === 0) {
        return {
          ok: false,
          rejection: rejection("invalid-locator", "text-occurrence locator requires a non-empty needle"),
        };
      }
      if (!Number.isInteger(locator.occurrence) || locator.occurrence < 1) {
        return {
          ok: false,
          rejection: rejection(
            "invalid-locator",
            `text-occurrence occurrence must be an integer >= 1 (got '${String(locator.occurrence)}')`,
          ),
        };
      }
    } else if (locator.kind === "utf16-range") {
      if (!Number.isInteger(locator.start) || !Number.isInteger(locator.end)) {
        return {
          ok: false,
          rejection: rejection(
            "invalid-locator",
            `utf16-range start/end must be integers (got '${String(locator.start)}'/'${String(locator.end)}')`,
          ),
        };
      }
    } else {
      return {
        ok: false,
        rejection: rejection("invalid-locator", `unknown locator kind '${String((locator as { kind?: unknown }).kind)}'`),
      };
    }

    /* ---- 4. 定位（text-occurrence 的第 N 次出现；+1 步进允许重叠） ---- */
    const range = this.#locatorRange(locator, text);
    if (range === null) {
      return {
        ok: false,
        rejection: rejection(
          "needle-not-found",
          `occurrence ${String((locator as { occurrence: number }).occurrence)} of the needle is not present in material version ${input.versionId}`,
        ),
      };
    }
    const [start, end] = range;

    /* ---- 5/6/7. 区间形状：越界 → 颠倒 → 零长度 ---- */
    if (start < 0 || end > text.length) {
      return {
        ok: false,
        rejection: rejection(
          "out-of-bounds",
          `selection [${start}, ${end}) is out of bounds for the version canonicalText (${text.length} UTF-16 units)`,
        ),
      };
    }
    if (end < start) {
      return {
        ok: false,
        rejection: rejection("reversed", `selection end ${end} is before start ${start} (half-open ranges must be ascending)`),
      };
    }
    if (end === start) {
      return {
        ok: false,
        rejection: rejection("zero-length", `selection [${start}, ${end}) is empty (zero-length selections have no excerpt)`),
      };
    }

    /* ---- 8. 摘录纪律（含 stale-version 跨版本判定） ---- */
    if (input.excerpt !== undefined) {
      const slice = text.slice(start, end);
      if (slice !== input.excerpt) {
        const stale = this.#staleRejection(input, start, end, input.excerpt, text);
        if (stale !== null) return { ok: false, rejection: stale };
        return {
          ok: false,
          rejection: rejection(
            "excerpt-mismatch",
            `the expected excerpt does not match material version ${input.versionId} at [${start}, ${end}) ` +
              "(anchor integrity violation; the resolver never falls back to similar text)",
          ),
        };
      }
    }

    /* ---- 9. UTF-16 边界安全（图素簇不拆分） ---- */
    const index = this.#graphemeIndex(text);
    for (const boundary of [start, end]) {
      if (boundary > 0 && boundary < text.length && !index.boundaries.has(boundary)) {
        const split = classifyClusterSplit(text, boundary, index);
        return {
          ok: false,
          rejection: rejection(
            split,
            `selection boundary ${boundary} splits a grapheme cluster of material version ${input.versionId} ` +
              `(${split}: user selections never cut a surrogate pair, a combining-mark sequence, or an emoji/ZWJ cluster in half)`,
          ),
        };
      }
    }

    /* ---- 10. 块归属：必须含于单块（pdf 跨页提示分段选择，不悄悄截断） ---- */
    const block = this.#containingBlock(blocks, start, end);
    if (block === null) {
      const kind = blocks[0]?.kind === "pdf-page" ? "cross-page" : "cross-block";
      return {
        ok: false,
        rejection: rejection(
          kind,
          kind === "cross-page"
            ? `selection [${start}, ${end}) crosses a page boundary of material version ${input.versionId}; select within one page (segmented selection), never a silent truncation`
            : `selection [${start}, ${end}) crosses a block boundary of material version ${input.versionId}; selections must stay within a single block`,
        ),
      };
    }

    /* ---- 11. 声明块复核 ---- */
    if (input.blockId !== undefined && input.blockId !== block.blockId) {
      const declaredExists = blocks.some((entry) => entry.blockId === input.blockId);
      return {
        ok: false,
        rejection: rejection(
          "block-mismatch",
          declaredExists
            ? `selection [${start}, ${end}) lies in block '${block.blockId}' but the anchor declares blockId '${input.blockId}' (block ownership mismatch)`
            : `the anchor declares blockId '${input.blockId}' which does not exist in material version ${input.versionId} (the selection lies in block '${block.blockId}')`,
        ),
      };
    }
    return { ok: true, range };
  }

  /**
   * stale-version 判定（文本同一性）：期望摘录与目标版本切片不等时，
   * 若摘录溯源到同材料的锚定版本、其同区间文本与摘录完全一致（且
   * sourceHash 如给出亦一致），则判 stale-version——锚点在旧版本完好、
   * 在目标版本失效；旧版本保持可读（版本不可变），锚点不迁移。
   * 判定不要求该区间在锚定版本上是完整合法选区（见文件头溯源说明）。
   */
  #staleRejection(
    input: ResolveSelectionInput,
    start: number,
    end: number,
    excerpt: string,
    targetText: string,
  ): MaterialRangeRejection | null {
    const anchor = input.anchor;
    if (anchor === undefined) return null;
    if (anchor.versionId === input.versionId) return null; // 版本对自身不构成 stale
    const anchorContent = this.repository.getVersionContent(anchor.versionId);
    const targetMaterialId = this.repository.getVersionContent(input.versionId).version.materialId;
    if (anchorContent.version.materialId !== targetMaterialId) {
      throw new InvalidArgumentError(
        `anchor provenance version ${anchor.versionId} belongs to material ${anchorContent.version.materialId}; ` +
          `stale-version detection only compares versions of the same material`,
      );
    }
    if (anchor.sourceHash !== undefined && anchor.sourceHash !== hashCanonicalText(anchorContent.canonicalText)) {
      throw new InvalidArgumentError(
        `anchor provenance sourceHash does not match material version ${anchor.versionId} canonicalText hash`,
      );
    }
    if (anchorContent.version.parseStatus !== "ready") return null; // 无法证实锚定文本 → 不判 stale
    const anchorText = anchorContent.canonicalText;
    if (start < 0 || end > anchorText.length) return null; // 区间不在锚定版本边界内 → 不判 stale
    if (anchorText.slice(start, end) !== excerpt) return null; // 锚定版本同区间文本与摘录不等 → 不判 stale
    const anchorBlockId = this.#containingBlock(
      anchorContent.blocks,
      start,
      end,
    )?.blockId; // 仅供诊断：锚定区间不必是完整选区
    const preview = JSON.stringify(targetText.slice(start, Math.min(end, targetText.length)).slice(0, 40));
    return rejection(
      "stale-version",
      `the anchor excerpt is intact on material version ${anchor.versionId}` +
        `${anchorBlockId === undefined ? "" : ` (block '${anchorBlockId}')`} but the text at [${start}, ${end}) ` +
        `changed in version ${input.versionId} (target slice starts ${preview}): the old version stays readable ` +
        "and the anchor is never migrated to similar text in the new version (charter D4 §3.1/§3.2)",
    );
  }

  /** locator → [start, end)（text-occurrence 未找到 → null；形状已由上方校验）。 */
  #locatorRange(locator: MaterialLocator, text: string): [number, number] | null {
    if (locator.kind === "utf16-range") {
      return [locator.start, locator.end];
    }
    let from = 0;
    let at = -1;
    for (let i = 0; i < locator.occurrence; i += 1) {
      at = text.indexOf(locator.needle, from);
      if (at === -1) return null;
      from = at + 1; // 与冻结探针同一语义：+1 步进，重叠出现计数
    }
    return [at, at + locator.needle.length];
  }

  /** 完整包含 [start, end) 的单块（连续覆盖 ⇒ 至多一块；无则 null）。 */
  #containingBlock(
    blocks: readonly MaterialBlock[],
    start: number,
    end: number,
  ): MaterialBlock | null {
    for (const block of blocks) {
      if (block.start <= start && end <= block.end) return block;
    }
    return null;
  }
}
