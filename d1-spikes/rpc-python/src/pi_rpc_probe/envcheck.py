"""Environment check: record reproducible environment facts (redacted).

Records: pi CLI version and resolved package, node version, python version,
uv version, provider readiness (status only -- never key material), and the
model list. Also records Agent B alignment status: the D1 task requires the
SDK and RPC probes to use the same pi version and model config; since Agent
B's spike was not present when this probe ran, alignment is PENDING and the
reproducible check commands are saved with the evidence.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

from .evidence import redact_text


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def agent_b_alignment(d1_root: str,
                      own_pi_version: str = "") -> Dict[str, Any]:
    """Is the Agent B (sdk-node) spike present for cross-checking?

    The D1 task requires SDK and RPC probes to use the same pi version and
    model config. Reads (never writes) Agent B's delivered artifacts:
    sdk-node/package.json for the pinned pi dependency, and
    evidence/sdk/runs/<newest>/{environment,run-summary}.json for the
    recorded runtime facts. Alignment facts are recorded; the final
    provider/model baseline decision stays with the owner.
    """
    sdk_dir = os.path.join(d1_root, "sdk-node")
    present = os.path.isdir(sdk_dir)
    pkg = os.path.join(sdk_dir, "package.json")
    pi_dep = None
    if os.path.isfile(pkg):
        data = _read_json(pkg)
        if data is not None:
            deps = (data.get("devDependencies") or {}).copy()
            deps.update(data.get("dependencies") or {})
            for name, spec in deps.items():
                if "pi-coding-agent" in str(name):
                    pi_dep = "%s: %s" % (name, spec)

    # newest delivered evidence run (read-only)
    runs_root = os.path.join(d1_root, "evidence", "sdk", "runs")
    run_dirs: List[str] = []
    if os.path.isdir(runs_root):
        run_dirs = sorted(
            (n for n in os.listdir(runs_root)
             if os.path.isdir(os.path.join(runs_root, n))),
            reverse=True,
        )
    their_env: Dict[str, Any] = {}
    their_summary: Dict[str, Any] = {}
    for name in run_dirs:
        if not their_env:
            env = _read_json(
                os.path.join(runs_root, name, "environment.json"))
            if env is not None:
                pi = env.get("pi") or {}
                runtime = env.get("runtime") or {}
                probe = env.get("probe") or {}
                their_env = {
                    "runDir": name,
                    "piPackageVersion": pi.get("packageVersion"),
                    "globalCliVersion": pi.get("globalCliVersion"),
                    "nodeVersion": runtime.get("node"),
                    "thinkingLevel": probe.get("thinkingLevel"),
                    "modelOverride": probe.get("modelOverride"),
                }
        if not their_summary:
            summ = _read_json(
                os.path.join(runs_root, name, "run-summary.json"))
            if summ is not None:
                their_summary = {
                    "runDir": name,
                    "statuses": {
                        str(r.get("scenario")): str(r.get("status"))
                        for r in summ.get("results") or []
                        if isinstance(r, dict)
                    },
                }
        if their_env and their_summary:
            break

    version_match: Optional[bool] = None
    their_ver = (their_env.get("piPackageVersion")
                 or their_env.get("globalCliVersion"))
    if present and their_ver and own_pi_version:
        version_match = their_ver in own_pi_version

    if not present:
        status = "PENDING_OWNER"
        detail = (
            "Agent B (sdk-node) artifacts were not present when this "
            "environment record was produced; same pi version and model "
            "config could not be cross-checked"
        )
    else:
        status = "CHECK_AVAILABLE"
        parts = [
            "sdk-node/ is present (pi dependency: %s)" %
            (pi_dep or "not declared in package.json"),
        ]
        if version_match is True:
            parts.append("recorded pi version %s MATCHES this probe's pi %s"
                         % (their_ver, own_pi_version.strip()))
        elif version_match is False:
            parts.append("recorded pi version %s DOES NOT match this "
                         "probe's pi %s" % (their_ver,
                                            own_pi_version.strip()))
        if their_summary.get("statuses"):
            parts.append("delivered scenario statuses: %s"
                         % json.dumps(their_summary["statuses"]))
            if their_env.get("modelOverride") is None:
                parts.append(
                    "sdk-node ran with pi's default provider/model (no "
                    "override) and its scenarios are BLOCKED with 403 -- "
                    "the same provider 403 this probe documented in "
                    "evidence/rpc/observation-copycopy-403.json; a common "
                    "working provider/model baseline remains PENDING_OWNER")
        detail = "; ".join(parts)
    return {
        "status": status,
        "detail": detail,
        "sdkNodePresent": present,
        "piDependency": pi_dep,
        "deliveredRuns": len(run_dirs),
        "newestRunEnvironment": their_env or None,
        "newestRunSummary": their_summary or None,
        "piVersionMatch": version_match,
        "reproduceWith": [
            "pi --version",
            "npm ls -g @earendil-works/pi-coding-agent",
            "pi --list-models",
            "cat d1-spikes/sdk-node/package.json",
        ],
    }


def _run(argv: List[str], timeout: float = 30.0) -> Dict[str, Any]:
    try:
        cp = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout
        )
        return {
            "argv": [os.path.basename(argv[0])] + argv[1:],
            "exitCode": cp.returncode,
            "stdout": redact_text(cp.stdout.strip())[:4000],
            "stderr": redact_text(cp.stderr.strip())[:2000],
        }
    except FileNotFoundError:
        return {"argv": argv, "exitCode": None, "error": "not-found"}
    except subprocess.TimeoutExpired:
        return {"argv": argv, "exitCode": None, "error": "timeout"}


def live_rpc_check(pi_bin: str, provider: str, model: str,
                   thinking: str = "off") -> Dict[str, Any]:
    """Minimal real RPC round trip: the only honest readiness oracle.

    D1 observation: `pi auth check` disagrees with actual API access on
    the local pi-switch providers (one reports ready but 403s every RPC
    call; another reports not_ready but serves normally). Readiness is
    therefore decided by a tiny live prompt over --mode rpc, and both
    signals are recorded.
    """
    from .client import PiRpcClient
    from .transport import PiSubprocess

    argv = [pi_bin, "--mode", "rpc", "--provider", provider,
            "--model", model, "--thinking", thinking, "--no-session"]
    t0 = time.monotonic()
    try:
        proc = PiSubprocess(argv, cwd=tempfile.gettempdir())
    except OSError as exc:
        return {"ok": False, "detail": "cannot spawn pi: %s" % exc}
    client = PiRpcClient(proc, request_timeout=60.0)
    client.start()
    try:
        client.request("new_session", timeout=30.0)
        idx = client.event_log_len()
        client.request("prompt",
                       {"message": "Reply with exactly: pong"},
                       timeout=30.0)
        client.wait_for_event(
            lambda e: e.get("type") == "agent_settled", 60.0,
            since_index=idx)
        stop = None
        err = None
        text = ""
        for e in client.events_since(idx):
            if e.get("type") == "message_end" and \
                    (e.get("message") or {}).get("role") == "assistant":
                m = e["message"]
                stop = m.get("stopReason")
                err = m.get("errorMessage")
                for block in m.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text += block.get("text") or ""
        ok = bool(stop == "stop" and text.strip())
        return {
            "ok": ok,
            "stopReason": stop,
            "answered": text.strip()[:80],
            "errorMessage": (redact_text(str(err))[:400]
                             if err else None),
            "elapsedMs": int((time.monotonic() - t0) * 1000),
            "detail": ("" if ok else
                       "live RPC prompt failed (stopReason=%r%s)"
                       % (stop, ", error=%s" % err if err else "")),
        }
    except Exception as exc:  # RpcTimeoutError / ProcessExitedError / ...
        return {"ok": False, "detail": "%s: %s" % (type(exc).__name__, exc)}
    finally:
        try:
            proc.close()
        except Exception:  # pragma: no cover - defensive
            pass


def check_environment(pi_bin: str, provider: str, model: str,
                      d1_root: str = "",
                      thinking: str = "off") -> Tuple[bool, Dict[str, Any]]:
    """Return (credentials_ready, environment_record).

    Readiness is decided by the live RPC round trip (see live_rpc_check);
    `pi auth check` output is recorded alongside as a secondary signal.
    """
    auth = _run([pi_bin, "auth", "check", "--provider", provider])
    live = live_rpc_check(pi_bin, provider, model, thinking)
    pi_version_out = _run([pi_bin, "--version"])
    env: Dict[str, Any] = {
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "implementation": "rpc-python",
        "piBin": pi_bin,
        "piVersion": pi_version_out,
        "piPackageGlobal": _run(
            ["npm", "ls", "-g", "@earendil-works/pi-coding-agent"]
        ),
        "nodeVersion": _run(["node", "--version"]),
        "python": {
            "version": platform.python_version(),
            "executable": redact_text(sys.executable),
            "implementation": platform.python_implementation(),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "uvVersion": _run(["uv", "--version"]),
        "provider": provider,
        "model": model,
        "thinking": thinking,
        "authCheck": auth,
        "liveCheck": live,
        "modelList": _run([pi_bin, "--list-models"]),
        "agentBAlignment": agent_b_alignment(
            d1_root or os.getcwd(),
            own_pi_version=str(pi_version_out.get("stdout") or ""),
        ),
        "notes": [
            "readiness is decided by liveCheck (a real minimal RPC prompt), "
            "not by `pi auth check`: on this machine one provider reports "
            "ready but 403s RPC calls while another reports not_ready but "
            "serves normally (see evidence/rpc/observation-copycopy-403.json)",
            "authCheck/liveCheck record status only; key material is never "
            "read, printed or stored by this probe",
            "pi subprocess argv and stdout are redacted (secrets, auth "
            "headers, absolute user paths) before being written",
            "final SDK-vs-RPC choice, host language and model baseline are "
            "PENDING_OWNER decisions, not made by this probe",
        ],
    }
    ready = bool(live.get("ok"))
    env["credentialsReady"] = ready
    return ready, env


def write_environment_record(path: str, record: Dict[str, Any]) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    return path
