/** Scoped, exact allowlist for Studio static assets and PDF.js resources. */
import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sendJson } from "./responses.ts";

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/shared/source/sha256.js": { file: "shared/source/sha256.js", type: "text/javascript; charset=utf-8" },
  "/core/create-studio-app.js": { file: "core/create-studio-app.js", type: "text/javascript; charset=utf-8" },
  "/core/dom.js": { file: "core/dom.js", type: "text/javascript; charset=utf-8" },
  "/core/views/markdown.js": { file: "core/views/markdown.js", type: "text/javascript; charset=utf-8" },
  "/shared/source/selection.js": { file: "shared/source/selection.js", type: "text/javascript; charset=utf-8" },
  "/shared/source/grapheme.js": { file: "shared/source/grapheme.js", type: "text/javascript; charset=utf-8" },
  "/shared/reading-position/scroll.js": { file: "shared/reading-position/scroll.js", type: "text/javascript; charset=utf-8" },
};

/** Exact CSS asset allowlist: never resolve arbitrary URL paths under public/. */
const CSS_MODULE_FILES = new Set(["tokens-base.css","workspace.css","conversation.css","terminology.css","controls-branches.css","materials.css","sources-navigation.css","responsive.css","reduced-motion.css"]);
const PDFJS_ROOT = new URL("../../../../node_modules/pdfjs-dist/", import.meta.url);

export function createStaticResponder(staticDir: string) {
  async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
    const cssMatch = /^\/styles\/([a-z-]+\.css)$/.exec(pathname);
    const entry = STATIC_FILES[pathname] ??
      (cssMatch !== null && CSS_MODULE_FILES.has(cssMatch[1]!)
        ? { file: `styles/${cssMatch[1]}`, type: "text/css; charset=utf-8" }
        : undefined);
    let source: string | URL | null = entry === undefined ? null : join(staticDir, entry.file);
    let type = entry?.type ?? null;
    if (source === null) {
      const moduleMatch = /^\/vendor\/pdfjs\/(pdf(?:\.worker)?\.mjs)$/.exec(pathname);
      const cmapMatch = /^\/vendor\/pdfjs\/cmaps\/([A-Za-z0-9_-]+\.bcmap)$/.exec(pathname);
      const fontMatch = /^\/vendor\/pdfjs\/standard_fonts\/([A-Za-z0-9_-]+\.(?:pfb|ttf))$/.exec(pathname);
      if (moduleMatch !== null) {
        source = new URL(`build/${moduleMatch[1]}`, PDFJS_ROOT);
        type = "text/javascript; charset=utf-8";
      } else if (cmapMatch !== null) {
        source = new URL(`cmaps/${cmapMatch[1]}`, PDFJS_ROOT);
        type = "application/octet-stream";
      } else if (fontMatch !== null) {
        source = new URL(`standard_fonts/${fontMatch[1]}`, PDFJS_ROOT);
        type = "application/octet-stream";
      }
    }
    if (source === null || type === null) return false;
    try {
      const content = await readFile(source);
      res.writeHead(200, {
        "content-type": type,
        "content-length": content.length,
        "cache-control": "no-store",
      });
      res.end(content);
      return true;
    } catch {
      sendJson(res, 500, { error: { code: "internal", message: `static file missing: ${pathname}` } });
      return true;
    }
  }

  return serveStatic;
}
