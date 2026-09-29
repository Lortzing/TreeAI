# D3 Studio — status record

Status snapshot of the D3 Core MVP (Studio) work, recorded in-repo because the
D3 plan and acceptance report currently live outside the repository (owner
delivery folder: `TreeAI_D3_规划表_v2.0_2026-09-29.md` — gate ladder Gate 0 →
Gate 1 → Gate 2 with acceptance matrix A1–A7; acceptance report pinned at
`0e71d75`). This document records **status only**; it does not freeze product
contracts (W1) and does not sign any gate — Gate 2 Go/No-Go is an owner
decision.

The pinned acceptance report's verdict stands: **D3 Gate 2 is not passed**. The
revision work the report prescribes (issue #2 P0/P1) has landed in-repo (see
below), but the Go conditions — full real-Pi evidence for A1, owner signature
on W1, per-screen visual comparison, and the 3–5 person trials, all bound to a
single commit — remain open owner-side steps.

## What has landed in-repo

| Commit | Content |
| --- | --- |
| `0e71d75` | D3 Studio MVP: offline Echo vertical slice — create/open Tree, Trunk conversation, anchored branch, branch continuation, navigate back, Return edit + explicit submit; all product state in the TreeAI database |
| `99e92e7` | P0 fixes: clean install (lockfile entry), Return retry consistency (navigate before persist), Studio suite in root `npm test` |
| `673cef8` | P1: run/abort diagnostics (runtime state, in-flight run, DB rows), anchored source highlight restore, controlled real-Pi wiring (env-only `TREEAI_STUDIO_API_KEY`, controlled `--agent-dir`, no `~/.pi` fallback) |
| `0fa1028` | Studio suite added to the `verify:d2` offline CI gate (the remaining W0 / D3-P0 CI item) — the SHA the pinned acceptance report (issue #2) judged |
| `8671136` | D3 P0 per issue #2: Return idempotency — `idempotencyKey` (partial unique index; same-key/same-content replays with zero writes, different content → 409 `return-conflict`), `targetAnchor` submit-time snapshot, draft/confirmed/delivered vocabulary; navigation-before-persist order kept; response-loss/double-click/concurrency/missing-session test classes |
| `7cfd8ef` | Gate 0 drafts per issue #2: `W1-product-contracts.md` (anchor/Return/failure-idempotency contracts, **draft — owner signature pending**), `W2-frontend-prototype.md` (per-screen state checklist + motion storyboard), `evidence/d3/` scaffold (offline/real-pi/trials + run-record template) |
| `6ff7146` | D3 P1 per issue #2: SSE streaming events (`/events`: snapshot + run-started/message-delta/abort-requested/run-terminal/tool-activity), persistent failure panel, distinct aborted state, sources drawer with event-journal tail (`/journal`, conservative projection), missing-session degradation (`sessionAvailability` live probe, branch badges/banners, fail-closed composers); deterministic `/fail` model-error injection for tests |
| `9008cf6` | Owner-recorded sanitized evidence: two successful real-Pi (controlled DeepSeek driver) Trunk prompts on the controlled agent directory — first in-repo real-Pi run record; no credentials, no gate claims |
| `d061b5f` | D3 P1 per issue #2 视觉: main-line reading + local branch panels (anchor-scoped side panel, fixed source/return affordances), anchored Return cards with M3/M4 motion and deliveredRunId cross-reference, localStorage return drafts (client-side per W1 §2.1), per-branch scroll restore, keyboard focus management, restrained motion with global `prefers-reduced-motion` switch, narrow-window layout |
| issue #3 wave | D3 P1 per issue #3 (journal/recovery/scroll): journal tri-state with an explicit load-failure + Retry state (no "no events" masquerade), missing-session recovery as a directly executable action ("Branch from latest available answer" in banner and panel note, disabled with reason when no candidate; a bypass, not an unlock — fail-closed composers stay disabled), and streaming/new-content scroll discipline (48px at-bottom guard; a reader scrolled up is never force-pinned) |
| issue #4 wave | Evidence engineering per issue #4 P1: in-repo scripted-DOM E2E suite (`apps/studio/tests/ui-probe.test.ts`, 8 tests / 156 assertions over the real app.js + parsed index.html, DOM-structure visual baseline included, auto-picked-up by the existing CI chain) and the SHA-bound evidence manifest generator (`scripts/record-d3-evidence.mjs`, `npm run record:d3`: commands/exit codes/durations/environment/artifact SHA-256, append-only, sanitized + post-write scan; verify:d2 recorded but gated by CI separately) |

## Open engineering item (not silently dropped)

- **ToolPolicy real-path integration (issue #3 P1 权限)**: a controlled, harmless real overreach scenario that actually passes through ToolPolicy and is denied, with the UI showing decision provenance. What exists: the `PiRuntimeConfig.tools` allowlist seam in runtime-pi ("宿主给出" for ToolPolicy integration), `ToolPolicyEngine`, tool-activity SSE + journal projection + drawer surfaces. What is missing: request-time tool-execution gating requires wrapping the Pi services created by `Pi.createAgentSessionServices` (Pi-0.85.1-specific integration; d1-spikes research available), the controlled agent dir's tool set is owner configuration, and the real denial evidence needs live model calls. Deliberately not rushed: untestable-offline UI would violate the repo's honesty discipline. Needs an owner-scoped design pass.

## Note on a parallel-session incident (2026-09-29)

An uncommitted rewrite of the three Studio public files appeared in the main checkout at 15:21:57 (a parallel session copied its own W2 rework out of a worktree, unaware of `d061b5f`/`8ac3e01`, and reported it as committed/pushed — it was not). It was preserved verbatim on branch `wip/studio-ui-variant-20260929` (+ /tmp/treeai-ui-variant-backup-20260929/) and the main tree was restored to HEAD before further work. Nothing was lost; the branch is unreviewed and unused by main.

## Acceptance matrix status (as of `d061b5f`)

| Criterion | Scope | In-repo state |
| --- | --- | --- |
| A1 主线与两条支线 | two branches from different anchors, ≥2 follow-ups each, real-Pi, no context bleed | Echo path fully covered by automated tests; real-Pi wiring landed and **first real-Pi Trunk prompts recorded** (`9008cf6`); the full two-branch real-Pi scenario (two anchors, ≥2 follow-ups each, no bleed) **not yet recorded** |
| A2 锚点与导航 | duplicate/cross-line/long selections, dead-reference degradation, reading-position restore | duplicate + cross-line + dead-reference degradation covered by tests; absolute-offset selection, per-branch reading-position restore, and the anchor-scoped panel UI landed (`d061b5f`); long-answer UI behavior and full target-Mac operation **not yet owner-verified** |
| A3 Return 语义 | draft not effective until confirmed, target anchor, delivery traceable, idempotent retry | **landed end-to-end offline** (`8671136` + `d061b5f`): draft/confirmed/delivered states, `targetAnchor` cards at the fork point, `idempotencyKey` idempotency (replay/conflict/concurrency tests), `deliveredRunId` cross-reference into the sources drawer, persistent client-side drafts; real-Pi delivery verification **not yet recorded** |
| A4 恢复与故障 | restart persistence, missing-session browse + actionable recovery hint | restart recovery + interrupted-run convergence covered by tests; missing-session **readable degradation + fail-closed continuation + recovery as a directly executable button landed** (`6ff7146` + issue #3 wave); real-device verification **not yet done** |
| A5 Run 与权限 | streaming/stop/error/policy terminal states, overreach denial, Run provenance | **streaming UI push, stop, error terminal states, run provenance + journal tail landed** (`6ff7146`); journal load-failure state with retry landed (issue #3 wave); policy honesty retained (empty allowlist → no tool decisions observed offline); **ToolPolicy real-path integration remains an open engineering item** (see above) and real-Pi run with tools / policy-denial evidence **not yet recorded** |
| A6 独立试用 | 3–5 non-developer trials on one real task script | **not started** (owner-organized) |
| A7 视觉与动效 | per-screen review against the high-fidelity spec | prototype rework per the W2 checklist landed (`d061b5f`, see W2 更新记录), plus the streaming scroll discipline from issue #3 (scrolled-up readers are never force-pinned); per-screen recording comparison, narrow-window and reduced-motion spot-checks on the target Mac **remain owner-manual** |

## Evidence areas

- `evidence/d3/real-pi/` — opened; first owner-recorded controlled real-Pi (DeepSeek) trunk smoke (`9008cf6`). The full A1 two-branch scenario, failure injections, and delivery traces are still to be recorded there.
- `evidence/d3/offline/` — opened; gate records bound to the implementation SHAs.
- `evidence/d3/trials/` — scaffold only; nothing recorded.
- W1 contract freeze: drafted in `W1-product-contracts.md` (`7cfd8ef`), **owner signature pending**.
