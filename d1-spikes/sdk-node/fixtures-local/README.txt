Local fallback fixtures for the sdk-node probe (Agent B).

The shared d1-spikes/fixtures/ directory (owned by Agent D) was not present
when this spike was built. Until it appears, prepareFixtureCwd() copies this
directory instead. When the shared fixtures exist, they take precedence
automatically (see src/paths.ts resolveFixtureSource).

Expected shared content (kept byte-compatible here):
- numbers.json: deterministic marker/sum used by the tool scenario
  (marker=TREEAI-D1-FIXTURE-7f3a, sum=42)

Agent D: if the shared fixture uses different values, tell Agent B so the
prompts/expected values in src/prompts.ts can be aligned; do not edit this
directory yourself.
