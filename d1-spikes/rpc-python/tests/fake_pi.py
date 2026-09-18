"""A scriptable fake `pi --mode rpc` server for protocol unit tests.

Usage: python3 fake_pi.py <spec.json> [ignored args...]

The spec JSON drives behavior:

{
  "startup": ["<raw stdout line>", ...],        // written at start
  "startupRawB64": ["<base64 bytes>", ...],     // raw stdout bytes (tests
                                                 // invalid utf-8 / partial
                                                 // records)
  "counterFile": "/path/counter.json",          // persist per-command call
                                                 // counts across processes
  "handlers": {
    "<command>": [                               // one entry per request;
      {                                          // last entry repeats
        "emit": ["<raw stdout line>", ...],      // "@echo" inside a JSON
                                                 // object is replaced by
                                                 // the request id
        "stderr": "text written to stderr",
        "delay": 0.2,
        "exit": 7,                               // exit code after emits
        "hang": true                             // sleep 60s, no response
      }
    ]
  },
  "default": {"emit": [...]} or null             // unknown commands
}

Emit lines are written verbatim + b"\\n": to simulate CRLF, end the emit
string with "\\r". To emit non-JSON garbage, just use a non-JSON string.
This fake is only for tests; it never talks to a real model.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time


def write_stdout(line: str) -> None:
    data = (line + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def load_counters(path):
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except (ValueError, OSError):
            pass
    return {}


def save_counters(path, counters):
    if path:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(counters, fh)
        os.replace(tmp, path)


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: fake_pi.py <spec.json>\n")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    for b64 in spec.get("startupRawB64", []):
        sys.stdout.buffer.write(base64.b64decode(b64))
        sys.stdout.buffer.flush()
    for line in spec.get("startup", []):
        write_stdout(line)

    handlers = spec.get("handlers", {})
    defaults = spec.get("default")
    counters = load_counters(spec.get("counterFile"))

    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:
            return 0
        raw = raw.rstrip(b"\n")
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        try:
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            write_stdout(json.dumps({
                "type": "response", "command": "parse", "success": False,
                "error": "Failed to parse command: %r" % raw[:100],
            }))
            continue
        cmd = str(req.get("type", ""))
        actions = handlers.get(cmd)
        if actions is None:
            if defaults is None:
                write_stdout(json.dumps({
                    "type": "response", "command": cmd,
                    "id": req.get("id"),
                    "success": False,
                    "error": "Unknown command: %s" % cmd,
                }))
                continue
            actions = [defaults]
        n = int(counters.get(cmd, 0))
        counters[cmd] = n + 1
        save_counters(spec.get("counterFile"), counters)
        action = actions[n] if n < len(actions) else actions[-1]

        if action.get("delay"):
            time.sleep(float(action["delay"]))
        for line in action.get("emit", []):
            out_line = line
            if "@echo" in out_line:
                try:
                    obj = json.loads(out_line)
                    if obj.get("id") == "@echo":
                        obj["id"] = req.get("id")
                        out_line = json.dumps(obj)
                except ValueError:
                    out_line = out_line.replace("@echo",
                                                str(req.get("id")))
            write_stdout(out_line)
        if action.get("stderr"):
            sys.stderr.write(str(action["stderr"]))
            sys.stderr.flush()
        if action.get("hang"):
            time.sleep(60.0)
            continue
        if action.get("exit") is not None:
            sys.stdout.buffer.flush()
            return int(action["exit"])


if __name__ == "__main__":
    sys.exit(main())
