/** model ownership for core.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 平台与产物布局                                                      */
/* ------------------------------------------------------------------ */

/** 支持矩阵（issue #8 §5）：首批仅这三个平台；其余架构不默认为已支持。 */
export type TargetPlatform = "darwin-arm64" | "win-x64" | "linux-x64";

export interface PlatformSpec {
  /** 产物平台标识（目录/压缩包命名用）。 */
  readonly target: TargetPlatform;
  /** nodejs.org 发行版的平台后缀（node-vX.Y.Z-<suffix>…）。 */
  readonly nodeDistSuffix: string;
  /** 发行版压缩包扩展（决定下载 URL 与解包方式）。 */
  readonly nodeDistExt: ".tar.gz" | ".tar.xz" | ".zip";
  /** 发行包内 node 可执行文件的相对路径。 */
  readonly nodeBinaryInDist: string;
  /** 产物内的 node 可执行文件相对路径（BUNDLE_ROOT 起）。 */
  readonly nodeBinaryInBundle: string;
  /** 当前平台是否为 POSIX 语义（信号/权限/自删除策略）。 */
  readonly posix: boolean;
}

export type LauncherDriver = "echo" | "pi";

export interface LauncherConfig {
  readonly schemaVersion: number;
  /** 缺省 8787；被占用时启动器自动顺延（见 portCandidates）。 */
  readonly port: number;
  /** 缺省 echo（离线确定性回声，无网络无凭据）；pi 需 provider/model+key。 */
  readonly driver: LauncherDriver;
  readonly provider?: string;
  readonly model?: string;
  readonly agentDir?: string;
  readonly piTools?: readonly string[];
  readonly policyReadRoots?: readonly string[];
  readonly terminologyProvider?: string;
  readonly terminologyModel?: string;
  readonly terminologyBudgetTokens?: number;
  readonly noBrowser?: boolean;
}

export interface NodeDistSpec {
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly shasumsUrl: string;
  /** 发行包解开后，node 可执行文件在包目录内的相对路径。 */
  readonly binaryInArchive: string;
}

export interface BundleManifest {
  readonly schemaVersion: string;
  readonly product: string;
  readonly bundleVersion: string;
  readonly platform: TargetPlatform;
  readonly node: {
    readonly version: string;
    readonly distFile: string;
    readonly distSha256: string;
  };
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly builtAt: string;
  readonly signing: {
    readonly codeSigning: "absent";
    readonly notarization: "absent";
    readonly note: string;
  };
}

/* ------------------------------------------------------------------ */
/* 运行时状态文件（数据目录内 runtime.json）                           */
/* ------------------------------------------------------------------ */

export interface RuntimeState {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly startedAt: string;
  readonly bundleVersion: string;
}
