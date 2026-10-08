# Candidate acceptance status

Last verified repository baseline for the **refactor inventory**: `e427460b31f61722d5e74a6fa4ee24d140abe67b` (2026-10-08). This is not a claim that tests were re-run at that SHA or that any refactor branch has passed.

| Scope | Current interpretation | Primary record |
| --- | --- | --- |
| D2 | Historical results only; optional live/D1 gate may remain NOT_RUN | [D2 verification](../d2/D2-verification.md) |
| D3 and W1 v3 | Engineering and historical evidence exist; final-candidate and owner acceptance are separate | [D3 status](../d3/D3-status.md), [issue #7](https://github.com/Lortzing/TreeAI/issues/7) |
| Terminology ①②③ | Independent quality, dispatch and UI gates remain authoritative | [issue #7](https://github.com/Lortzing/TreeAI/issues/7) |
| D4-0…8 | Five confirmed areas plus enabling packages and acceptance matrix | [D4 status](../d4/D4-status.md), [issue #8](https://github.com/Lortzing/TreeAI/issues/8) |
| Real Pi / Chrome | Must be executed on the final candidate SHA; old runs are not transferable automatically | [issue #7](https://github.com/Lortzing/TreeAI/issues/7) |
| Three OS targets, Mac sign-off, trials | Distinct target-device/human checks; not substituted by CI | [issue #8](https://github.com/Lortzing/TreeAI/issues/8) |

**Refactor PR0:** documentation and inventory only; no source migration. At writing, no refactor-branch `npm ci`, `npm test`, real-Pi or manual result is asserted. Subsequent PRs must update this page with the exact candidate SHA, commands and honest status. Preserve existing evidence until the entire project has passed all required gates.
