"""Subprocess transport with strict JSONL framing for `pi --mode rpc`.

Protocol requirements implemented here (from pi docs/rpc.md of 0.85.1):

- Records are delimited by LF (b"\\n") ONLY. We split on the byte level; this
  is UTF-8 safe because multi-byte sequences never contain 0x0A. We never use
  text-mode line iteration (universal newlines would also split on a lone CR
  and str.splitlines() would split on U+2028/U+2029, which are legal inside
  JSON strings).
- An optional single trailing CR is stripped from each record.
- stdout is the only JSONL channel; stderr is captured to its own buffer and
  file, and is NEVER fed to the JSON parser.
- Subprocess exit is detected by EOF on stdout; the exit code is surfaced.
- close() performs graceful shutdown (close stdin, wait), then terminate(),
  then kill(), and is idempotent.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from typing import Any, BinaryIO, List, NamedTuple, Optional

EOF_SENTINEL = None  # queue item meaning "stdout closed / process exited"

DEFAULT_CHUNK = 65536


class FramingError(Exception):
    """A line could not be decoded/parsed according to the protocol."""


class RawRecord(NamedTuple):
    """One stdout record: either parsed JSON or a protocol anomaly."""

    payload: Optional[dict]  # parsed JSON object, or None if anomalous
    raw: Optional[bytes]  # raw line bytes when anomalous (redact at evidence)
    anomaly: Optional[str]  # human-readable anomaly description
    at: float  # monotonic-ish wall time of observation


class StdoutSplitter:
    """Incremental LF-only frame splitter. Pure logic, unit-testable.

    feed() returns the list of complete record byte-strings (LF removed, one
    optional trailing CR removed). flush_eof() returns any trailing partial
    record (an anomaly under strict JSONL: every record must end with LF).
    """

    def __init__(self) -> None:
        self._buffer = b""

    def feed(self, chunk: bytes) -> List[bytes]:
        self._buffer += chunk
        records: List[bytes] = []
        while True:
            idx = self._buffer.find(b"\n")
            if idx == -1:
                break
            record = self._buffer[:idx]
            self._buffer = self._buffer[idx + 1:]
            if record.endswith(b"\r"):
                record = record[:-1]
            records.append(record)
        return records

    def flush_eof(self) -> Optional[bytes]:
        """Return leftover bytes after EOF (partial record), if any."""
        leftover = self._buffer
        self._buffer = b""
        if leftover:
            if leftover.endswith(b"\r"):
                leftover = leftover[:-1]
            return leftover
        return None

    @property
    def pending_bytes(self) -> int:
        return len(self._buffer)


def parse_record(record: bytes) -> RawRecord:
    """Decode one record to JSON. Returns an anomalous RawRecord on failure."""
    at = time.time()
    try:
        text = record.decode("utf-8")
    except UnicodeDecodeError as exc:
        return RawRecord(None, record, "invalid-utf8: %s" % exc, at)
    if not text.strip():
        return RawRecord(None, record, "empty-record", at)
    try:
        obj = json.loads(text)
    except ValueError as exc:
        return RawRecord(None, record, "invalid-json: %s" % exc, at)
    if not isinstance(obj, dict):
        return RawRecord(obj, record, "non-object-json-record", at)
    return RawRecord(obj, None, None, at)


class PiSubprocess:
    """Manages one `pi --mode rpc` subprocess with framed stdout reading.

    A background thread reads stdout in binary chunks, splits records with
    StdoutSplitter, and pushes RawRecord (or EOF_SENTINEL) into `records`.
    A second thread drains stderr into `stderr_lines` and an optional file.

    All JSONL traffic observed on stdout goes through `records`; stderr is
    kept strictly separate.
    """

    def __init__(
        self,
        argv: List[str],
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        stderr_path: Optional[str] = None,
        chunk_size: int = DEFAULT_CHUNK,
    ) -> None:
        self.argv = list(argv)
        self.cwd = cwd
        self.stderr_path = stderr_path
        self.records: "queue.Queue[Optional[RawRecord]]" = queue.Queue()
        self.stderr_lines: List[bytes] = []
        self.protocol_anomalies: List[RawRecord] = []
        self.started_at = time.time()
        self._chunk_size = chunk_size
        self._lock = threading.Lock()
        self._closed = False
        self._proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            bufsize=0,  # binary, unbuffered: we do our own framing
        )
        self._stdout_thread = threading.Thread(
            target=self._read_stdout, name="pi-stdout-reader", daemon=True
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr, name="pi-stderr-reader", daemon=True
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    # -- identity -----------------------------------------------------------

    @property
    def pid(self) -> int:
        return self._proc.pid

    def poll(self) -> Optional[int]:
        return self._proc.poll()

    @property
    def exit_code(self) -> Optional[int]:
        return self._proc.returncode

    @property
    def alive(self) -> bool:
        return self._proc.poll() is None

    def wait(self, timeout: Optional[float] = None) -> Optional[int]:
        """Block until the child is reaped. Returns the exit code, or None
        if the timeout expired while still running."""
        try:
            return self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    # -- reading ------------------------------------------------------------

    def _read_stdout(self) -> None:
        stream = self._proc.stdout  # type: ignore[union-attr]
        assert stream is not None
        fd = stream.fileno()
        splitter = StdoutSplitter()
        try:
            while True:
                chunk = os.read(fd, self._chunk_size)
                if not chunk:
                    break
                for record in splitter.feed(chunk):
                    self._emit(record)
            leftover = splitter.flush_eof()
            if leftover is not None:
                self._emit_anomaly(leftover, "eof-partial-record-without-lf")
        except (OSError, ValueError) as exc:  # pragma: no cover - defensive
            self._emit_anomaly(
                b"", "stdout-reader-error: %s" % exc
            )
        finally:
            self.records.put(EOF_SENTINEL)

    def _emit(self, record: bytes) -> None:
        parsed = parse_record(record)
        if parsed.anomaly:
            with self._lock:
                self.protocol_anomalies.append(parsed)
        self.records.put(parsed)

    def _emit_anomaly(self, raw: bytes, description: str) -> None:
        with self._lock:
            self.protocol_anomalies.append(
                RawRecord(None, raw if raw else None, description, time.time())
            )
        self.records.put(RawRecord(None, raw if raw else None, description, time.time()))

    def _read_stderr(self) -> None:
        stream = self._proc.stderr  # type: ignore[union-attr]
        assert stream is not None
        fd = stream.fileno()
        outfile = None
        if self.stderr_path:
            outfile = open(self.stderr_path, "wb", buffering=0)
        try:
            while True:
                chunk = os.read(fd, self._chunk_size)
                if not chunk:
                    break
                with self._lock:
                    self.stderr_lines.append(chunk)
                if outfile:
                    outfile.write(chunk)
        except OSError:  # pragma: no cover - defensive
            pass
        finally:
            if outfile:
                outfile.close()

    def stderr_text(self, max_bytes: int = 8192) -> str:
        """Return captured stderr (tail) as text. Never mixed into JSONL."""
        with self._lock:
            data = b"".join(self.stderr_lines)
        if len(data) > max_bytes:
            data = b"...[truncated]..." + data[-max_bytes:]
        return data.decode("utf-8", "replace")

    # -- writing ------------------------------------------------------------

    def send_json(self, obj: Any) -> None:
        """Serialize obj to one JSONL record on stdin."""
        if self._closed:
            raise BrokenPipeError("transport already closed")
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self._write_bytes(data)

    def send_raw(self, data: bytes) -> None:
        """Write raw bytes to stdin (diagnostics/tests only; e.g. to make
        the server produce a parse error)."""
        if self._closed:
            raise BrokenPipeError("transport already closed")
        self._write_bytes(data)

    def _write_bytes(self, data: bytes) -> None:
        stream = self._proc.stdin  # type: ignore[union-attr]
        assert stream is not None
        try:
            stream.write(data)
            stream.flush()
        except (BrokenPipeError, OSError) as exc:
            raise BrokenPipeError("pi stdin write failed: %s" % exc) from exc

    # -- lifecycle ------------------------------------------------------------

    def close(self, grace_timeout: float = 10.0) -> Optional[int]:
        """Idempotent shutdown: stdin EOF -> wait -> terminate -> kill.

        Returns the process exit code (negative = killed by signal).
        """
        if self._closed:
            return self._proc.returncode
        self._closed = True
        try:
            if self._proc.stdin is not None:
                try:
                    self._proc.stdin.close()
                except OSError:
                    pass
        except Exception:  # pragma: no cover - defensive
            pass
        try:
            self._proc.wait(timeout=grace_timeout)
        except subprocess.TimeoutExpired:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                try:
                    self._proc.wait(timeout=5.0)
                except subprocess.TimeoutExpired:  # pragma: no cover
                    pass
        # Drain reader threads so queues do not grow unboundedly.
        deadline = time.time() + grace_timeout
        for th in (self._stdout_thread, self._stderr_thread):
            remaining = max(0.0, deadline - time.time())
            th.join(timeout=remaining)
        return self._proc.returncode

    def kill_now(self) -> Optional[int]:
        """Immediate SIGKILL (used by timeout/crash paths)."""
        if self._proc.poll() is None:
            self._proc.kill()
            try:
                self._proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:  # pragma: no cover
                pass
        return self._proc.returncode
