/** selection-probe ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  countMaterialsViaApi,
  loadB1Registries,
  loadB1RegistryFixture,
} from "./fixture-api.mjs";
import {
  FIXTURE_IDS,
  loadB2InvalidSelections,
  loadB2PdfSelections,
  loadB2Selections,
} from "./fixtures.mjs";
import {
  importMaterialViaHttp,
  waitForVersionReady,
} from "./import-api.mjs";
import {
  inputClickAt,
  materialButtonSelector,
  waitFor,
} from "./input.mjs";
import {
  assertBlocksLossless,
  assertReaderChrome,
  openMaterialInReader,
  switchTreeInUi,
} from "./markdown-reader.mjs";
import {
  assertPdfReaderChrome,
  capturePdfFrozenSelection,
  ensurePdfPageRendered,
  MATERIAL_FETCH_BLOCK_STEP,
  pageSelectCrossPagePdf,
  PDF_FETCH_PAGE_STEP,
  pdfReaderLoadedExpr,
} from "./pdf-reader.mjs";
import {
  assertBarPayload,
  assertNoPageErrors,
  captureFrozenSelection,
  mouseDragFrozenSelection,
  mouseSelectFrozenSelection,
  pageReaderLoadedExpr,
  pageSelectCanonical,
  pageSelectCrossBlock,
  waitForArmedBar,
} from "./selection.mjs";

/* ------------------------------------------------------------------ */
/* 探针 2：d4-read-and-select                                            */
/* ------------------------------------------------------------------ */

export async function probeReadAndSelect(ctx) {
  const materials = ctx.scenario.materials;
  if (materials === null || FIXTURE_IDS.some((id) => materials[id] === undefined)) {
    throw new ctx.NotRunError("材料未全部导入就位（见 d4-import-material 的结果）——阅读/选区探针级联跳过");
  }
  const treeId = ctx.scenario.treeId;
  const selections = loadB2Selections(ctx.ROOT);
  const pdfSelections = loadB2PdfSelections(ctx.ROOT);
  const invalidCrossPageItems = loadB2InvalidSelections(ctx.ROOT).filter((item) => item.category === "cross-page");
  const registries = loadB1Registries(ctx.ROOT);
  const mdRegistry = registries.find((registry) => registry.kind === "markdown") ?? null;
  const pdfRegistry = registries.find((registry) => registry.kind === "pdf") ?? null;
  if (mdRegistry === null || pdfRegistry === null) {
    throw new Error("B1 registries incomplete: need both md-registry.json and pdf-registry.json");
  }
  ctx.noteFixturesUsed([
    ...mdRegistry.fixtures.map((entry) => entry.fixtureId),
    ...pdfRegistry.fixtures.map((entry) => entry.fixtureId),
  ]);

  /* ---- 全分母就位（issue #8 B2 验收：冻结选区分母必须铺满，绝不静默缩分母）：
          导入探针只铺 md-01/06/11——这里按需补齐其余 markdown 与全部 PDF
          fixture（与 B3 探针同款按需导入纪律；后续探针按 API 实况容忍追加）。 ---- */
  const fixtureTruth = new Map();
  let importedAny = false;
  for (const { name, kind, fixtures } of [
    { name: "md-registry.json", kind: "markdown", fixtures: mdRegistry.fixtures },
    { name: "pdf-registry.json", kind: "pdf", fixtures: pdfRegistry.fixtures },
  ]) {
    for (const entry of fixtures) {
      const fixture = loadB1RegistryFixture(ctx.ROOT, entry, name);
      fixtureTruth.set(fixture.fixtureId, fixture.truth);
      if (materials[fixture.fixtureId] !== undefined) continue;
      const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes, 30_000);
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`${fixture.fixtureId}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
      }
      const ready = await waitForVersionReady(ctx, treeId, res.body.material.id, res.body.version.id, fixture.fixtureId);
      if (ready.parserKind !== kind) {
        throw new Error(`${fixture.fixtureId}: parserKind ${String(ready.parserKind)} ≠ ${kind}`);
      }
      if (ready.parserVersion !== fixture.truth.normalizer) {
        throw new Error(`${fixture.fixtureId}: parserVersion ${String(ready.parserVersion)} ≠ frozen ${String(fixture.truth.normalizer)}`);
      }
      if (ready.textUnits !== fixture.expectedUnits) {
        throw new Error(`${fixture.fixtureId}: server textUnits ${String(ready.textUnits)} ≠ frozen ${String(fixture.expectedUnits)}`);
      }
      materials[fixture.fixtureId] = {
        fixtureId: fixture.fixtureId,
        materialId: res.body.material.id,
        versionId: res.body.version.id,
        title: res.body.material.title,
        textUnits: ready.textUnits,
      };
      importedAny = true;
    }
  }
  ctx.scenario.materials = materials;
  if (importedAny) {
    /* API 导入后真实导航刷新（应用自身重拉材料列表——与导入/B3 探针同款纪律）。 */
    await ctx.navigate(ctx.studioUrl());
    await waitFor(
      ctx,
      `(() => document.querySelector("#tree-list button.active") !== null)()`,
      { label: "active tree row after reload", timeoutMs: 15_000 },
    );
    await switchTreeInUi(ctx, treeId);
    const expectedCount = await countMaterialsViaApi(ctx, treeId);
    await waitFor(
      ctx,
      `(() => { const list = document.getElementById("material-list"); ` +
        `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(expectedCount)}; })()`,
      { label: `sidebar lists all ${String(expectedCount)} scenario materials after reload`, timeoutMs: 20_000 },
    );
  }

  const fixtureOf = (id) => fixtureTruth.get(id);
  const pick = (id, fixtureId) => {
    const item = selections.get(id);
    if (item === undefined) throw new Error(`frozen selection ${id} missing from markdown-selections.json`);
    if (item.fixture !== fixtureId) throw new Error(`frozen selection ${id} targets fixture ${item.fixture}, expected ${fixtureId}`);
    return item;
  };
  const pickPdf = (id, fixtureId) => {
    const item = pdfSelections.get(id);
    if (item === undefined) throw new Error(`frozen pdf selection ${id} missing from pdf-selections.json`);
    if (item.fixture !== fixtureId) throw new Error(`frozen pdf selection ${id} targets fixture ${item.fixture}, expected ${fixtureId}`);
    return item;
  };
  const cases = [];
  const mdCaptured = new Set();
  const pdfCaptured = new Set();
  const crossPageRefused = [];
  let copyMode;

  /* 数据驱动捕获（绝不硬编码 id 清单）：冻结集中指向该 fixture 的每个
     markdown 选区逐个经规范偏移 → 真实 DOM 选区 → 捕获载荷全等。 */
  const captureAllMarkdown = async (fixtureId) => {
    for (const item of selections.values()) {
      if (item.fixture !== fixtureId) continue;
      cases.push(await captureFrozenSelection(ctx, { treeId, material: materials[fixtureId], item, truth: fixtureOf(fixtureId) }));
      mdCaptured.add(item.id);
    }
  };

  /* ---- markdown 全分母（登记册序 md-01..md-12；冻结 45 选区） ---- */
  for (const entry of mdRegistry.fixtures) {
    const fixtureId = entry.fixtureId;
    const truth = fixtureOf(fixtureId);
    const material = materials[fixtureId];
    if (truth === undefined || material === undefined) {
      throw new Error(`markdown denominator incomplete: ${fixtureId} has no frozen truth or imported material`);
    }

    if (fixtureId === "md-01") {
      /* ---- md-01（真实鼠标两击选区 + 真实连续拖选 + 重复词第 5 次出现 + 跨行；14 块单页） ---- */
      await openMaterialInReader(ctx, material, { blocks: truth.blocks.length, tail: "end" });
      await assertBlocksLossless(ctx, truth, { expectedCount: truth.blocks.length, label: "md-01" });
      cases.push(await mouseSelectFrozenSelection(ctx, { treeId, material, item: pick("md-sel-01", "md-01"), truth }));
      mdCaptured.add("md-sel-01");
      /* 真实连续拖选（owner P1 #3）：mousedown 置锚「分」左缘 → mouseMoved×8
         跨文本推进 → mouseup 落「术」右缘——拖拽窗口内捕获条冻结（main 修复），
         释放点不被布局位移带偏；md-sel-02 为此前未覆盖的冻结选区（新增覆盖）。 */
      cases.push(await mouseDragFrozenSelection(ctx, { treeId, material, item: pick("md-sel-02", "md-01"), truth }));
      mdCaptured.add("md-sel-02");
      /* 该 fixture 的全部冻结选区（md-sel-01/02 双覆盖——手势之外再走规范路径）。 */
      await captureAllMarkdown("md-01");
      await ctx.screenshot("selection-md01-crossline");

      /* 跨块纪律（B2：markdown 选区必须含于单块）：blk-1 尾部 → blk-2 开头
         的真实 DOM 选区 → 捕获条如实呈不可锚定，绝不给出载荷。 */
      {
        const placed = await ctx.evalJs(pageSelectCrossBlock("blk-1", 140, "blk-2", 5));
        if (placed === null || placed.error !== undefined) {
          throw new Error(`cross-block case could not be placed — ${JSON.stringify(placed)}`);
        }
        const bar = await waitForArmedBar(ctx, "cross-block discipline");
        if (bar.invalidNote === null || !bar.invalidNote.includes("cross-block")) {
          throw new Error(`cross-block selection was not refused: ${JSON.stringify(bar)}`);
        }
        if (bar.payload !== null || bar.quote !== null) {
          throw new Error(`cross-block selection produced a payload (must not): ${JSON.stringify(bar)}`);
        }
        cases.push({ id: "cross-block-refused", category: "cross-block", blockId: null, start: null, end: null });
      }
      continue;
    }

    if (fixtureId === "md-06") {
      /* ---- md-06（emoji/字素簇家族；16 块单页） ---- */
      await openMaterialInReader(ctx, material, { blocks: truth.blocks.length, tail: "end" });
      await assertReaderChrome(ctx, material, truth);
      await assertBlocksLossless(ctx, truth, { expectedCount: truth.blocks.length, label: "md-06" });
      await ctx.screenshot("reader-md06");

      await captureAllMarkdown("md-06");

      /* 字素安全吸附（浏览器面专属，B2 inv 类别的前端镜像）：故意把选区边界
         放进 👨‍💻 字素簇内部（代理对之间起、簇内止）——捕获条必须向外吸附到
         整簇 [833, 838)，与冻结真值 md-sel-30 全等并携带吸附注记。 */
      {
        const item = pick("md-sel-30", "md-06");
        const placed = await ctx.evalJs(pageSelectCanonical(item.expected.blockId, item.expected.start + 1, item.expected.end - 1));
        if (placed === null || placed.error !== undefined) {
          throw new Error(`grapheme-split case could not be placed — ${JSON.stringify(placed)}`);
        }
        const bar = await waitForArmedBar(ctx, "grapheme-split (md-sel-30 truth)");
        assertBarPayload(bar, {
          materialId: material.materialId,
          versionId: material.versionId,
          expected: item.expected,
          caseId: "grapheme-split (md-sel-30 truth)",
          expectSnap: true,
        });
        cases.push({ id: "grapheme-split→md-sel-30", category: "emoji-split-snap", blockId: item.expected.blockId, start: item.expected.start, end: item.expected.end });
      }
      await ctx.screenshot("selection-md06-emoji");
      continue;
    }

    if (fixtureId === "md-11") {
      /* ---- md-11（59 块 > 50/页：懒加载第二页 + 长尾 + 重复词第 4 次出现） ---- */
      const firstPage = Math.min(truth.blocks.length, MATERIAL_FETCH_BLOCK_STEP);
      await openMaterialInReader(ctx, material, { blocks: firstPage, tail: "more" });
      await assertBlocksLossless(ctx, truth, { expectedCount: firstPage, label: "md-11 page 1" });
      /* 真实滚动到底 → 应用自身的滚动监听触发第二页预取。 */
      await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
      await waitFor(ctx, pageReaderLoadedExpr(truth.blocks.length, "end"), { label: "md-11 lazy-loaded second page (59 blocks)", timeoutMs: 15_000 });
      await assertBlocksLossless(ctx, truth, { expectedCount: truth.blocks.length, label: "md-11 all blocks" });
      await ctx.screenshot("reader-md11-lazyloaded");

      await captureAllMarkdown("md-11");

      /* 复制不变（charter §3.2「复制摘录」）：md-sel-40 重新武装（captureAll
         之后捕获条停在最后一条——复制流程需要 40 在场；双覆盖合规）。 */
      {
        const item = pick("md-sel-40", "md-11");
        const expected = item.expected;
        cases.push(await captureFrozenSelection(ctx, { treeId, material, item, truth }));
        /* DOM click 事件（应用自身的 click 监听路径）。不用 CDP 输入点击的原因：
           输入点击的 press/release 分两次 CDP 命令送达，press 引发的浏览器
           选区清除会让应用 0ms 延迟解除的捕获条重渲抢在 release 之前（真实
           用户点击不经 CDP 分段——应用的焦点守卫按连续输入保证成立）。 */
        await ctx.evalJs(
          `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); ` +
            `if (btn === null) return false; btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
        );
        await waitFor(
          ctx,
          `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); return btn !== null && btn.textContent === "已复制 ✓"; })()`,
          { label: "copy-quote confirmation (已复制 ✓)", timeoutMs: 4000 },
        );
        try {
          await ctx.cdpSend("Browser.grantPermissions", { origin: ctx.studioOrigin(), permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        } catch {
          /* 授权不可用 → 下方降级路径如实报告 */
        }
        const read = await ctx.evalJs(
          `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
            `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
        );
        if (read.ok === true) {
          if (read.text !== expected.excerpt) {
            throw new Error(
              `copy quote: clipboard content differs from the canonical excerpt ` +
                `(${String(read.text.length)} vs ${String(expected.excerpt.length)} UTF-16 units)`,
            );
          }
          copyMode = "clipboard read-back byte-equal";
        } else {
          /* 诚实降级：复制确认态（已复制 ✓）已验证 + 摘录与冻结 canonicalText
             切片字节相等（复制的就是该切片）。 */
          if (truth.canonicalText.slice(expected.start, expected.end) !== expected.excerpt) {
            throw new Error("frozen excerpt is not the canonicalText slice (fixture inconsistency)");
          }
          copyMode = `copy-confirmed (clipboard read-back unavailable: ${String(read.error)})`;
        }
      }
      await ctx.screenshot("selection-md11-longtail");
      /* 收尾：md-11 滚回顶部再离开。后续材料打开时 openMaterial 的换材料
         冲刷会把当前顶可见块落库为 blk-0（首块）——d4-restart-continue 重开
         md-11 时位置恢复落在第一页内（50 块 + more），其就位等待确定性成立；
         若留在大滚动位（长尾块 blk-5x），恢复路径会向前补页到 59 块，与其
         首页就位断言赛跑（此前全量跑侥幸通过的那类竞态——这里消除它）。 */
      await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = 0; return true; })()`);
      continue;
    }

    /* ---- 通用 markdown 流（其余 fixture：开卷 → 逐块无损 → 全部冻结选区） ---- */
    const firstPage = Math.min(truth.blocks.length, MATERIAL_FETCH_BLOCK_STEP);
    await openMaterialInReader(ctx, material, { blocks: firstPage, tail: firstPage < truth.blocks.length ? "more" : "end" });
    if (firstPage < truth.blocks.length) {
      await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
      await waitFor(ctx, pageReaderLoadedExpr(truth.blocks.length, "end"), { label: `${fixtureId} lazy-loaded remainder (${String(truth.blocks.length)} blocks)`, timeoutMs: 15_000 });
    }
    await assertBlocksLossless(ctx, truth, { expectedCount: truth.blocks.length, label: fixtureId });
    await captureAllMarkdown(fixtureId);
  }

  /* ---- PDF 全分母（登记册序 pdf-01..pdf-12；冻结 30 选区 + 单页纪律镜像） ---- */
  const pdfFixtureIds = new Set(pdfRegistry.fixtures.map((pdfEntry) => pdfEntry.fixtureId));
  for (const inv of invalidCrossPageItems) {
    if (!pdfFixtureIds.has(inv.input.fixture)) {
      throw new Error(`${String(inv.id)}: cross-page negative targets ${String(inv.input.fixture)}, which is not in the pdf registry`);
    }
  }
  const openPdfMaterialInReader = async (fixtureId) => {
    const truth = fixtureOf(fixtureId);
    const material = materials[fixtureId];
    const pages = truth.blocks.length;
    await inputClickAt(ctx, materialButtonSelector(material.materialId));
    const firstBatch = Math.min(pages, PDF_FETCH_PAGE_STEP);
    await waitFor(
      ctx,
      pdfReaderLoadedExpr(firstBatch, pages > firstBatch ? "more" : "end"),
      { label: `${fixtureId} reader (${String(firstBatch)} page(s))`, timeoutMs: 20_000 },
    );
    /* >10 页长文：真实滚动到底 → 应用自身的滚动监听逐批预取（10 页/批）。 */
    for (let loaded = firstBatch; loaded < pages; loaded += PDF_FETCH_PAGE_STEP) {
      await ctx.evalJs(`(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; el.scrollTop = el.scrollHeight; return true; })()`);
      const target = Math.min(loaded + PDF_FETCH_PAGE_STEP, pages);
      await waitFor(
        ctx,
        pdfReaderLoadedExpr(target, target >= pages ? "end" : "more"),
        { label: `${fixtureId} lazy-loaded pages up to ${String(target)}`, timeoutMs: 15_000 },
      );
    }
  };

  for (const entry of pdfRegistry.fixtures) {
    const fixtureId = entry.fixtureId;
    const truth = fixtureOf(fixtureId);
    const material = materials[fixtureId];
    if (truth === undefined || material === undefined) {
      throw new Error(`pdf denominator incomplete: ${fixtureId} has no frozen truth or imported material`);
    }
    await openPdfMaterialInReader(fixtureId);
    await assertPdfReaderChrome(ctx, material, truth);
    if (fixtureId === "pdf-01") await ctx.screenshot("reader-pdf01");
    if (fixtureId === "pdf-06") await ctx.screenshot("reader-pdf06-twocolumn");

    /* 本 fixture 的全部冻结选区（每项目标页先滚入懒渲染窗口并逐字对照冻结页块）。 */
    for (const item of pdfSelections.values()) {
      if (item.fixture !== fixtureId) continue;
      cases.push(await capturePdfFrozenSelection(ctx, { treeId, material, item, truth }));
      pdfCaptured.add(item.id);
      if (fixtureId === "pdf-01" && item.id === "pdf-sel-01") await ctx.screenshot("selection-pdf01-armed");
    }

    if (fixtureId === "pdf-01") {
      /* 真实连续拖选（与 markdown 面同款 owner P1 #3 纪律的 PDF 镜像）：
         pdf-sel-01（page-1 文本层上「递归」）——mousedown 置锚 → mouseMoved×8
         跨文本推进 → mouseup 收选；页文本层与 markdown 块共用同一套武装路径。 */
      {
        const item = pickPdf("pdf-sel-01", "pdf-01");
        const block = truth.blocks.find((candidate) => candidate.blockId === item.expected.blockId);
        if (block === undefined || typeof block.page !== "number") {
          throw new Error(`pdf-sel-01: page block ${String(item.expected.blockId)} missing from the frozen truth`);
        }
        await ensurePdfPageRendered(ctx, item.expected.blockId, "pdf-sel-01 (real drag)");
        cases.push(await mouseDragFrozenSelection(ctx, { treeId, material, item, truth, page: block.page }));
      }
    }

    /* 跨页纪律镜像（B2 冻结负例 inv-08/inv-09；charter §3.2：PDF 选区必须
       含于单页）：两页文本层都已渲染后放置跨页真实 DOM 选区 → 捕获条如实呈
       不可锚定，绝不给出载荷，也绝不静默截断。 */
    for (const inv of invalidCrossPageItems.filter((candidate) => candidate.input.fixture === fixtureId)) {
      const startBlock = truth.blocks.find((block) => block.start <= inv.input.start && inv.input.start < block.end) ?? null;
      const endBlock = truth.blocks.find((block) => block.start < inv.input.end && inv.input.end <= block.end) ?? null;
      if (startBlock === null || endBlock === null || startBlock.blockId === endBlock.blockId) {
        throw new Error(
          `${String(inv.id)}: frozen cross-page input [${String(inv.input.start)}, ${String(inv.input.end)}) does not span two distinct page blocks of ${fixtureId}`,
        );
      }
      await ensurePdfPageRendered(ctx, startBlock.blockId, String(inv.id));
      await ensurePdfPageRendered(ctx, endBlock.blockId, String(inv.id));
      const placed = await ctx.evalJs(
        pageSelectCrossPagePdf(startBlock.blockId, inv.input.start - startBlock.start, endBlock.blockId, inv.input.end - endBlock.start),
      );
      if (placed === null || placed.error !== undefined) {
        throw new Error(`${String(inv.id)}: cross-page selection could not be placed — ${JSON.stringify(placed)}`);
      }
      const bar = await waitForArmedBar(ctx, `${String(inv.id)} (cross-page discipline)`);
      if (bar.invalidNote === null || !bar.invalidNote.includes("cross-page")) {
        throw new Error(`${String(inv.id)}: cross-page selection was not refused: ${JSON.stringify(bar)}`);
      }
      if (bar.payload !== null || bar.quote !== null) {
        throw new Error(`${String(inv.id)}: cross-page selection produced a payload (must not): ${JSON.stringify(bar)}`);
      }
      cases.push({ id: `${String(inv.id)}-cross-page-refused`, category: "cross-page", blockId: null, start: null, end: null });
      crossPageRefused.push({ id: String(inv.id), fixture: fixtureId, from: startBlock.blockId, to: endBlock.blockId, range: [inv.input.start, inv.input.end] });
      if (fixtureId === "pdf-01") await ctx.screenshot("selection-pdf01-crosspage-refused");
    }

    if (fixtureId === "pdf-11") await ctx.screenshot("selection-pdf11-longtail");
  }
  if (crossPageRefused.length !== invalidCrossPageItems.length) {
    throw new Error(
      `cross-page negatives not fully mirrored: ${String(crossPageRefused.length)} of ${String(invalidCrossPageItems.length)} executed`,
    );
  }

  /* ---- 分母完整性（冻结分母绝不静默缩水；差一即失败） ---- */
  const mdTotal = selections.size;
  const pdfTotal = pdfSelections.size;
  const mdMissing = [...selections.keys()].filter((id) => !mdCaptured.has(id));
  const pdfMissing = [...pdfSelections.keys()].filter((id) => !pdfCaptured.has(id));
  if (mdMissing.length > 0 || pdfMissing.length > 0) {
    throw new Error(
      `frozen B2 selection denominator not fully captured — markdown missing: ${mdMissing.join(", ") || "(none)"}; pdf missing: ${pdfMissing.join(", ") || "(none)"}`,
    );
  }

  const pageErrors = assertNoPageErrors(ctx, { label: "d4-read-and-select" });
  const mdCategories = [...new Set([...selections.values()].map((item) => item.category))].sort();
  const pdfCategories = [...new Set([...pdfSelections.values()].map((item) => item.category))].sort();
  await ctx.sidecar("read-select-cases", {
    check: "d4-read-and-select",
    cases,
    frozenSelectionsExact: cases.filter((entry) => entry.id.startsWith("md-sel") || entry.id.startsWith("pdf-sel")).length,
    markdownFrozenExact: mdCaptured.size,
    pdfFrozenExact: pdfCaptured.size,
    markdownDenominator: mdTotal,
    pdfDenominator: pdfTotal,
    markdownCapturedIds: [...mdCaptured].sort(),
    pdfCapturedIds: [...pdfCaptured].sort(),
    markdownCategories: mdCategories,
    pdfCategories: pdfCategories,
    snapCase: "grapheme-split snapped outward to md-sel-30 truth",
    crossBlock: "refused (no payload)",
    crossPage: `refused (no payload) — frozen ${invalidCrossPageItems.map((inv) => String(inv.id)).join(", ")} mirrored in the real pdf reader`,
    crossPageRefused,
    pdfMouseGesture: "pdf-sel-01 via a real continuous drag (press → move×8 → release) on the page-1 text layer",
    copyQuote: copyMode,
    pageErrors,
  });
  return {
    detail:
      `${String(mdCaptured.size)}/${String(mdTotal)} markdown + ${String(pdfCaptured.size)}/${String(pdfTotal)} frozen B2 selections captured exactly in the real reader ` +
      `(markdown ${mdCategories.join("/")} across md-01..md-12 incl. emoji/ZWJ, repeat-word occurrences, cross-line and long-tail past lazy-load; ` +
      `pdf ${pdfCategories.join("/")} across pdf-01..pdf-12 with each targeted page's text layer byte-equal to the frozen truth before capture ` +
      `and multipage pdf-11 fully paged in; 3 real mouse gestures: md click + Shift+click (md-sel-01), md continuous drag (md-sel-02), ` +
      `pdf continuous drag (pdf-sel-01 on a page text layer)); grapheme-split snapped outward; cross-block refused; ` +
      `cross-page refused on pdf (frozen ${invalidCrossPageItems.map((inv) => String(inv.id)).join("/")} — no payload, never silently truncated); ` +
      `resolve-selection agrees on all (incl. sourceHash = SHA-256 of the frozen canonicalText); copy quote: ${copyMode}`,
  };
}
