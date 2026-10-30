/** beta materials-branch phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { materialButtonSelector } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";
import { pageSelectCanonical } from "../material-probes.mjs";
import { waitForArmedBar } from "../material-probes.mjs";

export async function runBetaMaterialsBranch(deps) {


      /* ============ 2) 场景支线：材料 Branch（真实 UI 建枝 + 首问/追问） ============ */
      {
        const md = { materialId: null };
        {
          const ids = await deps.ctx.evalJs(`(() => [...document.querySelectorAll("#material-list button[data-material-id]")].map((b) => ({ id: b.dataset.materialId, meta: (b.querySelector(".material-meta")?.textContent ?? "") })))()`);
          for (const entry of ids) {
            if (entry.meta.includes("markdown")) md.materialId = entry.id;
          }
          if (md.materialId === null) throw new Error(`beta probe: no markdown material in the sidebar (${JSON.stringify(ids)})`);
        }
        await inputClickAt(deps.ctx, materialButtonSelector(md.materialId));
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `if (reader === null || reader.hidden) return false; ` +
            `const blocks = document.querySelectorAll("#mat-blocks .material-block").length; ` +
            `if (blocks !== 50) return false; ` +
            `return (document.getElementById("mat-tail").textContent ?? "").includes("50 block(s) in view"); })()`,
          { label: `md-11 reader opened (first 50 of ${String(deps.mdBlocks.length)} blocks, lazy tail)`, timeoutMs: 25_000 },
        );
        const readerSurface = await deps.ctx.evalJs(`(() => ({
          floatingOpen: document.getElementById("materials-section").open,
          fileDetailsOpen: document.getElementById("mat-file-details").open,
          text: document.getElementById("material-reader").innerText
        }))()`);
        if (readerSurface.floatingOpen || readerSurface.fileDetailsOpen || /d4-md-v1|UTF-16|text units total/.test(readerSurface.text)) {
          throw new Error(`reader exposes implementation details or leaves attachments open: ${JSON.stringify(readerSurface)}`);
        }
        /* 武装选区（selectionchange 路径）→ 建枝 → 提交前材料范围声明 → 首问。 */
        const placed = await deps.ctx.evalJs(pageSelectCanonical(deps.mdRange.blockId, deps.mdRange.start, deps.mdRange.end));
        if (placed === null || placed.error !== undefined || placed.selectedText !== deps.mdRange.excerpt) {
          throw new Error(`beta probe: md-11 selection did not land as planned — ${JSON.stringify(placed)}`);
        }
        await waitForArmedBar(deps.ctx, "beta md-11 selection", 6000);
        await deps.domClick(deps.ctx, "#mat-selection-bar .mat-branch-d43");
        await waitFor(
          deps.ctx,
          `(() => { const flow = document.getElementById("mat-branch-flow"); ` +
            `return flow !== null && document.getElementById("mat-branch-first-question") !== null ` +
            `&& (flow.textContent ?? "").includes("本次提问会参考以下材料"); })()`,
          { label: "branch flow with the pre-submit material scope declaration", timeoutMs: 20_000 },
        );
        const scopeOk = await deps.ctx.evalJs(
          `(() => { const flow = document.getElementById("mat-branch-flow"); const text = flow.textContent ?? ""; ` +
            `return { block: text.includes("block ${deps.mdRange.blockId}"), range: text.includes("UTF-16 [${String(deps.mdRange.start)}, ${String(deps.mdRange.end)})"), ` +
              `excerpt: (flow.querySelector(".mat-branch-excerpt")?.textContent ?? null) === ${JSON.stringify(deps.mdRange.excerpt)} }; })()`,
        );
        if (scopeOk.block !== true || scopeOk.range !== true || scopeOk.excerpt !== true) {
          throw new Error(`beta probe: the pre-submit material scope declaration mismatch — ${JSON.stringify(scopeOk)}`);
        }
        const question = `请基于这段选区解释它的核心论点，并给出两个可检验的要点。（${deps.BETA_MARKERS.q1}）`;
        await inputClickAt(deps.ctx, "#mat-branch-first-question");
        await deps.ctx.cdpSend("Input.insertText", { text: question });
        await deps.domClick(deps.ctx, "#mat-branch-flow .mat-branch-submit");
        await waitFor(
          deps.ctx,
          `(() => { const panel = document.getElementById("branch-panel"); ` +
            `if (panel === null || panel.hidden) return false; ` +
            `const conv = document.getElementById("panel-conversation"); ` +
            `if (!(conv.textContent ?? "").includes(${JSON.stringify(deps.BETA_MARKERS.q1)})) return false; ` +
            `const turns = [...conv.querySelectorAll(".turn")]; ` +
            `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(deps.BETA_MARKERS.q1)})); ` +
            `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
          { label: `first question landed with an answer (${deps.modeNote})`, timeoutMs: deps.answerTimeoutMs },
        );
        const branchId = await deps.ctx.evalJs(`(() => document.querySelector("#branch-tabs button.panel-open")?.dataset.branchId ?? null)()`);
        if (typeof branchId !== "string") throw new Error("beta probe: could not identify the material branch tab");
        /* 一轮追问（面板会话高度 + 后续相位的语料）。 */
        const followUp = async (marker, text) => {
          await inputClickAt(deps.ctx, "#panel-prompt-input");
          await deps.ctx.cdpSend("Input.insertText", { text: `追问：${text}（${marker}）` });
          await inputClickAt(deps.ctx, "#panel-send");
          await waitFor(
            deps.ctx,
            `(() => { const conv = document.getElementById("panel-conversation"); ` +
              `const turns = [...conv.querySelectorAll(".turn")]; ` +
              `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
              `if (q < 0) return false; ` +
              `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
            { label: `follow-up ${marker} landed with an answer`, timeoutMs: deps.answerTimeoutMs },
          );
        };
        await followUp(deps.BETA_MARKERS.f1, "这个论点在原文中的依据是哪一句");
        await inputClickAt(deps.ctx, "#panel-close");
        try {
          await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed after the branch setup" });
        } catch (error) {
          await deps.ctx.screenshot("beta-panel-close-failure");
          throw error;
        }
        deps.scenarioSetup.branchId = branchId;
        deps.scenarioSetup.firstQuestion = deps.BETA_MARKERS.q1;
        deps.scenarioSetup.followUps = [deps.BETA_MARKERS.f1];
        deps.scenarioSetup.modeNote = deps.modeNote;
        deps.scenarioSetup.materialBranchOrigin = { materialId: md.materialId, blockId: deps.mdRange.blockId, range: deps.mdRange };
      }

  return {

  };
}
