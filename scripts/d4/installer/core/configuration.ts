/** configuration ownership for core.ts; compatibility entrypoint remains one level above. */
import type {
  LauncherConfig,
} from "./model.ts";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_PORT,
  PORT_SCAN_LIMIT,
} from "./policy.ts";

export function defaultLauncherConfig(): LauncherConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, port: DEFAULT_PORT, driver: "echo" };
}

/**
 * 解析 config.json。返回 problems（人话，可直接展示）；config 仅在零问题时
 * 返回。损坏配置绝不静默回落缺省——那会把用户的模型配置伪装成 echo。
 */
export function parseLauncherConfig(text: string): { config: LauncherConfig | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      config: null,
      problems: [
        `config.json 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。` +
          "修复方法：编辑该文件纠正语法，或将其删除后重新 start（会生成默认离线配置）。",
      ],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, problems: ["config.json 顶层必须是 JSON 对象。"] };
  }
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  const rawDriver = record["driver"];
  const driver = rawDriver === undefined ? "echo" : rawDriver;
  if (driver !== "echo" && driver !== "pi") {
    problems.push(
      `driver 必须是 'echo' 或 'pi'（当前 ${String(driver)}）。修复方法：编辑 config.json 将 driver 改为 'echo' 或 'pi'。`,
    );
  }
  const readOptionalString = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      problems.push(`${key} 必须是字符串（当前类型 ${typeof value}）。`);
      return undefined;
    }
    return value;
  };
  const readOptionalStringArray = (key: string): readonly string[] | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      problems.push(`${key} 必须是字符串数组。`);
      return undefined;
    }
    return value as readonly string[];
  };
  const provider = readOptionalString("provider");
  const model = readOptionalString("model");
  const agentDir = readOptionalString("agentDir");
  const piTools = readOptionalStringArray("piTools");
  const policyReadRoots = readOptionalStringArray("policyReadRoots");
  const config: LauncherConfig = {
    schemaVersion: typeof record["schemaVersion"] === "number" ? record["schemaVersion"] : CONFIG_SCHEMA_VERSION,
    port: typeof record["port"] === "number" ? record["port"] : DEFAULT_PORT,
    driver: driver === "pi" ? "pi" : "echo",
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(agentDir === undefined ? {} : { agentDir }),
    ...(piTools === undefined ? {} : { piTools }),
    ...(policyReadRoots === undefined ? {} : { policyReadRoots }),
    ...(typeof record["terminologyProvider"] === "string"
      ? { terminologyProvider: record["terminologyProvider"] }
      : {}),
    ...(typeof record["terminologyModel"] === "string" ? { terminologyModel: record["terminologyModel"] } : {}),
    ...(typeof record["terminologyBudgetTokens"] === "number"
      ? { terminologyBudgetTokens: record["terminologyBudgetTokens"] }
      : {}),
    ...(record["noBrowser"] === true ? { noBrowser: true } : {}),
  };
  return problems.length === 0 ? { config, problems } : { config: null, problems };
}

/**
 * 校验配置并给出可执行恢复信息（B8：模型配置错误有可执行恢复）。
 * 只报问题；问题的每一条都含「怎么修」。
 */
export function validateLauncherConfig(config: LauncherConfig): string[] {
  const problems: string[] = [];
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    problems.push(
      `config.json 的 schemaVersion 是 ${String(config.schemaVersion)}，本版本只支持 ${String(CONFIG_SCHEMA_VERSION)}。` +
        "修复方法：删除 config.json 后重新 start（重新生成默认配置），再按 README 重新填写。",
    );
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(
      `port 必须是 1–65535 的整数（当前 ${String(config.port)}）。` +
        `修复方法：编辑 config.json 把 port 改回 ${String(DEFAULT_PORT)}，或不写 port 使用默认值。`,
    );
  }
  if (config.driver === "pi") {
    if (typeof config.provider !== "string" || config.provider.trim() === "") {
      problems.push(
        "driver=pi 需要 provider（例如 anthropic）。修复方法：在 config.json 加 \"provider\": \"<你的 provider id>\"，" +
        "或先把 \"driver\" 改回 \"echo\"（离线回声模式，无需模型）。",
      );
    }
    if (typeof config.model !== "string" || config.model.trim() === "") {
      problems.push(
        "driver=pi 需要 model（例如 claude-sonnet-4-5）。修复方法：在 config.json 加 \"model\": \"<模型 id>\"," +
        "或先把 \"driver\" 改回 \"echo\"。",
      );
    }
    if (typeof config.terminologyBudgetTokens === "number" &&
      (!Number.isInteger(config.terminologyBudgetTokens) || config.terminologyBudgetTokens <= 0)) {
      problems.push("terminologyBudgetTokens 必须是正整数（或不写使用默认 1000000）。");
    }
    if (config.agentDir !== undefined && config.agentDir.trim() === "") {
      problems.push("driver=pi 时 agentDir 不能是空字符串。");
    }
    if (config.piTools !== undefined &&
      (config.piTools.length === 0 || config.piTools.some((tool) => tool.trim() === ""))) {
      problems.push("driver=pi 时 piTools 必须是非空工具名数组。");
    }
    if (config.policyReadRoots !== undefined) {
      if (config.piTools === undefined) {
        problems.push("policyReadRoots 需要同时配置 piTools；读取根只约束已启用的工具。");
      }
      if (config.policyReadRoots.length === 0 || config.policyReadRoots.some((root) => root.trim() === "")) {
        problems.push("policyReadRoots 必须是非空目录路径数组。");
      }
    }
  } else if (
    config.provider !== undefined ||
    config.model !== undefined ||
    config.agentDir !== undefined ||
    config.piTools !== undefined ||
    config.policyReadRoots !== undefined
  ) {
    problems.push(
      "driver=echo 时不需要 provider/model/agentDir/piTools/policyReadRoots（echo 是离线回声驱动）。" +
        '想用真实模型：把 "driver" 改为 "pi" 并补齐 provider/model。',
    );
  }
  return problems;
}

/** 由配置构造 studio 服务进程参数（apps/studio/src/cli.ts 的严格 flag 对）。 */
export function buildServerArgs(
  config: LauncherConfig,
  port: number,
  dataDir: string,
): string[] {
  const args: string[] = ["--port", String(port), "--data", dataDir];
  if (config.driver === "pi") {
    args.push("--driver", "pi", "--provider", config.provider ?? "", "--model", config.model ?? "");
    if (typeof config.terminologyProvider === "string" && config.terminologyProvider.trim() !== "") {
      args.push("--terminology-provider", config.terminologyProvider);
    }
    if (typeof config.terminologyModel === "string" && config.terminologyModel.trim() !== "") {
      args.push("--terminology-model", config.terminologyModel);
    }
    if (typeof config.terminologyBudgetTokens === "number") {
      args.push("--terminology-budget", String(config.terminologyBudgetTokens));
    }
    if (typeof config.agentDir === "string" && config.agentDir.trim() !== "") {
      args.push("--agent-dir", config.agentDir);
    }
    if (config.piTools !== undefined) args.push("--pi-tools", config.piTools.join(","));
    if (config.policyReadRoots !== undefined) args.push("--policy-read-roots", config.policyReadRoots.join(","));
  }
  return args;
}

/** 端口顺延候选：desired, desired+1, …（封顶 65535；供冲突恢复扫描）。 */
export function portCandidates(desired: number, limit: number = PORT_SCAN_LIMIT): number[] {
  const base = Number.isInteger(desired) && desired >= 1 ? desired : DEFAULT_PORT;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    const port = base + i;
    if (port > 65535) break;
    out.push(port);
  }
  return out;
}
