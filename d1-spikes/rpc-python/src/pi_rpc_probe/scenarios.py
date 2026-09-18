"""Five unified D1 scenarios driven over the pi RPC protocol.

Scenarios: basic, tool, steer, abort, resume. Pass conditions follow the D1
task book section 7 and the shared fixture contract (Agent D,
d1-spikes/fixtures/README.txt section 4), so the judgments match what the
SDK probe (Agent B) must apply and the comparison stays fair.

Every scenario:
- runs against a temp working copy (never the repo itself); the tool scenario
  prefers a make-run-dir copy of the shared fixtures when available;
- uses a minimal tool allowlist (the tool scenario allows only `read`);
- enforces a total deadline (watchdog thread kill_now()s the subprocess if
  the scenario code is stuck);
- releases the subprocess in a finally block and verifies it is gone;
- writes ONE redacted raw-event JSONL per scenario at
  d1-spikes/evidence/rpc/<scenario>.events.jsonl plus a structured result
  JSON at <scenario>.result.json, including on failure (last known events +
  structured error with a `message` field, per the shared schemas). No PASS
  is ever fabricated: without usable credentials the status is BLOCKED with
  blockedReason=CREDENTIALS.

Exit-code semantics of the result file (shared schema contract): exitCode is
the probe CLI exit code a third party re-running `command` would observe --
0 for PASS, 1 for FAIL, 2 for BLOCKED. The pi subprocess exit codes are
recorded as observations instead.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple, Union

from .client import (
    PiRpcClient,
    ProcessExitedError,
    RpcTimeoutError,
)
from .evidence import (
    BLOCKED_CREDENTIALS,
    EvidenceRecorder,
    ScenarioResult,
    append_summary,
    redact_text,
)
from .transport import PiSubprocess

SCENARIOS = ("basic", "tool", "steer", "abort", "resume")

# Shared prompt corpus (must match the SDK probe; alignment with Agent B is
# recorded as PENDING in evidence until Agent B's spike exists).
PROMPT_BASIC = "Reply with exactly the word: pong"
# Tool scenario: the four standard verification questions from the shared
# fixture contract (d1-spikes/fixtures/README.txt section 4). Expected
# answers are computed by the probe from numbers.json itself -- never taken
# from the model's claim alone.
PROMPT_TOOL_OK = (
    "Read the file numbers.json in the current working directory. It "
    "contains a JSON object with a key \"values\" holding a list of "
    "integers. Answer four questions about that list, each on its own "
    "line, exactly in the form 'count: N', 'sum: N', 'min: N', 'max: N', "
    "'median: N': (1) how many elements does values contain, (2) what is "
    "the sum of values, (3) what are the minimum and maximum of values, "
    "(4) what is the median of values."
)
PROMPT_TOOL_MISSING = (
    "Read the file missing-file-9f3c21.json in the current working directory "
    "and report its full contents. If the file cannot be read, reply with "
    "exactly: READ_FAILED"
)
PROMPT_STEER_INITIAL = "Count slowly from 1 to 30, one number per line."
PROMPT_STEER_REDIRECT = (
    "Stop counting now. Reply with exactly the word: steered"
)
PROMPT_ABORT_INITIAL = "Count slowly from 1 to 100, one number per line."
PROMPT_ABORT_FOLLOWUP = "Reply with exactly the word: again"
PROMPT_RESUME_A = (
    "Remember this secret code word: RIVER-MOON-77. Reply with exactly: "
    "ACKNOWLEDGED"
)
PROMPT_RESUME_B = (
    "What secret code word did I tell you earlier in this session? Reply "
    "with just the code word."
)

# Fallback fixture content, byte-identical in shape to the shared
# d1-spikes/fixtures/numbers.json (Agent D). Only used when no fixture
# directory can be located at all; expected answers are always computed
# from whichever numbers.json the scenario actually staged.
FALLBACK_NUMBERS = {
    "fixtureVersion": "d1-v1",
    "dataset": "treeai-d1-numbers",
    "values": [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3],
}


class ScenarioError(Exception):
    """Raised inside a scenario to mark it FAIL with a structured error."""


class ScenarioTimeout(ScenarioError):
    pass


class ProbeConfig:
    def __init__(
        self,
        pi_bin: Union[str, List[str]] = "pi",
        provider: str = "",
        model: str = "",
        thinking: str = "off",
        evidence_dir: str = "",
        fixture_dir: str = "",
        request_timeout: float = 120.0,
        scenario_timeouts: Optional[Dict[str, float]] = None,
        d1_root: str = "",
        run_dir: str = "",
        command: str = "",
    ) -> None:
        self.pi_bin = pi_bin
        self.provider = provider
        self.model = model
        self.thinking = thinking
        self.evidence_dir = evidence_dir
        self.fixture_dir = fixture_dir
        self.request_timeout = request_timeout
        self.scenario_timeouts = scenario_timeouts or {}
        # d1-spikes root; used to write evidenceFiles paths relative to it
        # (shared schema contract), e.g. "evidence/rpc/basic.events.jsonl".
        self.d1_root = d1_root
        # Optional make-run-dir output: <run>/fixtures is the fixture copy,
        # <run>/work is writable, <run> itself is the tool scenario cwd.
        self.run_dir = run_dir
        # Optional full replayable command recorded in result.json.
        self.command = command

    def timeout_for(self, scenario: str, default: float = 240.0) -> float:
        return float(self.scenario_timeouts.get(scenario, default))

    def rel_to_d1_root(self, path: str) -> str:
        """Evidence path relative to the d1-spikes root when possible."""
        if self.d1_root:
            try:
                rel = os.path.relpath(path, self.d1_root)
                if not rel.startswith(".."):
                    return rel.replace(os.sep, "/")
            except ValueError:  # pragma: no cover - different drives
                pass
        return path


def build_argv(config: ProbeConfig, extra: List[str]) -> List[str]:
    """Build the pi subprocess argv.

    pi_bin may be a string (executable name) or a list (e.g. a python
    interpreter plus a fake server script for protocol unit tests).
    """
    if isinstance(config.pi_bin, (list, tuple)):
        base = [str(x) for x in config.pi_bin]
    else:
        base = [config.pi_bin]
    argv = base + [
        "--mode", "rpc",
        "--provider", config.provider,
        "--model", config.model,
        "--thinking", config.thinking,
    ]
    return argv + extra


class PiProcessProbe:
    """One pi subprocess + correlated client, recording into ONE shared
    EvidenceRecorder per scenario (so a multi-process scenario like resume
    produces a single events.jsonl with a continuous seq)."""

    def __init__(
        self,
        config: ProbeConfig,
        scenario: str,
        extra_args: List[str],
        cwd: str,
        label: str,
        recorder: EvidenceRecorder,
    ) -> None:
        self.scenario = scenario
        self.label = label
        self.argv = build_argv(config, extra_args)
        self.cwd = cwd
        self.recorder = recorder
        # stderr is captured to its own file (NEVER into the JSONL parser);
        # after process exit the redacted tail is folded into the events
        # file as a probe_note and the raw file is removed, keeping the
        # evidence directory limited to schema-checkable artifacts.
        self.stderr_path = os.path.join(
            config.evidence_dir,
            "%s.stderr-%s.log" % (scenario, label),
        )
        os.makedirs(config.evidence_dir, exist_ok=True)
        self.proc = PiSubprocess(
            self.argv, cwd=cwd, stderr_path=self.stderr_path
        )
        self.client = PiRpcClient(
            self.proc, request_timeout=config.request_timeout
        )
        self.client.subscribe(self._on_record)
        self.client.start()
        self.closed = False

    def _on_record(self, obj: Dict[str, Any]) -> None:
        if not obj.get("__anomaly__"):
            self.recorder.set_run_state(self.client.run_state)
        self.recorder.record(obj)

    def request(self, command: str, payload: Optional[Dict[str, Any]] = None,
                timeout: Optional[float] = None) -> Dict[str, Any]:
        resp = self.client.request(command, payload, timeout=timeout)
        if resp.get("success") is not True:
            raise ScenarioError(
                "command %s failed: %s" % (command, resp.get("error"))
            )
        return resp

    def refresh_session_id(self) -> Optional[str]:
        resp = self.request("get_state")
        sid = (resp.get("data") or {}).get("sessionId")
        self.recorder.set_session_id(str(sid) if sid else "unknown")
        return sid

    def wait_settled(self, timeout: float,
                     since_index: Optional[int] = None
                     ) -> Optional[Dict[str, Any]]:
        ev = self.client.wait_for_event(
            lambda e: e.get("type") == "agent_settled", timeout,
            since_index=since_index,
        )
        return ev

    def prompt_and_wait(self, message: str, timeout: float,
                        streaming_behavior: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"message": message}
        if streaming_behavior:
            payload["streamingBehavior"] = streaming_behavior
        t0 = time.monotonic()
        # events belonging to this prompt are those logged after this index
        idx = self.client.event_log_len()
        resp = self.request("prompt", payload)
        settled = self.wait_settled(timeout, since_index=idx)
        if settled is None:
            raise ScenarioTimeout(
                "no agent_settled within %.0fs after prompt" % timeout
            )
        return {"response": resp, "settled": settled,
                "elapsed": time.monotonic() - t0, "sinceIndex": idx}

    # -- lifecycle ----------------------------------------------------------

    def _fold_stderr(self) -> None:
        """Fold the redacted stderr tail into the events file, delete raw."""
        try:
            with open(self.stderr_path, "rb") as fh:
                data = fh.read()
        except OSError:
            return
        try:
            os.remove(self.stderr_path)
        except OSError:  # pragma: no cover
            pass
        text = data[-8192:].decode("utf-8", "replace")
        if text.strip():
            self.recorder.note(
                "pi stderr (%s), redacted tail" % self.label,
                stderr=redact_text(text),
            )

    def close(self, grace_timeout: float = 10.0) -> Optional[int]:
        if self.closed:
            return self.proc.exit_code
        self.closed = True
        code = self.proc.close(grace_timeout=grace_timeout)
        self._fold_stderr()
        return code

    def force_kill(self) -> Optional[int]:
        code = self.proc.kill_now()
        self._fold_stderr()
        return code


# ---------------------------------------------------------------------------
# Event extraction helpers (work on recorder evidence lines)
# ---------------------------------------------------------------------------

def _payloads(recorder: EvidenceRecorder, pi_type: str,
              since_seq: int = 0) -> List[Dict[str, Any]]:
    return [ln["payload"]
            for ln in recorder.events_of_type(pi_type, since_seq=since_seq)]


def concatenated_text_deltas(recorder: EvidenceRecorder,
                             since_seq: int = 0) -> str:
    parts: List[str] = []
    for ev in _payloads(recorder, "message_update", since_seq):
        ame = ev.get("assistantMessageEvent") or {}
        if ame.get("type") == "text_delta":
            parts.append(ame.get("delta") or "")
    return "".join(parts)


def assistant_texts(recorder: EvidenceRecorder,
                    since_seq: int = 0) -> List[str]:
    texts: List[str] = []
    for ev in _payloads(recorder, "message_end", since_seq):
        msg = ev.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    texts.append(block.get("text") or "")
        elif isinstance(content, str):
            texts.append(content)
    return texts


def last_assistant_text(recorder: EvidenceRecorder,
                        since_seq: int = 0) -> str:
    texts = assistant_texts(recorder, since_seq)
    return texts[-1] if texts else ""


def stop_reasons(recorder: EvidenceRecorder,
                 since_seq: int = 0) -> List[str]:
    reasons: List[str] = []
    for ev in _payloads(recorder, "message_end", since_seq):
        msg = ev.get("message") or {}
        if msg.get("stopReason"):
            reasons.append(str(msg["stopReason"]))
    return reasons


def tool_events(recorder: EvidenceRecorder,
                since_seq: int = 0) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for t in ("tool_execution_start", "tool_execution_update",
              "tool_execution_end"):
        out.extend(_payloads(recorder, t, since_seq))
    return out


def queue_updates(recorder: EvidenceRecorder,
                  since_seq: int = 0) -> List[Dict[str, Any]]:
    return _payloads(recorder, "queue_update", since_seq)


def count_text_deltas(recorder: EvidenceRecorder,
                      since_seq: int = 0) -> int:
    n = 0
    for ev in _payloads(recorder, "message_update", since_seq):
        ame = ev.get("assistantMessageEvent") or {}
        if ame.get("type") == "text_delta":
            n += 1
    return n


# ---------------------------------------------------------------------------
# Fixture staging (shared fixtures contract, Agent D)
# ---------------------------------------------------------------------------

def expected_answers(numbers_path: str) -> Dict[str, Union[int, float]]:
    """Compute the four standard verification answers from numbers.json.

    Judgments are made against the fixture file itself, never against the
    model's claim (fixtures/README.txt section 4).
    """
    with open(numbers_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    values = data["values"]
    n = len(values)
    s = sum(values)
    ordered = sorted(values)
    if n % 2:
        med: Union[int, float] = ordered[n // 2]
    else:
        med = (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0
        if med == int(med):
            med = int(med)
    return {"count": n, "sum": s, "min": ordered[0], "max": ordered[-1],
            "median": med}


def _answer_matches(text: str, label: str,
                    value: Union[int, float]) -> bool:
    """'count: 16' (colon optional, flexible whitespace) matches value."""
    esc = re.sub(r"\.0$", "", str(value))
    pat = r"%s\s*:?\s*%s\b" % (re.escape(label), re.escape(esc))
    return re.search(pat, text, re.IGNORECASE) is not None


def _stage_fixture(config: ProbeConfig, tmpdir: str) -> str:
    """Stage numbers.json into the temp working dir; returns its path.

    Never edits the fixture source. When config.run_dir is set (a
    make-run-dir output) the caller uses the run dir directly instead.
    """
    numbers = os.path.join(tmpdir, "numbers.json")
    src = config.fixture_dir
    src_numbers = os.path.join(src, "numbers.json") if src else ""
    if src_numbers and os.path.isfile(src_numbers):
        shutil.copy2(src_numbers, numbers)
    else:
        # no fixture directory located at all: stage the canonical dataset
        # so the probe stays runnable; expected answers are still computed
        # from the staged file, so no judgment is fabricated
        with open(numbers, "w", encoding="utf-8") as fh:
            json.dump(FALLBACK_NUMBERS, fh, indent=2)
            fh.write("\n")
    return numbers


def _check_readonly_protection(cwd: str) -> Tuple[bool, str]:
    """Verify readonly/ inside a fixture copy rejects writes.

    Host-side check of the run dir property (fixtures/README.txt: a write
    attempt inside readonly/ is expected to fail). In run-dir mode the
    scenario cwd IS the fixtures copy, so readonly/ sits directly in cwd.
    """
    readonly = os.path.join(cwd, "readonly")
    probe_file = os.path.join(readonly, "notes.md")
    if not os.path.isdir(readonly):
        return True, "no readonly/ dir in cwd (plain temp staging)"
    try:
        with open(probe_file, "ab") as fh:
            fh.write(b"")
        # write succeeded where it must fail
        return False, "readonly/notes.md accepted a write (must be denied)"
    except PermissionError:
        return True, "readonly/notes.md write denied as required"
    except OSError as exc:
        return True, "readonly write failed (%s)" % type(exc).__name__


# ---------------------------------------------------------------------------
# Scenario implementations
# ---------------------------------------------------------------------------

def scenario_basic(config: ProbeConfig, deadline: float,
                   recorder: EvidenceRecorder,
                   register=None) -> Tuple[str, Optional[Dict[str, Any]],
                                          List[str], List[str]]:
    observations: List[str] = []
    limitations: List[str] = [
        "basic runs 3 prompt/settled cycles in one process (one session each); "
        "'three consecutive runs' interpreted as three full prompt cycles"
    ]
    probe = PiProcessProbe(
        config, "basic",
        extra_args=["--no-session"],
        cwd=tempfile.mkdtemp(prefix="d1-basic-"),
        label="p1",
        recorder=recorder,
    )
    if register:
        register(probe)
    tmpdir = probe.cwd
    try:
        _check_deadline(deadline)
        observations.append(
            "argv=%s" % redact_text(" ".join(probe.argv))
        )
        for rnd in range(1, 4):
            _check_deadline(deadline)
            base_seq = recorder.seq
            rem = deadline - time.monotonic()
            probe.request("new_session")
            out = probe.prompt_and_wait(
                PROMPT_BASIC, timeout=min(rem, config.request_timeout)
            )
            deltas = concatenated_text_deltas(recorder, base_seq)
            texts = assistant_texts(recorder, base_seq)
            reasons = stop_reasons(recorder, base_seq)
            full_text = "\n".join(texts)
            round_ok = (
                bool(deltas)
                and deltas in full_text
                and any(r == "stop" for r in reasons)
                and "pong" in full_text.lower()
            )
            observations.append(
                "round %d: settledAfter=%.2fs textDeltas=%d stopReasons=%s "
                "assembledInFinal=%s"
                % (rnd, out["elapsed"],
                   count_text_deltas(recorder, base_seq),
                   reasons, deltas in full_text)
            )
            if not round_ok:
                return "FAIL", _err("assertion",
                                    "basic round %d judgments failed" % rnd,
                                    stage="basic round %d" % rnd,
                                    deltas=deltas[:200],
                                    finalTexts=texts[:5],
                                    stopReasons=reasons,
                                    ), observations, limitations
        sid = probe.refresh_session_id()
        observations.append("sessionId after rounds: %r (no-session mode)"
                            % (sid,))
        return "PASS", None, observations, limitations
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        return "FAIL", _err("timeout", str(exc)), observations, limitations
    except ProcessExitedError as exc:
        return "FAIL", _err("process-exited", str(exc),
                            exit_code=exc.exit_code), observations, limitations
    except ScenarioError as exc:
        return "FAIL", _err("command", str(exc)), observations, limitations
    finally:
        probe.close()
        shutil.rmtree(tmpdir, ignore_errors=True)


def scenario_tool(config: ProbeConfig, deadline: float,
                  recorder: EvidenceRecorder,
                  register=None) -> Tuple[str, Optional[Dict[str, Any]],
                                         List[str], List[str]]:
    observations: List[str] = []
    limitations: List[str] = []
    if config.run_dir and os.path.isdir(config.run_dir):
        # make-run-dir output (shared fixtures contract): cwd is the frozen
        # fixtures copy (numbers.json + protected readonly/ directly in
        # cwd, so the standard prompt works verbatim); work/ stays
        # available for outputs and the caller owns deletion
        cwd = os.path.join(config.run_dir, "fixtures")
        numbers_path = os.path.join(cwd, "numbers.json")
        if not os.path.isfile(numbers_path):
            return "FAIL", _err(
                "fixture", "numbers.json missing in run dir %s"
                % redact_text(config.run_dir)
            ), observations, limitations
    else:
        cwd = tempfile.mkdtemp(prefix="d1-tool-")
        numbers_path = _stage_fixture(config, cwd)
    try:
        expected = expected_answers(numbers_path)
    except (OSError, ValueError, KeyError) as exc:
        return "FAIL", _err("fixture", "cannot compute expected answers "
                            "from numbers.json: %s" % exc
                            ), observations, limitations

    # host-side verification of the readonly/ contract (when present)
    ro_ok, ro_detail = _check_readonly_protection(cwd)
    observations.append("readonly protection: %s (%s)" % (ro_ok, ro_detail))
    if not ro_ok:
        return "FAIL", _err("fixture", ro_detail), observations, limitations

    probe = PiProcessProbe(
        config, "tool",
        extra_args=["--no-session", "--tools", "read"],
        cwd=cwd,
        label="p1",
        recorder=recorder,
    )
    if register:
        register(probe)
    owns_tmp = cwd.startswith(tempfile.gettempdir()) and \
        not config.run_dir
    try:
        _check_deadline(deadline)
        observations.append(
            "argv=%s cwd=%s" % (redact_text(" ".join(probe.argv)),
                                redact_text(cwd))
        )
        observations.append(
            "expected answers computed from staged numbers.json: %s"
            % json.dumps(expected, sort_keys=True)
        )

        # -- happy path: Q1-Q4 verification questions --------------------
        base_seq = recorder.seq
        rem = deadline - time.monotonic()
        out = probe.prompt_and_wait(
            PROMPT_TOOL_OK, timeout=min(rem, config.request_timeout)
        )
        starts = [e for e in tool_events(recorder, base_seq)
                  if e.get("type") == "tool_execution_start"]
        ends = [e for e in tool_events(recorder, base_seq)
                if e.get("type") == "tool_execution_end"]
        if not starts:
            return "FAIL", _err("assertion", "no tool_execution_start observed",
                                stage="tool ok"), observations, limitations
        tool_names = sorted({str(s.get("toolName")) for s in starts})
        args_paths = [json.dumps(s.get("args")) for s in starts]
        # tool must only touch the authorized fixture copy
        within = all(_args_within_cwd(s.get("args"), cwd) for s in starts)
        final_text = last_assistant_text(recorder, base_seq)
        answers_ok = all(
            _answer_matches(final_text, label, value)
            for label, value in expected.items()
        )
        ok = (
            tool_names == ["read"]
            and within
            and bool(ends)
            and all(not e.get("isError") for e in ends)
            and answers_ok
        )
        observations.append(
            "tool ok: toolNames=%s withinCwd=%s ends=%d isErrorAny=%s "
            "answersMatchFixture=%s settledAfter=%.2fs"
            % (tool_names, within, len(ends),
               any(e.get("isError") for e in ends),
               answers_ok, out["elapsed"])
        )
        observations.append("tool args: %s"
                            % redact_text("; ".join(args_paths)))
        if not ok:
            return "FAIL", _err(
                "assertion", "tool happy path failed",
                stage="tool ok", toolNames=tool_names,
                withinCwd=within, answersMatchFixture=answers_ok,
                expected=expected, finalText=final_text[:400],
            ), observations, limitations

        # -- failure path: missing file ---------------------------------
        base_seq2 = recorder.seq
        rem = deadline - time.monotonic()
        probe.request("new_session")
        out2 = probe.prompt_and_wait(
            PROMPT_TOOL_MISSING, timeout=min(rem, config.request_timeout)
        )
        starts2 = [e for e in tool_events(recorder, base_seq2)
                   if e.get("type") == "tool_execution_start"]
        ends2 = [e for e in tool_events(recorder, base_seq2)
                 if e.get("type") == "tool_execution_end"]
        err_flags = [bool(e.get("isError")) for e in ends2]
        final2 = last_assistant_text(recorder, base_seq2)
        fail_ok = (
            bool(starts2)
            and any(err_flags)
            and "READ_FAILED" in final2.upper()
        )
        observations.append(
            "tool fail: starts=%d isErrorFlags=%s finalMentionsFailure=%s "
            "settledAfter=%.2fs"
            % (len(starts2), err_flags,
               "READ_FAILED" in final2.upper(), out2["elapsed"])
        )
        if not fail_ok:
            return "FAIL", _err(
                "assertion", "tool failure path not clearly observable",
                stage="tool fail", isErrorFlags=err_flags,
                finalText=final2[:400],
            ), observations, limitations
        return "PASS", None, observations, limitations
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        return "FAIL", _err("timeout", str(exc)), observations, limitations
    except ProcessExitedError as exc:
        return "FAIL", _err("process-exited", str(exc),
                            exit_code=exc.exit_code), observations, limitations
    except ScenarioError as exc:
        return "FAIL", _err("command", str(exc)), observations, limitations
    finally:
        probe.close()
        if owns_tmp:
            shutil.rmtree(cwd, ignore_errors=True)


def scenario_steer(config: ProbeConfig, deadline: float,
                   recorder: EvidenceRecorder,
                   register=None) -> Tuple[str, Optional[Dict[str, Any]],
                                          List[str], List[str]]:
    observations: List[str] = []
    limitations: List[str] = [
        "steer delivery timing is inferred from queue_update events and the "
        "next assistant message; the protocol has no explicit "
        "'steer delivered' event"
    ]
    probe = PiProcessProbe(
        config, "steer",
        extra_args=["--no-session"],
        cwd=tempfile.mkdtemp(prefix="d1-steer-"),
        label="p1",
        recorder=recorder,
    )
    if register:
        register(probe)
    tmpdir = probe.cwd
    try:
        _check_deadline(deadline)
        base_seq = recorder.seq
        probe.request("new_session")
        sid = probe.refresh_session_id()

        rem = deadline - time.monotonic()
        # events belonging to this prompt are those logged after this index;
        # capture BEFORE sending so dispatcher races cannot skip them
        prompt_idx = probe.client.event_log_len()
        resp = probe.request(
            "prompt", {"message": PROMPT_STEER_INITIAL},
            timeout=min(rem, config.request_timeout),
        )

        # wait until the answer is actively streaming
        deltas_before = 0
        while deltas_before < 3:
            _check_deadline(deadline)
            got = probe.client.wait_for_event(
                lambda e: (e.get("type") == "message_update"
                           and (e.get("assistantMessageEvent") or {})
                           .get("type") == "text_delta"),
                timeout=max(1.0, deadline - time.monotonic()),
                since_index=prompt_idx,
            )
            if got is None:
                raise ScenarioTimeout("streaming never started before steer")
            deltas_before = count_text_deltas(recorder, base_seq)

        steer_sent_at = time.monotonic()
        steer_idx = probe.client.event_log_len()
        steer_resp = probe.client.request(
            "steer", {"message": PROMPT_STEER_REDIRECT},
            timeout=min(deadline - time.monotonic(), config.request_timeout),
        )
        steer_answered_at = time.monotonic()
        if steer_resp.get("success") is not True:
            return "FAIL", _err(
                "assertion", "steer command rejected",
                stage="steer", response=steer_resp,
            ), observations, limitations

        settled = probe.wait_settled(deadline - time.monotonic(),
                                     since_index=steer_idx)
        if settled is None:
            raise ScenarioTimeout("no agent_settled after steer")
        settled_at = time.monotonic()

        queues = queue_updates(recorder, base_seq)
        sid_after = probe.refresh_session_id()
        final_text = last_assistant_text(recorder, base_seq)
        msgs_resp = probe.client.request("get_messages")
        messages = (msgs_resp.get("data") or {}).get("messages") or []
        steer_msg_in_history = any(
            isinstance(m, dict) and PROMPT_STEER_REDIRECT[:30] in json.dumps(m)
            for m in messages
        )
        reflected = "steered" in final_text.lower()

        observations.append(
            "steer: deltasBeforeSteer=%d steerSentToResponse=%.2fs "
            "steerResponseToSettled=%.2fs queueUpdates=%d "
            "steerInHistory=%s reflectedInOutput=%s sessionIdUnchanged=%s"
            % (deltas_before,
               steer_answered_at - steer_sent_at,
               settled_at - steer_answered_at,
               len(queues), steer_msg_in_history, reflected,
               sid == sid_after)
        )
        observations.append("queue_update timeline: %s"
                            % redact_text(json.dumps(queues))[:600])
        if not (reflected and sid == sid_after):
            return "FAIL", _err(
                "assertion", "steer not reflected or session changed",
                stage="steer", reflected=reflected,
                sessionIdBefore=sid, sessionIdAfter=sid_after,
                finalText=final_text[:400],
            ), observations, limitations
        return "PASS", None, observations, limitations
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        return "FAIL", _err("timeout", str(exc)), observations, limitations
    except ProcessExitedError as exc:
        return "FAIL", _err("process-exited", str(exc),
                            exit_code=exc.exit_code), observations, limitations
    except ScenarioError as exc:
        return "FAIL", _err("command", str(exc)), observations, limitations
    finally:
        probe.close()
        shutil.rmtree(tmpdir, ignore_errors=True)


def scenario_abort(config: ProbeConfig, deadline: float,
                   recorder: EvidenceRecorder,
                   register=None) -> Tuple[str, Optional[Dict[str, Any]],
                                          List[str], List[str]]:
    observations: List[str] = []
    limitations: List[str] = [
        "abort response latency measured from command send to correlated "
        "response; the protocol makes abort wait for idle before responding"
    ]
    probe = PiProcessProbe(
        config, "abort",
        extra_args=["--no-session"],
        cwd=tempfile.mkdtemp(prefix="d1-abort-"),
        label="p1",
        recorder=recorder,
    )
    if register:
        register(probe)
    tmpdir = probe.cwd
    try:
        _check_deadline(deadline)
        base_seq = recorder.seq
        probe.request("new_session")
        rem = deadline - time.monotonic()
        prompt_idx = probe.client.event_log_len()
        probe.request(
            "prompt", {"message": PROMPT_ABORT_INITIAL},
            timeout=min(rem, config.request_timeout),
        )
        got = probe.client.wait_for_event(
            lambda e: (e.get("type") == "message_update"
                       and (e.get("assistantMessageEvent") or {})
                       .get("type") == "text_delta"),
            timeout=max(1.0, deadline - time.monotonic()),
            since_index=prompt_idx,
        )
        if got is None:
            raise ScenarioTimeout("streaming never started before abort")

        abort_sent_at = time.monotonic()
        abort_idx = probe.client.event_log_len()
        abort_resp = probe.client.request(
            "abort", timeout=min(60.0, deadline - time.monotonic())
        )
        abort_answered_at = time.monotonic()
        abort_latency = abort_answered_at - abort_sent_at
        if abort_resp.get("success") is not True:
            return "FAIL", _err("assertion", "abort command failed",
                                stage="abort", response=abort_resp
                                ), observations, limitations

        # after abort the session must settle; give it the remaining budget
        settled = probe.wait_settled(max(5.0, deadline - time.monotonic()),
                                     since_index=abort_idx)
        reasons = stop_reasons(recorder, base_seq)
        last_event_type = (
            probe.client.last_event or {}).get("type", "<none>")
        observations.append(
            "abort: responseLatencyMs=%d stopReasons=%s lastEventType=%s "
            "settled=%s"
            % (int(abort_latency * 1000), reasons, last_event_type,
               settled is not None)
        )
        if abort_latency >= 60.0:
            return "FAIL", _err(
                "assertion", "abort did not close within 60s",
                stage="abort", latencyMs=int(abort_latency * 1000),
            ), observations, limitations
        if "aborted" not in reasons and settled is None:
            return "FAIL", _err(
                "assertion",
                "neither aborted stopReason nor agent_settled observed",
                stage="abort", stopReasons=reasons,
            ), observations, limitations

        # the process must still be usable for a fresh session
        if not probe.proc.alive:
            return "FAIL", _err(
                "assertion", "pi process died after abort",
                stage="abort post-check", exitCode=probe.proc.exit_code,
            ), observations, limitations
        probe.request("new_session")
        base_seq2 = recorder.seq
        rem = deadline - time.monotonic()
        out = probe.prompt_and_wait(
            PROMPT_ABORT_FOLLOWUP, timeout=min(rem, config.request_timeout)
        )
        after_text = last_assistant_text(recorder, base_seq2)
        observations.append(
            "abort: post-abort session usable, followup settledAfter=%.2fs "
            "answer=%r" % (out["elapsed"], after_text[:60])
        )
        if "again" not in after_text.lower():
            return "FAIL", _err(
                "assertion", "post-abort follow-up did not complete",
                stage="abort post-check", answer=after_text[:200],
            ), observations, limitations
        return "PASS", None, observations, limitations
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        return "FAIL", _err("timeout", str(exc)), observations, limitations
    except ProcessExitedError as exc:
        return "FAIL", _err("process-exited", str(exc),
                            exit_code=exc.exit_code), observations, limitations
    except ScenarioError as exc:
        return "FAIL", _err("command", str(exc)), observations, limitations
    finally:
        probe.close()
        shutil.rmtree(tmpdir, ignore_errors=True)


def scenario_resume(config: ProbeConfig, deadline: float,
                    recorder: EvidenceRecorder,
                    register=None) -> Tuple[str, Optional[Dict[str, Any]],
                                           List[str], List[str]]:
    observations: List[str] = []
    limitations: List[str] = []
    workdir = tempfile.mkdtemp(prefix="d1-resume-")
    session_dir = os.path.join(workdir, "sessions")
    os.makedirs(session_dir, exist_ok=True)
    fixed_session_id = str(uuid.uuid4())
    common = ["--session-dir", session_dir, "--session-id", fixed_session_id]

    probe_a = PiProcessProbe(
        config, "resume", extra_args=common, cwd=workdir, label="p1",
        recorder=recorder,
    )
    if register:
        register(probe_a)
    sid_a = None
    session_file_a = None
    try:
        _check_deadline(deadline)
        base_seq = recorder.seq
        rem = deadline - time.monotonic()
        out_a = probe_a.prompt_and_wait(
            PROMPT_RESUME_A, timeout=min(rem, config.request_timeout)
        )
        state_a = probe_a.request("get_state").get("data") or {}
        sid_a = state_a.get("sessionId")
        session_file_a = state_a.get("sessionFile")
        recorder.set_session_id(str(sid_a) if sid_a else "unknown")
        text_a = last_assistant_text(recorder, base_seq)
        observations.append(
            "phase A: settledAfter=%.2fs sessionId=%r sessionFile=%s "
            "answer=%r"
            % (out_a["elapsed"], sid_a,
               redact_text(str(session_file_a)), text_a[:40])
        )
        if "ACKNOWLEDGED" not in text_a.upper():
            return "FAIL", _err("assertion", "phase A answer wrong",
                                stage="resume A", answer=text_a[:200]
                                ), observations, limitations
    finally:
        code_a = probe_a.close()
    observations.append("phase A: process exit code=%r" % (code_a,))
    if code_a not in (0, None):
        return "FAIL", _err("assertion", "phase A exited nonzero",
                            stage="resume A", exitCode=code_a
                            ), observations, limitations

    # ---- phase B: new host process, same session ----------------------
    probe_b = PiProcessProbe(
        config, "resume", extra_args=common, cwd=workdir, label="p2",
        recorder=recorder,
    )
    if register:
        register(probe_b)
    try:
        _check_deadline(deadline)
        base_seq_b = recorder.seq
        state_b = probe_b.request("get_state").get("data") or {}
        sid_b = state_b.get("sessionId")
        session_file_b = state_b.get("sessionFile")
        recorder.set_session_id(str(sid_b) if sid_b else "unknown")
        msgs_resp = probe_b.request("get_messages")
        messages = (msgs_resp.get("data") or {}).get("messages") or []
        history_ok = any(
            isinstance(m, dict)
            and "RIVER-MOON-77" in json.dumps(m)
            for m in messages
        )
        observations.append(
            "phase B: sessionId=%r sameAsA=%s sessionFileSame=%s "
            "messages=%d historyHasCodeWord=%s"
            % (sid_b, sid_b == sid_a,
               os.path.basename(str(session_file_b or ""))
               == os.path.basename(str(session_file_a or "")),
               len(messages), history_ok)
        )
        if not history_ok:
            # try the documented switch_session fallback and record it
            observations.append(
                "phase B: --session-id did not restore history; trying "
                "switch_session with sessionFile"
            )
            if session_file_a and os.path.exists(session_file_a):
                probe_b.request(
                    "switch_session", {"sessionPath": session_file_a}
                )
                state_b2 = probe_b.request("get_state").get("data") or {}
                sid_b = state_b2.get("sessionId")
                recorder.set_session_id(str(sid_b) if sid_b else "unknown")
                msgs = (probe_b.request("get_messages").get("data")
                        or {}).get("messages") or []
                history_ok = any(
                    isinstance(m, dict)
                    and "RIVER-MOON-77" in json.dumps(m)
                    for m in msgs
                )
                observations.append(
                    "phase B fallback: switch_session -> sessionId=%r "
                    "historyHasCodeWord=%s" % (sid_b, history_ok)
                )
                limitations.append(
                    "--session-id + --session-dir did not restore history; "
                    "switch_session with the explicit sessionFile was "
                    "required (recorded as protocol observation)"
                )
        if not history_ok:
            return "FAIL", _err(
                "assertion", "history not restored across host restart",
                stage="resume B", sessionIdA=sid_a, sessionIdB=sid_b,
                messageCount=len(messages),
            ), observations, limitations

        rem = deadline - time.monotonic()
        base_seq_b2 = recorder.seq
        out_b = probe_b.prompt_and_wait(
            PROMPT_RESUME_B, timeout=min(rem, config.request_timeout)
        )
        text_b = last_assistant_text(recorder, base_seq_b2)
        observations.append(
            "phase B: follow-up settledAfter=%.2fs answer=%r"
            % (out_b["elapsed"], text_b[:60])
        )
        if "RIVER-MOON-77" not in text_b.upper():
            return "FAIL", _err(
                "assertion", "follow-up answer missing remembered code word",
                stage="resume B", answer=text_b[:200],
            ), observations, limitations
        return "PASS", None, observations, limitations
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        return "FAIL", _err("timeout", str(exc)), observations, limitations
    except ProcessExitedError as exc:
        return "FAIL", _err("process-exited", str(exc),
                            exit_code=exc.exit_code), observations, limitations
    except ScenarioError as exc:
        return "FAIL", _err("command", str(exc)), observations, limitations
    finally:
        probe_b.close()
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise ScenarioTimeout("scenario deadline exceeded")


def _err(kind: str, detail: str, **extra: Any) -> Dict[str, Any]:
    """Structured error per the shared schema: `message` is required."""
    err: Dict[str, Any] = {"message": detail, "kind": kind}
    err.update(extra)
    return err


def _args_within_cwd(args: Any, cwd: str) -> bool:
    """Check that a read tool's path argument stays inside the temp cwd."""
    if not isinstance(args, dict):
        return True
    raw = args.get("path") or args.get("file") or args.get("fileName")
    if not raw:
        return True
    resolved = os.path.realpath(os.path.join(cwd, str(raw)))
    return resolved.startswith(os.path.realpath(cwd) + os.sep) or \
        resolved == os.path.realpath(cwd)


class _Watchdog:
    """Kills registered probes at the deadline so blocked code unblocks."""

    def __init__(self, deadline: float, grace: float = 5.0) -> None:
        self.deadline = deadline
        self.grace = grace
        self.probes: List[PiProcessProbe] = []
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def register(self, probe: PiProcessProbe) -> None:
        with self._lock:
            self.probes.append(probe)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._done.set()

    def _run(self) -> None:
        while not self._done.wait(timeout=0.5):
            if time.monotonic() > self.deadline + self.grace:
                with self._lock:
                    for probe in self.probes:
                        try:
                            probe.force_kill()
                        except Exception:
                            pass
                return


# exitCode semantics of the shared schema: the exit code a third party
# re-running `command` observes (the probe CLI), NOT the pi subprocess.
STATUS_TO_EXIT_CODE = {
    "PASS": 0,
    "FAIL": 1,
    "BLOCKED": 2,
    "NOT_RUN": 3,
}


def run_scenario(name: str, config: ProbeConfig,
                 ready: bool = True,
                 block_reason: str = "") -> ScenarioResult:
    assert name in SCENARIOS, name
    result = ScenarioResult(name)
    result.command = config.command or (
        "python3 rpc-python/probe.py run --scenario %s" % name
    )
    if not ready:
        result.finish(
            "BLOCKED",
            _err(BLOCKED_CREDENTIALS,
                 block_reason or "provider credentials not ready"),
            blocked_reason="CREDENTIALS",
        )
        result.exit_code = STATUS_TO_EXIT_CODE["BLOCKED"]
        result.limitations.append(
            "no real pi run: credentials unavailable; code and protocol "
            "tests still executable"
        )
        return result

    timeout = config.timeout_for(name)
    deadline = time.monotonic() + timeout
    # one events file per scenario (shared schema layout:
    # evidence/rpc/<scenario>.events.jsonl), one continuous seq
    os.makedirs(config.evidence_dir, exist_ok=True)
    events_path = os.path.join(
        config.evidence_dir, "%s.events.jsonl" % name
    )
    recorder = EvidenceRecorder(name, events_path)
    watchdog = _Watchdog(deadline)
    watchdog.start()
    impl = {
        "basic": scenario_basic,
        "tool": scenario_tool,
        "steer": scenario_steer,
        "abort": scenario_abort,
        "resume": scenario_resume,
    }[name]
    try:
        status, error, observations, limitations = impl(
            config, deadline, recorder, register=watchdog.register
        )
    except Exception as exc:  # defensive: never crash the harness silently
        status = "FAIL"
        error = _err("unexpected", "%s: %s" % (type(exc).__name__, exc))
        observations, limitations = [], []
    finally:
        watchdog.stop()
        if recorder.seq > 0:
            recorder.finalize()
        else:
            recorder.abort()

    result.observations.extend(observations)
    result.limitations.extend(limitations)
    # exit codes of every pi subprocess this scenario spawned (watchdog
    # holds the registered probes; all are closed by now via finally)
    exit_codes = [p.proc.exit_code for p in watchdog.probes]
    if exit_codes:
        result.observations.append(
            "pi subprocess exit codes (spawn order): %r" % (exit_codes,)
        )
    if status == "PASS" and recorder.seq > 0:
        result.evidence_files = [config.rel_to_d1_root(events_path)]
        # append the structured outcome next to the last known raw events
        append_summary(events_path, name, status, None)
    elif recorder.seq > 0:
        result.evidence_files = [config.rel_to_d1_root(events_path)]
        append_summary(events_path, name, status, error)
    result.exit_code = STATUS_TO_EXIT_CODE.get(status, 1)
    result.finish(status, error)
    return result
