# Tests and acceptance

Use pinned Node `24.21.0` and npm `11.19.0`.

## Development checks

```sh
npm ci
npm run typecheck
npm test
```

Studio uses `node --test tests/*.test.ts` under `apps/studio`; root has separate `tests/unit/*.test.ts`, `tests/integration/*.test.ts` and `tests/live/*.test.ts` globs. The refactor diagnostics workflow explicitly runs `node --test apps/studio/tests/shared-utils.test.mjs` to gate extracted browser source/view helpers. Explicit `.mjs` aggregators, including computed-path fault regressions, are also in the root command. Nested tests are **not** automatically included. Changes to test locations must expand discovery or retain aggregators and compare scenario IDs.

## Offline acceptance and fault injection

```sh
npm run verify:d2
npm run verify:d2:selftest
npm run verify:d4
npm run verify:d4:selftest
```

Verifier status: exit `0` pass; `1` tool error; `2` fail; `3` blocked/not run. Some verifiers intentionally return `3` without optional authorization, which is **not** full acceptance.

## Candidate-only checks

Follow `docs/d3/D3-status.md`, `docs/d4/D4-status.md` and issue #7 for real Pi, browser, installer/OS, Mac and participant gates. Results must be attached to the complete tested commit SHA. Re-running one slice does not automatically validate all D3, W1 v3, terminology and D4 commitments.

## Structural refactor requirements

Before moving a file inventory all imports, dynamic paths, scripts, CLI flags, browser static MIME/routes, installer allowlists, verifier check IDs and fixtures. Keep old scenario/denominator mapping, failure injection and original failure records. No deletion of raw acceptance evidence until whole-project completion.

## Read-only refactor comparison

```sh
node scripts/audit-refactor-boundaries.mjs --base e427460b31f61722d5e74a6fa4ee24d140abe67b --out /tmp/treeai-boundaries.json
npm run audit:studio-assets
npm run audit:computed-paths
```

The first report compares physical entrypoint sizes, literal source reverse imports and counts of static `test`/`it` names against the selected commit. It fails for lost static scenarios, unresolved literal imports and production imports of tests/fixtures. It includes untracked source files and labels the report as a working-tree comparison. Dynamic scenario names, individual assertions, computed paths and behavioral parity still require the original suites and runner gates. The diagnostics CI job compares against the PR base SHA.

The eight UI suites share browser event/network types, record conversion, selector traversal and an SSE stub factory. Each suite constructs its own SSE class/registry; DOM/selection constructors, storage and common backend models are shared; suite-specific focus, geometry, insertion, seeds and route/error scripts remain suite-owned. New controller race regressions are imported by `shared-utils.test.mjs`, retaining root and CI discovery.
