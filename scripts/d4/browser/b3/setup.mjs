/** setup ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */
import {
  importMaterialViaHttp,
  inputClickAt,
  loadB1Fixture,
  loadB1Registries,
  loadB1RegistryFixture,
  materialButtonSelector,
  pageSelectCanonical,
  waitFor,
  waitForArmedBar,
  waitForVersionReady,
} from "../material-probes.mjs";
import {
  domClick,
} from "./input.mjs";
import {
  B3_PDF_FIXTURE_ID,
} from "./policy.mjs";
import {
  pageSelectPdfLayer,
  safeBlockRange,
} from "./selection.mjs";

/** 场景树上确定 pdf-01（B1 冻结文字层 PDF）并确定两个选区（md/pdf）。
    d4-read-and-select 已把 B2 全分母（12 md + 12 PDF）铺进场景树——pdf-01
    已在场时**直接复用**（导入 API 对树内同字节去重回 200/created=false，
    重复导入既无必要也拿不到 201；复用同一 material/version 与浏览器面
    B2 证据同源）。 */
export async function ensureB3Corpus(ctx) {
  const treeId = ctx.scenario.treeId;
  if (treeId === null) {
    throw new ctx.NotRunError("场景树未就位（见 d4-import-material 的结果）——B3 材料 Branch/Return 探针级联跳过");
  }
  const materials = ctx.scenario.materials ?? {};
  if (materials["md-01"] === undefined) {
    throw new ctx.NotRunError("md-01 未导入就位（见 d4-import-material 的结果）——B3 材料 Branch/Return 探针级联跳过");
  }
  if (materials["md-01"].truth === undefined) {
    materials["md-01"].truth = loadB1Fixture(ctx.ROOT, "md-01").truth;
  }
  if (ctx.scenario.b3 === undefined) {
    /* pdf-01：登记册定位（负例/版本对不掺入）。 */
    const registries = loadB1Registries(ctx.ROOT);
    const pdfRegistry = registries.find((registry) => registry.kind === "pdf");
    if (pdfRegistry === undefined) throw new Error("B3: no pdf registry in tests/fixtures/d4/b1-import");
    const entry = pdfRegistry.fixtures.find((candidate) => candidate.fixtureId === B3_PDF_FIXTURE_ID);
    if (entry === undefined) throw new Error(`B3: fixture ${B3_PDF_FIXTURE_ID} missing from the pdf registry`);
    const fixture = loadB1RegistryFixture(ctx.ROOT, entry, "pdf-registry.json");
    if (fixture.truth.blocks.length < 2) throw new Error("B3: pdf-01 has fewer than 2 blocks (dataset shape changed)");
    if (materials[B3_PDF_FIXTURE_ID] === undefined) {
      const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes, 30_000);
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`B3 pdf-01 import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
      }
      await waitForVersionReady(ctx, treeId, res.body.material.id, res.body.version.id, "pdf-01");
      materials[B3_PDF_FIXTURE_ID] = {
        fixtureId: B3_PDF_FIXTURE_ID,
        materialId: res.body.material.id,
        versionId: res.body.version.id,
        title: res.body.material.title,
        truth: fixture.truth,
      };
      ctx.scenario.materials = materials;
      /* API 导入后刷新页面（真实导航——应用自身重拉材料列表；与导入探针
         同款纪律），等 pdf-01 出现在侧栏。 */
      await ctx.navigate(ctx.studioUrl());
      await waitFor(
        ctx,
        `(() => { const list = document.getElementById("material-list"); ` +
          `return list !== null && list.querySelectorAll("button[data-material-id]").length >= 4 ` +
          `&& document.querySelector(${JSON.stringify(materialButtonSelector(res.body.material.id))}) !== null; })()`,
        { label: "sidebar lists the imported pdf-01 (B3 corpus)", timeoutMs: 20_000 },
      );
    } else {
      /* 分母已铺（d4-read-and-select 导入并刷新过侧栏）——补挂冻结 truth
         只读复用，不重复导入（同字节会按树内去重回 200）。 */
      if (materials[B3_PDF_FIXTURE_ID].truth === undefined) {
        materials[B3_PDF_FIXTURE_ID].truth = fixture.truth;
      }
    }
    ctx.noteFixturesUsed(["md-01", B3_PDF_FIXTURE_ID]);
    /* 选区（确定性）：md-01 取中段块；pdf-01 取第 2 页块。 */
    const mdBlocks = materials["md-01"].truth.blocks;
    const mdBlock = mdBlocks[Math.floor(mdBlocks.length / 2)];
    const pdfBlock = fixture.truth.blocks[1];
    ctx.scenario.b3 = {
      mdRange: safeBlockRange(mdBlock),
      pdfRange: safeBlockRange(pdfBlock),
    };
  }
  return { treeId, b3: ctx.scenario.b3 };
}

/** 阅读器内武装选区（md：pageSelectCanonical；pdf：页文本层）→ 捕获条。 */
export async function armSelectionInReader(ctx, material, range) {
  const placed = material.fixtureId === B3_PDF_FIXTURE_ID
    ? await ctx.evalJs(pageSelectPdfLayer(range.blockId, range.start, range.end))
    : await ctx.evalJs(pageSelectCanonical(range.blockId, range.start, range.end));
  if (placed === null || placed.error !== undefined) {
    throw new Error(`B3 selection could not be placed on ${material.fixtureId} — ${JSON.stringify(placed)}`);
  }
  if (placed.selectedText !== range.excerpt) {
    throw new Error(
      `B3 selection on ${material.fixtureId} does not reproduce the planned excerpt ` +
        `(got ${JSON.stringify(placed.selectedText)}, want ${JSON.stringify(range.excerpt)})`,
    );
  }
  const bar = await waitForArmedBar(ctx, `B3 ${material.fixtureId} selection`, 6000);
  if (bar.payload === null) {
    throw new Error(`B3 capture bar did not arm with a payload on ${material.fixtureId}: ${JSON.stringify(bar)}`);
  }
  return bar;
}

/** 建枝（捕获条按钮 → declared 面）+ 提交前材料范围声明断言。 */
export async function branchFromArmedSelection(ctx, material, range) {
  await domClick(ctx, "#mat-selection-bar .mat-branch-d43");
  const flow = await waitFor(
    ctx,
    `(() => { const flow = document.getElementById("mat-branch-flow"); ` +
      `if (flow === null) return false; const card = flow.querySelector(".mat-branch-context"); ` +
      `const input = document.getElementById("mat-branch-first-question"); ` +
      `return card !== null && input !== null ? { text: flow.textContent ?? "" } : false; })()`,
    { label: `branch flow declared for ${material.fixtureId} (context card + first-question input)`, timeoutMs: 20_000 },
  );
  const problems = [];
  const text = flow.text ?? "";
  if (!text.includes("Material scope for this exploration — declared before your first question")) {
    problems.push("the pre-submit material scope declaration is not visible");
  }
  if (!text.includes(`“${material.title}”`)) problems.push("material title not stated in the scope card");
  if (!text.includes(`block ${range.blockId}`)) problems.push(`source block ${range.blockId} not stated`);
  if (!text.includes(`UTF-16 [${String(range.start)}, ${String(range.end)})`)) {
    problems.push(`canonical range [${String(range.start)}, ${String(range.end)}) not stated`);
  }
  const excerpt = await ctx.evalJs(
    `(() => document.querySelector("#mat-branch-flow .mat-branch-excerpt")?.textContent ?? null)()`,
  );
  if (excerpt !== range.excerpt) {
    problems.push(`scope-card excerpt differs from the armed selection (got ${JSON.stringify(excerpt)})`);
  }
  if (problems.length > 0) {
    throw new Error(`B3 pre-submit context declaration mismatch on ${material.fixtureId} — ${problems.join("; ")}`);
  }
  return true;
}

/** 首问派发（Submit 点击）→ 面板打开（问题 turn 在场）。 */
export async function submitFirstQuestion(ctx, questionText, timeoutMs) {
  await inputClickAt(ctx, "#mat-branch-first-question");
  await ctx.cdpSend("Input.insertText", { text: questionText });
  await domClick(ctx, "#mat-branch-flow .mat-branch-submit");
  await waitFor(
    ctx,
    `(() => { const panel = document.getElementById("branch-panel"); ` +
      `if (panel === null || panel.hidden) return false; ` +
      `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(questionText)}); })()`,
    { label: "first question landed and the branch panel opened", timeoutMs },
  );
}
