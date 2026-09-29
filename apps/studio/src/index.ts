/**
 * TreeAI Studio CLI 入口（D3 Core MVP）。
 *
 * 用法：
 *   node src/index.ts [--port 8787] [--data ./treeai-studio-data]
 *                     [--driver echo|pi] [--provider ID] [--model ID]
 *
 * - 默认 driver 为 echo：离线确定性回声驱动（经 runtime-pi 的端口注入
 *   缝隙驱动真实 PiRuntime 实现；无网络、无模型、无 ~/.pi 访问），
 *   整条产品竖切可本地复现。
 * - --driver pi 使用真实 Pi SDK 端口（需 --provider/--model 与有效凭据；
 *   凭据缺失时按 D2 语义明确失败，不伪造结果）。
 * - 产品状态全部落在 --data 目录的 TreeAI 数据库（treeai.db）与
 *   Pi session 文件（sessions/）；重启后原样恢复。
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiRuntime, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import type { PiRuntime } from "@treeai/contracts";
import { EchoSdkPort } from "./echo-port.ts";
import { TreeStudioService } from "./service.ts";
import { createStudioServer } from "./server.ts";

interface CliOptions {
  readonly port: number;
  readonly dataDir: string;
  readonly driver: "echo" | "pi";
  readonly providerId: string;
  readonly modelId: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: { port?: number; dataDir?: string; driver?: string; providerId?: string; modelId?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`usage: node src/index.ts [--port N] [--data DIR] [--driver echo|pi] [--provider ID] [--model ID] (bad or missing value for '${String(flag)}')`);
    }
    if (flag === "--port") options.port = Number(value);
    else if (flag === "--data") options.dataDir = value;
    else if (flag === "--driver") options.driver = value;
    else if (flag === "--provider") options.providerId = value;
    else if (flag === "--model") options.modelId = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  const driver = options.driver ?? "echo";
  if (driver !== "echo" && driver !== "pi") {
    throw new Error(`--driver must be 'echo' or 'pi' (got '${driver}')`);
  }
  const providerId = options.providerId ?? (driver === "echo" ? "studio-provider" : "");
  const modelId = options.modelId ?? (driver === "echo" ? "studio-model" : "");
  if (driver === "pi" && (providerId === "" || modelId === "")) {
    throw new Error("--driver pi requires --provider and --model");
  }
  return {
    port: options.port ?? 8787,
    dataDir: resolve(options.dataDir ?? "./treeai-studio-data"),
    driver,
    providerId,
    modelId,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sessionsDir = join(options.dataDir, "sessions");
  const workspace = join(options.dataDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const repository = TreeRepository.open({ path: join(options.dataDir, "treeai.db") });
  let runtime: PiRuntime;
  if (options.driver === "echo") {
    runtime = createPiRuntimeFromConfig({
      port: new EchoSdkPort({ providerId: options.providerId, modelId: options.modelId }),
      defaultCwd: workspace,
    });
  } else {
    runtime = createPiRuntime({ defaultCwd: workspace });
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

  process.stdout.write(
    [
      `treeai-studio: listening http://127.0.0.1:${port}`,
      `treeai-studio: driver=${options.driver} model=${options.providerId}/${options.modelId}`,
      `treeai-studio: data=${options.dataDir} (schema v${String(repository.schemaVersion)})`,
      "",
    ].join("\n"),
  );

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

await main();
