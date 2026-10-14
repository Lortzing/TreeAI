/** harness owner; frozen probe bodies and order preserved. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type { ForestId, MaterialBlock, TreeId } from "@treeai/contracts";
import { createStudioServer } from "../../../../apps/studio/src/server.ts";
import { EchoSdkPort } from "../../../../apps/studio/src/echo-port.ts";
import { TreeStudioService } from "../../../../apps/studio/src/service.ts";
import { STUDIO_MODEL } from "../../../../apps/studio/tests/helpers.ts";
import { MaterialImportService, type MaterialParser, type MaterialParserOutcome } from "../../../../apps/studio/src/materials/import-service.ts";
import { SearchService } from "../../../../apps/studio/src/search/search-service.ts";
import { NavService } from "../../../../apps/studio/src/nav/nav-service.ts";



import { type B6ScaleCheckOutcome } from './models.ts';


/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export const staticDir = fileURLToPath(new URL("../../../../apps/studio/public/", import.meta.url));


/** 冻结探针目标（charter §6 B6；不得为通过而调整）。 */
export const SEARCH_P95_LIMIT_MS = 500;

export const OPEN_P95_LIMIT_MS = 2_000;

export const IMPORT_LIMIT_MS = 30_000;

export const CANCEL_LIMIT_MS = 200;

export const SCROLL_P95_LIMIT_MS = 200;

/** 触发复测的告警带：p95 超过限额 80%（并发机器上的诚实复测策略）。 */
export const RERUN_BAND_RATIO = 0.8;


export interface TimingStats {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}


export function timing(values: readonly number[]): TimingStats {
  if (values.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.ceil(p * sorted.length) - 1]!;
  return {
    count: sorted.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}


export const fmt = (n: number): string => n.toFixed(1);


export interface HttpResult {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}


export async function call(url: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* 204 / non-JSON */
  }
  return { status: response.status, body: parsed, text };
}


/** 计时请求（端到端：含响应体读取）。 */
export async function timedCall(url: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<{ result: HttpResult; ms: number }> {
  const t0 = performance.now();
  const result = await call(url, method, body, headers);
  return { result, ms: performance.now() - t0 };
}


/** 在数据目录上装配一套真实 HTTP 服务（镜像 index.ts 的产品接线）。 */
export interface RunningServer {
  readonly port: number;
  url(path: string): string;
  close(): Promise<void>;
}


export async function startB6Server(
  dataDir: string,
  options: { readonly materialsOverride?: MaterialImportService } = {},
): Promise<RunningServer> {
  const repository = TreeRepository.open({ path: join(dataDir, "treeai.db") });
  const materialRepository = MaterialRepository.open({ path: join(dataDir, "treeai.db") });
  let closed = false;
  const service = new TreeStudioService({
    repository,
    runtime: createPiRuntimeFromConfig({ port: new EchoSdkPort(), defaultCwd: join(dataDir, "workspace") }),
    model: STUDIO_MODEL,
    sessionDir: join(dataDir, "sessions"),
    cwd: join(dataDir, "workspace"),
  });
  const materials = options.materialsOverride ?? new MaterialImportService({ repository: materialRepository });
  const search = new SearchService({ treeRepository: repository, materialRepository });
  const nav = new NavService({ repository, materialRepository });
  const server = createStudioServer({ service, staticDir, materials, search, nav });
  const port = await server.listen(0);
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await service.dispose();
      materialRepository.close();
      repository.close();
    },
  };
}


/** 独立探针库（fresh data dir + 预建森林/树，随后真实服务接管）。 */
export async function freshProbeDataDir(base: string, name: string, treeId: string): Promise<string> {
  const dataDir = join(base, name);
  mkdirSync(dataDir, { recursive: true });
  const repository = TreeRepository.open({ path: join(dataDir, "treeai.db") });
  try {
    const forest = repository.createForest({ id: `b6-${name}-forest` as ForestId });
    repository.createTree(forest.id, { id: treeId as TreeId });
  } finally {
    repository.close();
  }
  return dataDir;
}


/** 受控门控假解析器：parse() 挂起直到 release()（取消时序的确定性观测；
 * 自定义解析器注册表是产品的显式缝——注入时整体替换）。 */
export class GatedParser implements MaterialParser {
  readonly kind = "markdown" as const;
  readonly parserVersion = "b6-gated-v1";
  #release: (() => void) | null = null;
  readonly #promise: Promise<MaterialParserOutcome>;
  constructor() {
    this.#promise = new Promise<MaterialParserOutcome>((resolve) => {
      this.#release = () =>
        resolve({
          ok: true,
          canonicalText: "门控解析器的迟到结果（late result）——取消后到达即被结构性丢弃。",
          blocks: [
            { blockId: "blk-0", kind: "markdown-block", start: 0, end: 25 },
          ] satisfies MaterialBlock[],
        });
    });
  }
  parse(): Promise<MaterialParserOutcome> {
    return this.#promise;
  }
  release(): void {
    this.#release?.();
  }
}


export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}


/** 结果封装（早退与正常收尾共用同一 detail 措辞）。 */
export function outcome(
  problems: readonly string[],
  lines: readonly string[],
  notRun: readonly string[],
): B6ScaleCheckOutcome {
  const passed = problems.length === 0;
  const detail =
    "generator determinism (2 CLI runs byte-identical over all 103 artifacts + in-process truth equality + --load-check " +
    "into a real DB); corpus loaded through real parsers + repository APIs (100 versions / exactly 1,000,000 units / " +
    "1,010 branches / 10,000 saved facts); search-p95 warm ≤500ms over the 50 frozen needle queries on the real " +
    "per-request-rebuild HTTP path (cold/warm reported separately; every query hits its frozen offset); material-open " +
    "p95 ≤2s over 30 existing-material opens incl. large PDFs via first-blocks fetch (cold/hot + resume-opens " +
    "recorded); the 10 MiB/100-page frozen sample imports to parse-ready ≤30s through the real import pipeline; " +
    "cancel answers ≤200ms with late results structurally discarded; scroll block-page p95 ≤200ms; input/scroll " +
    "server timings recorded as evidence — the browser face (scroll smoothness, keydown latency, hit-list render, " +
    "cold boot) is NOT claimed and stays with the frontend wave / run:d4-browser";
  return {
    status: passed ? "PASS" : "FAIL",
    exitCode: passed ? 0 : 2,
    detail,
    lines,
    problems,
    notRun,
  };
}


/** 目录内全部文件的相对路径集合（确定性遍历）。 */
export function listFilesRecursive(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRecursive(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}
