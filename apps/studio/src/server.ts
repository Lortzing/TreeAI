/**
 * Studio HTTP 面（node:http，零新增依赖）。
 *
 * JSON API + 静态页面（public/）。所有写路径返回更新后的完整树状态，
 * 让最小 UI 无需本地状态同步逻辑。
 *
 * 错误映射：EntityNotFoundError → 404；InvalidArgumentError/
 * ConstraintViolationError → 400；RunNotActiveError/ReturnConflictError
 * （同幂等键不同内容）/契约违规（如并发 prompt，TypeError）/用户中止
 * （TreeAIError code "user-abort"）→ 409；其余运行期 TreeAIError → 502
 * （上游失败）；PersistenceError → 500；其余 → 500。
 *
 * POST /api/trees/:id/return 幂等语义：新建 Return → 201；同
 * idempotencyKey 同内容重放 → 200（同一 returnTurn，零新写入）；同键
 * 不同内容 → 409 return-conflict。两种成功均返回 {returnTurn, state}。
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
import { RunNotActiveError, ReturnConflictError, type TreeStudioService, type TreeState } from "./service.ts";

const MAX_BODY_BYTES = 1_000_000;

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

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, { error: { code: "invalid-argument", message: "unparseable request URL" } });
      return;
    }
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

      const treeMatch = /^\/api\/trees\/([^/]+)(?:\/(state|prompt|branches|switch|return|diagnostics))?$/.exec(pathname);
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
          // 幂等 Return：新建 201 / 同键同内容重放 200（同一 returnTurn，
          // 零新写入）/ 同键不同内容 409 return-conflict；导航失败（如
          // session 文件缺失 → 502 session-corrupt）时 Return 未写入，
          // 同键重试不重复。
          const submission = await service.submitReturn(
            treeId,
            requireString(body, "fromBranchId") as BranchId,
            requireString(body, "text"),
            requireString(body, "idempotencyKey"),
          );
          sendJson(res, submission.created ? 201 : 200, {
            returnTurn: submission.turn,
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
        // fetch 客户端的 keep-alive 空闲连接会拖延 close()；主动关闭空闲连接。
        server.closeIdleConnections();
        server.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      });
    },
  };
}
