/**
 * Studio CLI 解析与真实 Pi 驱动边界校验（非秘密面）。
 *
 * 从 src/index.ts 抽出（index.ts import 即启动服务器，无法单测），本模块：
 *   - 不触文件系统、不触网络、不 import Pi SDK（模块级零运行时依赖：
 *     工具缝的读取根存在性探针与策略引擎工厂由调用方注入——与 env →
 *     readPiApiKey 同一注入纪律）；
 *   - 不打印任何东西；
 *   - API key 的**值**只从注入的 env 对象读入并原样返回，交给调用方
 *     直接送入 runtime 工厂（与 D2 live 验证器同一纪律：只在内存中持有，
 *     绝不日志、绝不落库、绝不写 evidence；日志/错误里只允许出现
 *     环境变量**名字**）。
 *
 * 真实 Pi 驱动的受控缝（audit 修复）：
 *   - agent 目录显式受控：--agent-dir 显式指定，默认数据目录内的
 *     pi-agent/（数据目录本地）；绝不静默回落 ~/.pi；
 *   - API key 仅环境注入（TREEAI_STUDIO_API_KEY），永不作为 CLI 参数
 *     （argv 会进 shell 历史/进程列表）。
 *
 * 真实 Pi 驱动的工具缝（issue #6 P0-3「权限真路径」，默认关闭）：
 *   - --pi-tools TOOL,TOOL：Pi 工具 allowlist（如 "read"）。缺省零工具
 *     （既有行为，字节级不变）。给出即装配请求时策略门：工具调用在
 *     实际执行前经真实 ToolPolicy 引擎评估（runtime-pi 的
 *     PiRuntimeConfig.tools + toolPolicy 缝），deny / require-approval
 *     不执行并以 policy-denied 收敛该次 run（fail closed）；
 *   - --policy-read-roots DIR,DIR：读取根（逗号分隔的**绝对**目录，
 *     且须已存在）。缺省为数据目录内的 workspace/。写入根恒为空
 *     （一切写入拒绝——默认无逐次授权）；shell / network 默认拒绝；
 *     CLI 不提供放开开关（fail-closed 缺省，放开属负责人后续决策）。
 */

import { isAbsolute, join, resolve } from "node:path";
import type { PiToolPolicyEvaluator } from "@treeai/runtime-pi";

/** 真实 Pi 驱动的 API key 环境变量。日志/错误中只允许出现该名字。 */
export const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";

/** pi 驱动默认 agent 目录名（位于 --data 目录内，受控且数据目录本地）。 */
export const DEFAULT_PI_AGENT_DIR_NAME = "pi-agent";

export interface CliOptions {
  readonly port: number;
  readonly dataDir: string;
  readonly driver: "echo" | "pi";
  readonly providerId: string;
  readonly modelId: string;
  /**
   * 绝对 Pi agent 目录（provider/扩展/auth.json/models.json 的加载根）。
   * echo 驱动为 null（echo 从不读取 Pi agent 目录）。
   */
  readonly agentDir: string | null;
  /**
   * 真实 Pi 驱动的工具 allowlist（issue #6 P0-3）：逗号分隔的 Pi 工具名
   * （如 "read"）。null = 未给出（缺省零工具 + 无策略门，既有行为）。
   */
  readonly piTools: readonly string[] | null;
  /**
   * ToolPolicy 读取根（逗号分隔的**绝对**目录）。null = 未给出——
   * --pi-tools 给出时由 resolvePiToolWiring 缺省为数据目录 workspace/。
   * 仅在 --pi-tools 给出时合法。
   */
  readonly policyReadRoots: readonly string[] | null;
  /**
   * 术语执行器的 provider（issue #7 C ① 隔离 provider；缺省 = 主 provider）。
   */
  readonly terminologyProviderId: string;
  /** 术语执行器的 model（缺省 = 主 model）。 */
  readonly terminologyModelId: string;
  /** 术语执行器的累计预算（估算 token，chars/4 口径；缺省 1,000,000）。 */
  readonly terminologyBudgetTokens: number;
  /**
   * D4-5 运行模式（issue #8 契约 §5，CLI 而非 HTTP）：
   * - "server"：既有本地服务（缺省）；
   * - "export"：`export --out <dir>` 把 --data 的全部已保存产品事实导出为
   *   版本化包（默认不含凭据/缓存/运行日志/Pi session；--include-sessions
   *   显式包含并显著标注敏感；--readable 附带可读 Markdown 导出），完成后
   *   退出；
   * - "import"：`--import-package <dir>` 把包恢复到 --data（仅空数据目录），
   *   完成后退出。两种模式都不启动服务器、不创建 sessions/workspace。
   */
  readonly mode: "server" | "export" | "import";
  /** export 模式的包输出目录（--out；仅 export 模式非 null）。 */
  readonly outDir: string | null;
  /** export 模式：显式包含 Pi session 原件（敏感内容；随包显著标注）。 */
  readonly includeSessions: boolean;
  /** export 模式：附带人类可读 Markdown 导出（readable/）。 */
  readonly readable: boolean;
  /** import 模式的包目录（--import-package；仅 import 模式非 null）。 */
  readonly importPackageDir: string | null;
}

const USAGE =
  "usage: node src/index.ts [--port N] [--data DIR] [--driver echo|pi] " +
  "[--provider ID] [--model ID] [--agent-dir DIR] " +
  "[--pi-tools TOOL,TOOL] [--policy-read-roots DIR,DIR] " +
  "[--terminology-provider ID] [--terminology-model ID] [--terminology-budget N] " +
  "[--import-package DIR]\n" +
  "       node src/index.ts export --out DIR [--data DIR] [--include-sessions] [--readable]";

/** 逗号分隔列表解析：剔除空白项；未给出 → null（区分「显式空列表」）。 */
function parseList(value: string | undefined): readonly string[] | null {
  if (value === undefined) return null;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parseArgs(argv: readonly string[]): CliOptions {
  /* D4-5：`export` 子命令（export --out <dir> [--include-sessions]
     [--readable]）；`--import-package <dir>` 走 flag 形态（契约 §5）。 */
  const exportSubcommand = argv[0] === "export";
  const rest = exportSubcommand ? argv.slice(1) : [...argv];
  const options: {
    port?: number;
    dataDir?: string;
    driver?: string;
    providerId?: string;
    modelId?: string;
    agentDir?: string;
    piTools?: string;
    policyReadRoots?: string;
    terminologyProvider?: string;
    terminologyModel?: string;
    terminologyBudget?: string;
    out?: string;
    importPackage?: string;
    includeSessions?: boolean;
    readable?: boolean;
  } = {};
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i]!;
    if (flag === "--include-sessions" || flag === "--readable") {
      if (flag === "--include-sessions") options.includeSessions = true;
      else options.readable = true;
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`${USAGE} (bad or missing value for '${String(flag)}')`);
    }
    if (flag === "--port") options.port = Number(value);
    else if (flag === "--data") options.dataDir = value;
    else if (flag === "--driver") options.driver = value;
    else if (flag === "--provider") options.providerId = value;
    else if (flag === "--model") options.modelId = value;
    else if (flag === "--agent-dir") options.agentDir = value;
    else if (flag === "--pi-tools") options.piTools = value;
    else if (flag === "--policy-read-roots") options.policyReadRoots = value;
    else if (flag === "--terminology-provider") options.terminologyProvider = value;
    else if (flag === "--terminology-model") options.terminologyModel = value;
    else if (flag === "--terminology-budget") options.terminologyBudget = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--import-package") options.importPackage = value;
    else throw new Error(`unknown flag: ${flag}`);
    i += 2;
  }
  const importPackageDir = options.importPackage ?? null;
  const outDir = options.out ?? null;
  if (exportSubcommand && importPackageDir !== null) {
    throw new Error("'export' and --import-package are separate modes; pass only one of them");
  }
  if (exportSubcommand) {
    if (outDir === null) {
      throw new Error("the export subcommand requires --out <dir> (the package output directory)");
    }
    if (outDir.trim() === "") {
      throw new Error("--out must be a non-empty directory path");
    }
  } else {
    if (outDir !== null) {
      throw new Error("--out applies only to the export subcommand");
    }
    if (options.includeSessions === true) {
      throw new Error("--include-sessions applies only to the export subcommand (sessions are excluded by default)");
    }
    if (options.readable === true) {
      throw new Error("--readable applies only to the export subcommand");
    }
  }
  const mode: "server" | "export" | "import" = exportSubcommand
    ? "export"
    : importPackageDir !== null
      ? "import"
      : "server";
  const driver = options.driver ?? "echo";
  if (driver !== "echo" && driver !== "pi") {
    throw new Error(`--driver must be 'echo' or 'pi' (got '${driver}')`);
  }
  if (options.agentDir !== undefined && driver !== "pi") {
    throw new Error(
      "--agent-dir applies only to --driver pi (the echo driver never reads a Pi agent directory)",
    );
  }
  if (options.agentDir !== undefined && options.agentDir.trim() === "") {
    throw new Error("--agent-dir must be a non-empty directory path");
  }
  const piTools = parseList(options.piTools);
  const policyReadRoots = parseList(options.policyReadRoots);
  if (piTools !== null && driver !== "pi") {
    throw new Error(
      "--pi-tools applies only to --driver pi (the echo driver has no tool executor; " +
        "the pi driver also runs with zero tools unless --pi-tools is given)",
    );
  }
  if (piTools !== null && piTools.length === 0) {
    throw new Error("--pi-tools must list at least one Pi tool name (comma-separated, e.g. 'read')");
  }
  if (policyReadRoots !== null && piTools === null) {
    throw new Error(
      "--policy-read-roots requires --pi-tools (read roots scope the ToolPolicy engine that gates the enabled tools)",
    );
  }
  if (policyReadRoots !== null && policyReadRoots.length === 0) {
    throw new Error(
      "--policy-read-roots must list at least one absolute directory (comma-separated) when given",
    );
  }
  if (policyReadRoots !== null) {
    // 显式契约：读取根必须是绝对目录（相对值会被策略引擎按 cwd 重解释，
    // 语义不透明——按清晰边界错误拒绝，绝不静默重解析）。
    for (const root of policyReadRoots) {
      if (!isAbsolute(root)) {
        throw new Error(
          `--policy-read-roots entries must be absolute directory paths (got '${root}')`,
        );
      }
    }
  }
  const providerId = options.providerId ?? (driver === "echo" ? "studio-provider" : "");
  const modelId = options.modelId ?? (driver === "echo" ? "studio-model" : "");
  if (driver === "pi" && (providerId === "" || modelId === "")) {
    throw new Error(
      `--driver pi requires --provider and --model, and the ${PI_API_KEY_ENV} environment variable for the in-memory API key`,
    );
  }
  const terminologyBudget = Number(options.terminologyBudget ?? "1000000");
  if (!Number.isInteger(terminologyBudget) || terminologyBudget <= 0) {
    throw new Error(`--terminology-budget must be a positive integer (got '${String(options.terminologyBudget)}')`);
  }
  const dataDir = resolve(options.dataDir ?? "./treeai-studio-data");
  return {
    port: options.port ?? 8787,
    dataDir,
    driver,
    providerId,
    modelId,
    agentDir:
      driver === "pi"
        ? resolve(options.agentDir ?? join(dataDir, DEFAULT_PI_AGENT_DIR_NAME))
        : null,
    piTools,
    policyReadRoots,
    terminologyProviderId: options.terminologyProvider ?? providerId,
    terminologyModelId: options.terminologyModel ?? modelId,
    terminologyBudgetTokens: terminologyBudget,
    mode,
    outDir: outDir === null ? null : resolve(outDir),
    includeSessions: options.includeSessions === true,
    readable: options.readable === true,
    importPackageDir: importPackageDir === null ? null : resolve(importPackageDir),
  };
}

/**
 * 从注入的 env 读取真实 Pi 驱动的 API key（仅环境注入缝）。
 * 缺失/空白时抛出**只含环境变量名**的边界错误（绝不含任何值）。
 * 返回值是秘密：调用方必须直接送入 runtime 工厂，绝不日志/落库/回显。
 */
export function readPiApiKey(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[PI_API_KEY_ENV];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `--driver pi requires a non-empty ${PI_API_KEY_ENV} environment variable ` +
        "(in-memory API key; the value is never logged or persisted; " +
        "there is no fallback to ~/.pi or Pi auth.json credentials)",
    );
  }
  return value.trim();
}

/** 交给真实 Pi runtime 工厂的装配（受控 agent 目录 + 内存凭据）。 */
export interface PiDriverWiring {
  readonly agentDir: string;
  /** 内存中的 provider 凭据（runtime-pi 缝隙；不写入 Pi auth.json）。 */
  readonly credentials: { readonly providerId: string; readonly apiKey: string };
}

/**
 * --driver pi 的边界校验装配：受控 agent 目录 + 环境注入的内存 API key。
 * 缺失件以清晰边界错误失败；API key 的值只被返回，绝不被日志。
 */
export function resolvePiDriverWiring(
  options: CliOptions,
  env: Readonly<Record<string, string | undefined>>,
): PiDriverWiring {
  if (options.driver !== "pi" || options.agentDir === null) {
    throw new Error("resolvePiDriverWiring requires --driver pi options (with an agent directory)");
  }
  return {
    agentDir: options.agentDir,
    credentials: { providerId: options.providerId, apiKey: readPiApiKey(env) },
  };
}

/** --driver pi 的工具装配（issue #6 P0-3）：allowlist + 生效读取根。 */
export interface PiToolWiring {
  /** 交给 createPiRuntime 的 tools allowlist（PiRuntimeConfig.tools）。 */
  readonly tools: readonly string[];
  /** 生效读取根（绝对路径；显式给出或缺省，均已经存在性校验）。 */
  readonly readRoots: readonly string[];
  /** 读取根是否为缺省（数据目录 workspace/）——启动横幅据实标注。 */
  readonly readRootsDefaulted: boolean;
}

/**
 * 解析 --pi-tools 的工具装配。null = 无工具缝（echo 驱动，或 pi 驱动
 * 未给出 --pi-tools → 零工具 + 无策略门；缺省行为字节级不变）。
 * 读取根缺省为 workspace（index.ts 的 defaultCwd，即数据目录 workspace/）；
 * 每个生效根的存在性经**注入的**探针校验（缺失 → 清晰边界错误，
 * fail closed，绝不静默跳过）。
 */
export function resolvePiToolWiring(
  options: CliOptions,
  workspace: string,
  isExistingDirectory: (dir: string) => boolean,
): PiToolWiring | null {
  if (options.driver !== "pi" || options.piTools === null) return null;
  const readRootsDefaulted = options.policyReadRoots === null;
  const readRoots = readRootsDefaulted ? [workspace] : options.policyReadRoots;
  for (const root of readRoots) {
    if (!isExistingDirectory(root)) {
      throw new Error(
        `--policy-read-roots entries must be existing directories (got '${root}')`,
      );
    }
  }
  return { tools: options.piTools, readRoots, readRootsDefaulted };
}

/**
 * 由工具装配构造请求时策略引擎（配方的唯一来源，index.ts 与测试共用）：
 * 读取限 wiring.readRoots；写入根恒为空（一切写入拒绝——默认无逐次
 * 授权）；相对 targetPath 按工具 cwd（workspace）解析；shell / network
 * 保持默认拒绝。引擎工厂由宿主注入（index.ts 动态加载
 * @treeai/tool-policy——本模块不静态依赖它，缺省零工具路径零新模块
 * 加载；测试注入同一真实工厂，证明装配真实生效）。应用层策略，不是
 * OS 沙箱。
 */
export function buildPiToolPolicy(
  wiring: PiToolWiring,
  workspace: string,
  createEngine: typeof import("@treeai/tool-policy")["createToolPolicy"],
): PiToolPolicyEvaluator {
  return createEngine({
    readRoots: wiring.readRoots,
    workspaceRoots: [],
    cwd: workspace,
  });
}
