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
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BranchId,
  MaterialId,
  MaterialVersionId,
  RunId,
  TerminologyMode,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  PersistenceError,
} from "@treeai/persistence";
import { RunNotActiveError, NewExplorationConflictError, ReturnConflictError, type TreeDiagnostics, type TreeStudioService, type TreeState } from "./service.ts";
import {
  TerminologyPromotionConflictError,
  type TerminologyService,
} from "./terminology.ts";
import {
  MaterialImportService,
  MaterialNotReadyError,
  MaterialTooLargeError,
  MaterialUnsupportedError,
  ParseTaskNotCancelableError,
} from "./materials/import-service.ts";
import { MaterialRangeResolver, type ResolveSelectionInput } from "./materials/range-resolver.ts";

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
}

export interface StudioServer {
  readonly server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof EntityNotFoundError) {
    sendJson(res, 404, { error: { code: "not-found", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof InvalidArgumentError || err instanceof ConstraintViolationError) {
    sendJson(res, 400, { error: { code: "invalid-argument", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof RunNotActiveError) {
    // abort 目标不是该树当前在途 run（已终态/无在途/另有在途）——操作冲突。
    sendJson(res, 409, { error: { code: "conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof ReturnConflictError) {
    // 同幂等键已绑定不同内容的 Return——重试语义冲突（既有 Return 不变）。
    sendJson(res, 409, { error: { code: "return-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof NewExplorationConflictError) {
    // 「以保存内容开始新的探索」的前置条件不满足（session 仍可用 / 无历史
    // session）——与分支当前状态冲突，零写入。
    sendJson(res, 409, { error: { code: "new-exploration-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof TerminologyPromotionConflictError) {
    // 术语推广冲突（同批注异键 / 并发竞争判负）——既有推广不变。
    sendJson(res, 409, { error: { code: "terminology-promotion-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialUnsupportedError) {
    // 不支持的材料（未知扩展名 / 解析器未装配，如 D4-1 集成前的 pdf）。
    sendJson(res, 415, { error: { code: "material-unsupported", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialTooLargeError) {
    // 超过单文件上限（charter §5：解析前拒绝）。
    sendJson(res, 413, { error: { code: "material-too-large", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialNotReadyError) {
    // 非 ready 版本的读取/建枝前置（不支持/失败/取消绝不伪装空成功文档）。
    sendJson(res, 409, { error: { code: "material-not-ready", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof ParseTaskNotCancelableError) {
    // 取消目标已终态（ready/failed/canceled）——操作冲突。
    sendJson(res, 409, { error: { code: "parse-task-not-cancelable", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof TypeError) {
    // 调用方契约违规（如并发 prompt）——单用户本地工具下按操作冲突呈现。
    sendJson(res, 409, { error: { code: "conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      if (candidate.code === "user-abort") {
        // 用户/宿主主动中止，不是上游失败：按操作冲突呈现（run 已收敛 aborted）。
        sendJson(res, 409, { error: { code: "user-abort", message: candidate.message } } satisfies ApiErrorBody);
        return;
      }
      // TreeAIError（运行期失败：auth/upstream/session-corrupt/…）
      sendJson(res, 502, { error: { code: candidate.code, message: candidate.message } } satisfies ApiErrorBody);
      return;
    }
  }
  if (err instanceof PersistenceError) {
    sendJson(res, 500, { error: { code: err.code, message: err.message } } satisfies ApiErrorBody);
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  sendJson(res, 500, { error: { code: "internal", message } } satisfies ApiErrorBody);
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

/** 204 No Content（无 body；阅读位置 PUT 的成功响应）。 */
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function asTreeId(raw: string): TreeId {
  return decodeURIComponent(raw) as TreeId;
}

export function createStudioServer(options: StudioServerOptions): StudioServer {
  const { service, staticDir } = options;
  const terminology = options.terminology ?? null;
  const materials = options.materials ?? null;
  /* D4-2 统一区间/锚点解析层：与材料服务同一仓储派生（materials 未装配
     即为 null → 解析路由 503 materials-not-wired，绝不伪装成功）。 */
  const materialRanges =
    materials === null ? null : new MaterialRangeResolver({ repository: materials.repository });
  /** 打开中的 SSE 连接（close() 时主动终结，保证 server.close() 不被挂住）。 */
  const sseResponses = new Set<ServerResponse>();

  async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
    const entry = STATIC_FILES[pathname];
    if (entry === undefined) return false;
    try {
      const content = await readFile(join(staticDir, entry.file));
      res.writeHead(200, {
        "content-type": entry.type,
        "content-length": content.length,
        "cache-control": "no-store",
      });
      res.end(content);
      return true;
    } catch {
      sendJson(res, 500, { error: { code: "internal", message: `static file missing: ${entry.file}` } });
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
