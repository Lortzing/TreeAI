/** Scoped, exact allowlist for Studio static assets and PDF.js resources. */
import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sendJson } from "./responses.ts";

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/vendor/webawesome/styles/color/variants.css": { file: "vendor/webawesome/styles/color/variants.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/variants/brand.css": { file: "vendor/webawesome/styles/color/variants/brand.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/variants/neutral.css": { file: "vendor/webawesome/styles/color/variants/neutral.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/variants/success.css": { file: "vendor/webawesome/styles/color/variants/success.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/variants/warning.css": { file: "vendor/webawesome/styles/color/variants/warning.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/variants/danger.css": { file: "vendor/webawesome/styles/color/variants/danger.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/color/palettes/base.css": { file: "vendor/webawesome/styles/color/palettes/base.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.2SO23SX3.js": { file: "vendor/webawesome/chunks/chunk.2SO23SX3.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.3MSWQ3RG.js": { file: "vendor/webawesome/chunks/chunk.3MSWQ3RG.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.5VKLVAP2.js": { file: "vendor/webawesome/chunks/chunk.5VKLVAP2.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.5ZSSLK3M.js": { file: "vendor/webawesome/chunks/chunk.5ZSSLK3M.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.BKE5EYM3.js": { file: "vendor/webawesome/chunks/chunk.BKE5EYM3.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.D5HA4OFX.js": { file: "vendor/webawesome/chunks/chunk.D5HA4OFX.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.DITA2S5A.js": { file: "vendor/webawesome/chunks/chunk.DITA2S5A.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.DL7HG4WM.js": { file: "vendor/webawesome/chunks/chunk.DL7HG4WM.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.EFUXUR2V.js": { file: "vendor/webawesome/chunks/chunk.EFUXUR2V.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.H23DVATU.js": { file: "vendor/webawesome/chunks/chunk.H23DVATU.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.HGBRCPUS.js": { file: "vendor/webawesome/chunks/chunk.HGBRCPUS.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.HJQBZY2G.js": { file: "vendor/webawesome/chunks/chunk.HJQBZY2G.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.HOKYDFUG.js": { file: "vendor/webawesome/chunks/chunk.HOKYDFUG.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.IOZQCLLD.js": { file: "vendor/webawesome/chunks/chunk.IOZQCLLD.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.JB5Y2AN3.js": { file: "vendor/webawesome/chunks/chunk.JB5Y2AN3.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.JHZRD2LV.js": { file: "vendor/webawesome/chunks/chunk.JHZRD2LV.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.K5Q2EBKV.js": { file: "vendor/webawesome/chunks/chunk.K5Q2EBKV.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.KH7MR2OK.js": { file: "vendor/webawesome/chunks/chunk.KH7MR2OK.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.KKI7M5DP.js": { file: "vendor/webawesome/chunks/chunk.KKI7M5DP.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.KWDPKKFO.js": { file: "vendor/webawesome/chunks/chunk.KWDPKKFO.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.L2PH6XPF.js": { file: "vendor/webawesome/chunks/chunk.L2PH6XPF.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.LBLI4KS5.js": { file: "vendor/webawesome/chunks/chunk.LBLI4KS5.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.MEATLWHD.js": { file: "vendor/webawesome/chunks/chunk.MEATLWHD.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.MO2KS3JW.js": { file: "vendor/webawesome/chunks/chunk.MO2KS3JW.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.PZAN6FPN.js": { file: "vendor/webawesome/chunks/chunk.PZAN6FPN.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.QVJVDGCX.js": { file: "vendor/webawesome/chunks/chunk.QVJVDGCX.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.R7QX4M6R.js": { file: "vendor/webawesome/chunks/chunk.R7QX4M6R.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.RKPV5RWB.js": { file: "vendor/webawesome/chunks/chunk.RKPV5RWB.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.RPQJAXXR.js": { file: "vendor/webawesome/chunks/chunk.RPQJAXXR.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.RWNXKUCF.js": { file: "vendor/webawesome/chunks/chunk.RWNXKUCF.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.SKLR37OM.js": { file: "vendor/webawesome/chunks/chunk.SKLR37OM.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.SLTXS4GR.js": { file: "vendor/webawesome/chunks/chunk.SLTXS4GR.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.TLFIX76K.js": { file: "vendor/webawesome/chunks/chunk.TLFIX76K.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.UDRJMWVZ.js": { file: "vendor/webawesome/chunks/chunk.UDRJMWVZ.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.VC3BPUZJ.js": { file: "vendor/webawesome/chunks/chunk.VC3BPUZJ.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.WDIIGUNP.js": { file: "vendor/webawesome/chunks/chunk.WDIIGUNP.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.WLKYECLX.js": { file: "vendor/webawesome/chunks/chunk.WLKYECLX.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.YBFCQDTA.js": { file: "vendor/webawesome/chunks/chunk.YBFCQDTA.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.YDQCS2HK.js": { file: "vendor/webawesome/chunks/chunk.YDQCS2HK.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.YLIESRP2.js": { file: "vendor/webawesome/chunks/chunk.YLIESRP2.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/chunks/chunk.YPRC5XZF.js": { file: "vendor/webawesome/chunks/chunk.YPRC5XZF.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/components/tab-group/tab-group.js": { file: "vendor/webawesome/components/tab-group/tab-group.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/components/tab-panel/tab-panel.js": { file: "vendor/webawesome/components/tab-panel/tab-panel.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/components/tab/tab.js": { file: "vendor/webawesome/components/tab/tab.js", type: "text/javascript; charset=utf-8" },
  "/vendor/webawesome/styles/color/palettes/default.css": { file: "vendor/webawesome/styles/color/palettes/default.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/layers.css": { file: "vendor/webawesome/styles/layers.css", type: "text/css; charset=utf-8" },
  "/vendor/webawesome/styles/themes/default.css": { file: "vendor/webawesome/styles/themes/default.css", type: "text/css; charset=utf-8" },
  "/core/controllers/composer-tools.js": { file: "core/controllers/composer-tools.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/region-selection.js": { file: "core/controllers/region-selection.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/appearance.js": { file: "core/controllers/appearance.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/generative-ui.js": { file: "core/controllers/generative-ui.js", type: "text/javascript; charset=utf-8" },
  "/core/views/comparison.js": { file: "core/views/comparison.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/api-settings.js": { file: "core/controllers/api-settings.js", type: "text/javascript; charset=utf-8" },
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/shared/source/sha256.js": { file: "shared/source/sha256.js", type: "text/javascript; charset=utf-8" },
  "/core/views/session-workspace.js": { file: "core/views/session-workspace.js", type: "text/javascript; charset=utf-8" },
  "/core/controllers/workspace-events.js": { file: "core/controllers/workspace-events.js", type: "text/javascript; charset=utf-8" },
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
const CSS_MODULE_FILES = new Set(["tokens-base.css","workspace.css","conversation.css","terminology.css","controls-branches.css","materials.css","sources-navigation.css","responsive.css","session-workspace.css","reduced-motion.css","api-settings.css","studio-system.css","comparison.css"]);
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
