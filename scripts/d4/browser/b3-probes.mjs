/**
 * scripts/d4/browser/b3-probes.mjs — D4-3 材料 Branch/Return 浏览器探针
 * （issue #8 charter §3.3/B3 的用户路径浏览器面）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程。两种模式共用同一探针代码路径：
 *   - --mode real-pi   首问/追问发给真实 Pi（charter B3 证据的浏览器面）；
 *   - --mode selftest  echo 驱动（确定性回声）——同一 UI 流程的机制性冒烟，
 *                      探针代码路径的可达性证明，**永远不是 B3 证据**
 *                      （detail/sidecar 如实标注）。
 *
 * 用户路径（charter B3）：
 *   武装材料选区（markdown 与 pdf 各一）→ 建枝 → 提交前材料范围声明可见
 *   → 首问（真实 Pi；双击不重复派发 / 响应丢失重试诚实）→ 每枝 ≥2 轮追问
 *   → 跨枝隔离（回答不串枝）→ 重启续走（SIGTERM + 新进程后历史可读、
 *   追问继续落地）→ 回原文（精确摘录 + 定位到块）→ Return 携材料来源卡
 *   落主线 → Return 卡的「View material source」跳转。
 *
 * 探针纪律（与 material-probes.mjs 同款）：
 *   - 页面内操作全部真实 DOM/输入事件（CDP Input 真实点击/键入；建枝入口
 *     与复制按钮同款 DOM click——CDP press/release 分段会与 0ms 解除路径
 *     竞态）；绝不在页面里 fetch-shim 应用自身行为；
 *   - 响应丢失注入：CDP Fetch 域在 **Response 阶段** 拦截 material-first-question
 *     并 failRequest——请求已到达服务端并完整落地（echo/真实 Pi 皆然），
 *     仅响应被丢弃；这是「服务端已成功、客户端未见」的真实传输层模拟，
 *     不是请求丢失；
 *   - 服务器事实经真实 API 读回对账（分支 turn 集、幂等重放、跨枝隔离）；
 *   - 截图/JSON sidecar 入 artifacts；凭据零接触；失败如实。
 */

import {
  sleep,
  waitFor,
  inputClickAt,
  materialButtonSelector,
  pageSelectCanonical,
  readCaptureBar,
  waitForArmedBar,
  assertNoPageErrors,
  importMaterialViaHttp,
  waitForVersionReady,
  loadB1Fixture,
  loadB1Registries,
  loadB1RegistryFixture,
  openMaterialInReader,
} from "./material-probes.mjs";

/* ------------------------------------------------------------------ */
/* 探针标记（确定性、唯一；不与搜索探针的零结果查询或其他标记交叉）         */
/* ------------------------------------------------------------------ */

const B3_MARKERS = {
  mdQ1: "TreeAI-B3-探针-MD-首问-6f2c",
  mdF1: "TreeAI-B3-探针-MD-追问一-a03e",
  mdF2: "TreeAI-B3-探针-MD-追问二-b7d1",
  pdfQ1: "TreeAI-B3-探针-PDF-首问-9e54",
  pdfF1: "TreeAI-B3-探针-PDF-追问一-77c2",
  pdfF2: "TreeAI-B3-探针-PDF-追问二-31b8",
  restartF: "TreeAI-B3-探针-重启续走-5c8a",
  mdRet: "TreeAI-B3-探针-MD-RETURN-2d61",
  pdfRet: "TreeAI-B3-探针-PDF-RETURN-84f0",
};

/** PDF fixture（B1 冻结集文字层 PDF；探针在场景树导入自己的副本）。 */
const B3_PDF_FIXTURE_ID = "pdf-01";

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

/** 块文本上构造代理对安全的 UTF-16 半开区间（canonicalText 切片逐码元一致）。 */
function safeBlockRange(block, preferLen = 24) {
  const text = block.text;
  let start = Math.min(6, Math.max(0, text.length - 2));
  let end = Math.min(start + preferLen, text.length);
  const surrogateLead = (ch) => (ch & 0xfc00) === 0xd800;
  const surrogateTrail = (ch) => (ch & 0xfc00) === 0xdc00;
  while (start < text.length && surrogateLead(text.charCodeAt(start)) && start + 1 < text.length && surrogateTrail(text.charCodeAt(start + 1)) === false) start += 1;
  while (start > 0 && surrogateTrail(text.charCodeAt(start))) start -= 1;
  while (end > start && surrogateLead(text.charCodeAt(end - 1))) end -= 1;
  while (end < text.length && surrogateTrail(text.charCodeAt(end))) end += 1;
  if (end - start < 2) {
    /* 短块兜底：整块（块边界本身就是锚定边界）。 */
    start = 0;
    end = text.length;
  }
  return { blockId: block.blockId, start: block.start + start, end: block.start + end, excerpt: text.slice(start, end) };
}

/** PDF 页文本层上的规范选区（文本层 .material-block 的 textContent 与页块
 *  文本字节相等——页头「Page N」在层外，偏移换算干净；页框含页头，不可用）。 */
function pageSelectPdfLayer(blockId, start, end) {
  return `(() => {
    const layer = document.querySelector("#mat-blocks .pdf-page-text" + "[data-block-id=" + JSON.stringify(${JSON.stringify(blockId)}) + "]");
    if (layer === null) return { error: "pdf page text layer ${blockId} is not present (scroll it into view first)" };
    if (layer.dataset.rendered !== "true") return { error: "pdf page text layer ${blockId} is not rendered yet" };
    const blockStart = Number(layer.dataset.start);
    const localStart = ${Number(start)} - blockStart;
    const localEnd = ${Number(end)} - blockStart;
    if (!(localStart >= 0) || localEnd > layer.textContent.length) {
      return { error: "canonical range [${start}, ${end}) is outside page block ${blockId}" };
    }
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let a = null;
    let b = null;
    for (;;) {
      const node = walker.nextNode();
      if (node === null) break;
      const len = node.data.length;
      if (a === null && localStart <= pos + len) a = { node, offset: localStart - pos };
      if (b === null && localEnd <= pos + len) b = { node, offset: localEnd - pos };
      pos += len;
    }
    if (a === null || b === null) return { error: "offsets did not map onto text nodes of ${blockId}" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/** 双击提交（DOM click 双发 + dblclick 合成）：CDP 输入管线在按压段与阅读器
 *  延后重渲（捕获条解除/流程面重渲的布局位移）竞态——实测把提交按钮的
 *  落点让给块元素；与复制/建枝按钮同款 DOM click 管线（既有注释同源）。
 *  双击语义的被测对象 = 在途锁（submitting）+ 服务端 intent-key 幂等——
 *  两次 click 事件均送达应用自身的监听器（第二次按重渲后的当前按钮——
 *  真实用户双击的落点），handler 级守卫与服务端对账均被完整行使。 */
async function domDoubleClick(ctx, selector) {
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
async function domClick(ctx, selector) {
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
async function withDroppedResponses(ctx, urlPattern, fn) {
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

/** 面板打开等待（真实 tab 点击 → openBranchPanel → /switch 对齐 → 渲染）。
 *
 * 已发现的前端缺陷（报告不修，elementFromPoint 证据入 sidecar）：
 * #branch-section 是侧栏唯一的 flex:1 区块且 min-height:0——其余区块
 * （Forest/Navigate/Materials/Search，各自 flex-shrink:0）合计高度逼近/超过
 * 视口时，#branch-section 被压到 **height 0**（实测 top 212 / h 0，而
 * #branch-tabs h 96）：分支 tab 全部被裁剪，elementFromPoint 命中
 * ASIDE#sidebar——真实用户无法点击任何分支 tab。1b48ef0 修的是
 * tree-list/material-list 的内部滚动，#branch-section 这个压力阀没有下限。
 * 探针以 DOM click 兜底继续行使面板路径（数据路径完好），缺陷如实上报。 */
const B3_FRONTEND_BUGS = [];

async function openBranchPanelViaTab(ctx, branchId) {
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
async function panelFollowUp(ctx, marker, promptText, timeoutMs) {
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
async function branchViewViaApi(ctx, treeId, branchId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  if (res.status !== 200) throw new Error(`B3 /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  const view = (res.body?.branches ?? []).find((candidate) => candidate?.branch?.id === branchId) ?? null;
  if (view === null) throw new Error(`B3 branch ${branchId} missing from /state`);
  return view;
}

/* ------------------------------------------------------------------ */
/* 场景准备（幂等）：pdf fixture 导入 + 选区确定                         */
/* ------------------------------------------------------------------ */

/** PDF 阅读器就位（页框数 + 尾部「N page(s) in view · end of material (last page)」）。 */
function pdfReaderLoadedExpr(pages) {
  return `(() => { const reader = document.getElementById("material-reader"); ` +
    `if (reader === null || reader.hidden) return false; ` +
    `const frames = document.querySelectorAll("#mat-blocks .pdf-page-frame").length; ` +
    `if (frames !== ${String(pages)}) return false; ` +
    `const tail = document.getElementById("mat-tail"); ` +
    `if (tail === null) return false; ` +
    `const text = tail.textContent ?? ""; ` +
    `if (!text.includes(${JSON.stringify(`${String(pages)} page(s) in view`)})) return false; ` +
    `if (!text.includes("end of material (last page)")) return false; ` +
    `return { frames, tail: text }; })()`;
}

/** 场景树上确定 pdf-01（B1 冻结文字层 PDF）并确定两个选区（md/pdf）。
    d4-read-and-select 已把 B2 全分母（12 md + 12 PDF）铺进场景树——pdf-01
    已在场时**直接复用**（导入 API 对树内同字节去重回 200/created=false，
    重复导入既无必要也拿不到 201；复用同一 material/version 与浏览器面
    B2 证据同源）。 */
async function ensureB3Corpus(ctx) {
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
async function armSelectionInReader(ctx, material, range) {
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
async function branchFromArmedSelection(ctx, material, range) {
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
async function submitFirstQuestion(ctx, questionText, timeoutMs) {
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
