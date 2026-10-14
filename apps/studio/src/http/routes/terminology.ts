/** Terminology HTTP endpoints. Exposes the existing service without changing W1/quality gate or budget semantics. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchId, TerminologyMode, TurnId } from "@treeai/contracts";
import { InvalidArgumentError } from "@treeai/persistence";
import type { TerminologyService } from "../../terminology.ts";
import type { TreeStudioService } from "../../service.ts";
import { sendJson } from "../responses.ts";
import { readJsonBody, requireString, asTreeId } from "../requests.ts";

export async function handleTerminologyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  terminology: TerminologyService | null,
  service: TreeStudioService,
): Promise<boolean> {
      const terminologyMatch = /^\/api\/trees\/([^/]+)\/terminology(?:\/(.*))?$/.exec(pathname);
      if (terminologyMatch !== null) {
        const term = terminology;
        if (term === null || term === undefined) {
          sendJson(res, 503, {
            error: { code: "terminology-not-wired", message: "the terminology service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(terminologyMatch[1]!);
        const rest = terminologyMatch[2] ?? "";
        if (rest === "" && method === "GET") {
          sendJson(res, 200, term.readModel(treeId));
          return true;
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
          return true;
        }
        if (rest === "extract" && method === "POST") {
          const body = await readJsonBody(req);
          const task = await term.extract({
            treeId,
            branchId: requireString(body, "branchId") as BranchId,
            anchorTurnId: requireString(body, "anchorTurnId") as TurnId,
          });
          sendJson(res, 200, { task });
          return true;
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
          return true;
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
          return true;
        }
        const cancelMatch = /^tasks\/([^/]+)\/cancel$/.exec(rest);
        if (cancelMatch !== null && method === "POST") {
          sendJson(res, 200, { task: term.executor.cancel(decodeURIComponent(cancelMatch[1]!)) });
          return true;
        }
        if (rest === "preferences" && method === "PUT") {
          const body = await readJsonBody(req);
          const cacheEnabled = body["cacheEnabled"];
          if (typeof cacheEnabled !== "boolean") {
            throw new InvalidArgumentError("request field 'cacheEnabled' must be a boolean");
          }
          term.setCachePreference(cacheEnabled);
          sendJson(res, 200, { cacheEnabled: term.executor.cacheEnabled });
          return true;
        }
        /* 阅读模式（issue #7 术语①）：GET/PUT settings/reading-mode。
           枚举校验 → 400；未知树 → 404。模式可保存、可切换——质量门禁
           未过时零自动派发由 TerminologyService 保证（readModel 如实暴露
           autoSuggestions.enabled=false + 原因），路由层不伪装启用。 */
        if (rest === "settings/reading-mode" && method === "GET") {
          sendJson(res, 200, { readingMode: term.getReadingMode(treeId) });
          return true;
        }
        if (rest === "settings/reading-mode" && method === "PUT") {
          const body = await readJsonBody(req);
          const mode = body["mode"];
          if (mode !== "manual-only" && mode !== "minimal-hints" && mode !== "assisted-reading") {
            throw new InvalidArgumentError(
              "request field 'mode' must be one of 'manual-only' | 'minimal-hints' | 'assisted-reading'",
            );
          }
          term.setReadingMode(treeId, mode);
          sendJson(res, 200, { readingMode: mode });
          return true;
        }
        /* 建议集显式重试（budget-paused/failed 的「可恢复入口」——用户
           显式动作；gate 未过 → 400 建议管线整体关闭，绝不旁路）。 */
        const suggestRetryMatch = /^suggestions\/([^/]+)\/retry$/.exec(rest);
        if (suggestRetryMatch !== null && method === "POST") {
          const state = await term.retrySuggestions(
            treeId,
            decodeURIComponent(suggestRetryMatch[1]!) as TurnId,
          );
          sendJson(res, 200, { autoSuggestions: state });
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

  return false;
}
