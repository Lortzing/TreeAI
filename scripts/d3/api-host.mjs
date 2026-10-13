import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
/** api-host runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiHost(deps) {

  /* ------------------------------------------------------------------ */
  /* Studio 子进程                                                       */
  /* ------------------------------------------------------------------ */

  function studioArgv(dataDir, withTools = false, agentDirOverride = null) {
    const args = [deps.STUDIO_ENTRY, "--port", "0", "--data", dataDir];
    if (deps.CLI.mode === "real-pi") {
      args.push("--driver", "pi", "--provider", deps.CLI.provider, "--model", deps.CLI.model);
      /* agentDirOverride 仅由模型错误注入阶段使用（错误配置副本引导）；
         null = 既有语义（--agent-dir 透传或 CLI 缺省 <data>/pi-agent）。 */
      const agentDir = agentDirOverride ?? deps.CLI.agentDir;
      if (agentDir !== null) args.push("--agent-dir", agentDir);
      /* 两段式结构：主剧本（含重启/中止检查）全程零工具引导——真实模型
         偶尔会在提示中自发读取工作区文件，收窄读取根下会被策略正确拒绝
         （fail-closed 是产品正确行为，但会打断剧本）；工具缝仅在 A5 阶段
         以 withTools 引导单独重启同一数据目录后出现。CLI 是校验边界。 */
      if (withTools && deps.CLI.piTools !== null) {
        args.push("--pi-tools", deps.CLI.piTools);
        if (deps.CLI.policyReadRoots !== null) {
          args.push("--policy-read-roots", deps.CLI.policyReadRoots);
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

  async function startStudio(dataDir, withTools = false, agentDirOverride = null) {
    const child = spawn(process.execPath, studioArgv(dataDir, withTools, agentDirOverride), {
      cwd: deps.ROOT,
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
    const deadline = Date.now() + deps.BOOT_TIMEOUT_MS;
    for (;;) {
      const match = /listening http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match !== null) {
        return { child, port: Number(match[1]), stdout, stderr };
      }
      if (hasExited(child)) {
        throw new Error(
          `studio process exited before listening (code ${String(child.exitCode)}, signal ${String(child.signalCode)}); stderr tail: ${deps.truncate(deps.stripSecret(stderr), 800)}`,
        );
      }
      if (Date.now() > deadline) {
        ensureKilled(child);
        throw new Error(
          `studio process did not report a listening port within ${String(deps.BOOT_TIMEOUT_MS)}ms; ` +
            `stdout so far: ${deps.truncate(deps.stripSecret(stdout), 400)}; stderr tail: ${deps.truncate(deps.stripSecret(stderr), 800)}`,
        );
      }
      await deps.sleep(25);
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

  async function api(port, method, path, body, timeoutMs = deps.GET_TIMEOUT_MS) {
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
      return `${String(error.code)}: ${deps.truncate(String(error.message), 200)}`;
    }
    return `HTTP ${String(res?.status)} body=${deps.truncate(JSON.stringify(res?.body), 200)}`;
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
          await deps.sleep(quietMs);
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

  return {
    api,
    errDetail,
    stopStudio,
    startStudio,
    openSse,
    waitForExit,
  };
}
