
/** Original per-check reporting and mode gates Instance-owned state and dependencies. */

export function createBrowserResults(deps) {

  function report(entry) {
    deps.results.push(entry);
    const mark = entry.status;
    const tail =
      entry.reason !== undefined
        ? ` — ${entry.reason}`
        : entry.detail !== undefined
          ? ` — ${entry.detail}`
          : entry.error !== undefined
            ? ` — ${deps.truncate(entry.error.message, 400)}`
            : "";
    console.log(`  [${mark}] ${entry.id}${tail}`);
  }

  async function runCheck(id, fn) {
    const def = deps.byId.get(id);
    if (!def.modes.includes(deps.MODE)) {
      report({ id, status: "NOT_RUN", reason: def.notRun?.[deps.MODE] ?? `not applicable in --mode ${deps.MODE}` });
      return null;
    }
    if (def.id === "chrome-boot" || def.id === "studio-boot") {
      /* 两个引导项彼此独立，各自如实登记。 */
    } else if (!deps.chromeReady) {
      report({ id, status: "NOT_RUN", reason: "chrome did not boot (see chrome-boot)" });
      return null;
    } else if (!deps.booted) {
      report({ id, status: "NOT_RUN", reason: "studio process did not boot (see studio-boot)" });
      return null;
    }
    /* 工具门（浏览器面工具策略场景的第二重门控，镜像 run-d3-real-pi.mjs
       的 toolsGate 词汇）：real-pi 但 --pi-tools 未含 read 时整相 NOT_RUN
       （诚实原因）。 */
    if (def.toolsGate === true && deps.sc.toolPolicy !== null && !deps.sc.toolPolicy.applicable) {
      report({ id, status: "NOT_RUN", reason: deps.sc.toolPolicy.readGateReason });
      return null;
    }
    const startedAt = Date.now();
    try {
      const outcome = (await fn()) ?? {};
      report({ id, status: "PASS", ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}), durationMs: Date.now() - startedAt });
      return outcome;
    } catch (err) {
      report({
        id,
        status: "FAIL",
        error: { message: deps.sanitizeText(err instanceof Error ? err.message : String(err)) },
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  }

  function sweepBlocked(reason) {
    for (const def of deps.CHECK_DEFS) report({ id: def.id, status: "BLOCKED", reason });
  }

  return {
    sweepBlocked,
    runCheck,
  };
}
