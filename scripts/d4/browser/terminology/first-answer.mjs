/** terminology first-answer phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */

export async function runTerminologyFirstAnswer(deps) {


      /* ============ 2) ① manual-only 下回答后零自动派发 + 无建议条 ============ */
      {
        const { answerTurn: a1 } = await deps.sendTrunkPrompt(deps.ctx, deps.treeId, deps.TRUNK_Q1, {
          timeoutMs: deps.answerTimeoutMs,
          label: "trunk Q1 (manual-only phase)",
        });
        const read = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const stripAbsent = await deps.ctx.evalJs(`(() => document.querySelector("#conversation .term-suggest-strip") === null)()`);
        const sessionFiles = deps.terminologySessionFiles(deps.dataDir);
        const problems = [];
        if ((read?.tasks ?? []).length !== 0) problems.push(`tasks: ${JSON.stringify(read?.tasks)}`);
        if (read?.usage?.total?.requests !== 0) problems.push(`usage requests: ${JSON.stringify(read?.usage?.total)}`);
        if (read?.autoSuggestions?.enabled !== false || read?.autoSuggestions?.reason !== "quality-gate-pending") {
          problems.push(`autoSuggestions: ${JSON.stringify(read?.autoSuggestions)}`);
        }
        if ((read?.autoSuggestions?.sets ?? []).length !== 0) problems.push(`suggestion sets: ${JSON.stringify(read?.autoSuggestions?.sets)}`);
        if (stripAbsent !== true) problems.push("a .term-suggest-strip rendered");
        if (sessionFiles !== null && sessionFiles.length !== 0) problems.push(`terminology session files: ${JSON.stringify(sessionFiles)}`);
        if (problems.length > 0) {
          throw new Error(`terminology ① manual-only zero-auto-dispatch violated — ${problems.join("; ")}`);
        }
        deps.record.readingModes.manualOnlyNoStrip = {
          answerLen: a1.text.length,
          tasks: 0,
          usageRequests: 0,
          suggestionSets: 0,
          stripRendered: false,
          isolatedExecutorSessionFiles: 0,
          reason: "quality-gate-pending",
        };
      }

  return {

  };
}
