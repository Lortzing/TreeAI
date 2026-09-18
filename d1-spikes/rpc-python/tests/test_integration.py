"""Integration tests against the REAL `pi --mode rpc` binary.

These are skipped automatically when pi is not on PATH or the configured
provider is not ready. They verify the real protocol behaves as the client
expects (framing, correlation, graceful exit) before the full scenario
runs. They never print or store credentials.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from helpers import tmpdir  # noqa: E402
from pi_rpc_probe.client import PiRpcClient  # noqa: E402
from pi_rpc_probe.envcheck import check_environment  # noqa: E402
from pi_rpc_probe.transport import PiSubprocess  # noqa: E402

PI_BIN = os.environ.get("PI_BIN", "pi")
PROVIDER = os.environ.get("TREEAI_D1_PROVIDER", "tal-token-plan-06c64a09")
MODEL = os.environ.get("TREEAI_D1_MODEL", "deepseek-v4.1-flash")

_HAVE_PI = shutil.which(PI_BIN) is not None
_READY = False
if _HAVE_PI:
    try:
        _READY, _ = check_environment(PI_BIN, PROVIDER, MODEL)
    except Exception:
        _READY = False


@unittest.skipUnless(_HAVE_PI and _READY,
                     "pi binary or provider credentials unavailable")
class TestRealPiProtocol(unittest.TestCase):
    def _spawn(self, extra=None):
        argv = [PI_BIN, "--mode", "rpc", "--no-session",
                "--provider", PROVIDER, "--model", MODEL,
                "--thinking", "off"] + (extra or [])
        d = tmpdir("d1-integration-")
        proc = PiSubprocess(argv, cwd=d,
                            stderr_path=os.path.join(d, "stderr.log"))
        client = PiRpcClient(proc, request_timeout=60.0)
        client.start()
        return proc, client

    def test_get_state_correlated_response_and_graceful_exit(self):
        proc, client = self._spawn()
        try:
            out = client.request("get_state", timeout=60.0)
            self.assertTrue(out["success"], out)
            data = out.get("data") or {}
            self.assertIn("sessionId", data)
            # tolerate unsolicited extension events (e.g. extension_ui_request
            # emitted at startup) -- they must not break correlation
        finally:
            code = proc.close(grace_timeout=15.0)
        self.assertEqual(code, 0)

    def test_prompt_round_trip_streams_and_settles(self):
        proc, client = self._spawn()
        try:
            idx = client.event_log_len()
            out = client.request(
                "prompt", {"message": "Reply with exactly the word: pong"},
                timeout=60.0)
            self.assertTrue(out["success"], out)
            settled = client.wait_for_event(
                lambda e: e.get("type") == "agent_settled", 90.0,
                since_index=idx)
            self.assertIsNotNone(settled)
            deltas = [
                (e.get("assistantMessageEvent") or {}).get("delta", "")
                for e in client.events_since(idx)
                if e.get("type") == "message_update"
                and (e.get("assistantMessageEvent") or {})
                .get("type") == "text_delta"
            ]
            self.assertTrue(deltas, "no text deltas observed")
            self.assertIn("pong", "".join(deltas).lower())
        finally:
            code = proc.close(grace_timeout=15.0)
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
