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
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BranchId, RunId, TreeId } from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  PersistenceError,
} from "@treeai/persistence";
import { RunNotActiveError, NewExplorationConflictError, ReturnConflictError, type TreeDiagnostics, type TreeStudioService, type TreeState } from "./service.ts";

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

function asTreeId(raw: string): TreeId {
  return decodeURIComponent(raw) as TreeId;
}

export function createStudioServer(options: StudioServerOptions): StudioServer {
  const { service, staticDir } = options;
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
