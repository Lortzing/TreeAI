/** import-api ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  waitForVersionStatus,
} from "./fixture-api.mjs";

/* ------------------------------------------------------------------ */
/* 探针 1：d4-import-material                                            */
/* ------------------------------------------------------------------ */

export async function importMaterialViaHttp(ctx, treeId, filename, bytes, timeoutMs = 15_000) {
  const port = ctx.studioPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/trees/${encodeURIComponent(treeId)}/materials`, {
      method: "POST",
      headers: { "x-treeai-filename": encodeURIComponent(filename), "content-type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForVersionReady(ctx, treeId, materialId, versionId, fixtureId) {
  return waitForVersionStatus(ctx, treeId, materialId, versionId, fixtureId, "ready");
}
