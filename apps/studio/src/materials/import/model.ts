/** model ownership for import-service.ts; compatibility entrypoint remains one level above. */
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
import type {
  MaterialRepository,
} from "@treeai/persistence";

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

export interface MaterialParseExecution {
  readonly promise: Promise<MaterialParserOutcome>;
  cancel(): void;
}

export interface MaterialParseExecutor {
  start(
    parser: MaterialParser,
    bytes: Uint8Array,
    context: MaterialParseContext,
  ): MaterialParseExecution;
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
  /** Optional executor injection for deterministic parser seam tests. */
  readonly parseExecutor?: MaterialParseExecutor;
}

/** 进程内解析任务簿记（瞬态；持久事实在 material_versions 行）。 */
export interface ParseTaskRecord {
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
