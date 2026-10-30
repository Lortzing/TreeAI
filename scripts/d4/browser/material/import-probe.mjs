/** import-probe ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  FIXTURE_IDS,
  loadB1Fixture,
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
  assertNoPageErrors,
} from "./selection.mjs";

export async function probeImportMaterial(ctx) {
  const fixtures = FIXTURE_IDS.map((id) => loadB1Fixture(ctx.ROOT, id));
  ctx.noteFixturesUsed(FIXTURE_IDS);

  /* 1) 建树：真实 UI 路径（空态主操作按钮）。若页面已有打开的树（复跑/
        指定 --data），如实沿用而不重复建树。 */
  const emptyStateVisible = await ctx.evalJs(
    `(() => { const el = document.getElementById("empty-state"); return el !== null && !el.hidden && document.getElementById("empty-new-tree") !== null; })()`,
  );
  if (emptyStateVisible === true) {
    await inputClickAt(ctx, "#empty-new-tree");
  }
  await waitFor(
    ctx,
    `(() => {
      const section = document.getElementById("materials-section");
      const list = document.getElementById("material-list");
      if (section === null || section.hidden || list === null || list.children.length === 0) return false;
      return { firstItem: list.children[0].textContent };
    })()`,
    { label: "tree opened and the sidebar Materials section rendered" },
  );
  const trees = await ctx.api("GET", "/api/trees");
  if (trees.status !== 200 || (trees.body?.trees ?? []).length !== 1) {
    throw new Error(
      `expected exactly one tree in the fresh data dir (got ${String(trees.body?.trees?.length ?? "?")}); ` +
        "re-running the material probes against a reused --data dir is not supported — use a fresh data dir",
    );
  }
  const treeId = trees.body.trees[0].id;
  ctx.scenario.treeId = treeId;

  /* 2) 导入：真实 HTTP API（D4-1 契约面；导入 UI 属后续增量——浏览器
        侧未来将调用同一端点）。冻结 fixture 原始字节 + 文件名头。 */
  const imported = {};
  for (const { fixtureId, filename, bytes, truth } of fixtures) {
    const res = await importMaterialViaHttp(ctx, treeId, filename, bytes);
    if (res.status !== 201 || res.body?.created !== true) {
      throw new Error(`${fixtureId}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
    }
    const material = res.body.material;
    const version = res.body.version;
    if (version.parserKind !== "markdown") {
      throw new Error(`${fixtureId}: parserKind ${String(version.parserKind)} ≠ markdown`);
    }
    const ready = await waitForVersionReady(ctx, treeId, material.id, version.id, fixtureId);
    if (ready.textUnits !== truth.textUnits) {
      throw new Error(`${fixtureId}: server textUnits ${String(ready.textUnits)} ≠ frozen ${String(truth.textUnits)}`);
    }
    if (typeof material.title !== "string" || !material.title.includes(fixtureId)) {
      throw new Error(`${fixtureId}: material title does not identify the fixture: ${JSON.stringify(material.title)}`);
    }
    imported[fixtureId] = { fixtureId, materialId: material.id, versionId: version.id, title: material.title, textUnits: ready.textUnits };
  }
  ctx.scenario.materials = imported;

  /* 3) 刷新页面（真实导航）：应用重启动 → 自动开树 → 拉材料列表。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(FIXTURE_IDS.length)} ? true : false; })()`,
    { label: `sidebar materials list with ${String(FIXTURE_IDS.length)} entries after reload` },
  );

  /* 4) 逐条断言：ready 状态 + 种类/版本标签（真实 DOM）。 */
  for (const fixtureId of FIXTURE_IDS) {
    const entry = imported[fixtureId];
    const info = await ctx.evalJs(
      `(() => { const btn = document.querySelector(${JSON.stringify(materialButtonSelector(entry.materialId))}); ` +
        `if (btn === null) return null; ` +
        `const name = btn.querySelector(".material-name"); const meta = btn.querySelector(".material-meta"); ` +
        `const status = btn.querySelector(".material-status"); ` +
        `return { name: name === null ? null : name.textContent, meta: meta === null ? null : meta.textContent, ` +
        `status: status === null ? null : status.textContent, statusClass: status === null ? null : status.className }; })()`,
    );
    if (info === null) throw new Error(`${fixtureId}: no sidebar button for material ${entry.materialId}`);
    const problems = [];
    if (info.name !== entry.title) problems.push(`title ${JSON.stringify(info.name)} ≠ ${JSON.stringify(entry.title)}`);
    if (info.meta !== "markdown · v1 · ready") problems.push(`meta ${JSON.stringify(info.meta)} ≠ "markdown · v1 · ready"`);
    if (info.status !== "ready") problems.push(`status ${JSON.stringify(info.status)} ≠ "ready"`);
    if (info.statusClass !== "material-status ready") problems.push(`status class ${JSON.stringify(info.statusClass)} ≠ "material-status ready"`);
    if (problems.length > 0) throw new Error(`${fixtureId}: sidebar entry mismatch — ${problems.join("; ")}`);
  }

  await ctx.screenshot("materials-list");
  const pageErrors = assertNoPageErrors(ctx, { label: "d4-import-material" });
  await ctx.sidecar("import-materials", {
    check: "d4-import-material",
    treeId,
    fixtures: Object.fromEntries(
      Object.entries(imported).map(([fixtureId, entry]) => [
        fixtureId,
        { materialId: entry.materialId, versionId: entry.versionId, title: entry.title, textUnits: entry.textUnits, parseStatus: "ready" },
      ]),
    ),
    sidebarAssertion: "markdown · v1 · ready for each entry",
    pageErrors,
  });
  return {
    detail:
      `${String(FIXTURE_IDS.length)} frozen B1 fixtures imported via the real HTTP API (echo studio) and listed ready ` +
      `in the real sidebar (markdown · v1 · ready); server textUnits match the frozen truth`,
  };
}
