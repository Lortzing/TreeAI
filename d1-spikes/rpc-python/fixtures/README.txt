Local fallback fixtures for the rpc-python probe (Agent C).

These exist so the probe is self-contained when the shared
d1-spikes/fixtures/ directory (Agent D) is not present. The shared
fixtures take precedence once they exist (the CLI picks
d1-spikes/fixtures/ automatically, and the tool scenario then runs on a
scripts/make-run-dir temp copy of them, per the shared contract).

numbers.json mirrors the shared fixture dataset (values = digits of pi).
The tool scenario asks the agent the four standard verification
questions (count/sum/min/max/median, see d1-spikes/fixtures/README.txt
section 4) and judges the answers against this file itself. The scenario
runs against a temporary copy in a scratch directory; the source is
never modified.
