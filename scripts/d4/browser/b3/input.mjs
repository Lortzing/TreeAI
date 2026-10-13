/** input ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */
import {
  inputClickAt,
  sleep,
  waitFor,
} from "../material-probes.mjs";
import {
  B3_FRONTEND_BUGS,
} from "./policy.mjs";

/** 双击提交（DOM click 双发 + dblclick 合成）：CDP 输入管线在按压段与阅读器
 *  延后重渲（捕获条解除/流程面重渲的布局位移）竞态——实测把提交按钮的
 *  落点让给块元素；与复制/建枝按钮同款 DOM click 管线（既有注释同源）。
 *  双击语义的被测对象 = 在途锁（submitting）+ 服务端 intent-key 幂等——
 *  两次 click 事件均送达应用自身的监听器（第二次按重渲后的当前按钮——
 *  真实用户双击的落点），handler 级守卫与服务端对账均被完整行使。 */
export async function domDoubleClick(ctx, selector) {
  const clickOnce = async (detail) => {
    const clicked = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return false; ` +
        `el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: ${String(detail)} })); ` +
        `return true; })()`,
    );
    return clicked === true;
  };
  if ((await clickOnce(1)) !== true) throw new Error(`double-click target not found (first click): ${selector}`);
  await sleep(30);
  if ((await clickOnce(2)) !== true) {
    /* 第一次点击已触发 submitting 重渲（按钮换新或流程已收起）——第二次
       点击无处落点即如实记录（真实双击的第二击同样可能落在收起后的面）。 */
    return "second-click-target-gone";
  }
  await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el !== null) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); return true; })()`,
  );
  return "double-click-delivered";
}

/** DOM click（与复制/建枝按钮同款管线——CDP 输入点击的 press/release 分段会
 *  让 0ms 解除路径抢在 release 之前，见 material-probes 既有注释）。 */
export async function domClick(ctx, selector) {
  const clicked = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
  );
  if (clicked !== true) throw new Error(`click target not found: ${selector}`);
}

/** 响应丢失注入（CDP Fetch 域 Response 阶段）：urlPattern 匹配的请求已到
 *  服务端并完整处理（响应可读），仅响应被 failRequest 丢弃——「服务端已
 *  成功、客户端未见」的真实传输层模拟。fn 结束后停用（自身失能的监听器，
 *  Fetch.disable 后不再有 requestPaused 事件）。 */
export async function withDroppedResponses(ctx, urlPattern, fn) {
  const handle = { active: true, dropped: 0 };
  const listener = (params) => {
    if (!handle.active) return;
    /* Response 阶段：responseStatusCode 在场（请求已被服务端处理）。 */
    if (params.responseStatusCode !== undefined || params.responseError !== undefined) {
      handle.dropped += 1;
      void ctx.cdpSend("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionReset" }).catch(() => { /* 尽力而为 */ });
      return;
    }
    /* 防御：请求阶段暂停不应出现（patterns 限定 Response）——放行，不悬挂。 */
    void ctx.cdpSend("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { /* 尽力而为 */ });
  };
  ctx.cdpOn("Fetch.requestPaused", listener);
  await ctx.cdpSend("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Response" }] });
  try {
    const value = await fn();
    return { value, dropped: handle.dropped };
  } finally {
    handle.active = false;
    try {
      await ctx.cdpSend("Fetch.disable");
    } catch {
      /* 尽力而为 */
    }
  }
}

export async function openBranchPanelViaTab(ctx, branchId) {
  const selector = `#branch-tabs button[data-branch-id=${JSON.stringify(branchId)}]`;
  await waitFor(ctx, `(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`, {
    label: `branch tab present for ${branchId}`,
    timeoutMs: 20_000,
  });
  /* 页面刚装载/SSE 重连时分支 tab 列表会连发重渲（renderAll 逐事件重建）：
     等列表静置一拍再取坐标点击（命中复核与坐标同表达式——inputClickAt
     自带重试）。 */
  await sleep(400);
  const before = await ctx.evalJs(`(() => document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)()`);
  await sleep(250);
  const after = await ctx.evalJs(`(() => document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)()`);
  if (before !== after) {
    await sleep(400); /* 仍在重渲：再等一拍 */
  }
  try {
    await inputClickAt(ctx, selector);
  } catch (err) {
    /* 命中失败：核实是否为 #branch-section 塌缩（height 0 裁剪——真实缺陷），
       是则记录缺陷并用 DOM click 兜底（事件直达应用监听器，面板路径可继续
       被行使）；否则如实重抛。 */
    const cover = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return null; ` +
        `const section = document.getElementById("branch-section"); ` +
        `const r = el.getBoundingClientRect(); ` +
        `const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); ` +
        `return { sectionHeight: section === null ? null : section.getBoundingClientRect().height, ` +
          `hitIsTab: hit !== null && hit.closest(${JSON.stringify(selector)}) !== null }; })()`,
    );
    if (cover !== null && cover.sectionHeight === 0 && cover.hitIsTab !== true) {
      const already = B3_FRONTEND_BUGS.some((bug) => bug.id === "branch-section-collapse");
      if (!already) {
        B3_FRONTEND_BUGS.push({
          id: "branch-section-collapse",
          detail:
            "#branch-section (the sidebar's only flex:1 section, min-height:0) collapses to height 0 when the other sidebar sections " +
            "(Forest/Navigate/Materials/Search, all flex-shrink:0) fill the viewport — every branch tab is clipped and unclickable " +
            `(elementFromPoint at the tab center returns ASIDE#sidebar; measured section height ${String(cover.sectionHeight)}px, ` +
            "#branch-tabs content 96px) — the 1b48ef0 fix capped tree-list/material-list but left this pressure valve with no floor; " +
            "reported to the owner, not fixed in this wave (probe continues via DOM click so the panel paths stay exercised)",
        });
      }
      await domClick(ctx, selector);
    } else {
      throw err;
    }
  }
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `return panel !== null && !panel.hidden && document.getElementById("panel-conversation").children.length > 0; })()`,
    { label: `branch panel open for ${branchId} (tab click)`, timeoutMs: 20_000 },
  );
}

/** 面板追问（真实键入 + Send 点击）→ 等待新 assistant 落地（追问文本在场
 *  且其后有 assistant 回答）。echo/真实 Pi 皆适用（超时按模式放大）。 */
export async function panelFollowUp(ctx, marker, promptText, timeoutMs) {
  await inputClickAt(ctx, "#panel-prompt-input");
  await ctx.cdpSend("Input.insertText", { text: promptText });
  const typed = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
  if (typed !== promptText) {
    throw new Error(`panel composer did not receive the follow-up (got ${JSON.stringify(typed)})`);
  }
  await inputClickAt(ctx, "#panel-send");
  await waitFor(
    ctx,
    `(() => { const conv = document.getElementById("panel-conversation"); ` +
      `const turns = [...conv.querySelectorAll(".turn")]; ` +
      `const markerIndex = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
      `if (markerIndex < 0) return false; ` +
      `const answerAfter = turns.slice(markerIndex + 1).find((t) => t.classList.contains("assistant")); ` +
      `return answerAfter !== undefined && (answerAfter.textContent ?? "").trim().length > 0 ` +
      `? { userTurns: turns.filter((t) => t.classList.contains("user")).length, answerLen: (answerAfter.textContent ?? "").trim().length } ` +
      `: false; })()`,
    { label: `follow-up ${marker} landed with an assistant answer`, timeoutMs },
  );
}

/** 服务器事实读回：分支视图（turn 集）。 */
export async function branchViewViaApi(ctx, treeId, branchId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  if (res.status !== 200) throw new Error(`B3 /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  const view = (res.body?.branches ?? []).find((candidate) => candidate?.branch?.id === branchId) ?? null;
  if (view === null) throw new Error(`B3 branch ${branchId} missing from /state`);
  return view;
}
