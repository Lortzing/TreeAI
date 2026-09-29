/**
 * TreeAI Studio CLI 入口（D3 Core MVP）。
 *
 * 用法：
 *   node src/index.ts [--port 8787] [--data ./treeai-studio-data]
 *                     [--driver echo|pi] [--provider ID] [--model ID]
 *                     [--agent-dir DIR]
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
 * - 产品状态全部落在 --data 目录的 TreeAI 数据库（treeai.db）与
 *   Pi session 文件（sessions/）；重启后原样恢复。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiRuntime, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import type { PiRuntime } from "@treeai/contracts";
import {
  PI_API_KEY_ENV,
  parseArgs,
  resolvePiDriverWiring,
  type PiDriverWiring,
} from "./cli.ts";
import { EchoSdkPort } from "./echo-port.ts";
import { TreeStudioService } from "./service.ts";
import { createStudioServer } from "./server.ts";

let piApiKeyValueGuard: string | null = null;

function scrubSecret(text: string): string {
  if (piApiKeyValueGuard === null || piApiKeyValueGuard.length < 8) return text;
  return text.split(piApiKeyValueGuard).join("[REDACTED]");
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

  const repository = TreeRepository.open({ path: join(options.dataDir, "treeai.db") });
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
    });
  }

  const service = new TreeStudioService({
    repository,
    runtime,
    model: { providerId: options.providerId, modelId: options.modelId },
    sessionDir: sessionsDir,
    cwd: workspace,
  });

  const staticDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const studio = createStudioServer({ service, staticDir });
  const port = await studio.listen(options.port);

  const banner = [
    `treeai-studio: listening http://127.0.0.1:${port}`,
    `treeai-studio: driver=${options.driver} model=${options.providerId}/${options.modelId}`,
    `treeai-studio: data=${options.dataDir} (schema v${String(repository.schemaVersion)})`,
  ];
  if (piSetup !== null) {
    banner.push(`treeai-studio: pi agent-dir=${piSetup.agentDir} (controlled; ~/.pi is not used)`);
    banner.push(`treeai-studio: pi api key=${PI_API_KEY_ENV} env, in-memory only (value never logged)`);
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
