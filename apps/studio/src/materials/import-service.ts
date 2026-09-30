/**
 * MaterialImportService — D4-1「材料存储和导入」的导入编排 + 解析流水线
 * （issue #8 工作包 D4-1；D4 契约 §3 HTTP 语义 / §5 资源上限）。
 *
 * 职责（在已落地的 MaterialRepository + d4-md-v1/d4-pdf-v1 解析器之上）：
 *   - 导入：文件名扩展名 → 解析器种类（.md/.markdown → markdown；
 *     .pdf → pdf；其他 → 415 material-unsupported，如实说明，绝不伪成功）；
 *   - 上限（charter §5，在耗尽资源前明确拒绝）：
 *     · 单文件 20 MiB：读体/解析前拒绝（413 material-too-large）；
 *     · 规范文本 100 万 UTF-16 码元：解析后、落库前拒绝（版本 failed，
 *       原因码 text-units-exceeded——超限文本不落库、不外泄）；
 *     · 文本 PDF 200 页：pdf 解析器在解释任何内容流之前拒绝（原因码
 *       pages-exceeded，常量在 pdf-parser.ts 冻结、此处再导出共享）；
 *   - 版本语义（ADR-003 §3）：内容寻址 blob + UNIQUE(material_id,
 *     content_hash)——同材料同字节复用版本（200），新字节追加新版本（201），
 *     旧版本（及其锚点/摘录）永不受影响；导入端点按**树内**同字节去重
 *     （重导/双击返回既有 material+version，零新行）；
 *   - 异步解析流水线：导入即返回（版本 pending），任务 pending →
 *     parsing → ready | failed | canceled；解析器拒绝（invalid-utf8 等）
 *     → failed（原因码+说明入 parseError）；
 *   - 取消：pending/parsing 任务即刻呈 canceled；**迟到结果结构性丢弃**
 *     ——版本行的条件 UPDATE（parse_status IN ('pending','parsing')）保证
 *     已取消的版本不可能被迟到的解析结果复活或覆盖（数据库行仲裁竞争，
 *     任务面只做第一道短路）；迟到丢弃在任务面如实计数（不静默吞掉）；
 *   - 宿主中断恢复（与 TreeStudioService.recoverInterruptedRuns 同一
 *     纪律）：构造时把上次进程遗留的 pending/parsing 版本收敛为 failed
 *     （parse-interrupted），绝不留永远悬置的「幽灵解析中」；
 *   - 分块读取：canonicalText 按块分页（afterBlock 游标 + limit），
 *     仅 ready 版本可读（非 ready → 409 material-not-ready，不伪装空成功）。
 *
 * 诚实边界：默认注册表装配 markdown d4-md-v1 + pdf d4-pdf-v1（PDF 文字
 * 层解析器，apps/studio/src/materials/pdf-parser.ts——参考提取器
 * scripts/d4/pdf/extract.mjs 的应用侧移植，以 12 个冻结 fixture 真值为
 * 验收）。注入自定义 parsers 注册表时整体替换：缺位的种类在预检即被
 * 415 拒绝并说明 "not wired in this process"（绝无伪成功/伪就绪）。
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  IsoTimestamp,
  Material,
  MaterialBlock,
  MaterialId,
  MaterialParserKind,
  MaterialReadingPosition,
  MaterialVersion,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError, type MaterialRepository } from "@treeai/persistence";
import { MARKDOWN_PARSER_VERSION, parseMarkdownMaterial } from "./markdown-parser.ts";
import { DEFAULT_MAX_PAGES, PDF_PARSER_VERSION, parsePdfMaterial } from "./pdf-parser.ts";

/* ------------------------------------------------------------------ */
/* 冻结常量：上限与稳定原因码（charter §5 / D4 契约 §3）                */
/* ------------------------------------------------------------------ */

/** 单文件上限：20 MiB（charter §5；测试可经构造选项覆盖，缺省即冻结值）。 */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 单材料解析规范文本上限：100 万 UTF-16 码元（charter §5）。 */
export const DEFAULT_MAX_TEXT_UNITS = 1_000_000;

/** 超限原因码：规范文本超 100 万 UTF-16 码元（版本 failed 的原因码部分）。 */
export const TEXT_UNITS_EXCEEDED_REASON = "text-units-exceeded";

/**
 * 超限原因码：文本 PDF 超 200 页。pdf 解析器（d4-pdf-v1）在解释任何
 * 内容流之前按页树页数拒绝时使用本常量（常量定义在 pdf-parser.ts，
 * 此处再导出保持服务面稳定）；服务层把解析器给出的原因码原样入 parseError。
 */
export { PAGES_EXCEEDED_REASON } from "./pdf-parser.ts";

/** 文本 PDF 页数上限冻结值（charter §5；经 limits.maxPages 注入解析器）。 */
export { DEFAULT_MAX_PAGES } from "./pdf-parser.ts";

/** 宿主中断恢复的原因码（构造时收敛遗留 pending/parsing 版本）。 */
export const PARSE_INTERRUPTED_REASON = "parse-interrupted";

export interface MaterialImportLimits {
  /** 单文件字节上限（缺省 DEFAULT_MAX_FILE_BYTES = 20 MiB）。 */
  readonly maxFileBytes: number;
  /** 规范文本 UTF-16 码元上限（缺省 DEFAULT_MAX_TEXT_UNITS = 1,000,000）。 */
  readonly maxTextUnits: number;
  /** 文本 PDF 页数上限（缺省 DEFAULT_MAX_PAGES = 200；仅 pdf 解析器消费）。 */
  readonly maxPages: number;
}

/* ------------------------------------------------------------------ */
/* 解析器缝（MaterialParserKind → 解析器实例）                          */
/* ------------------------------------------------------------------ */

/**
 * 解析器统一产出：成功（canonicalText + 连续覆盖块图）或稳定拒绝
 * （原因码 + 说明——markdown 的 empty/invalid-utf8/nul-byte/
 * whitespace-only，pdf 的 pages-exceeded/无文字层等）。
 */
export type MaterialParserOutcome =
  | {
      readonly ok: true;
      readonly canonicalText: string;
      readonly blocks: readonly MaterialBlock[];
    }
  | {
      readonly ok: false;
      /** 稳定原因码（入 parseError 的前缀部分）。 */
      readonly reason: string;
      readonly message: string;
    };

/** 解析器缝：kind + 版本 + 纯函数式解析（可注入受控假解析器测试取消语义）。 */
export interface MaterialParser {
  readonly kind: MaterialParserKind;
  readonly parserVersion: string;
  parse(bytes: Uint8Array, context?: MaterialParseContext): Promise<MaterialParserOutcome>;
}

/**
 * 解析任务的运行参数（服务 → 解析器；markdown 解析器忽略页数上限）。
 * 页数上限由 pdf 解析器在解释任何内容流之前执行（charter §5：超限在
 * 耗尽资源前明确拒绝）。
 */
export interface MaterialParseContext {
  readonly maxPages: number;
}

/** d4-md-v1 解析器装配（同步纯函数 → MaterialParser 缝）。 */
export const D4_MD_V1_PARSER: MaterialParser = {
  kind: "markdown",
  parserVersion: MARKDOWN_PARSER_VERSION,
  parse(bytes: Uint8Array): Promise<MaterialParserOutcome> {
    const result = parseMarkdownMaterial(bytes);
    if (result.ok) {
      return Promise.resolve({
        ok: true,
        canonicalText: result.canonicalText,
        // 块文本是 canonicalText 的切片（派生量）：存块图不带 text，读取时切。
        blocks: result.blocks.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
        })),
      });
    }
    return Promise.resolve({ ok: false, reason: result.reason, message: result.message });
  },
};

/** d4-pdf-v1 解析器装配（同步纯函数 → MaterialParser 缝；页块带 1-based page）。 */
export const D4_PDF_V1_PARSER: MaterialParser = {
  kind: "pdf",
  parserVersion: PDF_PARSER_VERSION,
  parse(bytes: Uint8Array, context?: MaterialParseContext): Promise<MaterialParserOutcome> {
    const result = parsePdfMaterial(bytes, { maxPages: context?.maxPages });
    if (result.ok) {
      return Promise.resolve({
        ok: true,
        canonicalText: result.canonicalText,
        // pdf-page 块的 page 字段随块图入库（D4-2 阅读器按页渲染所需）。
        blocks: result.blocks.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
          page: block.page,
        })),
      });
    }
    return Promise.resolve({ ok: false, reason: result.reason, message: result.message });
  },
};

/**
 * 默认解析器注册表（按 MaterialParserKind）：markdown = d4-md-v1，
 * pdf = d4-pdf-v1（PDF 文字层解析器随本工作包装配）。注入自定义
 * `parsers` 时**整体替换**注册表——缺哪个种类，该扩展名导入即被
 * 415 诚实拒绝（`the 'X' parser is not wired in this process`），
 * 绝无伪成功/伪就绪。
 */
const DEFAULT_PARSERS: Readonly<Partial<Record<MaterialParserKind, MaterialParser>>> = {
  markdown: D4_MD_V1_PARSER,
  pdf: D4_PDF_V1_PARSER,
};

/* ------------------------------------------------------------------ */
/* 错误（HTTP 层映射见 server.ts：415/413/409）                         */
/* ------------------------------------------------------------------ */

/** 不支持的材料（扩展名未知 / 解析器未装配）→ 415 material-unsupported。 */
export class MaterialUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialUnsupportedError";
  }
}

/** 超过单文件上限（charter §5：解析前拒绝）→ 413 material-too-large。 */
export class MaterialTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxFileBytes: number;

  constructor(sizeBytes: number, maxFileBytes: number) {
    super(
      `the material is ${sizeBytes} bytes, exceeding the ${maxFileBytes}-byte single-file limit ` +
        "(rejected before parsing; charter D4 §5)",
    );
    this.name = "MaterialTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxFileBytes = maxFileBytes;
  }
}

/** 非 ready 版本的分块读取（或建枝前置）→ 409 material-not-ready。 */
export class MaterialNotReadyError extends Error {
  readonly versionId: MaterialVersionId;
  readonly parseStatus: string;

  constructor(version: MaterialVersion) {
    super(
      `material version ${version.id} is not ready for reading (parse status '${version.parseStatus}'` +
        `${version.parseError === null ? "" : `: ${version.parseError}`}); ` +
        "unsupported/failed/canceled materials are never presented as empty ready documents",
    );
    this.name = "MaterialNotReadyError";
    this.versionId = version.id;
    this.parseStatus = version.parseStatus;
  }
}

/** 取消目标不可取消（已终态：ready/failed/canceled）→ 409。 */
export class ParseTaskNotCancelableError extends Error {
  readonly taskId: string;
  readonly state: string;

  constructor(taskId: string, state: string) {
    super(
      `parse task ${taskId} is already terminal ('${state}'); only pending or parsing tasks can be canceled`,
    );
    this.name = "ParseTaskNotCancelableError";
    this.taskId = taskId;
    this.state = state;
  }
}

/* ------------------------------------------------------------------ */
/* 读模型形状（服务 → HTTP）                                            */
/* ------------------------------------------------------------------ */

/** 导入结果：201（created）新 material+version；200（复用）既有行零新写入。 */
export interface MaterialImportResult {
  readonly material: Material;
  readonly version: MaterialVersion;
  readonly created: boolean;
  /** 本次导入发起的解析任务 id（复用/未发起为 null）。 */
  readonly parseTaskId: string | null;
}

/** 分块读取页（契约 §3：{blocks:[{block,text}], nextAfterBlock, textUnits}）。 */
export interface MaterialVersionPage {
  readonly blocks: readonly { readonly block: MaterialBlock; readonly text: string }[];
  /** 下一页游标（下一页 ?afterBlock= 值）；已读尽为 null。 */
  readonly nextAfterBlock: string | null;
  readonly textUnits: number;
}

/** 解析任务的安全投影（进程内瞬态；迟到丢弃如实可见）。 */
export interface MaterialParseTaskView {
  readonly taskId: string;
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly parserKind: MaterialParserKind;
  readonly parserVersion: string;
  readonly createdAt: IsoTimestamp;
  readonly state: "pending" | "parsing" | "ready" | "failed" | "canceled";
  readonly parseError: string | null;
  /** 取消后到达（并被丢弃）的迟到结果计数（0/1）。 */
  readonly lateResultDiscarded: boolean;
}

export interface MaterialListItem {
  readonly material: Material;
  readonly versions: readonly MaterialVersion[];
}

export interface MaterialDetailView {
  readonly material: Material;
  readonly versions: readonly MaterialVersion[];
  /** 该树 × 材料的持久化阅读位置（无则 null）。 */
  readonly readingPosition: MaterialReadingPosition | null;
  /** 近期解析任务投影（最新在后；进程重启后为空——任务不跨进程）。 */
  readonly parseTasks: readonly MaterialParseTaskView[];
}

export interface ImportMaterialInput {
  /** 原始文件名（x-treeai-filename 解码后；作为初始显示名，不是身份）。 */
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* 种类判定（文件名扩展名 → MaterialParserKind）                        */
/* ------------------------------------------------------------------ */

const EXTENSION_KINDS: Readonly<Record<string, MaterialParserKind>> = {
  md: "markdown",
  markdown: "markdown",
  pdf: "pdf",
};

/**
 * 扩展名 → 解析器种类（大小写不敏感）。无扩展名/未知扩展名 →
 * MaterialUnsupportedError（415，消息指明扩展名与支持集合）。
 */
export function detectMaterialParserKind(filename: string): MaterialParserKind {
  const dot = filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  const kind = EXTENSION_KINDS[extension];
  if (kind === undefined) {
    throw new MaterialUnsupportedError(
      `cannot import '${filename}': the '${dot < 0 ? "" : `.${extension}`}' extension is not a supported material kind ` +
        "(supported: .md and .markdown → markdown, .pdf → pdf)",
    );
  }
  return kind;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 分块读取的默认/最大页大小（块数；与 journal 投影同一量级约定）。 */
export const DEFAULT_BLOCK_PAGE_LIMIT = 50;
export const MAX_BLOCK_PAGE_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export interface MaterialImportServiceOptions {
  readonly repository: MaterialRepository;
  /** 解析器注册表（缺省 markdown d4-md-v1 + pdf d4-pdf-v1，见 DEFAULT_PARSERS 注释）。 */
  readonly parsers?: Readonly<Partial<Record<MaterialParserKind, MaterialParser>>>;
  /** 上限覆盖（测试注入小限额用；缺省 20 MiB / 1,000,000 units / 200 pages）。 */
  readonly limits?: Partial<MaterialImportLimits>;
  readonly now?: () => IsoTimestamp;
  readonly generateTaskId?: () => string;
}

/** 进程内解析任务簿记（瞬态；持久事实在 material_versions 行）。 */
interface ParseTaskRecord {
  readonly taskId: string;
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly parserKind: MaterialParserKind;
  readonly parserVersion: string;
  readonly createdAt: IsoTimestamp;
  state: "pending" | "parsing" | "ready" | "failed" | "canceled";
  parseError: string | null;
  lateResultDiscarded: boolean;
}

export class MaterialImportService {
  readonly repository: MaterialRepository;
  readonly limits: MaterialImportLimits;
  readonly #parsers: ReadonlyMap<MaterialParserKind, MaterialParser>;
  readonly #tasks = new Map<string, ParseTaskRecord>();
  readonly #taskOrder: string[] = [];
  /** 迟到结果丢弃计数（进程内；诚实成本口径，与术语执行器同纪律）。 */
  #lateResultsDiscarded = 0;
  readonly #now: () => IsoTimestamp;
  readonly #generateTaskId: () => string;

  constructor(options: MaterialImportServiceOptions) {
    this.repository = options.repository;
    const maxFileBytes = options.limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTextUnits = options.limits?.maxTextUnits ?? DEFAULT_MAX_TEXT_UNITS;
    const maxPages = options.limits?.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new InvalidArgumentError("limits.maxFileBytes must be a positive integer");
    }
    if (!Number.isInteger(maxTextUnits) || maxTextUnits < 1) {
      throw new InvalidArgumentError("limits.maxTextUnits must be a positive integer");
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new InvalidArgumentError("limits.maxPages must be a positive integer");
    }
    this.limits = { maxFileBytes, maxTextUnits, maxPages };
    const registryEntries = Object.entries(options.parsers ?? DEFAULT_PARSERS).filter(
      (entry): entry is [string, MaterialParser] => entry[1] !== undefined,
    );
    this.#parsers = new Map(registryEntries.map(([kind, parser]) => [kind as MaterialParserKind, parser]));
    this.#now = options.now ?? ((): IsoTimestamp => new Date().toISOString());
    this.#generateTaskId =
      options.generateTaskId ?? ((): string => `mat-task-${randomUUID().slice(0, 8)}`);
    // 宿主中断恢复（I6 同纪律）：上次进程遗留的 pending/parsing 版本收敛为
    // failed——解析任务是进程内状态，重启后不可续；如实失败优于永远悬置。
    this.repository.failNonTerminalParseVersions(
      `${PARSE_INTERRUPTED_REASON}: the host process exited before parsing completed`,
    );
  }

  /* ------------------------------ 预检 ------------------------------ */

  /**
   * 导入预检（HTTP 层在读取请求体之前调用，使 404/415 无需先吞下整个 body）：
   * 树存在（404）+ 扩展名可判定（415）+ 解析器已装配（415——自定义注册表
   * 缺位种类时如实拒绝）。
   */
  precheckImport(treeId: TreeId, filename: string): {
    readonly parserKind: MaterialParserKind;
    readonly parserVersion: string;
  } {
    this.#assertTree(treeId);
    const parser = this.#resolveParserFor(filename);
    return { parserKind: parser.kind, parserVersion: parser.parserVersion };
  }

  /* ------------------------------ 导入 ------------------------------ */

  /**
   * 导入新材料（POST /api/trees/:treeId/materials）。
   *
   * - 校验顺序（在读取/解析/存储任何资源之前依次拒绝）：树（404）→
   *   文件名/种类（400/415）→ 解析器装配（415）→ 空体（400）→
   *   单文件上限（413）；
   * - 树内同字节去重：任一已链接材料已有同 contentHash + parserKind 的版本
   *   → 复用返回（created=false，零新行——重导/双击幂等）；
   * - 新导入：单事务建 material（title=文件名，仅显示名）+ pending 版本 +
   *   树链接，随后发起异步解析任务（响应即返回，版本 pending）。
   */
  async importMaterial(treeId: TreeId, input: ImportMaterialInput): Promise<MaterialImportResult> {
    const parser = this.#validateImport(treeId, input);
    const contentHash = sha256Hex(input.bytes);
    const reuse = this.#findTreeReusableVersion(treeId, contentHash, parser.kind);
    if (reuse !== null) {
      return { ...reuse, created: false, parseTaskId: null };
    }
    const { material, version } = this.repository.transaction(() => {
      const created = this.repository.createMaterial({ title: input.filename });
      const pending = this.repository.insertVersion({
        materialId: created.id,
        bytes: input.bytes,
        parserKind: parser.kind,
        parserVersion: parser.parserVersion,
        parseStatus: "pending",
        canonicalText: "",
        blocks: [],
      });
      this.repository.linkTreeMaterial(treeId, created.id);
      return { material: created, version: pending };
    });
    const taskId = this.#startParseTask(treeId, material, version, input.bytes, parser);
    return { material, version: this.#freshVersion(version), created: true, parseTaskId: taskId };
  }

  /**
   * 为既有材料追加新版本（POST …/materials/:materialId/versions）。
   * 语义同导入（同字节复用 200 / 新字节 201 / 413 / 415）；材料必须存在
   * 且已链接到该树（404）。版本链只追加：旧版本及其锚点永不受影响。
   */
  async addMaterialVersion(
    treeId: TreeId,
    materialId: MaterialId,
    input: ImportMaterialInput,
  ): Promise<MaterialImportResult> {
    const parser = this.#validateImport(treeId, input);
    const material = this.#findTreeMaterial(treeId, materialId);
    const contentHash = sha256Hex(input.bytes);
    const existing = this.repository
      .listVersions(materialId)
      .find((version) => version.contentHash === contentHash);
    if (existing !== undefined) {
      return { material, version: existing, created: false, parseTaskId: null };
    }
    const version = this.repository.insertVersion({
      materialId,
      bytes: input.bytes,
      parserKind: parser.kind,
      parserVersion: parser.parserVersion,
      parseStatus: "pending",
      canonicalText: "",
      blocks: [],
    });
    const taskId = this.#startParseTask(treeId, material, version, input.bytes, parser);
    return { material, version: this.#freshVersion(version), created: true, parseTaskId: taskId };
  }

  /* ------------------------------ 读取面 ------------------------------ */

  /** 树内材料列表（含各版本与状态；链接序）。 */
  listTreeMaterials(treeId: TreeId): readonly MaterialListItem[] {
    this.#assertTree(treeId);
    return this.repository.listTreeMaterials(treeId).map((material) => ({
      material,
      versions: this.repository.listVersions(material.id),
    }));
  }

  /** 材料详情（版本链 + 阅读位置 + 近期解析任务）。 */
  getMaterialDetail(treeId: TreeId, materialId: MaterialId): MaterialDetailView {
    this.#assertTree(treeId);
    const material = this.#findTreeMaterial(treeId, materialId);
    return {
      material,
      versions: this.repository.listVersions(materialId),
      readingPosition: this.repository.findReadingPosition(treeId, materialId),
      parseTasks: this.listParseTasksForMaterial(materialId),
    };
  }

  /**
   * canonicalText 分块读取（契约 §3）：afterBlock 游标（缺省从头）+ limit
   * 块（缺省 50，1..500）。仅 ready 版本可读——非 ready 抛
   * MaterialNotReadyError（409：不支持/失败/取消绝不伪装成空成功文档）。
   */
  readVersionBlocks(
    treeId: TreeId,
    materialId: MaterialId,
    versionId: MaterialVersionId,
    query: { readonly afterBlock?: string | null; readonly limit?: number } = {},
  ): MaterialVersionPage {
    this.#assertTree(treeId);
    this.#findTreeMaterial(treeId, materialId);
    const content = this.repository.getVersionContent(versionId); // 未知版本 → 404
    if (content.version.materialId !== materialId) {
      throw new InvalidArgumentError(
        `material version ${versionId} belongs to material ${content.version.materialId}, not ${materialId}`,
      );
    }
    if (content.version.parseStatus !== "ready") {
      throw new MaterialNotReadyError(content.version);
    }
    let startIndex = 0;
    const afterBlock = query.afterBlock ?? null;
    if (afterBlock !== null && afterBlock !== "") {
      const index = content.blocks.findIndex((block) => block.blockId === afterBlock);
      if (index < 0) {
        throw new InvalidArgumentError(
          `afterBlock '${afterBlock}' does not exist in material version ${versionId}`,
        );
      }
      startIndex = index + 1;
    }
    let limit = DEFAULT_BLOCK_PAGE_LIMIT;
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_BLOCK_PAGE_LIMIT) {
        throw new InvalidArgumentError(
          `limit must be an integer between 1 and ${MAX_BLOCK_PAGE_LIMIT} (got '${String(query.limit)}')`,
        );
      }
      limit = query.limit;
    }
    const slice = content.blocks.slice(startIndex, startIndex + limit);
    const moreBlocks = startIndex + limit < content.blocks.length;
    return {
      blocks: slice.map((block) => ({
        block,
        text: content.canonicalText.slice(block.start, block.end),
      })),
      nextAfterBlock: moreBlocks && slice.length > 0 ? slice[slice.length - 1]!.blockId : null,
      textUnits: content.canonicalText.length,
    };
  }

  /* ------------------------------ 解析任务 ------------------------------ */

  /**
   * 取消解析任务（POST …/parse-tasks/:taskId/cancel）。pending/parsing →
   * canceled（200）；已终态（ready/failed/canceled）→ 409。
   *
   * **迟到结果不挂靠（机制）**：取消与解析完成是两个竞争的条件 UPDATE，
   * 都以 `WHERE parse_status IN ('pending','parsing')` 为守卫、由数据库行
   * 仲裁——先落库者赢；取消先落库后，迟到的 ready/failed 迁移必然改零行
   * （updateVersionParseResult 返回 null），服务层据此丢弃并计数。任务面
   * 的 state 检查只是第一道短路；即便绕过它，行级守卫仍结构性拒绝。
   */
  cancelParseTask(taskId: string, materialId?: MaterialId): MaterialParseTaskView {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new EntityNotFoundError("material parse task", taskId);
    }
    if (materialId !== undefined && task.materialId !== materialId) {
      throw new EntityNotFoundError("material parse task", `${taskId} (material ${materialId})`);
    }
    if (task.state !== "pending" && task.state !== "parsing") {
      throw new ParseTaskNotCancelableError(task.taskId, task.state);
    }
    const updated = this.repository.updateVersionParseResult({
      versionId: task.versionId,
      parseStatus: "canceled",
      canonicalText: "",
      blocks: [],
    });
    if (updated === null) {
      // 解析结果先落库（竞争判负）：对齐任务面后按不可取消拒绝。
      const current = this.repository.findVersion(task.versionId);
      if (current !== null) {
        task.state = this.#taskStateOf(current.parseStatus);
        task.parseError = current.parseError;
      }
      throw new ParseTaskNotCancelableError(task.taskId, task.state);
    }
    task.state = "canceled";
    task.parseError = null;
    return this.#taskView(task);
  }

  /** 单任务投影（无则 null；进程内瞬态）。 */
  getParseTask(taskId: string): MaterialParseTaskView | null {
    const task = this.#tasks.get(taskId);
    return task === undefined ? null : this.#taskView(task);
  }

  /** 材料的近期解析任务（最新在后）。 */
  listParseTasksForMaterial(materialId: MaterialId): readonly MaterialParseTaskView[] {
    return this.#taskOrder
      .map((id) => this.#tasks.get(id))
      .filter((task): task is ParseTaskRecord => task !== undefined && task.materialId === materialId)
      .map((task) => this.#taskView(task));
  }

  /** 迟到结果丢弃计数（进程内诚实成本口径）。 */
  get lateResultsDiscarded(): number {
    return this.#lateResultsDiscarded;
  }

  #taskStateOf(status: MaterialVersion["parseStatus"]): ParseTaskRecord["state"] {
    if (status === "ready" || status === "failed" || status === "canceled") return status;
    // pending/parsing/unsupported/rejected：unsupported/rejected 不会出现在
    // 解析任务版本上（导入即拒，不入库）；防御性回落 parsing。
    return "parsing";
  }

  #taskView(task: ParseTaskRecord): MaterialParseTaskView {
    return {
      taskId: task.taskId,
      treeId: task.treeId,
      materialId: task.materialId,
      versionId: task.versionId,
      parserKind: task.parserKind,
      parserVersion: task.parserVersion,
      createdAt: task.createdAt,
      state: task.state,
      parseError: task.parseError,
      lateResultDiscarded: task.lateResultDiscarded,
    };
  }

  /* ------------------------------ 阅读位置 ------------------------------ */

  /**
   * 持久化阅读位置（PUT …/reading-position → 204）。校验/UPSERT 归仓储
   * （blockId 必须存在于版本块图、focusStart 须落块内且随 blockId 给出）。
   */
  upsertReadingPosition(
    treeId: TreeId,
    materialId: MaterialId,
    input: {
      readonly versionId: MaterialVersionId;
      readonly blockId?: string | null;
      readonly focusStart?: number | null;
    },
  ): MaterialReadingPosition {
    this.#assertTree(treeId);
    this.#findTreeMaterial(treeId, materialId);
    return this.repository.upsertReadingPosition({
      treeId,
      materialId,
      versionId: input.versionId,
      blockId: input.blockId ?? null,
      focusStart: input.focusStart ?? null,
    });
  }

  /**
   * 读取持久化阅读位置（GET …/reading-position → 200 {readingPosition|null}；
   * D4-2 读取面）。阅读位置按 Tree×材料持久化（charter §3.2「原文阅读与
   * 分支探索各自保留位置」的阅读侧；探索位置是分支自身的产品事实，另一
   * 存储，互不覆盖）。
   */
  getReadingPosition(treeId: TreeId, materialId: MaterialId): MaterialReadingPosition | null {
    this.#assertTree(treeId);
    this.#findTreeMaterial(treeId, materialId);
    return this.repository.findReadingPosition(treeId, materialId);
  }

  /* ------------------------------ 内部：校验 ------------------------------ */

  #assertTree(treeId: TreeId): void {
    if (!this.repository.hasTree(treeId)) {
      throw new EntityNotFoundError("tree", treeId);
    }
  }

  /** 树内已链接材料（404：材料不存在或未链接到该树——路由按树作用域解析）。 */
  #findTreeMaterial(treeId: TreeId, materialId: MaterialId): Material {
    const linked = this.repository
      .listTreeMaterials(treeId)
      .find((material) => material.id === materialId);
    if (linked === undefined) {
      throw new EntityNotFoundError(`material in tree ${treeId}`, materialId);
    }
    return linked;
  }

  #resolveParserFor(filename: string): MaterialParser {
    const kind = detectMaterialParserKind(filename);
    const parser = this.#parsers.get(kind);
    if (parser === undefined) {
      throw new MaterialUnsupportedError(
        `the '${kind}' parser is not wired in this process ` +
          "(the default registry carries markdown d4-md-v1 + pdf d4-pdf-v1; a custom parsers registry that omits this kind is honestly rejected)",
      );
    }
    return parser;
  }

  /** 导入统一校验（顺序即拒绝优先级；全部发生在存储/解析之前）。 */
  #validateImport(treeId: TreeId, input: ImportMaterialInput): MaterialParser {
    this.#assertTree(treeId);
    if (typeof input.filename !== "string" || input.filename.trim().length === 0) {
      throw new InvalidArgumentError("material filename must be a non-empty string");
    }
    const parser = this.#resolveParserFor(input.filename);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new InvalidArgumentError("material bytes must be a non-empty Uint8Array");
    }
    if (input.bytes.byteLength > this.limits.maxFileBytes) {
      throw new MaterialTooLargeError(input.bytes.byteLength, this.limits.maxFileBytes);
    }
    return parser;
  }

  /** 树内同字节复用：任一已链接材料已有同 contentHash + parserKind 的版本。 */
  #findTreeReusableVersion(
    treeId: TreeId,
    contentHash: string,
    parserKind: MaterialParserKind,
  ): { readonly material: Material; readonly version: MaterialVersion } | null {
    for (const material of this.repository.listTreeMaterials(treeId)) {
      for (const version of this.repository.listVersions(material.id)) {
        if (version.contentHash === contentHash && version.parserKind === parserKind) {
          return { material, version };
        }
      }
    }
    return null;
  }

  /* ------------------------------ 内部：解析流水线 ------------------------------ */

  #startParseTask(
    treeId: TreeId,
    material: Material,
    version: MaterialVersion,
    bytes: Uint8Array,
    parser: MaterialParser,
  ): string {
    const task: ParseTaskRecord = {
      taskId: this.#generateTaskId(),
      treeId,
      materialId: material.id,
      versionId: version.id,
      parserKind: parser.kind,
      parserVersion: parser.parserVersion,
      createdAt: this.#now(),
      state: "pending",
      parseError: null,
      lateResultDiscarded: false,
    };
    this.#tasks.set(task.taskId, task);
    this.#taskOrder.push(task.taskId);
    void this.#runParseTask(task, bytes, parser).catch(() => undefined);
    return task.taskId;
  }

  /**
   * 解析任务主体：pending → parsing →（解析）→ ready | failed；取消后到达
   * 的结果**迟到丢弃**（任务面短路 + 行级条件 UPDATE 双守卫，见
   * cancelParseTask）。意外错误（DB/驱动）如实落 failed（parse-internal）。
   */
  async #runParseTask(
    task: ParseTaskRecord,
    bytes: Uint8Array,
    parser: MaterialParser,
  ): Promise<void> {
    try {
      const parsing = this.repository.updateVersionParseResult({
        versionId: task.versionId,
        parseStatus: "parsing",
        canonicalText: "",
        blocks: [],
      });
      if (parsing === null) {
        this.#recordLateDiscard(task);
        return;
      }
      task.state = "parsing";
      // 页数上限随上下文交给解析器（pdf 在解释内容流前执行；md 忽略）。
      let outcome = await parser.parse(bytes, { maxPages: this.limits.maxPages });
      // 取消可能发生在解析在途期间（cancelParseTask 同步改写 task.state；
      // 经方法读取避免控制流窄化掩盖该交错）。
      if (this.#isCanceled(task)) {
        // 取消已先行落库：迟到结果丢弃（不挂靠、不复活、如实计数）。
        this.#recordLateDiscard(task);
        return;
      }
      // 规范文本上限（charter §5）：解析产物超限 → failed，超限文本不落库。
      // （解析内存由 20 MiB 文件上限约束；此处拒绝发生在任何持久化之前。）
      if (outcome.ok && outcome.canonicalText.length > this.limits.maxTextUnits) {
        outcome = {
          ok: false,
          reason: TEXT_UNITS_EXCEEDED_REASON,
          message:
            `the canonical text is ${outcome.canonicalText.length} UTF-16 units, exceeding the ` +
            `${this.limits.maxTextUnits}-unit limit (rejected before persistence; charter D4 §5)`,
        };
      }
      if (outcome.ok) {
        const ready = this.repository.updateVersionParseResult({
          versionId: task.versionId,
          parseStatus: "ready",
          canonicalText: outcome.canonicalText,
          blocks: outcome.blocks,
        });
        if (ready === null) {
          this.#recordLateDiscard(task);
          return;
        }
        task.state = "ready";
        return;
      }
      const parseError = `${outcome.reason}: ${outcome.message}`;
      const failed = this.repository.updateVersionParseResult({
        versionId: task.versionId,
        parseStatus: "failed",
        parseError,
        canonicalText: "",
        blocks: [],
      });
      if (failed === null) {
        this.#recordLateDiscard(task);
        return;
      }
      task.state = "failed";
      task.parseError = parseError;
    } catch (error) {
      // 意外错误（仓储/驱动/解析器异常）：如实落 failed；连仓储都不可写时
      // 只在任务面留下失败（绝不伪就绪）。
      const parseError = `parse-internal: ${error instanceof Error ? error.message : String(error)}`;
      try {
        this.repository.updateVersionParseResult({
          versionId: task.versionId,
          parseStatus: "failed",
          parseError,
          canonicalText: "",
          blocks: [],
        });
        task.parseError = parseError;
      } catch {
        /* 仓储已关闭/损坏：内存任务面如实 failed */
      }
      task.state = "failed";
    }
  }

  #recordLateDiscard(task: ParseTaskRecord): void {
    task.lateResultDiscarded = true;
    this.#lateResultsDiscarded += 1;
  }

  /** 任务是否已被取消（方法读取——取消与解析完成可交错，控制流窄化不可信）。 */
  #isCanceled(task: ParseTaskRecord): boolean {
    return task.state === "canceled";
  }

  /**
   * 响应用的最新版本行：解析任务在 import 返回前已同步推进到 parsing
   * （parse 恒为异步），重读一次让响应携带真实当前状态而非过期快照。
   */
  #freshVersion(version: MaterialVersion): MaterialVersion {
    return this.repository.findVersion(version.id) ?? version;
  }
}
