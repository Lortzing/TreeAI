"""Scenario logic tests against the fake pi server (no real model):

- PASS paths for all five scenarios prove the judgments work;
- FAIL paths (missing deltas, timeout, tool escape, wrong answers) prove
  failures are detected, structured, and leave no process behind;
- BLOCKED_CREDENTIALS path proves no PASS is fabricated without
  credentials (status BLOCKED + blockedReason CREDENTIALS);
- evidence layout matches the shared contract: one
  <scenario>.events.jsonl with strictly increasing seq, one
  <scenario>.result.json; result exitCode is the probe CLI exit code;
- CLI exit codes follow the documented contract.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from pi_rpc_probe import cli  # noqa: E402
from pi_rpc_probe.evidence import BLOCKED_CREDENTIALS  # noqa: E402
from pi_rpc_probe.scenarios import (  # noqa: E402
    FALLBACK_NUMBERS,
    ProbeConfig,
    run_scenario,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import (  # noqa: E402
    FAKE_PI,
    ev,
    fake_pi_argv,
    message_end_line,
    resp,
    streaming_flow,
    tmpdir,
)

VALUES = FALLBACK_NUMBERS["values"]  # 16 digits of pi
EXPECTED = {"count": 16, "sum": 80, "min": 1, "max": 9, "median": 5}
TOOL_ANSWER = ("count: 16\nsum: 80\nmin: 1\nmax: 9\nmedian: 5")


def make_fixture_dir(tmpdir):
    d = os.path.join(tmpdir, "fixtures-src")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "numbers.json"), "w", encoding="utf-8") as fh:
        json.dump(FALLBACK_NUMBERS, fh, indent=2)
    return d


def make_config(tmpdir, spec, timeouts=None, run_dir=""):
    argv = fake_pi_argv(spec, tmpdir)
    return ProbeConfig(
        pi_bin=argv,
        provider="fake-provider",
        model="fake-model",
        evidence_dir=os.path.join(tmpdir, "evidence"),
        fixture_dir=make_fixture_dir(tmpdir),
        request_timeout=10.0,
        scenario_timeouts=timeouts or {"basic": 20.0, "tool": 20.0,
                                       "steer": 20.0, "abort": 20.0,
                                       "resume": 20.0},
        run_dir=run_dir,
    )


class TestBasicScenario(unittest.TestCase):
    def test_pass_with_fake(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session",
                                               data={"cancelled": False})]}],
                "get_state": [{"emit": [resp(
                    "get_state", data={"sessionId": "fake-basic-1",
                                       "sessionFile": "/tmp/f.jsonl"})]}],
                "prompt": [{"emit": streaming_flow("pong")}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("basic", config)
        self.assertEqual(result.status, "PASS", result.error)
        self.assertIsNone(result.error)
        self.assertEqual(result.exit_code, 0)  # probe CLI exit code
        # evidence exists at the fixed contract path and parses as JSON
        jsonl_files = [f for f in result.evidence_files
                       if f.endswith(".jsonl")]
        self.assertEqual(len(jsonl_files), 1)
        self.assertTrue(jsonl_files[0].endswith("/basic.events.jsonl"))
        lines = [json.loads(x) for x in open(jsonl_files[0],
                                             encoding="utf-8")
                 if x.strip()]
        self.assertGreater(len(lines), 10)
        seqs = [ln["seq"] for ln in lines]
        self.assertEqual(seqs, list(range(1, len(lines) + 1)))
        types = {ln["piEventType"] for ln in lines}
        self.assertIn("agent_settled", types)
        self.assertIn("scenario_summary", types)
        # three rounds, one observation per round minimum
        self.assertTrue(any("round 3" in o for o in result.observations))

    def test_fail_when_text_deltas_missing(self):
        d = tmpdir()
        # final text present but no streaming deltas: must FAIL
        flow = [resp("prompt"), ev("agent_start"), ev("turn_start"),
                message_end_line("pong"), ev("turn_end"),
                ev("agent_end", messages=[], willRetry=False),
                ev("agent_settled")]
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp("get_state",
                                             data={"sessionId": "s"})]}],
                "prompt": [{"emit": flow}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("basic", config)
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.exit_code, 1)  # probe CLI exit code
        self.assertEqual(result.error["kind"], "assertion")
        self.assertIn("message", result.error)  # schema requires message
        self.assertIn("round 1", result.error["stage"])
        # the structured error is also the last event of the raw file
        jsonl = [f for f in result.evidence_files if f.endswith(".jsonl")][0]
        summary = [json.loads(x) for x in open(jsonl, encoding="utf-8")
                   if x.strip()][-1]
        self.assertEqual(summary["piEventType"], "scenario_summary")
        self.assertEqual(summary["payload"]["status"], "FAIL")
        self.assertIn("message", summary["payload"]["error"])

    def test_timeout_fails_and_reclaims_process(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "prompt": [{"emit": [resp("prompt")], "hang": True}],
            },
        }
        config = make_config(d, spec, timeouts={"basic": 2.0})
        t0 = time.monotonic()
        result = run_scenario("basic", config)
        elapsed = time.monotonic() - t0
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.error["kind"], "timeout")
        # the scenario honored a tight deadline instead of hanging forever
        self.assertLess(elapsed, 20.0)
        # result exitCode is the probe CLI code (1), pi exit codes observed
        self.assertEqual(result.exit_code, 1)
        self.assertTrue(any("pi subprocess exit codes" in o
                            for o in result.observations))

    def test_blocked_credentials(self):
        d = tmpdir()
        spec = {"handlers": {}}
        config = make_config(d, spec)
        result = run_scenario("basic", config, ready=False,
                              block_reason="provider auth invalid")
        self.assertEqual(result.status, "BLOCKED")
        self.assertEqual(result.error["kind"], BLOCKED_CREDENTIALS)
        self.assertEqual(result.blocked_reason, "CREDENTIALS")
        out = result.to_json()
        self.assertEqual(out["blockedReason"], "CREDENTIALS")
        self.assertEqual(result.exit_code, 2)
        # nothing was spawned: no events evidence for this run
        self.assertEqual(result.evidence_files, [])


class TestToolScenario(unittest.TestCase):
    def _ok_flow(self, final_text=TOOL_ANSWER):
        return [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("message_start", message={"role": "assistant", "content": []}),
            ev("tool_execution_start", toolCallId="c1", toolName="read",
               args={"path": "numbers.json"}),
            ev("tool_execution_end", toolCallId="c1", toolName="read",
               result={"content": [{"type": "text",
                                    "text": json.dumps(
                                        {"values": VALUES})}]},
               isError=False),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "16"}),
            message_end_line(final_text),
            ev("turn_end"), ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),
        ]

    def _fail_flow(self):
        return [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("tool_execution_start", toolCallId="c2", toolName="read",
               args={"path": "missing-file-9f3c21.json"}),
            ev("tool_execution_end", toolCallId="c2", toolName="read",
               result={"content": [{"type": "text",
                                    "text": "File not found"}]},
               isError=True),
            message_end_line("READ_FAILED"),
            ev("turn_end"), ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),
        ]

    def test_pass_with_fake(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp("get_state",
                                             data={"sessionId": "s"})]}],
                "prompt": [{"emit": self._ok_flow()},
                           {"emit": self._fail_flow()}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("tool", config)
        self.assertEqual(result.status, "PASS", result.error)
        # the fixture copy was staged into the temp cwd
        self.assertTrue(any("withinCwd=True" in o
                            for o in result.observations))
        # answers were judged against the staged fixture
        self.assertTrue(any("answersMatchFixture=True" in o
                            for o in result.observations))
        self.assertTrue(any("readonly protection: True" in o
                            for o in result.observations))

    def test_fail_when_answers_do_not_match_fixture(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "prompt": [{"emit": self._ok_flow(
                    final_text="count: 15\nsum: 79\nmin: 1\nmax: 9\n"
                               "median: 5")}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("tool", config)
        self.assertEqual(result.status, "FAIL")
        self.assertFalse(result.error.get("answersMatchFixture", True))
        self.assertEqual(result.error.get("expected"), EXPECTED)

    def test_fail_when_tool_escapes_cwd(self):
        d = tmpdir()
        ok_flow = [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("tool_execution_start", toolCallId="c1", toolName="read",
               args={"path": "../../etc/passwd"}),
            ev("tool_execution_end", toolCallId="c1", toolName="read",
               result={"content": [{"type": "text", "text": "root:x:0:0"}]},
               isError=False),
            message_end_line(TOOL_ANSWER),
            ev("turn_end"), ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),
        ]
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "prompt": [{"emit": ok_flow}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("tool", config)
        self.assertEqual(result.status, "FAIL")
        self.assertIn("tool", result.error["stage"])

    def test_run_dir_mode_with_readonly_protection(self):
        d = tmpdir()
        # simulate a make-run-dir output: fixtures copy + readonly + work
        run_dir = os.path.join(d, "run")
        os.makedirs(os.path.join(run_dir, "fixtures", "readonly"))
        os.makedirs(os.path.join(run_dir, "work"))
        with open(os.path.join(run_dir, "fixtures", "numbers.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(FALLBACK_NUMBERS, fh)
        ro = os.path.join(run_dir, "fixtures", "readonly", "notes.md")
        with open(ro, "w", encoding="utf-8") as fh:
            fh.write("read-only\n")
        os.chmod(ro, 0o444)
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp("get_state",
                                             data={"sessionId": "s"})]}],
                "prompt": [{"emit": self._ok_flow()},
                           {"emit": self._fail_flow()}],
            },
        }
        config = make_config(d, spec, run_dir=run_dir)
        result = run_scenario("tool", config)
        self.assertEqual(result.status, "PASS", result.error)
        self.assertTrue(any("write denied as required" in o
                            for o in result.observations))
        # the run dir itself is NOT deleted by the probe (caller owns it)
        self.assertTrue(os.path.isdir(run_dir))
        self.assertTrue(os.path.isfile(
            os.path.join(run_dir, "fixtures", "numbers.json")))
        os.chmod(ro, 0o644)  # cleanup


class TestSteerScenario(unittest.TestCase):
    def test_pass_with_fake(self):
        d = tmpdir()
        initial = [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("message_start", message={"role": "assistant", "content": []}),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "1 "}),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "2 "}),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "3 "}),
            # deliberately no settled here: the turn is interrupted by steer
        ]
        steer_effect = [
            resp("steer"),
            ev("queue_update", steering=["Stop counting now."],
               followUp=[]),
            ev("queue_update", steering=[], followUp=[]),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "steered"}),
            message_end_line("steered"),
            ev("turn_end"), ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),
        ]
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp(
                    "get_state", data={"sessionId": "steer-sess-1",
                                       "sessionFile": "/tmp/s.jsonl"})]}],
                "get_messages": [{"emit": [resp("get_messages", data={
                    "messages": [
                        {"role": "user", "content": "Stop counting now. "
                                                    "Reply with exactly "
                                                    "the word: steered"},
                    ]})]}],
                "prompt": [{"emit": initial}],
                "steer": [{"emit": steer_effect}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("steer", config)
        self.assertEqual(result.status, "PASS", result.error)
        self.assertTrue(any("sessionIdUnchanged=True" in o
                            for o in result.observations))

    def test_fail_when_output_ignores_steer(self):
        d = tmpdir()
        initial = [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "1 "}),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "2 "}),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "3 "}),
        ]
        steer_effect = [
            resp("steer"),
            message_end_line("4 5 6 7 8 9 10"),  # steer ignored
            ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),
        ]
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp(
                    "get_state", data={"sessionId": "steer-sess-1"})]}],
                "prompt": [{"emit": initial}],
                "steer": [{"emit": steer_effect}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("steer", config)
        self.assertEqual(result.status, "FAIL")
        self.assertFalse(result.error.get("reflected", True))


class TestAbortScenario(unittest.TestCase):
    def test_pass_with_fake(self):
        d = tmpdir()
        abortable = [
            resp("prompt"),
            ev("agent_start"), ev("turn_start"),
            ev("message_update", usage={}, assistantMessageEvent={
                "type": "text_delta", "contentIndex": 0, "delta": "1 "}),
            message_end_line("1 2", stop_reason="aborted"),
            ev("agent_settled"),  # stale settled: must be ignored via since
        ]
        abort_effect = [
            resp("abort"),
            ev("agent_end", messages=[], willRetry=False),
            ev("agent_settled"),  # the settled that counts
        ]
        followup = streaming_flow("again")
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp("get_state",
                                             data={"sessionId": "a"})]}],
                "prompt": [{"emit": abortable}, {"emit": followup}],
                "abort": [{"emit": abort_effect}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("abort", config)
        self.assertEqual(result.status, "PASS", result.error)
        self.assertTrue(any("stopReasons=['aborted']" in o
                            for o in result.observations))


class TestResumeScenario(unittest.TestCase):
    def test_pass_with_fake_two_processes(self):
        d = tmpdir()
        ack_flow = streaming_flow("ACKNOWLEDGED")
        recall_flow = streaming_flow("RIVER-MOON-77")
        spec = {
            "counterFile": os.path.join(d, "counter.json"),
            "handlers": {
                "get_state": [{"emit": [resp(
                    "get_state",
                    data={"sessionId": "resume-sess-1",
                          "sessionFile": "/tmp/resume-sess-1.jsonl"})],
                    "stderr": "fake session log line\n"}],
                "get_messages": [{"emit": [resp("get_messages", data={
                    "messages": [
                        {"role": "user",
                         "content": "Remember this secret code word: "
                                    "RIVER-MOON-77."},
                        {"role": "assistant", "content": "ACKNOWLEDGED"},
                    ]})]}],
                "prompt": [{"emit": ack_flow}, {"emit": recall_flow}],
            },
        }
        config = make_config(d, spec)
        result = run_scenario("resume", config)
        self.assertEqual(result.status, "PASS", result.error)
        # two host processes ran (phase A and phase B)
        self.assertTrue(any("phase A: process exit code=0" in o
                            for o in result.observations))
        self.assertTrue(any("historyHasCodeWord=True" in o
                            for o in result.observations))
        # ... but ONE shared events file with a continuous seq
        jsonl_files = [f for f in result.evidence_files
                       if f.endswith(".jsonl")]
        self.assertEqual(len(jsonl_files), 1)
        lines = [json.loads(x) for x in open(jsonl_files[0],
                                             encoding="utf-8")
                 if x.strip()]
        seqs = [ln["seq"] for ln in lines]
        self.assertEqual(seqs, list(range(1, len(lines) + 1)))
        # both processes' stderr notes folded into the same file
        notes = [ln for ln in lines if ln["piEventType"] == "probe_note"]
        self.assertGreaterEqual(len(notes), 2)


class TestCliExitCodes(unittest.TestCase):
    def _wrapper(self, tmpdir, spec):
        argv = fake_pi_argv(spec, tmpdir)
        wrapper = os.path.join(tmpdir, "fake-pi-wrapper.sh")
        with open(wrapper, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexec %s \"%s\" \"%s\" \"$@\"\n"
                     % (json.dumps(argv[0]), argv[1], argv[2]))
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
        return wrapper

    def test_run_pass_exits_zero(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "get_state": [{"emit": [resp(
                    "get_state", data={"sessionId": "s",
                                       "sessionFile": "/tmp/s.jsonl"})]}],
                "prompt": [{"emit": streaming_flow("pong")}],
            },
        }
        wrapper = self._wrapper(d, spec)
        out = os.path.join(d, "evidence")
        with mock.patch("pi_rpc_probe.cli.check_environment",
                        return_value=(True, {"authCheck": {"stdout": "ready"},
                                             "python": {"version": "3.x"},
                                             "piVersion": {"stdout": "0.0"}})):
            code = cli.main([
                "run", "--scenario", "basic",
                "--pi-bin", wrapper,
                "--provider", "fake", "--model", "fake-model",
                "--out", out,
                "--request-timeout", "10",
            ])
        self.assertEqual(code, 0)
        # result file at the fixed contract path
        self.assertTrue(os.path.isfile(os.path.join(out,
                                                   "basic.result.json")))
        with open(os.path.join(out, "basic.result.json"),
                  encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["status"], "PASS")
        self.assertEqual(data["exitCode"], 0)
        self.assertTrue(data["command"])
        self.assertTrue(any(o.startswith("env:") for o in data["observations"]))

    def test_run_failure_exits_one(self):
        d = tmpdir()
        spec = {
            "handlers": {
                "new_session": [{"emit": [resp("new_session")]}],
                "prompt": [{"emit": [resp("prompt"), ev("agent_start"),
                                      message_end_line("wrong"),
                                      ev("agent_settled")]}],
            },
        }
        wrapper = self._wrapper(d, spec)
        out = os.path.join(d, "evidence")
        with mock.patch("pi_rpc_probe.cli.check_environment",
                        return_value=(True, {"authCheck": {"stdout": "ready"},
                                             "python": {"version": "3.x"},
                                             "piVersion": {"stdout": "0.0"}})):
            code = cli.main([
                "run", "--scenario", "basic",
                "--pi-bin", wrapper,
                "--provider", "fake", "--model", "fake-model",
                "--out", out,
            ])
        self.assertEqual(code, 1)
        with open(os.path.join(out, "basic.result.json"),
                  encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["status"], "FAIL")
        self.assertEqual(data["exitCode"], 1)
        self.assertIn("message", data["error"])

    def test_run_blocked_exits_two(self):
        d = tmpdir()
        out = os.path.join(d, "evidence")
        with mock.patch("pi_rpc_probe.cli.check_environment",
                        return_value=(False, {"authCheck": {"stdout":
                                                            "invalid"},
                                              "python": {"version": "3.x"},
                                              "piVersion": {"stdout": "0.0"}})):
            code = cli.main([
                "run", "--scenario", "basic",
                "--pi-bin", "pi",
                "--provider", "nope", "--model", "nope",
                "--out", out,
            ])
        self.assertEqual(code, 2)
        with open(os.path.join(out, "basic.result.json"),
                  encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["status"], "BLOCKED")
        self.assertEqual(data["blockedReason"], "CREDENTIALS")
        self.assertEqual(data["exitCode"], 2)


if __name__ == "__main__":
    unittest.main()
