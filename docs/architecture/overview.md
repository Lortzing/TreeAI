# Architecture and dependency boundaries

TreeAI is a single npm-workspaces monorepo with one Studio loopback HTTP service and a native browser UI. This file describes the **current** layout; proposed splits in the refactor plan are not yet implemented.

| Location | Responsibility |
| --- | --- |
| `apps/studio/public/` | Browser entry `app.js`, `index.html`, `style.css` |
| `apps/studio/src/server.ts` | HTTP routes, JSON, SSE and statically allowed assets |
| `apps/studio/src/service.ts` | Tree/Branch/Return and run orchestration |
| `apps/studio/src/terminology.ts` | Terminology execution and promotion orchestration |
| `apps/studio/src/materials/` | Material imports, parsing, reading and branching |
| `apps/studio/src/search/` | Search over saved facts |
| `apps/studio/src/nav/` | Hierarchical navigation |
| `apps/studio/src/portability/` | Export and restore |
| `packages/contracts/` | Stable domain contracts, Pi SDK-independent |
| `packages/persistence/` | Shared DB connection, migrations and transactional repositories |
| `packages/runtime-pi/` | Pi SDK adapter and session execution |
| `packages/tool-policy/` | Tool authorization before execution |
| `packages/event-journal/` | Event journal and run-state replay |
| `scripts/`, `tests/` | Verification, probes, fixtures and installers |

**Fact source:** TreeAI persists product facts. Pi session references permit runtime resumption; missing or damaged Pi sessions must not erase a source excerpt, Return, material version or saved answer.

**Dependency discipline:** HTTP calls services; services do not depend on HTTP. The persistence API coordinates multi-entity transactions. Contracts cannot import Pi types. Domain UI may depend on a future shared/core layer but not another feature's private views.

**Refactor sequence:** baseline and test-discovery map first, then frontend state factory plus ESM static asset handling, then domain services, persistence/runtime, runners and documentation. Compatibility facades forward to one implementation. Do not publish an incomplete module migration as equivalent.

Related: [task map](../development/task-map.md), [tests](../development/testing.md), [product authority](../product/index.md).
