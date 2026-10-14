# R0–R7 remote integration — 2026-10-14

The user explicitly approved pushing code/evidence to Lortzing/TreeAI PR #27 and continuing CI. The initial HTTPS Git attempt had no credential helper; the CLI OAuth token lacked workflow scope. The existing SSH identity authenticated as Lortzing and successfully fast-forwarded the PR from `bc8692b5c4be2ae1c2d1173ccd98c60ebdb4e013` to `40b84b7f179f91b5242bdbd3497e2e752082503f`. No new credential permission, forced update or main merge was used.

At `40b84b7f179f91b5242bdbd3497e2e752082503f`, D2 offline, native Chrome and refactor diagnostics CI completed successfully. D4 remains 19 PASS / 1 owner B8 NOT_RUN, exit 3 INCOMPLETE. Linux B6 warm p95 was 479.1ms, triggering the original rerun rule; the definitive rerun was 477.9ms ≤500ms. Both are preserved.

The installer workflow succeeded on Linux/macOS; Windows failed in the newly enabled complete unit gate before packaging. Eight original assertions exposed host assumptions in synthetic fixtures: fixed POSIX separators on Windows and POSIX execution bits unavailable in NTFS. The original failure/secondary missing-artifact errors are retained.

The fixture correction preserves every original case, problem-count and reason assertion. Expected paths use the host filesystem's exact join semantics. Only synthetic foreign-POSIX bundles on Windows receive a scoped, one-node stat-mode fixture; real packaged/launcher validation stays unchanged. Existing missing-execution checks still reject mode 0644. A new regression forces both modes and verifies filesystem inspection/function identity are restored. Real POSIX smoke continues on Linux/macOS.

Working-candidate validation: focused installer tests 36/36, root tests 851/851, root test types pass, 794 baseline static declarations retained (854 current). Initial local mock API/type failures were corrected and retained. No production code, fixture/evaluator denominator, threshold or guard changed. The next committed SHA requires all applicable remote checks, especially Windows packaging and actual smoke, before claiming engineering CI completion.

Real Pi/quality credentials, independent annotations, owner target installations/Mac signoff and independent trials remain open. Green CI never replaces physical or human gates.
