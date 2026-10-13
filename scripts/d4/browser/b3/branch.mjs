/** branch ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */
import {
  assertNoPageErrors,
  inputClickAt,
  materialButtonSelector,
  openMaterialInReader,
  waitFor,
} from "../material-probes.mjs";
import {
  branchViewViaApi,
  domClick,
  domDoubleClick,
  openBranchPanelViaTab,
  panelFollowUp,
  withDroppedResponses,
} from "./input.mjs";
import {
  B3_MARKERS,
  B3_PDF_FIXTURE_ID,
} from "./policy.mjs";
import {
  pdfReaderLoadedExpr,
} from "./selection.mjs";
import {
  armSelectionInReader,
  branchFromArmedSelection,
  ensureB3Corpus,
} from "./setup.mjs";

/* ------------------------------------------------------------------ */
/* 探针 1：d4-branch-from-material                                       */
/* ------------------------------------------------------------------ */

export async function probeBranchFromMaterial(ctx) {
  const { treeId, b3 } = await ensureB3Corpus(ctx);
  const materials = ctx.scenario.materials;
  const md01 = materials["md-01"];
  const pdf01 = materials[B3_PDF_FIXTURE_ID];
  const modeNote = ctx.MODE === "selftest"
    ? "echo driver (deterministic answers) — NOT B3 evidence; proves the probe/UI code path only"
    : "real Pi answers";
  const answerTimeoutMs = ctx.MODE === "selftest" ? 30_000 : Math.max(60_000, ctx.promptTimeoutMs());
  const lines = [];

  const stateOfBranch = async (branchId) => branchViewViaApi(ctx, treeId, branchId);

  /* ---- 1) markdown 分支：武装 → 建枝 → 声明 → 首问双击不重复 ---- */
  await openMaterialInReader(ctx, md01, { blocks: md01.truth.blocks.length, tail: "end" });
  await armSelectionInReader(ctx, md01, b3.mdRange);
  await branchFromArmedSelection(ctx, md01, b3.mdRange);
  const mdQuestion = `请基于这段选区解释它的核心论点，并给出两个可检验的要点。（${B3_MARKERS.mdQ1}）`;
  /* 真实双击（press/release + press(clickCount 2)/release）：在途锁与服务端
     幂等键共同保证不重复派发——双击后分支上恰好一条该文本的 user turn。 */
  await inputClickAt(ctx, "#mat-branch-first-question");
  await ctx.cdpSend("Input.insertText", { text: mdQuestion });
  const doubleClickMode = await domDoubleClick(ctx, "#mat-branch-flow .mat-branch-submit");
  try {
    await waitFor(
      ctx,
      `(() => { const panel = document.getElementById("branch-panel"); ` +
        `if (panel === null || panel.hidden) return false; ` +
        `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(B3_MARKERS.mdQ1)}); })()`,
      { label: "md first question landed (double-click submit)", timeoutMs: answerTimeoutMs },
    );
  } catch (err) {
    const snap = await ctx.evalJs(
      `(() => ({ readerHidden: document.getElementById("material-reader") === null ? null : document.getElementById("material-reader").hidden, ` +
        `flowText: (document.getElementById("mat-branch-flow")?.textContent ?? "").slice(0, 400), ` +
        `flowPresent: document.getElementById("mat-branch-flow") !== null, ` +
        `inputValue: document.getElementById("mat-branch-first-question")?.value ?? null, ` +
        `panelHidden: document.getElementById("branch-panel") === null ? null : document.getElementById("branch-panel").hidden, ` +
        `panelText: (document.getElementById("panel-conversation")?.textContent ?? "").slice(0, 200), ` +
        `mainError: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 300), ` +
        `panelError: (document.getElementById("panel-error-banner")?.textContent ?? "").slice(0, 300) }))()`,
    );
    throw new Error(`md first question (double-click) did not land — UI snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
  }
  let mdBranchId = await ctx.evalJs(`(() => document.querySelector("#branch-tabs button.panel-open")?.dataset.branchId ?? null)()`);
  if (typeof mdBranchId !== "string") {
    /* 面板开的分支读不到时经 /state 反查（标题含首问文本的分支）。 */
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    const view = (res.body?.branches ?? []).find((candidate) =>
      (candidate?.turns ?? []).some((turn) => typeof turn?.text === "string" && turn.text.includes(B3_MARKERS.mdQ1)));
    mdBranchId = view?.branch?.id ?? null;
  }
  if (typeof mdBranchId !== "string") throw new Error("B3: could not identify the md exploration branch");
  {
    const view = await stateOfBranch(mdBranchId);
    const q1UserTurns = view.turns.filter((turn) => turn?.role === "user" && typeof turn.text === "string" && turn.text.includes(B3_MARKERS.mdQ1));
    if (q1UserTurns.length !== 1) {
      throw new Error(
        `B3 double-click dedup FAILED on the md branch: ${String(q1UserTurns.length)} user turns carry the first question (must be exactly 1)`,
      );
    }
    const assistants = view.turns.filter((turn) => turn?.role === "assistant");
    if (assistants.length < 1 || !(typeof assistants[assistants.length - 1].text === "string") || assistants[assistants.length - 1].text.length === 0) {
      throw new Error(`B3 md first question landed no assistant answer (${modeNote})`);
    }
    lines.push(`md branch ${mdBranchId}: double-clicked first-question submit (${doubleClickMode}) → exactly 1 user turn + assistant answer (${modeNote})`);
  }

  /* ---- 2) md 分支：≥2 轮追问 ---- */
  await panelFollowUp(ctx, B3_MARKERS.mdF1, `第一轮追问：这个论点在原文中的依据是哪一句？请引用。（${B3_MARKERS.mdF1}）`, answerTimeoutMs);
  await panelFollowUp(ctx, B3_MARKERS.mdF2, `第二轮追问：给出一个反例情形并说明边界。（${B3_MARKERS.mdF2}）`, answerTimeoutMs);
  lines.push(`md branch: 2 follow-up rounds landed (markers ${B3_MARKERS.mdF1} / ${B3_MARKERS.mdF2})`);
  await ctx.screenshot("b3-md-branch-panel");

  /* ---- 3) pdf 分支：武装（页文本层）→ 建枝 → 声明 → 首问（响应丢失重试） ---- */
  await inputClickAt(ctx, "#panel-close");
  await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed before the pdf flow" });
  await inputClickAt(ctx, materialButtonSelector(pdf01.materialId));
  await waitFor(ctx, pdfReaderLoadedExpr(pdf01.truth.blocks.length), {
    label: `pdf-01 reader (${String(pdf01.truth.blocks.length)} pages)`,
    timeoutMs: 20_000,
  });
  {
    /* 页文本层渲染（页框滚入视口触发懒渲染——PDF 可见页先行）。 */
    const layerSel = `#mat-blocks .pdf-page-text[data-block-id="${b3.pdfRange.blockId}"]`;
    const rendered = await ctx.evalJs(
      `(() => { const layer = document.querySelector(${JSON.stringify(layerSel)}); ` +
        `if (layer === null) return { error: "page frame absent" }; ` +
        `layer.parentElement.scrollIntoView({ block: "center" }); return true; })()`,
    );
    await waitFor(
      ctx,
      `(() => (document.querySelector(${JSON.stringify(layerSel)})?.dataset.rendered ?? null) === "true")()`,
      { label: `pdf page text layer ${b3.pdfRange.blockId} rendered` },
    );
    if (rendered === null || rendered.error !== undefined) throw new Error(`B3 pdf page frame not present: ${JSON.stringify(rendered)}`);
  }
  await armSelectionInReader(ctx, pdf01, b3.pdfRange);
  await branchFromArmedSelection(ctx, pdf01, b3.pdfRange);
  const pdfQuestion = `这一页的关键信息是什么？请概括为三点。（${B3_MARKERS.pdfQ1}）`;

  /* 响应丢失重试（真实传输层模拟：请求已到服务端并落地，仅响应被丢弃）：
     第一次提交 → fetch 网络错误（错误横幅 + 流程面保留、输入不动）→
     第二次提交（同 intent key）→ 服务端先对账：已落库 → outcome null
     （幂等重放、零重发）→ 面板打开 + 幂等重放注记；分支上恰好一条首问。 */
  let droppedCount = 0;
  await inputClickAt(ctx, "#mat-branch-first-question");
  await ctx.cdpSend("Input.insertText", { text: pdfQuestion });
  ({ dropped: droppedCount } = await withDroppedResponses(ctx, "*material-first-question*", async () => {
    await domClick(ctx, "#mat-branch-flow .mat-branch-submit");
    await waitFor(
      ctx,
      `(() => { const banner = document.getElementById("error-banner"); ` +
        `const flow = document.getElementById("mat-branch-flow"); ` +
        `const input = document.getElementById("mat-branch-first-question"); ` +
        `return banner !== null && !banner.hidden && flow !== null && input !== null && input.value.includes(${JSON.stringify(B3_MARKERS.pdfQ1)}); })()`,
      { label: "response-loss path: honest error + the flow retained with the typed question", timeoutMs: answerTimeoutMs },
    );
  }));
  if (droppedCount !== 1) {
    throw new Error(
      `B3 response-loss injection dropped ${String(droppedCount)} response(s) (expected exactly 1) — the transport-layer fault did not land as designed`,
    );
  }
  /* 重试（拦截已停用）：同键幂等重放。 */
  await domClick(ctx, "#mat-branch-flow .mat-branch-submit");
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `if (panel === null || panel.hidden) return false; ` +
      `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(B3_MARKERS.pdfQ1)}); })()`,
    { label: "pdf first question landed on retry (idempotent replay after the dropped response)", timeoutMs: answerTimeoutMs },
  );
  const replayNote = await ctx.evalJs(`(() => (document.getElementById("panel-error-banner")?.textContent ?? ""))()`);
  if (!replayNote.includes("idempotent replay, no duplicate dispatch")) {
    throw new Error(`B3 response-loss retry is not honest about the replay: panel note ${JSON.stringify(replayNote)}`);
  }
  let pdfBranchId = await ctx.evalJs(`(() => document.querySelector("#branch-tabs button.panel-open")?.dataset.branchId ?? null)()`);
  if (typeof pdfBranchId !== "string") {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    const view = (res.body?.branches ?? []).find((candidate) =>
      (candidate?.turns ?? []).some((turn) => typeof turn?.text === "string" && turn.text.includes(B3_MARKERS.pdfQ1)));
    pdfBranchId = view?.branch?.id ?? null;
  }
  if (typeof pdfBranchId !== "string") throw new Error("B3: could not identify the pdf exploration branch");
  if (pdfBranchId === mdBranchId) throw new Error("B3: md and pdf explorations share one branch (must be separate)");
  {
    const view = await stateOfBranch(pdfBranchId);
    const q1UserTurns = view.turns.filter((turn) => turn?.role === "user" && typeof turn.text === "string" && turn.text.includes(B3_MARKERS.pdfQ1));
    if (q1UserTurns.length !== 1) {
      throw new Error(
        `B3 response-loss retry duplicated the first question: ${String(q1UserTurns.length)} user turns on the pdf branch (must be exactly 1)`,
      );
    }
    lines.push(`pdf branch ${pdfBranchId}: dropped dispatch response (${String(droppedCount)} response failed at the transport layer) → same-key retry → idempotent replay (exactly 1 user turn, replay note shown)`);
  }

  /* ---- 4) pdf 分支：≥2 轮追问 ---- */
  await panelFollowUp(ctx, B3_MARKERS.pdfF1, `第一轮追问：这一页与前页的论证关系是什么？（${B3_MARKERS.pdfF1}）`, answerTimeoutMs);
  await panelFollowUp(ctx, B3_MARKERS.pdfF2, `第二轮追问：如果只保留一个关键句，是哪句？（${B3_MARKERS.pdfF2}）`, answerTimeoutMs);
  lines.push(`pdf branch: 2 follow-up rounds landed (markers ${B3_MARKERS.pdfF1} / ${B3_MARKERS.pdfF2})`);
  await ctx.screenshot("b3-pdf-branch-panel");

  /* ---- 5) 跨枝隔离：回答不串枝（服务器事实 + 面板在场断言） ---- */
  {
    const mdView = await stateOfBranch(mdBranchId);
    const pdfView = await stateOfBranch(pdfBranchId);
    const mdText = mdView.turns.map((turn) => turn?.text ?? "").join("\n");
    const pdfText = pdfView.turns.map((turn) => turn?.text ?? "").join("\n");
    const problems = [];
    for (const marker of [B3_MARKERS.pdfQ1, B3_MARKERS.pdfF1, B3_MARKERS.pdfF2]) {
      if (mdText.includes(marker)) problems.push(`md branch carries the pdf marker ${marker}`);
    }
    for (const marker of [B3_MARKERS.mdQ1, B3_MARKERS.mdF1, B3_MARKERS.mdF2]) {
      if (pdfText.includes(marker)) problems.push(`pdf branch carries the md marker ${marker}`);
    }
    if (problems.length > 0) throw new Error(`B3 cross-branch isolation violated — ${problems.join("; ")}`);
    lines.push(
      `cross-branch isolation: md ${String(mdView.turns.length)} turns / pdf ${String(pdfView.turns.length)} turns, no marker leaks across (${modeNote})`,
    );
  }

  /* ---- 6) 重启续走：SIGTERM + 新进程 + 重载 → 历史可读 + 追问继续落地 ---- */
  /* 同端口重启（浏览器 localStorage 按源隔离——挂起意图/来源缓存同源存活；
     真实产品的服务重启即同端口）。 */
  const oldPort = ctx.studioPort();
  await ctx.stopStudio();
  await ctx.navigate("about:blank");
  const newUrl = await ctx.restartStudioSamePort();
  await ctx.navigate(newUrl);
  await waitFor(
    ctx,
    `(() => { const section = document.getElementById("materials-section"); ` +
      `return section !== null && !section.hidden && document.getElementById("material-list").children.length > 0; })()`,
    { label: "workbench reopened after the same-port restart (B3)" },
  );
  await openBranchPanelViaTab(ctx, mdBranchId);
  await waitFor(
    ctx,
    `(() => (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(B3_MARKERS.mdF2)}))()`,
    { label: "saved md exploration history readable after the restart" },
  );
  await panelFollowUp(ctx, B3_MARKERS.restartF, `重启后的续走追问：之前的结论还成立吗？（${B3_MARKERS.restartF}）`, answerTimeoutMs);
  lines.push(`restart continuation: SIGTERM → new process (port ${String(oldPort)}→${String(ctx.studioPort())}) → history readable + a fresh follow-up landed`);
  await ctx.screenshot("b3-restart-continuation");

  /* ---- 收尾：登记场景（Return 探针复用）+ 纪律 ---- */
  ctx.scenario.b3 = {
    ...ctx.scenario.b3,
    mdBranchId,
    pdfBranchId,
    markers: B3_MARKERS,
  };
  const excludedCount = assertNoPageErrors(ctx, {
    exclude: (entry) =>
      entry.text.includes(`http://127.0.0.1:${String(oldPort)}`) ||
      /* 本探针注入的传输层响应丢弃（Fetch.failRequest）——预期的副产物。 */
      (entry.text.includes("material-first-question") && entry.text.includes("ERR_CONNECTION_RESET")),
    label: "d4-branch-from-material",
  });
  await ctx.sidecar("branch-from-material", {
    check: "d4-branch-from-material",
    mode: ctx.MODE,
    modeNote,
    treeId,
    branches: { md: mdBranchId, pdf: pdfBranchId },
    markers: B3_MARKERS,
    selections: { md: b3.mdRange, pdf: b3.pdfRange },
    lines,
    pageErrorsExcluded: excludedCount,
  });
  return {
    detail:
      `armed md + pdf selections branched with the pre-submit material scope declaration (title/version/block/range/excerpt) visible; ` +
      `first questions landed (${ctx.MODE === "selftest" ? "echo driver — NOT B3 evidence" : "real Pi"}) with a real double-click producing exactly 1 ` +
      `dispatch (md) and a transport-layer dropped response retried honestly (pdf: same-key idempotent replay, exactly 1 user turn, replay note shown); ` +
      `2 follow-up rounds each; cross-branch isolation asserted on server facts; SIGTERM restart → new process → history readable + continuation follow-up landed`,
  };
}
