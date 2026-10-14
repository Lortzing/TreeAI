/** Saved-fact search HTTP projection; optional wiring and validation order are preserved. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { SearchService, toContractSearchHit } from "../../search/search-service.ts";
import { readJsonBody, parseSearchQuery, asTreeId } from "../requests.ts";
import { sendJson } from "../responses.ts";

export async function handleSearchRoute(
  req: IncomingMessage, res: ServerResponse, method: string, pathname: string,
  search: SearchService | null,
): Promise<boolean> {
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
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
      return true;
    }
    const treeId = treeSearchMatch === null ? null : asTreeId(treeSearchMatch[1]!);
    const query = parseSearchQuery(await readJsonBody(req));
    const hits = search.search(query.text, {
      treeId,
      ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
    });
    sendJson(res, 200, { hits: hits.map(toContractSearchHit) });
    return true;
  }
  return false;
}
