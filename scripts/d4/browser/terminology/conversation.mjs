/** conversation ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  inputClickAt,
  sleep,
  waitFor,
} from "../material-probes.mjs";
import {
  treeStateViaApi,
  trunkViewOf,
} from "./facts.mjs";
import {
  TURN_BODY_WALKER,
} from "./selection.mjs";

/** 主干提问（真实键入 + Send 点击）→ 等待该问题的 assistant 回答落地
 *  （服务端事实）并在 DOM 渲染。返回 {userTurn, answerTurn}。 */
export async function sendTrunkPrompt(ctx, treeId, text, { timeoutMs, label }) {
  const before = trunkViewOf(await treeStateViaApi(ctx, treeId));
  const assistantBefore = (before?.turns ?? []).filter((turn) => turn?.role === "assistant").length;
  await inputClickAt(ctx, "#prompt-input");
  await ctx.cdpSend("Input.insertText", { text });
  const typed = await ctx.evalJs(`(() => document.getElementById("prompt-input").value)()`);
  if (typed !== text) {
    throw new Error(`${label}: the trunk composer did not receive the prompt (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#send");
  /* 服务端事实轮询（POST /prompt 的响应在 run 终态后才返回；以树态为准）。 */
  for (let elapsed = 0; ; elapsed += 200) {
    const state = await treeStateViaApi(ctx, treeId);
    const trunk = trunkViewOf(state);
    const turns = trunk?.turns ?? [];
    const userIdx = turns.findIndex((turn) => turn?.role === "user" && turn?.text === text);
    if (userIdx >= 0) {
      const after = turns.slice(userIdx + 1).find((turn) => turn?.role === "assistant");
      if (after !== undefined && typeof after.text === "string" && after.text.trim().length > 0) {
        const userTurn = turns[userIdx];
        /* DOM 渲染对齐（正文层 = .turn-actions 之外的文本节点拼接——与 turn
           原文字节相等；元素整体 textContent 混入动作按钮文字，不可比）。 */
        await waitFor(
          ctx,
          `(() => { ${TURN_BODY_WALKER}
            return [...document.querySelectorAll("#conversation .turn.assistant")].some((el) => {
              const nodes = bodyTextNodes(el);
              return nodes.map((n) => n.data).join("") === ${JSON.stringify(after.text)};
            }); })()`,
          { label: `${label}: the answer rendered in the Trunk conversation`, timeoutMs: 15_000 },
        );
        return { userTurn, answerTurn: after, assistantCount: turns.filter((turn) => turn?.role === "assistant").length, assistantBefore };
      }
    }
    if (elapsed >= timeoutMs) {
      throw new Error(`${label}: the trunk prompt did not land a non-empty assistant answer in ${String(timeoutMs)}ms`);
    }
    await sleep(200);
  }
}

/** 面板追问（真实键入 + Send 点击）→ 新 assistant 回答落地。 */
export async function panelFollowUp(ctx, marker, promptText, timeoutMs, label) {
  await inputClickAt(ctx, "#panel-prompt-input");
  await ctx.cdpSend("Input.insertText", { text: promptText });
  const typed = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
  if (typed !== promptText) {
    throw new Error(`${label}: the panel composer did not receive the follow-up (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#panel-send");
  await waitFor(
    ctx,
    `(() => { const conv = document.getElementById("panel-conversation"); ` +
      `const turns = [...conv.querySelectorAll(".turn")]; ` +
      `const markerIndex = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
      `if (markerIndex < 0) return false; ` +
      `const answerAfter = turns.slice(markerIndex + 1).find((t) => t.classList.contains("assistant")); ` +
      `return answerAfter !== undefined && (answerAfter.textContent ?? "").trim().length > 0; })()`,
    { label: `${label}: follow-up ${marker} landed with an assistant answer`, timeoutMs },
  );
}

/** 面板 Return（b3 同款真实用户路径：草稿预填 → 全选 → 键入替换 → 提交）。 */
export async function submitTermReturn(ctx, returnText, retMarker, label) {
  await inputClickAt(ctx, "#return-input");
  await ctx.evalJs(
    `(() => { const input = document.getElementById("return-input"); ` +
      `input.setSelectionRange(0, input.value.length); return input.selectionStart !== input.selectionEnd; })()`,
  );
  await ctx.cdpSend("Input.insertText", { text: returnText });
  const typed = await ctx.evalJs(`(() => document.getElementById("return-input").value)()`);
  if (typed !== returnText) {
    throw new Error(`${label}: the return draft did not receive the typed text (got ${String(typed === null ? "null" : `${String(typed.length)} units`)})`);
  }
  await inputClickAt(ctx, "#submit-return");
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `if (panel === null || !panel.hidden) return false; ` +
      `return [...document.querySelectorAll("#conversation .turn.return")]` +
      `.some((card) => (card.dataset.turnText ?? "") === ${JSON.stringify(returnText)} && (card.textContent ?? "").includes(${JSON.stringify(retMarker)})); })()`,
    { label: `${label}: panel closed and the Return card landed on the Trunk`, timeoutMs: 30_000 },
  );
  return ctx.evalJs(
    `(() => { const card = [...document.querySelectorAll("#conversation .turn.return")]` +
      `.find((c) => (c.dataset.turnText ?? "") === ${JSON.stringify(returnText)}); ` +
      `return card === undefined ? null : { meta: card.querySelector(".meta")?.textContent ?? null, ` +
      `delivery: card.querySelector(".delivery")?.textContent ?? null }; })()`,
  );
}

/** 分支 tab 点击开面板（b3 openBranchPanelViaTab 的轻量版：列表静置一拍）。 */
export async function openBranchPanelViaTab(ctx, branchId, label) {
  const selector = `#branch-tabs button[data-branch-id=${JSON.stringify(branchId)}]`;
  await waitFor(ctx, `(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`, {
    label: `${label}: branch tab present`,
    timeoutMs: 20_000,
  });
  await sleep(350);
  await inputClickAt(ctx, selector);
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `return panel !== null && !panel.hidden && document.getElementById("panel-conversation").children.length > 0; })()`,
    { label: `${label}: branch panel open`, timeoutMs: 20_000 },
  );
}

export async function closePanel(ctx) {
  const closed = await ctx.evalJs(`(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`);
  if (closed === true) return;
  await inputClickAt(ctx, "#panel-close");
  await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, {
    label: "branch panel closed",
  });
}
