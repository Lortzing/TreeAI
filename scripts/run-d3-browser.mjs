#!/usr/bin/env node
import { createBrowserReporting } from "./d3/browser-reporting.mjs";
import { createBrowserResults } from "./d3/browser-results.mjs";
import { createBrowserProbes } from "./d3/browser-probes.mjs";
import { createBrowserFixtures } from "./d3/browser-fixtures.mjs";
import { createBrowserSessionProbes } from "./d3/browser-session-probes.mjs";
import { createBrowserProjections } from "./d3/browser-projections.mjs";
import { createBrowserCli } from "./d3/browser-cli.mjs";
import { createBrowserAccessibility } from "./d3/browser-accessibility.mjs";
import { createBrowserRecovery } from "./d3/browser-recovery.mjs";
import { createBrowserConversation } from "./d3/browser-conversation.mjs";
import { createBrowserHost } from "./d3/browser-host.mjs";
import { createBrowserInput } from "./d3/browser-input.mjs";
import { createBrowserChrome } from "./d3/browser-chrome.mjs";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "run-d3-browser";
const VERSION = "1.3.2";
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
const browserFixtures = createBrowserFixtures({
  get MODES() { return MODES; },
});
const { CHECK_DEFS, SCENARIO, DEEP_ASKS, DEEP_MIN_ANSWER_CHARS, DEEP_BLOCKS, deepLongExpectation, DEEP_LATE_PHRASE, deepDuplicateExpectation, DEEP_DUP_WORD, deepCrossLineExpectation, SELECT_A, SELECT_B } = browserFixtures;

const browserCli = createBrowserCli({
  get DEFAULT_PROMPT_SETTLE_MS() { return DEFAULT_PROMPT_SETTLE_MS; },
  get USAGE() { return USAGE; },
  get MODES() { return MODES; },
  get PI_API_KEY_ENV() { return PI_API_KEY_ENV; },
});
const { parseCli } = browserCli;

const CLI = parseCli(process.argv.slice(2));
if (CLI.help) { console.log(USAGE); process.exit(0); }
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
const browserSessionProbes = createBrowserSessionProbes({
  get sc() { return sc; },
  get assert() { return assert; },
});
const { physicalPath, isPathWithin, walkFiles, sessionEntryPathText, findTreeSessionFile } = browserSessionProbes;

const browserChrome = createBrowserChrome({
  get CLI() { return CLI; },
  get CHROME_CANDIDATES() { return CHROME_CANDIDATES; },
  get CDP_SEND_TIMEOUT_MS() { return CDP_SEND_TIMEOUT_MS; },
  get chrome() { return chrome; },
  get sleep() { return sleep; },
  get VIEWPORT() { return VIEWPORT; },
  get sanitizeText() { return sanitizeText; },
});
const { findChromeExecutable, startChrome, stopChrome } = browserChrome;

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
const browserInput = createBrowserInput({
  get CDP_SEND_TIMEOUT_MS() { return CDP_SEND_TIMEOUT_MS; },
  get chrome() { return chrome; },
  get truncate() { return truncate; },
  get sleep() { return sleep; },
  get assert() { return assert; },
  get sc() { return sc; },
});
const { evalJs, screenshot, waitForJs, typeInto, pressModifierEnter, click, navigate, dragSelect, pressKey } = browserInput;
const browserProjections = createBrowserProjections({
  get evalJs() { return evalJs; },
  get sc() { return sc; },
  get chrome() { return chrome; },
  get screenshot() { return screenshot; },
  get sanitizeText() { return sanitizeText; },
  get waitForJs() { return waitForJs; },
  get api() { return api; },
  get typeInto() { return typeInto; },
  get pressModifierEnter() { return pressModifierEnter; },
  get click() { return click; },
  get assert() { return assert; },
  get sleep() { return sleep; },
});
const { resetErrorSurfaces, probeAssistantTurnCount, sendTrunkPrompt, waitForProbeOutcome, failureErrorCode, tpPath, snap, probeTurnCounts, pageSummaryExpression, waitForAnswerMarkers, sendPanelPrompt, sanitizeSummary, assistantTurnSelector } = browserProjections;

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
const browserHost = createBrowserHost({
  get STUDIO_ENTRY() { return STUDIO_ENTRY; },
  get studio() { return studio; },
  get MODE() { return MODE; },
  get CLI() { return CLI; },
  get sc() { return sc; },
  get ROOT() { return ROOT; },
  get appendArtifact() { return appendArtifact; },
  get BOOT_TIMEOUT_MS() { return BOOT_TIMEOUT_MS; },
  get truncate() { return truncate; },
  get sanitizeText() { return sanitizeText; },
  get sleep() { return sleep; },
  get GET_TIMEOUT_MS() { return GET_TIMEOUT_MS; },
});
const { api, killStudioAndWait, startStudio, killStudio } = browserHost;

/* ------------------------------------------------------------------ */
/* 检查登记（沿用 run-d3-real-pi.mjs 的词汇与语义）                      */
/* ------------------------------------------------------------------ */

const results = [];
const byId = new Map(CHECK_DEFS.map((def) => [def.id, def]));
const browserResults = createBrowserResults({
  get results() { return results; },
  get truncate() { return truncate; },
  get byId() { return byId; },
  get MODE() { return MODE; },
  get chromeReady() { return chromeReady; },
  get booted() { return booted; },
  get sc() { return sc; },
  get sanitizeText() { return sanitizeText; },
  get CHECK_DEFS() { return CHECK_DEFS; },
});
const { sweepBlocked, runCheck } = browserResults;

let booted = false;
let chromeReady = false;

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
const browserProbes = createBrowserProbes({
  get assert() { return assert; },
  get CLI() { return CLI; },
  get chrome() { return chrome; },
  get killStudioAndWait() { return killStudioAndWait; },
  get startStudio() { return startStudio; },
  get sc() { return sc; },
  get navigate() { return navigate; },
  get studio() { return studio; },
  get sleep() { return sleep; },
  get physicalPath() { return physicalPath; },
  get isPathWithin() { return isPathWithin; },
  get api() { return api; },
  get click() { return click; },
  get waitForJs() { return waitForJs; },
  get walkFiles() { return walkFiles; },
  get resetErrorSurfaces() { return resetErrorSurfaces; },
  get probeAssistantTurnCount() { return probeAssistantTurnCount; },
  get sendTrunkPrompt() { return sendTrunkPrompt; },
  get waitForProbeOutcome() { return waitForProbeOutcome; },
  get failureErrorCode() { return failureErrorCode; },
  get truncate() { return truncate; },
  get sanitizeText() { return sanitizeText; },
  get tpPath() { return tpPath; },
  get evalJs() { return evalJs; },
  get snap() { return snap; },
  get probeTurnCounts() { return probeTurnCounts; },
  get pageSummaryExpression() { return pageSummaryExpression; },
  get SCENARIO() { return SCENARIO; },
  get waitForAnswerMarkers() { return waitForAnswerMarkers; },
  get MODE() { return MODE; },
  get MISCONFIG_BASE_URL() { return MISCONFIG_BASE_URL; },
  get DEEP_ASKS() { return DEEP_ASKS; },
  get DEEP_MIN_ANSWER_CHARS() { return DEEP_MIN_ANSWER_CHARS; },
  get dragSelect() { return dragSelect; },
  get sendPanelPrompt() { return sendPanelPrompt; },
  get DEEP_BLOCKS() { return DEEP_BLOCKS; },
  get deepLongExpectation() { return deepLongExpectation; },
  get DEEP_LATE_PHRASE() { return DEEP_LATE_PHRASE; },
  get deepDuplicateExpectation() { return deepDuplicateExpectation; },
  get DEEP_DUP_WORD() { return DEEP_DUP_WORD; },
  get deepCrossLineExpectation() { return deepCrossLineExpectation; },
});
const { stepSelectionDeepLong, stepSelectionDeepDuplicate, stepSelectionDeepCrossLine, stepModelErrorRealPi, stepToolPolicyBoot, stepToolPolicyAllowRead, stepToolPolicyDenyFailClosed, stepToolPolicyDenyProvenance, stepToolPolicyCanaryNeverRead, stepModelErrorEcho } = browserProbes;

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
  await phaseConversation();

  await phaseReturn();

  await phaseRecovery();

  await phaseAccessibility();

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

  /* v1.3.2：summary 写盘移出本检查体（检查体保持纯断言），改在 main()
     全部检查登记后的统一收尾执行（见文件尾 try/catch 块）——修复写盘
     时点早于本行登记、summary.json 的 checks 数组恒比 stdout 少 1 行的
     既知 off-by-one。 */
  await runCheck("console-clean", async () => {
    const unexpected = chrome.pageErrors; /* expectPageErrors 窗口内的已在采集处跳过 */
    assert(unexpected.length === 0, `page errors observed: ${JSON.stringify(unexpected.slice(0, 5))}`);
    return { detail: "zero unexpected page console/Log errors across the whole run" };
  });

  return 0;
}

/** 汇总 artifacts：全检查结果 + 页面终态摘要 + 网络事实（脱敏写盘）。
 *  v1.3.2：调用点从 console-clean 检查体内移至 main() 之后的统一收尾
 *  （成功路径在全部检查登记后写盘；失败路径同样尽力写盘，写盘自身的
 *  失败绝不掩盖原始错误）——修复写盘时点早于最后一项检查登记、checks
 *  数组恒少 1 行（console-clean）的 off-by-one；例外：chrome 缺失的
 *  BLOCKED 早退发生在 artifacts 目录创建之前，本就无落盘位置（stdout
 *  全量 BLOCKED 报告为准）。 */






const { writeSummaryArtifact, cleanup, finish } = createBrowserReporting({
  get evalJs() { return evalJs; },
  get pageSummaryExpression() { return pageSummaryExpression; },
  get SCRIPT_NAME() { return SCRIPT_NAME; },
  get VERSION() { return VERSION; },
  get MODE() { return MODE; },
  get gitInfo() { return gitInfo; },
  get results() { return results; },
  get sanitizeSummary() { return sanitizeSummary; },
  get chrome() { return chrome; },
  get sc() { return sc; },
  get killStudio() { return killStudio; },
  get stopChrome() { return stopChrome; },
  get CLI() { return CLI; },
  get sanitizeText() { return sanitizeText; },
  get physicalPath() { return physicalPath; },
  get isPathWithin() { return isPathWithin; },
});

process.on("exit", () => {
  /* 同步兜底：任何退出路径都不留孤儿进程/临时目录（--keep 项除外）。 */
  if (studio.child !== null && !studio.exited) studio.child.kill("SIGKILL");
  if (chrome.child !== null && chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
});

/* ------------------------------------------------------------------ */

const browserConversation = createBrowserConversation({
  get runCheck() { return runCheck; },
  get click() { return click; },
  get waitForJs() { return waitForJs; },
  get snap() { return snap; },
  get assert() { return assert; },
  get api() { return api; },
  get sc() { return sc; },
  get sendTrunkPrompt() { return sendTrunkPrompt; },
  get SCENARIO() { return SCENARIO; },
  get waitForAnswerMarkers() { return waitForAnswerMarkers; },
  get MODE() { return MODE; },
  get CLI() { return CLI; },
  get assistantTurnSelector() { return assistantTurnSelector; },
  get dragSelect() { return dragSelect; },
  get SELECT_A() { return SELECT_A; },
  get evalJs() { return evalJs; },
  get truncate() { return truncate; },
  get sendPanelPrompt() { return sendPanelPrompt; },
  get pageSummaryExpression() { return pageSummaryExpression; },
  get SELECT_B() { return SELECT_B; },
  get sessionEntryPathText() { return sessionEntryPathText; },
  get findTreeSessionFile() { return findTreeSessionFile; },
  get typeInto() { return typeInto; },
  get stepModelErrorEcho() { return stepModelErrorEcho; },
});
const { phaseConversation, phaseReturn } = browserConversation;
const browserRecovery = createBrowserRecovery({
  get runCheck() { return runCheck; },
  get chrome() { return chrome; },
  get killStudio() { return killStudio; },
  get sleep() { return sleep; },
  get typeInto() { return typeInto; },
  get click() { return click; },
  get waitForJs() { return waitForJs; },
  get startStudio() { return startStudio; },
  get sc() { return sc; },
  get navigate() { return navigate; },
  get snap() { return snap; },
  get assert() { return assert; },
  get api() { return api; },
  get sendTrunkPrompt() { return sendTrunkPrompt; },
  get waitForAnswerMarkers() { return waitForAnswerMarkers; },
  get MODE() { return MODE; },
  get CLI() { return CLI; },
  get evalJs() { return evalJs; },
});
const { phaseRecovery } = browserRecovery;
const browserAccessibility = createBrowserAccessibility({
  get runCheck() { return runCheck; },
  get evalJs() { return evalJs; },
  get assert() { return assert; },
  get click() { return click; },
  get waitForJs() { return waitForJs; },
  get chrome() { return chrome; },
  get snap() { return snap; },
  get NARROW_VIEWPORT() { return NARROW_VIEWPORT; },
  get sleep() { return sleep; },
  get pressKey() { return pressKey; },
  get VIEWPORT() { return VIEWPORT; },
});
const { phaseAccessibility } = browserAccessibility;

try {
  const code = await main();
  /* v1.3.2：summary 在全部检查登记后、cleanup 之前写盘——checks 数组
     与 stdout 全量一致（含 console-clean 行）；页面终态摘要在 chrome
     存活时采集。检查 FAIL 不抛出 main（runCheck 就地登记），故本写盘
     覆盖「有 FAIL 的完整跑」；写盘自身失败按跑批器自身失败如实上报。 */
  await writeSummaryArtifact();
  await cleanup();
  finish(code === 0 && results.some((r) => r.status === "FAIL") ? 2 : code);
} catch (err) {
  /* 任何失败路径同样走清理（镜像 API 跑批器的 finally 纪律：不留孤儿
     进程/临时目录，canary/marker 的操作者目录残留同样处置）。
     v1.3.2：失败路径在清理前同样尽力写盘 summary（已登记的检查行如实
     入盘；写盘自身的失败被吞掉，绝不掩盖原始错误——artifacts 目录
     尚未建立或 chrome 已死时自然跳过）。 */
  const message = sanitizeText(err instanceof Error ? err.message : String(err));
  const writeSummaryBestEffort = () => writeSummaryArtifact().catch(() => { /* 尽力而为 */ });
  if (message.startsWith("BLOCKED:")) {
    console.error(message);
    sweepBlocked(message.replace(/^BLOCKED:\s*/, ""));
    await writeSummaryBestEffort();
    await cleanup().catch(() => { /* 尽力而为 */ });
    finish(3);
  } else {
    await writeSummaryBestEffort();
    await cleanup().catch(() => { /* 尽力而为 */ });
    console.error(`${SCRIPT_NAME} self-failure: ${message}`);
    process.exit(1);
  }
}
