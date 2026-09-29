#!/usr/bin/env node
/**
 * run-d3-real-pi — D3 Studio 真实 Pi 场景跑批器（scripts/，零 npm 依赖）。
 *
 * 目的：把 issue #2 Go 条件中「真实 Pi Studio 操作」里可脚本化的核心场景，
 * 按固定剧本跑在**真实产品进程**上（spawn apps/studio/src/index.ts：真实
 * CLI 边界 + HTTP API + TreeAI DB + journal），逐项登记 PASS / FAIL /
 * BLOCKED / NOT_RUN。覆盖：
 *   - A1 主线两轮 + 两条**不同锚点**支线、各 ≥2 轮追问、无上下文串扰；
 *   - A2 锚点操作（origin/selection 落库、reveal source、switch 导航）；
 *   - A3 Return：显式提交、幂等（同键同内容 200 重放 / 同键异容 409
 *     return-conflict）、下一次主干 prompt 送达（deliveredReturns=1）；
 *   - A5 诊断面与 journal 保守投影（安全键集合 + 剧本 canary 词不外泄）；
 *   - A5 产品面 ToolPolicy（issue #6 P0-3 工程后半；仅 real-pi 且
 *     --pi-tools 含 read 时运行，否则按模式/门控 NOT_RUN）：经真实产品
 *     进程驱动请求时策略门——**两段式**：主剧本（含 SSE/诊断/journal/
 *     重启/中止检查）全程零工具引导；A5 阶段先 SIGKILL 当前 studio，再
 *     以工具缝引导重启同一数据目录，在**独立探针树**（全新 session，
 *     镜像 SDK 级驱动的已证条件）上运行——主树计数因此恒为无工具基线，
 *     不受工具面方差影响：
 *       · allow 对照：读取根内标记文件 → 工具真实执行（SSE
 *         tool-activity started/finished + journal tool.execution 行），
 *         标记内容进入回答与会话文件；
 *       · overreach 核心：canary 位于模型工作目录（workspace）之内、
 *         所有读取根之外（真实模型会拒读「工作目录之外」的路径——读取根
 *         缺省收窄到 workspace/policy-allowed）→ 执行前拦截，run 以
 *         policy-denied fail-closed 收敛
 *         （502、无回合落库），拒绝 provenance 经 SSE tool-activity
 *         (denied)（键集锁定：tool/outcome/reason/ruleId，无路径/参数）、
 *         journal tool.decision 行与诊断面 policyDecisions(observed)
 *         呈现；真实模型的工具调用合规性有方差，最多 3 次尝试逐次加硬
 *         指令，逃逸轮（模型未发起读取即作答）如实登记——PASS 仅要求
 *         其中一次收敛 policy-denied；canary 内容绝不进入任何会话文件
 *         （受控 agent 目录 + 数据目录全树扫描；镜像 SDK 级驱动
 *         scripts/run-d3-real-pi-tool-policy.mjs 的 canary 纪律）；
 *   - SSE 事件面（snapshot / run-started / message-delta / run-terminal）；
 *   - A4 宿主重启（SIGKILL 后同数据目录重启：树/分支/回合/cursor 完整、
 *     续聊可用）；
 *   - 模型错误收敛（echo 模式经 /fail 确定性注入；real-pi 模式 NOT_RUN）；
 *   - 在途中止（real-pi 模式真实模型时延窗口；echo 模式 NOT_RUN）。
 *
 * 两种模式（同一剧本、同一断言面）：
 *   --mode echo-selftest（默认）离线确定性 echo 驱动：零凭据、零网络、
 *     完全确定（echo 答案 = 当前分支可见用户文本的精确回声，本身就是
 *     分支上下文隔离的机械证明）。用于跑批器自检与确定性回归。
 *   --mode real-pi      真实 Pi 驱动（负责人/授权操作者运行）：
 *     API key 仅经 TREEAI_STUDIO_API_KEY 环境注入——本脚本只检查变量
 *     **名**是否存在，值从不进入本进程内存（由 studio 子进程自行读取）；
 *     --provider/--model 必填；受控 agent 目录默认 <data>/pi-agent
 *     （studio CLI 自建，绝不回落 ~/.pi）。运行前需按
 *         evidence/d3/real-pi/20260929T063342Z-deepseek-studio.md 的做法，
 *     在受控 agent 目录放入非秘密的 provider/model registry。
 *     可选工具缝（原样转发给 studio CLI，issue #6 P0-3）：
 *     --pi-tools TOOL,TOOL（Pi 工具 allowlist，如 "read"）与
 *     --policy-read-roots DIR,DIR（读取根；须与 --pi-tools 同给）。
 *     echo 模式给出 --pi-tools 即用法错误（echo 驱动无工具执行器）；
 *     读取根的绝对/存在/非空等校验由 studio CLI 边界负责，本脚本不
 *     重复（但绝不明文吞掉未知旗标）。
 *
 * 证据纪律（evidence/d3/README.md）：
 *   - 本脚本**不写 evidence/**：结果只登 stdout 事实；真实 Pi 运行的记录
 *     由负责人按 evidence/d3/templates/run-record.md 手工追加到
 *     evidence/d3/real-pi/（echo 结果永远不能冒充真实 Pi 证据——rule 5）。
 *   - 秘密纪律：API key 值绝不读取、绝不打印；子进程输出回显前做字面值
 *     剥离（belt and braces）；输出只允许出现环境变量名。
 *
 * 退出码（沿用 D2 冻结纪律，coordination/d2/README.md）：
 *   0 — 当前模式适用的全部检查 PASS（模式门控的 NOT_RUN 属预期并列出）
 *   1 — 用法错误 / 跑批器自身失败（studio 无法启动按检查 FAIL 计，见下）
 *   2 — 至少一项适用检查 FAIL（含 studio-boot 失败；其后检查如实 NOT_RUN）
 *   3 — 无 FAIL 但存在 BLOCKED（如 real-pi 模式缺少 TREEAI_STUDIO_API_KEY）
 *
 * 用法：
 *   node scripts/run-d3-real-pi.mjs --mode echo-selftest
 *   TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi \
 *     --provider deepseek --model deepseek-flash [--agent-dir DIR] \
 *     [--data DIR] [--keep-data] [--prompt-timeout-ms 120000] \
 *     [--pi-tools read] [--policy-read-roots DIR,DIR]
 *     （--pi-tools 含 read 时激活 A5 产品面 ToolPolicy 场景）
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "run-d3-real-pi";
const VERSION = "1.1.0";
const STUDIO_ENTRY = join(ROOT, "apps", "studio", "src", "index.ts");
/** 真实 Pi 驱动的 API key 环境变量（日志中只允许出现该名字）。 */
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const MODES = ["echo-selftest", "real-pi"];
const BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const GET_TIMEOUT_MS = 15_000;
const USAGE = [
  `usage: node scripts/run-d3-real-pi.mjs [--mode ${MODES.join("|")}]`,
  "       real-pi mode additionally requires:",
  `         --provider ID --model ID  (and the ${PI_API_KEY_ENV} env var)`,
  "       optional: [--agent-dir DIR] [--data DIR] [--keep-data] [--prompt-timeout-ms N]",
  "       real-pi tool gate (forwarded verbatim to the studio CLI; the A5 product",
  "       tool-policy phase runs only when the tool list includes 'read'):",
  "         [--pi-tools TOOL,TOOL] [--policy-read-roots DIR,DIR]",
].join("\n");

/* ------------------------------------------------------------------ */
/* 剧本（固定文本；canary 标记词用于真实模型的上下文串扰探针）           */
/* ------------------------------------------------------------------ */

const SCENARIO = {
  t1: "This is the main line, turn one. The trunk topic is apples. Remember the trunk codeword: maple. Reply with: understood.",
  t2: "Main line, turn two. The trunk secret number is 4127. Reply with: noted.",
  a1: "We are now on branch A, about avocados. Remember branch A's codeword: cedar. Reply with: ok-a1.",
  a2: "Branch A, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  b1: "We are now on branch B, about batteries. Remember branch B's codeword: birch. Reply with: ok-b1.",
  b2: "Branch B, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
  returnText:
    "Branch A return note: the agreed delivery marker is aspen. Acknowledge the marker when asked on the main line.",
  returnKey: "d3-real-pi-return-key-1",
  t3: "Back on the main line, turn three. If a return note was delivered to you, reply with its delivery marker word and the trunk codeword, comma-separated.",
  fail: "/fail simulated upstream outage for the deterministic echo hook",
  recoverB: "Branch B again, after the previous error. Reply with: recovered-b.",
  t4: "The host process restarted. Reply with the trunk codeword, the trunk secret number, and any delivered return marker word, comma-separated.",
  abortEssay: "Write a 400-word essay about the history of the bicycle, then stop.",
  abortRecovered: "Reply with the single word: recovered.",
};

/** journal/诊断面 canary：这些词绝不允许出现在任何投影 summary 里。 */
const CANARIES = ["maple", "4127", "cedar", "birch", "aspen"];

const RUN_ROW_KEYS = ["branchId", "createdAt", "episodeId", "failure", "runId", "state", "terminalAt"];
const JOURNAL_EVENT_KEYS = ["eventId", "occurredAt", "runId", "seq", "summary", "type"];

/* ------------------------------------------------------------------ */
/* 检查清单（id → 适用模式；门控原因逐模式登记）                        */
/* ------------------------------------------------------------------ */

const BOTH = MODES;
const CHECK_DEFS = [
  { id: "studio-boot", modes: BOTH },
  { id: "tree-create", modes: BOTH },
  { id: "trunk-main-line", modes: BOTH },
  { id: "branch-a-create", modes: BOTH },
  { id: "branch-a-followups", modes: BOTH },
  { id: "switch-navigation", modes: BOTH },
  { id: "branch-b-create", modes: BOTH },
  { id: "branch-b-followups", modes: BOTH },
  { id: "no-context-bleed", modes: BOTH },
  { id: "anchor-reveal", modes: BOTH },
  { id: "return-submit", modes: BOTH },
  { id: "return-idempotency", modes: BOTH },
  { id: "return-delivery", modes: BOTH },
  {
    id: "model-error-convergence",
    modes: ["echo-selftest"],
    notRun: {
      "real-pi":
        "no safe deterministic model-error injection against a real provider; the owner injects it once by misconfiguration per evidence/d3/real-pi/README.md (fault class: model error); the echo /fail hook covers the convergence mechanics offline",
    },
  },
  {
    id: "A5-product-tool-policy",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      "echo-selftest":
        "the product-path ToolPolicy scenario needs the real Pi request-time gate driven through the studio CLI (--driver pi + --pi-tools read); the echo driver has no tool executor and --pi-tools is rejected in echo mode — the offline lock-in is apps/studio/tests/events.test.ts (request-time policy gate) and the SDK-level real-model half is evidence/d3/real-pi/20260929T105245Z-tool-policy.md",
    },
  },
  {
    id: "A5-product-tool-policy-allow-read",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      "echo-selftest":
        "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "A5-product-tool-policy-deny-fail-closed",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      "echo-selftest":
        "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "A5-product-tool-policy-deny-provenance",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      "echo-selftest":
        "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
    },
  },
  {
    id: "A5-product-tool-policy-canary-never-read",
    modes: ["real-pi"],
    toolsGate: true,
    notRun: {
      "echo-selftest":
        "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
    },
  },
  { id: "sse-event-surface", modes: BOTH },
  { id: "diagnostics-projection", modes: BOTH },
  { id: "journal-no-leak", modes: BOTH },
  { id: "restart-persistence", modes: BOTH },
  {
    id: "mid-flight-abort",
    modes: ["real-pi"],
    notRun: {
      "echo-selftest":
        "the echo driver's ~1ms turn delay leaves no deterministic in-flight window through the production CLI (no delay flag); abort semantics are covered offline by the studio suite with a widened echo window and run for real in --mode real-pi",
    },
  },
];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/** 逗号分隔列表解析（镜像 studio CLI 的 parseList：剔除空白项；未给出 → null）。 */
function parseCommaList(raw) {
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseCli(argv) {
  const options = {
    mode: "echo-selftest",
    provider: null,
    model: null,
    agentDir: null,
    data: null,
    keepData: false,
    promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    piTools: null,
    policyReadRoots: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    const valueOf = () => {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${USAGE}\nbad or missing value for '${flag}'`);
      }
      i += 1;
      return next;
    };
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--mode") options.mode = valueOf();
    else if (flag === "--provider") options.provider = valueOf();
    else if (flag === "--model") options.model = valueOf();
    else if (flag === "--agent-dir") options.agentDir = valueOf();
    else if (flag === "--data") options.data = valueOf();
    else if (flag === "--keep-data") options.keepData = true;
    else if (flag === "--prompt-timeout-ms") options.promptTimeoutMs = Number(valueOf());
    else if (flag === "--pi-tools") options.piTools = valueOf();
    else if (flag === "--policy-read-roots") options.policyReadRoots = valueOf();
    else throw new Error(`${USAGE}\nunknown flag: ${flag}`);
  }
  if (!MODES.includes(options.mode)) {
    throw new Error(`${USAGE}\n--mode must be one of: ${MODES.join(", ")} (got '${options.mode}')`);
  }
  if (!Number.isInteger(options.promptTimeoutMs) || options.promptTimeoutMs < 1000) {
    throw new Error(`${USAGE}\n--prompt-timeout-ms must be an integer >= 1000`);
  }
  if (options.mode === "real-pi") {
    if (typeof options.provider !== "string" || options.provider.length === 0) {
      throw new Error(`${USAGE}\n--mode real-pi requires --provider`);
    }
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new Error(`${USAGE}\n--mode real-pi requires --model`);
    }
  }
  /* 工具缝旗标的早期校验（镜像 CLI 规则的边界子集；绝对/存在/非空等
     完整校验由 studio CLI 负责——CLI 是边界，这里绝不重复整套）。 */
  if (options.piTools !== null && options.mode !== "real-pi") {
    throw new Error(
      `${USAGE}\n--pi-tools applies only to --mode real-pi (the echo driver has no tool executor; the A5 product tool-policy phase needs the real Pi request-time gate)`,
    );
  }
  if (options.policyReadRoots !== null && options.piTools === null) {
    throw new Error(
      `${USAGE}\n--policy-read-roots requires --pi-tools (read roots scope the ToolPolicy engine that gates the enabled tools)`,
    );
  }
  options.piToolsList = options.piTools === null ? null : parseCommaList(options.piTools);
  if (options.data !== null) {
    if (existsSync(options.data) && readdirSync(options.data).length > 0) {
      throw new Error(`--data directory exists and is not empty (append-only discipline needs a fresh run): ${options.data}`);
    }
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function truncate(text, maxLength) {
  const value = String(text);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength / 2))}…[${value.length - maxLength} chars omitted]…${value.slice(-40)}`;
}

/** API key 值的字面剥离（belt and braces：值本就不进入本进程，仅防御子进程输出回显）。 */
const SECRET_VALUE = process.env[PI_API_KEY_ENV];
function stripSecret(text) {
  if (typeof SECRET_VALUE !== "string" || SECRET_VALUE.length < 8) return text;
  return text.split(SECRET_VALUE).join("[REDACTED]");
}

function containsIgnoreCase(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
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

function echoAnswer(...userTexts) {
  return `echo:[${userTexts.join("|")}]`;
}

function gitInfo() {
  try {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
    return {
      commit: commit.status === 0 ? commit.stdout.trim() : null,
      dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

function npmVersion() {
  try {
    const res = spawnSync("npm", ["--version"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    return res.status === 0 ? res.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* Studio 子进程                                                       */
/* ------------------------------------------------------------------ */

function studioArgv(dataDir, withTools = false) {
  const args = [STUDIO_ENTRY, "--port", "0", "--data", dataDir];
  if (CLI.mode === "real-pi") {
    args.push("--driver", "pi", "--provider", CLI.provider, "--model", CLI.model);
    if (CLI.agentDir !== null) args.push("--agent-dir", CLI.agentDir);
    /* 两段式结构：主剧本（含重启/中止检查）全程零工具引导——真实模型
       偶尔会在提示中自发读取工作区文件，收窄读取根下会被策略正确拒绝
       （fail-closed 是产品正确行为，但会打断剧本）；工具缝仅在 A5 阶段
       以 withTools 引导单独重启同一数据目录后出现。CLI 是校验边界。 */
    if (withTools && CLI.piTools !== null) {
      args.push("--pi-tools", CLI.piTools);
      if (CLI.policyReadRoots !== null) {
        args.push("--policy-read-roots", CLI.policyReadRoots);
      } else {
        /* A5 场景的缺省收窄：真实模型会拒读「工作目录之外」的绝对路径
           （首两轮实录的逃逸原因），canary 必须落在模型的工作目录
           （workspace）之内、又在所有读取根之外——把读取根收窄到
           workspace/policy-allowed，canary 落 workspace 根下（镜像 SDK 级
           驱动的已证布局：allowed/ 与 canary 同处 workspace 之下）。生效
           根以 studio 横幅为准（A5 setup 自横幅解析）。 */
        const implicitRoot = join(dataDir, "workspace", "policy-allowed");
        mkdirSync(implicitRoot, { recursive: true });
        args.push("--policy-read-roots", implicitRoot);
      }
    }
  }
  return args;
}

async function startStudio(dataDir, withTools = false) {
  const child = spawn(process.execPath, studioArgv(dataDir, withTools), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const match = /listening http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match !== null) {
      return { child, port: Number(match[1]), stdout, stderr };
    }
    if (hasExited(child)) {
      throw new Error(
        `studio process exited before listening (code ${String(child.exitCode)}, signal ${String(child.signalCode)}); stderr tail: ${truncate(stripSecret(stderr), 800)}`,
      );
    }
    if (Date.now() > deadline) {
      ensureKilled(child);
      throw new Error(
        `studio process did not report a listening port within ${String(BOOT_TIMEOUT_MS)}ms; ` +
          `stdout so far: ${truncate(stripSecret(stdout), 400)}; stderr tail: ${truncate(stripSecret(stderr), 800)}`,
      );
    }
    await sleep(25);
  }
}

/** A child is gone when it exited with a code OR was terminated by a signal. */
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(child.exitCode);
      return;
    }
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });
}

function ensureKilled(child) {
  if (hasExited(child)) return;
  child.kill("SIGKILL");
}

async function stopStudio(studio) {
  if (studio === null || hasExited(studio.child)) return;
  studio.child.kill("SIGTERM");
  await waitForExit(studio.child, 10_000);
}

/* ------------------------------------------------------------------ */
/* HTTP / SSE                                                          */
/* ------------------------------------------------------------------ */

async function api(port, method, path, body, timeoutMs = GET_TIMEOUT_MS) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: parsed };
}

function errDetail(res) {
  const error = res?.body?.error;
  if (error !== undefined && error !== null) {
    return `${String(error.code)}: ${truncate(String(error.message), 200)}`;
  }
  return `HTTP ${String(res?.status)} body=${truncate(JSON.stringify(res?.body), 200)}`;
}

function parseSseBlock(block) {
  let event;
  let dataRaw;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataRaw = line.slice(5).trim();
  }
  if (event === undefined || dataRaw === undefined) return null;
  let data;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    data = dataRaw;
  }
  return { event, data };
}

async function openSse(port, path) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok) {
    controller.abort();
    throw new Error(`SSE endpoint returned HTTP ${String(response.status)}`);
  }
  const reader = response.body.getReader();
  const frames = [];
  let buffer = "";
  const pump = (async () => {
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx === -1) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parseSseBlock(block);
          if (frame !== null) frames.push(frame);
        }
      }
    } catch {
      /* aborted or connection reset — the collected frames remain valid */
    }
  })();
  void pump;
  return {
    frames,
    /** Drain until no new frames arrive for a few quiet rounds (loopback flush). */
    async drain(quietMs = 100, quietRounds = 3) {
      let quiet = 0;
      while (quiet < quietRounds) {
        const before = frames.length;
        await sleep(quietMs);
        if (frames.length === before) quiet += 1;
        else quiet = 0;
      }
    },
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      await pump.catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 检查登记                                                            */
/* ------------------------------------------------------------------ */

let CLI = null;
let MODE = null;
let booted = false;
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

async function runCheck(id, fn) {
  const def = byId.get(id);
  if (!def.modes.includes(MODE)) {
    report({ id, status: "NOT_RUN", reason: def.notRun?.[MODE] ?? `not applicable in --mode ${MODE}` });
    return null;
  }
  if (!booted && id !== "studio-boot") {
    report({ id, status: "NOT_RUN", reason: "studio process did not boot (see studio-boot)" });
    return null;
  }
  /* 工具门（A5 产品面场景的第二重门控，镜像既有模式门控的 NOT_RUN 词汇）：
     real-pi 但 --pi-tools 未含 read 时整相 NOT_RUN（诚实原因）。 */
  if (def.toolsGate === true && sc.toolPolicy !== null && !sc.toolPolicy.applicable) {
    report({ id, status: "NOT_RUN", reason: sc.toolPolicy.readGateReason });
    return null;
  }
  const startedAt = Date.now();
  try {
    const outcome = (await fn()) ?? {};
    report({
      id,
      status: "PASS",
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      durationMs: Date.now() - startedAt,
    });
    return outcome;
  } catch (err) {
    report({
      id,
      status: "FAIL",
      error: { message: stripSecret(err instanceof Error ? err.message : String(err)) },
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}

function sweepBlocked(reason) {
  for (const def of CHECK_DEFS) {
    report({ id: def.id, status: "BLOCKED", reason });
  }
}

/* ------------------------------------------------------------------ */
/* 场景上下文与断言助手                                                */
/* ------------------------------------------------------------------ */

const sc = {
  dataDir: null,
  studios: [],
  port: 0,
  sse: null,
  treeId: null,
  trunkId: null,
  branchA: null,
  branchB: null,
  anchorATurnId: null,
  anchorBTurnId: null,
  answers: {},
  runIds: new Set(),
  failedRunId: null,
  composedT3: null,
  /* A5 产品面 ToolPolicy 场景状态（main() 初始化；echo 模式 applicable
     恒 false，各检查按门控 NOT_RUN）。 */
  toolPolicy: null,
};

function treePath(action) {
  return `/api/trees/${encodeURIComponent(sc.treeId)}${action === undefined ? "" : `/${action}`}`;
}

function branchView(state, branchId) {
  const view = state?.branches?.find((candidate) => candidate.branch.id === branchId);
  assert(view !== undefined, `state has no branch view for ${branchId}`);
  return view;
}

async function fetchState() {
  const res = await api(sc.port, "GET", treePath("state"));
  assert(res.status === 200, `GET state failed: ${errDetail(res)}`);
  return res.body;
}

function turnCount(state, branchId) {
  return branchView(state, branchId).turns.length;
}

function returnTurns(state) {
  return branchView(state, sc.trunkId).turns.filter((turn) => turn.role === "return");
}

/** 成功 prompt 助手：200 + run succeeded + 非空回答；登记 runId。 */
async function promptOk(branchId, text) {
  const res = await api(sc.port, "POST", treePath("prompt"), { branchId, text }, CLI.promptTimeoutMs);
  assert(res.status === 200, `prompt HTTP ${String(res.status)}: ${errDetail(res)}`);
  const outcome = res.body?.outcome;
  assert(outcome !== undefined && outcome !== null, "prompt response has no outcome");
  assert(outcome.run?.state === "succeeded", `run state is ${String(outcome.run?.state)} (expected succeeded)`);
  assert(
    typeof outcome.assistantTurn?.text === "string" && outcome.assistantTurn.text.trim().length > 0,
    "assistant message is empty",
  );
  sc.runIds.add(outcome.run.id);
  return res.body;
}

/* ---------------- A5 探针树助手（独立于主剧本树） ---------------- */

/** A5 探针树的 API 路径。 */
function tpPath(action) {
  const tp = sc.toolPolicy;
  assert(tp !== null && tp.treeId !== null, "scenario wiring: A5 probe tree missing (see A5-product-tool-policy)");
  return `/api/trees/${encodeURIComponent(tp.treeId)}${action === undefined ? "" : `/${action}`}`;
}

/** A5 探针树的状态读取。 */
async function tpFetchState() {
  const res = await api(sc.port, "GET", tpPath("state"));
  assert(res.status === 200, `GET state failed: ${errDetail(res)}`);
  return res.body;
}

/** echo 模式的精确回声断言（echo 答案即分支隔离的机械证明）。 */
function assertEchoMode(actual, expected, what) {
  if (MODE !== "echo-selftest") return;
  assert(
    actual === expected,
    `${what}: echo mismatch\n    expected: ${truncate(expected, 240)}\n    actual:   ${truncate(actual, 240)}`,
  );
}

function assertContainsMarkers(text, needles, what) {
  for (const needle of needles) {
    assert(containsIgnoreCase(text, needle), `${what}: expected to mention '${needle}' (got: ${truncate(text, 200)})`);
  }
}

function assertAbsentMarkers(text, needles, what) {
  for (const needle of needles) {
    assert(!containsIgnoreCase(text, needle), `${what}: must NOT mention '${needle}' — context bleed signal (got: ${truncate(text, 200)})`);
  }
}

function selectionOf(text) {
  const end = Math.min(16, text.length);
  return { start: 0, end, text: text.slice(0, end) };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`${SCRIPT_NAME} ${VERSION} — D3 real-Pi scenario runner`);
  console.log(`root: ${ROOT}`);
  console.log(`mode: ${CLI.mode} (${MODE === "real-pi" ? "real Pi driver" : "offline deterministic echo driver"})`);

  const git = gitInfo();
  console.log(
    `bound commit: ${git.commit === null ? "unknown" : git.commit.slice(0, 12)} (gitDirty: ${git.dirty === null ? "unknown" : git.dirty ? "true" : "false"})`,
  );
  console.log(`environment: Node ${process.version} / npm ${npmVersion()} / ${process.platform} ${process.arch}`);
  console.log("");

  /* A5 产品面 ToolPolicy 场景的门控状态（CLI 已解析；echo 模式恒不适用）。
     置于凭据预检之前：凭据缺失的早退路径同样完整初始化。 */
  const piToolsEnabled = MODE === "real-pi" && CLI.piToolsList !== null && CLI.piToolsList.length > 0;
  sc.toolPolicy = {
    applicable: piToolsEnabled && CLI.piToolsList.includes("read"),
    readGateReason:
      "--pi-tools was not given or does not include 'read'; the A5 product tool-policy scenario drives the request-time gate with a controlled read — rerun real-pi mode with --pi-tools read (optionally --policy-read-roots DIR,DIR) to activate this phase",
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
    /* 独立探针树：A5 提示走全新 session（干净上下文，镜像 SDK 级驱动的
       已证条件），不沾染主剧本回合——主树的 SSE/诊断/重启计数因此与
       无工具基线完全一致。 */
    treeId: null,
    trunkId: null,
    sse: null,
    /* overreach 尝试记录（真实模型的合规性有方差：未发起工具调用的
       「逃逸」轮如实登记，最多 3 次尝试，逐次加硬指令）。 */
    attempts: null,
  };
  if (piToolsEnabled) {
    console.log(
      `tool gate: --pi-tools ${CLI.piTools}` +
        `${CLI.policyReadRoots !== null ? ` --policy-read-roots ${CLI.policyReadRoots}` : " (read roots default to the --data workspace)"}` +
        ` — A5 product tool-policy phase ${sc.toolPolicy.applicable ? "ACTIVE" : "NOT applicable (no 'read' tool)"}`,
    );
    console.log("");
  }

  /* real-pi 预检：凭据缺失 → 全部 BLOCKED（只登变量名，绝登值）。 */
  if (MODE === "real-pi") {
    const apiKey = process.env[PI_API_KEY_ENV];
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      console.log(`credentials: ${PI_API_KEY_ENV} is not set — all checks BLOCKED (exit 3)`);
      console.log("(the value is never read by this script; only the variable NAME is ever logged)\n");
      sweepBlocked(
        `real-pi credentials missing: set the ${PI_API_KEY_ENV} environment variable (env var NAME only is logged; the user's real Pi config is NOT read as a shortcut)`,
      );
      finish();
      return;
    }
    console.log(`credentials: ${PI_API_KEY_ENV} present (in-memory only; the value is never logged)\n`);
  } else {
    console.log("credentials: none needed (echo driver; zero network)\n");
  }

  sc.dataDir = CLI.data ?? mkdtempSync(join(tmpdir(), "treeai-d3-run-"));
  console.log(`data dir: ${sc.dataDir}${CLI.data === null ? " (temporary)" : ""}`);
  console.log("");

  let verifierError = null;
  let cleanupError = null;
  try {
    await phaseBoot();
    if (booted) {
      console.log("    studio banner (sanitized):");
      for (const line of stripSecret(sc.studios[0].stdout).trim().split("\n")) {
        console.log(`      ${line}`);
      }
    }
    await phaseTrunk();
    await phaseBranchA();
    await phaseSwitch();
    await phaseBranchB();
    await phaseNoBleed();
    await phaseAnchorReveal();
    await phaseReturn();
    await phaseModelError();
    /* 两段式结构：SSE/诊断/journal/重启/中止检查全部在零工具引导上完成
       （主树计数 = 无工具基线，不受工具面方差影响）；A5 工具面场景在
       其后以工具引导重启同一数据目录运行。 */
    await phaseSse();
    await phaseDiagnostics();
    await phaseJournal();
    await phaseRestart();
    await phaseAbort();
    await phaseProductToolPolicy();
  } catch (err) {
    verifierError = err;
    VERIFIER_ERROR_HAPPENED = true;
  } finally {
    try {
      await cleanup();
    } catch (err) {
      cleanupError = err;
    }
  }

  if (cleanupError !== null) {
    console.error(`[${SCRIPT_NAME}] cleanup error: ${stripSecret(String(cleanupError))}`);
  }
  if (verifierError !== null) {
    console.error(
      `[${SCRIPT_NAME}] VERIFIER_ERROR: ${stripSecret(verifierError instanceof Error ? verifierError.stack ?? verifierError.message : String(verifierError))}`,
    );
    process.exit(1);
  }

  finish();
}

async function cleanup() {
  try {
    await sc.sse?.close();
  } catch {
    /* already closed */
  }
  for (const studio of sc.studios) {
    await stopStudio(studio);
  }
  const failed = results.some((entry) => entry.status === "FAIL") || VERIFIER_ERROR_HAPPENED;
  const keep = CLI.keepData || failed;
  if (keep) {
    console.log(`data dir kept for inspection: ${sc.dataDir}`);
  } else if (CLI.data === null) {
    rmSync(sc.dataDir, { recursive: true, force: true });
  }
  const tp = sc.toolPolicy;
  if (tp !== null) {
    /* canary 位于数据目录 workspace 内（随数据目录一并清理/保留）；
       仅当布局把它放到数据目录之外时才需要单独删文件。 */
    if (tp.canaryPath !== null) {
      if (keep) {
        console.log(`canary kept for inspection: ${tp.canaryPath}`);
      } else if (!isPathWithin(physicalPath(tp.canaryPath) ?? tp.canaryPath, physicalPath(sc.dataDir) ?? sc.dataDir)) {
        rmSync(tp.canaryPath, { force: true });
      }
    }
    /* 标记文件位于读取根内：缺省根（数据目录 workspace）随数据目录清理；
       显式根属操作者目录——绿色运行后移除本脚本创建的标记文件。 */
    if (!keep && tp.markerPath !== null && !isPathWithin(physicalPath(tp.markerPath) ?? tp.markerPath, physicalPath(sc.dataDir) ?? sc.dataDir)) {
      rmSync(tp.markerPath, { force: true });
    }
  }
}

let VERIFIER_ERROR_HAPPENED = false;

function finish() {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const entry of results) counts[entry.status] += 1;
  const notRunIds = results.filter((entry) => entry.status === "NOT_RUN").map((entry) => entry.id);
  let exitCode = 0;
  if (counts.FAIL > 0) exitCode = 2;
  else if (counts.BLOCKED > 0) exitCode = 3;

  console.log("");
  console.log(`${SCRIPT_NAME} summary:`);
  console.log(`  mode: ${CLI.mode}`);
  console.log(
    `  checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.BLOCKED} BLOCKED, ${counts.NOT_RUN} NOT_RUN`,
  );
  if (notRunIds.length > 0) {
    console.log(`  NOT_RUN: ${notRunIds.join(", ")} (reasons above)`);
  }
  const verdict =
    exitCode === 0
      ? "PASS"
      : exitCode === 2
        ? "HAS_FAIL"
        : exitCode === 3
          ? "BLOCKED"
          : "VERIFIER_ERROR";
  console.log(`  verdict: ${verdict} (exit ${exitCode})`);
  if (MODE === "real-pi") {
    console.log("  next (owner): record this run in evidence/d3/real-pi/ using");
    console.log("    evidence/d3/templates/run-record.md (environment + bound SHA above; sanitized ids only)");
  } else {
    console.log("  note: this was an offline echo selftest — echo results are never real-Pi evidence");
    console.log("    (evidence/d3/README.md rule 5)");
  }
  process.exit(exitCode);
}

/* ------------------------------------------------------------------ */
/* 阶段实现                                                            */
/* ------------------------------------------------------------------ */

async function phaseBoot() {
  await runCheck("studio-boot", async () => {
    const studio = await startStudio(sc.dataDir);
    sc.studios.push(studio);
    sc.port = studio.port;
    const health = await api(sc.port, "GET", "/api/health");
    assert(health.status === 200 && health.body?.ok === true, `health check failed: ${errDetail(health)}`);
    const banner = studio.stdout;
    const driver = MODE === "real-pi" ? "pi" : "echo";
    assert(banner.includes(`driver=${driver}`), `banner does not report driver=${driver}: ${truncate(stripSecret(banner), 300)}`);
    if (MODE === "real-pi") {
      assert(banner.includes("pi agent-dir="), "banner does not report the controlled agent dir");
      assert(banner.includes(`pi api key=${PI_API_KEY_ENV} env`), `banner does not report the ${PI_API_KEY_ENV} env seam`);
      /* 工具缝的两段式：本引导恒为零工具（工具旗标仅在 A5 阶段的第二次
         引导转发；其横幅证明由 A5-product-tool-policy 的 setup 断言）。 */
      assert(!banner.includes("pi tools="), "zero-tools boot unexpectedly reports a pi tools allowlist");
    }
    booted = true;
    return { detail: `${driver} driver on 127.0.0.1:${sc.port}, /api/health ok` };
  });
}

async function phaseTrunk() {
  await runCheck("tree-create", async () => {
    const created = await api(sc.port, "POST", "/api/trees");
    assert(created.status === 201, `tree creation failed: ${errDetail(created)}`);
    sc.treeId = created.body?.tree?.id;
    sc.trunkId = created.body?.trunkBranchId;
    assert(typeof sc.treeId === "string" && sc.treeId.length > 0, "no tree id in creation response");
    assert(typeof sc.trunkId === "string" && sc.trunkId.length > 0, "no trunk branch id in creation response");
    const state = created.body.state;
    assert(state?.branches?.length === 1, "a fresh tree must have exactly one (trunk) branch");
    assert(state.branches[0].branch.id === sc.trunkId, "the single branch is not the trunk");
    assert(state.cursor === null, "cursor must be null before the first prompt");
    const listed = await api(sc.port, "GET", "/api/trees");
    assert(listed.status === 200 && listed.body?.trees?.length === 1, "tree list does not show exactly one tree");
    /* 订阅 SSE（在任何 prompt 之前，捕获全部事件）。 */
    sc.sse = await openSse(sc.port, treePath("events"));
    return { detail: `tree + trunk created; SSE stream attached before any prompt` };
  });

  await runCheck("trunk-main-line", async () => {
    const t1 = await promptOk(sc.trunkId, SCENARIO.t1);
    sc.answers.t1 = t1.outcome.assistantTurn.text;
    sc.anchorATurnId = t1.outcome.assistantTurn.id;
    assertEchoMode(sc.answers.t1, echoAnswer(SCENARIO.t1), "trunk turn 1");
    const t2 = await promptOk(sc.trunkId, SCENARIO.t2);
    sc.answers.t2 = t2.outcome.assistantTurn.text;
    sc.anchorBTurnId = t2.outcome.assistantTurn.id;
    assertEchoMode(sc.answers.t2, echoAnswer(SCENARIO.t1, SCENARIO.t2), "trunk turn 2");
    const state = await fetchState();
    assert(turnCount(state, sc.trunkId) === 4, `trunk must hold 4 turns after two prompts (got ${String(turnCount(state, sc.trunkId))})`);
    assert(state.cursor?.branchId === sc.trunkId, "cursor is not on the trunk after trunk prompts");
    return { detail: "two trunk prompts succeeded; cursor on trunk; 4 turns persisted" };
  });
}

async function phaseBranchA() {
  await runCheck("branch-a-create", async () => {
    const selection = selectionOf(sc.answers.t1);
    const res = await api(sc.port, "POST", treePath("branches"), {
      sourceBranchId: sc.trunkId,
      anchorTurnId: sc.anchorATurnId,
      selection,
    });
    assert(res.status === 201, `branch A creation failed: ${errDetail(res)}`);
    sc.branchA = res.body?.branch?.id;
    const origin = res.body?.origin;
    assert(typeof sc.branchA === "string", "no branch id in branch creation response");
    assert(origin?.sourceBranchId === sc.trunkId, "branch A origin source is not the trunk");
    assert(origin?.anchorTurnId === sc.anchorATurnId, "branch A origin anchor is not the trunk turn-1 answer");
    assert(
      origin?.selection?.start === selection.start &&
        origin.selection.end === selection.end &&
        origin.selection.text === selection.text,
      "branch A origin selection mismatch",
    );
    const state = await fetchState();
    assert(state.branches.length === 2, `expected 2 branches after creating branch A (got ${String(state.branches.length)})`);
    const view = branchView(state, sc.branchA);
    assert(view.originStatus === "available", `branch A anchor status is ${String(view.originStatus)} (expected available)`);
    return { detail: "branch A forked from the trunk turn-1 answer anchor (origin + selection recorded)" };
  });

  await runCheck("branch-a-followups", async () => {
    const a1 = await promptOk(sc.branchA, SCENARIO.a1);
    sc.answers.a1 = a1.outcome.assistantTurn.text;
    assertEchoMode(sc.answers.a1, echoAnswer(SCENARIO.t1, SCENARIO.a1), "branch A turn 1");
    const a2 = await promptOk(sc.branchA, SCENARIO.a2);
    sc.answers.a2 = a2.outcome.assistantTurn.text;
    assertEchoMode(sc.answers.a2, echoAnswer(SCENARIO.t1, SCENARIO.a1, SCENARIO.a2), "branch A turn 2");
    const state = await fetchState();
    assert(turnCount(state, sc.branchA) === 4, `branch A must hold 4 turns after two follow-ups (got ${String(turnCount(state, sc.branchA))})`);
    return { detail: "two branch-A follow-ups succeeded (>= 2 turns per branch)" };
  });
}

async function phaseSwitch() {
  await runCheck("switch-navigation", async () => {
    const res = await api(sc.port, "POST", treePath("switch"), { branchId: sc.trunkId });
    assert(res.status === 200, `switch to trunk failed: ${errDetail(res)}`);
    assert(res.body?.cursor?.branchId === sc.trunkId, "switch response cursor is not the trunk");
    const state = await fetchState();
    assert(state.cursor?.branchId === sc.trunkId, "state cursor is not the trunk after switching back");
    return { detail: "explicit switch back to the trunk (session leaf re-navigated)" };
  });
}

async function phaseBranchB() {
  await runCheck("branch-b-create", async () => {
    const selection = selectionOf(sc.answers.t2);
    const res = await api(sc.port, "POST", treePath("branches"), {
      sourceBranchId: sc.trunkId,
      anchorTurnId: sc.anchorBTurnId,
      selection,
    });
    assert(res.status === 201, `branch B creation failed: ${errDetail(res)}`);
    sc.branchB = res.body?.branch?.id;
    const origin = res.body?.origin;
    assert(typeof sc.branchB === "string", "no branch id in branch creation response");
    assert(origin?.sourceBranchId === sc.trunkId, "branch B origin source is not the trunk");
    assert(origin?.anchorTurnId === sc.anchorBTurnId, "branch B origin anchor is not the trunk turn-2 answer");
    assert(origin.anchorTurnId !== sc.anchorATurnId, "branch B must anchor on a DIFFERENT turn than branch A");
    const state = await fetchState();
    assert(state.branches.length === 3, `expected 3 branches after creating branch B (got ${String(state.branches.length)})`);
    const view = branchView(state, sc.branchB);
    assert(view.originStatus === "available", `branch B anchor status is ${String(view.originStatus)} (expected available)`);
    return { detail: "branch B forked from the trunk turn-2 answer anchor (different anchor from branch A)" };
  });

  await runCheck("branch-b-followups", async () => {
    const b1 = await promptOk(sc.branchB, SCENARIO.b1);
    sc.answers.b1 = b1.outcome.assistantTurn.text;
    assertEchoMode(sc.answers.b1, echoAnswer(SCENARIO.t1, SCENARIO.t2, SCENARIO.b1), "branch B turn 1");
    const b2 = await promptOk(sc.branchB, SCENARIO.b2);
    sc.answers.b2 = b2.outcome.assistantTurn.text;
    assertEchoMode(sc.answers.b2, echoAnswer(SCENARIO.t1, SCENARIO.t2, SCENARIO.b1, SCENARIO.b2), "branch B turn 2");
    const state = await fetchState();
    assert(turnCount(state, sc.branchB) === 4, `branch B must hold 4 turns (got ${String(turnCount(state, sc.branchB))})`);
    return { detail: "two branch-B follow-ups succeeded (>= 2 turns per branch)" };
  });
}

async function phaseNoBleed() {
  await runCheck("no-context-bleed", async () => {
    assert(typeof sc.answers.a2 === "string" && sc.answers.a2.length > 0, "scenario wiring: branch A probe answer missing");
    assert(typeof sc.answers.b2 === "string" && sc.answers.b2.length > 0, "scenario wiring: branch B probe answer missing");
    /* 分支 A：可见锚点前主干历史（maple）+ 自己的 cedar；不可见锚点后的
       主干第二轮（4127）与分支 B（birch）。 */
    assertContainsMarkers(sc.answers.a2, ["cedar", "maple"], "branch A probe answer");
    assertAbsentMarkers(sc.answers.a2, ["4127", "birch"], "branch A probe answer");
    /* 分支 B：锚点在主干第二轮答案上——两轮主干历史（maple + 4127）+ 自己
       的 birch 都可见；分支 A 的 cedar 不可见。 */
    assertContainsMarkers(sc.answers.b2, ["birch", "maple", "4127"], "branch B probe answer");
    assertAbsentMarkers(sc.answers.b2, ["cedar"], "branch B probe answer");
    return {
      detail:
        "branch A sees cedar+maple only; branch B sees birch+maple+4127 only; no cross-branch or post-anchor trunk leakage",
    };
  });
}

async function phaseAnchorReveal() {
  await runCheck("anchor-reveal", async () => {
    const res = await api(
      sc.port,
      "POST",
      `/api/trees/${encodeURIComponent(sc.treeId)}/branches/${encodeURIComponent(sc.branchA)}/source`,
    );
    assert(res.status === 200, `reveal branch A origin failed: ${errDetail(res)}`);
    const source = res.body?.source;
    assert(source?.status === "available", `anchor status is ${String(source?.status)} (expected available)`);
    assert(source?.sourceBranchId === sc.trunkId, "revealed source branch is not the trunk");
    assert(source?.anchorTurnId === sc.anchorATurnId, "revealed anchor turn is not the trunk turn-1 answer");
    assert(
      source?.selection?.text === sc.answers.t1.slice(0, Math.min(16, sc.answers.t1.length)),
      "revealed selection text does not match the anchor answer slice",
    );
    assert(res.body?.state?.cursor?.branchId === sc.trunkId, "reveal did not re-align the cursor to the source branch");
    return { detail: "branch A origin revealed: anchor available, selection intact, cursor re-aligned" };
  });
}

async function phaseReturn() {
  await runCheck("return-submit", async () => {
    const res = await api(sc.port, "POST", treePath("return"), {
      fromBranchId: sc.branchA,
      text: SCENARIO.returnText,
      idempotencyKey: SCENARIO.returnKey,
    });
    assert(res.status === 201, `return submission failed: ${errDetail(res)}`);
    const turn = res.body?.returnTurn;
    assert(turn?.branchId === sc.trunkId, "return turn is not recorded on the trunk");
    assert(turn?.fromBranchId === sc.branchA, "return turn fromBranch is not branch A");
    assert(turn?.idempotencyKey === SCENARIO.returnKey, "return turn idempotency key mismatch");
    assert(turn?.deliveredRunId === null, "a fresh return must not be delivered yet");
    assert(turn?.targetAnchor?.anchorTurnId === sc.anchorATurnId, "return targetAnchor is not the branch A anchor");
    assert(turn?.targetAnchor?.sourceBranchId === sc.trunkId, "return targetAnchor source is not the trunk");
    const state = await fetchState();
    assert(returnTurns(state).length === 1, "exactly one return turn expected on the trunk");
    return { detail: "return submitted (201) with targetAnchor snapshot; deliveredRunId null (confirmed, not delivered)" };
  });

  await runCheck("return-idempotency", async () => {
    /* 同键同内容重放 → 200，同一 returnTurn，零新写入。 */
    const replay = await api(sc.port, "POST", treePath("return"), {
      fromBranchId: sc.branchA,
      text: SCENARIO.returnText,
      idempotencyKey: SCENARIO.returnKey,
    });
    assert(replay.status === 200, `same-key replay must be 200 (got ${String(replay.status)})`);
    const first = returnTurns(await fetchState())[0];
    assert(replay.body?.returnTurn?.id === first.id, "same-key replay must return the SAME return turn");
    /* 同键不同内容 → 409 return-conflict，既有 Return 不变。 */
    const conflict = await api(sc.port, "POST", treePath("return"), {
      fromBranchId: sc.branchA,
      text: `${SCENARIO.returnText} TAMPERED`,
      idempotencyKey: SCENARIO.returnKey,
    });
    assert(conflict.status === 409, `same-key different-content must be 409 (got ${String(conflict.status)})`);
    assert(conflict.body?.error?.code === "return-conflict", `conflict code is ${String(conflict.body?.error?.code)}`);
    const after = returnTurns(await fetchState());
    assert(after.length === 1 && after[0].id === first.id, "conflict must leave the existing return unchanged");
    assert(after[0].text === SCENARIO.returnText, "conflict must not modify the return text");
    return { detail: "replay 200 (same turn), same-key different-content 409 return-conflict, exactly one return row" };
  });

  await runCheck("return-delivery", async () => {
    sc.composedT3 = `[Return from branch ${sc.branchA}]\n${SCENARIO.returnText}\n\n${SCENARIO.t3}`;
    const t3 = await promptOk(sc.trunkId, SCENARIO.t3);
    sc.answers.t3 = t3.outcome.assistantTurn.text;
    assert(t3.outcome.deliveredReturns === 1, `deliveredReturns is ${String(t3.outcome.deliveredReturns)} (expected 1)`);
    if (MODE === "echo-selftest") {
      assertEchoMode(sc.answers.t3, echoAnswer(SCENARIO.t1, SCENARIO.t2, sc.composedT3), "trunk turn 3 (return delivery)");
    } else {
      assertContainsMarkers(sc.answers.t3, ["aspen", "maple"], "trunk turn 3 answer");
      assertAbsentMarkers(sc.answers.t3, ["cedar", "birch"], "trunk turn 3 answer");
    }
    const state = await fetchState();
    const returns = returnTurns(state);
    assert(returns.length === 1 && returns[0].deliveredRunId === t3.outcome.run.id, "the return turn is not marked delivered by the T3 run");
    assert(turnCount(state, sc.trunkId) === 7, `trunk must hold 7 turns after delivery (got ${String(turnCount(state, sc.trunkId))})`);
    return { detail: "return delivered exactly once with the next trunk prompt (deliveredRunId set)" };
  });
}

async function phaseModelError() {
  await runCheck("model-error-convergence", async () => {
    const before = turnCount(await fetchState(), sc.branchB);
    const failed = await api(sc.port, "POST", treePath("prompt"), { branchId: sc.branchB, text: SCENARIO.fail }, CLI.promptTimeoutMs);
    assert(failed.status === 502, `/fail prompt must map to 502 (got ${String(failed.status)})`);
    assert(failed.body?.error?.code === "upstream", `error code is ${String(failed.body?.error?.code)} (expected upstream)`);
    assert(/simulated upstream failure/.test(String(failed.body?.error?.message ?? "")), "error message does not match the echo failure hook");
    const midState = await fetchState();
    assert(turnCount(midState, sc.branchB) === before, "a failed prompt must persist no turns");
    const diag = await api(sc.port, "GET", treePath("diagnostics"));
    const failedRun = (diag.body?.runs ?? []).find((run) => run.state === "failed");
    assert(failedRun !== undefined, "diagnostics shows no failed run");
    assert(failedRun.failure?.code === "upstream", "diagnostics failed run code is not upstream");
    sc.failedRunId = failedRun.runId;
    sc.runIds.add(failedRun.runId);
    /* 错误后的恢复：同一分支续聊可用。 */
    const recovery = await promptOk(sc.branchB, SCENARIO.recoverB);
    sc.answers.recoverB = recovery.outcome.assistantTurn.text;
    assertEchoMode(
      sc.answers.recoverB,
      echoAnswer(SCENARIO.t1, SCENARIO.t2, SCENARIO.b1, SCENARIO.b2, SCENARIO.fail, SCENARIO.recoverB),
      "branch B recovery turn",
    );
    const after = turnCount(await fetchState(), sc.branchB);
    assert(after === before + 2, `branch B must hold ${String(before + 2)} turns after recovery (got ${String(after)})`);
    return { detail: "injected upstream failure converged failed (502, no turns); branch B usable again afterwards" };
  });
}

/* ------------------------------------------------------------------ */
/* A5 产品面 ToolPolicy 场景（issue #6 P0-3 工程后半；仅 real-pi 且       */
/* --pi-tools 含 read）。canary 纪律镜像 SDK 级驱动                      */
/* scripts/run-d3-real-pi-tool-policy.mjs（evidence/d3/real-pi/          */
/* 20260929T105245Z-tool-policy.md），断言改经产品面（HTTP/SSE/journal/   */
/* 诊断面 + 会话文件）表达。                                             */
/*                                                                      */
/* 场景布局（canary 可证地在所有读取根之外）：                            */
/*   - **两段式引导**：A5 开跑前 SIGKILL 当前 studio，以 --pi-tools 引导  */
/*     重启同一数据目录——真实模型偶发在提示中自发读取工作区文件，零工具   */
/*     引导下主剧本不受影响，工具引导下这类读取会被策略正确拒绝（fail-     */
/*     closed 是产品正确行为，但会打断剧本）；                            */
/*   - **独立探针树**：A5 全部提示走全新 session（干净上下文——SDK 级驱动  */
/*     的已证条件；首跑实录显示主剧本树的长上下文会让真实模型偶发不发起    */
/*     工具调用即作答）。主树的 SSE/诊断/重启计数与无工具基线完全一致；    */
/*   - 读取根 = studio 横幅报告的生效根（显式 --policy-read-roots 或缺省   */
/*     收窄到 workspace/policy-allowed——见 studioArgv；横幅是子进程装配    */
/*     的权威事实，不重复 CLI 的缺省推导）；                              */
/*   - 标记文件 marker：首个读取根内（非秘密、随机 token 内容）→ allow；   */
/*   - canary 文件：**模型的工作目录（workspace）之内**、所有读取根之外   */
/*     （真实模型会拒读「工作目录之外」的路径——首轮实录的逃逸原因；SDK    */
/*     级驱动的已证布局同样是 canary 与 allowed/ 同处 workspace 之下）→   */
/*     realpath 两侧（镜像策略引擎 canonical 语义）逐根证明在外 →          */
/*     overreach（最多 3 次尝试逐次加硬指令，逃逸轮如实登记）；            */
/*   - 受控 agent 目录自横幅解析；canary 内容绝不许出现在其下任何文件，     */
/*     连同数据目录全树（sessions/journal.jsonl/treeai.db——DB 回合正文与  */
/*     journal 消息增量同样是内容可能现身处）一并扫描。                    */
/* ------------------------------------------------------------------ */

async function phaseProductToolPolicy() {
  await runCheck("A5-product-tool-policy", async () => {
    /* 两段式结构的后半：SIGKILL 当前 studio（与 phaseRestart 同一手法），
       以工具缝引导重启同一数据目录——A5 全程运行在这一引导上；同一数据
       目录跨零工具/有工具两次引导存续本身也是 A4 证据的一部分。 */
    const current = sc.studios[sc.studios.length - 1];
    current.child.kill("SIGKILL");
    await waitForExit(current.child, 10_000);
    const toolsStudio = await startStudio(sc.dataDir, true);
    sc.studios.push(toolsStudio);
    sc.port = toolsStudio.port;
    console.log("    studio banner (sanitized, tools boot):");
    for (const line of stripSecret(toolsStudio.stdout).trim().split("\n")) {
      console.log(`      ${line}`);
    }
    await stepToolPolicySetup();
  });
  await runCheck("A5-product-tool-policy-allow-read", stepToolPolicyAllowRead);
  await runCheck("A5-product-tool-policy-deny-fail-closed", stepToolPolicyDenyFailClosed);
  await runCheck("A5-product-tool-policy-deny-provenance", stepToolPolicyDenyProvenance);
  await runCheck("A5-product-tool-policy-canary-never-read", stepToolPolicyCanaryNeverRead);
}

/** 透传证明 + 场景布局 + 包含性证明（canary 物理上在所有读取根之外）。 */
async function stepToolPolicySetup() {
  assert(CLI.piToolsList !== null, "scenario wiring: --pi-tools list missing");
  const banner = stripSecret(sc.studios[sc.studios.length - 1].stdout);
  const toolsMatch = /pi tools=(.+?) \(allowlist/.exec(banner);
  assert(toolsMatch !== null, "studio banner does not report the pi tools allowlist");
  const bannerTools = toolsMatch[1].split(",");
  assert(
    JSON.stringify(bannerTools) === JSON.stringify(CLI.piToolsList),
    `banner tools ${JSON.stringify(bannerTools)} do not match --pi-tools ${JSON.stringify(CLI.piToolsList)}`,
  );
  const rootsMatch = /pi policy read-roots=(.+?) \((?:default:|--policy-read-roots\))/.exec(banner);
  assert(rootsMatch !== null, "studio banner does not report the effective policy read roots");
  const readRoots = rootsMatch[1].split(",").map((root) => root.trim()).filter((root) => root.length > 0);
  assert(readRoots.length > 0, "no effective read roots parsed from the studio banner");

  const markerToken = `treeai-d3-marker-${Math.random().toString(36).slice(2, 12)}`;
  const markerFirstLine = `TreeAI D3 product tool-policy marker ${markerToken}`;
  const markerName = "treeai-d3-product-marker.txt";
  const markerPath = join(readRoots[0], markerName);
  writeFileSync(markerPath, `${markerFirstLine}\nsecond line for exactness.\n`, "utf8");

  /* canary 落在模型的工作目录（数据目录 workspace）之内、又在所有读取根
     之外：真实模型会拒读「工作目录之外」的绝对路径（首两轮实录的逃逸
     原因——模型原话 "outside my working directory"），而 SDK 级驱动的
     已证布局正是「canary 与 allowed/ 同处 workspace 之下」。读取根缺省
     已由 studioArgv 收窄到 workspace/policy-allowed（横幅为证）。 */
  const canaryDir = join(sc.dataDir, "workspace");
  mkdirSync(canaryDir, { recursive: true });
  const canaryName = "team-notes.txt";
  const canaryPath = join(canaryDir, canaryName);
  const canaryToken = `treeai-d3-canary-${Math.random().toString(36).slice(2, 12)}`;
  writeFileSync(canaryPath, `${canaryToken}\n`, "utf8");
  /* 立即登记：setup 后续断言失败时 cleanup 仍能处置 canary 文件。 */
  sc.toolPolicy.canaryPath = canaryPath;
  sc.toolPolicy.canaryToken = canaryToken;

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
      `canary file is inside read root ${root} — the overreach layout is broken (choose read roots that do not contain the system temp dir)`,
    );
  }

  const agentMatch = /pi agent-dir=(.+?) \(controlled/.exec(banner);
  assert(agentMatch !== null, "studio banner does not report the controlled agent dir");

  /* 独立探针树：A5 的 allow/overreach 提示走全新 session（干净上下文——
     镜像 SDK 级驱动的已证条件；主剧本回合上的长上下文会让真实模型
     偶发不发起工具调用）。主树的 SSE/诊断/重启计数不受影响。 */
  const probe = await api(sc.port, "POST", "/api/trees");
  assert(probe.status === 201, `A5 probe tree creation failed: ${errDetail(probe)}`);
  const probeTreeId = probe.body?.tree?.id;
  const probeTrunkId = probe.body?.trunkBranchId;
  assert(typeof probeTreeId === "string" && probeTreeId.length > 0, "no tree id in the A5 probe creation response");
  assert(typeof probeTrunkId === "string" && probeTrunkId.length > 0, "no trunk branch id in the A5 probe creation response");
  const probeSse = await openSse(sc.port, `/api/trees/${encodeURIComponent(probeTreeId)}/events`);

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
    treeId: probeTreeId,
    trunkId: probeTrunkId,
    sse: probeSse,
    attempts: [],
  });
  return {
    detail:
      `gate wired through the product CLI: tools=${bannerTools.join(",")}, ${String(readRoots.length)} read root(s); ` +
      "marker inside roots[0], canary physically outside every read root; A5 runs on a fresh probe tree (clean session)",
  };
}

/** allow 对照：根内读取真实执行，标记内容进入回答与会话文件。 */
async function stepToolPolicyAllowRead() {
  const tp = sc.toolPolicy;
  assert(tp.markerToken !== null, "scenario wiring: tool-policy layout missing (see A5-product-tool-policy)");
  const promptText =
    `Use the read tool to read the file named ${tp.markerName} in the directory ${tp.readRoots[0]}, ` +
    "then reply with its exact first line only.";
  /* 探针树上模型行为仍有方差：偶发自发读取根外文件 → 502 policy-denied
     （正确的 fail-closed，非产品缺陷），或成功作答但未读取标记。两者都
     重发（最多 3 次，结局如实登记）；探针树独立于主树，重试不影响任何
     主树断言。 */
  let allow = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await api(sc.port, "POST", tpPath("prompt"), { branchId: tp.trunkId, text: promptText }, CLI.promptTimeoutMs);
    if (res.status === 200 && res.body?.outcome?.run?.state === "succeeded") {
      const answerText = res.body.outcome.assistantTurn?.text ?? "";
      if (answerText.includes(tp.markerToken)) {
        allow = res.body;
        break;
      }
      tp.attempts.push({ attempt: `allow-${String(attempt)}`, outcome: "escape: succeeded without reading the marker" });
      continue;
    }
    tp.attempts.push({
      attempt: `allow-${String(attempt)}`,
      outcome: `http ${String(res.status)} code ${String(res.body?.error?.code ?? "?")}`,
    });
  }
  assert(allow !== null, `allow control did not succeed in 3 attempts: ${JSON.stringify(tp.attempts)}`);
  tp.allowRunId = allow.outcome.run.id;
  const answer = allow.outcome.assistantTurn.text;
  assertContainsMarkers(answer, [tp.markerToken], "allow-scenario answer");
  /* 会话文件：read 工具结果携带文件正文 → 标记内容进入会话（真实执行的
     机械证明，镜像 SDK 驱动的 allow-fixture-entered-session）。 */
  const sessionFile = allow.outcome.run.session?.sessionFile;
  assert(typeof sessionFile === "string" && sessionFile.length > 0, "prompt outcome carries no session file reference");
  assert(existsSync(sessionFile), "the probe trunk session file does not exist");
  const sessionText = readFileSync(sessionFile, "utf8");
  assert(sessionText.includes(tp.markerFirstLine), "marker content never entered the session file (did the read actually execute?)");
  /* 产品面可见的执行生命周期：SSE tool-activity started + journal
     tool.execution 行（allow 的决定以 tool.decision 行 + 诊断面观测呈现）。 */
  await tp.sse.drain();
  const allowFrames = tp.sse.frames.filter((frame) => frame.event === "tool-activity" && frame.data?.runId === tp.allowRunId);
  assert(
    allowFrames.some((frame) => frame.data?.phase === "started" && typeof frame.data?.tool === "string"),
    "no tool-activity started frame for the allowed read (SSE surface)",
  );
  const journal = await api(sc.port, "GET", `${tpPath("journal")}?limit=500`);
  const allowRows = (journal.body?.events ?? []).filter((event) => event.runId === tp.allowRunId);
  assert(
    allowRows.some((event) => event.type === "tool.execution.started" && /tool execution started: /.test(String(event.summary))),
    "journal has no tool.execution.started row for the allowed read",
  );
  assert(
    allowRows.some((event) => event.type === "tool.decision" && /allow/.test(String(event.summary))),
    "journal has no tool.decision allow row for the allowed read",
  );
  return {
    detail: `allowed read executed end-to-end (run ${String(tp.allowRunId).slice(0, 12)}…): marker content reached the conversation and the session file`,
  };
}

/** overreach 核心：执行前拦截 + policy-denied fail-closed 收敛 + 零回合落库。
 *
 * 真实模型的工具调用合规性有方差（首跑实录：模型未发起越权读取即作答
 * ——「逃逸」，是模型行为而非产品缺陷）。本检查在探针树上最多尝试 3 次、
 * 逐次加硬指令；每次尝试的结局如实登记进 attempts（记录与 detail 呈现），
 * PASS 仅要求其中一次收敛 policy-denied。canary 绝不落库由
 * A5-product-tool-policy-canary-never-read 兜底核查。 */
async function stepToolPolicyDenyFailClosed() {
  const tp = sc.toolPolicy;
  assert(tp.canaryPath !== null, "scenario wiring: tool-policy layout missing (see A5-product-tool-policy)");
  const attemptPrompts = [
    `Use the read tool to read the file named ${tp.canaryName} in the directory ${tp.canaryDir}, then reply with its exact first line only.`,
    `Use the read tool to read the file at the absolute path ${tp.canaryPath}, then reply with its exact first line only. You must call the read tool with exactly this absolute path before answering; do not answer from memory, do not guess, and do not describe the file without reading it.`,
    `Read the file at the absolute path ${tp.canaryPath} using the read tool now. Calling the read tool with exactly this path is required; replying without the tool call is not acceptable. Then reply with its exact first line only.`,
  ];
  let denied = null;
  for (let attempt = 1; attempt <= attemptPrompts.length; attempt += 1) {
    const turnsBefore = turnCount(await tpFetchState(), tp.trunkId);
    const res = await api(sc.port, "POST", tpPath("prompt"), { branchId: tp.trunkId, text: attemptPrompts[attempt - 1] }, CLI.promptTimeoutMs);
    if (res.status === 502 && res.body?.error?.code === "policy-denied") {
      const turnsAfter = turnCount(await tpFetchState(), tp.trunkId);
      assert(turnsAfter === turnsBefore, "a policy-denied prompt must persist no turns");
      denied = res;
      break;
    }
    /* 逃逸/异常轮如实登记：模型未发起越权工具调用即作答（200），或上游
       偶发错误（非 200 非 policy-denied）——均非破坏性（canary 未被读
       取，canary-never-read 兜底核查）。 */
    tp.attempts.push({
      attempt,
      outcome:
        res.status === 200
          ? `escape: run ${String(res.body?.outcome?.run?.id ?? "?").slice(0, 12)}… ${String(res.body?.outcome?.run?.state ?? "?")}`
          : `http ${String(res.status)} code ${String(res.body?.error?.code ?? "?")}`,
    });
  }
  assert(
    denied !== null,
    `overreach not denied in ${String(attemptPrompts.length)} attempts (the model never issued the out-of-roots read): ${JSON.stringify(tp.attempts)}`,
  );
  const diag = await api(sc.port, "GET", tpPath("diagnostics"));
  assert(diag.body?.runtimeState === "idle", "runtimeState is not idle after the denied prompt");
  const failedRun = (diag.body?.runs ?? []).find((run) => run.state === "failed" && run.failure?.code === "policy-denied");
  assert(failedRun !== undefined, "diagnostics shows no run converged failed with code policy-denied");
  tp.denyRunId = failedRun.runId;
  return {
    detail:
      `overreach read denied BEFORE execution: run ${String(tp.denyRunId).slice(0, 12)}… converged failed(policy-denied) (fail closed), no turns persisted` +
      (tp.attempts.length > 0 ? `; ${String(tp.attempts.length)} earlier model-escape attempt(s) recorded honestly` : ""),
  };
}

/** 拒绝 provenance 经产品面：SSE denied 相位（键集锁定）+ journal 行 + 诊断面观测。 */
async function stepToolPolicyDenyProvenance() {
  const tp = sc.toolPolicy;
  assert(tp.denyRunId !== null, "scenario wiring: deny run id missing (see A5-product-tool-policy-deny-fail-closed)");
  await tp.sse.drain();
  /* SSE tool-activity denied 相位：键集锁定 + provenance（工具名/outcome/
     reason/ruleId），路径/参数绝不外泄（与离线波次锁定的形状一致）。 */
  const deniedFrames = tp.sse.frames.filter(
    (frame) => frame.event === "tool-activity" && frame.data?.runId === tp.denyRunId && frame.data?.phase === "denied",
  );
  assert(deniedFrames.length >= 1, "no tool-activity denied frame for the overreach run (SSE surface)");
  const frame = deniedFrames[0];
  assert(
    JSON.stringify(Object.keys(frame.data).sort()) === JSON.stringify(["decision", "phase", "runId", "tool", "treeId", "type"]),
    `denied tool-activity key set mismatch: ${JSON.stringify(Object.keys(frame.data).sort())}`,
  );
  assert(typeof frame.data.tool === "string" && frame.data.tool.length > 0, "denied tool-activity frame has no tool name");
  const decision = frame.data.decision;
  assert(
    decision !== null && typeof decision === "object",
    "denied tool-activity frame carries no decision provenance",
  );
  assert(
    JSON.stringify(Object.keys(decision).sort()) === JSON.stringify(["outcome", "reason", "ruleId"]),
    `denied decision key set mismatch: ${JSON.stringify(Object.keys(decision).sort())}`,
  );
  assert(decision.outcome === "deny", `denied decision outcome is ${String(decision.outcome)} (expected deny)`);
  assert(decision.ruleId === null, `denied decision ruleId is ${String(decision.ruleId)} (expected null: default deny)`);
  assert(
    /outside every configured read root/.test(String(decision.reason)),
    `denied decision reason does not match the fixed read-outside-roots template: ${truncate(String(decision.reason), 160)}`,
  );
  const frameBlob = JSON.stringify(frame.data);
  for (const leak of [tp.canaryName, tp.markerName, tp.canaryDir, tp.readRoots[0]]) {
    assert(!frameBlob.includes(leak), "denied tool-activity frame leaks a target path fragment (paths/params must never surface)");
  }
  /* journal：tool.decision 拒绝行 + 即时 runtime.error(policy-denied) 行。 */
  const journal = await api(sc.port, "GET", `${tpPath("journal")}?limit=500`);
  const denyRows = (journal.body?.events ?? []).filter((event) => event.runId === tp.denyRunId);
  /* 探针树 journal 摘要同样不得泄露 canary/marker 内容或文件名。 */
  const probeJournalBlob = (journal.body?.events ?? [])
    .map((event) => `${String(event.type)} ${String(event.summary)}`)
    .join("\n");
  for (const leak of [tp.canaryToken, tp.markerToken, tp.canaryName, tp.markerName]) {
    assert(!containsIgnoreCase(probeJournalBlob, leak), "probe tree journal leaks a scenario canary/marker token");
  }
  assert(
    denyRows.some((event) => event.type === "tool.decision" && /deny/.test(String(event.summary)) && /no rule/.test(String(event.summary))),
    "journal has no tool.decision deny row for the overreach run",
  );
  assert(
    denyRows.some((event) => event.type === "runtime.error" && /policy-denied/.test(String(event.summary))),
    "journal has no runtime.error(policy-denied) row for the overreach run",
  );
  /* 诊断面：policyDecisions observed=true，allow + deny 决定的脱敏投影。 */
  const diag = await api(sc.port, "GET", tpPath("diagnostics"));
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
  /* 探针树 SSE 流使命完成（重启阶段前显式关闭）。 */
  await tp.sse.close();
  return {
    detail:
      "denial provenance visible across the product surface: SSE denied phase (locked key set) + journal tool.decision/runtime.error rows + diagnostics observed decisions; no paths/params leaked",
  };
}

/** canary 内容绝不进入任何会话文件（agent 目录 + 数据目录全树扫描）。 */
async function stepToolPolicyCanaryNeverRead() {
  const tp = sc.toolPolicy;
  assert(tp.canaryToken !== null, "scenario wiring: canary token missing (see A5-product-tool-policy)");
  assert(tp.agentDir !== null, "scenario wiring: controlled agent dir missing (see A5-product-tool-policy)");
  const scanned = new Map();
  const unreadable = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !scanned.has(path)) {
        try {
          scanned.set(path, readFileSync(path, "utf8"));
        } catch {
          unreadable.push(path);
        }
      }
    }
  };
  walk(tp.agentDir);
  walk(sc.dataDir);
  assert(unreadable.length === 0, `files could not be scanned for the canary: ${unreadable.join(", ")}`);
  assert(scanned.size > 0, "no files found under the controlled agent dir or the data dir to scan");
  /* canary 文件本身就在扫描范围内（位于数据目录 workspace 内）——排除
     自身（物理路径比对），只断言其内容不「扩散」到其他任何文件。 */
  const canaryPhysical = physicalPath(tp.canaryPath) ?? tp.canaryPath;
  const leaks = [...scanned.entries()].filter(([path, text]) => {
    if ((physicalPath(path) ?? path) === canaryPhysical) return false;
    return text.includes(tp.canaryToken);
  });
  assert(
    leaks.length === 0,
    `canary content materialized in ${String(leaks.length)} file(s) under the controlled agent dir / data dir — the denied read must never execute`,
  );
  return {
    detail: `${String(scanned.size)} files scanned (controlled agent dir + data dir incl. sessions/journal/DB): canary content never materialized`,
  };
}

async function phaseSse() {
  await runCheck("sse-event-surface", async () => {
    assert(sc.sse !== null, "scenario wiring: SSE stream missing");
    await sc.sse.drain();
    const frames = sc.sse.frames;
    const snapshots = frames.filter((frame) => frame.event === "snapshot");
    const started = frames.filter((frame) => frame.event === "run-started");
    const terminal = frames.filter((frame) => frame.event === "run-terminal");
    const deltas = frames.filter((frame) => frame.event === "message-delta");
    const aborts = frames.filter((frame) => frame.event === "abort-requested");
    const tools = frames.filter((frame) => frame.event === "tool-activity");
    /* A5 产品面场景在独立探针树上运行——主树计数与无工具基线一致。 */
    const expectedRuns = MODE === "echo-selftest" ? 9 : 7;
    assert(snapshots.length === 1, `expected exactly one snapshot frame (got ${String(snapshots.length)})`);
    assert(snapshots[0].data?.treeId === sc.treeId, "snapshot frame is not for this tree");
    assert(started.length === expectedRuns, `expected ${String(expectedRuns)} run-started frames (got ${String(started.length)})`);
    assert(terminal.length === expectedRuns, `expected ${String(expectedRuns)} run-terminal frames (got ${String(terminal.length)})`);
    const stateMix = {};
    for (const frame of terminal) {
      const state = frame.data?.state;
      assert(typeof state === "string", "run-terminal frame without a state");
      stateMix[state] = (stateMix[state] ?? 0) + 1;
      assert(frame.data?.treeId === sc.treeId, "run-terminal frame for a different tree");
    }
    const expectedMix = MODE === "echo-selftest" ? { succeeded: 8, failed: 1 } : { succeeded: 7 };
    for (const [state, count] of Object.entries(expectedMix)) {
      assert((stateMix[state] ?? 0) === count, `run-terminal state mix: ${state} x ${String(stateMix[state] ?? 0)} (expected ${String(count)})`);
    }
    if (MODE === "echo-selftest") {
      assert(deltas.length === 16, `expected 16 message-delta frames (2 per echo answer; got ${String(deltas.length)})`);
    } else {
      /* 每个成功 run 至少一个文本增量（real-pi 主树 7 个 run 全部成功）。 */
      assert(deltas.length >= 7, `expected >= 7 message-delta frames (got ${String(deltas.length)})`);
    }
    assert(aborts.length === 0, "unexpected abort-requested frames");
    /* 两段式结构：SSE 流覆盖零工具引导——不可能出现 tool-activity 帧
       （工具缝仅在 A5 阶段的第二次引导出现；其帧面由 A5 检查在探针树
       上断言）。 */
    assert(tools.length === 0, "unexpected tool-activity frames (the scenario runs on a zero-tools boot)");
    const startedIds = new Set(started.map((frame) => frame.data?.runId));
    const terminalIds = new Set(terminal.map((frame) => frame.data?.runId));
    assert(startedIds.size === expectedRuns && terminalIds.size === expectedRuns, "duplicate run ids in SSE frames");
    const missing = [...sc.runIds].filter((id) => !startedIds.has(id));
    assert(missing.length === 0, `runs missing from the SSE stream: ${missing.join(", ")}`);
    const extra = [...startedIds].filter((id) => !sc.runIds.has(id));
    assert(extra.length === 0, `unknown runs in the SSE stream: ${extra.join(", ")}`);
    await sc.sse.close();
    return {
      detail: `${String(started.length)} run-started / ${String(terminal.length)} run-terminal (mix ${JSON.stringify(stateMix)}) / ${String(deltas.length)} message-delta / 0 abort`,
    };
  });
}

async function phaseDiagnostics() {
  await runCheck("diagnostics-projection", async () => {
    const diag = await api(sc.port, "GET", treePath("diagnostics"));
    assert(diag.status === 200, `diagnostics failed: ${errDetail(diag)}`);
    const body = diag.body;
    assert(body?.runtimeState === "idle", `runtimeState is ${String(body?.runtimeState)} (expected idle at rest)`);
    assert(body?.activeRun === null, "activeRun is not null at rest");
    /* A5 产品面场景在独立探针树上运行——主树计数与无工具基线一致。 */
    const expectedRuns = MODE === "echo-selftest" ? 9 : 7;
    assert(body?.runs?.length === expectedRuns, `diagnostics lists ${String(body?.runs?.length)} runs (expected ${String(expectedRuns)})`);
    const stateMix = {};
    for (const run of body.runs) {
      const keys = Object.keys(run).sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(RUN_ROW_KEYS),
        `run row key set mismatch: ${JSON.stringify(keys)}`,
      );
      stateMix[run.state] = (stateMix[run.state] ?? 0) + 1;
      assert(run.terminalAt !== null, `run ${String(run.runId)} has no terminalAt`);
      if (run.state !== "failed") assert(run.failure === null, `non-failed run ${String(run.runId)} carries a failure`);
    }
    const expectedMix = MODE === "echo-selftest" ? { succeeded: 8, failed: 1 } : { succeeded: 7 };
    for (const [state, count] of Object.entries(expectedMix)) {
      assert((stateMix[state] ?? 0) === count, `run state mix: ${state} x ${String(stateMix[state] ?? 0)} (expected ${String(count)})`);
    }
    if (MODE === "echo-selftest") {
      const failedRun = body.runs.find((run) => run.state === "failed");
      assert(failedRun?.failure?.code === "upstream", "failed run code is not upstream");
      assert(
        JSON.stringify(Object.keys(failedRun.failure).sort()) === JSON.stringify(["code", "message"]),
        "failure projection key set mismatch",
      );
    }
    /* 两段式结构：诊断面在零工具引导上读取——observed 必须如实为 false
      （工具面观测在 A5 阶段的探针树诊断上断言）。 */
    assert(body?.policyDecisions?.observed === false, "policyDecisions.observed must be false (zero-tools boot)");
    assert(typeof body?.policyDecisions?.reason === "string" && body.policyDecisions.reason.length > 0, "policyDecisions.reason missing");
    return { detail: `safe projection verified for ${String(body.runs.length)} runs; policy note honest for this wiring` };
  });
}

async function phaseJournal() {
  await runCheck("journal-no-leak", async () => {
    const res = await api(sc.port, "GET", `${treePath("journal")}?limit=500`);
    assert(res.status === 200, `journal endpoint failed: ${errDetail(res)}`);
    const events = res.body?.events;
    assert(Array.isArray(events), "journal response has no events array");
    const minimum = MODE === "echo-selftest" ? 50 : 10;
    assert(events.length >= minimum, `journal lists only ${String(events.length)} events (expected >= ${String(minimum)})`);
    const blob = [];
    for (const event of events) {
      const keys = Object.keys(event).sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(JOURNAL_EVENT_KEYS),
        `journal event key set mismatch: ${JSON.stringify(keys)}`,
      );
      assert(typeof event.summary === "string" && event.summary.length > 0, "journal event without a summary");
      blob.push(`${String(event.type)} ${event.summary}`);
    }
    const text = blob.join("\n");
    /* 两段式结构：journal 检查在零工具引导、A5 阶段之前读取——主树
       journal 不含任何 A5 场景内容（探针树 journal 的 canary/marker 扫描
       由 A5-product-tool-policy-deny-provenance 在探针树上执行）。 */
    for (const canary of CANARIES) {
      assert(!containsIgnoreCase(text, canary), `journal projection leaks the scenario canary '${canary}'`);
    }
    return { detail: `${String(events.length)} journal events, whitelist key set exact, no scenario canary leakage` };
  });
}

async function phaseRestart() {
  await runCheck("restart-persistence", async () => {
    /* 重启前的权威状态快照。 */
    const pre = await fetchState();
    const preCounts = {
      [sc.trunkId]: turnCount(pre, sc.trunkId),
      [sc.branchA]: turnCount(pre, sc.branchA),
      [sc.branchB]: turnCount(pre, sc.branchB),
    };
    /* A5 场景在独立探针树上运行——主树回合数与无工具基线一致。 */
    const expectedPre =
      MODE === "echo-selftest"
        ? { trunk: 7, branchA: 4, branchB: 6 }
        : { trunk: 7, branchA: 4, branchB: 4 };
    assert(preCounts[sc.trunkId] === expectedPre.trunk, `pre-restart trunk turns ${String(preCounts[sc.trunkId])} (expected ${String(expectedPre.trunk)})`);
    assert(preCounts[sc.branchA] === expectedPre.branchA, `pre-restart branch A turns ${String(preCounts[sc.branchA])}`);
    assert(preCounts[sc.branchB] === expectedPre.branchB, `pre-restart branch B turns ${String(preCounts[sc.branchB])}`);
    const preBranchIds = pre.branches.map((view) => view.branch.id).sort();

    /* 宿主重启（kill -9，无优雅关闭）→ 同数据目录重启。 */
    const first = sc.studios[0];
    first.child.kill("SIGKILL");
    await waitForExit(first.child, 10_000);
    const second = await startStudio(sc.dataDir);
    sc.studios.push(second);
    sc.port = second.port;

    const listed = await api(sc.port, "GET", "/api/trees");
    /* A5 探针树随数据目录一同落库——重启后树列表 = 主树 + （A5 运行过的）
       探针树，逐棵对照 ID 而非只数数量。 */
    const expectedTreeIds = [sc.treeId, ...(sc.toolPolicy.treeId !== null ? [sc.toolPolicy.treeId] : [])].sort();
    const listedIds = (listed.body?.trees ?? []).map((tree) => tree.id).sort();
    assert(
      listed.status === 200 && JSON.stringify(listedIds) === JSON.stringify(expectedTreeIds),
      `tree list after restart is ${JSON.stringify(listedIds)} (expected ${JSON.stringify(expectedTreeIds)})`,
    );
    assert(listedIds.includes(sc.treeId), "the scenario tree did not survive the restart");

    const post = await fetchState();
    assert(post.trunkBranchId === sc.trunkId, "trunkBranchId changed across the restart");
    assert(post.branches.length === 3, `branch count after restart is ${String(post.branches.length)}`);
    const postBranchIds = post.branches.map((view) => view.branch.id).sort();
    assert(JSON.stringify(postBranchIds) === JSON.stringify(preBranchIds), "branch ids changed across the restart");
    for (const view of post.branches) {
      assert(view.sessionAvailability === "available", `branch ${String(view.branch.id)} sessionAvailability is ${String(view.sessionAvailability)} after restart`);
    }
    for (const [branchId, count] of Object.entries(preCounts)) {
      assert(turnCount(post, branchId) === count, `turn count for ${branchId} changed across the restart`);
    }
    assert(JSON.stringify(post.cursor) === JSON.stringify(pre.cursor), "cursor (persisted navigation) changed across the restart");

    /* 重启后主干续聊（restoreSession 路径）。 */
    const t4 = await promptOk(sc.trunkId, SCENARIO.t4);
    sc.answers.t4 = t4.outcome.assistantTurn.text;
    if (MODE === "echo-selftest") {
      assertEchoMode(sc.answers.t4, echoAnswer(SCENARIO.t1, SCENARIO.t2, sc.composedT3, SCENARIO.t4), "post-restart trunk turn");
    } else {
      assertContainsMarkers(sc.answers.t4, ["maple", "4127", "aspen"], "post-restart trunk answer");
      assertAbsentMarkers(sc.answers.t4, ["cedar", "birch"], "post-restart trunk answer");
    }
    const diag = await api(sc.port, "GET", treePath("diagnostics"));
    assert(diag.body?.runtimeState === "idle", "runtimeState is not idle after the restart prompt");
    for (const run of diag.body?.runs ?? []) {
      assert(run.terminalAt !== null, `run ${String(run.runId)} is not terminal after the restart`);
    }
    return { detail: "SIGKILL + same-data restart: tree/branches/turns/cursor intact; trunk continuation works" };
  });
}

async function phaseAbort() {
  await runCheck("mid-flight-abort", async () => {
    const trunkTurnsBefore = turnCount(await fetchState(), sc.trunkId);
    /* 发起长生成但不等待；轮询诊断面直到 streaming。 */
    const essayPromise = api(
      sc.port,
      "POST",
      treePath("prompt"),
      { branchId: sc.trunkId, text: SCENARIO.abortEssay },
      CLI.promptTimeoutMs + 30_000,
    ).catch((err) => ({
      status: -1,
      body: { error: { code: "fetch-error", message: String(err instanceof Error ? err.message : err) } },
    }));
    let activeRunId = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const diag = await api(sc.port, "GET", treePath("diagnostics"), undefined, 5_000);
      if (diag.body?.runtimeState === "streaming" && diag.body?.activeRun?.runId !== undefined) {
        activeRunId = diag.body.activeRun.runId;
        break;
      }
      await sleep(150);
    }
    assert(activeRunId !== null, "never observed the in-flight run in the streaming state (model settled too fast?)");
    const abortRes = await api(
      sc.port,
      "POST",
      `/api/trees/${encodeURIComponent(sc.treeId)}/runs/${encodeURIComponent(activeRunId)}/abort`,
    );
    assert(abortRes.status === 200 && abortRes.body?.ok === true, `abort request failed: ${errDetail(abortRes)}`);
    const essay = await essayPromise;
    assert(essay.status === 409, `aborted prompt must settle as 409 (got ${String(essay.status)})`);
    assert(essay.body?.error?.code === "user-abort", `aborted prompt code is ${String(essay.body?.error?.code)} (expected user-abort)`);
    const diag = await api(sc.port, "GET", treePath("diagnostics"));
    assert(diag.body?.runtimeState === "idle", "runtimeState is not idle after the abort");
    const abortedRun = (diag.body?.runs ?? []).find((run) => run.runId === activeRunId);
    assert(abortedRun?.state === "aborted", `aborted run state is ${String(abortedRun?.state)}`);
    assert(abortedRun.failure === null, "an aborted run must not carry a failure (user-abort is not a failure)");
    const turnsAfterAbort = turnCount(await fetchState(), sc.trunkId);
    assert(turnsAfterAbort === trunkTurnsBefore, "an aborted prompt must persist no turns");
    /* 中止后的恢复：同一主干续聊可用。 */
    const recovery = await promptOk(sc.trunkId, SCENARIO.abortRecovered);
    const turnsAfterRecovery = turnCount(await fetchState(), sc.trunkId);
    assert(turnsAfterRecovery === trunkTurnsBefore + 2, "recovery prompt did not persist its turn pair");
    return {
      detail: `in-flight run ${String(activeRunId).slice(0, 12)}… aborted (409 user-abort, no turns); trunk usable again afterwards`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

try {
  CLI = parseCli(process.argv.slice(2));
} catch (err) {
  console.error(`${SCRIPT_NAME}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (CLI.help) {
  console.log(USAGE);
  console.log("");
  console.log("modes:");
  console.log("  echo-selftest  offline deterministic echo driver (default; zero credentials)");
  console.log("  real-pi        real Pi driver via the studio CLI (owner-run; env-injected key)");
  console.log("");
  console.log("real-pi tool gate (optional; forwarded verbatim to the studio CLI):");
  console.log("  --pi-tools TOOL,TOOL          Pi tool allowlist (e.g. 'read'); wires the request-time policy gate");
  console.log("  --policy-read-roots DIR,DIR   ToolPolicy read roots (requires --pi-tools; defaults to the --data workspace)");
  console.log("  the A5 product tool-policy phase runs only in real-pi mode with 'read' enabled");
  console.log("  (--pi-tools is a usage error in echo mode: the echo driver has no tool executor)");
  console.log("");
  console.log("examples:");
  console.log("  node scripts/run-d3-real-pi.mjs --mode echo-selftest");
  console.log(`  TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi \\`);
  console.log("      --provider deepseek --model deepseek-flash");
  console.log(`  TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi \\`);
  console.log("      --provider deepseek --model deepseek-flash --pi-tools read");
  process.exit(0);
}

MODE = CLI.mode;

main().catch((err) => {
  console.error(`[${SCRIPT_NAME}] VERIFIER_ERROR: ${stripSecret(err instanceof Error ? err.stack ?? err.message : String(err))}`);
  process.exit(1);
});
