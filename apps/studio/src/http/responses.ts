import type { ServerResponse } from "node:http";

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}


export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}


export function sendPdfBytes(res: ServerResponse, bytes: Uint8Array, rangeHeader: string | undefined): void {
  const total = bytes.byteLength;
  let start = 0;
  let end = total - 1;
  let partial = false;
  if (rangeHeader !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match === null || (match[1] === "" && match[2] === "")) {
      res.writeHead(416, { "content-range": `bytes */${String(total)}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (match[1] !== "") {
      start = Number(match[1]);
      end = match[2] === "" ? total - 1 : Number(match[2]);
    } else {
      const suffix = Number(match[2]);
      start = Math.max(0, total - suffix);
      end = total - 1;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= total
    ) {
      res.writeHead(416, { "content-range": `bytes */${String(total)}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    partial = true;
  }
  const body = Buffer.from(bytes.subarray(start, end + 1));
  const headers: Record<string, string | number> = {
    "content-type": "application/pdf",
    "content-length": body.byteLength,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    "cache-control": "no-store",
  };
  if (partial) headers["content-range"] = `bytes ${String(start)}-${String(end)}/${String(total)}`;
  res.writeHead(partial ? 206 : 200, headers);
  res.end(body);
}

