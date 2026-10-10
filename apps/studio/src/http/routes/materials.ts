/** D4 material API routes: import/version/range/reading position/branch/Return.
 * This adapter does not own database transactions; those remain within the existing services.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchId, MaterialId, MaterialVersionId } from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError } from "@treeai/persistence";
import type { TreeStudioService } from "../../service.ts";
import type { MaterialImportService } from "../../materials/import-service.ts";
import type { MaterialRangeResolver, ResolveSelectionInput } from "../../materials/range-resolver.ts";
import type { MaterialBranchingService } from "../../materials/branching.ts";
import { sendJson, sendPdfBytes, sendNoContent } from "../responses.ts";
import {
  asTreeId, decodeFilenameHeader, readMaterialBody, readJsonBody,
  requireString, parseMaterialSelection,
} from "../requests.ts";

export async function handleMaterialRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  pathname: string,
  service: TreeStudioService,
  materials: MaterialImportService | null,
  materialRanges: MaterialRangeResolver | null,
  materialBranching: MaterialBranchingService | null,
): Promise<boolean> {
      /* 材料导入/读取（issue #8 D4-1，契约 §3）。未装配（materials ===
         null）→ 503 如实说明，绝不伪装成功。上传为原始字节 body +
         x-treeai-filename 头（UTF-8 百分号编码）；404/415 预检在读 body
         之前完成。 */
      const materialsRootMatch = /^\/api\/trees\/([^/]+)\/materials$/.exec(pathname);
      if (materialsRootMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(materialsRootMatch[1]!);
        if (method === "GET") {
          sendJson(res, 200, { materials: materials.listTreeMaterials(treeId) });
          return true;
        }
        if (method === "POST") {
          const filename = decodeFilenameHeader(req);
          materials.precheckImport(treeId, filename);
          const bytes = await readMaterialBody(req, materials.limits.maxFileBytes);
          const result = await materials.importMaterial(treeId, { filename, bytes });
          sendJson(res, result.created ? 201 : 200, {
            material: result.material,
            version: result.version,
            created: result.created,
            parseTaskId: result.parseTaskId,
          });
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

      const materialMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)$/.exec(pathname);
      if (materialMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(materialMatch[1]!);
        const materialId = decodeURIComponent(materialMatch[2]!) as MaterialId;
        if (method === "GET") {
          sendJson(res, 200, materials.getMaterialDetail(treeId, materialId));
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

      /* 新版本导入（同语义/同返回码：201 新字节 / 200 同字节复用 / 413 / 415）。 */
      const materialVersionsMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions$/.exec(pathname);
      if (materialVersionsMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(materialVersionsMatch[1]!);
        const materialId = decodeURIComponent(materialVersionsMatch[2]!) as MaterialId;
        if (method === "POST") {
          const filename = decodeFilenameHeader(req);
          materials.precheckImport(treeId, filename);
          const bytes = await readMaterialBody(req, materials.limits.maxFileBytes);
          const result = await materials.addMaterialVersion(treeId, materialId, { filename, bytes });
          sendJson(res, result.created ? 201 : 200, {
            material: result.material,
            version: result.version,
            created: result.created,
            parseTaskId: result.parseTaskId,
          });
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

      const materialVersionFileMatch =
        /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/file$/.exec(pathname);
      if (materialVersionFileMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        if (method !== "GET") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(materialVersionFileMatch[1]!);
        const materialId = decodeURIComponent(materialVersionFileMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(materialVersionFileMatch[3]!) as MaterialVersionId;
        const file = materials.readVersionFile(treeId, materialId, versionId);
        sendPdfBytes(res, file.bytes, req.headers.range);
        return true;
      }

      /* canonicalText 分块读取：?afterBlock=&limit=（缺省从头、50 块）。 */
      const materialVersionMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
      if (materialVersionMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(materialVersionMatch[1]!);
        const materialId = decodeURIComponent(materialVersionMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(materialVersionMatch[3]!) as MaterialVersionId;
        if (method === "GET") {
          const afterBlockRaw = url.searchParams.get("afterBlock");
          let limit: number | undefined;
          const limitRaw = url.searchParams.get("limit");
          if (limitRaw !== null && limitRaw !== "") {
            const parsed = Number(limitRaw);
            if (!Number.isInteger(parsed)) {
              throw new InvalidArgumentError(`limit must be an integer (got '${limitRaw}')`);
            }
            limit = parsed;
          }
          const page = materials.readVersionBlocks(treeId, materialId, versionId, {
            afterBlock: afterBlockRaw === null || afterBlockRaw === "" ? null : afterBlockRaw,
            limit,
          });
          sendJson(res, 200, page);
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

      /* 取消解析任务（迟到结果不挂靠——版本行条件 UPDATE 结构性拒绝）。
         树作用域由路由校验（issue #8 P1）：treeId 参与解析，错误树统一 404。 */
      const parseTaskCancelMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/parse-tasks\/([^/]+)\/cancel$/.exec(pathname);
      if (parseTaskCancelMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(parseTaskCancelMatch[1]!);
        const materialId = decodeURIComponent(parseTaskCancelMatch[2]!) as MaterialId;
        const taskId = decodeURIComponent(parseTaskCancelMatch[3]!);
        const task = materials.cancelParseTask(treeId, taskId, materialId);
        sendJson(res, 200, { task });
        return true;
      }

      /* 持久化阅读位置（UPSERT 整体替换 → 204 无 body；D4-2 增读侧：
         GET → 200 {readingPosition: MaterialReadingPosition | null}）。 */
      const readingPositionMatch = /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/reading-position$/.exec(pathname);
      if (readingPositionMatch !== null) {
        if (materials === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        const treeId = asTreeId(readingPositionMatch[1]!);
        const materialId = decodeURIComponent(readingPositionMatch[2]!) as MaterialId;
        if (method === "GET") {
          sendJson(res, 200, { readingPosition: materials.getReadingPosition(treeId, materialId) });
          return true;
        }
        if (method === "PUT") {
          const body = await readJsonBody(req);
          const blockIdRaw = body["blockId"];
          if (blockIdRaw !== undefined && blockIdRaw !== null && typeof blockIdRaw !== "string") {
            throw new InvalidArgumentError("request field 'blockId' must be a string or null");
          }
          const focusRaw = body["focusStart"];
          if (focusRaw !== undefined && focusRaw !== null && !Number.isInteger(focusRaw)) {
            throw new InvalidArgumentError("request field 'focusStart' must be an integer or null");
          }
          materials.upsertReadingPosition(treeId, materialId, {
            versionId: requireString(body, "versionId") as MaterialVersionId,
            blockId: blockIdRaw === undefined ? null : (blockIdRaw as string | null),
            focusStart: focusRaw === undefined ? null : (focusRaw as number | null),
          });
          sendNoContent(res);
          return true;
        }
        sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
        return true;
      }

      /* D4-2 阅读与来源定位（issue #8 工作包 D4-2）——统一区间/锚点解析：
         POST …/versions/:versionId/resolve-selection
         body {locator, excerpt?, blockId?, anchor?} → 200 {selection, block}
         （规范 MaterialSelection：切片/块/UTF-16 边界/sourceHash 全通过）；
         区间纪律拒绝 → 400 + 稳定原因码（invalid-locator / needle-not-found /
         out-of-bounds / reversed / zero-length / surrogate-split /
         combining-split / emoji-split / excerpt-mismatch / stale-version /
         cross-page / cross-block / block-mismatch）；非 ready 版本 → 409
         material-not-ready（与分块读取同一纪律）。未装配 → 503。 */
      const resolveSelectionMatch =
        /^\/api\/trees\/([^/]+)\/materials\/([^/]+)\/versions\/([^/]+)\/resolve-selection$/.exec(pathname);
      if (resolveSelectionMatch !== null) {
        if (materials === null || materialRanges === null) {
          sendJson(res, 503, {
            error: { code: "materials-not-wired", message: "the material import service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(resolveSelectionMatch[1]!);
        const materialId = decodeURIComponent(resolveSelectionMatch[2]!) as MaterialId;
        const versionId = decodeURIComponent(resolveSelectionMatch[3]!) as MaterialVersionId;
        materials.getReadingPosition(treeId, materialId); // 树/材料作用域（404 于解析之前）
        const body = await readJsonBody(req);
        const locatorRaw = body["locator"];
        if (locatorRaw === null || typeof locatorRaw !== "object" || Array.isArray(locatorRaw)) {
          throw new InvalidArgumentError("request field 'locator' must be an object {kind, ...}");
        }
        const anchorRaw = body["anchor"];
        if (anchorRaw !== undefined && (anchorRaw === null || typeof anchorRaw !== "object" || Array.isArray(anchorRaw))) {
          throw new InvalidArgumentError("request field 'anchor' must be an object {versionId, sourceHash?}");
        }
        let anchor: ResolveSelectionInput["anchor"] | undefined;
        if (anchorRaw !== undefined) {
          const anchorRecord = anchorRaw as Record<string, unknown>;
          const anchorVersionId = anchorRecord["versionId"];
          if (typeof anchorVersionId !== "string" || anchorVersionId.length === 0) {
            throw new InvalidArgumentError("request field 'anchor.versionId' must be a non-empty string");
          }
          const anchorHash = anchorRecord["sourceHash"];
          if (anchorHash !== undefined && typeof anchorHash !== "string") {
            throw new InvalidArgumentError("request field 'anchor.sourceHash' must be a string");
          }
          anchor = {
            versionId: anchorVersionId as MaterialVersionId,
            ...(anchorHash === undefined ? {} : { sourceHash: anchorHash }),
          };
        }
        const excerptRaw = body["excerpt"];
        if (excerptRaw !== undefined && typeof excerptRaw !== "string") {
          throw new InvalidArgumentError("request field 'excerpt' must be a string");
        }
        const blockIdRaw = body["blockId"];
        if (blockIdRaw !== undefined && typeof blockIdRaw !== "string") {
          throw new InvalidArgumentError("request field 'blockId' must be a string");
        }
        const input: ResolveSelectionInput = {
          materialId,
          versionId,
          locator: locatorRaw as ResolveSelectionInput["locator"],
          ...(excerptRaw === undefined ? {} : { excerpt: excerptRaw }),
          ...(blockIdRaw === undefined ? {} : { blockId: blockIdRaw }),
          ...(anchor === undefined ? {} : { anchor }),
        };
        const resolution = materialRanges.resolve(input);
        if (!resolution.ok) {
          const { code, message } = resolution.rejection;
          if (code === "material-not-ready") {
            sendJson(res, 409, { error: { code, message } } satisfies ApiErrorBody);
          } else {
            sendJson(res, 400, { error: { code, message } } satisfies ApiErrorBody);
          }
          return true;
        }
        sendJson(res, 200, { selection: resolution.result.selection, block: resolution.result.block });
        return true;
      }

      /* ==================== D4-3 材料建枝区段（issue #8 charter §3.3 /
         ADR-004；服务 apps/studio/src/materials/branching.ts）====================
         契约 §3 的 from-material 在 D4-3 落地为两步（差异记录于
         D4-contracts.md §3）：建枝/恢复（零 Run/Turn，返回组合上下文供 UI
         在提交前说明材料范围）与首问（独立显式提交，先对账后行动）。
         未装配（materials === null → materialBranching === null）→ 503
         如实说明，绝不伪装成功。 */
      const fromMaterialMatch = /^\/api\/trees\/([^/]+)\/branches\/from-material$/.exec(pathname);
      if (fromMaterialMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(fromMaterialMatch[1]!);
        const body = await readJsonBody(req);
        const selection = parseMaterialSelection(body);
        const intentKey = requireString(body, "intentKey");
        const modeRaw = body["mode"];
        const mode = modeRaw === undefined ? "resume-or-create" : modeRaw;
        if (mode !== "resume-or-create" && mode !== "new") {
          throw new InvalidArgumentError("request field 'mode' must be 'resume-or-create' or 'new'");
        }
        if (mode === "new") {
          /* 显式另开：新 Branch + 新 session 意图（同键幂等重放 / 同键不同
             选区 409，由服务层判定）。 */
          const result = await materialBranching.restoreOrOpen({
            treeId,
            selection,
            mode: "new",
            intentKey,
          });
          sendJson(res, result.created ? 201 : 200, {
            mode: "created",
            branch: result.branch,
            origin: result.origin,
            context: result.context,
            created: result.created,
            navigation: result.navigation,
            sessionAvailability: result.sessionAvailability,
            state: service.getTreeState(treeId),
          });
          return true;
        }
        /* resume-or-create：同来源已有探索 → 恢复（intentKey 不绑定——
           恢复的是既有 Branch，其首问归属它自己的提交键）；无 → 按
           intentKey 新建。恢复的导航/会话可用性结果分离携带（失败不掩盖
           恢复本身）。 */
        try {
          const restored = await materialBranching.restoreOrOpen({ treeId, selection, mode: "restore" });
          sendJson(res, 200, {
            mode: "restored",
            branch: restored.branch,
            origin: restored.origin,
            context: restored.context,
            created: false,
            navigation: restored.navigation,
            sessionAvailability: restored.sessionAvailability,
            state: service.getTreeState(treeId),
          });
        } catch (err) {
          if (!(err instanceof EntityNotFoundError)) throw err;
          const created = materialBranching.createMaterialBranch({ treeId, selection, intentKey });
          sendJson(res, 201, {
            mode: "created",
            branch: created.branch,
            origin: created.origin,
            context: created.context,
            created: true,
            navigation: null,
            sessionAvailability: null,
            state: service.getTreeState(treeId),
          });
        }
        return true;
      }

      const materialFirstQuestionMatch = /^\/api\/trees\/([^/]+)\/material-first-question$/.exec(pathname);
      if (materialFirstQuestionMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(materialFirstQuestionMatch[1]!);
        const body = await readJsonBody(req);
        /* 目标分支经 (treeId, intentKey) 绑定解析（提交意图身份）；
           派发结局（succeeded/failed/unknown）是数据不是传输错误：200 携带
           dispatch 字段如实呈现；同键异问 409 由错误映射统一处理。 */
        const result = await materialBranching.firstQuestion({
          treeId,
          intentKey: requireString(body, "intentKey"),
          firstQuestion: requireString(body, "firstQuestion"),
        });
        sendJson(res, 200, {
          branch: result.branch,
          dispatch: result.dispatch,
          outcome: result.outcome,
          error: result.error,
          landed: result.landed,
          state: service.getTreeState(treeId),
        });
        return true;
      }

      const materialReturnMatch = /^\/api\/trees\/([^/]+)\/material-return$/.exec(pathname);
      if (materialReturnMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(materialReturnMatch[1]!);
        const body = await readJsonBody(req);
        const submission = await materialBranching.submitMaterialReturn({
          treeId,
          fromBranchId: requireString(body, "fromBranchId") as BranchId,
          text: requireString(body, "text"),
          idempotencyKey: requireString(body, "idempotencyKey"),
        });
        sendJson(res, submission.created ? 201 : 200, {
          returnTurn: submission.returnTurn,
          created: submission.created,
          navigation: submission.navigation,
          card: submission.card,
          state: service.getTreeState(treeId),
        });
        return true;
      }

      const materialNewExplorationMatch =
        /^\/api\/trees\/([^/]+)\/branches\/([^/]+)\/material-new-exploration$/.exec(pathname);
      if (materialNewExplorationMatch !== null) {
        if (materialBranching === null) {
          sendJson(res, 503, {
            error: { code: "material-branching-not-wired", message: "the material branching service is not wired in this process" },
          });
          return true;
        }
        if (method !== "POST") {
          sendJson(res, 405, { error: { code: "method-not-allowed", message: `${method} ${pathname}` } });
          return true;
        }
        const treeId = asTreeId(materialNewExplorationMatch[1]!);
        const body = await readJsonBody(req);
        const outcome = await materialBranching.promptNewMaterialExploration(
          treeId,
          decodeURIComponent(materialNewExplorationMatch[2]!) as BranchId,
          requireString(body, "text"),
        );
        sendJson(res, 200, { outcome, state: service.getTreeState(treeId) });
        return true;
      }
      /* ==================== D4-3 材料建枝区段结束 ==================== */

  return false;
}
