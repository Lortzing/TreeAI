import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchId, TurnId, TreeId } from "@treeai/contracts";
import { InvalidArgumentError } from "@treeai/persistence";
import type { GenerativeUiService } from "../../generative-ui/service.ts";
import { readJsonBody, requireString } from "../requests.ts";
import { sendJson } from "../responses.ts";

export async function handleGenerativeUiRoute(req: IncomingMessage, res: ServerResponse, url: URL, service: GenerativeUiService | null): Promise<boolean> {
  const match = /^\/api\/trees\/([^/]+)\/generative-ui(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return false;
  res.setHeader("Cache-Control", "no-store");
  let host: URL;
  try { host = new URL(`http://${req.headers.host ?? ""}`); } catch { sendJson(res, 403, { error: { code: "local-only", message: "仅允许同源本机请求。" } }); return true; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) || (req.headers.origin !== undefined && req.headers.origin !== host.origin) || (req.method !== "GET" && req.headers["x-treeai-generative-ui"] !== "1")) {
    sendJson(res, 403, { error: { code: "local-only", message: "请从 TreeAI 对比卡入口操作。" } }); return true;
  }
  if (!service) { sendJson(res, 503, { error: { code: "genui-unavailable", message: "此实例未启用对比卡。" } }); return true; }
  const treeId = decodeURIComponent(match[1]!) as TreeId;
  const rest = match[2] ?? "";
  if (rest === "" && req.method === "GET") {
    const branchId = (url.searchParams.get("branchId") ?? "") as BranchId;
    const turnId = (url.searchParams.get("turnId") ?? "") as TurnId;
    const tasks = service.list(treeId, branchId, turnId);
    let context = null, contextError = null;
    try { context = service.preview(treeId, branchId, turnId); } catch { contextError = "原文来源不可用或范围过大。已保存对比仍可阅读。"; }
    sendJson(res, 200, { tasks, context, contextError, usage: service.usage() }); return true;
  }
  if (rest === "" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (Object.keys(body).some(k => !["branchId", "anchorTurnId", "intentId", "instruction"].includes(k)) || (body.instruction !== undefined && typeof body.instruction !== "string")) throw new InvalidArgumentError("无效的对比卡请求。");
    sendJson(res, 202, { task: service.create(treeId, requireString(body, "branchId") as BranchId, requireString(body, "anchorTurnId") as TurnId, requireString(body, "intentId"), typeof body.instruction === "string" ? body.instruction : "") }); return true;
  }
  const sourceMatch = /^([^/]+)\/sources\/([^/]+)$/.exec(rest);
  if (sourceMatch && req.method === "GET") { sendJson(res, 200, { source: service.source(treeId, decodeURIComponent(sourceMatch[1]!), decodeURIComponent(sourceMatch[2]!)) }); return true; }
  const cancelMatch = /^([^/]+)\/cancel$/.exec(rest);
  if (cancelMatch && req.method === "POST") { sendJson(res, 200, { task: service.cancel(treeId, decodeURIComponent(cancelMatch[1]!)) }); return true; }
  if (/^[^/]+$/.test(rest) && req.method === "GET") { sendJson(res, 200, { task: service.get(treeId, decodeURIComponent(rest)) }); return true; }
  sendJson(res, 405, { error: { code: "method-not-allowed", message: "不支持的对比卡操作。" } }); return true;
}
