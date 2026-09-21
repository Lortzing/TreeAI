# TreeAI D2 — tests, fixtures, schemas and the verification gate

Agent F's acceptance infrastructure: the D2 JSON Schemas, the offline test
corpus (unit / integration / live-framework selftests), the e2e fixtures,
the verification gate (`verify-d2`, `verify-d2:live`, failure-path selftest)
and the CI workflows. Production packages live under `packages/**` and are
owned by the Wave-1 module agents; this tree only *tests* them.

## Layout

```
schemas/d2/                 event / result / environment JSON Schemas
                            (Draft 2020-12 subset, enforced by the built-in
                            validator below — zero new dependencies)
tests/support/              shared test infrastructure
  fake-pi-runtime.ts        FakePiRuntime: faithful offline double of the
                            frozen PiRuntime contract (pinned 0.85.1,
                            steer = same run new turn, navigateTree = same
                            session leaf move, session persistence, abort,
                            dispose idempotence, caller violations =
                            TypeError, runtime failures = TreeAIError)
  harness.ts                RunRegistry (frozen RunState machine + I1–I7),
                            Journal (per-run strict seq), FakeToolPolicy
                            (default deny), EventRecorder
  verifier/                 the gate's own engine, shared by the unit tests,
                            scripts/verify-d2*.js and the selftest so the
                            gate cannot drift between consumers:
    schema-validator.ts     dependency-free JSON Schema validator + selftest
    secret-scanner.ts       15 content + 8 filename rules, masking, selftest
    verdict.ts              exit-code discipline (computeVerdict +
                            checkExitCodeConsistency)
    evidence.ts             append-only run dirs, pre-write redaction/scan,
                            post-write rescan, journal seq verification
    probes.ts               fixtures-integrity + schema-probe corpus check
    util.ts                 runCommand (never throws), readJson, truncate
tests/unit/                 module unit tests (Agent F side)
tests/integration/          e2e scenarios on the fake runtime
tests/live/                 the six live scenarios (framework + selftest)
tests/fixtures/             e2e fixtures + schema-probe corpus
                            (integrity: MANIFEST.sha256, see below)
scripts/verify-d2.js        the offline gate (run directly with node)
scripts/verify-d2-live.js   the live suite (controlled credentials)
scripts/verify-d2-selftest.js  failure-path selftest (injects defects,
                            proves the gate fails)
.github/workflows/          d2-offline.yml (default gate, no secrets),
                            d2-live.yml (manual + protected env only)
evidence/d2/runs/<id>/      every gate run's evidence (append-only)
evidence/d2/selftest/<id>/  selftest evidence (incl. child-run proof)
evidence/d2-quarantine/     runs moved out of the scan root, with reasons
```

## Exit-code discipline (frozen)

| exit | meaning                                                        |
|------|----------------------------------------------------------------|
| 0    | every requested check PASS                                     |
| 1    | the verifier itself failed (unexpected internal error)         |
| 2    | at least one FAIL                                              |
| 3    | no FAIL, but BLOCKED or NOT_RUN present                        |

Honesty rules: a command that is not wired or a module not yet delivered is
**NOT_RUN with a reason** — never a PASS and never silently dropped. A
delivered module whose tests fail is a **FAIL**. Exit 0 is reserved for
"everything asked actually passed".

## The offline gate

```sh
node scripts/verify-d2.js              # full run
node scripts/verify-d2.js --only=secret-scan-workspace   # scoped
node scripts/verify-d2.js --d1-repro   # additionally runs
                                      # ./d1-spikes/scripts/verify-d1 --repro
```

Checks (id → meaning):

- `fixtures-integrity` — MANIFEST.sha256 hash parity + every schema probe
  validates/rejects as declared (a weakened schema flips "invalid" probes
  to valid and FAILS here)
- `schema-validator-selftest`, `secret-scanner-selftest` — the gate's own
  instruments prove themselves on synthetic corpora
- `typecheck` — `node scripts/typecheck.js` over all workspaces
- `tests-typecheck` — `tsc -p tests/tsconfig.json`
- `unit-tests-{contracts,runtime-pi,persistence,tool-policy,event-journal}`
  — `npm test -w <pkg>`; missing src or unwired test script → NOT_RUN,
  failing → FAIL
- `unit-tests-agent-f`, `integration-tests-agent-f`,
  `live-framework-selftest` — this tree's suites (`node --test`)
- `runtime-smoke` — NOT_RUN until the Integrator wires apps/runtime-smoke
- `pi-version-pin` — `@earendil-works/pi-coding-agent` must be exactly
  `0.85.1` (declared AND installed)
- `secret-scan-workspace` — scans tests/, schemas/d2/, .github/workflows/,
  evidence/d2/ and scripts/verify-d2*.js; any finding FAILs the gate
- `residual-resources` — no `treeai-*` temp leftovers after the suites
- `d1-repro` — NOT_RUN unless `--d1-repro` (offline PRs never force live
  model calls)
- `exit-codes`, `evidence-write-hygiene`, `schema-validation` — the run's
  own artifacts obey the discipline above, validate against schemas/d2,
  and no secret-shaped content entered the evidence (pre-write leaks are
  masked + recorded and FAIL the run; the post-write rescan of the whole
  run dir overrides the verdict to exit 2 on any new finding)

## The live suite

```sh
# missing credentials → every scenario BLOCKED, exit 3 (never a fake pass,
# and the user's real ~/.pi config is NEVER read as a shortcut):
node scripts/verify-d2-live.js

# controlled credential entry (names only are ever logged; values live in
# memory and are handed to the runtime factory, never persisted):
TREEAI_LIVE_PROVIDER_ID=... TREEAI_LIVE_MODEL_ID=... \
TREEAI_LIVE_API_KEY=... node scripts/verify-d2-live.js

# offline dry-run of the same six scenarios against FakePiRuntime:
node scripts/verify-d2-live.js --driver=fake
```

Scenarios (frozen): `basic`, `tool-policy`, `steer`, `abort`, `resume`,
`tree-navigation`. Each produces a record conforming to
`$defs/scenarioResult` in schemas/d2/result.schema.json. Session
transcripts are written INSIDE the run's evidence dir so the post-write
secret rescan covers them too. In CI this runs only via
`.github/workflows/d2-live.yml` (workflow_dispatch + protected `d2-live`
environment; secrets appear only in the verify step's env mapping).

## The failure-path selftest

```sh
node scripts/verify-d2-selftest.js
```

Builds synthetic trees in temp dirs (never touches the real tree), injects
defects, runs the REAL verifier against them, and requires each injection
to fail the gate (child exit 2):

1. a secret-shaped file in tests/ → `secret-scan-workspace` FAIL
2. the event schema replaced by an accept-anything document →
   `fixtures-integrity` FAIL ("a schema constraint was lost")
3. the exit-code constraints stripped from the result schema → the
   PASS-with-exit-1 probe validates → `fixtures-integrity` FAIL
4. control: a clean tree → exit 0 (the gate is not vacuous)

## Evidence

Every run appends `evidence/d2/runs/<UTC-run-id>/` containing
`environment.json`, `result.json`, `events.jsonl`, `checks.json`, `logs/`
(+ `sessions/` for live runs). Run dirs are never overwritten (collision →
`-2` suffix). Every write is redacted (home paths → `[HOME]`) and
secret-scanned BEFORE touching the disk; masked pre-write leaks are
recorded and FAIL the run; the whole dir is rescanned afterwards and any
new finding overrides the verdict to exit 2. Runs that must fail the scan
for historical reasons are moved to `evidence/d2-quarantine/` (outside the
scan root) with a README explaining why — nothing is deleted or edited.

## Fixtures and MANIFEST.sha256

`tests/fixtures/MANIFEST.sha256` pins the hash of every fixture file (33
lines at the time of writing). The gate recomputes and compares; any
tamper, stray file or rename FAILs `fixtures-integrity`. After
INTENTIONALLY changing a fixture, regenerate from `tests/fixtures`:

```sh
find . -type f ! -name MANIFEST.sha256 | sort | shasum > MANIFEST.sha256
```

and commit the manifest together with the fixture change.

The schema-probe corpus (`tests/fixtures/schema-probes/`, expectations in
`manifest.json`) is the paired negative/positive test set for the three
schemas: every `valid` probe must validate, every `invalid` probe must be
REJECTED — a schema that loses a constraint fails the gate.

## CI

- `d2-offline.yml` — push/PR, Node 24.21.0 pinned, `npm ci`, the offline
  gate + the failure-path selftest, evidence uploaded as an artifact.
  Contains no secrets.
- `d2-live.yml` — `workflow_dispatch` only, `environment: d2-live`
  (protected; admins maintain `LIVE_PROVIDER_ID`, `LIVE_MODEL_ID`,
  `LIVE_API_KEY`), optional `--driver` input and optional D1 repro step.
  Secrets appear only in the live step's env mapping and are never echoed.

## Known interface deviations (see coordination/d2/agent-f-handoff.md)

- `@treeai/runtime-pi` currently has no resolvable entry point (no
  `main`/`exports`/`types`), so `loadPiDriver()` reports NOT_RUN rather
  than pretending; the factory discovery list is
  `createPiRuntime | createPiRuntimeForVerification | createRuntime`.
- Root `package.json` script wiring (`verify:d2`, `verify:d2:live`) is the
  Integrator's job; run the scripts directly with node until then.
