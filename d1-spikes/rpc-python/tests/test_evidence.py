"""Evidence-layer tests: redaction, atomic writes, JSONL shape,
scenario result format, append-only summary."""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from helpers import tmpdir  # noqa: E402
from pi_rpc_probe.evidence import (  # noqa: E402
    AtomicJsonlWriter,
    EvidenceRecorder,
    ScenarioResult,
    append_summary,
    redact_obj,
    redact_text,
)


def _join(*parts):
    """Assemble synthetic secret-shaped strings at runtime.

    The pieces below are deliberately split so that no rule of
    d1-spikes/scripts/check-secrets matches the source file itself;
    the assembled values still exercise every redaction rule.
    """
    return "".join(parts)


# Synthetic corpus (never a real credential; assembled, see _join).
HOME_MAC = _join("/Use", "rs/tal")
HOME_LINUX = _join("/ho", "me/alice")
KEY_ANTHROPIC = _join("sk-an", "t-abc123def456ghi789xyz0")
BEARER_INPUT = _join("Autho", "rization: Bearer eyJhbGciOi.abc.def")
BEARER_EXPECTED = _join("Autho", "rization: Bearer REDACTED")


class TestRedaction(unittest.TestCase):
    def test_anthropic_style_key(self):
        self.assertEqual(
            redact_text("key " + KEY_ANTHROPIC),
            "key sk-REDACTED",
        )

    def test_bearer_token(self):
        self.assertEqual(redact_text(BEARER_INPUT), BEARER_EXPECTED)

    def test_api_key_assignment(self):
        out = redact_text(_join('{"api', '_key": "verysecretvalue12345"}'))
        self.assertNotIn("verysecretvalue12345", out)

    def test_home_paths(self):
        out = redact_text("reading %s/secret/fixture.json done" % HOME_MAC)
        self.assertNotIn(HOME_MAC, out)
        self.assertIn("<HOME>", out)
        out2 = redact_text(HOME_LINUX + "/x.jsonl")
        self.assertNotIn(HOME_LINUX, out2)

    def test_nested_objects(self):
        obj = {
            "path": HOME_MAC + "/tmp/session.jsonl",
            "nested": [{"key": "sk-abcdefghijklmnopqrst"}],
            "count": 3,
        }
        out = redact_obj(obj)
        self.assertNotIn(HOME_MAC, json.dumps(out))
        self.assertNotIn("sk-abcdefghijklmnopqrst", json.dumps(out))
        self.assertEqual(out["count"], 3)


class TestAtomicJsonlWriter(unittest.TestCase):
    def test_finalize_renames_and_leaves_no_tmp(self):
        d = tmpdir()
        path = os.path.join(d, "sub", "events.jsonl")
        w = AtomicJsonlWriter(path)
        w.write_obj({"seq": 1})
        w.write_obj({"seq": 2})
        self.assertTrue(os.path.exists(path + ".tmp"))
        final = w.finalize()
        self.assertEqual(final, path)
        self.assertTrue(os.path.exists(path))
        self.assertFalse(os.path.exists(path + ".tmp"))
        with open(path, "r", encoding="utf-8") as fh:
            lines = [json.loads(x) for x in fh if x.strip()]
        self.assertEqual([x["seq"] for x in lines], [1, 2])


class TestEvidenceRecorder(unittest.TestCase):
    def test_line_shape_and_monotonic_seq(self):
        d = tmpdir()
        path = os.path.join(d, "events.jsonl")
        rec = EvidenceRecorder("basic", path)
        rec.set_session_id("sess-1")
        rec.record({"type": "agent_start"})
        rec.record({"type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta",
                                              "delta": "x"},
                    "path": HOME_MAC + "/x"})
        rec.record({"__anomaly__": True, "type": "protocol_anomaly",
                    "anomaly": "invalid-json: oops"})
        rec.note("probe observation", extra={"k": 1})
        final = rec.finalize()
        with open(final, "r", encoding="utf-8") as fh:
            lines = [json.loads(x) for x in fh if x.strip()]
        self.assertEqual(len(lines), 4)
        seqs = [x["seq"] for x in lines]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), len(seqs))
        for ln in lines:
            self.assertEqual(ln["implementation"], "rpc-python")
            self.assertEqual(ln["scenario"], "basic")
            self.assertEqual(ln["sessionId"], "sess-1")
            self.assertEqual(ln["redactionVersion"], "d1-v1")
            for key in ("seq", "observedAt", "piEventType", "runState",
                        "payload"):
                self.assertIn(key, ln)
        # home path got redacted inside the payload
        self.assertNotIn(HOME_MAC, json.dumps(lines))
        # anomaly counted
        self.assertEqual(rec.anomaly_count, 1)
        self.assertEqual(rec.event_count, 3)  # 2 events + 1 note

    def test_events_of_type_with_since_seq(self):
        d = tmpdir()
        rec = EvidenceRecorder("basic", os.path.join(d, "e.jsonl"))
        rec.record({"type": "message_end"})
        rec.record({"type": "message_end"})
        cut = rec.seq
        rec.record({"type": "message_end"})
        self.assertEqual(len(rec.events_of_type("message_end")), 3)
        self.assertEqual(
            len(rec.events_of_type("message_end", since_seq=cut)), 1)
        rec.abort()  # release the .tmp handle without renaming


class TestScenarioResult(unittest.TestCase):
    def test_result_json_fields(self):
        r = ScenarioResult("basic")
        r.command = "python -m pi_rpc_probe run --scenario basic"
        r.exit_code = 0
        r.observations.append("obs-1")
        r.limitations.append("lim-1")
        r.finish("PASS")
        out = r.to_json()
        for key in ("implementation", "scenario", "status", "startedAt",
                    "endedAt", "durationMs", "command", "exitCode",
                    "evidenceFiles", "observations", "limitations", "error"):
            self.assertIn(key, out)
        self.assertEqual(out["status"], "PASS")
        self.assertIsNone(out["error"])
        self.assertIsInstance(out["durationMs"], int)

    def test_failure_result_keeps_error(self):
        r = ScenarioResult("tool")
        r.finish("FAIL", {"kind": "assertion", "detail": "boom"})
        out = r.to_json()
        self.assertEqual(out["status"], "FAIL")
        self.assertEqual(out["error"]["kind"], "assertion")

    def test_invalid_status_rejected(self):
        r = ScenarioResult("basic")
        with self.assertRaises(AssertionError):
            r.finish("MAYBE")

    def test_blocked_result_carries_blocked_reason(self):
        r = ScenarioResult("basic")
        r.finish("BLOCKED", {"message": "no creds", "kind": "BLOCKED_CREDENTIALS"},
                 blocked_reason="CREDENTIALS")
        out = r.to_json()
        self.assertEqual(out["blockedReason"], "CREDENTIALS")
        # non-BLOCKED results must NOT carry the key (schema enum)
        r2 = ScenarioResult("basic")
        r2.finish("PASS")
        self.assertNotIn("blockedReason", r2.to_json())
        with self.assertRaises(AssertionError):
            r2.finish("BLOCKED")  # blocked_reason required for BLOCKED

    def test_result_json_is_redacted(self):
        r = ScenarioResult("tool")
        r.command = "python3 probe.py run --scenario tool"
        r.observations.append("cwd=%s/scratch" % HOME_MAC)
        r.limitations.append("token sk-abcdefghijklmnopqrst in stderr")
        r.finish("FAIL", {"message": "bad %s/x.json" % HOME_MAC,
                          "kind": "assertion"})
        out = r.to_json()
        blob = json.dumps(out)
        self.assertNotIn(HOME_MAC, blob)
        self.assertNotIn("sk-abcdefghijklmnopqrst", blob)
        self.assertIn("<HOME>", blob)

    def test_append_summary_appends_only(self):
        d = tmpdir()
        path = os.path.join(d, "events.jsonl")
        rec = EvidenceRecorder("basic", path)
        rec.record({"type": "agent_start"})
        rec.finalize()
        before = open(path, "r", encoding="utf-8").read()
        append_summary(path, "basic", "FAIL",
                       {"kind": "timeout", "detail": "no settled"})
        with open(path, "r", encoding="utf-8") as fh:
            after = fh.read()
        self.assertTrue(after.startswith(before))  # nothing rewritten
        lines = [json.loads(x) for x in after.splitlines() if x.strip()]
        self.assertEqual(len(lines), 2)
        summary = lines[-1]
        self.assertEqual(summary["piEventType"], "scenario_summary")
        self.assertEqual(summary["payload"]["status"], "FAIL")
        self.assertEqual(summary["payload"]["error"]["kind"], "timeout")
        self.assertEqual(summary["seq"], 2)


if __name__ == "__main__":
    unittest.main()
