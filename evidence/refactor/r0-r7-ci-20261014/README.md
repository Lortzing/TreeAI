# R0–R7 remote integration — 2026-10-14

The user explicitly approved pushing code/evidence to Lortzing/TreeAI PR #27 and continuing CI. The initial HTTPS Git attempt had no credential helper; the CLI OAuth token lacked workflow scope. The existing SSH identity authenticated as Lortzing and successfully fast-forwarded the PR from `bc8692b5c4be2ae1c2d1173ccd98c60ebdb4e013` to `40b84b7f179f91b5242bdbd3497e2e752082503f`. No new credential permission, forced update or main merge was used.

At `40b84b7f179f91b5242bdbd3497e2e752082503f`, D2 offline, native Chrome and refactor diagnostics CI completed successfully. D4 remains 19 PASS / 1 owner B8 NOT_RUN, exit 3 INCOMPLETE. Linux B6 warm p95 was 479.1ms, triggering the original rerun rule; the definitive rerun was 477.9ms ≤500ms. Both are preserved.

The installer workflow succeeded on Linux/macOS; Windows failed in the newly enabled complete unit gate before packaging. Eight original assertions exposed host assumptions in synthetic fixtures: fixed POSIX separators on Windows and POSIX execution bits unavailable in NTFS. The original failure/secondary missing-artifact errors are retained.

The fixture correction preserves every original case, problem-count and reason assertion. Expected paths use the host filesystem's exact join semantics. Only synthetic foreign-POSIX bundles on Windows receive a scoped, one-node stat-mode fixture; real packaged/launcher validation stays unchanged. Existing missing-execution checks still reject mode 0644. A new regression forces both modes and verifies filesystem inspection/function identity are restored. Real POSIX smoke continues on Linux/macOS.

Working-candidate validation: focused installer tests 36/36, root tests 851/851, root test types pass, 794 baseline static declarations retained (854 current). Initial local mock API/type failures were corrected and retained. No production code, fixture/evaluator denominator, threshold or guard changed. The next committed SHA requires all applicable remote checks, especially Windows packaging and actual smoke, before claiming engineering CI completion.

Real Pi/quality credentials, independent annotations, owner target installations/Mac signoff and independent trials remain open. Green CI never replaces physical or human gates.

## Final engineering CI at d20d808

Full tested remote SHA: **`d20d808262b50859a855e91a54eb57004a78df74`**. All PR checks and all three installer jobs completed successfully. Exact run/job results, complete logs, artifact inventory and the original failed attempt remain in this directory. This follow-up commit contains documentation/evidence only and does not relabel these runs as another SHA.

| Run | Result | Limits/exclusions retained |
| --- | --- | --- |
| [D2 offline](https://github.com/Lortzing/TreeAI/actions/runs/38501050211) | CI success | verifier 21 PASS/1 NOT_RUN, exit 3 INCOMPLETE; no D1 live repro |
| [Native Chrome](https://github.com/Lortzing/TreeAI/actions/runs/38501050229) | CI success | two explicitly scoped Echo runs, 7/7 each; not full 16-check or real Pi evidence |
| [Refactor diagnostics](https://github.com/Lortzing/TreeAI/actions/runs/38501050231) | CI success | D4 19 PASS/1 owner B8 NOT_RUN, exit 3; B6 first warm 471.1ms, definitive rerun 459.7ms ≤500ms; both retained |
| [Three-platform installer](https://github.com/Lortzing/TreeAI/actions/runs/38501239760) | Linux/macOS/Windows success | each actual package smoke 46/46; archive checksum verification and artifact upload succeed; Windows took 23m20s |

Actual package SHA-256 (distinct from the uploaded enclosing artifact zip digest): win-x64 `49f5c03fffdde43e77cb38351efe1191c51066ca0b7c2b0d3e9945e510c518c8`; linux-x64 `849dade377ce2ca46d81d445d5dde5e915e5d578d79f65b48538c7eb814aa661`; darwin-arm64 `ad0dfc228bccb311c5f0a651c53692714d83c468288aa2116c798c070a2533ee`.

Compatibility-entry physical measurements are retained in `entry-context.json`: app.js 9719→20 lines, server.ts 1733→168, D4 browser entry 997→607. Code moved to linked owners; this is not a token count, total repository shrinkage or a claim about the complete context needed for every task.

The full local browser/API/terminology/Mac recordings remain bound to their original code SHA `0173fc34a4900e45355224693a27b17a51a47dc6`. A Git comparison confirms zero changes in apps/packages/scripts/package/lockfile between that SHA and d20; only root fixture tests and documentation/evidence/CI ordering changed. Earlier runs are never relabeled as d20. Whole-project/human/model acceptance is still not claimed, and no raw evidence was deleted.
