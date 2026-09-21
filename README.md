# TreeAI

Trusted-local, tree-structured agent runtime built on the [Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

> **Status: D2 (engineering convergence) — Wave 1 delivered, Wave 2 offline closure done.**
> D2 turns the D1-validated Pi SDK capabilities into a maintainable, testable,
> recoverable first-version runtime. D2 is **not** production release approval.

- **Route** (ADR-001, Accepted 2026-09-20): TypeScript/Node.js + Pi SDK in-process embedding. Same-process risk is accepted **only** in trusted-local mode — this is not a sandbox or security boundary.
- **Pinned baselines**: Node `24.21.0` / npm `11.19.0` (engines), TypeScript `5.9.3`, Pi `@earendil-works/pi-coding-agent@0.85.1` (exact; `latest`/`*`/ranges/Git HEAD are forbidden). Deviations require an explicit upgrade record and regression.
- **Data boundary** (ADR-001 §4): the TreeAI-owned database is the fact source for Forest/Tree/Branch/Episode/Run; Pi sessions are only referenced (sessionFile/sessionId/entryId) for recovery and replay. TreeAI never writes Pi session JSONL and never copies credentials.

## Non-negotiable rules

1. **`d1-spikes/` is read-only** in D2. It is the D1 evidence area: no rewriting history, no deleting failed runs, no moving probe files into production directories. D1 regression stays executable via `./d1-spikes/scripts/verify-d1 --repro` as a version-upgrade gate.
2. **Pi type isolation**: only `packages/runtime-pi` may depend on / import `@earendil-works/pi-coding-agent`. `contracts`, `persistence`, `tool-policy` and `event-journal` must not import Pi types; TreeAI exposes its own session-reference, event, error and run-state types.
3. **Gate order is strict**: Gate 0 (scaffold & contract freeze) → Wave 1 (parallel module work) → Gate 1 (module acceptance) → Wave 2 (integration) → Gate 2 (automated acceptance) → Wave 3 (owner acceptance). No skipping; Gate 0 not passed means no parallel development.
4. Root `package.json` / `package-lock.json` / `tsconfig.base.json` are Integrator-only; new dependencies go through `coordination/d2/` requests.

## Workspace layout

```text
packages/contracts      frozen core contracts & domain types   (Agent A)
packages/runtime-pi     PiRuntime — Pi SDK lifecycle            (Agent B)
packages/persistence    TreeRepository, migrations             (Agent C)
packages/tool-policy    default-deny tool policy               (Agent D)
packages/event-journal  append-only journal & run-state         (Agent E)
apps/runtime-smoke      end-to-end integration app             (Integrator)
coordination/d2/        agent status files & dependency requests
evidence/d2/            append-only verification evidence
```

Dependency direction: `apps/runtime-smoke` → { runtime-pi, persistence, tool-policy, event-journal } → `contracts`. No lateral package dependencies; cooperate through `contracts`.

## Commands

| Command | Status (2026-09-21, Wave 2 offline closure) |
|---|---|
| `npm ci` | working — clean install from the lockfile |
| `npm run typecheck` | working — all six workspaces with TypeScript sources checked |
| `npm test` | working — five package suites + Agent F unit (75) / integration (8) / live selftest (3, offline fake driver) |
| `npm run test:integration` | working — `apps/runtime-smoke` (Wave 2 offline integration, 2/2) + Agent F integration (8/8) |
| `npm run verify:d2` | working — offline acceptance verifier: 20 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN (`d1-repro` needs explicit `--d1-repro` + network + d1-spikes write authorization) → exit 3 is the honest offline terminal state |
| `npm run verify:d2:selftest` | working — verifier failure-injection selftest, 4/4 |
| `npm run verify:d2:live` | wired — without credentials all six live scenarios are BLOCKED (exit 3); never a faked live PASS |

Exit-code convention (shared with the D2 verifier): `0` all PASS · `1` tool error · `2` at least one FAIL · `3` no FAIL but BLOCKED/NOT_RUN present.

What was actually verified, what was not, and what needs an owner decision:
see `docs/d2/D2-verification.md`, `docs/d2/D2-known-limitations.md` and
`docs/d2/D2-owner-checklist.md`.

## Coordination & evidence

- Agent status/handoff/dependency-request files: `coordination/d2/` (each file is written only by its owning agent; see `coordination/d2/README.md`).
- Integrator status: `coordination/d2/integrator-status.md` (Wave 1) ·
  `coordination/d2/integrator-wave2-status.md` (Wave 2 closure record).
- Verification evidence (append-only): `evidence/d2/`.

## License

MIT — see [LICENSE](LICENSE).
