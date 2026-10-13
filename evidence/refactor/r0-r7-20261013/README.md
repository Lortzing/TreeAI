# R0–R7 code-candidate verification (before evidence text correction)

Tested code: `1ea8e9ee506d999a050a32be535a88a91e5f91cd`. These results validate this commit, not a later code change. All raw command logs, original failures and scanner-clean browser/terminology reports are retained. Home path values in copied logs/reports were redacted; checks/errors/counts/timings/SHAs were preserved.

| Surface | Actual result |
| --- | --- |
| Production/root test types | exit 0 |
| Root Node tests | 849 pass / 0 fail |
| Integration | runtime-smoke 2/2 and scenario tests 8/8 |
| D3 Chrome Echo | 25 PASS / 6 mode-gated NOT_RUN, exit 0 |
| D3 API Echo | 19 PASS / 6 mode-gated NOT_RUN, exit 0 |
| D4 full Chrome Echo | 16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN, clean working tree |
| D2 offline | 21 PASS / 1 D1 live NOT_RUN, exit 3 INCOMPLETE |
| D4 offline | 19 PASS / 1 owner B8 NOT_RUN, exit 3 INCOMPLETE |
| Independent failure-injection tests | D2 5/5; D4 control + eight defects detected |
| Terminology dev/frozen Echo | complete 180 items each; 5 PASS / 2 human PENDING per set |
| Dev weak baseline | 38/318 negative-term mislabel, 11.9% > 10%; nonbinding FAIL retained, human PENDING |
| darwin-arm64 package + smoke | pinned official Node hash; scanner zero findings; 46/46 |
| macOS installation engineer automation | 55/55; original label inversion is explained in the run's summary-erratum.md |

B6 search warm p95 236.2ms ≤500ms; every frozen query hit its target. B2 browser selections retained 45 Markdown + 30 PDF valid cases. Frozen fixtures, evaluator sets and lockfile are unchanged from the main baseline.

Package `gitDirty=true` records only generated, untracked evidence; tracked source stayed at the tested SHA. The package remains available locally at `/tmp/treeai-r0-r7-final-package/treeai-studio-0.0.0+1ea8e9ee-darwin-arm64.tar.gz`, SHA-256 `bdf20041cab53eb0c097effa869c86293072e2f4539c4fef58cd862a507db113`.

Real Pi, real-model quality and D1 live reproduction were not executed without configured credentials. Physical target-device acceptance, Mac owner signoff, independent trials and two-person annotation/arbitration remain open. PR #27 was read but a push was rejected by automatic approval review; no code or evidence was published by this run.
