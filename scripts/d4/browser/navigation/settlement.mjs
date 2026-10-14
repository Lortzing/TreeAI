/** settlement ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */
import {
  waitFor,
} from "../material-probes.mjs";
import {
  scrollRowIntoWindow,
} from "./input.mjs";

/** 结算探针安装（页内）：t0 = performance.now() 于安装时刻；MutationObserver
 *  （整树 + 属性）+ 20ms tick 求值 settleExpr，真值即结算并携带其值。 */
export function armWaiterExpr(settleExpr) {
  return `(() => {
    window.__probeSettleValue = null;
    window.__probeT0 = performance.now();
    const cond = () => { try { return (${settleExpr}); } catch (err) { return false; } };
    window.__probeWaiter = new Promise((resolve) => {
      let done = false;
      let iv = null;
      let mo = null;
      const finish = () => {
        done = true;
        if (iv !== null) clearInterval(iv);
        if (mo !== null) mo.disconnect();
        resolve({ elapsed: performance.now() - window.__probeT0, value: window.__probeSettleValue });
      };
      const check = () => {
        if (done) return;
        const value = cond();
        if (value) { window.__probeSettleValue = value; finish(); }
      };
      mo = new MutationObserver(() => check());
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      iv = setInterval(check, 20);
      check();
    });
    return true;
  })()`;
}

/** 结算等待（await 页内 promise；超时如实带操作标签失败 + UI 状态快照）。 */
export async function awaitWaiter(ctx, label, timeoutMs) {
  try {
    return await ctx.evalJs(`window.__probeWaiter`, timeoutMs);
  } catch (err) {
    const snap = await ctx.evalJs(
      `(() => { const active = document.querySelector("#nav-tree li.nav-item.active"); ` +
        `const steps = [...document.querySelectorAll("#nav-path .nav-path-step")]; ` +
        `const scroller = document.getElementById("nav-tree-scroll"); ` +
        `return { statusLine: (document.getElementById("nav-tree-status").textContent ?? "").slice(0, 140), ` +
          `activeBranch: active === null ? null : active.dataset.branchId ?? null, ` +
          `pathHeading: (document.getElementById("nav-path-heading").textContent ?? "").slice(0, 80), ` +
          `lastStepTitle: steps.length === 0 ? null : steps[steps.length - 1].title, ` +
          `domRows: document.querySelectorAll("#nav-tree .nav-item").length, ` +
          `scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }; })()`,
    ).catch(() => null);
    throw new Error(`nav op settle timeout (${String(timeoutMs)}ms): ${label} — snapshot: ${JSON.stringify(snap)}; ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 结算条件（按操作类型生成；arm 时刻必须为假——由真值派生保证）           */
/* ------------------------------------------------------------------ */

export const rowSelector = (branchId) => `#nav-tree li[data-branch-id=${JSON.stringify(branchId)}]`;

export function settleExpand(nodeId, firstChildId) {
  const childCheck = firstChildId === null
    ? `true`
    : `document.querySelector(${JSON.stringify(rowSelector(firstChildId))}) !== null`;
  return `(() => { const row = document.querySelector(${JSON.stringify(rowSelector(nodeId))}); ` +
    `if (row === null) return false; ` +
    `if (row.getAttribute("aria-expanded") !== "true") return false; ` +
    `return ${childCheck}; })()`;
}

export function settleCollapse(nodeId, firstChildId) {
  const childCheck = firstChildId === null
    ? `true`
    : `document.querySelector(${JSON.stringify(rowSelector(firstChildId))}) === null`;
  return `(() => { const row = document.querySelector(${JSON.stringify(rowSelector(nodeId))}); ` +
    `if (row === null) return false; ` +
    `if (row.getAttribute("aria-expanded") === "true") return false; ` +
    `return ${childCheck}; })()`;
}

/** 选中结算 = 路径行落定（heading + 末步 = 该节点——选中与路径取回都完成）。
 * 行的 .active/.focused 在虚拟化窗口内的渲染另行抽样断言（assertSelectedRowRendered）：
 * 实测应用自身的选中流可把选中行留在渲染窗口外（focus 滚动与窗口重划竞态，
 * 见 frontendBugs「selected-row-outside-window」——路径行正确、树内无活动行）。 */
export function settleSelect(nodeId) {
  return `(() => { const heading = document.getElementById("nav-path-heading").textContent ?? ""; ` +
    `if (!heading.includes("full path")) return false; ` +
    `const steps = document.querySelectorAll("#nav-path .nav-path-step"); ` +
    `if (steps.length === 0) return false; ` +
    `return (steps[steps.length - 1].title ?? "").includes(${JSON.stringify(`select ${nodeId} (`)}); })()`;
}

/** 选中行的渲染断言（抽样）：滚入窗口后 .active 在场（精确行索引）。 */
export async function assertSelectedRowRendered(ctx, nodeId, mirror, treeId) {
  await scrollRowIntoWindow(ctx, rowSelector(nodeId), { rowIndex: mirror.rowIndex(treeId, { type: "node", id: nodeId }) });
  await waitFor(
    ctx,
    `(() => { const row = document.querySelector(${JSON.stringify(`${rowSelector(nodeId)}.active`)}); ` +
      `return row !== null ? { branchId: row.dataset.branchId ?? null } : false; })()`,
    { label: `selected row ${nodeId} rendered with .active once scrolled into the window`, timeoutMs: 8000 },
  );
  return true;
}

export function settleTreeOpen(treeId) {
  return `(() => { const surface = document.getElementById("nav-surface"); ` +
    `if (surface === null || surface.hidden) return false; ` +
    `const title = document.getElementById("nav-tree-title").textContent ?? ""; ` +
    `if (!title.includes(${JSON.stringify(treeId)})) return false; ` +
    `const status = document.getElementById("nav-tree-status").textContent ?? ""; ` +
    `if (!status.includes("rendering ")) return false; ` +
    `return document.querySelectorAll("#nav-tree .nav-item").length > 0; })()`;
}

/** more 翻页结算：状态行总行数（trunk + 已载子枝 + more 行）自基线增长到
 *  目标——状态行常驻 DOM（more 按钮装载后会被推离窗口，不可作结算面）。 */
export function settleMore(baselineTotalRows, targetTotalRows) {
  return `(() => { const status = document.getElementById("nav-tree-status").textContent ?? ""; ` +
    `const match = /rendering \\d+\\/(\\d+) visible rows/.exec(status); ` +
    `return match !== null && Number(match[1]) > ${String(baselineTotalRows)} && Number(match[1]) >= ${String(targetTotalRows)}; })()`;
}

/** 当前状态行总行数（trunk + 已载子枝 + more 行）。 */
export async function readStatusTotalRows(ctx) {
  const value = await ctx.evalJs(
    `(() => { const status = document.getElementById("nav-tree-status").textContent ?? ""; ` +
      `const match = /rendering \\d+\\/(\\d+) visible rows/.exec(status); ` +
      `return match === null ? null : Number(match[1]); })()`,
  );
  if (value === null || !Number.isFinite(value)) {
    throw new Error(`nav probe: the tree status line does not carry the visible-row total (${JSON.stringify(value)})`);
  }
  return value;
}

export function settleSearchHit(branchId) {
  return `(() => document.querySelector(${JSON.stringify(`#nav-node-results button[data-branch-id=${JSON.stringify(branchId)}]`)}) !== null)()`;
}
