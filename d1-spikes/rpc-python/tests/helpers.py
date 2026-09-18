"""Shared helpers for the protocol unit tests."""

from __future__ import annotations

import atexit
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
)

from pi_rpc_probe.client import PiRpcClient  # noqa: E402
from pi_rpc_probe.transport import PiSubprocess  # noqa: E402

FAKE_PI = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fake_pi.py")


def fake_pi_argv(spec: dict, tmpdir: str, name: str = "spec.json"):
    """Write spec to tmpdir and return the argv list that runs the fake."""
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    return [sys.executable, FAKE_PI, path]


def spawn_fake(spec: dict, tmpdir: str, name: str = "spec.json",
               request_timeout: float = 10.0):
    """Spawn the fake pi and return (PiSubprocess, started PiRpcClient)."""
    argv = fake_pi_argv(spec, tmpdir, name)
    stderr_path = os.path.join(tmpdir, "stderr.log")
    proc = PiSubprocess(argv, cwd=tmpdir, stderr_path=stderr_path)
    client = PiRpcClient(proc, request_timeout=request_timeout)
    client.start()
    return proc, client


def resp(command: str, success: bool = True, data=None, error=None,
         with_id: bool = True) -> str:
    obj = {"type": "response", "command": command, "success": success}
    if with_id:
        obj["id"] = "@echo"
    if data is not None:
        obj["data"] = data
    if error is not None:
        obj["error"] = error
    return json.dumps(obj)


def ev(etype: str, **fields) -> str:
    obj = {"type": etype}
    obj.update(fields)
    return json.dumps(obj)


def message_end_line(text: str, stop_reason: str = "stop") -> str:
    return ev(
        "message_end",
        message={
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stopReason": stop_reason,
        },
    )


def streaming_flow(text: str, stop_reason: str = "stop",
                   split: int = 2) -> list:
    """A realistic successful prompt flow (response first, events after).

    The text is emitted as contiguous chunks so that concatenating the
    deltas in arrival order reproduces the text exactly.
    """
    if split > 1 and len(text) >= split:
        size = -(-len(text) // split)  # ceil division
        chunks = [text[i * size:(i + 1) * size] for i in range(split)]
    else:
        chunks = [text]
    lines = [resp("prompt")]
    lines.append(ev("agent_start"))
    lines.append(ev("turn_start"))
    lines.append(ev("message_start", message={"role": "assistant",
                                              "content": []}))
    lines.append(ev("message_update", usage={},
                    assistantMessageEvent={"type": "text_start",
                                           "contentIndex": 0}))
    for chunk in chunks:
        lines.append(ev("message_update", usage={},
                        assistantMessageEvent={"type": "text_delta",
                                               "contentIndex": 0,
                                               "delta": chunk}))
    lines.append(ev("message_update", usage={},
                    assistantMessageEvent={"type": "text_end",
                                           "contentIndex": 0,
                                           "content": text}))
    lines.append(message_end_line(text, stop_reason))
    lines.append(ev("turn_end", message={"role": "assistant"}, toolResults=[]))
    lines.append(ev("agent_end", messages=[], willRetry=False))
    lines.append(ev("agent_settled"))
    return lines


def good_spec(prompt_flows=None) -> dict:
    """Spec for a well-behaved fake pi covering the commands we use."""
    return {
        "handlers": {
            "new_session": [{"emit": [resp("new_session",
                                           data={"cancelled": False})]}],
            "get_state": [{"emit": [resp(
                "get_state",
                data={"sessionId": "fake-session-0001",
                      "sessionFile": "/tmp/fake-session-0001.jsonl",
                      "isStreaming": False},
            )]}],
            "get_messages": [{"emit": [resp(
                "get_messages", data={"messages": []},
            )]}],
            "prompt": prompt_flows or [{"emit": streaming_flow("pong")}],
            "steer": [{"emit": [resp("steer")]}],
            "abort": [{"emit": [resp("abort")]}],
        },
    }


_TRACKED_DIRS: list = []


@atexit.register
def _cleanup_tracked_dirs() -> None:
    """Best-effort removal of every tmpdir() created by the tests.

    Runs at interpreter exit so individual tests never need cleanup
    boilerplate; failures (e.g. a readonly run-dir copy) are ignored.
    """
    for d in _TRACKED_DIRS:
        try:
            _restore_write_perms(d)
            shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def _restore_write_perms(path: str) -> None:
    """Restore write perms so run-dir copies (readonly/ stripped) delete."""
    if not os.path.isdir(path):
        return
    try:
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                p = os.path.join(root, name)
                try:
                    os.chmod(p, os.stat(p).st_mode | 0o200)
                except OSError:
                    pass
    except OSError:
        pass


def tmpdir(prefix: str = "d1-test-") -> str:
    d = tempfile.mkdtemp(prefix=prefix)
    _TRACKED_DIRS.append(d)
    return d
