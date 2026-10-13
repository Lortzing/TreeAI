import { runB6ScaleCheck } from "../../tests/support/verifier/d4-b6-scale.ts";
import { truncate } from "../../tests/support/verifier/util.ts";
import { runB9NavCheck } from "../../tests/support/verifier/d4-b9-nav.ts";
/** d4-browser-owner original ordered checks Instance-owned state and dependencies. */

export function createD4BrowserOwner(deps) {

  const BROWSER_OWNER_CHECKS = [

    {
      id: "b6-scale-performance",
      // REAL executing check (D4-6): the frozen B6 scale dataset (spec at
      // tests/fixtures/d4/b6-scale/spec.json) is generated deterministically by
      // scripts/d4/gen-b6-scale-dataset.mjs (two CLI runs byte-identical +
      // --load-check into a real persistence DB), loaded through the real
      // parsers + repository APIs (100 materials / exactly 1M canonical units /
      // 1,000 non-trunk branches / 10,000 saved facts), and measured through the
      // REAL service/HTTP surface on a server assembled like index.ts:
      // search p95 ≤500ms over the 50 frozen needle queries (warm, per-request
      // rebuild path; cold reported separately), material-open p95 ≤2s over 30
      // existing-material opens (first visible blocks page, large PDFs
      // included), the 10 MiB/100-page frozen sample imports to parse-ready
      // ≤30s, cancel answers ≤200ms with late results structurally discarded,
      // scroll block-page p95 ≤200ms. CPU/memory/OS + loadavg recorded;
      // near-limit probes are rerun once with both runs recorded (parallel-wave
      // machine honesty). The browser face of B6 stays NOT claimed: see
      // b6-browser-face.
      fn: async () => {
        const outcome = await runB6ScaleCheck(deps.ROOT);
        deps.log("b6-scale-performance", `b6 scale/performance check\n${[...outcome.lines, ...outcome.notRun.map((n) => `NOT_RUN: ${n}`)].join("\n")}`);
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
      id: "b6-browser-face",
      // REAL executing check (final browser-evidence wave): audits the committed
      // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
      // summary carries d4-b6-scale-browser PASS, validating the recorded metrics
      // against the charter B6 browser budgets (material-open p95 <=2s over 30 real
      // sidebar opens incl. long PDFs readable with the first visible page; no
      // >200ms main-thread segment while paging; keystroke-to-render p95 <=200ms
      // while paging; the cancel attempt + its honest structural finding; search
      // hit-list render recorded as evidence). The browser measurement itself runs
      // via run:d4-browser (real Chrome + real studio processes on the B6 corpus);
      // this row verifies the recorded evidence is present, complete and within
      // budget, and discloses its binding (runId / gitCommit / mode / environment).
      // Local-machine engineering evidence (environment in the sidecar) — never
      // claimed cross-machine; the final candidate-SHA regression re-runs
      // run:d4-browser. The server-side budgets (search p95, gated cancel) stay
      // with b6-scale-performance — the two rows never substitute for each other.
      fn: async () => {
        const audit = deps.auditBrowserEvidence(deps.ROOT, "d4-b6-scale-browser", "b6-scale-browser", {
          validate: (sidecar) => {
            const problems = [];
            const open = sidecar.materialOpen;
            if (open === undefined || open.stats === undefined) problems.push("material-open metrics missing");
            else {
              if (open.stats.count !== 30) problems.push(`material-open count ${String(open.stats.count)} != 30`);
              if (open.stats.p95Ms > 2000) problems.push(`material-open p95 ${String(open.stats.p95Ms)}ms > 2000ms`);
            }
            const r = sidecar.responsiveness;
            if (r === undefined || r.stepLatency === undefined || r.keystrokeLatency === undefined) {
              problems.push("responsiveness metrics missing");
            } else {
              if (r.worstLongTaskMs > 200) problems.push(`worst longtask ${String(r.worstLongTaskMs)}ms > 200ms`);
              if (r.stepLatency.p95Ms > 200) problems.push(`scroll step-to-frame p95 ${String(r.stepLatency.p95Ms)}ms > 200ms`);
              if (r.keystrokeLatency.count < 10) problems.push(`only ${String(r.keystrokeLatency.count)} keystrokes measured`);
              if (r.keystrokeLatency.p95Ms > 200) problems.push(`keystroke-to-render p95 ${String(r.keystrokeLatency.p95Ms)}ms > 200ms`);
            }
            const cancel = sidecar.cancelProbe;
            if (cancel === undefined) problems.push("cancel probe record missing");
            else if (cancel.clickToCanceledMs === undefined && cancel.windowMissed !== true) {
              problems.push("neither a measured cancel nor the honest window-missed finding is recorded");
            } else if (cancel.clickToCanceledMs !== undefined && cancel.clickToCanceledMs > 500) {
              problems.push(`cancel click→canceled ${String(cancel.clickToCanceledMs)}ms > 500ms (browser-observed)`);
            }
            if (sidecar.searchRender === undefined || (sidecar.searchRender.queries ?? []).length < 10) {
              problems.push("search hit-list render evidence missing (<10 queries)");
            }
            return problems;
          },
          describe: (sidecar) => {
            const open = sidecar.materialOpen.stats;
            const r = sidecar.responsiveness;
            const cancel = sidecar.cancelProbe;
            return (
              `30 real-sidebar material opens p95 ${String(open.p95Ms)}ms (median ${String(open.medianMs)}ms, long PDFs readable with the first ` +
              `visible page); paging the long PDF + long md: worst longtask ${String(r.worstLongTaskMs)}ms over ${String(r.longTaskCount)} tasks, ` +
              `step-to-frame p95 ${String(r.stepLatency.p95Ms)}ms; keystroke-to-render p95 ${String(r.keystrokeLatency.p95Ms)}ms while paging; ` +
              `cancel: ${
                cancel.clickToCanceledMs !== undefined
                  ? `click → canceled in ${String(cancel.clickToCanceledMs)}ms (browser-observed)`
                  : `window structurally missed (single-threaded server + synchronous parser — finding recorded; import-to-ready ${String(cancel.importToReadyMs)}ms ≤ 30s browser-observed)`
              }; search hit-list render p50 ${String(sidecar.searchRender.stats.medianMs)}ms / p95 ${String(sidecar.searchRender.stats.p95Ms)}ms (evidence)`
            );
          },
        });
        return audit;
      },
    },

    {
      id: "b7-beta-usability",
      // REAL executing check (B7 automated part): audits the committed
      // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
      // summary carries d4-beta-usability PASS, validating the recorded sidecar's
      // six scenario blocks against the charter B7 automated surface (clean-env
      // start per README with an honest first-boot empty state; wide (>=1440px) and
      // narrow (~390x844 mobile) viewports usable with no horizontal overflow and
      // hit-testable key controls + reachable capture bar; keyboard Tab traversal
      // to the main controls with visible focus, Enter/Space activation, layered
      // Escape with focus restoration, reader arrow scrolling, no focus trap;
      // simulated touch via CDP Input.dispatchTouchEvent — tap/swipe/drag-select
      // arming the capture bar through the selectionchange path/copy tap; reduced-
      // motion honored with immediate-arrival positioning jumps; the in-session
      // focus/scroll/draft round trip preserving draft text, focus, panel scroll
      // and the reader's saved reading position). The browser measurement itself
      // runs via run:d4-browser (real Chrome + a real studio process, echo in
      // selftest / real Pi in real-pi mode). HONEST SCOPE: this row passing is the
      // AUTOMATED part of B7 only — the Mac experience sign-off and the 3–5 person
      // individual trials remain the owner's D4-G3 human sequence and are never
      // substituted by this audit.
      fn: async () => {
        const audit = deps.auditBrowserEvidence(deps.ROOT, "d4-beta-usability", "beta-usability", {
          validate: (sidecar) => {
            const problems = [];
            const b = sidecar.betaUsability;
            if (b === undefined) {
              return ["the sidecar carries no betaUsability block"];
            }
            const cleanBoot = b.cleanBoot;
            if (cleanBoot === undefined) problems.push("cleanBoot section missing");
            else {
              if (cleanBoot.entryConsistentWithReadme !== true || cleanBoot.flagsConsistentWithReadme !== true) {
                problems.push("the README start-path reconciliation did not hold (entry/flags)");
              }
              const empty = cleanBoot.emptyStateHonest ?? {};
              if (empty.emptyStateVisible !== true || empty.forestTreeButtons !== 0 || empty.materialsSectionHidden !== true) {
                problems.push("the first-boot empty state is not recorded as honest (no trees / no materials / create-tree affordance)");
              }
              if (typeof cleanBoot.treeCreatedViaEmptyState !== "string") {
                problems.push("the create-tree flow was not exercised on the clean boot");
              }
            }
            const wn = b.wideNarrow;
            if (wn === undefined || wn.wide === undefined || wn.narrow === undefined) {
              problems.push("wideNarrow sections missing");
            } else {
              if (wn.wide.widthPx === undefined || wn.wide.widthPx < 1440) problems.push(`wide viewport ${String(wn.wide.widthPx)}px < 1440px`);
              if (wn.narrow.widthPx === undefined || wn.narrow.widthPx > 400) problems.push(`narrow viewport ${String(wn.narrow.widthPx)}px is not the ~390px mobile window`);
              for (const [name, section] of [["wide", wn.wide], ["narrow", wn.narrow]]) {
                if ((section.overflowX?.documentElement ?? 99) > 1) problems.push(`${name} viewport records horizontal overflow`);
                if (section.readerUsable !== true || section.panelUsable !== true) problems.push(`${name} viewport reader/panel not recorded usable`);
                const hits = section.hits ?? {};
                for (const control of ["newTree", "materialImport", "searchInput", "branchTab"]) {
                  if (hits[control] !== true) problems.push(`${name} viewport: the ${control} control is not recorded hit-testable`);
                }
              }
              if (wn.narrow.drawerOpensViaToggle !== true) problems.push("the narrow sidebar drawer does not open via the toggle");
            }
            const kb = b.keyboard;
            if (kb === undefined) problems.push("keyboard section missing");
            else {
              if (kb.tabSteps === undefined || kb.tabSteps < 1) problems.push("keyboard Tab traversal steps missing");
              const reached = kb.reached ?? {};
              for (const control of ["newTree", "materialImport", "searchInput", "readerContent"]) {
                if (reached[control] !== true) problems.push(`keyboard traversal never reached ${control}`);
              }
              if (kb.focusStyleVisible === undefined || Object.values(kb.focusStyleVisible ?? {}).some((s) => s === null || s?.outlineStyle === "none")) {
                problems.push("the keyboard focus indicator is not recorded visible (computed outline)");
              }
              if ((kb.arrowScroll?.afterDown ?? 0) <= (kb.arrowScroll?.before ?? 0)) problems.push("reader arrow scrolling not recorded effective");
              if (kb.enterActivation === undefined || kb.spaceActivation === undefined) problems.push("Enter/Space activation not recorded");
              if ((kb.escapeLayers ?? []).length < 3 || !(kb.escapeLayers ?? []).every((l) => l.ok === true)) {
                problems.push("layered Escape close with focus restoration not recorded for drawer/reader/panel");
              }
              if (kb.noFocusTrap !== true) problems.push("the no-focus-trap assertion is not recorded");
            }
            const touch = b.touch;
            if (touch === undefined) problems.push("touch section missing");
            else {
              if (touch.tapOpenedReader !== true) problems.push("touch tap did not open the material reader");
              if ((touch.swipeScrolledPx ?? 0) <= 0) problems.push("the touch swipe did not scroll the reader");
              if (touch.selectionArmedViaTouch !== true) problems.push("the in-gesture text-layer selection did not arm the capture bar (selectionchange path)");
              if (touch.toolbarButtonTapped !== true) problems.push("the capture-bar toolbar button was not tapped");
              if (typeof touch.copyVerification !== "string") problems.push("the copy verification is not recorded");
            }
            const rm = b.reducedMotion;
            if (rm === undefined) problems.push("reducedMotion section missing");
            else {
              if (rm.matched !== true) problems.push("page matchMedia('(prefers-reduced-motion: reduce)') was not true under the emulation");
              if (rm.immediateArrival !== true) problems.push("the positioning jump / stick-to-bottom was not immediate under reduce (in-transit frames recorded)");
              if (rm.viewSourceJump === undefined || rm.viewSourceJump.anchoredBlock === undefined) problems.push("the View-source positioning jump record is missing");
            }
            const fsd = b.focusScrollDraft;
            if (fsd === undefined) problems.push("focusScrollDraft section missing");
            else {
              if (fsd.draftPreserved !== true) problems.push("the panel draft text was not preserved across the round trip");
              if (fsd.focusRestoredTo !== "#panel-view-source") problems.push(`focus after the round trip is ${String(fsd.focusRestoredTo)} (expected #panel-view-source)`);
              if (fsd.panelScrollPreserved === undefined) problems.push("the panel scroll preservation record is missing");
              const rsp = fsd.readerScrollPreserved ?? {};
              if (rsp.restoredToBlock !== rsp.topBlockAtClose || (rsp.restoredDiffPx ?? 99) > 2) {
                problems.push("the reader did not reopen at the saved reading position (in-session round trip)");
              }
            }
            return problems;
          },
          describe: (sidecar) => {
            const b = sidecar.betaUsability;
            return (
              `clean boot per README (argv/entry/flags reconciled; honest empty state; tree created via the empty-state action); ` +
              `wide ${String(b.wideNarrow.wide.widthPx)}px + narrow ${String(b.wideNarrow.narrow.widthPx)}px (mobile) viewports usable ` +
              `with no horizontal overflow and hit-testable key controls; keyboard: ${String(b.keyboard.tabSteps)} Tab steps to the reader text ` +
              `with visible focus outlines, Enter+Space activations, ${String(b.keyboard.escapeLayers.length)} layered Escape closes with focus ` +
              `restoration, reader arrows scroll; touch: ${String(b.touch.taps)} taps / ${String(b.touch.swipes)} swipes / ` +
              `${String(b.touch.dragSelects)} in-gesture drag-select arming the capture bar via selectionchange (${b.touch.copyVerification}); ` +
              `reduced-motion honored with immediate arrival; draft/focus/panel-scroll/reader-position all preserved across the in-session ` +
              `round trip — AUTOMATED part of B7 only: the Mac sign-off and the 3–5 person trials remain the owner's D4-G3 human sequence, ` +
              `so this PASS is NOT B7 complete`
            );
          },
        });
        return audit;
      },
    },

    {
      id: "b8-install-crossplatform",
      fn: deps.notRunCheck(
        "b8-install-crossplatform",
        "D4-7",
        "engineering delivered (packaging scripts/d4/package-installer.mjs + launcher + d4-installer CI workflow + macOS local real test under evidence/d4/d4-7/); B8 acceptance still requires the owner's clean-install real-machine validation on Windows 11 x64 and Ubuntu 24.04 (plus real-Pi material smoke), which no CI run can substitute",
      ),
    },

    {
      id: "b9-large-tree-nav",
      // REAL executing check (D4-8): the offline structural slice of charter B9
      // against the actual deliverable surfaces — the generator CLI as real
      // subprocesses (determinism across processes, manifest hash equality,
      // --load-check into a real persistence DB), the loader, and the /api/nav/*
      // HTTP surface through a real node:http server with the full B9 dataset:
      // structure-truth vs API queries 100% (all 10,100 branches located by id
      // with ancestors/path/origin/sibling position matching truth; every node
      // view compared via subtree pagination), 100-level deep chain complete,
      // wide-tree children paged in truth order, same-name disambiguation by
      // id, empty tree honest, lazy endpoints page-bounded (<1MiB), expand
      // state surviving a simulated restart (migration 0010), and nav responses
      // byte-identical after every session goes unavailable (product tree ≠
      // run/session trees). Engine-side p95 + first-open are recorded as
      // evidence only — the browser face of B9 (p95 in a real browser,
      // virtualization, keyboard) is NOT claimed here: see b9-nav-browser-face.
      fn: async () => {
        const outcome = await runB9NavCheck(deps.ROOT);
        deps.log("b9-large-tree-nav", `b9 large-scale tree nav check\n${[...outcome.lines, ...outcome.notRun.map((n) => `NOT_RUN: ${n}`)].join("\n")}`);
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
      id: "b9-nav-browser-face",
      // REAL executing check (final browser-evidence wave): audits the committed
      // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
      // summary carries d4-nav-browser PASS, validating the recorded metrics against
      // the charter B9 browser budgets (b9-big first open to usable <=2s; >=50 timed
      // scripted expand/switch ops with p95 <=300ms; virtualized DOM row count bound
      // against the loaded row total; keyboard level-by-level movement with focus
      // retained across re-windowing; expand state surviving a real SIGTERM process
      // restart; structure-truth spot checks). The browser measurement itself runs
      // via run:d4-browser (real Chrome + a real studio process on the B9 dataset);
      // this row verifies the recorded evidence is present, complete and within
      // budget, and discloses its binding (runId / gitCommit / mode / environment).
      // Local-machine engineering evidence (environment in the sidecar) — never
      // claimed cross-machine; the final candidate-SHA regression re-runs
      // run:d4-browser. The engine-side 100% locate/subtree verification stays with
      // b9-large-tree-nav — the two rows never substitute for each other.
      fn: async () => {
        const audit = deps.auditBrowserEvidence(deps.ROOT, "d4-nav-browser", "nav-browser", {
          validate: (sidecar) => {
            const problems = [];
            const timing = sidecar.timing;
            if (timing === undefined) problems.push("nav timing metrics missing");
            else {
              if (timing.bigFirstOpenMs === undefined || timing.bigFirstOpenMs > 2000) {
                problems.push(`b9-big first open ${String(timing.bigFirstOpenMs)}ms > 2000ms (or missing)`);
              }
              if (timing.timedOpCount === undefined || timing.timedOpCount < 50) {
                problems.push(`timed op count ${String(timing.timedOpCount)} < 50`);
              }
              if (timing.p95Ms === undefined || timing.p95Ms > 300) {
                problems.push(`nav op p95 ${String(timing.p95Ms)}ms > 300ms (or missing)`);
              }
            }
            const v = sidecar.virtualization;
            if (v === undefined || v.wideTotalRows === undefined || v.wideTotalRows < 200 || (v.samples ?? []).length < 4) {
              problems.push("virtualization samples missing or the wide tree was not fully loaded (<200 rows)");
            } else if (!(v.samples ?? []).every((sample) => sample.domRows <= v.domRowLimit)) {
              problems.push("a virtualization sample exceeded the windowed DOM row limit");
            }
            if ((sidecar.keyboard?.steps ?? []).length < 8) problems.push("keyboard steps missing (<8)");
            const restart = sidecar.restart;
            if (restart === undefined || restart.before === undefined || restart.after === undefined || restart.selectedRestored === undefined) {
              problems.push("expand-state restart record missing");
            }
            if ((sidecar.spotChecks ?? []).length < 8) problems.push(`structure-truth spot checks < 8 (${String((sidecar.spotChecks ?? []).length)})`);
            return problems;
          },
          describe: (sidecar) => {
            const timing = sidecar.timing;
            const v = sidecar.virtualization;
            return (
              `b9-big first open to usable ${String(timing.bigFirstOpenMs)}ms; ${String(timing.timedOpCount)} timed expand/switch ops ` +
              `p95 ${String(timing.p95Ms)}ms (median ${String(timing.medianMs)}ms, max ${String(timing.maxMs)}ms; ` +
              `${String(timing.preemptedOps ?? 0)} more-page ops pump-preempted, honestly recorded); virtualization: DOM rows ≤ ` +
              `${String(v.domRowLimit)} while ${String(v.wideTotalRows)} wide-tree rows are loaded; keyboard ` +
              `${String(sidecar.keyboard.steps.length)} steps with focus retained; expand state byte-equal across a real ` +
              `SIGTERM restart (selected ${String(sidecar.restart.selectedRestored)} restored); ${String(sidecar.spotChecks.length)} ` +
              `structure-truth spot checks; ${String((sidecar.frontendBugs ?? []).length)} frontend findings recorded`
            );
          },
        });
        return audit;
      },
    }
  ];

  return {
    BROWSER_OWNER_CHECKS,
  };
}
