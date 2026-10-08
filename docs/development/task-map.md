# Task-to-file map

Begin with the named entry and its direct imports, then broaden only when a change crosses a boundary. Paths are current as of baseline `e427460b31f61722d5e74a6fa4ee24d140abe67b`; keep this map in sync with later modularization.

| Work | First files | Expand when | Minimal check |
| --- | --- | --- | --- |
| Main conversation and branches | `apps/studio/public/app.js`, `apps/studio/src/service.ts` | Pi execution, API or storage changes | Studio service/UI tests |
| Return and idempotency | `apps/studio/src/service.ts`, `packages/persistence/src/tree-repository.ts` | Adoption/prompt semantics change | Replay, conflict, failure persistence |
| Terminology UI | `apps/studio/public/app.js`, `apps/studio/tests/ui-terminology.test.ts` | Promotion or provider budget | Terminology/UI cases and real browser |
| Terminology backend | `apps/studio/src/terminology.ts` | Shared transaction changes | Terminology tests and evaluator |
| Markdown/PDF reading | `apps/studio/src/materials/`, `apps/studio/tests/ui-pdf-reader.test.ts` | Source range/selection changes | PDF fixed fixtures and Chrome selection |
| Source offsets | `apps/studio/src/materials/range-resolver.ts` | Any new source type | UTF-16, duplicate text, emoji and combining tests |
| Search | `apps/studio/src/search/`, `apps/studio/tests/ui-search.test.ts` | Jump-to-source or persistence changes | Scope and stale version cases |
| Large-tree nav | `apps/studio/src/nav/`, `apps/studio/tests/ui-nav.test.ts` | Persisted expansion state | B9 scale and keyboard tests |
| HTTP/static routing | `apps/studio/src/server.ts` | New browser module, MIME or installer files | API/static and install smoke |
| Tool permissions | `packages/tool-policy/`, `packages/runtime-pi/` | Event projection or UI changes | Allow/deny and provenance tests |
| Portable data | `apps/studio/src/portability/` | Import version/migrations | Corrupt restore and atomicity tests |
| Installer | `scripts/d4/installer/`, `scripts/d4/package-installer.mjs` | Bundle manifest or entry paths | Target platform package smoke |
| Browser/real Pi evidence | `scripts/run-d3-browser.mjs`, `scripts/run-d3-real-pi.mjs` | Scenario/check ID change | Both verifier selftests |

Never assume a renamed or nested `*.test.ts` is discovered automatically; check actual npm test globs. A successful offline Echo test is not evidence of real Pi/Chrome/Mac verification.
