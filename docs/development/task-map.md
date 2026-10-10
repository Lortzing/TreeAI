# Task-to-file map — current refactor candidate

Start from the narrowest owner and its tests; expand only when crossing a public API, persistence or runner boundary. Paths refer to [integration PR #27](https://github.com/Lortzing/TreeAI/pull/27), not the old main layout.

| Task | Start here | Broaden when necessary | Verification |
| --- | --- | --- | --- |
| Studio startup/UI state | `apps/studio/public/app.js`, `core/create-studio-app.js` | ESM/static/installer wiring | Studio scripted DOM + native Chrome |
| Studio diagnostics/status | `public/core/views/diagnostics.js`, `public/core/create-studio-app.js` | diagnostics refresh/polling/SSE and abort controller | diagnostics/failure UI + Studio suite |
| Source identity/offsets | `public/shared/source/{sha256,selection}.js`, `public/core/dom.js` | Server range resolver and Unicode contract | source SHA/selection + fixed range cases |
| Reading position | `public/shared/reading-position/scroll.js` | Material reader or branch navigation | bottom-follow + Chrome scrolling |
| Return rendering/source | `public/core/views/return.js`, `public/core/create-studio-app.js` | Return write/adoption in `src/service.ts`; material Return and shared motion maps remain in factory | W1 replay/conflict/source/display |
| Tree conversation / Branch / Return behavior | `public/core/create-studio-app.js`, `src/service.ts` | Pi session cursor or repository writes | Studio, runtime, journal, real Pi |
| Terminology | `src/terminology.ts`, `src/terminology/suggestion-density.ts` | Promotion ledger, model budget, UI view | Terminology API/UI/evaluator, manual vs auto gate |
| Markdown/PDF | `src/materials/`, `public/core/create-studio-app.js` | source/selection and PDF parser | B1/B2/B3 + native selection |
| Search and navigation | `src/search/`, `src/nav/`, `public/core/views/{search,nav-finder}.js`, `public/core/create-studio-app.js` | index rebuild, versions or cursor semantics; nav session/virtualized tree controllers remain in factory | Search/finder UI + B4/B9 engine and Chrome |
| HTTP / static / API | `src/server.ts`, `src/http/{requests,responses,errors,static}.ts` | New static route, PDF.js resource or installer | HTTP/static tests, MIME and browser 404 |
| Runtime SDK boundary | `packages/runtime-pi/src/pi-runtime.ts`, `session-inspection.ts` | Pi port and tool policy only when affected | runtime-pi / session restore / policy |
| Storage, backups and session recovery | `packages/persistence/src/`, `src/portability/` | Multi-entity DB transaction | restart/integrity/failure injection |
| Browser/real Pi runner | `scripts/run-d4-browser.mjs`, `run-d3-browser.mjs` | Domains in `scripts/d4/browser/` | check IDs / exit codes 0-3 / CI smoke |
| PDF fixture generation | `scripts/d4/pdf/content.mjs`, `content/fixtures-*.mjs` | Unicode parser/source changes | `content.test.mjs`, frozen B1 hash |
| B6 large-scale testing | `scripts/d4/gen-b6-scale-dataset.mjs`, `tests/support/verifier/d4-b6-scale.ts` | Font provisioning on non-Mac | Linux B6 + invariant checks; real Chrome B6 separately |
| Installed product | `scripts/d4/installer/`, `package-installer.mjs` | Bundled public files, Node runtime | bundle smoke and physical target devices |

**Important:** The factory and several service/runner files remain large by design only as an intermediate migration state, **not** as approved permanent size exceptions. Do not mark R1/R3/R4 complete before splitting them and retaining the entire old scenario/fixture denominator. The root and Studio workspace test globs are not recursive by default.
