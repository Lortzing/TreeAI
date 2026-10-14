/** terminology clean-boot phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { inputClickAt } from "../material-probes.mjs";

export async function runTerminologyCleanBoot(deps) {

      /* ============ 0) 专用数据目录冷启（真实 Studio 进程） ============ */
      await deps.ctx.navigate("about:blank");

      const url = await deps.ctx.bootStudioOn(deps.dataDir);

      await deps.ctx.navigate(url);

      /* 剪贴板读权限（③ 复制不变量的剪贴板回读口径；不可用则如实降级为
         selection.toString 字节相等并记录——material 探针同款诚实降级）。 */
      try {
        await deps.ctx.cdpSend("Browser.grantPermissions", {
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
          origin: new URL(url).origin,
        });
      } catch {
        /* 尽力而为：降级口径在复制断言处如实记录 */
      }

      await waitFor(deps.ctx, `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`, {
        label: "studio shell on the terminology probe's clean data dir",
        timeoutMs: 30_000,
      });

      /* 建树：真实 UI 空态主操作。 */
      await inputClickAt(deps.ctx, "#empty-new-tree");

      await waitFor(
        deps.ctx,
        `(() => { const view = document.getElementById("tree-view"); const composer = document.getElementById("prompt-input"); ` +
          `return view !== null && !view.hidden && composer !== null && !composer.disabled; })()`,
        { label: "create-tree flow usable (workbench opens)", timeoutMs: 20_000 },
      );

      const trees = await deps.ctx.api("GET", "/api/trees");

      const treeId = trees.body?.trees?.[0]?.id ?? null;

      if (trees.body?.trees?.length !== 1 || typeof treeId !== "string") {
        throw new Error(`terminology probe: the empty-state create-tree flow did not produce exactly one tree (${JSON.stringify(trees.body?.trees?.length ?? null)})`);
      }

      await deps.ctx.screenshot("term-workbench");

  return {
    treeId,
  };
}
