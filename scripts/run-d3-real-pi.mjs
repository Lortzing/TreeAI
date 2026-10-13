#!/usr/bin/env node
import { createApiFixtures } from "./d3/api-fixtures.mjs";
import { createApiProjections } from "./d3/api-projections.mjs";
import { createApiCli } from "./d3/api-cli.mjs";
import { createApiHost } from "./d3/api-host.mjs";
import { createApiExploration } from "./d3/api-exploration.mjs";
import { createApiObservation } from "./d3/api-observation.mjs";
import { createApiToolDeny } from "./d3/api-tool-deny.mjs";
import { createApiToolSetup } from "./d3/api-tool-setup.mjs";
import { createApiModelError } from "./d3/api-model-error.mjs";
import { createApiConversation } from "./d3/api-conversation.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 *   - 模型错误收敛（echo 模式经 /fail 确定性注入；real-pi 模式经「错误
 *     配置 registry」注入——20260929T104445Z-faults-model-error.md 已证
 *     手法的跑批器化：受控 agent 目录副本仅把 provider baseUrl 改为不可
 *     路由回环地址，错误 prompt 502/Run failed/零回合；换回原目录重启
 *     同一数据目录后同树恢复续聊；独立探针树，主树基线计数不受影响）；
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "run-d3-real-pi";
const VERSION = "1.2.0";
const STUDIO_ENTRY = join(ROOT, "apps", "studio", "src", "index.ts");
/** 真实 Pi 驱动的 API key 环境变量（日志中只允许出现该名字）。 */
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const MODES = ["echo-selftest", "real-pi"];
/** 模型错误注入的不可路由 provider baseUrl（回环 9 端口 = discard：
 *  连接立即被拒，绝不产生真实 provider 请求；镜像
 *  evidence/d3/real-pi/20260929T104445Z-faults-model-error.md 的已证手法）。 */
const MISCONFIG_BASE_URL = "http://127.0.0.1:9/";
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
const apiFixtures = createApiFixtures({
  get MODES() { return MODES; },
});
const { CHECK_DEFS, SCENARIO, RUN_ROW_KEYS, JOURNAL_EVENT_KEYS, CANARIES } = apiFixtures;

const apiCli = createApiCli({
  get DEFAULT_PROMPT_TIMEOUT_MS() { return DEFAULT_PROMPT_TIMEOUT_MS; },
  get USAGE() { return USAGE; },
  get MODES() { return MODES; },
});
const { parseCli } = apiCli;

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
const apiHost = createApiHost({
  get STUDIO_ENTRY() { return STUDIO_ENTRY; },
  get CLI() { return CLI; },
  get ROOT() { return ROOT; },
  get BOOT_TIMEOUT_MS() { return BOOT_TIMEOUT_MS; },
  get truncate() { return truncate; },
  get stripSecret() { return stripSecret; },
  get sleep() { return sleep; },
  get GET_TIMEOUT_MS() { return GET_TIMEOUT_MS; },
});
const { api, errDetail, stopStudio, startStudio, openSse, waitForExit } = apiHost;

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
  /* a2/b2 prompt 的 session 文件引用（真实模式 no-context-bleed 的
     parentId 路径证明用；echo 模式维持答案面断言，不使用）。 */
  a2SessionFile: null,
  b2SessionFile: null,
  runIds: new Set(),
  failedRunId: null,
  composedT3: null,
  /* A5 产品面 ToolPolicy 场景状态（main() 初始化；echo 模式 applicable
     恒 false，各检查按门控 NOT_RUN）。 */
  toolPolicy: null,
  /* 模型错误注入阶段的错误配置 agent 目录副本（cleanup 处置；
     null = 未创建）。 */
  misconfigAgentDir: null,
};
const apiProjections = createApiProjections({
  get sc() { return sc; },
  get assert() { return assert; },
  get api() { return api; },
  get errDetail() { return errDetail; },
  get CLI() { return CLI; },
  get MODE() { return MODE; },
  get truncate() { return truncate; },
  get containsIgnoreCase() { return containsIgnoreCase; },
});
const { treePath, promptOk, assertEchoMode, fetchState, turnCount, selectionOf, branchView, assertContainsMarkers, assertAbsentMarkers, sessionEntryPathText, returnTurns, tpPath, tpFetchState } = apiProjections;

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
    /* 模型错误检查的双时序：echo 模式在此处经 /fail 钩子注入主树（主树
       SSE/诊断计数把它算作第 9 个 run，见 phaseSse/phaseDiagnostics 的
       echo 期望值）；real-pi 模式改为错误配置 registry 的重启舞步，
       为不扰动其后 SSE/诊断/journal/重启/中止检查的主树基线计数，
       挪到 phaseAbort 之后、A5 之前执行（独立探针树，镜像 A5 的两段式
       结构——见 phaseModelError 的 real-pi 分支）。 */
    if (MODE === "echo-selftest") {
      await phaseModelError();
    }
    /* 两段式结构：SSE/诊断/journal/重启/中止检查全部在零工具引导上完成
       （主树计数 = 无工具基线，不受工具面方差影响）；A5 工具面场景在
       其后以工具引导重启同一数据目录运行。 */
    await phaseSse();
    await phaseDiagnostics();
    await phaseJournal();
    await phaseRestart();
    await phaseNewExploration();
    await phaseAbort();
    if (MODE === "real-pi") {
      await phaseModelError();
    }
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
  /* 错误配置 registry 副本（模型错误注入用，位于系统临时目录、数据目录
     之外）：绿色运行后删除；失败保留供取证（与 data dir 同一 keep 语义）。 */
  if (sc.misconfigAgentDir !== null) {
    if (keep) {
      console.log(`misconfigured agent-dir copy kept for inspection: ${sc.misconfigAgentDir}`);
    } else {
      rmSync(sc.misconfigAgentDir, { recursive: true, force: true });
    }
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
const apiConversation = createApiConversation({
  get runCheck() { return runCheck; },
  get startStudio() { return startStudio; },
  get sc() { return sc; },
  get api() { return api; },
  get assert() { return assert; },
  get errDetail() { return errDetail; },
  get MODE() { return MODE; },
  get truncate() { return truncate; },
  get stripSecret() { return stripSecret; },
  get PI_API_KEY_ENV() { return PI_API_KEY_ENV; },
  get booted() { return booted; },
  set booted(value) { booted = value; },
  get openSse() { return openSse; },
  get treePath() { return treePath; },
  get promptOk() { return promptOk; },
  get SCENARIO() { return SCENARIO; },
  get assertEchoMode() { return assertEchoMode; },
  get echoAnswer() { return echoAnswer; },
  get fetchState() { return fetchState; },
  get turnCount() { return turnCount; },
  get selectionOf() { return selectionOf; },
  get branchView() { return branchView; },
  get assertContainsMarkers() { return assertContainsMarkers; },
  get assertAbsentMarkers() { return assertAbsentMarkers; },
  get sessionEntryPathText() { return sessionEntryPathText; },
  get returnTurns() { return returnTurns; },
});
const { phaseBoot, phaseTrunk, phaseBranchA, phaseSwitch, phaseBranchB, phaseNoBleed, phaseAnchorReveal, phaseReturn } = apiConversation;
const apiModelError = createApiModelError({
  get runCheck() { return runCheck; },
  get MODE() { return MODE; },
  get turnCount() { return turnCount; },
  get fetchState() { return fetchState; },
  get sc() { return sc; },
  get api() { return api; },
  get treePath() { return treePath; },
  get SCENARIO() { return SCENARIO; },
  get CLI() { return CLI; },
  get assert() { return assert; },
  get promptOk() { return promptOk; },
  get assertEchoMode() { return assertEchoMode; },
  get echoAnswer() { return echoAnswer; },
  get stripSecret() { return stripSecret; },
  get MISCONFIG_BASE_URL() { return MISCONFIG_BASE_URL; },
  get waitForExit() { return waitForExit; },
  get startStudio() { return startStudio; },
  get errDetail() { return errDetail; },
});
const { phaseModelError } = apiModelError;
const apiToolSetup = createApiToolSetup({
  get runCheck() { return runCheck; },
  get sc() { return sc; },
  get waitForExit() { return waitForExit; },
  get startStudio() { return startStudio; },
  get stripSecret() { return stripSecret; },
  get stepToolPolicyDenyFailClosed() { return stepToolPolicyDenyFailClosed; },
  get stepToolPolicyDenyProvenance() { return stepToolPolicyDenyProvenance; },
  get stepToolPolicyCanaryNeverRead() { return stepToolPolicyCanaryNeverRead; },
  get assert() { return assert; },
  get CLI() { return CLI; },
  get physicalPath() { return physicalPath; },
  get isPathWithin() { return isPathWithin; },
  get api() { return api; },
  get errDetail() { return errDetail; },
  get openSse() { return openSse; },
  get tpPath() { return tpPath; },
  get assertContainsMarkers() { return assertContainsMarkers; },
});
const { phaseProductToolPolicy } = apiToolSetup;
const apiToolDeny = createApiToolDeny({
  get sc() { return sc; },
  get assert() { return assert; },
  get turnCount() { return turnCount; },
  get tpFetchState() { return tpFetchState; },
  get api() { return api; },
  get tpPath() { return tpPath; },
  get CLI() { return CLI; },
  get truncate() { return truncate; },
  get containsIgnoreCase() { return containsIgnoreCase; },
  get physicalPath() { return physicalPath; },
});
const { stepToolPolicyDenyFailClosed, stepToolPolicyDenyProvenance, stepToolPolicyCanaryNeverRead } = apiToolDeny;
const apiObservation = createApiObservation({
  get runCheck() { return runCheck; },
  get assert() { return assert; },
  get sc() { return sc; },
  get MODE() { return MODE; },
  get api() { return api; },
  get treePath() { return treePath; },
  get errDetail() { return errDetail; },
  get RUN_ROW_KEYS() { return RUN_ROW_KEYS; },
  get JOURNAL_EVENT_KEYS() { return JOURNAL_EVENT_KEYS; },
  get CANARIES() { return CANARIES; },
  get containsIgnoreCase() { return containsIgnoreCase; },
  get fetchState() { return fetchState; },
  get turnCount() { return turnCount; },
  get waitForExit() { return waitForExit; },
  get startStudio() { return startStudio; },
  get promptOk() { return promptOk; },
  get SCENARIO() { return SCENARIO; },
  get assertEchoMode() { return assertEchoMode; },
  get echoAnswer() { return echoAnswer; },
  get assertContainsMarkers() { return assertContainsMarkers; },
  get assertAbsentMarkers() { return assertAbsentMarkers; },
});
const { phaseSse, phaseDiagnostics, phaseJournal, phaseRestart } = apiObservation;
const apiExploration = createApiExploration({
  get runCheck() { return runCheck; },
  get fetchState() { return fetchState; },
  get turnCount() { return turnCount; },
  get api() { return api; },
  get sc() { return sc; },
  get assert() { return assert; },
  get errDetail() { return errDetail; },
  get waitForExit() { return waitForExit; },
  get startStudio() { return startStudio; },
  get treePath() { return treePath; },
  get SCENARIO() { return SCENARIO; },
  get CLI() { return CLI; },
  get sleep() { return sleep; },
  get promptOk() { return promptOk; },
});
const { phaseNewExploration, phaseAbort } = apiExploration;

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
