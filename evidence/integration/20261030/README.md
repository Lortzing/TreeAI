# TreeAI multi-branch integration — 2026-10-30

**Latest CI follow-up:** source/test commit `20de66609951e99826c22a7a9732ce9a1afa1580` supersedes the initial candidate below with a focused search performance fix. Original failed CI evidence and the original limits are retained; see the follow-up section at the end.

Remote base: `35ae4a012fd6beea0b66b9bb773dbe858dfedc45` (PR #29).
Final code/test candidate: `fd73a458a2e3e52dc68e19249b3cd23e8e986880`.
Integration branch: `codex/integrate-development-20261030`.

## Sources and preservation

| Development line | Preserved snapshot / commit | Integrated result |
| --- | --- | --- |
| Latest Studio UI, settings, attachments, theme, model/input tools, reader | `4c0e3058c9eee3cacd2ca4a4d7203848c4728451`, parent `fca8e4377fa5ebf887cf42d5c8572af3c7bbbfc2` | Latest compact toolbar, warm default theme, local Web Awesome settings, MD/PDF attachment context, configured model selection, material tabs and text-region selection |
| Generative UI | `d1cb06574ed9da5943876f21cc9c70d080027bcb` | Persisted comparison cards, explicit generation, source bindings, budget/cancellation, draft append, schema 11, portable export/restore including schema 10 compatibility |
| Icons | `7aee06e56aeb30dca517a6b48799f51c2af1aa89` | Selected Return icon, favicon, empty-state mark, all design alternatives/assets retained |
| Harvest and continuity | `ebb66d1a68c4718781cc72699de08f745002bc95` | Saved Return overview, source/round jumps, material resume and browser Tree/round cursors |
| Browser CI/history diagnostics | `4224fca89c57cc773846ff782e0c8a3b97574766` | Missing artifact retention merged; newer detailed Escape diagnostics retained; other history changes already present |
| Earlier settings worktree | `795b3a89867412b89fe1838af084571acbc039a4` | Reviewed as superseded by PR #29 and latest settings; recorded by a no-content merge to preserve provenance |
| Earlier layout worktree | `65a36caadd8d02ef4ad12a09a7d9849aee05b4c5` | Reviewed as superseded by latest layout/fixes; recorded by a no-content merge, without restoring removed tool-panel behavior |

Other worktrees were inventoried. Research-only worktree had no repository changes; the old refactor worktree contains historical generated evidence but no new product code. Existing source worktrees, their branch tips and uncommitted files were not edited. Temporary indexes produced snapshots, and changed/new bytes were hash-checked before and after. See [original worktree hashes](worktree-manifest.json), [snapshot identities](worktree-snapshots.json), and [tested production/source hashes](tested-source-hashes.json).

Conflicts were resolved by combining feature wiring, static allowlists and complete test bodies. New icons and the harvest action were placed in the latest toolbar, rather than reinstating the old two-toolbar markup. Generative cards remain separate from saved Return facts; app disposal releases their polling. Material-refresh updates also refresh the harvest view. No dependency/lockfile or frozen fixture/evaluator bytes changed; no existing evidence was removed.

## Validation

- Node `24.21.0` / npm `11.19.0`.
- Final production/workspace types and root test types: PASS ([workspace](types-final.log), [root](root-types.log)).
- Final `npm test`: **945 / 945 PASS**, 0 failures/skips ([log](tests-final.log)). First combined run had 944 PASS; the final run adds a real schema 10→11 upgrade preservation regression. Schema 11 creation and generated-card compatibility tests remain intact.
- Literal import/static scenario audit: **898 baseline names retained, 942 current, 0 violations** ([report](boundaries-final.json)). First audit flagged four renamed scenarios; three original names were restored with their updated complete bodies, and the historical schema 10 case now independently exercises the legacy migration prefix and preservation on upgrade. No checker exceptions or denominator reductions were introduced. The first audit and initial new migration test's wrong table-name failure are retained in the adjacent logs.
- Native ESM/CSS/vendor checksum/package inclusion audit: **105 ESM / 13 CSS PASS** ([log](assets-first.log)). Computed paths: **132 resources / 20 discovery globs PASS**, 12 dynamic expressions retain existing runtime gates ([log](paths.log)).
- Full native Chrome Echo D4: **16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN** ([summary](browser-summary.json), [log](browser-first.log)). Frozen import/selection denominators, Return save/restart/source, search, export/restore, B6/B9, wide/narrow, keyboard/touch and terminology were exercised. Summary retains `gitCommit=fd73a45...`, `gitDirty=true`: generated evidence was untracked and the test-only retention commit landed during this run. Production/browser/runner sources did not change between `413be1d2f1f0dc0b24ec32f2247fbb8f13ce9cf8` and `fd73a45`; exact final source hashes are recorded separately. This is final-source Echo evidence, not a clean-tree run or real-Pi claim.
- Separate D2 selftest: **5/5 PASS**; separate D4 selftest: all original injections detected, clean control ([D2](d2-selftest.log), [D4](d4-selftest.log)). Their complete generated evidence is retained under the original `evidence/d{2,4}/selftest/` directories.
- Direct IAB integration flow: pre-existing schema 10 demo data reopened with the merged schema 11 product; old Return and selected round remain readable. Opened a prior branch via harvest, explicitly generated an Echo comparison, selected a takeaway, appended it to Return draft, confirmed it, then observed two independently saved Returns in the harvest overview. Theme, new logo, attachment/model tools and compact toolbar were visible together. [Integrated preview](integrated-preview.png). Demo directory `/tmp/treeai-harvest-preview-20261030` contains synthetic material only.

Offline D2 rerun: **21 PASS / 0 FAIL / 1 NOT_RUN**, exit 3 INCOMPLETE ([log](d2-local.log)); D4: **19 PASS / 0 FAIL / 1 NOT_RUN**, exit 3 INCOMPLETE ([log](d4.log)). These preserve the authorization-gated D1 repro and human/physical B8 exclusions. The original sandbox D2 run failed HTTP bind permissions and is retained ([log](d2.log)); it is not counted as a product pass. Final remote integration identity is reported by the merge operation, not invented here.

## Boundaries

No new real-Pi/model-quality, live microphone/provider-switching, full new installer, target-device signoff, independent participant or long-term trial result is claimed. Raw UI selections and Echo sample cards do not establish factual correctness or product value. D1 opt-in, frozen quality/annotation/arbitration and original human/device gates stay open. DOCX/PPT/web/image ingestion and shared tabs across every right-pane type remain the prior refinement line's stated exclusions. Merge does not constitute formal release or whole-project acceptance.


## CI performance follow-up

Initial PR head `44eb27bb667400259034c6ef9f3a31df29ecf1d3` passed remote D2 and native browser workflows, but [diagnostics run 41039456137](https://github.com/Lortzing/TreeAI/actions/runs/41039456137) failed the original B6 search gate: Linux warm p95 **533.1ms**, definitive rerun **521.3ms**, limit **500ms**. This is retained as a FAIL in [the complete job log](ci-first-diagnostics.log), not treated as machine noise or hidden by a rerun.

Source/test fix: `20de66609951e99826c22a7a9732ce9a1afa1580`. Per-document unique tokens now append monotonically increasing IDs into array postings, and queries intersect them with two pointers. The engine still reads/rebuilds from current product facts every request; no product cache or invalidation mechanism, ranking, matching, Unicode offsets, serialization format, frozen corpus, query list, threshold or rerun rule changed.

CPU profiling on the exact B6 corpus identified index construction as the dominant cost. Alternating before/after builds on identical snapshot documents measured median **165.4ms → 105.6ms**, p95 **172.4ms → 114.5ms** (14 measured builds each after two warmups). Every complete hit object matched across all 50 frozen queries plus extra Unicode/scope/kind/limit cases ([comparison output](perf-comparison.log)). The regression covers astral CJK, repeated query terms, intersection order, exact UTF-16 positions and restored indexes. Its initial missing local test-helper failure is retained; the corrected focused suites pass 25/25.

Revalidation on unchanged fix bytes:

- Complete root suite **946/946 PASS**, no failures/skips ([log](search-fix-tests.log)); workspace and root test types pass.
- Static boundary audit **898 original names preserved / 943 current, 0 violations** ([report](search-fix-boundaries.json)).
- Original scoped B6 check passes, **3 PASS / 0 FAIL**, exit 0 including its original result/hygiene rows ([log](search-fix-b6.log)). Full original 50-query HTTP warm p95 **194.8ms ≤ 500ms** on this macOS host; cold p95 **166.9ms**. This local timing does not substitute for the Linux rerun. Raw generated evidence: `evidence/d4/runs/d4-offline-20261030T102645640Z/`.
- [Exact tested source hashes](search-fix-source-hashes.json). The earlier full browser 16/16 record remains bound to its initial code; the fix changes only search internals and its test. The PR's subsequent Linux workflows provide remote validation of the new head and are not preclaimed here.
