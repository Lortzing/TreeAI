import { existsSync } from "node:fs";
/** browser-cli original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserCli(deps) {

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
      promptTimeoutMs: deps.DEFAULT_PROMPT_SETTLE_MS,
      provider: null,
      model: null,
      agentDir: null,
      piTools: null,
      policyReadRoots: null,
      help: false,
    };
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { ...raw, help: true };
    for (let i = 0; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (value === undefined && flag !== "--keep-data") throw new Error(`${deps.USAGE}\n(bad or missing value for '${String(flag)}')`);
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
      else throw new Error(`${deps.USAGE}\n(unknown flag: ${String(flag)})`);
    }
    if (!deps.MODES.includes(raw.mode)) throw new Error(`${deps.USAGE}\n(--mode must be one of ${deps.MODES.join(", ")})`);
    if (!Number.isFinite(raw.promptTimeoutMs) || raw.promptTimeoutMs < 1000) {
      throw new Error(`${deps.USAGE}\n(--prompt-timeout-ms must be a number >= 1000)`);
    }
    if (raw.mode === "real-pi") {
      if (raw.provider === null || raw.model === null) {
        throw new Error(`${deps.USAGE}\n(--mode real-pi requires --provider and --model)`);
      }
      if (raw.agentDir !== null && !existsSync(raw.agentDir)) {
        throw new Error(`${deps.USAGE}\n(--agent-dir does not exist: ${raw.agentDir})`);
      }
      if (process.env[deps.PI_API_KEY_ENV] === undefined || process.env[deps.PI_API_KEY_ENV] === "") {
        throw new Error(
          `BLOCKED: --mode real-pi needs the ${deps.PI_API_KEY_ENV} env var (name only is printed; the value is never read by this script)`,
        );
      }
    } else if (raw.provider !== null || raw.model !== null || raw.agentDir !== null) {
      throw new Error(`${deps.USAGE}\n(--provider/--model/--agent-dir apply only to --mode real-pi)`);
    }
    /* 工具缝旗标的早期校验（镜像 run-d3-real-pi.mjs 的边界子集；绝对/
       存在等完整校验由 studio CLI 负责——CLI 是边界，这里绝不重复整套）。 */
    if (raw.piTools !== null && raw.mode !== "real-pi") {
      throw new Error(
        `${deps.USAGE}\n(--pi-tools applies only to --mode real-pi (the echo driver has no tool executor; the browser tool-policy phase needs the real Pi request-time gate))`,
      );
    }
    if (raw.policyReadRoots !== null && raw.piTools === null) {
      throw new Error(
        `${deps.USAGE}\n(--policy-read-roots requires --pi-tools (read roots scope the ToolPolicy engine that gates the enabled tools))`,
      );
    }
    raw.piToolsList = raw.piTools === null ? null : parseCommaList(raw.piTools);
    raw.policyReadRootsList = raw.policyReadRoots === null ? null : parseCommaList(raw.policyReadRoots);
    return raw;
  }

  return {
    parseCli,
  };
}
