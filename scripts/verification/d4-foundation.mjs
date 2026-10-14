import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { verifyD4FixturesIntegrity } from "../../tests/support/verifier/d4-probes.ts";
import { readJson, runCommand } from "../../tests/support/verifier/util.ts";
/** d4-foundation original ordered checks Instance-owned state and dependencies. */

export function createD4Foundation(deps) {

  /* ------------------------------------------------------------------ */
  /* The checks                                                          */
  /* ------------------------------------------------------------------ */

  const FOUNDATION_CHECKS = [

    {
      id: "fixtures-integrity-d4",
      fn: async () => {
        const d4Root = join(deps.ROOT, "tests", "fixtures", "d4");
        if (!existsSync(d4Root)) {
          return { status: "NOT_RUN", exitCode: null, reason: "tests/fixtures/d4 not present in this tree" };
        }
        const result = verifyD4FixturesIntegrity(d4Root);
        if (result.problems.length > 0) {
          return { status: "FAIL", exitCode: 1, error: { message: result.problems.join("; ") } };
        }
        const s = result.stats;
        return {
          status: "PASS",
          exitCode: 0,
          detail:
            `${s.hashedFiles} files hashed; B1 ${s.mdFixtures} md + ${s.pdfFixtures} pdf + ` +
            `${s.negativeFixtures} negatives + ${s.versionPairs} version pair(s); ` +
            `B2 ${s.validSelections} valid / ${s.invalidSelections} invalid; ` +
            `B4 ${s.positiveQueries} positive / ${s.noResultQueries} no-result`,
        };
      },
    },

    {
      id: "docs-integrity-d4",
      fn: async () => {
        const problems = [];
        const mirrorPath = join(deps.ROOT, "docs", "d4", "D4-project-v1.md");
        const mirror = existsSync(mirrorPath) ? readFileSync(mirrorPath, "utf8") : null;
        if (mirror === null) {
          problems.push("docs/d4/D4-project-v1.md (项目书镜像) missing");
        } else {
          for (const marker of [
            "TreeAI D4 项目书 v1.1",
            "负责人最新明确确认",
            "## 6. D4 验收矩阵",
            "## 9. 开工清单与停止条件",
            "D4-0",
            "D4-8",
          ]) {
            if (!mirror.includes(marker)) problems.push(`mirror missing marker: ${marker}`);
          }
          if (!mirror.startsWith("<!--")) {
            problems.push("mirror must start with the provenance comment block");
          }
        }
        const statusPath = join(deps.ROOT, "docs", "d4", "D4-status.md");
        const status = existsSync(statusPath) ? readFileSync(statusPath, "utf8") : null;
        if (status === null) {
          problems.push("docs/d4/D4-status.md missing");
        } else {
          for (const marker of ["D4-0", "D4-1", "D4-2", "D4-3", "D4-4", "D4-5", "D4-6", "D4-7", "D4-8", "D4-G0", "D4-G3"]) {
            if (!status.includes(marker)) problems.push(`D4-status missing task id: ${marker}`);
          }
          for (const column of ["任务ID", "状态", "被测完整SHA", "证据类型", "复验条件"]) {
            if (!status.includes(column)) problems.push(`D4-status missing required column: ${column}`);
          }
        }
        const adrPath = join(deps.ROOT, "docs", "adr", "ADR-003-d4-material-sources-versions-run-origins.md");
        const adr = existsSync(adrPath) ? readFileSync(adrPath, "utf8") : null;
        if (adr === null) {
          problems.push("ADR-003 missing");
        } else {
          for (const marker of [
            "**状态：Accepted",
            "决策一",
            "决策二",
            "决策三",
            "测试义务",
          ]) {
            if (!adr.includes(marker)) problems.push(`ADR-003 missing marker: ${marker}`);
          }
        }
        const adr4Path = join(deps.ROOT, "docs", "adr", "ADR-004-d4-material-branching-and-first-question.md");
        const adr4 = existsSync(adr4Path) ? readFileSync(adr4Path, "utf8") : null;
        if (adr4 === null) {
          problems.push("ADR-004 missing");
        } else {
          for (const marker of ["**状态：Accepted", "决策一", "决策四", "测试义务"]) {
            if (!adr4.includes(marker)) problems.push(`ADR-004 missing marker: ${marker}`);
          }
        }
        const contractsPath = join(deps.ROOT, "docs", "d4", "D4-contracts.md");
        const contracts = existsSync(contractsPath) ? readFileSync(contractsPath, "utf8") : null;
        if (contracts === null) {
          problems.push("docs/d4/D4-contracts.md missing");
        } else {
          for (const marker of ["0008", "material_versions", "branches/from-material", "冻结验收集格式"]) {
            if (!contracts.includes(marker)) problems.push(`D4-contracts missing marker: ${marker}`);
          }
        }
        if (problems.length > 0) {
          return { status: "FAIL", exitCode: 1, error: { message: problems.join("; ") } };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: "project mirror, status matrix, ADR-003 and contracts design all present and structurally complete",
        };
      },
    },

    {
      id: "entrypoints-d4",
      fn: async () => {
        const problems = [];
        const pkg = readJson(join(deps.ROOT, "package.json"));
        const scripts = (pkg && pkg.scripts) || {};
        const required = ["verify:d4", "verify:d4:selftest", "run:d4-browser"];
        for (const name of required) {
          if (typeof scripts[name] !== "string") {
            problems.push(`package.json script not wired: ${name}`);
          }
        }
        for (const file of ["scripts/verify-d4.js", "scripts/verify-d4-selftest.js", "scripts/run-d4-browser.mjs"]) {
          if (!existsSync(join(deps.ROOT, file))) problems.push(`entry script missing: ${file}`);
        }
        if (problems.length > 0) {
          return { status: "FAIL", exitCode: 1, error: { message: problems.join("; ") } };
        }
        const help = runCommand(process.execPath, [join("scripts", "run-d4-browser.mjs"), "--help"], {
          cwd: deps.ROOT,
          timeoutMs: 60_000,
        });
        deps.log("entrypoints-d4", `$ node scripts/run-d4-browser.mjs --help\n${help.stdout}\n${help.stderr}`);
        if (help.status !== 0) {
          return {
            status: "FAIL",
            exitCode: 1,
            error: { message: `run-d4-browser --help exited ${String(help.status)}` },
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: "verify:d4 / verify:d4:selftest / run:d4-browser wired; runner help renders",
        };
      },
    },

    {
      id: "typecheck",
      fn: deps.commandCheck("typecheck", "npm", ["run", "typecheck"], { timeoutMs: 600_000 }),
    },

    {
      id: "tests-typecheck",
      fn: deps.commandCheck(
        "tests-typecheck",
        process.execPath,
        [join("node_modules", "typescript", "bin", "tsc"), "-p", "tests/tsconfig.json"],
        { timeoutMs: 600_000 },
      ),
    },

    {
      id: "unit-tests-d4",
      fn: deps.commandCheck(
        "unit-tests-d4",
        process.execPath,
        [
          "--test",
          join("tests", "unit", "d4-fixtures-integrity.test.ts"),
          join("tests", "unit", "d4-7-installer.test.ts"),
        ],
        { timeoutMs: 600_000 },
      ),
    }
  ];

  return {
    FOUNDATION_CHECKS,
  };
}
