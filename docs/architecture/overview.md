# Architecture — integration candidate

TreeAI remains a **single** npm workspaces monorepo and one loopback Studio HTTP process with a native browser UI; no framework rewrite, gateway layer or microservices.

| Layer | Current adapter and ownership |
| --- | --- |
| Browser entry | `apps/studio/public/app.js`: thin module wrapper constructing one `createStudioApp` instance |
| Browser core | `public/core/create-studio-app.js`: lifecycle, static listeners and boot; `core/state.js` owns initial instance state; `core/compose-features.js` and `core/composition/{materials,navigation}.js` assemble domain controllers/views; `core/dom.js` holds element identity |
| Source/reading | `public/shared/source/{sha256,selection}.js`, `shared/reading-position/scroll.js` |
| Return view | `public/core/views/return.js` and `views/material-branch.js`; `controllers/return.js` owns browser drafts/reconciliation/submission |
| Navigation | `public/core/controllers/nav-{finder,session,interaction,persistence,node-search,locate}.js` own requests, tree sessions, user actions and restoration; `core/views/nav-{tree,path,node-results}.js` own virtual rows, paths, results and focus restoration |
| Styles | `public/style.css` ordered `@import` manifest, `public/styles/*.css` domain/viewport sources |
| HTTP | `src/server.ts`: wiring, dispatch, error boundary and lifecycle; `src/http/routes/` for tree/search/nav/material/terminology routes; `src/http/{requests,responses,errors,static}.ts` for adapters |
| Product | `src/service.ts` with extracted `studio/{event-summary,prompt-text}.ts`; `src/terminology.ts` is a compatibility entry for executor/service, promotion/dispatch-ledger, models/policy, prompts/candidates, usage and suggestion projection/density modules |
| Materials/search/nav | `src/materials/`, `src/search/`, `src/nav/` |
| Runtime | `packages/runtime-pi/`: sole Pi SDK port; session-inspection extracted |
| Persistence | `packages/persistence/`: one DB, shared transaction coordination and schema/migrations |
| Tool policy/journal/contracts | `packages/{tool-policy,event-journal,contracts}/` — preserve SDK-independent contracts |
| Verification | `tests/`, `scripts/d4/`, `scripts/run-d{3,4}-browser.mjs`, native Chrome/CDP host in `scripts/d4/browser/chrome-host.mjs`, shared scripted browser protocol/SSE/selector stubs in `apps/studio/tests/support/browser-stubs.ts`, two dedicated refactor CI workflows |

**Fact authority:** The TreeAI database retains saved Tree, Branch, Turn, Return, annotations, material versions and reading position. Pi session references authorize continuation, not the authoritative copy of those facts. Return writes and adoption state remain independent from navigation success.

**Call direction:** Browser → loopback HTTP → product services → single DB/runtime ports. Services must not import HTTP. Test probes may import production code; production code must not import fixtures/eval runners. Exact public ESM/CSS allowlist is deliberately closed rather than disk-directory serving.

**Still TODO:** remaining Studio service and repository responsibilities, large runners and duplicated DOM/selection/backend/storage test mocks; final candidate browser/Pi/installation checks. Preserve W1 v3 signature and D4 contract/frozen hashes. See [task map](../development/task-map.md), [acceptance matrix](../acceptance/status.md) and [product authority](../product/index.md).
