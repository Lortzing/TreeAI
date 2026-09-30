/**
 * Studio 测试辅助：临时数据目录 + 真实 TreeRepository + 真实 PiRuntime
 * （注入离线 echo 端口）。不触网络、不触用户 Pi 配置。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type { PiModelSelector, PiRuntime } from "@treeai/contracts";
import type { EventJournal } from "@treeai/event-journal";
import { EchoSdkPort } from "../src/echo-port.ts";
import { TreeStudioService } from "../src/service.ts";
import { MaterialImportService, type MaterialParser } from "../src/materials/import-service.ts";

export const STUDIO_MODEL: PiModelSelector = { providerId: "studio-provider", modelId: "studio-model" };

export interface StudioInstance {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly service: TreeStudioService;
  /** 注入的 echo 端口（runtime 覆盖注入时为 null）。 */
  readonly echoPort: EchoSdkPort | null;
  /** 注入的 journal（未注入时为 null）。close 由测试自己负责。 */
  readonly journal: EventJournal | null;
  /** 材料仓储（与 treeai.db 同库的第二连接；close 随 shutdown）。 */
  readonly materialRepository: MaterialRepository;
  /** 材料导入服务（D4-1；解析器/上限可经 options.materialImport 注入）。 */
  readonly materials: MaterialImportService;
  /** 释放运行时与数据库连接（保留磁盘数据，供 reload 场景复用）。 */
  shutdown(): Promise<void>;
}

export function makeTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-studio-"));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 实例级选项（测试用）：拉宽 echo 在途窗口 / 注入 journal / 覆盖 runtime / 材料服务注入。 */
export interface StudioInstanceOptions {
  /** 拉宽 echo 驱动的在途窗口（ms），供 abort/流式类测试确定性观测。 */
  readonly echoTurnDelayMs?: number;
  /** 可选注入审计 journal（P1；缺省不注入 = 零 journal 行为）。 */
  readonly journal?: EventJournal;
  /** 可选覆盖 runtime（脚本化 runtime 的服务级测试）。 */
  readonly runtime?: PiRuntime;
  /** 材料导入服务注入（受控假解析器/小限额测试用；缺省 d4-md-v1 + 冻结上限）。 */
  readonly materialImport?: {
    readonly parsers?: Readonly<Partial<Record<"markdown" | "pdf", MaterialParser>>>;
    readonly limits?: { readonly maxFileBytes?: number; readonly maxTextUnits?: number };
  };
}

/** 在给定数据目录上构建一套 service（同一目录可重复调用 = 模拟重启）。 */
export function makeStudioInstance(dir: string, options?: StudioInstanceOptions): StudioInstance {
  const sessionsDir = join(dir, "sessions");
  const workspace = join(dir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const repository = TreeRepository.open({ path: join(dir, "treeai.db") });
  const echoPort =
    options?.runtime !== undefined
      ? null
      : options?.echoTurnDelayMs === undefined
        ? new EchoSdkPort()
        : new EchoSdkPort({ turnDelayMs: options.echoTurnDelayMs });
  const runtime: PiRuntime =
    options?.runtime !== undefined
      ? options.runtime
      : createPiRuntimeFromConfig({ port: echoPort!, defaultCwd: workspace });
  const service = new TreeStudioService({
    repository,
    runtime,
    model: STUDIO_MODEL,
    sessionDir: sessionsDir,
    cwd: workspace,
    ...(options?.journal === undefined ? {} : { journal: options.journal }),
  });
  const materialRepository = MaterialRepository.open({ path: join(dir, "treeai.db") });
  const materials = new MaterialImportService({
    repository: materialRepository,
    ...(options?.materialImport === undefined
      ? {}
      : {
          ...(options.materialImport.parsers === undefined
            ? {}
            : { parsers: options.materialImport.parsers }),
          ...(options.materialImport.limits === undefined
            ? {}
            : { limits: options.materialImport.limits }),
        }),
  });

  return {
    dir,
    repository,
    service,
    echoPort,
    journal: options?.journal ?? null,
    materialRepository,
    materials,
    async shutdown(): Promise<void> {
      await service.dispose();
      materialRepository.close();
      repository.close();
    },
  };
}
