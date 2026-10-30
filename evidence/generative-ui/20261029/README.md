# Generative UI engineering evidence — 2026-10-29

Baseline commit: `35ae4a012fd6beea0b66b9bb773dbe858dfedc45`.
Candidate: uncommitted working tree, with exact changed source/test SHA-256 identities in [source-manifest.json](source-manifest.json). No committed-candidate, release, or whole-product acceptance is claimed.

| Check | Result / evidence |
| --- | --- |
| Full workspace typecheck | exit 0, [typecheck.log](typecheck.log) |
| Full `npm test` after final source-binding guard | 924 PASS / 0 FAIL / 0 skipped, exit 0; [summary](test-summary.json), [raw log](tests.log) |
| New Generative UI tests | 23: 7 validation, 10 service/storage/portability/HTTP, 6 browser/draft/dialog |
| Static assets / installer source inclusion | 58 ESM + 13 CSS, PASS; installer recursively includes the new source directories |
| Computed paths | 132 resources + 20 discovery globs, PASS; 12 general dynamic paths remain runtime-gated |
| D2 offline verifier | 21 PASS / 0 FAIL / 1 NOT_RUN, exit 3 INCOMPLETE; [result](d2-result.json) |
| D4 offline verifier | 19 PASS / 0 FAIL / 1 NOT_RUN, exit 3 INCOMPLETE; [result](d4-result.json) |
| D2/D4 failure-injection selftests | exit 0; [D2](d2-selftest.log), [D4](d4-selftest.log); original run directories remain in the repository |
| Actual browser | IAB native browser on a local temporary Echo database; [screenshot](comparison-offline.png), [DB confirmation](browser-db-check.json) |

The complete D2/D4 runs preceded the last tightening of same-Tree source bindings to the original Branch selection. The final typecheck and full 924-test run followed that tightening, including material/export/restore/HTTP and forged-origin rejection tests. Do not present the earlier verifier source snapshot as a separate exact-final-commit run.

Browser actions verified: open an existing Branch; expand the comparison entry; inspect generation context/budget; explicitly generate; inspect the comparison and text alternative; select a takeaway and append it to the existing Return draft; inspect saved source snapshots and locate the original selection; refresh; force-stop/restart the temporary Studio process and read the same saved revision; enlarge the same DOM card; Escape closes only the dialog and preserves Branch/checkbox state. Native DOM testing exposed and corrected checkbox sizing and Escape propagation. Browser error log was empty at the final inspection.

One saved task and 1,597 accounted characters remained after all reading/refresh/restart actions. There were zero confirmed Return turns: adding a generated takeaway only touched the local draft. All test/example source content was synthetic. The screenshot is explicitly labelled offline and is not evidence of model content quality.

The external Claude Code channel contributed the initial seven schema tests and a bounded concurrency review. Both requests reported `is_error: false`, `subtype: success`, and no permission denials. The main agent corrected TypeScript details, independently reviewed the findings, and ran all checks; the review's suggested cancellation-overwrite issue was already guarded by repository terminal-state immutability.

Earlier failed runs remain under `/private/tmp/treeai-genui-*`: the initial missing dependencies/Node strip-only parameter property, expected schema/CSS manifest updates, and sandbox-denied listener attempts were resolved. They are not counted as successful runs. No frozen fixture, acceptance denominator, prior assertion, lockfile, or historical evidence was removed.

Exclusions: no real-Pi quality run (no configured model credentials in this task/default data locations), no 20-task learning-quality evaluation, no fresh target-device installations, no owner/participant signoff. D1 live repro and D4 B8 real-machine gates retain NOT_RUN. Future quiz/simulation/multi-material components are outside this first ComparisonCard slice.
