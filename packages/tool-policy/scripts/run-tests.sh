#!/usr/bin/env bash
# Agent D unit-test runner for @treeai/tool-policy.
#
# Strategy: compile src/ + tests/ with the workspace-pinned tsc into a
# scratch directory (.tmp-test), run Node's built-in test runner on the
# emitted JS, then remove the scratch directory. No third-party test
# framework; no residue left in the workspace on any exit path.
#
# Exit codes: 0 all tests pass; 1 compile failure; test-runner exit code
# is propagated otherwise (node --test exits 1 on failing tests).
set -uo pipefail
cd "$(dirname "$0")/.."

TSC="${TSC:-../../node_modules/.bin/tsc}"
OUT=".tmp-test"

rm -rf "$OUT"
if ! "$TSC" -p tsconfig.test.json; then
  rm -rf "$OUT"
  exit 1
fi

node --test "$OUT"/tests/*.test.js
status=$?

rm -rf "$OUT"
exit $status
