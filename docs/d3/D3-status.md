# D3 Studio — status record

Status snapshot of the D3 Core MVP (Studio) work, recorded in-repo because the
D3 plan and acceptance report currently live outside the repository (owner
delivery folder: `TreeAI_D3_规划表_v2.0_2026-09-29.md` — gate ladder Gate 0 →
Gate 1 → Gate 2 with acceptance matrix A1–A7; acceptance report pinned at
`0e71d75`). This document records **status only**; it does not freeze product
contracts (W1) and does not sign any gate — Gate 2 Go/No-Go is an owner
decision.

The pinned acceptance report's verdict stands: **D3 Gate 2 is not passed**;
the Studio is an offline-Echo internal prototype until the matrix below is
closed with evidence bound to a single commit.

## What has landed in-repo

| Commit | Content |
| --- | --- |
| `0e71d75` | D3 Studio MVP: offline Echo vertical slice — create/open Tree, Trunk conversation, anchored branch, branch continuation, navigate back, Return edit + explicit submit; all product state in the TreeAI database |
| `99e92e7` | P0 fixes: clean install (lockfile entry), Return retry consistency (navigate before persist), Studio suite in root `npm test` |
| `673cef8` | P1: run/abort diagnostics (runtime state, in-flight run, DB rows), anchored source highlight restore, controlled real-Pi wiring (env-only `TREEAI_STUDIO_API_KEY`, controlled `--agent-dir`, no `~/.pi` fallback) |
| this change | Studio suite added to the `verify:d2` offline CI gate (the remaining W0 / D3-P0 CI item) |

## Acceptance matrix status (as of this commit)

| Criterion | Scope | In-repo state |
| --- | --- | --- |
| A1 主线与两条支线 | two branches from different anchors, ≥2 follow-ups each, real-Pi, no context bleed | Echo path covered by automated tests; real-Pi wiring landed in `673cef8` but **no real-Pi end-to-end evidence recorded in-repo yet** |
| A2 锚点与导航 | duplicate/cross-line/long selections, dead-reference degradation, reading-position restore | duplicate + cross-line + dead-reference degradation covered by tests (`apps/studio/tests/service.test.ts`); reading-position restore present in UI but **not formally verified** |
| A3 Return 语义 | draft not effective until confirmed, target anchor, delivery traceable, idempotent retry | navigation-before-persist landed in `99e92e7`; **draft / target-anchor / delivery surfaces not built** |
| A4 恢复与故障 | restart persistence, missing-session browse + actionable recovery hint | restart recovery + interrupted-run convergence covered by tests; **missing-session UI degradation hint not built** |
| A5 Run 与权限 | streaming/stop/error/policy terminal states, overreach denial, Run provenance | run/abort diagnostics landed in `673cef8`; **streaming UI push and policy/journal surfacing not built** (documented non-goal in `apps/studio/src/service.ts`) |
| A6 独立试用 | 3–5 non-developer trials on one real task script | **not started** |
| A7 视觉与动效 | per-screen review against the high-fidelity spec | **not started** |

## Not started outside the matrix

- No `evidence/d3/` area and no D3 acceptance script yet (Gate 0 artifacts:
  baseline is this commit; CI coverage closed by this change; the W1 product
  contract freeze remains open and owner-owned).
