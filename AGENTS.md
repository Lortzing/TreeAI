# TreeAI contributor/agent entrypoint

TreeAI is one local TypeScript monorepo using the Pi SDK. Preserve the current product scope and signed W1 v3 semantics; refactoring is not authority to alter business decisions.

## First reads
- Read [docs/development/task-map.md](docs/development/task-map.md) for the smallest relevant set of files.
- Read [docs/architecture/overview.md](docs/architecture/overview.md) for dependency and fact-source boundaries.
- Read [docs/acceptance/status.md](docs/acceptance/status.md) for current gates, not historical PASS counts.
- Do **not** default-read `evidence/`, `d1-spikes/`, old `coordination/` or archived plans. Search them only when a specific assertion needs them.

## Invariants
- Node 24.21.0 / npm 11.19.0; do not silently update dependencies or lockfiles.
- Five core packages: contracts, runtime-pi, persistence, tool-policy, event-journal. Only runtime-pi imports Pi SDK types.
- TreeAI database is the durable source of product truth; Pi session availability is a separate dimension.
- Do not regress Return save-before-navigation, Tree-scoped idempotency, source identity, budget state machines, tool default-deny, retry/recovery, or material version identities.
- Never treat saved product information as erased merely because a Pi session is unavailable.
- A migration/entrypoint move must audit importers, test discovery globs, HTTP static allowlist, installer inclusion, verifier paths, fixtures, and evidence links.
- Preserve frozen fixtures and evaluator denominators. Never remove a failing assertion to make a refactor pass.
- Evidence deletion is gated on whole-project acceptance, including all manual and target-platform checks. Do not delete it in a routine cleanup.
- Never put API keys or raw personal material into commits, logs, PRs or evidence.

## Verification and handoff
- Focused checks first; run `npm run typecheck` and `npm test` before claiming shared-path parity.
- Offline D2/D4 verifier and selftest are separate; exit 3 / NOT_RUN / BLOCKED never means PASS.
- Real browser, Pi, target platform and human gates are separately recorded, not inferred from unit tests.
- Include complete tested commit SHA, changed behavior, tests actually executed, exclusions, and known blockers in each PR.
- Keep the root README a product/start guide, not a running log. Use linked historical records for investigations.
