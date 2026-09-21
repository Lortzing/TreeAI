TreeAI D2 e2e fixture tree (Agent F).

readonly/    — files the fake tool policy ALLOWS reading (readRoots includes this dir).
workspace/   — files where writes are allowed only with user approval (require-approval).
live/        — ground truth used by the live tool-policy scenario.

These files contain no secrets by construction; the fixtures-integrity check
hashes them (MANIFEST.sha256) so any tampering fails the gate.
