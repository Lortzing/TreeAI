import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiSettingsService } from "../../api-settings.ts";
import { readJsonBody } from "../requests.ts";
import { sendJson } from "../responses.ts";
export async function handleApiSettingsRoute(req: IncomingMessage, res: ServerResponse, pathname: string, service: ApiSettingsService | null): Promise<boolean> {
  if (pathname !== "/api/settings/models" && pathname !== "/api/settings/api" && pathname !== "/api/settings/api/test" && pathname !== "/api/settings/api/credentials") return false;
  res.setHeader("Cache-Control", "no-store");
  let target: URL;
  try { target = new URL(`http://${req.headers.host ?? ""}`); }
  catch { sendJson(res, 403, { error: { code: "local-only", message: "仅允许本机访问设置。" } }); return true; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || (req.headers.origin !== undefined && req.headers.origin !== target.origin)) {
    sendJson(res, 403, { error: { code: "local-only", message: "仅允许同源本机访问设置。" } }); return true;
  }
  if (service === null) { sendJson(res, 503, { error: { code: "settings-unavailable", message: "此实例未启用 API 设置。" } }); return true; }
  if (req.method === "GET" && pathname === "/api/settings/models") { sendJson(res, 200, service.activeModels()); return true; }
  if (req.method === "GET" && pathname === "/api/settings/api") { await service.refreshCredentials(); sendJson(res, 200, service.snapshot()); return true; }
  const credentialRequest = pathname === "/api/settings/api/credentials" && (req.method === "POST" || req.method === "DELETE");
  const settingsWrite = req.method === "PUT" && pathname === "/api/settings/api";
  const probeRequest = req.method === "POST" && pathname === "/api/settings/api/test";
  if (!credentialRequest && !settingsWrite && !probeRequest) {
    sendJson(res, 405, { error: { code: "method-not-allowed", message: "此设置接口不支持该操作。" } }); return true;
  }
  if (req.headers["x-treeai-settings"] !== "1") { sendJson(res, 403, { error: { code: "settings-header-required", message: "请通过 TreeAI 设置页修改配置。" } }); return true; }
  try {
    const body = await readJsonBody(req);
    sendJson(res, 200, credentialRequest ? await service.credential(body, req.method === "DELETE") : req.method === "PUT" ? service.save(body) : await service.test(body));
  } catch (error) {
    const conflict = error instanceof Error && error.message === "settings-conflict";
    const busy = error instanceof Error && error.message === "probe-busy";
    if (credentialRequest) {
      sendJson(res, 400, { error: { code: "credential-store-failed", message: "密钥操作失败，请检查设置与系统钥匙串状态。" } }); return true;
    }
    sendJson(res, conflict || busy ? 409 : 400, { error: { code: conflict ? "settings-conflict" : busy ? "probe-busy" : "invalid-settings", message: conflict ? "设置已被其他窗口修改，请重新打开后再保存。" : busy ? "连接测试正在运行，请稍后重试。" : "配置无效，请检查接口、地址、模型及环境变量名称。" } });
  }
  return true;
}
