/** D4 tree navigation HTTP routes. No DB/session changes; all error mapping stays in server boundary. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchId } from "@treeai/contracts";
import { InvalidArgumentError } from "@treeai/persistence";
import type { NavService } from "../../nav/nav-service.ts";
import type { NavSearchMode } from "../../nav/nav-engine.ts";
import { sendJson, sendNoContent } from "../responses.ts";
import { readJsonBody, parseNavExpandStateBody, navNumberParam, navPageOptions, asTreeId } from "../requests.ts";

/** Return false only for non-nav paths or unrecognized nav routes (caller emits 404). */
export async function handleNavRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  pathname: string,
  nav: NavService | null,
): Promise<boolean> {
      if (pathname === "/api/nav" || pathname.startsWith("/api/nav/")) {
        if (nav === null) {
          sendJson(res, 503, {
            error: { code: "nav-not-wired", message: "the tree navigation service is not wired in this process" },
          });
          return true;
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
              return true;
            }
            sendJson(res, 200, engine.listTrees(navPageOptions(url)));
            return true;
          }
          if (navTreeMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
            }
            sendJson(res, 200, engine.getTreeOverview(asTreeId(navTreeMatch[1]!)));
            return true;
          }
          if (navChildrenMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
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
            return true;
          }
          if (navSubtreeMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
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
            return true;
          }
          if (navPathMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
            }
            sendJson(res, 200, {
              treeId: decodeURIComponent(navPathMatch[1]!),
              branchId: decodeURIComponent(navPathMatch[2]!),
              path: engine.fullPath(decodeURIComponent(navPathMatch[1]!), decodeURIComponent(navPathMatch[2]!)),
            });
            return true;
          }
          if (navExpandStateMatch !== null) {
            const treeId = asTreeId(navExpandStateMatch[1]!);
            if (method === "GET") {
              sendJson(res, 200, { expandState: nav.getExpandState(treeId) });
              return true;
            }
            if (method === "PUT") {
              const body = parseNavExpandStateBody(await readJsonBody(req));
              nav.saveExpandState({ treeId, ...body });
              sendNoContent(res);
              return true;
            }
            sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
            return true;
          }
          if (navLocateMatch !== null) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
            }
            sendJson(res, 200, engine.locateBranch(decodeURIComponent(navLocateMatch[1]!) as BranchId));
            return true;
          }
          if (navTreeSearchMatch || navBranchSearchMatch) {
            if (method !== "GET") {
              sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
              return true;
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
              return true;
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
            return true;
          }
        }
        // 已识别 /api/nav/* 前缀但无匹配路由 → 404（与其他未匹配路径一致）。
      }
  return false;
}
