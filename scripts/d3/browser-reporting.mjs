/** Instance-owned runner evidence/verdict lifecycle; original contract retained. */
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
export function createBrowserReporting(deps) {
async function writeSummaryArtifact() {
  const summary = await deps.evalJs(deps.pageSummaryExpression()).catch(() => null);
  const payload = {
    script: deps.SCRIPT_NAME,
    version: deps.VERSION,
    mode: deps.MODE,
    generatedAt: new Date().toISOString(),
    git: deps.gitInfo(),
    checks: deps.results.map((r) => ({ id: r.id, status: r.status })),
    pageFinalState: summary === null ? null : deps.sanitizeSummary(summary),
    pageErrors: deps.chrome.pageErrors,
    netLog: deps.chrome.netLog.filter((e) => !e.url.includes("favicon")),
  };
  writeFileSync(join(deps.sc.artifactsDir, "summary.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

async function cleanup() {
  deps.killStudio();
  deps.stopChrome();
  const keep = deps.CLI.keepData || deps.CLI.dataDir !== null;
  if (keep && deps.sc.dataDir !== null) {
    console.log(`  data dir kept: ${deps.sanitizeText(deps.sc.dataDir)}`);
  } else if (deps.sc.dataDir !== null) {
    try { rmSync(deps.sc.dataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
  /* 工具面场景的 canary/marker 纪律（镜像 run-d3-real-pi.mjs）：canary
     位于数据目录 workspace 内（随数据目录处置）——布局若把它放到数据
     目录之外才需单独删除；marker 位于首个读取根，显式根属操作者目录
     ——非保留路径下移除本脚本创建的标记文件。 */
  const tp = deps.sc.toolPolicy;
  if (tp !== null && deps.sc.dataDir !== null) {
    const dataPhysical = deps.physicalPath(deps.sc.dataDir) ?? deps.sc.dataDir;
    if (tp.canaryPath !== null && !deps.isPathWithin(deps.physicalPath(tp.canaryPath) ?? tp.canaryPath, dataPhysical)) {
      try { rmSync(tp.canaryPath, { force: true }); } catch { /* 尽力而为 */ }
    }
    if (tp.markerPath !== null && !keep && !deps.isPathWithin(deps.physicalPath(tp.markerPath) ?? tp.markerPath, dataPhysical)) {
      try { rmSync(tp.markerPath, { force: true }); } catch { /* 尽力而为 */ }
    }
  }
  /* 模型错误相的错配 registry 副本（系统临时目录，数据目录/仓库之外）：
     绿色且非保留时删除；保留（--keep-data/--data）或有 FAIL（取证）时
     打印脱敏路径留档（镜像 run-d3-real-pi.mjs 的处置纪律）。 */
  const me = deps.sc.modelError;
  if (me !== null && me.misconfigDir !== null) {
    if (keep || deps.results.some((r) => r.status === "FAIL")) {
      console.log(`  misconfigured agent-dir copy kept: ${deps.sanitizeText(me.misconfigDir)}`);
    } else {
      try { rmSync(me.misconfigDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
  }
  if (deps.sc.artifactsDir !== null) {
    console.log(`  artifacts kept: ${deps.sanitizeText(deps.sc.artifactsDir)}`);
  }
}

function finish(code) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const entry of deps.results) counts[entry.status] += 1;
  console.log(
    `\n${deps.SCRIPT_NAME}: ${String(counts.PASS)} PASS / ${String(counts.FAIL)} FAIL / ${String(counts.BLOCKED)} BLOCKED / ${String(counts.NOT_RUN)} NOT_RUN (mode ${deps.MODE})`,
  );
  process.exit(code);
}
return { writeSummaryArtifact, cleanup, finish };
}
