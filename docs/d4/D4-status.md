# D4 — status record（独立矩阵跟踪，issue #7 跟踪补充 2026-09-30）

Status record for the **D4 independent matrix** the owner brought into
tracking (issue #7 跟踪补充, owner directive 2026-09-30 15:23):
「既定 D4 纳入跟踪……术语功能不替代 D4；D3 人工项延后不阻止可独立推进
的 D4 工程」。This document records **status only**; it does not freeze a
D4 scope — per the same comment, **不重新创造一套范围**.

## Current state: the authoritative D4 task book has not been located

Searched honestly (2026-09-30, this wave):

1. **Repo tree** (`main` @ `085f979`, full text over tracked `*.md` /
   `*.ts` / `*.mjs` / `*.json`): no D4 planning/delivery document, no D4
   task matrix, no D4 references beyond hash-string coincidences. The
   untracked-in-repo D1 agent task book also carries no D4 section.
2. **Owner delivery folder** (the same local source that carried the D1/D2/D3
   documents, `TreeAI_D1_…`/`TreeAI_D2_…`/`TreeAI_D3_…`): only D1/D2/D3
   documents exist there — **no D4 document**.
3. **What does exist** (recorded verbatim, NOT promoted to scope):
   - `TreeAI_D3_规划表.md` (D3 plan v1), 「留到 D4」row:
     *PDF/Markdown 阅读、跨材料搜索、正式安装包与跨平台适配、性能优化、
     大规模树导航* — a deferral list inside the D3 plan, not a D4 matrix.
   - `TreeAI_D3_规划表_v2.0_2026-09-29.md` (the plan the issue #7 acceptance
     read) writes those areas as 后续验证 — again not a frozen D4 task
     matrix (the acceptance comment states this explicitly and rules that
     these suggestions cannot be upgraded to D4 blockers from these
     documents alone).

## What is needed (owner-side, blocking D4 engineering verification)

Per the issue #7 comment's own 复验条件: the next D4 delivery should
**provide or reference the established D4 document**, making explicit the
already-confirmed items, boundaries, acceptance commands, and evidence
requirements. Engineering cannot and will not invent that scope. Once the
authoritative document lands (in-repo or referenced), this record will carry
the per-item matrix: code linkage, tested SHA, and how each item was
verified (executed / recorded / inferred / unverifiable), with remediation
and re-verification conditions — the same discipline as the D3 status
record.

## Relationship to the current engineering waves

- The issue #7 waves (W1 P0/P1 remediation `32f4778`, terminology ①② core
  `cd0784c`, extract-prompt tightening `433f448`, runner extension `92a2e3a`,
  evidence binding `085f979`) are **D3/W1/terminology work** — they are not
  D4 progress and are not counted as such.
- Per the comment, D4 engineering may proceed independently of the deferred
  D3 manual items (Mac sign-off, trials) once its authoritative scope is
  available.
- The final stop condition (per the comment) now includes D4 having
  verifiable acceptance with no blockers — which first requires the scope
  document above.
