/** Navigation keyboard phase with original assertions and caller cleanup Instance-owned state and dependencies. */
import { openTreeUnmeasured } from "./operations.mjs";
import { B9_DEEP_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { waitFor } from "../material-probes.mjs";
import { rowSelector } from "./settlement.mjs";
import { sleep } from "../material-probes.mjs";

export async function runNavKeyboard(deps) {

      {
        await openTreeUnmeasured(deps.ctx, B9_DEEP_TREE_ID);
        /* 展开状态恢复（上一相保存的展开集合）：等待揭示完成（保存的选中行在场）。 */
        await waitFor(
          deps.ctx,
          `(() => document.querySelector(${JSON.stringify(rowSelector("b9-deep-c010"))}) !== null)()`,
          { label: "b9-deep restore reveal (saved selection reachable)", timeoutMs: 30_000 },
        );
        await deps.ctx.evalJs(`(() => { document.getElementById("nav-tree-scroll").focus(); return true; })()`);
        const focusState = async () => deps.ctx.evalJs(
          `(() => { const el = document.activeElement; ` +
            `const row = el === null ? null : (el.closest ? el.closest("#nav-tree li.nav-item") : null); ` +
            `return { tag: el === null ? null : el.tagName, id: el === null ? null : el.id, ` +
              `branchId: row === null ? null : (row.dataset.branchId ?? null), focused: row === null ? null : row.classList.contains("focused") }; })()`,
        );
        const pressKey = async (key, code, vk) => {
          await deps.ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 });
          await deps.ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 });
          await sleep(140);
        };
        const assertFocus = async (step, expectedBranchId) => {
          const state = await focusState();
          deps.keyboard.steps.push({ step, ...state });
          if (state.branchId !== expectedBranchId || state.focused !== true) {
            throw new Error(
              `keyboard focus lost at step ${step}: expected row ${expectedBranchId} focused, got ${JSON.stringify(state)}`,
            );
          }
        };
        await pressKey("Home", "Home", 36);
        await assertFocus("Home (first row; large re-windowing jump)", deps.deep.trunkBranchId);
        await pressKey("ArrowRight", "ArrowRight", 39);
        await assertFocus("ArrowRight descends into the first child", "b9-deep-c001");
        await pressKey("ArrowDown", "ArrowDown", 40);
        await assertFocus("ArrowDown level walk", "b9-deep-c002");
        await pressKey("ArrowDown", "ArrowDown", 40);
        await pressKey("ArrowDown", "ArrowDown", 40);
        await pressKey("ArrowDown", "ArrowDown", 40);
        await assertFocus("ArrowDown ×3 more", "b9-deep-c005");
        /* End = 可见行序的末个节点行（真值数组序与 API 子序在 b9-deep 上实测
           不同——末行身份不硬编码：断言焦点落在某行上且为大跳后的重划窗口
           内行；随后 Home 回首行（trunk）再验一次大跳）。 */
        await pressKey("End", "End", 35);
        {
          const state = await focusState();
          deps.keyboard.steps.push({ step: "End (last row; large re-windowing jump)", ...state });
          if (state.branchId === null || state.focused !== true) {
            throw new Error(`keyboard focus lost at End: expected a focused row, got ${JSON.stringify(state)}`);
          }
          deps.keyboard.endRowId = state.branchId;
        }
        await pressKey("Home", "Home", 36);
        await assertFocus("Home again (large re-windowing jump)", deps.deep.trunkBranchId);
        await pressKey("ArrowLeft", "ArrowLeft", 37);
        await assertFocus("ArrowLeft collapses the expanded trunk (focus retained)", deps.deep.trunkBranchId);
        {
          const collapsed = await deps.ctx.evalJs(`(() => document.querySelector(${JSON.stringify(rowSelector("b9-deep-c001"))}) === null)()`);
          if (collapsed !== true) {
            throw new Error("ArrowLeft did not collapse the trunk (the collapsed subtree must leave zero rows)");
          }
        }
        await pressKey("ArrowRight", "ArrowRight", 39);
        await assertFocus("ArrowRight re-expands the trunk (focus retained across re-windowing)", deps.deep.trunkBranchId);
        await pressKey("ArrowRight", "ArrowRight", 39);
        await assertFocus("ArrowRight descends again after re-expansion", "b9-deep-c001");
      }

  return {

  };
}
