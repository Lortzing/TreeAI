import { handleTreeEntryRoute, handleTreeRoute } from "./http/routes/trees.ts";
import { handleSearchRoute } from "./http/routes/search.ts";
import { handleApiSettingsRoute } from "./http/routes/api-settings.ts";
import type { ApiSettingsService } from "./api-settings.ts";
/** TreeAI HTTP adapter; endpoint/error details: docs/architecture/http-implementation-notes.md. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sendError } from "./http/errors.ts";
import { createSseStream } from "./http/sse.ts";
import { createStaticResponder } from "./http/static.ts";
import { handleNavRoute } from "./http/routes/nav.ts";
import { handleTerminologyRoute } from "./http/routes/terminology.ts";
import { handleMaterialRoute } from "./http/routes/materials.ts";
import { sendJson } from "./http/responses.ts";
import type { TreeStudioService } from "./service.ts";
import { type TerminologyService } from "./terminology.ts";
import type { MaterialImportService } from "./materials/import-service.ts";
import { MaterialRangeResolver } from "./materials/range-resolver.ts";
import { MaterialBranchingService } from "./materials/branching.ts";
import type { SearchService } from "./search/search-service.ts";
import type { NavService } from "./nav/nav-service.ts";

export interface StudioServerOptions {
  readonly apiSettings?: ApiSettingsService | null;
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
      if (await handleApiSettingsRoute(req, res, pathname, options.apiSettings ?? null)) return;
      if (method === "GET" && (await serveStatic(res, pathname))) return;

      if (await handleTreeEntryRoute(req, res, method, pathname, service)) return;

      /* 术语三部分（issue #7 C）：/api/trees/:id/terminology/*。
         未装配（terminology === null）→ 503 如实说明，绝不伪装成功。 */
      if (await handleTerminologyRoute(req, res, method, pathname, terminology, service)) return;

      if (await handleMaterialRoute(req, res, url, method, pathname, service, materials, materialRanges, materialBranching)) return;

      if (await handleSearchRoute(req, res, method, pathname, search)) return;

      // Navigation reads durable product facts independently of Pi session availability.
      if (await handleNavRoute(req, res, url, method, pathname, nav)) return;

      if (await handleTreeRoute(req, res, url, method, pathname, service, startSseStream)) return;

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
