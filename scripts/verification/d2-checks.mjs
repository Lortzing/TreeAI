import { verifyFixturesIntegrity } from "../../tests/support/verifier/probes.ts";
import { join } from "node:path";
import { runValidatorSelfTest } from "../../tests/support/verifier/schema-validator.ts";
import { runScannerSelfTest, scanFiles } from "../../tests/support/verifier/secret-scanner.ts";
import { existsSync, readdirSync } from "node:fs";
import { readJson, runCommand, tailLines } from "../../tests/support/verifier/util.ts";
import { tmpdir } from "node:os";
/** d2-checks original ordered checks Instance-owned state and dependencies. */

export function createD2Checks(deps) {

  /* ------------------------------------------------------------------ */
  /* The checks                                                          */
  /* ------------------------------------------------------------------ */

  const CHECKS = [
    {
      id: "fixtures-integrity",
      fn: async () => {
        const result = verifyFixturesIntegrity(
          join(deps.ROOT, "tests", "fixtures"),
          join(deps.ROOT, "schemas", "d2"),
        );
        if (result.problems.length > 0) {
          return {
            status: "FAIL",
            exitCode: 1,
            error: { message: result.problems.join("; ") },
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: `${result.hashedFiles} files hashed; ${result.validProbes} valid / ${result.invalidProbes} invalid probes confirmed`,
        };
      },
    },
    {
      id: "schema-validator-selftest",
      fn: async () => {
        const failures = runValidatorSelfTest();
        if (failures.length > 0) {
          return { status: "FAIL", exitCode: 1, error: { message: failures.join("; ") } };
        }
        return { status: "PASS", exitCode: 0, detail: "keyword corpus clean" };
      },
    },
    {
      id: "secret-scanner-selftest",
      fn: async () => {
        const result = runScannerSelfTest();
        if (!result.pass) {
          return {
            status: "FAIL",
            exitCode: 1,
            error: { message: result.problems.join("; ") },
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: `${result.rulesFired} rules fired on the synthetic corpus, clean corpus clean`,
        };
      },
    },
    {
      id: "typecheck",
      fn: deps.commandCheck("typecheck", process.execPath, ["scripts/typecheck.js"], {
        notRunOn: [3],
        notRunReason: "no workspace has TypeScript sources yet (Gate 0 scaffold semantics)",
      }),
    },
    {
      id: "tests-typecheck",
      fn: deps.commandCheck(
        "tests-typecheck",
        process.execPath,
        [join("node_modules", "typescript", "bin", "tsc"), "-p", "tests/tsconfig.json"],
      ),
    },
    {
      id: "unit-tests-contracts",
      fn: deps.moduleTestCheck("unit-tests-contracts", join("packages", "contracts"), "@treeai/contracts"),
    },
    {
      id: "unit-tests-runtime-pi",
      fn: deps.moduleTestCheck("unit-tests-runtime-pi", join("packages", "runtime-pi"), "@treeai/runtime-pi"),
    },
    {
      id: "unit-tests-persistence",
      fn: deps.moduleTestCheck("unit-tests-persistence", join("packages", "persistence"), "@treeai/persistence"),
    },
    {
      id: "unit-tests-tool-policy",
      fn: deps.moduleTestCheck("unit-tests-tool-policy", join("packages", "tool-policy"), "@treeai/tool-policy"),
    },
    {
      id: "unit-tests-event-journal",
      fn: deps.moduleTestCheck("unit-tests-event-journal", join("packages", "event-journal"), "@treeai/event-journal"),
    },
    {
      id: "unit-tests-agent-f",
      fn: deps.commandCheck("unit-tests-agent-f", process.execPath, ["--test", "tests/unit/*.test.ts"]),
    },
    {
      id: "integration-tests-agent-f",
      fn: deps.commandCheck("integration-tests-agent-f", process.execPath, [
        "--test",
        "tests/integration/*.test.ts",
      ]),
    },
    {
      id: "live-framework-selftest",
      fn: deps.commandCheck("live-framework-selftest", process.execPath, ["--test", "tests/live/*.test.ts"]),
    },
    {
      id: "runtime-smoke",
      fn: async () => {
        const dir = join(deps.ROOT, "apps", "runtime-smoke");
        if (!existsSync(dir)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "apps/runtime-smoke does not exist yet",
          };
        }
        const pkg = readJson(join(dir, "package.json"));
        const scripts = (pkg && pkg.scripts) || {};
        if (typeof scripts.test !== "string") {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason:
              "runtime-smoke has no test script wired (unexpected — check apps/runtime-smoke/package.json)",
          };
        }
        const res = runCommand("npm", ["test", "-w", "@treeai/runtime-smoke"], {
          cwd: deps.ROOT,
          timeoutMs: 600_000,
        });
        deps.log("runtime-smoke", res.stdout + res.stderr);
        if (res.status === 0) return { status: "PASS", exitCode: 0 };
        return {
          status: "FAIL",
          exitCode: res.status ?? 1,
          error: { message: `runtime-smoke tests exited ${String(res.status)}` },
        };
      },
    },
    {
      id: "unit-tests-studio",
      fn: deps.moduleTestCheck("unit-tests-studio", join("apps", "studio"), "@treeai/studio"),
    },
    {
      id: "pi-version-pin",
      fn: async () => {
        const runtimePiPkg = readJson(join(deps.ROOT, "packages", "runtime-pi", "package.json"));
        const dep =
          runtimePiPkg && runtimePiPkg.dependencies
            ? runtimePiPkg.dependencies["@earendil-works/pi-coding-agent"]
            : undefined;
        if (dep !== "0.85.1") {
          return {
            status: "FAIL",
            exitCode: 1,
            error: {
              message: `packages/runtime-pi must depend on @earendil-works/pi-coding-agent exactly "0.85.1" (D1 DECISION-003); found ${JSON.stringify(dep)}`,
            },
          };
        }
        const installed = readJson(
          join(deps.ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        );
        const installedVersion =
          installed && typeof installed.version === "string" ? installed.version : null;
        if (installedVersion !== "0.85.1") {
          return {
            status: "FAIL",
            exitCode: 1,
            error: {
              message: `installed Pi version is ${JSON.stringify(installedVersion)}, pinned is "0.85.1" (run npm ci)`,
            },
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: `declared "${dep}" / installed "${installedVersion}"`,
        };
      },
    },
    {
      id: "secret-scan-workspace",
      fn: async () => {
        const roots = [
          join(deps.ROOT, "tests"),
          join(deps.ROOT, "schemas", "d2"),
          join(deps.ROOT, ".github", "workflows"),
          join(deps.ROOT, "evidence", "d2"),
          join(deps.ROOT, "evidence", "d3"),
          join(deps.ROOT, "evidence", "d3", "browser"),
        ].filter((p) => existsSync(p));
        // Preserve the original D2 entrypoint scope and include its extracted
        // check owners so moving code cannot bypass the workspace scanner.
        const scriptsDir = join(deps.ROOT, "scripts");
        if (existsSync(scriptsDir)) {
          for (const name of readdirSync(scriptsDir)) {
            if (/^verify-d2/.test(name)) roots.push(join(scriptsDir, name));
          }
        }
        const verificationDir = join(scriptsDir, "verification");
        if (existsSync(verificationDir)) roots.push(verificationDir);
        const report = scanFiles(roots, deps.ROOT);
        deps.log(
          "secret-scan-workspace",
          `scanned ${report.stats.filesScanned} files across ${roots.length} roots\n` +
            JSON.stringify(report.findings, null, 2),
        );
        if (report.findingCount > 0) {
          return {
            status: "FAIL",
            exitCode: 1,
            error: {
              message: `${report.findingCount} secret-scan findings (rules: ${[
                ...new Set(report.findings.map((f) => f.ruleId)),
              ].join(", ")})`,
            },
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail: `${report.stats.filesScanned} files scanned, 0 findings (scanner ${report.scannerVersion})`,
        };
      },
    },
    {
      id: "residual-resources",
      fn: async () => {
        const patterns = [
          /^treeai-fake-rt\./,
          /^treeai-scanner-/,
          /^treeai-live-selftest\./,
          /^treeai-d2-e2e-/,
          /^treeai-probe-/,
          /^treeai-d2-sectest\./,
        ];
        const leftovers = [];
        try {
          for (const name of readdirSync(tmpdir())) {
            if (patterns.some((p) => p.test(name))) leftovers.push(name);
          }
        } catch (err) {
          return {
            status: "BLOCKED",
            exitCode: null,
            reason: `temp dir unreadable: ${String(err)}`,
          };
        }
        if (leftovers.length > 0) {
          return {
            status: "FAIL",
            exitCode: 1,
            error: { message: `leaked temp resources: ${leftovers.join(", ")}` },
          };
        }
        return { status: "PASS", exitCode: 0, detail: "no treeai-* temp leftovers" };
      },
    },
    {
      id: "d1-repro",
      fn: async () => {
        if (!deps.D1_REPRO) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason:
              "explicit --d1-repro flag required (offline PRs never force live model calls); execution also needs network + d1-spikes write authorization",
          };
        }
        const script = join(deps.ROOT, "d1-spikes", "scripts", "verify-d1");
        if (!existsSync(script)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "d1-spikes/scripts/verify-d1 not present in this tree",
          };
        }
        const res = runCommand(script, ["--repro"], { cwd: deps.ROOT, timeoutMs: 600_000 });
        deps.log("d1-repro", res.stdout + res.stderr);
        if (res.status === 0) {
          return { status: "PASS", exitCode: 0, detail: tailLines(res.stdout, 2) };
        }
        return {
          status: "FAIL",
          exitCode: res.status ?? 1,
          error: { message: `verify-d1 --repro exited ${String(res.status)}` },
        };
      },
    },
  ];

  return {
    CHECKS,
  };
}
