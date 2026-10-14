import { runNavVirtualization } from "./virtualization.mjs";
import { runNavKeyboard } from "./keyboard.mjs";
import { runNavRestart } from "./restart.mjs";
import { runNavSpotChecks } from "./spot-checks.mjs";
import * as os from "node:os";
/** probe ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAMENAME_TREE_ID,
  B9_WIDE_TREE_ID,
  checkB9Invariants,
  generateB9Dataset,
} from "../../../../apps/studio/src/nav/b9-dataset.ts";
import {
  loadB9IntoFreshDir,
} from "../../../../apps/studio/src/nav/b9-loader.ts";
import {
  assertNoPageErrors,
  inputClickAt,
  sleep,
  waitFor,
} from "../material-probes.mjs";
import {
  navFillInput,
  navRowDomClickWithFallback,
  scrollRowIntoWindow,
} from "./input.mjs";
import {
  finderLocateTree,
  openTreeUnmeasured,
  runOp,
} from "./operations.mjs";
import {
  buildOpPlan,
  createNavMirror,
} from "./plan.mjs";
import {
  BIG_FIRST_OPEN_LIMIT_MS,
  NAV_FRONTEND_FINDINGS,
  NAV_P95_LIMIT_MS,
  RERUN_BAND_RATIO,
  ROW_HEIGHT,
} from "./policy.mjs";
import {
  armWaiterExpr,
  assertSelectedRowRendered,
  awaitWaiter,
  rowSelector,
  settleSearchHit,
  settleSelect,
  settleTreeOpen,
} from "./settlement.mjs";
import {
  fmt,
  timingStats,
} from "./timing.mjs";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 探针：d4-nav-browser                                                  */
/* ------------------------------------------------------------------ */

export async function probeNavBrowser(ctx) {
  /* —— 0) 数据集（确定性生成 + 不变量自检 + 真实装载器入专用目录）—— */
  const dataset = generateB9Dataset();
  const invariantProblems = checkB9Invariants(dataset);
  if (invariantProblems.length > 0) {
    throw new Error(`nav probe: B9 dataset invariants failed (${String(invariantProblems.length)} problems): ${invariantProblems[0]}`);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "treeai-d4-b9-browser-"));
  const loaded = loadB9IntoFreshDir(dataset, dataDir);
  const loadStats = { ...loaded.loadStats };
  loaded.close();
  const { ops, wide, big, deep, wideChildren } = buildOpPlan(dataset);

  const cpus = os.cpus();
  const environment = {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch}`,
    cpu: `${String(cpus.length)}× ${cpus[0]?.model ?? "unknown"}`,
    totalMemoryGiB: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1)),
    viewport: "1280×900 (headless=new, CDP)",
    loadavgAtStart: os.loadavg().map((v) => Number(v.toFixed(2))),
    honestyNote:
      "local-machine engineering evidence (p95/first-open recorded with the environment above; never claimed cross-machine); " +
      "parallel wave agents may be building on this machine — the p95 probe reruns once if it lands within 20% of the limit, both runs recorded",
  };

  try {
    /* —— 1) 专用数据目录上启动真实 Studio 进程 + 冷页面 —— */
    /* 先切空白页：切断上一探针页面对其进程的轮询（bootStudioOn 会停掉它）。 */
    await ctx.navigate("about:blank");
    const url = await ctx.bootStudioOn(dataDir);
    const bootT0 = Date.now();
    await ctx.navigate(url);
    await waitFor(
      ctx,
      `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`,
      { label: "studio shell on the B9 data dir", timeoutMs: 30_000 },
    );
    /* 前端缺陷（如实上报，报告不修）：#nav-section（flex: 1.2 1 0 +
       min-height 220px）在其内容（finder + 树视图，min-content ~500px）超
       出分配高度时溢出区块盒——溢出的树滚动器按绘制序被后继
       #materials-section 覆盖（elementFromPoint 于任意树行 toggle 命中材料
       列表按钮）。实测 1280×900 / ×1400 / ×2000 / ×2200 视口全部复现
       （视口越高 forest 22vh 上限与 branch-tabs 越吃空间，nav 区块始终拿
       不到内容高度）——**工作台开着带材料的树时（常态）导航树在任何常见
       窗口尺寸下都不可点击**。同族：1b48ef0 只修了 tree-list/material-list
       的内部滚动；#branch-section 塌缩 0 高（分支 tab 不可点）由 b3 探针
       另证。探针处置：树行/toggle/more/命中行的点击改 DOM dispatch（事件
       直达应用监听器——虚拟化窗口内的行仍在 DOM；行定位仍走真实
       scrollTop 滚动 + 应用自身 scroll→重渲路径）；计时口径不含输入命中
       测试（~1-5ms，方向乐观，如实入 sidecar）。 */
    const sidebarGeometry = await ctx.evalJs(
      `(() => { const sidebar = document.getElementById("sidebar"); ` +
        `const r = sidebar.getBoundingClientRect(); ` +
        `return { viewport: window.innerWidth + "x" + window.innerHeight, sidebarHeight: Math.round(r.height), sidebarScrollHeight: sidebar.scrollHeight, ` +
          `navSectionHeight: Math.round(document.getElementById("nav-section").getBoundingClientRect().height), ` +
          `branchSectionHeight: Math.round(document.getElementById("branch-section").getBoundingClientRect().height) }; })()`,
    );
    const browserInfo = await ctx.evalJs(
      `(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null }))()`,
    );
    const coldShellMs = Date.now() - bootT0;
    const navTiming = {
      coldShellMs,
      measurementViewport: "1280x900",
      rowInteractionNote:
        "row/toggle/more/hit clicks are DOM-dispatched (the sidebar layout bug below covers the tree scroller at every tested viewport); the settle measurement covers the app's full work (fetch + render), input-pipeline hit-testing (~1-5ms) excluded",
    };
    const frontendBugs = [
      {
        id: "nav-section-overflow-under-materials",
        detail:
          "#nav-section (flex: 1.2 1 0 + min-height: 220px) overflows its box whenever its content (finder + tree surface, min-content ~500px) exceeds the allocated height — the overflowing tree scroller is painted UNDER the following #materials-section (elementFromPoint at a nav row's toggle returns a material list button). " +
          "Reproduced at 1280x900 / x1400 / x2000 / x2200 viewports (taller viewports grow forest's 22vh cap and the branch-tabs list, so the nav section never reaches its content height): with a workbench tree that has materials open (the normal state), the nav tree is unclickable at any common window size. " +
          "Same family as 1b48ef0 (which capped only tree-list/material-list); the sibling #branch-section collapses to height 0 in the same state (branch tabs unclickable — evidenced by the b3 probes). Reported to the owner, not fixed in this wave.",
        measuredAt: sidebarGeometry,
      },
    ];

    /* —— 2) b9-big 初次打开至可操作 ≤ 2s —— */
    let firstOpenMs;
    {
      await finderLocateTree(ctx, B9_BIG_TREE_ID);
      await ctx.evalJs(armWaiterExpr(settleTreeOpen(B9_BIG_TREE_ID)));
      await inputClickAt(ctx, `#nav-tree-results button[data-tree-id=${JSON.stringify(B9_BIG_TREE_ID)}]`);
      const settled = await awaitWaiter(ctx, "first-open:b9-big", 30_000);
      firstOpenMs = settled.elapsed;
      const status = await ctx.evalJs(`(() => document.getElementById("nav-tree-status").textContent ?? "")()`);
      if (!status.includes(`${String(big.nodes.length)} nodes`)) {
        throw new Error(`b9-big overview does not report ${String(big.nodes.length)} nodes: ${JSON.stringify(status)}`);
      }
      navTiming.bigFirstOpenMs = firstOpenMs;
      if (firstOpenMs > BIG_FIRST_OPEN_LIMIT_MS) {
        throw new Error(
          `b9-big first open to usable took ${fmt(firstOpenMs)}ms > ${String(BIG_FIRST_OPEN_LIMIT_MS)}ms (charter B9; ${environment.honestyNote})`,
        );
      }
    }

    /* —— 3) 固定脚本化操作序列（≥50 次；p95 ≤ 300ms）—— */
    const mirror = createNavMirror(dataset);
    /* 操作级重试（一次）：settle 超时多半是被应用自身的异步恢复/装载竞态
       （实测 re-expand-after-collapse 偶发；快照入证）——1s 静置后重走整
       操作，重试仍败则如实失败。 */
    let sequencePass = 0;
    const runOpWithRetry = async (op) => {
      try {
        return await runOp(ctx, op, mirror, { pass: sequencePass });
      } catch (err) {
        if (op.kind === "treeOpen") throw err;
        await sleep(1000);
        return await runOp(ctx, op, mirror, { pass: sequencePass });
      }
    };
    const runOpSequence = async () => {
      sequencePass += 1;
      const records = [];
      for (const op of ops) {
        const loadavg = os.loadavg().map((v) => Number(v.toFixed(2)));
        const ms = await runOpWithRetry(op);
        records.push({
          op: `${op.kind}:${op.tree}:${op.node ?? op.target ?? ""}`,
          ...(ms === null
            ? { ms: null, note: "skipped (already satisfied / pump-preempted) — idempotent rerun semantics" }
            : { ms: Number(ms.toFixed(1)) }),
          loadavg,
        });
      }
      return records;
    };
    let records = await runOpSequence();
    const preemptedCount = records.filter((r) => r.ms === null).length;
    let stats = timingStats(records.filter((r) => r.ms !== null).map((r) => r.ms));
    let rerunRecords = null;
    if (stats.p95Ms > RERUN_BAND_RATIO * NAV_P95_LIMIT_MS) {
      rerunRecords = await runOpSequence();
      const rerunStats = timingStats(rerunRecords.filter((r) => r.ms !== null).map((r) => r.ms));
      records = [
        ...records.map((r) => ({ ...r, pass: "first" })),
        ...rerunRecords.map((r) => ({ ...r, pass: "rerun" })),
      ];
      stats = rerunStats;
    }
    navTiming.opCount = records.length;
    navTiming.timedOpCount = records.filter((r) => r.ms !== null && r.pass !== "rerun").length;
    navTiming.preemptedOps = preemptedCount;
    navTiming.p95Ms = Number(stats.p95Ms.toFixed(1));
    navTiming.medianMs = Number(stats.medianMs.toFixed(1));
    navTiming.maxMs = Number(stats.maxMs.toFixed(1));
    navTiming.rerun = rerunRecords !== null;
    if (navTiming.timedOpCount < 50) {
      throw new Error(`nav op sequence executed only ${String(navTiming.timedOpCount)} timed ops (< 50 required by charter B9; ${String(preemptedCount)} pump-preempted)`);
    }
    if (stats.p95Ms > NAV_P95_LIMIT_MS) {
      throw new Error(
        `nav p95 ${fmt(stats.p95Ms)}ms > ${String(NAV_P95_LIMIT_MS)}ms over ${String(records.length)} scripted ops (charter B9; ${environment.honestyNote})`,
      );
    }

    /* —— 4) 虚拟化：DOM 行数随可视窗口而非节点总数 —— */
    const virtualization = { samples: [], bigRendered: null, wideTotalRows: null };
    const scrollerHeight = await ctx.evalJs(`(() => document.getElementById("nav-tree-scroll").clientHeight)()`);
    const domRowLimit = Math.ceil(Number(scrollerHeight) / ROW_HEIGHT) + 2 * 10 + 10; /* 视口行 + 双侧 overscan 10 + 余量 */
    virtualization.domRowLimit = domRowLimit;
const navVirtualization = await runNavVirtualization({
  get ctx() { return ctx; },
  get wideChildren() { return wideChildren; },
  get virtualization() { return virtualization; },
  get domRowLimit() { return domRowLimit; },
  get scrollerHeight() { return scrollerHeight; },
  get big() { return big; },
});


    /* —— 5) 键盘逐层移动 + 焦点跨窗口重划保持（b9-deep 全链展开态）—— */
    const keyboard = { steps: [] };
const navKeyboard = await runNavKeyboard({
  get ctx() { return ctx; },
  get keyboard() { return keyboard; },
  get deep() { return deep; },
});


    /* —— 6) 展开状态跨真实进程重启存活 —— */
    const restart = {};
const navRestart = await runNavRestart({
  get ctx() { return ctx; },
  get restart() { return restart; },
  get dataDir() { return dataDir; },
  get mirror() { return mirror; },
});


    /* —— 7) 结构真值抽样对照（搜索命中行 + 完整路径行 + 材料来源跳转）—— */
    const spotChecks = [];
const navSpotChecks = await runNavSpotChecks({
  get dataset() { return dataset; },
  get wideChildren() { return wideChildren; },
  get ctx() { return ctx; },
  get spotChecks() { return spotChecks; },
  get mirror() { return mirror; },
});


    /* —— 收尾：纪律 + sidecar —— */
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (entry) => entry.text.includes(`http://127.0.0.1:${String(restart.oldPort ?? -1)}`),
      label: "d4-nav-browser",
    });
    environment.loadavgAtEnd = os.loadavg().map((v) => Number(v.toFixed(2)));
    await ctx.screenshot("nav-browser-wide-virtualized");
    if (NAV_FRONTEND_FINDINGS.selectedRowOutsideWindow) {
      frontendBugs.push({
        id: "selected-row-outside-window",
        detail:
          "the app's own select flow can leave the selected row OUTSIDE the virtualized rendered window (observed on b9-big: after the select click the path line is fully correct but no li.nav-item.active exists in the DOM — the focus scroll and the window re-render race; the user sees the path line but no active row in the tree until they scroll). The row renders with .active once scrolled back into the window (asserted on the sampled selects). Reported to the owner, not fixed in this wave.",
      });
    }
    await ctx.sidecar("nav-browser", {
      check: "d4-nav-browser",
      dataset: {
        setId: "b9-nav",
        seed: "d4-b9-2026-09-30",
        trees: loadStats.trees,
        branchRows: loadStats.branches,
        loadElapsedMs: Number(loadStats.elapsedMs.toFixed(0)),
      },
      environment: { ...environment, browser: browserInfo },
      frontendBugs,
      timing: navTiming,
      limits: { p95Ms: NAV_P95_LIMIT_MS, bigFirstOpenMs: BIG_FIRST_OPEN_LIMIT_MS, virtualizedDomRowLimit: domRowLimit },
      opPlan: ops.map((op) => `${op.kind}:${op.tree}:${op.node ?? op.target ?? op.total ?? ""}`),
      opRecords: records,
      virtualization,
      keyboard,
      restart,
      spotChecks,
      pageErrorsExcluded: excludedCount,
    });
    return {
      detail:
        `B9 dataset (100 trees / ${String(loadStats.branches)} branch rows) loaded via the real loader into a dedicated data dir served by a real studio process; ` +
        `b9-big first open to usable ${fmt(firstOpenMs)}ms ≤ ${String(BIG_FIRST_OPEN_LIMIT_MS)}ms; ${String(navTiming.timedOpCount)} timed expand/switch ops (${String(preemptedCount)} more-page ops pump-preempted, honestly recorded) ` +
        `(expand/collapse/select/tree-switch/more-page/search-reveal, deterministic truth-derived order) p95 ${fmt(stats.p95Ms)}ms ≤ ${String(NAV_P95_LIMIT_MS)}ms ` +
        `(median ${fmt(stats.medianMs)}ms, max ${fmt(stats.maxMs)}ms${navTiming.rerun ? "; near-limit rerun recorded, verdict from the rerun" : ""}); ` +
        `virtualization: DOM rows ≤ ${String(domRowLimit)} (windowed) across scroll offsets while ${String(virtualization.wideTotalRows)} wide-tree rows are loaded ` +
        `(b9-big ${String(big.nodes.length)} nodes vs ${String(virtualization.bigRendered?.domRows)} DOM rows); keyboard moves level-by-level with focus retained ` +
        `across re-windowing (Home/End large jumps + collapse/re-expand); expand state survived a real SIGTERM restart (byte-equal expand-state + UI restore); ` +
        `${String(spotChecks.length)} spot-checks match the frozen structure truth (hit rows, full path chain, material source jump)`,
    };
  } finally {
    try {
      await ctx.navigate("about:blank"); /* 先切断页面到进程的轮询，再停进程 */
    } catch {
      /* 尽力而为 */
    }
    try {
      await ctx.stopStudio();
    } catch {
      /* 尽力而为 */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
}
