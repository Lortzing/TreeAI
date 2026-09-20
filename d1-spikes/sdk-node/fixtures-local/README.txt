Local fallback fixtures for the sdk-node probe (Agent B).

Agent D's shared d1-spikes/fixtures/ has been delivered and takes
precedence automatically (see src/paths.ts resolveFixtureSource); the
tool scenario runs against the shared numbers.json. This directory is
kept as a self-contained fallback for checkouts where the shared
fixtures are absent; prepareFixtureCwd() copies it in that case and
the scenario records a limitation noting the fallback.

Fallback content (byte-identical to the shared fixture):
- numbers.json: the 16 digits of pi used by the tool scenario
  values [3,1,4,1,5,9,2,6,5,3,5,8,9,7,9,3]
  count=16, sum=80, min=1, max=9, median=5

These values must stay aligned with the shared numbers.json and with
the expected aggregates in src/prompts.ts (FIXTURE_COUNT/SUM/MIN/MAX/
MEDIAN). tests/static.test.ts cross-checks the fallback against the
shared fixture whenever both are present; if Agent D ever changes the
shared numbers, realign this file, src/prompts.ts and README.md. Do
not edit this directory outside Agent B's scope.
