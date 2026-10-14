/** restart ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  countMaterialsViaApi,
} from "./fixture-api.mjs";
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
  assertNoPageErrors,
  pageReaderLoadedExpr,
  pageReaderRestoredExpr,
  pageTopAlignBlock,
} from "./selection.mjs";

/* ------------------------------------------------------------------ */
/* 探针 3：d4-restart-continue                                           */
/* ------------------------------------------------------------------ */

export async function waitForReadingPosition(ctx, treeId, material, blockId) {
  const deadline = Date.now() + 6000;
  for (;;) {
    const res = await ctx.api(
      "GET",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(material.materialId)}/reading-position`,
    );
    const pos = res.body?.readingPosition ?? null;
    if (res.status === 200 && pos !== null && pos.blockId === blockId) {
      if (pos.versionId !== material.versionId) {
        throw new Error(`saved reading position versionId ${String(pos.versionId)} ≠ ${String(material.versionId)}`);
      }
      if (pos.focusStart !== null) {
        throw new Error(`saved reading position focusStart ${String(pos.focusStart)} ≠ null`);
      }
      return pos;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the reader's reading-position save did not land on ${blockId} (last seen: ${JSON.stringify(pos)})`);
    }
    await sleep(150);
  }
}

export async function probeRestartContinue(ctx) {
  const materials = ctx.scenario.materials;
  if (materials === null || materials["md-11"] === undefined || ctx.scenario.treeId === null) {
    throw new ctx.NotRunError("md-11 未导入就位（见 d4-import-material 的结果）——重启续读探针级联跳过");
  }
  const treeId = ctx.scenario.treeId;
  const md11 = loadB1Fixture(ctx.ROOT, "md-11");
  const entry = materials["md-11"];
  const totalBlocks = md11.truth.blocks.length; // 59
  const RESTORE_BLOCK = "blk-52";

  /* 1) 阅读器就位于 md-11 且第二页已载（幂等：已在读则聚焦不重载）。 */
  const state = await ctx.evalJs(
    `(() => { const reader = document.getElementById("material-reader"); ` +
      `const blocks = document.querySelectorAll("#mat-blocks .material-block").length; ` +
      `return { open: reader !== null && !reader.hidden, blocks: blocks }; })()`,
  );
  if (!(state !== null && state.open === true && state.blocks === totalBlocks)) {
    await inputClickAt(ctx, materialButtonSelector(entry.materialId));
    await waitFor(ctx, pageReaderLoadedExpr(50, "more"), { label: "md-11 reader first page", timeoutMs: 20_000 });
    await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
    await waitFor(ctx, pageReaderLoadedExpr(totalBlocks, "end"), { label: "md-11 second page", timeoutMs: 15_000 });
  }

  /* 2) 真实滚动：blk-52 顶部对齐（scroll 事件驱动应用自身路径）。 */
  const scrolled = await ctx.evalJs(pageTopAlignBlock(RESTORE_BLOCK));
  if (scrolled === null || scrolled.error !== undefined) {
    throw new Error(`could not top-align ${RESTORE_BLOCK} — ${JSON.stringify(scrolled)}`);
  }
  if (Math.abs(scrolled.diff) > 2) {
    throw new Error(`scroll to ${RESTORE_BLOCK} did not align (Δ${String(scrolled.diff)}px)`);
  }
  await sleep(250);

  /* 3) 阅读器自身的关闭按钮（真实输入点击）→ 立即冲刷阅读位置保存。 */
  await inputClickAt(ctx, "#mat-close");
  await waitFor(
    ctx,
    `(() => { const reader = document.getElementById("material-reader"); return reader !== null && reader.hidden; })()`,
    { label: "material reader closed" },
  );

  /* 4) 应用自己的保存路径已 PUT——经真实后端读回验证。 */
  const saved = await waitForReadingPosition(ctx, treeId, entry, RESTORE_BLOCK);

  /* 5) 停止 studio 进程（SIGTERM 优雅退出；超时 SIGKILL 兜底）。 */
  const oldPort = ctx.studioPort();
  await ctx.stopStudio();
  await ctx.navigate("about:blank"); /* 立即切断页面到旧进程的 SSE */

  /* 6) 同数据目录启动全新 studio 进程（新端口）。 */
  const newUrl = await ctx.restartStudio();
  await ctx.navigate(newUrl);
  /* 材料数按 API 实况（后续探针可在场景树追加材料——B3 探针的 pdf-01）。 */
  const expectedMaterials = await countMaterialsViaApi(ctx, treeId);
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(expectedMaterials)} ? true : false; })()`,
    { label: "materials list after restart" },
  );

  /* 7) 重开 md-11（真实 UI）：向前补页到保存块、恢复注记落位。 */
  await inputClickAt(ctx, materialButtonSelector(entry.materialId));
  const restored = await waitFor(ctx, pageReaderRestoredExpr(RESTORE_BLOCK, totalBlocks), {
    label: `reading position restored to ${RESTORE_BLOCK}`,
    timeoutMs: 25_000,
  });
  /* 视觉对齐硬断言（≤2px 容差——亚像素取整）：app.js 即时落位 + 渲染保位
     修复的回归锁。 */
  if (restored.diff > 2) {
    throw new Error(
      `restore scroll misaligned: #mat-blocks scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)} (diff ${String(restored.diff)}px)`,
    );
  }
  /* 持久化行的跨进程复核（新进程读回保存行——重启续读的服务端事实）。 */
  const persisted = await waitForReadingPosition(ctx, treeId, entry, RESTORE_BLOCK);
  await ctx.screenshot("restart-restored");

  /* 8) console 纪律：旧端口的连接拒绝（杀进程窗口内页面的 SSE 重连）是
        本探针主动注入的预期现象；其余错误一概失败。 */
  const excludedCount = assertNoPageErrors(ctx, {
    exclude: (e) => e.text.includes(`http://127.0.0.1:${String(oldPort)}`),
    label: "d4-restart-continue",
  });
  await ctx.sidecar("restart-continue", {
    check: "d4-restart-continue",
    treeId,
    material: entry.title,
    savedPosition: { versionId: saved.versionId, blockId: saved.blockId, focusStart: saved.focusStart, updatedAt: saved.updatedAt },
    persistedAcrossRestart: { versionId: persisted.versionId, blockId: persisted.blockId },
    restart: { oldPort, newPort: ctx.studioPort(), dataDirKept: true },
    restored: { blockId: RESTORE_BLOCK, blocks: restored.blocks, note: true, scroll: { scrollTop: restored.scrollTop, blockTop: restored.blockTop, diffPx: restored.diff } },
    pageErrorsExcluded: excludedCount,
  });
  return {
    detail:
      `reading position saved at ${RESTORE_BLOCK} via the reader's own save path (close-button flush) → ` +
      `studio SIGTERM → new process on the same data dir → reopened with the restore note and ${RESTORE_BLOCK} ` +
      `loaded (${String(restored.blocks)} blocks after forward paging; persisted row verified on the new process; ` +
      `visual scroll alignment asserted ≤2px: scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)})`,
  };
}
