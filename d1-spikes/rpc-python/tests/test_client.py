"""Client-layer tests: request correlation, timeouts, exit detection,
event dispatch, derived run state, since-index waiting."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from pi_rpc_probe.client import (  # noqa: E402
    PiRpcClient,
    ProcessExitedError,
    RpcTimeoutError,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import ev, message_end_line, resp, spawn_fake, tmpdir  # noqa: E402


class TestRequestCorrelation(unittest.TestCase):
    def test_response_correlated_with_interleaved_events(self):
        d = tmpdir()
        # events BEFORE and AFTER the response on the same stream
        spec = {"handlers": {
            "prompt": [{"emit": [
                ev("agent_start"),
                resp("prompt"),
                ev("message_update", usage={}, assistantMessageEvent={
                    "type": "text_delta", "contentIndex": 0, "delta": "hi"}),
                ev("agent_settled"),
            ]}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            out = client.request("prompt", {"message": "x"}, timeout=5.0)
            self.assertTrue(out["success"])
            self.assertIn("id", out)
            self.assertIn("prompt", out["id"])
            deadline = time.time() + 5
            while "agent_settled" not in client.events_seen \
                    and time.time() < deadline:
                time.sleep(0.05)
            self.assertIn("agent_start", client.events_seen)
            self.assertIn("agent_settled", client.events_seen)
        finally:
            proc.close()

    def test_event_with_id_field_is_not_a_response(self):
        # bash_execution_update echoes the originating command's id; it must
        # be dispatched as an event, not consumed as a response
        d = tmpdir()
        spec = {"handlers": {
            "bash": [{"emit": [
                json.dumps({"type": "bash_execution_update", "id": "@echo",
                            "delta": "chunk1\n"}),
                resp("bash", data={"output": "chunk1\n", "exitCode": 0}),
            ]}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            out = client.request("bash", {"command": "ls"}, timeout=5.0)
            self.assertTrue(out["success"])
            self.assertEqual(out["data"]["exitCode"], 0)
            deadline = time.time() + 5
            while "bash_execution_update" not in client.events_seen \
                    and time.time() < deadline:
                time.sleep(0.05)
            self.assertIn("bash_execution_update", client.events_seen)
            self.assertEqual(client.unmatched_responses, [])
        finally:
            proc.close()

    def test_concurrent_requests_each_get_their_own_response(self):
        d = tmpdir()
        spec = {"handlers": {
            "get_state": [{"emit": [resp("get_state", data={"a": 1})],
                           "delay": 0.2}],
            "get_messages": [{"emit": [resp("get_messages",
                                            data={"messages": [1]})]}],
        }}
        proc, client = spawn_fake(spec, d)
        results = {}

        def _do(cmd, key):
            results[key] = client.request(cmd, timeout=10.0)

        try:
            t1 = threading.Thread(target=_do, args=("get_state", "state"))
            t2 = threading.Thread(target=_do, args=("get_messages", "msgs"))
            t1.start(); t2.start(); t1.join(); t2.join()
            self.assertEqual(results["state"]["data"], {"a": 1})
            self.assertEqual(results["msgs"]["data"], {"messages": [1]})
            self.assertNotEqual(results["state"]["id"],
                                results["msgs"]["id"])
        finally:
            proc.close()

    def test_unmatched_id_response_recorded_not_crashing(self):
        d = tmpdir()
        spec = {"handlers": {
            "get_state": [{"emit": [
                json.dumps({"type": "response", "command": "get_state",
                            "id": "bogus-id", "success": False,
                            "error": "stale"}),
                resp("get_state", data={"ok": True}),
            ]}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            out = client.request("get_state", timeout=5.0)
            self.assertTrue(out["success"])
            self.assertEqual(len(client.unmatched_responses), 1)
            self.assertEqual(client.unmatched_responses[0]["id"], "bogus-id")
        finally:
            proc.close()

    def test_parse_error_response_without_id(self):
        d = tmpdir()
        spec = {"handlers": {}}
        proc, client = spawn_fake(spec, d)
        try:
            # send raw garbage: the fake answers with a no-id parse response
            proc.send_raw(b"this is not json\n")
            deadline = time.time() + 5
            while not client.unmatched_responses and time.time() < deadline:
                time.sleep(0.05)
            self.assertEqual(len(client.unmatched_responses), 1)
            self.assertEqual(client.unmatched_responses[0]["command"],
                             "parse")
            # the client itself stays usable
            out = client.request("get_state", timeout=5.0)
            # no handler: fake returns unknown-command failure
            self.assertFalse(out["success"])
        finally:
            proc.close()


class TestErrors(unittest.TestCase):
    def test_request_timeout_is_typed(self):
        d = tmpdir()
        spec = {"handlers": {"get_state": [{"hang": True}]}}
        proc, client = spawn_fake(spec, d, request_timeout=10.0)
        try:
            t0 = time.monotonic()
            with self.assertRaises(RpcTimeoutError):
                client.request("get_state", timeout=0.5)
            self.assertLess(time.monotonic() - t0, 3.0)
        finally:
            proc.close()

    def test_exit_during_pending_request(self):
        d = tmpdir()
        spec = {"handlers": {"get_state": [{
            "stderr": "boom trace\n", "delay": 0.2, "exit": 3,
        }]}}
        proc, client = spawn_fake(spec, d)
        try:
            with self.assertRaises(ProcessExitedError) as cm:
                client.request("get_state", timeout=10.0)
            self.assertEqual(cm.exception.exit_code, 3)
            self.assertIn("boom trace", cm.exception.stderr_tail)
        finally:
            proc.close()

    def test_request_after_exit_raises(self):
        d = tmpdir()
        spec = {"handlers": {"get_state": [{"exit": 0}]}}
        proc, client = spawn_fake(spec, d)
        try:
            with self.assertRaises(ProcessExitedError):
                client.request("get_state", timeout=10.0)
            time.sleep(0.3)  # let EOF propagate
            with self.assertRaises(ProcessExitedError):
                client.request("get_state", timeout=10.0)
        finally:
            proc.close()


class TestEventDispatch(unittest.TestCase):
    def test_run_state_transitions(self):
        d = tmpdir()
        spec = {"handlers": {
            "prompt": [{"emit": [
                resp("prompt"),
                ev("agent_start"),
                ev("compaction_start", reason="threshold"),
                ev("compaction_end", reason="threshold", result=None,
                   aborted=False, willRetry=False),
                message_end_line("x"),
                ev("agent_end", messages=[], willRetry=False),
                ev("agent_settled"),
            ]}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            states = []
            client.subscribe(lambda e: states.append(client.run_state))
            client.request("prompt", {"message": "x"}, timeout=5.0)
            deadline = time.time() + 5
            while client.run_state != "idle" and time.time() < deadline:
                time.sleep(0.05)
            self.assertEqual(client.run_state, "idle")
            self.assertIn("running", states)
            self.assertIn("compacting", states)
        finally:
            proc.close()

    def test_wait_for_event_with_since_index(self):
        d = tmpdir()
        flow1 = [resp("prompt"), ev("agent_start"), ev("agent_settled")]
        flow2 = [resp("prompt"), ev("agent_start"), ev("agent_settled")]
        spec = {"handlers": {"prompt": [{"emit": flow1}, {"emit": flow2}]}}
        proc, client = spawn_fake(spec, d)
        try:
            idx0 = client.event_log_len()
            client.request("prompt", {"message": "one"}, timeout=5.0)
            got = client.wait_for_event(
                lambda e: e.get("type") == "agent_settled", 2.0,
                since_index=idx0)
            self.assertIsNotNone(got)  # first settled

            idx1 = client.event_log_len()
            # waiting from idx1 must NOT see the first settled again
            none = client.wait_for_event(
                lambda e: e.get("type") == "agent_settled", 0.5,
                since_index=idx1)
            self.assertIsNone(none)

            client.request("prompt", {"message": "two"}, timeout=5.0)
            got2 = client.wait_for_event(
                lambda e: e.get("type") == "agent_settled", 2.0,
                since_index=idx1)
            self.assertIsNotNone(got2)
        finally:
            proc.close()

    def test_subscriber_exception_does_not_kill_dispatch(self):
        d = tmpdir()
        spec = {"handlers": {
            "prompt": [{"emit": [
                resp("prompt"), ev("agent_start"), ev("agent_settled"),
            ]}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            def broken(_obj):
                raise RuntimeError("recorder bug")

            client.subscribe(broken)
            client.request("prompt", {"message": "x"}, timeout=5.0)
            deadline = time.time() + 5
            while "agent_settled" not in client.events_seen \
                    and time.time() < deadline:
                time.sleep(0.05)
            self.assertIn("agent_settled", client.events_seen)
        finally:
            proc.close()


if __name__ == "__main__":
    unittest.main()
