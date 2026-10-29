/** restore ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  loadB1Fixture,
} from "./fixtures.mjs";
import {
  inputClickAt,
  materialButtonSelector,
  sleep,
  waitFor,
} from "./input.mjs";
import {
  assertBlocksLossless,
  switchTreeInUi,
} from "./markdown-reader.mjs";
import {
  runUiSearch,
  searchProbeApi,
  searchProbeSafeBlockRange,
} from "./search.mjs";
import {
  assertNoPageErrors,
  pageReaderLoadedExpr,
  pageSelectCanonical,
  resolveSelectionAndAssert,
  waitForArmedBar,
} from "./selection.mjs";
import {
  mkdtempSync,
  renameSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 探针 7：d4-export-restore-recover（B5 数据可携带浏览器面）              */
/* ------------------------------------------------------------------ */

/**
 * B5 恢复组合路径（D4-5 CLI + 真实浏览器）：
 *   事实建立（材料 + 材料 Branch + echo 首问 + 批注 + Return + 主线
 *   turn，全部真实 API）→ studio 进程优雅停止 → `apps/studio export
 *   --out`（charter §5 缺省不含 session）→ `--import-package` 恢复到
 *   全新空数据目录 → 在恢复目录上启动全新 studio 进程 → 真实浏览器里：
 *   重开材料阅读（与冻结真值逐字无损 + resolve-selection sourceHash
 *   复核）、侧栏 Search 找回复原事实（主线 turn / Return / 材料三类
 *   命中 → 来源跳转；支线命中行如实携带 session-unavailable 注记 +
 *   显式换轨入口）、session 未随包存活分支经 D4-3 恢复流打开面板
 *   （alignCursor:false——不重放注定失败的 /switch；续聊发送
 *   fail-closed + 常驻恢复注记）→ 显式「Start new exploration」换轨
 *   （confirm 二次确认经 CDP 接受）→ 新探索首问落地、session 恢复
 *   可用、旧历史保持可读。
 *
 * 注入的故障（如实入证，见 sidecar injectedFaults）：导出后将原数据目录
 * 的 sessions/ 移开——同机上模拟「包未携带 session（charter §5 缺省）→
 * 换机后 session 文件不存在」；恢复进程对引用路径的实时存在性探针由此
 * 如实报告 unavailable。探针结束时移回（原目录保持原样）。
 */
export const B5_MARKERS = {
  question: "TreeAI-B5-恢复探针-首问-3e77",
  annotation: "TreeAI-B5-恢复探针-批注-8c14",
  ret: "TreeAI-B5-恢复探针-RETURN-52a9",
  trunkTurn: "TreeAI-B5-恢复探针-主线-e5a1",
  newExploration: "TreeAI-B5-恢复探针-新探索-d40f",
};

/** 侧栏命中行点击（真实 DOM click 事件——与既有搜索探针同一管线）。 */
export async function clickSearchHitRow(ctx, kindLabel) {
  const clicked = await ctx.evalJs(
    `(() => { const hit = [...document.querySelectorAll("#search-results button.search-hit")]` +
      `.find((b) => b.querySelector(".search-hit-kind") !== null && b.querySelector(".search-hit-kind").textContent === ${JSON.stringify(kindLabel)}); ` +
      `if (hit === undefined) return false; hit.click(); return true; })()`,
  );
  if (clicked !== true) throw new Error(`no ${kindLabel} search-hit row found to click`);
  return true;
}

export async function probeExportRestoreRecover(ctx) {
  const treeId = ctx.scenario.treeId;
  const materials = ctx.scenario.materials;
  if (treeId === null || materials === null || materials["md-01"] === undefined) {
    throw new ctx.NotRunError("md-01 未导入就位（见 d4-import-material 的结果）——导出/恢复探针级联跳过");
  }
  const md01 = loadB1Fixture(ctx.ROOT, "md-01");
  const entry = materials["md-01"];
  if (entry.truth === undefined) entry.truth = md01.truth;
  const b5Range = searchProbeSafeBlockRange(md01.truth);

  /* 1) 事实建立（幂等：scenario.b5BranchId 在即对账复用）。 */
  let branchId = ctx.scenario.b5BranchId ?? null;
  if (branchId === null) {
    const resolved = await searchProbeApi(
      ctx, "POST",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(entry.materialId)}/versions/${encodeURIComponent(entry.versionId)}/resolve-selection`,
      { locator: { kind: "utf16-range", start: b5Range.start, end: b5Range.end }, excerpt: b5Range.excerpt, blockId: b5Range.blockId },
      "B5 resolve-selection (md-01 first block)",
    );
    const selection = resolved.body?.selection ?? null;
    if (selection === null) throw new Error(`B5 resolve-selection returned no canonical selection: ${JSON.stringify(resolved.body)}`);
    const intentKey = "browser-b5-restore-probe";
    /* mode "new"（显式另开）：同一 md-01 首块选区上已有搜索探针的探索
       （resume-or-create 会恢复它而不绑定本探针的 intentKey——首问对账
       会 400）；B5 需要自己的分支与提交键。 */
    const branchRes = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`, { selection, intentKey, mode: "new" }, 30_000);
    if (branchRes.status !== 200 && branchRes.status !== 201) {
      throw new Error(`B5 from-material HTTP ${String(branchRes.status)}: ${JSON.stringify(branchRes.body)}`);
    }
    if (branchRes.body?.mode !== "created" || branchRes.body?.created !== true) {
      throw new Error(`B5 from-material did not create a dedicated branch (mode=${JSON.stringify(branchRes.body?.mode)}): ${JSON.stringify(branchRes.body)}`);
    }
    branchId = branchRes.body?.branch?.id ?? null;
    if (branchId === null) throw new Error(`B5 from-material returned no branch: ${JSON.stringify(branchRes.body)}`);

    const fq = await ctx.api(
      "POST",
      `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
      { intentKey, firstQuestion: `请基于这段选区说明它在该材料结构中的作用。（${B5_MARKERS.question}）` },
      60_000,
    );
    if (fq.status !== 200 || fq.body?.dispatch !== "succeeded") {
      throw new Error(`B5 material-first-question HTTP ${String(fq.status)} dispatch ${String(fq.body?.dispatch)}: ${JSON.stringify(fq.body?.error ?? null)}`);
    }
    const anchorTurnId = fq.body?.landed?.assistantTurnId ?? null;
    if (anchorTurnId === null) throw new Error(`B5 first question landed no assistant turn: ${JSON.stringify(fq.body)}`);
    const answerText = fq.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof answerText !== "string" || answerText.length === 0) {
      throw new Error("B5 first question outcome carries no assistant text");
    }
    let annoEnd = Math.min(12, answerText.length);
    while (annoEnd > 0 && (answerText.charCodeAt(annoEnd - 1) & 0xfc00) === 0xd800) annoEnd -= 1;
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/terminology/annotations`, {
      branchId, anchorTurnId,
      selection: { start: 0, end: annoEnd, text: answerText.slice(0, annoEnd) },
      mode: "range",
      term: "B5恢复探针术语",
      explanation: `B5 恢复探针创建的批注解释（${B5_MARKERS.annotation}），用于恢复后找回验证。`,
    }, "B5 annotation save");
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/material-return`, {
      fromBranchId: branchId,
      text: `B5 恢复探针的 Return：材料探索的收获记录（${B5_MARKERS.ret}）。`,
      idempotencyKey: "browser-b5-restore-return-1",
    }, "B5 material-return");
    ctx.scenario.b5BranchId = branchId;
  }

  const stateOf = async () => {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    if (res.status !== 200) throw new Error(`B5 /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const branchViewIn = (state, id) => (state?.branches ?? []).find((view) => view?.branch?.id === id) ?? null;

  /* 主线事实（真实 prompt API——恢复后「来源跳转不受 session 影响」的主线
     命中语料；主线命中不开支线面板，跳转纯只读定位）。 */
  if (ctx.scenario.b5TrunkTurn !== true) {
    const state0 = await stateOf();
    const trunkBranchId = state0?.trunkBranchId ?? null;
    if (typeof trunkBranchId !== "string") throw new Error("B5: no trunk branch in the scenario tree state");
    const promptRes = await ctx.api(
      "POST",
      `/api/trees/${encodeURIComponent(treeId)}/prompt`,
      { branchId: trunkBranchId, text: `主线记录：材料阅读的阶段性结论（${B5_MARKERS.trunkTurn}）。` },
      60_000,
    );
    if (promptRes.status !== 200) {
      throw new Error(`B5 trunk prompt HTTP ${String(promptRes.status)}: ${JSON.stringify(promptRes.body)}`);
    }
    const assistantText = promptRes.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof assistantText !== "string" || assistantText.length === 0) {
      throw new Error("B5 trunk prompt outcome carries no assistant text (echo driver must answer)");
    }
    ctx.scenario.b5TrunkTurn = true;
    ctx.scenario.b5TrunkBranchId = trunkBranchId;
  }

  /* 2) 导出前事实核验：该分支 session 在原进程上可用（后续不可用是恢复语义，不是本来就坏）。 */
  const before = branchViewIn(await stateOf(), branchId);
  if (before === null || before.sessionAvailability !== "available") {
    throw new Error(`B5 branch must have an available session before export (got ${JSON.stringify(before?.sessionAvailability ?? null)})`);
  }
  const turnsBefore = before.turns.length;

  /* 3) 停 studio（优雅）→ CLI 导出 → CLI 恢复到全新空数据目录。 */
  const oldPort = ctx.studioPort();
  await ctx.stopStudio();
  await ctx.navigate("about:blank");
  const pkgDir = mkdtempSync(join(tmpdir(), "treeai-d4-b5-pkg-"));
  const restoredDir = mkdtempSync(join(tmpdir(), "treeai-d4-b5-restored-"));
  const dataDir = ctx.studioDataDir();
  const sessionsDir = join(dataDir, "sessions");
  const sessionsAside = join(dataDir, "sessions.aside-b5");
  let sessionsMoved = false;
  try {
    const exportRun = await ctx.runStudioCli(["export", "--out", pkgDir, "--data", dataDir], 180_000);
    if (exportRun.code !== 0 || !exportRun.stdout.includes("package written to")) {
      throw new Error(`B5 export CLI failed (exit ${String(exportRun.code)}): ${exportRun.stdout}\n${exportRun.stderr}`);
    }
    if (!exportRun.stdout.includes("sessions excluded by default")) {
      throw new Error(`B5 export CLI did not state the sessions-excluded default: ${exportRun.stdout}`);
    }
    const restoreRun = await ctx.runStudioCli(["--import-package", pkgDir, "--data", restoredDir], 180_000);
    if (restoreRun.code !== 0 || !restoreRun.stdout.includes("restored into")) {
      throw new Error(`B5 restore CLI failed (exit ${String(restoreRun.code)}): ${restoreRun.stdout}\n${restoreRun.stderr}`);
    }
    if (!restoreRun.stdout.includes("no Pi sessions in the package")) {
      throw new Error(`B5 restore CLI did not state the no-sessions honesty line: ${restoreRun.stdout}`);
    }

    /* 4) 注入的故障：原数据目录 sessions/ 移开（同机模拟换机后文件缺失；
          包缺省不含 session 是产品事实，这里只消除同机的残留路径）。 */
    renameSync(sessionsDir, sessionsAside);
    sessionsMoved = true;

    /* 5) 恢复目录上启动全新 studio 进程。 */
    const newUrl = await ctx.bootStudioOn(restoredDir);
    await ctx.navigate(newUrl);
    await waitFor(ctx, `(() => document.querySelectorAll("#tree-list button").length > 0)()`, { label: "restored workbench tree list" });
    await switchTreeInUi(ctx, treeId);

    /* 6) 服务端事实：恢复进程上该分支 session 不可用 + 旧 turns 完整可读。 */
    const stateAfter = await stateOf();
    const after = branchViewIn(stateAfter, branchId);
    if (after === null) throw new Error("B5 branch missing from the restored process state");
    if (after.sessionAvailability !== "unavailable") {
      throw new Error(`B5 branch session must be unavailable on the restored process (got ${JSON.stringify(after.sessionAvailability)})`);
    }
    if (after.turns.length !== turnsBefore) {
      throw new Error(`B5 restored branch turns ${String(after.turns.length)} ≠ saved ${String(turnsBefore)} (saved history must stay readable)`);
    }
    if (!after.turns.some((turn) => typeof turn?.text === "string" && turn.text.includes(B5_MARKERS.question))) {
      throw new Error("B5 restored branch turns do not carry the saved first-question marker");
    }

    /* 7) 恢复材料阅读：真实侧栏点击 → 逐字无损 + resolve-selection sourceHash。 */
    await inputClickAt(ctx, materialButtonSelector(entry.materialId));
    await waitFor(ctx, pageReaderLoadedExpr(md01.truth.blocks.length, "end"), { label: "restored md-01 reader (14 blocks)", timeoutMs: 25_000 });
    await assertBlocksLossless(ctx, md01.truth, { expectedCount: md01.truth.blocks.length, label: "restored md-01" });
    await resolveSelectionAndAssert(ctx, {
      treeId, material: entry,
      expected: { blockId: b5Range.blockId, start: b5Range.start, end: b5Range.end, excerpt: b5Range.excerpt },
      canonicalText: md01.truth.canonicalText,
      caseId: "b5-restored-resolve-selection",
    });
    await ctx.screenshot("restore-reader");

    /* 8) 侧栏 Search 找回复原事实（真实 UI）。
       主线 turn / Return / 材料 三类命中的来源跳转（主线与 Return 命中不
       开支线面板——纯只读定位，不受 session 影响）；支线 turn 命中行如实
       携带 session-unavailable 注记 + 显式换轨入口（点击该类命中开面板的
       路径当前被 /switch 对缺失 session 的 502 拦截——本波报告的产品缺
       陷，见证据记录；面板打开走 9) 的 D4-3 恢复流）。 */
    const trunkHits = await runUiSearch(ctx, B5_MARKERS.trunkTurn, "tree");
    if (trunkHits.rows.find((row) => row.kind === "对话") === null) {
      throw new Error(`B5 restored trunk turn not found via the sidebar Search (status=${JSON.stringify(trunkHits.status)}, rows=${JSON.stringify(trunkHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "对话");
    await waitFor(
      ctx,
      `(() => { const conv = document.getElementById("conversation"); ` +
        `return conv !== null && (conv.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.trunkTurn)}); })()`,
      { label: "trunk turn hit jump reveals the restored turn in the main conversation", timeoutMs: 20_000 },
    );

    const retHits = await runUiSearch(ctx, B5_MARKERS.ret, "tree");
    if (retHits.rows.find((row) => row.kind === "Return") === null) {
      throw new Error(`B5 restored return not found via the sidebar Search (rows=${JSON.stringify(retHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "Return");
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.ret)}))()`,
      { label: "return hit jump reveals the restored return card", timeoutMs: 20_000 },
    );

    const turnHits = await runUiSearch(ctx, B5_MARKERS.question, "tree");
    const turnRowIndex = turnHits.rows.findIndex((row) => row.kind === "对话");
    if (turnRowIndex < 0) {
      throw new Error(`B5 restored side-branch turn not found via the sidebar Search (rows=${JSON.stringify(turnHits.rows.slice(0, 3))})`);
    }
    const sessionNote = await ctx.evalJs(
      `(() => { const rows = [...document.querySelectorAll("#search-results li")]; ` +
        `const row = rows[${String(turnRowIndex)}]; if (row === undefined) return null; ` +
        `const note = row.querySelector(".search-hit-session"); const explore = row.querySelector(".search-hit-explore"); ` +
        `return { note: note === null ? null : note.textContent, explore: explore === null ? null : explore.textContent }; })()`,
    );
    if (sessionNote?.note === null || !(sessionNote.note ?? "").includes("session unavailable on this branch")) {
      throw new Error(`B5 side-branch turn hit must carry the session-unavailable note (got ${JSON.stringify(sessionNote)})`);
    }
    if (sessionNote?.explore === null || !(sessionNote.explore ?? "").includes("新探索")) {
      throw new Error(`B5 side-branch turn hit must carry the explicit new-exploration entry (got ${JSON.stringify(sessionNote)})`);
    }

    const annoHits = await runUiSearch(ctx, B5_MARKERS.annotation, "tree");
    if (annoHits.rows.find((row) => row.kind === "批注") === null) {
      throw new Error(`B5 restored annotation not found via the sidebar Search (rows=${JSON.stringify(annoHits.rows.slice(0, 3))})`);
    }

    const materialHits = await runUiSearch(ctx, b5Range.excerpt, "tree");
    if (materialHits.rows.find((row) => row.kind === "材料") === null) {
      throw new Error(`B5 restored material not found via the sidebar Search for its canonical first-block phrase (rows=${JSON.stringify(materialHits.rows.slice(0, 3))})`);
    }
    await clickSearchHitRow(ctx, "材料");
    await waitFor(
      ctx,
      `(() => { const reader = document.getElementById("material-reader"); ` +
        `return reader !== null && !reader.hidden && (reader.textContent ?? "").includes(${JSON.stringify(b5Range.excerpt)}); })()`,
      { label: "material hit jump opens the restored reader at the hit", timeoutMs: 20_000 },
    );
    await ctx.screenshot("restore-facts-recovered");

    /* 9) session 未存活分支的面板打开（D4-3 材料建枝/恢复流——真实 UI 且
          对齐失败如实分离的路径）：阅读器内重建同一选区 → 捕获条 →
          「⑃ 展开支线」→ 恢复二选（既有探索 + session 不可用
          注记）→「↩ 继续已有支线」→ 面板以
          alignCursor:false 打开（不重放注定失败的 /switch）。 */
    const placed = await ctx.evalJs(pageSelectCanonical(b5Range.blockId, b5Range.start, b5Range.end));
    if (placed === null || placed.error !== undefined) {
      throw new Error(`B5 branching-flow selection could not be placed — ${JSON.stringify(placed)}`);
    }
    const armedBar = await waitForArmedBar(ctx, "B5 branching-flow selection", 4000);
    if (armedBar.payload === null) throw new Error(`B5 branching-flow bar did not arm with a payload: ${JSON.stringify(armedBar)}`);
    /* DOM click（与复制按钮同款管线——CDP 输入点击的 press/release 分段会
       让 0ms 解除路径抢在 release 之前，见既有注释）。 */
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#mat-selection-bar .mat-branch-d43"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    const choice = await waitFor(
      ctx,
      `(() => { const flow = document.getElementById("mat-branch-flow"); ` +
        `if (flow === null) return false; const text = flow.textContent ?? ""; ` +
        `return text.includes("继续已有支线") ? { text } : false; })()`,
      { label: "branching flow reaches the restore-vs-new choice (existing exploration found)", timeoutMs: 15_000 },
    );
    if (!(choice.text ?? "").includes("原会话暂时不可用")) {
      throw new Error(`B5 choice card must state the session-unavailable honesty note (got ${JSON.stringify(choice.text)})`);
    }
    await ctx.evalJs(
      `(() => { const btn = document.querySelector("#mat-branch-flow .mat-branch-resume"); ` +
        `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    /* 阅读器是支线列的覆盖层（z-index 高于面板）且退出有 170ms 动画——
       必须等它完全 hidden 后才能与面板交互（真实用户节奏；否则输入点击
       落在仍可见的阅读器上）。 */
    await waitFor(
      ctx,
      `(() => { const r = document.getElementById("material-reader"); return r !== null && r.hidden === true; })()`,
      { label: "material reader exit animation settled (overlay gone)", timeoutMs: 5_000 },
    );
    await waitFor(
      ctx,
      `(() => { const panel = document.getElementById("branch-panel"); ` +
        `return panel !== null && !panel.hidden && (panel.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.question)}); })()`,
      { label: "resume opens the restored branch panel with the saved turn (no /switch replay)", timeoutMs: 15_000 },
    );
    /* session-unavailable 如实呈现：常驻降级注记 + 显式换轨入口可见可用 +
       续聊发送 fail-closed。 */
    const unavailableUi = await waitFor(
      ctx,
      `(() => { const note = document.getElementById("panel-session-note"); const btn = document.getElementById("panel-new-exploration"); ` +
        `const send = document.getElementById("panel-send"); ` +
        `if (note === null || btn === null || note.hidden || btn.hidden || btn.disabled) return false; ` +
        `return { note: note.textContent, btn: btn.textContent, sendDisabled: send === null ? null : send.disabled === true }; })()`,
      { label: "session-unavailable note + explicit new-exploration entry + fail-closed send", timeoutMs: 10_000 },
    );
    if (!(unavailableUi.note ?? "").includes("Session missing on this branch")) {
      throw new Error(`B5 session-unavailable note text mismatch: ${JSON.stringify(unavailableUi.note)}`);
    }
    if (unavailableUi.sendDisabled !== true) {
      throw new Error("B5 panel send must stay fail-closed while the session is unavailable");
    }
    await ctx.screenshot("restore-session-unavailable");

    /* 10) 显式新探索（面板 composer 的换轨入口，confirm 经 CDP 接受）。 */
    let dialogsSeen = 0;
    ctx.cdpOn("Page.javascriptDialogOpening", () => {
      dialogsSeen += 1;
      void ctx.cdpSend("Page.handleJavaScriptDialog", { accept: true }).catch(() => { /* 尽力而为 */ });
    });
    await inputClickAt(ctx, "#panel-prompt-input");
    await ctx.cdpSend("Input.insertText", { text: `新探索的第一问：请重新概括这段选区的内容要点。（${B5_MARKERS.newExploration}）` });
    const typed = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
    if (typeof typed !== "string" || !typed.includes(B5_MARKERS.newExploration)) {
      throw new Error(`B5 panel composer did not receive the typed first question (got ${JSON.stringify(typed)})`);
    }
    await inputClickAt(ctx, "#panel-new-exploration");
    /* 落地轮询（失败时快照 UI 状态入错——不吞真因）。 */
    const markerLandedExpr = `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.newExploration)}))()`;
    {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if ((await ctx.evalJs(markerLandedExpr)) === true) break;
        if (Date.now() >= deadline) {
          const snap = await ctx.evalJs(
            `(() => ({ inputValue: document.getElementById("panel-prompt-input").value, ` +
              `btnHidden: document.getElementById("panel-new-exploration").hidden, ` +
              `btnDisabled: document.getElementById("panel-new-exploration").disabled, ` +
              `noteHidden: document.getElementById("panel-session-note").hidden, ` +
              `panelError: (document.getElementById("panel-error-banner") === null ? null : document.getElementById("panel-error-banner").textContent ?? "").slice(0, 300), ` +
              `mainError: (document.getElementById("error-banner") === null ? null : document.getElementById("error-banner").textContent ?? "").slice(0, 300) }))()`,
          );
          throw new Error(
            `B5 new-exploration first question did not land in 30s (confirm dialogs seen: ${String(dialogsSeen)}); UI snapshot: ${JSON.stringify(snap)}`,
          );
        }
        await sleep(200);
      }
    }
    /* 收尾态：输入清空、session 注记/换轨入口随新 session 下线、旧历史仍可读。 */
    await waitFor(
      ctx,
      `(() => { const input = document.getElementById("panel-prompt-input"); ` +
        `return input !== null && input.value === ""; })()`,
      { label: "panel composer cleared after the new exploration", timeoutMs: 10_000 },
    );
    await waitFor(
      ctx,
      `(() => { const note = document.getElementById("panel-session-note"); const btn = document.getElementById("panel-new-exploration"); ` +
        `return note !== null && note.hidden === true && btn !== null && btn.hidden === true; })()`,
      { label: "session recovered after the explicit new exploration", timeoutMs: 10_000 },
    );
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(B5_MARKERS.question)}))()`,
      { label: "the old saved history stays readable after the new exploration", timeoutMs: 10_000 },
    );
    const afterExplore = branchViewIn(await stateOf(), branchId);
    if (afterExplore.sessionAvailability !== "available") {
      throw new Error(`B5 branch session must be available after the explicit new exploration (got ${JSON.stringify(afterExplore.sessionAvailability)})`);
    }
    const assistantTurns = afterExplore.turns.filter((turn) => turn?.role === "assistant");
    if (assistantTurns.length === 0 || typeof assistantTurns[assistantTurns.length - 1].text !== "string" || assistantTurns[assistantTurns.length - 1].text.length === 0) {
      throw new Error("B5 new exploration landed no assistant answer (echo driver must answer)");
    }
    await ctx.screenshot("restore-new-exploration");

    /* 11) console 纪律：旧端口的连接拒绝（停进程窗口内页面 SSE 重连）是本探针
           主动注入的预期现象；其余错误一概失败。 */
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (e) => e.text.includes(`http://127.0.0.1:${String(oldPort)}`),
      label: "d4-export-restore-recover",
    });
    await ctx.sidecar("export-restore-recover", {
      check: "d4-export-restore-recover",
      treeId,
      branchId,
      markers: B5_MARKERS,
      facts: {
        material: entry.title,
        savedBranchTurns: turnsBefore,
        restoredBranchTurns: after.turns.length,
        turnsAfterNewExploration: afterExplore.turns.length,
      },
      export: { cli: "apps/studio export --out", packageDir: "<tmp>", sessionsExcluded: true },
      restore: { cli: "--import-package", dataDir: "<tmp>" },
      restart: { oldPort, newPort: ctx.studioPort(), restoredDataDir: "<tmp>" },
      injectedFaults: [
        "original data dir sessions/ renamed aside after export (same-machine stand-in for the charter §5 default: the package carries no sessions, so on any other machine the referenced file does not exist); renamed back at probe end",
      ],
      searchRecovery: {
        jumpsExercised: ["trunk turn → main conversation", "return → trunk Return card", "material → restored reader at the hit"],
        sideBranchHitRows: "carry the session-unavailable note + explicit new-exploration entry (rows not clicked: the search-hit panel-open path replays POST /switch, which the real server rejects 502 session-corrupt for a missing session file — reported to the owner, not fixed in this wave)",
      },
      sessionPath: { before: "available", afterRestore: "unavailable", afterNewExploration: "available" },
      pageErrorsExcluded: excludedCount,
    });
    return {
      detail:
        `facts (material + material branch + echo first-question + annotation + return + trunk turn) exported via the D4-5 CLI ` +
        `(sessions excluded by default) → restored into an empty data dir → new studio process → real browser: ` +
        `restored md-01 byte-equal to the frozen truth (resolve-selection sourceHash re-verified), sidebar Search recovered ` +
        `trunk-turn/return/material facts with source jumps and showed the session-unavailable note + explicit entry on the ` +
        `side-branch hit rows; the D4-3 resume flow opened the session-less branch panel (alignCursor:false, no /switch replay) with ` +
        `the fail-closed composer and recovery note, and the explicit new exploration landed a fresh session ` +
        `(${String(turnsBefore)} old turns + new pair readable, composer cleared)`,
    };
  } finally {
    if (sessionsMoved) {
      try { renameSync(sessionsAside, sessionsDir); } catch { /* 尽力而为 */ }
    }
  }
}
