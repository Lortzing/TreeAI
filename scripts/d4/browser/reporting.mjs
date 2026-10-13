/** Instance-owned runner evidence/verdict lifecycle; original contract retained. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
export function createD4Reporting(deps) {
function report(entry) {
  deps.results.push(entry);
  const tail =
    entry.reason !== undefined
      ? ` — ${entry.reason}`
      : entry.detail !== undefined
        ? ` — ${entry.detail}`
        : entry.error !== undefined
          ? ` — ${deps.truncate(entry.error.message, 400)}`
          : "";
  console.log(`  [${entry.status}] ${entry.id}${tail}`);
}

async function runCheck(id, fn) {
  const def = deps.byId.get(id);
  if (!def.modes.includes(deps.MODE)) {
    /* 模式门控的 NOT_RUN（如 selftest 下的 real-pi 专有检查）：不属于
       所选模式的义务，不计入 exit-3 判定（charter：0=所选模式全部通过）。 */
    report({ id, status: "NOT_RUN", reason: def.notRun?.[deps.MODE] ?? `not applicable in --mode ${deps.MODE}`, modeGated: true });
    return null;
  }
  if (fn === null) {
    /* 骨架检查：实现未落地，如实 NOT_RUN（计入 exit-3 判定）。 */
    report({ id, status: "NOT_RUN", reason: def.notRun?.[deps.MODE] ?? "not implemented yet" });
    return null;
  }
  if (def.id !== "chrome-boot" && !deps.chromeReady) {
    report({ id, status: "NOT_RUN", reason: "chrome did not boot (see chrome-boot)" });
    return null;
  }
  if (def.id !== "chrome-boot" && def.id !== "studio-boot" && !deps.booted) {
    report({ id, status: "NOT_RUN", reason: "studio process did not boot (see studio-boot)" });
    return null;
  }
  const startedAt = Date.now();
  try {
    const outcome = (await fn()) ?? {};
    report({ id, status: "PASS", ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}), durationMs: Date.now() - startedAt });
    return outcome;
  } catch (err) {
    if (err instanceof deps.NotRunError) {
      /* 探针级联（如导入未就位 → 阅读探针无对象）：NOT_RUN + 原因。 */
      report({ id, status: "NOT_RUN", reason: deps.sanitizeText(err instanceof Error ? err.message : String(err)) });
      return null;
    }
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

function gitInfo() {
  try {
    const head = execSync("git rev-parse HEAD", { cwd: deps.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    let dirty = false;
    try {
      dirty = execSync("git status --porcelain", { cwd: deps.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    } catch { /* 如实保持 false */ }
    return { head, dirty };
  } catch {
    return null;
  }
}

function fixturesBinding() {
  if (deps.scenario.fixturesUsed === null || deps.scenario.fixturesUsed.length === 0) return null;
  try {
    const manifest = readFileSync(deps.D4_FIXTURES_MANIFEST);
    return {
      manifestPath: "tests/fixtures/d4/MANIFEST.sha256",
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      used: deps.scenario.fixturesUsed,
    };
  } catch {
    return { manifestPath: "tests/fixtures/d4/MANIFEST.sha256", manifestSha256: null, used: deps.scenario.fixturesUsed };
  }
}

function finish(code) {
  const counts = { pass: 0, fail: 0, blocked: 0, notRun: 0 };
  for (const r of deps.results) counts[r.status === "PASS" ? "pass" : r.status === "FAIL" ? "fail" : r.status === "BLOCKED" ? "blocked" : "notRun"] += 1;
  /* 冻结语义（charter §8）：0=所选模式全部通过；2=失败；3=阻塞/未运行。
     模式门控的 NOT_RUN 不属于所选模式的义务，不触发 3；实现未落地的
     NOT_RUN 与 BLOCKED、级联 NOT_RUN 触发 3。 */
  let exit = code;
  if (exit === 0 && counts.fail > 0) exit = 2;
  else if (exit === 0 && (counts.blocked > 0 || deps.results.some((r) => r.status === "NOT_RUN" && r.modeGated !== true))) exit = 3;
  console.log("");
  console.log(
    `run-d4-browser: ${String(counts.pass)} PASS / ${String(counts.fail)} FAIL / ${String(counts.blocked)} BLOCKED / ${String(counts.notRun)} NOT_RUN (mode ${deps.MODE})`,
  );
  if (deps.MODE === "selftest") {
    console.log("note: selftest uses the offline echo driver — these results are never real-Pi evidence");
  }
  try {
    const git = gitInfo();
    const fixtures = fixturesBinding();
    /* 结构化结论字段（issue #8 增量验收 2026-09-30 18:18 P1：runId/gitCommit/
       mode/verdict/counts 不得缺位——sidecar 曾以 null 混过 Markdown 口头说明）。 */
    writeFileSync(join(deps.sc.artifactsDir, "summary.json"), JSON.stringify({
      script: "run-d4-browser.mjs",
      version: "0.6.0",
      runId: deps.sc.runId,
      mode: deps.MODE,
      verdict: counts.fail > 0 ? "HAS_FAIL" : counts.blocked > 0 || deps.results.some((r) => r.status === "NOT_RUN" && r.modeGated !== true) ? "INCOMPLETE" : "PASS",
      exitCode: exit,
      ...(deps.CLI.only.length > 0 ? { scoped: deps.CLI.only } : {}),
      counts: { pass: counts.pass, fail: counts.fail, blocked: counts.blocked, notRun: counts.notRun },
      gitCommit: git === null ? "unavailable (git rev-parse failed)" : git.head,
      gitDirty: git === null ? null : git.dirty,
      generatedAt: new Date().toISOString(),
      ...(git !== null ? { git } : {}),
      ...(fixtures !== null ? { fixtures } : {}),
      checks: deps.results,
      pageErrors: deps.chrome.pageErrors,
    }, null, 2));
  } catch { /* 尽力而为 */ }
  process.exit(exit);
}
return { report, runCheck, sweepBlocked, gitInfo, fixturesBinding, finish };
}
