import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
/** browser-host runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserHost(deps) {

  function studioArgv(dataDir, withTools = false, agentDirOverride = null) {
    const argv = [
      deps.STUDIO_ENTRY,
      "--port",
      String(deps.studio.port),
      "--data",
      dataDir,
    ];
    if (deps.MODE === "real-pi") {
      argv.push("--driver", "pi", "--provider", deps.CLI.provider, "--model", deps.CLI.model);
      /* agentDirOverride 仅供模型错误注入相的错配副本引导使用（镜像
         run-d3-real-pi.mjs studioArgv 的第三参）；缺省回落 CLI --agent-dir。 */
      const agentDir = agentDirOverride ?? deps.CLI.agentDir;
      if (agentDir !== null) argv.push("--agent-dir", agentDir);
      /* 两段式结构（镜像 run-d3-real-pi.mjs）：主剧本检查全程零工具引导
         ——真实模型偶发在提示中自发读取工作区文件，收窄读取根下会被策略
         正确拒绝（fail-closed 是产品正确行为，但会打断剧本）；工具缝仅在
         tool-policy-boot 以 withTools 重启同一数据目录后出现。CLI 是校验
         边界（绝对/存在/非空），本脚本不重复。 */
      if (withTools && deps.CLI.piTools !== null) {
        argv.push("--pi-tools", deps.CLI.piTools);
        if (deps.CLI.policyReadRoots !== null) {
          argv.push("--policy-read-roots", deps.CLI.policyReadRoots);
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
    deps.studio.exited = false;
    /* 子进程输出落盘到 artifacts（服务端事实留档，脱敏；亦防管道写满
       阻塞）。工具引导写独立日志（studio-tools.log）——零工具引导的
       studio.log 不被覆盖，两段引导的事实都留档。 */
    writeFileSync(join(deps.sc.artifactsDir, logName), "");
    deps.studio.stdoutRaw = "";
    deps.studio.stderrRaw = "";
    deps.studio.child = spawn(process.execPath, studioArgv(dataDir, withTools, agentDir), {
      cwd: deps.ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    deps.studio.child.stdout.on("data", (chunk) => {
      deps.studio.stdoutRaw += chunk.toString("utf8");
      deps.appendArtifact(logName, chunk);
    });
    deps.studio.child.stderr.on("data", (chunk) => {
      deps.studio.stderrRaw += chunk.toString("utf8");
      deps.appendArtifact(logName, chunk);
    });
    deps.studio.child.on("exit", () => { deps.studio.exited = true; });
    const deadline = Date.now() + deps.BOOT_TIMEOUT_MS;
    for (;;) {
      if (deps.studio.exited) {
        /* 边界错误如实面世（含脱敏 stderr 尾部）——如 --pi-tools 需要已
           编译的 ToolPolicy 引擎（apps/studio dist 未构建时的指引性错误），
           绝不静默代为构建。 */
        throw new Error(
          `studio exited during boot (see artifacts ${logName}); stderr tail: ${deps.truncate(deps.sanitizeText(deps.studio.stderrRaw), 600)}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${String(deps.studio.port)}/api/health`);
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (body === null || body.ok === true) return;
        }
      } catch {
        /* 尚未就绪 */
      }
      if (Date.now() >= deadline) throw new Error(`studio boot timeout (${String(deps.BOOT_TIMEOUT_MS)}ms)`);
      await deps.sleep(150);
    }
  }

  function killStudio() {
    if (deps.studio.child !== null && !deps.studio.exited) deps.studio.child.kill("SIGKILL");
  }

  /** SIGKILL 后等待进程真正退出（同端口重启前的必要窗口；SIGKILL 通常
   *  即时生效，超时仅作防御——镜像 API 跑批器的 waitForExit 手法）。 */
  async function killStudioAndWait(timeoutMs = 10_000) {
    if (deps.studio.child === null || deps.studio.exited) return;
    deps.studio.child.kill("SIGKILL");
    const deadline = Date.now() + timeoutMs;
    while (!deps.studio.exited && Date.now() < deadline) await deps.sleep(50);
  }

  async function api(method, path, body, timeoutMs = deps.GET_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${String(deps.studio.port)}${path}`, {
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

  return {
    api,
    killStudioAndWait,
    startStudio,
    killStudio,
  };
}
