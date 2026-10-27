# API settings and final automatic engineering acceptance — 2026-10-27

Production code: `39a62bd00956324d47ba37f8967c431c5c1ebfa9`.
Test-only successor: `00237b592d3055263d338ad81d0d979247554b67`.
Development base: `8a947d4a74027379392ea42fc89b25e19f904b09`.
Main baseline: `e2e6d9b8c395a94ac496899a483a0808f872eccc`.
[PR #28](https://github.com/Lortzing/TreeAI/pull/28).

## Delivered behavior

The Studio API settings dialog and CLI accept API provider/model profiles for
Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini.
Settings store environment names, never key values, and do not import Pi/account
subscription login state. Connection testing makes an isolated actual Pi request;
profiles save atomically with stale-edit detection and apply on restart.

Native acceptance also repaired round-follow/source focus/reader stacking/error
Dismiss behavior. Linux reproduction identified a pending flow from another
material consuming Escape and PDF text geometry arriving after async canvas
paint. The fixes preserve the pending draft, visible-flow layering, canonical
source identity, frozen fixtures and native drag assertions. No dependency,
lockfile, threshold, frozen evaluator denominator or prior evidence was removed.

The test-only successor retains both historical names for the topbar scenario
(main and development had different frozen names), executing the same full
assertions twice. It changes no production code. Documentation/evidence successors
also do not imply a fresh real-model run on a later production implementation.

## Bound results and commands

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | all seven source workspaces pass | [types.log](types.log) |
| `node_modules/.bin/tsc -p tests/tsconfig.json --noEmit` | exit 0 | [test-types.log](test-types.log) |
| `npm test` at test-only successor | 884 PASS, 0 FAIL/cancel/skip | [tests.log](tests.log) |
| Main/development scenario and import audit | 862 baseline / 883 current static names, 0 violations against each baseline | [main](main-boundaries.json), [development](development-boundaries.json) |
| Studio assets/computed paths | 56 ESM + 11 CSS; 131 resources + 20 globs; 12 enumerated runtime gates | [assets](assets.log), [computed paths](computed-paths.log) |
| Real Pi API core | 25 PASS, no FAIL/BLOCKED/NOT_RUN | [real-pi-api.log](real-pi-api.log) |
| Native Chrome D3 real Pi | 31 PASS, no FAIL/BLOCKED/NOT_RUN | [log](real-pi-d3.log), [summary](real-pi-d3-summary.json) |
| Complete native Chrome D4 real Pi | 16 PASS, no FAIL/BLOCKED/NOT_RUN | [log](real-pi-d4.log), [summary](real-pi-d4-summary.json) |
| macOS package smoke | 46 PASS, 0 FAIL | [installer-smoke.log](installer-smoke.log) |
| macOS actual installation/upgrade engineering | 55 PASS, 0 FAIL | [bound record](../../d4/d4-7/d47-macos-20261027T024748Z/summary.md) |
| Offline D2 | 21 PASS + 1 NOT_RUN, exit 3 INCOMPLETE | [d2-offline.log](d2-offline.log) |
| Offline D4 | 19 PASS + 1 NOT_RUN, exit 3 INCOMPLETE | [d4-offline.log](d4-offline.log) |
| Separate failure-injection selftests | D2 5/5; D4 all 9 controls detected, exit 0 | [D2](d2-selftest.log), [D4](d4-selftest.log) |

Real-Pi commands at final production code (the two documented key environment
names were set to a nonsecret local-proxy placeholder, never a subscription key):

```sh
node scripts/run-d3-real-pi.mjs --mode real-pi --provider local-api --model claude-haiku-4-5 --agent-dir treeai-studio-data/api-live/api-agent --data /private/tmp/treeai-39a62bd-api-core --keep-data --pi-tools read --policy-read-roots /private/tmp/treeai-39a62bd-api-allowed
node scripts/run-d3-browser.mjs --mode real-pi --provider local-api --model claude-haiku-4-5 --agent-dir treeai-studio-data/api-live/api-agent --data /private/tmp/treeai-39a62bd-d3-real --keep-data --artifacts /private/tmp/treeai-39a62bd-d3-real-artifacts --pi-tools read --policy-read-roots /private/tmp/treeai-39a62bd-d3-real/allowed
node scripts/run-d4-browser.mjs --mode real-pi --provider local-api --model claude-haiku-4-5 --agent-dir treeai-studio-data/api-live/api-agent --data /private/tmp/treeai-39a62bd-d4-real --artifacts /private/tmp/treeai-39a62bd-d4-real-artifacts
node scripts/d4/installer/test-macos-local.mjs --keep --version-a 0.0.0-api-39a62bd-a --version-b 0.0.0-api-39a62bd-b
node scripts/d4/installer/smoke-bundle.mjs --archive <temp>/treeai-d47-local/treeai-studio-0.0.0-api-39a62bd-b-darwin-arm64.tar.gz --work-dir /private/tmp/treeai-39a62bd-smoke --data-dir /private/tmp/treeai-39a62bd-smoke-data --keep
```

These runs used Node 24.21.0 / npm 11.19.0 and pinned Pi 0.85.1 on macOS arm64.
Browser runs used headless Chrome 153.0.8010.37. Git dirty flags are retained:
acceptance docs/generated evidence were pending, followed by the test-only alias;
no uncommitted production implementation is represented as a clean commit run.
D2/D4 offline logs predate the final production fixes and bind to their original
working runs; final committed code is separately revalidated by remote CI.

The local macOS B archive SHA256 is
`28761a52e4a54930e426b37c665b5eca42ac7526b905fb25f3b2f349f35ce742`.
It is retained outside Git in `treeai-studio-data/installers/`. Windows/Linux
archives and checksums are available through the final installer workflow.

## Remote checks

- Production-code [browser](https://github.com/Lortzing/TreeAI/actions/runs/40440199130)
  and [D2](https://github.com/Lortzing/TreeAI/actions/runs/40440199092) pass.
- The historical-name conflict initially failed [diagnostics](https://github.com/Lortzing/TreeAI/actions/runs/40440199150).
  The test-only successor preserves both names; its checks are [D2](https://github.com/Lortzing/TreeAI/actions/runs/40441178395),
  [browser](https://github.com/Lortzing/TreeAI/actions/runs/40441178323), and
  [diagnostics](https://github.com/Lortzing/TreeAI/actions/runs/40441178566).
- [Three-platform packaging + smoke](https://github.com/Lortzing/TreeAI/actions/runs/40440262671)
  binds to the final production SHA. Each platform has its own conclusion;
  the live run is authoritative. Superseded be9263a packaging was canceled after
  the PDF fix; it is not counted as a successful final run.

## Failed runs and exclusions

[Retained diagnostic failures](retained-failures.log) include actual Linux Escape,
PDF drag and main/development static-name failures. Original full remote logs
remain in GitHub Actions, and local originals remain under `/private/tmp/treeai-*`.
The first final D3 attempt incorrectly allowed its own synthetic canary directory;
it failed honestly, then passed with isolated allowed/canary directories. The first
D4 launch lacked the runner's required env seam and did not start; the explicit
nonsecret placeholder run passed. A `--help` invocation of the macOS script (which
has no help parser) began its test and failed downloading in the sandbox; that
[failed record](../../d4/d4-7/d47-macos-20261027T024147Z/summary.md) is retained,
followed by authorized network-enabled 55/55 runs. Earlier working 880/881/882/883
results bind to their own revisions, not the 884-test successor.

Four protocol fixtures execute the real pinned SDK against local SSE servers;
they do not certify all external vendors. Only the user-selected loopback API
has live certification here. The alias does not attest the upstream actual
model, billing route or provider authentication. No real vendor keys were read.

Historical D1 opt-in reproduction, frozen one-shot model quality evaluation,
independent two-person annotation/arbitration, participant trials, owner macOS
experience signoff and Windows 11/Ubuntu physical installation plus real-Pi
material smoke remain independent gates. Package smoke, macOS engineering,
source real-Pi flows and human signoff do not substitute for one another.
No whole-project acceptance, evidence deletion, merge or release is claimed.

The local service is http://127.0.0.1:8787 with isolated demo data and saved API
selection. See [consolidated decisions](../../../docs/acceptance/api-settings-morning-decisions.md).
The user's background-browser preference applies to subsequent automation:
headless checks and hidden/background web tabs; no further foreground opener tests.

A bounded local Claude Code review returned success with no permission denials;
its routing hypothesis was independently tested and the hidden-flow root cause
confirmed by native CI call stacks. External review was supporting analysis,
not acceptance evidence. No session files, databases or credential files were
copied into this record. The accompanying scan reports only rule IDs/paths.
