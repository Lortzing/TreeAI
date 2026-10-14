/** Navigation spot-checks phase with original assertions and caller cleanup Instance-owned state and dependencies. */
import { B9_BIG_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { B9_DEEP_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { B9_WIDE_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { B9_SAMENAME_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { B9_LONGTITLE_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { B9_EMPTY_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { openTreeUnmeasured } from "./operations.mjs";
import { navFillInput } from "./input.mjs";
import { armWaiterExpr } from "./settlement.mjs";
import { settleSearchHit } from "./settlement.mjs";
import { navRowDomClickWithFallback } from "./input.mjs";
import { waitFor } from "../material-probes.mjs";
import { settleSelect } from "./settlement.mjs";
import { awaitWaiter } from "./settlement.mjs";
import { inputClickAt } from "../material-probes.mjs";

export async function runNavSpotChecks(deps) {

      {
        const treeOf = (treeId) => deps.dataset.trees.find((candidate) => candidate.treeId === treeId);
        const samples = [];
        const pushSample = (treeId, node) => samples.push({ treeId, node });
        {
          const bigTree = treeOf(B9_BIG_TREE_ID);
          const bigChildren = bigTree.nodes.filter((node) => node.parentId === bigTree.trunkBranchId);
          pushSample(B9_BIG_TREE_ID, bigChildren[0]);
          pushSample(B9_BIG_TREE_ID, bigTree.nodes.find((node) => node.depth === 3) ?? bigChildren[0]);
          const materialNode = bigTree.nodes.find((node) => node.originKind === "material");
          if (materialNode !== undefined) pushSample(B9_BIG_TREE_ID, materialNode);
        }
        pushSample(B9_DEEP_TREE_ID, treeOf(B9_DEEP_TREE_ID).nodes.find((node) => node.id === "b9-deep-c050"));
        pushSample(B9_WIDE_TREE_ID, deps.wideChildren[deps.wideChildren.length - 1]);
        {
          const samename = treeOf(B9_SAMENAME_TREE_ID);
          const sameTitleNodes = samename.nodes.filter((node) => node.title !== null);
          pushSample(B9_SAMENAME_TREE_ID, sameTitleNodes[0]);
          pushSample(B9_SAMENAME_TREE_ID, sameTitleNodes[sameTitleNodes.length - 1]);
        }
        pushSample(B9_LONGTITLE_TREE_ID, treeOf(B9_LONGTITLE_TREE_ID).nodes.find((node) => node.parentId !== null));
        pushSample(B9_EMPTY_TREE_ID, treeOf(B9_EMPTY_TREE_ID).nodes[0]);

        for (const { treeId, node } of samples) {
          if (node === undefined) continue;
          /* 分支搜索按当前导航树范围——先开样本树（非计时切换）。 */
          await openTreeUnmeasured(deps.ctx, treeId);
          /* 搜索命中行（携带完整路径/深度/来源——UI 的真值载荷面）。 */
          await navFillInput(deps.ctx, "#nav-node-search", node.id);
          await deps.ctx.evalJs(armWaiterExpr(settleSearchHit(node.id)));
          await navRowDomClickWithFallback(deps.ctx, "#nav-node-find");
          const hit = await waitFor(
            deps.ctx,
            `(() => { const button = document.querySelector(${JSON.stringify(`#nav-node-results button[data-branch-id=${JSON.stringify(node.id)}]`)}); ` +
              `return button === null ? false : { name: button.querySelector(".nav-finder-name")?.textContent ?? "", ` +
                `meta: button.querySelector(".nav-finder-meta")?.textContent ?? "", path: button.title ?? "" }; })()`,
            { label: `branch-search hit for ${node.id}`, timeoutMs: 15_000 },
          );
          const problems = [];
          if (!hit.meta.includes(`depth ${String(node.depth)}`)) problems.push(`hit depth mismatch: ${JSON.stringify(hit.meta)}`);
          if (!hit.meta.includes(node.originKind)) problems.push(`hit originKind mismatch: ${JSON.stringify(hit.meta)}`);
          const nodeById = new Map(deps.dataset.trees.flatMap((tree) => tree.nodes.map((candidate) => [candidate.id, candidate])));
          const expectedPathTitles = [...node.parentPath, node.id].map((id) => {
            const ancestor = nodeById.get(id);
            if (ancestor === undefined || ancestor.title !== null) {
              return ancestor?.title ?? "(no first question yet)";
            }
            return ancestor.depth === 0 ? "Trunk" : "(no first question yet)";
          });
          const prefix = `${node.id} · `;
          const pathTitles = hit.path.startsWith(prefix) ? hit.path.slice(prefix.length) : null;
          const expectedPathText = expectedPathTitles.join(" / ");
          if (pathTitles !== expectedPathText) {
            problems.push(`hit full path diverges from truth (got ${JSON.stringify(pathTitles)}, want ${JSON.stringify(expectedPathText)})`);
          }
          if (problems.length > 0) throw new Error(`nav spot-check ${node.id} — ${problems.join("; ")}`);
          deps.spotChecks.push({ treeId, branchId: node.id, depth: node.depth, originKind: node.originKind, pathLevels: expectedPathTitles.length });
        }

        /* 选中节点 → 完整路径行（展开完整显示后逐步对照真值父链）。 */
        {
          const target = treeOf(B9_DEEP_TREE_ID).nodes.find((node) => node.id === "b9-deep-c050");
          await openTreeUnmeasured(deps.ctx, B9_DEEP_TREE_ID);
          await navFillInput(deps.ctx, "#nav-node-search", "b9-deep-c050");
          await navRowDomClickWithFallback(deps.ctx, "#nav-node-find");
          await waitFor(
            deps.ctx,
            `(() => document.querySelector(${JSON.stringify(`#nav-node-results button[data-branch-id=${JSON.stringify("b9-deep-c050")}]`)}) !== null)()`,
            { label: "branch-search hit for b9-deep-c050 (path spot-check)", timeoutMs: 15_000 },
          );
          await deps.ctx.evalJs(armWaiterExpr(settleSelect("b9-deep-c050")));
          await navRowDomClickWithFallback(deps.ctx, `#nav-node-results button[data-branch-id=${JSON.stringify("b9-deep-c050")}]`);
          await awaitWaiter(deps.ctx, "reveal:b9-deep-c050 (path spot-check)", 30_000);
          await waitFor(
            deps.ctx,
            `(() => { const more = document.querySelector("#nav-path .nav-path-more"); ` +
              `if (more !== null && (more.textContent ?? "").includes("show full path")) { more.click(); return false; } ` +
              `return document.querySelectorAll("#nav-path .nav-path-step").length > 0; })()`,
            { label: "full path expanded for the spot-check", timeoutMs: 10_000 },
          );
          const steps = await deps.ctx.evalJs(
            `(() => [...document.querySelectorAll("#nav-path .nav-path-step")].map((button) => button.title ?? ""))()`,
          );
          const gotIds = steps.map((title) => /^select (.+?) \(depth \d+\)$/.exec(title)?.[1] ?? null);
          const wantIds = [...target.parentPath, target.id];
          if (JSON.stringify(gotIds) !== JSON.stringify(wantIds)) {
            throw new Error(
              `the full path row diverges from the truth parent chain (got ${JSON.stringify(gotIds.slice(0, 6))}…, want ${JSON.stringify(wantIds.slice(0, 6))}…)`,
            );
          }
          deps.spotChecks.push({ treeId: B9_DEEP_TREE_ID, branchId: "b9-deep-c050", pathRowLevels: gotIds.length });
        }

        /* 材料来源节点：⌖ Source of selected → 工作台开树 + 阅读器开于锚定块。
           选最小含材料来源的树（工作台开树拉全量树态——5000 节点树非本断言对象）。 */
        {
          const treesWithMaterialOrigin = deps.dataset.trees
            .filter((tree) => tree.nodes.some((node) => node.originKind === "material"))
            .sort((a, b) => a.nodes.length - b.nodes.length);
          const originTree = treesWithMaterialOrigin[0];
          if (originTree === undefined) throw new Error("nav probe: no tree with a material-origin node (dataset shape changed)");
          const materialNode = originTree.nodes.find((node) => node.originKind === "material");
          if (materialNode === undefined) throw new Error("nav probe: material-origin node missing (dataset shape changed)");
          await openTreeUnmeasured(deps.ctx, originTree.treeId);
          /* 经分支搜索揭示目标（未展开的树上行不在 DOM——搜索命中行携带完整
             路径，reveal 展开祖先并选中；与用户路径一致）。 */
          deps.mirror.expandAncestors(originTree.treeId, materialNode.id);
          await navFillInput(deps.ctx, "#nav-node-search", materialNode.id);
          await deps.ctx.evalJs(armWaiterExpr(settleSearchHit(materialNode.id)));
          await navRowDomClickWithFallback(deps.ctx, "#nav-node-find");
          await waitFor(
            deps.ctx,
            `(() => document.querySelector(${JSON.stringify(`#nav-node-results button[data-branch-id=${JSON.stringify(materialNode.id)}]`)}) !== null)()`,
            { label: `branch-search hit for ${materialNode.id} (source spot-check)`, timeoutMs: 15_000 },
          );
          await deps.ctx.evalJs(armWaiterExpr(settleSelect(materialNode.id)));
          await navRowDomClickWithFallback(deps.ctx, `#nav-node-results button[data-branch-id=${JSON.stringify(materialNode.id)}]`);
          await awaitWaiter(deps.ctx, `reveal:${materialNode.id} (source spot-check)`, 30_000);
          await navRowDomClickWithFallback(deps.ctx, "#nav-source-selected");
          const readerState = await waitFor(
            deps.ctx,
            `(() => { const reader = document.getElementById("material-reader"); ` +
              `if (reader === null || reader.hidden) return false; ` +
              `const block = document.querySelector('#mat-blocks [data-block-id="${materialNode.origin.blockId}"]'); ` +
              `return block !== null ? { blockId: block.dataset.blockId } : false; })()`,
            { label: "source-of-selected opens the reader at the anchored material block", timeoutMs: 30_000 },
          );
          const excerptThere = await deps.ctx.evalJs(
            `(() => { const el = document.querySelector('#mat-blocks [data-block-id="${materialNode.origin.blockId}"]'); ` +
              `if (el === null) return false; const layer = el.classList.contains("pdf-page-frame") ? (el.querySelector(".pdf-page-text") ?? el) : el; ` +
              `return (layer.textContent ?? "").includes(${JSON.stringify(materialNode.origin.excerpt.slice(0, 10))}); })()`,
          );
          if (excerptThere !== true) {
            throw new Error(`the anchored block does not carry the origin excerpt for ${materialNode.id}`);
          }
          deps.spotChecks.push({ treeId: originTree.treeId, branchId: materialNode.id, sourceJump: { blockId: readerState.blockId, excerptVisible: true } });
          await inputClickAt(deps.ctx, "#mat-close");
          await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (nav source spot-check)" });
        }
      }

  return {

  };
}
