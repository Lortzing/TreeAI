/** search ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  utf8BytesOf,
} from "./fixture-api.mjs";
import {
  B1_MARKDOWN_DIR,
  loadB1Fixture,
} from "./fixtures.mjs";
import {
  importMaterialViaHttp,
  waitForVersionReady,
} from "./import-api.mjs";
import {
  inputClickAt,
  waitFor,
} from "./input.mjs";
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
/* 探针 5：d4-search-recover（B4 浏览器面：真实 UI 搜索 → 结果 → 来源跳转）*/
/* ------------------------------------------------------------------ */

/* 语料标记：探针自有事实经真实 API 落库（材料/首问对话/批注/Return），随后
 * 在真实 UI 里检索并逐类跳转断言。冻结 B4 集（55 正向/12 无结果）的引擎面
 * 由离线 b4-cross-material-find 执行；本探针补的是浏览器面：结果行逐字段、
 * 旧版本标注、无结果不编造、当前树/全部树范围、命中→来源。 */
export const SEARCH_PROBE_MARKERS = {
  question: "TreeAI-搜索探针-QUESTION-7f3a",
  annotation: "TreeAI-搜索探针-批注-c41d",
  ret: "TreeAI-搜索探针-RETURN-90b2",
};


export const SEARCH_PROBE_V1_ONLY = "偏移量分页";

/** md-01 首块内构造代理对安全的 UTF-16 半开区间（excerpt 必须与 canonical
 *  切片逐码元一致——边界落在代理对中间会被区间层拒绝，那是 B2 纪律）。 */
export function searchProbeSafeBlockRange(truth) {
  const block = truth.blocks[0];
  const text = block.text;
  let local = Math.min(16, text.length);
  while (local > 0 && (text.charCodeAt(local - 1) & 0xfc00) === 0xd800) local -= 1;
  if (local === 0) throw new Error("md-01 first block has no surrogate-safe prefix");
  return { blockId: block.blockId, start: block.start, end: block.start + local, excerpt: text.slice(0, local) };
}

export async function searchProbeApi(ctx, method, path, body, what) {
  const res = await ctx.api(method, path, body, 30_000);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${what}: HTTP ${String(res.status)} — ${JSON.stringify(res.body)}`);
  }
  return res;
}

/** 建库：树（沿用导入探针的树或自建）+ md-01 + 版本对 v1→v2 + 第二棵树
 *  的 md-06 + 材料 Branch/首问/批注/Return 五类真实事实。全部幂等（重复
 *  调用按既有事实对账，不重复造事实）。 */
export async function ensureSearchCorpus(ctx) {
  let treeId = ctx.scenario.treeId ?? null;
  if (treeId === null) {
    const trees = await ctx.api("GET", "/api/trees");
    treeId = (trees.body?.trees ?? [])[0]?.id ?? null;
  }
  if (treeId === null) {
    await ctx.navigate(ctx.studioUrl());
    await inputClickAt(ctx, "#empty-new-tree");
    await waitFor(ctx, `(() => { const s = document.getElementById("materials-section"); return s !== null && !s.hidden; })()`, { label: "tree opened" });
    const trees = await ctx.api("GET", "/api/trees");
    treeId = (trees.body?.trees ?? [])[0]?.id ?? null;
    if (treeId === null) throw new Error("could not establish a tree for the search probe");
  }
  ctx.scenario.treeId = treeId;
  const materials = ctx.scenario.materials ?? {};

  /* md-01（材料命中与建枝基座）。 */
  if (materials["md-01"] === undefined) {
    const fixture = loadB1Fixture(ctx.ROOT, "md-01");
    const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes);
    if (res.status !== 201) throw new Error(`md-01 import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    await waitForVersionReady(ctx, treeId, res.body.material.id, res.body.version.id, "md-01");
    materials["md-01"] = { materialId: res.body.material.id, versionId: res.body.version.id, truth: fixture.truth };
  }
  ctx.scenario.materials = materials;
  const md01 = materials["md-01"];
  if (md01.truth === undefined) {
    /* 导入探针登记的条目不带真值——补挂冻结 truth（只读）。 */
    md01.truth = loadB1Fixture(ctx.ROOT, "md-01").truth;
  }

  if (ctx.scenario.searchCorpus !== true) {
    /* 版本对：v1（偏移量分页）→ v2（游标分页），v1 成为旧版本命中语料。 */
    const pairDir = join(ctx.ROOT, ...B1_MARKDOWN_DIR.slice(0, -1), "version-pairs");
    const v1Bytes = readFileSync(join(pairDir, "md-vpair-v1.md"));
    const v2Bytes = readFileSync(join(pairDir, "md-vpair-v2.md"));
    let vpairMaterialId = null;
    const listed = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials`);
    for (const material of listed.body?.materials ?? []) {
      if (typeof material.title === "string" && material.title.includes("md-vpair")) vpairMaterialId = material.id;
    }
    if (vpairMaterialId === null) {
      const res = await importMaterialViaHttp(ctx, treeId, "md-vpair-v1.md", v1Bytes);
      if (res.status !== 201) throw new Error(`md-vpair v1 import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
      vpairMaterialId = res.body.material.id;
      await waitForVersionReady(ctx, treeId, vpairMaterialId, res.body.version.id, "md-vpair-v1");
      /* 版本端点与导入端点同头语义（原始字节 + x-treeai-filename）；ctx.api
       *  只会 JSON，这里直接走字节头。 */
      const v2Raw = await fetch(`http://127.0.0.1:${String(ctx.studioPort())}/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(vpairMaterialId)}/versions`, {
        method: "POST",
        headers: { "x-treeai-filename": encodeURIComponent("md-vpair-v2.md"), "content-type": "application/octet-stream" },
        body: v2Bytes,
      });
      const v2Body = await v2Raw.json().catch(() => null);
      if (v2Raw.status !== 201) throw new Error(`md-vpair v2 HTTP ${String(v2Raw.status)}: ${JSON.stringify(v2Body)}`);
      await waitForVersionReady(ctx, treeId, vpairMaterialId, v2Body.version.id, "md-vpair-v2");
    }
    ctx.scenario.searchVpairMaterialId = vpairMaterialId;

    /* 材料 Branch + 幂等首问 + 批注 + Return（全部真实 D4-3 API）。 */
    const range = searchProbeSafeBlockRange(md01.truth);
    const resolved = await searchProbeApi(
      ctx, "POST",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(md01.materialId)}/versions/${encodeURIComponent(md01.versionId)}/resolve-selection`,
      { locator: { kind: "utf16-range", start: range.start, end: range.end }, excerpt: range.excerpt, blockId: range.blockId },
      "resolve-selection (md-01 first block)",
    );
    const selection = resolved.body?.selection ?? null;
    if (selection === null) throw new Error(`resolve-selection returned no canonical selection: ${JSON.stringify(resolved.body)}`);

    const intentKey = "browser-search-probe-md01";
    const branchRes = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
      { selection, intentKey, mode: "resume-or-create" }, 30_000);
    if (branchRes.status !== 200 && branchRes.status !== 201) {
      throw new Error(`from-material HTTP ${String(branchRes.status)}: ${JSON.stringify(branchRes.body)}`);
    }
    const branchId = branchRes.body?.branch?.id ?? null;
    if (branchId === null) throw new Error(`from-material returned no branch: ${JSON.stringify(branchRes.body)}`);

    const question = `这段材料最关键的论点是什么？请结合选区解释。（${SEARCH_PROBE_MARKERS.question}）`;
    const fq = await ctx.api("POST", `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
      { intentKey, firstQuestion: question }, 60_000);
    if (fq.status !== 200 || fq.body?.dispatch !== "succeeded") {
      throw new Error(`material-first-question HTTP ${String(fq.status)} dispatch ${String(fq.body?.dispatch)}: ${JSON.stringify(fq.body?.error ?? null)}`);
    }
    const anchorTurnId = fq.body?.landed?.assistantTurnId ?? null;
    if (anchorTurnId === null) throw new Error(`first question landed no assistant turn: ${JSON.stringify(fq.body)}`);
    const answerText = fq.body?.outcome?.assistantTurn?.text ?? null;
    if (typeof answerText !== "string" || answerText.length === 0) {
      throw new Error(`first question outcome carries no assistant text: ${JSON.stringify(fq.body?.outcome === null ? null : "outcome-present")}`);
    }

    /* 批注（术语面真实 API）：锚定首问回答（assistant turn），选区必须与
     *  回答文本的给定偏移切片逐字一致（锚定完整性），正文携带探针标记。 */
    let annoEnd = Math.min(12, answerText.length);
    while (annoEnd > 0 && (answerText.charCodeAt(annoEnd - 1) & 0xfc00) === 0xd800) annoEnd -= 1;
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/terminology/annotations`, {
      branchId, anchorTurnId,
      selection: { start: 0, end: annoEnd, text: answerText.slice(0, annoEnd) },
      mode: "range",
      term: "搜索探针术语",
      explanation: `这是搜索探针创建的批注解释（${SEARCH_PROBE_MARKERS.annotation}），用于浏览器面跳转验证。`,
    }, "annotation save");

    /* Return（材料 Branch 的收获回主线，真实 submitReturn 底层）。 */
    await searchProbeApi(ctx, "POST", `/api/trees/${encodeURIComponent(treeId)}/material-return`, {
      fromBranchId: branchId,
      text: `材料探索的收获：这一段讲了核心论点（${SEARCH_PROBE_MARKERS.ret}）。`,
      idempotencyKey: "browser-search-probe-return-1",
    }, "material-return");

    /* 第二棵树 + 跨树专属语料：探针自产唯一短语材料（d4-read-and-select
     * 把 B2 全分母（12 md + 12 PDF，含 md-02）铺进了场景树——md-02 已两树
     * 皆有，不能再当跨树判别词；改为只进第二棵树的探针专属材料，其短语
     * 全局唯一：当前树范围必须零命中、全部树范围必须命中）。 */
    let tree2Id = ctx.scenario.searchTree2Id ?? null;
    if (tree2Id === null) {
      const created = await searchProbeApi(ctx, "POST", "/api/trees", undefined, "create tree 2");
      tree2Id = created.body?.tree?.id ?? null;
      if (tree2Id === null) throw new Error("tree 2 creation returned no id");
      const tree2Marker = `TreeAI-搜索探针-跨树语料-c93e`;
      const tree2Bytes = utf8BytesOf(
        `# 跨树范围探针语料\n\n${tree2Marker}：这一段只存在于第二棵树——当前树范围搜索必须零命中，全部树范围必须命中本材料。\n`,
      );
      const res = await importMaterialViaHttp(ctx, tree2Id, "search-probe-tree2-corpus.md", tree2Bytes);
      if (res.status !== 201) throw new Error(`tree-2 corpus import HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
      await waitForVersionReady(ctx, tree2Id, res.body.material.id, res.body.version.id, "search-probe-tree2-corpus");
      ctx.scenario.searchTree2Id = tree2Id;
      ctx.scenario.searchTree2Phrase = tree2Marker;
    }
    ctx.scenario.searchCorpus = true;
  }
  return {
    treeId,
    tree2Id: ctx.scenario.searchTree2Id ?? null,
    md06Excerpt: ctx.scenario.searchMd06Excerpt ?? null,
  };
}

/** 真实 UI 搜索：点击范围开关 → 清空并注入查询（CDP insertText）→ 点击
 *  Search → 等待状态行落定 → 返回命中行（真实 DOM 读出）。 */
export async function runUiSearch(ctx, query, scope) {
  const scopeButton = scope === "tree" ? "#search-scope-tree" : "#search-scope-all";
  await inputClickAt(ctx, scopeButton);
  await ctx.evalJs(`(() => { document.getElementById("search-input").value = ""; })()`);
  await inputClickAt(ctx, "#search-input");
  await ctx.cdpSend("Input.insertText", { text: query });
  await inputClickAt(ctx, "#search-run");
  await waitFor(
    ctx,
    `(() => { const s = document.getElementById("search-status"); if (s === null) return false; ` +
      `const t = s.textContent ?? ""; return t.includes("hit(s) for") || t.includes("0 hits for"); })()`,
    { label: `search settled for ${JSON.stringify(query)}`, timeoutMs: 20_000 },
  );
  return ctx.evalJs(
    `(() => { const rows = [...document.querySelectorAll("#search-results button.search-hit")]; ` +
      `return { status: document.getElementById("search-status").textContent, ` +
        `rows: rows.map((row) => ({ kind: row.querySelector(".search-hit-kind")?.textContent ?? "", ` +
          `title: row.querySelector(".search-hit-title")?.textContent ?? "", ` +
          `meta: row.querySelector(".search-hit-meta")?.textContent ?? "", ` +
          `excerpt: row.querySelector(".search-hit-excerpt")?.textContent ?? "" })) }; })()`,
  );
}

export async function probeSearchRecover(ctx) {
  const { treeId, tree2Id } = await ensureSearchCorpus(ctx);
  ctx.noteFixturesUsed(["md-01", "md-vpair-v1", "md-vpair-v2"]);
  const md01 = ctx.scenario.materials["md-01"];
  const problems = [];

  /* 前置：页面停在本树（后续跳转断言以本树为当前树）。 */
  await ctx.navigate(ctx.studioUrl());
  await waitFor(ctx, `(() => { const s = document.getElementById("materials-section"); return s !== null && !s.hidden; })()`, { label: "workbench with the corpus tree open" });

  /* 1) 材料·旧版本命中：v1 独有短语 → 命中行标注「旧版本」→ 点击 → 打开
   *    命中版本（v1）的只读阅读面。 */
  const oldVersion = await runUiSearch(ctx, SEARCH_PROBE_V1_ONLY, "tree");
  const oldHit = oldVersion.rows.find((row) => row.kind === "材料" && row.meta.includes("旧版本")) ?? null;
  if (oldHit === null) {
    problems.push(`旧版本材料命中未出现（status=${JSON.stringify(oldVersion.status)}，rows=${JSON.stringify(oldVersion.rows.slice(0, 3))}）`);
  } else {
    const hitIndex = oldVersion.rows.indexOf(oldHit);
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")][${String(hitIndex)}].click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => { const root = document.getElementById("material-reader"); ` +
        `return root !== null && !root.hidden && (root.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_V1_ONLY)}); })()`,
      { label: "old-version hit jump opens the reader at the hit version" },
    );
    await ctx.screenshot("search-oldversion-jump");
  }

  /* 2) 批注命中 → 锚定视图 + 批注卡（正文含标记）。 */
  const anno = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.annotation, "tree");
  const annoHit = anno.rows.find((row) => row.kind === "批注") ?? null;
  if (annoHit === null) {
    problems.push(`批注命中未出现（status=${JSON.stringify(anno.status)}，rows=${JSON.stringify(anno.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "批注").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.annotation)}))()`,
      { label: "annotation hit jump reveals the saved annotation" },
    );
    await ctx.screenshot("search-annotation-jump");
  }

  /* 3) Return 命中 → 主线 Return 卡。 */
  const ret = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.ret, "tree");
  const retHit = ret.rows.find((row) => row.kind === "Return") ?? null;
  if (retHit === null) {
    problems.push(`Return 命中未出现（status=${JSON.stringify(ret.status)}，rows=${JSON.stringify(ret.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "Return").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.ret)}))()`,
      { label: "return hit jump reveals the saved return" },
    );
    await ctx.screenshot("search-return-jump");
  }

  /* 4) 对话命中（首问 turn）→ 点击跳转，正文标记可见。 */
  const turn = await runUiSearch(ctx, SEARCH_PROBE_MARKERS.question, "tree");
  const turnHit = turn.rows.find((row) => row.kind === "对话") ?? null;
  if (turnHit === null) {
    problems.push(`对话命中未出现（status=${JSON.stringify(turn.status)}，rows=${JSON.stringify(turn.rows.slice(0, 3))}）`);
  } else {
    await ctx.evalJs(`(() => { [...document.querySelectorAll("#search-results button.search-hit")].find((b) => b.querySelector(".search-hit-kind")?.textContent === "对话").click(); return true; })()`);
    await waitFor(
      ctx,
      `(() => (document.body.textContent ?? "").includes(${JSON.stringify(SEARCH_PROBE_MARKERS.question)}))()`,
      { label: "turn hit jump reveals the first-question turn" },
    );
    await ctx.screenshot("search-turn-jump");
  }

  /* 5) 无结果不编造。 */
  const none = await runUiSearch(ctx, "zzq-不存在于任何已保存事实的词-qxz", "tree");
  if (none.rows.length !== 0 || !(none.status ?? "").includes("0 hits")) {
    problems.push(`无结果查询不诚实（rows=${String(none.rows.length)}，status=${JSON.stringify(none.status)}）`);
  }

  /* 6) 当前树/全部树范围：跨树语料只在第二棵树（探针自产唯一短语材料）——
        当前树零命中、全部树命中。 */
  if (tree2Id !== null) {
    const crossTreePhrase = ctx.scenario.searchTree2Phrase;
    const inTree = await runUiSearch(ctx, crossTreePhrase, "tree");
    if (inTree.rows.length !== 0) {
      problems.push(`当前树范围泄漏跨树命中（跨树语料只在第二棵树：rows=${JSON.stringify(inTree.rows.slice(0, 3))}）`);
    }
    const inAll = await runUiSearch(ctx, crossTreePhrase, "all");
    if (inAll.rows.length === 0) {
      problems.push(`全部树范围未命中第二棵树的跨树语料（query=${JSON.stringify(crossTreePhrase)}，status=${JSON.stringify(inAll.status)}）`);
    }
  }

  assertNoPageErrors(ctx, { label: "d4-search-recover" });
  await ctx.sidecar("search-recover", {
    check: "d4-search-recover",
    treeId, tree2Id,
    markers: SEARCH_PROBE_MARKERS,
    problems,
    corpus: { md01: { materialId: md01.materialId, versionId: md01.versionId }, vpairMaterialId: ctx.scenario.searchVpairMaterialId ?? null },
  });
  if (problems.length > 0) {
    throw new Error(`d4-search-recover browser-face problems — ${problems.join("; ")}`);
  }
  return { detail: `5 类命中（材料·旧版本/批注/Return/对话）+ 无结果诚实 + 当前树/全部树范围，语料 md-01 + md-vpair + tree-2 探针自产跨树语料` };
}
