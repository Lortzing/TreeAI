/**
 * Studio 测试辅助：临时数据目录 + 真实 TreeRepository + 真实 PiRuntime
 * （注入离线 echo 端口）。不触网络、不触用户 Pi 配置。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import type { PiModelSelector } from "@treeai/contracts";
import { EchoSdkPort } from "../src/echo-port.ts";
import { TreeStudioService } from "../src/service.ts";

export const STUDIO_MODEL: PiModelSelector = { providerId: "studio-provider", modelId: "studio-model" };

export interface StudioInstance {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly service: TreeStudioService;
  readonly echoPort: EchoSdkPort;
  /** 释放运行时与数据库连接（保留磁盘数据，供 reload 场景复用）。 */
  shutdown(): Promise<void>;
}

export function makeTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-studio-"));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 实例级选项（测试用）：拉宽 echo 驱动的在途窗口，供 abort 类测试确定性观测。 */
export interface StudioInstanceOptions {
  readonly echoTurnDelayMs?: number;
}

/** 在给定数据目录上构建一套 service（同一目录可重复调用 = 模拟重启）。 */
export function makeStudioInstance(dir: string, options?: StudioInstanceOptions): StudioInstance {
  const sessionsDir = join(dir, "sessions");
  const workspace = join(dir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const repository = TreeRepository.open({ path: join(dir, "treeai.db") });
  const echoPort =
    options?.echoTurnDelayMs === undefined
      ? new EchoSdkPort()
      : new EchoSdkPort({ turnDelayMs: options.echoTurnDelayMs });
  const runtime = createPiRuntimeFromConfig({ port: echoPort, defaultCwd: workspace });
  const service = new TreeStudioService({
    repository,
    runtime,
    model: STUDIO_MODEL,
    sessionDir: sessionsDir,
    cwd: workspace,
  });

  return {
    dir,
    repository,
    service,
    echoPort,
    async shutdown(): Promise<void> {
      await service.dispose();
      repository.close();
    },
  };
}
