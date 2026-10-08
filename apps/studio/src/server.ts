/**
 * Studio HTTP 面（node:http，零新增依赖）。
 *
 * JSON API + 静态页面（public/）+ SSE 事件流（P1）。所有写路径返回更新后
 * 的完整树状态，让最小 UI 无需本地状态同步逻辑。
 *
 * 错误映射：EntityNotFoundError → 404；InvalidArgumentError/
 * ConstraintViolationError → 400；RunNotActiveError/ReturnConflictError
 * （同幂等键不同内容）/NewExplorationConflictError（新探索前置条件不满足）
 * /契约违规（如并发 prompt，TypeError）/用户中止（TreeAIError code
 * "user-abort"）→ 409；其余运行期 TreeAIError → 502
 * （上游失败）；PersistenceError → 500；其余 → 500。
 *
 * POST /api/trees/:id/branches/:branchId/source —— 锚点揭示（signed v3
 * §1.2：来源定位与 Pi 游标对齐分离）：source 为纯产品定位（status 三态 +
 * selection 快照，与 session 可用性无关），source.navigation 为
 * status==="available" 时对 Pi 游标的独立对齐结果（navigated / failed+code
 * +message——失败不降格来源状态，数据库原文照常可定位高亮）。
 *
 * POST /api/trees/:id/branches/:branchId/new-exploration —— 用户显式确认的
 * 「以保存内容开始新的探索」（signed v3 §4.4）：body {text}；200 =
 * {outcome, state}（新 session 首问完成，保存内容已作为上下文带入）；
 * 409 new-exploration-conflict = 前置条件不满足（session 仍可用 / 无历史
 * session）；400 = 空文本。
 *
 * POST /api/trees/:id/return 幂等语义（保存先于导航，signed W1 v3.0
 * §3.5）：新建 Return → 201；同 idempotencyKey 同内容重放 → 200（同一
 * returnTurn，零新写入）；同键不同内容 → 409 return-conflict。两种成功
 * 均返回 {returnTurn, navigation, state}——navigation 为保存后回程导航
 * 的结果（navigated / no-session / failed+code+message）：导航失败不是
 * HTTP 错误（Return 已保存），客户端按「已保存，返回主线失败」分开呈现；
 * 主干尚无 session 时仍照常保存（navigation "no-session"）。
 *
 * GET /api/trees/:id/events —— SSE（text/event-stream, no-store）：
 * 连接即发送 snapshot 事件（当前 getTreeDiagnostics 投影），随后转发该
 * 树的安全 UI 事件（按事件类型命名）；~15s 心跳注释行；客户端断开
 * （req close）即退订。未知树 → 404 JSON（切流之前）。事件词汇表
 * （payload 即 service.ts StudioEvent）：
 *   - snapshot        {…TreeDiagnostics}
 *   - run-started     {treeId, branchId, episodeId, runId}
 *   - message-delta   {treeId, runId, delta}
 *   - abort-requested {treeId, runId}
 *   - run-terminal    {treeId, runId, state, failure|null}
 *   - tool-activity   {treeId, runId, tool|null, phase, decision?}
 *     （phase: started|finished|denied；denied 时 decision 携带
 *      {outcome, reason, ruleId} 策略 provenance——参数/路径/命令绝不出境）
 * SSE 是瞬态推送：连接只过滤转发，不落任何状态；/state 与 /diagnostics
 * 仍是权威读模型。
 *
 * GET /api/trees/:id/journal?limit=N —— journal 保守投影（P1 来源抽屉）：
 * {events: [{eventId, runId, seq, occurredAt, type, summary}]}，按写入顺序
 * （最新在后）；limit 缺省 50、须为 1..500 的整数（否则 400）。未知树 →
 * 404。未注入 journal → 空列表（诚实空态）。
 *
 * 材料 API（issue #8 D4-1，契约 §3；未注入 materials 服务 → 503 如实说明）：
 *   POST /api/trees/:id/materials —— 导入：原始字节 body（本地 loopback，
 *   无 multipart 依赖），文件名经 x-treeai-filename 头（UTF-8 百分号编码）。
 *   201 {material, version, created, parseTaskId} 新建；同字节重导 200（树内
 *   复用既有 material+version，零新行）；超限 413 material-too-large（读体
 *   时即拒绝，内存有界）；不支持 415 material-unsupported（未知扩展名，或
 *   D4-1 集成前的 .pdf——detail 如实说明，绝不伪成功）。导入即返回，版本
 *   由异步解析任务推进 pending → parsing → ready|failed|canceled。
 *   GET  /api/trees/:id/materials —— 列表（{materials:[{material, versions}]}）。
 *   GET  /api/trees/:id/materials/:materialId —— 详情（版本链 + 阅读位置 +
 *   近期解析任务）。
 *   POST …/materials/:materialId/versions —— 新版本（同语义/同返回码）。
 *   GET  …/materials/:materialId/versions/:versionId?afterBlock=&limit= ——
 *   canonicalText 分块读取：{blocks:[{block, text}], nextAfterBlock, textUnits}
 *   （缺省从头、limit 缺省 50，1..500；afterBlock 为块游标，读尽
 *   nextAfterBlock=null）。仅 ready 版本可读：非 ready → 409
 *   material-not-ready（不支持/失败/取消绝不伪装成空成功文档）。
 *   POST …/materials/:materialId/parse-tasks/:taskId/cancel —— 取消解析：
 *   200 canceled；已终态 409 parse-task-not-cancelable；treeId 参与作用域
 *   校验——树不存在/任务不属该树/材料未链接该树统一 404（issue #8 P1）。
 *   迟到结果结构性
 *   丢弃（版本行条件 UPDATE 由数据库仲裁，不可能复活/覆盖已取消状态）。
 *   PUT  …/materials/:materialId/reading-position —— 持久化阅读位置
 *   （{versionId, blockId?, focusStart?}；校验失败 400）→ 204 无 body。
 *
 * 材料阅读与来源定位 API（issue #8 D4-2，契约 §3 + D4-2 落地增量）：
 *   GET  …/materials/:materialId/reading-position —— 读取持久化阅读位置
 *   → 200 {readingPosition: MaterialReadingPosition | null}。阅读位置按
 *   Tree×材料持久化（charter §3.2 阅读侧）；分支探索位置是分支自身的
 *   产品事实（runs/turns），两者各自保留、互不覆盖。
 *   POST …/materials/:materialId/versions/:versionId/resolve-selection
 *   —— 统一区间/锚点解析：body {locator:{kind:"utf16-range"|"text-
 *   occurrence", …}, excerpt?, blockId?, anchor?{versionId, sourceHash?}}
 *   → 200 {selection, block}（规范 MaterialSelection；零误定位——绝不以
 *   相似文字兜底）；区间纪律拒绝 → 400 + 稳定原因码（invalid-locator/
 *   needle-not-found/out-of-bounds/reversed/zero-length/surrogate-split/
 *   combining-split/emoji-split/excerpt-mismatch/stale-version/cross-page/
 *   cross-block/block-mismatch）；非 ready 版本 → 409 material-not-ready。
 *
 * 搜索 API（issue #8 D4-4，契约 §3；未注入 search 服务 → 503 如实说明）：
 *   POST /api/trees/:treeId/search —— 当前树内搜索（默认范围=当前树；
 *   未知树 404）。POST /api/search —— 全部树搜索。body {text, kinds?}
 *   （kinds ⊆ material|annotation|return|turn）→ 引擎选项；200
 *   {hits:[SearchHit]}——契约裁剪面：可空字段缺省（非 null），引擎附加
 *   refId/matchType/matchCount 剥离。空/纯空白 text → 400；kinds 非法
 *   （非数组/空数组/未知成员）→ 400。零命中如实空数组（不编造）。搜索
 *   纯只读：不创建任何产品事实（项目书 §4「浏览/搜索不创建 Turn」）。
 *
 * 大规模树导航 API（issue #8 D4-8，charter §5；未注入 nav 服务 → 503
 * nav-not-wired 如实说明）：/api/nav/* 只读产品事实（trees/branches/
 * turns/origins），从不读 run/session 可用性——产品树 ≠ 运行 session 树
 * （session 全部消失时导航结果逐字节不变）。单次响应永不携带整棵树载荷
 * （children/subtree 均有 limit 上限 + 游标续页——按需加载）。详见区段
 * 注释（路由清单与错误映射）；展开状态 PUT → 204，读取无状态 → null
 * 诚实空态（重启后展开状态与阅读位置不丢：migration 0010）。
 *
 * 材料建枝 API（issue #8 D4-3，charter §3.3 / ADR-004；未注入 materials
 *   → 503 如实说明；契约 §3「from-material 拆两步」的差异记录见
 *   D4-contracts.md §3 D4-3 落地增量）：
 *   POST /api/trees/:treeId/branches/from-material —— 材料建枝（零 Run/
 *   Turn）+ 同来源恢复/显式另开：body {selection, intentKey,
 *   mode:"resume-or-create"|"new"}。mode "new" → 显式另开（新 Branch + 新
 *   session 意图，201 新建 / 200 同键幂等重放 / 409 同键不同选区）；mode
 *   "resume-or-create"（缺省）→ 同来源已有探索则恢复（200 mode:"restored"，
 *   续聊点导航结果与 sessionAvailability 分离携带；此时 intentKey 不绑定，
 *   恢复的是既有 Branch），无则按 intentKey 新建（201）。建枝只落 Branch/
 *   来源/首问绑定（浏览/搜索不创建 Turn——首问是独立显式提交）。
 *   POST /api/trees/:treeId/material-first-question —— 幂等首问（先对账
 *   后行动，ADR-004 决策四）：body {intentKey, firstQuestion} → 200
 *   {branch, dispatch, outcome, error, landed}（目标分支经 (treeId,
 *   intentKey) 绑定解析）；dispatch ∈ succeeded|failed|unknown（unknown =
 *   在途 Run 对账不决，不盲发）；首问已用不同内容落库 → 409
 *   material-first-question-conflict（改问走普通续聊）。
 *   POST /api/trees/:treeId/material-return —— 材料 Branch 的 Return
 *   （复用 submitReturn：保存先于导航、幂等键、采用尝试/成功分离）+
 *   材料来源卡（标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump；
 *   targetAnchor 恒 null——不伪造主线锚点）：body {fromBranchId, text,
 *   idempotencyKey}；201 新建 / 200 同键同内容重放。
 *   POST …/branches/:branchId/material-new-exploration —— 缺 session 的显式
 *   新探索（W1 §3.4 + 材料上下文随行）：body {text} → 200 {outcome, state}。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sendError } from "./http/errors.ts";
import { sendJson, sendNoContent, sendPdfBytes, type ApiErrorBody } from "./http/responses.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BranchId, MaterialId, MaterialVersionId, RunId, TerminologyMode, TreeId, TurnId } from "@treeai/contracts";
import { ConstraintViolationError, EntityNotFoundError, InvalidArgumentError, PersistenceError } from "@treeai/persistence";
import { RunNotActiveError, NewExplorationConflictError, ReturnConflictError, type TreeDiagnostics, type TreeStudioService, type TreeState } from "./service.ts";
import { type TerminologyService } from "./terminology.ts";
import { MaterialImportService, MaterialTooLargeError } from "./materials/import-service.ts";
import { MaterialRangeResolver, type ResolveSelectionInput } from "./materials/range-resolver.ts";
import { MaterialBranchingService } from "./materials/branching.ts";
import type { SearchDocumentKind } from "./search/search-engine.ts";
import { SEARCH_DOCUMENT_KINDS, SearchService, toContractSearchHit } from "./search/search-service.ts";
import { NavEngineError, type NavSearchMode } from "./nav/nav-engine.ts";
import { NavService } from "./nav/nav-service.ts";

const MAX_BODY_BYTES = 1_000_000;
const SSE_HEARTBEAT_MS = 15_000;
const JOURNAL_DEFAULT_LIMIT = 50;
const JOURNAL_MAX_LIMIT = 500;

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
const PDFJS_ROOT = new URL("../../../node_modules/pdfjs-dist/", import.meta.url);

export interface StudioServerOptions {
  readonly service: TreeStudioService;
  /** 静态文件目录（public/）。 */
  readonly staticDir: string;
  /**
   * 术语三部分服务（issue #7 C；缺省不注入 → 术语路由 503，如实说明
   * 未装配，绝不伪装成功）。宿主（index.ts / 测试）注入完整装配。
   */
  readonly terminology?: TerminologyService | null;
  /**
   * 材料导入服务（issue #8 D4-1；缺省不注入 → 材料路由 503，如实说明
   * 未装配，绝不伪装成功）。宿主（index.ts / 测试）注入完整装配。
   */
  readonly materials?: MaterialImportService | null;
  /**
   * 搜索服务（issue #8 D4-4；缺省不注入 → 搜索路由 503，如实说明未装配，
   * 绝不伪装成功）。宿主（index.ts / 测试）注入完整装配。
   */
  readonly search?: SearchService | null;
  /**
   * 大规模树导航服务（issue #8 D4-8，charter §5；缺省不注入 → /api/nav/*
   * 路由 503，如实说明未装配，绝不伪装成功）。宿主（index.ts / 测试）
   * 注入完整装配；树写入方须调用 nav.invalidate(treeId) 失效读索引。
   */
  readonly nav?: NavService | null;
}

export interface StudioServer {
  readonly server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new InvalidArgumentError("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidArgumentError("request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidArgumentError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidArgumentError(`request field '${field}' must be a non-empty string`);
  }
  return value;
}

/**
 * 材料建枝请求体的规范选区（D4-3）：{materialId, versionId, blockId, start,
 * end, excerpt, sourceHash}——D4-2 resolve-selection 的产出形状。此处只做
 * 形状校验；切片/块/sourceHash 锚定纪律由材料仓储 getMaterialSelection
 * （经建枝服务）再校验。
 */
function parseMaterialSelection(body: Record<string, unknown>): {
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly sourceHash: string;
} {
  const selection = body["selection"];
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    throw new InvalidArgumentError(
      "request field 'selection' must be an object {materialId, versionId, blockId, start, end, excerpt, sourceHash}",
    );
  }
  const record = selection as Record<string, unknown>;
  const materialId = record["materialId"];
  const versionId = record["versionId"];
  const blockId = record["blockId"];
  const start = record["start"];
  const end = record["end"];
  const excerpt = record["excerpt"];
  const sourceHash = record["sourceHash"];
  if (
    typeof materialId !== "string" ||
    typeof versionId !== "string" ||
    typeof blockId !== "string" ||
    typeof excerpt !== "string" ||
    typeof sourceHash !== "string"
  ) {
    throw new InvalidArgumentError("selection string fields (materialId/versionId/blockId/excerpt/sourceHash) are required");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new InvalidArgumentError("selection start/end must be integers (UTF-16 half-open range)");
  }
  return {
    materialId: materialId as MaterialId,
    versionId: versionId as MaterialVersionId,
    blockId,
    start: start as number,
    end: end as number,
    excerpt,
    sourceHash,
  };
}

/**
 * 材料导入的原始字节 body（契约 §3：本地 loopback 原始字节上传，零
 * multipart 依赖）。超限即刻停止累积（内存有界）但持续排空至流尾再拒绝
 * ——既不缓冲超限数据，也让客户端确定性地读到 413 响应。
 */
async function readMaterialBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (exceeded) continue;
    if (size > maxBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    throw new MaterialTooLargeError(size, maxBytes);
  }
  return Buffer.concat(chunks);
}

/** x-treeai-filename 头（UTF-8 百分号编码）→ 文件名；缺失/畸形 → 400。 */
function decodeFilenameHeader(req: IncomingMessage): string {
  const raw = req.headers["x-treeai-filename"];
  const joined = Array.isArray(raw) ? raw.join("") : raw;
  if (typeof joined !== "string" || joined.trim().length === 0) {
    throw new InvalidArgumentError("the x-treeai-filename header is required (UTF-8 percent-encoded)");
  }
  try {
    return decodeURIComponent(joined);
  } catch {
    throw new InvalidArgumentError("the x-treeai-filename header is not valid percent-encoded UTF-8");
  }
}

/**
 * 搜索请求体（契约 §3，issue #8 D4-4）：{text, kinds?} → 引擎选项。
 * 空/纯空白 text（无任何可检索单元）→ 400；kinds 非法（非数组/空数组/
 * 未知成员）→ 400（引擎对这些 fail-fast 抛 SearchEngineError，必须在
 * HTTP 面先行校验成 400，不得漏成 500）。
 */
function parseSearchQuery(body: Record<string, unknown>): {
  readonly text: string;
  readonly kinds?: ReadonlyArray<SearchDocumentKind>;
} {
  const text = body["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new InvalidArgumentError("request field 'text' must be a non-empty (not blank) string");
  }
  const rawKinds = body["kinds"];
  if (rawKinds === undefined) return { text };
  if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
    throw new InvalidArgumentError(
      "request field 'kinds' must be a non-empty array of 'material' | 'annotation' | 'return' | 'turn'",
    );
  }
  const kinds: SearchDocumentKind[] = [];
  for (const entry of rawKinds) {
    if (typeof entry !== "string" || !SEARCH_DOCUMENT_KINDS.has(entry)) {
      throw new InvalidArgumentError(
        `request field 'kinds' must contain only 'material' | 'annotation' | 'return' | 'turn' (got ${String(entry)})`,
      );
    }
    if (!kinds.includes(entry as SearchDocumentKind)) kinds.push(entry as SearchDocumentKind);
  }
  return { text, kinds };
}

/** 204 No Content（无 body；阅读位置 PUT 的成功响应）。 */
/**
 * 导航查询参数 → 数值（issue #8 D4-8）：非数字/非整数交由引擎层校验
 * （NavEngineError invalid-argument → 400，原因码稳定）。
 */
function navNumberParam(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`query parameter '${name}' must be a number (got '${raw}')`);
  }
  return parsed;
}

/** 导航分页查询参数（cursor/limit；缺省走引擎默认）。 */
function navPageOptions(url: URL): { readonly cursor?: string; readonly limit?: number } {
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: navNumberParam(limit, "limit") }),
  };
}

/**
 * 展开状态 PUT 请求体（issue #8 D4-8）：{expandedBranchIds, selectedBranchId?}。
 * 数组形状在此校验（400）；成员存在性/树归属在仓储层校验（404/400）。
 */
function parseNavExpandStateBody(body: Record<string, unknown>): {
  readonly expandedBranchIds: readonly BranchId[];
  readonly selectedBranchId: BranchId | null;
} {
  const raw = body["expandedBranchIds"];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    throw new InvalidArgumentError("request field 'expandedBranchIds' must be an array of branch ids");
  }
  const selected = body["selectedBranchId"];
  if (selected !== undefined && selected !== null && typeof selected !== "string") {
    throw new InvalidArgumentError(
      "request field 'selectedBranchId' must be a branch id string or null (reading position)",
    );
  }
  return {
    expandedBranchIds: raw as readonly BranchId[],
    selectedBranchId: (selected as BranchId | null | undefined) ?? null,
  };
}

function asTreeId(raw: string): TreeId {
  return decodeURIComponent(raw) as TreeId;
}

export function createStudioServer(options: StudioServerOptions): StudioServer {
  const { service, staticDir } = options;
  const terminology = options.terminology ?? null;
  const materials = options.materials ?? null;
  const search = options.search ?? null;
  /* D4-8 大规模树导航服务（issue #8 charter §5）：未装配即为 null →
     /api/nav/* 路由 503 nav-not-wired，绝不伪装成功。 */
  const nav = options.nav ?? null;
  /* D4-2 统一区间/锚点解析层：与材料服务同一仓储派生（materials 未装配
     即为 null → 解析路由 503 materials-not-wired，绝不伪装成功）。 */
  const materialRanges =
    materials === null ? null : new MaterialRangeResolver({ repository: materials.repository });
  /* D4-3 材料建枝服务（issue #8 charter §3.3 / ADR-004）：复用主服务
     （studio）的 Branch/Origin/Run/Return 底层 + 材料仓储的来源/首问幂等
     面——与解析层同一装配纪律（materials 未装配即为 null → 建枝路由 503）。 */
  const materialBranching =
    materials === null
      ? null
      : new MaterialBranchingService({
          treeRepository: service.repository,
          materialRepository: materials.repository,
          studio: service,
        });
  /** 打开中的 SSE 连接（close() 时主动终结，保证 server.close() 不被挂住）。 */
  const sseResponses = new Set<ServerResponse>();

  async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
    const entry = STATIC_FILES[pathname];
    let source: string | URL | null = entry === undefined ? null : join(staticDir, entry.file);
    let type = entry?.type ?? null;
    if (source === null) {
      const moduleMatch = /^\/vendor\/pdfjs\/(pdf(?:\.worker)?\.mjs)$/.exec(pathname);
      const cmapMatch = /^\/vendor\/pdfjs\/cmaps\/([A-Za-z0-9_-]+\.bcmap)$/.exec(pathname);
      const fontMatch = /^\/vendor\/pdfjs\/standard_fonts\/([A-Za-z0-9_-]+\.(?:pfb|ttf))$/.exec(pathname);
      if (moduleMatch !== null) {
        source = new URL(`build/${moduleMatch[1]}`, PDFJS_ROOT);
        type = "text/javascript; charset=utf-8";
      } else if (cmapMatch !== null) {
        source = new URL(`cmaps/${cmapMatch[1]}`, PDFJS_ROOT);
        type = "application/octet-stream";
      } else if (fontMatch !== null) {
        source = new URL(`standard_fonts/${fontMatch[1]}`, PDFJS_ROOT);
        type = "application/octet-stream";
      }
    }
    if (source === null || type === null) return false;
    try {
      const content = await readFile(source);
      res.writeHead(200, {
        "content-type": type,
        "content-length": content.length,
        "cache-control": "no-store",
      });
      res.end(content);
      return true;
    } catch {
      sendJson(res, 500, { error: { code: "internal", message: `static file missing: ${pathname}` } });
      return true;
    }
  }

  /**
   * SSE 流：snapshot（连接时的诊断面投影）→ 按事件类型转发该树的安全
   * UI 事件；~15s 心跳注释；客户端断开即退订。headers 写出后不再抛错
   * （写失败静默——客户端已断开时 write 不 throw）。
   */
  function startSseStream(req: IncomingMessage, res: ServerResponse, treeId: TreeId, snapshot: TreeDiagnostics): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const writeEvent = (name: string, data: unknown): void => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    writeEvent("snapshot", snapshot);
    const unsubscribe = service.subscribeStudioEvents((event) => {
      if (event.treeId !== treeId) return;
      writeEvent(event.type, event);
    });
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    sseResponses.add(res);
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      sseResponses.delete(res);
      res.end();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: { code: "invalid-argument", message: "unparseable request URL" } });
      return;
    }
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && (await serveStatic(res, pathname))) return;

      if (pathname === "/api/trees") {
        if (method === "GET") {
          sendJson(res, 200, { trees: service.listTrees() });
          return;
        }
        if (method === "POST") {
          const created = service.createTree();
          const state: TreeState = service.getTreeState(created.tree.id);
          sendJson(res, 201, { tree: created.tree, trunkBranchId: created.trunkBranch.id, state });
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} /api/trees` } });
        return;
      }

      const sourceMatch = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(pathname);
      if (sourceMatch !== null) {
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(sourceMatch[1]!);
        const source = await service.revealBranchOrigin(treeId, decodeURIComponent(sourceMatch[2]!) as BranchId);
        sendJson(res, 200, { source, state: service.getTreeState(treeId) });
        return;
      }

      /* POST /api/trees/:treeId/branches/:branchId/new-exploration —— 用户
         显式确认的「以保存内容开始新的探索」（signed v3 §4.4）：分支续聊点
         session 不可用时的换轨入口。200 = 首问完成（新 session + 保存内容
         上下文，PromptOutcome）；409 new-exploration-conflict = 前置条件不
         满足（session 仍可用 / 无历史 session），零写入；400 = 空文本。 */
      const newExplorationMatch = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/new-exploration$/.exec(pathname);
      if (newExplorationMatch !== null) {
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(newExplorationMatch[1]!);
        const body = await readJsonBody(req);
        const outcome = await service.promptNewExploration(
          treeId,
          decodeURIComponent(newExplorationMatch[2]!) as BranchId,
          requireString(body, "text"),
        );
        sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
        return;
      }

      /* 术语三部分（issue #7 C）：/api/trees/:id/terminology/*。
         未装配（terminology === null）→ 503 如实说明，绝不伪装成功。 */
      const terminologyMatch = /^\/api\/trees\/([^/]+)\/terminology(?:\/(.*))?$/.exec(pathname);
      if (terminologyMatch !== null) {
        const term = terminology;
        if (term === null || term === undefined) {
          sendJson(res, 503, {
            error: { code: "terminology-not-wired", message: "the terminology service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(terminologyMatch[1]!);
        const rest = terminologyMatch[2] ?? "";
        if (rest === "" && method === "GET") {
          sendJson(res, 200, term.readModel(treeId));
          return;
        }
        if (rest === "explain" && method === "POST") {
          const body = await readJsonBody(req);
          const selection = body["selection"];
          if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
            throw new InvalidArgumentError("request field 'selection' must be an object {start, end, text}");
          }
          const mode = body["mode"];
          if (mode !== "term" && mode !== "range") {
            throw new InvalidArgumentError("request field 'mode' must be 'term' or 'range'");
          }
          const outcome = await term.explain({
            treeId,
            branchId: requireString(body, "branchId") as BranchId,
            anchorTurnId: requireString(body, "anchorTurnId") as TurnId,
            selection: selection as { start: number; end: number; text: string },
            mode: mode as TerminologyMode,
          });
          sendJson(res, 200, outcome);
          return;
        }
        if (rest === "extract" && method === "POST") {
          const body = await readJsonBody(req);
          const task = await term.extract({
            treeId,
            branchId: requireString(body, "branchId") as BranchId,
            anchorTurnId: requireString(body, "anchorTurnId") as TurnId,
          });
          sendJson(res, 200, { task });
          return;
        }
        if (rest === "annotations" && method === "POST") {
          const body = await readJsonBody(req);
          const selection = body["selection"];
          if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
            throw new InvalidArgumentError("request field 'selection' must be an object {start, end, text}");
          }
          const mode = body["mode"];
          if (mode !== "term" && mode !== "range" && mode !== "auto") {
            throw new InvalidArgumentError("request field 'mode' must be 'term' | 'range' | 'auto'");
          }
          const saved = term.saveAnnotation({
            treeId,
            branchId: requireString(body, "branchId") as BranchId,
            anchorTurnId: requireString(body, "anchorTurnId") as TurnId,
            selection: selection as { start: number; end: number; text: string },
            mode: mode as TerminologyMode,
            term: requireString(body, "term"),
            explanation: requireString(body, "explanation"),
          });
          sendJson(res, saved.created ? 201 : 200, { annotation: saved.annotation, created: saved.created });
          return;
        }
        const promoteMatch = /^annotations\/([^/]+)\/promote$/.exec(rest);
        if (promoteMatch !== null && method === "POST") {
          const body = await readJsonBody(req);
          const promotion = await term.promote({
            treeId,
            annotationId: decodeURIComponent(promoteMatch[1]!),
            idempotencyKey: requireString(body, "idempotencyKey"),
            firstQuestion: requireString(body, "firstQuestion"),
          });
          sendJson(res, promotion.created ? 201 : 200, { ...promotion, state: service.getTreeState(treeId) });
          return;
        }
        const cancelMatch = /^tasks\/([^/]+)\/cancel$/.exec(rest);
        if (cancelMatch !== null && method === "POST") {
          sendJson(res, 200, { task: term.executor.cancel(decodeURIComponent(cancelMatch[1]!)) });
          return;
        }
        if (rest === "preferences" && method === "PUT") {
          const body = await readJsonBody(req);
          const cacheEnabled = body["cacheEnabled"];
          if (typeof cacheEnabled !== "boolean") {
            throw new InvalidArgumentError("request field 'cacheEnabled' must be a boolean");
          }
          term.setCachePreference(cacheEnabled);
          sendJson(res, 200, { cacheEnabled: term.executor.cacheEnabled });
          return;
        }
        /* 阅读模式（issue #7 术语①）：GET/PUT settings/reading-mode。
           枚举校验 → 400；未知树 → 404。模式可保存、可切换——质量门禁
           未过时零自动派发由 TerminologyService 保证（readModel 如实暴露
           autoSuggestions.enabled=false + 原因），路由层不伪装启用。 */
        if (rest === "settings/reading-mode" && method === "GET") {
          sendJson(res, 200, { readingMode: term.getReadingMode(treeId) });
          return;
        }
        if (rest === "settings/reading-mode" && method === "PUT") {
          const body = await readJsonBody(req);
          const mode = body["mode"];
          if (mode !== "manual-only" && mode !== "minimal-hints" && mode !== "assisted-reading") {
            throw new InvalidArgumentError(
              "request field 'mode' must be one of 'manual-only' | 'minimal-hints' | 'assisted-reading'",
            );
          }
          term.setReadingMode(treeId, mode);
          sendJson(res, 200, { readingMode: mode });
          return;
        }
        /* 建议集显式重试（budget-paused/failed 的「可恢复入口」——用户
           显式动作；gate 未过 → 400 建议管线整体关闭，绝不旁路）。 */
        const suggestRetryMatch = /^suggestions\/([^/]+)\/retry$/.exec(rest);
        if (suggestRetryMatch !== null && method === "POST") {
          const state = await term.retrySuggestions(
            treeId,
            decodeURIComponent(suggestRetryMatch[1]!) as TurnId,
          );
          sendJson(res, 200, { autoSuggestions: state });
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      /* 材料导入/读取（issue #8 D4-1，契约 §3）。未装配（materials ===
         null）→ 503 如实说明，绝不伪装成功。上传为原始字节 body +
         x-treeai-filename 头（UTF-8 百分号编码）；404/415 预检在读 body
         之前完成。 */
      const materialsRootMatch = /^\/api\/trees\/([^/]+)\/materials$/.exec(pathname);
      if (materialsRootMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(materialsRootMatch[1]!);
        if (method === "GET") {
          sendJson(res, 200, { materials: materials.listTreeMaterials(treeId) });
          return;
        }
        if (method === "POST") {
          const filename = decodeFilenameHeader(req);
          materials.precheckImport(treeId, filename);
          const bytes = await readMaterialBody(req, materials.limits.maxFileBytes);
          const result = await materials.importMaterial(treeId, { filename, bytes });
          sendJson(res, result.created ? 201 : 200, {
            material: result.material,
            version: result.version,
            created: result.created,
            parseTaskId: result.parseTaskId,
          });
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      const materialMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(pathname);
      if (materialMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(materialMatch[1]!);
        const materialId = decodeURIComponent(materialMatch[2]!) as MaterialId;
        if (method === "GET") {
          sendJson(res, 200, materials.getMaterialDetail(treeId, materialId));
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      /* 新版本导入（同语义/同返回码：201 新字节 / 200 同字节复用 / 413 / 415）。 */
      const materialVersionsMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions$/.exec(pathname);
      if (materialVersionsMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(materialVersionsMatch[1]!);
        const materialId = decodeURIComponent(materialVersionsMatch[2]!) as MaterialId;
        if (method === "POST") {
          const filename = decodeFilenameHeader(req);
          materials.precheckImport(treeId, filename);
          const bytes = await readMaterialBody(req, materials.limits.maxFileBytes);
          const result = await materials.addMaterialVersion(treeId, materialId, { filename, bytes });
          sendJson(res, result.created ? 201 : 200, {
            material: result.material,
            version: result.version,
            created: result.created,
            parseTaskId: result.parseTaskId,
          });
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      const materialVersionFileMatch =
        /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/file$/.exec(pathname);
      if (materialVersionFileMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        if (method !== "GET") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(materialVersionFileMatch[1]!);
        const materialId = decodeURIComponent(materialVersionFileMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(materialVersionFileMatch[3]!) as MaterialVersionId;
        const file = materials.readVersionFile(treeId, materialId, versionId);
        sendPdfBytes(res, file.bytes, req.headers.range);
        return;
      }

      /* canonicalText 分块读取：?afterBlock=&limit=（缺省从头、50 块）。 */
      const materialVersionMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
      if (materialVersionMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(materialVersionMatch[1]!);
        const materialId = decodeURIComponent(materialVersionMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(materialVersionMatch[3]!) as MaterialVersionId;
        if (method === "GET") {
          const afterBlockRaw = url.searchParams.get("afterBlock");
          let limit: number | undefined;
          const limitRaw = url.searchParams.get("limit");
          if (limitRaw !== null && limitRaw !== "") {
            const parsed = Number(limitRaw);
            if (!Number.isInteger(parsed)) {
              throw new InvalidArgumentError(`limit must be an integer (got '${limitRaw}')`);
            }
            limit = parsed;
          }
          const page = materials.readVersionBlocks(treeId, materialId, versionId, {
            afterBlock: afterBlockRaw === null || afterBlockRaw === "" ? null : afterBlockRaw,
            limit,
          });
          sendJson(res, 200, page);
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      /* 取消解析任务（迟到结果不挂靠——版本行条件 UPDATE 结构性拒绝）。
         树作用域由路由校验（issue #8 P1）：treeId 参与解析，错误树统一 404。 */
      const parseTaskCancelMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/parse-tasks\/([^/]+)\/cancel$/.exec(pathname);
      if (parseTaskCancelMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(parseTaskCancelMatch[1]!);
        const materialId = decodeURIComponent(parseTaskCancelMatch[2]!) as MaterialId;
        const taskId = decodeURIComponent(parseTaskCancelMatch[3]!);
        const task = materials.cancelParseTask(treeId, taskId, materialId);
        sendJson(res, 200, { task });
        return;
      }

      /* 持久化阅读位置（UPSERT 整体替换 → 204 无 body；D4-2 增读侧：
         GET → 200 {readingPosition: MaterialReadingPosition | null}）。 */
      const readingPositionMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/reading-position$/.exec(pathname);
      if (readingPositionMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        const treeId = asTreeId(readingPositionMatch[1]!);
        const materialId = decodeURIComponent(readingPositionMatch[2]!) as MaterialId;
        if (method === "GET") {
          sendJson(res, 200, { readingPosition: materials.getReadingPosition(treeId, materialId) });
          return;
        }
        if (method === "PUT") {
          const body = await readJsonBody(req);
          const blockIdRaw = body["blockId"];
          if (blockIdRaw !== undefined && blockIdRaw !== null && typeof blockIdRaw !== "string") {
            throw new InvalidArgumentError("request field 'blockId' must be a string or null");
          }
          const focusRaw = body["focusStart"];
          if (focusRaw !== undefined && focusRaw !== null && !Number.isInteger(focusRaw)) {
            throw new InvalidArgumentError("request field 'focusStart' must be an integer or null");
          }
          materials.upsertReadingPosition(treeId, materialId, {
            versionId: requireString(body, "versionId") as MaterialVersionId,
            blockId: blockIdRaw === undefined ? null : (blockIdRaw as string | null),
            focusStart: focusRaw === undefined ? null : (focusRaw as number | null),
          });
          sendNoContent(res);
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      /* D4-2 阅读与来源定位（issue #8 工作包 D4-2）——统一区间/锚点解析：
         POST …/versions/:versionId/resolve-selection
         body {locator, excerpt?, blockId?, anchor?} → 200 {selection, block}
         （规范 MaterialSelection：切片/块/UTF-16 边界/sourceHash 全通过）；
         区间纪律拒绝 → 400 + 稳定原因码（invalid-locator / needle-not-found /
         out-of-bounds / reversed / zero-length / surrogate-split /
         combining-split / emoji-split / excerpt-mismatch / stale-version /
         cross-page / cross-block / block-mismatch）；非 ready 版本 → 409
         material-not-ready（与分块读取同一纪律）。未装配 → 503。 */
      const resolveSelectionMatch =
        /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/resolve-selection$/.exec(pathname);
      if (resolveSelectionMatch !== null) {
        if (materials === null || materialRanges === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(resolveSelectionMatch[1]!);
        const materialId = decodeURIComponent(resolveSelectionMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(resolveSelectionMatch[3]!) as MaterialVersionId;
        materials.getReadingPosition(treeId, materialId); // 树/材料作用域（404 于解析之前）
        const body = await readJsonBody(req);
        const locatorRaw = body["locator"];
        if (locatorRaw === null || typeof locatorRaw !== "object" || Array.isArray(locatorRaw)) {
          throw new InvalidArgumentError("request field 'locator' must be an object {kind, ...}");
        }
        const anchorRaw = body["anchor"];
        if (anchorRaw !== undefined && (anchorRaw === null || typeof anchorRaw !== "object" || Array.isArray(anchorRaw))) {
          throw new InvalidArgumentError("request field 'anchor' must be an object {versionId, sourceHash?}");
        }
        let anchor: ResolveSelectionInput["anchor"] | undefined;
        if (anchorRaw !== undefined) {
          const anchorRecord = anchorRaw as Record<string, unknown>;
          const anchorVersionId = anchorRecord["versionId"];
          if (typeof anchorVersionId !== "string" || anchorVersionId.length === 0) {
            throw new InvalidArgumentError("request field 'anchor.versionId' must be a non-empty string");
          }
          const anchorHash = anchorRecord["sourceHash"];
          if (anchorHash !== undefined && typeof anchorHash !== "string") {
            throw new InvalidArgumentError("request field 'anchor.sourceHash' must be a string");
          }
          anchor = {
            versionId: anchorVersionId as MaterialVersionId,
            ...(anchorHash === undefined ? {} : { sourceHash: anchorHash }),
          };
        }
        const excerptRaw = body["excerpt"];
        if (excerptRaw !== undefined && typeof excerptRaw !== "string") {
          throw new InvalidArgumentError("request field 'excerpt' must be a string");
        }
        const blockIdRaw = body["blockId"];
        if (blockIdRaw !== undefined && typeof blockIdRaw !== "string") {
          throw new InvalidArgumentError("request field 'blockId' must be a string");
        }
        const input: ResolveSelectionInput = {
          materialId,
          versionId,
          locator: locatorRaw as ResolveSelectionInput["locator"],
          ...(excerptRaw === undefined ? {} : { excerpt: excerptRaw }),
          ...(blockIdRaw === undefined ? {} : { blockId: blockIdRaw }),
          ...(anchor === undefined ? {} : { anchor }),
        };
        const resolution = materialRanges.resolve(input);
        if (!resolution.ok) {
          const { code, message } = resolution.rejection;
          if (code === "material-not-ready") {
            sendJson(res, 409, { error: { code, message } } satisfies ApiErrorBody);
          } else {
            sendJson(res, 400, { error: { code, message } } satisfies ApiErrorBody);
          }
          return;
        }
        sendJson(res, 200, { selection: resolution.result.selection, block: resolution.result.block });
        return;
      }

      /* ==================== D4-3 材料建枝区段（issue #8 charter §3.3 /
         ADR-004；服务 apps/studio/src/materials/branching.ts）====================
         契约 §3 的 from-material 在 D4-3 落地为两步（差异记录于
         D4-contracts.md §3）：建枝/恢复（零 Run/Turn，返回组合上下文供 UI
         在提交前说明材料范围）与首问（独立显式提交，先对账后行动）。
         未装配（materials === null → materialBranching === null）→ 503
         如实说明，绝不伪装成功。 */
      const fromMaterialMatch = /^\/api\/trees\/([^/]+)\/branches\/from-material$/.exec(pathname);
      if (fromMaterialMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(fromMaterialMatch[1]!);
        const body = await readJsonBody(req);
        const selection = parseMaterialSelection(body);
        const intentKey = requireString(body, "intentKey");
        const modeRaw = body["mode"];
        const mode = modeRaw === undefined ? "resume-or-create" : modeRaw;
        if (mode !== "resume-or-create" && mode !== "new") {
          throw new InvalidArgumentError("request field 'mode' must be 'resume-or-create' or 'new'");
        }
        if (mode === "new") {
          /* 显式另开：新 Branch + 新 session 意图（同键幂等重放 / 同键不同
             选区 409，由服务层判定）。 */
          const result = await materialBranching.restoreOrOpen({
            treeId,
            selection,
            mode: "new",
            intentKey,
          });
          sendJson(res, result.created ? 201 : 200, {
            mode: "created",
            branch: result.branch,
            origin: result.origin,
            context: result.context,
            created: result.created,
            navigation: result.navigation,
            sessionAvailability: result.sessionAvailability,
            state: service.getTreeState(treeId),
          });
          return;
        }
        /* resume-or-create：同来源已有探索 → 恢复（intentKey 不绑定——
           恢复的是既有 Branch，其首问归属它自己的提交键）；无 → 按
           intentKey 新建。恢复的导航/会话可用性结果分离携带（失败不掩盖
           恢复本身）。 */
        try {
          const restored = await materialBranching.restoreOrOpen({ treeId, selection, mode: "restore" });
          sendJson(res, 200, {
            mode: "restored",
            branch: restored.branch,
            origin: restored.origin,
            context: restored.context,
            created: false,
            navigation: restored.navigation,
            sessionAvailability: restored.sessionAvailability,
            state: service.getTreeState(treeId),
          });
        } catch (err) {
          if (!(err instanceof EntityNotFoundError)) throw err;
          const created = materialBranching.createMaterialBranch({ treeId, selection, intentKey });
          sendJson(res, 201, {
            mode: "created",
            branch: created.branch,
            origin: created.origin,
            context: created.context,
            created: true,
            navigation: null,
            sessionAvailability: null,
            state: service.getTreeState(treeId),
          });
        }
        return;
      }

      const materialFirstQuestionMatch = /^\/api\/trees\/([^/]+)\/material-first-question$/.exec(pathname);
      if (materialFirstQuestionMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(materialFirstQuestionMatch[1]!);
        const body = await readJsonBody(req);
        /* 目标分支经 (treeId, intentKey) 绑定解析（提交意图身份）；
           派发结局（succeeded/failed/unknown）是数据不是传输错误：200 携带
           dispatch 字段如实呈现；同键异问 409 由错误映射统一处理。 */
        const result = await materialBranching.firstQuestion({
          treeId,
          intentKey: requireString(body, "intentKey"),
          firstQuestion: requireString(body, "firstQuestion"),
        });
        sendJson(res, 200, {
          branch: result.branch,
          dispatch: result.dispatch,
          outcome: result.outcome,
          error: result.error,
          landed: result.landed,
          state: service.getTreeState(treeId),
        });
        return;
      }

      const materialReturnMatch = /^\/api\/trees\/([^/]+)\/material-return$/.exec(pathname);
      if (materialReturnMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(materialReturnMatch[1]!);
        const body = await readJsonBody(req);
        const submission = await materialBranching.submitMaterialReturn({
          treeId,
          fromBranchId: requireString(body, "fromBranchId") as BranchId,
          text: requireString(body, "text"),
          idempotencyKey: requireString(body, "idempotencyKey"),
        });
        sendJson(res, submission.created ? 201 : 200, {
          returnTurn: submission.returnTurn,
          created: submission.created,
          navigation: submission.navigation,
          card: submission.card,
          state: service.getTreeState(treeId),
        });
        return;
      }

      const materialNewExplorationMatch =
        /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/material-new-exploration$/.exec(pathname);
      if (materialNewExplorationMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = asTreeId(materialNewExplorationMatch[1]!);
        const body = await readJsonBody(req);
        const outcome = await materialBranching.promptNewMaterialExploration(
          treeId,
          decodeURIComponent(materialNewExplorationMatch[2]!) as BranchId,
          requireString(body, "text"),
        );
        sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
        return;
      }
      /* ==================== D4-3 材料建枝区段结束 ==================== */

      /* D4-4 找回既有思考 —— 搜索（issue #8 D4-4，契约 §3；未注入 search
         服务 → 503 如实说明，绝不伪装成功）：
         POST /api/trees/:treeId/search —— 当前树内搜索（默认范围=当前树；
         未知树 → 404，树作用域校验在检索之前、请求体校验之后）。
         POST /api/search —— 全部树搜索。body {text, kinds?} → 引擎选项；
         200 {hits:[SearchHit]}（契约裁剪：可空字段缺省、引擎附加字段
         剥离）；零命中如实空数组。搜索纯只读（不创建产品事实）。 */
      const treeSearchMatch = /^\/api\/trees\/([^/]+)\/search$/.exec(pathname);
      if (treeSearchMatch !== null || pathname === "/api/search") {
        if (search === null) {
          sendJson(res, 503, {
            error: { code: "search-not-wired", message: "the search service is not wired in this process" },
          });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        const treeId = treeSearchMatch === null ? null : asTreeId(treeSearchMatch[1]!);
        const query = parseSearchQuery(await readJsonBody(req));
        const hits = search.search(query.text, {
          treeId,
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        });
        sendJson(res, 200, { hits: hits.map(toContractSearchHit) });
        return;
      }

      /* ==================== D4-8 大规模树导航区段（issue #8，charter §5） ====================
         只读产品事实（trees/branches/turns/origins），从不读 run/session
         可用性——产品树 ≠ 运行 session 树（session 全部消失时导航结果
         逐字节不变）。单次响应永不携带整棵树载荷（按需分页：children/
         subtree 均有 limit 上限 + 游标续页）。未装配 nav → 503。

           GET  /api/nav/trees?cursor=&limit=                       —— 森林/树列表（标量摘要，无全树载荷）
           GET  /api/nav/trees/:treeId                              —— 单树概览（节点数/最大深度/标题）
           GET  /api/nav/trees/:treeId/branches/:branchId/children?cursor=&limit=
                                                                     —— 子节点分页（按需加载核心查询）
           GET  /api/nav/trees/:treeId/branches/:branchId/subtree?maxDepth=&cursor=&limit=
                                                                     —— 深度受限子树展开（BFS + 游标续页）
           GET  /api/nav/trees/:treeId/branches/:branchId/path      —— 根→本节点完整路径（含本节点；
                                                                         100 层深链完整返回）
           GET  /api/nav/branches/:branchId/locate                  —— 跨树定位（树/祖先链/兄弟位次/来源）
           GET  /api/nav/search/trees?text=&mode=&limit=&cursor=    —— 树标题/标识搜索（确定性序 + 分页）
           GET  /api/nav/search/branches?text=&mode=&treeId=&limit=&cursor=
                                                                     —— Branch 标题/标识搜索（命中带完整
                                                                         路径——同名消歧按 id 精确定位）
           GET  /api/nav/trees/:treeId/expand-state                 —— 展开状态读取（无 → null 诚实空态）
           PUT  /api/nav/trees/:treeId/expand-state                 —— 展开状态整组写入（body
                                                                         {expandedBranchIds, selectedBranchId?}
                                                                         → 204；校验成员树归属）

         错误映射（NavEngineError 稳定原因码）：unknown-tree/unknown-branch
         → 404；invalid-argument/invalid-cursor → 400；stale-cursor → 409
         （索引失效后旧游标，从首页重开）；仓储层 EntityNotFound → 404、
         InvalidArgument → 400（展开状态校验）。 */
      if (pathname === "/api/nav" || pathname.startsWith("/api/nav/")) {
        if (nav === null) {
          sendJson(res, 503, {
            error: { code: "nav-not-wired", message: "the tree navigation service is not wired in this process" },
          });
          return;
        }
        const navTreesListMatch = pathname === "/api/nav/trees";
        const navTreeMatch = /^\/api\/nav\/trees\/([^/]+)$/.exec(pathname);
        const navChildrenMatch = /^\/api\/nav\/trees\/([^/]+)\/branches\/([^/]+)\/children$/.exec(pathname);
        const navSubtreeMatch = /^\/api\/nav\/trees\/([^/]+)\/branches\/([^/]+)\/subtree$/.exec(pathname);
        const navPathMatch = /^\/api\/nav\/trees\/([^/]+)\/branches\/([^/]+)\/path$/.exec(pathname);
        const navExpandStateMatch = /^\/api\/nav\/trees\/([^/]+)\/expand-state$/.exec(pathname);
        const navLocateMatch = /^\/api\/nav\/branches\/([^/]+)\/locate$/.exec(pathname);
        const navTreeSearchMatch = pathname === "/api/nav/search/trees";
        const navBranchSearchMatch = pathname === "/api/nav/search/branches";
        const isNavRoute =
          navTreesListMatch ||
          navTreeMatch !== null ||
          navChildrenMatch !== null ||
          navSubtreeMatch !== null ||
          navPathMatch !== null ||
          navExpandStateMatch !== null ||
          navLocateMatch !== null ||
          navTreeSearchMatch ||
          navBranchSearchMatch;
        if (isNavRoute) {
          const engine = nav.engine;
          if (navTreesListMatch) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            sendJson(res, 200, engine.listTrees(navPageOptions(url)));
            return;
          }
          if (navTreeMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            sendJson(res, 200, engine.getTreeOverview(asTreeId(navTreeMatch[1]!)));
            return;
          }
          if (navChildrenMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            sendJson(
              res,
              200,
              engine.listChildren(
                decodeURIComponent(navChildrenMatch[1]!),
                decodeURIComponent(navChildrenMatch[2]!) as BranchId,
                navPageOptions(url),
              ),
            );
            return;
          }
          if (navSubtreeMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            const options = navPageOptions(url);
            const maxDepthRaw = url.searchParams.get("maxDepth");
            sendJson(
              res,
              200,
              engine.expandSubtree(
                decodeURIComponent(navSubtreeMatch[1]!),
                decodeURIComponent(navSubtreeMatch[2]!) as BranchId,
                {
                  ...options,
                  ...(maxDepthRaw === null ? {} : { maxDepth: navNumberParam(maxDepthRaw, "maxDepth") }),
                },
              ),
            );
            return;
          }
          if (navPathMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            sendJson(res, 200, {
              treeId: decodeURIComponent(navPathMatch[1]!),
              branchId: decodeURIComponent(navPathMatch[2]!),
              path: engine.fullPath(decodeURIComponent(navPathMatch[1]!), decodeURIComponent(navPathMatch[2]!)),
            });
            return;
          }
          if (navExpandStateMatch !== null) {
            const treeId = asTreeId(navExpandStateMatch[1]!);
            if (method === "GET") {
              sendJson(res, 200, { expandState: nav.getExpandState(treeId) });
              return;
            }
            if (method === "PUT") {
              const body = parseNavExpandStateBody(await readJsonBody(req));
              nav.saveExpandState({ treeId, ...body });
              sendNoContent(res);
              return;
            }
            sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
            return;
          }
          if (navLocateMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            sendJson(res, 200, engine.locateBranch(decodeURIComponent(navLocateMatch[1]!) as BranchId));
            return;
          }
          if (navTreeSearchMatch || navBranchSearchMatch) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return;
            }
            const text = url.searchParams.get("text") ?? "";
            if (text.trim().length === 0) {
              throw new InvalidArgumentError("query parameter 'text' must be a non-empty (not blank) string");
            }
            const modeRaw = url.searchParams.get("mode");
            if (modeRaw !== null && modeRaw !== "exact" && modeRaw !== "prefix" && modeRaw !== "substring") {
              throw new InvalidArgumentError(
                `query parameter 'mode' must be 'exact' | 'prefix' | 'substring' (got '${modeRaw}')`,
              );
            }
            const mode = modeRaw as NavSearchMode | null;
            const limitRaw = url.searchParams.get("limit");
            const cursor = url.searchParams.get("cursor") ?? undefined;
            if (navTreeSearchMatch) {
              sendJson(
                res,
                200,
                engine.searchTreesPage(text, {
                  ...(mode === null ? {} : { mode }),
                  ...(limitRaw === null ? {} : { limit: navNumberParam(limitRaw, "limit") }),
                  ...(cursor === undefined ? {} : { cursor }),
                }),
              );
              return;
            }
            const scopeTreeId = url.searchParams.get("treeId");
            sendJson(
              res,
              200,
              engine.searchBranchesPage(text, {
                ...(mode === null ? {} : { mode }),
                ...(scopeTreeId === null ? {} : { treeId: decodeURIComponent(scopeTreeId) }),
                ...(limitRaw === null ? {} : { limit: navNumberParam(limitRaw, "limit") }),
                ...(cursor === undefined ? {} : { cursor }),
              }),
            );
            return;
          }
        }
        // 已识别 /api/nav/* 前缀但无匹配路由 → 404（与其他未匹配路径一致）。
      }
      /* ==================== D4-8 大规模树导航区段结束 ==================== */

      const treeMatch = /^\/api\/trees\/([^/]+)(?:\/(state|prompt|branches|switch|return|diagnostics|events|journal))?$/.exec(pathname);
      if (treeMatch !== null) {
        const treeId = asTreeId(treeMatch[1]!);
        const action = treeMatch[2];

        if (action === undefined && method === "GET") {
          sendJson(res, 200, service.getTreeState(treeId));
          return;
        }
        if (action === "state" && method === "GET") {
          sendJson(res, 200, service.getTreeState(treeId));
          return;
        }
        if (action === "diagnostics" && method === "GET") {
          // A5 诊断面：安全投影（无 session 引用/详情/cause/路径；策略决策如实未观测）。
          sendJson(res, 200, service.getTreeDiagnostics(treeId));
          return;
        }
        if (action === "events") {
          // P1 SSE 事件流：先校验树（404 JSON 在切流之前），再切换到流式响应。
          if (method !== "GET") {
            sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
            return;
          }
          const snapshot = service.getTreeDiagnostics(treeId); // EntityNotFoundError → 404
          startSseStream(req, res, treeId, snapshot);
          return;
        }
        if (action === "journal") {
          if (method !== "GET") {
            sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
            return;
          }
          const limitRaw = url.searchParams.get("limit");
          let limit = JOURNAL_DEFAULT_LIMIT;
          if (limitRaw !== null) {
            const parsed = Number(limitRaw);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > JOURNAL_MAX_LIMIT) {
              throw new InvalidArgumentError(
                `limit must be an integer between 1 and ${String(JOURNAL_MAX_LIMIT)} (got '${limitRaw}')`,
              );
            }
            limit = parsed;
          }
          sendJson(res, 200, { events: service.getTreeJournal(treeId, limit) });
          return;
        }
        if (action === "prompt" && method === "POST") {
          const body = await readJsonBody(req);
          const outcome = await service.prompt(
            treeId,
            requireString(body, "branchId") as BranchId,
            requireString(body, "text"),
          );
          sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
          return;
        }
        if (action === "branches" && method === "POST") {
          const body = await readJsonBody(req);
          const selection = body["selection"];
          if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
            throw new InvalidArgumentError("request field 'selection' must be an object {start, end, text}");
          }
          const creation = service.createBranchFromSelection(
            treeId,
            requireString(body, "sourceBranchId") as BranchId,
            requireString(body, "anchorTurnId"),
            selection as { start: number; end: number; text: string },
          );
          sendJson(res, 201, { branch: creation.branch, origin: creation.origin, state: service.getTreeState(treeId) });
          return;
        }
        if (action === "switch" && method === "POST") {
          const body = await readJsonBody(req);
          const cursor = await service.switchBranch(treeId, requireString(body, "branchId") as BranchId);
          sendJson(res, 200, { cursor, state: service.getTreeState(treeId) });
          return;
        }
        if (action === "return" && method === "POST") {
          const body = await readJsonBody(req);
          // 幂等 Return（保存先于导航，signed v3 §3.5）：新建 201 / 同键
          // 同内容重放 200（同一 returnTurn，零新写入）/ 同键不同内容 409
          // return-conflict。保存成功后的回程导航失败不映射为 HTTP 错误
          // ——Return 已保存，导航结果随 navigation 字段分离呈现（failed
          // + code/message），重放路径同样返回导航结果（重试即重新导航）。
          const submission = await service.submitReturn(
            treeId,
            requireString(body, "fromBranchId") as BranchId,
            requireString(body, "text"),
            requireString(body, "idempotencyKey"),
          );
          sendJson(res, submission.created ? 201 : 200, {
            returnTurn: submission.turn,
            navigation: submission.navigation,
            state: service.getTreeState(treeId),
          });
          return;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return;
      }

      /* POST /api/trees/:treeId/runs/:runId/abort —— 请求中止该树当前在途的 run。
         404 未知树/run；400 空 id/跨树 run；409 非活动 run（RunNotActiveError）
         或 prompt 已以 user-abort 收敛。 */
      const runAbortMatch = /^\/api\/trees\/([^/]+)\/runs\/([^/]+)\/abort$/.exec(pathname);
      if (runAbortMatch !== null) {
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return;
        }
        await service.abort(asTreeId(runAbortMatch[1]!), runAbortMatch[2]! as RunId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: { code: "not-found", message: `no route for ${method} ${pathname}` } });
    } catch (err) {
      sendError(res, err);
    }
  }

  return {
    server,
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("server did not bind to a TCP port"));
            return;
          }
          resolve(address.port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // fetch 客户端的 keep-alive 空闲连接会拖延 close()；打开中的 SSE 流
        // 是长连接（永远不空闲），且客户端单方面 abort 时（undici 保持
        // socket 复用）服务端甚至观察不到断开——必须主动终结 SSE 响应并
        // 兜底关闭全部连接，close() 才能及时完成。
        for (const res of sseResponses) {
          res.end();
        }
        sseResponses.clear();
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      });
    },
  };
}
