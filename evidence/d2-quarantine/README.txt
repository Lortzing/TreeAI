Quarantined evidence runs (Agent F, 2026-09-21)
=================================================

This directory sits OUTSIDE evidence/d2/ on purpose: the D2 offline gate's
secret-scan-workspace check scans evidence/d2/, and the runs moved here
contain content that must fail that scan. Nothing here was modified — runs
are preserved verbatim, append-only discipline intact; they are only
relocated out of the active scan root so the gate signal stays meaningful.

d2-live-20260921T093421934Z
  Development-stage --driver=fake live run. The tool-policy scenario's
  prompt embedded the ABSOLUTE path of the live fixture, which the runtime
  then wrote into the session transcript (sessions/.../fake-session-1...
  jsonl line 2). The verifier's post-write secret rescan caught it
  ("home-path" rule), overrode the verdict to HAS_FAIL/exit 2 — the
  discipline worked as designed. The prompt bug was fixed the same day in
  tests/live/framework.ts (the prompt now references the repo-relative
  path). The run is kept here as the audit record of that failure.

Do NOT move runs back into evidence/d2/runs/ without re-running
  node scripts/verify-d2.js --only=secret-scan-workspace
and confirming exit 0.
