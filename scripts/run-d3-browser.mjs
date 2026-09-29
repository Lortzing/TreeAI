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
 *     studio 子进程自行读取）；--provider/--model 必填。echo 专属检查
 *     （/fail 注入、精确回声断言）如实 NOT_RUN；另含仅在真实模型时延
 *     窗口下可做的「响应丢失（在途整页刷新）」检查。
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
 */

import { spawn, execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "run-d3-browser";
const VERSION = "1.0.0";
const STUDIO_ENTRY = join(ROOT, "apps", "studio", "src", "index.ts");
/** 真实 Pi 驱动的 API key 环境变量（日志中只允许出现该名字）。 */
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const MODES = ["selftest", "real-pi"];
const BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_SETTLE_MS = 30_000;
const GET_TIMEOUT_MS = 15_000;
const CDP_SEND_TIMEOUT_MS = 30_000;
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
].join("\n");

/* ------------------------------------------------------------------ */
/* 剧本（与 run-d3-real-pi.mjs 同一 codeword 场景；canary 词为跨支线    */
/* 上下文串扰探针；echo 答案 = 可见用户文本的精确回声，串扰机械可见）    */
/* ------------------------------------------------------------------ */

const SCENARIO = {
  t1: "This is the main line, turn one. The trunk topic is apples. Remember the trunk codeword: maple. Reply with: understood.",
  t2: "Main line, turn two. The trunk secret number is 4127. Reply with: noted.",
  t3: "Main line, turn three. Did any branch return a delivery marker to you? Quote it exactly if so, otherwise reply: none.",
  a1: "We are now on branch A, about avocados. Remember branch A's codeword: cedar. Reply with: ok-a1.",
  a2: "Branch A, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  b1: "We are now on branch B, about batteries. Remember branch B's codeword: birch. Reply with: ok-b1.",
  b2: "Branch B, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  returnText:
    "Branch A return note: the agreed delivery marker is aspen. Acknowledge the marker when asked on the main line.",
  fail: "/fail this prompt must converge as a simulated upstream model error",
  recovery: "After the earlier failure, the main line continues. Reply with: back-online.",
};
const CANARIES = ["maple", "4127", "cedar", "birch", "aspen"];
/** 支线拖选的字符子区间（答案内、避开句首句尾标点的稳定窗口）。 */
const SELECT_A = { from: 24, to: 52 };
const SELECT_B = { from: 30, to: 61 };

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
  {
    id: "model-error-convergence",
    modes: ["selftest"],
    notRun: {
      "real-pi":
        "no safe deterministic model-error injection against a real provider (the echo /fail hook is selftest-only); the owner injects it once by misconfiguration per evidence/d3/real-pi/README.md (fault class: model error)",
    },
  },
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
  { id: "console-clean", modes: MODES },
];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

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
  for (const dir of [sc.dataDir, sc.artifactsDir, chrome?.profileDir].filter((d) => typeof d === "string")) {
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
  await chrome.cdp.send("Input.insertText", { text });
  await sleep(80);
  const value = await evalJs(`document.activeElement === null ? null : document.activeElement.value`);
  assert(value === text, `typed text mismatch (got ${truncate(String(value), 80)})`);
}

/**
 * 真实拖选：在元素的正文文本节点上按字符偏移 [from,to) 建立原生选区
 * （mousePressed → mouseMoved 序列 → mouseReleased），浏览器原生完成
 * Selection；元素自身的 mouseup 处理器随后读取 window.getSelection()
 * 计算 {start,end,text} 偏移（W1 §1.1 绝对偏移路径）。
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
      const locate = (target) => {
        let acc = 0;
        for (const node of walker) {
          const len = node.textContent.length;
          if (target <= acc + len) {
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, Math.max(0, Math.min(target - acc, len)));
            return range.getBoundingClientRect();
          }
          acc += len;
        }
        const last = walker[walker.length - 1];
        const range = document.createRange();
        range.selectNodeContents(last);
        return range.getBoundingClientRect();
      };
      const fromRect = locate(clamp(${String(from)}));
      const toRect = locate(clamp(${String(to)}));
      const anchor = el.getBoundingClientRect();
      return {
        from: { x: fromRect.left + Math.min(2, fromRect.width / 2), y: fromRect.top + fromRect.height / 2 },
        to: { x: toRect.right - Math.min(2, toRect.width / 2), y: toRect.top + toRect.height / 2 },
        total, anchorTop: anchor.top,
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

const studio = { child: null, port: 0, exited: false };

function studioArgv(dataDir) {
  const argv = [
    STUDIO_ENTRY,
    "--port",
    String(studio.port),
    "--data",
    dataDir,
  ];
  if (MODE === "real-pi") {
    argv.push("--driver", "pi", "--provider", CLI.provider, "--model", CLI.model);
    if (CLI.agentDir !== null) argv.push("--agent-dir", CLI.agentDir);
  }
  return argv;
}

async function startStudio(dataDir) {
  studio.exited = false;
  /* 子进程输出落盘到 artifacts（服务端事实留档，亦防管道写满阻塞）。 */
  writeFileSync(join(sc.artifactsDir, "studio.log"), "");
  studio.child = spawn(process.execPath, studioArgv(dataDir), {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  studio.child.stdout.on("data", (chunk) => { appendArtifact("studio.log", chunk); });
  studio.child.stderr.on("data", (chunk) => { appendArtifact("studio.log", chunk); });
  studio.child.on("exit", () => { studio.exited = true; });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (studio.exited) throw new Error("studio exited during boot (see artifacts studio.log)");
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
};

/** 页面侧等待：某分支视图的最后一轮 assistant 答案包含标记词集合。
 * 超时诊断附带当前页面事实（末轮答案/输入框残留/run 状态）。 */
async function waitForAnswerMarkers(containerSelector, needles, timeoutMs) {
  const expr =
    `(() => { const turns = [...document.querySelectorAll(${JSON.stringify(containerSelector)} + ' .turn.assistant')]; ` +
    "if (turns.length === 0) return false; const text = turns[turns.length - 1].dataset.turnText ?? turns[turns.length - 1].textContent; " +
    `return ${JSON.stringify(needles)}.every((n) => text.includes(n)) ? text : false; })()`;
  try {
    return await waitForJs(expr, timeoutMs, `assistant answer containing ${needles.join(",")}`);
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
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["maple"] : ["understood"], CLI.promptTimeoutMs);
    await sendTrunkPrompt(SCENARIO.t2, { keyboard: true });
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["4127"] : ["noted"], CLI.promptTimeoutMs);
    const summary = await snap("trunk-main-line");
    const turns = summary.conversation.turns;
    assert(turns.length === 4, `trunk conversation has ${String(turns.length)} turns (expected 4: 2 user + 2 assistant)`);
    assert(turns.filter((t) => t.role === "user").length === 2 && turns.filter((t) => t.role === "assistant").length === 2,
      `trunk turn roles wrong: ${JSON.stringify(turns.map((t) => t.role))}`);
    assert(turns[0].text === SCENARIO.t1, "first user turn text mismatch");
    const stateRes = await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/state`);
    assert(stateRes.status === 200, `state fetch ${String(stateRes.status)}`);
    const serverTurns = stateRes.body?.branches?.[0]?.turns?.length ?? -1;
    assert(serverTurns === 4, `server trunk view has ${String(serverTurns)} turns (expected 4)`);
    sc.trunkTurnCount = 4;
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
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["cedar"] : ["ok-a1"], CLI.promptTimeoutMs);
    await sendPanelPrompt(SCENARIO.a2, { keyboard: true });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["cedar", "maple"] : ["cedar", "maple"], CLI.promptTimeoutMs);
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
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["birch"] : ["ok-b1"], CLI.promptTimeoutMs);
    await sendPanelPrompt(SCENARIO.b2, { keyboard: false });
    await waitForAnswerMarkers("#panel-conversation", MODE === "selftest" ? ["birch"] : ["birch"], CLI.promptTimeoutMs);
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
    assert(bText.includes("maple"), "branch B panel lost trunk-visible codeword maple");
    /* 切回支线 A：A 只见 cedar + 主干词，绝不见 birch。 */
    const tabSelector = await evalJs(
      `(() => { const buttons = [...document.querySelectorAll('#branch-tabs button')]; ` +
      "const tab = buttons.find((b) => b.textContent.includes('Branch 1')); " +
      "return tab === undefined ? null : '#branch-tabs button:nth-of-type(' + String(buttons.indexOf(tab) + 1) + ')'; })()",
    );
    await click(tabSelector);
    await waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch A panel reopened");
    const aText = (await evalJs("document.getElementById('panel-conversation').textContent")).trim();
    assert(aText.includes("cedar"), "branch A panel does not show its own codeword cedar");
    assert(!aText.includes("birch"), "branch A panel leaked branch B codeword birch");
    assert(aText.includes("maple"), "branch A panel lost trunk-visible codeword maple");
    await snap("no-context-bleed");
    return { detail: "rendered branch panels carry no cross-branch codewords (cedar/birch probe on both sides)" };
  });

  /* ---- A3 Return 语义 ---- */

  await runCheck("return-flow", async () => {
    /* 支线 A 面板仍开着：填写 Return 草稿并显式提交。
       注意 #return-input 按产品语义预填上一答案（W1 §2.1 草稿）——
       全选覆盖后再注入（真实用户的编辑路径）。 */
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
    /* 覆盖层是 fixed 右侧整幅——盖住主线 composer 的 Send 按钮**与
       Sources 开关本身**（开关位于 branch-bar 最右）——真实用户的关闭
       路径是 Esc（W2 逐层键盘语义；鼠标无关闭入口本身是本波发现的
       W2 相关偏差，记入证据记录）。 */
    await pressKey("Escape", "Escape", 27);
    await waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 5_000, "drawer closed via Esc after reading");
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
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["aspen"] : ["aspen"], CLI.promptTimeoutMs);
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

  await runCheck("model-error-convergence", async () => {
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
    assert(composerEnabled === true, "trunk composer stayed disabled after the failed run converged");
    await sendTrunkPrompt(SCENARIO.recovery, { keyboard: false });
    await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["back-online"] : ["back-online"], CLI.promptTimeoutMs);
    const runs = (await api("GET", `/api/trees/${encodeURIComponent(sc.treeId)}/diagnostics`)).body?.runs ?? [];
    const failedRun = runs.find((r) => r.state === "failed");
    assert(failedRun !== undefined, "no failed run recorded server-side after /fail");
    assert((failedRun.failure?.code ?? "") === "upstream", `failed run code is ${String(failedRun.failure?.code)}`);
    sc.trunkTurnCount += 2; /* /fail 零回合落库；恢复 prompt 落 1 对回合 */
    await snap("model-error-recovered");
    return { detail: `/fail converged as a failed run (banner role=alert text upstream, persistent failure panel, composer re-enabled); follow-up prompt succeeded; server shows the failed run (upstream)` };
  });

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
      await waitForAnswerMarkers("#conversation", MODE === "selftest" ? ["restart-ok"] : ["restart-ok"], CLI.promptTimeoutMs);
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
    /* 抽屉打开时开关被自身覆盖（fixed 全幅）——Esc 是唯一关闭路径。 */
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
  if (CLI.keepData || CLI.dataDir !== null) {
    console.log(`  data dir kept: ${sanitizeText(sc.dataDir)}`);
  } else if (sc.dataDir !== null) {
    try { rmSync(sc.dataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
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
