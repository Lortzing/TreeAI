# R0–R7 local automatic acceptance

Tested code SHA: **`0173fc34a4900e45355224693a27b17a51a47dc6`**. The subsequent record/CI-order commit changes documentation/evidence and the placement of the discovery audit only; it does not change tested product code, runner implementations, fixtures or test discovery. Remote CI has not run on this result because the push is awaiting explicit approval.

The 17 sequential command records and complete logs are in `commands.json` and adjacent files. Two complete code-candidate recordings, initial failures and the original macOS label mistake/erratum are retained in the earlier evidence directory. Copied logs redact home paths only; check IDs, results, timings, reasons, hashes and SHA fields remain intact.

| Surface | Actual result |
| --- | --- |
| Production types + root test types | exit 0 |
| Complete root Node tests | **850 PASS / 0 FAIL**, exit 0 |
| Integration | runtime-smoke **2/2**, scenario tests **8/8**, exit 0 |
| Complete D4 native Chrome Echo | **16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**, exit 0; gitDirty=false |
| D3 native Chrome Echo | **25 PASS / 6 mode-gated NOT_RUN**, exit 0; real-Pi-only checks remain unexecuted |
| D3 API Echo | **19 PASS / 6 mode-gated NOT_RUN**, exit 0 |
| D2 offline | **21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**, exit **3 INCOMPLETE**; D1 live repro excluded |
| D4 offline | **19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**, exit **3 INCOMPLETE**; owner B8 excluded |
| Independent selftests | D2 **5/5**; D4 clean control + all eight defect injections detected, exit 0 |
| Complete dev/frozen terminology Echo | **180 items each**, 5 PASS + 2 human PENDING per set; pipeline evidence only |
| Dev weak baseline | mislabel **38/318 = 11.9% > 10%**, reported nonbinding FAIL retained; 2 PENDING + explanation NOT_RUN |
| darwin-arm64 package smoke | **46 PASS / 0 FAIL**, exit 0 |
| macOS engineer installation automation | **55 PASS / 0 FAIL**, exit 0; corrected precondition label says before/after absent=true |
| Original D4 CLI contracts | complete 5/5, exit 0 |

Frozen B1 ready denominator: **24**, negatives **11**. Frozen browser B2: **45 Markdown + 30 PDF** valid selections, exact UTF-16 offsets, copy and resolver agreement, explicit cross-page rejection. B6 full 50-query search warm p95 **227.9ms ≤500ms**, every query hits the frozen target. B9 uses the unchanged 10,100-node truth and complete paths/source checks. Native B9 p95 **48.2ms ≤300ms**; 30 native material opens p95 **32.5ms ≤2s**.

R0 audits preserve **794/794 original static declarations** (853 current), zero literal boundary violations, **53 ESM + 9 CSS** assets, **131** computed resources and **20** discovery globs. Twelve variable expressions are enumerated and mapped to execution owners in the development audit scope. R6 accounts for all **2,662** evidence paths tracked at this tested code SHA: 2,551 grouped and 111 explicitly unassigned. Newly appended records are retained, not deleted. Main-baseline diff has zero changes to frozen fixtures, both evaluator sets, contracts or lockfile, and zero modifications/deletions of original evidence.

Fresh generated-discovery check: removing only the generated journal `dist` causes the expected audit exit 1; the original Studio dependency build exits 0 and restores audit exit 0. CI now performs discovery after the Studio build. No generated test is exempted and no assertion is weakened. The saved prior generated directory remains in `/tmp`.

Package source SHA is the tested SHA. Its `gitDirty=true` records only generated untracked evidence during packaging; tracked product/runner/test source was unchanged. The official pinned Node distribution hash was verified, launcher/module layout passed and the staging scanner reported zero findings (its existing node_modules blind spot is disclosed in the build report). Package artifact: `/tmp/treeai-r0-r7-final2-package/treeai-studio-0.0.0+0173fc34-darwin-arm64.tar.gz`; SHA-256 **`8e6346bab6f664cdd251c07cbbd90780f8ffc13db8976c2a002bdfcd8cb31c20`**.

Open gates remain explicit: configured credentials for final real Pi/D1/real-model evaluation; one-shot frozen real verdict with no retries around the lock; independent two-person quality annotation/arbitration; owner Mac experience signoff, Windows 11/Ubuntu 24.04 clean physical installations/real-Pi smoke, and 3–5 independent participant trials. No participant, annotation or signature was fabricated. Echo, local installation automation and CI never substitute for those gates.

Existing integration PR: https://github.com/Lortzing/TreeAI/pull/27. Automatic permission review rejected pushing source/evidence without explicit destination authorization. No push, comment, workaround transfer or main merge was performed. The complete local result is ready for approval and review.
