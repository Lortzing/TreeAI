# D2 JSON Schemas (Agent F)

Three JSON Schemas constrain every artifact the D2 verification gate
produces. They are Draft 2020-12 documents, validated by the
dependency-free subset validator in
`tests/support/verifier/schema-validator.ts` (zero new npm dependencies —
task book constraint); the supported keyword set is documented in that
file's selftest.

| schema | constrains | validated against it by |
|---|---|---|
| `event.schema.json` | every line of `events.jsonl` (eventId / runId patterns, `seq` strict positive integer, UTC-only `occurredAt`, dot-notation `type`, `payload` object, `evidence` references with a closed `source` enum) | `verify-d2` check `schema-validation` (the run's own journal), the evidence-writer integration test, the probe corpus |
| `result.schema.json` | `result.json` and every item in `checks.json` / `results[]`; `$defs/scenarioResult` additionally constrains the six live-scenario records (frozen scenario ids, `driver` pi\|fake, `piVersion` const `0.85.1`); the `anyOf` branches hard-wire the exit-code discipline: PASS→0, FAIL→non-zero integer + `error`, BLOCKED/NOT_RUN→null or non-zero integer + `reason`, verdict↔exitCode pairs | `verify-d2` / `verify-d2-live` (own artifacts), `checkExitCodeConsistency` as an independent re-check, the probe corpus |
| `environment.schema.json` | `environment.json`: `pi.pinnedVersion` is **const `"0.85.1"`** (ADR-001 / D1 DECISION-003 — `latest`, ranges and unrecorded heads are rejected while `installedVersion` stays free-form so drift can be RECORDED honestly and flagged by the `pi-version-pin` check), runtime toolchain, `credentialPolicy` enum `offline \| controlled-env-injection \| none` | every verifier run writes and validates its own `environment.json` |

## Probe corpus

`tests/fixtures/schema-probes/` holds paired valid/invalid instances
(expectations in `manifest.json`; currently 9 valid / 17 invalid probes).
The gate requires every "valid" probe to validate AND every "invalid"
probe to be rejected — a schema that loses a constraint flips an invalid
probe to valid and FAILs `fixtures-integrity` (the failure-path selftest
demonstrates exactly this by weakening the schemas on synthetic trees).

## Revision policy

A **breaking change** to any schema requires, in the same change:

1. a revision entry below (date, schema, what changed, why);
2. new probes under `tests/fixtures/schema-probes/<family>/` covering the
   new constraint in both directions (valid + invalid);
3. `manifest.json` expectations updated and
   `tests/fixtures/MANIFEST.sha256` regenerated (see tests/README.md);
4. `node scripts/verify-d2.js --only=fixtures-integrity` exit 0.

### Revisions

- 2026-09-21 — initial release of all three schemas (events are
  versioned by the schema `$id` + the enclosing run's `result.json`
  `schemaVersion`; `result.schema.json` pins `d2-result-1` and
  `environment.schema.json` pins `d2-environment-1`), Agent F, together
  with the probe corpus, validator and gate.
