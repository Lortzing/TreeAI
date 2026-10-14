import { existsSync, readdirSync } from "node:fs";
/** api-cli original runner scenarios/helpers Instance-owned state and dependencies. */

export function createApiCli(deps) {

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
      promptTimeoutMs: deps.DEFAULT_PROMPT_TIMEOUT_MS,
      piTools: null,
      policyReadRoots: null,
      help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      const next = argv[i + 1];
      const valueOf = () => {
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`${deps.USAGE}\nbad or missing value for '${flag}'`);
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
      else throw new Error(`${deps.USAGE}\nunknown flag: ${flag}`);
    }
    if (!deps.MODES.includes(options.mode)) {
      throw new Error(`${deps.USAGE}\n--mode must be one of: ${deps.MODES.join(", ")} (got '${options.mode}')`);
    }
    if (!Number.isInteger(options.promptTimeoutMs) || options.promptTimeoutMs < 1000) {
      throw new Error(`${deps.USAGE}\n--prompt-timeout-ms must be an integer >= 1000`);
    }
    if (options.mode === "real-pi") {
      if (typeof options.provider !== "string" || options.provider.length === 0) {
        throw new Error(`${deps.USAGE}\n--mode real-pi requires --provider`);
      }
      if (typeof options.model !== "string" || options.model.length === 0) {
        throw new Error(`${deps.USAGE}\n--mode real-pi requires --model`);
      }
    }
    /* 工具缝旗标的早期校验（镜像 CLI 规则的边界子集；绝对/存在/非空等
       完整校验由 studio CLI 负责——CLI 是边界，这里绝不重复整套）。 */
    if (options.piTools !== null && options.mode !== "real-pi") {
      throw new Error(
        `${deps.USAGE}\n--pi-tools applies only to --mode real-pi (the echo driver has no tool executor; the A5 product tool-policy phase needs the real Pi request-time gate)`,
      );
    }
    if (options.policyReadRoots !== null && options.piTools === null) {
      throw new Error(
        `${deps.USAGE}\n--policy-read-roots requires --pi-tools (read roots scope the ToolPolicy engine that gates the enabled tools)`,
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

  return {
    parseCli,
  };
}
