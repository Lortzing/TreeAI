# Tests and acceptance

Use pinned Node `24.21.0` and npm `11.19.0`.

## Development checks

```sh
npm ci
npm run typecheck
npm test
```

Studio uses `node --test tests/*.test.ts` under `apps/studio`; root has separate `tests/unit/*.test.ts`, `tests/integration/*.test.ts` and `tests/live/*.test.ts` globs. The refactor diagnostics workflow explicitly runs `node --test apps/studio/tests/shared-utils.test.mjs` to gate extracted browser source/view helpers. Nested tests are **not** automatically included. Changes to test locations must expand discovery or retain aggregators and compare scenario IDs.

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
