/** Native Chrome/CDP lifecycle and artifact capture for the D4 runner. No probe imports. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_CANDIDATES } from "./cli.mjs";

const CDP_SEND_TIMEOUT_MS = 30_000;

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
    try { message = JSON.parse(raw); } catch { return; }
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

  send(method, params = {}, timeoutMs = CDP_SEND_TIMEOUT_MS) {
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

/** Each runner owns its browser, profile, request map and screenshot sequence. */
export function createChromeHost({ cli: CLI, viewport: VIEWPORT, getContext, sanitizeText, truncate, sleep }) {
  function findChromeExecutable() {
    if (CLI.chromeExecutable !== null) {
      return existsSync(CLI.chromeExecutable) ? CLI.chromeExecutable : null;
    }
    for (const candidate of CHROME_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  const chrome = {
    executable: null,
    profileDir: null,
    child: null,
    port: 0,
    cdp: null,
    pageErrors: [],
    screenshotSeq: 0,
  };

  async function startChrome() {
    chrome.executable = findChromeExecutable();
    if (chrome.executable === null) {
      throw new Error(
        "BLOCKED: no Chromium/Chrome executable found — pass --chrome-executable PATH (candidates probed: " +
          `${CHROME_CANDIDATES.map((p) => `"${p}"`).join(", ")})`,
      );
    }
    chrome.profileDir = mkdtempSync(join(tmpdir(), "treeai-d4-chrome-"));
    const args = [
      "--headless=new",
      // Explicit CI-only escape hatch. Never disable Chrome sandbox by default.
      ...(process.env["TREEAI_TEST_CHROME_NO_SANDBOX"] === "1" ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${chrome.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--force-device-scale-factor=1",
      `--window-size=${String(VIEWPORT.width)},${String(VIEWPORT.height)}`,
      "about:blank",
    ];
    chrome.child = spawn(chrome.executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let chromeStderrTail = "";
    chrome.child.stderr.on("data", (chunk) => {
      chromeStderrTail = (chromeStderrTail + String(chunk)).slice(-2500);
    });

    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`chrome boot timeout: no DevTools listening line in 45s; stderr: ${sanitizeText(chromeStderrTail)}`)), 45_000);
      chrome.child.stderr.on("data", (chunk) => {
        buffer += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match !== null) { clearTimeout(timer); resolve(match[1]); }
      });
      chrome.child.on("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`chrome exited during boot (code ${String(code)}, signal ${String(signal)}): ${sanitizeText(chromeStderrTail)}`));
      });
    });

    const url = new URL(wsUrl);
    chrome.port = Number(url.port);

    let target = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(chrome.port)}/json/list`);
        if (res.ok) {
          const targets = await res.json();
          target = targets.find((t) => t.type === "page") ?? null;
          if (target !== null) break;
        }
      } catch { /* chrome 尚未就绪 */ }
      await sleep(100);
    }
    if (target === null) throw new Error("chrome booted but no page target appeared on /json/list");

    chrome.cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await chrome.cdp.send("Page.enable");
    await chrome.cdp.send("Runtime.enable");
    await chrome.cdp.send("Log.enable");
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    chrome.cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error") return;
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (text.includes("favicon")) return;
      chrome.pageErrors.push({ source: "console", text: sanitizeText(text) });
    });
    chrome.cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry ?? {};
      if (entry.level !== "error") return;
      const url = entry.url ?? "";
      if (url.includes("favicon")) return;
      chrome.pageErrors.push({ source: "log", text: sanitizeText(`${entry.text}${url === "" ? "" : ` (${url})`}`) });
    });
  }

  function stopChrome() {
    if (chrome.cdp !== null) chrome.cdp.close();
    if (chrome.child !== null && chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
    if (chrome.profileDir !== null) {
      try { rmSync(chrome.profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  }

  async function navigate(url) {
    await chrome.cdp.send("Page.navigate", { url });
    await sleep(600);
  }

  async function evalJs(expression, timeoutMs = CDP_SEND_TIMEOUT_MS) {
    const res = await chrome.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (res.exceptionDetails !== undefined) {
      throw new Error(
        `page eval failed: ${truncate(sanitizeText(JSON.stringify(res.exceptionDetails)), 400)} — expression: ${truncate(expression, 600)}`,
      );
    }
    return res.result.value;
  }

  async function screenshot(name) {
    const sc = getContext();
    chrome.screenshotSeq += 1;
    const path = join(sc.artifactsDir, `${String(chrome.screenshotSeq).padStart(2, "0")}-${name}.jpg`);
    const shot = await chrome.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  }

  /** JSON sidecar（与截图同一序号空间；确定性事实入证据，脱敏纪律同 summary）。 */
  async function sidecar(name, data) {
    const sc = getContext();
    chrome.screenshotSeq += 1;
    const path = join(sc.artifactsDir, `${String(chrome.screenshotSeq).padStart(2, "0")}-${name}.json`);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }
  return { chrome, startChrome, stopChrome, navigate, evalJs, screenshot, sidecar };
}
