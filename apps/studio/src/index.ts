/**
 * TreeAI Studio CLI 入口（D3 Core MVP）。
 *
 * 用法：
 *   node src/index.ts [--port 8787] [--data ./treeai-studio-data]
 *                     [--driver echo|pi] [--provider ID] [--model ID]
 *                     [--agent-dir DIR]
 *                     [--pi-tools TOOL,TOOL] [--policy-read-roots DIR,DIR]
 *
 * - 默认 driver 为 echo：离线确定性回声驱动（经 runtime-pi 的端口注入
 *   缝隙驱动真实 PiRuntime 实现；无网络、无模型、无 ~/.pi 访问），
 *   整条产品竖切可本地复现。
 * - --driver pi 使用真实 Pi SDK 端口。受控缝（audit 修复）：
 *     - Pi agent 目录显式受控：--agent-dir 显式指定，默认数据目录内的
 *       pi-agent/（数据目录本地）；绝不静默回落 ~/.pi；
 *     - API key 仅经 TREEAI_STUDIO_API_KEY 环境变量注入（内存缝，
 *       runtime-pi 的 credentials → setRuntimeApiKey；不写 Pi auth.json），
 *       绝不作为 CLI 参数，值绝不进日志/TreeAI 数据库/evidence。
 *   缺失 --provider/--model/TREEAI_STUDIO_API_KEY 或 agent 目录不可用时，
 *   按清晰边界错误明确失败，不伪造结果。
 * - 工具与策略（issue #6 P0-3，默认关闭）：--pi-tools 给出 Pi 工具
 *   allowlist（缺省零工具，行为不变），并同时装配请求时策略门——真实
 *   工具调用在实际执行前经 ToolPolicy 引擎评估（读取限
 *   --policy-read-roots 给出的绝对根，缺省数据目录内 workspace/；写入根
 *   恒空 → 一切写入拒绝；shell/network 默认拒绝），deny /
 *   require-approval 不执行并以 policy-denied 收敛该次 run（fail
 *   closed），决策以安全投影记入 journal（tool.decision）。应用层策略，
 *   不是 OS 沙箱。
 * - 产品状态全部落在 --data 目录的 TreeAI 数据库（treeai.db）、Pi session
 *   文件（sessions/）与审计 journal（journal.jsonl，P1：run 生命周期
 *   事件的追加式记录，跨重启续用）；重启后原样恢复。
 */

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiRuntime, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import type { PiToolPolicyEvaluator } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import { JsonlEventJournal } from "@treeai/event-journal";
import type { PiRuntime } from "@treeai/contracts";
import {
  PI_API_KEY_ENV,
  buildPiToolPolicy,
  parseArgs,
  resolvePiDriverWiring,
  resolvePiToolWiring,
  type PiDriverWiring,
  type PiToolWiring,
} from "./cli.ts";
import { EchoSdkPort } from "./echo-port.ts";
import { TreeStudioService } from "./service.ts";
import { createStudioServer } from "./server.ts";

let piApiKeyValueGuard: string | null = null;

function scrubSecret(text: string): string {
  if (piApiKeyValueGuard === null || piApiKeyValueGuard.length < 8) return text;
  return text.split(piApiKeyValueGuard).join("[REDACTED]");
}

/** --policy-read-roots 生效根的存在性探针（目录；缺失/非目录 → false）。 */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * --pi-tools 给出时装配请求时策略引擎：真实 @treeai/tool-policy 经
 * #tool-policy 编译产物**动态**加载（缺省零工具路径不加载任何新模块，
 * 行为字节级不变；dist 未构建时给出含 build:deps 指引的清晰边界错误）。
 */
async function loadPiToolPolicy(wiring: PiToolWiring, workspace: string): Promise<PiToolPolicyEvaluator> {
  let engineModule: typeof import("#tool-policy");
  try {
    engineModule = await import("#tool-policy");
  } catch (err) {
    throw new Error(
      "--pi-tools requires the compiled ToolPolicy engine (apps/studio #tool-policy -> dist/tool-policy; " +
        `run \`npm run build:deps\` in apps/studio first): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildPiToolPolicy(wiring, workspace, engineModule.createToolPolicy);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const piSetup: PiDriverWiring | null =
    options.driver === "pi" ? resolvePiDriverWiring(options, process.env) : null;
  if (piSetup !== null) {
    piApiKeyValueGuard = piSetup.credentials.apiKey;
    try {
      mkdirSync(piSetup.agentDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `--driver pi: the controlled Pi agent directory '${piSetup.agentDir}' could not be created: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const sessionsDir = join(options.dataDir, "sessions");
  const workspace = join(options.dataDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  // 工具缝（issue #6 P0-3）：仅 --pi-tools 给出时非 null（此时读取根已过
  // 存在性校验；缺省根 workspace 刚在上面创建）。echo / 未给出 → null，
  // 下方装配与既有完全一致。
  const toolWiring = resolvePiToolWiring(options, workspace, isExistingDirectory);

  const repository = TreeRepository.open({ path: join(options.dataDir, "treeai.db") });
  // P1 审计 journal：数据目录内的单一追加式 JSONL（与 treeai.db 同级，
  // 跨重启复用；服务侧生成 journal eventId，无 per-instance 撞号问题）。
  // 构造 service 时自动执行 host-crash 恢复（service.journalRecovery）。
  const journal = await JsonlEventJournal.open(join(options.dataDir, "journal.jsonl"));
  let runtime: PiRuntime;
  if (piSetup === null) {
    runtime = createPiRuntimeFromConfig({
      port: new EchoSdkPort({ model: { providerId: options.providerId, modelId: options.modelId } }),
      defaultCwd: workspace,
    });
  } else {
    runtime = createPiRuntime({
      agentDir: piSetup.agentDir,
      defaultCwd: workspace,
      credentials: piSetup.credentials,
      // --pi-tools：工具 allowlist + 请求时策略评估（PiRuntimeConfig 的
      // tools/toolPolicy 缝；引擎动态加载，见 loadPiToolPolicy）。
      ...(toolWiring === null ? {} : { tools: toolWiring.tools }),
      ...(toolWiring === null ? {} : { toolPolicy: await loadPiToolPolicy(toolWiring, workspace) }),
    });
  }

  const service = new TreeStudioService({
    repository,
    runtime,
    model: { providerId: options.providerId, modelId: options.modelId },
    sessionDir: sessionsDir,
    cwd: workspace,
    journal,
  });

  const staticDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const studio = createStudioServer({ service, staticDir });
  const port = await studio.listen(options.port);

  const banner = [
    `treeai-studio: listening http://127.0.0.1:${port}`,
    `treeai-studio: driver=${options.driver} model=${options.providerId}/${options.modelId}`,
    `treeai-studio: data=${options.dataDir} (schema v${String(repository.schemaVersion)})`,
    `treeai-studio: journal=${journal.openReport.path} (${String(journal.openReport.eventsLoaded)} events loaded)`,
  ];
  if (piSetup !== null) {
    banner.push(`treeai-studio: pi agent-dir=${piSetup.agentDir} (controlled; ~/.pi is not used)`);
    banner.push(`treeai-studio: pi api key=${PI_API_KEY_ENV} env, in-memory only (value never logged)`);
  }
  if (toolWiring !== null) {
    // 工具集与策略根是本地配置（与 data/agent-dir 同级可见性），经既有
    // scrubSecret 横幅纪律输出；缺省根据实标注（不冒充显式配置）。
    banner.push(
      `treeai-studio: pi tools=${toolWiring.tools.join(",")} ` +
        "(allowlist; every tool call is policy-gated before execution)",
    );
    banner.push(
      `treeai-studio: pi policy read-roots=${toolWiring.readRoots.join(",")} ` +
        (toolWiring.readRootsDefaulted
          ? "(default: the --data workspace; scope reads with --policy-read-roots)"
          : "(--policy-read-roots)") +
        "; writes/shell/network denied (fail closed)",
    );
  }
  banner.push("");
  process.stdout.write(scrubSecret(banner.join("\n")));

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await service.dispose();
        repository.close();
        // journal close 排空内部写入队列后落盘（追加式文件，重启续用）。
        await journal.close();
        await studio.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`treeai-studio: ${scrubSecret(message)}\n`);
  process.exit(1);
});
