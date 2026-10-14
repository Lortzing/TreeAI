/** validation ownership for material-repository.ts; compatibility entrypoint remains one level above. */
import {
  DatabaseCorruptError,
  InvalidArgumentError,
} from "../errors.ts";
import type {
  BranchOriginKind,
} from "./model.ts";
import {
  ORIGIN_KINDS,
  PARSE_STATUSES,
  PARSER_KINDS,
} from "./policy.ts";
import type {
  MaterialBlock,
  MaterialParserKind,
  MaterialParseStatus,
  MaterialSelection,
} from "@treeai/contracts";
import {
  createHash,
} from "node:crypto";

export function isParseStatus(value: string): value is MaterialParseStatus {
  return (PARSE_STATUSES as readonly string[]).includes(value);
}

export function isParserKind(value: string): value is MaterialParserKind {
  return (PARSER_KINDS as readonly string[]).includes(value);
}

export function isOriginKind(value: string): value is BranchOriginKind {
  return (ORIGIN_KINDS as readonly string[]).includes(value);
}

export function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
}

/** 原件字节 SHA-256（十六进制；内容寻址键）。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 版本 canonicalText 的 SHA-256（十六进制，UTF-8 编码口径）——
 * 与术语批注 hashSourceText 同一纪律（ADR-003 §2 sourceHash）。
 */
export function hashCanonicalText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 断言行内 parse_status 合法（schema CHECK 之外的双保险）。 */
export function assertParseStatus(status: string, context: string): MaterialParseStatus {
  if (!isParseStatus(status)) {
    throw new DatabaseCorruptError(`invalid parse status '${status}' in database (${context})`);
  }
  return status;
}

/** 断言行内 parser_kind 合法。 */
export function assertParserKind(kind: string, context: string): MaterialParserKind {
  if (!isParserKind(kind)) {
    throw new DatabaseCorruptError(`invalid parser kind '${kind}' in database (${context})`);
  }
  return kind;
}

/** 反序列化版本 block map（损坏 JSON/形状按库损坏处理）。 */
export function decodeBlockMap(versionId: string, json: string): MaterialBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DatabaseCorruptError(`stored block_map_json is not valid JSON (material version ${versionId})`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new DatabaseCorruptError(`stored block_map_json is not an array (material version ${versionId})`);
  }
  for (const block of parsed) {
    const candidate = block as Partial<MaterialBlock>;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.blockId !== "string" ||
      (candidate.kind !== "markdown-block" && candidate.kind !== "pdf-page") ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end)
    ) {
      throw new DatabaseCorruptError(
        `stored block_map_json entry lacks the MaterialBlock shape (material version ${versionId})`,
      );
    }
  }
  return parsed as MaterialBlock[];
}

/**
 * 校验块覆盖（B1 真值规则的存储侧防御）：blocks 对 canonicalText 有序
 * 连续覆盖——首块 start=0、blocks[i].end === blocks[i+1].start、末块
 * end=textLength；块 kind 与 parserKind 一致；空 canonicalText 时块为空。
 */
export function assertValidBlockCoverage(
  blocks: readonly MaterialBlock[],
  textLength: number,
  parserKind: MaterialParserKind,
): void {
  const expectedKind = parserKind === "markdown" ? "markdown-block" : "pdf-page";
  if (blocks.length === 0) {
    if (textLength !== 0) {
      throw new InvalidArgumentError(
        `blocks must continuously cover canonicalText (got 0 blocks for ${textLength} units)`,
      );
    }
    return;
  }
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    assertNonEmptyString(block.blockId, `blocks[${i}].blockId`);
    if (block.kind !== expectedKind) {
      throw new InvalidArgumentError(
        `blocks[${i}].kind must be '${expectedKind}' for parser kind '${parserKind}' (got '${String(block.kind)}')`,
      );
    }
    if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.end <= block.start) {
      throw new InvalidArgumentError(
        `blocks[${i}] must have integer offsets with end > start ` +
          `(got start=${String(block.start)}, end=${String(block.end)})`,
      );
    }
    if (block.start !== cursor) {
      throw new InvalidArgumentError(
        `blocks must continuously cover canonicalText: blocks[${i}] starts at ${String(block.start)}, ` +
          `expected ${cursor} (previous block ends at ${cursor})`,
      );
    }
    cursor = block.end;
  }
  if (cursor !== textLength) {
    throw new InvalidArgumentError(
      `blocks must continuously cover canonicalText: last block ends at ${cursor}, expected ${textLength}`,
    );
  }
}

/** 校验材料选区形状（字段类型/区间整数序）。 */
export function assertValidSelectionShape(selection: MaterialSelection): void {
  assertNonEmptyString(selection.materialId, "selection.materialId");
  assertNonEmptyString(selection.versionId, "selection.versionId");
  assertNonEmptyString(selection.blockId, "selection.blockId");
  assertNonEmptyString(selection.sourceHash, "selection.sourceHash");
  if (typeof selection.excerpt !== "string") {
    throw new InvalidArgumentError("selection.excerpt must be a string");
  }
  if (
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end)
  ) {
    throw new InvalidArgumentError("selection.start/end must be integers");
  }
}
