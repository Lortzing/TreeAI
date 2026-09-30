/**
 * D4 PDF fixture generator — render smoke test (best effort).
 *
 * Loads generated PDFs in headless Chrome over CDP (zero-dep client mirroring
 * scripts/run-d3-browser.mjs), screenshots each, and checks the screenshots
 * are not blank: we decode the PNG ourselves (zlib inflate + unfilter) and
 * compare pixel statistics against a blank about:blank control. This is a
 * smoke check, not OCR: "not blank with visible ink" is the claim.
 *
 * If Chrome is unavailable, or the PDF viewer does not render in headless
 * mode, the failure is reported honestly (status "not-run"/"error") and the
 * generator records it — never a faked pass.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";
import { crc32 } from "./util.mjs";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const VIEWPORT = { width: 1000, height: 800 };

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener("message", (event) => this.handle(String(event.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket connect timeout")), 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket error")); }, { once: true });
    });
    return new Cdp(ws);
  }

  handle(raw) {
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
    }
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error(`CDP send after close: ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/* ---------------------------------------------------------------------- */
/* Minimal PNG decoder (8-bit RGB/RGBA/gray, non-interlaced)               */
/* ---------------------------------------------------------------------- */

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  const chunkAt = (offset) => buf.readUInt32BE(offset);
  while (pos < buf.length) {
    const len = chunkAt(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported here");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    const crc = buf.readUInt32BE(pos + 8 + len);
    const expect = crc32(buf.subarray(pos + 4, pos + 8 + len));
    if (crc !== expect) throw new Error("PNG chunk CRC mismatch");
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(bitDepth)}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${String(colorType)}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = Buffer.from(raw.subarray(src, src + stride));
    src += stride;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[x] = (row[x] + a) & 0xff; break;
        case 2: row[x] = (row[x] + b) & 0xff; break;
        case 3: row[x] = (row[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter ${String(filter)}`);
      }
    }
    row.copy(dst, 0);
    prev = row;
  }
  return { width, height, channels, data: out };
}

/** Pixel statistics on the grayscale projection of a decoded image. */
function pixelStats(image) {
  const { width, height, channels, data } = image;
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  const total = width * height;
  const values = new Set();
  for (let i = 0; i < total; i += 1) {
    const o = i * channels;
    let gray;
    if (channels >= 3) gray = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
    else gray = data[o];
    if (channels === 4) gray = gray * (data[o + 3] / 255) + 255 * (1 - data[o + 3] / 255);
    sum += gray;
    sumSq += gray * gray;
    if (gray < 200) dark += 1;
    if (values.size < 4096) values.add(Math.round(gray));
  }
  const mean = sum / total;
  const variance = sumSq / total - mean * mean;
  return { mean, stdDev: Math.sqrt(Math.max(0, variance)), darkFraction: dark / total, distinctValues: values.size };
}

/* ---------------------------------------------------------------------- */
/* The smoke run                                                           */
/* ---------------------------------------------------------------------- */

export async function runRenderSmoke(pdfPaths) {
  const executable = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (executable === undefined) {
    return { status: "not-run", detail: "no Chrome/Chromium executable found on this machine" };
  }
  const profileDir = mkdtempSync(`${tmpdir()}/treeai-d4-pdfsmoke-`);
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--force-device-scale-factor=1",
    `--window-size=${String(VIEWPORT.width)},${String(VIEWPORT.height)}`,
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("chrome boot timeout")), 20_000);
      child.stderr.on("data", (chunk) => {
        buffer += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("chrome exited during boot"));
      });
    });
    const port = new URL(wsUrl).port;
    let target = null;
    for (let attempt = 0; attempt < 100 && target === null; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) target = (await res.json()).find((t) => t.type === "page") ?? null;
      } catch { /* not ready */ }
      if (target === null) await new Promise((r) => setTimeout(r, 100));
    }
    if (target === null) throw new Error("no page target on /json/list");
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const shoot = async () => {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        return Buffer.from(shot.data, "base64");
      };
      const navigate = async (url) => {
        await cdp.send("Page.navigate", { url });
        await new Promise((r) => setTimeout(r, 1800)); // let the PDF viewer settle
      };

      // Control: a blank page screenshot.
      await navigate("about:blank");
      const blankPng = await shoot();
      const blankStats = pixelStats(decodePng(blankPng));

      const results = [];
      let allOk = true;
      for (const pdfPath of pdfPaths) {
        await navigate(`file://${pdfPath}`);
        const png = await shoot();
        const stats = pixelStats(decodePng(png));
        // Not blank: markedly more dark pixels and gray variance than the
        // blank control (the PDF viewer chrome itself adds a toolbar, so we
        // require a meaningful multiple of the control's ink).
        const inkOk = stats.darkFraction > Math.max(blankStats.darkFraction * 3, 0.01);
        const varianceOk = stats.stdDev > Math.max(blankStats.stdDev * 3, 2);
        const ok = inkOk && varianceOk;
        allOk = allOk && ok;
        results.push({
          file: basename(pdfPath),
          ok,
          stats,
          control: blankStats,
        });
      }
      return {
        status: allOk ? "pass" : "fail",
        detail: allOk
          ? `${String(results.length)}/${String(results.length)} PDFs rendered non-blank in headless Chrome (pixel-ink check vs about:blank control)`
          : "at least one PDF rendered blank (see results)",
        executable,
        results,
      };
    } finally {
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
