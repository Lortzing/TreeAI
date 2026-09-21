# D2 Owner Checklist

- Date: 2026-09-21 (post Wave 2 offline closure)
- Audience: repository owner. These are decisions and actions the Integrator
  was NOT authorized to take. Nothing below has been decided by the
  Integrator; every item is open.

## Status at a glance

| Area | State |
|---|---|
| D1 facts (SDK route, Pi 0.85.1 pin, navigation evidence) | closed in D1 (ADR-001 accepted 2026-09-20) |
| D2 offline verification | closed honestly: all offline checks PASS; `d1-repro` NOT_RUN by design |
| D2 live verification | BLOCKED (credentials + factory-shape mismatch) |
| Production release | **NOT approved** (see §4) |

## 1. Owner decisions needed (blocking live verification)

- [ ] **Provide live credentials** via the controlled env vars
      `TREEAI_LIVE_PROVIDER_ID`, `TREEAI_LIVE_MODEL_ID`,
      `TREEAI_LIVE_API_KEY`, then run `npm run verify:d2:live`. The verifier
      never logs or persists them; without them all six scenarios stay
      BLOCKED (exit 3).
- [ ] **Resolve the live factory-shape mismatch** (known limitation #4):
      `tests/live/framework.ts` calls the factory as
      `factory({piVersion, model, sessionDir, apiKey})` while
      `runtime-pi`'s `createPiRuntime` expects
      `{port, agentDir, defaultCwd, ...}`. Commission a change on exactly one
      side (Agent F's framework or Agent B's factory). Until then, even with
      credentials the real-driver live run cannot succeed.
- [ ] **Authorize `d1-repro`** if wanted: run
      `node scripts/verify-d2.js --d1-repro` with network access and
      d1-spikes write authorization. This is the only item keeping the
      offline verifier at exit 3 instead of exit 0.

## 2. Owner decisions needed (cross-module interface normalization)

Each of these is currently worked around in the host layer
(`apps/runtime-smoke`). Decide whether to commission the underlying fix:

- [ ] **`runtime.error` payload normalization** (limitation #1): align
      `runtime-pi`'s emitted payload with the `event-journal` projector's
      expected `{error: {code, message}}` shape, or teach the recorder to
      accept both.
- [ ] **`restoreSession` precheck failure visibility** (limitation #2):
      decide whether missing-file precheck rejections should emit
      `runtime.error` like prompt-path failures do.
- [ ] **Journal eventId namespacing across process generations**
      (limitation #3): currently one journal file per process generation; a
      single restart-spanning journal requires namespaced eventIds in
      `runtime-pi`.
- [ ] **`tool-policy` package entry** (limitation #7): commission
      `main`/`exports` from the package owner so production consumers do not
      need the app-local `#subpath-imports` compile workaround.

## 3. Manual acceptance the owner may want to perform personally

- [ ] Run the gate set and compare exit codes:
      `npm run typecheck` (0), `npm test` (0),
      `npm run test:integration` (0), `npm run verify:d2` (3 — only
      `d1-repro` NOT_RUN), `npm run verify:d2:selftest` (0),
      `npm run verify:d2:live` (3 — BLOCKED without credentials).
- [ ] Inspect evidence (append-only):
      `evidence/d2/runs/d2-offline-20260921T104713263Z/` (verifier),
      `evidence/d2/runs/integrator-wave2-20260921T104955Z/` (Integrator
      gate-command logs), `evidence/d2/selftest/` (failure injection).
- [ ] Review `docs/d2/D2-verification.md` (what was actually verified) and
      `docs/d2/D2-known-limitations.md` (what was not, and why).
- [ ] Optionally decide whether to normalize the four Wave 1 agent status
      files that contain absolute home paths (outside the Integrator's write
      scope; not scanned by the official gate).

## 4. Production release: NOT approved — outstanding requirements

D2 delivered offline-verified components only. Before any production use,
at minimum:

- [ ] Real-model live evidence for all six scenarios (requires §1 items).
- [ ] The cross-module normalizations in §2 (or documented acceptance of the
      host-layer workarounds as the permanent integration contract).
- [ ] Real-SDK soak/reliability testing beyond the deterministic offline
      suite (the fake port proves integration semantics, not model behavior,
      timing, or failure modes of the real SDK).
- [ ] A threat/ops review of the host embedding pattern (journal-per-generation,
  session-file lifecycle, backup/restore procedures from the persistence
  package) under the intended deployment shape.
- [ ] Version-bump policy confirmation: every Node/npm/TS/Pi bump re-runs the
  full gate set plus the `node:sqlite` regression from `agent-c-1`.

## 5. Reference: who owns what after Wave 2

- `packages/contracts|runtime-pi|persistence|tool-policy|event-journal` —
  Wave 1 module owners (frozen; changes via owner-commissioned work).
- `scripts/verify-d2*.js`, `tests/**`, `schemas/d2/**` — Agent F (frozen).
- `apps/runtime-smoke/**` — Integrator (Wave 2 deliverable; the offline
  integration reference implementation).
- `docs/d2/**`, `evidence/d2/**`, root `package.json` scripts — Integrator
  (this closure); future edits append, never overwrite history.
- `d1-spikes/**` — read-only D1 record; writing requires explicit owner
  authorization (e.g. for `--d1-repro`).
