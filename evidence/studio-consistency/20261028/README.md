# Studio consistency and macOS Keychain — 2026-10-28

Code commit: `550eda4c253f8662b7fe3079bd33688c9857cf04`.
Base: merged PR #28, `dfe938d5a3c2439cb78e4fb1ec8b7f2266e319be`.
Branch: `codex/studio-consistency-keychain-resume`.

## Behavior

Unified shared colors, typography, controls, spacing and responsive surfaces for
conversation, branches, materials and settings. Search now has a single sidebar
disclosure; primary navigation and runtime/empty-state labels use Chinese.
Model settings expose endpoint, API format and model ID directly, with limits,
environment names and multi-profile JSON in advanced settings.

macOS credentials use the system Keychain, scoped by resolved data-directory path
and declared environment name. Profile files contain references only. Environment
values win; startup and connection probes resolve credentials in memory, including
separate provider keys and literal custom header values. Native subprocess errors
are sanitized, writes use stdin rather than secret-bearing arguments, and a write
is read back before success. Presence checks use metadata. Browser input is cleared
on submission, provider switch, close and disposal. Other platforms explicitly use
environment variables without a plaintext fallback.

## Verification actually executed

- Node `24.21.0`, npm `11.19.0`; dependencies/lockfile unchanged. Offline npm ci
  found a missing cached SDK archive, so the existing same-machine dependency
  directory from the previous worktree was copied with relative workspace links.
- `npm run typecheck`: PASS ([log](typecheck.log)).
- `npm test`: **901/901 PASS**, zero fail/skipped ([log](tests.log)). The final
  source tree was committed unchanged after this run. Coverage includes the new
  credential adapter, guarded HTTP writes, UI lifecycle, real pinned-SDK local
  protocol fixtures, multi-provider in-memory credentials/headers, disclosure
  targeting and the original product suites.
- `node_modules/.bin/tsc -p tests/tsconfig.json --noEmit`: PASS ([log](test-types.log)).
- `npm run audit:studio-assets`: 56 ESM assets + 12 CSS modules PASS
  ([log](assets.log)); `audit:computed-paths`: 131 resources, 20 test globs PASS
  ([log](computed-paths.log)). Installer source/public inclusion remains recursive;
  the new credential module and style are covered by existing inclusion rules.
- Full native D3 selftest on the code commit: **25 PASS / 0 FAIL / 0 BLOCKED /
  6 NOT_RUN** ([log](d3-final.log), [summary](d3-final-summary.json)). Echo excludes
  real-provider response-loss and the five real-Pi tool-policy checks; these are
  not promoted to PASS. Evidence-only writes may make the report dirty flag true.
- Full native D4 selftest on the recovered working candidate: **16 PASS / 0 FAIL /
  0 BLOCKED / 0 NOT_RUN** ([log](d4-working-candidate.log),
  [summary](d4-working-candidate-summary.json)). It started before the final two
  empty-conversation text translations and documentation edits. All other source
  and test files match the code commit. Do not relabel its recorded base/dirty
  identity as a clean final-SHA run. Its B1/B2 selections, branching/Return,
  recovery/search/export, B6/B9, keyboard/touch/mobile and terminology checks pass.
- Final code commit D4 usability rerun: **5 PASS / 0 FAIL / 0 BLOCKED /
  0 NOT_RUN** (four boot checks + usability); [log](d4-final-beta.log),
  [summary](d4-final-beta-summary.json). This scoped run verifies the final Chinese
  empty states and desktop/mobile keyboard, touch, focus and recovery behavior.
  It does not replace the complete 16-check working-candidate run above.
- Background manual UI inspection on the committed source: desktop conversation
  and settings plus 390×844 settings; document and dialog horizontal overflow both
  false. [Main](main.png), [settings](settings.png), [mobile](settings-mobile.png).
  The preview uses temporary Echo data, not the user's actual conversations.

## Failures, exclusions and remaining gates

The initial sandbox run could not bind loopback HTTP ports; its original failure
is retained in [sandbox-port-failure.log](sandbox-port-failure.log). Authorized
local-port execution passed. The external Claude Code review returned
`subtype=success` but `is_error=true`, no permission denials, and DNS ENOTFOUND;
it is a failed delegation, not review evidence. The main agent performed review.

This turn did not rerun a vendor API, real Pi model, actual Keychain write,
installer package build/smoke, offline D2/D4 verifiers or their selftests, frozen
quality evaluation, target-device signoff, participant trials, remote CI or a
remote push. Earlier-thread live Keychain tests are historical, not new final-SHA
evidence. The owner explicitly deferred actual acceptance. No fixture,
denominator, dependency, lockfile, product fact or existing evidence was removed.
