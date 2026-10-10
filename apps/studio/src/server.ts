/** TreeAI HTTP adapter; endpoint/error details: docs/architecture/http-implementation-notes.md. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sendError } from "./http/errors.ts";
import { createSseStream } from "./http/sse.ts";
import { createStaticResponder } from "./http/static.ts";
import { handleNavRoute } from "./http/routes/nav.ts";
import { handleTerminologyRoute } from "./http/routes/terminology.ts";
import { handleMaterialRoute } from "./http/routes/materials.ts";
import { readJsonBody, requireString, parseSearchQuery, asTreeId } from "./http/requests.ts";
import { sendJson, type ApiErrorBody } from "./http/responses.ts";
import type { BranchId, RunId, TreeId, TurnId } from "@treeai/contracts";
import { ConstraintViolationError, EntityNotFoundError, InvalidArgumentError, PersistenceError } from "@treeai/persistence";
import { RunNotActiveError, NewExplorationConflictError, ReturnConflictError, type TreeDiagnostics, type TreeStudioService, type TreeState } from "./service.ts";
import { type TerminologyService } from "./terminology.ts";
import type { MaterialImportService } from "./materials/import-service.ts";
import { MaterialRangeResolver } from "./materials/range-resolver.ts";
import { MaterialBranchingService } from "./materials/branching.ts";
import type { SearchDocumentKind } from "./search/search-engine.ts";
import { SEARCH_DOCUMENT_KINDS, SearchService, toContractSearchHit } from "./search/search-service.ts";
import type { NavService } from "./nav/nav-service.ts";

const JOURNAL_DEFAULT_LIMIT = 50;
const JOURNAL_MAX_LIMIT = 500;

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

  const serveStatic = createStaticResponder(staticDir);

  /**
   * SSE 流：snapshot（连接时的诊断面投影）→ 按事件类型转发该树的安全
   * UI 事件；~15s 心跳注释；客户端断开即退订。headers 写出后不再抛错
   * （写失败静默——客户端已断开时 write 不 throw）。
   */
  const startSseStream = createSseStream(service, sseResponses);

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
      if (await handleTerminologyRoute(req, res, method, pathname, terminology, service)) return;

      if (await handleMaterialRoute(req, res, url, method, pathname, service, materials, materialRanges, materialBranching)) return;

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
      if (await handleNavRoute(req, res, url, method, pathname, nav)) return;
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
