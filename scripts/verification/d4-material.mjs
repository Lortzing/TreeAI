import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { runB1ImportCheck } from "../../tests/support/verifier/d4-b1-import.ts";
import { truncate } from "../../tests/support/verifier/util.ts";
import { runB2AnchorsCheck } from "../../tests/support/verifier/d4-b2-anchors.ts";
import { runB3ExplorationCheck } from "../../tests/support/verifier/d4-b3-exploration.ts";
import { runB4SearchCheck } from "../../tests/support/verifier/d4-b4-search.ts";
import { runB5RestoreCheck } from "../../tests/support/verifier/d4-b5-restore.ts";
/** d4-material original ordered checks Instance-owned state and dependencies. */

export function createD4Material(deps) {

  const MATERIAL_CHECKS = [

    // ---- acceptance-matrix rows: NOT_RUN until their work package lands ----
    {
      id: "b1-import-versions",
      // REAL executing check (D4-1): the import pipeline runs against whatever
      // b1-import registries exist at runtime (md/pdf enumerated generically);
      // ready fixtures must round-trip to their frozen truth byte-exactly,
      // negatives must be rejected with the frozen reason, same-bytes re-import
      // must reuse the version, version pairs execute when locatable, and the
      // manifest-registered oversize probes (>20MiB / >200 pages / >1M units)
      // are generated deterministically here and must be refused.
      fn: async () => {
        const d4Root = join(deps.ROOT, "tests", "fixtures", "d4");
        if (!existsSync(d4Root)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "tests/fixtures/d4 not present in this tree",
          };
        }
        const outcome = await runB1ImportCheck(d4Root);
        deps.log("b1-import-versions", `b1 import/versions check\n${outcome.lines.join("\n")}`);
        if (outcome.status === "FAIL") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: outcome.problems.join("; ") },
            detail: truncate(outcome.detail, 4000),
          };
        }
        if (outcome.status === "NOT_RUN") {
          return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
        }
        return { status: "PASS", exitCode: 0, detail: outcome.detail };
      },
    },

    {
      id: "b2-precise-anchors",
      // REAL executing check (D4-2): the frozen B2 selection set runs through the
      // product range/anchor resolution layer (MaterialRangeResolver) on top of
      // the real import pipeline (MaterialImportService + MaterialRepository).
      // All valid selections must resolve to exactly the stored truth (100%,
      // incl. repeat-word-2nd / cross-line / unicode / long-tail coverage); all
      // invalid selections must be rejected with the correct frozen category
      // reason (stale-version executes the md-vpair version pair; unsupported
      // materials refuse anchoring as material-not-ready); any successful
      // resolution of a frozen-invalid selection counts as a mis-location (0
      // required). The browser-selection part of charter B2 stays a later
      // run:d4-browser concern — this check's scope is the mechanical layer.
      fn: async () => {
        const d4Root = join(deps.ROOT, "tests", "fixtures", "d4");
        if (!existsSync(d4Root)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "tests/fixtures/d4 not present in this tree",
          };
        }
        const outcome = await runB2AnchorsCheck(d4Root);
        deps.log("b2-precise-anchors", `b2 precise anchors check\n${outcome.lines.join("\n")}`);
        if (outcome.status === "FAIL") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: outcome.problems.join("; ") },
            detail: truncate(outcome.detail, 4000),
          };
        }
        if (outcome.status === "NOT_RUN") {
          return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
        }
        return { status: "PASS", exitCode: 0, detail: outcome.detail };
      },
    },

    {
      id: "b3-material-exploration",
      // REAL executing check (D4-3): the material exploration loop runs on the
      // real service stack (MaterialImportService + MaterialRangeResolver +
      // MaterialBranchingService over the real TreeStudioService, offline echo
      // Pi runtime — zero credentials) against frozen B1 fixtures plus
      // deterministic data generated inside the check. Covers the offline-
      // executable core of charter §3.3/B3: create-from-selection (md + pdf),
      // context window honesty (24,000-unit cap, truncation marker, oversized
      // selection refusal), independent run origin, idempotent first question
      // (replay + post-restart determinism), 409 conflicts, reconcile-before-
      // action (unknown/failed), restore vs explicit new + look-alike/cross-tree
      // isolation, material return with source card, missing-session explicit
      // new exploration, non-ready refusal. The REAL-Pi part of charter B3
      // (browser evidence at the final candidate SHA) stays with
      // run:d4-browser --mode real-pi — see b3-real-exploration.
      fn: async () => {
        const d4Root = join(deps.ROOT, "tests", "fixtures", "d4");
        if (!existsSync(d4Root)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "tests/fixtures/d4 not present in this tree",
          };
        }
        const outcome = await runB3ExplorationCheck(d4Root);
        deps.log("b3-material-exploration", `b3 material exploration check\n${outcome.lines.join("\n")}`);
        if (outcome.status === "FAIL") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: outcome.problems.join("; ") },
            detail: truncate(outcome.detail, 4000),
          };
        }
        if (outcome.status === "NOT_RUN") {
          return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
        }
        return { status: "PASS", exitCode: 0, detail: outcome.detail };
      },
    },

    {
      id: "b3-real-exploration",
      // Evidence audit (delivered 2026-10-01): the recorded run:d4-browser
      // --mode real-pi run under evidence/d4/browser. mode is verified — an
      // echo/selftest run NEVER satisfies this row. Charter B3 items validated
      // against the recorded sidecars: md + pdf branches, ≥2 follow-up rounds
      // each, cross-branch isolation, restart continuation, double-click and
      // transport-layer response-loss idempotency, return-to-source exact
      // excerpts, Return material source cards + return-card jump, post-return
      // restart readability. This row audits evidence; producing it requires
      // credentials (TREEAI_STUDIO_API_KEY) outside this offline verifier.
      fn: async () => {
        const browserDir = join(deps.ROOT, "evidence", "d4", "browser");
        if (!existsSync(browserDir)) {
          return { status: "NOT_RUN", exitCode: null, reason: "no evidence/d4/browser yet — the real-pi run has not been recorded" };
        }
        const runDirs = readdirSync(browserDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(browserDir, entry.name))
          .filter((dir) => existsSync(join(dir, "summary.json")))
          .sort()
          .reverse();
        for (const runDir of runDirs) {
          let summary = null;
          try {
            summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
          } catch {
            continue;
          }
          if (summary.mode !== "real-pi") continue; /* echo runs never satisfy this row */
          const branchCheck = (summary.checks ?? []).find((c) => c.id === "d4-branch-from-material");
          const returnCheck = (summary.checks ?? []).find((c) => c.id === "d4-return-from-material");
          if (branchCheck === undefined || returnCheck === undefined) continue;
          if (branchCheck.status !== "PASS" || returnCheck.status !== "PASS") {
            return {
              status: "FAIL",
              exitCode: 2,
              error: { message: `the newest real-pi evidence run is not PASS on the B3 checks (${branchCheck.status}/${returnCheck.status}) — re-run and record` },
              detail: `evidence run ${String(summary.runId ?? "")} mode ${String(summary.mode)}`,
            };
          }
          const problems = [];
          let branchSidecar = null;
          let returnSidecar = null;
          try {
            const branchFile = readdirSync(runDir).find((name) => name.endsWith("-branch-from-material.json"));
            const returnFile = readdirSync(runDir).find((name) => name.endsWith("-return-from-material.json"));
            if (branchFile === undefined || returnFile === undefined) {
              return { status: "FAIL", exitCode: 2, error: { message: `real-pi run ${String(summary.runId ?? "")} lacks the B3 sidecars` } };
            }
            branchSidecar = JSON.parse(readFileSync(join(runDir, branchFile), "utf8"));
            returnSidecar = JSON.parse(readFileSync(join(runDir, returnFile), "utf8"));
          } catch (err) {
            return { status: "FAIL", exitCode: 2, error: { message: `B3 sidecar not readable: ${String(err)}` } };
          }
          if (branchSidecar.mode !== "real-pi" || returnSidecar.mode !== "real-pi") problems.push("sidecar mode is not real-pi");
          if (branchSidecar.branches?.md === undefined || branchSidecar.branches?.pdf === undefined) {
            problems.push("branches: md and pdf both required");
          }
          if (branchSidecar.selections?.md?.excerpt === undefined || branchSidecar.selections?.pdf?.excerpt === undefined) {
            problems.push("selections with excerpts for md and pdf both required");
          }
          const lines = (branchSidecar.lines ?? []).join("\n");
          if (!lines.includes("double-click")) problems.push("double-click idempotency not recorded");
          if (!lines.includes("idempotent replay")) problems.push("response-loss idempotent-retry not recorded");
          const followUps = (branchSidecar.lines ?? []).filter((l) => l.includes("follow-up rounds landed")).length;
          if (followUps < 2) problems.push(`follow-up rounds recorded for ${String(followUps)} branch(es), need md + pdf (2)`);
          if (!lines.includes("cross-branch isolation")) problems.push("cross-branch isolation not recorded");
          if (!lines.includes("restart continuation")) problems.push("restart continuation not recorded");
          const retLines = (returnSidecar.lines ?? []).join("\n");
          if (!retLines.includes("exact excerpt in view")) problems.push("return-to-source exact excerpt not recorded");
          if (!retLines.includes("material source fields")) problems.push("Return material source card fields not recorded");
          if (!retLines.includes("source jump reopens the reader")) problems.push("return-card source jump not recorded");
          if (!retLines.includes("restart")) problems.push("post-return restart readability not recorded");
          if ((returnSidecar.returns ?? []).length < 2) problems.push("returns for md and pdf both required");
          if (problems.length > 0) {
            return {
              status: "FAIL",
              exitCode: 2,
              error: { message: `recorded real-pi B3 evidence is incomplete: ${problems.join("; ")}` },
              detail: `evidence run ${String(summary.runId ?? "")} mode ${String(summary.mode)}`,
            };
          }
          return {
            status: "PASS",
            exitCode: 0,
            detail:
              `real-pi run ${String(summary.runId ?? "")} (mode ${String(summary.mode)}, gitCommit ${String(summary.gitCommit ?? "?").slice(0, 12)}): ` +
              "md+pdf branches with real first questions, double-click + response-loss idempotency, 2 follow-up rounds each, " +
              "cross-branch isolation, restart continuation, return-to-source exact excerpts, Return source cards + jump, post-return restart",
          };
        }
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "no recorded run:d4-browser --mode real-pi evidence run yet (this row audits recorded evidence; producing it needs TREEAI_STUDIO_API_KEY)",
        };
      },
    },

    {
      id: "b4-cross-material-find",
      // REAL executing check (D4-4): the frozen B4 corpus (facts.json: saved
      // product facts across 3 trees; material fragments pinned to the B1 frozen
      // truth canonicalText) is assembled into search documents through the
      // PRODUCT assembly path (buildSearchDocuments in
      // apps/studio/src/search/search-service.ts — the same pure function the
      // HTTP search endpoints use) and queried through the real engine
      // (LocalSearchEngine). Every positive query must place its pre-specified
      // target factId in the top-5 (charter floor 95%; the frozen set + the
      // deterministic engine assert all of them); every no-result query must
      // return zero hits (nothing fabricated). The browser/UI part of charter
      // B4 (source jump) stays with run:d4-browser; the HTTP endpoints are
      // covered by the studio suite (search-api.test.ts).
      fn: async () => {
        const d4Root = join(deps.ROOT, "tests", "fixtures", "d4");
        if (!existsSync(d4Root)) {
          return {
            status: "NOT_RUN",
            exitCode: null,
            reason: "tests/fixtures/d4 not present in this tree",
          };
        }
        const outcome = runB4SearchCheck(d4Root);
        deps.log("b4-cross-material-find", `b4 cross-material find check\n${outcome.lines.join("\n")}`);
        if (outcome.status === "FAIL") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: outcome.problems.join("; ") },
            detail: truncate(outcome.detail, 4000),
          };
        }
        if (outcome.status === "NOT_RUN") {
          return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
        }
        return { status: "PASS", exitCode: 0, detail: outcome.detail };
      },
    },

    {
      id: "b5-restore-integrity",
      // REAL executing check (D4-5): export/restore portability through the
      // actual CLI entry (subprocesses running apps/studio/src/index.ts export /
      // --import-package) against a representative dataset built by the real
      // import pipeline + repositories. Covers the offline-mechanical slice of
      // charter B5: empty-dir restore integrity compare (saved facts/returns/
      // excerpts survive), corrupted package refused with the target and source
      // untouched, material new version keeps old excerpt linkage, whole-session
      // deletion degrades availability honestly (facts stay readable; explicit
      // new exploration is the product path), parse cancel holds after restore,
      // and per-request search rebuild identical over source and restored
      // databases (B5 索引删除重建). The browser-path items of B5 (restart+
      // resume in a real browser, the explicit-new-exploration UI affordance)
      // stay with run:d4-browser / the final candidate-SHA regression — not
      // claimed here.
      fn: async () => {
        const outcome = await runB5RestoreCheck(deps.ROOT);
        deps.log("b5-restore-integrity", `b5 restore/asset-integrity check\n${outcome.lines.join("\n")}`);
        if (outcome.status === "FAIL") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: outcome.problems.join("; ") },
            detail: truncate(outcome.detail, 4000),
          };
        }
        if (outcome.status === "NOT_RUN") {
          return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
        }
        return { status: "PASS", exitCode: 0, detail: outcome.detail };
      },
    }
  ];

  return {
    MATERIAL_CHECKS,
  };
}
