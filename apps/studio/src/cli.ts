/**
 * Studio CLI 解析与真实 Pi 驱动边界校验（非秘密面）。
 *
 * 从 src/index.ts 抽出（index.ts import 即启动服务器，无法单测），本模块：
 *   - 不触文件系统、不触网络、不 import Pi SDK；
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
 */

import { join, resolve } from "node:path";

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
}

const USAGE =
  "usage: node src/index.ts [--port N] [--data DIR] [--driver echo|pi] " +
  "[--provider ID] [--model ID] [--agent-dir DIR]";

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: {
    port?: number;
    dataDir?: string;
    driver?: string;
    providerId?: string;
    modelId?: string;
    agentDir?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`${USAGE} (bad or missing value for '${String(flag)}')`);
    }
    if (flag === "--port") options.port = Number(value);
    else if (flag === "--data") options.dataDir = value;
    else if (flag === "--driver") options.driver = value;
    else if (flag === "--provider") options.providerId = value;
    else if (flag === "--model") options.modelId = value;
    else if (flag === "--agent-dir") options.agentDir = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
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
  const providerId = options.providerId ?? (driver === "echo" ? "studio-provider" : "");
  const modelId = options.modelId ?? (driver === "echo" ? "studio-model" : "");
  if (driver === "pi" && (providerId === "" || modelId === "")) {
    throw new Error(
      `--driver pi requires --provider and --model, and the ${PI_API_KEY_ENV} environment variable for the in-memory API key`,
    );
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
