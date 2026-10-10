# Architecture — integration candidate

TreeAI remains a **single** npm workspaces monorepo and one loopback Studio HTTP process with a native browser UI; no framework rewrite, gateway layer or microservices.

| Layer | Current adapter and ownership |
| --- | --- |
| Browser entry | `apps/studio/public/app.js`: thin module wrapper constructing one `createStudioApp` instance |
| Browser core | `public/core/create-studio-app.js`: still-large instance-owned state/handlers; `core/dom.js` holds element identity |
| Source/reading | `public/shared/source/{sha256,selection}.js`, `shared/reading-position/scroll.js` |
| Return view (pending extraction) | `public/core/create-studio-app.js` |
| Styles | `public/style.css` ordered `@import` manifest, `public/styles/*.css` domain/viewport sources |
| HTTP | `src/server.ts`: route ownership; `src/http/{requests,responses,errors,static}.ts` for adapters |
| Product | `src/service.ts` with extracted `studio/{event-summary,prompt-text}.ts`; `src/terminology.ts` with suggestion-density helper |
| Materials/search/nav | `src/materials/`, `src/search/`, `src/nav/` |
| Runtime | `packages/runtime-pi/`: sole Pi SDK port; session-inspection extracted |
| Persistence | `packages/persistence/`: one DB, shared transaction coordination and schema/migrations |
| Tool policy/journal/contracts | `packages/{tool-policy,event-journal,contracts}/` — preserve SDK-independent contracts |
| Verification | `tests/`, `scripts/d4/`, `scripts/run-d{3,4}-browser.mjs`, two dedicated refactor CI workflows |

**Fact authority:** The TreeAI database retains saved Tree, Branch, Turn, Return, annotations, material versions and reading position. Pi session references authorize continuation, not the authoritative copy of those facts. Return writes and adoption state remain independent from navigation success.

**Call direction:** Browser → loopback HTTP → product services → single DB/runtime ports. Services must not import HTTP. Test probes may import production code; production code must not import fixtures/eval runners. Exact public ESM/CSS allowlist is deliberately closed rather than disk-directory serving.

**Still TODO:** extract feature-specific controllers from the ~9k-line factory; HTTP route handlers, remaining terminology and repository responsibilities, large runners and duplicated test mocks. Preserve W1 v3 signature and D4 contract/frozen hashes. See [task map](../development/task-map.md), [acceptance matrix](../acceptance/status.md) and [product authority](../product/index.md).
