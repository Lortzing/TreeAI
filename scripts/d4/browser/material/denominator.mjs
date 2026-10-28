/** denominator ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  b1FixtureBasename,
  buildOversizeFileBytes,
  buildOversizePagesPdf,
  buildOversizeTextUnitsBytes,
  countMaterialsViaApi,
  loadB1Registries,
  loadB1RegistryFixture,
  readAllBlocksViaApi,
  waitForVersionStatus,
} from "./fixture-api.mjs";
import {
  B1_ROOT,
} from "./fixtures.mjs";
import {
  importMaterialViaHttp,
} from "./import-api.mjs";
import {
  inputClickAt,
  waitFor,
} from "./input.mjs";
import {
  activeTreeIdInUiExpr,
  switchTreeInUi,
} from "./markdown-reader.mjs";
import {
  assertNoPageErrors,
} from "./selection.mjs";
import {
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 探针 6：d4-import-denominator（B1 全分母浏览器面）                      */
/* ------------------------------------------------------------------ */

/**
 * B1 全分母（owner 2026-09-30 增量验收：浏览器面的导入分母必须铺满冻结集）：
 * 在专用树（真实 UI「＋ New Tree」建）里经真实导入 API 铺满 12 markdown +
 * 12 text-layer PDF 全部 ready fixture——每个版本到达 ready、textUnits 与
 * 冻结真值一致、经分页块读取面与冻结 canonicalText + 块图逐字节全等；
 * 8 个文件负例 + 3 个超限负例（manifest 配方确定性生成）如实拒绝：导入门
 * 拒绝（400/413，零持久化）或终态 failed（parseError 携冻结原因码、
 * textUnits 0、分块读取 409 material-not-ready——绝不伪装空成功文档）。
 * 全部经真实侧栏 Materials 列表呈现断言（ready/failed 状态逐条对账）。
 */
export async function probeImportDenominator(ctx) {
  if (ctx.scenario.treeId === null || ctx.scenario.materials === null) {
    throw new ctx.NotRunError("场景树/材料未就位（见 d4-import-material 的结果）——B1 全分母探针级联跳过");
  }
  const scenarioTreeId = ctx.scenario.treeId;
  const registries = loadB1Registries(ctx.ROOT);
  const readyTotal = registries.reduce((sum, r) => sum + r.fixtures.length, 0);
  const fileNegativesTotal = registries.reduce((sum, r) => sum + r.negativeFixtures.length, 0);
  ctx.noteFixturesUsed([
    ...registries.flatMap((r) => r.fixtures.map((f) => f.fixtureId)),
    ...registries.flatMap((r) => r.negativeFixtures.map((f) => f.fixtureId)),
  ]);

  /* 级联卫生：探针无论成败都把 UI 切回场景树（后续探针的当前树语义
     不因本探针的中途失败而被污染）。 */
  let denominatorTreeId = null;
  try {
  /* 1) 真实 UI 建专用树（第二棵树；不污染场景树的下游探针语义）。 */
  const treesBefore = await ctx.evalJs(`(() => document.querySelectorAll("#tree-list button").length)()`);
  await inputClickAt(ctx, "#new-tree");
  await waitFor(
    ctx,
    `(() => document.querySelectorAll("#tree-list button").length === ${String(Number(treesBefore) + 1)})()`,
    { label: "denominator tree row appears in the sidebar" },
  );
  const treeId = await ctx.evalJs(activeTreeIdInUiExpr());
  denominatorTreeId = treeId;
  if (typeof treeId !== "string" || treeId === scenarioTreeId) {
    throw new Error(`the new denominator tree did not become active (active=${JSON.stringify(treeId)})`);
  }
  const treesApi = await ctx.api("GET", "/api/trees");
  if ((treesApi.body?.trees ?? []).length !== Number(treesBefore) + 1) {
    throw new Error(`expected ${String(Number(treesBefore) + 1)} trees after the UI New Tree click (got ${String(treesApi.body?.trees?.length ?? "?")})`);
  }

  /* 2) 全分母导入：每个 ready fixture → 201 → ready → textUnits 真值 →
        分页块读取与冻结 canonicalText/块图逐字节全等。 */
  const imported = [];
  for (const { name, kind, fixtures } of registries) {
    for (const entry of fixtures) {
      const fixture = loadB1RegistryFixture(ctx.ROOT, entry, name);
      if (entry.outcome !== "ready") {
        throw new Error(`${name}: fixture ${String(entry.fixtureId)} has non-ready outcome '${String(entry.outcome)}'`);
      }
      const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes, 60_000);
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`${String(entry.fixtureId)}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
      }
      const material = res.body.material;
      const version = res.body.version;
      if (version.parserKind !== kind) {
        throw new Error(`${String(entry.fixtureId)}: parserKind ${String(version.parserKind)} ≠ ${kind}`);
      }
      if (typeof material.title !== "string" || !material.title.includes(String(entry.fixtureId))) {
        throw new Error(`${String(entry.fixtureId)}: material title does not identify the fixture: ${JSON.stringify(material.title)}`);
      }
      const ready = await waitForVersionStatus(ctx, treeId, material.id, version.id, String(entry.fixtureId), "ready", 60_000);
      if (ready.parserVersion !== fixture.truth.normalizer) {
        throw new Error(`${String(entry.fixtureId)}: parserVersion ${String(ready.parserVersion)} ≠ frozen ${String(fixture.truth.normalizer)}`);
      }
      if (ready.textUnits !== fixture.expectedUnits) {
        throw new Error(`${String(entry.fixtureId)}: server textUnits ${String(ready.textUnits)} ≠ frozen ${String(fixture.expectedUnits)}`);
      }
      const blocks = await readAllBlocksViaApi(ctx, treeId, material.id, version.id, String(entry.fixtureId));
      const gotText = blocks.map((block) => block.text).join("");
      if (gotText !== fixture.truth.canonicalText) {
        throw new Error(
          `${String(entry.fixtureId)}: canonical text via the blocks API diverges from the frozen truth ` +
            `(${String(gotText.length)} vs ${String(fixture.truth.canonicalText.length)} UTF-16 units)`,
        );
      }
      const gotMap = blocks.map(({ text, ...rest }) => rest);
      const wantMap = fixture.truth.blocks.map((block) => ({
        blockId: block.blockId,
        kind: block.kind,
        start: block.start,
        end: block.end,
        ...(block.page !== undefined ? { page: block.page } : {}),
      }));
      if (JSON.stringify(gotMap) !== JSON.stringify(wantMap)) {
        throw new Error(`${String(entry.fixtureId)}: block map via the blocks API diverges from the frozen truth`);
      }
      imported.push({
        fixtureId: String(entry.fixtureId),
        kind,
        materialId: material.id,
        versionId: version.id,
        title: material.title,
        textUnits: ready.textUnits,
        blocks: blocks.length,
      });
    }
  }
  if (imported.length !== readyTotal) {
    throw new Error(`imported ${String(imported.length)} ready fixtures, registry total is ${String(readyTotal)}`);
  }

  /* 3) 文件负例（negative/ + 登记册）：导入门拒绝（零持久化）或终态
        failed（冻结原因码 + textUnits 0 + 读取面 409 material-not-ready）。 */
  const negatives = [];
  for (const { name, kind, negativeFixtures } of registries) {
    for (const entry of negativeFixtures) {
      const fixtureId = String(entry.fixtureId);
      const reason = String(entry.reason);
      const bytes = readFileSync(join(ctx.ROOT, ...B1_ROOT, entry.file));
      const before = await countMaterialsViaApi(ctx, treeId);
      const res = await importMaterialViaHttp(ctx, treeId, b1FixtureBasename(entry.file), bytes, 60_000);
      if (fixtureId === "neg-md-empty") {
        if (res.status !== 400 || res.body?.error?.code !== "invalid-argument") {
          throw new Error(`${fixtureId}: expected HTTP 400 invalid-argument at the import gate (got ${String(res.status)} ${JSON.stringify(res.body?.error ?? res.body)})`);
        }
        const after = await countMaterialsViaApi(ctx, treeId);
        if (after !== before) {
          throw new Error(`${fixtureId}: gate rejection persisted rows anyway (${String(before)} → ${String(after)})`);
        }
        negatives.push({ fixtureId, verdict: "gate-rejected", http: 400, code: "invalid-argument", reason, persisted: false });
        continue;
      }
      if (res.status !== 201 || res.body?.created !== true) {
        throw new Error(`${fixtureId}: negative import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
      }
      const version = await waitForVersionStatus(ctx, treeId, res.body.material.id, res.body.version.id, fixtureId, "failed", 60_000);
      const parseError = typeof version.parseError === "string" ? version.parseError : "";
      if (!parseError.startsWith(`${reason}:`)) {
        throw new Error(`${fixtureId}: parseError '${parseError}' does not carry the frozen reason '${reason}'`);
      }
      if (version.textUnits !== 0) {
        throw new Error(`${fixtureId}: rejected document stored ${String(version.textUnits)} text units`);
      }
      const readRes = await ctx.api(
        "GET",
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(res.body.material.id)}/versions/${encodeURIComponent(res.body.version.id)}`,
      );
      if (readRes.status !== 409 || readRes.body?.error?.code !== "material-not-ready") {
        throw new Error(
          `${fixtureId}: reads of the rejected version must be refused 409 material-not-ready (got ${String(readRes.status)} ${JSON.stringify(readRes.body?.error?.code ?? null)})`,
        );
      }
      negatives.push({ fixtureId, verdict: "failed-version", reason, parseError: parseError.slice(0, 140), materialId: res.body.material.id, versionId: res.body.version.id, textUnits: 0 });
    }
  }
  if (negatives.length !== fileNegativesTotal) {
    throw new Error(`executed ${String(negatives.length)} file negatives, registry total is ${String(fileNegativesTotal)}`);
  }

  /* 4) 超限负例（manifest sets.b1-import.generatedOversize 配方；生成器与
        tests/support/verifier/d4-b1-import.ts 同源——确定性、不入仓）。 */
  {
    const before = await countMaterialsViaApi(ctx, treeId);
    const oversizeFile = await importMaterialViaHttp(ctx, treeId, "oversize-file-bytes.md", buildOversizeFileBytes(), 120_000);
    if (oversizeFile.status !== 413 || oversizeFile.body?.error?.code !== "material-too-large") {
      throw new Error(
        `oversize >20MiB: expected HTTP 413 material-too-large before parsing (got ${String(oversizeFile.status)} ${JSON.stringify(oversizeFile.body?.error ?? null)})`,
      );
    }
    if (await countMaterialsViaApi(ctx, treeId) !== before) {
      throw new Error("oversize >20MiB: the 413 gate rejection persisted rows anyway");
    }

    const pages = await importMaterialViaHttp(ctx, treeId, "oversize-pages.pdf", buildOversizePagesPdf(), 120_000);
    if (pages.status !== 201 || pages.body?.created !== true) {
      throw new Error(`oversize >200 pages: import did not 201 (HTTP ${String(pages.status)}): ${JSON.stringify(pages.body)}`);
    }
    const pagesVersion = await waitForVersionStatus(ctx, treeId, pages.body.material.id, pages.body.version.id, "oversize >200 pages", "failed", 90_000);
    if (!(typeof pagesVersion.parseError === "string" && pagesVersion.parseError.startsWith("pages-exceeded:"))) {
      throw new Error(`oversize >200 pages: parseError '${String(pagesVersion.parseError)}' does not carry 'pages-exceeded'`);
    }
    if (pagesVersion.textUnits !== 0) throw new Error("oversize >200 pages: rejected document stored text units");

    const units = await importMaterialViaHttp(ctx, treeId, "oversize-text-units.md", buildOversizeTextUnitsBytes(), 120_000);
    if (units.status !== 201 || units.body?.created !== true) {
      throw new Error(`oversize >1M units: import did not 201 (HTTP ${String(units.status)}): ${JSON.stringify(units.body)}`);
    }
    const unitsVersion = await waitForVersionStatus(ctx, treeId, units.body.material.id, units.body.version.id, "oversize >1M units", "failed", 90_000);
    if (!(typeof unitsVersion.parseError === "string" && unitsVersion.parseError.startsWith("text-units-exceeded:"))) {
      throw new Error(`oversize >1M units: parseError '${String(unitsVersion.parseError)}' does not carry 'text-units-exceeded'`);
    }
    if (unitsVersion.textUnits !== 0) throw new Error("oversize >1M units: rejected document stored text units");
    negatives.push(
      { fixtureId: "oversize-md-20mib", verdict: "gate-rejected", http: 413, code: "material-too-large", reason: "material-too-large", persisted: false },
      { fixtureId: "oversize-pdf-200pages", verdict: "failed-version", reason: "pages-exceeded", parseError: String(pagesVersion.parseError).slice(0, 140), materialId: pages.body.material.id, versionId: pages.body.version.id, textUnits: 0 },
      { fixtureId: "oversize-md-1m-units", verdict: "failed-version", reason: "text-units-exceeded", parseError: String(unitsVersion.parseError).slice(0, 140), materialId: units.body.material.id, versionId: units.body.version.id, textUnits: 0 },
    );
  }

  /* 5) 真实侧栏呈现：页面真实导航刷新（材料经 API 落库后的冷启动读取）→
        切到专用树（真实输入点击树列表行）→ 全部分母逐条对账。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(ctx, `(() => document.querySelectorAll("#tree-list button").length === ${String(Number(treesBefore) + 1)})()`, { label: "tree list after reload" });
  await switchTreeInUi(ctx, treeId);
  const expectedTotal = imported.length + negatives.filter((n) => n.persisted !== false).length;
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(expectedTotal)}; })()`,
    { label: `denominator sidebar with ${String(expectedTotal)} material entries`, timeoutMs: 20_000 },
  );
  const sidebar = await ctx.evalJs(
    `(() => [...document.querySelectorAll("#material-list button[data-material-id]")].map((btn) => ({ ` +
      `id: btn.dataset.materialId, name: btn.querySelector(".material-name") === null ? null : btn.querySelector(".material-name").textContent, ` +
      `meta: btn.querySelector(".material-meta") === null ? null : btn.querySelector(".material-meta").textContent, ` +
      `statusText: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").textContent, ` +
      `statusClass: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").className, ` +
      `statusTitle: btn.querySelector(".material-status") === null ? null : btn.querySelector(".material-status").title })))()`,
  );
  if (sidebar.length !== expectedTotal) {
    throw new Error(`sidebar shows ${String(sidebar.length)} materials, expected ${String(expectedTotal)}`);
  }
  const byId = new Map(sidebar.map((row) => [row.id, row]));
  const problems = [];
  for (const item of imported) {
    const row = byId.get(item.materialId);
    if (row === undefined) {
      problems.push(`${item.fixtureId}: no sidebar entry for material ${item.materialId}`);
      continue;
    }
    if (row.name !== item.title) problems.push(`${item.fixtureId}: title ${JSON.stringify(row.name)} ≠ ${JSON.stringify(item.title)}`);
    if (row.meta !== `${item.kind} · v1 · ready`) problems.push(`${item.fixtureId}: meta ${JSON.stringify(row.meta)} ≠ "${item.kind} · v1 · ready"`);
    if (row.statusText !== "ready") problems.push(`${item.fixtureId}: status ${JSON.stringify(row.statusText)} ≠ "ready"`);
    if (row.statusClass !== "material-status ready") problems.push(`${item.fixtureId}: status class ${JSON.stringify(row.statusClass)} ≠ "material-status ready"`);
  }
  for (const item of negatives) {
    if (item.persisted === false) {
      if (byId.has(item.materialId)) problems.push(`${item.fixtureId}: gate-rejected negative must not appear in the sidebar`);
      continue;
    }
    const row = byId.get(item.materialId);
    if (row === undefined) {
      problems.push(`${item.fixtureId}: no sidebar entry for the failed material`);
      continue;
    }
    if (row.statusClass !== "material-status failed") problems.push(`${item.fixtureId}: status class ${JSON.stringify(row.statusClass)} ≠ "material-status failed"`);
    if (!(typeof row.statusText === "string" && row.statusText.startsWith(`failed: ${item.reason}:`))) {
      problems.push(`${item.fixtureId}: status ${JSON.stringify(row.statusText)} does not start with "failed: ${item.reason}:"`);
    }
    if (!(typeof row.statusTitle === "string" && row.statusTitle.startsWith(`${item.reason}:`))) {
      problems.push(`${item.fixtureId}: status title (full parseError) ${JSON.stringify(row.statusTitle)} does not start with "${item.reason}:"`);
    }
  }
  const readyCount = sidebar.filter((row) => row.statusText === "ready").length;
  const failedCount = sidebar.filter((row) => row.statusClass === "material-status failed").length;
  if (readyCount !== imported.length) problems.push(`sidebar ready count ${String(readyCount)} ≠ ${String(imported.length)}`);
  if (failedCount !== negatives.filter((n) => n.persisted !== false).length) {
    problems.push(`sidebar failed count ${String(failedCount)} ≠ ${String(negatives.filter((n) => n.persisted !== false).length)}`);
  }
  if (problems.length > 0) throw new Error(`denominator sidebar mismatch — ${problems.join("; ")}`);
  await ctx.screenshot("denominator-sidebar");

  /* 6) 收尾：切回场景树（后续探针的当前树语义保持原样）。 */
  await switchTreeInUi(ctx, scenarioTreeId);
  const backCount = await countMaterialsViaApi(ctx, scenarioTreeId);
  await waitFor(
    ctx,
    `(() => { const list = document.getElementById("material-list"); ` +
      `return list !== null && list.querySelectorAll("button[data-material-id]").length === ${String(backCount)}; })()`,
    { label: `scenario tree materials restored in the sidebar (${String(backCount)})` },
  );

  const pageErrors = assertNoPageErrors(ctx, { label: "d4-import-denominator" });
  await ctx.sidecar("import-denominator", {
    check: "d4-import-denominator",
    treeId,
    readyFixtures: imported.map(({ fixtureId, kind, materialId, versionId, textUnits, blocks }) => ({ fixtureId, kind, materialId, versionId, textUnits, blocks })),
    negatives,
    counts: {
      ready: imported.length,
      fileNegatives: fileNegativesTotal,
      oversizeGenerated: 3,
      sidebarTotal: expectedTotal,
      sidebarReady: readyCount,
      sidebarFailed: failedCount,
    },
    truthAssertion: "every ready version byte-equal to the frozen canonicalText + block map via the paginated blocks API; every rejection carries the frozen reason code",
    pageErrors,
  });
  return {
    detail:
      `${String(imported.length)} ready fixtures (12 markdown + 12 text-layer PDF) imported via the real HTTP API into a UI-created tree, ` +
      `each byte-equal to the frozen canonicalText + block map via the paginated blocks API; ` +
      `${String(negatives.length)} negatives honestly rejected (2 at the import gate with zero persistence: empty→400, >20MiB→413; ` +
      `9 terminal failed versions carrying the frozen reason: invalid-utf8/nul-byte/whitespace-only/encrypted/corrupt/no-text-layer×2/pages-exceeded/text-units-exceeded, ` +
      `reads refused 409 material-not-ready); the real sidebar lists all ${String(expectedTotal)} entries with honest ready/failed status`,
  };
  } finally {
    if (denominatorTreeId !== null && denominatorTreeId !== scenarioTreeId) {
      try {
        await switchTreeInUi(ctx, scenarioTreeId);
      } catch {
        /* 尽力而为：切换失败时如实留给后续探针的级联报告，不吞本探针的原错误。 */
      }
    }
  }
}
