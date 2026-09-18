"""PiRpcClient: request/response correlation and event dispatch.

Layers on PiSubprocess:

- attaches a monotonically increasing id to every command and resolves the
  matching {"type":"response", "id": ...} record;
- classifies every other stdout record as an event, appends it to an
  in-memory event log (under a lock), and fans it out to subscribers;
- derives a coarse run state (idle/running/compacting) from the event
  stream -- unlike the SDK, the RPC protocol has no continuously readable
  state object, so the client must maintain this state machine itself
  (recorded as an RPC capability difference for D1);
- distinguishes: request timeout, process exit while a request is pending,
  unmatched/parse responses, and protocol anomalies.

Only records with type == "response" are treated as command responses.
Other records that merely carry an id (e.g. bash_execution_update, which
echoes the originating bash command's id) are events, per the protocol.

wait_for_event(predicate, timeout, since_index) first scans the event log
from since_index (under the same lock dispatch uses) and only then
subscribes; this closes the race where the dispatcher consumes an event
before the waiter subscribes, and lets callers ignore stale events from
earlier rounds.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from .transport import EOF_SENTINEL, PiSubprocess, RawRecord

EventCallback = Callable[[Dict[str, Any]], None]
EventPredicate = Callable[[Dict[str, Any]], bool]

RUN_STATE_IDLE = "idle"
RUN_STATE_RUNNING = "running"
RUN_STATE_COMPACTING = "compacting"


class RpcTimeoutError(Exception):
    """The server did not answer a request within the deadline."""


class ProcessExitedError(Exception):
    """The pi subprocess exited (or was never alive) during a request."""

    def __init__(self, message: str, exit_code: Optional[int] = None,
                 stderr_tail: str = "") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr_tail = stderr_tail


class PendingRequest:
    __slots__ = ("req_id", "command", "event", "response", "resolved_at")

    def __init__(self, req_id: str, command: str) -> None:
        self.req_id = req_id
        self.command = command
        self.event = threading.Event()
        self.response: Optional[Dict[str, Any]] = None
        self.resolved_at: Optional[float] = None


class PiRpcClient:
    """One correlated client over one PiSubprocess."""

    def __init__(self, proc: PiSubprocess, request_timeout: float = 120.0) -> None:
        self.proc = proc
        self.request_timeout = request_timeout
        self.run_state = RUN_STATE_IDLE
        self.unmatched_responses: List[Dict[str, Any]] = []
        self.events_seen: List[str] = []  # event type names, in order
        self.last_event: Optional[Dict[str, Any]] = None
        self._event_log: List[Dict[str, Any]] = []
        self._event_lock = threading.Lock()
        self._subscribers: List[EventCallback] = []
        self._pending: Dict[str, PendingRequest] = {}
        self._pending_lock = threading.Lock()
        self._id_counter = 0
        self._id_lock = threading.Lock()
        self._dispatch_thread = threading.Thread(
            target=self._dispatch_loop, name="pi-dispatcher", daemon=True
        )
        self._started = False
        self._closed = False
        self._eof_error: Optional[ProcessExitedError] = None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if not self._started:
            self._started = True
            self._dispatch_thread.start()

    def subscribe(self, fn: EventCallback) -> None:
        """Register a callback invoked (in dispatcher thread) for each event.

        Must be called before start() or between events; exceptions raised
        by callbacks are swallowed and recorded, a broken recorder must not
        kill dispatching.
        """
        with self._event_lock:
            self._subscribers.append(fn)

    # -- event log ----------------------------------------------------------

    def event_log_len(self) -> int:
        with self._event_lock:
            return len(self._event_log)

    def events_since(self, index: int) -> List[Dict[str, Any]]:
        with self._event_lock:
            return list(self._event_log[index:])

    # -- dispatch -----------------------------------------------------------

    def _dispatch_loop(self) -> None:
        while True:
            item = self.proc.records.get()
            if item is EOF_SENTINEL or item is None:
                self._on_eof()
                return
            assert isinstance(item, RawRecord)
            # A dispatcher crash would silently break all request
            # correlation; internal errors are recorded, never fatal.
            try:
                if item.anomaly:
                    self._notify_anomaly(item)
                    continue
                obj = item.payload
                assert isinstance(obj, dict)
                if obj.get("type") == "response":
                    self._handle_response(obj)
                else:
                    self._handle_event(obj)
            except Exception as exc:  # pragma: no cover - defensive
                self._notify_internal_error(exc, item)

    def _notify_internal_error(self, exc: Exception, item: RawRecord) -> None:
        anomaly = {
            "__anomaly__": True,
            "type": "dispatcher_internal_error",
            "error": "%s: %s" % (type(exc).__name__, exc),
            "rawRedacted": _redact_bytes(item.raw),
            "at": time.time(),
        }
        for fn in self._snapshot_subscribers():
            self._safe_call(fn, anomaly)

    def _handle_response(self, obj: Dict[str, Any]) -> None:
        req_id = obj.get("id")
        if req_id is None:
            # Parse errors carry no id (the command could not be parsed).
            self._record_unmatched(obj)
            return
        with self._pending_lock:
            pending = self._pending.pop(req_id, None)
        if pending is None:
            self._record_unmatched(obj)
            return
        pending.response = obj
        pending.resolved_at = time.time()
        pending.event.set()

    def _record_unmatched(self, obj: Dict[str, Any]) -> None:
        self.unmatched_responses.append(obj)
        anomaly = {
            "__anomaly__": True,
            "type": "unmatched_response",
            "response": obj,
            "at": time.time(),
        }
        for fn in self._snapshot_subscribers():
            self._safe_call(fn, anomaly)

    def _handle_event(self, obj: Dict[str, Any]) -> None:
        etype = str(obj.get("type", "<missing-type>"))
        self.events_seen.append(etype)
        self.last_event = obj
        self._update_run_state(etype, obj)
        with self._event_lock:
            self._event_log.append(obj)
            subscribers = list(self._subscribers)
        for fn in subscribers:
            self._safe_call(fn, obj)

    def _notify_anomaly(self, item: RawRecord) -> None:
        obj = {
            "__anomaly__": True,
            "type": "protocol_anomaly",
            "anomaly": item.anomaly,
            "rawRedacted": _redact_bytes(item.raw),
            "at": item.at,
        }
        for fn in self._snapshot_subscribers():
            self._safe_call(fn, obj)

    def _snapshot_subscribers(self) -> List[EventCallback]:
        with self._event_lock:
            return list(self._subscribers)

    def _safe_call(self, fn: EventCallback, obj: Dict[str, Any]) -> None:
        try:
            fn(obj)
        except Exception as exc:  # pragma: no cover - recorder robustness
            try:
                self.unmatched_responses.append(
                    {"subscriberError": repr(exc)}
                )
            except Exception:
                pass

    def _update_run_state(self, etype: str, obj: Dict[str, Any]) -> None:
        # Client-derived state machine; the RPC protocol has no push-based
        # authoritative state (get_state is pull-only). See README.
        if etype == "agent_start":
            self.run_state = RUN_STATE_RUNNING
        elif etype == "compaction_start":
            self.run_state = RUN_STATE_COMPACTING
        elif etype == "compaction_end":
            self.run_state = RUN_STATE_RUNNING
        elif etype == "agent_settled":
            self.run_state = RUN_STATE_IDLE
        elif etype == "agent_end":
            # A low-level run ended, but retries/queued continuations may
            # follow; only agent_settled returns us to idle.
            if self.run_state != RUN_STATE_IDLE:
                self.run_state = RUN_STATE_RUNNING

    def _on_eof(self) -> None:
        self._closed = True
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        # EOF usually means the process died; give the reaper a moment so
        # the reported exit code is the real one instead of None. This runs
        # in the dispatcher thread, so it must never raise -- a dead
        # dispatcher would leave every pending request hanging.
        exit_code: Optional[int] = None
        try:
            exit_code = self.proc.wait(timeout=2.0)
        except Exception:  # pragma: no cover - defensive
            pass
        if exit_code is None:
            exit_code = self.proc.exit_code
        stderr_tail = self.proc.stderr_text()
        for p in pending:
            p.response = None
            p.resolved_at = time.time()
            p.event.set()
        self._eof_error = ProcessExitedError(
            "pi subprocess exited (code=%r) while %d request(s) pending"
            % (exit_code, len(pending)),
            exit_code=exit_code,
            stderr_tail=stderr_tail,
        )

    # -- requests -----------------------------------------------------------

    def _next_id(self, command: str) -> str:
        with self._id_lock:
            self._id_counter += 1
            n = self._id_counter
        return "req-%04d-%s" % (n, command)

    def request(self, command: str, payload: Optional[Dict[str, Any]] = None,
                timeout: Optional[float] = None) -> Dict[str, Any]:
        """Send a command, wait for its correlated response.

        Raises:
            RpcTimeoutError: no response within timeout.
            ProcessExitedError: subprocess exited before answering.
        """
        if not self._started:
            raise RuntimeError("client.start() must be called first")
        if self._closed:
            raise ProcessExitedError(
                "pi subprocess already closed (code=%r)" % self.proc.exit_code,
                exit_code=self.proc.exit_code,
                stderr_tail=self.proc.stderr_text(),
            )
        req_id = self._next_id(command)
        obj: Dict[str, Any] = {"id": req_id, "type": command}
        if payload:
            obj.update(payload)
        pending = PendingRequest(req_id, command)
        with self._pending_lock:
            self._pending[req_id] = pending
        self.proc.send_json(obj)
        timeout = timeout if timeout is not None else self.request_timeout
        if not pending.event.wait(timeout=timeout):
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise RpcTimeoutError(
                "no response for %s (id=%s) within %.1fs"
                % (command, req_id, timeout)
            )
        resp = pending.response
        if resp is None:
            if self._eof_error is not None:
                raise self._eof_error
            raise ProcessExitedError(
                "pi subprocess exited while %s (id=%s) was pending"
                % (command, req_id),
                exit_code=self.proc.exit_code,
                stderr_tail=self.proc.stderr_text(),
            )
        return resp

    # -- event waiting --------------------------------------------------------

    def wait_for_event(
        self,
        predicate: EventPredicate,
        timeout: float,
        since_index: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """Block until an event satisfying predicate arrives (or timeout).

        since_index semantics: only consider events at log position >=
        since_index. The initial scan and the subscriber registration happen
        under the same lock the dispatcher uses, so no event can be missed
        between the scan and the subscription.
        """
        cond = threading.Condition()
        hits: List[Dict[str, Any]] = []

        def _cb(obj: Dict[str, Any]) -> None:
            if predicate(obj):
                with cond:
                    hits.append(obj)
                    cond.notify_all()

        with self._event_lock:
            start = 0 if since_index is None else since_index
            for ev in self._event_log[start:]:
                if predicate(ev):
                    return ev
            self._subscribers.append(_cb)
        try:
            deadline = time.monotonic() + timeout
            with cond:
                while not hits:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    cond.wait(timeout=remaining)
            return hits[0]
        finally:
            with self._event_lock:
                try:
                    self._subscribers.remove(_cb)
                except ValueError:  # pragma: no cover
                    pass


def _redact_bytes(raw: Optional[bytes], limit: int = 400) -> Optional[str]:
    if raw is None:
        return None
    return raw[:limit].decode("utf-8", "replace")
