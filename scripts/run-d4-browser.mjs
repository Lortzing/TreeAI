#!/usr/bin/env node
import { createD4Reporting } from "./d4/browser/reporting.mjs";
import { createChromeHost } from "./d4/browser/chrome-host.mjs";
/**
 * run-d4-browser — TreeAI D4 浏览器验收入口（issue #8 §8）。
 *
 * 驱动真实 headless Chromium（CDP，零 npm 依赖）与真实 Studio 进程，
 * 沿 D4 用户路径（导入→选文探索→Return→重启→搜索找回）执行检查。
 * D4-0 落骨架（boot/页面装载真实检查）；D4-2 前端落地后（v0.2.0）材料
 * 路径的浏览器检查翻绿（探针实现见 scripts/d4/browser/material-probes.mjs，
 * 冻结真值取 tests/fixtures/d4/ 的 B1/B2 冻结集）：
 *   - d4-import-material：B1 冻结 fixture 经真实 HTTP API 导入（D4-1 契约
 *     面；导入 UI 属后续增量）→ 真实 UI 侧栏 Materials 列表逐条 ready +
 *     种类/版本标签；
 *   - d4-import-denominator：B1 全分母（owner 2026-09-30 增量验收）——
 *     12 markdown + 12 文字层 PDF 全部经真实导入 API 到达 ready 且与冻结
 *     canonicalText/块图逐字节全等（分页块读取面）；8 文件负例 + 3 超限
 *     负例（manifest 配方确定性生成）如实拒绝（门拒绝零持久化 / 终态
 *     failed 携冻结原因码，读取 409）；真实侧栏逐条呈现对账；
 *   - d4-read-and-select：真实 UI 打开阅读器 → 分块懒加载 → 真实 DOM 选区
 *     （selectionchange/mouseup 武装路径 + 真实鼠标拖选 + 真实连续拖选
 *     press→move×N→release）→ 捕获载荷
 *     与 B2 冻结真值逐项全等（blockId/UTF-16 区间/摘录；含字素吸附、
 *     跨块拒绝、重复词第 N 次出现）→ resolve-selection 服务端复核（含
 *     sourceHash === SHA-256(冻结 canonicalText)）→ 复制摘录不变；
 *   - d4-restart-continue：阅读位置经阅读器自身保存路径落库 → 停止
 *     studio 进程 → 同数据目录新进程 → 重开恢复到原块；
 *   - d4-export-restore-recover（B5）：D4-5 CLI 导出（缺省不含 session）
 *     → 恢复到全新空数据目录 → 恢复目录上全新 studio 进程 → 真实浏览器
 *     阅读恢复材料 / 侧栏 Search 找回复原事实（来源跳转）/ session 未存
 *     活分支的显式新探索换轨。
 * v0.4.0（最终波浏览器证据）：
 *   - d4-branch-from-material / d4-return-from-material（B3 用户路径，
 *     b3-probes.mjs）：real-pi 执行完整 charter 路径（md+pdf 武装选区 →
 *     建枝 → 提交前材料范围声明 → 真实 Pi 首问（双击不重复派发 / 响应
 *     丢失同键重试诚实——CDP Fetch 域 Response 阶段丢弃，服务端已落地）
 *     → ≥2 轮追问 → 跨枝隔离 → 重启续走 → 回原文（精确摘录+定位）→
 *     Return 携材料来源卡）；selftest 为同一 UI 流程的 echo 冒烟（机制
 *     可达性证明，detail/sidecar 如实标注「不是 B3 证据」）；
 *   - d4-nav-browser（B9 浏览器面，nav-probes.mjs）：B9 数据集真实生成/
 *     装载入专用目录 → 真实浏览器度量（b9-big 初开 ≤2s、≥50 次脚本化
 *     展开/切换 p95 ≤300ms、虚拟化 DOM 有界、键盘逐层+焦点跨窗口保持、
 *     展开状态跨真实进程重启、结构真值抽样对照）；
 *   - d4-b6-scale-browser（B6 浏览器面，scale-probes.mjs）：B6 规模特产
 *     真实生成/装载 → 真实浏览器度量（30 次现有材料打开至可读 p95 ≤2s、
 *     翻页无 >200ms 主线程段（longtask+步延迟）、翻阅中键入
 *     keystroke-to-render、10MiB 样例真实导入 UI 取消、搜索命中渲染证据）。
 *     本地机器工程证据（环境/并发如实入 sidecar），不跨机器宣称。
 * v0.5.0（B7 自动部分）：
 *   - d4-beta-usability（beta-usability-probes.mjs）：B7「Beta 可用性」的
 *     自动可执行面——README 干净环境启动（argv/entry/flags 与 README +
 *     package.json start 对账；首启空状态诚实 + 建树流程真实可用）、宽窄
 *     两档视口（≥1440px 与 ~390×844 mobile：侧栏/阅读器/支线面板可用、
 *     无横向溢出、捕获条可达、关键控件 elementFromPoint 命中）、键盘
 *     （Tab 遍历至主要控件 + Enter/Space 激活 + Escape 分层关闭含焦点
 *     还原 + 焦点样式可见 + 阅读器方向键滚动 + 无焦点陷阱）、触屏模拟
 *     （CDP Input.dispatchTouchEvent：tap/swipe/文本层拖选武装捕获条
 *     （selectionchange 触路径）/tap 工具条按钮剪贴板回读）、reduced-
 *     motion（matchMedia 生效 + 定位跳转/贴底跟随即时落位）、焦点/滚动/
 *     草稿会话内回程（草稿保留 + 焦点还原 + 面板滚动保留 + 阅读器经
 *     自身保存/恢复路径回到关闭位置）。selftest=echo 驱动（机制证据）；
 *     real-pi=真实 Pi 回答。Mac 签收与 3–5 人试用属负责人 D4-G3 人工
 *     序列——本检查 PASS 不构成 B7 全过。
 * v0.6.0（issue #7 术语半边，下一步 2）：
 *   - terminology-path（terminology-probes.mjs；**无 d4- 前缀——issue #7
 *     术语工作、非 D4 工作包，verify:d4 不审计本行**）：术语①②③的真实
 *     浏览器 + 真实 Pi 纵向路径——阅读模式三选一真实切换（PUT 载荷传输层
 *     观测 + 服务端回读）、gate 未过如实旁注、manual-only/minimal-hints
 *     回答后零自动派发（服务端任务/usage/建议集零 + 隔离执行器 sessions
 *     零文件）；term/range 两模式真实拖选武装 → 解释卡 → 保存批注 →
 *     推广建枝（双击恰一次派发 / 响应丢失 → 刷新揭示既有推广 → 恢复，
 *     恰一条首问）→ ≥2 轮追问 → Return（术语来源卡：摘录/保存时间/
 *     来源分支）→ SIGTERM 重启 → 历史/批注可读 + 续走 → 已有探索恢复 +
 *     显式另开；③前端不变量（选择期间不重绘/复制不变/宽 1600 窄 390/
 *     焦点-滚动-草稿回程）。专用临时数据目录，selftest=echo / real-pi=
 *     真实 Pi（echo 如实标注不是真实 Pi 证据）。
 * 未落地项保持 NOT_RUN + 原因（owner 写明）——绝不静默省略，也不把
 * NOT_RUN 计为通过。
 *
 * 退出码（沿用 D2/D3 冻结语义）：
 *   0 — 所选模式全部检查 PASS
 *   1 — 工具自身错误
 *   2 — 至少一个 FAIL
 *   3 — 无 FAIL 但存在 BLOCKED / NOT_RUN
 *
 * 用法（帮助文本即契约：浏览器路径、数据目录与受控 provider/model/
 * agent-dir 参数在此说明；真实凭据只经 TREEAI_STUDIO_API_KEY 环境注入，
 * 不写进命令、截图或证据）：
 *
 *   node scripts/run-d4-browser.mjs --mode selftest
 *   node scripts/run-d4-browser.mjs --mode real-pi --provider <id> --model <id> \
 *        [--agent-dir <dir>] [--data <dir>] [--artifacts <dir>] \
 *        [--chrome-executable <path>] [--prompt-timeout-ms <ms>] [--keep-data]
 *
 *   --mode selftest        离线确定性 echo 驱动（永远不是真实 Pi 证据）
 *   --mode real-pi         真实 Pi（须设 TREEAI_STUDIO_API_KEY；本脚本只
 *                          检查变量名，从不读取值）
 *   --data <dir>           Studio 数据目录（缺省 mkdtemp；--keep-data 保留）
 *   --artifacts <dir>      截图/summary 落盘目录（缺省 mkdtemp）
 *   --chrome-executable    浏览器可执行文件（缺省按候选列表探测；
 *                          找不到 → BLOCKED + exit 3）
 *   --provider/--model/--agent-dir  受控模型配置（仅 real-pi；agent-dir
 *                          常用 .pi-d2-live 受控注册表）
 *   --prompt-timeout-ms    等待模型回答的最长毫秒数（>=1000）
 *   --help                 打印本说明并退出 0
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseCli, PI_API_KEY_ENV, MODES } from "./d4/browser/cli.mjs";

import {
  probeImportMaterial,
  probeReadAndSelect,
  probeRestartContinue,
  probeSearchRecover,
  probeImportDenominator,
  probeExportRestoreRecover,
} from "./d4/browser/material-probes.mjs";
/* 终波探针（b3/nav/scale）按需动态加载：它们的模块图深达 apps/studio/src
 * （nav→b9-dataset→markdown-parser）与 tests/support（scale→b6 dataset/
 * loader）——静态导入会让 --help（entrypoints-d4 检查）在合成树/精简
 * checkout 里因缺文件而失败。运行对应检查时才加载。 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO_ENTRY = join(ROOT, "apps", "studio", "src", "index.ts");
const D4_FIXTURES_MANIFEST = join(ROOT, "tests", "fixtures", "d4", "MANIFEST.sha256");
const BOOT_TIMEOUT_MS = 60_000;
const GET_TIMEOUT_MS = 15_000;
const VIEWPORT = { width: 1280, height: 900 };

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const CLI = parseCli(process.argv.slice(2));
const MODE = CLI.mode;

/* ------------------------------------------------------------------ */
/* 通用小工具                                                           */
/* ------------------------------------------------------------------ */

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function sanitizeText(text) {
  return text.replaceAll(tmpdir(), "<tmp>").replaceAll(process.env.HOME ?? "", "~");
}

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
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

const { chrome, startChrome, stopChrome, navigate, evalJs, screenshot, sidecar } = createChromeHost({
  cli: CLI, viewport: VIEWPORT, getContext: () => sc, sanitizeText, truncate, sleep,
});

/* ------------------------------------------------------------------ */
/* Studio 进程                                                          */
/* ------------------------------------------------------------------ */

const studio = { child: null, port: 0, exited: false, stdoutRaw: "", stderrRaw: "", lastArgv: null };

function studioArgv(dataDir) {
  const argv = [STUDIO_ENTRY, "--port", String(studio.port), "--data", dataDir];
  if (MODE === "real-pi") {
    argv.push("--driver", "pi", "--provider", CLI.provider, "--model", CLI.model);
    if (CLI.agentDir !== null) argv.push("--agent-dir", CLI.agentDir);
  }
  return argv;
}

async function startStudio(dataDir, opts = {}) {
  studio.exited = false;
  studio.stdoutRaw = "";
  studio.stderrRaw = "";
  const logPath = join(sc.artifactsDir, "studio.log");
  if (opts.appendLog === true) {
    appendArtifact("studio.log", `\n=== studio restart ${new Date().toISOString()} (data dir unchanged) ===\n`);
  } else {
    writeFileSync(logPath, "");
  }
  const argv = studioArgv(dataDir);
  studio.lastArgv = [...argv];
  studio.child = spawn(process.execPath, argv, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  studio.child.stdout.on("data", (chunk) => {
    studio.stdoutRaw += chunk.toString("utf8");
    appendArtifact("studio.log", chunk);
  });
  studio.child.stderr.on("data", (chunk) => {
    studio.stderrRaw += chunk.toString("utf8");
    appendArtifact("studio.log", chunk);
  });
  studio.child.on("exit", () => { studio.exited = true; });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (studio.exited) {
      throw new Error(
        `studio exited during boot (see artifacts studio.log); stderr tail: ${truncate(sanitizeText(studio.stderrRaw), 600)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${String(studio.port)}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body === null || body.ok === true) return;
      }
    } catch { /* 尚未就绪 */ }
    if (Date.now() >= deadline) throw new Error(`studio boot timeout (${String(BOOT_TIMEOUT_MS)}ms)`);
    await sleep(150);
  }
}

function appendArtifact(name, chunk) {
  try {
    const path = join(sc.artifactsDir, name);
    writeFileSync(path, (existsSync(path) ? readFileSync(path) : Buffer.alloc(0)).toString("utf8") + sanitizeText(chunk.toString("utf8")));
  } catch { /* 尽力而为 */ }
}

function killStudio() {
  if (studio.child !== null && !studio.exited) studio.child.kill("SIGKILL");
}

/** 停止 studio 进程（d4-restart-continue 用）：SIGTERM 优雅退出（进程
    自带 graceful shutdown：仓储/journal 落盘）；超时 SIGKILL 兜底。 */
async function stopStudioProcess(timeoutMs = 8000) {
  const child = studio.child;
  if (child === null || studio.exited) return;
  child.kill("SIGTERM");
  const graceful = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!graceful) {
    child.kill("SIGKILL");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref?.();
    });
  }
  studio.exited = true;
}

/** 同数据目录启动全新 studio 进程（新端口；数据目录原样保留）。 */
async function restartStudio(dataDir) {
  return bootStudioOn(dataDir);
}

/** 同数据目录启动全新 studio 进程（新端口；B5 恢复探针在恢复目录上开新进程用——
    sc.dataDir 语义保持指向原始数据目录）。 */
async function bootStudioOn(dataDir) {
  await stopStudioProcess();
  studio.port = await freePort();
  await startStudio(dataDir, { appendLog: true });
  booted = true;
  sc.studioUrl = `http://127.0.0.1:${String(studio.port)}/`;
  return sc.studioUrl;
}

/** 同端口优雅重启（B3 探针用）：SIGTERM 停止后在同一端口起新进程——浏览器
    localStorage 按源（host:port）隔离，挂起意图/来源缓存等浏览器侧状态只在
    同源下存活（真实产品的服务重启即同端口）。端口短暂占用（TIME_WAIT 窗口）
    时重试一次。 */
async function restartStudioSamePort() {
  const port = studio.port;
  await stopStudioProcess();
  for (let attempt = 0; ; attempt += 1) {
    try {
      studio.port = port;
      await startStudio(sc.dataDir, { appendLog: true });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(600);
    }
  }
  booted = true;
  sc.studioUrl = `http://127.0.0.1:${String(studio.port)}/`;
  return sc.studioUrl;
}

/** D4-5 CLI 子进程（export 子命令 / --import-package；不启动服务器，
    完成即退）。stdout/stderr 如实入 artifacts（studio-cli.log）。 */
function runStudioCli(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STUDIO_ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n(treeai harness: studio CLI timed out after ${String(timeoutMs)}ms)`;
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(err.message)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      appendArtifact("studio-cli.log", `\n=== studio CLI ${args.join(" ")} → exit ${String(code)} ===\n${sanitizeText(stdout)}${stderr === "" ? "" : `\n[stderr]\n${sanitizeText(stderr)}`}\n`);
      resolve({ code, stdout: sanitizeText(stdout), stderr: sanitizeText(stderr) });
    });
  });
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
/* 检查登记                                                             */
/* ------------------------------------------------------------------ */

const CHECK_DEFS = [
  { id: "chrome-boot", modes: ["selftest", "real-pi"] },
  { id: "studio-boot", modes: ["selftest", "real-pi"] },
  { id: "page-load", modes: ["selftest", "real-pi"] },
  { id: "console-clean", modes: ["selftest", "real-pi"] },
  /* D4 用户路径：B1/B2 浏览器面已落地（v0.2.0，scripts/d4/browser/）；
     B3 材料 Branch/Return 用户路径探针已实现（v0.4.0，b3-probes.mjs）：
     real-pi 执行完整 charter 路径（真实 Pi 首问/追问/隔离/回原文/Return/
     双击幂等/响应丢失重试/重启续走）；selftest 以 echo 驱动同一 UI 流程
     （机制冒烟，如实标注「不是 B3 证据」）。
     B9 大规模树导航与 B6 规模性能的浏览器面（v0.4.0，nav-probes.mjs /
     scale-probes.mjs）：专用数据目录（真实生成器/装载器）+ 真实浏览器度量。 */
  { id: "d4-import-material", modes: ["selftest", "real-pi"] },
  { id: "d4-import-denominator", modes: ["selftest", "real-pi"] },
  { id: "d4-read-and-select", modes: ["selftest", "real-pi"] },
  { id: "d4-branch-from-material", modes: ["selftest", "real-pi"] },
  { id: "d4-return-from-material", modes: ["selftest", "real-pi"] },
  { id: "d4-restart-continue", modes: ["selftest", "real-pi"] },
  { id: "d4-search-recover", modes: ["selftest", "real-pi"] },
  { id: "d4-export-restore-recover", modes: ["selftest", "real-pi"] },
  { id: "d4-nav-browser", modes: ["selftest", "real-pi"] },
  { id: "d4-b6-scale-browser", modes: ["selftest", "real-pi"] },
  { id: "d4-beta-usability", modes: ["selftest", "real-pi"] },
  /* issue #7 术语半边（下一步 2）：真实浏览器 + 真实 Pi 纵向路径。无 d4-
     前缀（术语工作、非 D4 工作包）——verify:d4 保持既有行结构，本行由
     术语侧独立追踪。专用临时数据目录（bootStudioOn），不依赖共享场景。 */
  { id: "terminology-path", modes: ["selftest", "real-pi"] },
];

const results = [];
const byId = new Map(CHECK_DEFS.map((def) => [def.id, def]));

/* --only 范围门（verify-d4 --only 同款纪律）：boot 检查恒随行（其余检查
   的级联前提）；范围如实入 summary（scoped 标注），绝不冒充全量。 */
const BOOT_ALWAYS_IDS = ["chrome-boot", "studio-boot", "page-load"];
const KNOWN_CHECK_IDS = new Set(CHECK_DEFS.map((def) => def.id));
const UNKNOWN_ONLY = CLI.only.filter((id) => !KNOWN_CHECK_IDS.has(id));
if (UNKNOWN_ONLY.length > 0) {
  console.error(`run-d4-browser error: unknown --only check id(s): ${UNKNOWN_ONLY.join(", ")} (known: ${[...KNOWN_CHECK_IDS].join(", ")})`);
  process.exit(1);
}
const SELECTED_CHECK_IDS = CLI.only.length === 0
  ? CHECK_DEFS.map((def) => def.id)
  : CHECK_DEFS.filter((def) => CLI.only.includes(def.id) || BOOT_ALWAYS_IDS.includes(def.id)).map((def) => def.id);



let booted = false;
let chromeReady = false;

/** 级联 NOT_RUN（探针间依赖未就位）：如实登记原因，不伪装成 FAIL/PASS。 */
class NotRunError extends Error {}







/** 冻结集绑定（evidence/d4/README 规则 5）：引用 tests/fixtures/d4/ 的
    运行记录 MANIFEST.sha256 的 SHA-256（哈希的哈希）。 */




/* ------------------------------------------------------------------ */
/* 场景上下文与主流程                                                    */
/* ------------------------------------------------------------------ */

const sc = { dataDir: null, artifactsDir: null, studioUrl: null, runId: `d4-browser-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${String(process.pid)}` };

/** 材料探针的共享场景状态（探针间传递：树/导入产物；fixturesUsed 供
    summary 的冻结集绑定）。 */
const scenario = { treeId: null, materials: null, fixturesUsed: null };

/** 探针上下文：真实 Chrome（CDP）+ 真实 studio 进程的受控句柄集合。 */
const { report, runCheck, sweepBlocked, gitInfo, fixturesBinding, finish } = createD4Reporting({
  get results() { return results; },
  get truncate() { return truncate; },
  get byId() { return byId; },
  get MODE() { return MODE; },
  get chromeReady() { return chromeReady; },
  get booted() { return booted; },
  get NotRunError() { return NotRunError; },
  get sanitizeText() { return sanitizeText; },
  get CHECK_DEFS() { return CHECK_DEFS; },
  get ROOT() { return ROOT; },
  get scenario() { return scenario; },
  get D4_FIXTURES_MANIFEST() { return D4_FIXTURES_MANIFEST; },
  get sc() { return sc; },
  get CLI() { return CLI; },
  get chrome() { return chrome; },
});

const probeCtx = {
  MODE,
  ROOT,
  NotRunError,
  evalJs,
  navigate,
  screenshot,
  sidecar,
  cdpSend: (method, params, timeoutMs) => chrome.cdp.send(method, params, timeoutMs),
  cdpOn: (method, fn) => chrome.cdp.on(method, fn),
  studioPort: () => studio.port,
  studioOrigin: () => `http://127.0.0.1:${String(studio.port)}`,
  studioUrl: () => sc.studioUrl,
  studioDataDir: () => sc.dataDir,
  studioArgv: () => (studio.lastArgv === null ? null : [...studio.lastArgv]),
  promptTimeoutMs: () => CLI.promptTimeoutMs,
  api,
  stopStudio: () => stopStudioProcess(),
  restartStudio: () => restartStudio(sc.dataDir),
  restartStudioSamePort,
  bootStudioOn,
  runStudioCli,
  pageErrors: () => chrome.pageErrors.slice(),
  clearPageErrors: () => {
    chrome.pageErrors.length = 0;
  },
  scenario,
  noteFixturesUsed: (ids) => {
    /* 并集（探针各自登记使用面；summary 的冻结集绑定如实汇总）。 */
    const merged = new Set([...(scenario.fixturesUsed ?? []), ...ids]);
    scenario.fixturesUsed = [...merged].sort();
  },
};

async function main() {
  sc.dataDir = CLI.dataDir ?? mkdtempSync(join(tmpdir(), "treeai-d4-data-"));
  sc.artifactsDir = CLI.artifactsDir ?? mkdtempSync(join(tmpdir(), "treeai-d4-browser-artifacts-"));
  mkdirSync(sc.artifactsDir, { recursive: true });
  console.log(`run-d4-browser 0.6.0 — mode ${MODE}`);
  console.log(`data: ${sanitizeText(sc.dataDir)}${CLI.keepData ? " (kept)" : ""}`);
  console.log(`artifacts: ${sanitizeText(sc.artifactsDir)}`);

  try {
    await runCheck("chrome-boot", async () => {
      await startChrome();
      chromeReady = true;
      return { detail: `${sanitizeText(chrome.executable)} on 127.0.0.1:${String(chrome.port)}` };
    });

    await runCheck("studio-boot", async () => {
      studio.port = await freePort();
      await startStudio(sc.dataDir);
      booted = true;
      sc.studioUrl = `http://127.0.0.1:${String(studio.port)}/`;
      return { detail: `studio healthy on ${sc.studioUrl}` };
    });

    await runCheck("page-load", async () => {
      if (sc.studioUrl === null) throw new Error("studio url unknown");
      await navigate(sc.studioUrl);
      const ok = await evalJs(
        `(() => { const el = document.querySelector("#tree-view, #empty-state, #new-tree"); return el !== null; })()`,
      );
      if (ok !== true) throw new Error("studio shell did not render (#tree-view/#empty-state/#new-tree absent)");
      await screenshot("studio-shell");
      return { detail: "studio shell rendered in headless Chromium" };
    });

    await runCheck("console-clean", async () => {
      if (chrome.pageErrors.length > 0) {
        throw new Error(`page errors: ${chrome.pageErrors.map((e) => e.text).join(" | ")}`);
      }
      return { detail: "no console/log errors on the studio shell" };
    });

    const inScope = (id) => SELECTED_CHECK_IDS.includes(id);
    if (CLI.only.length > 0) console.log(`scoped to: ${CLI.only.join(", ")} (boot checks always run)`);

    /* D4 材料路径检查（B1/B2 浏览器面，v0.2.0 落地）：真实 Chrome +
       真实 studio 进程上的真实 DOM 检查（echo 驱动，selftest 声明照旧）。
       B3 材料 Branch/Return（v0.4.0）：real-pi 全路径 / selftest echo 冒烟
       （detail/sidecar 如实标注「不是 B3 证据」）。
       B9 导航面 + B6 规模面（v0.4.0）：专用数据目录（真实生成器/装载器）
       上的真实浏览器度量（本地机器工程证据，环境入 sidecar）。 */
    if (inScope("d4-import-material")) await runCheck("d4-import-material", () => probeImportMaterial(probeCtx));
    if (inScope("d4-import-denominator")) await runCheck("d4-import-denominator", () => probeImportDenominator(probeCtx));
    if (inScope("d4-read-and-select")) await runCheck("d4-read-and-select", () => probeReadAndSelect(probeCtx));
    if (inScope("d4-branch-from-material")) {
      await runCheck("d4-branch-from-material", async () => {
        const { probeBranchFromMaterial: run } = await import("./d4/browser/b3-probes.mjs");
        return run(probeCtx);
      });
    }
    if (inScope("d4-return-from-material")) {
      await runCheck("d4-return-from-material", async () => {
        const { probeReturnFromMaterial: run } = await import("./d4/browser/b3-probes.mjs");
        return run(probeCtx);
      });
    }
    if (inScope("d4-restart-continue")) await runCheck("d4-restart-continue", () => probeRestartContinue(probeCtx));
    if (inScope("d4-search-recover")) await runCheck("d4-search-recover", () => probeSearchRecover(probeCtx));
    if (inScope("d4-export-restore-recover")) await runCheck("d4-export-restore-recover", () => probeExportRestoreRecover(probeCtx));
    if (inScope("d4-nav-browser")) {
      await runCheck("d4-nav-browser", async () => {
        const { probeNavBrowser: run } = await import("./d4/browser/nav-probes.mjs");
        return run(probeCtx);
      });
    }
    if (inScope("d4-b6-scale-browser")) {
      await runCheck("d4-b6-scale-browser", async () => {
        const { probeB6ScaleBrowser: run } = await import("./d4/browser/scale-probes.mjs");
        return run(probeCtx);
      });
    }
    if (inScope("d4-beta-usability")) {
      await runCheck("d4-beta-usability", async () => {
        const { probeBetaUsability: run } = await import("./d4/browser/beta-usability-probes.mjs");
        return run(probeCtx);
      });
    }
    if (inScope("terminology-path")) {
      await runCheck("terminology-path", async () => {
        const { probeTerminologyPath: run } = await import("./d4/browser/terminology-probes.mjs");
        return run(probeCtx);
      });
    }

    finish(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("BLOCKED:")) {
      console.error(message);
      sweepBlocked(message.slice("BLOCKED:".length).trim());
      finish(3);
      return;
    }
    console.error(`run-d4-browser error: ${sanitizeText(message)}`);
    finish(1);
  }
}

process.on("exit", () => {
  killStudio();
  stopChrome();
  if (!CLI.keepData && sc.dataDir !== null && CLI.dataDir === null) {
    try { rmSync(sc.dataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
});

main().catch((err) => {
  console.error(`run-d4-browser error: ${sanitizeText(err instanceof Error ? err.message : String(err))}`);
  finish(1);
});
