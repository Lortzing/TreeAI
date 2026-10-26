# API settings and current UI acceptance — 2026-10-26

Development base: `8a947d4a74027379392ea42fc89b25e19f904b09`.
Branch: `codex/latest-real-pi`. The implementation record below initially binds
to a working candidate; committed-SHA revalidation and remote CI are recorded
in the final evidence record when available. No historical successful commit is
claimed to validate a later implementation.

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
