import { runBetaCleanBoot } from "./beta/clean-boot.mjs";
import { runBetaMaterialsBranch } from "./beta/materials-branch.mjs";
import { runBetaLayout } from "./beta/layout.mjs";
import { runBetaTouch } from "./beta/touch.mjs";
import { runBetaReducedMotion } from "./beta/reduced-motion.mjs";
import { runBetaKeyboard } from "./beta/keyboard.mjs";
import { runBetaFocusDrafts } from "./beta/focus-drafts.mjs";
import { exposeInputTarget } from "./material/input.mjs";
/**
 * scripts/d4/browser/beta-usability-probes.mjs — D4 B7 自动部分浏览器探针
 * （issue #8 charter §6 B7「Beta 可用性」的 run:d4-browser 面）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程（selftest=echo 驱动；real-pi=真实 Pi）。探针自足：
 * 专用临时数据目录（真实 README 启动路径冷启）+ 场景语料（B1 冻结
 * md-11 与 pdf-01 经真实导入 API）+ 材料 Branch（真实 UI 建枝 + 首问/
 * 追问，echo 或真实 Pi）。六组场景（charter B7 行的自动可执行面）：
 *
 *   - cleanBoot：按 README「Studio (D3 MVP) — local install & start」文档
 *     的启动路径在干净临时目录冷启（runner 的 studioArgv 与 README/
 *     package.json start 脚本逐项对账）；首启空状态诚实（无树/无材料/
 *     建树流程可用——真实点击建树即证据）。
 *   - wideNarrow：≥1440px 宽与 ~390×844 窄（CDP Emulation.
 *     setDeviceMetricsOverride；窄档 mobile 触屏视口）两档：侧栏/阅读器/
 *     支线面板可用（关键控件 elementFromPoint 命中）、主内容无横向溢出、
 *     捕获条可达；窄档侧栏抽屉经 #sidebar-toggle 开合。
 *   - keyboard：Tab 遍历到达主要控件（新建树/材料导入/搜索输入/阅读器
 *     正文容器）+ Enter/Space 激活 + Escape 分层关闭（抽屉→阅读器→面板，
 *     每层焦点还原）+ 焦点样式可见（computed :focus-visible outline）+
 *     阅读器方向键滚动 + 无焦点陷阱（遍历序列全程在元素上）。
 *   - touch：CDP Input.dispatchTouchEvent——tap 开侧栏抽屉/开材料阅读/
 *     tap 捕获条按钮（复制剪贴板回读字节相等）、swipe 滚动阅读器、
 *     文本层上拖选武装捕获条（app 的触路径是 selectionchange 武装——
 *     选区在触摸手势进行中建立、全程零鼠标事件；headless Chrome 153 的
 *     原生长按/拖动不合成持久选区，实测记录后以平台 Selection API 在
 *     手势内置位，armed 断言不受影响，如实披露）。
 *   - reducedMotion：Emulation.setEmulatedMedia prefers-reduced-motion:
 *     reduce → 页面 matchMedia 为真；触发定位跳转（面板 ⌖ View source →
 *     阅读器开于锚定块）断言即时落位（MutationObserver 微任务时刻的
 *     scrollTop 已是终位 + 后续 rAF 帧无在途位移）；附贴底跟随滚动的
 *     对照测量（无 reduce 时如实记录，不设平滑断言）。
 *   - focusScrollDraft：支线面板输入草稿问题（不提交）→ 面板 ⌖ View
 *     source（离开，阅读器开于锚定块并下滚数屏）→ Esc 回支线：草稿
 *     文本保留 + 焦点还原（#panel-view-source）+ 面板滚动位置保留；
 *     阅读器经材料列表按钮重开 → 恢复到关闭时的保存块（应用自身的
 *     阅读位置保存/恢复路径，会话内回程；重启场景归 d4-restart-continue）。
 *
 * 探针纪律（与 material-probes.mjs 同款）：页面内操作全部真实 DOM/输入
 * 事件（CDP Input 鼠标/键盘/触摸、真实 insertText）；绝不在页面里
 * fetch-shim 应用自身行为；导入走真实 HTTP API；截图/JSON sidecar 入
 * artifacts；凭据零接触；失败如实（label + 具体 mismatch，绝不吞错）。
 *
 * 诚实边界：本探针是 B7 的**自动部分**——宽窄窗/键盘/触屏/reduced-motion/
 * 回程的机制性检查。Mac 体验签收与 3–5 人逐人试用属负责人 D4-G3 人工
 * 序列，本探针的 PASS 不构成 B7 全过。
 */

import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join, resolve } from "node:path";

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
} from "./material-probes.mjs";

/* ------------------------------------------------------------------ */
/* 冻结常量                                                             */
/* ------------------------------------------------------------------ */

const MD_FIXTURE_ID = "md-11"; /* 59 块长文：懒加载/滚动/阅读位置 */
const PDF_FIXTURE_ID = "pdf-01"; /* 2 页文字层 PDF：触屏拖选 */

const WIDE_VIEWPORT = { width: 1600, height: 900 }; /* ≥1440px 宽档 */
const NARROW_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }; /* ~390×844 窄档（触屏） */
const DEFAULT_VIEWPORT = { width: 1280, height: 900 }; /* runner 缺省，探针结束时还原 */

const BETA_MARKERS = {
  q1: "TreeAI-B7-探针-首问-3f8a",
  f1: "TreeAI-B7-探针-追问一-c41d",
  fControl: "TreeAI-B7-探针-贴底对照-e902",
  fReduce: "TreeAI-B7-探针-reduce-57b3",
  draft: "TreeAI-B7-探针-草稿-d6e4",
};

/* 横向溢出容差（亚像素取整）。 */
const OVERFLOW_X_TOLERANCE_PX = 1;
/* 即时落位断言容差（scrollTop 已在终位 ±2px）。 */
const IMMEDIATE_ARRIVAL_TOLERANCE_PX = 2;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

async function setViewport(ctx, viewport) {
  await ctx.cdpSend("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    mobile: viewport.mobile ?? false,
  });
  await sleep(350);
}

/** 真实触摸 tap（touchStart + touchEnd 于同一点）。 */
async function touchTap(ctx, x, y) {
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(50);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** 真实触摸 swipe（touchStart → touchMove×N → touchEnd；位移分步送达）。 */
async function touchSwipe(ctx, { x, y, dx, dy, steps = 8, holdMs = 35 }) {
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= steps; i += 1) {
    await sleep(holdMs);
    await ctx.cdpSend("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }],
    });
  }
  await sleep(70);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** 真实按键（keyDown + keyUp）。Enter 激活 button 需携带 text 载荷
    （CDP 合成键事件的默认动作路径——实测无 text 时 Enter 不触发
    button 点击；Tab/Escape/Space/方向键不受影响）。 */
async function pressKey(ctx, key, code, vk, { modifiers = 0, text = undefined } = {}) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text !== undefined ? { text } : {}) });
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(90);
}

/** 命中探测：元素中心 elementFromPoint 是否落在元素（或其子元素）内。 */
async function hitTest(ctx, selector) {
  await exposeInputTarget(ctx, selector);
  const state = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return { missing: true }; ` +
      `if (el.hidden === true) return { missing: true, hidden: true }; ` +
      `const r = el.getBoundingClientRect(); ` +
      `if (r.width <= 0 || r.height <= 0) return { missing: true, zeroRect: true }; ` +
      `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
      `if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return { missing: true, outside: true, rect: { left: r.left, top: r.top, w: r.width, h: r.height } }; ` +
      `const hit = document.elementFromPoint(x, y); ` +
      `return { x, y, hit: hit !== null && (hit === el || el.contains(hit)) }; })()`,
  );
  return state;
}

/** 断言一组关键控件全部命中（逐个如实收集，缺一即失败）。 */
async function assertHits(ctx, selectors, label) {
  const results = {};
  const problems = [];
  for (const [name, selector] of Object.entries(selectors)) {
    const state = await hitTest(ctx, selector);
    results[name] = state?.hit === true ? true : state;
    if (state?.hit !== true) problems.push(`${name} (${selector}): ${JSON.stringify(state)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${label} — key controls not hit-testable: ${problems.join("; ")}`);
  }
  return results;
}

/** 横向溢出读数（documentElement + body 口径）。 */
async function readOverflowX(ctx) {
  return ctx.evalJs(
    `(() => ({ documentElement: document.documentElement.scrollWidth - document.documentElement.clientWidth, ` +
      `body: document.body.scrollWidth - document.body.clientWidth, innerWidth: window.innerWidth }))()`,
  );
}

async function assertNoHorizontalOverflow(ctx, label) {
  const overflow = await readOverflowX(ctx);
  if (overflow.documentElement > OVERFLOW_X_TOLERANCE_PX) {
    throw new Error(`${label}: horizontal overflow ${String(overflow.documentElement)}px > ${String(OVERFLOW_X_TOLERANCE_PX)}px (${JSON.stringify(overflow)})`);
  }
  return overflow;
}

/** 窄档侧栏抽屉滑入静置（220ms transform 过渡——类翻转 ≠ 几何就位）。 */
async function waitForDrawerSettled(ctx) {
  await waitFor(
    ctx,
    `(() => { if (!document.body.classList.contains("sidebar-open")) return false; ` +
      `const b = document.getElementById("new-tree"); const r = b.getBoundingClientRect(); ` +
      `return r.left >= 0 && r.right <= window.innerWidth && r.width > 0; })()`,
    { label: "the narrow sidebar drawer finished its slide-in", timeoutMs: 6000 },
  );
}

/** 窄档侧栏抽屉滑出静置（visibility 的 0s/220ms 延迟翻转——类移除后抽屉
    仍覆盖主区至过渡结束；此窗口内 elementFromPoint 命中抽屉而非目标）。 */
async function waitForDrawerDismissed(ctx) {
  await waitFor(
    ctx,
    `(() => { if (document.body.classList.contains("sidebar-open")) return false; ` +
      `return getComputedStyle(document.getElementById("sidebar")).visibility === "hidden"; })()`,
    { label: "the narrow sidebar drawer finished its slide-out", timeoutMs: 6000 },
  );
}

/** DOM click（与 b3 探针同款管线——0ms 解除路径与 CDP press/release 分段竞态）。 */
async function domClick(ctx, selector) {
  const clicked = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
  );
  if (clicked !== true) throw new Error(`click target not found: ${selector}`);
}

/** activeElement 概要（id 优先，退而求其次 tag+class）。 */
const ACTIVE_EL_EXPR = `(() => { const a = document.activeElement; ` +
  `if (a === null || a === document.body) return null; ` +
  `return { id: a.id === "" ? null : a.id, tag: a.tagName, cls: String(a.className).slice(0, 50), ` +
    `insideReader: a.closest("#material-reader") !== null }; })()`;

/** 块文本上构造代理对安全的 UTF-16 半开区间（与 b3 探针同款逻辑）。 */
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
    start = 0;
    end = text.length;
  }
  return { blockId: block.blockId, start: block.start + start, end: block.start + end, excerpt: text.slice(start, end) };
}

/** PDF 页文本层上的规范选区（与 b3 探针同款；文本层 textContent 与页块字节相等）。 */
function pdfLayerSelectExpr(blockId, start, end) {
  return `(() => {
    const layer = document.querySelector("#mat-blocks .pdf-page-text[data-block-id=" + JSON.stringify(${JSON.stringify(blockId)}) + "]");
    if (layer === null) return { error: "pdf page text layer ${blockId} is not present" };
    if (layer.dataset.rendered !== "true") return { error: "pdf page text layer ${blockId} is not rendered yet" };
    const blockStart = Number(layer.dataset.start);
    const localStart = ${Number(start)} - blockStart;
    const localEnd = ${Number(end)} - blockStart;
    if (!(localStart >= 0) || localEnd > layer.textContent.length) {
      return { error: "canonical range [${start}, ${end}) is outside page block ${blockId}" };
    }
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let pos = 0, a = null, b = null;
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
    const r = range.getBoundingClientRect();
    return { selectedText: selection.toString(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

/** 触摸手势进行内置位选区（app 的触路径：selectionchange 武装，零鼠标事件）。
    手势坐标取选区中点（拖选语义）。 */
async function touchDragSelect(ctx, placementExpr) {
  // Resolve a real text-layer hit point, then clear the probe's initial
  // selection: it must be created *during* touch, not before touchStart.
  // Otherwise Chrome can clear it on touchEnd before selectionchange arms
  // the reader, which does not model a user dragging text on a touch screen.
  let point = await ctx.evalJs(placementExpr);
  if (point === null || point.error !== undefined) {
    throw new Error(`touch-drag selection could not be placed — ${JSON.stringify(point)}`);
  }
  await ctx.evalJs(`(() => { const selection = window.getSelection(); window.__betaTouchRange = selection.getRangeAt(0).cloneRange(); selection.removeAllRanges(); return true; })()`);
  await sleep(120);
  point = await ctx.evalJs(`(() => { const range = window.__betaTouchRange.cloneRange(); const start = range.startContainer; start.parentElement?.scrollIntoView({block:'center',inline:'center'}); if (start.nodeType === Node.TEXT_NODE && range.startOffset < start.textContent.length) range.setEnd(start, range.startOffset + 1); const rect = range.getClientRects()[0] ?? range.getBoundingClientRect(); const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, inReader: !!hit?.closest('#mat-blocks'), hit: hit?.id || hit?.className || null }; })()`);
  if (point.inReader !== true) throw new Error(`touch-drag target moved outside the material text after clearing the initial selection: ${JSON.stringify(point)}`);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await sleep(60);
  const placed = await ctx.evalJs(placementExpr);
  if (placed === null || placed.error !== undefined) {
    await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    throw new Error(`touch-drag selection failed during active touch — ${JSON.stringify(placed)}`);
  }
  const stillSelected = await ctx.evalJs(`(() => String(window.getSelection()))()`);
  await sleep(80);
  const barDuring = await readCaptureBar(ctx);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(120);
  const afterRelease = await ctx.evalJs(`(() => String(window.getSelection()))()`);
  return { placed, stillSelected, barDuring, afterRelease };
}

/** README「Studio (D3 MVP) — local install & start」段解析（运行时读取，
    绝不内嵌副本——与文档漂移即失败）。 */
function readReadmeStudioSection(root) {
  const text = readFileSync(join(root, "README.md"), "utf8");
  // The R5 README keeps the actual CLI instructions but uses a shorter heading.
  // Accept both historical and current section names; verify commands and flags
  // against the real studio executable below rather than locking old prose.
  const headings = ["## Run locally", "## Studio (D3 MVP) — local install & start"];
  const heading = headings.find((h) => text.includes(h));
  if (heading === undefined) throw new Error(`README.md has no local Studio install/start section (expected one of ${headings.join(", ")})`);
  const start = text.indexOf(heading);
  const next = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, next < 0 ? undefined : next);
  const codeBlocks = [...section.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].map((m) => m[1]);
  const commandLines = codeBlocks.flatMap((block) => block.split("\n"))
    .map((l) => l.trim()).map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const startCommand = commandLines.find((l) => l === "npm run start --workspace @treeai/studio") ?? null;
  const installCommand = commandLines.find((l) => l === "npm ci") ?? null;
  const optionsLine = section.split("\n").map((l) => l.trim()).find((l) => l.startsWith("Options:"))
    ?? commandLines.find((l) => l.includes("npm run start") && l.includes("--port") && l.includes("--data")) ?? null;
  return { heading, startCommand, installCommand, optionsLine, urlLine: /http:\/\/127\.0\.0\.1:\d+/.exec(section)?.[0] ?? null };
}

/* ------------------------------------------------------------------ */
/* 探针：d4-beta-usability                                              */
/* ------------------------------------------------------------------ */

export async function probeBetaUsability(ctx) {
  const modeNote = ctx.MODE === "selftest"
    ? "echo driver (deterministic answers) — mechanism evidence, not real-Pi behavior"
    : "real Pi answers";
  const answerTimeoutMs = ctx.MODE === "selftest" ? 30_000 : Math.max(60_000, ctx.promptTimeoutMs());

  /* —— 0) README / package.json 事实（运行时读取）+ 冻结 fixture —— */
  const readme = readReadmeStudioSection(ctx.ROOT);
  const studioPkg = JSON.parse(readFileSync(join(ctx.ROOT, "apps", "studio", "package.json"), "utf8"));
  const mdFixture = loadB1Fixture(ctx.ROOT, MD_FIXTURE_ID);
  const registries = loadB1Registries(ctx.ROOT);
  const pdfRegistry = registries.find((registry) => registry.kind === "pdf");
  if (pdfRegistry === undefined) throw new Error("beta probe: no pdf registry in tests/fixtures/d4/b1-import");
  const pdfEntry = pdfRegistry.fixtures.find((candidate) => candidate.fixtureId === PDF_FIXTURE_ID);
  if (pdfEntry === undefined) throw new Error(`beta probe: fixture ${PDF_FIXTURE_ID} missing from the pdf registry`);
  const pdfFixture = loadB1RegistryFixture(ctx.ROOT, pdfEntry, "pdf-registry.json");
  ctx.noteFixturesUsed([MD_FIXTURE_ID, PDF_FIXTURE_ID]);

  const cpus = os.cpus();
  const environment = {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch}`,
    cpu: `${String(cpus.length)}× ${cpus[0]?.model ?? "unknown"}`,
    totalMemoryGiB: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1)),
    loadavgAtStart: os.loadavg().map((v) => Number(v.toFixed(2))),
    honestyNote:
      "automated part of charter B7 only (clean-boot/wide-narrow/keyboard/touch/reduced-motion/focus-scroll-draft); " +
      "the Mac sign-off and the 3–5 person trials remain the owner's D4-G3 human sequence — this probe passing is NOT B7 complete",
  };

  /* 触摸事件计数（sidecar 的可审计度量）。 */
  const touchStats = { taps: 0, swipes: 0, dragSelects: 0 };
  const tapAt = async (x, y) => { touchStats.taps += 1; await touchTap(ctx, x, y); };
  const swipeAt = async (opts) => { touchStats.swipes += 1; await touchSwipe(ctx, opts); };

  /* 场景状态（cleanBoot 建树后回填；后续相位共用）。 */
  const scenarioSetup = {};

  /* 选区（确定性）：md-11 中段块；pdf-01 第 2 页块。 */
  const mdBlocks = mdFixture.truth.blocks;
  const mdRange = safeBlockRange(mdBlocks[8]);
  const pdfRange = safeBlockRange(pdfFixture.truth.blocks[1]);

  const dataDir = mkdtempSync(join(tmpdir(), "treeai-d4-beta-browser-"));

  try {
    /* ============ 1) cleanBoot：README 干净环境启动 + 首启空状态诚实 ============ */
    const cleanBoot = {};
const betaCleanBoot = await runBetaCleanBoot({
  get ctx() { return ctx; },
  get dataDir() { return dataDir; },
  get studioPkg() { return studioPkg; },
  get readme() { return readme; },
  get cleanBoot() { return cleanBoot; },
  get scenarioSetup() { return scenarioSetup; },
  get MD_FIXTURE_ID() { return MD_FIXTURE_ID; },
  get mdFixture() { return mdFixture; },
  get PDF_FIXTURE_ID() { return PDF_FIXTURE_ID; },
  get pdfFixture() { return pdfFixture; },
});

const betaMaterialsBranch = await runBetaMaterialsBranch({
  get ctx() { return ctx; },
  get mdBlocks() { return mdBlocks; },
  get mdRange() { return mdRange; },
  get domClick() { return domClick; },
  get BETA_MARKERS() { return BETA_MARKERS; },
  get modeNote() { return modeNote; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get scenarioSetup() { return scenarioSetup; },
});


    const branchTabSelector = `#branch-tabs button[data-branch-id=${JSON.stringify(scenarioSetup.branchId)}]`;

    /* ============ 3) wideNarrow：宽窄两档可用 + 无横向溢出 + 捕获条可达 ============ */
    const wideNarrow = {};
const betaLayout = await runBetaLayout({
  get setViewport() { return setViewport; },
  get ctx() { return ctx; },
  get WIDE_VIEWPORT() { return WIDE_VIEWPORT; },
  get assertNoHorizontalOverflow() { return assertNoHorizontalOverflow; },
  get assertHits() { return assertHits; },
  get branchTabSelector() { return branchTabSelector; },
  get scenarioSetup() { return scenarioSetup; },
  get mdRange() { return mdRange; },
  get wideNarrow() { return wideNarrow; },
  get NARROW_VIEWPORT() { return NARROW_VIEWPORT; },
  get waitForDrawerSettled() { return waitForDrawerSettled; },
  get waitForDrawerDismissed() { return waitForDrawerDismissed; },
  get DEFAULT_VIEWPORT() { return DEFAULT_VIEWPORT; },
});


    /* ============ 4) touch：tap / swipe / 文本层拖选武装 / tap 工具条按钮 ============
       (顺序纪律：本相位先于键盘相位执行——headless Chrome 153 的 CDP 输入
       管线在 Space/Escape/无 text 的 Enter 之后不再接受原生
       Input.dispatchTouchEvent（实测复现：鼠标/eval/带 text 的键不受影响）；
       触摸之后键鼠一切正常。探针侧手势时序坑，sidecar 如实披露。) */
    const touch = { ...touchStats };
const betaTouch = await runBetaTouch({
  get setViewport() { return setViewport; },
  get ctx() { return ctx; },
  get NARROW_VIEWPORT() { return NARROW_VIEWPORT; },
  get tapAt() { return tapAt; },
  get waitForDrawerSettled() { return waitForDrawerSettled; },
  get scenarioSetup() { return scenarioSetup; },
  get waitForDrawerDismissed() { return waitForDrawerDismissed; },
  get touch() { return touch; },
  get swipeAt() { return swipeAt; },
  get pdfFixture() { return pdfFixture; },
  get pdfRange() { return pdfRange; },
  get touchStats() { return touchStats; },
  get touchDragSelect() { return touchDragSelect; },
  get pdfLayerSelectExpr() { return pdfLayerSelectExpr; },
  get DEFAULT_VIEWPORT() { return DEFAULT_VIEWPORT; },
});


    /* ============ 5) reducedMotion：matchMedia + 定位跳转即时落位 ============ */
    const reducedMotion = {};
const betaReducedMotion = await runBetaReducedMotion({
  get ctx() { return ctx; },
  get branchTabSelector() { return branchTabSelector; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get BETA_MARKERS() { return BETA_MARKERS; },
  get reducedMotion() { return reducedMotion; },
  get IMMEDIATE_ARRIVAL_TOLERANCE_PX() { return IMMEDIATE_ARRIVAL_TOLERANCE_PX; },
  get mdRange() { return mdRange; },
  get domClick() { return domClick; },
});


    /* ============ 6) keyboard：Tab 遍历 / Enter+Space / Escape / 焦点样式 / 方向键 ============ */
    const keyboard = { sequence: [] };
const betaKeyboard = await runBetaKeyboard({
  get ctx() { return ctx; },
  get scenarioSetup() { return scenarioSetup; },
  get keyboard() { return keyboard; },
  get pressKey() { return pressKey; },
  get ACTIVE_EL_EXPR() { return ACTIVE_EL_EXPR; },
  get branchTabSelector() { return branchTabSelector; },
});


    /* ============ 7) focusScrollDraft：草稿/焦点/滚动会话内回程 ============ */
    const focusScrollDraft = {};
const betaFocusDrafts = await runBetaFocusDrafts({
  get ctx() { return ctx; },
  get branchTabSelector() { return branchTabSelector; },
  get BETA_MARKERS() { return BETA_MARKERS; },
  get domClick() { return domClick; },
  get mdRange() { return mdRange; },
  get pressKey() { return pressKey; },
  get IMMEDIATE_ARRIVAL_TOLERANCE_PX() { return IMMEDIATE_ARRIVAL_TOLERANCE_PX; },
  get focusScrollDraft() { return focusScrollDraft; },
  get scenarioSetup() { return scenarioSetup; },
});


    /* ============ 收尾：纪律 + sidecar ============ */
    environment.loadavgAtEnd = os.loadavg().map((v) => Number(v.toFixed(2)));
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: () => false,
      label: "d4-beta-usability",
    });
    await ctx.screenshot("beta-usability-final");
    await ctx.sidecar("beta-usability", {
      check: "d4-beta-usability",
      mode: ctx.MODE,
      modeNote,
      environment,
      limits: {
        wideViewportMinPx: 1440,
        narrowViewport: `${String(NARROW_VIEWPORT.width)}×${String(NARROW_VIEWPORT.height)} (mobile)`,
        overflowXTolerancePx: OVERFLOW_X_TOLERANCE_PX,
        immediateArrivalTolerancePx: IMMEDIATE_ARRIVAL_TOLERANCE_PX,
      },
      betaUsability: {
        cleanBoot,
        wideNarrow,
        keyboard: {
          tabSteps: keyboard.tabSteps,
          reached: keyboard.reached,
          focusStyleVisible: keyboard.focusStyleVisible,
          arrowScroll: keyboard.arrowScroll,
          enterActivation: keyboard.enterActivation,
          spaceActivation: keyboard.spaceActivation,
          escapeLayers: keyboard.escapeLayers,
          noFocusTrap: keyboard.noFocusTrap,
          focusRetainedThroughTraversal: keyboard.focusRetainedThroughTraversal,
          focusRetainedAfterArrowScroll: keyboard.focusRetainedAfterArrowScroll,
          traversalSequence: keyboard.sequence,
        },
        touch,
        reducedMotion,
        focusScrollDraft,
      },
      scenarioSetup,
      pageErrorsExcluded: excludedCount,
      honestyNote:
        "automated part of charter B7 (clean boot per README, wide/narrow, keyboard, touch, reduced-motion, focus/scroll/draft round trip) — " +
        "the Mac sign-off and the 3–5 person trials remain the owner's D4-G3 human sequence; this PASS is NOT B7 complete. " +
        "Touch note: raw long-press/drag in headless Chrome 153 does not synthesize a persistent text selection (probed live and recorded); " +
        "the drag-select scenario places the selection via the platform Selection API during an in-progress touch gesture — the app's own " +
        "touch arming path (selectionchange, zero mouse events) is what the assertion exercises.",
    });
    return {
      detail:
        `README-documented start path booted a clean temp data dir (argv/entry/flags reconciled with README + package.json; honest empty state: ` +
        `no trees/materials, create-tree flow used for real); wide ${String(wideNarrow.wide.widthPx)}px + narrow ${String(wideNarrow.narrow.widthPx)}px (mobile) viewports: ` +
        `sidebar/reader/branch panel usable, no horizontal overflow, capture bar reachable, key controls hit-testable; keyboard: Tab traversal ` +
        `reached new-tree/import/search/reader-text in ${String(keyboard.tabSteps)} steps with visible focus outlines, Enter+Space activations, ` +
        `Escape layering with focus restoration, reader arrows scroll; touch: ${String(touch.taps)} taps + ${String(touch.swipes)} swipes + ` +
        `${String(touch.dragSelects)} in-gesture drag-select (drawer open, reader open, swipe scrolled ${String(touch.swipeScrolledPx)}px, ` +
        `pdf text-layer selection armed via selectionchange with zero mouse events, copy tap verified ${touch.copyVerification}); ` +
        `reduced-motion: matchMedia honored, View-source jump + stick-to-bottom landed immediately (no in-transit frames); ` +
        `draft round trip: draft preserved + focus restored to #panel-view-source + panel scroll kept + reader reopened at the saved block ` +
        `(in-session); ${modeNote} — automated part only, the Mac sign-off and 3–5 person trials remain the owner's D4-G3 human sequence`,
    };
  } finally {
    /* 还原缺省视口 + 清除媒体模拟（探针面对共享 Chrome 实例的纪律）。 */
    try {
      await setViewport(ctx, DEFAULT_VIEWPORT);
    } catch { /* 尽力而为 */ }
    try {
      await ctx.cdpSend("Emulation.setEmulatedMedia", { features: [] });
    } catch { /* 尽力而为 */ }
    try {
      await ctx.navigate("about:blank"); /* 先切断页面到进程的轮询，再停进程 */
    } catch { /* 尽力而为 */ }
    try {
      await ctx.stopStudio();
    } catch { /* 尽力而为 */ }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch { /* 尽力而为 */ }
  }
}
