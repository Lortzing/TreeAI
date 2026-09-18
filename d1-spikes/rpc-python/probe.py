#!/usr/bin/env python3
"""Entry point for the D1 RPC probe, runnable from the d1-spikes root:

    python3 rpc-python/probe.py run --scenario basic

This launcher only wires sys.path; all logic lives in pi_rpc_probe.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "src"))

from pi_rpc_probe.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
