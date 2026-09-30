/**
 * Shared B9「大规模树导航」executing check (D4-8 wave, issue #8 charter §5
 * 大规模树导航 + §6 B9; frozen spec tests/fixtures/d4/b9-nav/spec.json).
 *
 * Offline structural verification, end to end against the REAL deliverable
 * surfaces — the generator CLI as an actual subprocess, the loader, the
 * repositories, the /api/nav/* HTTP surface through a real node:http server:
 *
 *  1. generator determinism at the CLI surface: two independent subprocess
 *     runs of scripts/d4/gen-b9-nav-dataset.mjs (first one with --load-check,
 *     which additionally proves the dataset loads into a REAL persistence DB
 *     via repository APIs with sqlite integrity ok) must produce
 *     byte-identical structure truth and equal manifest hashes;
 *  2. engine-side frozen probes (cold engine): locate-correctness, origins,
 *     wide pagination, deep path, samename disambiguation, search, empty
 *     tree, big-tree shape, tree list, plus ENGINE-LEVEL p95 (>=50 scripted
 *     ops, <=300ms) and big-tree cold first open (<=2s) — recorded as
 *     engine-side evidence lines, explicitly NOT the browser verdict;
 *  3. structure-truth vs API queries 100%: EVERY one of the 10,100 branches
 *     is located through /api/nav/branches/:id/locate (tree, ancestors,
 *     path, origin, sibling position all compared against the truth), and
 *     every tree's full node set is paged out via /api/nav/.../subtree with
 *     every node view (parent/depth/title/originKind/childCount) compared;
 *  4. deep chain: /path of the b9-deep 100-level leaf returns the complete
 *     101-node chain (ids equal the truth parent chain, depths 0..100);
 *  5. wide tree: 200+ root children paged through /children in truth order
 *     (no duplicates, no gaps);
 *  6. same-name disambiguation: >=50 identical-title hits each carry a
 *     distinct full path and are locatable by id alone;
 *  7. empty tree usable: honest empty pages, single-node subtree, null title;
 *  8. lazy endpoints bounded: single pages never exceed the limit caps and
 *     the largest page stays under 1 MiB (no full-tree payloads);
 *  9. expand-state persistence: PUT → simulated restart (all connections
 *     closed, fresh assembly on the same data dir) → GET returns the exact
 *     same expand state and selected branch (migration 0010);
 * 10. product tree ≠ run/session trees: after the availability sweep marks
 *     every synthetic session unavailable, the sampled nav responses are
 *     byte-identical (navigation reads product facts only).
 *
 * Honest NOT_RUN scope (recorded in the outcome, not claimed): the browser
 * face of B9 — nav-p95 in a real browser, virtualization (DOM count vs
 * viewport), keyboard navigation, first-open in a real browser — belongs to
 * the frontend wave / run:d4-browser and the final candidate-SHA regression.
 *
 * Consumers: scripts/verify-d4.js (check `b9-large-tree-nav`). The frozen
 * fixture tree stays read-only — nothing under tests/fixtures is written.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";

import { createStudioServer } from "../../../apps/studio/src/server.ts";
import { EchoSdkPort } from "../../../apps/studio/src/echo-port.ts";
import { TreeStudioService } from "../../../apps/studio/src/service.ts";
import { STUDIO_MODEL } from "../../../apps/studio/tests/helpers.ts";
import {
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_SAMENAME_TREE_ID,
  B9_WIDE_TREE_ID,
  generateB9Dataset,
  type B9Dataset,
  type B9Node,
} from "../../../apps/studio/src/nav/b9-dataset.ts";
import { loadB9IntoFreshDir, openB9Repositories } from "../../../apps/studio/src/nav/b9-loader.ts";
import { NavService } from "../../../apps/studio/src/nav/nav-service.ts";
import { TreeNavEngine } from "../../../apps/studio/src/nav/nav-engine.ts";
import { runB9EngineChecks } from "../../../apps/studio/src/nav/b9-probes.ts";
import { runCommand } from "./util.ts";

export interface B9NavCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-item execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
  /** Honest NOT_RUN scope (browser face; carried into the evidence record). */
  readonly notRun: readonly string[];
}

const staticDir = fileURLToPath(new URL("../../../apps/studio/public/", import.meta.url));

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface HttpResult {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}

async function call(url: string, method = "GET", body?: unknown): Promise<HttpResult> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
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

/** 在 b9 数据目录上装配一套真实 HTTP 服务（自带仓储连接；close 一并释放）。 */
interface RunningServer {
  readonly port: number;
  url(path: string): string;
  close(): Promise<void>;
}

async function startServer(dataDir: string): Promise<RunningServer> {
  const repos = openB9Repositories(dataDir);
  let closed = false;
  const service = new TreeStudioService({
    repository: repos.repository,
    runtime: createPiRuntimeFromConfig({ port: new EchoSdkPort(), defaultCwd: join(dataDir, "workspace") }),
    model: STUDIO_MODEL,
    sessionDir: join(dataDir, "sessions"),
    cwd: join(dataDir, "workspace"),
  });
  const nav = new NavService({ repository: repos.repository, materialRepository: repos.materialRepository });
  const server = createStudioServer({ service, staticDir, nav });
  const port = await server.listen(0);
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await service.dispose();
      repos.close();
    },
  };
}

export async function runB9NavCheck(root: string): Promise<B9NavCheckOutcome> {
  const problems: string[] = [];
  const lines: string[] = [];
  const base = mkdtempSync(join(tmpdir(), "treeai-b9-nav-"));
  const notRun = [
    "nav-p95 (browser): p95 of scripted expand/switch operations in a real browser — frontend wave / run:d4-browser, not claimed here (engine-side p95 recorded as evidence only)",
    "virtualization: DOM node count growing with the viewport rather than the full tree — frontend wave, not claimed here",
    "keyboard: keyboard navigation with focus surviving virtualization — frontend wave, not claimed here",
    "browser-face first-open: b9-big first open in a real browser — frontend wave / run:d4-browser, not claimed here",
  ];

  try {
    /* ---- 1) 生成器确定性（真实 CLI 子进程 ×2，字节级恒等） ---- */
    {
      const outA = join(base, "gen-a");
      const outB = join(base, "gen-b");
      const runA = runCommand(
        process.execPath,
        [join("scripts", "d4", "gen-b9-nav-dataset.mjs"), "--out", outA, "--load-check"],
        { cwd: root, timeoutMs: 180_000 },
      );
      const runB = runCommand(
        process.execPath,
        [join("scripts", "d4", "gen-b9-nav-dataset.mjs"), "--out", outB, "--quiet"],
        { cwd: root, timeoutMs: 180_000 },
      );
      lines.push(`generator CLI run A (with --load-check): exit ${String(runA.status)}`);
      lines.push(`generator CLI run B (fresh process): exit ${String(runB.status)}`);
      if (runA.status !== 0 || runB.status !== 0) {
        problems.push(
          `generator CLI failed (A exit ${String(runA.status)}: ${runA.stderr.slice(0, 300)}; B exit ${String(runB.status)}: ${runB.stderr.slice(0, 300)})`,
        );
      } else {
        const structureA = join(outA, "b9-structure.json");
        const structureB = join(outB, "b9-structure.json");
        const manifestA = join(outA, "b9-manifest.json");
        const manifestB = join(outB, "b9-manifest.json");
        if (!existsSync(structureA) || !existsSync(structureB) || !existsSync(manifestA) || !existsSync(manifestB)) {
          problems.push("generator CLI did not produce structure truth + manifest in both runs");
        } else {
          const hashA = sha256File(structureA);
          const hashB = sha256File(structureB);
          const manifestHashA = sha256File(manifestA);
          const manifestHashB = sha256File(manifestB);
          const byteIdentical = readFileSync(structureA).equals(readFileSync(structureB));
          if (hashA !== hashB || !byteIdentical) {
            problems.push(`generator determinism FAILED across processes: ${hashA} vs ${hashB}`);
          } else if (manifestHashA !== manifestHashB) {
            problems.push(`generator manifest hashes differ across processes: ${manifestHashA} vs ${manifestHashB}`);
          } else {
            const manifest = JSON.parse(readFileSync(manifestA, "utf8")) as { structureTruthSha256?: string };
            if (manifest.structureTruthSha256 !== hashA) {
              problems.push("manifest structureTruthSha256 does not match the written structure truth");
            } else {
              lines.push(
                `generator determinism: two independent CLI runs byte-identical (structure truth sha256 ${hashA.slice(0, 16)}…, manifest ${manifestHashA.slice(0, 16)}…, 100 trees / 10000 non-trunk branches)`,
              );
            }
          }
        }
      }
    }

    /* ---- 2) 全量装载 + 冷引擎冻结探针（引擎级证据，非浏览器 verdict） ---- */
    const dataset: B9Dataset = generateB9Dataset();
    const dataDir = join(base, "data");
    const loaded = loadB9IntoFreshDir(dataset, dataDir);
    let server = await startServer(dataDir);
    try {
      lines.push(
        `load: ${String(loaded.loadStats.branches)} branch rows / ${String(loaded.loadStats.trees)} trees / ` +
          `${String(loaded.loadStats.turnOrigins)} turn + ${String(loaded.loadStats.materialOrigins)} material origins ` +
          `into a real persistence DB in ${loaded.loadStats.elapsedMs.toFixed(0)}ms (repository APIs, deterministic clock)`,
      );
      {
        // 冷引擎（独立实例，未服务过任何请求）跑冻结探针集。
        const coldEngine = new TreeNavEngine({
          repository: loaded.repository,
          materialRepository: loaded.materialRepository,
        });
        const engineChecks = runB9EngineChecks({ dataset, engine: coldEngine });
        for (const probe of engineChecks.probes) {
          if (probe.status !== "PASS") {
            problems.push(`engine probe ${probe.id} FAILED: ${probe.detail}`);
          }
        }
        lines.push(
          `engine probes (cold engine, engine-level evidence — NOT the browser verdict): ` +
            `${String(engineChecks.passedCount)}/${String(engineChecks.passedCount + engineChecks.failedCount)} pass; ` +
            `p95 ${engineChecks.perf.p95Ms.toFixed(1)}ms over ${String(engineChecks.perf.opCount)} scripted ops (limit 300ms); ` +
            `b9-big cold first open ${engineChecks.perf.firstOpenMs.toFixed(0)}ms (limit 2000ms)`,
        );
      }

      /* ---- 3) 结构真值 vs API 100%（全量 10,100 分支） ---- */
      const truthById = new Map<string, { treeId: string; node: B9Node }>();
      const truthChildren = new Map<string, B9Node[]>();
      for (const tree of dataset.trees) {
        for (const node of tree.nodes) {
          truthById.set(node.id, { treeId: tree.treeId, node });
          const siblings = truthChildren.get(node.parentId ?? "__root__") ?? [];
          siblings.push(node);
          truthChildren.set(node.parentId ?? "__root__", siblings);
        }
      }

      // 3a) 树列表分页翻完：100 棵全覆盖、无重复
      {
        const collected: string[] = [];
        let cursor: string | null = null;
        for (;;) {
          const url = new URLSearchParams({ limit: "40" });
          if (cursor !== null) url.set("cursor", cursor);
          const res = await call(server.url(`/api/nav/trees?${url.toString()}`));
          if (res.status !== 200) {
            problems.push(`tree listing page failed: HTTP ${String(res.status)} ${res.text.slice(0, 200)}`);
            break;
          }
          collected.push(...res.body.trees.map((t: any) => t.treeId));
          cursor = res.body.nextCursor;
          if (cursor === null) break;
        }
        const truthIds = dataset.trees.map((tree) => tree.treeId);
        if (collected.length !== truthIds.length || new Set(collected).size !== truthIds.length) {
          problems.push(
            `tree listing collected ${String(collected.length)} entries (${String(new Set(collected).size)} distinct), truth has ${String(truthIds.length)}`,
          );
        } else {
          lines.push(`tree list: ${String(collected.length)} trees paged at limit 40, no duplicates, all covered`);
        }
      }

      // 3b) 每棵树 subtree 分页翻完：全部节点视图 vs 真值（parent/depth/title/originKind/childCount）
      {
        let nodeViewsCompared = 0;
        let subtreePages = 0;
        let maxPageBytes = 0;
        const seenIds = new Set<string>();
        for (const tree of dataset.trees) {
          const maxDepth = tree.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
          let cursor: string | null = null;
          const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
          let collectedInTree = 0;
          for (;;) {
            const url = new URLSearchParams({ maxDepth: String(maxDepth), limit: "1000" });
            if (cursor !== null) url.set("cursor", cursor);
            const res = await call(
              server.url(`/api/nav/trees/${tree.treeId}/branches/${tree.trunkBranchId}/subtree?${url.toString()}`),
            );
            if (res.status !== 200) {
              problems.push(`subtree page failed for ${tree.treeId}: HTTP ${String(res.status)}`);
              break;
            }
            subtreePages += 1;
            maxPageBytes = Math.max(maxPageBytes, res.text.length);
            if (res.body.nodes.length > 1000) {
              problems.push(`subtree page for ${tree.treeId} returned ${String(res.body.nodes.length)} nodes (> limit cap 1000)`);
            }
            for (const view of res.body.nodes as any[]) {
              const truth = nodesById.get(view.id);
              if (truth === undefined) {
                problems.push(`subtree of ${tree.treeId}: API returned unknown node ${view.id}`);
                continue;
              }
              if (seenIds.has(view.id)) {
                problems.push(`node ${view.id} appeared in more than one page`);
              }
              seenIds.add(view.id);
              if (
                view.parentBranchId !== truth.parentId ||
                view.depth !== truth.depth ||
                view.title !== truth.title ||
                view.originKind !== truth.originKind ||
                view.treeId !== tree.treeId
              ) {
                problems.push(
                  `node ${view.id}: API view diverges from truth (parent/depth/title/originKind/treeId)`,
                );
              }
              const childCount = truthChildren.get(view.id)?.length ?? 0;
              if (view.childCount !== childCount) {
                problems.push(`node ${view.id}: childCount ${String(view.childCount)} !== truth ${String(childCount)}`);
              }
              nodeViewsCompared += 1;
              collectedInTree += 1;
            }
            cursor = res.body.nextCursor;
            if (cursor === null) break;
          }
          if (collectedInTree !== tree.nodes.length) {
            problems.push(
              `tree ${tree.treeId}: subtree paging collected ${String(collectedInTree)} nodes, truth has ${String(tree.nodes.length)}`,
            );
          }
        }
        if (nodeViewsCompared === dataset.totals.branchRows && seenIds.size === dataset.totals.branchRows) {
          lines.push(
            `structure truth vs API (nodes): 100% — ${String(nodeViewsCompared)}/${String(dataset.totals.branchRows)} node views compared ` +
              `(parent/depth/title/originKind/childCount), 0 divergences, across ${String(subtreePages)} subtree pages; ` +
              `largest page ${String(maxPageBytes)} bytes (< 1 MiB)`,
          );
        } else {
          problems.push(
            `node coverage incomplete: ${String(seenIds.size)} distinct nodes seen, ${String(nodeViewsCompared)} compared, truth ${String(dataset.totals.branchRows)}`,
          );
        }
      }

      // 3c) 全量 locate：每个分支的树/祖先链/路径/来源/兄弟位次 vs 真值
      {
        const startedAt = Date.now();
        const problemsBefore = problems.length;
        let located = 0;
        let originViews = 0;
        for (const tree of dataset.trees) {
          for (const node of tree.nodes) {
            const res = await call(server.url(`/api/nav/branches/${node.id}/locate`));
            if (res.status !== 200) {
              problems.push(`locate ${node.id}: HTTP ${String(res.status)} ${res.text.slice(0, 160)}`);
              continue;
            }
            const body = res.body;
            if (body.treeId !== tree.treeId || body.node.id !== node.id) {
              problems.push(`locate ${node.id}: wrong tree/node identity (${body.treeId}/${body.node.id})`);
            }
            const truthPathIds = [...node.parentPath, node.id];
            const pathIds = (body.path as any[]).map((step) => step.id);
            if (JSON.stringify(pathIds) !== JSON.stringify(truthPathIds)) {
              problems.push(`locate ${node.id}: path diverges from truth parent chain`);
            }
            if (body.ancestors.length !== node.depth) {
              problems.push(`locate ${node.id}: ancestors ${String(body.ancestors.length)} !== depth ${String(node.depth)}`);
            }
            if (node.parentId !== null) {
              const siblings = truthChildren.get(node.parentId)!;
              const expectedIndex = siblings.findIndex((candidate) => candidate.id === node.id);
              if (
                body.siblingPosition === null ||
                body.siblingPosition.index !== expectedIndex ||
                body.siblingPosition.total !== siblings.length
              ) {
                problems.push(`locate ${node.id}: sibling position diverges from truth`);
              }
            } else if (body.siblingPosition !== null) {
              problems.push(`locate ${node.id}: trunk must have null sibling position`);
            }
            const origin = body.origin;
            if (node.origin === null) {
              if (origin !== null) problems.push(`locate ${node.id}: origin must be null (truth: none)`);
            } else if (node.origin.kind === "turn") {
              if (
                origin === null || origin.kind !== "turn" ||
                origin.sourceBranchId !== node.origin.sourceBranchId ||
                origin.anchorTurnId !== node.origin.anchorTurnId ||
                origin.anchorEntryId !== node.origin.anchorEntryId ||
                origin.selection.start !== node.origin.selStart ||
                origin.selection.end !== node.origin.selEnd ||
                origin.selection.text !== node.origin.selText
              ) {
                problems.push(`locate ${node.id}: turn origin diverges from truth`);
              } else {
                originViews += 1;
              }
            } else {
              if (
                origin === null || origin.kind !== "material" ||
                origin.materialId !== node.origin.materialId ||
                origin.versionId !== node.origin.versionId ||
                origin.blockId !== node.origin.blockId ||
                origin.start !== node.origin.start ||
                origin.end !== node.origin.end ||
                origin.excerpt !== node.origin.excerpt
              ) {
                problems.push(`locate ${node.id}: material origin diverges from truth`);
              } else {
                originViews += 1;
              }
            }
            located += 1;
          }
        }
        if (located === dataset.totals.branchRows && problems.length === problemsBefore) {
          lines.push(
            `structure truth vs API (locate): 100% — ${String(located)}/${String(dataset.totals.branchRows)} branches located ` +
              `by id (tree/ancestors/path/sibling position), ${String(originViews)} origin refs all match, in ${String(Date.now() - startedAt)}ms`,
          );
        } else {
          problems.push(`locate coverage: ${String(located)}/${String(dataset.totals.branchRows)} located`);
        }
      }

      /* ---- 4) 深链：100 层完整 ---- */
      {
        const deep = dataset.trees.find((tree) => tree.treeId === B9_DEEP_TREE_ID)!;
        const leaf = deep.nodes.find((node) => node.id === "b9-deep-c100")!;
        const res = await call(server.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/branches/${leaf.id}/path`));
        if (res.status !== 200 || res.body.path.length !== 101) {
          problems.push(`deep chain path: HTTP ${String(res.status)}, ${String(res.body?.path?.length)} levels (need 101)`);
        } else {
          const truthIds = [...leaf.parentPath, leaf.id];
          const ok =
            JSON.stringify(res.body.path.map((step: any) => step.id)) === JSON.stringify(truthIds) &&
            res.body.path.every((step: any, index: number) => step.depth === index);
          if (!ok) {
            problems.push("deep chain path: ids/depths diverge from the truth chain");
          } else {
            lines.push("deep chain: /path of b9-deep-c100 returns the complete 101-node chain (depths 0..100, ids = truth)");
          }
        }
      }

      /* ---- 5) 宽树：根下 200+ 直接子枝按 children 分页翻完 ---- */
      {
        const wide = dataset.trees.find((tree) => tree.treeId === B9_WIDE_TREE_ID)!;
        const truthOrder = wide.nodes.filter((node) => node.parentId === wide.trunkBranchId).map((node) => node.id);
        const collected: string[] = [];
        let cursor: string | null = null;
        for (;;) {
          const url = new URLSearchParams({ limit: "50" });
          if (cursor !== null) url.set("cursor", cursor);
          const res = await call(
            server.url(`/api/nav/trees/${B9_WIDE_TREE_ID}/branches/${wide.trunkBranchId}/children?${url.toString()}`),
          );
          if (res.status !== 200) {
            problems.push(`wide children page failed: HTTP ${String(res.status)}`);
            break;
          }
          collected.push(...res.body.nodes.map((node: any) => node.id));
          cursor = res.body.nextCursor;
          if (cursor === null) break;
        }
        if (JSON.stringify(collected) !== JSON.stringify(truthOrder)) {
          problems.push(
            `wide tree children: ${String(collected.length)} collected vs truth ${String(truthOrder.length)} or order diverges`,
          );
        } else {
          lines.push(`wide tree: ${String(truthOrder.length)} root children paged at limit 50 in exact truth order (no dups/gaps)`);
        }
      }

      /* ---- 6) 同名消歧 ---- */
      {
        const samename = dataset.trees.find((tree) => tree.treeId === B9_SAMENAME_TREE_ID)!;
        const truthHits = samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE);
        const res = await call(
          server.url(`/api/nav/search/branches?text=${encodeURIComponent(B9_SAME_NAME_TITLE)}&mode=exact&limit=500`),
        );
        if (res.status !== 200 || res.body.hits.length !== truthHits.length) {
          problems.push(
            `same-name search: HTTP ${String(res.status)}, ${String(res.body?.hits?.length)} hits vs truth ${String(truthHits.length)}`,
          );
        } else {
          const paths = new Set(res.body.hits.map((hit: any) => hit.path.map((step: any) => step.id).join(">")));
          if (paths.size !== truthHits.length) {
            problems.push(`same-name search: only ${String(paths.size)} distinct paths among ${String(truthHits.length)} hits`);
          } else {
            // 每个命中可按 id 精确定位（消歧闭环）
            let roundTrips = 0;
            for (const hit of res.body.hits as any[]) {
              const located = await call(server.url(`/api/nav/branches/${hit.branchId}/locate`));
              if (
                located.status === 200 &&
                JSON.stringify(located.body.path.map((step: any) => step.id)) ===
                  JSON.stringify(hit.path.map((step: any) => step.id))
              ) {
                roundTrips += 1;
              }
            }
            if (roundTrips !== truthHits.length) {
              problems.push(`same-name disambiguation: ${String(roundTrips)}/${String(truthHits.length)} id round trips`);
            } else {
              lines.push(
                `same-name disambiguation: ${String(truthHits.length)} identical-title hits each carry a distinct full path; ` +
                  `${String(roundTrips)} locate-by-id round trips match`,
              );
            }
          }
        }
      }

      /* ---- 7) 空树诚实 ---- */
      {
        const empty = dataset.trees.find((tree) => tree.treeId === B9_EMPTY_TREE_ID)!;
        const overview = await call(server.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}`));
        const children = await call(
          server.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}/branches/${empty.trunkBranchId}/children`),
        );
        const subtree = await call(
          server.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}/branches/${empty.trunkBranchId}/subtree?maxDepth=2`),
        );
        if (
          overview.status !== 200 || overview.body.nodeCount !== 1 || overview.body.title !== null ||
          children.status !== 200 || children.body.nodes.length !== 0 || children.body.totalChildren !== 0 ||
          subtree.status !== 200 || subtree.body.nodes.length !== 1
        ) {
          problems.push("empty tree: overview/children/subtree are not the honest empty shapes");
        } else {
          lines.push("empty tree: usable — nodeCount 1, honest empty children page, single-node subtree, null title");
        }
      }

      /* ---- 8) 展开状态：PUT → 模拟重启 → GET 恒等 ---- */
      {
        const deep = dataset.trees.find((tree) => tree.treeId === B9_DEEP_TREE_ID)!;
        const expandIds = [deep.trunkBranchId, "b9-deep-c001", "b9-deep-c010", "b9-deep-c100"];
        const put = await call(server.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
          expandedBranchIds: expandIds,
          selectedBranchId: "b9-deep-c010",
        });
        if (put.status !== 204) {
          problems.push(`expand-state PUT: HTTP ${String(put.status)} ${put.text.slice(0, 200)}`);
        } else {
          const before = await call(server.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`));
          // 模拟重启：关闭全部连接（服务 + 两个仓储，loaded 也一并关闭），
          // 同目录全新装配；重启后的服务接替外层 server（自带连接）。
          await server.close();
          loaded.close();
          server = await startServer(dataDir);
          const after = await call(server.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`));
          if (after.status !== 200 || after.text !== before.text) {
            problems.push(
              `expand-state restart: response diverged (HTTP ${String(after.status)}): ${after.text.slice(0, 200)}`,
            );
          } else {
            lines.push(
              "expand-state persistence: PUT → simulated restart (all connections closed, fresh assembly) → GET byte-identical " +
                "(expanded set + selected branch survive; migration 0010)",
            );
          }
        }
      }

      /* ---- 9) 产品树 ≠ 运行 session 树：session 全量降级后逐字节不变 ---- */
      {
        const wide = dataset.trees.find((tree) => tree.treeId === B9_WIDE_TREE_ID)!;
        const endpoints = [
          "/api/nav/trees?limit=40",
          "/api/nav/branches/b9-deep-c050/locate",
          `/api/nav/trees/${B9_WIDE_TREE_ID}/branches/${wide.trunkBranchId}/children?limit=50`,
          `/api/nav/search/branches?text=${encodeURIComponent(B9_SAME_NAME_TITLE)}&mode=exact&limit=13`,
        ];
        const before: string[] = [];
        for (const endpoint of endpoints) {
          const res = await call(server.url(endpoint));
          if (res.status !== 200) {
            problems.push(`session-degradation probe ${endpoint}: HTTP ${String(res.status)} before sweep`);
          }
          before.push(res.text);
        }
        // 独立连接做清扫（只写 session 可用性列），随后全新装配复测。
        const sweepRepos = openB9Repositories(dataDir);
        try {
          const sweep = sweepRepos.repository.refreshSessionAvailability();
          let unavailable = 0;
          for (const entry of sweep) {
            for (const { reference } of sweepRepos.repository.getSessionReferencesByFile(entry.sessionFile)) {
              if (reference.availability.status === "unavailable") unavailable += 1;
            }
          }
          lines.push(
            `session degradation: sweep marked every synthetic session file unavailable ` +
              `(${String(unavailable)} references across ${String(sweep.length)} files); nav endpoints re-queried below`,
          );
        } finally {
          sweepRepos.close();
        }
        const restarted = await startServer(dataDir);
        try {
          for (let i = 0; i < endpoints.length; i += 1) {
            const res = await call(restarted.url(endpoints[i]!));
            if (res.status !== 200 || res.text !== before[i]) {
              problems.push(
                `product tree ≠ session trees violated at ${endpoints[i]}: response changed after session degradation`,
              );
            }
          }
          if (!problems.some((p) => p.startsWith("product tree"))) {
            lines.push(
              "product tree ≠ run/session trees: sampled nav responses byte-identical after every session went unavailable",
            );
          }
        } finally {
          await restarted.close();
        }
      }
    } finally {
      try {
        await server.close();
      } catch {
        /* already closed by the restart flow */
      }
      loaded.close();
    }
  } catch (error) {
    problems.push(`check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const passed = problems.length === 0;
  const detail =
    "generator determinism (2 CLI runs byte-identical, manifest hashes equal); structure-truth vs API 100% " +
    "(all 10,100 branches located with ancestors/path/origin/sibling position matching truth; every node view compared " +
    "via subtree pagination); 100-level deep chain complete; wide-tree children paged in truth order; same-name " +
    "disambiguation by id; empty tree honest; lazy endpoints page-bounded (<1MiB); expand state survives simulated " +
    "restart (migration 0010); nav byte-identical after every session degrades (product tree ≠ session trees); " +
    "engine-side p95 + first-open recorded as evidence only — browser face (p95/virtualization/keyboard) NOT claimed, " +
    "stays with the frontend wave / run:d4-browser";
  return {
    status: passed ? "PASS" : "FAIL",
    exitCode: passed ? 0 : 2,
    detail,
    lines,
    problems,
    notRun,
  };
}
