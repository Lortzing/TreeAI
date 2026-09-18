"""pi_rpc_probe: a disposable D1 spike driving `pi --mode rpc` as a subprocess.

This is NOT a production backend and NOT a generic RuntimeAdapter. It exists
only to produce reproducible evidence for TreeAI D1 (SDK-vs-RPC comparison).

Scope (Agent C, D1):
- strict JSONL stdin/stdout framing over a pi RPC subprocess
- request/response correlation by id
- asynchronous event dispatch
- stderr captured separately (never parsed as JSONL)
- timeouts, subprocess exit detection, and finally-style cleanup

See d1-spikes/rpc-python/README.md for usage.
"""

__version__ = "0.1.0"

IMPLEMENTATION_ID = "rpc-python"
REDACTION_VERSION = "d1-v1"
