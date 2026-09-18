"""Transport-layer tests: strict JSONL framing, stderr isolation, exit
detection, cleanup. All against the fake pi server (no real model)."""

from __future__ import annotations

import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from pi_rpc_probe.transport import (  # noqa: E402
    EOF_SENTINEL,
    PiSubprocess,
    StdoutSplitter,
    parse_record,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import fake_pi_argv, spawn_fake, tmpdir  # noqa: E402


class TestStdoutSplitter(unittest.TestCase):
    def test_lf_only_splitting_with_unicode_line_separators(self):
        # U+2028 / U+2029 are valid inside JSON strings; strict JSONL must
        # NOT split on them (str.splitlines() would).
        payload = {"text": "before after end"}
        data = (json.dumps(payload) + "\n").encode("utf-8")
        records = StdoutSplitter().feed(data)
        self.assertEqual(len(records), 1)
        parsed = parse_record(records[0])
        self.assertIsNone(parsed.anomaly)
        self.assertEqual(parsed.payload["text"], "before after end")

    def test_splitter_does_not_split_on_lone_cr(self):
        # a lone CR must not terminate a record (only LF does); the
        # resulting record content is kept verbatim (here: not valid JSON,
        # which the parser reports separately -- the framing is what counts)
        data = b'{"a": 1}\r{"b": 2}\n'
        records = StdoutSplitter().feed(data)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0], b'{"a": 1}\r{"b": 2}')
        parsed = parse_record(records[0])
        self.assertIsNotNone(parsed.anomaly)  # invalid JSON, but one record

    def test_trailing_cr_stripped(self):
        records = StdoutSplitter().feed(b'{"a": 1}\r\n')
        self.assertEqual(records, [b'{"a": 1}'])

    def test_byte_drip_reassembly(self):
        # records delivered one byte at a time still reassemble correctly
        splitter = StdoutSplitter()
        data = b'{"a": 1}\n{"b": 2}\n'
        out = []
        for i in range(len(data)):
            out.extend(splitter.feed(data[i:i + 1]))
        self.assertEqual(out, [b'{"a": 1}', b'{"b": 2}'])
        self.assertEqual(splitter.flush_eof(), None)

    def test_partial_record_at_eof(self):
        splitter = StdoutSplitter()
        records = splitter.feed(b'{"a": 1}\n{"partial":')
        self.assertEqual(records, [b'{"a": 1}'])
        self.assertEqual(splitter.flush_eof(), b'{"partial":')

    def test_multiple_records_in_one_chunk(self):
        splitter = StdoutSplitter()
        records = splitter.feed(b'{"a":1}\n{"b":2}\n{"c":3}\n')
        self.assertEqual(len(records), 3)

    def test_parse_record_invalid_utf8(self):
        parsed = parse_record(b'\xff\xfe broken\n'.rstrip(b"\n"))
        self.assertIsNotNone(parsed.anomaly)
        self.assertIn("invalid-utf8", parsed.anomaly)

    def test_parse_record_invalid_json(self):
        parsed = parse_record(b'{"a": ')
        self.assertIsNotNone(parsed.anomaly)
        self.assertIn("invalid-json", parsed.anomaly)

    def test_parse_record_empty(self):
        parsed = parse_record(b'')
        self.assertIsNotNone(parsed.anomaly)
        self.assertIn("empty-record", parsed.anomaly)

    def test_parse_record_non_object(self):
        parsed = parse_record(b'[1, 2, 3]')
        self.assertEqual(parsed.payload, [1, 2, 3])
        self.assertEqual(parsed.anomaly, "non-object-json-record")


class TestPiSubprocess(unittest.TestCase):
    def test_exit_code_and_eof(self):
        d = tmpdir()
        spec = {"handlers": {
            "get_state": [{"emit": ['{"id": "@echo", "type": "response", '
                                   '"command": "get_state", "success": true}'],
                           "exit": 7}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            # the response arrives before the exit: request succeeds
            resp = client.request("get_state", timeout=5.0)
            self.assertTrue(resp["success"])
            deadline = time.time() + 5
            while proc.poll() is None and time.time() < deadline:
                time.sleep(0.05)
            self.assertEqual(proc.exit_code, 7)
            # subsequent requests fail with a typed exit error
            time.sleep(0.2)  # let EOF propagate to the dispatcher
            with self.assertRaises(Exception):
                client.request("get_state", timeout=5.0)
        finally:
            proc.close()

    def test_stderr_isolated_from_stdout(self):
        d = tmpdir()
        secret = "sk-abcdef123456789012345"
        spec = {"handlers": {
            "get_state": [{
                "emit": ['{"id": "@echo", "type": "response", '
                         '"command": "get_state", "success": true}'],
                "stderr": "diagnostic noise %s\n" % secret,
            }],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            resp = client.request("get_state", timeout=5.0)
            self.assertTrue(resp["success"])
            deadline = time.time() + 5
            while not proc.stderr_text() and time.time() < deadline:
                time.sleep(0.05)
            stderr_text = proc.stderr_text()
            self.assertIn(secret, stderr_text)
            # stderr content never appears in the JSONL record stream
            items = []
            while True:
                try:
                    item = proc.records.get(timeout=0.3)
                except Exception:
                    break
                if item is EOF_SENTINEL:
                    break
                items.append(item)
            for item in items:
                raw = json.dumps(getattr(item, "payload", None)) + \
                    str(getattr(item, "raw", None))
                self.assertNotIn(secret, raw)
            # and the stderr file received the bytes
            with open(os.path.join(d, "stderr.log"), "rb") as fh:
                self.assertIn(secret.encode(), fh.read())
        finally:
            proc.close()

    def test_invalid_utf8_recorded_as_anomaly(self):
        import base64
        d = tmpdir()
        spec = {
            # b'\xff\xfe{"type": "x"}\n' as raw startup bytes
            "startupRawB64": [base64.b64encode(
                b'\xff\xfe{"type": "x"}\n').decode()],
            "handlers": {},
        }
        proc, client = spawn_fake(spec, d)
        try:
            deadline = time.time() + 5
            while not proc.protocol_anomalies and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(any(
                "invalid-utf8" in (a.anomaly or "")
                for a in proc.protocol_anomalies
            ))
            # process still alive and usable afterwards
            proc.send_json({"id": "t1", "type": "get_state"})
        finally:
            proc.close()

    def test_partial_record_without_lf_at_eof(self):
        import base64
        d = tmpdir()
        spec = {
            "startupRawB64": [base64.b64encode(b'{"partial": 1').decode()],
            "handlers": {},
        }
        proc, client = spawn_fake(spec, d)
        try:
            proc._proc.stdin.close()  # simulate peer going away
            deadline = time.time() + 5
            while not proc.protocol_anomalies and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(any(
                "eof-partial-record-without-lf" in (a.anomaly or "")
                for a in proc.protocol_anomalies
            ))
        finally:
            proc.close()

    def test_close_graceful_exit_zero(self):
        d = tmpdir()
        spec = {"handlers": {}}
        argv = fake_pi_argv(spec, d)
        proc = PiSubprocess(argv, cwd=d)
        code = proc.close(grace_timeout=5.0)
        self.assertEqual(code, 0)
        # idempotent
        self.assertEqual(proc.close(), 0)

    def test_close_terminates_hanging_process(self):
        d = tmpdir()
        spec = {"handlers": {
            "get_state": [{"hang": True}],
        }}
        proc, client = spawn_fake(spec, d)
        try:
            proc.send_json({"id": "t1", "type": "get_state"})
            time.sleep(0.3)  # let the fake enter its sleep
        finally:
            code = proc.close(grace_timeout=1.0)
        self.assertIsNotNone(code)
        self.assertLess(code, 0)  # terminated/killed by signal
        self.assertFalse(proc.alive)

    def test_kill_now(self):
        d = tmpdir()
        spec = {"handlers": {"get_state": [{"hang": True}]}}
        proc, client = spawn_fake(spec, d)
        try:
            proc.send_json({"id": "t1", "type": "get_state"})
            time.sleep(0.2)
        finally:
            code = proc.kill_now()
        self.assertLess(code, 0)
        self.assertFalse(proc.alive)


if __name__ == "__main__":
    unittest.main()
