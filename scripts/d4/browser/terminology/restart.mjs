/** terminology restart phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { waitForConversationHistory } from "../reading-rounds.mjs";

export async function runTerminologyRestart(deps) {

      {
        await deps.ctx.stopStudio();
        await deps.ctx.navigate("about:blank");
        /* 同数据目录新进程：探针专用数据目录与 runner 的 sc.dataDir 不同，
           restartStudioSamePort 会错启 runner 目录——这里以 bootStudioOn 在
           本探针目录上起新进程（新端口）。口径披露：术语探针的重启断言全部
           是服务端持久事实（批注/分支/turn/账本），不依赖浏览器 localStorage
           （同源存活仅影响挂起意图等浏览器侧缓存——术语路径无此依赖）。 */
        const newUrl = await deps.ctx.bootStudioOn(deps.dataDir);
        await deps.ctx.navigate(newUrl);
        try {
          await waitFor(
            deps.ctx,
            `(() => { const view = document.getElementById("tree-view"); ` +
              `return view !== null && !view.hidden && document.querySelectorAll("#conversation .turn").length >= 4; })()`,
            { label: "workbench reopened after the same-port restart (terminology probe)", timeoutMs: 30_000 },
          );
        } catch (err) {
          const snap = await deps.ctx.evalJs(
            `(() => ({ treeViewHidden: document.getElementById("tree-view")?.hidden ?? null, ` +
              `emptyState: !document.getElementById("empty-state")?.hidden, ` +
              `turns: document.querySelectorAll("#conversation .turn").length, ` +
              `treeRows: document.querySelectorAll("#tree-list button").length, ` +
              `activeTree: document.querySelector("#tree-list button.active span")?.textContent ?? null, ` +
              `errorBanner: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 200), ` +
              `bodySnippet: (document.body.textContent ?? "").slice(0, 200) }))()`,
          ).catch(() => null);
          throw new Error(`restart: the workbench did not reopen — snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
        }
        /* Return 卡与批注覆盖跨重启可读。 */
        const bodyHasReturns = await deps.ctx.evalJs(
          `(() => { const text = document.body.textContent ?? ""; ` +
            `return text.includes(${JSON.stringify(deps.TERM_MARKERS.termRet)}) && text.includes(${JSON.stringify(deps.TERM_MARKERS.rangeRet)}); })()`,
        );
        if (bodyHasReturns !== true) {
          throw new Error("the terminology Return cards are not visible on the Trunk after the restart");
        }
        const marksAfterRestart = await deps.ctx.evalJs(
          `(() => { const turn = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))}); ` +
            `if (turn === null) return null; ` +
            `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
            `return { count: marks.length, texts: marks.map((m) => m.textContent) }; })()`,
        );
        if (marksAfterRestart?.count !== 2) {
          throw new Error(`annotation overlays after the restart: ${JSON.stringify(marksAfterRestart)} (expected both saved annotations)`);
        }
        /* 抽屉批注列表（快照 + 推广去向）。 */
        await deps.openDrawer(deps.ctx);
        const drawerAfterRestart = await deps.ctx.evalJs(
          `(() => { const drawer = document.getElementById("source-drawer"); ` +
            `const items = [...drawer.querySelectorAll(".drawer-list li")]; ` +
            `const text = drawer.textContent ?? ""; ` +
            `return { listText: items.map((li) => li.textContent), hasPromotedNote: text.includes("promoted to"), ` +
              `usageLine: [...drawer.querySelectorAll("p.muted")].find((p) => p.textContent.includes("terminology executor"))?.textContent ?? null }; })()`,
        );
        const drawerProblems = [];
        if (drawerAfterRestart.listText.length < 2) drawerProblems.push(`annotations list: ${JSON.stringify(drawerAfterRestart.listText)}`);
        if (!(drawerAfterRestart.listText.some((li) => li.includes(`“${deps.termPick.text}”`)))) {
          drawerProblems.push(`term annotation not listed: ${JSON.stringify(drawerAfterRestart.listText)}`);
        }
        if (drawerAfterRestart.hasPromotedNote !== true) drawerProblems.push("promoted-to notes missing from the annotations list");
        if (drawerProblems.length > 0) {
          throw new Error(`terminology restart: drawer annotations mismatch — ${drawerProblems.join("; ")}`);
        }
        await deps.closeDrawer(deps.ctx);
        deps.record.restart.annotationsReadable = {
          overlays: marksAfterRestart.texts,
          drawerList: drawerAfterRestart.listText,
          usageLine: drawerAfterRestart.usageLine,
        };

        /* 支线历史可读 + 继续追问落地。 */
        await deps.openBranchPanelViaTab(deps.ctx, deps.termBranchId, "term branch after restart");
        await waitForConversationHistory(deps.ctx, "#panel-conversation", [deps.TERM_MARKERS.termQ1, deps.TERM_MARKERS.termF2],
          { label: "term exploration history readable after the restart" });
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.restartF, `重启后的续走追问：之前的结论还成立吗？（${deps.TERM_MARKERS.restartF}）`, deps.answerTimeoutMs, "term branch after restart");
        deps.record.restart.historyAndContinuation = {
          port: `${String(deps.oldPort)}→${String(deps.ctx.studioPort())}`,
          historyMarkers: [deps.TERM_MARKERS.termQ1, deps.TERM_MARKERS.termF2],
          continuationFollowUp: deps.TERM_MARKERS.restartF,
        };
        await deps.ctx.screenshot("term-restart-continuation");
        await deps.closePanel(deps.ctx);
      }

  return {

  };
}
