# Studio refinement — 2026-10-29 working candidate

Baseline HEAD: `fca8e4377fa5ebf887cf42d5c8572af3c7bbbfc2`. These are **local working-tree changes**, not a tested clean commit or a published build. `source-manifest.json` identifies final changed source bytes, including new browser modules and the pinned UI library. No PR was created.

## Behavior

- Original warm theme by default; optional #EFF2ED theme and Enter / Ctrl-or-Cmd+Enter / Shift+Enter send preference, saved locally. IME candidate confirmation never sends.
- Settings uses locally vendored Web Awesome 3.14.0 tabs and native dialog focus management. Appearance, input and connection configuration are separate; empty configuration hides disabled fields. Upstream files are unchanged, licensed, checksummed and exactly allowlisted. Installer already includes the entire public tree; no npm dependency or lockfile updates.
- Input tools share a compact row with SVG controls. Main and branch composers accept up to four MD/PDF attachments, resolve immutable tree-scoped versions, disclose bounded context, and include actual text in the next prompt. User-facing file buttons reopen the original version; raw attachment URL headers are not displayed as titles.
- Model choices come only from the running process's configured catalog. Real Pi selection uses AgentSession.setModel, with validation before dispatch. Speech recognition, when supported and permitted, fills a draft and never submits automatically.
- Material tabs use a horizontal line directory; switching retains reading positions and releases PDF rendering resources. Right-reader wheel/touch/key scrolling collapses its heading and reveals it again on upward movement. The close control remains reachable.
- Text selection shows a nearby action popover; rectangle mode captures one continuous canonical text range within one block/page. Cross-block/page captures are refused, not silently shortened. This is text-region selection, not image OCR or an image crop.
- Toolbar diagnostics move into the existing overflow, idle state and redundant sidebar copy disappear, one-round conversations have no pagination controls, and unarmed disabled explanation buttons are hidden.

## Verification actually executed

- `npm run typecheck`: final working candidate PASS (`types-final-candidate.log`).
- `npm test`: **913 / 913 PASS** (`tests-redesign-final.log`). The later tooltip/feedback/attachment-spacing refinements were checked with focused suites, not represented as a new full-suite run.
- Final affected UI suites: **74 / 74 PASS** (`ui-polish-final.log`).
- Final attachment, material API and appearance suites: **27 / 27 PASS** (`attachments-final.log`).
- Exact browser-asset/vendor checksum audit and computed-path audit PASS.
- Scoped Chrome Echo selftest: **9 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN** (`browser-scoped-pass.json`). Includes boot, import, 75 frozen MD/PDF selections, real mouse gestures, material branching/retry/idempotency, return/save, restart, mobile/touch/keyboard/reduced motion. **Not the full 16-check suite and not real-Pi evidence.** Later changes only affect settings layout/copy, attachment spacing, and unarmed explanation visibility; settings were checked directly in the app browser afterward.
- Direct app-browser checks: settings tabs click/arrow keys, theme and shortcut persistence across reload, original theme restored; empty connection state and populated form footer; actual MD rectangle selection, right-pane header down/up, two-file switching, Enter send / Ctrl+Enter newline and attachment dispatch checked during this iteration. Preview uses an isolated Echo data directory, not user API/model calls.

Prior failed scoped browser run is retained as `browser-prior-failed.json` and `browser-prior-studio.log` (PDF first-question timeout and a following reset). It is not relabeled PASS; the independent final scoped run passed. Earlier intermediate scripted-DOM failures and logs remain in `/tmp/treeai-ui-followup-20261029/`.

## Still open

DOCX/PPT/web/image ingestion, visual crop/OCR asking, shared tabs across every right-pane content type, attachment/model/voice tools in dynamically created first-question forms, live microphone recognition, live provider model switching, new installer execution, target-device and human acceptance. They are not implied by these checks. Existing save-before-navigation, material/version identities, frozen fixtures and evaluator denominators are preserved.
