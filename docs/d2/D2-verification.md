# D2 Verification Record (Wave 2 Offline Closure)

- Date: 2026-09-21 (UTC)
- Executor: Integrator (Wave 2 integration + Gate 1/Gate 2 offline closure)
- Status: **offline acceptance closed honestly** — every requested offline check
  PASS except `d1-repro` (NOT_RUN by frozen design until the owner opts in).
  Live verification remains BLOCKED on credentials. Production release is
  NOT approved.

This record separates what was actually executed and observed from what was
not. No live PASS is claimed anywhere; no `--d1-repro` pass is claimed.

## 1. Gate command matrix (real runs, real exit codes)

All commands were run from the repository root on the post-Wave-2 tree
(Node 24.21.0, npm 11.19.0, TypeScript 5.9.3, Pi SDK 0.85.1 exact pin).
Sanitized logs: `evidence/d2/runs/integrator-wave2-20260921T104955Z/`.

| Command | Exit | Meaning |
|---|---|---|
| `npm run typecheck` | 0 | all six workspaces with TS sources typecheck clean (contracts, runtime-pi, persistence, tool-policy, event-journal, runtime-smoke) |
| `npm test` | 0 | five package suites + Agent F `tests/unit` (75) + `tests/integration` (8) + `tests/live` offline selftest (3) |
| `npm run test:integration` | 0 | runtime-smoke suite (2/2) + Agent F integration (8/8) |
| `npm test -w @treeai/runtime-smoke` | 0 | the Wave 2 offline integration app (see §3) |
| live-framework import probe (`loadPiDriver()`) | 0 | `@treeai/runtime-pi` resolves via its package entry; factory `createPiRuntime` discovered (`driver: pi`); no model call, no `~/.pi` access |
| `npm run verify:d2` | 3 | Agent F offline verifier: **20 PASS, 0 FAIL, 0 BLOCKED, 1 NOT_RUN** (`d1-repro`) — see §4 |
| `npm run verify:d2:selftest` | 0 | verifier failure-injection selftest 4/4 (control exit 0; injected secret / bad schema / illegal exit codes each caught as exit 2) |
| `npm run verify:d2:live` (no credentials) | 3 | 3 PASS (result schema, exit-code discipline, evidence hygiene) + **6 scenarios BLOCKED** on missing `TREEAI_LIVE_PROVIDER_ID` / `TREEAI_LIVE_MODEL_ID` / `TREEAI_LIVE_API_KEY` |

## 2. Per-package unit results (re-verified in this run)

| Workspace | Result | Notes |
|---|---|---|
| `packages/contracts` | PASS | test = typecheck + negative-type-tests + no-pi-imports script gates |
| `packages/runtime-pi` | 51/51 PASS | includes offline real-port tests; Pi 0.85.1 declared + installed |
| `packages/persistence` | 45/45 PASS | `node:sqlite` (Node built-in; dependency decision `agent-c-1` approved, zero npm deps) |
| `packages/tool-policy` | 58/58 PASS | |
| `packages/event-journal` | 73/73 PASS | compiled `dist` test entry (`build:test`) |
| `tests/unit` (Agent F) | 75/75 PASS | |
| `tests/integration` (Agent F) | 8/8 PASS | offline, fake runtime |
| `tests/live` (Agent F) | 3/3 PASS | live-framework selftest via `--driver=fake`; no credentials involved |
| `apps/runtime-smoke` | 2/2 PASS | Integrator-owned Wave 2 app (below) |

## 3. What `apps/runtime-smoke` actually verifies (offline, §6.1 eleven-step flow)

The app drives the REAL Wave 1 implementations (contracts + runtime-pi +
persistence + event-journal + tool-policy) through
`createPiRuntimeFromConfig` with an app-local deterministic fake Pi SDK port
(`src/fake-pi-port.ts`; no production code, never copied into `packages/`,
no network, no models, no `~/.pi` access). The scenario executes and asserts:

1. Forest / Tree / main branch / second branch created in the persistence
   layer; Episode/Run/SessionReference rows written.
2. Two prompt rounds on the main branch with deterministic echo answers
   (`echo:[turn-1@main]`, then `echo:[turn-1@main|turn-2@main]`).
3. Fork via `navigateTree` to the turn-1 user entry: same sessionId, same
   session file, append-only entry tree, no new session created, target lands
   on the user entry's parent (fork point).
4. Branch context isolation: the fork's first prompt answers
   `echo:[turn-1@second]` (only the fork's own user texts are visible).
5. Host-crash simulation: an in-flight "hang" run is abandoned; generation-1
   journal and DB are closed without settle or dispose.
6. Restart (generation 2): `recoverInterruptedRuns("host-crash")` recovers
   exactly the crashed run as `failed`; projection state, DB state and
   terminal timestamps agree.
7. Restart recovery of BOTH branches: main restores full context
   (`echo:[turn-1@main|turn-2@main|turn-3@main]`); the second branch restores
   its isolated context (`echo:[turn-1@second|turn-2@second]`); restore emits
   `session.replaced` then `session.restored` in that order.
8. Post-restart branch switch via `navigateTree` (same-session invariants).
9. Abort convergence: `runtime.abort()` settles the in-flight prompt with a
   `user-abort` rejection; run reaches terminal `aborted`.
10. Session-missing degradation: deleting a session file marks references
    unavailable (`missing-file`); `restoreSession` rejects `session-corrupt`;
    the host records the failure in the journal.
11. ToolPolicy matrix (8 probes): read inside workspace allowed; read/write
    outside denied; write inside without grant requires approval; grant
    consumed once; shell and network denied. Journal discipline: strict
    per-run 1..N seq, duplicate-seq and duplicate-event-id appends rejected
    leaving the file unchanged; redaction: a planted bearer-shaped token is
    masked before disk and absent from every persisted line.

Final cross-consistency: for all 8 runs (5 succeeded / 2 failed / 1 aborted),
`projectRunEvents` (journal) === DB state === expected, anomalies `[]`,
contiguous seq, `terminalAt` set for non-successful runs; every journal runId
exists in the DB; the shared session file persists append-only.

The second test spawns the scenario as a real child process under an isolated
`HOME` and asserts exit 0, marker output, no `.pi` directory created in the
sandbox HOME, and no credential-shaped strings on stdout.

## 4. `verify:d2` terminal state (why exit 3 is the honest offline state)

Agent F's frozen semantics: exit 0 requires every REQUESTED check to pass;
`d1-repro` is only requested with the explicit `--d1-repro` flag (offline PRs
never force live model calls). Without the flag it is recorded NOT_RUN with
its reason, which yields verdict `INCOMPLETE` (exit 3). After Wave 2 wiring
the only non-PASS item is exactly that one:

```
20 PASS, 0 FAIL, 0 BLOCKED, 1 NOT_RUN
  [NOT_RUN] d1-repro — explicit --d1-repro flag required ...;
            execution also needs network + d1-spikes write authorization
```

The Integrator did not modify Agent F's verifier semantics, did not add the
flag behind the owner's back, and does not treat exit 3 as a failure: it is
the verifier's designed honest state for an offline run. Verifier-owned
evidence (final run on the completed tree):
`evidence/d2/runs/d2-offline-20260921T105411091Z/` (first post-wiring run:
`d2-offline-20260921T104713263Z/`).

## 5. Gate 1 checklist (Integrator audit, 2026-09-21)

| Check | Result |
|---|---|
| per-package test + typecheck | PASS (§2; `npm run typecheck` exit 0 across all six workspaces) |
| no private Pi imports | PASS — the only Pi import in production code is the public package root (`import * as Pi from "@earendil-works/pi-coding-agent"`) in `packages/runtime-pi/src/pi-real-port.ts` (the sanctioned seam); no `#imports`/subpath/dist reachthrough anywhere in `packages/*/src` |
| no `latest` / ranges / source patches | PASS — Pi pinned exactly `0.85.1` (declared, installed, lockfile); no patch files; no patched `node_modules` content |
| no session JSONL writes in production packages | PASS — no `.jsonl`/`writeFileSync`/`appendFile` in any `packages/*/src`; the only session-file writer is the app-local offline fake |
| dependency requests have conclusions | PASS — single request `agent-c-1` (`node:sqlite`, zero npm deps) approved with re-run record in `coordination/d2/agent-c-dependency-request.md` |
| handoff files complete | PASS — `agent-{a..f}-handoff.md` all present with deliverables/status/boundaries |
| secret scan | PASS for all verifier-scanned zones (F's `secret-scan-workspace`: tests/, schemas/d2/, .github/workflows, evidence/d2/, scripts/verify-d2*) and for the Integrator's own zones after sanitization (apps/runtime-smoke, docs/d2, coordination/d2/integrator-*) |

Pre-existing note (outside Integrator write scope): F's scanner also flags
absolute home paths in four Wave 1 agent status files
(`agent-{a,b,d,e}-status.md`). Those files are not scanned by the official
gate (coordination/ is outside its roots) and are not mine to edit; recorded
here so the owner can decide whether to normalize them.

## 6. What is NOT claimed

- No live (real-model) scenario pass — all six live scenarios are BLOCKED on
  credentials, and the live-framework/runtime-pi factory shape mismatch
  (see `D2-known-limitations.md`) additionally blocks real-driver execution
  until the owner commissions a fix on one side.
- No `--d1-repro` pass — requires the explicit flag, network access, and
  d1-spikes write authorization (owner action).
- No production-release approval — D2 delivers offline-verified components
  only; see `D2-owner-checklist.md`.
