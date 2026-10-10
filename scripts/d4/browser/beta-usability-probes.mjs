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
  const point = await ctx.evalJs(placementExpr);
  if (point === null || point.error !== undefined) {
    throw new Error(`touch-drag selection could not be placed — ${JSON.stringify(point)}`);
  }
  await ctx.evalJs(`(() => { window.getSelection().removeAllRanges(); return true; })()`);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await sleep(60);
  const placed = await ctx.evalJs(placementExpr);
  if (placed === null || placed.error !== undefined) {
    await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    throw new Error(`touch-drag selection failed during active touch — ${JSON.stringify(placed)}`);
  }
  const stillSelected = await ctx.evalJs(`(() => String(window.getSelection()))()`);
  await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(120);
  return { placed, stillSelected };
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
    {
      /* 先切空白页：切断上一探针页面对其进程的轮询（bootStudioOn 会停掉它）。 */
      await ctx.navigate("about:blank");
      const url = await ctx.bootStudioOn(dataDir);
      /* 实际启动命令（runner 的真实 spawn argv——探针上下文如实取回）。 */
      const actualArgv = ctx.studioArgv();
      const readmeEntryFromStartScript = resolve(ctx.ROOT, "apps", "studio", studioPkg.scripts?.start?.replace(/^node\s+/, "") ?? "");
      const actualEntry = actualArgv[0];
      const readmeConsistency = {
        readmeStartCommand: readme.startCommand,
        readmeInstallCommand: readme.installCommand,
        readmeOptionsLine: readme.optionsLine,
        packageStartScript: studioPkg.scripts?.start ?? null,
        actualArgv,
        entryMatchesReadmeStartScript: existsSync(readmeEntryFromStartScript) && resolve(actualEntry) === readmeEntryFromStartScript,
        flagsWithinReadmeOptions: actualArgv.includes("--port") && actualArgv.includes("--data"),
      };
      const problems = [];
      if (readme.installCommand !== "npm ci") {
        problems.push("README no longer documents npm ci");
      }
      if (readme.urlLine !== "http://127.0.0.1:8787") {
        problems.push(`README local URL changed: ${String(readme.urlLine)}`);
      }
      if (readme.startCommand !== "npm run start --workspace @treeai/studio") {
        problems.push(`README start command is ${JSON.stringify(readme.startCommand)}`);
      }
      if (studioPkg.scripts?.start !== "node src/index.ts") {
        problems.push(`apps/studio package.json start is ${JSON.stringify(studioPkg.scripts?.start)}`);
      }
      if (!readmeConsistency.entryMatchesReadmeStartScript) {
        problems.push(`the actually-spawned entry (${actualEntry}) does not resolve to the README start script's entry`);
      }
      if (!readmeConsistency.flagsWithinReadmeOptions || (readme.optionsLine ?? "").includes("--port") !== true || (readme.optionsLine ?? "").includes("--data") !== true) {
        problems.push(`the flags actually passed are not the README-documented options (README options line: ${JSON.stringify(readme.optionsLine)})`);
      }
      if (problems.length > 0) {
        throw new Error(`cleanBoot: the actual start path diverges from the README studio section — ${problems.join("; ")}`);
      }

      await ctx.navigate(url);
      await waitFor(ctx, `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`, {
        label: "studio shell on the clean data dir (README start path)",
        timeoutMs: 30_000,
      });
      /* 首启空状态诚实：无树（空态可见 + 森林列表无树行 + 服务端 0 树）、
         无材料（材料段隐藏）、建树流程可用（真实点击建树即证据）。 */
      const emptyState = await ctx.evalJs(
        `(() => ({ emptyStateVisible: !document.getElementById("empty-state").hidden && document.getElementById("empty-new-tree") !== null, ` +
          `treeViewHidden: document.getElementById("tree-view").hidden, ` +
          `forestTreeButtons: document.querySelectorAll("#tree-list button").length, ` +
          `navForestTreeButtons: document.querySelectorAll("#nav-tree-results button[data-tree-id]").length, ` +
          `materialsSectionHidden: document.getElementById("materials-section").hidden, ` +
          `newTreeButton: document.getElementById("new-tree") !== null, ` +
          `sourceDrawerToggleHidden: document.getElementById("source-drawer-toggle").hidden }))()`,
      );
      const treesApi = await ctx.api("GET", "/api/trees");
      const serverTreeCount = treesApi.body?.trees?.length ?? null;
      const emptyProblems = [];
      if (emptyState.emptyStateVisible !== true) emptyProblems.push("the empty state is not visible with its create-tree action");
      if (emptyState.treeViewHidden !== true) emptyProblems.push("#tree-view is visible on a clean boot");
      if (emptyState.forestTreeButtons !== 0) emptyProblems.push(`forest lists ${String(emptyState.forestTreeButtons)} tree(s) on a clean boot`);
      if (emptyState.navForestTreeButtons !== 0) emptyProblems.push(`nav forest lists ${String(emptyState.navForestTreeButtons)} tree(s) on a clean boot`);
      if (emptyState.materialsSectionHidden !== true) emptyProblems.push("the materials section is visible with no tree open");
      if (emptyState.newTreeButton !== true) emptyProblems.push("the New Tree button is absent");
      if (serverTreeCount !== 0) emptyProblems.push(`the server reports ${String(serverTreeCount)} tree(s) on a clean boot`);
      if (emptyProblems.length > 0) {
        throw new Error(`cleanBoot: the first-boot empty state is not honest — ${emptyProblems.join("; ")}`);
      }
      /* 建树流程可用：真实点击空态主操作。 */
      await inputClickAt(ctx, "#empty-new-tree");
      await waitFor(
        ctx,
        `(() => { const view = document.getElementById("tree-view"); const section = document.getElementById("materials-section"); ` +
          `return view !== null && !view.hidden && section !== null && !section.hidden; })()`,
        { label: "create-tree flow usable (workbench opens after the empty-state action)", timeoutMs: 20_000 },
      );
      const treesAfter = await ctx.api("GET", "/api/trees");
      const treeId = treesAfter.body?.trees?.[0]?.id ?? null;
      if (treesAfter.body?.trees?.length !== 1 || typeof treeId !== "string") {
        throw new Error(`cleanBoot: create-tree flow did not produce exactly one tree (${JSON.stringify(treesAfter.body?.trees?.length ?? null)})`);
      }
      cleanBoot.readmeStartCommand = readme.startCommand;
      cleanBoot.readmeOptionsLine = readme.optionsLine;
      cleanBoot.packageStartScript = studioPkg.scripts.start;
      cleanBoot.actualArgv = actualArgv;
      cleanBoot.entryConsistentWithReadme = readmeConsistency.entryMatchesReadmeStartScript;
      cleanBoot.flagsConsistentWithReadme = readmeConsistency.flagsWithinReadmeOptions;
      cleanBoot.emptyStateHonest = emptyState;
      cleanBoot.serverTreeCountOnBoot = serverTreeCount;
      cleanBoot.treeCreatedViaEmptyState = treeId;
      scenarioSetup.treeId = treeId;
      await ctx.screenshot("beta-cleanboot-workbench");

      /* 场景语料：B1 冻结 fixture 经真实导入 API（D4-1 契约面）。 */
      const imported = {};
      for (const fixture of [
        { id: MD_FIXTURE_ID, filename: mdFixture.filename, bytes: mdFixture.bytes, truth: mdFixture.truth },
        { id: PDF_FIXTURE_ID, filename: pdfFixture.filename, bytes: pdfFixture.bytes, truth: pdfFixture.truth },
      ]) {
        const res = await importMaterialViaHttp(ctx, treeId, fixture.filename, fixture.bytes, 30_000);
        if (res.status !== 201 || res.body?.created !== true) {
          throw new Error(`${fixture.id}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
        }
        await waitForVersionReady(ctx, treeId, res.body.material.id, res.body.version.id, fixture.id);
        imported[fixture.id] = { materialId: res.body.material.id, versionId: res.body.version.id, title: res.body.material.title };
      }
      /* 刷新页面（真实导航——应用自身重拉材料列表）。 */
      await ctx.navigate(url);
      await waitFor(
        ctx,
        `(() => document.querySelectorAll("#material-list button[data-material-id]").length === 2)()`,
        { label: "sidebar lists both imported materials after reload", timeoutMs: 20_000 },
      );
    }

    /* ============ 2) 场景支线：材料 Branch（真实 UI 建枝 + 首问/追问） ============ */
    {
      const md = { materialId: null };
      {
        const ids = await ctx.evalJs(`(() => [...document.querySelectorAll("#material-list button[data-material-id]")].map((b) => ({ id: b.dataset.materialId, meta: (b.querySelector(".material-meta")?.textContent ?? "") })))()`);
        for (const entry of ids) {
          if (entry.meta.includes("markdown")) md.materialId = entry.id;
        }
        if (md.materialId === null) throw new Error(`beta probe: no markdown material in the sidebar (${JSON.stringify(ids)})`);
      }
      await inputClickAt(ctx, materialButtonSelector(md.materialId));
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `if (reader === null || reader.hidden) return false; ` +
          `const blocks = document.querySelectorAll("#mat-blocks .material-block").length; ` +
          `if (blocks !== 50) return false; ` +
          `return (document.getElementById("mat-tail").textContent ?? "").includes("50 block(s) in view"); })()`,
        { label: `md-11 reader opened (first 50 of ${String(mdBlocks.length)} blocks, lazy tail)`, timeoutMs: 25_000 },
      );
      /* 武装选区（selectionchange 路径）→ 建枝 → 提交前材料范围声明 → 首问。 */
      const placed = await ctx.evalJs(pageSelectCanonical(mdRange.blockId, mdRange.start, mdRange.end));
      if (placed === null || placed.error !== undefined || placed.selectedText !== mdRange.excerpt) {
        throw new Error(`beta probe: md-11 selection did not land as planned — ${JSON.stringify(placed)}`);
      }
      await waitForArmedBar(ctx, "beta md-11 selection", 6000);
      await domClick(ctx, "#mat-selection-bar .mat-branch-d43");
      await waitFor(
        ctx,
        `(() => { const flow = document.getElementById("mat-branch-flow"); ` +
          `return flow !== null && document.getElementById("mat-branch-first-question") !== null ` +
          `&& (flow.textContent ?? "").includes("Material scope for this exploration — declared before your first question"); })()`,
        { label: "branch flow with the pre-submit material scope declaration", timeoutMs: 20_000 },
      );
      const scopeOk = await ctx.evalJs(
        `(() => { const flow = document.getElementById("mat-branch-flow"); const text = flow.textContent ?? ""; ` +
          `return { block: text.includes("block ${mdRange.blockId}"), range: text.includes("UTF-16 [${String(mdRange.start)}, ${String(mdRange.end)})"), ` +
            `excerpt: (flow.querySelector(".mat-branch-excerpt")?.textContent ?? null) === ${JSON.stringify(mdRange.excerpt)} }; })()`,
      );
      if (scopeOk.block !== true || scopeOk.range !== true || scopeOk.excerpt !== true) {
        throw new Error(`beta probe: the pre-submit material scope declaration mismatch — ${JSON.stringify(scopeOk)}`);
      }
      const question = `请基于这段选区解释它的核心论点，并给出两个可检验的要点。（${BETA_MARKERS.q1}）`;
      await inputClickAt(ctx, "#mat-branch-first-question");
      await ctx.cdpSend("Input.insertText", { text: question });
      await domClick(ctx, "#mat-branch-flow .mat-branch-submit");
      await waitFor(
        ctx,
        `(() => { const panel = document.getElementById("branch-panel"); ` +
          `if (panel === null || panel.hidden) return false; ` +
          `const conv = document.getElementById("panel-conversation"); ` +
          `if (!(conv.textContent ?? "").includes(${JSON.stringify(BETA_MARKERS.q1)})) return false; ` +
          `const turns = [...conv.querySelectorAll(".turn")]; ` +
          `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(BETA_MARKERS.q1)})); ` +
          `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
        { label: `first question landed with an answer (${modeNote})`, timeoutMs: answerTimeoutMs },
      );
      const branchId = await ctx.evalJs(`(() => document.querySelector("#branch-tabs button.panel-open")?.dataset.branchId ?? null)()`);
      if (typeof branchId !== "string") throw new Error("beta probe: could not identify the material branch tab");
      /* 一轮追问（面板会话高度 + 后续相位的语料）。 */
      const followUp = async (marker, text) => {
        await inputClickAt(ctx, "#panel-prompt-input");
        await ctx.cdpSend("Input.insertText", { text: `追问：${text}（${marker}）` });
        await inputClickAt(ctx, "#panel-send");
        await waitFor(
          ctx,
          `(() => { const conv = document.getElementById("panel-conversation"); ` +
            `const turns = [...conv.querySelectorAll(".turn")]; ` +
            `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
            `if (q < 0) return false; ` +
            `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
          { label: `follow-up ${marker} landed with an answer`, timeoutMs: answerTimeoutMs },
        );
      };
      await followUp(BETA_MARKERS.f1, "这个论点在原文中的依据是哪一句");
      await inputClickAt(ctx, "#panel-close");
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed after the branch setup" });
      scenarioSetup.branchId = branchId;
      scenarioSetup.firstQuestion = BETA_MARKERS.q1;
      scenarioSetup.followUps = [BETA_MARKERS.f1];
      scenarioSetup.modeNote = modeNote;
      scenarioSetup.materialBranchOrigin = { materialId: md.materialId, blockId: mdRange.blockId, range: mdRange };
    }

    const branchTabSelector = `#branch-tabs button[data-branch-id=${JSON.stringify(scenarioSetup.branchId)}]`;

    /* ============ 3) wideNarrow：宽窄两档可用 + 无横向溢出 + 捕获条可达 ============ */
    const wideNarrow = {};
    {
      /* —— 宽档（≥1440px）—— */
      await setViewport(ctx, WIDE_VIEWPORT);
      const wideViewport = await ctx.evalJs(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`);
      if (wideViewport.w < 1440) throw new Error(`wide viewport is ${String(wideViewport.w)}px (< 1440 required)`);
      const wideOverflow = await assertNoHorizontalOverflow(ctx, "wide viewport");
      const wideHits = await assertHits(
        ctx,
        {
          newTree: "#new-tree",
          materialImport: "#material-import",
          searchInput: "#search-input",
          treeRow: "#tree-list button.active",
          branchTab: branchTabSelector,
        },
        "wide viewport",
      );
      /* 阅读器两档可用：打开 md-11（真实点击）→ 块渲染 + 无横向溢出。 */
      await inputClickAt(ctx, materialButtonSelector(scenarioSetup.materialBranchOrigin.materialId));
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
        { label: "md-11 reader usable at the wide viewport", timeoutMs: 20_000 },
      );
      await assertNoHorizontalOverflow(ctx, "wide viewport with the reader open");
      /* 捕获条可达：武装选区 → 捕获条按钮 elementFromPoint 命中。 */
      const placedWide = await ctx.evalJs(pageSelectCanonical(mdRange.blockId, mdRange.start, mdRange.end));
      if (placedWide?.selectedText !== mdRange.excerpt) {
        throw new Error(`wide viewport: selection placement failed — ${JSON.stringify(placedWide)}`);
      }
      await waitForArmedBar(ctx, "beta wide-viewport selection", 6000);
      const wideBarHits = await assertHits(
        ctx,
        { copy: "#mat-selection-bar .mat-copy", branch: "#mat-selection-bar .mat-branch-d43" },
        "wide viewport capture bar",
      );
      /* 关阅读器后再测支线面板（≥1180px 阅读器与面板同列，阅读器 z-index
         在上——面板命中测试须在阅读器收起后）。 */
      await inputClickAt(ctx, "#mat-close");
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (wide, before the panel test)" });
      /* 支线面板两档可用：tab 点击打开 → 输入框命中 → 收起。 */
      await inputClickAt(ctx, branchTabSelector);
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
        label: "branch panel opens at the wide viewport (tab click)",
        timeoutMs: 20_000,
      });
      await assertHits(ctx, { panelInput: "#panel-prompt-input", panelViewSource: "#panel-view-source" }, "wide viewport branch panel");
      await assertNoHorizontalOverflow(ctx, "wide viewport with the panel open");
      await inputClickAt(ctx, "#panel-close");
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (wide)" });
      wideNarrow.wide = {
        widthPx: wideViewport.w,
        heightPx: wideViewport.h,
        overflowX: wideOverflow,
        hits: wideHits,
        captureBarHits: wideBarHits,
        readerUsable: true,
        panelUsable: true,
      };

      /* —— 窄档（~390×844，mobile 触屏视口）—— */
      await setViewport(ctx, NARROW_VIEWPORT);
      const narrowViewport = await ctx.evalJs(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`);
      if (narrowViewport.w > 400 || narrowViewport.w < 380) {
        throw new Error(`narrow viewport is ${String(narrowViewport.w)}px (expected ~390)`);
      }
      const narrowState = await ctx.evalJs(
        `(() => ({ toggleVisible: getComputedStyle(document.getElementById("sidebar-toggle")).display !== "none", ` +
          `sidebarDrawerHidden: getComputedStyle(document.getElementById("sidebar")).visibility === "hidden" }))()`,
      );
      if (narrowState.toggleVisible !== true || narrowState.sidebarDrawerHidden !== true) {
        throw new Error(`narrow viewport: the sidebar drawer is not in its closed state — ${JSON.stringify(narrowState)}`);
      }
      const narrowOverflowClosed = await assertNoHorizontalOverflow(ctx, "narrow viewport (drawer closed)");
      /* 抽屉开合（真实点击 #sidebar-toggle）。 */
      await inputClickAt(ctx, "#sidebar-toggle");
      await waitFor(
        ctx,
        `(() => document.body.classList.contains("sidebar-open") && getComputedStyle(document.getElementById("sidebar")).visibility === "visible")()`,
        { label: "narrow viewport: the sidebar drawer opens via the toggle", timeoutMs: 10_000 },
      );
      await waitForDrawerSettled(ctx);
      const narrowHits = await assertHits(
        ctx,
        {
          newTree: "#new-tree",
          materialImport: "#material-import",
          searchInput: "#search-input",
          treeRow: "#tree-list button.active",
          branchTab: branchTabSelector,
        },
        "narrow viewport (drawer open)",
      );
      await assertNoHorizontalOverflow(ctx, "narrow viewport (drawer open)");
      /* 阅读器两档可用：抽屉内点击材料 → 阅读器全幅可用（选材料收抽屉是产品纪律）。 */
      await inputClickAt(ctx, materialButtonSelector(scenarioSetup.materialBranchOrigin.materialId));
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
          `&& document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
        { label: "narrow viewport: the reader opens full-width and the drawer dismisses (material select)",
          timeoutMs: 20_000 },
      );
      await waitForDrawerDismissed(ctx);
      await assertNoHorizontalOverflow(ctx, "narrow viewport with the reader open");
      /* 捕获条可达（窄档）。 */
      const placedNarrow = await ctx.evalJs(pageSelectCanonical(mdRange.blockId, mdRange.start, mdRange.end));
      if (placedNarrow?.selectedText !== mdRange.excerpt) {
        throw new Error(`narrow viewport: selection placement failed — ${JSON.stringify(placedNarrow)}`);
      }
      await waitForArmedBar(ctx, "beta narrow-viewport selection", 6000);
      const narrowBarHits = await assertHits(ctx, { copy: "#mat-selection-bar .mat-copy" }, "narrow viewport capture bar");
      await ctx.evalJs(`(() => { window.getSelection().removeAllRanges(); return true; })()`);
      await sleep(250);
      await inputClickAt(ctx, "#mat-close");
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (narrow)" });
      /* 支线面板两档可用：抽屉开 → tab 点击 → 面板开（抽屉按产品纪律收起）。 */
      await inputClickAt(ctx, "#sidebar-toggle");
      await waitFor(ctx, `(() => document.body.classList.contains("sidebar-open"))()`, { label: "drawer reopens (narrow panel phase)" });
      await waitForDrawerSettled(ctx);
      await inputClickAt(ctx, branchTabSelector);
      await waitFor(
        ctx,
        `(() => { const p = document.getElementById("branch-panel"); ` +
          `return p !== null && !p.hidden && !document.body.classList.contains("sidebar-open"); })()`,
        { label: "narrow viewport: the branch panel opens and the drawer dismisses (branch tab select)",
          timeoutMs: 20_000 },
      );
      await waitForDrawerDismissed(ctx);
      await assertHits(ctx, { panelInput: "#panel-prompt-input", panelViewSource: "#panel-view-source" }, "narrow viewport branch panel");
      await assertNoHorizontalOverflow(ctx, "narrow viewport with the panel open");
      await inputClickAt(ctx, "#panel-close");
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (narrow)" });
      wideNarrow.narrow = {
        widthPx: narrowViewport.w,
        heightPx: narrowViewport.h,
        mobileViewport: true,
        drawerOpensViaToggle: true,
        overflowX: narrowOverflowClosed,
        hits: narrowHits,
        captureBarHits: narrowBarHits,
        readerUsable: true,
        panelUsable: true,
      };
      /* 还原缺省视口（后续相位的基准）。 */
      await setViewport(ctx, DEFAULT_VIEWPORT);
    }

    /* ============ 4) touch：tap / swipe / 文本层拖选武装 / tap 工具条按钮 ============
       (顺序纪律：本相位先于键盘相位执行——headless Chrome 153 的 CDP 输入
       管线在 Space/Escape/无 text 的 Enter 之后不再接受原生
       Input.dispatchTouchEvent（实测复现：鼠标/eval/带 text 的键不受影响）；
       触摸之后键鼠一切正常。探针侧手势时序坑，sidecar 如实披露。) */
    const touch = { ...touchStats };
    {
      await setViewport(ctx, NARROW_VIEWPORT);
      /* tap 开侧栏抽屉。 */
      const toggleRect = await ctx.evalJs(
        `(() => { const b = document.getElementById("sidebar-toggle"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await tapAt(toggleRect.x, toggleRect.y);
      await waitFor(
        ctx,
        `(() => document.body.classList.contains("sidebar-open") && getComputedStyle(document.getElementById("sidebar")).visibility === "visible")()`,
        { label: "touch: tap opens the sidebar drawer", timeoutMs: 10_000 },
      );
      await waitForDrawerSettled(ctx);
      /* tap 打开材料阅读（md-11）。 */
      const mdBtn = await ctx.evalJs(
        `(() => { const b = document.querySelector(${JSON.stringify(materialButtonSelector(scenarioSetup.materialBranchOrigin.materialId))}); ` +
          `const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await tapAt(mdBtn.x, mdBtn.y);
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
          `&& document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
        { label: "touch: tap on the material opens the reader (drawer dismisses)", timeoutMs: 20_000 },
      );
      await waitForDrawerDismissed(ctx);
      touch.tapOpenedReader = true;
      /* swipe 滚动阅读器。 */
      const beforeSwipe = await ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
      await swipeAt({ x: 195, y: 620, dy: -420, dx: 0, steps: 8 });
      await sleep(400);
      const afterSwipe = await ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
      if (!(afterSwipe > beforeSwipe + 50)) {
        throw new Error(`touch: the swipe did not scroll the reader (${String(beforeSwipe)} → ${String(afterSwipe)})`);
      }
      touch.swipeScrolledPx = Math.round(afterSwipe - beforeSwipe);
      /* 换到 pdf-01（tap 材料按钮；抽屉开→选材料→收起）。 */
      await tapAt(toggleRect.x, toggleRect.y);
      await waitFor(ctx, `(() => document.body.classList.contains("sidebar-open"))()`, { label: "touch: drawer reopens (pdf phase)" });
      await waitForDrawerSettled(ctx);
      const pdfMaterialId = await ctx.evalJs(
        `(() => { for (const b of document.querySelectorAll("#material-list button[data-material-id]")) { ` +
          `if ((b.querySelector(".material-meta")?.textContent ?? "").includes("pdf")) return b.dataset.materialId; } return null; })()`,
      );
      if (typeof pdfMaterialId !== "string") throw new Error("touch: no pdf material in the sidebar");
      const pdfBtn = await ctx.evalJs(
        `(() => { const b = document.querySelector(${JSON.stringify(materialButtonSelector(pdfMaterialId))}); ` +
          `const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await tapAt(pdfBtn.x, pdfBtn.y);
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
          `&& document.querySelectorAll("#mat-blocks .pdf-page-frame").length === ${String(pdfFixture.truth.blocks.length)}; })()`,
        { label: "touch: tap on pdf-01 switches the reader (all page frames)", timeoutMs: 25_000 },
      );
      await waitForDrawerDismissed(ctx);
      /* 第 2 页滚入视口 + 文本层渲染（可见页先行）。 */
      await ctx.evalJs(
        `(() => { const frames = [...document.querySelectorAll("#mat-blocks .pdf-page-frame")]; ` +
          `const target = frames.find((f) => f.dataset.blockId === ${JSON.stringify(pdfRange.blockId)}); ` +
          `if (target === undefined) return false; target.scrollIntoView({ block: "center" }); return true; })()`,
      );
      await waitFor(
        ctx,
        `(() => (document.querySelector(${JSON.stringify(`#mat-blocks .pdf-page-text[data-block-id="${pdfRange.blockId}"]`)})?.dataset.rendered ?? null) === "true")()`,
        { label: "touch: the pdf page text layer renders as it scrolls into view",
          timeoutMs: 15_000 },
      );
      /* 长按实测（如实记录）：headless Chrome 153 的原生长按不合成持久选区
         （只取坐标置监听，不置位选区——长按后 selectionchange 计数与终选区
         如实入 sidecar）。 */
      {
        /* 只取坐标（不置位）：长按目标词中心。 */
        const point = await ctx.evalJs(
          `(() => { const layer = document.querySelector(${JSON.stringify(`#mat-blocks .pdf-page-text[data-block-id="${pdfRange.blockId}"]`)}); ` +
            `const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT); ` +
            `const n = walker.nextNode(); if (n === null) return null; ` +
            `const range = document.createRange(); range.setStart(n, 4); range.setEnd(n, 12); ` +
            `const r = range.getBoundingClientRect(); ` +
            `window.__betaTouchSelCount = 0; ` +
            `document.addEventListener("selectionchange", () => { window.__betaTouchSelCount += 1; }); ` +
            `return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
        );
        await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        await sleep(900);
        await ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(500);
        const longPressResult = await ctx.evalJs(
          `(() => ({ selectionChangeEvents: window.__betaTouchSelCount, selectionText: String(window.getSelection()) }))()`,
        );
        touch.longPressProbe = { target: point, result: longPressResult, synthesizedPersistedSelection: longPressResult.selectionText.length > 0 };
      }
      /* 文本层上拖选武装捕获条（app 的触路径：selectionchange 武装——
         选区在触摸手势进行中建立，全程零鼠标事件）。 */
      touchStats.dragSelects += 1;
      const drag = await touchDragSelect(ctx, pdfLayerSelectExpr(pdfRange.blockId, pdfRange.start, pdfRange.end));
      if (drag.placed.selectedText !== pdfRange.excerpt || drag.stillSelected !== pdfRange.excerpt) {
        throw new Error(
          `touch: the in-gesture selection on the pdf text layer did not hold — placed ${JSON.stringify(drag.placed.selectedText)}, at touchEnd ${JSON.stringify(drag.stillSelected)}, want ${JSON.stringify(pdfRange.excerpt)}`,
        );
      }
      let bar;
      try {
        bar = await waitForArmedBar(ctx, "touch pdf-01 selection", 6000);
      } catch (error) {
        const diagnostic = await ctx.evalJs(`(() => {
          const s = window.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
          const frame = document.querySelector("#mat-blocks .pdf-page-frame");
          return { selectionText: s?.toString() ?? null, rangeText: r?.toString() ?? null,
            collapsed: r?.collapsed ?? null, anchor: r?.startContainer?.parentElement?.className ?? null,
            focus: r?.endContainer?.parentElement?.className ?? null,
            readerOpen: !document.getElementById("material-reader")?.hidden,
            pdfFrames: document.querySelectorAll("#mat-blocks .pdf-page-frame").length };
        })()`);
        throw new Error(`touch pdf-01 selection: ${String(error)}; native diagnostic ${JSON.stringify(diagnostic)}`);
      }
      if (bar.payload === null) {
        throw new Error(`touch: the capture bar did not arm with a payload — ${JSON.stringify(bar)}`);
      }
      if (!bar.payload.includes(`block ${pdfRange.blockId}`) || !bar.payload.includes("page 2")) {
        throw new Error(`touch: the armed payload does not carry the pdf block/page — ${JSON.stringify(bar.payload)}`);
      }
      if (bar.quote !== pdfRange.excerpt) {
        throw new Error(`touch: the armed quote differs from the planned excerpt — ${JSON.stringify(bar.quote)}`);
      }
      touch.selectionArmedViaTouch = true;
      touch.armedPayload = bar.payload;
      touch.armedDuringGesture = { zeroMouseEvents: true, path: "selectionchange arming (the app's touch path)" };
      /* tap 工具条按钮（复制）：剪贴板回读字节相等。 */
      await ctx.cdpSend("Browser.grantPermissions", { origin: ctx.studioOrigin(), permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      const copyRect = await ctx.evalJs(
        `(() => { const b = document.querySelector("#mat-selection-bar .mat-copy"); ` +
          `if (b === null) return null; const r = b.getBoundingClientRect(); ` +
          `if (r.width <= 0 || r.height <= 0) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (copyRect === null) throw new Error("touch: the capture bar copy button has no box (not visible)");
      await tapAt(copyRect.x, copyRect.y);
      const copyState = await waitFor(
        ctx,
        `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); ` +
          `return btn !== null && btn.textContent === "Copied ✓" ? { label: btn.textContent } : false; })()`,
        { label: "touch: tap on Copy shows the Copied ✓ confirmation", timeoutMs: 5000 },
      );
      const clip = await ctx.evalJs(
        `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
          `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
      );
      if (clip.ok === true) {
        if (clip.text !== pdfRange.excerpt) {
          throw new Error(`touch: the clipboard content differs from the excerpt (got ${JSON.stringify(clip.text.slice(0, 40))}…)`);
        }
        touch.toolbarButtonTapped = true;
        touch.copyVerification = "clipboard read-back byte-equal";
      } else {
        /* 诚实降级：确认态已验证 + 摘录与冻结真值一致（剪贴板读回不可用）。 */
        touch.toolbarButtonTapped = true;
        touch.copyVerification = `copy-confirmed (Copied ✓ shown; clipboard read-back unavailable: ${String(clip.error)})`;
      }
      touch.copyLabel = copyState.label;
      /* 收尾：解除选区、关阅读器、还原视口。 */
      await ctx.evalJs(`(() => { window.getSelection().removeAllRanges(); return true; })()`);
      await sleep(250);
      await inputClickAt(ctx, "#mat-close");
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (touch phase)" });
      await setViewport(ctx, DEFAULT_VIEWPORT);
      touch.taps = touchStats.taps;
      touch.swipes = touchStats.swipes;
      touch.dragSelects = touchStats.dragSelects;
    }

    /* ============ 5) reducedMotion：matchMedia + 定位跳转即时落位 ============ */
    const reducedMotion = {};
    {
      /* 面板重开（贴底跟随的载体）。 */
      await inputClickAt(ctx, branchTabSelector);
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
        label: "panel open (reduced-motion phase)",
        timeoutMs: 20_000,
      });
      /* 贴底跟随的对照测量（无 reduce，如实记录——不设平滑断言）。 */
      const instrumentStick = () => ctx.evalJs(
        `(() => { window.__betaStick = { atMutation: null, frames: [] }; ` +
          `const pc = document.getElementById("panel-conversation"); ` +
          `const mo = new MutationObserver(() => { ` +
            `if (window.__betaStick.atMutation === null) { ` +
              `window.__betaStick.atMutation = { scrollTop: pc.scrollTop, bottom: pc.scrollHeight - pc.clientHeight, t: Number(performance.now().toFixed(1)) }; } }); ` +
          `mo.observe(pc, { childList: true, subtree: true }); ` +
          `window.__betaStickMo = mo; ` +
          `const rec = () => { ` +
            `window.__betaStick.frames.push({ t: Number(performance.now().toFixed(1)), top: pc.scrollTop, bottom: pc.scrollHeight - pc.clientHeight }); ` +
            `if (window.__betaStick.frames.length < 30) requestAnimationFrame(rec); }; ` +
          `requestAnimationFrame(rec); return true; })()`,
      );
      const readStick = () => ctx.evalJs(
        `(() => { if (window.__betaStickMo) window.__betaStickMo.disconnect(); ` +
          `const probe = window.__betaStick; ` +
          `return { atMutation: probe.atMutation, frames: probe.frames, ` +
            `settledTop: document.getElementById("panel-conversation").scrollTop, ` +
            `settledBottom: document.getElementById("panel-conversation").scrollHeight - document.getElementById("panel-conversation").clientHeight }; })()`,
      );
      const panelFollowUp = async (marker, text) => {
        /* 贴底跟随只在用户本就贴底时发生（issue #3）——先把面板会话滚到底，
           后续断言的才是「新内容到达时的跟随」路径。 */
        await ctx.evalJs(`(() => { const pc = document.getElementById("panel-conversation"); pc.scrollTop = pc.scrollHeight; return true; })()`);
        await sleep(150);
        await inputClickAt(ctx, "#panel-prompt-input");
        await ctx.cdpSend("Input.insertText", { text: `追问：${text}（${marker}）` });
        await inputClickAt(ctx, "#panel-send");
        await waitFor(
          ctx,
          `(() => { const conv = document.getElementById("panel-conversation"); ` +
            `const turns = [...conv.querySelectorAll(".turn")]; ` +
            `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
            `if (q < 0) return false; ` +
            `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
          { label: `follow-up ${marker} landed (reduced-motion phase)`, timeoutMs: answerTimeoutMs },
        );
      };
      await instrumentStick();
      await panelFollowUp(BETA_MARKERS.fControl, "贴底跟随的对照测量");
      await sleep(500);
      reducedMotion.controlStickToBottom = await readStick();

      /* reduce 开启：页面 matchMedia 为真。 */
      await ctx.cdpSend("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await sleep(250);
      const matched = await ctx.evalJs(`(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)()`);
      if (matched !== true) {
        throw new Error("reducedMotion: page matchMedia('(prefers-reduced-motion: reduce)') is false after the emulation was set");
      }
      reducedMotion.matched = true;
      /* 贴底跟随在 reduce 下即时落位。口径（charter B7 行「终位置一帧内
         到达」）：首个变更微任务时刻已在终位；其后至多一帧的过渡（流式
         增量写入与跟随滚动分属相邻任务——平滑滚动则会呈现多帧在途）。 */
      await instrumentStick();
      await panelFollowUp(BETA_MARKERS.fReduce, "reduce 下的即时落位");
      await sleep(500);
      const reduceStick = await readStick();
      const stickProblems = [];
      if (reduceStick.atMutation === null) {
        stickProblems.push("no mutation was observed on the panel conversation");
      } else if (reduceStick.atMutation.scrollTop < reduceStick.atMutation.bottom - IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        stickProblems.push(
          `at the mutation instant the panel was still in transit (scrollTop ${String(reduceStick.atMutation.scrollTop)} < bottom ${String(reduceStick.atMutation.bottom)} — smooth scroll in flight under reduce)`,
        );
      }
      const transitRunOf = (frames) => {
        let best = 0;
        let run = 0;
        for (const f of frames) {
          if (f.top < f.bottom - IMMEDIATE_ARRIVAL_TOLERANCE_PX) { run += 1; best = Math.max(best, run); }
          else run = 0;
        }
        return best;
      };
      const reduceFrames = reduceStick.frames ?? [];
      const transitFrames = reduceFrames.filter((f) => f.top < f.bottom - IMMEDIATE_ARRIVAL_TOLERANCE_PX);
      reduceStick.transitFrameCount = transitFrames.length;
      reduceStick.maxConsecutiveTransitFrames = transitRunOf(reduceFrames);
      if (transitRunOf(reduceFrames) > 1) {
        stickProblems.push(
          `the scroll stayed in transit for ${String(transitRunOf(reduceFrames))} consecutive frames after the mutation (smooth animation in flight under reduce; transit frames: ${JSON.stringify(transitFrames.slice(0, 4))})`,
        );
      }
      if (Math.abs((reduceStick.settledTop ?? -1) - (reduceStick.settledBottom ?? -2)) > IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        stickProblems.push(`the settled position is not the bottom (top ${String(reduceStick.settledTop)} vs bottom ${String(reduceStick.settledBottom)})`);
      }
      if (stickProblems.length > 0) {
        throw new Error(`reducedMotion: the stick-to-bottom scroll was not immediate under reduce — ${stickProblems.join("; ")}`);
      }
      reducedMotion.stickToBottomUnderReduce = reduceStick;
      reducedMotion.immediateArrival = true;

      /* 定位跳转：面板 ⌖ View source → 阅读器开于锚定块。断言即时落位：
         锚定块进入 DOM 的微任务时刻 scrollTop 已是终位（scrollIntoView 与
         渲染同一同步块）+ 到位之后的帧不再位移（加载期帧不计数——阅读器
         打开是异步 detail/分页过程）。 */
      await ctx.evalJs(
        `(() => { window.__betaJump = { arrival: null, frames: [] }; ` +
          `const mo = new MutationObserver(() => { ` +
            `const block = document.querySelector('#mat-blocks [data-block-id="${mdRange.blockId}"]'); ` +
            `if (block !== null && window.__betaJump.arrival === null) { ` +
              `window.__betaJump.arrival = { t: Number(performance.now().toFixed(1)), scrollTop: document.getElementById("mat-blocks").scrollTop }; } }); ` +
          `mo.observe(document.getElementById("material-reader"), { childList: true, subtree: true }); ` +
          `window.__betaJumpMo = mo; ` +
          `const rec = () => { ` +
            `window.__betaJump.frames.push({ t: Number(performance.now().toFixed(1)), top: document.getElementById("mat-blocks") === null ? null : document.getElementById("mat-blocks").scrollTop, ` +
              `blockPresent: document.querySelector('#mat-blocks [data-block-id="${mdRange.blockId}"]') !== null }); ` +
            `if (window.__betaJump.frames.length < 40) requestAnimationFrame(rec); }; ` +
          `requestAnimationFrame(rec); return true; })()`,
      );
      await domClick(ctx, "#panel-view-source");
      const jumpSettled = await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `if (reader === null || reader.hidden) return false; ` +
          `const block = document.querySelector('#mat-blocks [data-block-id="${mdRange.blockId}"]'); ` +
          `if (block === null) return false; ` +
          `return (reader.textContent ?? "").includes("jumped to the material source of a Return — located at block ${mdRange.blockId}"); })()`,
        { label: "reducedMotion: View source opened the reader at the anchored block", timeoutMs: 25_000 },
      );
      if (jumpSettled !== true) throw new Error("reducedMotion: the anchored block never settled");
      const jump = await ctx.evalJs(
        `(() => { if (window.__betaJumpMo) window.__betaJumpMo.disconnect(); ` +
          `const blocks = document.getElementById("mat-blocks"); ` +
          `const block = document.querySelector('#mat-blocks [data-block-id="${mdRange.blockId}"]'); ` +
          `const blockTop = block.offsetTop - blocks.offsetTop; ` +
          `return { ...window.__betaJump, finalTop: blocks.scrollTop, blockTop, diff: Math.abs(blocks.scrollTop - blockTop) }; })()`,
      );
      const jumpProblems = [];
      if (jump.arrival === null) jumpProblems.push("the anchored block's arrival was never observed during the jump");
      if (jump.diff > IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        jumpProblems.push(`the reader did not land with the anchored block at the top (scrollTop ${String(jump.finalTop)} vs block top ${String(jump.blockTop)}, diff ${String(jump.diff)}px)`);
      }
      if (jump.arrival !== null && Math.abs(jump.arrival.scrollTop - jump.blockTop) > IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        jumpProblems.push(
          `at the anchored block's arrival instant the reader was not yet at the final position (scrollTop ${String(jump.arrival.scrollTop)} vs block top ${String(jump.blockTop)} — smooth scroll in flight under reduce)`,
        );
      }
      const movingFramesAfterArrival = (jump.frames ?? []).filter(
        (f) => f.blockPresent === true && f.t >= (jump.arrival?.t ?? Infinity) && Math.abs((f.top ?? -1) - jump.finalTop) > IMMEDIATE_ARRIVAL_TOLERANCE_PX,
      );
      if (movingFramesAfterArrival.length > 0) {
        jumpProblems.push(`${String(movingFramesAfterArrival.length)} post-arrival frames show an in-transit scroll position after the jump`);
      }
      if (jumpProblems.length > 0) {
        throw new Error(`reducedMotion: the View-source positioning jump was not immediate under reduce — ${jumpProblems.join("; ")}`);
      }
      reducedMotion.viewSourceJump = { anchoredBlock: mdRange.blockId, arrival: jump.arrival, finalTop: jump.finalTop, blockTop: jump.blockTop, diffPx: jump.diff, frames: jump.frames };
      /* 清除模拟（还原），并断言回落的真实性。 */
      await ctx.cdpSend("Emulation.setEmulatedMedia", { features: [] });
      await sleep(250);
      const matchedAfterReset = await ctx.evalJs(`(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)()`);
      if (matchedAfterReset !== false) {
        throw new Error("reducedMotion: the emulated media did not reset (matchMedia still true after clearing)");
      }
      reducedMotion.emulationResetVerified = true;
    }

    /* ============ 6) keyboard：Tab 遍历 / Enter+Space / Escape / 焦点样式 / 方向键 ============ */
    const keyboard = { sequence: [] };
    {
      /* 阅读器打开（键盘遍历要到达阅读器正文容器）。 */
      await inputClickAt(ctx, materialButtonSelector(scenarioSetup.materialBranchOrigin.materialId));
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
        { label: "md-11 reader open (keyboard phase)", timeoutMs: 20_000 },
      );
      /* Tab 遍历（确定性口径）：先 Shift+Tab 回卷到文档起点（焦点越过首个
         可聚焦元素落回 body——起点边界），再正向 Tab 完整遍历文档序。
         起点边界后每次 Tab 必须落在元素上（无陷阱），到达阅读器正文容器
         （#mat-blocks，键盘可滚动面）为止。回卷与正向序列全程入 sidecar。 */
      await ctx.evalJs(`(() => { if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur(); return true; })()`);
      keyboard.rewindSequence = [];
      let rewindSteps = 0;
      for (; rewindSteps < 60; rewindSteps += 1) {
        await pressKey(ctx, "Tab", "Tab", 9, { modifiers: 8 });
        const active = await ctx.evalJs(ACTIVE_EL_EXPR);
        keyboard.rewindSequence.push(active);
        if (active === null) break;
      }
      if (rewindSteps >= 60) {
        throw new Error(`keyboard: Shift+Tab never reached the document start boundary — rewind: ${JSON.stringify(keyboard.rewindSequence)}`);
      }
      keyboard.rewindSteps = rewindSteps + 1;
      const seen = new Map();
      let reachedBlocks = false;
      for (let step = 1; step <= 80; step += 1) {
        await pressKey(ctx, "Tab", "Tab", 9);
        const active = await ctx.evalJs(ACTIVE_EL_EXPR);
        keyboard.sequence.push({ step, active });
        if (active === null) {
          throw new Error(
            `keyboard: Tab step ${String(step)} lost focus (activeElement is body/null — focus trap or an unfocusable surface); sequence: ${JSON.stringify(keyboard.sequence)}`,
          );
        }
        const key = active.id ?? `${active.tag}.${active.cls}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (active.id === "mat-blocks") { reachedBlocks = true; break; }
      }
      if (!reachedBlocks) {
        throw new Error(`keyboard: Tab traversal never reached the reader's text container (#mat-blocks) in ${String(keyboard.sequence.length)} steps`);
      }
      const reached = {
        newTree: seen.has("new-tree"),
        materialImport: seen.has("material-import"),
        searchInput: seen.has("search-input"),
        readerContent: seen.has("mat-blocks"),
      };
      for (const [name, ok] of Object.entries(reached)) {
        if (ok !== true) {
          throw new Error(`keyboard: Tab traversal never reached ${name} — sequence: ${JSON.stringify(keyboard.sequence)}`);
        }
      }
      keyboard.tabSteps = keyboard.sequence.length;
      keyboard.reached = reached;
      /* 焦点保持：遍历终点仍在 #mat-blocks（无中途丢失已由逐步断言保证）。 */
      keyboard.focusRetainedThroughTraversal = true;
      /* 焦点样式可见（computed style）：Tab 聚焦的 #mat-blocks + 此前途经的
         #search-input（各自重走一次聚焦，读 computed outline）。 */
      const focusStyle = async (selector) => ctx.evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
          `if (el === null) return null; el.focus(); ` +
          `const cs = getComputedStyle(el); ` +
          `return { selector: ${JSON.stringify(selector)}, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, ` +
            `outlineColor: cs.outlineColor, focusVisible: el.matches(":focus-visible") }; })()`,
      );
      const blocksStyle = await focusStyle("#mat-blocks");
      const searchStyle = await focusStyle("#search-input");
      const styleProblems = [];
      for (const style of [blocksStyle, searchStyle]) {
        if (style === null || style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) <= 0) {
          styleProblems.push(JSON.stringify(style));
        }
      }
      if (styleProblems.length > 0) {
        throw new Error(`keyboard: the focus indicator is not visible (computed outline) — ${styleProblems.join("; ")}`);
      }
      keyboard.focusStyleVisible = { readerBlocks: blocksStyle, searchInput: searchStyle };
      /* 阅读器方向键滚动有效：焦点在 #mat-blocks 上（Tab 终点已重聚焦）。 */
      await ctx.evalJs(`(() => { document.getElementById("mat-blocks").focus(); return true; })()`);
      const arrowBefore = await ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
      for (let i = 0; i < 6; i += 1) await pressKey(ctx, "ArrowDown", "ArrowDown", 40);
      const arrowDown = await ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
      for (let i = 0; i < 3; i += 1) await pressKey(ctx, "ArrowUp", "ArrowUp", 38);
      const arrowUp = await ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
      if (!(arrowDown > arrowBefore)) {
        throw new Error(`keyboard: ArrowDown did not scroll the reader (${String(arrowBefore)} → ${String(arrowDown)})`);
      }
      if (!(arrowUp < arrowDown && arrowUp > 0)) {
        throw new Error(`keyboard: ArrowUp did not scroll back while staying in the material (${String(arrowDown)} → ${String(arrowUp)})`);
      }
      keyboard.arrowScroll = { before: arrowBefore, afterDown: arrowDown, afterUp: arrowUp };
      /* 焦点保持在滚动/懒加载重渲之后（焦点未丢）。 */
      const activeAfterArrows = await ctx.evalJs(ACTIVE_EL_EXPR);
      if (activeAfterArrows?.id !== "mat-blocks") {
        throw new Error(`keyboard: focus was lost after arrow-scrolling the reader — ${JSON.stringify(activeAfterArrows)}`);
      }
      keyboard.focusRetainedAfterArrowScroll = true;
      /* Enter 激活：焦点在阅读器关闭按钮上按 Enter → 阅读器关闭（button 的
         键盘激活语义）。 */
      await ctx.evalJs(`(() => { document.querySelector("#material-reader .mat-close").focus(); return true; })()`);
      await pressKey(ctx, "Enter", "Enter", 13, { text: "\r" });
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
        label: "keyboard: Enter on the reader close button closes the reader",
      });
      keyboard.enterActivation = "reader close button (Enter) closed the reader";
      /* Space 激活：焦点在搜索范围切换按钮上按 Space → aria-pressed 翻转。 */
      const spaceBefore = await ctx.evalJs(`(() => { const b = document.getElementById("search-scope-all"); b.focus(); return b.getAttribute("aria-pressed"); })()`);
      await pressKey(ctx, " ", "Space", 32);
      const spaceAfter = await ctx.evalJs(`(() => document.getElementById("search-scope-all").getAttribute("aria-pressed"))()`);
      if (spaceBefore === spaceAfter) {
        throw new Error(`keyboard: Space did not activate the search-scope toggle (aria-pressed ${String(spaceBefore)} unchanged)`);
      }
      await pressKey(ctx, " ", "Space", 32); /* 还原 */
      keyboard.spaceActivation = `search-scope toggle (Space) flipped aria-pressed ${String(spaceBefore)} → ${String(spaceAfter)} → ${String(spaceBefore)}`;
      /* Escape 分层关闭 + 焦点还原：抽屉 → 阅读器 → 支线面板。 */
      const escapeLayers = [];
      const recordEscape = async (label, open, closedExpr, verifyFocusExpr, focusTargetLabel) => {
        await open();
        await pressKey(ctx, "Escape", "Escape", 27);
        await waitFor(ctx, closedExpr, { label: `keyboard: Escape closed the ${label}`, timeoutMs: 10_000 });
        const focusState = await ctx.evalJs(
          `(() => { const a = document.activeElement; ` +
            `return { summary: a === null || a === document.body ? null : { id: a.id === "" ? null : a.id, tag: a.tagName, cls: String(a.className).slice(0, 50) }, ` +
              `ok: ${verifyFocusExpr} }; })()`,
        );
        escapeLayers.push({ layer: label, focusRestoredTo: focusTargetLabel, active: focusState.summary, ok: focusState.ok });
        if (focusState.ok !== true) {
          throw new Error(`keyboard: Escape closed the ${label} but focus was not restored to ${focusTargetLabel} — ${JSON.stringify(focusState)}`);
        }
      };
      await recordEscape(
        "source drawer",
        async () => {
          await inputClickAt(ctx, "#source-drawer-toggle");
          await waitFor(ctx, `(() => { const d = document.getElementById("source-drawer"); return d !== null && !d.hidden; })()`, { label: "source drawer open" });
        },
        `(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`,
        `document.activeElement === document.getElementById("source-drawer-toggle")`,
        "#source-drawer-toggle",
      );
      /* 阅读器的 Esc 焦点还原目标是打开它的材料列表按钮（materialReaderFocusReturn
         的 material-button 引用——动态按钮无 id，以落在 #material-list 内断言）。 */
      await recordEscape(
        "material reader",
        async () => {
          await inputClickAt(ctx, materialButtonSelector(scenarioSetup.materialBranchOrigin.materialId));
          await waitFor(
            ctx,
            `(() => { const r = document.getElementById("material-reader"); return r !== null && !r.hidden && document.querySelectorAll("#mat-blocks .material-block").length > 0; })()`,
            { label: "reader reopened (keyboard escape phase)" },
          );
        },
        `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`,
        `(() => { const a = document.activeElement; return a !== null && a.closest("#material-list") !== null; })()`,
        "the material-list button that opened the reader",
      );
      /* 面板的 Esc 还原目标是打开它的分支 tab（panelFocusReturn 的 tab 引用——
         动态按钮无 id，以落在该 tab 上断言）。 */
      await recordEscape(
        "branch panel",
        async () => {
          await inputClickAt(ctx, branchTabSelector);
          await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, { label: "panel reopened (keyboard escape phase)" });
        },
        `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`,
        `(() => { const a = document.activeElement; return a !== null && a.closest(${JSON.stringify(branchTabSelector)}) !== null; })()`,
        "the branch tab that opened the panel",
      );
      keyboard.escapeLayers = escapeLayers;
      keyboard.noFocusTrap = true;
    }

    /* ============ 7) focusScrollDraft：草稿/焦点/滚动会话内回程 ============ */
    const focusScrollDraft = {};
    {
      /* 起点：面板经 tab 点击打开（此前相位的开合状态不作为前提；阅读器
         若仍开着先收起——回程从干净态开始）。 */
      const readerOpenAtStart = await ctx.evalJs(`(() => { const r = document.getElementById("material-reader"); return r !== null && !r.hidden; })()`);
      if (readerOpenAtStart === true) {
        await inputClickAt(ctx, "#mat-close");
        await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
          label: "reader closed before the draft round trip",
        });
      }
      await inputClickAt(ctx, branchTabSelector);
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
        label: "panel open (draft round trip)",
        timeoutMs: 20_000,
      });
      /* 面板输入草稿问题（不提交）。 */
      const draftText = `草稿问题：回程后这段文字必须原样保留。（${BETA_MARKERS.draft}）`;
      await inputClickAt(ctx, "#panel-prompt-input");
      await ctx.cdpSend("Input.insertText", { text: draftText });
      const typedDraft = await ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
      if (typedDraft !== draftText) {
        throw new Error(`focusScrollDraft: the draft did not receive the typed text (got ${JSON.stringify(typedDraft)})`);
      }
      /* 面板滚动位置（离开前的记录 + 主动滚离贴底位置）。 */
      const panelScrollBefore = await ctx.evalJs(
        `(() => { const pc = document.getElementById("panel-conversation"); ` +
          `pc.scrollTop = Math.max(0, Math.floor((pc.scrollHeight - pc.clientHeight) / 2)); ` +
          `return { scrollTop: pc.scrollTop, scrollHeight: pc.scrollHeight, clientHeight: pc.clientHeight }; })()`,
      );
      /* 查看来源（离开）：阅读器开于锚定块。 */
      await domClick(ctx, "#panel-view-source");
      await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `return reader !== null && !reader.hidden && ` +
          `(reader.textContent ?? "").includes("jumped to the material source of a Return — located at block ${mdRange.blockId}"); })()`,
        { label: "focusScrollDraft: View source opened the reader at the anchored block", timeoutMs: 25_000 },
      );
      /* 阅读器下滚数屏（懒加载 + 滚动位置保存路径）。 */
      let topBlockAtClose = null;
      let readerScrollAtClose = null;
      for (let step = 0; step < 6; step += 1) {
        await ctx.evalJs(
          `(() => { const el = document.getElementById("mat-blocks"); ` +
            `el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight * 0.85)); return true; })()`,
        );
        await sleep(350);
      }
      const closeState = await ctx.evalJs(
        `(() => { const blocks = document.getElementById("mat-blocks"); ` +
          `const base = blocks.offsetTop; let first = null; ` +
          `for (const child of blocks.children) { ` +
            `if (child.dataset === undefined || child.dataset.blockId === undefined) continue; ` +
            `const blockId = child.dataset.blockId; if (first === null) first = blockId; ` +
            `const top = child.offsetTop - base; const height = child.offsetHeight; ` +
            `if (top + height > blocks.scrollTop + 1) return { topBlockAtClose: blockId, scrollTop: blocks.scrollTop, inViewBlocks: document.querySelectorAll("#mat-blocks .material-block").length }; } ` +
          `return { topBlockAtClose: first, scrollTop: blocks.scrollTop, inViewBlocks: document.querySelectorAll("#mat-blocks .material-block").length }; })()`,
      );
      if (closeState.topBlockAtClose === mdRange.blockId) {
        throw new Error(`focusScrollDraft: the reader did not scroll away from the anchored block before closing (${JSON.stringify(closeState)})`);
      }
      topBlockAtClose = closeState.topBlockAtClose;
      readerScrollAtClose = closeState.scrollTop;
      /* Esc 回支线：草稿保留 + 焦点还原 + 面板滚动保留 + （重开）阅读器位置保留。 */
      await pressKey(ctx, "Escape", "Escape", 27);
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
        label: "focusScrollDraft: Escape closed the reader (back to the branch panel)",
      });
      const backState = await ctx.evalJs(
        `(() => ({ panelOpen: !document.getElementById("branch-panel").hidden, ` +
          `draft: document.getElementById("panel-prompt-input").value, ` +
          `activeId: document.activeElement === null ? null : (document.activeElement.id || null), ` +
          `activeIsViewSource: document.activeElement === document.getElementById("panel-view-source"), ` +
          `panelScrollTop: document.getElementById("panel-conversation").scrollTop }))()`,
      );
      const backProblems = [];
      if (backState.panelOpen !== true) backProblems.push("the branch panel is not open after the reader closed");
      if (backState.draft !== draftText) backProblems.push(`the draft was not preserved (got ${JSON.stringify(backState.draft)})`);
      if (backState.activeIsViewSource !== true) backProblems.push(`focus was not restored to #panel-view-source (active ${JSON.stringify(backState.activeId)})`);
      if (Math.abs(backState.panelScrollTop - panelScrollBefore.scrollTop) > IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        backProblems.push(`the panel scroll position changed (${String(panelScrollBefore.scrollTop)} → ${String(backState.panelScrollTop)})`);
      }
      if (backProblems.length > 0) {
        throw new Error(`focusScrollDraft: the round trip lost state — ${backProblems.join("; ")}`);
      }
      focusScrollDraft.draftPreserved = true;
      focusScrollDraft.draftMarker = BETA_MARKERS.draft;
      focusScrollDraft.focusRestoredTo = "#panel-view-source";
      focusScrollDraft.panelScrollPreserved = { before: panelScrollBefore.scrollTop, after: backState.panelScrollTop };
      /* 阅读器滚动位置保留（会话内回程：应用自身的保存/恢复路径）。
         等关闭时冲刷的 reading-position PUT 落库（服务端可读回）。 */
      const materialId = scenarioSetup.materialBranchOrigin.materialId;
      let savedPosition = null;
      {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const detail = await ctx.api("GET", `/api/trees/${encodeURIComponent(scenarioSetup.treeId ?? (await ctx.evalJs(`(() => document.querySelector("#tree-list button.active span")?.textContent)()`)))}/materials/${encodeURIComponent(materialId)}`);
          if (detail.status === 200 && detail.body?.readingPosition?.blockId === topBlockAtClose) {
            savedPosition = detail.body.readingPosition;
            break;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `focusScrollDraft: the reader's reading-position save did not land in 10s (expected block ${String(topBlockAtClose)}, ` +
                `server says ${JSON.stringify(detail.body?.readingPosition?.blockId ?? null)})`,
            );
          }
          await sleep(150);
        }
      }
      /* 重开阅读器（材料列表按钮——自然的续读路径）：恢复到关闭时的保存块。 */
      await inputClickAt(ctx, materialButtonSelector(materialId));
      const restored = await waitFor(
        ctx,
        `(() => { const reader = document.getElementById("material-reader"); ` +
          `if (reader === null || reader.hidden) return false; ` +
          `if (!(reader.textContent ?? "").includes(${JSON.stringify(`restored to your saved reading position (block ${topBlockAtClose})`)})) return false; ` +
          `const blocks = document.getElementById("mat-blocks"); ` +
          `const block = document.querySelector('#mat-blocks [data-block-id="${topBlockAtClose}"]'); ` +
          `if (block === null) return false; ` +
          `return { scrollTop: blocks.scrollTop, blockTop: block.offsetTop - blocks.offsetTop, diff: Math.abs(blocks.scrollTop - (block.offsetTop - blocks.offsetTop)) }; })()`,
        { label: `focusScrollDraft: reopening the reader restores the saved position (block ${String(topBlockAtClose)})`,
          timeoutMs: 25_000 },
      );
      if (restored.diff > IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
        throw new Error(
          `focusScrollDraft: the restored scroll is not aligned to the saved block (scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)})`,
        );
      }
      focusScrollDraft.readerScrollPreserved = {
        topBlockAtClose,
        scrollTopAtClose: readerScrollAtClose,
        savedPosition,
        restoredToBlock: topBlockAtClose,
        restoredDiffPx: restored.diff,
        note: "in-session round trip via the app's own reading-position save/restore path (the cross-restart scenario belongs to d4-restart-continue)",
      };
      await ctx.screenshot("beta-draft-roundtrip-restored");
      await inputClickAt(ctx, "#mat-close");
      await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (draft phase end)" });
      await inputClickAt(ctx, "#panel-close");
      await waitFor(ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (draft phase end)" });
    }

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
