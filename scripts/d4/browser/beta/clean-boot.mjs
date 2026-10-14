/** beta clean-boot phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { waitFor } from "../material-probes.mjs";
import { inputClickAt } from "../material-probes.mjs";
import { importMaterialViaHttp } from "../material-probes.mjs";
import { waitForVersionReady } from "../material-probes.mjs";

export async function runBetaCleanBoot(deps) {

      {
        /* 先切空白页：切断上一探针页面对其进程的轮询（bootStudioOn 会停掉它）。 */
        await deps.ctx.navigate("about:blank");
        const url = await deps.ctx.bootStudioOn(deps.dataDir);
        /* 实际启动命令（runner 的真实 spawn argv——探针上下文如实取回）。 */
        const actualArgv = deps.ctx.studioArgv();
        const readmeEntryFromStartScript = resolve(deps.ctx.ROOT, "apps", "studio", deps.studioPkg.scripts?.start?.replace(/^node\s+/, "") ?? "");
        const actualEntry = actualArgv[0];
        const readmeConsistency = {
          readmeStartCommand: deps.readme.startCommand,
          readmeInstallCommand: deps.readme.installCommand,
          readmeOptionsLine: deps.readme.optionsLine,
          packageStartScript: deps.studioPkg.scripts?.start ?? null,
          actualArgv,
          entryMatchesReadmeStartScript: existsSync(readmeEntryFromStartScript) && resolve(actualEntry) === readmeEntryFromStartScript,
          flagsWithinReadmeOptions: actualArgv.includes("--port") && actualArgv.includes("--data"),
        };
        const problems = [];
        if (deps.readme.installCommand !== "npm ci") {
          problems.push("README no longer documents npm ci");
        }
        if (deps.readme.urlLine !== "http://127.0.0.1:8787") {
          problems.push(`README local URL changed: ${String(deps.readme.urlLine)}`);
        }
        if (deps.readme.startCommand !== "npm run start --workspace @treeai/studio") {
          problems.push(`README start command is ${JSON.stringify(deps.readme.startCommand)}`);
        }
        if (deps.studioPkg.scripts?.start !== "node src/index.ts") {
          problems.push(`apps/studio package.json start is ${JSON.stringify(deps.studioPkg.scripts?.start)}`);
        }
        if (!readmeConsistency.entryMatchesReadmeStartScript) {
          problems.push(`the actually-spawned entry (${actualEntry}) does not resolve to the README start script's entry`);
        }
        if (!readmeConsistency.flagsWithinReadmeOptions || (deps.readme.optionsLine ?? "").includes("--port") !== true || (deps.readme.optionsLine ?? "").includes("--data") !== true) {
          problems.push(`the flags actually passed are not the README-documented options (README options line: ${JSON.stringify(deps.readme.optionsLine)})`);
        }
        if (problems.length > 0) {
          throw new Error(`cleanBoot: the actual start path diverges from the README studio section — ${problems.join("; ")}`);
        }

        await deps.ctx.navigate(url);
        await waitFor(deps.ctx, `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`, {
          label: "studio shell on the clean data dir (README start path)",
          timeoutMs: 30_000,
        });
        /* 首启空状态诚实：无树（空态可见 + 森林列表无树行 + 服务端 0 树）、
           无材料（材料段隐藏）、建树流程可用（真实点击建树即证据）。 */
        const emptyState = await deps.ctx.evalJs(
          `(() => ({ emptyStateVisible: !document.getElementById("empty-state").hidden && document.getElementById("empty-new-tree") !== null, ` +
            `treeViewHidden: document.getElementById("tree-view").hidden, ` +
            `forestTreeButtons: document.querySelectorAll("#tree-list button").length, ` +
            `navForestTreeButtons: document.querySelectorAll("#nav-tree-results button[data-tree-id]").length, ` +
            `materialsSectionHidden: document.getElementById("materials-section").hidden, ` +
            `newTreeButton: document.getElementById("new-tree") !== null, ` +
            `sourceDrawerToggleHidden: document.getElementById("source-drawer-toggle").hidden }))()`,
        );
        const treesApi = await deps.ctx.api("GET", "/api/trees");
        const serverTreeCount = treesApi.body?.trees?.length ?? null;
        const emptyProblems = [];
        if (emptyState.emptyStateVisible !== true) emptyProblems.push("the empty state is not visible with its create-tree action");
        if (emptyState.treeViewHidden !== true) emptyProblems.push("#tree-view is visible on a clean boot");
        if (emptyState.forestTreeButtons !== 0) emptyProblems.push(`forest lists ${String(emptyState.forestTreeButtons)} tree(s) on a clean boot`);
        if (emptyState.navForestTreeButtons !== 0) emptyProblems.push(`nav forest lists ${String(emptyState.navForestTreeButtons)} tree(s) on a clean boot`);
        if (emptyState.materialsSectionHidden !== true) emptyProblems.push("the materials section is visible with no tree open");
        if (emptyState.newTreeButton !== true) emptyProblems.push("the New Tree button is absent");
        if (serverTreeCount !== 0) emptyProblems.push(`the server reports ${String(serverTreeCount)} tree(s) on a clean boot`);
        if (emptyProblems.length > 0) {
          throw new Error(`cleanBoot: the first-boot empty state is not honest — ${emptyProblems.join("; ")}`);
        }
        /* 建树流程可用：真实点击空态主操作。 */
        await inputClickAt(deps.ctx, "#empty-new-tree");
        await waitFor(
          deps.ctx,
          `(() => { const view = document.getElementById("tree-view"); const section = document.getElementById("materials-section"); ` +
            `return view !== null && !view.hidden && section !== null && !section.hidden; })()`,
          { label: "create-tree flow usable (workbench opens after the empty-state action)", timeoutMs: 20_000 },
        );
        const treesAfter = await deps.ctx.api("GET", "/api/trees");
        const treeId = treesAfter.body?.trees?.[0]?.id ?? null;
        if (treesAfter.body?.trees?.length !== 1 || typeof treeId !== "string") {
          throw new Error(`cleanBoot: create-tree flow did not produce exactly one tree (${JSON.stringify(treesAfter.body?.trees?.length ?? null)})`);
        }
        deps.cleanBoot.readmeStartCommand = deps.readme.startCommand;
        deps.cleanBoot.readmeOptionsLine = deps.readme.optionsLine;
        deps.cleanBoot.packageStartScript = deps.studioPkg.scripts.start;
        deps.cleanBoot.actualArgv = actualArgv;
        deps.cleanBoot.entryConsistentWithReadme = readmeConsistency.entryMatchesReadmeStartScript;
        deps.cleanBoot.flagsConsistentWithReadme = readmeConsistency.flagsWithinReadmeOptions;
        deps.cleanBoot.emptyStateHonest = emptyState;
        deps.cleanBoot.serverTreeCountOnBoot = serverTreeCount;
        deps.cleanBoot.treeCreatedViaEmptyState = treeId;
        deps.scenarioSetup.treeId = treeId;
        await deps.ctx.screenshot("beta-cleanboot-workbench");

        /* 场景语料：B1 冻结 fixture 经真实导入 API（D4-1 契约面）。 */
        const imported = {};
        for (const fixture of [
          { id: deps.MD_FIXTURE_ID, filename: deps.mdFixture.filename, bytes: deps.mdFixture.bytes, truth: deps.mdFixture.truth },
          { id: deps.PDF_FIXTURE_ID, filename: deps.pdfFixture.filename, bytes: deps.pdfFixture.bytes, truth: deps.pdfFixture.truth },
        ]) {
          const res = await importMaterialViaHttp(deps.ctx, treeId, fixture.filename, fixture.bytes, 30_000);
          if (res.status !== 201 || res.body?.created !== true) {
            throw new Error(`${fixture.id}: import did not 201/create (HTTP ${String(res.status)}): ${JSON.stringify(res.body)}`);
          }
          await waitForVersionReady(deps.ctx, treeId, res.body.material.id, res.body.version.id, fixture.id);
          imported[fixture.id] = { materialId: res.body.material.id, versionId: res.body.version.id, title: res.body.material.title };
        }
        /* 刷新页面（真实导航——应用自身重拉材料列表）。 */
        await deps.ctx.navigate(url);
        await waitFor(
          deps.ctx,
          `(() => document.querySelectorAll("#material-list button[data-material-id]").length === 2)()`,
          { label: "sidebar lists both imported materials after reload", timeoutMs: 20_000 },
        );
      }

  return {

  };
}
