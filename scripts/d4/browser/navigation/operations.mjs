/** operations ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */
import {
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
  NAV_FRONTEND_FINDINGS,
} from "./policy.mjs";
import {
  armWaiterExpr,
  assertSelectedRowRendered,
  awaitWaiter,
  readStatusTotalRows,
  rowSelector,
  settleCollapse,
  settleExpand,
  settleMore,
  settleSearchHit,
  settleSelect,
  settleTreeOpen,
} from "./settlement.mjs";

/* ------------------------------------------------------------------ */
/* 操作执行                                                             */
/* ------------------------------------------------------------------ */

/** finder 定位树（真实键入 + Find；结果行在场）。 */
export async function finderLocateTree(ctx, treeId) {
  const present = await ctx.evalJs(
    `(() => document.querySelector(${JSON.stringify(`#nav-tree-results button[data-tree-id=${JSON.stringify(treeId)}]`)}) !== null)()`,
  );
  if (present === true) return;
  await inputClickAt(ctx, "#nav-tree-search");
  await ctx.evalJs(`(() => { document.getElementById("nav-tree-search").value = ""; })()`);
  await ctx.cdpSend("Input.insertText", { text: treeId });
  await inputClickAt(ctx, "#nav-tree-find");
  await waitFor(
    ctx,
    `(() => document.querySelector(${JSON.stringify(`#nav-tree-results button[data-tree-id=${JSON.stringify(treeId)}]`)}) !== null)()`,
    { label: `finder result for ${treeId}`, timeoutMs: 15_000 },
  );
}

/** 非计时的树打开（finder + 真实点击 + 就位等待——供度量序列之外的切换）。 */
export async function openTreeUnmeasured(ctx, treeId) {
  await finderLocateTree(ctx, treeId);
  await inputClickAt(ctx, `#nav-tree-results button[data-tree-id=${JSON.stringify(treeId)}]`);
  await waitFor(ctx, settleTreeOpen(treeId), { label: `nav tree open: ${treeId}`, timeoutMs: 20_000 });
}

export async function runOp(ctx, op, mirror, { pass = 1 } = {}) {
  const label = `${op.kind}:${op.tree}:${op.node ?? op.target ?? op.total ?? ""}`;
  if (op.kind === "treeOpen") {
    await finderLocateTree(ctx, op.tree);
    await ctx.evalJs(armWaiterExpr(settleTreeOpen(op.tree)));
    await inputClickAt(ctx, `#nav-tree-results button[data-tree-id=${JSON.stringify(op.tree)}]`);
    return (await awaitWaiter(ctx, label, 20_000)).elapsed;
  }
  if (op.kind === "expand" || op.kind === "collapse") {
    /* 幂等预检（复测序列）：目标态已成立则跳过（toggle 会翻反）。 */
    const desired = op.kind === "expand";
    const current = await ctx.evalJs(
      `(() => { const row = document.querySelector(${JSON.stringify(rowSelector(op.node))}); ` +
        `return row === null ? null : row.getAttribute("aria-expanded") === "true"; })()`,
    );
    if (current === desired) {
      if (desired) mirror.expand(op.tree, op.node);
      else mirror.collapse(op.tree, op.node);
      return null;
    }
    await scrollRowIntoWindow(ctx, rowSelector(op.node), { rowIndex: mirror.rowIndex(op.tree, { type: "node", id: op.node }) });
    await ctx.evalJs(armWaiterExpr(op.kind === "expand" ? settleExpand(op.node, op.firstChild) : settleCollapse(op.node, op.firstChild)));
    await navRowDomClickWithFallback(ctx, `${rowSelector(op.node)} .nav-toggle`, { rowIndex: mirror.rowIndex(op.tree, { type: "node", id: op.node }) });
    const elapsed = (await awaitWaiter(ctx, label, 15_000)).elapsed;
    if (op.kind === "expand") mirror.expand(op.tree, op.node);
    else mirror.collapse(op.tree, op.node);
    return elapsed;
  }

  if (op.kind === "select") {
    await scrollRowIntoWindow(ctx, rowSelector(op.node), { rowIndex: mirror.rowIndex(op.tree, { type: "node", id: op.node }) });
    await ctx.evalJs(armWaiterExpr(settleSelect(op.node)));
    await navRowDomClickWithFallback(ctx, `${rowSelector(op.node)} .nav-label`, { rowIndex: mirror.rowIndex(op.tree, { type: "node", id: op.node }) });
    const result = await awaitWaiter(ctx, label, 15_000);
    /* 抽样（每第 5 个 select）：选中行滚入窗口后 .active 在场 + 窗口外现象
       如实记录（见 frontendBugs「selected-row-outside-window」）。计时不含
       本断言（settle 已先行返回）。 */
    if (op.sampleRowAssert === true && pass === 1) {
      const activeNow = await ctx.evalJs(
        `(() => document.querySelector(${JSON.stringify(`${rowSelector(op.node)}.active`)}) !== null)()`,
      );
      if (activeNow !== true) {
        NAV_FRONTEND_FINDINGS.selectedRowOutsideWindow = true;
      }
      await assertSelectedRowRendered(ctx, op.node, mirror, op.tree);
    }
    return result.elapsed;
  }
  if (op.kind === "more") {
    /* 滚入 more 行会触发应用自身的按需续页泵——先等泵 settle（状态行稳定），
       再读基线（结算要求自基线增长——点击引发的装载才算本操作的度量）。 */
    const targetTotal = 1 + op.targetLoaded + (op.targetLoaded < op.total ? 1 : 0);
    const currentTotal = await readStatusTotalRows(ctx);
    if (currentTotal >= targetTotal) {
      mirror.markLoaded(op.tree, op.parent, op.targetLoaded); /* 泵已装满目标页——镜像同步。 */
      return null; /* 如实记 pump-preempted（序列层标注）。 */
    }
    await scrollRowIntoWindow(ctx, "#nav-tree .nav-more", { rowIndex: mirror.rowIndex(op.tree, { type: "more", parentId: op.parent }) });
    await sleep(300);
    const baseline = await readStatusTotalRows(ctx);
    await ctx.evalJs(armWaiterExpr(settleMore(baseline, targetTotal)));
    await navRowDomClickWithFallback(ctx, "#nav-tree .nav-more", { rowIndex: mirror.rowIndex(op.tree, { type: "more", parentId: op.parent }) });
    const elapsed = (await awaitWaiter(ctx, label, 20_000)).elapsed;
    mirror.markLoaded(op.tree, op.parent, op.targetLoaded);
    return elapsed;
  }
  if (op.kind === "search") {
    await navFillInput(ctx, "#nav-node-search", op.query);
    await ctx.evalJs(armWaiterExpr(settleSearchHit(op.target)));
    await navRowDomClickWithFallback(ctx, "#nav-node-find");
    return (await awaitWaiter(ctx, label, 20_000)).elapsed;
  }
  if (op.kind === "reveal") {
    mirror.expandAncestors(op.tree, op.node);
    await scrollRowIntoWindow(ctx, `#nav-node-results button[data-branch-id=${JSON.stringify(op.node)}]`);
    await ctx.evalJs(armWaiterExpr(settleSelect(op.node)));
    await navRowDomClickWithFallback(ctx, `#nav-node-results button[data-branch-id=${JSON.stringify(op.node)}]`);
    return (await awaitWaiter(ctx, label, 30_000)).elapsed;
  }
  throw new Error(`nav probe: unknown op kind ${String(op.kind)}`);
}
