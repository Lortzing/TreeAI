/** errors ownership for import-service.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialVersion,
  MaterialVersionId,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 错误（HTTP 层映射见 server.ts：415/413/409）                         */
/* ------------------------------------------------------------------ */

/** 不支持的材料（扩展名未知 / 解析器未装配）→ 415 material-unsupported。 */
export class MaterialUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialUnsupportedError";
  }
}

/** 超过单文件上限（charter §5：解析前拒绝）→ 413 material-too-large。 */
export class MaterialTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxFileBytes: number;

  constructor(sizeBytes: number, maxFileBytes: number) {
    super(
      `the material is ${sizeBytes} bytes, exceeding the ${maxFileBytes}-byte single-file limit ` +
        "(rejected before parsing; charter D4 §5)",
    );
    this.name = "MaterialTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxFileBytes = maxFileBytes;
  }
}

/** 非 ready 版本的分块读取（或建枝前置）→ 409 material-not-ready。 */
export class MaterialNotReadyError extends Error {
  readonly versionId: MaterialVersionId;
  readonly parseStatus: string;

  constructor(version: MaterialVersion) {
    super(
      `material version ${version.id} is not ready for reading (parse status '${version.parseStatus}'` +
        `${version.parseError === null ? "" : `: ${version.parseError}`}); ` +
        "unsupported/failed/canceled materials are never presented as empty ready documents",
    );
    this.name = "MaterialNotReadyError";
    this.versionId = version.id;
    this.parseStatus = version.parseStatus;
  }
}

/** 取消目标不可取消（已终态：ready/failed/canceled）→ 409。 */
export class ParseTaskNotCancelableError extends Error {
  readonly taskId: string;
  readonly state: string;

  constructor(taskId: string, state: string) {
    super(
      `parse task ${taskId} is already terminal ('${state}'); only pending or parsing tasks can be canceled`,
    );
    this.name = "ParseTaskNotCancelableError";
    this.taskId = taskId;
    this.state = state;
  }
}
