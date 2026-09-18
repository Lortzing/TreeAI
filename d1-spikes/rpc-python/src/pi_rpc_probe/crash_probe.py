"""Host-crash cleanup probe: what happens to pi when its driver dies?

Simulates a host (driver process) crash by SIGKILLing the process that owns
the pi RPC subprocess, then observes the orphaned pi process:

- does pi exit on its own (stdin pipe closed by the kernel -> EOF)?
- how long does it take?
- if it stays alive, does SIGTERM/SIGKILL cleanup reclaim it?

Two phases: idle (pi started, no prompt) and streaming (long prompt active).
The result is recorded as evidence; PASS means the probe ran to completion
and left no pi process behind, NOT that orphaning is acceptable.

Requires working model credentials for the streaming phase (a real prompt).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Any, Dict, List, Optional

from .evidence import redact_text

OBSERVE_TIMEOUT = 45.0  # seconds to wait for orphaned pi to exit on its own
TERM_WAIT = 5.0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - exists but not ours
        return True


def _kill_pid(pid: int) -> None:
    for sig, wait in ((signal.SIGTERM, TERM_WAIT), (signal.SIGKILL, 5.0)):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if not _pid_alive(pid):
                return
            time.sleep(0.2)


def _phase(config: Any, phase: str, ready: bool) -> Dict[str, Any]:
    driver_path = os.path.join(os.path.dirname(__file__), "crash_driver.py")
    ready_dir = tempfile.mkdtemp(prefix="d1-crash-%s-" % phase)
    ready_file = os.path.join(ready_dir, "ready.json")
    driver_argv = [
        sys.executable, driver_path,
        "--pi-bin", config.pi_bin,
        "--provider", config.provider,
        "--model", config.model,
        "--thinking", config.thinking,
        "--ready-file", ready_file,
        "--phase", phase,
    ]
    if phase == "streaming" and not ready:
        return {
            "phase": phase,
            "status": "NOT_RUN",
            "detail": "streaming phase needs model credentials",
        }
    driver = subprocess.Popen(
        driver_argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    pi_pid: Optional[int] = None
    try:
        # wait for the readiness record
        deadline = time.monotonic() + 90.0
        record = None
        while time.monotonic() < deadline:
            if os.path.exists(ready_file):
                try:
                    with open(ready_file, "r", encoding="utf-8") as fh:
                        record = json.load(fh)
                    break
                except (ValueError, OSError):
                    pass
            if driver.poll() is not None:
                return {
                    "phase": phase,
                    "status": "FAIL",
                    "detail": "driver exited before readiness (code=%r)"
                              % driver.returncode,
                }
            time.sleep(0.2)
        if record is None:
            return {"phase": phase, "status": "FAIL",
                    "detail": "driver never became ready"}
        pi_pid = int(record["piPid"])
        time.sleep(3.0)  # let streaming actually start

        # ---- simulate host crash --------------------------------------
        crash_at = time.monotonic()
        os.kill(driver.pid, signal.SIGKILL)
        driver.wait(timeout=10.0)

        exited_on_own = False
        exit_after_ms: Optional[int] = None
        observe_deadline = time.monotonic() + OBSERVE_TIMEOUT
        while time.monotonic() < observe_deadline:
            if not _pid_alive(pi_pid):
                exited_on_own = True
                exit_after_ms = int((time.monotonic() - crash_at) * 1000)
                break
            time.sleep(0.25)

        forced_cleanup = False
        if not exited_on_own and _pid_alive(pi_pid):
            _kill_pid(pi_pid)
            forced_cleanup = not _pid_alive(pi_pid)

        leftover = _pid_alive(pi_pid) if pi_pid else False
        return {
            "phase": phase,
            "status": "PASS" if not leftover else "FAIL",
            "piPid": pi_pid,
            "driverKilledWith": "SIGKILL",
            "exitedOnItsOwn": exited_on_own,
            "exitAfterMs": exit_after_ms,
            "observeTimeoutS": OBSERVE_TIMEOUT,
            "forcedCleanupApplied": forced_cleanup,
            "leftoverProcess": leftover,
            "argv": redact_text(" ".join(record.get("argv", []))),
        }
    finally:
        if driver.poll() is None:
            driver.kill()
            try:
                driver.wait(timeout=5.0)
            except subprocess.TimeoutExpired:  # pragma: no cover
                pass
        if pi_pid and _pid_alive(pi_pid):
            _kill_pid(pi_pid)
        shutil.rmtree(ready_dir, ignore_errors=True)


def run_crash_probe(config: Any, ready: bool = True) -> Dict[str, Any]:
    run_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-%s" % (
        uuid.uuid4().hex[:6]
    )
    result: Dict[str, Any] = {
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "implementation": "rpc-python",
        "probe": "crash-probe",
        "runId": run_id,
        "phases": [],
        "conclusion": "",
        "limitations": [
            "macOS has no PDEATHSIG equivalent; orphan behavior depends on "
            "pi observing stdin EOF after the host's pipes are closed",
            "PID liveness is checked with kill(pid, 0); short PID-reuse "
            "windows are theoretically possible but were not observed",
        ],
    }
    statuses: List[str] = []
    for phase in ("idle", "streaming"):
        ph = _phase(config, phase, ready)
        result["phases"].append(ph)
        statuses.append(str(ph.get("status", "FAIL")))
    overall = (
        "FAIL" if "FAIL" in statuses
        else ("NOT_RUN" if all(s == "NOT_RUN" for s in statuses) else "PASS")
    )
    result["status"] = overall
    idle_ph = result["phases"][0]
    stream_ph = result["phases"][1]
    parts = []
    for ph in result["phases"]:
        if ph.get("status") == "NOT_RUN":
            parts.append("%s: not run (%s)" % (ph["phase"], ph.get("detail")))
        else:
            parts.append(
                "%s: exitedOnItsOwn=%s exitAfterMs=%r forcedCleanup=%s"
                % (ph["phase"], ph.get("exitedOnItsOwn"),
                   ph.get("exitAfterMs"), ph.get("forcedCleanupApplied"))
            )
    result["conclusion"] = "; ".join(parts)
    return result
