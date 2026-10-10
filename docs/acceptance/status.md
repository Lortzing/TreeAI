# TreeAI refactor acceptance — live candidate matrix

**Last updated:** 2026-10-10. **Main baseline:** `e427460b31f61722d5e74a6fa4ee24d140abe67b`.
**Integration PR:** [#27](https://github.com/Lortzing/TreeAI/pull/27), branch `refactor/integration-r0-r7`. The current candidate must be read from the PR HEAD; this document does **not** claim that an earlier successful run validates every subsequent commit.

| Wave | Implemented now | Still required |
| --- | --- | --- |
| R0 repository map | `scripts/repo-inventory.mjs`, `scripts/audit-studio-assets.mjs`, task map and agent navigation | Complete importer/CLI/test/installer reverse-dependency audit; initial-to-final measured comparison |
| R1 browser UI | Thin `app.js` bootstrap, isolated `createStudioApp`, ESM/static allowlist, CSS modules, source hash/selection, reading position and DOM reuse; D4-4 Search and Turn-backed Return presentation views isolated in `public/core/views/{search,return}.js` with focused no-browser coverage | Split remaining large factory by conversation/branch/terminology/materials/navigation; real Chrome regressions |
| R2 UI tests | Shared app harness, CSS source loader and targeted module regressions | Deduplicate remaining eight suites' DOM/selection/backend/storage mocks; audit original case/ID denominator |
| R3 Studio server/services | HTTP response, errors, request validation, static and SSE handlers; safe journal summaries, prompt composition, terminology density | Separate HTTP routes, Studio services, terminology executor/promotion/ledger and DB repositories while preserving transaction coordinator |
| R4 runtime and runners | Pi session inspection, four ordered PDF fixture groups and frozen registry test | Full browser/Pi/installer/verification runner boundaries, dataset ownership and old CLI/check ID compatibility |
| R5 documentation | Short README/AGENTS, docs index/task map/architecture, archived D3 historical ledger | Verify all references and final product authority consistency |
| R6 evidence lifecycle | Original evidence retained; read-only `scripts/evidence-index.mjs` locator and [usage](evidence-index.md); Linux-compatible frozen B6 generator font path | Verify evidence index completeness, then remove redundant raw artifacts **only after full project acceptance** |
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

## Verified CI facts (exact commit required)

- [#21 B6 portability commit `5cc4cb5b175516a4fc6755d1f488bac7bb81d14c`](https://github.com/Lortzing/TreeAI/pull/21): D2 offline and refactor-diagnostics succeeded. A Linux TrueType TTC was supplied; B6 dataset and performance verifier were **not disabled**.
- Previous [#20](https://github.com/Lortzing/TreeAI/pull/20) scripted DOM regression: 408/408 Studio tests passed, and D2 offline passed. These results do not prove native Chrome or the integration PR final SHA.
- Chromium/CDP has successfully booted the actual Studio shell in CI on earlier candidate runs. Full scoped Beta/material/terminology/browser acceptance is still in progress; previously surfaced README-test compatibility and prerequisite issues are tracked in the integration PR.
- D4 B8 target Windows 11 x64 / Ubuntu 24.04 x64 clean installation and real Pi material smoke remain NOT_RUN pending physical owner validation. Historical Mac evidence is not a fresh signoff of this integration candidate.

**Non-negotiable:** D3 and signed W1 v3, terminology three workstreams, D4, final Pi/Chrome, installed package, owner signoff and 3–5-person trials remain independent gates. A successful offline echo or partial CI run is not overall acceptance. Failure evidence remains until reconciled and the entire project has passed all gates. Reference [Issue #7](https://github.com/Lortzing/TreeAI/issues/7) and [Issue #8](https://github.com/Lortzing/TreeAI/issues/8) for the underlying obligations; do not revise those standards inside a mechanical refactor.

Relevant detailed history: [D3 status](../d3/D3-status.md), [full D3 ledger](../archive/d3/D3-status-history.md), [D4 status](../d4/D4-status.md).
