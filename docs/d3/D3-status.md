# D3 Studio — current status and archived engineering record

**Status authority:** [current acceptance matrix](../acceptance/status.md) and [Issue #7](https://github.com/Lortzing/TreeAI/issues/7). A successful offline test suite is **not** final D3, W1, terminology, browser, real-Pi or owner acceptance.

The previous large, append-only D3 status ledger has been preserved in full as [D3 status historical record](../archive/d3/D3-status-history.md). This short page retains the established `docs/d3/D3-status.md` URL for old issues and references without forcing every reader to ingest historical runs.

## Boundary that still applies

- W1 v3 owner-signed product decisions remain signed and are not a new sign-off request. The existing W1 documents are supporting in-repo records, not a replacement for the signed original.
- D3 Gate 2 and the final-candidate regressions are separate from historical evidence. Old Pi/browser results belong to the exact SHA that produced them.
- Return save-before-navigation, Tree-scoped idempotency, source identity vs session availability, authorized tools and recovery remain required.
- Product-facing Mac experience sign-off and independent trials are distinct owner-side gates; do not mark them PASS based on simulated DOM.
- The scope includes D3, W1 v3 mandatory fixes, terminology three workstreams and existing D4 dependencies; no new features are silently added by refactoring.

For exact historical commits, failed observations, remediation steps and wave tracking, follow the [unchanged full record](../archive/d3/D3-status-history.md). For current D4 scope, follow [D4 status](../d4/D4-status.md) and [Issue #8](https://github.com/Lortzing/TreeAI/issues/8).
