# Terminology eval run term-eval-20261001T112126245Z-dev-echo-baseline

- set: **dev** (hash `23c6fd6a522a66ec…`)
- mode/provider/model: **echo / baseline / baseline/baseline**
- git: `c282b2f6c5a408bdc03192f2d3efdda7a6a9f261` (dirty: true) branch `wip/term-eval-runner`
- runner v1; prompt versions explain v2 / extract v2
- started/finished: 2026-10-01T11:21:24.637Z → 2026-10-01T11:21:26.245Z

## Gates

| gate | status | binding | detail |
| --- | --- | --- | --- |
| pipeline-integrity | PASS | yes | explain: 74/74 clean terminal states (74 not applicable, 0 unexpected); extract: 106/106 clean terminal states (0 unexpected) — mode echo, provider baseline |
| explain-source-match | NOT_RUN | reported-only | provider does not explain (baseline) |
| extract-negative-mislabel | FAIL | reported-only | negativeTerms mislabel (term level) = 44/318 = 13.8% (gate ≤10%); separately: full-negative item level 51/51 = 100.0%, unlisted extra marks 761 |
| usefulness | PENDING | reported-only | 有用率 (≥90%) needs two-person annotation of annotation-sheet.csv (rater1/rater2 + arbitration); never asserted mechanically |
| key-obstacle-coverage | PENDING | reported-only | 关键理解障碍覆盖率 (≥80%) needs two-person annotation (key_obstacle columns + arbitrated useful explanations); never asserted mechanically |

## Metrics (per task kind)

**explain** — ran 0 (succeeded 0, failed 0); source match 0/0; empty outputs 0; latency p50 n/ams / p95 n/ams (advisory ≤5000ms) / max n/ams

**extract** — ran 106 (positives 55, full negatives 51, failed 0); expectedTerms recall 43/149 = 28.9%; precision 43/848 = 5.1%; negativeTerms mislabel 44/318 = 13.8%; full-negative item mislabel 51/51 = 100.0%; unlisted extras 761; empty outputs on positives 0; latency p50 6ms / p95 16ms (advisory ≤8000ms)

## Cost accounting (explicit denominators; tokens honestly UNKNOWN)

- explain: 0 request(s), input 0 chars / output 0 chars
- extract: 106 request(s), input 114322 chars / output 32607 chars
- tokens: real usage **UNKNOWN** (the Pi seam does not expose token counts); chars/4 estimate 0 (explain) + 36733 (extract) — listed separately, never mixed
- retries: 0 max; 0 actual retry dispatch(es)

## Pending human gates

- 有用率 (≥90%): PENDING — two-person annotation of `annotation-sheet.csv` (rater1/rater2 + arbitrated).
- 关键理解障碍覆盖率 (≥80%): PENDING — key_obstacle columns + arbitrated useful explanations.

## Note

echo mode with the zero-dependency baseline — offline reference floor for the baseline/strong-model comparison; quality gates are reported, not binding

## Echo selftest

- [PASS] selftest:extract-metrics — recall 1/4, precision 1/4, mislabel 2/3, extras 1 (got 1/4, 1/4, 2/3, 1)
- [PASS] selftest:explain-metrics — source match 1/2 = 50% (gate must FAIL below 100%)
- [PASS] selftest:gate-flip — binding quality gates flip to FAIL on synthetic violations (50% source match; 66.7% mislabel)
- [PASS] selftest:baseline-nonbinding — baseline provider quality gates are reported-only (weak baseline is expected, not a runner defect)
- [PASS] selftest:nth-occurrence — 3rd occurrence resolves at 22 with slice equality
- [PASS] selftest:frozen-lock — echo runs, observe-only real runs and dev runs never lock the frozen verdict
- [PASS] selftest:frozen-lock-2 — an executed real frozen run with matching set hash locks the verdict
- [PASS] selftest:secret-scan — secret values are detected in serialized reports
- [PASS] baseline:determinism-zh — same input twice -> 8 candidates, byte-equal JSON
- [PASS] baseline:determinism-en — same input twice -> 8 candidates, byte-equal JSON
- [PASS] baseline:mechanical-zh — slice equality + dedup + density cap hold
- [PASS] baseline:mechanical-en — slice equality + dedup + density cap hold
- [PASS] baseline:known-answer-zh — repeated technical n-gram 梯度下降 ranks above glued boundary junk (top: 梯度下降, 配衰减计划, 一步的幅度)
- [PASS] baseline:known-answer-en — repeated en bigram phrase is among the candidates (top: repetition system, spaced repetition, beats rereading., spacing effect)
- [PASS] baseline:code-exclusion — backtick-fenced code is never a candidate
- [PASS] baseline:url-exclusion — URL text is never a candidate
- [PASS] baseline:determinism-set-item — same set-style input twice -> byte-equal output
