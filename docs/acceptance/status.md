# TreeAI refactor acceptance — live candidate matrix

**Last updated:** 2026-10-13. **Main baseline:** `e427460b31f61722d5e74a6fa4ee24d140abe67b`.
**Integration PR:** [#27](https://github.com/Lortzing/TreeAI/pull/27), branch `refactor/integration-r0-r7`. The current candidate must be read from the PR HEAD; this document does **not** claim that an earlier successful run validates every subsequent commit.

| Wave | Implemented now | Still required |
| --- | --- | --- |
| R0 repository map | `scripts/repo-inventory.mjs`, `scripts/audit-studio-assets.mjs`, task map and agent navigation | Literal import/scenario comparison and measured baseline now available; computed CLI/verifier paths and final whole-project audit still required |
| R1 browser UI | Thin `app.js` bootstrap, isolated `createStudioApp`, ESM/static allowlist, CSS modules, source hash/selection, reading position and DOM reuse; Search, Turn-backed Return, diagnostics, navigation-finder, and navigation-chrome presentation views isolated in `public/core/views/{search,return,diagnostics,nav-finder,nav-chrome}.js` with focused no-browser coverage; conversation/branch/Return/selection/terminology/materials/search/navigation controllers and domain views extracted; lifecycle, state and feature composition are separate | Browser domain decomposition implemented; final-candidate complete Chrome/Pi regressions still required |
| R2 UI tests | Shared app harness, CSS source loader, browser protocol/SSE/selector stubs across all eight UI suites, static scenario comparison and targeted module regressions | Deduplicate remaining DOM/selection/backend/storage mocks; static names are audited, dynamic scenario IDs and assertions still require full suite/runner review |
| R3 Studio server/services | HTTP response/errors/validation/static/SSE adapters and tree/search/nav/material/terminology routes; safe journal summaries, prompt composition, terminology density | Studio orchestration/session/Return/read-model/event boundaries and terminology executor/promotion/ledger now separate; split remaining DB repositories while preserving transaction coordinator |
| R4 runtime and runners | Pi session inspection, native Chrome/CDP lifecycle host, four ordered PDF fixture groups and frozen registry test | Full browser/Pi/installer/verification runner boundaries, dataset ownership and old CLI/check ID compatibility |
| R5 documentation | Short README/AGENTS, docs index/task map/architecture, archived D3 historical ledger | Verify all references and final product authority consistency |
| R6 evidence lifecycle | Original evidence retained; read-only `scripts/evidence-index.mjs` locator and [usage](evidence-index.md); Linux-compatible frozen B6 generator font path | Tracked-path accounting complete including unassigned historical paths; remove redundant raw artifacts **only after full project acceptance** |
| R7 integration/acceptance | CI typechecks, D2/D4 offline, native Chrome smoke workflows | Final-SHA real Pi and actual Mac/Windows/Linux install, owner acceptance, independent participant trials |

## 2026-10-10 Search-view wave (working candidate based on `28d809537099fad04e6c32df2c647e266bacbca5`)

- R1 moved the Search panel's status/meta/result/session-unavailable rendering and hit registry behind `apps/studio/public/core/views/search.js`; request, jump, tree/session, and frozen UI contracts remain in `create-studio-app.js`.
- Local validation on this working candidate: 412 Studio tests passed; shared extracted-view/factory/static/Search suites passed; production and root test typechecks passed; Studio asset audit passed.
- Local offline evidence: D2 `21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for authorization-gated D1 repro) and D4 `19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for owner-only B8 install/real-Pi acceptance); D2/D4 selftests and contract suites passed.
- No local Chrome binary is available, so native Chrome was not rerun here. Existing PR-head Echo Chrome runs remain non-real-Pi evidence and do not close final-SHA, physical-install, owner-signoff, or trial gates.

## 2026-10-10 Return-view wave (working candidate based on `c32ca66ac5b4c74bfd8bc6679cb1e6d95f5ee77d`)

- R1 moved only Turn-backed Return card presentation into `apps/studio/public/core/views/return.js`; Return drafts/submission/navigation, material Return rendering, `returnAttemptsFor`, and shared motion maps remain in `create-studio-app.js`.
- Direct shared-view tests, factory/static tests, and the existing Return/material UI suites are green; Studio has 412/412 tests, root tests/typechecks and asset audit pass, and the new direct aggregator has 9/9 tests.
- Local offline evidence: D2 `21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for authorization-gated D1 repro), D2 selftest `5/5`; D4 `19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for owner-only B8 install/real-Pi acceptance), D4 selftest and 13 contract tests pass.
- The local preview loaded `/core/views/return.js` with no console errors or failed requests. No local native Chrome binary is available; browser-pane loading is not real-Pi or physical-install acceptance.
- No acceptance standard, scenario denominator, source/Return semantic, evidence artifact, or physical acceptance gate was changed.

## 2026-10-10 Diagnostics-view wave (working candidate based on `ad4421d36f9755441cbdc3282a460166aa31007a`)

- R1 moved only diagnostics and persistent failure-panel rendering into `apps/studio/public/core/views/diagnostics.js`; diagnostics refresh/polling/SSE, abort controller, and dismissal state remain in `create-studio-app.js`.
- Direct extracted-view tests, factory/static tests, `ui-probe` (32/32), and `ui-regressions` (10/10) pass; Studio has 412/412 tests, root tests/typechecks and asset audit pass, and the shared-utils aggregator has 10/10 tests.
- Local offline evidence: D2 `21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for authorization-gated D1 repro), D2 selftest `5/5`; D4 `19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for owner-only B8 install/real-Pi acceptance), D4 selftest and 13 contract tests pass.
- The local preview loaded `/core/views/diagnostics.js` with no console errors or failed requests. No local native Chrome binary is available; browser-pane loading is not real-Pi or physical-install acceptance.
- No acceptance standard, scenario denominator, evidence artifact, or physical acceptance gate was changed.

## 2026-10-10 Navigation-finder wave (working candidate based on `0ac6248dfb917a2b6d54a6ded7f2ff697e73af97`)

- R1 moved only tree-finder DOM presentation into `apps/studio/public/core/views/nav-finder.js`; finder request/epoch controllers, shared list replacement, tree-open/session restoration, and virtualized navigation remain in `create-studio-app.js`.
- Direct extracted-view, static/factory, and `ui-nav` tests pass; Studio has 412/412 tests, root tests/typechecks and asset audit pass, and the shared-utils aggregator has 11/11 tests.
- Local offline evidence: D2 `21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for authorization-gated D1 repro), D2 selftest `5/5`; D4 `19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for owner-only B8 install/real-Pi acceptance), D4 selftest and 13 contract tests pass.
- The local preview loaded `/core/views/nav-finder.js` with no console errors or failed requests. No local native Chrome binary is available; browser-pane loading is not real-Pi or physical-install acceptance.
- No pagination limit, stale-cursor behavior, focus semantics, acceptance standard, scenario denominator, evidence artifact, or physical acceptance gate was changed.

## 2026-10-10 Navigation-chrome wave (working candidate based on `16f70f3c542d3977c485d4d8965e50e0a435fa17`)

- R1 moved navigation surface overview/action presentation into `public/core/views/nav-chrome.js`; tree session, overview fetch/retry controller, virtualized rows, finder, source locate, and keyboard behavior remain in `create-studio-app.js`.
- Direct view, static/factory, nav, diagnostics, and Return regressions pass; Studio has 412/412 tests, root tests/typechecks and asset audit pass, and the shared-utils aggregator has 12/12 tests.
- Local offline evidence: D2 `21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for authorization-gated D1 repro), D2 selftest `5/5`; D4 `19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN` (exit 3 for owner-only B8 install/real-Pi acceptance), D4 selftest and 13 contract tests pass.
- The local preview loaded `/core/views/nav-chrome.js` with no console errors or failed requests. No local native Chrome binary is available; browser-pane loading is not real-Pi or physical-install acceptance.
- No navigation semantics, acceptance standard, scenario denominator, evidence artifact, or physical acceptance gate was changed.

## 2026-10-12 B6 search snapshot wave (working candidate based on `1f0bf09`)

- Replaced the global-search snapshot's per-branch Turn query loop with a fresh tree-wide repository read ordered by branch creation/rowid and per-branch Turn creation/rowid; freshness, role partition, ranking, offsets, match counts, and tree scoping remain unchanged.
- Added persistence and SearchService snapshot-order parity coverage; focused search/API/persistence suites pass **45/45**. No B6 threshold, verifier rerun rule, or frozen evidence semantics changed.
- Local D4 after the optimization: B6 warm p95 **210.7ms ≤ 500ms**, exact 50-query offsets passed; overall **19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**. D2 remains **21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN** with selftest **5/5**.

## 2026-10-12 Navigation-controller and virtualized-tree wave (base `71becfd8574e79b0c778823f392dd77d7eda9555`)

- Extracted finder request epochs, listing/search and pagination into `public/core/controllers/nav-finder.js`; extracted virtual row ordering/rendering, window load pumping, status and focus restoration into `public/core/views/nav-tree.js`. The factory is 356 lines smaller. Session loading, keyboard and persistence remain explicit follow-up work.
- Preserved page limits, request paths, error messages, 34px row geometry, 10-row overscan, stale-response guards and all existing navigation scenarios. Added three direct regressions for superseded requests, independent instances, retry cursors and stale pagination; the existing shared-utils aggregator includes them in root tests and refactor CI.
- Working-tree validation: production and root-test typechecks, full `npm test` (826 Node tests, including 413 Studio tests; contracts negative type checks also pass), focused nav/static/factory tests and ESM/CSS/installer asset audit passed.
- Native Chrome scoped Echo run: 5 PASS / 0 FAIL; B9 first open 111.8ms, 55 timed navigation operations p95 35.2ms, virtualization capped at 39 DOM rows, keyboard focus retained and expansion restored after SIGTERM. This is local Echo navigation evidence, not real-Pi or whole-project acceptance.
- Initial sandbox runs failed because local HTTP listeners were denied (`listen EPERM`): D2 Studio tests and D4 B6/B9. Original failure evidence remains on disk. D2 outside the sandbox: 21 PASS / 0 FAIL / 1 NOT_RUN (exit 3, explicit D1 live authorization absent). D4 outside the sandbox: 19 PASS / 0 FAIL / 1 NOT_RUN (exit 3, owner cross-platform install gate). D2 and D4 failure-injection selftests passed.
- No frozen fixture, verifier threshold, acceptance denominator or historical evidence was removed or relaxed. Final-SHA real Pi, physical installations and owner/participant acceptance remain open.

## 2026-10-13 Navigation, HTTP, harness and evidence wave (base `bc8692b5c4be2ae1c2d1173ccd98c60ebdb4e013`)

- R1 extracted navigation session/child paging, keyboard/selection/scrolling, serialized expansion persistence, branch search and source location controllers; path and branch-result views are separate. The factory is 693 physical lines smaller (7,594 lines), with all 20 moved navigation function bodies unchanged after normalizing comments/formatting.
- R2 shared event/network protocol types, record conversion, selector traversal and SSE stubs across all eight UI suites. Each suite retains its own SSE constructor/registry and DOM constructor checks. Added five controller regressions for late responses, read-only restore, stale cursors, serialized latest snapshots and late persistence failures; existing scenario assertions remain intact.
- R3 extracted tree/source/new-exploration/Return/journal/events/abort and search HTTP handlers. The 167-line server owns wiring, dispatch order, errors and process lifecycle; response codes, request validation order and Return save-before-navigation remain unchanged.
- R4 extracted the D4 runner's native Chrome/CDP lifecycle and screenshot/sidecar capture into `scripts/d4/browser/chrome-host.mjs`; the existing CLI and check registry remain unchanged. The runner is 703 lines.
- R0 added a read-only AST-based literal reverse-import and static scenario audit, including untracked source files, and wired it into diagnostics CI against the PR base. Main baseline entrypoint comparison: browser `app.js` 9,718 → 19 lines (remaining factory measured separately), HTTP server 1,732 → 167, D4 browser runner 996 → 703. Static baseline scenario names: 794 retained; current 838. These counts do not substitute for dynamic cases or behavioral tests.
- R6 accounts for every tracked evidence path, including 78 flat/history/guidance/quarantine paths in `unassignedPaths`; 2,264 files are grouped into 160 runs with 831 marker hashes. No evidence was deleted or interpreted as acceptance.
- Working-candidate checks: production and root-test typechecks, full root test run before the final stub/index edits (831 Node tests), final Studio suite (413/413), shared/static/controller tests, literal boundaries/scenarios and ESM/CSS/installer inclusion audit passed. Final committed-candidate results must be read from the subsequent run records; an earlier run does not validate later edits.
- Scoped native Chrome Echo regression after the Chrome host extraction: 5 PASS / 0 FAIL; B9 first open 117.5ms, 55 timed operations p95 69.7ms, at most 39 DOM rows, keyboard focus retained and expansion restored after actual SIGTERM. This is navigation-only Echo evidence.
- D2 offline 21 PASS / 0 FAIL / 1 NOT_RUN (exit 3, D1 live authorization absent); D4 offline 19 PASS / 0 FAIL / 1 NOT_RUN (exit 3, physical owner install/real-Pi gate). D2/D4 failure-injection selftests passed. Initial sandbox listener failures remain in local logs and are not counted as successful verification.
- Outstanding local decomposition: conversation/branch/terminology/material factory responsibilities, remaining DOM/selection/backend/storage mocks, Studio service/terminology/repository ownership, and the other runtime/Pi/installer/verifier runners. Final-SHA real Pi, physical installations, owner signoff and participant trials remain open; R0–R7 overall completion is not claimed.

## 2026-10-13 Full browser ownership and terminology wave (base `71bcdfb992db0330a535e3c6abcfa288cb407425`)

- Browser ownership is now split across instance-owned conversation/turn-action/overlay/selection, Tree/Branch/prompt/Return, source drawer, diagnostics/SSE, terminology, materials and search/navigation controllers and views. The lifecycle/static-listener entrypoint is 403 lines; core composition is 624 lines with separate material/navigation composition modules. State and all controller epochs/timers/caches remain per start; cross-feature callbacks resolve lazily.
- Terminology's public `src/terminology.ts` entrypoint reexports compatible names from models/policy, prompts/candidates, usage, executor, suggestion projection/density, service, atomic promotion coordinator and first-question dispatch/reconciliation ledger. The repository transaction coordinator, immutable first-question hash, replay/failure/unknown-result semantics and quality gate remain unchanged.
- Full scripted validation after the final fixes: production/root-test typechecks and all 834 Node tests passed before the subsequent reduced-motion regression (413 Studio tests); the eight UI suites retain all 146 scenarios. The read-only literal audit retains all 794 main-baseline static names, now 841 total including the subsequent reduced-motion regression, with no boundary violations. All 53 ESM assets and nine CSS modules are accounted for; duplicate exact static routes now fail the asset audit.
- Native Chrome exposed two issues that scripted DOM alone did not detect. Calling injected native fetch as a dependency-object method changed its receiver; API/upload controllers now preserve its original unbound call contract, with a direct regression. PDF.js asynchronous canvas sizing could push a Return source block outside the viewport; PDF frames now reserve the parser's known page aspect ratio before paint, with finite/positive geometry guards and a direct regression. A later complete run exposed native scroll-event timing: an immediate reduced-motion follow could be undone by a same-task refresh restoring an obsolete snapshot. Visible conversation containers now record their actual programmatic scroll position synchronously; hidden zero-size containers retain saved positions. A direct regression models delayed scroll events and readers above. Canonical text, offsets, frozen fixtures and browser assertions/thresholds were unchanged.
- Initial full Echo Chrome run failed startup; a subsequent full run had 15 PASS / 1 FAIL (PDF Return source viewport). Both failure records remain under `/tmp/treeai-r1-term-full-chrome*`. After reserving geometry, the original scoped import/material Branch/Return checks passed 7/7 at `/tmp/treeai-r1-pdf-return-chrome`; the next complete run at `/tmp/treeai-r1-term-full-chrome-final` had 15 PASS / 1 FAIL (reduced-motion follow). The original Beta check passed 5/5 after the timing fix at `/tmp/treeai-r1-reduced-follow-chrome`. Complete committed-candidate results are recorded separately before claiming whole-browser parity.
- This wave does not close R0–R7 overall. Remaining automatic work includes Studio service/repository decomposition, remaining DOM/selection/backend/storage mock deduplication, large runtime/Pi/installer/verifier runners, final computed-path audit and final-SHA Pi/browser/CI/package verification. Physical owner installations/signoff and participant trials remain independent human gates. Evidence cleanup is still gated by whole-project acceptance.

## 2026-10-13 Studio service ownership wave (base `dfd81d2668fc530cc4f230a6339bf64b24c76123`)

- The preceding browser/terminology checkpoint passed production/root-test typechecks and all 835 Node tests. Complete native Chrome Echo on that exact commit passed 16/16 with every original check and frozen denominator present (`/tmp/treeai-dfd81d2-full-chrome/summary.json`). This is whole Echo browser scope, not final Pi or human acceptance.
- `src/service.ts` now preserves its public exports through Studio model/error/policy modules and a 605-line orchestration service. Instance-owned event/journal observation, session continuation/cursor coordination, Return atomic save/replay/navigation and safe saved-fact/diagnostics/journal read projections have separate owners.
- One prompt lock and active-run/prelude state remain in the orchestration owner. Observers receive current state through callbacks; journal write ordering/recovery and flush barriers are unchanged. Session availability still only probes file existence and never decides whether saved product facts exist. Return uses the original repository transaction before navigation and retains the original replay/conflict behavior.
- Focused service/event/material/API/search/navigation cases passed 69/69. Full working-candidate production/root-test typechecks and all 835 Node tests passed. Exact committed-candidate verification is recorded separately before any final parity claim. No fixture, assertion, check ID, dependency, lockfile or acceptance threshold was changed.
- R3 repository decomposition, R2 remaining test mocks, R4 large runners/runtime, final audit/integration/Pi/package checks and mandatory human acceptance remain open. The continuous goal is active.

## Verified CI facts (exact commit required)

- [#21 B6 portability commit `5cc4cb5b175516a4fc6755d1f488bac7bb81d14c`](https://github.com/Lortzing/TreeAI/pull/21): D2 offline and refactor-diagnostics succeeded. A Linux TrueType TTC was supplied; B6 dataset and performance verifier were **not disabled**.
- Previous [#20](https://github.com/Lortzing/TreeAI/pull/20) scripted DOM regression: 408/408 Studio tests passed, and D2 offline passed. These results do not prove native Chrome or the integration PR final SHA.
- Chromium/CDP has successfully booted the actual Studio shell in CI on earlier candidate runs. Full scoped Beta/material/terminology/browser acceptance is still in progress; previously surfaced README-test compatibility and prerequisite issues are tracked in the integration PR.
- D4 B8 target Windows 11 x64 / Ubuntu 24.04 x64 clean installation and real Pi material smoke remain NOT_RUN pending physical owner validation. Historical Mac evidence is not a fresh signoff of this integration candidate.

**Non-negotiable:** D3 and signed W1 v3, terminology three workstreams, D4, final Pi/Chrome, installed package, owner signoff and 3–5-person trials remain independent gates. A successful offline echo or partial CI run is not overall acceptance. Failure evidence remains until reconciled and the entire project has passed all gates. Reference [Issue #7](https://github.com/Lortzing/TreeAI/issues/7) and [Issue #8](https://github.com/Lortzing/TreeAI/issues/8) for the underlying obligations; do not revise those standards inside a mechanical refactor.

Relevant detailed history: [D3 status](../d3/D3-status.md), [full D3 ledger](../archive/d3/D3-status-history.md), [D4 status](../d4/D4-status.md).
