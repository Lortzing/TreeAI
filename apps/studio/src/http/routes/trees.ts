import type { MaterialImportService } from "../../materials/import-service.ts";
import type { ApiSettingsService } from "../../api-settings.ts";
/** Tree conversation HTTP routes. Product writes and error mapping remain in their existing owners. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchId, RunId } from "@treeai/contracts";
import { InvalidArgumentError } from "@treeai/persistence";
import type { TreeStudioService, TreeState } from "../../service.ts";
import { readJsonBody, requireString, asTreeId } from "../requests.ts";
import { sendJson } from "../responses.ts";
import { createSseStream } from "../sse.ts";

const JOURNAL_DEFAULT_LIMIT = 50;
const JOURNAL_MAX_LIMIT = 500;

/** Collection, source and recovery routes precede feature-specific handlers, as before. */
export async function handleTreeEntryRoute(
  req: IncomingMessage, res: ServerResponse, method: string, pathname: string,
  service: TreeStudioService,
): Promise<boolean> {
  if (pathname === "/api/trees") {
    if (method === "GET") {
      sendJson(res, 200, { trees: service.listTrees() });
      return true;
    }
    if (method === "POST") {
      const created = service.createTree();
      const state: TreeState = service.getTreeState(created.tree.id);
      sendJson(res, 201, { tree: created.tree, trunkBranchId: created.trunkBranch.id, state });
      return true;
    }
    sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} /api/trees` } });
    return true;
  }
  
  const sourceMatch = /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/source$/.exec(pathname);
  if (sourceMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
      return true;
    }
    const treeId = asTreeId(sourceMatch[1]!);
    const source = await service.revealBranchOrigin(treeId, decodeURIComponent(sourceMatch[2]!) as BranchId);
    sendJson(res, 200, { source, state: service.getTreeState(treeId) });
    return true;
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
      return true;
    }
    const treeId = asTreeId(newExplorationMatch[1]!);
    const body = await readJsonBody(req);
    const outcome = await service.promptNewExploration(
      treeId,
      decodeURIComponent(newExplorationMatch[2]!) as BranchId,
      requireString(body, "text"),
    );
    sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
    return true;
  }
  return false;
}

/** Tree state, conversation, Return, journal, events and run cancellation. */
export async function handleTreeRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, method: string, pathname: string,
  service: TreeStudioService, startSseStream: ReturnType<typeof createSseStream>, apiSettings?: ApiSettingsService, materials?: MaterialImportService | null,
): Promise<boolean> {
  const treeMatch = /^\/api\/trees\/([^/]+)(?:\/(state|prompt|branches|switch|return|diagnostics|events|journal))?$/.exec(pathname);
  if (treeMatch !== null) {
    const treeId = asTreeId(treeMatch[1]!);
    const action = treeMatch[2];
  
    if (action === undefined && method === "GET") {
      sendJson(res, 200, service.getTreeState(treeId));
      return true;
    }
    if (action === "state" && method === "GET") {
      sendJson(res, 200, service.getTreeState(treeId));
      return true;
    }
    if (action === "diagnostics" && method === "GET") {
      // A5 诊断面：安全投影（无 session 引用/详情/cause/路径；策略决策如实未观测）。
      sendJson(res, 200, service.getTreeDiagnostics(treeId));
      return true;
    }
    if (action === "events") {
      // P1 SSE 事件流：先校验树（404 JSON 在切流之前），再切换到流式响应。
      if (method !== "GET") {
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }
      const snapshot = service.getTreeDiagnostics(treeId); // EntityNotFoundError → 404
      startSseStream(req, res, treeId, snapshot);
      return true;
    }
    if (action === "journal") {
      if (method !== "GET") {
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
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
      return true;
    }
    if (action === "prompt" && method === "POST") {
      const body = await readJsonBody(req);
      let model: { providerId: string; modelId: string } | undefined;
      if (body["model"] !== undefined) {
        const requested = body["model"] as { providerId?: unknown; modelId?: unknown } | null;
        const available = apiSettings?.activeModels().models.find(candidate => candidate.providerId === requested?.providerId && candidate.modelId === requested?.modelId);
        if (!available) throw new InvalidArgumentError("所选模型尚未在当前进程启用，请检查设置或重启后重试。");
        model = { providerId: available.providerId, modelId: available.modelId };
      }
      if (body["attachments"] !== undefined && !materials) throw new InvalidArgumentError("当前实例未启用材料服务。");
      const attachmentContext = body["attachments"] === undefined ? {} : materials!.composeAttachments(treeId, body["attachments"]);
      const outcome = await service.prompt(
        treeId,
        requireString(body, "branchId") as BranchId,
        requireString(body, "text"),
        { ...attachmentContext, ...(model ? { model } : {}) },
      );
      sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
      return true;
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
      return true;
    }
    if (action === "switch" && method === "POST") {
      const body = await readJsonBody(req);
      const cursor = await service.switchBranch(treeId, requireString(body, "branchId") as BranchId);
      sendJson(res, 200, { cursor, state: service.getTreeState(treeId) });
      return true;
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
      return true;
    }
    sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
    return true;
  }
  
  /* POST /api/trees/:treeId/runs/:runId/abort —— 请求中止该树当前在途的 run。
     404 未知树/run；400 空 id/跨树 run；409 非活动 run（RunNotActiveError）
     或 prompt 已以 user-abort 收敛。 */
  const runAbortMatch = /^\/api\/trees\/([^/]+)\/runs\/([^/]+)\/abort$/.exec(pathname);
  if (runAbortMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
      return true;
    }
    await service.abort(asTreeId(runAbortMatch[1]!), runAbortMatch[2]! as RunId);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
