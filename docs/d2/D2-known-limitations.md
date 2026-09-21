# D2 Known Limitations

- Date: 2026-09-21 (Wave 2 offline closure)
- Scope: facts discovered and decisions taken during D2 integration that a
  future maintainer must know. Nothing here is hidden behind a green check.

Legend: **[D1 fact]** inherited from the D1 spike phase; **[D2 addition]**
introduced/discovered in D2; **[offline-verified]** proven by the offline
suite; **[live/manual]** requires credentials or owner action;
**[production-gate]** blocks production release.

## Integration findings (host-side adaptation requirements)

These are interface frictions BETWEEN frozen Wave 1 modules. The Integrator
worked around each of them in `apps/runtime-smoke` (host layer) without
touching the packages; production hosts must apply the same adaptations —
or the owner can commission the underlying fix.

1. **[D2 addition] [offline-verified] `runtime.error` payload shape mismatch.**
   `runtime-pi` emits `runtime.error` with `{code, message}` at the payload
   top level; `event-journal`'s projector expects the recorder's
   `{error: {code, message}}` shape. Forwarding the raw payload through
   `recordPiRuntimeEvent` produces an invalid-payload projection anomaly.
   Host workaround (see the app's `EventForwarder.flush`): adapt the shape and
   record via `recordCustom` with `pi-runtime` evidence links.

2. **[D2 addition] [offline-verified] `restoreSession` precheck failures emit
   no `runtime.error`.** The missing-file precheck throws `session-corrupt`
   directly; only prompt-path failures are reported as events. A host that
   wants the failure in the journal must call `recorder.recordError` itself
   (the app does this in the degradation step).

3. **[D2 addition] [offline-verified] Journal-global eventId uniqueness ×
   per-instance runtime seq.** `event-journal` enforces eventId uniqueness
   across the whole journal file, while a `runtime-pi` instance numbers its
   events `pi-runtime-<seq>` from 1 for its own lifetime. A second process
   generation reusing the same journal file collides (`duplicate-event-id`,
   empirically demonstrated and rejected in the scenario's journal-discipline
   step). Integration decision: one journal file per process generation
   (`journal-gen-1.jsonl` / `journal-gen-2.jsonl`). If a single long-lived
   journal across restarts is wanted, eventIds need namespacing in
   `runtime-pi` (owner decision).

## Live-path blockers (owner decisions required)

4. **[D2 addition] [live/manual] Live framework ↔ runtime-pi factory shape
   mismatch.** `tests/live/framework.ts` calls the discovered factory as
   `factory({piVersion, model, sessionDir, apiKey})`, but `runtime-pi`'s
   public factory is `createPiRuntime(config: PiRuntimeConfig)` with
   `{port, agentDir, defaultCwd, thinkingLevel, tools, abortConvergenceMs}`.
   With credentials present, a real live run would still fail on this
   structural divergence. Both files are outside the Integrator's write
   scope (Agent F's framework; Agent B's frozen factory). The owner must
   commission a fix on one side. Discovery itself now works: the package
   entry added in Wave 2 makes `@treeai/runtime-pi` importable and the
   factory discoverable (`driver: pi`).

5. **[live/manual] Live scenarios BLOCKED on credentials.** All six live
   scenarios (basic, tool-policy, steer, abort, resume, tree-navigation)
   require `TREEAI_LIVE_PROVIDER_ID`, `TREEAI_LIVE_MODEL_ID` and
   `TREEAI_LIVE_API_KEY` (controlled env vars; never logged or persisted).
   Without them the live verifier honestly reports BLOCKED (exit 3).

6. **[live/manual] `d1-repro` NOT_RUN.** Requires the explicit `--d1-repro`
   flag, network access, and write authorization for `d1-spikes/`. None of
   these were granted; the offline verifier therefore ends at exit 3 with
   exactly this one NOT_RUN item (frozen Agent F semantics).

## Packaging / consumption limitations

7. **[D2 addition] `tool-policy` has no package entry point.** The package
   (Agent D scope) declares no `main`/`exports`, and its internal imports
   use `.js` specifiers that Node type-stripping does not rewrite, so it
   cannot be loaded from TypeScript sources directly. `apps/runtime-smoke`
   consumes it via the app's `#subpath-imports` alias resolving to an
   app-local compiled copy (`dist/tool-policy`), with a matching tsconfig
   `paths` mapping for typecheck. Production consumers need a proper package
   entry from the package owner.

8. **[D2 addition] `packages/runtime-pi/package.json` entry was added by the
   Integrator** (`main`/`exports`/`types` → `src/index.ts`, Node 24
   type-stripping) as the explicit integration action requested by Agent F.
   It exposes only the existing public factory; no business logic changed.

## App-scaffolding caveats (runtime-smoke)

9. **The fake Pi port is app-local test scaffolding.**
   `apps/runtime-smoke/src/fake-pi-port.ts` mirrors Pi 0.85.1 semantics
   (append-only entry tree, lazy JSONL persist, user-target-forks-to-parent
   navigation, abort convergence) but is NOT the real SDK: answers are
   deterministic echoes of the user texts visible on the current branch. It
   proves host-layer integration and cross-module contracts, not real model
   behavior. It must never be copied into `packages/`.

10. **[D2 addition] [offline-verified] Event-loop starvation with unref'd
    in-flight pacing.** During integration a spawned child intermittently
    died with Node's "unsettled top-level await" exit 13: the fake's hang
    loop used unref'd timers, so a run awaiting only that run's convergence
    could drain the loop. Lesson (now encoded in the fake): in-flight run
    pacing must be ref-counted, and an abandoned run must be explicitly
    reaped (dispose) at simulated process death. Production hosts embedding
    runtimes should assume the same discipline.

## Environment pins

11. **Version pins are load-bearing.** Node 24.21.0 (type stripping of `.ts`
    imports, `node:sqlite`), npm 11.19.0, TypeScript 5.9.3, Pi SDK 0.85.1
    exact. Any bump requires re-running the full gate set
    (`npm run typecheck`, `npm test`, `npm run test:integration`,
    `npm run verify:d2`) plus the persistence regression called out in
    dependency decision `agent-c-1`.

12. **[D1 fact] Pi SDK is consumed only through the public package root.**
    No private subpath imports, no source patches, no `latest`. Pi
    modification governance follows `docs/adr/ADR-002-pi-modification-governance.md`
    and the D1 decision record (ADR-001 SDK route accepted, 2026-09-20).
