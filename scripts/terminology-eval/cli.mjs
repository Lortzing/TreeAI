
/** Terminology evaluator cli with unchanged denominator and gates Instance-owned state and dependencies. */

export function createEvalCli(deps) {

  function usage() {
    console.log(
      "usage: node scripts/run-terminology-eval.mjs [--set dev|frozen] [--mode echo|real] " +
        "[--provider echo|baseline|ID] [--model ID] [--agent-dir DIR] [--limit N] [--retries N] " +
        "[--evidence-root DIR] [--allow-observe]",
    );
  }

  function parseArgs(argv) {
    const raw = {
      set: "dev",
      mode: "echo",
      provider: null,
      model: null,
      agentDir: deps.DEFAULT_AGENT_DIR,
      limit: null,
      retries: 0,
      evidenceRoot: deps.DEFAULT_EVIDENCE_ROOT,
      allowObserve: false,
      help: false,
    };
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { usage(); return { ...raw, help: true }; }
    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      if (flag === "--allow-observe") {
        raw.allowObserve = true;
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined) {
        usage();
        throw new Error(`bad or missing value for '${String(flag)}'`);
      }
      if (flag === "--set") raw.set = value;
      else if (flag === "--mode") raw.mode = value;
      else if (flag === "--provider") raw.provider = value;
      else if (flag === "--model") raw.model = value;
      else if (flag === "--agent-dir") raw.agentDir = value;
      else if (flag === "--limit") raw.limit = Number(value);
      else if (flag === "--retries") raw.retries = Number(value);
      else if (flag === "--evidence-root") raw.evidenceRoot = value;
      else {
        usage();
        throw new Error(`unknown flag: ${flag}`);
      }
      i += 1;
    }
    if (raw.set !== "dev" && raw.set !== "frozen") {
      throw new Error(`--set must be 'dev' or 'frozen' (got '${raw.set}')`);
    }
    if (raw.mode !== "echo" && raw.mode !== "real") {
      throw new Error(`--mode must be 'echo' or 'real' (got '${raw.mode}')`);
    }
    if (raw.provider === "echo" || raw.provider === "baseline") {
      if (raw.mode === "real") {
        throw new Error(`--provider ${raw.provider} is offline-only; --mode real needs a real provider id`);
      }
    }
    if (raw.provider === null) raw.provider = raw.mode === "echo" ? "echo" : "deepseek";
    if (raw.model === null) raw.model = raw.mode === "echo" ? raw.provider : "deepseek-flash";
    if (raw.limit !== null && (!Number.isInteger(raw.limit) || raw.limit <= 0)) {
      throw new Error(`--limit must be a positive integer (got '${String(argv)}')`);
    }
    if (!Number.isInteger(raw.retries) || raw.retries < 0) {
      throw new Error(`--retries must be a non-negative integer`);
    }
    return raw;
  }

  return {
    parseArgs,
  };
}
