/** Original Studio HTTP request parsing and API validation rules. */
import type { IncomingMessage } from "node:http";
import type { BranchId, MaterialId, MaterialVersionId, TreeId } from "@treeai/contracts";
import { InvalidArgumentError } from "@treeai/persistence";
import { MaterialTooLargeError } from "../materials/import-service.ts";
import { SEARCH_DOCUMENT_KINDS } from "../search/search-service.ts";
import type { SearchDocumentKind } from "../search/search-engine.ts";

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidArgumentError(`request field '${field}' must be a non-empty string`);
  }
  return value;
}

/**
 * 材料建枝请求体的规范选区（D4-3）：{materialId, versionId, blockId, start,
 * end, excerpt, sourceHash}——D4-2 resolve-selection 的产出形状。此处只做
 * 形状校验；切片/块/sourceHash 锚定纪律由材料仓储 getMaterialSelection
 * （经建枝服务）再校验。
 */
export function parseMaterialSelection(body: Record<string, unknown>): {
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly sourceHash: string;
} {
  const selection = body["selection"];
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    throw new InvalidArgumentError(
      "request field 'selection' must be an object {materialId, versionId, blockId, start, end, excerpt, sourceHash}",
    );
  }
  const record = selection as Record<string, unknown>;
  const materialId = record["materialId"];
  const versionId = record["versionId"];
  const blockId = record["blockId"];
  const start = record["start"];
  const end = record["end"];
  const excerpt = record["excerpt"];
  const sourceHash = record["sourceHash"];
  if (
    typeof materialId !== "string" ||
    typeof versionId !== "string" ||
    typeof blockId !== "string" ||
    typeof excerpt !== "string" ||
    typeof sourceHash !== "string"
  ) {
    throw new InvalidArgumentError("selection string fields (materialId/versionId/blockId/excerpt/sourceHash) are required");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new InvalidArgumentError("selection start/end must be integers (UTF-16 half-open range)");
  }
  return {
    materialId: materialId as MaterialId,
    versionId: versionId as MaterialVersionId,
    blockId,
    start: start as number,
    end: end as number,
    excerpt,
    sourceHash,
  };
}

/**
 * 材料导入的原始字节 body（契约 §3：本地 loopback 原始字节上传，零
 * multipart 依赖）。超限即刻停止累积（内存有界）但持续排空至流尾再拒绝
 * ——既不缓冲超限数据，也让客户端确定性地读到 413 响应。
 */
export async function readMaterialBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (exceeded) continue;
    if (size > maxBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    throw new MaterialTooLargeError(size, maxBytes);
  }
  return Buffer.concat(chunks);
}

/** x-treeai-filename 头（UTF-8 百分号编码）→ 文件名；缺失/畸形 → 400。 */
export function decodeFilenameHeader(req: IncomingMessage): string {
  const raw = req.headers["x-treeai-filename"];
  const joined = Array.isArray(raw) ? raw.join("") : raw;
  if (typeof joined !== "string" || joined.trim().length === 0) {
    throw new InvalidArgumentError("the x-treeai-filename header is required (UTF-8 percent-encoded)");
  }
  try {
    return decodeURIComponent(joined);
  } catch {
    throw new InvalidArgumentError("the x-treeai-filename header is not valid percent-encoded UTF-8");
  }
}

/**
 * 搜索请求体（契约 §3，issue #8 D4-4）：{text, kinds?} → 引擎选项。
 * 空/纯空白 text（无任何可检索单元）→ 400；kinds 非法（非数组/空数组/
 * 未知成员）→ 400（引擎对这些 fail-fast 抛 SearchEngineError，必须在
 * HTTP 面先行校验成 400，不得漏成 500）。
 */
export function parseSearchQuery(body: Record<string, unknown>): {
  readonly text: string;
  readonly kinds?: ReadonlyArray<SearchDocumentKind>;
} {
  const text = body["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new InvalidArgumentError("request field 'text' must be a non-empty (not blank) string");
  }
  const rawKinds = body["kinds"];
  if (rawKinds === undefined) return { text };
  if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
    throw new InvalidArgumentError(
      "request field 'kinds' must be a non-empty array of 'material' | 'annotation' | 'return' | 'turn'",
    );
  }
  const kinds: SearchDocumentKind[] = [];
  for (const entry of rawKinds) {
    if (typeof entry !== "string" || !SEARCH_DOCUMENT_KINDS.has(entry)) {
      throw new InvalidArgumentError(
        `request field 'kinds' must contain only 'material' | 'annotation' | 'return' | 'turn' (got ${String(entry)})`,
      );
    }
    if (!kinds.includes(entry as SearchDocumentKind)) kinds.push(entry as SearchDocumentKind);
  }
  return { text, kinds };
}

/** 204 No Content（无 body；阅读位置 PUT 的成功响应）。 */
/**
 * 导航查询参数 → 数值（issue #8 D4-8）：非数字/非整数交由引擎层校验
 * （NavEngineError invalid-argument → 400，原因码稳定）。
 */
export function navNumberParam(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`query parameter '${name}' must be a number (got '${raw}')`);
  }
  return parsed;
}

/** 导航分页查询参数（cursor/limit；缺省走引擎默认）。 */
export function navPageOptions(url: URL): { readonly cursor?: string; readonly limit?: number } {
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: navNumberParam(limit, "limit") }),
  };
}

/**
 * 展开状态 PUT 请求体（issue #8 D4-8）：{expandedBranchIds, selectedBranchId?}。
 * 数组形状在此校验（400）；成员存在性/树归属在仓储层校验（404/400）。
 */
export function parseNavExpandStateBody(body: Record<string, unknown>): {
  readonly expandedBranchIds: readonly BranchId[];
  readonly selectedBranchId: BranchId | null;
} {
  const raw = body["expandedBranchIds"];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    throw new InvalidArgumentError("request field 'expandedBranchIds' must be an array of branch ids");
  }
  const selected = body["selectedBranchId"];
  if (selected !== undefined && selected !== null && typeof selected !== "string") {
    throw new InvalidArgumentError(
      "request field 'selectedBranchId' must be a branch id string or null (reading position)",
    );
  }
  return {
    expandedBranchIds: raw as readonly BranchId[],
    selectedBranchId: (selected as BranchId | null | undefined) ?? null,
  };
}

export function asTreeId(raw: string): TreeId {
  return decodeURIComponent(raw) as TreeId;
}

