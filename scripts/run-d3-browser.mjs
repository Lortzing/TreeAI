#!/usr/bin/env node
/**
 * TreeAI D3 浏览器面跑批器（browser-UI-level，issue #6 修订项的浏览器层）。
 *
 * 定位：`run-d3-real-pi.mjs` 在 HTTP API 面驱动产品闭环；本脚本在同一
 * 剧本（同一 codeword 场景）上把断言面抬到**真实浏览器**——启动本机
 * Chromium/Chrome（headless，CDP over DevTools WebSocket），以真实输入
 * 事件（鼠标点击/拖选、键盘提交、IME 文本注入）驱动真实 Studio UI，
 * 断言用户实际看到的 DOM（渲染结构、可见文案、aria 属性、计算样式、
 * 窄窗/降级动效），并以 HTTP API 交叉核对服务器权威状态。
 *
 * 零外部依赖：CDP 客户端用 Node 内建 WebSocket 实现；不新增 npm 依赖、
 * 不进入 npm test / CI（与 run-d3-real-pi.mjs 同为本地证据工具）。
 *
 * 两种模式（同一剧本、同一断言面）：
 *   --mode selftest（默认）离线确定性 echo 驱动 + 真实浏览器渲染：
 *     零凭据、零外网；echo 答案 = 当前分支可见用户文本的精确回声，
 *     支线上下文隔离在渲染面上机械可证。用于自检与确定性回归。
 *   --mode real-pi   真实 Pi 驱动 + 真实浏览器渲染（负责人/授权操作者）：
 *     API key 仅经 TREEAI_STUDIO_API_KEY 环境注入——本脚本只检查变量
 *     **名**是否存在，值从不进入本进程内存（spawn 时整体透传环境给
 *     studio 子进程自行读取）；--provider/--model 必填。精确回声断言等
 *     echo 专属检查如实 NOT_RUN；模型错误注入在 real-pi 改经错误配置
 *     registry 的重启舞步执行（独立探针树，见 main() 双时序注释与
 *     stepModelErrorRealPi）；另含仅在真实模型时延窗口下可做的
 *     「响应丢失（在途整页刷新）」检查。
 *     可选工具缝（原样转发给 studio CLI，issue #6 P0-3 浏览器后半；
 *     仅 real-pi 且 --pi-tools 含 read 时运行，否则按模式/工具门如实
 *     NOT_RUN）：--pi-tools TOOL,TOOL（Pi 工具 allowlist，如 "read"）与
 *     --policy-read-roots DIR,DIR（读取根；须与 --pi-tools 同给；缺省
 *     收窄到 <data>/workspace/policy-allowed）。echo 模式给出 --pi-tools
 *     即用法错误（echo 驱动无工具执行器）；读取根的绝对/存在等校验由
 *     studio CLI 边界负责，本脚本不重复（但绝不明文吞掉未知旗标）。
 *     工具面场景为两段式（镜像 API 面跑批器 run-d3-real-pi.mjs 的 A5
 *     相）：主剧本检查（至 reduced-motion）全程零工具引导（主树计数 =
 *     无工具基线）；工具相先 SIGKILL 当前 studio，以工具缝重启同一
 *     数据目录，在全新探针树（真实 #new-tree 点击，干净 session）上
 *     以真实输入事件驱动——allow 对照（读取根内标记文件 → 回答含标记
 *     token、抽屉 Tool activity 呈现、会话文件含标记内容）与 overreach
 *     核心（canary 位于模型工作目录（workspace）之内、所有读取根之外
 *     → 执行前拦截：错误横幅 + 常驻失败面板 policy-denied、零回合
 *     落库、composer 复位；拒绝 provenance 经渲染抽屉文本与诊断面
 *     policyDecisions 呈现，路径/参数/token 绝不外泄；canary 内容绝不
 *     进入任何会话文件或渲染页面——受控 agent 目录 + 数据目录全树扫描
 *     兜底）。真实模型的工具调用合规性有方差：逃逸轮（模型未发起读取
 *     即作答）如实登记，allow/overreach 各最多 3 次尝试逐次加硬指令，
 *     PASS 仅要求其中一次收敛。
 *
 * A2 深选区相（issue #6 P1 / W2 §4；selftest 与 real-pi 双模式，无需
 *   工具缝）：把 ui-probe 三个脚本化 DOM 场景抬到真实浏览器操作——
 *   数千字符长答案的后段选区（非整条答案回退）、重复词**第二处**（绝不
 *   允许首处字符串匹配顶替）、跨渲染行选区（pre-wrap 真实行边界）。每
 *   场景一棵全新探针树（真实 #new-tree 点击，干净 session——主剧本树
 *   不受影响，相末核对计数不变）；经真实 composer 发送含确定性分节长块
 *   （~13k 字符，镜像 ui-probe 的 LONG_A2 结构）的 prompt。echo 答案 =
 *   精确回声 → 断言确定性偏移；real-pi 以「逐字复述该块」指令驱动，期望
 *   从**实际渲染答案**动态计算（后段短语取末次出现且深度 ≥85%、重复词取
 *   第二处出现、跨行窗口取换行两侧恰含一个换行）——答案 <3000 字符或
 *   结构缺失视为模型逃逸，逐次加硬指令最多 3 次尝试，逃逸轮如实登记。
 *   拖选落点按目标字符盒精确计算（按压点 = from 字符盒左缘内 1px、释放
 *   点 = to-1 字符盒右缘内 1px；长答案目标区先滚入滚动容器视口中央），
 *   断言链：选区武装 → 浏览器侧偏移（复刻 selectionOffsetsWithin 的前缀
 *   长度数学）与计算目标全等 → 建支线 → 面板摘录精确携带 → 服务器
 *   origin.selection 全等（API 交叉核对，非整条回退/非首处顶替即在此
 *   证明）→ 揭示切片（前缀/后缀恰切偏移两侧、跨行含换行）→ 锚定支线
 *   可续聊（每支线一条短 follow-up + 标记等待）。
 *
 * 浏览器边界（诚实声明，与 evidence/d3/browser/README.md 一致）：
 *   - 本脚本驱动 headless Chromium 的**真实渲染与输入管线**（真实
 *     布局/计算样式/事件传播），但不是目标 Mac 上的人工逐屏录屏口径
 *     ——后者仍属负责人（owner）验收步骤。
 *   - 截图写入本地 artifacts 目录（不设 --artifacts 时为临时目录，
 *     路径打印到 stdout）；截图等二进制**不入仓**，入库记录只携带
 *     脱敏 DOM 摘要（由操作者按 evidence/d3 纪律手工誊录）。
 *
 * 证据纪律：本脚本**不写 evidence/**——结果只登 stdout 事实；记录由
 * 负责人/授权操作者按 evidence/d3/templates/run-record.md 追加。
 * 秘密纪律：API key 值绝不读取、绝不打印；artifacts 写盘前做字面值
 * 与本机路径剥离（HOME/data 目录占位符化）。
 *
 * 退出码（沿用 D2 冻结纪律，coordination/d2/README.md）：
 *   0 — 当前模式适用的全部检查 PASS（模式门控的 NOT_RUN 属预期并列出）
 *   1 — 用法错误 / 跑批器自身失败（studio 无法启动按检查 FAIL 计）
 *   2 — 至少一项适用检查 FAIL（含 studio-boot 失败；其后检查如实 NOT_RUN）
 *   3 — 无 FAIL 但存在 BLOCKED（如 real-pi 模式缺少 TREEAI_STUDIO_API_KEY，
 *        或本机找不到可用的 Chromium/Chrome 可执行文件）
 *
 * 用法：
 *   node scripts/run-d3-browser.mjs                     # echo 自检（默认）
 *   node scripts/run-d3-browser.mjs --mode real-pi \
 *     --provider deepseek --model deepseek-flash        # 需 TREEAI_STUDIO_API_KEY
 *   可选：[--data DIR] [--keep-data] [--artifacts DIR]
 *         [--chrome-executable PATH] [--prompt-timeout-ms N]
 *   real-pi 工具缝（原样转发 studio CLI；工具面场景仅 --pi-tools 含
 *   read 时运行）：[--pi-tools TOOL,TOOL] [--policy-read-roots DIR,DIR]
 */

import { spawn, execSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "run-d3-browser";
const VERSION = "1.3.1";
const STUDIO_ENTRY = join(ROOT, "apps", "studio", "src", "index.ts");
/** 真实 Pi 驱动的 API key 环境变量（日志中只允许出现该名字）。 */
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const MODES = ["selftest", "real-pi"];
const BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_SETTLE_MS = 30_000;
const GET_TIMEOUT_MS = 15_000;
const CDP_SEND_TIMEOUT_MS = 30_000;
/** 模型错误注入的不可路由 provider baseUrl（回环 9 端口 = discard：连接
 *  立即被拒，绝不产生真实 provider 请求；镜像 run-d3-real-pi.mjs 的已证
 *  手法——evidence/d3/real-pi/20260929T104445Z-faults-model-error.md）。 */
const MISCONFIG_BASE_URL = "http://127.0.0.1:9/";
const VIEWPORT = { width: 1280, height: 900 };
const NARROW_VIEWPORT = { width: 480, height: 800 };
/** 本机 Chromium 候选（macOS 常见安装位 + PATH 探测，Linux 兼容）。 */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];
const USAGE = [
  `usage: node scripts/run-d3-browser.mjs [--mode ${MODES.join("|")}]`,
  "       real-pi mode additionally requires:",
  `         --provider ID --model ID  (and the ${PI_API_KEY_ENV} env var)`,
  "       optional: [--data DIR] [--keep-data] [--artifacts DIR]",
  "                 [--chrome-executable PATH] [--prompt-timeout-ms N]",
  "       real-pi agent dir (non-secret provider/model registry):",
  "         [--agent-dir DIR]  (default: the studio CLI's <data>/pi-agent)",
  "       real-pi tool gate (forwarded verbatim to the studio CLI; the browser tool-policy",
  "       phase runs only when the tool list includes 'read'):",
  "         [--pi-tools TOOL,TOOL] [--policy-read-roots DIR,DIR]",
].join("\n");

/* ------------------------------------------------------------------ */
/* 剧本（与 run-d3-real-pi.mjs 同一 codeword 场景；canary 词为跨支线    */
/* 上下文串扰探针；echo 答案 = 可见用户文本的精确回声，串扰机械可见）    */
/* ------------------------------------------------------------------ */

const SCENARIO = {
  /* 指令要求「逐字短语」——真实模型照办；短语长度保证浏览器面拖选有
     稳定的字符区间（真实模型对 "Reply with: understood." 只回一个词，
     拖选会被钳到整条答案，锚定区间失真）。 */
  t1: "This is the main line, turn one. The trunk topic is apples. Remember the trunk codeword: maple. Reply with exactly: understood — the trunk topic is apples and the codeword is maple.",
  t2: "Main line, turn two. The trunk secret number is 4127. Reply with exactly: noted — the secret number 4127 is registered on the main line.",
  t3: "Main line, turn three. Did any branch return a delivery marker to you? Quote it exactly if so, otherwise reply: none.",
  a1: "We are now on branch A, about avocados. Remember branch A's codeword: cedar. Reply with: ok-a1.",
  a2: "Branch A, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  b1: "We are now on branch B, about batteries. Remember branch B's codeword: birch. Reply with: ok-b1.",
  b2: "Branch B, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  returnText:
    "Branch A return note: the agreed delivery marker is aspen. Acknowledge the marker when asked on the main line.",
  fail: "/fail this prompt must converge as a simulated upstream model error",
  recovery: "After the earlier failure, the main line continues. Reply with: back-online.",
  /* 模型错误注入相（real-pi 专属，探针树）：失败轮与恢复轮用同一文本
     ——「上一次失败的同一 prompt 在配置修复 + 重启后成功」即恢复语义
     本身（镜像 run-d3-real-pi.mjs phaseModelError 的 real-pi 分支）。 */
  modelErrorProbe: "Reply with the single word: online.",
};
const CANARIES = ["maple", "4127", "cedar", "birch", "aspen"];
/** 支线拖选的字符子区间（答案内、避开句首句尾标点的稳定窗口）。 */
const SELECT_A = { from: 24, to: 52 };
const SELECT_B = { from: 30, to: 61 };

/* ------------------------------------------------------------------ */
/* A2 深选区场景文本（issue #6 P1 / W2 §4；镜像 ui-probe 的三个脚本化     */
/* DOM 场景：LONG_A2 / DUP_A2 / CROSS_A2——这里以「prompt 携带确定性分节   */
/* 长块」的形态经真实 composer 发送：echo 答案 = 精确回声 → 确定性偏移；   */
/* real-pi 以逐字复述指令驱动，期望从实际渲染答案动态计算）。              */
/* ------------------------------------------------------------------ */

/** 与 ui-probe LONG_A2_PARAGRAPH 同源的节文本（125 字符）。 */
const DEEP_SECTION_TEXT =
  "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const DEEP_INTRO = "A long structured block follows, composed of numbered sections separated by newlines.";
/** 长答案场景的后段目标短语（块尾行携带；ask 文本绝不含它）。 */
const DEEP_LATE_PHRASE = "late anchor target phrase";
/** 重复词场景的故意重复词（第 12/33 节各一次；ask 文本绝不含它）。 */
const DEEP_DUP_WORD = "alpha";
/** 跨行场景的换行两侧短语（插在第 20/21 节之间两行的行中/行中）。 */
const DEEP_CROSS_OPEN = "anchor start:";
const DEEP_CROSS_CLOSE = "next rendered line";
/** real-pi 模型方差门槛：答案低于此长度视为逃逸（逐次加硬重试）。 */
const DEEP_MIN_ANSWER_CHARS = 3000;
/** 后段选区深度门槛：目标短语出现位置须 ≥ 该比例（ui-probe echo 面 >0.9，
 * real-pi 面放宽到 0.85——模型可能附言，但不得远离尾部）。 */
const DEEP_LATE_DEPTH = 0.85;

/** 数千字符分节长块（36 节 × 375 字符节文 ≈ 13k，镜像 LONG_A2 的体量）。 */
function deepSections({ decorate = null, insertAfter20 = null, closing = "The closing paragraph ends the block." } = {}) {
  const lines = [DEEP_INTRO];
  for (let i = 1; i <= 36; i += 1) {
    let line = `Section ${i}: ${DEEP_SECTION_TEXT.repeat(3)}`;
    if (decorate !== null) line += decorate(i);
    lines.push(line);
    if (i === 20 && insertAfter20 !== null) lines.push(...insertAfter20);
  }
  lines.push(closing);
  return lines.join("\n");
}

/** 三场景的确定性长块（互不包含对方的锚点短语——动态定位不串场）。 */
const DEEP_BLOCKS = {
  long: deepSections({ closing: `The closing paragraph carries the ${DEEP_LATE_PHRASE}.` }),
  duplicate: deepSections({
    decorate: (i) =>
      i === 12 ? ` The marker word for this probe is ${DEEP_DUP_WORD}.` : i === 33 ? ` The marker word returns here: ${DEEP_DUP_WORD}.` : "",
  }),
  crossLine: deepSections({
    insertAfter20: [
      `Cross-line ${DEEP_CROSS_OPEN} the selection opens on this rendered line.`,
      `the selection closes on the ${DEEP_CROSS_CLOSE} after the break.`,
    ],
  }),
};

/** real-pi 逐次加硬的复述指令（echo 面恒第 1 条即中）。 */
const DEEP_ASKS = [
  "Selection probe. Repeat the block below verbatim in your reply, then stop.",
  "Selection probe, second attempt. Repeat the ENTIRE block below verbatim — every line, exactly as written, no summary, no truncation, no added commentary before or after.",
  "Selection probe, final attempt. You must repeat the whole block below character-for-character, from its first line to its last line, with nothing else in your reply.",
];

/** 期望计算：从实际渲染答案动态求目标 {start,end,text}；不满足场景结构
 * （短语缺失/深度不足/出现次数不足/跨行窗口不恰含一个换行）→ ok:false
 * （真实模型方差，如实登记后重试）。 */
function deepLongExpectation(answerText) {
  const start = answerText.lastIndexOf(DEEP_LATE_PHRASE);
  if (start < 0) return { ok: false, reason: "the late-tail phrase never appeared in the answer" };
  const depth = start / answerText.length;
  if (depth < DEEP_LATE_DEPTH) {
    return { ok: false, reason: `the phrase occurrence sits at depth ${depth.toFixed(3)} (< ${String(DEEP_LATE_DEPTH)} — answer shape escaped)` };
  }
  return { ok: true, start, end: start + DEEP_LATE_PHRASE.length, text: DEEP_LATE_PHRASE, depth };
}

function deepDuplicateExpectation(answerText) {
  const word = DEEP_DUP_WORD;
  const first = answerText.indexOf(word);
  const second = first < 0 ? -1 : answerText.indexOf(word, first + word.length);
  if (second < 0) {
    return { ok: false, reason: `the duplicated word appeared ${first < 0 ? "0" : "1"} time(s) in the answer (needs at least 2)` };
  }
  return { ok: true, start: second, end: second + word.length, text: word, first };
}

function deepCrossLineExpectation(answerText) {
  const start = answerText.indexOf(DEEP_CROSS_OPEN);
  if (start < 0) return { ok: false, reason: "the cross-line opening phrase never appeared in the answer" };
  const closeAt = answerText.indexOf(DEEP_CROSS_CLOSE, start);
  if (closeAt < 0) return { ok: false, reason: "the cross-line closing phrase never appeared after the opening one" };
  const end = closeAt + DEEP_CROSS_CLOSE.length;
  const text = answerText.slice(start, end);
  const newlines = text.split("\n").length - 1;
  if (newlines !== 1) {
    return { ok: false, reason: `the computed window spans ${String(newlines)} line break(s) (needs exactly 1)` };
  }
  return { ok: true, start, end, text, newlines };
}

const CHECK_DEFS = [
  { id: "chrome-boot", modes: MODES },
  { id: "studio-boot", modes: MODES },
  { id: "page-boot", modes: MODES },
  { id: "tree-create", modes: MODES },
  { id: "trunk-main-line", modes: MODES },
  { id: "selection-anchoring", modes: MODES },
  { id: "branch-a-create", modes: MODES },
  { id: "branch-a-followups", modes: MODES },
  { id: "switch-navigation", modes: MODES },
  { id: "branch-b-create", modes: MODES },
  { id: "branch-b-followups", modes: MODES },
  { id: "no-context-bleed", modes: MODES },
  { id: "return-flow", modes: MODES },
  { id: "return-delivery", modes: MODES },
  /* 模型错误收敛在两种模式各有一条确定性注入路径：selftest 经 /fail
     钩子（主树，本清单原位置执行）；real-pi 经错误配置 registry 的
     重启舞步（独立探针树，A2 深选区相之后、工具相引导之前执行）——
     见 main() 的双时序注释与 stepModelErrorRealPi。 */
  { id: "model-error-convergence", modes: MODES },
  { id: "server-restart-recovery", modes: MODES },
  { id: "missing-session-degradation", modes: MODES },
  {
    id: "response-loss-midstream",
    modes: ["real-pi"],
    notRun: {
      selftest:
        "the echo driver's ~1ms turn delay leaves no deterministic in-flight window for a mid-stream page reload; the server-down-between-prompts half is covered by server-restart-recovery in both modes",
    },
  },
  { id: "a11y-semantics", modes: MODES },
  { id: "narrow-window-layout", modes: MODES },
  { id: "reduced-motion", modes: MODES },
  /* A2 深选区相（issue #6 P1 / W2 §4；双模式，无需工具缝）：每场景一棵
     全新探针树，主剧本树计数不受影响（相末由 selection-deep-cross-line
     核对）。置于主剧本全部检查之后、工具相引导之前——real-pi 下本相
     全程零工具引导（深选区无需工具；工具方差不沾染）。 */
  { id: "selection-deep-long", modes: MODES },
  { id: "selection-deep-duplicate", modes: MODES },
  { id: "selection-deep-cross-line", modes: MODES },
  {
    id: "tool-policy-boot",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      selftest:
        "the browser tool-policy phase needs the real Pi request-time gate booted with --pi-tools read through the studio CLI (--driver pi); the echo driver has no tool executor and --pi-tools is rejected in echo mode — the offline lock-ins are apps/studio/tests/events.test.ts + cli.test.ts and the API-level product-path recording is evidence/d3/real-pi/20260929T124851Z-product-loop-tools.md",
    },
  },
  {
    id: "tool-policy-allow-read",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "tool-policy-deny-fail-closed",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "tool-policy-deny-provenance",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "tool-policy-canary-never-read",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
    },
  },
  { id: "console-clean", modes: MODES },
];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/** 逗号分隔列表解析（镜像 studio CLI 的 parseList：剔除空白项）。 */
function parseCommaList(raw) {
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseCli(argv) {
  const raw = {
    mode: "selftest",
    dataDir: null,
    keepData: false,
    artifactsDir: null,
    chromeExecutable: null,
    promptTimeoutMs: DEFAULT_PROMPT_SETTLE_MS,
    provider: null,
    model: null,
    agentDir: null,
    piTools: null,
    policyReadRoots: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${USAGE}\n(bad or missing value for '${String(flag)}')`);
    if (flag === "--mode") raw.mode = value;
    else if (flag === "--data") raw.dataDir = value;
    else if (flag === "--keep-data") {
      raw.keepData = true;
      i -= 1; /* 无参旗标 */
    } else if (flag === "--artifacts") raw.artifactsDir = value;
    else if (flag === "--chrome-executable") raw.chromeExecutable = value;
    else if (flag === "--prompt-timeout-ms") raw.promptTimeoutMs = Number(value);
    else if (flag === "--provider") raw.provider = value;
    else if (flag === "--model") raw.model = value;
    else if (flag === "--agent-dir") raw.agentDir = value;
    else if (flag === "--pi-tools") raw.piTools = value;
    else if (flag === "--policy-read-roots") raw.policyReadRoots = value;
    else throw new Error(`${USAGE}\n(unknown flag: ${String(flag)})`);
  }
  if (!MODES.includes(raw.mode)) throw new Error(`${USAGE}\n(--mode must be one of ${MODES.join(", ")})`);
  if (!Number.isFinite(raw.promptTimeoutMs) || raw.promptTimeoutMs < 1000) {
    throw new Error(`${USAGE}\n(--prompt-timeout-ms must be a number >= 1000)`);
  }
  if (raw.mode === "real-pi") {
    if (raw.provider === null || raw.model === null) {
      throw new Error(`${USAGE}\n(--mode real-pi requires --provider and --model)`);
    }
    if (raw.agentDir !== null && !existsSync(raw.agentDir)) {
      throw new Error(`${USAGE}\n(--agent-dir does not exist: ${raw.agentDir})`);
    }
    if (process.env[PI_API_KEY_ENV] === undefined || process.env[PI_API_KEY_ENV] === "") {
      throw new Error(
        `BLOCKED: --mode real-pi needs the ${PI_API_KEY_ENV} env var (name only is printed; the value is never read by this script)`,
      );
    }
  } else if (raw.provider !== null || raw.model !== null || raw.agentDir !== null) {
    throw new Error(`${USAGE}\n(--provider/--model/--agent-dir apply only to --mode real-pi)`);
  }
  /* 工具缝旗标的早期校验（镜像 run-d3-real-pi.mjs 的边界子集；绝对/
     存在等完整校验由 studio CLI 负责——CLI 是边界，这里绝不重复整套）。 */
  if (raw.piTools !== null && raw.mode !== "real-pi") {
    throw new Error(
      `${USAGE}\n(--pi-tools applies only to --mode real-pi (the echo driver has no tool executor; the browser tool-policy phase needs the real Pi request-time gate))`,
    );
  }
  if (raw.policyReadRoots !== null && raw.piTools === null) {
    throw new Error(
      `${USAGE}\n(--policy-read-roots requires --pi-tools (read roots scope the ToolPolicy engine that gates the enabled tools))`,
    );
  }
  raw.piToolsList = raw.piTools === null ? null : parseCommaList(raw.piTools);
  raw.policyReadRootsList = raw.policyReadRoots === null ? null : parseCommaList(raw.policyReadRoots);
  return raw;
}

const CLI = parseCli(process.argv.slice(2));
const MODE = CLI.mode;

/* ------------------------------------------------------------------ */
/* 通用小工具                                                           */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function truncate(text, maxLength) {
  const s = String(text);
  return s.length <= maxLength ? s : `${s.slice(0, maxLength)}…`;
}

/** 本机路径/家目录占位符化：artifacts 写盘与 stdout 事实的统一脱敏。 */
function sanitizeText(text) {
  let out = String(text);
  if (process.env.HOME !== undefined && process.env.HOME.length > 1) {
    out = out.split(process.env.HOME).join("~");
  }
  for (const dir of [sc.dataDir, sc.artifactsDir, sc.modelError?.misconfigDir, chrome?.profileDir].filter((d) => typeof d === "string")) {
    if (dir !== null && dir.length > 1) out = out.split(dir).join("<dir>");
  }
  return out;
}

function gitInfo() {
  const head = spawnSyncText("git", ["rev-parse", "HEAD"]);
  const dirty = spawnSyncText("git", ["status", "--porcelain"]);
  return { head, dirty: dirty.trim().length > 0 };
}

function spawnSyncText(command, args) {
  try {
    return execSync([command, ...args].join(" "), { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** 挑一个空闲 TCP 端口（listen 0 后读取；本地竞态窗口足够小）。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * 目录边界包含性（镜像 tool-policy paths.ts 的 isPathWithin 字符串语义）：
 * 调用方须先做物理解析（physicalPath），避免符号链接造成的假性内外。
 */
function isPathWithin(target, root) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** 物理路径（realpathSync.native：OS POSIX 语义，解析符号链接）。失败 → null。 */
function physicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** 递归列出目录下所有文件（目录缺失/不可读 → 空列表；canary 扫描与
 *  sessions 快照共用——Pi SDK 的会话文件可能按模型/日期嵌套存放）。 */
function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** 树的 session 文件（全树一个 .jsonl——支线经 navigateTree 在同一文件
 *  的 entry 树上续聊，不换文件）：含指定提示词的会话文件必须恰好一个。 */
function findTreeSessionFile(promptNeedle) {
  const candidates = walkFiles(join(sc.dataDir, "sessions")).filter((path) => path.endsWith(".jsonl"));
  const hits = candidates.filter((path) => {
    try {
      return readFileSync(path, "utf8").includes(promptNeedle);
    } catch {
      return false;
    }
  });
  assert(
    hits.length === 1,
    `expected exactly one tree session file containing the ${JSON.stringify(promptNeedle)} prompt, found ${String(hits.length)}`,
  );
  return hits[0];
}

/** session entry 树的可见性路径（真实模型下列举措辞有方差——20260929T161646Z
 *  的 b2 只回 "birch"，模型行为不构成串扰证据）：从含 promptNeedle 的用户
 *  entry 沿 parentId 走到根，收集路径上全部 message 文本。这条链正是
 *  navigateTree 续聊点的完整可见上下文——标记词在/不在路径上即上下文
 *  可见性的机械证明，与模型怎么措辞无关。 */
function sessionEntryPathText(sessionFile, promptNeedle) {
  let entries;
  try {
    entries = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch (err) {
    throw new Error(`the tree session file could not be read/parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byId = new Map(entries.filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
  const leaf = entries.find(
    (e) =>
      e.type === "message" &&
      e.message !== null &&
      typeof e.message === "object" &&
      e.message.role === "user" &&
      JSON.stringify(e.message.content ?? "").includes(promptNeedle),
  );
  if (leaf === undefined) {
    throw new Error(`no user entry carrying the ${JSON.stringify(promptNeedle)} prompt found in the tree session file`);
  }
  const texts = [];
  let current = leaf;
  while (current !== undefined) {
    if (current.type === "message" && Array.isArray(current.message?.content)) {
      for (const part of current.message.content) {
        if (typeof part?.text === "string") texts.push(part.text);
      }
    }
    const parent = current.parentId;
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  return texts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Chromium 定位与 CDP 客户端（零依赖：Node 内建 WebSocket）             */
/* ------------------------------------------------------------------ */

function findChromeExecutable() {
  if (CLI.chromeExecutable !== null) {
    if (!existsSync(CLI.chromeExecutable)) return null;
    return CLI.chromeExecutable;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket connect timeout: ${url}`)), 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP WebSocket error: ${url}`)); }, { once: true });
    });
    const conn = new CdpConnection(ws);
    ws.addEventListener("message", (event) => conn.handleMessage(String(event.data)));
    ws.addEventListener("close", () => { conn.closed = true; });
    return conn;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry !== undefined) {
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
      }
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers !== undefined) for (const fn of handlers) fn(message.params ?? {});
  }

  send(method, params = {}, timeoutMs = CDP_SEND_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`CDP send after close: ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP send timeout (${String(timeoutMs)}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(fn);
    this.listeners.set(method, handlers);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

const chrome = {
  executable: null,
  profileDir: null,
  child: null,
  port: 0,
  cdp: null,
  /** 页面意外错误的登记处（console error / Log error；favicon 404 除外）。 */
  pageErrors: [],
  /** 故障注入窗口内预期的错误（server-restart 等检查置位，不计入 console-clean）。 */
  expectPageErrors: false,
  /** 页面网络事实（Network domain）：请求/响应/失败——超时诊断用。 */
  netLog: [],
  netLogIndex: new Map(),
  screenshotSeq: 0,
};

async function startChrome() {
  chrome.executable = findChromeExecutable();
  if (chrome.executable === null) {
    throw new Error(
      "BLOCKED: no Chromium/Chrome executable found — pass --chrome-executable PATH (candidates probed: " +
        `${CHROME_CANDIDATES.map((p) => `"${p}"`).join(", ")})`,
    );
  }
  chrome.profileDir = mkdtempSync(join(tmpdir(), "treeai-d3-chrome-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${chrome.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--force-device-scale-factor=1",
    "--window-size=1280,900",
    "about:blank",
  ];
  chrome.child = spawn(chrome.executable, args, { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome boot timeout: no DevTools listening line in 20s")), 20_000);
    chrome.child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`chrome exited during boot (code ${String(chrome.child.exitCode)})`));
    });
  });

  const url = new URL(wsUrl);
  chrome.port = Number(url.port);

  /* 等待 HTTP 端点就绪并定位初始 page target。 */
  let target = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(chrome.port)}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        target = targets.find((t) => t.type === "page") ?? null;
        if (target !== null) break;
      }
    } catch {
      /* chrome 尚未就绪 */
    }
    await sleep(100);
  }
  if (target === null) throw new Error("chrome booted but no page target appeared on /json/list");

  chrome.cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await chrome.cdp.send("Page.enable");
  await chrome.cdp.send("Runtime.enable");
  await chrome.cdp.send("Log.enable");
  await chrome.cdp.send("Network.enable");
  await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* 页面网络事实采集（诊断面：请求是否发出/响应是否返回/失败原因）。 */
  chrome.cdp.on("Network.requestWillBeSent", (params) => {
    const entry = { id: params.requestId, method: params.request.method, url: params.request.url, status: null, failed: null };
    chrome.netLog.push(entry);
    chrome.netLogIndex.set(params.requestId, entry);
  });
  chrome.cdp.on("Network.responseReceived", (params) => {
    const entry = chrome.netLogIndex.get(params.requestId);
    if (entry !== undefined) entry.status = params.response.status;
  });
  chrome.cdp.on("Network.loadingFailed", (params) => {
    const entry = chrome.netLogIndex.get(params.requestId);
    if (entry !== undefined) entry.failed = params.errorText;
  });

  /* 页面错误采集（console.error / Log error）；favicon 404 视为浏览器噪声；
     故障注入窗口（chrome.expectPageErrors）内的连接类错误按预期不计。 */
  chrome.cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error" || chrome.expectPageErrors) return;
    const text = (params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (text.includes("favicon")) return;
    chrome.pageErrors.push({ source: "console", text: sanitizeText(text) });
  });
  chrome.cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry ?? {};
    if (entry.level !== "error" || chrome.expectPageErrors) return;
    const url = entry.url ?? "";
    if (url.includes("favicon")) return;
    chrome.pageErrors.push({ source: "log", text: sanitizeText(`${entry.text}${url === "" ? "" : ` (${url})`}`) });
  });
}

function stopChrome() {
  if (chrome.cdp !== null) chrome.cdp.close();
  if (chrome.child !== null && chrome.child.exitCode === null) {
    chrome.child.kill("SIGKILL");
  }
  if (chrome.profileDir !== null) {
    try { rmSync(chrome.profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

/* ------------------------------------------------------------------ */
/* CDP 驱动助手（真实输入事件 + DOM 断言）                              */
/* ------------------------------------------------------------------ */

async function evalJs(expression, timeoutMs = CDP_SEND_TIMEOUT_MS) {
  const result = await chrome.cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`page evaluate failed: ${truncate(detail ?? "unknown", 400)}\n  at: ${truncate(expression, 200)}`);
  }
  return result.result.value;
}

/** 轮询直到页面内表达式为真值（或超时）。 */
async function waitForJs(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evalJs(expression);
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timeout (${String(timeoutMs)}ms) waiting for: ${label ?? expression}`);
    }
    await sleep(80);
  }
}

/** 元素滚入视口并返回其视口坐标矩形（点击/拖选的落点基础）。 */
async function rectInView(selector) {
  await evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      "if (el !== null && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' }); })()",
  );
  await sleep(60); /* 等一帧滚动落位 */
  return evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      "if (el === null) return null; const r = el.getBoundingClientRect();" +
      "return { x: r.x, y: r.y, width: r.width, height: r.height, " +
      "visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight }; })()",
  );
}

async function click(selector) {
  const rect = await rectInView(selector);
  assert(rect !== null, `click target not found: ${selector}`);
  assert(rect.visible, `click target not visible: ${selector}`);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  /* 覆盖层防护：点击点必须命中目标（或其子元素）——来源抽屉等 fixed
     覆盖层会把点击静默吞掉（真实用户同样点不到被盖住的按钮）。 */
  const hit = await evalJs(
    `(() => { const el = document.elementFromPoint(${String(x)}, ${String(y)}); ` +
    `const target = document.querySelector(${JSON.stringify(selector)}); ` +
    "return el !== null && target !== null && (el === target || target.contains(el)); })()",
  );
  assert(hit === true, `click point of ${selector} is covered by another element (fixed overlay open?) — elementFromPoint mismatch`);
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120); /* 事件处理 + 渲染落位 */
}

/** 真实键盘提交（Cmd/Ctrl+Enter）：app.js 的 keydown 监听路径。 */
async function pressModifierEnter(modifier) {
  const modifiers = modifier === "meta" ? 4 : 2;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await sleep(120);
}

/** 真实单键（Esc 逐层关闭等）：app.js 的 document keydown 监听路径。 */
async function pressKey(key, code, windowsVirtualKeyCode) {
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  await sleep(200); /* 抽屉/面板收起的 170ms 退出动画窗口 */
}

/** 聚焦可编辑元素并注入文本（走浏览器原生输入管线，等价粘贴路径）。
 * replace=true 时先建立全选（textarea 上 setSelectionRange(0, len)——与
 * 用户 ⌘A 等价的选区），insertText 随后经原生编辑管线替换选区。
 * （失败 prompt 会把文本留在输入框，append 会把恢复 prompt 拼成
 * /fail… 前缀；Return 草稿框亦按 W1 预填上一答案——全选覆盖是唯一
 * 确定性路径。） */
async function typeInto(selector, text, { replace = false } = {}) {
  const rect = await rectInView(selector);
  assert(rect !== null, `type target not found: ${selector}`);
  assert(rect.visible, `type target not visible: ${selector}`);
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 1, clickCount: 1 });
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 0, clickCount: 1 });
  await sleep(80);
  const focused = await evalJs(`document.activeElement !== null && document.activeElement.id === ${JSON.stringify(selector.replace(/^#/, ""))}`);
  assert(focused === true, `type target did not take focus: ${selector}`);
  if (replace) {
    const selected = await evalJs(
      `(() => { const el = document.activeElement; el.setSelectionRange(0, el.value.length); ` +
      "return el.selectionStart === 0 && el.selectionEnd === el.value.length; })()",
    );
    assert(selected === true, "replace-mode full selection did not take (setSelectionRange)");
    await sleep(40);
  }
  /* 分块注入（A2 深选区相的 ~13k 字符 prompt）：insertText 走原生编辑
     管线逐块追加（IME 组合路径），末尾整值比对兜底——块边界行为异常即
     如实 FAIL，绝不静默截断。 */
  const CHUNK = 2000;
  for (let offset = 0; offset < text.length; offset += CHUNK) {
    await chrome.cdp.send("Input.insertText", { text: text.slice(offset, offset + CHUNK) });
    await sleep(30);
  }
  await sleep(80);
  const value = await evalJs(`document.activeElement === null ? null : document.activeElement.value`);
  assert(value === text, `typed text mismatch (got ${truncate(String(value), 80)})`);
}

/**
 * 真实拖选：在元素的正文文本节点上按字符偏移 [from,to) 建立原生选区
 * （mousePressed → mouseMoved 序列 → mouseReleased），浏览器原生完成
 * Selection；元素自身的 mouseup 处理器随后读取 window.getSelection()
 * 计算 {start,end,text} 偏移（W1 §1.1 绝对偏移路径）。
 *
 * 落点精度（A2 深选区相所需的精确 [from,to) 语义）：按压点取 from 处
 * 字符盒左缘内 1px（最近字符边界 = 偏移 from），释放点取 to-1 处字符盒
 * 右缘内 1px（最近字符边界 = 偏移 to）——真实拖选以字符粒度落位，偏移
 * 即精确命中。长答案（数千字符、数百渲染行）的目标字符常在首屏之外
 * （scrollIntoView 整元素居中放不下）：把 [from,to] 区间中点滚到滚动层
 * 视口中央（先内层滚动容器、无则文档滚动——**长对话下本产品实际滚动的
 * 是文档**：#app 为 min-height 而非 height，#conversation 的 min-height:
 * auto 链被放开、内部滚动容器不启用；跑批器按实况滚动，该产品布局
 * 发现随 scrolledBy 事实登入检查 detail，由 owner 裁决），再以滚动后的
 * 坐标取矩形并派发真实鼠标事件（getBoundingClientRect 为视口相对值，
 * scrollTop 同步改后强制布局即为终值）。场景文本须保证 from 与 to-1 落
 * 在可见字符上（避开换行符与行缘空白——pre-wrap 下其字符盒不可靠）。
 */
async function dragSelect(selector, from, to) {
  const points = await evalJs(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: 'center' });
      /* 只统计 <br> 之前的正文文本节点（其后是按钮与提示，不属于答案文本）。 */
      const walker = [];
      for (const node of el.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') break;
        if (node.nodeType === Node.TEXT_NODE) walker.push(node);
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'MARK') {
          for (const inner of node.childNodes) if (inner.nodeType === Node.TEXT_NODE) walker.push(inner);
        }
      }
      if (walker.length === 0) return null;
      const total = walker.reduce((n, node) => n + node.textContent.length, 0);
      const clamp = (i) => Math.max(0, Math.min(i, total));
      /* 偏移 → 字符盒：[i, i+1) 的 Range 矩形即第 i 个字符的渲染盒。 */
      const charBox = (target) => {
        const t = Math.max(0, target);
        let acc = 0;
        for (const node of walker) {
          const len = node.textContent.length;
          if (t < acc + len) {
            const range = document.createRange();
            range.setStart(node, t - acc);
            range.setEnd(node, t - acc + 1);
            const boxes = range.getClientRects();
            if (boxes.length > 0) return boxes[boxes.length - 1];
            return range.getBoundingClientRect();
          }
          acc += len;
        }
        return null;
      };
      let fromBox = charBox(clamp(${String(from)}));
      let toBox = charBox(clamp(${String(to)}) - 1);
      if (fromBox === null || toBox === null) return null;
      /* 目标区滚入安全视口带：从内层滚动容器向外找（无内层可滚则文档
         滚动——见函数头的产品布局注记），把区间中点滚到该层视口中央；
         逐层最多 3 轮（内层滚到头仍出带 → 下一轮向外层找）。
         v1.3.1：安全带以目标最近的滚动容器的可视矩形为准，并与窗口带
         取交（限高骨架下 #conversation 的可视带远小于窗口——上沿顶栏、
         下沿 composer；仅按窗口带判断时，位于容器裁剪沿之下的字符盒会
         被误判为已入带，拖选落点落到 composer 上，原生选区逃出答案
         turn，武装失败——2026-09-30 视觉重构波真实模型跨行深选区场景
         实录，回放见该波记录）。 */
      const clipRect = (() => {
        let node = el.parentElement;
        while (node !== null && node !== document.body) {
          const cs = getComputedStyle(node);
          if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
            return node.getBoundingClientRect();
          }
          node = node.parentElement;
        }
        return null;
      })();
      const bandTop = clipRect === null ? 80 : Math.max(80, clipRect.top + 24);
      const bandBottom = clipRect === null ? window.innerHeight - 80 : Math.min(window.innerHeight - 80, clipRect.bottom - 24);
      const inBand = () => Math.min(fromBox.top, toBox.top) >= bandTop && Math.max(fromBox.bottom, toBox.bottom) <= bandBottom;
      let searchFrom = el.parentElement;
      let scrolledBy = "none";
      for (let pass = 0; pass < 3 && !inBand(); pass += 1) {
        let scroller = searchFrom;
        while (scroller !== null) {
          const cs = getComputedStyle(scroller);
          if (/(auto|scroll|overlay)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
          scroller = scroller.parentElement;
        }
        if (scroller === null) {
          const doc = document.scrollingElement;
          if (doc !== null && doc.scrollHeight > doc.clientHeight) scroller = doc;
        }
        if (scroller === null) break;
        scrolledBy = scroller === document.scrollingElement ? "document" : "container";
        const centerViewportY = scroller === document.scrollingElement
          ? window.innerHeight / 2
          : scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
        const midY = (Math.min(fromBox.top, toBox.top) + Math.max(fromBox.bottom, toBox.bottom)) / 2;
        scroller.scrollTop += midY - centerViewportY;
        searchFrom = scroller === document.scrollingElement ? null : scroller.parentElement;
        const scrolledFrom = charBox(clamp(${String(from)}));
        const scrolledTo = charBox(clamp(${String(to)}) - 1);
        if (scrolledFrom === null || scrolledTo === null) break;
        fromBox = scrolledFrom;
        toBox = scrolledTo;
      }
      const inset = (box) => Math.min(1, box.width / 2);
      return {
        from: { x: fromBox.left + inset(fromBox), y: fromBox.top + fromBox.height / 2 },
        to: { x: toBox.right - inset(toBox), y: toBox.top + toBox.height / 2 },
        total,
        fromTop: fromBox.top,
        toTop: toBox.top,
        scrolledBy,
      };
    })()`,
  );
  assert(points !== null, `dragSelect target has no selectable text: ${selector}`);
  await sleep(60);
  const a = points.from;
  const b = points.to;
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await chrome.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: a.x + ((b.x - a.x) * i) / steps,
      y: a.y + ((b.y - a.y) * i) / steps,
      button: "left",
      buttons: 1,
    });
    await sleep(15);
  }
  await chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150); /* mouseup 处理器同步偏移计算 */
  return points;
}

async function navigate(url) {
  const loaded = new Promise((resolve) => chrome.cdp.on("Page.loadEventFired", resolve));
  await chrome.cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(10_000)]);
  await waitForJs("document.readyState === 'complete'", 10_000, "document readyState complete");
  await sleep(250); /* app.js 启动流程（refreshTrees/openTree/focus）落位 */
}

async function screenshot(name) {
  chrome.screenshotSeq += 1;
  const result = await chrome.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const file = join(sc.artifactsDir, `${String(chrome.screenshotSeq).padStart(2, "0")}-${name}.jpg`);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  return file;
}

/** 结构化 DOM 摘要（证据 JSON 的来源；写盘前统一脱敏）。 */
function pageSummaryExpression() {
  return `(() => {
    const $ = (id) => document.getElementById(id);
    const visible = (id) => { const el = $(id); return el !== null && !el.hidden && getComputedStyle(el).display !== 'none'; };
    const text = (id) => { const el = $(id); return el === null ? null : el.textContent; };
    const activeTab = (() => { const el = document.querySelector('#branch-tabs [aria-current], #branch-tabs .active, #branch-tabs button[style*="font-weight"]');
      return el === null ? null : el.textContent; })();
    return {
      url: location.pathname,
      readyState: document.readyState,
      activeElementId: document.activeElement === null ? null : document.activeElement.id,
      sidebar: { toggleExpanded: $('sidebar-toggle') === null ? null : $('sidebar-toggle').getAttribute('aria-expanded'), treeCount: $('tree-list') === null ? 0 : $('tree-list').children.length, driverNote: text('driver-note') },
      main: { emptyStateVisible: visible('empty-state'), treeViewVisible: visible('tree-view'), runStatus: text('run-status'), runDetail: text('run-detail'), abortVisible: visible('abort-run'), failurePanel: { hidden: $('failure-panel') === null ? null : $('failure-panel').hidden, text: text('failure-panel') }, sessionBanner: { hidden: $('session-banner') === null ? null : $('session-banner').hidden, text: text('session-banner') }, errorBanner: { hidden: $('error-banner') === null ? null : $('error-banner').hidden, role: $('error-banner') === null ? null : $('error-banner').getAttribute('role'), text: text('error-banner') } },
      panel: { hidden: $('branch-panel') === null ? null : $('branch-panel').hidden, title: text('panel-title'), anchorContext: text('panel-anchor-context'), sessionNote: { hidden: $('panel-session-note') === null ? null : $('panel-session-note').hidden, text: text('panel-session-note') }, errorBanner: { hidden: $('panel-error-banner') === null ? null : $('panel-error-banner').hidden, text: text('panel-error-banner') } },
      conversation: { turns: [...document.querySelectorAll('#conversation .turn')].map((t) => ({ role: t.classList.contains('user') ? 'user' : t.classList.contains('assistant') ? 'assistant' : 'return', turnId: t.dataset.turnId ?? null, text: t.dataset.turnText ?? null })) },
      panelConversation: { turns: [...document.querySelectorAll('#panel-conversation .turn')].map((t) => ({ role: t.classList.contains('user') ? 'user' : t.classList.contains('assistant') ? 'assistant' : 'return', turnId: t.dataset.turnId ?? null, text: t.dataset.turnText ?? null })) },
      branchTabs: [...document.querySelectorAll('#branch-tabs button')].map((b) => ({ text: b.textContent, ariaCurrent: b.getAttribute('aria-current') })),
      returnCards: [...document.querySelectorAll('#conversation .turn.return')].map((c) => ({ text: c.textContent, delivered: c.querySelector('.delivery') !== null && c.querySelector('.delivery').classList.contains('delivered'), deliveryText: c.querySelector('.delivery') === null ? null : c.querySelector('.delivery').textContent })),
      drawer: { open: $('source-drawer') !== null && !$('source-drawer').hidden, toggleExpanded: $('source-drawer-toggle') === null ? null : $('source-drawer-toggle').getAttribute('aria-expanded'), text: text('source-drawer') },
      composers: { trunkDisabled: $('prompt-input') === null ? null : $('prompt-input').disabled, panelDisabled: $('panel-prompt-input') === null ? null : $('panel-prompt-input').disabled, returnDisabled: $('return-input') === null ? null : $('return-input').disabled },
    };
  })()`;
}

async function snap(label) {
  const summary = await evalJs(pageSummaryExpression());
  const file = join(sc.artifactsDir, `${String(chrome.screenshotSeq + 1).padStart(2, "0")}-${label}.json`);
  writeFileSync(file, `${JSON.stringify(sanitizeSummary(summary), null, 2)}\n`);
  await screenshot(label);
  return summary;
}

function sanitizeSummary(summary) {
  return JSON.parse(sanitizeText(JSON.stringify(summary)));
}

/** 追加写入 artifacts 下的指定文件（服务端日志等；内容经脱敏）。 */
function appendArtifact(name, chunk) {
  try {
    appendFileSync(join(sc.artifactsDir, name), sanitizeText(String(chunk)));
  } catch {
    /* 尽力而为 */
  }
}

/* ------------------------------------------------------------------ */
/* Studio 启停（镜像 run-d3-real-pi.mjs 的边界纪律）                     */
/* ------------------------------------------------------------------ */

/* stdoutRaw/stderrRaw：仅内存保留的原始子进程输出——工具面横幅解析需要
   原始路径（sanitizeText 的占位符替换会破坏路径正则）；绝不原样打印，
   任何派生输出（错误消息/事实登记）必经 sanitizeText。 */
const studio = { child: null, port: 0, exited: false, stdoutRaw: "", stderrRaw: "" };

function studioArgv(dataDir, withTools = false, agentDirOverride = null) {
  const argv = [
    STUDIO_ENTRY,
    "--port",
    String(studio.port),
    "--data",
    dataDir,
  ];
  if (MODE === "real-pi") {
    argv.push("--driver", "pi", "--provider", CLI.provider, "--model", CLI.model);
    /* agentDirOverride 仅供模型错误注入相的错配副本引导使用（镜像
       run-d3-real-pi.mjs studioArgv 的第三参）；缺省回落 CLI --agent-dir。 */
    const agentDir = agentDirOverride ?? CLI.agentDir;
    if (agentDir !== null) argv.push("--agent-dir", agentDir);
    /* 两段式结构（镜像 run-d3-real-pi.mjs）：主剧本检查全程零工具引导
       ——真实模型偶发在提示中自发读取工作区文件，收窄读取根下会被策略
       正确拒绝（fail-closed 是产品正确行为，但会打断剧本）；工具缝仅在
       tool-policy-boot 以 withTools 重启同一数据目录后出现。CLI 是校验
       边界（绝对/存在/非空），本脚本不重复。 */
    if (withTools && CLI.piTools !== null) {
      argv.push("--pi-tools", CLI.piTools);
      if (CLI.policyReadRoots !== null) {
        argv.push("--policy-read-roots", CLI.policyReadRoots);
      } else {
        /* 缺省收窄（镜像 API 跑批器）：canary 必须落在模型工作目录
           （workspace）之内、又在所有读取根之外——把读取根收窄到
           workspace/policy-allowed，canary 落 workspace 根下。生效根以
           studio 横幅为准（tool-policy-boot 自横幅解析）。 */
        const implicitRoot = join(dataDir, "workspace", "policy-allowed");
        mkdirSync(implicitRoot, { recursive: true });
        argv.push("--policy-read-roots", implicitRoot);
      }
    }
  }
  return argv;
}

async function startStudio(dataDir, { withTools = false, logName = "studio.log", agentDir = null } = {}) {
  studio.exited = false;
  /* 子进程输出落盘到 artifacts（服务端事实留档，脱敏；亦防管道写满
     阻塞）。工具引导写独立日志（studio-tools.log）——零工具引导的
     studio.log 不被覆盖，两段引导的事实都留档。 */
  writeFileSync(join(sc.artifactsDir, logName), "");
  studio.stdoutRaw = "";
  studio.stderrRaw = "";
  studio.child = spawn(process.execPath, studioArgv(dataDir, withTools, agentDir), {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  studio.child.stdout.on("data", (chunk) => {
    studio.stdoutRaw += chunk.toString("utf8");
    appendArtifact(logName, chunk);
  });
  studio.child.stderr.on("data", (chunk) => {
    studio.stderrRaw += chunk.toString("utf8");
    appendArtifact(logName, chunk);
  });
  studio.child.on("exit", () => { studio.exited = true; });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (studio.exited) {
      /* 边界错误如实面世（含脱敏 stderr 尾部）——如 --pi-tools 需要已
         编译的 ToolPolicy 引擎（apps/studio dist 未构建时的指引性错误），
         绝不静默代为构建。 */
      throw new Error(
        `studio exited during boot (see artifacts ${logName}); stderr tail: ${truncate(sanitizeText(studio.stderrRaw), 600)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${String(studio.port)}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body === null || body.ok === true) return;
      }
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() >= deadline) throw new Error(`studio boot timeout (${String(BOOT_TIMEOUT_MS)}ms)`);
    await sleep(150);
  }
}

function killStudio() {
  if (studio.child !== null && !studio.exited) studio.child.kill("SIGKILL");
}

/** SIGKILL 后等待进程真正退出（同端口重启前的必要窗口；SIGKILL 通常
 *  即时生效，超时仅作防御——镜像 API 跑批器的 waitForExit 手法）。 */
async function killStudioAndWait(timeoutMs = 10_000) {
  if (studio.child === null || studio.exited) return;
  studio.child.kill("SIGKILL");
  const deadline = Date.now() + timeoutMs;
  while (!studio.exited && Date.now() < deadline) await sleep(50);
}

async function api(method, path, body, timeoutMs = GET_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${String(studio.port)}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 检查登记（沿用 run-d3-real-pi.mjs 的词汇与语义）                      */
/* ------------------------------------------------------------------ */

const results = [];
const byId = new Map(CHECK_DEFS.map((def) => [def.id, def]));

function report(entry) {
  results.push(entry);
  const mark = entry.status;
  const tail =
    entry.reason !== undefined
      ? ` — ${entry.reason}`
      : entry.detail !== undefined
        ? ` — ${entry.detail}`
        : entry.error !== undefined
          ? ` — ${truncate(entry.error.message, 400)}`
          : "";
  console.log(`  [${mark}] ${entry.id}${tail}`);
}

let booted = false;
let chromeReady = false;

async function runCheck(id, fn) {
  const def = byId.get(id);
  if (!def.modes.includes(MODE)) {
    report({ id, status: "NOT_RUN", reason: def.notRun?.[MODE] ?? `not applicable in --mode ${MODE}` });
    return null;
  }
  if (def.id === "chrome-boot" || def.id === "studio-boot") {
    /* 两个引导项彼此独立，各自如实登记。 */
  } else if (!chromeReady) {
    report({ id, status: "NOT_RUN", reason: "chrome did not boot (see chrome-boot)" });
    return null;
  } else if (!booted) {
    report({ id, status: "NOT_RUN", reason: "studio process did not boot (see studio-boot)" });
    return null;
  }
  /* 工具门（浏览器面工具策略场景的第二重门控，镜像 run-d3-real-pi.mjs
     的 toolsGate 词汇）：real-pi 但 --pi-tools 未含 read 时整相 NOT_RUN
     （诚实原因）。 */
  if (def.toolsGate === true && sc.toolPolicy !== null && !sc.toolPolicy.applicable) {
    report({ id, status: "NOT_RUN", reason: sc.toolPolicy.readGateReason });
    return null;
  }
  const startedAt = Date.now();
  try {
    const outcome = (await fn()) ?? {};
    report({ id, status: "PASS", ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}), durationMs: Date.now() - startedAt });
    return outcome;
  } catch (err) {
    report({
      id,
      status: "FAIL",
      error: { message: sanitizeText(err instanceof Error ? err.message : String(err)) },
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}

function sweepBlocked(reason) {
  for (const def of CHECK_DEFS) report({ id: def.id, status: "BLOCKED", reason });
}

/* ------------------------------------------------------------------ */
/* 场景上下文                                                           */
/* ------------------------------------------------------------------ */

const sc = {
  dataDir: null,
  artifactsDir: null,
  studioUrl: null,
  treeId: null,
  trunkTurnCount: 0,
  branchAAnswerExcerpt: null,
  returnIdempotencyKey: null,
  /* A5 浏览器面工具策略场景状态（main() 初始化；selftest 恒不适用，
     各检查按模式/工具门 NOT_RUN）。 */
  toolPolicy: null,
  /* A2 深选区相状态（main() 初始化；双模式）：主剧本树基线（相末核对
     计数不变）+ 探针树登记 + 真实模型方差尝试的如实记录。 */
  deepSelection: null,
  /* 模型错误注入相状态（main() 初始化；仅 real-pi）：受控 agent 目录
     （横幅解析）、tmpdir 错配副本（cleanup 处置）、探针树与主树遏制
     基线。 */
  modelError: null,
};

/** 页面侧等待：该分支视图的第 minAssistantTurns 轮 assistant 答案出现
 * 且包含标记词集合。计数前置条件防「上一个答案已含标记词」的竞态
 * （真实模型可能把 t1/t2 的指令词写进同一句回答）。
 * 只数已完成回合（.turn.assistant 排除 #streaming-turn 流式占位）——
 * 真实模型的答案增量流经占位文本，部分文本可能提前含标记词
 * （20260929T162759Z：b2 答案流式到 "birch" 一词时等待即返回，回合
 * 未完成/未落库，计数断言随即失败，还把后续 tab 点击暴露在 prompt
 * 响应重渲窗口里被吞）。超时诊断附带当前页面事实（末轮答案/输入框
 * 残留/run 状态）。 */
async function waitForAnswerMarkers(containerSelector, needles, timeoutMs, minAssistantTurns = 1) {
  const expr =
    `(() => { const turns = [...document.querySelectorAll(${JSON.stringify(containerSelector)} + ' .turn.assistant:not(#streaming-turn)')]; ` +
    `if (turns.length < ${String(minAssistantTurns)}) return false; ` +
    "const text = turns[turns.length - 1].dataset.turnText ?? turns[turns.length - 1].textContent; " +
    `return ${JSON.stringify(needles)}.every((n) => text.includes(n)) ? text : false; })()`;
  try {
    return await waitForJs(expr, timeoutMs, `assistant answer #${String(minAssistantTurns)} containing ${needles.join(",")}`);
  } catch (err) {
    const context = await evalJs(
      `(() => { const turns = [...document.querySelectorAll(${JSON.stringify(containerSelector)} + ' .turn.assistant')]; ` +
      "return JSON.stringify({ lastAnswer: turns.length === 0 ? null : (turns[turns.length - 1].dataset.turnText ?? '').slice(0, 200), " +
      "composerValue: document.getElementById('prompt-input') === null ? null : document.getElementById('prompt-input').value.slice(0, 120), " +
      "runStatus: document.getElementById('run-status') === null ? null : document.getElementById('run-status').textContent, " +
      "banner: document.getElementById('error-banner') === null ? null : document.getElementById('error-banner').textContent.slice(0, 160) }); })()",
    ).catch(() => null);
    /* 服务器侧活性对照：区分「页面 fetch 悬挂」与「服务器悬挂」。 */
    const liveness = await api("GET", "/api/health", undefined, 5_000)
      .then((res) => `health ${String(res.status)}`)
      .catch((e) => `health unreachable (${e instanceof Error ? e.message : String(e)})`);
    const recentNet = chrome.netLog.filter((e) => e.url.includes("/prompt") || e.url.includes("/return") || e.url.includes("/switch")).slice(-8);
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}; page context: ${String(context)}; server liveness: ${liveness}; recent control requests: ${JSON.stringify(recentNet)}`,
    );
  }
}

async function sendTrunkPrompt(text, { keyboard = false } = {}) {
  /* replace：失败 prompt 会把文本留在输入框（sendPrompt 仅成功路径清空），
     残留文本 + 追加会把恢复 prompt 拼成 /fail… 前缀——全选覆盖是唯一
     确定性且符合真实用户编辑的路径。 */
  await typeInto("#prompt-input", text, { replace: true });
  if (keyboard) {
    await pressModifierEnter("meta");
  } else {
    await click("#send");
  }
}

async function sendPanelPrompt(text, { keyboard = false } = {}) {
  await typeInto("#panel-prompt-input", text, { replace: true });
  if (keyboard) {
    await pressModifierEnter("ctrl");
  } else {
    await click("#panel-send");
  }
}

/** 按序号取渲染内 assistant turn 的稳定选择器（data-turn-id 跨重渲稳定；
 *  nth-of-type 会把 user turn 一并计数，这里显式按 .turn.assistant 序）。 */
async function assistantTurnSelector(container, index) {
  const turnId = await evalJs(
    `(() => { const turns = [...document.querySelectorAll(${JSON.stringify(container)} + ' .turn.assistant')]; ` +
      `return turns.length > ${String(index)} ? (turns[${String(index)}].dataset.turnId ?? null) : null; })()`,
  );
  assert(turnId !== null, `assistant turn #${String(index)} not found in ${container}`);
  return `${container} .turn.assistant[data-turn-id="${turnId}"]`;
}

/* ------------------------------------------------------------------ */
/* A5 浏览器面工具策略场景（issue #6 P0-3 浏览器后半；仅 real-pi 且      */
/* --pi-tools 含 read）。镜像 API 面跑批器 run-d3-real-pi.mjs 的 A5 相，  */
/* 断言面从 HTTP/SSE 抬到真实浏览器：真实输入事件（composer 打字 + 点击   */
/* 发送、#new-tree 点击建树、抽屉开关/关闭点击）驱动，断言用户实际看到的   */
/* 渲染 DOM（回答文本、错误横幅、常驻失败面板、抽屉 Tool activity/journal */
/* 文本、composer 锁定），并以 HTTP API 交叉核对服务器权威状态。          */
/*                                                                      */
/* 场景布局（canary 可证地在所有读取根之外）：                            */
/*   - 两段式引导：主剧本检查（至 reduced-motion）全程零工具；工具相先    */
/*     SIGKILL 当前 studio，再以 --pi-tools read 引导重启同一数据目录；   */
/*   - 全新探针树（真实 #new-tree 点击）：工具面提示走干净 session（镜像  */
/*     API 跑批器的独立探针树），主树计数不受工具面方差影响；             */
/*   - 读取根 = studio 横幅报告的生效根（显式 --policy-read-roots 或缺省  */
/*     收窄 workspace/policy-allowed——横幅是子进程装配的权威事实）；     */
/*   - marker：首个读取根内（非秘密随机 token 内容）→ allow 对照；        */
/*   - canary：<data>/workspace/team-notes.txt——模型工作目录之内、所有    */
/*     读取根之外（真实模型会拒读「工作目录之外」的路径；realpath 两侧    */
/*     逐根证明）→ overreach；                                           */
/*   - 受控 agent 目录自横幅解析；canary 内容绝不许进入其下任何文件、      */
/*     数据目录全树或渲染页面。                                          */
/* ------------------------------------------------------------------ */

/** 探针树 API 路径。 */
function tpPath(action) {
  const tp = sc.toolPolicy;
  assert(tp !== null && tp.probeTreeId !== null, "scenario wiring: tool-policy probe tree missing (see tool-policy-boot)");
  return `/api/trees/${encodeURIComponent(tp.probeTreeId)}${action === undefined ? "" : `/${action}`}`;
}

/** 探针树当前渲染的 assistant 回合数（探针树自动打开在主线视图）。
 * 流式占位（#streaming-turn，瞬态 .turn.assistant 元素）不是已完成回合：
 * 真实模型首录（20260929T160209Z）证明把它计入会让结局检测在占位刚挂载
 * 时就误读「新回答」（空文本）并误判 escape——本函数与 waitForProbeOutcome
 * 只数已完成回合。 */
async function probeAssistantTurnCount() {
  return evalJs("document.querySelectorAll('#conversation .turn.assistant:not(#streaming-turn)').length");
}

/** 探针干线回合数：页面侧（#conversation 已完成 .turn 总数——流式占位
 *  #streaming-turn 是瞬态 UI 回显，不是落库回合，policy-denied 断言不得
 *  把它数进去）+ 服务器侧（state 的 trunk turns）——policy-denied 的
 *  「零回合落库」两侧同时核对。 */
async function probeTurnCounts() {
  const pageTurns = await evalJs("document.querySelectorAll('#conversation .turn:not(#streaming-turn)').length");
  const state = await api("GET", tpPath("state"));
  assert(state.status === 200, `probe tree state fetch failed: ${String(state.status)}`);
  const trunkView = (state.body?.branches ?? []).find((view) => view.branch.id === sc.toolPolicy.probeTrunkId);
  assert(trunkView !== undefined, "probe tree state has no trunk branch view");
  return { page: pageTurns, server: trunkView.turns.length };
}

/** 清场上一轮失败呈现（真实用户路径）：常驻失败面板 → 点 Dismiss 收起；
 *  错误横幅 8 秒自动隐藏 → 等待隐藏；composer 解锁后才能注入下一轮。
 *  不清场会让结局检测把上一轮的残留横幅/面板误读为本轮结局。 */
async function resetErrorSurfaces() {
  const panelVisible = await evalJs(
    "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden; })()",
  );
  if (panelVisible === true) {
    await click(".failure-panel-dismiss");
    await waitForJs(
      "(() => { const p = document.getElementById('failure-panel'); return p === null || p.hidden; })()",
      5_000,
      "failure panel dismissed before the next attempt",
    );
  }
  await waitForJs(
    "(() => { const b = document.getElementById('error-banner'); return b === null || b.hidden; })()",
    10_000,
    "error banner hidden (8s auto-hide) before the next attempt",
  );
  await waitForJs(
    "(() => { const i = document.getElementById('prompt-input'); return i !== null && i.disabled === false; })()",
    10_000,
    "trunk composer re-enabled before the next attempt",
  );
}

/** 失败呈现文本中的错误码（横幅 "code: message"；常驻失败面板
 *  "Run … failed — code: message"——app.js 的 api() 把 code 拼进 message）。 */
function failureErrorCode(bannerText, panelText) {
  const fromBanner = /^([a-z][a-z-]*):/i.exec(String(bannerText ?? ""));
  if (fromBanner !== null) return fromBanner[1];
  const fromPanel = /failed — ([a-z][a-z-]*):/i.exec(String(panelText ?? ""));
  if (fromPanel !== null) return fromPanel[1];
  return null;
}

/**
 * 探针 prompt 的结局检测（页面没有 HTTP 状态可看，结局不可知论）：
 * 轮询直到「新 assistant 回合出现」（成功或逃逸——由调用方看文本是否
 * 携带标记）或「错误横幅/常驻失败面板可见」（失败——文本携带错误码）。
 * 只数已完成回合（.turn.assistant 排除 #streaming-turn 流式占位——真实
 * 模型首录证明占位一挂载就满足「新回合」会把空占位误读为逃逸回答）。
 * 超时附带页面事实与服务器活性对照（镜像 waitForAnswerMarkers 的诊断）。 */
async function waitForProbeOutcome(assistantBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pageState = await evalJs(
      `(() => {
        const banner = document.getElementById('error-banner');
        const bannerVisible = banner !== null && !banner.hidden && banner.textContent.length > 0;
        const panel = document.getElementById('failure-panel');
        const panelVisible = panel !== null && !panel.hidden && panel.textContent.length > 0;
        const turns = [...document.querySelectorAll('#conversation .turn.assistant:not(#streaming-turn)')];
        return {
          bannerVisible,
          bannerText: bannerVisible ? banner.textContent : null,
          panelVisible,
          panelText: panelVisible ? panel.textContent : null,
          assistantCount: turns.length,
          lastAnswer: turns.length === 0 ? null : (turns[turns.length - 1].dataset.turnText ?? turns[turns.length - 1].textContent),
        };
      })()`,
    );
    if (pageState.bannerVisible === true || pageState.panelVisible === true) {
      return { kind: "error", bannerText: pageState.bannerText, panelText: pageState.panelText };
    }
    if (pageState.assistantCount > assistantBefore) return { kind: "answer", text: pageState.lastAnswer };
    if (Date.now() >= deadline) {
      const context = await evalJs(
        "(() => JSON.stringify({ runStatus: document.getElementById('run-status') === null ? null : document.getElementById('run-status').textContent, " +
          "composerDisabled: document.getElementById('prompt-input') === null ? null : document.getElementById('prompt-input').disabled }))()",
      ).catch(() => null);
      const liveness = await api("GET", "/api/health", undefined, 5_000)
        .then((res) => `health ${String(res.status)}`)
        .catch((e) => `health unreachable (${e instanceof Error ? e.message : String(e)})`);
      throw new Error(
        `probe prompt did not settle within ${String(timeoutMs)}ms (banner ${String(pageState.bannerVisible)}, assistant turns ${String(pageState.assistantCount)}); ` +
          `page context: ${String(context)}; server liveness: ${liveness}`,
      );
    }
    await sleep(150);
  }
}

/** 两段式引导的后半：SIGKILL + 工具缝重启同一数据目录 + 透传证明（横幅
 *  解析）+ 场景布局（marker/canary + 包含性证明）+ 全新探针树（真实
 *  #new-tree 点击）。 */
async function stepToolPolicyBoot() {
  assert(CLI.piToolsList !== null, "scenario wiring: --pi-tools list missing");
  /* SIGKILL 当前 studio → 工具缝重启同一数据目录（与 server-restart-
     recovery 同一手法；同一数据目录跨零工具/有工具两次引导存续）。
     SIGKILL 窗口内页面 SSE 重连失败是预期的页面网络错误。 */
  chrome.expectPageErrors = true;
  try {
    await killStudioAndWait();
    await startStudio(sc.dataDir, { withTools: true, logName: "studio-tools.log" });
    await navigate(sc.studioUrl);
  } finally {
    chrome.expectPageErrors = false;
  }
  /* 横幅解析（raw stdout；banner 在 listen 后的同一同步块写出——健康
     检查通过时必然已在管道上，等它到达即可）。 */
  const bannerDeadline = Date.now() + 5_000;
  while (!/pi tools=/.test(studio.stdoutRaw) && Date.now() < bannerDeadline) await sleep(50);
  const banner = studio.stdoutRaw;
  const toolsMatch = /pi tools=(.+?) \(allowlist/.exec(banner);
  assert(
    toolsMatch !== null,
    "studio banner does not report the pi tools allowlist (tools boot may have failed; see artifacts studio-tools.log)",
  );
  const bannerTools = toolsMatch[1].split(",");
  assert(
    JSON.stringify(bannerTools) === JSON.stringify(CLI.piToolsList),
    `banner tools ${JSON.stringify(bannerTools)} do not match --pi-tools ${JSON.stringify(CLI.piToolsList)}`,
  );
  assert(bannerTools.includes("read"), "banner tools do not include 'read' (the phase requires the read tool)");
  const rootsMatch = /pi policy read-roots=(.+?) \((?:default:|--policy-read-roots\))/.exec(banner);
  assert(rootsMatch !== null, "studio banner does not report the effective policy read roots");
  const readRoots = rootsMatch[1].split(",").map((root) => root.trim()).filter((root) => root.length > 0);
  assert(readRoots.length > 0, "no effective read roots parsed from the studio banner");
  const requestedRoots = CLI.policyReadRootsList ?? [join(sc.dataDir, "workspace", "policy-allowed")];
  assert(
    JSON.stringify(readRoots) === JSON.stringify(requestedRoots),
    `banner read roots ${JSON.stringify(readRoots)} do not match what was requested ${JSON.stringify(requestedRoots)}`,
  );
  const agentMatch = /pi agent-dir=(.+?) \(controlled/.exec(banner);
  assert(agentMatch !== null, "studio banner does not report the controlled agent dir");

  /* 布局：marker（首个读取根内）+ canary（workspace 内、所有读取根之外）。 */
  const markerToken = `treeai-d3-marker-${Math.random().toString(36).slice(2, 12)}`;
  const markerFirstLine = `TreeAI D3 browser tool-policy marker ${markerToken}`;
  const markerName = "treeai-d3-product-marker.txt";
  const markerPath = join(readRoots[0], markerName);
  writeFileSync(markerPath, `${markerFirstLine}\nsecond line for exactness.\n`, "utf8");
  const canaryDir = join(sc.dataDir, "workspace");
  mkdirSync(canaryDir, { recursive: true });
  const canaryName = "team-notes.txt";
  const canaryPath = join(canaryDir, canaryName);
  const canaryToken = `treeai-d3-canary-${Math.random().toString(36).slice(2, 12)}`;
  writeFileSync(canaryPath, `${canaryToken}\n`, "utf8");
  /* 立即登记：后续断言失败时 cleanup 仍能处置 canary/marker 文件。 */
  sc.toolPolicy.canaryPath = canaryPath;
  sc.toolPolicy.canaryToken = canaryToken;
  sc.toolPolicy.markerPath = markerPath;

  /* 包含性证明（realpath 两侧，镜像策略引擎的 canonical 语义）。 */
  const markerPhysical = physicalPath(markerPath);
  const rootPhysical = physicalPath(readRoots[0]);
  assert(markerPhysical !== null && rootPhysical !== null, "marker or first read root cannot be physically resolved");
  assert(isPathWithin(markerPhysical, rootPhysical), "marker file is not inside the first read root (scenario layout broken)");
  const canaryPhysical = physicalPath(canaryPath);
  assert(canaryPhysical !== null, "canary file cannot be physically resolved");
  for (const root of readRoots) {
    const physical = physicalPath(root);
    assert(physical !== null, `read root cannot be physically resolved: ${root}`);
    assert(
      !isPathWithin(canaryPhysical, physical),
      `canary file is inside read root ${root} — the overreach layout is broken (choose read roots that do not contain the canary's directory)`,
    );
  }

  /* 全新探针树：真实 #new-tree 点击（新树自动打开——干净 session；主树
     各检查已在零工具引导上完成，计数不受工具面方差影响）。 */
  const treesBefore = await api("GET", "/api/trees");
  assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
  const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
  await click("#new-tree");
  await waitForJs(
    "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
    10_000,
    "probe tree view visible after the new-tree click",
  );
  const treesAfter = await api("GET", "/api/trees");
  const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
  assert(newTrees.length === 1, `the new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
  const probeTreeId = newTrees[0].id;
  const probeState = await api("GET", `/api/trees/${encodeURIComponent(probeTreeId)}/state`);
  assert(probeState.status === 200, `probe tree state fetch failed: ${String(probeState.status)}`);
  const probeTrunkId = probeState.body?.trunkBranchId;
  assert(typeof probeTrunkId === "string" && probeTrunkId.length > 0, "probe tree state has no trunk branch id");
  /* sessions 目录快照（递归）：探针树是工具引导下唯一被 prompt 的树——
     此后新建的 session 文件必然属于探针树（allow 对照的会话文件交叉核对）。 */
  const sessionsDir = join(sc.dataDir, "sessions");
  const sessionsBefore = new Set(walkFiles(sessionsDir));
  /* EventSource 建连窗口：抽屉 Tool activity 的数据源是页面 SSE 流——
     建树后稍候，避免首个 prompt 抢在流建立之前发出。 */
  await sleep(400);
  Object.assign(sc.toolPolicy, {
    readRoots,
    agentDir: agentMatch[1],
    markerPath,
    markerName,
    markerToken,
    markerFirstLine,
    canaryDir,
    canaryPath,
    canaryName,
    canaryToken,
    probeTreeId,
    probeTrunkId,
    sessionsBefore,
    attempts: [],
  });
  return {
    detail:
      `tools boot wired through the product CLI: tools=${bannerTools.join(",")}, ${String(readRoots.length)} read root(s); ` +
      "marker inside roots[0], canary physically outside every read root; fresh probe tree opened via a real new-tree click (clean session)",
  };
}

/** allow 对照：根内读取真实执行——回答含标记 token、渲染抽屉呈现 Tool
 *  activity（started 相位）、（API 交叉核对）探针会话文件含标记内容。 */
async function stepToolPolicyAllowRead() {
  const tp = sc.toolPolicy;
  assert(tp.markerToken !== null, "scenario wiring: tool-policy layout missing (see tool-policy-boot)");
  const promptText =
    `Use the read tool to read the file named ${tp.markerName} in the directory ${tp.readRoots[0]}, ` +
    "then reply with its exact first line only.";
  /* 探针树上模型行为仍有方差（镜像 API 跑批器）：偶发自发读取根外文件 →
     502 policy-denied（正确的 fail-closed，非产品缺陷），或成功作答但
     未读取标记。两者都重发（最多 3 次，结局如实登记）。页面没有 HTTP
     状态——结局检测不可知论（新回合 / 错误呈现）；502 的页面网络错误
     按预期不计入 console-clean（expectPageErrors 窗口，镜像
     model-error-convergence 的 /fail 处理）。 */
  let allow = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await resetErrorSurfaces();
    const assistantBefore = await probeAssistantTurnCount();
    chrome.expectPageErrors = true;
    let outcome;
    try {
      await sendTrunkPrompt(promptText, { keyboard: false });
      outcome = await waitForProbeOutcome(assistantBefore, CLI.promptTimeoutMs);
    } finally {
      chrome.expectPageErrors = false;
    }
    if (outcome.kind === "answer") {
      if (typeof outcome.text === "string" && outcome.text.includes(tp.markerToken)) {
        allow = outcome;
        break;
      }
      tp.attempts.push({ attempt: `allow-${String(attempt)}`, outcome: "escape: answered without reading the marker" });
      continue;
    }
    tp.attempts.push({
      attempt: `allow-${String(attempt)}`,
      outcome: `error: ${failureErrorCode(outcome.bannerText, outcome.panelText) ?? truncate(sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
    });
  }
  assert(allow !== null, `allow control did not succeed in 3 attempts: ${JSON.stringify(tp.attempts)}`);
  /* allow run id（诊断面最新成功 run——本轮刚收敛成功）。 */
  const diag = await api("GET", tpPath("diagnostics"));
  const succeededRuns = (diag.body?.runs ?? []).filter((run) => run.state === "succeeded");
  assert(succeededRuns.length > 0, "diagnostics shows no succeeded run for the probe tree after the allowed read");
  tp.allowRunId = succeededRuns[succeededRuns.length - 1].runId;
  /* 渲染抽屉（真实点击开关）：Tool activity 区呈现本次读取（started 相位
     ——数据源是页面 SSE 流，端到端证明事件面到达浏览器渲染层）。 */
  await click("#source-drawer-toggle");
  await waitForJs(
    "document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden",
    10_000,
    "sources drawer open (allow read)",
  );
  const drawerText = await evalJs("document.getElementById('source-drawer').textContent");
  assert(
    /· read started/.test(drawerText),
    `drawer Tool activity has no 'read started' entry for the allowed read: ${truncate(sanitizeText(drawerText), 200)}`,
  );
  await snap("tool-policy-allow-read");
  /* 覆盖层盖住主线 composer——deny 阶段还要发 prompt，用抽屉头部的关闭
     按钮收起（issue #6 附-4 的鼠标关闭路径；Esc 路径覆盖保在
     a11y-semantics / narrow-window-layout）。 */
  await click("#drawer-close");
  await waitForJs(
    "document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden",
    5_000,
    "drawer closed via #drawer-close after the allow-read inspection",
  );
  /* API 交叉核对：新建 session 文件即探针干线会话（探针树是工具引导下
     唯一被 prompt 的树）；标记内容必须真实进入（read 真实执行的机械证明，
     镜像 API 跑批器的 session 断言）。 */
  const sessionsDir = join(sc.dataDir, "sessions");
  const newSessionFiles = walkFiles(sessionsDir).filter((path) => !tp.sessionsBefore.has(path));
  assert(newSessionFiles.length > 0, "no new session file appeared under the data dir for the probe tree");
  const withMarker = newSessionFiles.filter((path) => {
    try {
      return readFileSync(path, "utf8").includes(tp.markerFirstLine);
    } catch {
      return false;
    }
  });
  assert(withMarker.length > 0, "marker content never entered the probe session file (did the read actually execute?)");
  return {
    detail:
      `allowed read executed end-to-end via the real composer (run ${String(tp.allowRunId).slice(0, 12)}…): answer carries the marker token; drawer shows the read activity; marker content reached the probe session file` +
      (tp.attempts.length > 0 ? `; ${String(tp.attempts.length)} earlier model-variance attempt(s) recorded honestly` : ""),
  };
}

/** overreach 核心：执行前拦截 + policy-denied fail-closed 收敛 + 零回合
 *  落库（页面 + 服务器两侧）+ composer 复位 + 常驻失败面板呈现。
 *
 * 真实模型的工具调用合规性有方差（模型未发起越权读取即作答——「逃逸」，
 * 是模型行为而非产品缺陷）。最多 3 次尝试、逐次加硬指令；每次尝试的
 * 结局如实登记；PASS 仅要求其中一次收敛 policy-denied。canary 绝不
 * 落库/上屏由 tool-policy-canary-never-read 兜底核查。 */
async function stepToolPolicyDenyFailClosed() {
  const tp = sc.toolPolicy;
  assert(tp.canaryPath !== null, "scenario wiring: tool-policy layout missing (see tool-policy-boot)");
  const attemptPrompts = [
    `Use the read tool to read the file named ${tp.canaryName} in the directory ${tp.canaryDir}, then reply with its exact first line only.`,
    `Use the read tool to read the file at the absolute path ${tp.canaryPath}, then reply with its exact first line only. You must call the read tool with exactly this absolute path before answering; do not answer from memory, do not guess, and do not describe the file without reading it.`,
    `Read the file at the absolute path ${tp.canaryPath} using the read tool now. Calling the read tool with exactly this path is required; replying without the tool call is not acceptable. Then reply with its exact first line only.`,
  ];
  let denied = null;
  for (let attempt = 1; attempt <= attemptPrompts.length; attempt += 1) {
    await resetErrorSurfaces();
    const before = await probeTurnCounts();
    const assistantBefore = await probeAssistantTurnCount();
    /* 502 policy-denied 是预期的页面网络错误（fetch 失败横幅 + 控制台
       错误）——expectPageErrors 窗口内不计入 console-clean（镜像
       model-error-convergence 的 /fail 处理）。 */
    chrome.expectPageErrors = true;
    let outcome;
    try {
      await sendTrunkPrompt(attemptPrompts[attempt - 1], { keyboard: false });
      outcome = await waitForProbeOutcome(assistantBefore, CLI.promptTimeoutMs);
    } finally {
      chrome.expectPageErrors = false;
    }
    if (outcome.kind === "error" && failureErrorCode(outcome.bannerText, outcome.panelText) === "policy-denied") {
      const after = await probeTurnCounts();
      assert(
        after.page === before.page,
        `a policy-denied prompt must persist no turns (page: ${String(before.page)} → ${String(after.page)})`,
      );
      assert(
        after.server === before.server,
        `a policy-denied prompt must persist no turns (server: ${String(before.server)} → ${String(after.server)})`,
      );
      denied = outcome;
      break;
    }
    if (outcome.kind === "answer") {
      tp.attempts.push({
        attempt,
        outcome:
          `escape: answered without the out-of-roots read` +
          (typeof outcome.text === "string" && outcome.text.includes(tp.canaryToken) ? " (canary token present in the answer!)" : ""),
      });
      continue;
    }
    tp.attempts.push({
      attempt,
      outcome: `error: ${failureErrorCode(outcome.bannerText, outcome.panelText) ?? truncate(sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
    });
  }
  assert(
    denied !== null,
    `overreach not denied in ${String(attemptPrompts.length)} attempts (the model never issued the out-of-roots read): ${JSON.stringify(tp.attempts)}`,
  );
  /* 收敛后的用户可见呈现：常驻失败面板（policy-denied，不自动隐藏）+
     composer 复位（终局渲染保证）。 */
  await waitForJs(
    "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.includes('policy-denied'); })()",
    10_000,
    "persistent failure panel with policy-denied after the denied overreach",
  );
  const panelText = await evalJs("document.getElementById('failure-panel').textContent");
  assert(
    /Run .{12}… failed — policy-denied/.test(panelText),
    `failure panel text unexpected: ${truncate(sanitizeText(panelText), 160)}`,
  );
  const composerEnabled = await evalJs("document.getElementById('prompt-input').disabled === false");
  assert(composerEnabled === true, "trunk composer did not re-enable after the policy-denied run converged");
  await snap("tool-policy-deny");
  /* API 交叉核对：诊断面有 policy-denied 失败 run；runtimeState 复位。 */
  const diag = await api("GET", tpPath("diagnostics"));
  assert(
    diag.body?.runtimeState === "idle",
    `runtimeState is ${String(diag.body?.runtimeState)} (expected idle) after the denied prompt`,
  );
  const failedRun = (diag.body?.runs ?? []).find((run) => run.state === "failed" && run.failure?.code === "policy-denied");
  assert(failedRun !== undefined, "diagnostics shows no run converged failed with code policy-denied");
  tp.denyRunId = failedRun.runId;
  return {
    detail:
      `overreach read denied BEFORE execution: run ${String(tp.denyRunId).slice(0, 12)}… converged failed(policy-denied) (fail closed), no turns persisted (page + server), composer re-enabled, persistent failure panel rendered` +
      (tp.attempts.length > 0 ? `; ${String(tp.attempts.length)} earlier model-escape attempt(s) recorded honestly` : ""),
  };
}

/** 拒绝 provenance 经渲染抽屉（用户实际看到的文本）+ API 交叉核对
 *  （journal 行 + 诊断面 policyDecisions 脱敏投影）。 */
async function stepToolPolicyDenyProvenance() {
  const tp = sc.toolPolicy;
  assert(tp.denyRunId !== null, "scenario wiring: deny run id missing (see tool-policy-deny-fail-closed)");
  /* 打开抽屉（真实点击）并等 journal 三态加载落位（deny 行渲染即证加载
     完成——journal 摘要是 service 侧的固定模板投影）。 */
  await click("#source-drawer-toggle");
  await waitForJs(
    "(() => { const d = document.getElementById('source-drawer'); " +
      "return d !== null && !d.hidden && d.textContent.includes('tool.decision — tool policy decision on read: deny'); })()",
    10_000,
    "drawer renders the deny tool.decision journal row",
  );
  const drawerText = await evalJs("document.getElementById('source-drawer').textContent");
  /* Tool activity：denied 条目携带 provenance（固定模板 reason + 规则
     来源 [no rule]——默认拒绝）。 */
  assert(
    /· read denied — /.test(drawerText) &&
      /outside every configured read root/.test(drawerText) &&
      /\[no rule\]/.test(drawerText),
    `drawer Tool activity has no 'read denied' entry with the fixed reason and no-rule provenance: ${truncate(sanitizeText(drawerText), 240)}`,
  );
  /* Journal 行：tool.decision 拒绝行 + runtime.error(policy-denied) 行。 */
  assert(
    drawerText.includes("tool.decision — tool policy decision on read: deny (no rule)"),
    "drawer journal has no tool.decision deny (no rule) row for the overreach run",
  );
  assert(
    drawerText.includes("runtime.error — runtime error policy-denied"),
    "drawer journal has no runtime.error policy-denied row for the overreach run",
  );
  /* 渲染文本绝不泄露路径/参数/token（镜像 API 跑批器的泄露清单：
     canary/marker 文件名、canary 目录、读取根、两个 token）。 */
  for (const leak of [tp.canaryName, tp.markerName, tp.canaryDir, tp.readRoots[0], tp.canaryToken, tp.markerToken]) {
    assert(
      !drawerText.includes(leak),
      `rendered drawer text leaks a scenario ${leak === tp.canaryToken || leak === tp.markerToken ? "token" : "path fragment"} (paths/params must never surface)`,
    );
  }
  await snap("tool-policy-deny-provenance");
  /* API 交叉核对：journal 行（服务器权威）+ 诊断面 policyDecisions。 */
  const journal = await api("GET", `${tpPath("journal")}?limit=500`);
  const denyRows = (journal.body?.events ?? []).filter((event) => event.runId === tp.denyRunId);
  assert(
    denyRows.some(
      (event) => event.type === "tool.decision" && /deny/.test(String(event.summary)) && /no rule/.test(String(event.summary)),
    ),
    "journal has no tool.decision deny row for the overreach run (API)",
  );
  assert(
    denyRows.some((event) => event.type === "runtime.error" && /policy-denied/.test(String(event.summary))),
    "journal has no runtime.error(policy-denied) row for the overreach run (API)",
  );
  const diag = await api("GET", tpPath("diagnostics"));
  const policy = diag.body?.policyDecisions;
  assert(policy?.observed === true, "diagnostics policyDecisions.observed is not true after a real denial");
  const views = policy.decisions ?? [];
  const allowView = views.find((view) => view.outcome === "allow");
  const denyView = views.find((view) => view.outcome === "deny");
  assert(allowView !== undefined, "diagnostics policyDecisions has no allow view");
  assert(denyView !== undefined, "diagnostics policyDecisions has no deny view");
  assert(allowView.ruleId === "allow-read-configured-roots", `allow view ruleId is ${String(allowView.ruleId)}`);
  assert(denyView.ruleId === null, `deny view ruleId is ${String(denyView.ruleId)} (expected null)`);
  assert(
    /outside every configured read root/.test(String(denyView.reason)),
    "diagnostics deny view reason does not match the fixed template",
  );
  for (const view of views) {
    assert(
      JSON.stringify(Object.keys(view).sort()) ===
        JSON.stringify(["category", "occurredAt", "outcome", "reason", "risk", "ruleId", "tool"]),
      `policy decision view key set mismatch: ${JSON.stringify(Object.keys(view).sort())}`,
    );
  }
  const diagBlob = JSON.stringify(views);
  for (const leak of [tp.canaryName, tp.markerName, tp.canaryDir, tp.readRoots[0]]) {
    assert(!diagBlob.includes(leak), "diagnostics policy decisions leak a target path fragment");
  }
  /* 抽屉保持打开：canary-never-read 的渲染页断言覆盖含抽屉在内的最大
     呈现面（Tool activity + journal 行此刻都在页面上）。 */
  return {
    detail:
      "denial provenance visible in what the user sees: drawer 'read denied — outside every configured read root [no rule]' + journal tool.decision/runtime.error rows; API cross-check agrees (allow rule allow-read-configured-roots, deny no-rule); no paths/params/tokens leaked",
  };
}

/** canary 内容绝不进入任何会话文件（受控 agent 目录 + 数据目录全树扫描，
 *  排除 canary 文件自身——物理路径比对）与渲染页面（pageSummary 摘要 +
 *  页面正文，此刻抽屉打开即含 Tool activity/journal 的最大呈现面）。 */
async function stepToolPolicyCanaryNeverRead() {
  const tp = sc.toolPolicy;
  assert(tp.canaryToken !== null, "scenario wiring: canary token missing (see tool-policy-boot)");
  assert(tp.agentDir !== null, "scenario wiring: controlled agent dir missing (see tool-policy-boot)");
  const scanned = new Map();
  const unreadable = [];
  for (const file of [...walkFiles(tp.agentDir), ...walkFiles(sc.dataDir)]) {
    if (scanned.has(file)) continue;
    try {
      scanned.set(file, readFileSync(file, "utf8"));
    } catch {
      unreadable.push(file);
    }
  }
  assert(unreadable.length === 0, `files could not be scanned for the canary: ${unreadable.join(", ")}`);
  assert(scanned.size > 0, "no files found under the controlled agent dir or the data dir to scan");
  const canaryPhysical = physicalPath(tp.canaryPath) ?? tp.canaryPath;
  const leaks = [...scanned.entries()].filter(([path, text]) => {
    if ((physicalPath(path) ?? path) === canaryPhysical) return false;
    return text.includes(tp.canaryToken);
  });
  assert(
    leaks.length === 0,
    `canary content materialized in ${String(leaks.length)} file(s) under the controlled agent dir / data dir — the denied read must never execute`,
  );
  /* 渲染页两道扫描：结构化摘要（含对话回合/抽屉文本/横幅）+ 页面正文。 */
  const summary = await evalJs(pageSummaryExpression());
  const summaryBlob = JSON.stringify(summary);
  assert(!summaryBlob.includes(tp.canaryToken), "the rendered page summary carries the canary token");
  const bodyText = await evalJs("document.body.textContent");
  assert(!(bodyText ?? "").includes(tp.canaryToken), "the rendered page body carries the canary token");
  await snap("tool-policy-canary-never-read");
  return {
    detail: `${String(scanned.size)} files scanned (controlled agent dir + data dir incl. sessions/journal/DB): canary content never materialized; rendered page (incl. the open drawer) carries no canary token`,
  };
}

/* ------------------------------------------------------------------ */
/* 模型错误注入相（issue #6 P0-2 清单第 4 项模型错误腿的浏览器面）。       */
/* 两种模式各有一条确定性注入路径（同一检查 id，双时序执行——见 main()）：  */
/*   - selftest：echo /fail 钩子，主树，原位置（断言面自 v1.0.0 不变）；   */
/*   - real-pi：错误配置 registry 的重启舞步（镜像 run-d3-real-pi.mjs      */
/*     phaseModelError 的 real-pi 分支与 evidence/d3/real-pi/             */
/*     20260929T104445Z-faults-model-error.md 已证手法）：受控 agent 目录   */
/*     副本仅改 provider baseUrl 为不可路由回环地址（绝不产生真实 provider  */
/*     请求；凭据全程环境注入且不变）→ SIGKILL 重启同一数据目录 → 全新     */
/*     探针树 prompt：502 / Run failed / 零回合 / composer 复位（浏览器面  */
/*     断言用户实际看到的呈现 + HTTP 交叉核对权威状态）→ 换回原 registry   */
/*     重启 → 同树同一 prompt 成功（failed → succeeded 恢复闭环）。        */
/* ------------------------------------------------------------------ */

/** selftest 路径：/fail 钩子注入（本函数仅把原 main() 内联块原样提出——
 *  断言与执行时序逐字节不变；runCheck 包装留在调用点）。 */
async function stepModelErrorEcho() {
  /* echo /fail 注入（selftest 专属确定性钩子）→ upstream 模拟失败。
     /fail 的 502 是预期的页面网络错误——采集窗口内不计入 console-clean。 */
  chrome.expectPageErrors = true;
  try {
    await sendTrunkPrompt(SCENARIO.fail, { keyboard: false });
    await waitForJs(
      "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0; })()",
      CLI.promptTimeoutMs,
      "error banner visible after /fail",
    );
  } finally {
    chrome.expectPageErrors = false;
  }
  const summary = await snap("model-error");
  assert(summary.main.errorBanner.role === "alert", `error banner role is ${String(summary.main.errorBanner.role)}`);
  assert((summary.main.errorBanner.text ?? "").includes("upstream"), `error banner text unexpected: ${truncate(summary.main.errorBanner.text ?? "", 120)}`);
  /* 常驻失败面板：Run … failed — upstream: …（不自动隐藏）。 */
  await waitForJs(
    "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.includes('upstream'); })()",
    10_000,
    "persistent failure panel with upstream code",
  );
  /* 失败后 composer 解锁（终局渲染保证）且主线可续用（恢复路径）。 */
  const composerEnabled = await evalJs("document.getElementById('prompt-input').disabled === false");
  assert(composerEnabled === true, "trunk composer did not re-enable after the failed run converged");
  await sendTrunkPrompt(SCENARIO.recovery, { keyboard: false });
  await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["back-online"] : ["back-online"], CLI.promptTimeoutMs, 4);
  sc.trunkTurnCount += 2; /* /fail 零回合落库；恢复 prompt 落 1 对回合（断言前登记） */
  const runs = (await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/diagnostics`)).body?.runs ?? [];
  const failedRun = runs.find((r) => r.state === "failed");
  assert(failedRun !== undefined, "no failed run recorded server-side after /fail");
  assert((failedRun.failure?.code ?? "") === "upstream", `failed run code is ${String(failedRun.failure?.code)}`);
  await snap("model-error-recovered");
  return { detail: `/fail converged as a failed run (banner role=alert text upstream, persistent failure panel, composer re-enabled); follow-up prompt succeeded; server shows the failed run (upstream)` };
}

/** 模型错误相探针树 API 路径。 */
function mePath(action) {
  const me = sc.modelError;
  assert(me !== null && me.probeTreeId !== null, "scenario wiring: model-error probe tree missing (see stepModelErrorRealPi)");
  return `/api/trees/${encodeURIComponent(me.probeTreeId)}${action === undefined ? "" : `/${action}`}`;
}

/** 真实侧栏点击选中指定树。整页刷新后 app.js 引导逻辑自动打开 trees[0]
 *  （repository 按创建序返回 = 最旧的主剧本树）——模型错误相的恢复
 *  prompt 必须落在探针树上，故先以真实点击切换（app.js renderTrees：
 *  #tree-list li button，首个 span = 完整树 id，选中态 = .active）。 */
async function selectTreeInSidebar(treeId) {
  const target = JSON.stringify(treeId);
  const index = await evalJs(
    "(() => { const items = [...document.querySelectorAll('#tree-list li button')]; " +
    `const hit = items.findIndex((b) => { const span = b.querySelector('span'); return span !== null && span.textContent === ${target}; }); ` +
    "return hit; })()",
  );
  assert(typeof index === "number" && index >= 0, `tree ${String(treeId).slice(0, 8)}… not found in the sidebar tree list`);
  await click(`#tree-list li:nth-of-type(${String(index + 1)}) button`);
  await waitForJs(
    "(() => { const items = [...document.querySelectorAll('#tree-list li button')]; " +
    `const b = items[${String(index)}]; return b !== undefined && b.classList.contains('active') === true; })()`,
    10_000,
    "probe tree active in the sidebar after the click",
  );
}

/** 模型错误相的全新探针树（真实 #new-tree 点击，镜像 tool-policy-boot /
 *  openDeepProbeTree 的模式：新建即打开——干净 session；knownIds 差分
 *  确保恰好一棵新树；登记入 sc.modelError，不沾染 A2 相的探针树登记）。 */
async function openModelErrorProbeTree() {
  const me = sc.modelError;
  assert(me !== null, "scenario wiring: model-error state missing (see main())");
  const treesBefore = await api("GET", "/api/trees");
  assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
  const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
  await click("#new-tree");
  await waitForJs(
    "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
    10_000,
    "model-error probe tree view visible after the new-tree click",
  );
  const treesAfter = await api("GET", "/api/trees");
  assert(treesAfter.status === 200, `GET /api/trees failed after the model-error new-tree click: ${String(treesAfter.status)}`);
  const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
  assert(newTrees.length === 1, `the model-error new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
  const treeId = newTrees[0].id;
  const state = await api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  assert(state.status === 200, `model-error probe tree state fetch failed: ${String(state.status)}`);
  const trunkBranchId = state.body?.trunkBranchId;
  assert(typeof trunkBranchId === "string" && trunkBranchId.length > 0, "model-error probe tree state has no trunk branch id");
  me.probeTreeId = treeId;
  me.probeTrunkId = trunkBranchId;
  return { treeId, trunkBranchId };
}

/** real-pi 路径：错误配置 registry 的重启舞步（独立探针树）。断言面 =
 *  用户实际看到的渲染 DOM（真实输入事件驱动）+ HTTP 交叉核对权威状态；
 *  错误码按现行分类器如实登记（连接类错误现行归 unknown——是否细化属
 *  owner 契约决定，断言只要求渲染面与诊断面一致）。 */
async function stepModelErrorRealPi() {
  const me = sc.modelError;
  assert(MODE === "real-pi" && me !== null, "scenario wiring: the model-error dance requires real-pi mode (see main())");

  /* 受控 agent 目录自当前引导横幅解析（原始 registry）。studio.stdoutRaw
     是唯一未脱敏的子进程输出留存（横幅路径正则需要原文）；任何派生
     输出必经 sanitizeText。 */
  const waitStudioBanner = async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (/pi agent-dir=/.test(studio.stdoutRaw) || Date.now() >= deadline) return studio.stdoutRaw;
      await sleep(100);
    }
  };
  const sourceAgentDir = (/pi agent-dir=(.+?) \(controlled/.exec(await waitStudioBanner()) ?? [])[1];
  assert(typeof sourceAgentDir === "string" && sourceAgentDir.length > 0, "studio banner does not report the controlled agent dir");
  assert(existsSync(sourceAgentDir), `the controlled agent dir reported by the banner does not exist: ${sanitizeText(sourceAgentDir)}`);
  me.agentDir = sourceAgentDir;

  /* 主树遏制基线 + 既有树集合（相末核对：本相只新增自己的探针树）。 */
  const treesListBefore = await api("GET", "/api/trees");
  assert(treesListBefore.status === 200, `GET /api/trees failed: ${String(treesListBefore.status)}`);
  const mainBefore = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
  assert(mainBefore.status === 200, `main tree state fetch failed: ${String(mainBefore.status)}`);
  const mainBeforeTrunk = (mainBefore.body?.branches ?? []).find((view) => view.branch.id === mainBefore.body?.trunkBranchId);
  me.baseline = {
    branchIds: (mainBefore.body?.branches ?? []).map((view) => view.branch.id),
    trunkTurnCount: (mainBeforeTrunk?.turns ?? []).length,
    treeIds: (treesListBefore.body?.trees ?? []).map((tree) => tree.id),
  };

  /* 副本 + 仅改 provider baseUrl（其余 registry 字段逐字节保留；副本位于
     系统临时目录——数据目录/canary 扫描与 gitInfo().dirty 均不受影响，
     cleanup 按保留/失败语义处置）。 */
  const misconfigDir = mkdtempSync(join(tmpdir(), "treeai-d3-misconfig-agent-"));
  me.misconfigDir = misconfigDir;
  cpSync(sourceAgentDir, misconfigDir, { recursive: true });
  const modelsPath = join(misconfigDir, "models.json");
  assert(existsSync(modelsPath), `the controlled agent dir carries no models.json registry to misconfigure: ${sanitizeText(sourceAgentDir)}`);
  let registry;
  try {
    registry = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch (err) {
    throw new Error(`the registry copy could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const provider = registry?.providers?.[CLI.provider];
  assert(provider !== null && typeof provider === "object", `the registry has no provider entry for '${CLI.provider}'`);
  assert(typeof provider.baseUrl === "string" && provider.baseUrl.length > 0, `provider '${CLI.provider}' has no baseUrl to misconfigure`);
  provider.baseUrl = MISCONFIG_BASE_URL;
  writeFileSync(modelsPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  /* 注入引导：SIGKILL 当前 studio（killStudioAndWait 防 studio.exited 竞态
     ——旧子进程迟到的 exit 事件会误标新引导），以错配副本引导同一数据
     目录；SSE 随服务死掉 → 整页刷新窗口的预期网络错误不计入
     console-clean。 */
  chrome.expectPageErrors = true;
  let misconfigBanner = "";
  try {
    await killStudioAndWait();
    await startStudio(sc.dataDir, { agentDir: misconfigDir, logName: "studio-misconfig.log" });
    await navigate(sc.studioUrl);
    misconfigBanner = await waitStudioBanner();
  } finally {
    chrome.expectPageErrors = false;
  }
  assert(
    misconfigBanner.includes(`pi agent-dir=${misconfigDir} (controlled`),
    "the misconfigured boot does not report the registry copy as its controlled agent dir",
  );

  /* 全新探针树：错误 prompt 与恢复 prompt 都走全新 session（干净面，
     主树各检查计数不受影响）。 */
  await openModelErrorProbeTree();

  /* 错误 prompt（真实 composer 输入 + 点击发送）：provider 不可达 → 502。
     SDK 内部重试有固定时长，promptTimeoutMs 覆盖；502 是预期的页面网络
     错误（采集窗口内不计入 console-clean）。 */
  const assistantBefore = await probeAssistantTurnCount();
  assert(assistantBefore === 0, `the fresh probe tree should render zero assistant turns (got ${String(assistantBefore)})`);
  let outcome;
  chrome.expectPageErrors = true;
  try {
    await sendTrunkPrompt(SCENARIO.modelErrorProbe, { keyboard: false });
    outcome = await waitForProbeOutcome(assistantBefore, CLI.promptTimeoutMs);
  } finally {
    chrome.expectPageErrors = false;
  }
  assert(
    outcome.kind === "error",
    `the misconfigured prompt did not converge to an error presentation: ${truncate(sanitizeText(JSON.stringify(outcome)), 300)}`,
  );
  const errorCode = failureErrorCode(outcome.bannerText, outcome.panelText);
  assert(
    typeof errorCode === "string" && errorCode.length > 0,
    `no error code rendered in the banner/failure panel: ${truncate(sanitizeText(String(outcome.bannerText ?? outcome.panelText ?? "")), 160)}`,
  );
  me.errorCode = errorCode;

  /* 用户实际看到的失败呈现：横幅 role=alert 且携带错误码（8 秒自动隐藏
     窗口内先等待可见再读取，不依赖 snap 时序）；常驻失败面板 Run …
     failed — code: …（不自动隐藏）；composer 解锁；run-status 收敛
     idle；零回合渲染。 */
  await waitForJs(
    "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0; })()",
    10_000,
    "error banner visible after the misconfigured prompt",
  );
  const bannerFacts = await evalJs(
    "(() => { const b = document.getElementById('error-banner'); " +
    "return { role: b === null ? null : b.getAttribute('role'), visible: b !== null && !b.hidden, text: b === null ? '' : b.textContent }; })()",
  );
  assert(bannerFacts.role === "alert", `error banner role is ${String(bannerFacts.role)}`);
  assert(bannerFacts.visible === true, "error banner not visible when the failed prompt converged");
  assert(String(bannerFacts.text).includes(errorCode), `error banner text does not carry the code '${errorCode}': ${truncate(sanitizeText(String(bannerFacts.text)), 120)}`);
  await waitForJs(
    "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.length > 0; })()",
    10_000,
    "persistent failure panel after the misconfigured prompt",
  );
  const panelText = String(await evalJs("document.getElementById('failure-panel').textContent"));
  assert(
    new RegExp(`failed — ${errorCode}:`).test(panelText),
    `failure panel does not show 'Run … failed — ${errorCode}:': ${truncate(sanitizeText(panelText), 160)}`,
  );
  const renderedAssistant = await probeAssistantTurnCount();
  const renderedAll = await evalJs("document.querySelectorAll('#conversation .turn:not(#streaming-turn)').length");
  assert(renderedAssistant === 0 && renderedAll === 0, `a failed prompt must render no turns (assistant ${String(renderedAssistant)}, all ${String(renderedAll)})`);
  const composerEnabled = await evalJs("document.getElementById('prompt-input').disabled === false");
  assert(composerEnabled === true, "trunk composer did not re-enable after the failed run converged");
  await waitForJs(
    "document.getElementById('run-status') !== null && document.getElementById('run-status').textContent === 'idle'",
    10_000,
    "#run-status back to idle after the failed prompt converged",
  );
  await snap("model-error-misconfig");

  /* 服务器权威状态交叉核对（HTTP 面 = API 跑批器同一断言面）。 */
  const probeState = await api("GET", mePath("state"));
  assert(probeState.status === 200, `probe tree state fetch failed: ${String(probeState.status)}`);
  const probeTrunkView = (probeState.body?.branches ?? []).find((view) => view.branch.id === me.probeTrunkId);
  assert(probeTrunkView !== undefined, "probe tree state has no trunk branch view");
  assert((probeTrunkView.turns ?? []).length === 0, "a failed prompt must persist no turns");
  let probeDiag = await api("GET", mePath("diagnostics"));
  assert(probeDiag.body?.runtimeState === "idle", `runtimeState is ${String(probeDiag.body?.runtimeState)} (expected idle) after the misconfigured prompt`);
  assert(probeDiag.body?.activeRun === null, "activeRun is not null after the misconfigured prompt");
  const failedRun = (probeDiag.body?.runs ?? []).find((run) => run.state === "failed");
  assert(failedRun !== undefined, "diagnostics shows no failed run for the misconfigured prompt");
  assert(
    failedRun.failure?.code === errorCode,
    `the failed run carries code ${String(failedRun.failure?.code)} while the rendered presentation carried ${errorCode}`,
  );
  me.failedRunId = failedRun.runId;
  assert(typeof me.failedRunId === "string" && me.failedRunId.length > 0, "the failed run has no run id");

  /* 恢复引导：SIGKILL，换回原 registry 重启同一数据目录（配置修复）。 */
  chrome.expectPageErrors = true;
  let recoveryBanner = "";
  try {
    await killStudioAndWait();
    await startStudio(sc.dataDir, { logName: "studio-recovery.log" });
    await navigate(sc.studioUrl);
    recoveryBanner = await waitStudioBanner();
  } finally {
    chrome.expectPageErrors = false;
  }
  assert(
    recoveryBanner.includes(`pi agent-dir=${sourceAgentDir} (controlled`),
    "the recovery boot does not report the original controlled agent dir",
  );

  /* 整页刷新后页面自动打开最旧树（主剧本树）——先以真实侧栏点击选中
     探针树。失败呈现自权威状态重建（常驻失败面板 sticky 语义）：同一
     run 前缀 + 同一错误码重现，零回合不变——「失败事实跨进程重启保留」
     的浏览器面证明。 */
  await selectTreeInSidebar(me.probeTreeId);
  await waitForJs(
    "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.length > 0; })()",
    10_000,
    "failure panel reconstructed from authoritative state after the restart",
  );
  const reconstructedPanel = String(await evalJs("document.getElementById('failure-panel').textContent"));
  assert(
    reconstructedPanel.includes(me.failedRunId.slice(0, 12)),
    `the reconstructed failure panel does not reference the failed run ${me.failedRunId.slice(0, 8)}…: ${truncate(sanitizeText(reconstructedPanel), 160)}`,
  );
  assert(
    new RegExp(`failed — ${errorCode}:`).test(reconstructedPanel),
    `the reconstructed failure panel lost the code '${errorCode}': ${truncate(sanitizeText(reconstructedPanel), 160)}`,
  );
  const renderedAfterRestart = await evalJs("document.querySelectorAll('#conversation .turn:not(#streaming-turn)').length");
  assert(renderedAfterRestart === 0, `rendered turns after restart+reload is ${String(renderedAfterRestart)} (expected 0)`);

  /* 同一探针树、同一 prompt：配置修复 + 重启后成功（failed → succeeded）。
     常驻失败面板先经真实 Dismiss 清场（sticky 面板会让结局检测立即误读
     error——waitForProbeOutcome 的既有纪律）。 */
  await resetErrorSurfaces();
  const before = await probeAssistantTurnCount();
  let recovery;
  chrome.expectPageErrors = true;
  try {
    await sendTrunkPrompt(SCENARIO.modelErrorProbe, { keyboard: false });
    recovery = await waitForProbeOutcome(before, CLI.promptTimeoutMs);
  } finally {
    chrome.expectPageErrors = false;
  }
  assert(
    recovery.kind === "answer",
    `the recovery prompt did not produce an answer: ${truncate(sanitizeText(JSON.stringify(recovery)), 300)}`,
  );
  assert(typeof recovery.text === "string" && recovery.text.trim().length > 0, "the recovery answer is empty");

  /* 页面终局：2 渲染回合（1 user + 1 assistant）、run-status idle；
     服务器侧：同树 2 回合落库、run 序列 failed(code) → succeeded。 */
  const renderedFinal = await evalJs("document.querySelectorAll('#conversation .turn:not(#streaming-turn)').length");
  assert(renderedFinal === 2, `rendered turns after recovery is ${String(renderedFinal)} (expected 2: user + assistant)`);
  await waitForJs(
    "document.getElementById('run-status') !== null && document.getElementById('run-status').textContent === 'idle'",
    10_000,
    "#run-status back to idle after the recovery prompt",
  );
  const probeState2 = await api("GET", mePath("state"));
  const probeTrunkView2 = (probeState2.body?.branches ?? []).find((view) => view.branch.id === me.probeTrunkId);
  assert((probeTrunkView2?.turns ?? []).length === 2, `the recovery prompt did not persist its turn pair (${String(probeTrunkView2?.turns?.length ?? -1)})`);
  probeDiag = await api("GET", mePath("diagnostics"));
  assert(probeDiag.body?.runtimeState === "idle", "runtimeState is not idle after the recovery prompt");
  const runStates = (probeDiag.body?.runs ?? []).map((run) => `${run.state}${run.failure === null ? "" : `(${String(run.failure.code)})`}`);
  assert(
    JSON.stringify(runStates) === JSON.stringify([`failed(${errorCode})`, "succeeded"]),
    `the probe run sequence is ${JSON.stringify(runStates)} (expected [failed(${errorCode}), succeeded])`,
  );
  await snap("model-error-recovery");

  /* 相末遏制核对：主剧本树分支集与干线回合数跨相不变；树集合恰增一棵
     （本相探针树）——探针隔离的机械证明。 */
  const mainAfter = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
  assert(mainAfter.status === 200, `main tree state fetch failed after the model-error phase: ${String(mainAfter.status)}`);
  const afterBranchIds = (mainAfter.body?.branches ?? []).map((view) => view.branch.id);
  assert(
    JSON.stringify(afterBranchIds) === JSON.stringify(me.baseline.branchIds),
    `main tree branch set drifted across the model-error phase: ${JSON.stringify(me.baseline.branchIds)} → ${JSON.stringify(afterBranchIds)}`,
  );
  const afterTrunkView = (mainAfter.body?.branches ?? []).find((view) => view.branch.id === mainAfter.body?.trunkBranchId);
  assert(
    (afterTrunkView?.turns ?? []).length === me.baseline.trunkTurnCount,
    `main tree trunk turns drifted across the model-error phase: ${String(me.baseline.trunkTurnCount)} → ${String(afterTrunkView?.turns?.length ?? -1)}`,
  );
  const afterTreeIds = ((await api("GET", "/api/trees")).body?.trees ?? []).map((tree) => tree.id);
  assert(
    JSON.stringify(afterTreeIds) === JSON.stringify([...me.baseline.treeIds, me.probeTreeId]),
    `the tree set drifted beyond the model-error probe tree: ${JSON.stringify(afterTreeIds)}`,
  );

  return {
    detail:
      `misconfigured registry (unroutable baseUrl) booted through the product CLI: the browser rendered the failed run (banner role=alert code ${errorCode}, persistent failure panel, composer re-enabled, zero turns on page and server, diagnostics idle) on a fresh probe tree; ` +
      `original-registry restart + reload reconstructed the failure presentation from authoritative state and the same tree then succeeded (failed(${errorCode}) → succeeded)`,
  };
}

/* ------------------------------------------------------------------ */
/* A2 深选区相（issue #6 P1 / W2 §4；双模式，无需工具缝）。把 ui-probe   */
/* 的三个脚本化 DOM 场景——数千字符长答案的后段选区（非整条回退）、重复    */
/* 词**第二处**（绝不允许首处顶替）、跨渲染行选区——抬到真实浏览器操作：    */
/* 每场景一棵全新探针树（真实 #new-tree 点击，干净 session——主剧本树不受   */
/* 影响，相末核对计数不变），经真实 composer 产生数千字符答案（echo =      */
/* 精确回声 → 确定性偏移；real-pi = 逐字复述指令 + 从实际渲染答案动态计算  */
/* + 逃逸逐次加硬重试），真实鼠标拖选按字符盒精确落位，断言浏览器侧偏移、   */
/* 面板摘录、服务器 origin.selection、揭示切片四面对齐。                   */
/* ------------------------------------------------------------------ */

/** 全新探针树（真实 #new-tree 点击，镜像 tool-policy-boot 的模式：新建即
 *  打开——干净 session；knownIds 差分确保恰好一棵新树）。 */
async function openDeepProbeTree(label) {
  const treesBefore = await api("GET", "/api/trees");
  assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
  const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
  await click("#new-tree");
  await waitForJs(
    "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
    10_000,
    `${label} probe tree view visible after the new-tree click`,
  );
  const treesAfter = await api("GET", "/api/trees");
  assert(treesAfter.status === 200, `GET /api/trees failed after the ${label} new-tree click: ${String(treesAfter.status)}`);
  const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
  assert(newTrees.length === 1, `the ${label} new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
  const treeId = newTrees[0].id;
  const state = await api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  assert(state.status === 200, `${label} probe tree state fetch failed: ${String(state.status)}`);
  const trunkBranchId = state.body?.trunkBranchId;
  assert(typeof trunkBranchId === "string" && trunkBranchId.length > 0, `${label} probe tree state has no trunk branch id`);
  sc.deepSelection.probeTreeIds.push(treeId);
  return { treeId, trunkBranchId };
}

/** 探针 prompt → 完成答案 → 动态期望。真实模型方差（答案 <3000 字符、
 *  结构缺失、上游错误）= 逃逸/失败轮：如实登记，逐次加硬指令最多
 *  DEEP_ASKS.length 次尝试，PASS 仅要求其中一次结构成立（镜像工具相的
 *  有界重试纪律；echo 面第 1 条恒中——回声即 prompt 的确定性回放）。
 *  尝试窗口内 expectPageErrors：可重试的 prompt 失败轮（如 502 上游错误）
 *  的页面网络错误按预期不计入 console-clean（结局仍如实登记于 attempts）。 */
async function deepPromptForAnswer({ label, block, validate }) {
  for (let attempt = 1; attempt <= DEEP_ASKS.length; attempt += 1) {
    await resetErrorSurfaces();
    const assistantBefore = await probeAssistantTurnCount();
    const prompt = `${DEEP_ASKS[attempt - 1]}\n\n${block}`;
    let outcome;
    chrome.expectPageErrors = true;
    try {
      await sendTrunkPrompt(prompt, { keyboard: false });
      outcome = await waitForProbeOutcome(assistantBefore, CLI.promptTimeoutMs);
    } finally {
      chrome.expectPageErrors = false;
    }
    if (outcome.kind === "error") {
      sc.deepSelection.attempts.push({
        scenario: label,
        attempt,
        outcome: `error: ${failureErrorCode(outcome.bannerText, outcome.panelText) ?? truncate(sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
      });
      continue;
    }
    const answerText = outcome.text;
    if (typeof answerText !== "string" || answerText.length < DEEP_MIN_ANSWER_CHARS) {
      sc.deepSelection.attempts.push({
        scenario: label,
        attempt,
        outcome: `escape: answer ${typeof answerText === "string" ? `${String(answerText.length)} chars` : "not text"} (< ${String(DEEP_MIN_ANSWER_CHARS)})`,
      });
      continue;
    }
    const expectation = validate(answerText);
    if (expectation.ok !== true) {
      sc.deepSelection.attempts.push({ scenario: label, attempt, outcome: `escape: ${expectation.reason}` });
      continue;
    }
    return { prompt, answerText, expectation, attempt };
  }
  assert(
    false,
    `the ${label} probe did not produce a structurally valid answer in ${String(DEEP_ASKS.length)} attempts: ${JSON.stringify(sc.deepSelection.attempts)}`,
  );
}

/** 最后一条已完成 assistant 回合的稳定选择器（等流式占位清除后按
 *  data-turn-id 取——跨重渲稳定；重试轮下此即被验证的那条答案）。 */
async function deepLastAnswerSelector() {
  await waitForJs(
    "document.getElementById('streaming-turn') === null",
    5_000,
    "streaming placeholder cleared before the deep-selection drag",
  );
  const turnId = await evalJs(
    "(() => { const turns = [...document.querySelectorAll('#conversation .turn.assistant:not(#streaming-turn)')]; " +
      "return turns.length === 0 ? null : turns[turns.length - 1].dataset.turnId ?? null; })()",
  );
  assert(turnId !== null, "no completed assistant answer found in the probe tree trunk");
  return { selector: `#conversation .turn.assistant[data-turn-id="${turnId}"]`, turnId };
}

/** 页面侧选区事实：武装态 + 原生选区的绝对偏移（复刻 app.js
 *  selectionOffsetsWithin 的前缀长度数学——这正是 .branch-here 点击时
 *  将提交的 {start,end,text}）；携带选区原文/矩形计数与滚动容器实况
 * （失败时的取证面——镜像 waitForAnswerMarkers 的超时诊断纪律）。 */
function deepSelectionStateExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const button = el.querySelector('.branch-here');
    const selection = window.getSelection();
    let offsets = null;
    if (selection !== null && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (el.contains(range.commonAncestorContainer)) {
        const selected = range.toString();
        if (selected.length > 0) {
          const before = range.cloneRange();
          before.selectNodeContents(el);
          before.setEnd(range.startContainer, range.startOffset);
          const start = before.toString().length;
          if (el.dataset.turnText.slice(start, start + selected.length) === selected) {
            offsets = { start, end: start + selected.length, text: selected };
          }
        }
      }
    }
    let scroller = el.parentElement;
    while (scroller !== null && scroller !== document.body) {
      const cs = getComputedStyle(scroller);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    return {
      hasSelection: el.classList.contains('has-selection'),
      buttonText: button === null ? null : button.textContent,
      offsets,
      selectionText: selection === null ? null : String(selection).slice(0, 80),
      selectionRectCount: selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).getClientRects().length : 0,
      scroller: scroller === null ? null : { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
      viewport: { innerHeight: window.innerHeight, scrollY: window.scrollY },
    };
  })()`;
}

/** 跨行几何证明：原生选区的 client rects（跨渲染行 = 多矩形）+ 选区两端
 *  字符所在渲染行的 top（不同行 = 真实行边界跨越——pre-wrap 下的实况，
 *  非仅字符偏移含换行）。 */
function deepSelectionGeometryExpression(selector, start, end) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const selection = window.getSelection();
    if (el === null || selection === null || selection.rangeCount === 0) return null;
    const rectCount = selection.getRangeAt(0).getClientRects().length;
    const walker = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') break;
      if (node.nodeType === Node.TEXT_NODE) walker.push(node);
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'MARK') {
        for (const inner of node.childNodes) if (inner.nodeType === Node.TEXT_NODE) walker.push(inner);
      }
    }
    const charTop = (target) => {
      let acc = 0;
      for (const node of walker) {
        const len = node.textContent.length;
        if (target < acc + len) {
          const range = document.createRange();
          range.setStart(node, target - acc);
          range.setEnd(node, target - acc + 1);
          const boxes = range.getClientRects();
          return boxes.length === 0 ? null : boxes[boxes.length - 1].top;
        }
        acc += len;
      }
      return null;
    };
    return { rectCount, fromTop: charTop(${String(start)}), toTop: charTop(${String(end)} - 1) };
  })()`;
}

/** 揭示切片事实（镜像 ui-probe 的 assertRevealSlices 语义）：揭示后的
 *  锚点 turn 渲染为 [前缀文本节点, mark 高亮, 后缀文本节点]——前后缀与
 *  高亮必须恰为 turn 文本按绝对偏移的三段切片（偏移定位的 UI 级证明，
 *  非字符串搜索近似）；焦点移至锚点 turn（tabindex=-1 + anchor-focus）。 */
function deepRevealSlicesExpression(selector) {
  return `(() => {
    const turn = document.querySelector(${JSON.stringify(selector)});
    if (turn === null) return null;
    const mark = turn.querySelector('.source-highlight');
    if (mark === null) return null;
    const nodes = [...turn.childNodes];
    const markIndex = nodes.indexOf(mark);
    const prefix = markIndex > 0 ? nodes[markIndex - 1] : null;
    const suffix = markIndex >= 0 && markIndex + 1 < nodes.length ? nodes[markIndex + 1] : null;
    return {
      markText: mark.textContent,
      prefixText: prefix !== null && prefix.nodeType === Node.TEXT_NODE ? prefix.data : null,
      suffixText: suffix !== null && suffix.nodeType === Node.TEXT_NODE ? suffix.data : null,
      anchorFocus: turn.classList.contains('anchor-focus'),
      tabindex: turn.getAttribute('tabindex'),
      focused: document.activeElement === turn,
    };
  })()`;
}

/** 场景专属断言挂点之后的公共链路：fresh 探针树 → prompt/答案/期望 →
 *  （echo 确定性）→ 服务器 turn 文本对齐 → 真实拖选（字符盒精确落点）→
 *  武装态 + 浏览器侧偏移全等 →（场景几何证明）→ 建支线 → 面板摘录精确
 *  携带 → API 交叉核对 origin.selection 全等 → 揭示切片 → 锚定支线可
 *  续聊（短 follow-up + 标记等待）→ 关面板。 */
async function runDeepSelectionScenario({ label, block, validate, followUp, selectionAssert = null, echoAssert = null }) {
  const probe = await openDeepProbeTree(label);
  const { prompt, answerText, expectation } = await deepPromptForAnswer({ label, block, validate });
  /* echo 确定性（selftest）：答案 = prompt 的精确回声 → 动态计算即落在
     已知确定位置；场景专属确定性断言（出现次数/体量/深度）由 echoAssert
     补充（镜像 ui-probe 的精确断言语义）。 */
  if (MODE === "selftest") {
    assert(
      answerText === `echo:[${prompt}]`,
      "the echo answer is not the exact prompt echo (the deterministic echo contract is broken — see apps/studio/src/echo-port.ts echoAnswer)",
    );
    if (echoAssert !== null) echoAssert(answerText, prompt);
  }
  /* 服务器权威 turn 文本与渲染一致（动态期望的事实基础两侧对齐）。 */
  const probeState = await api("GET", `/api/trees/${encodeURIComponent(probe.treeId)}/state`);
  assert(probeState.status === 200, `${label} probe tree state fetch failed: ${String(probeState.status)}`);
  const trunkView = (probeState.body?.branches ?? []).find((view) => view.branch.id === probe.trunkBranchId);
  assert(trunkView !== undefined, `${label} probe tree state has no trunk branch view`);
  const serverAnswer = (trunkView.turns ?? []).filter((turn) => turn.role === "assistant").at(-1);
  assert(serverAnswer !== undefined, `${label} probe trunk has no assistant answer server-side`);
  assert(serverAnswer.text === answerText, `${label} rendered answer text disagrees with the server turn text`);

  /* 真实拖选（精确 [from,to) 落点）→ 选区武装 + 浏览器侧偏移与计算目标
     全等（非整条回退/非首处顶替的第一道证明——偏移即目标出现位置）。 */
  const { selector, turnId } = await deepLastAnswerSelector();
  const dragPoints = await dragSelect(selector, expectation.start, expectation.end);
  const selState = await evalJs(deepSelectionStateExpression(selector));
  assert(
    selState !== null && selState.hasSelection === true,
    `${label}: the answer did not enter .has-selection after the real drag; drag points ${JSON.stringify(dragPoints)}; page selection state ${JSON.stringify(selState)}`,
  );
  assert(selState.buttonText === "⑃ Branch from selection", `${label}: branch button text is ${String(selState.buttonText)}`);
  assert(selState.offsets !== null, `${label}: the native selection is empty or not contained in the answer turn`);
  assert(
    selState.offsets.start === expectation.start && selState.offsets.end === expectation.end && selState.offsets.text === expectation.text,
    `${label}: browser-side selection ${JSON.stringify(selState.offsets)} does not equal the computed target ${JSON.stringify({ start: expectation.start, end: expectation.end, text: expectation.text })}`,
  );
  if (selectionAssert !== null) await selectionAssert(selector, answerText, expectation);
  await snap(`${label}-anchor`);

  /* 建支线（真实点击）→ 面板摘录精确携带所选文本。 */
  await click(`${selector} .branch-here`);
  await waitForJs(
    "document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden",
    10_000,
    `${label} branch panel open`,
  );
  const branchSummary = await snap(`${label}-branch`);
  assert(branchSummary.panel.title === "Branch 1", `${label}: panel title is ${String(branchSummary.panel.title)} (expected "Branch 1")`);
  const anchorCtx = branchSummary.panel.anchorContext ?? "";
  assert(
    anchorCtx.includes(`“${expectation.text}”`),
    `${label}: the panel anchor context does not carry the exact selected excerpt: ${truncate(anchorCtx, 160)}`,
  );

  /* API 交叉核对：服务器 branch 记录的 origin.selection 与浏览器侧全等
     （锚点 {start,end,text} 逐字段；originStatus available）。 */
  const afterState = await api("GET", `/api/trees/${encodeURIComponent(probe.treeId)}/state`);
  assert(afterState.status === 200, `${label}: probe tree state fetch failed after branching: ${String(afterState.status)}`);
  const views = afterState.body?.branches ?? [];
  assert(views.length === 2, `${label}: probe tree has ${String(views.length)} branch views (expected trunk + the anchored branch)`);
  const anchored = views.filter((view) => view.origin !== null && view.origin.anchorTurnId === turnId);
  assert(anchored.length === 1, `${label}: expected exactly one branch anchored on the probed answer turn, found ${String(anchored.length)}`);
  const origin = anchored[0].origin;
  assert(
    origin.selection.start === expectation.start && origin.selection.end === expectation.end && origin.selection.text === expectation.text,
    `${label}: server anchor record ${JSON.stringify(origin.selection)} does not equal the browser-side selection`,
  );
  assert(anchored[0].originStatus === "available", `${label}: anchored branch originStatus is ${String(anchored[0].originStatus)}`);

  /* 揭示（真实点击 ⌖ View source）：高亮按服务端偏移切片——前缀/后缀恰
     切两侧；焦点移至锚点 turn。 */
  await click("#panel-view-source");
  await waitForJs(
    `document.querySelector(${JSON.stringify(`${selector} .source-highlight`)}) !== null`,
    10_000,
    `${label} reveal highlight rendered`,
  );
  const revealed = await evalJs(deepRevealSlicesExpression(selector));
  assert(revealed !== null, `${label}: the revealed turn carries no highlight mark`);
  assert(revealed.markText === expectation.text, `${label}: the highlight is not exactly the anchored selection text`);
  assert(
    revealed.prefixText === answerText.slice(0, expectation.start),
    `${label}: the reveal prefix does not end exactly at the anchor start offset`,
  );
  assert(
    revealed.suffixText === answerText.slice(expectation.end),
    `${label}: the reveal suffix does not resume exactly at the anchor end offset`,
  );
  assert(revealed.anchorFocus === true && revealed.tabindex === "-1", `${label}: the revealed turn lacks the anchor-focus contract`);
  assert(revealed.focused === true, `${label}: focus did not move to the revealed anchor turn`);
  await snap(`${label}-reveal`);

  /* 锚定支线可续聊：一条短 follow-up + 标记等待（echo 面答案 = 支线谱系
     用户文本的精确回声，必含标记；real-pi 依「Reply with exactly」指令）。 */
  await sendPanelPrompt(followUp.prompt, { keyboard: false });
  await waitForAnswerMarkers("#panel-conversation", [followUp.marker], CLI.promptTimeoutMs, 1);
  const panelSummary = await snap(`${label}-followup`);
  assert(
    panelSummary.panelConversation.turns.length === 2,
    `${label}: the anchored branch panel shows ${String(panelSummary.panelConversation.turns.length)} turns (expected 2: follow-up user + assistant)`,
  );
  await click("#panel-close");
  await waitForJs(
    "document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden",
    10_000,
    `${label} branch panel closed`,
  );
  return { answerText, expectation, probe, dragPoints };
}

/** 场景真实模型方差尝试的如实登记说明（detail 尾注）。 */
function deepAttemptNote(label) {
  const count = sc.deepSelection.attempts.filter((entry) => entry.scenario === label).length;
  return count === 0 ? "" : `; ${String(count)} earlier model-variance attempt(s) recorded honestly`;
}

/** 场景 1（长答案后段，ui-probe LONG_A2 的浏览器面）：数千字符多段答案的
 *  末段短语选区——精确 {start,end,text}，深度 ≥ 门槛（echo 面 >0.9 镜像
 *  ui-probe），anchor.text ≪ 答案长度（非整条回退）。相首落主剧本树基线
 *  （相末由 selection-deep-cross-line 核对不变）。 */
async function stepSelectionDeepLong() {
  const baseline = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
  assert(baseline.status === 200, `main tree state fetch failed: ${String(baseline.status)}`);
  const baselineTrunk = (baseline.body?.branches ?? []).find((view) => view.branch.id === baseline.body?.trunkBranchId);
  assert(baselineTrunk !== undefined, "main tree state has no trunk branch view");
  sc.deepSelection.mainBaseline = {
    branchIds: (baseline.body?.branches ?? []).map((view) => view.branch.id),
    trunkTurnCount: (baselineTrunk.turns ?? []).length,
  };
  const { answerText, expectation, dragPoints } = await runDeepSelectionScenario({
    label: "selection-deep-long",
    block: DEEP_BLOCKS.long,
    validate: deepLongExpectation,
    followUp: {
      prompt: "Follow-up on the deep-anchored branch. Reply with exactly: deep-long-branch-live.",
      marker: "deep-long-branch-live",
    },
    echoAssert: (echoAnswer) => {
      assert(echoAnswer.length > 5000, "the echo answer is not multi-thousand-character (ui-probe parity: >5000)");
      const start = echoAnswer.lastIndexOf(DEEP_LATE_PHRASE);
      assert(start > echoAnswer.length * 0.9, "the selection does not sit in the late tail of the echo answer (ui-probe parity: depth >0.9)");
    },
  });
  assert(
    expectation.end - expectation.start < answerText.length && expectation.start > 0,
    "the anchored excerpt covers the whole answer (the whole-answer fallback must not trigger)",
  );
  /* 长答案下的滚动实况（产品布局发现，如实随 detail 登记由 owner 裁决）：
     本产品该体量下滚动发生在文档层（#conversation 内部滚动容器不启用），
     阅读位置记忆/贴底跟随等以 #conversation 滚动为前提的语义随之失效。 */
  const scrollNote =
    dragPoints.scrolledBy === "document"
      ? "; layout note: at this answer length the page scrolls at the document level (#conversation's internal scroller stays inactive — reading-position memory and stick-to-bottom bind to it; product finding, owner to rule)"
      : "";
  return {
    detail:
      `late-tail selection on a ${String(answerText.length)}-char answer anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
      `(depth ${expectation.depth.toFixed(3)}, excerpt ${String(expectation.text.length)} chars ≪ answer — no whole-answer fallback): ` +
      "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable" +
      scrollNote +
      deepAttemptNote("selection-deep-long"),
  };
}

/** 场景 2（重复词第二处，ui-probe DUP_A2 的浏览器面）：同一词两次出现，
 *  选**第二处**——提交偏移即第二处位置（首处在 first，绝不许首处字符串
 *  匹配顶替）；揭示前缀恰切到第二处之前（首处顶替会使前缀短得多）。 */
async function stepSelectionDeepDuplicate() {
  const { expectation } = await runDeepSelectionScenario({
    label: "selection-deep-duplicate",
    block: DEEP_BLOCKS.duplicate,
    validate: deepDuplicateExpectation,
    followUp: {
      prompt: "Follow-up on the second-occurrence branch. Reply with exactly: deep-dup-branch-live.",
      marker: "deep-dup-branch-live",
    },
    echoAssert: (echoAnswer) => {
      const occurrences = echoAnswer.split(DEEP_DUP_WORD).length - 1;
      assert(
        occurrences === 2,
        `the echo answer carries ${String(occurrences)} occurrences of the duplicated word (expected exactly 2 at the two known positions)`,
      );
    },
  });
  assert(expectation.start !== expectation.first, "the anchor offset collapsed onto the FIRST occurrence (first-match substitution)");
  return {
    detail:
      `second occurrence of "${DEEP_DUP_WORD}" anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
      `(first occurrence at ${String(expectation.first)} — no first-match substitution): ` +
      "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable" +
      deepAttemptNote("selection-deep-duplicate"),
  };
}

/** 场景 3（跨行选区，ui-probe CROSS_A2 的浏览器面）：选区跨一个换行——
 *  偏移跨换行精确、文本含换行不截断、揭示切片含换行完整；并以真实渲染
 *  几何证明（原生选区多 client rect + 两端字符在不同渲染行）。相末核对
 *  主剧本树计数不变（探针树隔离的机械证明）。 */
async function stepSelectionDeepCrossLine() {
  const { expectation } = await runDeepSelectionScenario({
    label: "selection-deep-cross-line",
    block: DEEP_BLOCKS.crossLine,
    validate: deepCrossLineExpectation,
    followUp: {
      prompt: "Follow-up on the cross-line branch. Reply with exactly: deep-cross-branch-live.",
      marker: "deep-cross-branch-live",
    },
    selectionAssert: async (selector, scenarioAnswerText, scenarioExpectation) => {
      const geometry = await evalJs(deepSelectionGeometryExpression(selector, scenarioExpectation.start, scenarioExpectation.end));
      assert(geometry !== null, "selection geometry could not be read (cross-line proof)");
      assert(
        geometry.rectCount >= 2,
        `the native selection has ${String(geometry.rectCount)} client rect(s) — expected a multi-line (cross-line) selection`,
      );
      assert(
        geometry.fromTop !== null && geometry.toTop !== null && Math.abs(geometry.fromTop - geometry.toTop) > 5,
        `the drag endpoints sit on the same rendered line (fromTop ${String(geometry?.fromTop)} vs toTop ${String(geometry?.toTop)}) — not a real cross-line drag`,
      );
    },
  });
  assert(
    expectation.text.includes("\n") && (expectation.text.match(/\n/g) ?? []).length === 1,
    "the anchored cross-line excerpt does not carry exactly one intact line break",
  );
  /* 相末核对：主剧本树的分支集与干线回合数跨相不变 + 侧栏树数 = 主树 +
     本相探针树（每场景一棵）。 */
  const after = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
  assert(after.status === 200, `main tree state fetch failed after the deep-selection phase: ${String(after.status)}`);
  const baseline = sc.deepSelection.mainBaseline;
  assert(baseline !== null, "scenario wiring: the main-tree baseline snapshot is missing (see selection-deep-long)");
  const afterBranchIds = (after.body?.branches ?? []).map((view) => view.branch.id);
  assert(
    JSON.stringify(afterBranchIds) === JSON.stringify(baseline.branchIds),
    `main tree branch set drifted across the deep-selection phase: ${JSON.stringify(baseline.branchIds)} → ${JSON.stringify(afterBranchIds)}`,
  );
  const afterTrunk = (after.body?.branches ?? []).find((view) => view.branch.id === after.body?.trunkBranchId);
  assert(
    (afterTrunk.turns ?? []).length === baseline.trunkTurnCount,
    `main tree trunk turns drifted across the deep-selection phase: ${String(baseline.trunkTurnCount)} → ${String(afterTrunk?.turns?.length ?? -1)}`,
  );
  const sidebarTrees = await evalJs("document.getElementById('tree-list') === null ? null : document.getElementById('tree-list').children.length");
  assert(
    sidebarTrees === 1 + sc.deepSelection.probeTreeIds.length,
    `sidebar tree count is ${String(sidebarTrees)} (expected 1 main + ${String(sc.deepSelection.probeTreeIds.length)} deep-selection probe tree(s))`,
  );
  return {
    detail:
      `cross-line selection anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
      `(spans exactly 1 line break, excerpt keeps the newline intact; multi-rect native selection with endpoints on different rendered lines): ` +
      "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable; " +
      `main choreography tree unchanged across the phase (${String(baseline.branchIds.length)} branches / ${String(baseline.trunkTurnCount)} trunk turns before and after)` +
      deepAttemptNote("selection-deep-cross-line"),
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`${SCRIPT_NAME} v${VERSION} — mode ${MODE}`);
  const git = gitInfo();
  console.log(`  workspace HEAD: ${git.head === null ? "<unknown>" : git.head}${git.dirty ? " (dirty)" : ""}`);

  /* Chrome 缺失是环境限制（BLOCKED / 退出码 3），不是产品检查 FAIL。 */
  if (findChromeExecutable() === null) {
    const reason =
      "no Chromium/Chrome executable found — pass --chrome-executable PATH (candidates probed: " +
      CHROME_CANDIDATES.map((p) => `"${p}"`).join(", ") + ")";
    console.error(`BLOCKED: ${reason}`);
    sweepBlocked(reason);
    finish(3);
  }

  sc.dataDir = CLI.dataDir ?? mkdtempSync(join(tmpdir(), "treeai-d3-browser-data-"));
  sc.artifactsDir = CLI.artifactsDir ?? mkdtempSync(join(tmpdir(), "treeai-d3-browser-artifacts-"));
  mkdirSync(sc.artifactsDir, { recursive: true });
  console.log(`  data dir: ${sanitizeText(sc.dataDir)}${CLI.dataDir === null ? " (temp; pass --data/--keep-data to keep)" : ""}`);
  console.log(`  artifacts: ${sanitizeText(sc.artifactsDir)}`);

  /* A5 浏览器面工具策略场景的门控状态（CLI 已解析；selftest 恒不适用，
     各检查按模式门控 NOT_RUN）。 */
  const piToolsEnabled = MODE === "real-pi" && CLI.piToolsList !== null && CLI.piToolsList.length > 0;
  sc.toolPolicy = {
    applicable: piToolsEnabled && CLI.piToolsList !== null && CLI.piToolsList.includes("read"),
    readGateReason:
      "--pi-tools was not given or does not include 'read'; the browser tool-policy phase drives the request-time gate with a controlled read — rerun real-pi mode with --pi-tools read (optionally --policy-read-roots DIR,DIR) to activate this phase",
    readRoots: null,
    agentDir: null,
    markerPath: null,
    markerName: null,
    markerToken: null,
    markerFirstLine: null,
    canaryDir: null,
    canaryPath: null,
    canaryName: null,
    canaryToken: null,
    allowRunId: null,
    denyRunId: null,
    /* 全新探针树：工具面提示走干净 session（镜像 API 跑批器），不沾染
       主树回合——主树各检查计数恒为无工具基线。 */
    probeTreeId: null,
    probeTrunkId: null,
    /* tools 引导后的 sessions 目录快照（递归）：探针树是工具引导下唯一
       被 prompt 的树——此后新建的 session 文件必然属于探针树。 */
    sessionsBefore: null,
    /* 真实模型的合规性方差记录（逃逸轮如实登记；allow/deny 各最多 3 次
       尝试，逐次加硬指令）。 */
    attempts: [],
  };
  if (piToolsEnabled) {
    console.log(
      `  tool gate: --pi-tools ${CLI.piTools}` +
        (CLI.policyReadRoots !== null
          ? ` --policy-read-roots ${sanitizeText(CLI.policyReadRoots)}`
          : " (tools boot narrows read roots to <data>/workspace/policy-allowed)") +
        ` — browser tool-policy phase ${sc.toolPolicy.applicable ? "ACTIVE" : "NOT applicable (no 'read' tool)"}`,
    );
  }

  /* A2 深选区相状态（双模式）：主剧本树基线在 selection-deep-long 落点
     （相末由 selection-deep-cross-line 核对）；探针树与模型方差尝试登记。 */
  sc.deepSelection = {
    mainBaseline: null,
    probeTreeIds: [],
    attempts: [],
  };

  /* 模型错误注入相状态（仅 real-pi）：受控 agent 目录（横幅解析）、
     tmpdir 错配副本（cleanup 处置）、探针树与主树遏制基线。 */
  sc.modelError = {
    agentDir: null,
    misconfigDir: null,
    probeTreeId: null,
    probeTrunkId: null,
    failedRunId: null,
    errorCode: null,
    baseline: null,
  };

  /* ---- 引导 ---- */

  await runCheck("chrome-boot", async () => {
    await startChrome();
    chromeReady = true;
    const version = await chrome.cdp.send("Browser.getVersion");
    return { detail: `${sanitizeText(chrome.executable)} — Chromium ${String(version.product).replace(/^Headless/, "")} (CDP on 127.0.0.1:${String(chrome.port)})` };
  });

  studio.port = await freePort();
  await runCheck("studio-boot", async () => {
    await startStudio(sc.dataDir);
    booted = true;
    sc.studioUrl = `http://127.0.0.1:${String(studio.port)}/`;
    const health = await api("GET", "/api/health");
    assert(health.status === 200, `health status ${String(health.status)}`);
    return { detail: `studio on :${String(studio.port)} (driver ${MODE === "real-pi" ? "pi" : "echo"}), /api/health ok` };
  });

  await runCheck("page-boot", async () => {
    await navigate(sc.studioUrl);
    assert((await evalJs("document.title")) === "TreeAI Studio", "document.title mismatch");
    await waitForJs("document.getElementById('tree-list') !== null", 5_000, "sidebar tree list");
    const summary = await snap("page-boot");
    /* 注意：#driver-note 是静态空元素（无脚本写入）；驱动标识以 studio
       启动横幅（服务端 stdout）为准，页面断言只覆盖渲染事实本身。 */
    assert(summary.main.emptyStateVisible === true, "empty state not visible with zero trees");
    assert(summary.sidebar.treeCount === 0, `tree list count ${String(summary.sidebar.treeCount)} (expected 0)`);
    assert(summary.activeElementId === "new-tree", `initial focus is #${String(summary.activeElementId)} (expected new-tree)`);
    return { detail: "rendered; empty state visible; zero trees; initial focus on 新建 (new-tree)" };
  });

  /* ---- A1 主线与两条支线 ---- */

  let treeCreated = null;
  await runCheck("tree-create", async () => {
    await click("#new-tree");
    await waitForJs("document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden", 10_000, "tree view visible");
    const summary = await snap("tree-create");
    assert(summary.sidebar.treeCount === 1, `tree list count ${String(summary.sidebar.treeCount)} (expected 1)`);
    const stateRes = await api("GET", "/api/trees");
    assert(stateRes.status === 200 && Array.isArray(stateRes.body?.trees) && stateRes.body.trees.length === 1,
      `GET /api/trees disagrees: ${String(stateRes.status)}`);
    treeCreated = stateRes.body.trees[0];
    sc.treeId = treeCreated.id;
    return { detail: `tree created via real click; trunk view open; branch tabs: ${summary.branchTabs.map((t) => t.text).join(" / ")}` };
  });

  await runCheck("trunk-main-line", async () => {
    await sendTrunkPrompt(SCENARIO.t1, { keyboard: false });
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["maple"] : ["apples", "maple"], CLI.promptTimeoutMs, 1);
    await sendTrunkPrompt(SCENARIO.t2, { keyboard: true });
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["4127"] : ["4127"], CLI.promptTimeoutMs, 2);
    const summary = await snap("trunk-main-line");
    sc.trunkTurnCount = 4; /* 断言前登记：后续检查不因本检查失败而失去基线 */
    const turns = summary.conversation.turns;
    assert(turns.length === 4, `trunk conversation has ${String(turns.length)} turns (expected 4: 2 user + 2 assistant)`);
    assert(turns.filter((t) => t.role === "user").length === 2 && turns.filter((t) => t.role === "assistant").length === 2,
      `trunk turn roles wrong: ${JSON.stringify(turns.map((t) => t.role))}`);
    assert(turns[0].text === SCENARIO.t1, "first user turn text mismatch");
    const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
    assert(stateRes.status === 200, `state fetch ${String(stateRes.status)}`);
    const serverTurns = stateRes.body?.branches?.[0]?.turns?.length ?? -1;
    assert(serverTurns === 4, `server trunk view has ${String(serverTurns)} turns (expected 4)`);
    sc.trunkTurnCount = 4; /* 断言前登记：后续检查不因本检查失败而失去基线 */
    return { detail: `two trunk prompts (t2 via ⌘+Enter keyboard path); 4 turns rendered; API state agrees (4 turns server-side)` };
  });

  const firstAnswerSelector = await runCheck("selection-anchoring", async () => {
    const selector = await assistantTurnSelector("#conversation", 0);
    await dragSelect(selector, SELECT_A.from, SELECT_A.to);
    const state = await evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      "const button = el === null ? null : el.querySelector('.branch-here'); " +
      "return { hasSelection: el === null ? false : el.classList.contains('has-selection'), " +
      "buttonText: button === null ? null : button.textContent, " +
      "selectionText: String(window.getSelection()) }; })()",
    );
    assert(state.hasSelection === true, "assistant turn did not enter .has-selection state after real drag selection");
    assert(state.buttonText === "⑃ Branch from selection", `branch button text is ${String(state.buttonText)}`);
    assert(state.selectionText.length > 0, "native selection is empty after drag");
    sc.branchAAnswerExcerpt = state.selectionText;
    await snap("selection-anchoring");
    return { selector, detail: `real mouse drag produced a native selection (「${truncate(state.selectionText, 40)}」); affordance switched to Branch from selection` };
  });
  const firstAnswer = firstAnswerSelector?.selector ?? "#conversation .turn.assistant";

  await runCheck("branch-a-create", async () => {
    await click(`${firstAnswer} .branch-here`);
    await waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch panel open");
    const summary = await snap("branch-a-create");
    assert(summary.panel.title === "Branch 1", `panel title is ${String(summary.panel.title)} (expected "Branch 1")`);
    const anchorCtx = summary.panel.anchorContext ?? "";
    assert(anchorCtx.includes(truncate(sc.branchAAnswerExcerpt, 20)) || anchorCtx.includes(sc.branchAAnswerExcerpt.slice(0, 12)),
      `anchor context does not carry the selected excerpt: ${truncate(anchorCtx, 120)}`);
    assert(summary.branchTabs.some((t) => t.text.includes("Branch 1")), `branch tab missing: ${JSON.stringify(summary.branchTabs)}`);
    return { detail: `branch A created from the real selection; panel open with anchor excerpt; title "${String(summary.panel.title)}"` };
  });

  await runCheck("branch-a-followups", async () => {
    await sendPanelPrompt(SCENARIO.a1, { keyboard: false });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["cedar"] : ["ok-a1"], CLI.promptTimeoutMs, 1);
    await sendPanelPrompt(SCENARIO.a2, { keyboard: true });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["cedar", "maple"] : ["cedar", "maple"], CLI.promptTimeoutMs, 2);
    const summary = await snap("branch-a-followups");
    const turns = summary.panelConversation.turns;
    assert(turns.length === 4, `branch A panel shows ${String(turns.length)} turns (expected 4: 2 rounds of user+assistant)`);
    return { detail: `branch A two follow-up rounds (a2 via Ctrl+Enter); ${String(turns.length)} turns rendered in panel` };
  });

  await runCheck("switch-navigation", async () => {
    /* 面板 → 主线（panel-close），主线回合不受支线影响。 */
    await click("#panel-close");
    await waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "branch panel closed");
    let summary = await evalJs(pageSummaryExpression());
    assert(summary.conversation.turns.length === sc.trunkTurnCount,
      `trunk conversation changed after branch work: ${String(summary.conversation.turns.length)} turns (expected ${String(sc.trunkTurnCount)})`);
    /* 主线 → 支线 A（branch tab），支线内容完整且与主线不串。 */
    const tabSelector = await evalJs(
      `(() => { const buttons = [...document.querySelectorAll('#branch-tabs button')]; ` +
      "const tab = buttons.find((b) => b.textContent.includes('Branch 1')); " +
      "return tab === undefined ? null : '#branch-tabs button:nth-of-type(' + String(buttons.indexOf(tab) + 1) + ')'; })()",
    );
    assert(tabSelector !== null, "Branch 1 tab not found");
    await click(tabSelector);
    await waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch panel reopened");
    summary = await evalJs(pageSummaryExpression());
    assert(summary.panelConversation.turns.length === 4, `branch A panel lost turns after switch: ${String(summary.panelConversation.turns.length)}`);
    assert(!summary.conversation.turns.some((t) => (t.text ?? "").includes("avocados")), "trunk conversation leaked branch A content");
    await snap("switch-navigation");
    return { detail: "panel→trunk→panel navigation via real clicks; trunk untouched by branch turns; branch A content intact" };
  });

  await runCheck("branch-b-create", async () => {
    await click("#panel-close");
    await waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "panel closed before branch B");
    /* 第二个锚点：主干第 2 轮答案的不同子区间（.turn.assistant 序号 1）。 */
    const secondAnswer = await assistantTurnSelector("#conversation", 1);
    await dragSelect(secondAnswer, SELECT_B.from, SELECT_B.to);
    const state = await evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(secondAnswer)}); ` +
      "const button = el === null ? null : el.querySelector('.branch-here'); " +
      "return { hasSelection: el === null ? false : el.classList.contains('has-selection'), buttonText: button === null ? null : button.textContent, selectionText: String(window.getSelection()) }; })()",
    );
    assert(state.hasSelection === true, "second answer did not enter has-selection after drag");
    assert(state.selectionText !== sc.branchAAnswerExcerpt, "branch B selection is identical to branch A selection (expected a different anchor)");
    await click(`${secondAnswer} .branch-here`);
    await waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch B panel open");
    const summary = await snap("branch-b-create");
    assert(summary.panel.title === "Branch 2", `panel title is ${String(summary.panel.title)} (expected "Branch 2")`);
    return { detail: `branch B from a different anchor on the second trunk answer (「${truncate(state.selectionText, 30)}」)` };
  });

  await runCheck("branch-b-followups", async () => {
    await sendPanelPrompt(SCENARIO.b1, { keyboard: false });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["birch"] : ["ok-b1"], CLI.promptTimeoutMs, 1);
    await sendPanelPrompt(SCENARIO.b2, { keyboard: false });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["birch"] : ["birch"], CLI.promptTimeoutMs, 2);
    const summary = await snap("branch-b-followups");
    assert(summary.panelConversation.turns.length === 4, `branch B panel shows ${String(summary.panelConversation.turns.length)} turns (expected 4)`);
    return { detail: "branch B two follow-up rounds; 6 turns rendered in panel" };
  });

  await runCheck("no-context-bleed", async () => {
    /* 支线 B 面板：echo 语义下可见 = 主干可见文本 + 本支线文本。
       B 只应见到 birch（自身）与主干词（maple/4127），绝不见 cedar。 */
    const bText = (await evalJs("document.getElementById('panel-conversation').textContent")).trim();
    assert(bText.includes("birch"), "branch B panel does not show its own codeword birch");
    assert(!bText.includes("cedar"), "branch B panel leaked branch A codeword cedar");
    /* 真实模型的「列举可见词」措辞有方差（b2 可能只回 "birch"——模型行为，
       非串扰证据）：正向可见性断言改为 session entry 树的 parentId 路径
       （= 续聊点可见的完整上下文，机械证明）；echo 模式回声语义本身确定，
       维持面板断言不变。 */
    if (MODE === "selftest") {
      assert(bText.includes("maple"), "branch B panel lost trunk-visible codeword maple");
    } else {
      const bPath = sessionEntryPathText(findTreeSessionFile("Branch B, turn two"), "Branch B, turn two");
      assert(bPath.includes("birch"), "branch B session path lost its own codeword birch");
      assert(bPath.includes("maple"), "branch B session path lost trunk-visible codeword maple");
      assert(bPath.includes("4127"), "branch B session path lost trunk-visible secret number 4127");
      assert(!bPath.includes("cedar"), "branch B session path leaked branch A codeword cedar");
    }
    /* 切回支线 A：A 只见 cedar + 主干词，绝不见 birch。 */
    const tabSelector = await evalJs(
      `(() => { const buttons = [...document.querySelectorAll('#branch-tabs button')]; ` +
        "const tab = buttons.find((b) => b.textContent.includes('Branch 1')); " +
        "return tab === undefined ? null : '#branch-tabs button:nth-of-type(' + String(buttons.indexOf(tab) + 1) + ')'; })()",
    );
    await click(tabSelector);
    /* 面板可见 ≠ 面板已切换（上一支线面板本就开着）——以标题证实真的
       切到了 Branch 1；否则下方文本断言会误读上一支线的内容。 */
    await waitForJs(
      "(() => { const p = document.getElementById('branch-panel'); const t = document.getElementById('panel-title'); " +
        "return p !== null && !p.hidden && t !== null && t.textContent.includes('Branch 1'); })()",
      10_000,
      "branch A panel actually switched (panel title shows Branch 1)",
    );
    const aText = (await evalJs("document.getElementById('panel-conversation').textContent")).trim();
    assert(aText.includes("cedar"), "branch A panel does not show its own codeword cedar");
    assert(!aText.includes("birch"), "branch A panel leaked branch B codeword birch");
    if (MODE === "selftest") {
      assert(aText.includes("maple"), "branch A panel lost trunk-visible codeword maple");
    } else {
      /* A 的锚点在主干第 1 轮答案上：路径含 t1 史（maple）+ cedar，
         绝不含锚点后的主干第 2 轮（4127）与支线 B（birch）。 */
      const aPath = sessionEntryPathText(findTreeSessionFile("Branch A, turn two"), "Branch A, turn two");
      assert(aPath.includes("cedar"), "branch A session path lost its own codeword cedar");
      assert(aPath.includes("maple"), "branch A session path lost trunk-visible codeword maple");
      assert(!aPath.includes("4127"), "branch A session path leaked post-anchor trunk secret number 4127");
      assert(!aPath.includes("birch"), "branch A session path leaked branch B codeword birch");
    }
    await snap("no-context-bleed");
    return {
      detail:
        MODE === "selftest"
          ? "rendered branch panels carry no cross-branch codewords (cedar/birch probe on both sides)"
          : "rendered panels carry no cross-branch codewords; per-branch visibility proven on the session entry path (parentId chain to the root) for both branches",
    };
  });

  /* ---- A3 Return 语义 ---- */

  await runCheck("return-flow", async () => {
    /* 支线 A 面板仍开着：填写 Return 草稿并显式提交。
       注意 #return-input 按产品语义预填上一答案（W1 §2.1 草稿）——
       全选覆盖后再注入（真实用户的编辑路径）。 */
    /* 源支线显式断言：A3 场景的 Return 必须发自支线 A——面板若停在其他
       支线（切换被吞等），Return 的锚点/来源会静默漂移而下游断言照常
       通过（20260929T162759Z 复盘）。 */
    const returnSourceTitle = await evalJs(
      "document.getElementById('panel-title') === null ? null : document.getElementById('panel-title').textContent",
    );
    assert(
      typeof returnSourceTitle === "string" && returnSourceTitle.includes("Branch 1"),
      `the A3 return must be submitted from branch A, but the open panel shows ${JSON.stringify(returnSourceTitle)}`,
    );
    await typeInto("#return-input", SCENARIO.returnText, { replace: true });
    await click("#submit-return");
    /* 提交后面板收起、主干出现 anchored Return 卡（待送达）。 */
    await waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "panel closed after return submit");
    await waitForJs("document.querySelectorAll('#conversation .turn.return').length > 0", 10_000, "return card rendered on trunk");
    const summary = await snap("return-flow");
    const card = summary.returnCards[summary.returnCards.length - 1];
    assert(card !== undefined, "no return card on trunk after submit");
    assert(card.text.includes("aspen"), `return card does not carry the return text: ${truncate(card.text, 120)}`);
    assert(card.delivered === false, "return card is already delivered before the next trunk run");
    assert((card.deliveryText ?? "").includes("confirmed"), `pending delivery badge text unexpected: ${String(card.deliveryText)}`);
    /* 来源抽屉：Returns 区显示 not yet delivered。 */
    await click("#source-drawer-toggle");
    await waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "sources drawer open");
    const drawerText = await evalJs("document.getElementById('source-drawer').textContent");
    assert(drawerText.includes("not yet delivered"), `drawer return entry missing pending state: ${truncate(drawerText, 200)}`);
    await snap("return-flow-drawer");
    /* 抽屉头部的可见关闭按钮（issue #6 附-4 的鼠标关闭路径）：覆盖层开着
       时真实点击 #drawer-close——click 助手的 elementFromPoint 防护证明
       按钮在覆盖层打开时确实可点（此前鼠标无关闭入口，Esc 是唯一路径；
       Esc 的逐层键盘语义覆盖保在 a11y-semantics / narrow-window-layout）。 */
    await click("#drawer-close");
    await waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 5_000, "drawer closed via #drawer-close after reading");
    const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
    const returnTurns = (stateRes.body?.branches ?? []).flatMap((view) => (view.turns ?? []).filter((t) => t.role === "return"));
    assert(returnTurns.length === 1, `${String(returnTurns.length)} return turns server-side (expected 1)`);
    assert(returnTurns[0].deliveredRunId === null, "server already marks the return delivered before the next trunk run");
    sc.returnIdempotencyKey = returnTurns[0].idempotencyKey;
    return { detail: `return submitted from branch A panel (draft prefilled → select-all overwrite); anchored card on trunk in confirmed/pending state; drawer shows "not yet delivered"; server agrees (1 return, deliveredRunId null)` };
  });

  await runCheck("return-delivery", async () => {
    /* 主干第 3 轮：下一次 Trunk prompt 必须采用已送达的 Return。 */
    await sendTrunkPrompt(SCENARIO.t3, { keyboard: false });
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["aspen"] : ["aspen"], CLI.promptTimeoutMs, 3);
    const cardState = await evalJs(
      `(() => { const cards = [...document.querySelectorAll('#conversation .turn.return')]; ` +
      "const card = cards[cards.length - 1]; const delivery = card === undefined ? null : card.querySelector('.delivery'); " +
      "return { text: card === undefined ? null : card.textContent, delivered: delivery === null ? false : delivery.classList.contains('delivered'), deliveryText: delivery === null ? null : delivery.textContent }; })()",
    );
    assert(cardState.delivered === true, `return card not in delivered state after next trunk run: ${truncate(JSON.stringify(cardState), 200)}`);
    const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
    const returnTurns = (stateRes.body?.branches ?? []).flatMap((view) => (view.turns ?? []).filter((t) => t.role === "return"));
    const delivered = returnTurns.find((t) => t.deliveredRunId !== null);
    assert(delivered !== undefined, "server shows no delivered return after the next trunk run");
    const runs = (await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/diagnostics`)).body?.runs ?? [];
    const latestTrunkRun = runs.filter((r) => r.state === "succeeded").at(-1);
    assert(latestTrunkRun !== undefined, "no succeeded run found for delivery cross-check");
    assert(delivered.deliveredRunId === latestTrunkRun.runId,
      `deliveredRunId ${String(delivered.deliveredRunId)} does not match the next trunk run ${String(latestTrunkRun.runId)}`);
    sc.trunkTurnCount += 2;
    await snap("return-delivery");
    return { detail: `return adopted by the next trunk run; card badge → delivered; deliveredRunId === the t3 run (server-verified)` };
  });

  /* 模型错误检查的双时序（镜像 run-d3-real-pi.mjs main()）：selftest 在
     此处经 /fail 钩子注入主树（原位置、原断言面——断言自 v1.0.0 逐字节
     不变，v1.3.0 仅提取为 stepModelErrorEcho）；real-pi 改为错误配置
     registry 的重启舞步，为不扰动其后重启/缺失 session/响应丢失/无障碍/
     窄窗/A2 深选区各检查的主树基线计数，挪到 A2 相之后、工具相引导之前
     执行（独立探针树——见 stepModelErrorRealPi）。 */
  if (MODE === "selftest") {
    await runCheck("model-error-convergence", stepModelErrorEcho);
  }

  /* ---- A4 恢复与故障 ---- */

  await runCheck("server-restart-recovery", async () => {
    /* 在途无 run 时 SIGKILL：下一动作前杀进程 = 「响应丢失（杀进程）」
       故障类的页面侧呈现；随后同数据目录重启 + 整页刷新对账。 */
    try {
      chrome.expectPageErrors = true;
      killStudio();
      await sleep(400);
      /* 页面在服务已死后发 prompt：必须呈现错误横幅而非静默丢弃。 */
      await typeInto("#prompt-input", "This prompt is sent while the server is down.", { replace: true });
      await click("#send");
      const banner = await waitForJs(
        "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0 ? b.textContent : false; })()",
        30_000,
        "error banner after server-down prompt",
      );
      /* 同数据目录重启（server 进程重启；数据全在磁盘）。 */
      await startStudio(sc.dataDir);
      await navigate(sc.studioUrl);
      const summary = await snap("server-restart");
      assert(summary.conversation.turns.length >= sc.trunkTurnCount,
        `trunk turns lost across restart+reload: ${String(summary.conversation.turns.length)} (expected >= ${String(sc.trunkTurnCount)})`);
      const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
      const branchCount = (stateRes.body?.branches ?? []).length;
      assert(branchCount === 3, `branch count after restart is ${String(branchCount)} (expected 3: trunk + A + B)`);
      /* 重启后主线续聊可用。 */
      await sendTrunkPrompt("After the restart, the main line continues. Reply with: restart-ok.", { keyboard: false });
      await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["restart-ok"] : ["restart-ok"], CLI.promptTimeoutMs, MODE === "selftest" ? 5 : 4);
    } finally {
      chrome.expectPageErrors = false;
    }
    await snap("server-restart-recovered");
    return { detail: `server SIGKILL → page showed an honest error banner on the next prompt; same-data restart + reload kept the trunk turns and all 3 branches; continuation works` };
  });

  await runCheck("missing-session-degradation", async () => {
    /* 移走 session 文件（本机受控数据目录内；echo session 为 *.jsonl）→
       整页刷新 → 降级呈现。 */
    const sessionsDir = join(sc.dataDir, "sessions");
    assert(existsSync(sessionsDir), `no sessions dir under data dir`);
    const files = readdirSync(sessionsDir).filter((f) => !f.startsWith("."));
    assert(files.length > 0, "no session files to move");
    const moved = [];
    for (const file of files) {
      renameSync(join(sessionsDir, file), join(sessionsDir, `${file}.moved`));
      moved.push(file);
    }
    await navigate(sc.studioUrl);
    const summary = await snap("missing-session");
    const bannerVisible = !summary.main.sessionBanner.hidden && (summary.main.sessionBanner.text ?? "").length > 0;
    assert(bannerVisible, `session banner not visible after session loss: ${JSON.stringify(summary.main.sessionBanner)}`);
    /* fail-closed：composer 禁用（或提示后禁用），恢复动作如实呈现。 */
    const composerState = await evalJs(
      `(() => { const input = document.getElementById('prompt-input'); ` +
      "const recovery = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Branch from latest available answer')); " +
      "return { disabled: input === null ? null : input.disabled, " +
      "recoveryPresent: recovery !== undefined && recovery !== null, recoveryDisabled: recovery === undefined || recovery === null ? null : recovery.disabled, " +
      "bannerText: document.getElementById('session-banner') === null ? '' : document.getElementById('session-banner').textContent }; })()",
    );
    assert(composerState.disabled === true, `trunk composer not disabled after session loss (disabled=${String(composerState.disabled)})`);
    assert(composerState.recoveryPresent === true, "recovery affordance (Branch from latest available answer) not presented");
    /* 还原 session 文件 → 刷新即恢复。 */
    for (const file of moved) {
      renameSync(join(sessionsDir, `${file}.moved`), join(sessionsDir, file));
    }
    await navigate(sc.studioUrl);
    const recovered = await evalJs(
      "(() => { const input = document.getElementById('prompt-input'); const b = document.getElementById('session-banner'); " +
      "return { disabled: input === null ? null : input.disabled, bannerHidden: b === null ? true : b.hidden }; })()",
    );
    assert(recovered.disabled === false && recovered.bannerHidden === true,
      `page did not recover after session restore: ${JSON.stringify(recovered)}`);
    await snap("missing-session-recovered");
    return { detail: `session file(s) moved away → banner + fail-closed composer + recovery affordance; restored → full recovery on reload (${String(moved.length)} file(s))` };
  });

  await runCheck("response-loss-midstream", async () => {
    /* real-pi 专属：真实模型时延窗口内整页刷新（响应丢失），
       刷新后页面以权威状态对账，绝不停留在流式占位中间态。 */
    await typeInto("#prompt-input", "Please write a short paragraph (about 80 words) about tides. Then reply with: done-tides.", { replace: true });
    await click("#send");
    await sleep(700); /* 流式进行中 */
    await navigate(sc.studioUrl);
    const settled = await waitForJs(
      "(() => { const placeholder = document.getElementById('streaming-turn'); " +
      "const status = document.getElementById('run-status'); " +
      "return placeholder === null && status !== null && !status.textContent.includes('streaming'); })()",
      CLI.promptTimeoutMs,
      "page settles after mid-stream reload (no stuck placeholder)",
    );
    const summary = await snap("response-loss-midstream");
    const hasAnswer = summary.conversation.turns.some((t) => t.role === "assistant" && (t.text ?? "").length > 0);
    const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
    const runs = (await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/diagnostics`)).body?.runs ?? [];
    assert(stateRes.status === 200, "state fetch failed after midstream reload");
    return { detail: `mid-stream reload reconciled to authoritative state (placeholder cleared, status ${String((await evalJs("document.getElementById('run-status').textContent")))}); last run state ${String(runs.at(-1)?.state ?? "?")}; answer present: ${String(hasAnswer)}` };
  });

  /* ---- A7 无障碍语义与真实计算样式 ---- */

  await runCheck("a11y-semantics", async () => {
    /* 错误横幅：role=alert + tabindex=0（W2 §2.4）。 */
    const bannerAttrs = await evalJs(
      "(() => { const b = document.getElementById('error-banner'); return { role: b.getAttribute('role'), tabIndex: b.tabIndex }; })()",
    );
    assert(bannerAttrs.role === "alert", `error banner role is ${String(bannerAttrs.role)}`);
    assert(bannerAttrs.tabIndex === 0, `error banner tabIndex is ${String(bannerAttrs.tabIndex)} (expected 0, Tab-reachable)`);
    /* 抽屉 Esc 关闭（W2 键盘焦点行）。 */
    await click("#source-drawer-toggle");
    await waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "drawer open");
    const drawerExpanded = await evalJs("document.getElementById('source-drawer-toggle').getAttribute('aria-expanded')");
    assert(drawerExpanded === "true", `drawer toggle aria-expanded is ${String(drawerExpanded)} while open`);
    await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "drawer closed via Esc");
    /* Esc 关闭后焦点还原给触发元素（W2 键盘焦点行）。 */
    const focusAfterEsc = await evalJs("document.activeElement === null ? null : document.activeElement.id");
    assert(focusAfterEsc === "source-drawer-toggle", `focus after drawer Esc is #${String(focusAfterEsc)} (expected source-drawer-toggle)`);
    /* aria-expanded 由下次渲染对齐 state.drawerOpen——等待翻转而非立即读。 */
    await waitForJs("document.getElementById('source-drawer-toggle').getAttribute('aria-expanded') === 'false'", 3_000, "drawer aria-expanded false after Esc");
    /* 侧栏开合的 aria-expanded（窄窗抽屉语义在 narrow-window-layout 检查）。 */
    const panelAnchor = await evalJs("(() => { const el = document.getElementById('panel-anchor-context'); return el === null ? null : el.getAttribute('tabindex'); })()");
    assert(panelAnchor === "-1", `panel anchor context tabindex is ${String(panelAnchor)} (expected -1, programmatically focusable)`);
    await snap("a11y-semantics");
    return { detail: "error banner role=alert + Tab-reachable; drawer aria-expanded both ways + Esc closes; panel anchor context programmatically focusable" };
  });

  await runCheck("narrow-window-layout", async () => {
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: NARROW_VIEWPORT.width,
      height: NARROW_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(200);
    const toggleVisible = await evalJs(
      "(() => { const el = document.getElementById('sidebar-toggle'); const cs = getComputedStyle(el); " +
        "const mql = window.matchMedia('(max-width: 719px)'); " +
        "const detail = getComputedStyle(document.getElementById('run-detail')); " +
        "return { display: cs.display, narrow: mql.matches, runDetailDisplay: detail.display }; })()",
    );
    assert(toggleVisible.narrow === true, "viewport 480px did not match the narrow media query (max-width 719px)");
    assert(toggleVisible.display !== "none", `sidebar toggle hidden in narrow viewport (display ${String(toggleVisible.display)})`);
    assert(toggleVisible.runDetailDisplay === "none", `#run-detail not hidden in narrow viewport (display ${String(toggleVisible.runDetailDisplay)})`);
    /* 侧栏开合（aria 语义 + body class）。 */
    await click("#sidebar-toggle");
    const openState = await evalJs(
      "(() => { return { expanded: document.getElementById('sidebar-toggle').getAttribute('aria-expanded'), open: document.body.classList.contains('sidebar-open') }; })()",
    );
    assert(openState.expanded === "true" && openState.open === true, `sidebar did not open in narrow viewport: ${JSON.stringify(openState)}`);
    await click("#sidebar-toggle");
    /* 窄窗来源抽屉：自底部上滑（drawer-up-* 关键帧，进入窗口 ~240ms 内
       可捕获 animationName）；结构证据 = 抽屉占满窄窗全宽。 */
    await click("#source-drawer-toggle");
    const narrowDrawer = await waitForJs(
      "(() => { const el = document.getElementById('source-drawer'); if (el === null || el.hidden) return false; " +
        "const cs = getComputedStyle(el); if (cs.animationName !== 'none' && cs.animationName !== '') return { animationName: cs.animationName, width: cs.width }; " +
        "return cs.width !== '' && Number.parseFloat(cs.width) >= 470 ? { animationName: 'none', width: cs.width } : false; })()",
      3_000,
      "narrow drawer settles (bottom-up animation or full-width structural form)",
    );
    await waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "narrow drawer open");
    const narrowWidth = Number.parseFloat(narrowDrawer.width);
    assert(narrowWidth >= NARROW_VIEWPORT.width - 10, `narrow drawer not full-width: ${String(narrowDrawer.width)}`);
    assert(narrowDrawer.animationName === "none" || /drawer-up/i.test(String(narrowDrawer.animationName)),
      `narrow drawer animation is not the bottom-up form: ${JSON.stringify(narrowDrawer)}`);
    await snap("narrow-window");
    /* 窄窗抽屉（fixed 全幅）仍保有 Esc 关闭路径的覆盖（W2 逐层键盘语义；
       鼠标关闭路径 #drawer-close 的浏览器面覆盖在 return-flow）。 */
    await pressKey("Escape", "Escape", 27);
    await waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "narrow drawer closed via Esc");
    /* 还原宽窗：右侧滑入（panel-in / translateX），宽度远小于全宽。 */
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(200);
    await click("#source-drawer-toggle");
    await waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "wide drawer open");
    const wideDrawer = await evalJs(
      "(() => { const el = document.getElementById('source-drawer'); const cs = getComputedStyle(el); " +
        "return { animationName: cs.animationName, width: cs.width, left: cs.left, right: cs.right }; })()",
    );
    await pressKey("Escape", "Escape", 27);
    await waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "wide drawer closed via Esc");
    const wideWidth = Number.parseFloat(wideDrawer.width);
    assert(wideWidth < VIEWPORT.width * 0.6, `wide drawer unexpectedly near-full-width: ${JSON.stringify(wideDrawer)}`);
    assert(!/drawer-up/i.test(String(wideDrawer.animationName)), `wide drawer uses the bottom-up form: ${JSON.stringify(wideDrawer)}`);
    return { detail: `480px viewport: toggle visible, #run-detail hidden, sidebar open/close aria ok; drawer full-width ${String(narrowDrawer.width)}${narrowDrawer.animationName === "none" ? "" : ` (${String(narrowDrawer.animationName)})`} in narrow vs right-side ${String(wideDrawer.width)} in wide` };
  });

  await runCheck("reduced-motion", async () => {
    await chrome.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await sleep(150);
    const motion = await evalJs(
      `(() => {
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
        /* 全局规则：* { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important }。 */
        const probe = document.querySelector('.turn.assistant .delivery') ?? document.querySelector('.turn.return .delivery') ?? document.querySelector('.turn.assistant') ?? document.body;
        const cs = getComputedStyle(probe);
        return { reduced: mql.matches, animationDuration: cs.animationDuration, transitionDuration: cs.transitionDuration, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior };
      })()`,
    );
    assert(motion.reduced === true, "setEmulatedMedia did not flip prefers-reduced-motion");
    /* Chromium 将 0.01ms 序列化为 "0.00001s"——按毫秒数值比较。 */
    const durationMs = (value) => {
      const parsed = Number.parseFloat(String(value));
      return String(value).endsWith("ms") ? parsed : parsed * 1000;
    };
    assert(durationMs(motion.animationDuration) <= 0.02, `computed animation-duration under reduce is ${String(motion.animationDuration)} (expected ≤0.02ms)`);
    assert(durationMs(motion.transitionDuration) <= 0.02, `computed transition-duration under reduce is ${String(motion.transitionDuration)} (expected ≤0.02ms)`);
    await snap("reduced-motion");
    await chrome.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });
    await sleep(150);
    const normal = await evalJs(
      `(() => { const probe = document.querySelector('.turn.assistant .delivery') ?? document.querySelector('.turn.return .delivery') ?? document.querySelector('.turn.assistant') ?? document.body; return { reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches, animationDuration: getComputedStyle(probe).animationDuration }; })()`,
    );
    assert(normal.reduced === false, "prefers-reduced-motion did not reset");
    return { detail: `prefers-reduced-motion honored in the real browser (computed animation/transition-duration collapse to 0.01ms; reset back to ${String(normal.animationDuration)})` };
  });

  /* ---- A2 深选区相（issue #6 P1 / W2 §4；双模式）：置于主剧本全部检查
     之后（主树计数已终态、基线可钉）、工具相引导之前（real-pi 下本相
     全程零工具引导——深选区无需工具，工具方差不沾染；工具相随后的
     SIGKILL+工具缝重启不受影响——其探针树按 knownIds 差分自取）。每
     场景一棵全新探针树，主剧本树不受影响（相末核对）。 ---- */

  await runCheck("selection-deep-long", stepSelectionDeepLong);
  await runCheck("selection-deep-duplicate", stepSelectionDeepDuplicate);
  await runCheck("selection-deep-cross-line", stepSelectionDeepCrossLine);

  /* ---- 模型错误注入相（仅 real-pi，独立探针树；selftest 的 /fail 路径
     已在上方原位置执行）：错配 registry 引导 → 探针树失败收敛（浏览器面
     断言 + HTTP 交叉核对）→ 原 registry 引导恢复（failed → succeeded）。
     相末遏制核对主树不变；随后工具相照常 SIGKILL + 工具缝重启（其探针
     树按 knownIds 差分自取，不受影响）。 ---- */

  if (MODE === "real-pi") {
    await runCheck("model-error-convergence", stepModelErrorRealPi);
  }

  /* ---- A5 工具面场景（issue #6 P0-3 浏览器后半；仅 real-pi 且 --pi-tools
     含 read，两段式：以上检查全部在零工具引导上完成——工具相在此先
     SIGKILL 当前 studio，再以工具缝重启同一数据目录运行） ---- */

  await runCheck("tool-policy-boot", stepToolPolicyBoot);
  await runCheck("tool-policy-allow-read", stepToolPolicyAllowRead);
  await runCheck("tool-policy-deny-fail-closed", stepToolPolicyDenyFailClosed);
  await runCheck("tool-policy-deny-provenance", stepToolPolicyDenyProvenance);
  await runCheck("tool-policy-canary-never-read", stepToolPolicyCanaryNeverRead);

  await runCheck("console-clean", async () => {
    const unexpected = chrome.pageErrors; /* expectPageErrors 窗口内的已在采集处跳过 */
    await writeSummaryArtifact();
    assert(unexpected.length === 0, `page errors observed: ${JSON.stringify(unexpected.slice(0, 5))}`);
    return { detail: "zero unexpected page console/Log errors across the whole run" };
  });

  return 0;
}

/** 汇总 artifacts：全检查结果 + 页面终态摘要 + 网络事实（脱敏写盘）。 */
async function writeSummaryArtifact() {
  const summary = await evalJs(pageSummaryExpression()).catch(() => null);
  const payload = {
    script: SCRIPT_NAME,
    version: VERSION,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    checks: results.map((r) => ({ id: r.id, status: r.status })),
    pageFinalState: summary === null ? null : sanitizeSummary(summary),
    pageErrors: chrome.pageErrors,
    netLog: chrome.netLog.filter((e) => !e.url.includes("favicon")),
  };
  writeFileSync(join(sc.artifactsDir, "summary.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

async function cleanup() {
  killStudio();
  stopChrome();
  const keep = CLI.keepData || CLI.dataDir !== null;
  if (keep && sc.dataDir !== null) {
    console.log(`  data dir kept: ${sanitizeText(sc.dataDir)}`);
  } else if (sc.dataDir !== null) {
    try { rmSync(sc.dataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
  /* 工具面场景的 canary/marker 纪律（镜像 run-d3-real-pi.mjs）：canary
     位于数据目录 workspace 内（随数据目录处置）——布局若把它放到数据
     目录之外才需单独删除；marker 位于首个读取根，显式根属操作者目录
     ——非保留路径下移除本脚本创建的标记文件。 */
  const tp = sc.toolPolicy;
  if (tp !== null && sc.dataDir !== null) {
    const dataPhysical = physicalPath(sc.dataDir) ?? sc.dataDir;
    if (tp.canaryPath !== null && !isPathWithin(physicalPath(tp.canaryPath) ?? tp.canaryPath, dataPhysical)) {
      try { rmSync(tp.canaryPath, { force: true }); } catch { /* 尽力而为 */ }
    }
    if (tp.markerPath !== null && !keep && !isPathWithin(physicalPath(tp.markerPath) ?? tp.markerPath, dataPhysical)) {
      try { rmSync(tp.markerPath, { force: true }); } catch { /* 尽力而为 */ }
    }
  }
  /* 模型错误相的错配 registry 副本（系统临时目录，数据目录/仓库之外）：
     绿色且非保留时删除；保留（--keep-data/--data）或有 FAIL（取证）时
     打印脱敏路径留档（镜像 run-d3-real-pi.mjs 的处置纪律）。 */
  const me = sc.modelError;
  if (me !== null && me.misconfigDir !== null) {
    if (keep || results.some((r) => r.status === "FAIL")) {
      console.log(`  misconfigured agent-dir copy kept: ${sanitizeText(me.misconfigDir)}`);
    } else {
      try { rmSync(me.misconfigDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  }
  if (sc.artifactsDir !== null) {
    console.log(`  artifacts kept: ${sanitizeText(sc.artifactsDir)}`);
  }
}

function finish(code) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const entry of results) counts[entry.status] += 1;
  console.log(
    `\n${SCRIPT_NAME}: ${String(counts.PASS)} PASS / ${String(counts.FAIL)} FAIL / ${String(counts.BLOCKED)} BLOCKED / ${String(counts.NOT_RUN)} NOT_RUN (mode ${MODE})`,
  );
  process.exit(code);
}

process.on("exit", () => {
  /* 同步兜底：任何退出路径都不留孤儿进程/临时目录（--keep 项除外）。 */
  if (studio.child !== null && !studio.exited) studio.child.kill("SIGKILL");
  if (chrome.child !== null && chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
});

/* ------------------------------------------------------------------ */

try {
  const code = await main();
  await cleanup();
  finish(code === 0 && results.some((r) => r.status === "FAIL") ? 2 : code);
} catch (err) {
  /* 任何失败路径同样走清理（镜像 API 跑批器的 finally 纪律：不留孤儿
     进程/临时目录，canary/marker 的操作者目录残留同样处置）。 */
  await cleanup().catch(() => { /* 尽力而为 */ });
  const message = sanitizeText(err instanceof Error ? err.message : String(err));
  if (message.startsWith("BLOCKED:")) {
    console.error(message);
    sweepBlocked(message.replace(/^BLOCKED:\s*/, ""));
    finish(3);
  } else {
    console.error(`${SCRIPT_NAME} self-failure: ${message}`);
    process.exit(1);
  }
}
