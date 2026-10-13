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
  "/core/views/nav-tree.js": { file: "core/views/nav-tree.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-session.js": { file: "core/controllers/nav-session.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-interaction.js": { file: "core/controllers/nav-interaction.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-persistence.js": { file: "core/controllers/nav-persistence.js", type: "text/javascript; charset=utf-8" },
  "/core/views/nav-path.js": { file: "core/views/nav-path.js", type: "text/javascript; charset=utf-8" },
  "/core/views/nav-node-results.js": { file: "core/views/nav-node-results.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-node-search.js": { file: "core/controllers/nav-node-search.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-locate.js": { file: "core/controllers/nav-locate.js", type: "text/javascript; charset=utf-8" },
  "/core/views/material-pdf.js": { file: "core/views/material-pdf.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-import.js": { file: "core/controllers/material-import.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-selection.js": { file: "core/controllers/material-selection.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-list.js": { file: "core/controllers/material-list.js", type: "text/javascript; charset=utf-8" },
  "/core/views/material-reader.js": { file: "core/views/material-reader.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-reader.js": { file: "core/controllers/material-reader.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-intent-store.js": { file: "core/controllers/material-intent-store.js", type: "text/javascript; charset=utf-8" },
  "/core/views/material-branch.js": { file: "core/views/material-branch.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/material-branch.js": { file: "core/controllers/material-branch.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/terminology.js": { file: "core/controllers/terminology.js", type: "text/javascript; charset=utf-8" },
  "/core/views/terminology.js": { file: "core/views/terminology.js", type: "text/javascript; charset=utf-8" },
  "/core/views/turn-overlays.js": { file: "core/views/turn-overlays.js", type: "text/javascript; charset=utf-8" },
  "/core/views/turn-actions.js": { file: "core/views/turn-actions.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/turn-selection.js": { file: "core/controllers/turn-selection.js", type: "text/javascript; charset=utf-8" },
  "/core/views/conversation.js": { file: "core/views/conversation.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/return.js": { file: "core/controllers/return.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/studio-events.js": { file: "core/controllers/studio-events.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/branch.js": { file: "core/controllers/branch.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/prompt.js": { file: "core/controllers/prompt.js", type: "text/javascript; charset=utf-8" },
  "/core/views/tree-chrome.js": { file: "core/views/tree-chrome.js", type: "text/javascript; charset=utf-8" },
  "/core/views/source-drawer.js": { file: "core/views/source-drawer.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/source-drawer.js": { file: "core/controllers/source-drawer.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/tree.js": { file: "core/controllers/tree.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/search.js": { file: "core/controllers/search.js", type: "text/javascript; charset=utf-8" },
  "/core/state.js": { file: "core/state.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/focus.js": { file: "core/controllers/focus.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/basics.js": { file: "core/controllers/basics.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/render.js": { file: "core/controllers/render.js", type: "text/javascript; charset=utf-8" },
  "/core/compose-features.js": { file: "core/compose-features.js", type: "text/javascript; charset=utf-8" },
  "/core/composition/materials.js": { file: "core/composition/materials.js", type: "text/javascript; charset=utf-8" },
  "/core/composition/navigation.js": { file: "core/composition/navigation.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/nav-finder.js": { file: "core/controllers/nav-finder.js", type: "text/javascript; charset=utf-8" },
  "/core/dom.js": { file: "core/dom.js", type: "text/javascript; charset=utf-8" },
  "/core/views/markdown.js": { file: "core/views/markdown.js", type: "text/javascript; charset=utf-8" },
  "/core/views/search.js": { file: "core/views/search.js", type: "text/javascript; charset=utf-8" },
  "/core/views/return.js": { file: "core/views/return.js", type: "text/javascript; charset=utf-8" },
  "/core/views/diagnostics.js": { file: "core/views/diagnostics.js", type: "text/javascript; charset=utf-8" },
  "/core/views/nav-finder.js": { file: "core/views/nav-finder.js", type: "text/javascript; charset=utf-8" },
  "/core/views/nav-chrome.js": { file: "core/views/nav-chrome.js", type: "text/javascript; charset=utf-8" },
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
