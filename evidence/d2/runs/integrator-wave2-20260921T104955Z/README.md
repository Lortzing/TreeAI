# Integrator Wave 2 Gate Evidence

- Run id: `integrator-wave2-20260921T104955Z` (UTC 2026-09-21)
- Owner: Integrator (Wave 2 integration + Gate 1/Gate 2 offline closure)
- Kind: Integrator-owned gate-command evidence. Agent F's verifier writes its
  own, schema-validated run directories (`d2-offline-*`, `d2-live-*`,
  `d2-selftest-*`) alongside this one; nothing here overwrites them.

## What this directory contains

| File | Content |
|---|---|
| `gate-commands.json` | Every Wave 2 gate command with its real exit code and meaning |
| `logs/typecheck.log` | `npm run typecheck` — exit 0 |
| `logs/test.log` | `npm test` (five packages + Agent F unit/integration/live-selftest) — exit 0 |
| `logs/test-integration.log` | `npm run test:integration` — exit 0 |
| `logs/runtime-smoke.log` | `npm test -w @treeai/runtime-smoke` — exit 0 |
| `logs/live-driver-import-probe.log` | live-framework `loadPiDriver()` discovery probe — exit 0, driver `pi` |
| `logs/verify-d2-selftest.log` | `npm run verify:d2:selftest` — exit 0 (4/4, failure injection caught) |
| `logs/verify-d2-live.log` | `npm run verify:d2:live` (no credentials) — exit 3, 6 scenarios BLOCKED |

Sanitization: absolute paths (repository root, user home directory, temp
directories) in the captured logs were replaced with the placeholders
`<repo>`, `<userhome>` and `<tmpdir>` before writing (secret-scanner
hygiene: no home paths, no credential-shaped strings).

## Honest terminal state (offline)

- Offline acceptance: every requested offline check PASS except `d1-repro`
  (NOT_RUN — requires the explicit `--d1-repro` flag, network access, and
  d1-spikes write authorization; Agent F's frozen semantics were not modified).
- Live: BLOCKED on credentials (controlled env vars `TREEAI_LIVE_PROVIDER_ID`,
  `TREEAI_LIVE_MODEL_ID`, `TREEAI_LIVE_API_KEY`) plus the recorded
  factory-shape mismatch between the live framework and the runtime-pi
  factory (see `docs/d2/D2-known-limitations.md`).
- Production release: NOT approved (Wave 2 decision authority stays with the
  owner; see `docs/d2/D2-owner-checklist.md`).
