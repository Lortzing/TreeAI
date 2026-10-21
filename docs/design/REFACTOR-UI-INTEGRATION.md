# Refactor and Studio UI integration

2026-10-21. Integrates `refactor/integration-r0-r7` at `c25e1b9` with the approved Session UI at `7674a44` for main.

The browser entry remains a thin `createStudioApp` bootstrap. Session/Episode projection and the relationship graph live in an instance-owned `core/views/session-workspace.js`; keyboard, pointer and product navigation bindings live in `core/controllers/workspace-events.js` with disposal. Conversation, focus, prompt, Return, materials and navigation keep their refactored owners. The new visual layer is an ordered CSS module. Exact HTTP allowlists and static-route tests include the added resources; the installer continues to copy the entire public module tree.

Validation on the integrated working tree:

- `npm test`: 859 passed, zero failures or skipped tests. Includes all existing refactor scenarios and the new round navigation/source/draft scenarios. The isolated streaming unit fixture was extended with its new branch-view dependency; original assertions remain.
- `npm run typecheck`: all seven source workspaces passed.
- `npm run audit:studio-assets`: 55 native ESM assets and 10 CSS modules accounted for, including installer inclusion.
- `npm run audit:computed-paths`: 131 resolved resources, 20 test globs; 12 computed expressions remain explicitly mapped to their runtime gates.
- `node scripts/audit-refactor-boundaries.mjs --base origin/main --out /tmp/treeai-merge-boundaries.json`: 794 baseline static scenarios preserved, 862 current; zero boundary violations. Static scenario counts and actual executed test counts are distinct.
- Browser at the integrated local Echo server: create Tree, submit two prompts, follow the latest round, page to an older round, create Branch, reveal the source round, open Session graph. No browser errors observed.
- `git diff --check`: clean.

This merge does not close existing real-Pi, human quality, participant or physical target-device acceptance gates. It does not claim that prior CI/package/browser acceptance runs validate this integration; those records remain intact.
