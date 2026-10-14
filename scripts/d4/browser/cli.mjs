/** D4 browser runner's original CLI contract and Chromium discovery candidates. */
import { existsSync } from "node:fs";
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const MODES = ["selftest", "real-pi"];
const DEFAULT_PROMPT_TIMEOUT_MS = 240_000;

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
  "run-d4-browser — TreeAI D4 浏览器验收入口",
  "",
  "用法:",
  "  node scripts/run-d4-browser.mjs --mode selftest",
  "  node scripts/run-d4-browser.mjs --mode real-pi --provider <id> --model <id> [options]",
  "",
  "选项:",
  "  --mode <selftest|real-pi>   selftest=离线 echo 驱动（不是真实 Pi 证据）；real-pi=真实 Pi",
  "  --data <dir>                Studio 数据目录（缺省临时目录；--keep-data 保留）",
  "  --keep-data                 运行后保留数据目录",
  "  --artifacts <dir>           证据落盘目录（缺省临时目录）",
  "  --chrome-executable <path>  浏览器可执行文件（缺省探测常见安装路径）",
  "  --prompt-timeout-ms <ms>    模型回答等待上限（>=1000，缺省 240000）",
  "  --provider <id>             受控 provider（仅 real-pi）",
  "  --model <id>                受控 model（仅 real-pi）",
  "  --agent-dir <dir>           受控 agent 注册表目录（仅 real-pi；常用 .pi-d2-live）",
  "  --only <id>                 只运行指定检查（可重复；boot 检查恒随行——",
  "                              其余检查不列出；summary 记录范围，绝不冒充全量）",
  "  --help                      打印本说明",
  "",
  "凭据: real-pi 需要 TREEAI_STUDIO_API_KEY 环境变量（只检查变量名，值由",
  "      Studio 子进程自行读取；凭据不落命令、截图或证据）。",
  "",
  "浏览器路径: 真实 headless Chromium 经 CDP 驱动（--remote-debugging-port=0，",
  "            随机 --user-data-dir 临时 profile，运行后清理）。",
  "数据目录:   Studio --data 指向的本地 SQLite 数据目录。",
].join("\n");

export function parseCli(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const raw = {
    mode: "selftest",
    dataDir: null,
    keepData: false,
    artifactsDir: null,
    chromeExecutable: null,
    promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    provider: null,
    model: null,
    agentDir: null,
    only: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // A switch consumes no value, including when it is the final argument.
    if (flag === "--keep-data") {
      raw.keepData = true;
      continue;
    }
    if (!["--mode", "--data", "--artifacts", "--chrome-executable", "--prompt-timeout-ms", "--provider", "--model", "--agent-dir", "--only"].includes(flag)) {
      throw new Error(`${USAGE}\n(unknown flag: ${String(flag)})`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${USAGE}\n(bad or missing value for '${String(flag)}')`);
    if (flag === "--mode") raw.mode = value;
    else if (flag === "--data") raw.dataDir = value;
    else if (flag === "--artifacts") raw.artifactsDir = value;
    else if (flag === "--chrome-executable") raw.chromeExecutable = value;
    else if (flag === "--prompt-timeout-ms") raw.promptTimeoutMs = Number(value);
    else if (flag === "--provider") raw.provider = value;
    else if (flag === "--model") raw.model = value;
    else if (flag === "--agent-dir") raw.agentDir = value;
    else if (flag === "--only") raw.only.push(value);
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


export { PI_API_KEY_ENV, MODES, CHROME_CANDIDATES, USAGE };
