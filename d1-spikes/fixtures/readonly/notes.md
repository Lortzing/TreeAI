# TreeAI D1 read-only fixture notes

- fixtureVersion: d1-v1
- This directory is read-only by contract. Scenario runs may read these files
  but must never write to them.
- All scenario runs operate on a temporary copy produced by
  d1-spikes/scripts/make-run-dir. The copy enforces read-only permissions on
  this directory; a write attempt inside it is expected to fail and is itself
  one of the "tool only accesses authorized fixtures" verification points.
- numbers.json holds a frozen list of 16 integer values (digits of pi).
- Expected answers for the standard verification questions are documented in
  fixtures/README.txt.
- These fixtures contain no credentials, tokens, or personal data. If you
  believe you found a secret here, treat it as an incident: stop sharing the
  evidence and record it in reports/blockers.md.
