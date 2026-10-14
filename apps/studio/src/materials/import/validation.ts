/** validation ownership for import-service.ts; compatibility entrypoint remains one level above. */
import {
  MaterialUnsupportedError,
} from "./errors.ts";
import {
  EXTENSION_KINDS,
} from "./policy.ts";
import type {
  MaterialParserKind,
} from "@treeai/contracts";
import {
  createHash,
} from "node:crypto";

/**
 * 扩展名 → 解析器种类（大小写不敏感）。无扩展名/未知扩展名 →
 * MaterialUnsupportedError（415，消息指明扩展名与支持集合）。
 */
export function detectMaterialParserKind(filename: string): MaterialParserKind {
  const dot = filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  const kind = EXTENSION_KINDS[extension];
  if (kind === undefined) {
    throw new MaterialUnsupportedError(
      `cannot import '${filename}': the '${dot < 0 ? "" : `.${extension}`}' extension is not a supported material kind ` +
        "(supported: .md and .markdown → markdown, .pdf → pdf)",
    );
  }
  return kind;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
