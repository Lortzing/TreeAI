"""Evidence recording: redaction, atomic JSONL writes, scenario results.

Implements the D1 shared evidence format (task book section 6):

- raw event lines: seq / observedAt / implementation / scenario / sessionId /
  piEventType / runState / payload / redactionVersion
- scenario result JSON: implementation / scenario / status / startedAt /
  endedAt / durationMs / command / exitCode / evidenceFiles / observations /
  limitations / error

Rules honored here:
- evidence files are written to a .tmp file first, then atomically renamed;
- failed runs still record the last known events and a structured error;
- secrets, auth headers and absolute user paths are redacted before write;
- statuses are restricted to PASS / FAIL / BLOCKED / NOT_RUN.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional

from . import IMPLEMENTATION_ID, REDACTION_VERSION

STATUSES = ("PASS", "FAIL", "BLOCKED", "NOT_RUN")
BLOCKED_CREDENTIALS = "BLOCKED_CREDENTIALS"
# blockedReason values of the shared scenario-result schema (Agent D).
# The task book's BLOCKED_CREDENTIALS marker maps to CREDENTIALS.
BLOCKED_REASONS = ("CREDENTIALS", "VERSION_UNAVAILABLE", "DEPENDENCY_MISSING",
                   "ENVIRONMENT", "OTHER")

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    # long token-like strings with known prefixes (anthropic/openai style)
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"), "sk-REDACTED"),
    (re.compile(r"\brk-[A-Za-z0-9_-]{12,}\b"), "rk-REDACTED"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"), "Bearer REDACTED"),
    (re.compile(r"(?i)authorization['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}"),
     "authorization: REDACTED"),
    (re.compile(r"(?i)\bapi[_-]?key['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}"),
     "api_key: REDACTED"),
    (re.compile(r"\bx-api-key['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}"),
     "x-api-key: REDACTED"),
]

_HOME_PATTERNS = [
    # absolute user paths (macOS / Linux / Windows) -> <HOME>
    (re.compile(r"/Users/[A-Za-z0-9._-]+"), "<HOME>"),
    (re.compile(r"/home/[A-Za-z0-9._-]+"), "<HOME>"),
    (re.compile(r"[A-Za-z]:\\\\Users\\\\[A-Za-z0-9._-]+"), "<HOME>"),
]


def redact_text(text: str) -> str:
    for pattern, repl in _SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    for pattern, repl in _HOME_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def redact_obj(obj: Any) -> Any:
    """Recursively redact strings inside parsed JSON structures."""
    if isinstance(obj, str):
        return redact_text(obj)
    if isinstance(obj, dict):
        return {k: redact_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_obj(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Atomic JSONL writer
# ---------------------------------------------------------------------------

class AtomicJsonlWriter:
    """Append-only JSONL writer with atomic finalize (tmp + os.replace)."""

    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.tmp_path = path + ".tmp"
        self._fh = open(self.tmp_path, "w", encoding="utf-8")
        self._finalized = False

    def write_obj(self, obj: Dict[str, Any]) -> None:
        self._fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self._fh.flush()

    def finalize(self) -> str:
        if not self._finalized:
            self._fh.close()
            os.replace(self.tmp_path, self.path)
            self._finalized = True
        return self.path

    def abort(self) -> None:
        """Close without renaming; the .tmp file remains for inspection."""
        if not self._finalized:
            self._fh.close()
            self._finalized = True


# ---------------------------------------------------------------------------
# Evidence recorder (attaches to a PiRpcClient)
# ---------------------------------------------------------------------------

class EvidenceRecorder:
    """Records every observed event/response/anomaly as a redacted JSONL line.

    seq_start: initial seq value (0 for the standard one-file-per-scenario
    layout where every run rewrites the file from seq 1). The append-only
    tree-navigation evidence passes the last seq of the existing file so a
    later run's appended lines keep the file's seq strictly increasing.
    """

    def __init__(self, scenario: str, out_path: str,
                 seq_start: int = 0) -> None:
        self.scenario = scenario
        self.writer = AtomicJsonlWriter(out_path)
        self._seq = int(seq_start)
        self.session_id = "unknown"
        self.run_state = "idle"
        self.event_count = 0
        self.anomaly_count = 0
        self.response_count = 0
        self.lines: List[Dict[str, Any]] = []  # in-memory copy (bounded)

    def set_session_id(self, session_id: str) -> None:
        if session_id:
            self.session_id = session_id

    def set_run_state(self, state: str) -> None:
        self.run_state = state

    def record(self, obj: Dict[str, Any]) -> None:
        """Subscriber callback: one stdout record -> one evidence line."""
        self._seq += 1
        is_anomaly = bool(obj.get("__anomaly__"))
        if is_anomaly:
            pi_event_type = str(obj.get("type", "protocol_anomaly"))
            payload = redact_obj({k: v for k, v in obj.items() if k != "__anomaly__"})
            self.anomaly_count += 1
        elif obj.get("type") == "response":
            pi_event_type = "response"
            payload = redact_obj(obj)
            self.response_count += 1
        else:
            pi_event_type = str(obj.get("type", "<missing-type>"))
            payload = redact_obj(obj)
            self.event_count += 1
        line = {
            "seq": self._seq,
            "observedAt": _utc_now_iso(),
            "implementation": IMPLEMENTATION_ID,
            "scenario": self.scenario,
            "sessionId": self.session_id,
            "piEventType": pi_event_type,
            "runState": self.run_state,
            "payload": payload,
            "redactionVersion": REDACTION_VERSION,
        }
        self.writer.write_obj(line)
        if len(self.lines) < 5000:
            self.lines.append(line)

    def note(self, message: str, **extra: Any) -> None:
        """Record a client-side observation as a structured probe event."""
        obj: Dict[str, Any] = {
            "type": "probe_note",
            "note": message,
        }
        obj.update(extra)
        self.record(obj)

    def finalize(self) -> str:
        return self.writer.finalize()

    def abort(self) -> None:
        """Close the writer without renaming (diagnostics/tests)."""
        self.writer.abort()

    @property
    def finalized(self) -> bool:
        return self.writer._finalized

    @property
    def seq(self) -> int:
        return self._seq

    def events_of_type(self, pi_event_type: str,
                       since_seq: int = 0) -> List[Dict[str, Any]]:
        return [ln for ln in self.lines
                if ln["piEventType"] == pi_event_type and ln["seq"] > since_seq]


# ---------------------------------------------------------------------------
# Scenario result
# ---------------------------------------------------------------------------

class ScenarioResult:
    def __init__(self, scenario: str) -> None:
        self.scenario = scenario
        self.implementation = IMPLEMENTATION_ID
        self.status: str = "NOT_RUN"
        self.blocked_reason: Optional[str] = None  # required when BLOCKED
        self.started_at = _utc_now_iso()
        self.ended_at: Optional[str] = None
        self.duration_ms: Optional[int] = None
        self.command: Optional[str] = None
        self.exit_code: Optional[int] = None
        self.evidence_files: List[str] = []
        self.observations: List[str] = []
        self.limitations: List[str] = []
        self.error: Optional[Dict[str, Any]] = None
        self._t0 = time.time()

    def finish(self, status: str, error: Optional[Dict[str, Any]] = None,
               blocked_reason: Optional[str] = None) -> None:
        assert status in STATUSES, status
        self.status = status
        self.ended_at = _utc_now_iso()
        self.duration_ms = int((time.time() - self._t0) * 1000)
        self.error = error
        if status == "BLOCKED":
            assert blocked_reason in BLOCKED_REASONS, blocked_reason
            self.blocked_reason = blocked_reason
        else:
            self.blocked_reason = None

    def to_json(self) -> Dict[str, Any]:
        # every free-text field is redacted before it hits disk
        out: Dict[str, Any] = {
            "implementation": self.implementation,
            "scenario": self.scenario,
            "status": self.status,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "durationMs": self.duration_ms,
            "command": redact_text(self.command or ""),
            "exitCode": self.exit_code,
            "evidenceFiles": [redact_text(p) for p in self.evidence_files],
            "observations": [redact_text(o) for o in self.observations],
            "limitations": [redact_text(l) for l in self.limitations],
            "error": redact_obj(self.error),
        }
        # blockedReason is only present for BLOCKED results (the shared
        # scenario-result schema restricts it to an enum when present)
        if self.status == "BLOCKED" and self.blocked_reason:
            out["blockedReason"] = self.blocked_reason
        return out

    def write(self, path: str) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.to_json(), fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
        return path


def append_summary(path: str, scenario: str, status: str,
                   error: Optional[Dict[str, Any]] = None,
                   extra: Optional[Dict[str, Any]] = None) -> None:
    """Append one summary record to a finalized events file (append-only).

    Ensures a failed run's structured error lands in the raw-event evidence
    file itself, next to the last known events, as required by the D1
    evidence rules. Never rewrites existing lines.
    """
    if not os.path.exists(path):
        return
    last_seq = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict) and isinstance(obj.get("seq"), int):
                    last_seq = max(last_seq, obj["seq"])
            except ValueError:
                continue
    record = {
        "seq": last_seq + 1,
        "observedAt": _utc_now_iso(),
        "implementation": IMPLEMENTATION_ID,
        "scenario": scenario,
        "sessionId": "unknown",
        "piEventType": "scenario_summary",
        "runState": "idle",
        "payload": redact_obj({
            "status": status,
            "error": error,
            "extra": extra or {},
        }),
        "redactionVersion": REDACTION_VERSION,
    }
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % (
        int(time.time() * 1000) % 1000
    )
