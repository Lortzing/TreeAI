"""Crash driver: a sacrificial "host" process that owns a pi subprocess.

Run as a standalone script. It spawns `pi --mode rpc`, optionally sends a
long-running prompt (phase=streaming), writes a readiness record, and then
idles forever. The parent (crash_probe) SIGKILLs this driver to simulate a
host crash and then observes what happens to the orphaned pi process.

This file is intentionally runnable without the package on sys.path.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pi-bin", default="pi")
    ap.add_argument("--provider", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--thinking", default="off")
    ap.add_argument("--ready-file", required=True)
    ap.add_argument("--phase", choices=("idle", "streaming"), default="idle")
    ap.add_argument("--prompt",
                    default="Count slowly from 1 to 100, one number per "
                            "line.")
    args = ap.parse_args()

    argv = [
        args.pi_bin, "--mode", "rpc", "--no-session",
        "--provider", args.provider,
        "--model", args.model,
        "--thinking", args.thinking,
    ]
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=os.getcwd(),
    )
    record = {
        "piPid": proc.pid,
        "driverPid": os.getpid(),
        "phase": args.phase,
        "argv": argv,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if args.phase == "streaming":
        proc.stdin.write(
            (json.dumps({"id": "crash-1", "type": "prompt",
                         "message": args.prompt}) + "\n").encode("utf-8")
        )
        proc.stdin.flush()
        record["promptSent"] = True

    with open(args.ready_file, "w", encoding="utf-8") as fh:
        json.dump(record, fh)

    # idle until killed; ignore SIGTERM so only SIGKILL takes us down
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:  # pragma: no cover
        return 0


if __name__ == "__main__":
    sys.exit(main())
