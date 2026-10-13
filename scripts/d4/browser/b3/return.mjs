/** return ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */
import {
  assertNoPageErrors,
  inputClickAt,
  waitFor,
} from "../material-probes.mjs";
import {
  domClick,
  openBranchPanelViaTab,
} from "./input.mjs";
import {
  B3_FRONTEND_BUGS,
  B3_MARKERS,
  B3_PDF_FIXTURE_ID,
} from "./policy.mjs";

/* ------------------------------------------------------------------ */
/* 探针 2：d4-return-from-material                                       */
/* ------------------------------------------------------------------ */

export async function probeReturnFromMaterial(ctx) {
  const treeId = ctx.scenario.treeId;
  const b3 = ctx.scenario.b3;
  if (treeId === null || b3 === undefined || b3.mdBranchId === undefined || b3.pdfBranchId === undefined) {
    throw new ctx.NotRunError("材料 Branch 未就位（见 d4-branch-from-material 的结果）——材料 Return 探针级联跳过");
  }
  const materials = ctx.scenario.materials;
  const md01 = materials["md-01"];
  const pdf01 = materials[B3_PDF_FIXTURE_ID];
  const modeNote = ctx.MODE === "selftest"
    ? "echo driver — NOT B3 evidence; proves the probe/UI code path only"
    : "real Pi answers";
  const lines = [];
  const returns = [];

  /** 单枝回原文 + Return 闭环。 */
  const runReturnLoop = async (label, branchId, material, range, returnText, retMarker) => {
    /* 1) 面板打开（tab 点击）→ ⌖ View source → 阅读器打开于锚定版本+块。 */
    await openBranchPanelViaTab(ctx, branchId);
    await domClick(ctx, "#panel-view-source");
    const jumped = await waitFor(
      ctx,
      `(() => { const reader = document.getElementById("material-reader"); ` +
        `if (reader === null || reader.hidden) return false; ` +
        `const note = (reader.textContent ?? ""); ` +
        `if (!note.includes("jumped to the material source of a Return — located at block ${range.blockId}")) return false; ` +
        `const block = document.querySelector('#mat-blocks [data-block-id="${range.blockId}"]'); ` +
        `return block !== null ? { inView: block.getBoundingClientRect().top < window.innerHeight && block.getBoundingClientRect().bottom > 0 } : false; })()`,
      { label: `${label}: return-to-source opened the reader at block ${range.blockId}`, timeoutMs: 25_000 },
    );
    if (jumped.inView !== true) {
      throw new Error(`${label}: the anchored block ${range.blockId} is not in the viewport after the source jump`);
    }
    /* 精确摘录在场（md：块文本；pdf：已渲染页文本层）。 */
    const excerptVisible = await ctx.evalJs(
      `(() => { const el = document.querySelector('#mat-blocks [data-block-id="${range.blockId}"]'); ` +
        `if (el === null) return false; const layer = el.classList.contains("pdf-page-frame") ` +
        `? (el.querySelector(".pdf-page-text") ?? el) : el; ` +
        `return (layer.textContent ?? "").includes(${JSON.stringify(range.excerpt.slice(0, Math.min(12, range.excerpt.length)))}); })()`,
    );
    if (excerptVisible !== true) {
      throw new Error(`${label}: the exact excerpt is not visible in the anchored block after the source jump`);
    }
    await ctx.screenshot(`b3-${label}-return-source`);

    /* 2) Return 草稿 + 提交（真实 UI）→ 面板收起 + 主线材料 Return 卡。
       面板打开时草稿按产品行为预填分支最后一个回答（syncReturnDraftForBranch
       的 lastAnswerText 预填）——真实用户路径：全选（Ctrl+A）后键入替换。 */
    await inputClickAt(ctx, "#mat-close");
    await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: `${label}: reader closed before the Return submit` });
    /* 面板在阅读器关闭后仍在（View source 不收面板）。 */
    await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, { label: `${label}: branch panel still open` });
    await inputClickAt(ctx, "#return-input");
    /* 全选（真实用户路径；CDP 的 Ctrl+A 合成在 headless 输入管线下不可靠，
       以 setSelectionRange 置选区——替换动作本身由真实 insertText 管线完成）。 */
    await ctx.evalJs(
      `(() => { const input = document.getElementById("return-input"); ` +
        `input.setSelectionRange(0, input.value.length); return input.selectionStart !== input.selectionEnd; })()`,
    );
    await ctx.cdpSend("Input.insertText", { text: returnText });
    const typedReturn = await ctx.evalJs(`(() => document.getElementById("return-input").value)()`);
    if (typedReturn !== returnText) {
      throw new Error(`${label}: the return draft did not receive the typed text (got ${String(typedReturn === null ? "null" : `${String(typedReturn.length)} units`)})`);
    }
    await inputClickAt(ctx, "#submit-return");
    try {
      await waitFor(
        ctx,
        `(() => { const conv = document.getElementById("conversation"); ` +
          `const card = [...conv.querySelectorAll(".turn.return.material-return")]` +
          `.find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(retMarker)})) ?? null; ` +
          `if (card === null) return false; ` +
          `const fields = card.querySelector(".mat-return-source-fields"); ` +
          `const quote = card.querySelector(".mat-return-excerpt"); ` +
          `return fields !== null && quote !== null ` +
          `? { fields: fields.textContent, quote: quote.textContent } : false; })()`,
        { label: `${label}: material Return card on the Trunk with the source card`, timeoutMs: 30_000 },
      );
    } catch (err) {
      const snap = await ctx.evalJs(
        `(() => ({ panelHidden: document.getElementById("branch-panel")?.hidden ?? null, ` +
          `returnInput: (document.getElementById("return-input")?.value ?? "").slice(0, 120), ` +
          `mainError: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 300), ` +
          `panelError: (document.getElementById("panel-error-banner")?.textContent ?? "").slice(0, 300), ` +
          `trunkReturns: document.querySelectorAll("#conversation .turn.return").length, ` +
          `materialReturns: document.querySelectorAll("#conversation .turn.return.material-return").length, ` +
          `trunkTextTail: (document.getElementById("conversation").textContent ?? "").slice(-400) }))()`,
      );
      throw new Error(`${label}: material Return card did not land — snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
    }
    const cardInfo = await ctx.evalJs(
      `(() => { const card = [...document.querySelectorAll("#conversation .turn.return.material-return")]` +
        `.find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(retMarker)})) ?? null; ` +
        `if (card === null) return null; ` +
        `return { fields: card.querySelector(".mat-return-source-fields")?.textContent ?? null, ` +
        `quote: card.querySelector(".mat-return-excerpt")?.textContent ?? null, ` +
        `text: card.dataset.turnText ?? null, jump: card.querySelector(".mat-return-jump")?.textContent ?? null }; })()`,
    );
    const problems = [];
    if (cardInfo === null) problems.push("no material return card in the main conversation");
    else {
      if (!cardInfo.fields.includes(`“${material.title}”`)) problems.push(`source card does not name the material: ${JSON.stringify(cardInfo.fields)}`);
      if (!cardInfo.fields.includes(`block ${range.blockId}`)) problems.push(`source card does not state block ${range.blockId}: ${JSON.stringify(cardInfo.fields)}`);
      if (cardInfo.quote !== range.excerpt) problems.push(`source-card excerpt is not the exact selection excerpt (got ${JSON.stringify(cardInfo.quote)})`);
      if (cardInfo.text !== returnText) problems.push(`return card text differs from the submitted draft (got ${JSON.stringify(cardInfo.text)})`);
      if (cardInfo.jump !== "⌖ View material source") problems.push(`source-card jump affordance missing: ${JSON.stringify(cardInfo.jump)}`);
    }
    if (problems.length > 0) throw new Error(`${label}: material Return card mismatch — ${problems.join("; ")}`);
    /* 服务器事实对账（material-return 落库：Return turn 在主线分支上、
       fromBranchId 指回材料分支、文本 = 提交文本）。 */
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    if (res.status !== 200) throw new Error(`B3 /state HTTP ${String(res.status)}`);
    const trunkView = (res.body?.branches ?? []).find((candidate) => candidate?.branch?.parentBranchId === null) ?? null;
    const retTurns = (trunkView?.turns ?? []).filter((turn) => turn?.role === "return");
    if (!retTurns.some((turn) => turn?.text === returnText && turn?.fromBranchId === branchId)) {
      throw new Error(
        `${label}: no material-return turn with the submitted text on the server (trunk has ${String(retTurns.length)} return turns)`,
      );
    }
    returns.push({ branch: branchId, blockId: range.blockId, marker: retMarker, fields: cardInfo.fields });
    lines.push(
      `${label}: panel View source → reader at block ${range.blockId} with the exact excerpt in view; Return submitted → ` +
        `Trunk card carries the material source fields + exact excerpt + View-material-source jump`,
    );
  };

  /* md 枝回原文 + Return。 */
  await runReturnLoop(
    "md",
    b3.mdBranchId,
    md01,
    b3.mdRange,
    `材料探索的收获（md）：核心论点与两个要点已核对。（${B3_MARKERS.mdRet}）`,
    B3_MARKERS.mdRet,
  );

  /* pdf 枝回原文 + Return（页块定位 + 页码注记）。 */
  await runReturnLoop(
    "pdf",
    b3.pdfBranchId,
    pdf01,
    b3.pdfRange,
    `材料探索的收获（pdf）：关键信息三点已概括。（${B3_MARKERS.pdfRet}）`,
    B3_MARKERS.pdfRet,
  );

  /* Return 卡的「⌖ View material source」跳转（再入原文）。 */
  {
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#conversation .turn.return.material-return .mat-return-jump"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    await waitFor(
      ctx,
      `(() => { const reader = document.getElementById("material-reader"); ` +
        `return reader !== null && !reader.hidden && ` +
        `(reader.textContent ?? "").includes("jumped to the material source of a Return — located at block ${b3.mdRange.blockId}"); })()`,
      { label: "return-card View material source reopens the reader at the anchored block", timeoutMs: 25_000 },
    );
    await ctx.screenshot("b3-return-card-source-jump");
    lines.push("return-card source jump reopens the reader at the anchored md block");
    await inputClickAt(ctx, "#mat-close");
    await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed after the return-card jump" });
  }

  /* 重启续走（Return 之后）：SIGTERM + 新进程 → Return 卡仍在主线、支线历史可读。 */
  {
    const oldPort = ctx.studioPort();
    await ctx.stopStudio();
    await ctx.navigate("about:blank");
    const newUrl = await ctx.restartStudioSamePort();
    await ctx.navigate(newUrl);
    await waitFor(
      ctx,
      `(() => { const section = document.getElementById("materials-section"); ` +
        `return section !== null && !section.hidden; })()`,
      { label: "workbench reopened after the post-Return same-port restart" },
    );
    const bodyHasReturns = await ctx.evalJs(
      `(() => { const text = document.body.textContent ?? ""; ` +
        `return text.includes(${JSON.stringify(B3_MARKERS.mdRet)}) && text.includes(${JSON.stringify(B3_MARKERS.pdfRet)}); })()`,
    );
    if (bodyHasReturns !== true) {
      throw new Error("B3: the material Return cards are not visible on the Trunk after the restart");
    }
    await openBranchPanelViaTab(ctx, b3.pdfBranchId);
    await waitFor(
      ctx,
      `(() => (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(B3_MARKERS.pdfF2)}))()`,
      { label: "pdf exploration history readable after the restart" },
    );
    lines.push(`post-Return restart: SIGTERM → new process (port ${String(oldPort)}→${String(ctx.studioPort())}) → both Return cards on the Trunk + branch history readable`);
    await ctx.screenshot("b3-post-return-restart");

    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (entry) => entry.text.includes(`http://127.0.0.1:${String(oldPort)}`),
      label: "d4-return-from-material",
    });
    await ctx.sidecar("return-from-material", {
      check: "d4-return-from-material",
      mode: ctx.MODE,
      modeNote,
      treeId,
      returns,
      markers: B3_MARKERS,
      lines,
      frontendBugs: B3_FRONTEND_BUGS,
      pageErrorsExcluded: excludedCount,
    });
  }
  return {
    detail:
      `return-to-source from both branch panels (md block + pdf page block) opened the reader at the anchored version/block with the exact ` +
      `excerpt in view; Returns submitted via the real UI landed on the Trunk with the material source card (title/version/block + exact ` +
      `excerpt + View-material-source jump); the return-card jump reopens the source; SIGTERM restart → new process → Return cards and ` +
      `branch histories stay readable (${ctx.MODE === "selftest" ? "echo driver — NOT B3 evidence" : "real Pi"})`,
  };
}
