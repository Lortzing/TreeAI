/** facts ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  readdirSync,
} from "node:fs";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 服务端事实读回                                                        */
/* ------------------------------------------------------------------ */

export async function treeStateViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
  if (res.status !== 200) throw new Error(`terminology probe /state HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function trunkViewOf(state) {
  return (state?.branches ?? []).find((view) => view?.branch?.parentBranchId === null) ?? null;
}

export async function terminologyViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/terminology`);
  if (res.status !== 200) throw new Error(`terminology probe read model HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function readingModeViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/terminology/settings/reading-mode`);
  if (res.status !== 200) throw new Error(`reading-mode GET HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return res.body?.readingMode ?? null;
}

/** 隔离执行器零派发佐证：terminology/sessions 零文件（会话文件只在执行器
 *  prompt 落地后产生——echo 与真实 Pi 同纪律）。 */
export function terminologySessionFiles(dataDir) {
  try {
    return readdirSync(join(dataDir, "terminology", "sessions"));
  } catch {
    return null;
  }
}
