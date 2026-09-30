/**
 * @treeai/studio 可携带层（issue #8 D4-5 数据可携带与可恢复）。
 *
 * 公共面：包格式冻结定义（package-format）、导出（export-service +
 * readable-export）、恢复（restore-service）。CLI 接线见 src/index.ts 的
 * `export` 子命令与 `--import-package` 模式；HTTP 面不设端点（契约 §5：
 * CLI 而非 HTTP）。
 */

export {
  EXPORT_PACKAGE_FORMAT,
  FACTS_LAYOUT_SCHEMA_VERSION,
  FACT_TABLES,
  FACT_TABLES_BY_NAME,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  MAX_BLOB_ENTRY_BYTES,
  MAX_ENTRY_COUNT,
  MAX_FACTS_ENTRY_BYTES,
  MAX_MARKER_ENTRY_BYTES,
  MAX_READABLE_ENTRY_BYTES,
  MAX_SESSION_ENTRY_BYTES,
  MAX_TOTAL_PACKAGE_BYTES,
  PortabilityError,
  RESTORE_INSERT_ORDER,
  SESSIONS_SENSITIVE_MARKER,
  SESSIONS_SENSITIVE_MARKER_TEXT,
  TABLE_PRIMARY_KEYS,
  assertBlobFileName,
  assertFactsLayoutCurrent,
  assertSafePackagePath,
  assertSessionFileName,
  encodeFactsFile,
  encodeManifestFile,
  maxEntryBytesForKind,
  stableStringify,
  type ExportManifest,
  type ExportManifestEntry,
  type FactColumnKind,
  type FactColumnSpec,
  type FactTableSpec,
  type FactsFileShape,
  type ManifestEntryKind,
} from "./package-format.ts";

export {
  ExportService,
  exportPackage,
  type ExportPackageOptions,
  type ExportPackageResult,
} from "./export-service.ts";

export { renderReadableFiles, type ReadableFile, type ReadableRenderInput } from "./readable-export.ts";

export {
  assertRestoreTargetEmpty,
  restorePackage,
  type RestorePackageOptions,
  type RestorePackageResult,
} from "./restore-service.ts";
