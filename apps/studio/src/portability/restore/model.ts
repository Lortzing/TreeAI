/** model ownership for restore-service.ts; compatibility entrypoint remains one level above. */
import type {
  ExportManifest,
  FactsFileShape,
} from "../package-format.ts";

/* ------------------------------------------------------------------ */
/* 选项与结果                                                           */
/* ------------------------------------------------------------------ */

export interface RestorePackageOptions {
  /** 导出包目录（含 manifest.json）。 */
  readonly packageDir: string;
  /** 恢复目标数据目录：必须为空（不存在或零条目）。 */
  readonly dataDir: string;
}

export interface RestorePackageResult {
  readonly dataDir: string;
  readonly manifest: ExportManifest;
  /** 恢复的事实行数（全表合计）。 */
  readonly rowsRestored: number;
  /** 恢复的材料原件数。 */
  readonly blobsRestored: number;
  /** 恢复的 session 文件数（未含 session 的包为 0）。 */
  readonly sessionsRestored: number;
  /** session 引用改写数（指向 <data>/sessions/ 的行数）。 */
  readonly sessionReferencesRewritten: number;
}

export interface WalkedFile {
  readonly relPath: string;
  readonly absPath: string;
}

export interface LoadedBlob {
  readonly hash: string;
  readonly bytes: Uint8Array;
}

export interface LoadedSession {
  readonly basename: string;
  readonly bytes: Uint8Array;
}

export interface LoadedPackage {
  readonly blobs: readonly LoadedBlob[];
  readonly facts: ReadonlyMap<string, FactsFileShape>;
  readonly sessions: readonly LoadedSession[];
  readonly readableCount: number;
}
