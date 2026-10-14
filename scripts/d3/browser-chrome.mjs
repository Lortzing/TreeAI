import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
/** browser-chrome runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserChrome(deps) {

  /* ------------------------------------------------------------------ */
  /* Chromium 定位与 CDP 客户端（零依赖：Node 内建 WebSocket）             */
  /* ------------------------------------------------------------------ */

  function findChromeExecutable() {
    if (deps.CLI.chromeExecutable !== null) {
      if (!existsSync(deps.CLI.chromeExecutable)) return null;
      return deps.CLI.chromeExecutable;
    }
    for (const candidate of deps.CHROME_CANDIDATES) {
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

    send(method, params = {}, timeoutMs = deps.CDP_SEND_TIMEOUT_MS) {
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

  async function startChrome() {
    deps.chrome.executable = findChromeExecutable();
    if (deps.chrome.executable === null) {
      throw new Error(
        "BLOCKED: no Chromium/Chrome executable found — pass --chrome-executable PATH (candidates probed: " +
          `${deps.CHROME_CANDIDATES.map((p) => `"${p}"`).join(", ")})`,
      );
    }
    deps.chrome.profileDir = mkdtempSync(join(tmpdir(), "treeai-d3-chrome-"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${deps.chrome.profileDir}`,
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
    deps.chrome.child = spawn(deps.chrome.executable, args, { stdio: ["ignore", "ignore", "pipe"] });

    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("chrome boot timeout: no DevTools listening line in 20s")), 20_000);
      deps.chrome.child.stderr.on("data", (chunk) => {
        buffer += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      deps.chrome.child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(`chrome exited during boot (code ${String(deps.chrome.child.exitCode)})`));
      });
    });

    const url = new URL(wsUrl);
    deps.chrome.port = Number(url.port);

    /* 等待 HTTP 端点就绪并定位初始 page target。 */
    let target = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(deps.chrome.port)}/json/list`);
        if (res.ok) {
          const targets = await res.json();
          target = targets.find((t) => t.type === "page") ?? null;
          if (target !== null) break;
        }
      } catch {
        /* chrome 尚未就绪 */
      }
      await deps.sleep(100);
    }
    if (target === null) throw new Error("chrome booted but no page target appeared on /json/list");

    deps.chrome.cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await deps.chrome.cdp.send("Page.enable");
    await deps.chrome.cdp.send("Runtime.enable");
    await deps.chrome.cdp.send("Log.enable");
    await deps.chrome.cdp.send("Network.enable");
    await deps.chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: deps.VIEWPORT.width,
      height: deps.VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    /* 页面网络事实采集（诊断面：请求是否发出/响应是否返回/失败原因）。 */
    deps.chrome.cdp.on("Network.requestWillBeSent", (params) => {
      const entry = { id: params.requestId, method: params.request.method, url: params.request.url, status: null, failed: null };
      deps.chrome.netLog.push(entry);
      deps.chrome.netLogIndex.set(params.requestId, entry);
    });
    deps.chrome.cdp.on("Network.responseReceived", (params) => {
      const entry = deps.chrome.netLogIndex.get(params.requestId);
      if (entry !== undefined) entry.status = params.response.status;
    });
    deps.chrome.cdp.on("Network.loadingFailed", (params) => {
      const entry = deps.chrome.netLogIndex.get(params.requestId);
      if (entry !== undefined) entry.failed = params.errorText;
    });

    /* 页面错误采集（console.error / Log error）；favicon 404 视为浏览器噪声；
       故障注入窗口（chrome.expectPageErrors）内的连接类错误按预期不计。 */
    deps.chrome.cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error" || deps.chrome.expectPageErrors) return;
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (text.includes("favicon")) return;
      deps.chrome.pageErrors.push({ source: "console", text: deps.sanitizeText(text) });
    });
    deps.chrome.cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry ?? {};
      if (entry.level !== "error" || deps.chrome.expectPageErrors) return;
      const url = entry.url ?? "";
      if (url.includes("favicon")) return;
      deps.chrome.pageErrors.push({ source: "log", text: deps.sanitizeText(`${entry.text}${url === "" ? "" : ` (${url})`}`) });
    });
  }

  function stopChrome() {
    if (deps.chrome.cdp !== null) deps.chrome.cdp.close();
    if (deps.chrome.child !== null && deps.chrome.child.exitCode === null) {
      deps.chrome.child.kill("SIGKILL");
    }
    if (deps.chrome.profileDir !== null) {
      try { rmSync(deps.chrome.profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  }

  return {
    findChromeExecutable,
    startChrome,
    stopChrome,
  };
}
