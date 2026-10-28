# API settings and current UI acceptance — 2026-10-26

Development base: `8a947d4a74027379392ea42fc89b25e19f904b09`.
Branch: `codex/latest-real-pi`. The implementation record below initially binds
to a working candidate; committed-SHA revalidation and remote CI are recorded
in the final evidence record when available. No historical successful commit is
claimed to validate a later implementation.

## Final code and verification — 2026-10-27

Production code: `39a62bd00956324d47ba37f8967c431c5c1ebfa9`.
Test-only successor: `00237b592d3055263d338ad81d0d979247554b67` preserves both
historical topbar scenario names from main and the development line, executing
the same complete current assertions under both identities. No product code
changed after 39a62bd. [PR #28](https://github.com/Lortzing/TreeAI/pull/28).

- Full source and root-test typechecks passed; **884 tests passed**, no failures,
  cancellations or skips at the test-only successor.
- Final production code: real Pi API **25/25**, native real Pi D3 **31/31**,
  complete native real Pi D4 **16/16**; each has zero FAIL/BLOCKED/NOT_RUN.
- Final production code: macOS installation/upgrade engineering automation
  **55/55**. This zero-credential engineering test is separate from the real-Pi
  source runs and the owner's experience signoff.
- Static audits preserve all **862 baseline scenarios**, with **883 current
  static names**. Main and development-line baselines are both retained.
- [Linux browser CI](https://github.com/Lortzing/TreeAI/actions/runs/40440199130)
  and [D2 CI](https://github.com/Lortzing/TreeAI/actions/runs/40440199092) pass on
  final production code. The successor revalidates the static-name correction;
  its latest status is on the PR. [Final production-code installer run](https://github.com/Lortzing/TreeAI/actions/runs/40440262671)
  records the three target-platform results separately.

Linux failures are resolved: Escape now ignores a pending branching flow from
another material while preserving that material's draft and the visible-flow
first/reader-second ordering. PDF text geometry is applied before asynchronous
PDF.js paint; native drag anchors no longer move when a slower page finishes
painting. Regression tests cover both. Diagnostic failures and the first
baseline-name conflict are preserved, without threshold/fixture changes.

[Bound commands, logs, failures and exclusions](../../evidence/api-settings/20261027/README.md)
are the final record; the earlier working and morning snapshots below remain
historical and do not override it. Local real runs report a dirty tree because
acceptance docs/generated evidence and then a test-only alias were pending;
no uncommitted production changes are claimed as a clean-commit run.

## Result

Studio's **API 设置** dialog manages API provider/model profiles, endpoint format,
URL, model limits, environment references and advanced multi-profile/header
JSON. Its connection button sends a fixed real request through Pi in a temporary
session. Saves are atomic, reject stale concurrent edits, and apply on restart.
Explicit CLI configuration overrides saved preferences. An explicitly offline
instance can repair corrupt saved settings without exposing their raw contents.
No credentials are saved in browser storage or copied from account-login state.

The user selected the existing API at `http://127.0.0.1:15722`, configured as
`local-api/claude-haiku-4-5`. The user's proxy ignores client auth, so the local
client supplies a nonsecret placeholder. TreeAI does not attest the proxy's
upstream routing, actual model identity or billing. The earlier direct port
15721 request returned 502; the selected API path succeeded.

Actual browser testing exposed regressions in the latest development UI:
new exploration did not follow its new round, source reveal tried to focus a
main pane still hidden by an exiting branch, material-source reading was hidden
behind the branch, and the workspace controls covered persistent-failure
Dismiss. These are fixed. Branch display lookups now index the current branch
array while preserving mechanical ordinals and identity across state changes.

The old native probes also assumed a full-session list, fixed English branch
names, permanently expanded controls, and unchanged touch coordinates after a
capture bar collapsed. Probes now inspect all actual round pages while restoring
the original page/selection, use stable IDs and verify source identity, open
real disclosures before interacting, and recompute the real text hit point.
Native virtual-row clicks are checked for the intended select/toggle before
using the existing disclosed DOM-dispatch fallback. Frozen scenarios, metrics,
thresholds, fixture bytes and evaluator denominators remain unchanged. A renamed
upstream scenario retains its historical static ID with current UI assertions.

## Executed on the working candidate

- Full source typechecks: all seven workspaces passed. Root test types passed.
- `npm test`: 880 passed, zero failures/skips at the recorded working run.
- Real Pi API core runner: **25 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**.
- Native Chrome real Pi D3: **31 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**.
- Native Chrome D4 Echo: **16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**.
- Four real pinned-SDK protocol fixtures stream Anthropic Messages, OpenAI Chat
  Completions, OpenAI Responses and Gemini; configured model/header/streaming
  behavior is asserted. These are local fixture tests, not vendor certification.
- UI settings tests cover on-demand loading, edits across model switching,
  guarded test/save requests, JSON errors, stale writes and close/dispose aborts.
  HTTP tests cover same-origin/loopback enforcement, CSRF guards, concurrency,
  secret-free responses and corrupt-settings recovery.
- Static audit: **862 baseline static scenarios preserved / 879 current**, zero
  boundary violations. Static names and executed test counts are distinct.
- Asset audit: 56 ESM assets / 11 CSS modules; computed paths: 131 resolved
  resources / 20 test globs. The 12 existing dynamic expressions retain their
  separate runtime gates.
- macOS actual package build passed the pinned official Node checksum, layout
  and staging scan; packaged installer smoke **46 PASS / 0 FAIL**. This initial
  working package is not evidence for a later commit or owner-device signoff.
- Earlier working D2 and D4 offline checks returned 21+1 NOT_RUN and 19+1
  NOT_RUN respectively (exit 3 INCOMPLETE). No whole-project PASS is claimed.

Failed runs remain in `/private/tmp/treeai-api-*` and
`/private/tmp/treeai-settings-*`; native browser artifacts use the same run
suffixes. They include the first unsupported TS parameter property, a test
client that omitted Host, one extracted probe variable scope error, stale UI
probe failures, and the actual UI regressions above. Corrections preserved the
business assertions; no failed evidence was deleted. Bounded external Claude
Code tasks implemented the isolated UI controller/probe adaptation; their
results were independently reviewed, repaired and verified by the main agent.

## Remaining independent gates

### Morning status verified 2026-10-27 (Asia/Shanghai)

Draft [PR #28](https://github.com/Lortzing/TreeAI/pull/28) is open at
`a2ac87fb9709ea1dd25affa3dfa359475fed97e3`. Latest remote D2 and diagnostics
checks succeed. [Browser CI](https://github.com/Lortzing/TreeAI/actions/runs/40319475193)
fails in Linux Beta keyboard acceptance: Escape reaches the material reader and
is prevented, but the reader remains visible. This is an unresolved engineering
blocker, not a request for the owner to waive the assertion. Keep the PR draft.

The three-platform installer workflow at
`bc3fa941ad64bca799b82f9744d66e611c600b06` completed successfully for macOS arm64,
Linux x64 and Windows x64, including bundle smoke and artifact checksums
([run](https://github.com/Lortzing/TreeAI/actions/runs/40316141746)). It does not
validate later commits or substitute for physical-device acceptance.

Local committed-code validation at
`101564d77cddd37aa66f6b03e42f5132472057d3` completed real-Pi D3 **31/31**, real-Pi
D4 **16/16**, and macOS packaged smoke **46/46**. Original logs are retained at
`/private/tmp/treeai-101564d-{d3-real,d4-real,installer-smoke}.log`.
The later a2ac87f commit adds browser failure diagnostics only. Local offline D2
and D4 remain **21 PASS + 1 NOT_RUN** and **19 PASS + 1 NOT_RUN**, exit 3;
their independent failure-injection selftests succeeded. No whole-project PASS.

The morning check found the previous local service stopped; it was restarted
using `treeai-studio-data/start-real-pi.sh`, preserving the isolated data directory
and saved API selection. Entry: `http://127.0.0.1:8787`.

Actual vendor credentials were not supplied for OpenAI/Gemini certification;
only the chosen local endpoint was tested live. Frozen one-shot real quality
assessment, independent two-person annotation/arbitration, owner signoffs,
Windows/Ubuntu physical installations and participant trials remain separate.
D1 historical opt-in reproduction and B8 human gates are not inferred from CI.
Dependencies and lockfiles are unchanged; prior evidence is retained.

The local service is `http://127.0.0.1:8787`. Profiles and a local restart script
are ignored under `treeai-studio-data/`; the general example is
`examples/api-providers.example.json`. See [API configuration](../development/api-connections.md)
and [tomorrow's consolidated decisions](api-settings-morning-decisions.md).
